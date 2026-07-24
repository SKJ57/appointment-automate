/**
 * @package @theslotbot/shared
 *
 * Canonical source of truth for all enums and types shared between
 * the API (apps/api) and the Admin Panel (apps/admin).
 *
 * RULE: Never import from apps/* into this package.
 * RULE: Never add runtime logic here — types and enums only.
 * RULE: When you change an enum value, TypeScript will immediately
 *       flag every consumer across the monorepo. Fix all of them
 *       before merging.
 */

// ─────────────────────────────────────────────
// SALON & SUBSCRIPTION
// ─────────────────────────────────────────────

/**
 * Controls whether the entire WhatsApp bot is active for a salon.
 *
 * active      → normal operation
 * suspended   → subscription lapsed; webhook intercepts and sends
 *               the offline message (rate-limited to once per 24h
 *               per customer). All background workers are paused.
 * cancelled   → permanent termination. No messages sent at all.
 *               Data retained per the service agreement.
 *
 * See: Risk D (Kill Switch) from Phase 0 analysis.
 * See: apps/api/src/api/middleware/subscriptionGate.ts
 */
export enum SubscriptionStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  CANCELLED = 'cancelled',
}

// ─────────────────────────────────────────────
// AUTH & ROLES
// ─────────────────────────────────────────────

/**
 * Role hierarchy (highest to lowest privilege):
 *
 * agency_admin  → theslotbot team. Cross-salon visibility.
 *                 Can create salon_owner accounts.
 *                 Sees the system health view.
 *
 * salon_owner   → Seeded by agency_admin. Scoped to one Salon.
 *                 Can invite salon_staff.
 *                 Sees the revisit campaign report.
 *
 * salon_staff   → Invited by salon_owner. Scoped to one Salon.
 *                 Sees today's bookings, upcoming, slot mgmt,
 *                 mark-complete, walk-in logging.
 *                 Cannot see campaign reports or system health.
 */
export enum UserRole {
  AGENCY_ADMIN = 'agency_admin',
  SALON_OWNER = 'salon_owner',
  SALON_STAFF = 'salon_staff',
}

/**
 * Status of an invite token.
 *
 * pending   → email sent, not yet accepted
 * accepted  → user completed registration via invite link
 * expired   → 72h window passed without acceptance (cron-cleaned)
 * revoked   → manually cancelled by salon_owner or agency_admin
 */
export enum InviteStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

// ─────────────────────────────────────────────
// SERVICES
// ─────────────────────────────────────────────

/**
 * Drives revisit campaign message branching.
 * See: Section 7.4 of the architecture spec.
 *
 * short_cycle   → Haircut, colour touch-up (4–8 week natural cycle)
 *                 Day 30: same-service nudge
 *                 Day 37: small incentive on same service
 *
 * medium_cycle  → Facials, skin treatments (6–10 week cycle)
 *                 Day 30: same-service nudge, later-edge timing
 *                 Day 37: new/seasonal service angle + incentive
 *
 * long_cycle    → Bridal, deep treatments (3–6 month cycle)
 *                 Day 30: warm check-in only, no hard sell
 *                 Day 37: offer a smaller different service
 */
export enum ServiceCategory {
  SHORT_CYCLE = 'short_cycle',
  MEDIUM_CYCLE = 'medium_cycle',
  LONG_CYCLE = 'long_cycle',
}

// ─────────────────────────────────────────────
// BOOKINGS
// ─────────────────────────────────────────────

/**
 * Lifecycle states for a booking record.
 *
 * pending_confirmation  → booking created via WhatsApp, not yet
 *                         confirmed (only used when
 *                         CLIENT_CONFIG.booking.requireApproval = true)
 * confirmed             → slot is claimed, reminders are queued
 * completed             → staff marked the visit done in admin panel.
 *                         Triggers review request job.
 * cancelled             → cancelled by customer or reception.
 *                         Slot is freed. Reminder jobs are removed.
 * no_show               → appointment time passed, customer didn't arrive.
 *                         Slot freed. No review request sent.
 */
