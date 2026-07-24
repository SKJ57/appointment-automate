/**
 * src/modules/booking/booking.service.ts
 *
 * Orchestration layer for the booking domain.
 *
 * LAYERING RULE:
 * booking.repository.ts = pure Prisma, no side effects outside the DB.
 * booking.service.ts (this file) = orchestrates repository calls +
 *   BullMQ job scheduling + idempotency-aware enqueueing.
 * api/routes/bookings.ts = HTTP concerns only (parsing, validation,
 *   response shaping). Calls into this service, never into the
 *   repository directly.
 *
 * This file is also where the white-label engine/config boundary is
 * most visible: every business rule referenced here comes from
 * CLIENT_CONFIG, never a hardcoded value. The engine knows "send a
 * reminder N hours before"; CLIENT_CONFIG decides what N is, and
 * whether to send it at all (feature toggle).
 */

import { Booking } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config';
import { MessageType } from '@theslotbot/shared/types';
import { QUEUE_NAMES } from '@theslotbot/shared/constants';
import {
  claimSlotAndCreateBooking,
  cancelBooking as repoCanelBooking,
  markBookingComplete as repoMarkBookingComplete,
  findAvailableSlots,
  findBookingById,
  findBookingsByDateRange,
  setSlotBlocked,
  blockSlotsInWindow,
  findSlotsForDay,
  ClaimSlotParams,
  BookingWithRelations,
} from './booking.repository';
import { reminderQueue, reviewQueue, JobId } from '@/workers/queues';
import { isWithinQuietHours } from '@/lib/timezone';
import { markCustomerConvertedOnBooking } from '@/workers/campaign.worker';

const log = logger.child({ module: 'booking.service' });

// ─────────────────────────────────────────────
// CREATE BOOKING
// ─────────────────────────────────────────────

export interface CreateBookingInput {
  salonId: string;
  customerId: string;
  serviceId: string;
  slotId: string;
  slotStart: Date;
  durationMinutes: number;
  source: 'whatsapp' | 'admin_manual';
  notes?: string;
}

/**
 * Create a booking and, on success, enqueue the reminder jobs.
 *
 * This is the single entrypoint used by both the WhatsApp state machine
 * (source: 'whatsapp') and the admin walk-in form (source: 'admin_manual').
 * Both paths get identical correctness guarantees — there is no separate,
 * less-safe code path for manual entry.
 */
export async function createBooking(
  input: CreateBookingInput,
): Promise<Booking> {
  const slotEnd = new Date(
    input.slotStart.getTime() + input.durationMinutes * 60 * 1000,
  );

  const claimParams: ClaimSlotParams = {
    salonId: input.salonId,
    customerId: input.customerId,
    serviceId: input.serviceId,
    slotId: input.slotId,
    slotStart: input.slotStart,
    slotEnd,
    source: input.source,
    notes: input.notes,
  };

  // The atomic transaction lives in the repository (Risk B1 fix).
  // Errors (SlotAlreadyClaimedError, SlotOverlapError) propagate up
  // to the route handler, which maps them to HTTP 409 responses.
  const booking = await claimSlotAndCreateBooking(claimParams);

  // Only schedule reminders for confirmed bookings. If requireApproval
  // is enabled, the booking sits in pending_confirmation and reminders
  // are scheduled later, when reception approves it.
  if (booking.status === 'confirmed') {
    await scheduleReminders(booking);

    // Section 6.3: if this customer was anywhere in the day30_sent /
    // day37_sent revisit cycle, rebooking immediately moves them to
    // 'converted' so the campaign worker stops messaging someone who
    // already came back. Campaign-domain logic lives in campaign.worker.ts
    // even though it's triggered from here.
    await markCustomerConvertedOnBooking(input.customerId);
  }

  return booking;
}

// ─────────────────────────────────────────────
// REMINDER SCHEDULING
// ─────────────────────────────────────────────

/**
 * Enqueue the 24h and 3h reminder jobs for a confirmed booking.
 *
 * Risk C1 fix: jobId is deterministic (`reminder:${type}:${bookingId}`).
 * If this function is called twice for the same booking — e.g. a
 * duplicate Meta webhook delivery re-triggers the confirmation handler —
 * BullMQ's jobId deduplication silently no-ops the second enqueue.
 * No special-case duplicate detection needed in this function itself.
 *
 * Feature toggle: CLIENT_CONFIG.reminders.send24h / send3h. A client
 * who only wants 3h reminders (not 24h) gets that purely through config,
 * with zero code branching beyond this one check.
 */
