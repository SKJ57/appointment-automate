/**
 * src/modules/whatsapp/state-machine.ts
 *
 * The core conversational engine. Routes an inbound message through
 * the booking flow based on the customer's current ConversationState.
 *
 * STATE TRANSITION MAP (mirrors packages/shared/types/index.ts):
 *
 *   idle → greeting → awaiting_service_selection → awaiting_slot_selection
 *        → awaiting_slot_confirmation → booking_confirmed → idle
 *
 *   Any state, on reprompt exhaustion → awaiting_human_handoff
 *   awaiting_human_handoff, on reset keyword → idle
 *
 * ENGINE / CONFIG SEPARATION:
 * This file knows the SHAPE of a booking conversation — that a service
 * must be picked before a slot, that a slot must be confirmed before
 * it's claimed. It does NOT know what services exist, what they're
 * called, or how many there are. Every customer-facing list (services,
 * slots) is fetched from the database via booking.service.ts, which is
 * itself populated from CLIENT_CONFIG-driven seed data. Swap the seed
 * data for a different client and this file's logic is unchanged.
 *
 * CONCURRENCY (Risk A3):
 * Every state transition goes through updateSessionState() with the
 * session's current sessionVersion. If that throws
 * SessionVersionConflictError (a concurrent webhook delivery already
 * moved the session), this module catches it, re-fetches the session,
 * and re-runs the routing logic against the now-current state rather
 * than blindly retrying the original transition.
 *
 * THE TRANSACTIONAL OPT-IN (Business Requirement, Risk D4):
 * The confirmation prompt sent in awaiting_slot_selection →
 * awaiting_slot_confirmation bundles the booking confirmation question
 * with the marketing opt-in framing ("Reply YES to confirm... and
 * unlock our VIP list..."). When the customer's YES arrives in
 * awaiting_slot_confirmation, handleSlotConfirmation() calls BOTH
 * createBooking() AND recordTransactionalOptIn() — a single customer
 * action drives two database writes, by design.
 */

import { ConversationSession } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { ConversationState, MessageType, TemplateCategory } from '@theslotbot/shared/types';
import {
  getOrCreateSession,
  updateSessionState,
  hasExceededReprompts,
  isResetKeyword,
  linkSessionToCustomer,
  SessionVersionConflictError,
} from './session.service';
import { findOrCreateCustomer, recordTransactionalOptIn } from '@/modules/booking/customer.service';
import {
  createBooking,
  getAvailableSlots,
} from '@/modules/booking/booking.service';
import {
  SlotAlreadyClaimedError,
  SlotOverlapError,
} from '@/modules/booking/booking.repository';
import { sendMessage } from './gateway';
import { startOfSalonDay, endOfSalonDay, formatInSalonTimezone } from '@/lib/timezone';
import { InboundMessage } from './payload-parser';

const log = logger.child({ module: 'state-machine' });

const MAX_TRANSITION_RETRIES = 3;

// ─────────────────────────────────────────────
// ENTRYPOINT
// ─────────────────────────────────────────────

export async function handleInboundMessage(params: {
  salonId: string;
  salonName: string;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, salonName, message } = params;

  for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt++) {
    try {
      const session = await getOrCreateSession({
        salonId,
        customerPhoneNumber: message.customerPhoneNumber,
      });

      await routeMessage({ salonId, salonName, session, message });
      return; // success
    } catch (err) {
      if (err instanceof SessionVersionConflictError) {
        log.debug(
          { customerPhoneNumber: message.customerPhoneNumber, attempt },
          'Session version conflict — re-reading and retrying routing',
        );
        continue; // re-fetch session and re-route against current state
      }
      throw err;
    }
  }

  log.error(
    { customerPhoneNumber: message.customerPhoneNumber },
    'Exceeded max retries resolving session version conflicts — dropping message',
  );
}

// ─────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────

