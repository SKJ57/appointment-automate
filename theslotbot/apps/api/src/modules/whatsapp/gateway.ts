/**
 * src/modules/whatsapp/gateway.ts
 *
 * The single point of contact with the AiSensy / Meta Cloud API for
 * sending outbound WhatsApp messages.
 *
 * ARCHITECTURE RULE:
 * No other module calls the AiSensy API directly. The state machine,
 * the reminder worker, and the campaign worker all call sendMessage()
 * here. This keeps retry logic, error-code routing, and idempotency
 * integration in exactly one place.
 *
 * RISK C1 INTEGRATION:
 * Every call to sendMessage() first acquires a send lock via
 * message-log.service.ts. If the lock is not acquired (meaning this
 * exact message was already sent or is being sent concurrently),
 * sendMessage() returns immediately without calling the Meta API at all.
 * This is the actual enforcement point of the idempotency guarantee —
 * not just a log entry, but a hard gate before any network call.
 *
 * RISK 6.4 (Gateway resilience) — error-code-aware retry:
 *   131026 (invalid number)   → mark customer.isNumberInvalid = true,
 *                                stop all future attempts to this number.
 *                                Does NOT retry.
 *   131049 (frequency cap)    → re-throw a typed error so the caller
 *                                (a BullMQ worker) can re-queue with a
 *                                24h delay rather than an immediate retry.
 *   Other 5xx / network errors → re-throw for BullMQ's standard
 *                                exponential backoff (configured in
 *                                queues.ts) to handle.
 *
 * DRY RUN MODE:
 * When DRY_RUN_MESSAGES=true, no network call is made. The message is
 * logged to the console and treated as sent. This lets developers run
 * the full booking flow locally without burning real WhatsApp API quota
 * or needing AiSensy credentials configured.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config';
import { MessageType, TemplateCategory } from '@theslotbot/shared/types';
import { META_ERROR_MAP, ERROR_CODES } from '@theslotbot/shared/constants';
import {
  acquireSendLock,
  markSent,
  markFailed,
  IdempotencyKey,
} from '@/modules/notifications/message-log.service';

const log = logger.child({ module: 'whatsapp.gateway' });

const AISENSY_API_KEY = process.env.AISENSY_API_KEY;
const AISENSY_API_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';
const DRY_RUN = process.env.DRY_RUN_MESSAGES === 'true';

if (!AISENSY_API_KEY && !DRY_RUN) {
  throw new Error(
    'AISENSY_API_KEY is not set and DRY_RUN_MESSAGES is not true. ' +
      'The gateway cannot send messages without one or the other.',
  );
}

// ─────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────

/**
 * Thrown when Meta returns the frequency-cap error (131049).
 * Caught by BullMQ workers to trigger a 24h-delayed re-queue instead
 * of the default exponential backoff — immediate retries against a
 * frequency cap simply fail again and waste retry budget.
 */
export class FrequencyCapError extends Error {
  readonly code = ERROR_CODES.META_FREQUENCY_CAP;
  constructor() {
    super('Meta frequency cap reached for this recipient.');
    this.name = 'FrequencyCapError';
  }
}

/**
 * Thrown when Meta reports the destination number is invalid (131026).
 * The caller should NOT retry. The gateway has already marked the
 * customer's number invalid in the database before throwing this.
 */
export class InvalidNumberError extends Error {
  readonly code = ERROR_CODES.META_INVALID_NUMBER;
  constructor() {
    super('Destination WhatsApp number is invalid.');
    this.name = 'InvalidNumberError';
  }
}

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface SendMessageParams {
  salonId: string;
  customerId: string;
  customerPhone: string;
  messageType: MessageType;
  templateCategory: TemplateCategory;
  templateName: string;
  templateParams: Record<string, string>;
  bookingId?: string;
  /**
   * For customer-scoped idempotency keys (campaigns), the date
   * component. Omit for booking-scoped messages.
   */
  campaignDate?: string;
}

export interface SendMessageResult {
  sent: boolean;
  reason?: 'duplicate_suppressed' | 'number_invalid' | 'dry_run';
  metaMessageId?: string;
}

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────

