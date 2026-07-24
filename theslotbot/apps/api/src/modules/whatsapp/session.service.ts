/**
 * src/modules/whatsapp/session.service.ts
 *
 * Manages ConversationSession persistence: timeout detection (Risk A1),
 * optimistic locking against concurrent webhook deliveries (Risk A3),
 * and reprompt counting (Risk A2).
 *
 * WHY STATE LIVES IN THE DATABASE:
 * A server restart, deploy, or autoscale event must never lose an
 * in-progress booking conversation. Every read/write here goes through
 * Postgres, never an in-memory Map. This is what makes the Booking API
 * Server horizontally scalable without any session-affinity requirement.
 */

import { ConversationSession, ConversationState } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config';
import { SESSION_RESET_KEYWORDS } from '@theslotbot/shared/constants';

const log = logger.child({ module: 'session.service' });

export class SessionVersionConflictError extends Error {
  constructor() {
    super('Session was modified concurrently. Caller should re-read and retry.');
    this.name = 'SessionVersionConflictError';
  }
}

// ─────────────────────────────────────────────
// GET OR CREATE
// ─────────────────────────────────────────────

/**
 * Fetches the session for a phone number, applying timeout logic
 * (Risk A1) before returning it.
 *
 * If no session exists, creates one in 'idle' state.
 * If a session exists but lastActivityAt is older than
 * CLIENT_CONFIG.conversation.sessionTimeoutMinutes, the session is
 * reset to 'idle' with repromptCount cleared — effectively a fresh
 * start, but the row itself is reused (not deleted) so booking context
 * like selectedServiceId is also cleared as part of this same operation.
 */
export async function getOrCreateSession(params: {
  salonId: string;
  customerPhoneNumber: string;
}): Promise<ConversationSession> {
  const { salonId, customerPhoneNumber } = params;

  const existing = await prisma.conversationSession.findUnique({
    where: {
      salonId_customerPhoneNumber: { salonId, customerPhoneNumber },
    },
  });

  if (!existing) {
    return prisma.conversationSession.create({
      data: { salonId, customerPhoneNumber, state: 'idle' },
    });
  }

  const timeoutMs =
    CLIENT_CONFIG.conversation.sessionTimeoutMinutes * 60 * 1000;
  const isExpired =
    Date.now() - existing.lastActivityAt.getTime() > timeoutMs;

  if (isExpired && existing.state !== 'idle') {
    log.debug(
      { sessionId: existing.id, customerPhoneNumber, previousState: existing.state },
      'Session expired due to inactivity — resetting to idle',
    );

    // Reuse the optimistic-lock update path so a concurrent inbound
    // message racing this timeout check is still handled safely.
    return updateSessionState({
      sessionId: existing.id,
      knownVersion: existing.sessionVersion,
      newState: 'idle',
      clearBookingContext: true,
      resetRepromptCount: true,
    });
  }

  return existing;
}

// ─────────────────────────────────────────────
// OPTIMISTIC-LOCKED UPDATE (Risk A3)
// ─────────────────────────────────────────────

export interface UpdateSessionStateParams {
  sessionId: string;
  knownVersion: number;
  newState: ConversationState;
  selectedServiceId?: string | null;
  selectedSlotId?: string | null;
  clearBookingContext?: boolean;
  incrementReprompt?: boolean;
  resetRepromptCount?: boolean;
}

/**
 * Updates a session's state using an optimistic lock.
 *
 * The WHERE clause includes sessionVersion = knownVersion. If a
 * concurrent request (e.g. a duplicate Meta webhook delivery, or a
 * customer double-tapping send) already updated this session, the
 * version will have moved and this UPDATE affects 0 rows.
 *
 * On a 0-row result, this throws SessionVersionConflictError. The
 * caller (state-machine.ts) catches this, re-reads the session, and
 * re-evaluates the incoming message against the now-current state —
 * it does NOT blindly retry the same transition, because the
 * concurrent update may have already moved the conversation forward
 * in a way that makes the original transition invalid.
 */
export async function updateSessionState(
  params: UpdateSessionStateParams,
): Promise<ConversationSession> {
  const {
    sessionId,
    knownVersion,
    newState,
    selectedServiceId,
    selectedSlotId,
    clearBookingContext,
    incrementReprompt,
    resetRepromptCount,
  } = params;

  const data: Record<string, unknown> = {
    state: newState,
    sessionVersion: { increment: 1 },
    lastActivityAt: new Date(),
  };

  if (clearBookingContext) {
    data.selectedServiceId = null;
    data.selectedSlotId = null;
  } else {
    if (selectedServiceId !== undefined) data.selectedServiceId = selectedServiceId;
    if (selectedSlotId !== undefined) data.selectedSlotId = selectedSlotId;
  }

  if (resetRepromptCount) {
    data.repromptCount = 0;
  } else if (incrementReprompt) {
    data.repromptCount = { increment: 1 };
  }

  const result = await prisma.conversationSession.updateMany({
    where: { id: sessionId, sessionVersion: knownVersion },
    data,
  });

  if (result.count === 0) {
    throw new SessionVersionConflictError();
  }

  // Re-read to return the full updated row (updateMany doesn't return it)
  return prisma.conversationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
}

// ─────────────────────────────────────────────
// REPROMPT GUARD (Risk A2)
// ─────────────────────────────────────────────

/**
 * Determines whether the session has exceeded the reprompt limit and
 * should be escalated to human handoff.
 */
export function hasExceededReprompts(session: ConversationSession): boolean {
  return session.repromptCount >= CLIENT_CONFIG.conversation.maxReprompts;
}

/**
 * Checks if an inbound text matches one of the configured reset
 * keywords (used to exit awaiting_human_handoff / expired states).
 */
export function isResetKeyword(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return (SESSION_RESET_KEYWORDS as readonly string[]).includes(normalized);
}

// ─────────────────────────────────────────────
// LINK CUSTOMER
// ─────────────────────────────────────────────

/**
 * Associates a session with a Customer record once one has been
 * created/found. Sessions can exist before a Customer record does
 * (first contact), so this is called separately once the customer
 * service resolves the customer.
 */
export async function linkSessionToCustomer(
  sessionId: string,
  customerId: string,
): Promise<void> {
  await prisma.conversationSession.update({
    where: { id: sessionId },
    data: { customerId },
  });
}
