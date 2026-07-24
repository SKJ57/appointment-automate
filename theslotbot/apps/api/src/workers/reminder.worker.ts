/**
 * src/workers/reminder.worker.ts
 *
 * Consumes the `reminders` queue and sends 24h/3h pre-appointment
 * reminders.
 *
 * RISK C2 — THE MANDATORY PRE-SEND CHECK:
 * booking.service.ts removes a booking's reminder jobs from BullMQ when
 * it's cancelled, but that removal is best-effort (logged on failure,
 * never rolled back — see the comment in removeReminderJobs()). This
 * worker is the actual safety net. Every job, when it fires, re-reads
 * the booking's CURRENT status from the database before sending
 * anything. If the booking is no longer 'confirmed' — cancelled after
 * the job was queued, marked no_show, whatever — the job aborts and
 * logs a skip. This check is not optional defensive code; it is the
 * primary correctness guarantee for "never remind a customer about a
 * cancelled appointment," with job removal as a secondary optimization
 * that reduces wasted queue churn but is not relied upon for correctness.
 *
 * QUIET HOURS (Risk C3):
 * If a job's fire time happens to land inside quiet hours — possible if
 * a booking is created very close to its own appointment time, pushing
 * the "24 hours before" or "3 hours before" calculation into an
 * unsociable hour — the worker does NOT send at 4 AM. For the 3h
 * reminder specifically, delaying until quiet hours end would often
 * mean sending the reminder AFTER the appointment, which is worse than
 * not sending it. So: if delaying would push the reminder past the
 * appointment's start time, the job is dropped with a logged reason
 * instead of delayed. Otherwise, it's rescheduled to quiet-hours-end.
 *
 * IDEMPOTENCY:
 * The actual send goes through gateway.sendMessage(), which acquires
 * the MessageLog idempotency lock before any Meta API call (Risk C1).
 * This worker also checks the booking's own reminder24hSent/
 * reminder3hSent flags as a second, cheaper pre-check to skip the
 * gateway call entirely on an already-sent reminder.
 */

import { Worker, Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getWorkerConnection } from '@/lib/redis';
import { QUEUE_NAMES } from '@theslotbot/shared/constants';
import { MessageType, TemplateCategory, ReminderJobPayload } from '@theslotbot/shared/types';
import { sendMessage } from '@/modules/whatsapp/gateway';
import { markReminderSent } from '@/modules/booking/booking.repository';
import { isWithinQuietHours, formatInSalonTimezone } from '@/lib/timezone';
import { CLIENT_CONFIG } from '@/config/client.config';

const log = logger.child({ module: 'reminder.worker' });

// ─────────────────────────────────────────────
// JOB PROCESSOR
// ─────────────────────────────────────────────

async function processReminderJob(job: Job<ReminderJobPayload>): Promise<void> {
  const { bookingId, customerId, salonId, messageType } = job.data;

  // ── THE MANDATORY PRE-SEND CHECK (Risk C2) ──────────────────────────
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      slotStart: true,
      reminder24hSent: true,
      reminder3hSent: true,
      service: { select: { name: true, durationMinutes: true } },
      customer: { select: { phoneNumber: true, name: true } },
      salon: { select: { name: true } },
    },
  });

  if (!booking) {
    log.warn({ bookingId, jobId: job.id }, 'Reminder job fired for a booking that no longer exists — skipping');
    return;
  }

  if (booking.status !== 'confirmed') {
    log.info(
      { bookingId, jobId: job.id, currentStatus: booking.status },
      'Reminder job aborted — booking is no longer confirmed (cancelled, completed, or no-show)',
    );
    return;
  }

  const alreadySent =
    messageType === MessageType.REMINDER_24H
      ? booking.reminder24hSent
      : booking.reminder3hSent;

  if (alreadySent) {
    log.debug({ bookingId, jobId: job.id }, 'Reminder already sent (booking flag) — skipping');
    return;
  }

  // ── QUIET HOURS CHECK (Risk C3) ──────────────────────────────────────
  const now = new Date();
  if (isWithinQuietHours(now)) {
    await handleQuietHoursConflict({ job, booking, messageType });
    return;
  }

  // ── SEND ──────────────────────────────────────────────────────────────
  const dateLabel = formatInSalonTimezone(booking.slotStart, 'YYYY-MM-DD');
  const timeLabel = formatInSalonTimezone(booking.slotStart, 'HH:mm');

  const messageText =
    messageType === MessageType.REMINDER_24H
      ? buildReminder24hText(booking.service.name, dateLabel, timeLabel)
      : buildReminder3hText(booking.service.name, timeLabel);

  const result = await sendMessage({
    salonId,
    customerId,
    customerPhone: booking.customer.phoneNumber,
    messageType,
    templateCategory: TemplateCategory.UTILITY,
    templateName:
      messageType === MessageType.REMINDER_24H ? 'reminder_24h' : 'reminder_3h',
    templateParams: { 1: messageText },
    bookingId,
  });

  if (result.sent) {
    await markReminderSent(
      bookingId,
      messageType === MessageType.REMINDER_24H ? '24h' : '3h',
    );
    log.info({ bookingId, messageType }, 'Reminder sent successfully');
  } else {
    log.info(
      { bookingId, messageType, reason: result.reason },
      'Reminder not sent (idempotency suppression or invalid number)',
    );
  }
}

