/**
 * src/modules/booking/slot-generation.worker.ts
 *
 * Risk B3 fix: defines who creates Slot rows and when.
 *
 * STRATEGY:
 * Slots are pre-generated, not created on-demand. A nightly job runs
 * once per salon and ensures slots exist for every open business day
 * within CLIENT_CONFIG.booking.maxAdvanceBookingDays from today.
 *
 * WHY PRE-GENERATED RATHER THAN ON-DEMAND:
 * On-demand slot creation (generating slots only when a customer asks
 * for availability) creates a race between two customers querying the
 * same time window simultaneously and a subtler bug: the admin panel's
 * "block this time" action has nothing to act on if the slot row doesn't
 * exist yet. Pre-generation means slots are a stable, queryable resource
 * from the moment they enter the booking window.
 *
 * IDEMPOTENCY:
 * This job is safe to re-run at any time without creating duplicates.
 * It uses a deterministic slot grid (one slot per service-duration-sized
 * interval... but see the granularity note below) and checks for existing
 * rows before inserting.
 *
 * GRANULARITY DECISION:
 * Slots are generated at a fixed interval (CLIENT_CONFIG-driven, default
 * derived from the shortest active service duration) rather than one grid
 * per service. This keeps the Slot table service-agnostic — exactly the
 * white-label requirement. The overlap check in booking.repository.ts
 * (Risk B1) is what actually prevents double-booking regardless of grid
 * granularity; the grid only controls how many options customers see.
 *
 * WHEN BUSINESS HOURS CHANGE MID-DEPLOYMENT:
 * If CLIENT_CONFIG.hours changes (e.g. salon now closes at 9 PM instead
 * of 8 PM), re-running this job will generate the new later slots for
 * future days, but will NOT retroactively change already-generated slots
 * for days that fall within the existing window. An admin action to
 * regenerate a specific date range is provided in regenerateForDateRange()
 * for this case — it marks pre-existing unbooked slots outside the new
 * hours as blocked, rather than deleting them (preserves FK integrity
 * if anything ever referenced them).
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config';
import {
  startOfSalonDay,
  todayInSalonTimezone,
  addCalendarDays,
  zonedDateStringToUtc,
  isoWeekdayInSalonTimezone,
} from '@/lib/timezone';

const log = logger.child({ module: 'slot-generation.worker' });

/**
 * The interval between generated slot start times, in minutes.
 *
 * Phase 2 review decision: this is explicit CLIENT_CONFIG, not
 * auto-derived from the shortest active service duration. Auto-deriving
 * was rejected because adding a new short service later would silently
 * shift the entire calendar grid for every future day on the next
 * slot-generation run — a surprising, hard-to-debug side effect for
 * something as operationally significant as the booking calendar's shape.
 *
 * See CLIENT_CONFIG.booking.slotGridIntervalMinutes for the value and
 * the full rationale comment.
 */
function getSlotIntervalMinutes(): number {
  return CLIENT_CONFIG.booking.slotGridIntervalMinutes;
}

/**
 * Generate (or top up) slots for a single salon, covering today through
 * today + maxAdvanceBookingDays. Idempotent — uses upsert-style logic
 * so re-running this never creates duplicate slot rows for the same
 * (salonId, startTime).
 */
export async function generateSlotsForSalon(salonId: string): Promise<{
  created: number;
  skipped: number;
}> {
  const intervalMinutes = getSlotIntervalMinutes();
  const today = todayInSalonTimezone();
  const horizonDays = CLIENT_CONFIG.booking.maxAdvanceBookingDays;

  let created = 0;
  let skipped = 0;

  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    const dateStr = addCalendarDays(today, dayOffset);
    const dayStartUtc = startOfSalonDay(dateStr);
    const weekday = isoWeekdayInSalonTimezone(dayStartUtc);

    // Skip days the salon is closed (Risk B3 + CLIENT_CONFIG.hours)
    if (!(CLIENT_CONFIG.hours.daysOpen as readonly number[]).includes(weekday)) {
      continue;
    }

    const slotsForDay = buildDaySlotGrid(dateStr, intervalMinutes);

    // Check which of these slot start times already exist for this salon
    const existing = await prisma.slot.findMany({
      where: {
        salonId,
        startTime: { in: slotsForDay.map((s) => s.startTime) },
      },
      select: { startTime: true },
    });

    const existingTimes = new Set(
      existing.map((s) => s.startTime.toISOString()),
    );

    const toCreate = slotsForDay.filter(
      (s) => !existingTimes.has(s.startTime.toISOString()),
    );

    skipped += slotsForDay.length - toCreate.length;

    if (toCreate.length > 0) {
      const result = await prisma.slot.createMany({
        data: toCreate.map((s) => ({
          salonId,
          startTime: s.startTime,
          endTime: s.endTime,
          isBlocked: false,
        })),
        skipDuplicates: true, // extra safety net against race with another run
      });
      created += result.count;
    }
  }

  log.info(
    { salonId, created, skipped, horizonDays },
    'Slot generation complete for salon',
  );

  return { created, skipped };
}

