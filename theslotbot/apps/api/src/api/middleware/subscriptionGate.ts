/**
 * src/api/middleware/subscriptionGate.ts
 *
 * Business Requirement 2 — The Soft Kill Switch.
 *
 * This middleware runs AFTER validateWebhookSignature (so we trust the
 * payload came from Meta) and BEFORE the message reaches the
 * conversation state machine. It is the single enforcement point for
 * "is this salon allowed to talk to customers right now."
 *
 * THREE STATES, THREE BEHAVIORS:
 *
 *   active     → next() is called immediately. No overhead beyond the
 *                salon lookup. The state machine never knows this gate
 *                exists — this is the engine/config separation in
 *                practice: the core conversation logic has zero
 *                awareness of subscription billing.
 *
 *   suspended  → The Ghost Rule engages. We check whether this phone
 *                number has already received the offline notice within
 *                the rate-limit window (offline-message.service.ts).
 *                  - If not sent recently: send it now, record it,
 *                    then respond 200 to Meta and STOP. The state
 *                    machine is never invoked.
 *                  - If already sent recently: respond 200 to Meta
 *                    immediately and STOP. No API call, no DB write
 *                    beyond what the rate-limit check itself required.
 *                    This is the actual cost-control mechanism — a
 *                    customer who messages 50 times in an hour costs
 *                    us one Meta API call, not fifty.
 *
 *   cancelled  → Respond 200 and STOP. No message of any kind is sent,
 *                ever, to a cancelled client's customers. This is
 *                permanent termination, not a billing hiccup.
 *
 * WHY THIS RETURNS 200 IN ALL THREE INTERCEPT CASES:
 * Per Meta's webhook contract, a non-200 response causes Meta to retry
 * delivery. A suspended/cancelled salon intercepting and dropping a
 * message is the CORRECT terminal outcome, not an error — retrying
 * would just mean re-running this same gate logic repeatedly for no
 * benefit. We always return 200 once our own processing (successful
 * or intentionally-skipped) is complete.
 *
 * WHERE THE SALON IS RESOLVED FROM:
 * Meta's webhook payload identifies the destination WhatsApp Business
 * number. We look up the Salon by that number. If no salon matches
 * (shouldn't happen in a correctly configured single-tenant-per-deploy
 * setup, but defensive nonetheless), we log an alert-worthy error and
 * drop the request — there's no salon context to act on.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  checkGhostRuleEligibility,
  recordOfflineMessageSent,
} from '@/modules/notifications/offline-message.service';
import { sendOfflineMessage } from '@/modules/whatsapp/gateway';
import { extractInboundMessage } from '@/modules/whatsapp/payload-parser';

const log = logger.child({ module: 'subscriptionGate' });

/**
 * Express type augmentation: downstream handlers (the webhook route's
 * final handler, which dispatches to the state machine) can read the
 * resolved salon off req.salon instead of re-querying it.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      salon?: {
        id: string;
        name: string;
        subscriptionStatus: string;
        serviceOfflineMessage: string | null;
      };
    }
  }
}

export const subscriptionGate: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Meta sends several payload shapes to this endpoint (message events,
  // status callbacks, etc). We only need the destination business
  // number and, for message events, the sender's number, both of which
  // payload-parser.ts extracts uniformly.
  const parsed = extractInboundMessage(req.body);

  if (!parsed) {
    // Not a customer message (could be a status callback, or a payload
    // shape we don't recognise). Those don't need the kill switch at
    // all — let them through to the webhook handler, which routes
    // status callbacks to message-log.service.ts directly.
    next();
    return;
  }

  const { businessPhoneNumber, customerPhoneNumber, inboundMessageId } = parsed;

  const salon = await prisma.salon.findUnique({
    where: { whatsappNumber: businessPhoneNumber },
    select: {
      id: true,
      name: true,
      subscriptionStatus: true,
      serviceOfflineMessage: true,
    },
  });

  if (!salon) {
    log.error(
      { businessPhoneNumber },
      'Webhook received for unrecognised business number — no matching salon. Dropping.',
    );
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  // ── ACTIVE: pass through, zero overhead beyond the lookup above ─────
  if (salon.subscriptionStatus === 'active') {
    req.salon = salon;
    next();
    return;
  }

  // ── CANCELLED: permanent silence, no exceptions ──────────────────────
  if (salon.subscriptionStatus === 'cancelled') {
    log.debug(
      { salonId: salon.id, customerPhoneNumber },
      'Message dropped — salon subscription is cancelled',
    );
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  // ── SUSPENDED: the 24-Hour Ghost Rule ─────────────────────────────────
  if (salon.subscriptionStatus === 'suspended') {
    const eligibility = await checkGhostRuleEligibility({
      salonId: salon.id,
      customerPhone: customerPhoneNumber,
    });

    if (!eligibility.shouldSend) {
      // Already notified this number within the rate-limit window.
      // Silent drop — no API call, no new log row.
      log.debug(
        { salonId: salon.id, customerPhoneNumber, lastSentAt: eligibility.lastSentAt },
        'Ghost rule: offline notice already sent recently — dropping silently',
      );
      res.status(200).send('EVENT_RECEIVED');
      return;
    }

    // First contact (or first contact in 24h) while suspended — send
    // the one-time offline notice.
    try {
      await sendOfflineMessage({
        customerPhone: customerPhoneNumber,
        salon: {
          name: salon.name,
          serviceOfflineMessage: salon.serviceOfflineMessage,
        },
      });

      // Look up whether this phone number has a Customer record, purely
      // for the optional FK on OfflineMessageLog — not required for
      // the rate-limit logic itself, which keys on phone number alone.
      const existingCustomer = await prisma.customer.findFirst({
        where: { salonId: salon.id, phoneNumber: customerPhoneNumber },
        select: { id: true },
      });

      await recordOfflineMessageSent({
        salonId: salon.id,
        customerPhone: customerPhoneNumber,
        customerId: existingCustomer?.id,
      });

      log.info(
        { salonId: salon.id, customerPhoneNumber, inboundMessageId },
        'Offline notice sent to customer of suspended salon',
      );
    } catch (err) {
      // If the offline-message send itself fails (Meta API error), log
      // it but still drop the request — we do not want a send failure
      // here to fall through to the state machine, which would defeat
      // the entire purpose of the kill switch.
      log.error(
        { err, salonId: salon.id, customerPhoneNumber },
        'Failed to send offline notice — dropping request anyway (kill switch must hold)',
      );
    }

    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  // Unreachable given the enum, but TypeScript and defensive coding
  // both want an explicit fallback rather than an implicit pass-through.
  log.error(
    { salonId: salon.id, subscriptionStatus: salon.subscriptionStatus },
    'Unrecognised subscription status — dropping request as a safety default',
  );
  res.status(200).send('EVENT_RECEIVED');
};
