/**
 * src/modules/booking/booking.repository.ts
 *
 * All Prisma queries for the booking and slot domain.
 *
 * ARCHITECTURE RULE:
 * This layer speaks only Prisma and SQL. No business logic lives here.
 * No BullMQ. No WhatsApp. No CLIENT_CONFIG reads.
 * The service layer (booking.service.ts) orchestrates; this layer executes.
 *
 * THE CRITICAL TRANSACTION — claimSlotAndCreateBooking():
 *
 * This is the most important function in the entire codebase. It is the
 * direct implementation of Risk B1 (overlap prevention). It must be
 * atomic, correct under concurrent load, and reject gracefully.
 *
 * The transaction does four things in order, inside a single DB transaction:
 *   1. Overlap check: query for any non-cancelled booking whose time window
 *      intersects with the requested window (including slot buffer).
 *      If any exist → throw SLOT_OVERLAP_DETECTED.
 *   2. Slot availability check: confirm the specific slot row has
 *      bookingId = null and isBlocked = false.
 *      If not → throw SLOT_ALREADY_CLAIMED.
 *   3. Booking creation: INSERT the booking row.
 *   4. Slot claim: UPDATE the slot row to set bookingId = new booking ID.
 *      This is conditional on bookingId still being null (double-check).
 *      If update affects 0 rows → another transaction won the race.
 *      Throw SLOT_ALREADY_CLAIMED.
 *
 * Steps 1–4 run inside prisma.$transaction() with serializable isolation
 * is NOT needed here — the conditional UPDATE in step 4 provides the
 * necessary atomicity. Two concurrent transactions cannot both successfully
 * claim the same slot because only one UPDATE can match bookingId IS NULL.
 */