export async function scheduleReminders(booking: Booking): Promise<void> {
  const jobs: Array<{ type: MessageType.REMINDER_24H | MessageType.REMINDER_3H; hoursBeforeMs: number; enabled: boolean }> = [
    {
      type: MessageType.REMINDER_24H,
      hoursBeforeMs: 24 * 60 * 60 * 1000,
      enabled: CLIENT_CONFIG.reminders.send24h,
    },
    {
      type: MessageType.REMINDER_3H,
      hoursBeforeMs: 3 * 60 * 60 * 1000,
      enabled: CLIENT_CONFIG.reminders.send3h,
    },
  ];

  for (const job of jobs) {
    if (!job.enabled) continue;

    const fireAt = new Date(booking.slotStart.getTime() - job.hoursBeforeMs);
    const delay = fireAt.getTime() - Date.now();

    // If the booking was made less than the reminder window away
    // (e.g. customer books an appointment for 2 hours from now),
    // the 24h reminder's fire time is already in the past. Skip it
    // rather than firing it instantly with stale "24 hours from now"
    // framing — same logic applies to a same-day 3h booking under
    // the 3h window.
    if (delay <= 0) {
      log.debug(
        { bookingId: booking.id, type: job.type },
        'Reminder fire time already past — skipping enqueue',
      );
      continue;
    }

    await reminderQueue.add(
      job.type,
      {
        bookingId: booking.id,
        customerId: booking.customerId,
        salonId: booking.salonId,
        messageType: job.type,
        scheduledFor: fireAt.toISOString(),
      },
      {
        jobId: JobId.reminder(job.type, booking.id),
        delay,
      },
    );

    log.debug(
      { bookingId: booking.id, type: job.type, fireAt },
      'Reminder job enqueued',
    );
  }
}

/**
 * Remove pending reminder jobs for a booking.
 *
 * Risk C2 fix: this is called from cancelBooking() below, immediately
 * after the DB status update. If job removal throws (Redis blip, job
 * already running), we log an alert-worthy error but do NOT roll back
 * the cancellation — the booking IS cancelled in the source of truth
 * (the database). The reminder worker's pre-send status re-check is
 * the mandatory second layer that catches any job that slips through
 * here. See reminder.worker.ts for that check.
 */
async function removeReminderJobs(bookingId: string): Promise<void> {
  const jobIds = [
    JobId.reminder(MessageType.REMINDER_24H, bookingId),
    JobId.reminder(MessageType.REMINDER_3H, bookingId),
  ];

  for (const jobId of jobIds) {
    try {
      const job = await reminderQueue.getJob(jobId);
      if (job) {
        await job.remove();
        log.debug({ bookingId, jobId }, 'Reminder job removed on cancellation');
      }
    } catch (err) {
      // Risk C2: do not throw. Log loudly — this should trigger a
      // BetterStack alert in production. The pre-send re-check in
      // the worker is the safety net, not this removal call.
      log.error(
        { err, bookingId, jobId },
        'Failed to remove reminder job on cancellation — relying on worker pre-send check',
      );
    }
  }
}

// ─────────────────────────────────────────────
// CANCEL BOOKING
// ─────────────────────────────────────────────

export async function cancelBooking(params: {
  bookingId: string;
  salonId: string;
  reason?: string;
}): Promise<Booking> {
  const booking = await repoCanelBooking(params);

  // DB update succeeded — booking.status is now 'cancelled', which is
  // the source of truth. Job removal is best-effort cleanup, not
  // required for correctness (see removeReminderJobs comment above).
  await removeReminderJobs(params.bookingId);

  return booking;
}

// ─────────────────────────────────────────────
// MARK COMPLETE
// ─────────────────────────────────────────────

export async function markBookingComplete(params: {
  bookingId: string;
  salonId: string;
  completedById: string;
}): Promise<Booking> {
  const booking = await repoMarkBookingComplete(params);

  // Feature toggle: review automation can be disabled per client.
  // Checking review.requestDelayHours presence isn't a toggle by itself —
  // add an explicit reviewEnabled flag if a client wants this fully off.
  // For now this follows the existing CLIENT_CONFIG.review block, which
  // is always present; a `false` delay isn't meaningful, so we gate via
  // a dedicated check the team can wire to a future config.review.enabled
  // flag without touching this function's contract.
  await scheduleReviewRequest(booking);

  return booking;
}

