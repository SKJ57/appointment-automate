/**
 * src/modules/notifications/offline-message.service.ts
 *
 * Business Requirement 2 — The 24-Hour Ghost Rule.
 *
 * When a salon's subscription is suspended, every inbound WhatsApp
 * message must be intercepted before it reaches the conversation state
 * machine. The customer gets a single offline notice; nothing else
 * about the bot is allowed to engage.
 *
 * THE RATE LIMIT, PRECISELY:
 * A given customer phone number may receive the offline message at
 * most once per CLIENT_CONFIG.subscription.offlineMessageRateLimitHours
 * (default 24h). Every message they send within that window after
 * receiving the notice is silently dropped — no API call to Meta, no
 * new log row, nothing. This exists specifically to prevent a spammy
 * or confused customer from generating unbounded Meta API costs while
 * the salon owner isn't paying their subscription.
 *
 * WHY THIS IS A SEPARATE TABLE FROM MessageLog (see schema comments):
 * An offline customer may not have a Customer record at all (could be
 * a brand-new number messaging in for the first time while the salon
 * happens to be suspended). OfflineMessageLog.customerPhone has no FK
 * requirement, unlike MessageLog.customerId.
 *
 * THIS MODULE DOES NOT SEND THE MESSAGE ITSELF.
 * It only decides whether a send is permitted right now, and records
 * that a send happened. The actual Meta API call lives in gateway.ts.
 * This keeps the rate-limit logic testable without mocking the network.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config';

const log = logger.child({ module: 'offline-message.service' });

export interface GhostRuleCheckResult {
  /** True if the offline message should be sent right now. */
  shouldSend: boolean;
  /** The most recent prior send, if one exists within the lookback window. */
  lastSentAt: Date | null;
}

/**
 * Checks whether the offline message is permitted to be sent to this
 * phone number right now, per the 24-hour ghost rule.
 *
 * Does NOT record a send — call recordOfflineMessageSent() separately
 * after the actual Meta API call succeeds, consistent with the
 * "log before send, confirm after" principle used throughout the system
 * (here inverted slightly: we check eligibility first, send, then log,
 * because this table's purpose is rate-limiting, not delivery tracking —
 * there's no Meta status callback wired to this table).
 */
export async function checkGhostRuleEligibility(params: {
  salonId: string;
  customerPhone: string;
}): Promise<GhostRuleCheckResult> {
  const { salonId, customerPhone } = params;
  const rateLimitHours = CLIENT_CONFIG.subscription.offlineMessageRateLimitHours;
  const cutoff = new Date(Date.now() - rateLimitHours * 60 * 60 * 1000);

  const recentSend = await prisma.offlineMessageLog.findFirst({
    where: {
      salonId,
      customerPhone,
      sentAt: { gt: cutoff },
    },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });

  if (recentSend) {
    log.debug(
      { salonId, customerPhone, lastSentAt: recentSend.sentAt },
      'Ghost rule: offline message already sent within rate-limit window — will drop',
    );
    return { shouldSend: false, lastSentAt: recentSend.sentAt };
  }

  return { shouldSend: true, lastSentAt: null };
}

/**
 * Records that the offline message was sent to this phone number.
 * Called by the webhook handler immediately after the Meta API call
 * for the offline notice succeeds (or is enqueued — see gateway.ts
 * for the queue-vs-direct-send distinction; offline messages are
 * sent synchronously since they're a single short message, not a
 * scheduled job, so there's no separate "queued" state to track here).
 */
export async function recordOfflineMessageSent(params: {
  salonId: string;
  customerPhone: string;
  customerId?: string; // populated if a Customer record happens to exist
}): Promise<void> {
  await prisma.offlineMessageLog.create({
    data: {
      salonId: params.salonId,
      customerPhone: params.customerPhone,
      customerId: params.customerId,
    },
  });

  log.info(
    { salonId: params.salonId, customerPhone: params.customerPhone },
    'Offline message sent and rate-limit window started',
  );
}