import { Prisma, Booking, Slot, Customer, BookingStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { ERROR_CODES } from '@theslotbot/shared/constants';
import { CLIENT_CONFIG } from '@/config/client.config';

const log = logger.child({ module: 'booking.repository' });

// ─────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────

export class SlotAlreadyClaimedError extends Error {
  readonly code = ERROR_CODES.SLOT_ALREADY_CLAIMED;
  constructor() {
    super('This slot was just taken. Please choose another time.');
    this.name = 'SlotAlreadyClaimedError';
  }
}

export class SlotOverlapError extends Error {
  readonly code = ERROR_CODES.SLOT_OVERLAP_DETECTED;
  constructor() {
    super('This time window conflicts with an existing booking.');
    this.name = 'SlotOverlapError';
  }
}

export class BookingNotFoundError extends Error {
  readonly code = ERROR_CODES.BOOKING_NOT_FOUND;
  constructor(id: string) {
    super(`Booking ${id} not found.`);
    this.name = 'BookingNotFoundError';
  }
}

export class InvalidStatusTransitionError extends Error {
  readonly code = ERROR_CODES.INVALID_BOOKING_STATUS_TRANSITION;
  constructor(from: BookingStatus, to: BookingStatus) {
    super(`Cannot transition booking from '${from}' to '${to}'.`);
    this.name = 'InvalidStatusTransitionError';
  }
}

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface ClaimSlotParams {
  salonId: string;
  customerId: string;
  serviceId: string;
  slotId: string;
  slotStart: Date;
  slotEnd: Date;          // slotStart + service.durationMinutes
  source: 'whatsapp' | 'admin_manual';
  notes?: string;
}

export type BookingWithRelations = Booking & {
  customer: Customer;
  service: { id: string; name: string; durationMinutes: number; category: string };
  slot: Slot | null;
};

// ─────────────────────────────────────────────
// SLOT QUERIES
// ─────────────────────────────────────────────

/**
 * Find available slots for a given date and service duration.
 *
 * A slot is available when:
 *   - it belongs to this salon
 *   - it is not blocked
 *   - it has no existing bookingId (the slot row itself is unclaimed)
 *   - no non-cancelled booking overlaps the window
 *     [slot.startTime, slot.startTime + durationMinutes + bufferMinutes]
 *
 * Risk B4: dateStart and dateEnd are computed by the caller in the salon's
 * timezone before being passed here. This function works in UTC internally.
 */
export async function findAvailableSlots(params: {
  salonId: string;
  dateStart: Date;  // Start of the day in salon timezone (as UTC Date)
  dateEnd: Date;    // End of the day in salon timezone (as UTC Date)
  durationMinutes: number;
}): Promise<Slot[]> {
  const { salonId, dateStart, dateEnd, durationMinutes } = params;
  const bufferMs =
    CLIENT_CONFIG.booking.slotBufferMinutes * 60 * 1000;

  // Fetch slots that are unblocked and unclaimed
  const candidateSlots = await prisma.slot.findMany({
    where: {
      salonId,
      isBlocked: false,
      bookingId: null,
      startTime: { gte: dateStart, lt: dateEnd },
    },
    orderBy: { startTime: 'asc' },
  });

  if (candidateSlots.length === 0) return [];

  // For each candidate, check whether a booking already occupies the window.
  // We do this in a single batch query for efficiency.
  const slotWindows = candidateSlots.map((slot) => ({
    slotId: slot.id,
    windowStart: new Date(slot.startTime.getTime() - bufferMs),
    windowEnd: new Date(
      slot.startTime.getTime() + durationMinutes * 60 * 1000 + bufferMs,
    ),
  }));

  // Find all bookings that conflict with ANY of our candidate windows.
  // Using raw query for OR across dynamic window list is cleaner.
  const conflictingBookings = await prisma.booking.findMany({
    where: {
      salonId,
      status: {
        notIn: ['cancelled', 'no_show'],
      },
      OR: slotWindows.map(({ windowStart, windowEnd }) => ({
        slotStart: { lt: windowEnd },
        slotEnd: { gt: windowStart },
      })),
    },
    select: { slotStart: true, slotEnd: true },
  });

  if (conflictingBookings.length === 0) return candidateSlots;

  // Filter out candidates that overlap with any conflicting booking
  return candidateSlots.filter((slot) => {
    const windowStart = new Date(slot.startTime.getTime() - bufferMs);
    const windowEnd = new Date(
      slot.startTime.getTime() + durationMinutes * 60 * 1000 + bufferMs,
    );

    return !conflictingBookings.some(
      (b) => b.slotStart < windowEnd && b.slotEnd > windowStart,
    );
  });
}

// ─────────────────────────────────────────────
// THE ATOMIC SLOT CLAIM TRANSACTION
// Risk B1 fix — the most important function in the codebase
// ─────────────────────────────────────────────

/**
 * Atomically claim a slot and create a booking.
 *
 * This is the implementation of the "Calendar Tetris" overlap prevention.
 * It runs as a single database transaction. Two concurrent requests for
 * the same slot cannot both succeed — one wins, one gets SlotAlreadyClaimedError.
 *
 * See the module-level comment for the full transaction breakdown.
 */
export async function claimSlotAndCreateBooking(
  params: ClaimSlotParams,
): Promise<Booking> {
  const {
    salonId,
    customerId,
    serviceId,
    slotId,
    slotStart,
    slotEnd,
    source,
    notes,
  } = params;

  const bufferMs = CLIENT_CONFIG.booking.slotBufferMinutes * 60 * 1000;

  // Expand the window by buffer on both sides for the overlap check
  const overlapWindowStart = new Date(slotStart.getTime() - bufferMs);
  const overlapWindowEnd = new Date(slotEnd.getTime() + bufferMs);

  return await prisma.$transaction(async (tx) => {
    // ── Step 1: Overlap check ─────────────────────────────────────────
    // Is there any active booking that overlaps with our intended window?
    const overlappingCount = await tx.booking.count({
      where: {
        salonId,
        status: { notIn: ['cancelled', 'no_show'] },
        // Interval overlap: existing.start < our.end AND existing.end > our.start
        slotStart: { lt: overlapWindowEnd },
        slotEnd: { gt: overlapWindowStart },
      },
    });

    if (overlappingCount > 0) {
      log.warn(
        { salonId, slotId, slotStart, slotEnd },
        'Slot overlap detected — rejecting booking attempt',
      );
      throw new SlotOverlapError();
    }

    // ── Step 2: Slot availability check ──────────────────────────────
    // Re-read the slot inside the transaction to get its current state
    const slot = await tx.slot.findUnique({
      where: { id: slotId },
      select: { id: true, bookingId: true, isBlocked: true, salonId: true },
    });

    if (!slot || slot.salonId !== salonId) {
      throw new BookingNotFoundError(slotId);
    }

    if (slot.isBlocked || slot.bookingId !== null) {
      log.warn(
        { slotId, isBlocked: slot.isBlocked, bookingId: slot.bookingId },
        'Slot already claimed or blocked at transaction time',
      );
      throw new SlotAlreadyClaimedError();
    }

    // ── Step 3: Create the booking ────────────────────────────────────
    // actualVisitDate is set from slotStart's date component (Risk D1 fix).
    // This is the date of the appointment, not when it was logged.
    const actualVisitDate = new Date(slotStart);
    actualVisitDate.setUTCHours(0, 0, 0, 0); // normalise to midnight UTC

    const booking = await tx.booking.create({
      data: {
        salonId,
        customerId,
        serviceId,
        slotStart,
        slotEnd,
        actualVisitDate,
        source,
        notes,
        // Requires manual approval if configured, otherwise auto-confirm
        status: CLIENT_CONFIG.booking.requireApproval
          ? 'pending_confirmation'
          : 'confirmed',
      },
    });

    // ── Step 4: Atomic slot claim ─────────────────────────────────────
    // The WHERE clause includes bookingId IS NULL as a final guard.
    // If another transaction committed between Step 2 and here, the
    // updateMany will affect 0 rows. We check the count and abort.
    const claimResult = await tx.slot.updateMany({
      where: {
        id: slotId,
        bookingId: null, // Must still be unclaimed
        isBlocked: false,
      },
      data: { bookingId: booking.id },
    });

    if (claimResult.count === 0) {
      // Another concurrent transaction claimed this slot between our
      // check and our update. The transaction will auto-rollback.
      log.warn(
        { slotId, bookingId: booking.id },
        'Slot claimed by concurrent transaction — rolling back',
      );
      throw new SlotAlreadyClaimedError();
    }

    log.info(
      { bookingId: booking.id, slotId, customerId, salonId },
      'Booking created and slot claimed successfully',
    );

    return booking;
  });
}

// ─────────────────────────────────────────────
// BOOKING READS
// ─────────────────────────────────────────────

export async function findBookingById(
  bookingId: string,
  salonId: string,
): Promise<BookingWithRelations | null> {
  return prisma.booking.findFirst({
    where: { id: bookingId, salonId },
    include: {
      customer: true,
      service: {
        select: {
          id: true,
          name: true,
          durationMinutes: true,
          category: true,
        },
      },
      slot: true,
    },
  });
}

export async function findBookingsByDateRange(params: {
  salonId: string;
  from: Date;
  to: Date;
  status?: BookingStatus;
  page: number;
  pageSize: number;
}): Promise<{ items: BookingWithRelations[]; total: number }> {
  const { salonId, from, to, status, page, pageSize } = params;

  const where: Prisma.BookingWhereInput = {
    salonId,
    slotStart: { gte: from, lte: to },
    ...(status ? { status } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.booking.findMany({
      where,
      include: {
        customer: true,
        service: { select: { id: true, name: true, durationMinutes: true, category: true } },
        slot: true,
      },
      orderBy: { slotStart: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  return { items: items as BookingWithRelations[], total };
}

// ─────────────────────────────────────────────
// BOOKING MUTATIONS
// ─────────────────────────────────────────────

/**
 * Mark a booking as complete.
 *
 * Updates in a single transaction:
 *   - booking.status → completed
 *   - booking.completedAt, booking.completedById
 *   - customer.lastVisitDate = booking.actualVisitDate (Risk D1)
 *   - customer.lastVisitServiceId
 *   - customer.revisitCampaignStatus = 'none' (reset for next cycle)
 *
 * The caller (booking.service.ts) is responsible for enqueuing
 * the review request job after this returns.
 */
export async function markBookingComplete(params: {
  bookingId: string;
  salonId: string;
  completedById: string;
}): Promise<Booking> {
  const { bookingId, salonId, completedById } = params;

  const booking = await findBookingById(bookingId, salonId);

  if (!booking) {
    throw new BookingNotFoundError(bookingId);
  }

  if (booking.status !== 'confirmed') {
    throw new InvalidStatusTransitionError(booking.status, 'completed');
  }

  // Idempotent: if already completed, return as-is
  if (booking.status === 'completed') {
    return booking;
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        completedById,
      },
    });

    // Risk D1: use actualVisitDate (the appointment date), not now()
    await tx.customer.update({
      where: { id: booking.customerId },
      data: {
        lastVisitDate: booking.actualVisitDate,
        lastVisitServiceId: booking.serviceId,
        // Reset campaign status so the 30-day clock starts fresh
        revisitCampaignStatus: 'none',
      },
    });

    log.info(
      { bookingId, customerId: booking.customerId, completedById },
      'Booking marked complete, customer visit date updated',
    );

    return updated;
  });
}

/**
 * Cancel a booking and free the slot.
 *
 * The caller (booking.service.ts) is responsible for removing
 * the BullMQ reminder jobs after this returns. We separate the
 * DB update from the queue operation because they cannot share
 * a transaction — they touch different systems.
 *
 * Risk C2: if job removal fails after this DB update succeeds,
 * the pre-send re-check in the reminder worker catches the leaked
 * job. That check is mandatory, not defensive.
 */
export async function cancelBooking(params: {
  bookingId: string;
  salonId: string;
  reason?: string;
}): Promise<Booking> {
  const { bookingId, salonId, reason } = params;

  const booking = await findBookingById(bookingId, salonId);

  if (!booking) {
    throw new BookingNotFoundError(bookingId);
  }

  const cancellableStatuses: BookingStatus[] = [
    'pending_confirmation',
    'confirmed',
  ];

  if (!cancellableStatuses.includes(booking.status)) {
    throw new InvalidStatusTransitionError(booking.status, 'cancelled');
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        notes: reason
          ? `${booking.notes ? booking.notes + '\n' : ''}Cancellation reason: ${reason}`
          : booking.notes,
      },
    });

    // Free the slot atomically with the cancellation
    await tx.slot.updateMany({
      where: { bookingId },
      data: { bookingId: null },
    });

    log.info(
      { bookingId, slotId: booking.slot?.id, reason },
      'Booking cancelled, slot freed',
    );

    return updated;
  });
}

