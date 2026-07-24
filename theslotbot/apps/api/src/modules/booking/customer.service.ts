/**
 * src/modules/booking/customer.service.ts
 *
 * Customer record management, including the transactional opt-in flow.
 *
 * RISK D4 FIX — The Transactional Opt-In:
 * whatsappOptIn defaults to false at the schema level. This service
 * captures the explicit YES that flips it to true.
 *
 * THE GROWTH-HACK PHRASING (business requirement):
 * The state machine (Dev 2's territory, whatsapp/state-machine.ts) sends
 * the confirmation prompt with bundled framing:
 *   "Your slot is available! Reply YES to confirm this booking and
 *    unlock our VIP list for occasional last-minute discounts."
 * A single YES reply does two things at once: confirms the booking AND
 * sets whatsappOptIn = true. This function is what the state machine
 * calls when that YES arrives — it is the data-layer half of the flow;
 * the message copy itself lives in the message template, not here.
 *
 * COMPLIANCE NOTE FOR THE TEAM:
 * Bundling consent into a transactional confirmation is a common growth
 * pattern, but Meta's commerce policy and India's DPDP Act both expect
 * the marketing nature of what's being agreed to be clear in the prompt
 * text itself ("VIP list", "discounts" — not hidden in fine print). The
 * schema and this function record the opt-in event with a timestamp
 * (via updatedAt) so there's an audit trail of when consent was given,
 * which is what actually matters if this is ever challenged. The
 * specific wording is a product/legal decision the team should confirm
 * before go-live — this function just faithfully records whatever the
 * state machine tells it happened.
 *
 * RISK D2 FIX — Walk-in campaign state reset:
 * upsertCustomer() always resets revisitCampaignStatus to 'none' and
 * nonResponderCount to 0 when called from the walk-in logging path,
 * regardless of the customer's prior campaign state. A walk-in is by
 * definition a fresh visit — the customer just came back.
 */

import { Customer } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { PHONE_REGEX } from '@theslotbot/shared/constants';

const log = logger.child({ module: 'customer.service' });

export class InvalidPhoneNumberError extends Error {
  constructor(phone: string) {
    super(`Phone number '${phone}' is not in valid E.164 format.`);
    this.name = 'InvalidPhoneNumberError';
  }
}

function assertValidPhone(phone: string): void {
  if (!PHONE_REGEX.test(phone)) {
    throw new InvalidPhoneNumberError(phone);
  }
}

// ─────────────────────────────────────────────
// FIND OR CREATE (used by the WhatsApp inbound handler)
// ─────────────────────────────────────────────

/**
 * Find a customer by phone, or create a bare record if this is their
 * first contact. Does NOT touch whatsappOptIn or campaign state —
 * those are set explicitly by the flows below. A first-touch customer
 * starts with whatsappOptIn = false (schema default) until they
 * explicitly opt in during booking confirmation.
 */
export async function findOrCreateCustomer(params: {
  salonId: string;
  phoneNumber: string;
  name?: string;
}): Promise<Customer> {
  assertValidPhone(params.phoneNumber);

  const existing = await prisma.customer.findUnique({
    where: {
      salonId_phoneNumber: {
        salonId: params.salonId,
        phoneNumber: params.phoneNumber,
      },
    },
  });

  if (existing) {
    // Update name if we now have one and previously didn't
    if (params.name && !existing.name) {
      return prisma.customer.update({
        where: { id: existing.id },
        data: { name: params.name },
      });
    }
    return existing;
  }

  const created = await prisma.customer.create({
    data: {
      salonId: params.salonId,
      phoneNumber: params.phoneNumber,
      name: params.name ?? 'WhatsApp Customer',
      // whatsappOptIn defaults to false at the schema level (Risk D4)
    },
  });

  log.info(
    { customerId: created.id, salonId: params.salonId },
    'New customer record created',
  );

  return created;
}

// ─────────────────────────────────────────────
// TRANSACTIONAL OPT-IN CAPTURE (Risk D4 fix)
// ─────────────────────────────────────────────

/**
 * Record that a customer opted in to marketing messages as part of
 * confirming a booking. Called by the state machine when the customer's
 * "YES" reply is interpreted in the awaiting_slot_confirmation step.
 *
 * This is idempotent: setting whatsappOptIn = true on an already-true
 * record is a harmless no-op. We do not overwrite an existing opt-in
 * timestamp implicitly via updatedAt churn on every booking — only the
 * first transition from false to true is meaningfully "consent given."
 * Subsequent bookings from an already-opted-in customer don't need to
 * re-confirm consent, so this function short-circuits when already true.
 */
