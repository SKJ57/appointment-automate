/**
 * client.config.ts
 *
 * THE WHITE-LABEL CONFIGURATION FILE
 * ───────────────────────────────────
 * This is the single file that changes when you deploy theslotbot
 * for a new client. Clone the repo, update this file and the seed
 * data in prisma/seeds/<client-name>/, and you have a new instance.
 *
 * RULE: No client-specific values anywhere else in src/.
 * RULE: All values here must have a documented valid range or set.
 * RULE: Secret values (API keys, URLs with tokens) live in .env only.
 *       Reference them here via process.env — never hardcode them.
 *
 * How to add a new config key:
 *   1. Add it here with a JSDoc comment explaining the valid range.
 *   2. Add the corresponding env var to .env.example if it's a secret.
 *   3. Add it to the Zod validation schema at the bottom of this file.
 *      The server will refuse to start if validation fails — no silent
 *      misconfiguration in production.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// RAW CONFIG OBJECT
// ─────────────────────────────────────────────

const rawConfig = {

  // ─── Salon Identity ──────────────────────────────────────────────
  salon: {
    /**
     * Human-readable name. Used in message templates.
     * e.g. "Jaya Premium Salon"
     */
    name: process.env.SALON_NAME ?? 'Jaya Premium Salon',

    /**
     * URL-safe slug. Used as the Salon.slug in the database.
     * Must be lowercase, hyphen-separated. No spaces.
     * e.g. "jaya-premium-salon"
     */
    slug: process.env.SALON_SLUG ?? 'jaya-premium-salon',

    /**
     * The salon's WhatsApp Business number in E.164 format.
     * Must match the number registered with AiSensy/Twilio.
     * e.g. "+919876543210"
     */
    whatsappNumber: process.env.WA_BUSINESS_NUMBER!,

    /**
     * Direct link to the salon's Google Business review page.
     * Pasted into the review request message template.
     * Obtain from: Google Business Profile → Get More Reviews → Share review form
     */
    googleReviewUrl: process.env.GOOGLE_REVIEW_URL!,

    /**
     * IANA timezone string for the salon's physical location.
     * ALL date/time queries use this. Never assume UTC.
     * Risk B4: this is the fix for the timezone bug.
     * Valid values: any string from the IANA tz database.
     * e.g. "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore"
     */
    timezone: process.env.SALON_TIMEZONE ?? 'Asia/Kolkata',
  },

  // ─── Business Hours ──────────────────────────────────────────────
  hours: {
    /**
     * Opening time in HH:mm (24h), local to salon.timezone.
     * Slot generation will not create slots before this time.
     */
    open: '10:00',

    /**
     * Closing time in HH:mm (24h), local to salon.timezone.
     * Slot generation will not create slots at or after this time.
     * The last slot starts at close - last service duration.
     */
    close: '20:00',

    /**
     * Days the salon is open. ISO weekday numbers.
     * 1 = Monday, 7 = Sunday.
     * e.g. [1, 2, 3, 4, 5, 6] = Monday through Saturday.
     */
    daysOpen: [1, 2, 3, 4, 5, 6],
  },

  // ─── Booking Rules ───────────────────────────────────────────────
  booking: {
    /**
     * Whether bookings need manual approval from reception before
     * being confirmed. Default: false (instant confirmation).
     * Set to true only if the salon owner explicitly wants oversight.
     * Warning: enabling this reintroduces the latency that the bot
     * exists to remove. See Section 8.2 of the architecture spec.
     */
    requireApproval: false,

    /**
     * Buffer between bookings in minutes. (Risk B2 fix)
     * The overlap check extends slotEnd by this amount when testing
     * for conflicts, so a 60-min facial ending at 3 PM blocks the
     * 3:00 PM slot and exposes only 3:10 PM as the next open start.
     * Set to 0 to disable.
     * Valid range: 0–60.
     */
    slotBufferMinutes: 10,

    /**
     * The interval between generated slot start times, in minutes.
     * (Phase 2 review decision: explicit over auto-derived.)
     *
     * This was originally auto-derived from the shortest active service
     * duration, but that's risky in production: if a client adds a new
     * 10-minute add-on service later, the entire calendar grid for every
     * future day would silently shift to 10-minute increments on the
     * next slot-generation run, fragmenting the admin panel's calendar
     * view and changing the appearance of availability for existing
     * services without anyone having asked for that.
     *
     * Set this explicitly per client based on how granular their booking
     * flow should feel. A luxury salon offering 60+ minute services
     * rarely benefits from a grid finer than 30 minutes; a quick-service
     * client (e.g. a barbershop with 15-minute cuts) may want 15.
     * Valid range: 5–60.
     */
    slotGridIntervalMinutes: 30,

    /**
     * How many days in advance a customer can book via WhatsApp.
     * Slot generation runs for NOW + this many days.
     * Valid range: 7–90.
     */
    maxAdvanceBookingDays: 30,

    /**
     * Maximum number of concurrent bookings the salon can hold
     * at any given time. Used as the capacity ceiling when
     * stylistId is null (single-resource mode).
     * Valid range: 1–20.
     */
    maxConcurrentBookings: 1,

    /**
     * How many open slots to present to the customer at once
     * during the awaiting_slot_selection step.
     * Valid range: 3–10.
     */
    slotsToShow: 5,
  },

  // ─── Conversation / State Machine ────────────────────────────────
  conversation: {
    /**
     * Minutes of inactivity before a session is considered expired.
     * (Risk A1 fix) On expiry, state resets to 'expired' and the
     * next message triggers a fresh greeting.
     * Valid range: 5–120.
     */
    sessionTimeoutMinutes: 30,

    /**
     * Maximum invalid inputs before transitioning to
     * awaiting_human_handoff. (Risk A2 fix)
     * Valid range: 1–5.
     */
    maxReprompts: 2,
  },

  // ─── Reminders ───────────────────────────────────────────────────
  reminders: {
    /**
     * Whether to send the 24-hour reminder.
     * Disable if the salon handles reminders through another channel.
     */
    send24h: true,

    /**
     * Whether to send the 3-hour reminder.
     */
    send3h: true,
  },

  // ─── Review Automation ───────────────────────────────────────────
  review: {
    /**
     * Hours after a visit is marked complete before sending the
     * review request. (Risk C3 awareness: this delay should land
     * the review message during business hours, not at 2 AM.)
     * The worker checks quiet hours before sending and delays if needed.
     * Valid range: 0.5–24.
     */
    requestDelayHours: 3,
  },

  // ─── Revisit Campaign ────────────────────────────────────────────
  campaign: {
    /**
     * Enable/disable the 30-day revisit message.
     */
    day30Enabled: true,

    /**
     * Enable/disable the 37-day follow-up message.
     */
    day37Enabled: true,

    /**
     * Quiet hours: no outbound marketing messages sent in this window.
     * (Risk C3 fix — applied to reminders AND campaign messages.)
     * Format: HH:mm in salon.timezone. End < Start means overnight window.
     * e.g. { start: '21:00', end: '10:00' } means no sends 9 PM – 10 AM.
     */
    quietHours: {
      start: '21:00',
      end: '10:00',
    },

    /**
     * After this many full non-responder cycles (day30→day37→ignored),
     * the customer is moved to a lower-frequency messaging tier.
     * Valid range: 1–5.
     */
    nonResponderThreshold: 2,

    /**
     * Days between messages for customers who have exceeded
     * nonResponderThreshold. Effectively "quarterly" messaging.
     * Valid range: 60–365.
     */
    nonResponderCooldownDays: 90,
  },

  // ─── Kill Switch / Subscription ──────────────────────────────────
  subscription: {
    /**
     * Message sent to customers when the salon's subscription is
     * suspended. This falls back to the Salon.serviceOfflineMessage
     * database column if set (allows per-client override without
     * a code deploy).
     * Keep this short — it's a WhatsApp message, not an email.
     */
    defaultOfflineMessage:
      'This service is temporarily unavailable. Please contact the salon directly for bookings.',

    /**
     * Rate limit for the offline message per customer phone number.
     * (Business Requirement 2 — 24-Hour Ghost Rule)
     * A customer who keeps messaging a suspended salon will only
     * receive this message once per this many hours.
     * All subsequent messages in the window are silently dropped.
     * Valid range: 1–72.
     */
    offlineMessageRateLimitHours: 24,
  },

  // ─── Infrastructure ──────────────────────────────────────────────
  infra: {
    /**
     * BullMQ job retry settings for outbound message sends.
     * Transient errors (5xx) retry up to maxRetries times with
     * exponential backoff. Permanent errors (131026) do not retry.
     * Frequency cap errors (131049) retry once after 24 hours.
     */
    messageQueue: {
      maxRetries: 3,
      backoffBaseMs: 2000,      // 2s → 4s → 8s
      frequencyCapRetryMs: 86_400_000, // 24 hours
    },

    /**
     * How long to retain completed/failed BullMQ jobs in Redis.
     * Longer retention = more Redis memory. Shorter = less visibility.
     */
    jobRetentionMs: {
      completed: 86_400_000,   // 24 hours
      failed: 604_800_000,     // 7 days
    },
  },
} as const;