/**
 * Update the reminder sent flags.
 * Called by the reminder worker after a successful send.
 * These are a second idempotency layer (beyond MessageLog).
 */
export async function markReminderSent(
  bookingId: string,
  type: '24h' | '3h',
): Promise<void> {
  await prisma.booking.update({
    where: { id: bookingId },
    data:
      type === '24h'
        ? { reminder24hSent: true }
        : { reminder3hSent: true },
  });
}

export async function markReviewRequestSent(bookingId: string): Promise<void> {
  await prisma.booking.update({
    where: { id: bookingId },
    data: { reviewRequestSent: true },
  });
}

// ─────────────────────────────────────────────
// SLOT BLOCKING (admin action — staff breaks, holidays)
// ─────────────────────────────────────────────

export class SlotHasActiveBookingError extends Error {
  readonly code = ERROR_CODES.BOOKING_NOT_CANCELLABLE;
  constructor() {
    super('This slot has a confirmed booking and cannot be blocked.');
    this.name = 'SlotHasActiveBookingError';
  }
}

/**
 * Toggle a single slot's isBlocked flag. Cannot block a slot that
 * currently has an active booking — reception should cancel or
 * reschedule the booking first, which is a deliberate decision, not
 * something this action should do implicitly as a side effect.
 */
export async function setSlotBlocked(params: {
  slotId: string;
  salonId: string;
  isBlocked: boolean;
}): Promise<Slot> {
  const { slotId, salonId, isBlocked } = params;

  const slot = await prisma.slot.findFirst({
    where: { id: slotId, salonId },
  });

  if (!slot) {
    throw new BookingNotFoundError(slotId);
  }

  if (isBlocked && slot.bookingId !== null) {
    throw new SlotHasActiveBookingError();
  }

  return prisma.slot.update({
    where: { id: slotId },
    data: { isBlocked },
  });
}