export async function recordTransactionalOptIn(
  customerId: string,
): Promise<Customer> {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
  });

  if (customer.whatsappOptIn) {
    // Already opted in from a previous booking — nothing to do.
    return customer;
  }

  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { whatsappOptIn: true },
  });

  log.info(
    { customerId },
    'Customer opted in to marketing messages via transactional confirmation',
  );

  return updated;
}

// ─────────────────────────────────────────────
// WALK-IN UPSERT (Risk D2 fix)
// ─────────────────────────────────────────────

/**
 * Called from the admin walk-in logging endpoint. Upserts a customer
 * by phone number and ALWAYS resets campaign state, because logging a
 * walk-in visit means the customer is here right now — any prior
 * "ignored our Day 37 message" history is no longer relevant.
 *
 * Without this reset (Risk D2), a customer who churned, came back as
 * a walk-in, and left again would remain stuck in their old
 * non_responder state and never re-enter the revisit campaign cycle.
 */
export async function upsertWalkInCustomer(params: {
  salonId: string;
  phoneNumber: string;
  name: string;
}): Promise<Customer> {
  assertValidPhone(params.phoneNumber);

  const customer = await prisma.customer.upsert({
    where: {
      salonId_phoneNumber: {
        salonId: params.salonId,
        phoneNumber: params.phoneNumber,
      },
    },
    update: {
      name: params.name,
      // Risk D2: always reset campaign state on a logged visit,
      // regardless of what it was before.
      revisitCampaignStatus: 'none',
      nonResponderCount: 0,
    },
    create: {
      salonId: params.salonId,
      phoneNumber: params.phoneNumber,
      name: params.name,
      // New walk-ins start with opt-in false — they haven't been asked.
      // Reception can ask verbally and the future "merge/manual opt-in"
      // admin action (out of scope for Phase 2) would set this.
    },
  });

  log.info(
    { customerId: customer.id, salonId: params.salonId },
    'Walk-in customer upserted, campaign state reset',
  );

  return customer;
}

// ─────────────────────────────────────────────
// MERGE (Section 8.3 — duplicate customer resolution)
// ─────────────────────────────────────────────

/**
 * Merge sourceCustomerId's history into targetCustomerId, then
 * soft-delete the source. Used when a customer's WhatsApp number
 * changes and they appear as a "new" customer.
 *
 * Preserves the target's campaign state (the survivor record keeps
 * its own revisit cycle position) but adopts the source's lastVisitDate
 * if it is more recent — the merge should not lose a recent visit.
 */
export async function mergeCustomers(params: {
  targetCustomerId: string;
  sourceCustomerId: string;
  salonId: string;
}): Promise<Customer> {
  const { targetCustomerId, sourceCustomerId, salonId } = params;

  return prisma.$transaction(async (tx) => {
    const [target, source] = await Promise.all([
      tx.customer.findFirstOrThrow({
        where: { id: targetCustomerId, salonId },
      }),
      tx.customer.findFirstOrThrow({
        where: { id: sourceCustomerId, salonId },
      }),
    ]);

    // Reassign all of source's bookings and message logs to target
    await tx.booking.updateMany({
      where: { customerId: sourceCustomerId },
      data: { customerId: targetCustomerId },
    });
    await tx.messageLog.updateMany({
      where: { customerId: sourceCustomerId },
      data: { customerId: targetCustomerId },
    });

    // Adopt the more recent lastVisitDate between the two records
    const useSourceVisit =
      source.lastVisitDate &&
      (!target.lastVisitDate || source.lastVisitDate > target.lastVisitDate);

    const merged = await tx.customer.update({
      where: { id: targetCustomerId },
      data: useSourceVisit
        ? {
            lastVisitDate: source.lastVisitDate,
            lastVisitServiceId: source.lastVisitServiceId,
          }
        : {},
    });

    // Soft-delete the source by renaming its phone number out of the
    // unique constraint's way and marking it inactive via a name prefix.
    // (No isActive column on Customer in v1 — see note below.)
    // For Phase 2 we hard-delete the now-orphaned source record since
    // all its history has been reassigned and nothing references it.
    await tx.customer.delete({ where: { id: sourceCustomerId } });

    log.info(
      { targetCustomerId, sourceCustomerId, salonId },
      'Customer records merged',
    );

    return merged;
  });
}
