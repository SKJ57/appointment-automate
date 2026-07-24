/**
 * src/modules/notifications/message-log.service.ts
 *
 * The idempotency layer for all outbound WhatsApp messages.
 *
 * DESIGN PRINCIPLE (from spec Section 1.3):
 * "Every outbound message is logged before it is sent and updated
 *  after — never the reverse — so a crash mid-send never produces
 *  an unaccounted-for message."
 *
 * HOW IDEMPOTENCY WORKS (Risk C1 fix):
 * Before any message send attempt, call acquireSendLock().
 * It attempts to INSERT a MessageLog row with a deterministic
 * idempotency key. Postgres enforces uniqueness on that key.
 *
 * Two outcomes:
 *   INSERT succeeds → this process owns the send. Proceed.
 *   INSERT fails (unique violation) → already sent or being sent
 *     concurrently. Return null. Caller silently drops the attempt.
 *
 * This guarantees at-most-once delivery at the application layer,
 * independent of BullMQ retry behaviour or Meta webhook duplication.
 *
 * IDEMPOTENCY KEY FORMAT:
 *   Booking-scoped messages:  `${bookingId}::${messageType}`
 *     e.g. "abc-123::reminder_24h"
 *   Customer-scoped messages: `${customerId}::${messageType}::${YYYY-MM-DD}`
 *     e.g. "def-456::revisit_day30::2026-06-28"
 *   The date suffix on customer-scoped keys means a customer who gets
 *   a Day 30 message in June and returns in September correctly gets
 *   a new Day 30 message — the key no longer conflicts.
 */

import { Prisma, MessageLog, MessageStatus } from '@prisma/client';
import { MessageType, TemplateCategory } from '@theslotbot/shared/types';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'message-log.service' });

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface AcquireLockParams {
  idempotencyKey: string;
  messageType: MessageType;
  templateCategory: TemplateCategory;
  customerId: string;
  salonId: string;
  bookingId?: string;
}

export interface AcquireLockResult {
  messageLogId: string;
  acquired: boolean;
}

// ─────────────────────────────────────────────
// KEY BUILDERS
// ─────────────────────────────────────────────

export const IdempotencyKey = {
  /**
   * For booking-scoped messages (confirm, reminder_24h, reminder_3h,
   * review_request). One key per booking per message type.
   */
  forBooking: (bookingId: string, messageType: MessageType): string =>
    `${bookingId}::${messageType}`,

  /**
   * For customer-scoped messages (revisit campaigns). Includes the
   * current date so a returning customer gets re-enrolled correctly
   * in future cycles without the key conflicting with past sends.
   */
  forCustomer: (
    customerId: string,
    messageType: MessageType,
    date: string, // YYYY-MM-DD in salon timezone
  ): string => `${customerId}::${messageType}::${date}`,
};

// ─────────────────────────────────────────────
// ACQUIRE LOCK
// ─────────────────────────────────────────────

/**
 * Attempt to acquire the send lock for a message by inserting a
 * MessageLog row with status=queued.
 *
 * Returns { acquired: true, messageLogId } if this call owns the send.
 * Returns { acquired: false, messageLogId } if already sent/in-flight.
 *
 * The caller must check `acquired` before proceeding with the send.
 * If acquired is false, drop the message silently — no retry, no error.
 */
export async function acquireSendLock(
  params: AcquireLockParams,
): Promise<AcquireLockResult> {
  const {
    idempotencyKey,
    messageType,
    templateCategory,
    customerId,
    salonId,
    bookingId,
  } = params;

  try {
    const messageLog = await prisma.messageLog.create({
      data: {
        idempotencyKey,
        messageType,
        templateCategory,
        status: 'queued',
        customerId,
        salonId,
        bookingId,
      },
      select: { id: true },
    });

    log.debug(
      { idempotencyKey, messageType, customerId },
      'Send lock acquired',
    );

    return { messageLogId: messageLog.id, acquired: true };
  } catch (err) {
    // Prisma throws P2002 on unique constraint violations.
    // This is the expected path for duplicates — not an error condition.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      log.debug(
        { idempotencyKey, messageType },
        'Duplicate send attempt suppressed (idempotency key exists)',
      );

      // Fetch the existing log ID so the caller can track it
      const existing = await prisma.messageLog.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });

      return {
        messageLogId: existing?.id ?? 'unknown',
        acquired: false,
      };
    }

    // Any other error is unexpected — rethrow to let the worker handle it
    throw err;
  }
}

// ─────────────────────────────────────────────
// STATUS UPDATES
// (called by Meta webhook status callbacks)
// ─────────────────────────────────────────────

export async function markSent(
  messageLogId: string,
  metaMessageId: string,
): Promise<void> {
  await prisma.messageLog.update({
    where: { id: messageLogId },
    data: {
      status: 'sent',
      metaMessageId,
      sentAt: new Date(),
    },
  });
}

export async function markDelivered(metaMessageId: string): Promise<void> {
  await prisma.messageLog.updateMany({
    where: { metaMessageId },
    data: {
      status: 'delivered',
      deliveredAt: new Date(),
    },
  });
}

export async function markRead(metaMessageId: string): Promise<void> {
  await prisma.messageLog.updateMany({
    where: { metaMessageId },
    data: {
      status: 'read',
      readAt: new Date(),
    },
  });
}

export async function markFailed(
  messageLogId: string,
  metaErrorCode: string,
): Promise<void> {
  await prisma.messageLog.update({
    where: { id: messageLogId },
    data: {
      status: 'failed',
      metaErrorCode,
      failedAt: new Date(),
    },
  });
}

/**
 * Look up a MessageLog by Meta's message ID.
 * Used when a Meta status webhook arrives and we need to find
 * the local record to update.
 */
export async function findByMetaMessageId(
  metaMessageId: string,
): Promise<MessageLog | null> {
  return prisma.messageLog.findFirst({
    where: { metaMessageId },
  });
}