async function routeMessage(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, salonName, session, message } = params;

  // Reset keyword check applies regardless of state — lets a customer
  // stuck in human_handoff or expired escape back to a fresh start.
  if (
    (session.state === 'awaiting_human_handoff' || session.state === 'expired') &&
    isResetKeyword(message.text)
  ) {
    await transitionAndGreet({ salonId, salonName, session, message });
    return;
  }

  switch (session.state) {
    case 'idle':
    case 'expired':
      await handleGreeting({ salonId, salonName, session, message });
      break;

    case 'greeting':
      // greeting is a transient state set by handleGreeting itself in
      // the same turn it sends the menu; an inbound message should
      // never actually find a session sitting in 'greeting' between
      // turns. Defensive fallback: treat it as awaiting_service_selection.
      await handleServiceSelection({ salonId, salonName, session, message });
      break;

    case 'awaiting_service_selection':
      await handleServiceSelection({ salonId, salonName, session, message });
      break;

    case 'awaiting_slot_selection':
      await handleSlotSelectionReply({ salonId, salonName, session, message });
      break;

    case 'awaiting_slot_confirmation':
      await handleSlotConfirmation({ salonId, salonName, session, message });
      break;

    case 'booking_confirmed':
      // Conversation already completed. Any further message starts fresh.
      await handleGreeting({ salonId, salonName, session, message });
      break;

    case 'awaiting_human_handoff':
      // Did not match the reset-keyword branch above — stay silent or
      // send a gentle "we're still here, type MENU to restart" nudge.
      // Sending nothing avoids spamming a customer who's mid-escalation
      // with reception; reception's manual follow-up is the real channel
      // now. We log for visibility into how often this state is hit.
      log.debug(
        { sessionId: session.id, customerPhoneNumber: message.customerPhoneNumber },
        'Message received while in human_handoff — no automated reply sent',
      );
      break;

    default:
      log.error(
        { sessionId: session.id, state: session.state },
        'Unhandled conversation state',
      );
  }
}

// ─────────────────────────────────────────────
// STEP 1: GREETING
// ─────────────────────────────────────────────

async function handleGreeting(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, salonName, session, message } = params;

  const customer = await findOrCreateCustomer({
    salonId,
    phoneNumber: message.customerPhoneNumber,
  });
  await linkSessionToCustomer(session.id, customer.id);

  const services = await prisma.service.findMany({
    where: { salonId, isActive: true },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, price: true, durationMinutes: true },
  });

  const menuText = buildServiceMenuText(salonName, services);

  await sendCustomerMessage({
    salonId,
    customerId: customer.id,
    customerPhoneNumber: message.customerPhoneNumber,
    templateName: 'service_menu',
    templateParams: { 1: menuText },
  });

  await updateSessionState({
    sessionId: session.id,
    knownVersion: session.sessionVersion,
    newState: 'awaiting_service_selection',
    resetRepromptCount: true,
  });
}

async function transitionAndGreet(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const resetSession = await updateSessionState({
    sessionId: params.session.id,
    knownVersion: params.session.sessionVersion,
    newState: 'idle',
    clearBookingContext: true,
    resetRepromptCount: true,
  });
  await handleGreeting({ ...params, session: resetSession });
}