/**
 * Blocks every unbooked slot within a time window on a given day —
 * the actual implementation behind "block this time for a staff
 * break." Slots that already have an active booking are left
 * untouched and reported back separately so the admin panel can show
 * "3 slots blocked, 1 slot could not be blocked (has a booking)"
 * rather than silently skipping or silently overriding an existing
 * commitment.
 */
export async function blockSlotsInWindow(params: {
  salonId: string;
  windowStart: Date;
  windowEnd: Date;
  reason?: string;
}): Promise<{ blockedCount: number; conflictingSlotIds: string[] }> {
  const { salonId, windowStart, windowEnd } = params;

  const slotsInWindow = await prisma.slot.findMany({
    where: {
      salonId,
      startTime: { gte: windowStart, lt: windowEnd },
    },
  });

  const blockable = slotsInWindow.filter((s) => s.bookingId === null);
  const conflicting = slotsInWindow.filter((s) => s.bookingId !== null);

  if (blockable.length > 0) {
    await prisma.slot.updateMany({
      where: { id: { in: blockable.map((s) => s.id) } },
      data: { isBlocked: true },
    });
  }

  log.info(
    {
      salonId,
      windowStart,
      windowEnd,
      blockedCount: blockable.length,
      conflictCount: conflicting.length,
      reason: params.reason,
    },
    'Slot window block applied',
  );

  return {
    blockedCount: blockable.length,
    conflictingSlotIds: conflicting.map((s) => s.id),
  };
}

// ─────────────────────────────────────────────
// DAY VIEW (admin capacity calendar)
// ─────────────────────────────────────────────

/**
 * Returns every slot for a given day, regardless of service — this is
 * distinct from findAvailableSlots(), which is scoped to one service's
 * duration and only returns bookable slots. The admin capacity view
 * needs to see everything: available, booked (with who/what), and
 * blocked, for the whole day at a glance.
 */
export async function findSlotsForDay(params: {
  salonId: string;
  dayStart: Date;
  dayEnd: Date;
}) {
  const { salonId, dayStart, dayEnd } = params;

  return prisma.slot.findMany({
    where: {
      salonId,
      startTime: { gte: dayStart, lt: dayEnd },
    },
    include: {
      booking: {
        include: {
          customer: { select: { name: true } },
          service: { select: { name: true } },
        },
      },
    },
    orderBy: { startTime: 'asc' },
  });
}