export async function sendMessage(
  params: SendMessageParams,
): Promise<SendMessageResult> {
  const {
    salonId,
    customerId,
    customerPhone,
    messageType,
    templateCategory,
    templateName,
    templateParams,
    bookingId,
    campaignDate,
  } = params;

  // ── Pre-flight: is this number known-invalid? ───────────────────────
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { isNumberInvalid: true },
  });

  if (customer?.isNumberInvalid) {
    log.debug(
      { customerId, customerPhone },
      'Skipping send — number previously marked invalid',
    );
    return { sent: false, reason: 'number_invalid' };
  }

  // ── Idempotency gate (Risk C1) ───────────────────────────────────────
  const idempotencyKey = bookingId
    ? IdempotencyKey.forBooking(bookingId, messageType)
    : IdempotencyKey.forCustomer(customerId, messageType, campaignDate!);

  const lock = await acquireSendLock({
    idempotencyKey,
    messageType,
    templateCategory,
    customerId,
    salonId,
    bookingId,
  });

  if (!lock.acquired) {
    // Already sent or in-flight. This is the enforcement point —
    // no network call happens for a duplicate.
    return { sent: false, reason: 'duplicate_suppressed' };
  }

  // ── Dry run short-circuit ────────────────────────────────────────────
  if (DRY_RUN) {
    log.info(
      { customerPhone, templateName, templateParams },
      '[DRY RUN] Would send WhatsApp message',
    );
    await markSent(lock.messageLogId, `dry-run-${Date.now()}`);
    return { sent: true, reason: 'dry_run' };
  }

  // ── Real send ─────────────────────────────────────────────────────────
  try {
    const metaMessageId = await callAiSensyApi({
      customerPhone,
      templateName,
      templateParams,
    });

    await markSent(lock.messageLogId, metaMessageId);

    log.info(
      { customerId, messageType, metaMessageId },
      'WhatsApp message sent successfully',
    );

    return { sent: true, metaMessageId };
  } catch (err) {
    await handleSendFailure(err, {
      messageLogId: lock.messageLogId,
      customerId,
    });
    throw err; // rethrow so the BullMQ worker's retry logic engages
  }
}

// ─────────────────────────────────────────────
// AISENSY API CALL
// ─────────────────────────────────────────────

interface AiSensyErrorBody {
  error?: { code?: string; message?: string };
}

async function callAiSensyApi(params: {
  customerPhone: string;
  templateName: string;
  templateParams: Record<string, string>;
}): Promise<string> {
  const response = await fetch(AISENSY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AISENSY_API_KEY}`,
    },
    body: JSON.stringify({
      to: params.customerPhone,
      template: {
        name: params.templateName,
        params: params.templateParams,
      },
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as AiSensyErrorBody;
    const metaErrorCode = body.error?.code;

    const err = new Error(
      body.error?.message ?? `AiSensy API returned ${response.status}`,
    ) as Error & { metaErrorCode?: string; httpStatus?: number };
    err.metaErrorCode = metaErrorCode;
    err.httpStatus = response.status;
    throw err;
  }

  const data = (await response.json()) as { messageId: string };
  return data.messageId;
}

// ─────────────────────────────────────────────
// ERROR-CODE-AWARE RETRY ROUTING (Section 6.4)
// ─────────────────────────────────────────────

async function handleSendFailure(
  err: unknown,
  context: { messageLogId: string; customerId: string },
): Promise<void> {
  const typedErr = err as Error & { metaErrorCode?: string; httpStatus?: number };
  const metaErrorCode = typedErr.metaErrorCode;

  await markFailed(context.messageLogId, metaErrorCode ?? 'unknown');

  if (!metaErrorCode) {
    log.error({ err }, 'Message send failed with no Meta error code (network/5xx)');
    return; // generic failure — let BullMQ's exponential backoff retry
  }

  const mappedCode = META_ERROR_MAP[metaErrorCode];

  if (mappedCode === ERROR_CODES.META_INVALID_NUMBER) {
    // Permanently stop sending to this number — do not retry.
    await prisma.customer.update({
      where: { id: context.customerId },
      data: { isNumberInvalid: true },
    });
    log.warn(
      { customerId: context.customerId, metaErrorCode },
      'Customer number marked invalid (131026) — no further sends will be attempted',
    );
    throw new InvalidNumberError();
  }

  if (mappedCode === ERROR_CODES.META_FREQUENCY_CAP) {
    log.warn(
      { customerId: context.customerId, metaErrorCode },
      'Frequency cap hit (131049) — caller should re-queue with 24h delay',
    );
    throw new FrequencyCapError();
  }

  log.error(
    { err, metaErrorCode },
    'Message send failed with unmapped Meta error code',
  );
}

// ─────────────────────────────────────────────
// OFFLINE MESSAGE (Ghost Rule) — direct send, bypasses idempotency lock
// ─────────────────────────────────────────────

/**
 * Sends the service-offline notice directly, without going through the
 * booking/campaign idempotency lock (that system is keyed to MessageType
 * values tied to bookings and campaigns; the offline message's own
 * rate-limit is enforced separately by offline-message.service.ts
 * BEFORE this function is ever called — see the subscription gate
 * middleware). This function assumes eligibility has already been
 * checked and just performs the send.
 */
export async function sendOfflineMessage(params: {
  customerPhone: string;
  salon: { name: string; serviceOfflineMessage: string | null };
}): Promise<void> {
  const messageText =
    params.salon.serviceOfflineMessage ??
    CLIENT_CONFIG.subscription.defaultOfflineMessage;

  if (DRY_RUN) {
    log.info(
      { customerPhone: params.customerPhone, messageText },
      '[DRY RUN] Would send offline message',
    );
    return;
  }

  await callAiSensyApi({
    customerPhone: params.customerPhone,
    templateName: 'service_offline',
    templateParams: { 1: messageText },
  });
}