export enum BookingStatus {
  PENDING_CONFIRMATION = 'pending_confirmation',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

/**
 * Distinguishes how a booking or visit was created.
 * Used in reporting and audit trail.
 */
export enum BookingSource {
  WHATSAPP = 'whatsapp',
  ADMIN_MANUAL = 'admin_manual',
}

// ─────────────────────────────────────────────
// CONVERSATION / SESSION STATE MACHINE
// ─────────────────────────────────────────────

/**
 * Every possible state in the WhatsApp booking conversation.
 *
 * CRITICAL: State is stored in the database (not server memory).
 * A server restart must never lose an in-progress conversation.
 * See: Risk A (State Machine) from Phase 0 analysis.
 *
 * State transition map:
 *
 *   idle
 *     └─ (any message) → greeting
 *
 *   greeting
 *     └─ (welcome sent) → awaiting_service_selection
 *
 *   awaiting_service_selection
 *     ├─ (valid service) → awaiting_slot_selection
 *     └─ (invalid, reprompt_count < max) → awaiting_service_selection
 *     └─ (invalid, reprompt_count >= max) → awaiting_human_handoff
 *
 *   awaiting_slot_selection
 *     ├─ (valid slot) → awaiting_slot_confirmation
 *     └─ (invalid) → awaiting_slot_selection (re-show slots)
 *
 *   awaiting_slot_confirmation
 *     ├─ (confirmed) → booking_confirmed
 *     └─ (rejected) → awaiting_slot_selection (re-show slots)
 *     └─ (slot race-lost) → awaiting_slot_selection (show new slots)
 *
 *   booking_confirmed
 *     └─ (next inbound) → idle (conversation complete)
 *
 *   awaiting_human_handoff
 *     └─ (MENU or HI keyword) → idle
 *
 *   expired  ← set by session timeout check, not by user action
 *     └─ (any message) → greeting (fresh start)
 */
export enum ConversationState {
  IDLE = 'idle',
  GREETING = 'greeting',
  AWAITING_SERVICE_SELECTION = 'awaiting_service_selection',
  AWAITING_SLOT_SELECTION = 'awaiting_slot_selection',
  AWAITING_SLOT_CONFIRMATION = 'awaiting_slot_confirmation',
  BOOKING_CONFIRMED = 'booking_confirmed',
  AWAITING_HUMAN_HANDOFF = 'awaiting_human_handoff',
  EXPIRED = 'expired',
}

// ─────────────────────────────────────────────
// MESSAGING
// ─────────────────────────────────────────────

/**
 * Every type of outbound message the system can send.
 * Used as part of the idempotency key in MessageLog.
 *
 * Idempotency key format (see message-log.service.ts):
 *   booking-scoped:  `${bookingId}::${MessageType}`
 *   customer-scoped: `${customerId}::${MessageType}::${YYYY-MM-DD}`
 *
 * See: Risk C1 (duplicate message prevention) from Phase 0 analysis.
 */
export enum MessageType {
  BOOKING_CONFIRM = 'booking_confirm',
  REMINDER_24H = 'reminder_24h',
  REMINDER_3H = 'reminder_3h',
  REVIEW_REQUEST = 'review_request',
  REVISIT_DAY30 = 'revisit_day30',
  REVISIT_DAY37 = 'revisit_day37',
  SERVICE_OFFLINE = 'service_offline',
}

/**
 * Meta template categories.
 *
 * utility    → Tied to an existing transaction (booking confirmation,
 *              reminders). Higher delivery rate (92–98%).
 *              NOT subject to per-user frequency capping.
 *
 * marketing  → Promotional / re-engagement (revisit campaign, review
 *              request if it contains any promo framing). Subject to
 *              Meta's per-user frequency cap. Realistic delivery: 75–80%.
 *
 * See: Section 7.5 of the architecture spec.
 */
export enum TemplateCategory {
  UTILITY = 'utility',
  MARKETING = 'marketing',
}

/**
 * Delivery lifecycle for a single outbound message.
 * Updated via Meta webhook callbacks (status updates).
 */
export enum MessageStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

// ─────────────────────────────────────────────
// REVISIT CAMPAIGN
// ─────────────────────────────────────────────

/**
 * Where a customer sits in the 30/37-day revisit cycle.
 *
 * none           → eligible for Day 30 send (default state after any visit)
 * day30_sent     → Day 30 message sent; eligible for Day 37 if no booking
 * day37_sent     → Day 37 message sent; evaluate for non_responder
 * converted      → Customer rebooked at any point during the cycle.
 *                  Set immediately on booking confirmation.
 *                  A booking hook cancels any pending Day 37 job.
 * non_responder  → Both Day 30 and Day 37 were ignored. Customer enters
 *                  quarterly low-frequency list. non_responder_count++.
 *                  Excluded from next month's Day 30/37 cycle entirely.
 *
 * See: Risk D (Campaign Logic) from Phase 0 analysis.
 * See: Section 6.3 of the architecture spec.
 */
export enum RevisitCampaignStatus {
  NONE = 'none',
  DAY30_SENT = 'day30_sent',
  DAY37_SENT = 'day37_sent',
  CONVERTED = 'converted',
  NON_RESPONDER = 'non_responder',
}

// ─────────────────────────────────────────────
// API RESPONSE SHAPES
// Shared between API route handlers and Admin fetch calls.
// Keep these in sync with openapi/spec.yaml.
// ─────────────────────────────────────────────

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// ─────────────────────────────────────────────
// BULLMQ JOB PAYLOADS
// Typed interfaces for every job that enters a queue.
// Workers must validate against these types on dequeue.
// ─────────────────────────────────────────────

export interface ReminderJobPayload {
  bookingId: string;
  customerId: string;
  salonId: string;
  messageType: MessageType.REMINDER_24H | MessageType.REMINDER_3H;
  scheduledFor: string; // ISO 8601 — the intended fire time
}

export interface ReviewRequestJobPayload {
  bookingId: string;
  customerId: string;
  salonId: string;
  serviceId: string;
  completedAt: string; // ISO 8601
}

export interface RevisitCampaignJobPayload {
  customerId: string;
  salonId: string;
  messageType: MessageType.REVISIT_DAY30 | MessageType.REVISIT_DAY37;
  lastVisitDate: string; // YYYY-MM-DD
  lastVisitServiceId: string;
  serviceCategory: ServiceCategory;
}

export interface OfflineMessageJobPayload {
  salonId: string;
  customerPhone: string;
  inboundMessageId: string; // Meta message ID, for dedup
}

// ─────────────────────────────────────────────
// DOMAIN RESPONSE SHAPES
// Imported directly by both Express route handlers (as the return
// type they populate) and React components (as the type of data
// returned from the API client). This is the literal enforcement of
// "strict API contract" — not just matching field names by convention,
// but importing the same TypeScript type on both sides of the wire.
// Keep these in sync with the Prisma schema's serializable shape;
// Prisma's generated types are NOT imported into the frontend (the
// frontend never depends on @prisma/client), so these are the
// hand-maintained bridge between the two.
// ─────────────────────────────────────────────

export interface ServiceDto {
  id: string;
  name: string;
  description: string | null;
  price: number; // paise
  durationMinutes: number;
  category: ServiceCategory;
  isActive: boolean;
  displayOrder: number;
}

export interface CustomerDto {
  id: string;
  phoneNumber: string;
  name: string;
  whatsappOptIn: boolean;
  lastVisitDate: string | null; // YYYY-MM-DD
  revisitCampaignStatus: RevisitCampaignStatus;
  nonResponderCount: number;
  isNumberInvalid: boolean;
}

export interface SlotDto {
  id: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  isBlocked: boolean;
  bookingId: string | null;
}

export interface BookingDto {
  id: string;
  status: BookingStatus;
  source: BookingSource;
  slotStart: string; // ISO 8601
  slotEnd: string;   // ISO 8601
  actualVisitDate: string; // YYYY-MM-DD
  reminder24hSent: boolean;
  reminder3hSent: boolean;
  reviewRequestSent: boolean;
  completedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  customer: CustomerDto;
  service: Pick<ServiceDto, 'id' | 'name' | 'durationMinutes' | 'category'>;
}

export interface PaginatedMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PaginatedBookings {
  items: BookingDto[];
  meta: PaginatedMeta;
}

export interface DailyMetricsDto {
  date: string; // YYYY-MM-DD
  scheduledToday: number;
  completedToday: number;
  cancelledToday: number;
  noShowToday: number;
  upcomingWeekCount: number;
  revenueTodayPaise: number;
}

export interface CurrentUserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  salonId: string | null;
}