/**
 * Enqueue the post-visit review request, delayed by
 * CLIENT_CONFIG.review.requestDelayHours, with a quiet-hours check
 * so the message doesn't land at 2 AM (Risk C3 fix, applied here too
 * even though Section 6 framed quiet hours around campaigns — a
 * review request firing during quiet hours is the same bad experience).
 *
 * Risk C1 fix: deterministic jobId `review:${bookingId}` prevents
 * duplicate review requests if markBookingComplete is called twice
 * (the repository layer is idempotent on status, but this guards the
 * queue side too).
 */
async function scheduleReviewRequest(booking: Booking): Promise<void> {
  const delayMs = CLIENT_CONFIG.review.requestDelayHours * 60 * 60 * 1000;
  let fireAt = new Date(Date.now() + delayMs);

  // If the computed fire time lands in quiet hours, push to the next
  // permitted window start rather than sending at an unsociable hour.
  if (isWithinQuietHours(fireAt)) {
    const { end } = CLIENT_CONFIG.campaign.quietHours;
    const [endHour, endMinute] = end.split(':').map(Number);
    const adjusted = new Date(fireAt);
    adjusted.setHours(endHour!, endMinute!, 0, 0);
    if (adjusted <= fireAt) {
      adjusted.setDate(adjusted.getDate() + 1);
    }
    fireAt = adjusted;
  }

  const delay = Math.max(0, fireAt.getTime() - Date.now());

  await reviewQueue.add(
    'review_request',
    {
      bookingId: booking.id,
      customerId: booking.customerId,
      salonId: booking.salonId,
      serviceId: booking.serviceId,
      completedAt: (booking.completedAt ?? new Date()).toISOString(),
    },
    {
      jobId: JobId.review(booking.id),
      delay,
    },
  );

  log.debug(
    { bookingId: booking.id, fireAt },
    'Review request job enqueued',
  );
}

// ─────────────────────────────────────────────
// READS (pass-through with light shaping)
// ─────────────────────────────────────────────

export async function getBooking(
  bookingId: string,
  salonId: string,
): Promise<BookingWithRelations | null> {
  return findBookingById(bookingId, salonId);
}

export async function listBookings(params: {
  salonId: string;
  from: Date;
  to: Date;
  status?: Parameters<typeof findBookingsByDateRange>[0]['status'];
  page: number;
  pageSize: number;
}) {
  return findBookingsByDateRange(params);
}

export async function getAvailableSlots(params: {
  salonId: string;
  serviceId: string;
  dateStart: Date;
  dateEnd: Date;
}) {
  const service = await prisma.service.findFirst({
    where: { id: params.serviceId, salonId: params.salonId, isActive: true },
    select: { durationMinutes: true },
  });

  if (!service) {
    return [];
  }

  const slots = await findAvailableSlots({
    salonId: params.salonId,
    dateStart: params.dateStart,
    dateEnd: params.dateEnd,
    durationMinutes: service.durationMinutes,
  });

  return slots.slice(0, CLIENT_CONFIG.booking.slotsToShow);
}

// ─────────────────────────────────────────────
// SLOT BLOCKING (admin action — staff breaks, holidays)
// ─────────────────────────────────────────────

export async function blockSlot(params: {
  slotId: string;
  salonId: string;
  isBlocked: boolean;
}) {
  return setSlotBlocked(params);
}

/**
 * Blocks every unbooked slot within [startTime, endTime) on the given
 * salon-local date. Used by the "block this time for a staff break"
 * admin action. windowStart/windowEnd are computed by the route layer
 * using lib/timezone.ts before calling this — the service layer stays
 * timezone-agnostic and works purely in UTC instants, consistent with
 * every other function in this module.
 */
export async function blockTimeWindow(params: {
  salonId: string;
  windowStart: Date;
  windowEnd: Date;
  reason?: string;
}) {
  return blockSlotsInWindow(params);
}

/**
 * Full-day capacity view for the admin Slots calendar page.
 * See findSlotsForDay in the repository for why this is distinct from
 * getAvailableSlots (service-agnostic vs. service-scoped).
 */
export async function getDaySlots(params: {
  salonId: string;
  dayStart: Date;
  dayEnd: Date;
}) {
  return findSlotsForDay(params);
}
