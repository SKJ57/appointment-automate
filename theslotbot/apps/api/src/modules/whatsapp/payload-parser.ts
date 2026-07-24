/**
 * src/modules/whatsapp/payload-parser.ts
 *
 * Meta Cloud API webhook payloads are deeply nested and carry several
 * different event shapes through the same endpoint (inbound messages,
 * delivery status callbacks, template status updates). This module is
 * the single place that understands that nesting — everything else in
 * the codebase works with the flat types defined below.
 *
 * Meta's actual payload shape (abbreviated):
 * {
 *   "entry": [{
 *     "changes": [{
 *       "value": {
 *         "metadata": { "display_phone_number": "919876543210" },
 *         "messages": [{ "from": "919876543210", "id": "wamid.xxx", "text": {...} }],
 *         "statuses": [{ "id": "wamid.xxx", "status": "delivered", ... }]
 *       }
 *     }]
 *   }]
 * }
 *
 * Note Meta omits the leading '+' in phone numbers within the payload —
 * this module normalises to E.164 (with '+') since that's what our
 * schema and PHONE_REGEX expect everywhere else.
 */

import { PHONE_REGEX } from '@theslotbot/shared/constants';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface InboundMessage {
  businessPhoneNumber: string; // E.164, the salon's number (webhook destination)
  customerPhoneNumber: string; // E.164, the sender
  inboundMessageId: string;    // Meta's wamid for this message
  text: string | null;         // null for non-text message types (buttons, media)
  buttonReplyId: string | null; // populated if this is a quick-reply button tap
  timestamp: Date;
}

export interface StatusCallback {
  metaMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode: string | null;
}

// ─────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────

function normalizePhone(rawPhone: string): string {
  const digitsOnly = rawPhone.replace(/[^\d]/g, '');
  const withPlus = `+${digitsOnly}`;
  return withPlus;
}

/**
 * Extracts a normalised InboundMessage from a raw Meta webhook payload,
 * or returns null if this payload doesn't represent a customer message
 * (e.g. it's a status callback instead — use extractStatusCallback for those).
 */
export function extractInboundMessage(
  payload: unknown,
): InboundMessage | null {
  try {
    const entry = (payload as any)?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return null;

    const businessPhoneNumber = normalizePhone(
      value.metadata?.display_phone_number ?? '',
    );
    const customerPhoneNumber = normalizePhone(message.from ?? '');

    if (
      !PHONE_REGEX.test(businessPhoneNumber) ||
      !PHONE_REGEX.test(customerPhoneNumber)
    ) {
      return null;
    }

    const text: string | null = message.text?.body ?? null;
    const buttonReplyId: string | null =
      message.button?.payload ?? message.interactive?.button_reply?.id ?? null;

    return {
      businessPhoneNumber,
      customerPhoneNumber,
      inboundMessageId: message.id,
      text,
      buttonReplyId,
      timestamp: new Date(Number(message.timestamp) * 1000),
    };
  } catch {
    // Malformed payload — treat as "not a message" rather than throwing,
    // so the webhook handler can still 200 the request and move on.
    return null;
  }
}

/**
 * Extracts a normalised StatusCallback from a raw Meta webhook payload,
 * or returns null if this isn't a status update.
 */
export function extractStatusCallback(
  payload: unknown,
): StatusCallback | null {
  try {
    const entry = (payload as any)?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const status = value?.statuses?.[0];

    if (!status) return null;

    const validStatuses = ['sent', 'delivered', 'read', 'failed'];
    if (!validStatuses.includes(status.status)) return null;

    return {
      metaMessageId: status.id,
      status: status.status,
      errorCode: status.errors?.[0]?.code?.toString() ?? null,
    };
  } catch {
    return null;
  }
}
