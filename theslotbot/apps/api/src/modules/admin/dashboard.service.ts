/**
 * src/modules/admin/dashboard.service.ts
 *
 * Aggregation queries for the admin dashboard's daily metrics view.
 * Kept separate from booking.service.ts because this is reporting
 * logic (read-only aggregates across bookings), not booking lifecycle
 * orchestration — a different concern, even though it queries the
 * same tables.
 */

import { prisma } from '@/lib/prisma';
import { startOfSalonDay, endOfSalonDay, addCalendarDays, todayInSalonTimezone } from '@/lib/timezone';

export interface DailyMetrics {
  date: string; // YYYY-MM-DD, salon-local
  scheduledToday: number;      // confirmed or pending_confirmation, slotStart today
  completedToday: number;      // status completed, actualVisitDate today
  cancelledToday: number;      // status cancelled, cancelledAt today
  noShowToday: number;         // status no_show, slotStart today
  upcomingWeekCount: number;   // confirmed bookings in the next 7 days (excl. today)
  revenueTodayPaise: number;   // sum of service.price for completed bookings today
}

export async function getDailyMetrics(salonId: string): Promise<DailyMetrics> {
  const today = todayInSalonTimezone();
  const todayStart = startOfSalonDay(today);
  const todayEnd = endOfSalonDay(today);

  const weekStart = startOfSalonDay(addCalendarDays(today, 1));
  const weekEnd = endOfSalonDay(addCalendarDays(today, 7));

  const [
    scheduledToday,
    completedTodayBookings,
    cancelledToday,
    noShowToday,
    upcomingWeekCount,
  ] = await Promise.all([
    prisma.booking.count({
      where: {
        salonId,
        status: { in: ['confirmed', 'pending_confirmation'] },
        slotStart: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.booking.findMany({
      where: {
        salonId,
        status: 'completed',
        actualVisitDate: todayStart,
      },
      select: { service: { select: { price: true } } },
    }),
    prisma.booking.count({
      where: {
        salonId,
        status: 'cancelled',
        cancelledAt: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.booking.count({
      where: {
        salonId,
        status: 'no_show',
        slotStart: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.booking.count({
      where: {
        salonId,
        status: 'confirmed',
        slotStart: { gte: weekStart, lte: weekEnd },
      },
    }),
  ]);

  const revenueTodayPaise = completedTodayBookings.reduce(
    (sum, b) => sum + b.service.price,
    0,
  );

  return {
    date: today,
    scheduledToday,
    completedToday: completedTodayBookings.length,
    cancelledToday,
    noShowToday,
    upcomingWeekCount,
    revenueTodayPaise,
  };
}