// ─────────────────────────────────────────────
// ZOD VALIDATION SCHEMA
//
// The server entrypoint (src/index.ts) calls validateConfig() before
// starting. If any value is out of range or a required env var is
// missing, the process exits with a clear error message.
//
// This prevents silent misconfiguration: a missing GOOGLE_REVIEW_URL
// would otherwise only surface when the first review message fails
// to send in production — at that point a real customer interaction
// has already been broken.
// ─────────────────────────────────────────────

const ConfigSchema = z.object({
  salon: z.object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    whatsappNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164 format'),
    googleReviewUrl: z.string().url(),
    timezone: z.string().min(1),
  }),
  hours: z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    daysOpen: z.array(z.number().int().min(1).max(7)).min(1),
  }),
  booking: z.object({
    requireApproval: z.boolean(),
    slotBufferMinutes: z.number().int().min(0).max(60),
    slotGridIntervalMinutes: z.number().int().min(5).max(60),
    maxAdvanceBookingDays: z.number().int().min(7).max(90),
    maxConcurrentBookings: z.number().int().min(1).max(20),
    slotsToShow: z.number().int().min(3).max(10),
  }),
  conversation: z.object({
    sessionTimeoutMinutes: z.number().int().min(5).max(120),
    maxReprompts: z.number().int().min(1).max(5),
  }),
  reminders: z.object({
    send24h: z.boolean(),
    send3h: z.boolean(),
  }),
  review: z.object({
    requestDelayHours: z.number().min(0.5).max(24),
  }),
  campaign: z.object({
    day30Enabled: z.boolean(),
    day37Enabled: z.boolean(),
    quietHours: z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    }),
    nonResponderThreshold: z.number().int().min(1).max(5),
    nonResponderCooldownDays: z.number().int().min(60).max(365),
  }),
  subscription: z.object({
    defaultOfflineMessage: z.string().min(10),
    offlineMessageRateLimitHours: z.number().int().min(1).max(72),
  }),
  infra: z.object({
    messageQueue: z.object({
      maxRetries: z.number().int().min(0).max(10),
      backoffBaseMs: z.number().int().min(100),
      frequencyCapRetryMs: z.number().int().min(3_600_000),
    }),
    jobRetentionMs: z.object({
      completed: z.number().int().positive(),
      failed: z.number().int().positive(),
    }),
  }),
});

export type ClientConfig = z.infer<typeof ConfigSchema>;

// ─────────────────────────────────────────────
// VALIDATION ENTRYPOINT
// Called once at server startup. Throws and exits on invalid config.
// ─────────────────────────────────────────────

export function validateConfig(): ClientConfig {
  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error('❌ CLIENT_CONFIG validation failed. Server will not start.');
    console.error('Errors:');
    result.error.errors.forEach((err) => {
      console.error(`  [${err.path.join('.')}] ${err.message}`);
    });
    process.exit(1);
  }

  return result.data;
}

// Export the validated config as a singleton.
// Import this in any module that needs config values.
// Never import rawConfig directly.
export const CLIENT_CONFIG: ClientConfig = validateConfig();
