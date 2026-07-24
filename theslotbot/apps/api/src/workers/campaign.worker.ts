/**
 * src/workers/campaign.worker.ts
 *
 * Daily batch job implementing the Day 30 / Day 37 revisit campaign.
 *
 * BUSINESS REQUIREMENT — REACTIVATION SAFETY:
 * If a salon is suspended for an extended period (the example given was
 * 6 months) and then reactivates, hundreds of customers may have
 * lastVisitDate values that are now 30, 60, 90+ days in the past — all
 * of them technically "due" for a revisit message the moment the
 * subscription becomes active again. Without a guard, reactivation
 * would trigger a single batch blast to the salon's entire dormant
 * customer base simultaneously, which is both a terrible customer
 * experience (a flood of "come back!" messages from a salon that's
 * been silent for half a year) and a Meta frequency-cap/quality-rating
 * risk.
 *
 * THE FIX: salon.campaignResumeAfter is set to NOW() at the moment of
 * reactivation (see the /admin/system/subscription endpoint spec from
 * Phase 1). Every query in this worker requires:
 *
 *   customer.lastVisitDate > salon.campaignResumeAfter
 *
 * (skipped entirely when campaignResumeAfter is null — a salon that has
 * never been suspended gets zero behavior change). A salon reactivating
 * today only re-enrolls customers whose visits happen FROM TODAY FORWARD
 * into the 30/37-day cycle. The pre-existing backlog is permanently
 * excluded from automatic campaign sends — those customers are not
 * lost, they simply don't get blasted; a salon owner who wants to
 * manually re-engage that backlog can do so through a separate,
 * deliberate action (out of scope for this worker).
 *
 * SERVICE-CATEGORY BRANCHING (Section 7.4):
 * The message template selected depends on the customer's
 * lastVisitServiceId → service.category. short_cycle, medium_cycle, and
 * long_cycle each get distinct Day 30 and Day 37 copy.
 *
 * FEATURE TOGGLE:
 * CLIENT_CONFIG.campaign.day30Enabled / day37Enabled. A client who only
 * wants Day 30 (no follow-up) gets that purely through config — this
 * worker checks the flag before processing each phase and exits early
 * if disabled, with zero code branching beyond that check.
 */

import { Worker, Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getWorkerConnection } from '@/lib/redis';
import { CLIENT_CONFIG } from '@/config/client.config';
import { QUEUE_NAMES } from '@theslotbot/shared/constants';
import { MessageType, TemplateCategory, ServiceCategory } from '@theslotbot/shared/types';
import { sendMessage } from '@/modules/whatsapp/gateway';
import { todayInSalonTimezone, addCalendarDays } from '@/lib/timezone';

const log = logger.child({ module: 'campaign.worker' });

type SalonForCampaign = {
  id: string;
  name: string;
  campaignResumeAfter: Date | null;
};

type CampaignCustomer = {
  id: string;
  phoneNumber: string;
  name: string;
  nonResponderCount: number;
  lastVisitService: { category: ServiceCategory } | null;
};

// ─────────────────────────────────────────────
// DAILY ENTRYPOINT
// Triggered by a BullMQ repeatable job (registered in cron.worker.ts,
// not shown in this phase — the queue/job-scheduling wiring belongs
// there; this file owns the campaign business logic itself).
// ─────────────────────────────────────────────

export async function runDailyCampaignSweep(): Promise<void> {
  const salons = await prisma.salon.findMany({
    where: { subscriptionStatus: 'active' },
    select: { id: true, name: true, campaignResumeAfter: true },
  });

  log.info({ salonCount: salons.length }, 'Starting daily campaign sweep');

  for (const salon of salons) {
    try {
      if (CLIENT_CONFIG.campaign.day30Enabled) {
        await processDay30(salon);
      }
      if (CLIENT_CONFIG.campaign.day37Enabled) {
        await processDay37(salon);
      }
    } catch (err) {
      log.error(
        { err, salonId: salon.id, salonName: salon.name },
        'Campaign sweep failed for salon — continuing with remaining salons',
      );
    }
  }
}

// ─────────────────────────────────────────────
// DATE CONDITION BUILDER (reactivation safety, shared by both phases)
// ─────────────────────────────────────────────

