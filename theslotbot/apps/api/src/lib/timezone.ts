/**
 * src/lib/timezone.ts
 *
 * Risk B4 fix: the single source of truth for timezone-aware date math.
 *
 * THE BUG THIS PREVENTS:
 * The server runs on UTC (standard for Railway/Render). If any query uses
 * CURRENT_DATE, new Date(), or string date comparison without accounting
 * for the salon's timezone, "today" and "tomorrow" silently resolve to
 * the wrong calendar day for any salon not in UTC+0.
 *
 * Example of the bug: a salon in Asia/Kolkata (UTC+5:30) closes at 8 PM IST.
 * At 9 PM IST (3:30 PM UTC), a customer asks for "tomorrow's slots."
 * A naive `new Date()` call on the server thinks it's still today in UTC
 * terms until 5:30 AM IST — so "tomorrow" queries return slots starting
 * from the wrong day entirely.
 *
 * RULE: Every function in this codebase that needs "today," "tomorrow,"
 * or any calendar-day boundary MUST go through this module. Never call
 * `new Date()` directly for day-boundary logic — only for instant-in-time
 * values (createdAt, timestamps).
 *
 * We use the native Intl API rather than a date library (date-fns-tz,
 * Luxon) to keep the dependency footprint minimal — Node 20's built-in
 * Intl.DateTimeFormat fully supports IANA timezone names.
 */

import { CLIENT_CONFIG } from '@/config/client.config';

const SALON_TZ = CLIENT_CONFIG.salon.timezone;

/**
 * Returns the start of the given calendar day (00:00:00.000) in the
 * salon's timezone, expressed as a UTC Date object suitable for
 * Postgres timestamptz comparison.
 *
 * @param dateStr - YYYY-MM-DD, interpreted as a salon-local calendar date.
 *                  If omitted, uses "today" in the salon's timezone.
 */
export function startOfSalonDay(dateStr?: string): Date {
  const targetDateStr = dateStr ?? todayInSalonTimezone();
  return zonedDateStringToUtc(targetDateStr, '00:00:00');
}

/**
 * Returns the end of the given calendar day (23:59:59.999) in the
 * salon's timezone, expressed as a UTC Date object.
 */
export function endOfSalonDay(dateStr?: string): Date {
  const targetDateStr = dateStr ?? todayInSalonTimezone();
  return zonedDateStringToUtc(targetDateStr, '23:59:59.999');
}

/**
 * Returns today's date as YYYY-MM-DD in the salon's local timezone.
 * This is NOT the same as new Date().toISOString().split('T')[0],
 * which would give the UTC calendar date — exactly the Risk B4 bug.
 */
export function todayInSalonTimezone(): string {
  return formatInSalonTimezone(new Date(), 'YYYY-MM-DD');
}

/**
 * Adds `days` calendar days to a YYYY-MM-DD date string and returns
 * the new YYYY-MM-DD string. Pure calendar arithmetic, timezone-safe
 * because it never crosses through a Date object's UTC representation
 * for the addition itself.
 */
export function addCalendarDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use UTC noon as a safe pivot to avoid DST-adjacent edge cases
  // when only doing whole-day arithmetic on the calendar string.
  const pivot = new Date(Date.UTC(year!, month! - 1, day!, 12, 0, 0));
  pivot.setUTCDate(pivot.getUTCDate() + days);

  const y = pivot.getUTCFullYear();
  const m = String(pivot.getUTCMonth() + 1).padStart(2, '0');
  const d = String(pivot.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Converts a salon-local YYYY-MM-DD + HH:mm:ss[.SSS] into the
 * corresponding UTC Date instant, accounting for the salon's
 * IANA timezone offset (including DST where applicable).
 */
export function zonedDateStringToUtc(dateStr: string, timeStr: string): Date {
  // Strategy: construct a Date guessing UTC, then measure the offset
  // the target timezone actually has at that instant, then correct.
  // This correctly handles DST because Intl resolves the real offset
  // for the specific calendar date, not a fixed UTC offset.
  const naiveUtcGuess = new Date(`${dateStr}T${timeStr}Z`);

  const offsetMinutes = getTimezoneOffsetMinutes(naiveUtcGuess, SALON_TZ);

  // If salon is UTC+5:30, local 10:00 corresponds to UTC 04:30.
  // naiveUtcGuess currently represents 10:00 UTC (wrong by the offset).
  // Subtract the offset to correct it to the real UTC instant.
  return new Date(naiveUtcGuess.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * Formats a UTC Date instant as a string in the salon's local timezone.
 * Supports 'YYYY-MM-DD' and 'HH:mm' format tokens (extend as needed).
 */
export function formatInSalonTimezone(
  date: Date,
  format: 'YYYY-MM-DD' | 'HH:mm',
): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SALON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  if (format === 'YYYY-MM-DD') {
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  return `${get('hour')}:${get('minute')}`;
}

/**
 * Returns the ISO weekday number (1=Monday..7=Sunday) for a UTC Date
 * instant, as observed in the salon's local timezone.
 * Used to check against CLIENT_CONFIG.hours.daysOpen.
 */
export function isoWeekdayInSalonTimezone(date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: SALON_TZ,
    weekday: 'short',
  });
  const weekday = formatter.format(date);
  const map: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return map[weekday] ?? 1;
}

/**
 * Checks whether a given UTC instant falls within the salon's configured
 * quiet hours (CLIENT_CONFIG.campaign.quietHours). Handles overnight
 * windows correctly (e.g. start: '21:00', end: '10:00').
 */
export function isWithinQuietHours(date: Date): boolean {
  const { start, end } = CLIENT_CONFIG.campaign.quietHours;
  const currentTime = formatInSalonTimezone(date, 'HH:mm');

  if (start <= end) {
    // Same-day window, e.g. 13:00–18:00
    return currentTime >= start && currentTime < end;
  }
  // Overnight window, e.g. 21:00–10:00
  return currentTime >= start || currentTime < end;
}

/**
 * Returns the offset in minutes between UTC and the target timezone
 * at the given instant (positive = ahead of UTC, e.g. +330 for IST).
 */
function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  );

  return (asUtc - date.getTime()) / 60000;
}