// ─────────────────────────────────────────────
// QUIET HOURS HANDLING (Risk C3)
// ─────────────────────────────────────────────

/**
 * Either re-queues the job with a delay past the quiet-hours window,
 * or drops it outright if delaying would push the send past the
 * appointment's start time (a "24h before" reminder sent 1 hour before
 * the appointment is worse than no reminder at all).
 */
async function handleQuietHoursConflict(params: {
  job: Job<ReminderJobPayload>;
  booking: { id: string; slotStart: Date };
  messageType: MessageType.REMINDER_24H | MessageType.REMINDER_3H;
}): Promise<void> {
  const { job, booking, messageType } = params;
  const { end } = CLIENT_CONFIG.campaign.quietHours;
  const [endHour, endMinute] = end.split(':').map(Number);

  const nextPermittedTime = new Date();
  nextPermittedTime.setHours(endHour!, endMinute!, 0, 0);
  if (nextPermittedTime <= new Date()) {
    nextPermittedTime.setDate(nextPermittedTime.getDate() + 1);
  }

  if (nextPermittedTime >= booking.slotStart) {
    log.info(
      { bookingId: booking.id, messageType, nextPermittedTime, slotStart: booking.slotStart },
      'Reminder dropped — quiet hours delay would push send past appointment start',
    );
    return;
  }

  const delay = nextPermittedTime.getTime() - Date.now();

  // Re-enqueue with a derived jobId (suffixed) to avoid colliding with
  // the currently-processing job's own lifecycle/cleanup.
  await job.queue.add(
    job.name,
    job.data,
    {
      jobId: `${job.id}:requeued-quiet-hours`,
      delay,
    },
  );

  log.info(
    { bookingId: booking.id, messageType, nextPermittedTime },
    'Reminder delayed past quiet hours window',
  );
}

// ─────────────────────────────────────────────
// MESSAGE TEXT BUILDERS
// ─────────────────────────────────────────────

function buildReminder24hText(serviceName: string, date: string, time: string): string {
  return `Reminder: your ${serviceName} appointment is tomorrow, ${date} at ${time}. Reply RESCHEDULE if you need to change it.`;
}

function buildReminder3hText(serviceName: string, time: string): string {
  return `See you soon! Your ${serviceName} appointment is today at ${time}.`;
}

// ─────────────────────────────────────────────
// WORKER REGISTRATION
// ─────────────────────────────────────────────

export const reminderWorker = new Worker<ReminderJobPayload>(
  QUEUE_NAMES.REMINDERS,
  processReminderJob,
  {
    connection: getWorkerConnection(),
    concurrency: 5,
  },
);

reminderWorker.on('completed', (job) => {
  log.debug({ jobId: job.id }, 'Reminder job completed');
});

reminderWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Reminder job failed');
});