/**
 * Builds the Prisma `lastVisitDate` where-condition combining:
 *   1. an exact match against the target date (today - N days), and
 *   2. the reactivation safety floor (lastVisitDate > campaignResumeAfter),
 *      applied only when the salon has a non-null campaignResumeAfter.
 *
 * Built as a single combined object so there's no risk of one condition
 * silently overwriting the other — a single `equals` + `gt` pair on the
 * same key is unambiguous to Prisma and to anyone reading this later.
 */
function buildLastVisitDateCondition(
  targetDateStr: string,
  campaignResumeAfter: Date | null,
): { equals: Date } | { equals: Date; gt: Date } {
  const targetDateAsDate = new Date(`${targetDateStr}T00:00:00.000Z`);

  if (campaignResumeAfter) {
    return { equals: targetDateAsDate, gt: campaignResumeAfter };
  }
  return { equals: targetDateAsDate };
}

// ─────────────────────────────────────────────
// DAY 30
// ─────────────────────────────────────────────

async function processDay30(salon: SalonForCampaign): Promise<void> {
  const targetDate = addCalendarDays(todayInSalonTimezone(), -30);

  const customers = await prisma.customer.findMany({
    where: {
      salonId: salon.id,
      revisitCampaignStatus: 'none',
      lastVisitDate: buildLastVisitDateCondition(targetDate, salon.campaignResumeAfter),
      whatsappOptIn: true, // Risk D4: only opted-in customers get marketing sends
      isNumberInvalid: false,
    },
    include: {
      lastVisitService: { select: { category: true } },
    },
  });

  log.info(
    { salonId: salon.id, eligibleCount: customers.length, targetDate },
    'Day 30 campaign candidates resolved',
  );

  for (const customer of customers) {
    await sendRevisitMessage({
      salon,
      customer,
      messageType: MessageType.REVISIT_DAY30,
    });
  }
}

// ─────────────────────────────────────────────
// DAY 37
// ─────────────────────────────────────────────

async function processDay37(salon: SalonForCampaign): Promise<void> {
  const targetDate = addCalendarDays(todayInSalonTimezone(), -37);

  const customers = await prisma.customer.findMany({
    where: {
      salonId: salon.id,
      revisitCampaignStatus: 'day30_sent',
      lastVisitDate: buildLastVisitDateCondition(targetDate, salon.campaignResumeAfter),
      whatsappOptIn: true,
      isNumberInvalid: false,
    },
    include: {
      lastVisitService: { select: { category: true } },
    },
  });

  log.info(
    { salonId: salon.id, eligibleCount: customers.length, targetDate },
    'Day 37 campaign candidates resolved',
  );

  for (const customer of customers) {
    await sendRevisitMessage({
      salon,
      customer,
      messageType: MessageType.REVISIT_DAY37,
    });
  }
}

// ─────────────────────────────────────────────
// MESSAGE DISPATCH + STATE TRANSITION
// ─────────────────────────────────────────────

async function sendRevisitMessage(params: {
  salon: SalonForCampaign;
  customer: CampaignCustomer;
  messageType: MessageType.REVISIT_DAY30 | MessageType.REVISIT_DAY37;
}): Promise<void> {
  const { salon, customer, messageType } = params;
  const category = customer.lastVisitService?.category ?? 'medium_cycle';

  const templateName = buildTemplateName(messageType, category);
  const messageText = buildMessageText(salon.name, messageType, category);

  const today = todayInSalonTimezone();

  const result = await sendMessage({
    salonId: salon.id,
    customerId: customer.id,
    customerPhone: customer.phoneNumber,
    messageType,
    templateCategory: TemplateCategory.MARKETING,
    templateName,
    templateParams: { 1: messageText },
    campaignDate: today,
  });

  if (!result.sent) {
    log.debug(
      { customerId: customer.id, messageType, reason: result.reason },
      'Revisit message not sent (idempotency or invalid number)',
    );
    return;
  }

  // ── STATE TRANSITION ──────────────────────────────────────────────────
  if (messageType === MessageType.REVISIT_DAY30) {
    await prisma.customer.update({
      where: { id: customer.id },
      data: { revisitCampaignStatus: 'day30_sent' },
    });
  } else {
    // Day 37 fired with no booking in between (the booking-confirmation
    // hook would have already moved status to 'converted' and excluded
    // this customer from the Day 37 query above if they'd rebooked —
    // see markCustomerConvertedOnBooking() below).
    const newCount = customer.nonResponderCount + 1;
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        revisitCampaignStatus: 'non_responder',
        nonResponderCount: newCount,
      },
    });

    log.info(
      { customerId: customer.id, nonResponderCount: newCount },
      'Customer marked non_responder after Day 37 with no rebooking',
    );
  }
}