function buildServiceMenuText(
  salonName: string,
  services: Array<{ id: string; name: string; price: number; durationMinutes: number }>,
): string {
  const lines = services.map(
    (s, i) => `${i + 1}. ${s.name} — ₹${(s.price / 100).toFixed(0)} (${s.durationMinutes} min)`,
  );
  return `Welcome to ${salonName}! Reply with a number to choose a service:\n\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────
// STEP 2: SERVICE SELECTION
// ─────────────────────────────────────────────

async function handleServiceSelection(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, session, message } = params;

  const services = await prisma.service.findMany({
    where: { salonId, isActive: true },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, durationMinutes: true },
  });

  const selectedIndex = parseNumericChoice(message.text);
  const selectedService =
    selectedIndex !== null ? services[selectedIndex - 1] : undefined;

  if (!selectedService) {
    await handleInvalidInput({
      salonId,
      session,
      message,
      repromptMessage:
        'Sorry, I didn\'t catch that. Please reply with the number next to a service from the list above.',
    });
    return;
  }

  // Show available slots for the next few days
  const todayStart = startOfSalonDay();
  const horizonEnd = endOfSalonDay(
    formatInSalonTimezone(
      new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      'YYYY-MM-DD',
    ),
  );

  const slots = await getAvailableSlots({
    salonId,
    serviceId: selectedService.id,
    dateStart: todayStart,
    dateEnd: horizonEnd,
  });

  if (slots.length === 0) {
    await sendCustomerMessage({
      salonId,
      customerId: session.customerId,
      customerPhoneNumber: message.customerPhoneNumber,
      templateName: 'no_slots_available',
      templateParams: {
        1: 'Sorry, we have no available slots in the next week for this service. Please call us directly or try again later.',
      },
    });
    // Stay in service selection so they can pick a different service
    await updateSessionState({
      sessionId: session.id,
      knownVersion: session.sessionVersion,
      newState: 'awaiting_service_selection',
    });
    return;
  }

  const slotMenuText = buildSlotMenuText(slots);

  await sendCustomerMessage({
    salonId,
    customerId: session.customerId,
    customerPhoneNumber: message.customerPhoneNumber,
    templateName: 'slot_menu',
    templateParams: { 1: slotMenuText },
  });

  await updateSessionState({
    sessionId: session.id,
    knownVersion: session.sessionVersion,
    newState: 'awaiting_slot_selection',
    selectedServiceId: selectedService.id,
    resetRepromptCount: true,
  });
}

function buildSlotMenuText(
  slots: Array<{ id: string; startTime: Date }>,
): string {
  const lines = slots.map((s, i) => {
    const dateLabel = formatInSalonTimezone(s.startTime, 'YYYY-MM-DD');
    const timeLabel = formatInSalonTimezone(s.startTime, 'HH:mm');
    return `${i + 1}. ${dateLabel} at ${timeLabel}`;
  });
  return `Here are our next available slots. Reply with a number to choose:\n\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────
// STEP 3: SLOT SELECTION
// ─────────────────────────────────────────────

async function handleSlotSelectionReply(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, session, message } = params;

  if (!session.selectedServiceId) {
    // Lost context somehow — restart cleanly rather than guessing.
    await transitionAndGreet(params);
    return;
  }

  const todayStart = startOfSalonDay();
  const horizonEnd = endOfSalonDay(
    formatInSalonTimezone(
      new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      'YYYY-MM-DD',
    ),
  );

  const slots = await getAvailableSlots({
    salonId,
    serviceId: session.selectedServiceId,
    dateStart: todayStart,
    dateEnd: horizonEnd,
  });

  const selectedIndex = parseNumericChoice(message.text);
  const selectedSlot =
    selectedIndex !== null ? slots[selectedIndex - 1] : undefined;

  if (!selectedSlot) {
    await handleInvalidInput({
      salonId,
      session,
      message,
      repromptMessage:
        'Please reply with the number next to one of the available time slots above.',
    });
    return;
  }

  const service = await prisma.service.findUniqueOrThrow({
    where: { id: session.selectedServiceId },
    select: { name: true, price: true, durationMinutes: true },
  });

  const dateLabel = formatInSalonTimezone(selectedSlot.startTime, 'YYYY-MM-DD');
  const timeLabel = formatInSalonTimezone(selectedSlot.startTime, 'HH:mm');

  // ── THE TRANSACTIONAL OPT-IN PROMPT ──────────────────────────────────
  // Business requirement: bundle the booking confirmation with the
  // marketing opt-in. A single YES reply does both. The wording itself
  // is product/legal-owned copy — confirm compliance posture before
  // launch — but the mechanism (one reply, two effects) is implemented
  // in handleSlotConfirmation() below.
  const confirmationText =
    `${service.name} on ${dateLabel} at ${timeLabel} (₹${(service.price / 100).toFixed(0)}).\n\n` +
    `Your slot is available! Reply YES to confirm this booking and unlock our VIP list ` +
    `for occasional last-minute discounts.`;

  await sendCustomerMessage({
    salonId,
    customerId: session.customerId,
    customerPhoneNumber: message.customerPhoneNumber,
    templateName: 'booking_confirmation_prompt',
    templateParams: { 1: confirmationText },
  });

  await updateSessionState({
    sessionId: session.id,
    knownVersion: session.sessionVersion,
    newState: 'awaiting_slot_confirmation',
    selectedSlotId: selectedSlot.id,
    resetRepromptCount: true,
  });
}

// ─────────────────────────────────────────────
// STEP 4: SLOT CONFIRMATION (booking + transactional opt-in)
// ─────────────────────────────────────────────