/**
 * Builds the grid of slot start/end times for a single salon-local day,
 * respecting CLIENT_CONFIG.hours.open / close and the slot interval.
 * The final slot offered is the latest one that still fits the interval
 * before closing time (actual service-fit is validated later by the
 * overlap check at booking time, not here — this is just the candidate grid).
 */
function buildDaySlotGrid(
  dateStr: string,
  intervalMinutes: number,
): Array<{ startTime: Date; endTime: Date }> {
  const { open, close } = CLIENT_CONFIG.hours;

  const dayStart = zonedDateStringToUtc(dateStr, `${open}:00`);
  const dayEnd = zonedDateStringToUtc(dateStr, `${close}:00`);

  const slots: Array<{ startTime: Date; endTime: Date }> = [];
  let cursor = new Date(dayStart);

  while (cursor < dayEnd) {
    const slotEnd = new Date(cursor.getTime() + intervalMinutes * 60 * 1000);
    if (slotEnd > dayEnd) break;

    slots.push({ startTime: new Date(cursor), endTime: slotEnd });
    cursor = slotEnd;
  }

  return slots;
}

/**
 * Run slot generation for every active salon. This is the entrypoint
 * called by the nightly cron (registered in workers/cron.worker.ts).
 */
export async function generateSlotsForAllActiveSalons(): Promise<void> {
  const salons = await prisma.salon.findMany({
    where: { subscriptionStatus: 'active' },
    select: { id: true, name: true },
  });

  log.info({ salonCount: salons.length }, 'Starting nightly slot generation');

  for (const salon of salons) {
    try {
      await generateSlotsForSalon(salon.id);
    } catch (err) {
      log.error(
        { err, salonId: salon.id, salonName: salon.name },
        'Slot generation failed for salon — continuing with remaining salons',
      );
      // Intentionally do not rethrow: one salon's failure must not
      // block slot generation for every other client on this deployment
      // pattern (relevant if this ever runs against multiple DBs/schemas).
    }
  }
}

/**
 * Admin action: when business hours change, mark now-out-of-hours,
 * unbooked future slots as blocked rather than deleting them.
 * Booked slots are left untouched — an existing confirmed booking
 * outside new hours is a human scheduling decision, not a bug.
 */
export async function regenerateForDateRange(params: {
  salonId: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
}): Promise<{ blocked: number; created: number }> {
  const { salonId, fromDate, toDate } = params;

  const rangeStart = startOfSalonDay(fromDate);
  const rangeEnd = startOfSalonDay(addCalendarDays(toDate, 1));

  // Block unbooked slots outside current business hours within this range
  const allSlotsInRange = await prisma.slot.findMany({
    where: {
      salonId,
      startTime: { gte: rangeStart, lt: rangeEnd },
      bookingId: null,
    },
  });

  const { open, close } = CLIENT_CONFIG.hours;
  let blocked = 0;

  for (const slot of allSlotsInRange) {
    const dateStr = slot.startTime.toISOString().split('T')[0]!;
    const openTime = zonedDateStringToUtc(dateStr, `${open}:00`);
    const closeTime = zonedDateStringToUtc(dateStr, `${close}:00`);

    const outOfHours = slot.startTime < openTime || slot.endTime > closeTime;

    if (outOfHours && !slot.isBlocked) {
      await prisma.slot.update({
        where: { id: slot.id },
        data: { isBlocked: true },
      });
      blocked++;
    }
  }

  // Re-run generation to fill in any new slots within expanded hours
  const intervalMinutes = getSlotIntervalMinutes();
  let created = 0;

  let cursor = fromDate;
  while (cursor <= toDate) {
    const weekday = isoWeekdayInSalonTimezone(startOfSalonDay(cursor));
    if ((CLIENT_CONFIG.hours.daysOpen as readonly number[]).includes(weekday)) {
      const slotsForDay = buildDaySlotGrid(cursor, intervalMinutes);
      const existing = await prisma.slot.findMany({
        where: { salonId, startTime: { in: slotsForDay.map((s) => s.startTime) } },
        select: { startTime: true },
      });
      const existingTimes = new Set(existing.map((s) => s.startTime.toISOString()));
      const toCreate = slotsForDay.filter(
        (s) => !existingTimes.has(s.startTime.toISOString()),
      );
      if (toCreate.length > 0) {
        const result = await prisma.slot.createMany({
          data: toCreate.map((s) => ({
            salonId,
            startTime: s.startTime,
            endTime: s.endTime,
            isBlocked: false,
          })),
          skipDuplicates: true,
        });
        created += result.count;
      }
    }
    cursor = addCalendarDays(cursor, 1);
  }

  log.info(
    { salonId, fromDate, toDate, blocked, created },
    'Slot regeneration for date range complete',
  );

  return { blocked, created };
}
