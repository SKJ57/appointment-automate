/**
 * src/modules/booking/booking.repository.test.ts
 *
 * These tests exist to PROVE Risk B1 is actually fixed, not just
 * documented as fixed. The race condition test fires concurrent
 * requests at the real database (not mocked) — a mocked Prisma client
 * cannot prove transaction atomicity, only a real Postgres instance
 * enforcing the conditional UPDATE can.
 *
 * Run with: pnpm --filter @theslotbot/api test
 * Requires DATABASE_URL pointed at a real (test) Postgres instance —
 * see .github/workflows/ci.yml for the CI service container setup.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import {
  claimSlotAndCreateBooking,
  cancelBooking,
  SlotAlreadyClaimedError,
  SlotOverlapError,
  findAvailableSlots,
} from './booking.repository';

// ─────────────────────────────────────────────
// TEST FIXTURES
// ─────────────────────────────────────────────

let salonId: string;
let serviceId: string;
let customerAId: string;
let customerBId: string;

async function seedTestSalon() {
  const salon = await prisma.salon.create({
    data: {
      name: 'Test Salon',
      slug: `test-salon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      whatsappNumber: `+1555${Math.floor(Math.random() * 10_000_000)}`,
      googleReviewUrl: 'https://example.com/review',
      subscriptionStatus: 'active',
    },
  });

  const service = await prisma.service.create({
    data: {
      salonId: salon.id,
      name: 'Test Haircut',
      price: 50000,
      durationMinutes: 60,
      category: 'short_cycle',
    },
  });

  const customerA = await prisma.customer.create({
    data: {
      salonId: salon.id,
      phoneNumber: `+1555${Math.floor(Math.random() * 10_000_000)}`,
      name: 'Customer A',
    },
  });

  const customerB = await prisma.customer.create({
    data: {
      salonId: salon.id,
      phoneNumber: `+1555${Math.floor(Math.random() * 10_000_000)}`,
      name: 'Customer B',
    },
  });

  return {
    salonId: salon.id,
    serviceId: service.id,
    customerAId: customerA.id,
    customerBId: customerB.id,
  };
}

async function createTestSlot(startTime: Date, durationMinutes = 60) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  return prisma.slot.create({
    data: { salonId, startTime, endTime, isBlocked: false },
  });
}

beforeEach(async () => {
  const fixtures = await seedTestSalon();
  salonId = fixtures.salonId;
  serviceId = fixtures.serviceId;
  customerAId = fixtures.customerAId;
  customerBId = fixtures.customerBId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────
// THE CRITICAL TEST — concurrent claims on the same slot
// ─────────────────────────────────────────────

describe('claimSlotAndCreateBooking — concurrency', () => {
  it('allows exactly one of two simultaneous claims on the same slot to succeed', async () => {
    const slotStart = new Date('2026-08-15T10:00:00Z');
    const slotEnd = new Date('2026-08-15T11:00:00Z');
    const slot = await createTestSlot(slotStart);

    // Fire both claims genuinely concurrently — Promise.allSettled does
    // not serialize these; both requests hit the DB at roughly the same
    // instant, which is exactly the scenario Risk B1 describes (two
    // customers tapping "confirm" on the same slot within milliseconds).
    const [resultA, resultB] = await Promise.allSettled([
      claimSlotAndCreateBooking({
        salonId,
        customerId: customerAId,
        serviceId,
        slotId: slot.id,
        slotStart,
        slotEnd,
        source: 'whatsapp',
      }),
      claimSlotAndCreateBooking({
        salonId,
        customerId: customerBId,
        serviceId,
        slotId: slot.id,
        slotStart,
        slotEnd,
        source: 'whatsapp',
      }),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, exactly one must fail
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The failure must be the specific, expected error type —
    // not a generic DB error or a hung transaction
    const rejectedResult = rejected[0] as PromiseRejectedResult;
    expect(rejectedResult.reason).toBeInstanceOf(SlotAlreadyClaimedError);

    // Verify the database agrees: exactly one confirmed booking exists
    // for this slot, and the slot row points to that one booking.
    const bookingsForSlot = await prisma.booking.findMany({
      where: { salonId, slotStart, slotEnd },
    });
    expect(bookingsForSlot).toHaveLength(1);

    const refreshedSlot = await prisma.slot.findUniqueOrThrow({
      where: { id: slot.id },
    });
    expect(refreshedSlot.bookingId).toBe(bookingsForSlot[0]!.id);
  });

  it('allows ten simultaneous claims on the same slot to produce exactly one winner', async () => {
    // A higher-concurrency version of the above. Ten near-simultaneous
    // requests is closer to a real peak-hour burst than a clean 2-way race.
    const slotStart = new Date('2026-08-16T14:00:00Z');
    const slotEnd = new Date('2026-08-16T15:00:00Z');
    const slot = await createTestSlot(slotStart);

    const customers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        prisma.customer.create({
          data: {
            salonId,
            phoneNumber: `+1555${9000000 + i}`,
            name: `Concurrent Customer ${i}`,
          },
        }),
      ),
    );

    const results = await Promise.allSettled(
      customers.map((customer) =>
        claimSlotAndCreateBooking({
          salonId,
          customerId: customer.id,
          serviceId,
          slotId: slot.id,
          slotStart,
          slotEnd,
          source: 'whatsapp',
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const bookingsForSlot = await prisma.booking.count({
      where: { salonId, slotStart, slotEnd, status: { not: 'cancelled' } },
    });
    expect(bookingsForSlot).toBe(1);
  });
});

// ─────────────────────────────────────────────
// OVERLAP DETECTION — Risk B1, non-grid-aligned bookings
// ─────────────────────────────────────────────

describe('claimSlotAndCreateBooking — overlap detection', () => {
  it('rejects a booking that overlaps an existing confirmed booking even on a different slot row', async () => {
    // This is the specific failure mode the original spec missed:
    // two DIFFERENT slot rows whose time windows overlap because of
    // variable service durations. The conditional UPDATE on the slot
    // table alone cannot catch this — only the explicit overlap query
    // (Step 1 of the transaction) catches it.
    const firstStart = new Date('2026-08-17T10:00:00Z');
    const firstEnd = new Date('2026-08-17T11:00:00Z'); // 60-min service
    const firstSlot = await createTestSlot(firstStart);

    await claimSlotAndCreateBooking({
      salonId,
      customerId: customerAId,
      serviceId,
      slotId: firstSlot.id,
      slotStart: firstStart,
      slotEnd: firstEnd,
      source: 'whatsapp',
    });

    // Second slot starts at 10:30, inside the first booking's window
    const secondStart = new Date('2026-08-17T10:30:00Z');
    const secondEnd = new Date('2026-08-17T11:15:00Z'); // 45-min service
    const secondSlot = await createTestSlot(secondStart);

    await expect(
      claimSlotAndCreateBooking({
        salonId,
        customerId: customerBId,
        serviceId,
        slotId: secondSlot.id,
        slotStart: secondStart,
        slotEnd: secondEnd,
        source: 'whatsapp',
      }),
    ).rejects.toBeInstanceOf(SlotOverlapError);
  });

  it('allows a booking immediately after another once the buffer window has passed', async () => {
    const firstStart = new Date('2026-08-18T10:00:00Z');
    const firstEnd = new Date('2026-08-18T11:00:00Z');
    const firstSlot = await createTestSlot(firstStart);

    await claimSlotAndCreateBooking({
      salonId,
      customerId: customerAId,
      serviceId,
      slotId: firstSlot.id,
      slotStart: firstStart,
      slotEnd: firstEnd,
      source: 'whatsapp',
    });

    // CLIENT_CONFIG.booking.slotBufferMinutes is 10 in the default config.
    // Starting exactly 10 minutes after the prior booking's end should
    // be the earliest valid non-conflicting start.
    const secondStart = new Date('2026-08-18T11:10:00Z');
    const secondEnd = new Date('2026-08-18T12:10:00Z');
    const secondSlot = await createTestSlot(secondStart);

    const booking = await claimSlotAndCreateBooking({
      salonId,
      customerId: customerBId,
      serviceId,
      slotId: secondSlot.id,
      slotStart: secondStart,
      slotEnd: secondEnd,
      source: 'whatsapp',
    });

    expect(booking.status).toBe('confirmed');
  });

  it('ignores cancelled bookings when checking for overlap', async () => {
    const slotStart = new Date('2026-08-19T10:00:00Z');
    const slotEnd = new Date('2026-08-19T11:00:00Z');
    const slot = await createTestSlot(slotStart);

    const firstBooking = await claimSlotAndCreateBooking({
      salonId,
      customerId: customerAId,
      serviceId,
      slotId: slot.id,
      slotStart,
      slotEnd,
      source: 'whatsapp',
    });

    await cancelBooking({ bookingId: firstBooking.id, salonId });

    // A second slot row covering the exact same window should now be
    // bookable, because the only conflicting booking was cancelled and
    // the slot itself was freed (bookingId set back to null).
    const secondSlot = await prisma.slot.findUniqueOrThrow({
      where: { id: slot.id },
    });
    expect(secondSlot.bookingId).toBeNull();

    const rebooked = await claimSlotAndCreateBooking({
      salonId,
      customerId: customerBId,
      serviceId,
      slotId: slot.id,
      slotStart,
      slotEnd,
      source: 'whatsapp',
    });

    expect(rebooked.status).toBe('confirmed');
  });
});

// ─────────────────────────────────────────────
// CANCELLATION — frees the slot atomically
// ─────────────────────────────────────────────

describe('cancelBooking', () => {
  it('frees the slot atomically with the status change', async () => {
    const slotStart = new Date('2026-08-20T10:00:00Z');
    const slotEnd = new Date('2026-08-20T11:00:00Z');
    const slot = await createTestSlot(slotStart);

    const booking = await claimSlotAndCreateBooking({
      salonId,
      customerId: customerAId,
      serviceId,
      slotId: slot.id,
      slotStart,
      slotEnd,
      source: 'whatsapp',
    });

    const cancelled = await cancelBooking({ bookingId: booking.id, salonId });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();

    const refreshedSlot = await prisma.slot.findUniqueOrThrow({
      where: { id: slot.id },
    });
    expect(refreshedSlot.bookingId).toBeNull();
  });
});

// ─────────────────────────────────────────────
// AVAILABILITY QUERY — respects overlap and buffer
// ─────────────────────────────────────────────

describe('findAvailableSlots', () => {
  it('excludes slots that would overlap an existing booking given the requested duration', async () => {
    const bookedStart = new Date('2026-08-21T10:00:00Z');
    const bookedEnd = new Date('2026-08-21T11:00:00Z');
    const bookedSlot = await createTestSlot(bookedStart);

    await claimSlotAndCreateBooking({
      salonId,
      customerId: customerAId,
      serviceId,
      slotId: bookedSlot.id,
      slotStart: bookedStart,
      slotEnd: bookedEnd,
      source: 'whatsapp',
    });

    // Create an adjacent slot row at 10:30 — inside the booked window
    const adjacentSlot = await createTestSlot(
      new Date('2026-08-21T10:30:00Z'),
    );
    // And one safely after the buffer window
    const freeSlot = await createTestSlot(new Date('2026-08-21T11:15:00Z'));

    const available = await findAvailableSlots({
      salonId,
      dateStart: new Date('2026-08-21T00:00:00Z'),
      dateEnd: new Date('2026-08-22T00:00:00Z'),
      durationMinutes: 60,
    });

    const availableIds = available.map((s) => s.id);
    expect(availableIds).not.toContain(adjacentSlot.id);
    expect(availableIds).not.toContain(bookedSlot.id); // already claimed
    expect(availableIds).toContain(freeSlot.id);
  });
});