function buildTemplateName(
  messageType: MessageType.REVISIT_DAY30 | MessageType.REVISIT_DAY37,
  category: ServiceCategory,
): string {
  const phase = messageType === MessageType.REVISIT_DAY30 ? 'day30' : 'day37';
  return `revisit_${phase}_${category.replace('_cycle', '')}`;
}

/**
 * Section 7.4 branching, condensed into copy. Real production copy
 * should live in the seed templates file (prisma/seeds/<client>/templates.ts)
 * per client, submitted to Meta ahead of go-live — these strings are
 * representative defaults for the engine's behavior, not final client copy.
 */
function buildMessageText(
  salonName: string,
  messageType: MessageType.REVISIT_DAY30 | MessageType.REVISIT_DAY37,
  category: ServiceCategory,
): string {
  if (messageType === MessageType.REVISIT_DAY30) {
    switch (category) {
      case 'short_cycle':
        return `It's been a month since your last visit to ${salonName} — time for a touch-up? Reply BOOK to grab a slot.`;
      case 'medium_cycle':
        return `Your skin/hair is probably due for some care — book your next visit at ${salonName}. Reply BOOK.`;
      case 'long_cycle':
        return `We loved having you at ${salonName}. No rush — just checking in! Reply BOOK whenever you're ready for your next visit.`;
    }
  } else {
    switch (category) {
      case 'short_cycle':
        return `Still thinking about it? Here's 10% off your next visit to ${salonName} this week. Reply BOOK.`;
      case 'medium_cycle':
        return `New seasonal treatments are in at ${salonName} — plus a little discount if you book this week. Reply BOOK.`;
      case 'long_cycle':
        return `If a full treatment isn't on your mind right now, how about something smaller at ${salonName}? Reply BOOK to see options.`;
    }
  }
}

// ─────────────────────────────────────────────
// BOOKING-TRIGGERED EARLY EXIT (Section 6.3)
// Called from booking.service.ts when a booking is confirmed for a
// customer who is anywhere in the day30_sent / day37_sent cycle.
// Placed here (not in booking.service.ts) because it's campaign-domain
// logic, even though it's invoked from the booking flow.
// ─────────────────────────────────────────────

export async function markCustomerConvertedOnBooking(
  customerId: string,
): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { revisitCampaignStatus: true },
  });

  if (
    customer &&
    (customer.revisitCampaignStatus === 'day30_sent' ||
      customer.revisitCampaignStatus === 'day37_sent')
  ) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { revisitCampaignStatus: 'converted' },
    });
    log.info({ customerId }, 'Customer marked converted — rebooked during campaign cycle');
  }
}

// ─────────────────────────────────────────────
// WORKER REGISTRATION
// The actual daily trigger (BullMQ repeatable job / cron schedule) is
// registered in cron.worker.ts, which calls runDailyCampaignSweep().
// This Worker instance also accepts ad-hoc manual triggers (e.g. an
// admin "run campaign now" action) via the revisitCampaignQueue.
// ─────────────────────────────────────────────

export const campaignWorker = new Worker(
  QUEUE_NAMES.REVISIT_CAMPAIGN,
  async (_job: Job) => {
    await runDailyCampaignSweep();
  },
  {
    connection: getWorkerConnection(),
    concurrency: 1, // campaign sweep should not run concurrently with itself
  },
);

campaignWorker.on('completed', () => {
  log.info('Campaign sweep completed');
});

campaignWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Campaign sweep job failed');
});