async function handleSlotConfirmation(params: {
  salonId: string;
  salonName: string;
  session: ConversationSession;
  message: InboundMessage;
}): Promise<void> {
  const { salonId, session, message } = params;

  const normalized = (message.text ?? message.buttonReplyId ?? '').trim().toLowerCase();
  const isConfirmed = normalized === 'yes' || normalized === 'y' || normalized === 'confirm';
  const isRejected = normalized === 'no' || normalized === 'n' || normalized === 'cancel';

  if (isRejected) {
    // Go back to slot selection so they can pick a different time,
    // without losing their selected service.
    await sendCustomerMessage({
      salonId,
      customerId: session.customerId,
      customerPhoneNumber: message.customerPhoneNumber,
      templateName: 'booking_declined',
      templateParams: { 1: 'No problem — here are the available slots again.' },
    });
    await updateSessionState({
      sessionId: session.id,
      knownVersion: session.sessionVersion,
      newState: 'awaiting_slot_selection',
      selectedSlotId: null,
    });
    return;
  }

  if (!isConfirmed) {
    await handleInvalidInput({
      salonId,
      session,
      message,
      repromptMessage: 'Please reply YES to confirm this booking, or NO to choose a different time.',
    });
    return;
  }

  if (!session.customerId || !session.selectedServiceId || !session.selectedSlotId) {
    await transitionAndGreet(params);
    return;
  }

  const [service, slot] = await Promise.all([
    prisma.service.findUniqueOrThrow({
      where: { id: session.selectedServiceId },
      select: { durationMinutes: true },
    }),
    prisma.slot.findUniqueOrThrow({
      where: { id: session.selectedSlotId },
      select: { startTime: true },
    }),
  ]);

  try {
    const booking = await createBooking({
      salonId,
      customerId: session.customerId,
      serviceId: session.selectedServiceId,
      slotId: session.selectedSlotId,
      slotStart: slot.startTime,
      durationMinutes: service.durationMinutes,
      source: 'whatsapp',
    });

    // The transactional opt-in: this single YES also sets whatsappOptIn.
    // See Risk D4 and customer.service.ts for the compliance framing notes.
    await recordTransactionalOptIn(session.customerId);

    await sendCustomerMessage({
      salonId,
      customerId: session.customerId,
      customerPhoneNumber: message.customerPhoneNumber,
      templateName: 'booking_confirmed',
      templateParams: {
        1: `You're all set! We'll send you a reminder closer to your appointment.`,
      },
      messageType: MessageType.BOOKING_CONFIRM,
      templateCategory: TemplateCategory.UTILITY,
      bookingId: booking.id,
    });

    await updateSessionState({
      sessionId: session.id,
      knownVersion: session.sessionVersion,
      newState: 'booking_confirmed',
      clearBookingContext: true,
    });
  } catch (err) {
    if (err instanceof SlotAlreadyClaimedError || err instanceof SlotOverlapError) {
      // Risk B1 in action: someone else claimed this slot in the
      // milliseconds between selection and confirmation. Re-offer
      // fresh availability rather than failing silently.
      log.info(
        { sessionId: session.id, slotId: session.selectedSlotId },
        'Slot claim lost race at confirmation time — re-offering availability',
      );
      await sendCustomerMessage({
        salonId,
        customerId: session.customerId,
        customerPhoneNumber: message.customerPhoneNumber,
        templateName: 'slot_unavailable',
        templateParams: {
          1: 'Sorry, that slot was just taken by another customer. Let me show you what else is available.',
        },
      });
      await updateSessionState({
        sessionId: session.id,
        knownVersion: session.sessionVersion,
        newState: 'awaiting_service_selection',
        clearBookingContext: true,
      });
      return;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// REPROMPT HANDLING (Risk A2)
// ─────────────────────────────────────────────

async function handleInvalidInput(params: {
  salonId: string;
  session: ConversationSession;
  message: InboundMessage;
  repromptMessage: string;
}): Promise<void> {
  const { salonId, session, message, repromptMessage } = params;

  if (hasExceededReprompts(session)) {
    await sendCustomerMessage({
      salonId,
      customerId: session.customerId,
      customerPhoneNumber: message.customerPhoneNumber,
      templateName: 'human_handoff',
      templateParams: {
        1: "I'm having trouble understanding. Please type MENU to start over, or call us directly for help.",
      },
    });
    await updateSessionState({
      sessionId: session.id,
      knownVersion: session.sessionVersion,
      newState: 'awaiting_human_handoff',
    });
    return;
  }

  await sendCustomerMessage({
    salonId,
    customerId: session.customerId,
    customerPhoneNumber: message.customerPhoneNumber,
    templateName: 'reprompt',
    templateParams: { 1: repromptMessage },
  });

  await updateSessionState({
    sessionId: session.id,
    knownVersion: session.sessionVersion,
    newState: session.state, // stay in the same state
    incrementReprompt: true,
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function parseNumericChoice(text: string | null): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

/**
 * Sends a conversational reply. Distinct from the booking/reminder/
 * campaign sends in that these are direct, synchronous replies within
 * an active conversation turn, not BullMQ-scheduled jobs — but they
 * still go through the same gateway and, for the booking confirmation
 * specifically, the same booking-scoped idempotency key (bookingId +
 * BOOKING_CONFIRM) used everywhere else. Conversational prompts that
 * aren't tied to a specific booking (menus, reprompts) pass a
 * synthetic always-unique date stamp so they don't collide with the
 * customer-scoped campaign idempotency key format — they aren't meant
 * to be deduplicated the way a scheduled campaign message is.
 */
async function sendCustomerMessage(params: {
  salonId: string;
  customerId: string | null;
  customerPhoneNumber: string;
  templateName: string;
  templateParams: Record<string, string>;
  messageType?: MessageType;
  templateCategory?: TemplateCategory;
  bookingId?: string;
}): Promise<void> {
  if (!params.customerId) {
    log.error(
      { customerPhoneNumber: params.customerPhoneNumber },
      'Attempted to send a message with no linked customerId',
    );
    return;
  }

  await sendMessage({
    salonId: params.salonId,
    customerId: params.customerId,
    customerPhone: params.customerPhoneNumber,
    messageType: params.messageType ?? MessageType.BOOKING_CONFIRM,
    templateCategory: params.templateCategory ?? TemplateCategory.UTILITY,
    templateName: params.templateName,
    templateParams: params.templateParams,
    bookingId: params.bookingId,
    campaignDate: params.bookingId ? undefined : new Date().toISOString(),
  });
}
