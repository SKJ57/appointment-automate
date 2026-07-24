/**
 * @package @theslotbot/shared — constants
 *
 * Shared error codes and application constants.
 * Import from here so error strings never drift between
 * the API (where they're thrown) and the Admin (where they're displayed).
 */

// ─────────────────────────────────────────────
// APPLICATION ERROR CODES
// ─────────────────────────────────────────────

export const ERROR_CODES = {
  // Slot / Booking
  SLOT_ALREADY_CLAIMED: 'SLOT_ALREADY_CLAIMED',
  SLOT_NOT_FOUND: 'SLOT_NOT_FOUND',
  SLOT_OVERLAP_DETECTED: 'SLOT_OVERLAP_DETECTED',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  BOOKING_NOT_CANCELLABLE: 'BOOKING_NOT_CANCELLABLE',
  INVALID_BOOKING_STATUS_TRANSITION: 'INVALID_BOOKING_STATUS_TRANSITION',

  // Session
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_VERSION_CONFLICT: 'SESSION_VERSION_CONFLICT',
  MAX_REPROMPTS_EXCEEDED: 'MAX_REPROMPTS_EXCEEDED',

  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_ALREADY_USED: 'INVITE_ALREADY_USED',
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',

  // Subscription / Kill Switch
  SALON_SUSPENDED: 'SALON_SUSPENDED',
  SALON_CANCELLED: 'SALON_CANCELLED',

  // WhatsApp / Meta
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  META_INVALID_NUMBER: 'META_INVALID_NUMBER',       // error code 131026
  META_FREQUENCY_CAP: 'META_FREQUENCY_CAP',         // error code 131049
  META_TEMPLATE_REJECTED: 'META_TEMPLATE_REJECTED',

  // Message
  MESSAGE_DUPLICATE_SUPPRESSED: 'MESSAGE_DUPLICATE_SUPPRESSED',
  MESSAGE_SEND_FAILED: 'MESSAGE_SEND_FAILED',

  // General
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// ─────────────────────────────────────────────
// META API ERROR CODE MAPPINGS
// Maps Meta's numeric error codes to our internal error codes.
// Used in gateway.ts retry-routing logic.
// ─────────────────────────────────────────────

export const META_ERROR_MAP: Record<string, ErrorCode> = {
  '131026': ERROR_CODES.META_INVALID_NUMBER,
  '131049': ERROR_CODES.META_FREQUENCY_CAP,
} as const;

// ─────────────────────────────────────────────
// QUEUE NAMES
// Single source of truth — used when defining queues (queues.ts)
// and when enqueuing jobs (booking.service.ts, etc.)
// ─────────────────────────────────────────────

export const QUEUE_NAMES = {
  REMINDERS: 'reminders',
  REVIEW_REQUESTS: 'review-requests',
  REVISIT_CAMPAIGN: 'revisit-campaign',
  OUTBOUND_MESSAGES: 'outbound-messages',
  OFFLINE_MESSAGES: 'offline-messages',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ─────────────────────────────────────────────
// SESSION RESET KEYWORDS
// If a customer sends one of these while in AWAITING_HUMAN_HANDOFF
// or EXPIRED state, their session resets to IDLE.
// ─────────────────────────────────────────────

export const SESSION_RESET_KEYWORDS = ['hi', 'hello', 'menu', 'start', 'book'] as const;

// ─────────────────────────────────────────────
// PHONE NUMBER
// ─────────────────────────────────────────────

/** E.164 format expected for all stored phone numbers */
export const PHONE_REGEX = /^\+[1-9]\d{6,14}$/;