// ─────────────────────────────────────────────
// PHASE 5 — INVITE FLOW
// ─────────────────────────────────────────────

export interface CreateInviteResponseDto {
  inviteId: string;
  email: string;
  role: UserRole;
  expiresAt: string; // ISO 8601
  /**
   * The full, shareable invite URL, including the raw (unhashed) token
   * as a query parameter. This is the ONLY time the raw token is ever
   * transmitted — the database stores only its hash. The salon_owner
   * or agency_admin who generated this must copy/share it immediately;
   * there is no way to retrieve it again after this response.
   */
  inviteUrl: string;
}

export interface TeamMemberDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string; // ISO 8601
}

// ─────────────────────────────────────────────
// PHASE 5 — CAMPAIGN REPORT
// ─────────────────────────────────────────────

export interface CampaignReportRowDto {
  period: string; // "YYYY-MM"
  day30Sent: number;
  day30Delivered: number;
  day30Read: number;
  day37Sent: number;
  day37Delivered: number;
  day37Read: number;
  /**
   * Distinct customers who received a Day 30 or Day 37 message in this
   * period AND currently sit in 'converted' campaign status. This is
   * an attribution approximation, not an exact "converted within this
   * exact period" count — the schema does not track a separate
   * convertedAt timestamp, so a customer who converts weeks after
   * receiving the message in period X is still attributed to period X.
   * Documented here so nobody mistakes this for more precise than it is.
   */
  converted: number;
}

// ─────────────────────────────────────────────
// PHASE 5 — SLOT CAPACITY VIEW
// ─────────────────────────────────────────────

/**
 * Extends SlotDto with a summary of the booking occupying it, if any.
 * Used by the admin Slots calendar view so reception can see, at a
 * glance, who's booked into a given slot without a second API call
 * per slot.
 */
export interface SlotWithBookingDto extends SlotDto {
  booking: {
    id: string;
    status: BookingStatus;
    customerName: string;
    serviceName: string;
  } | null;
}
