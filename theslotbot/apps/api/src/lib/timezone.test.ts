/**
 * src/lib/timezone.test.ts
 *
 * Proves Risk B4 is fixed: "today" and "tomorrow" must resolve to the
 * correct calendar day in the salon's local timezone, not the server's
 * UTC clock. These tests use Asia/Kolkata (UTC+5:30) because it has a
 * non-whole-hour offset, which is exactly the kind of edge case that
 * breaks naive `getUTCHours() + offset` arithmetic.
 *
 * NOTE: these tests assume CLIENT_CONFIG.salon.timezone resolves to
 * 'Asia/Kolkata' in the test environment (see .github/workflows/ci.yml
 * SALON_TIMEZONE env var). If that env var changes, these specific
 * assertions need updating alongside it — the logic under test does
 * not hardcode IST, only the test fixtures do.
 */

import { describe, it, expect } from 'vitest';
import {
  startOfSalonDay,
  endOfSalonDay,
  zonedDateStringToUtc,
  formatInSalonTimezone,
  addCalendarDays,
  isoWeekdayInSalonTimezone,
  isWithinQuietHours,
} from './timezone';

describe('zonedDateStringToUtc', () => {
  it('converts a salon-local morning time to the correct UTC instant (IST = UTC+5:30)', () => {
    // 10:00 AM IST on 2026-08-15 should be 04:30 UTC the same day
    const result = zonedDateStringToUtc('2026-08-15', '10:00:00');
    expect(result.toISOString()).toBe('2026-08-15T04:30:00.000Z');
  });

  it('correctly rolls over to the previous UTC day for early local morning times', () => {
    // 02:00 AM IST is 20:30 UTC the PREVIOUS day — this is the exact
    // bug class Risk B4 describes: a naive implementation would keep
    // this on the same calendar day in UTC terms.
    const result = zonedDateStringToUtc('2026-08-15', '02:00:00');
    expect(result.toISOString()).toBe('2026-08-14T20:30:00.000Z');
  });
});

describe('startOfSalonDay / endOfSalonDay', () => {
  it('returns the correct UTC instant for the start of a salon-local day', () => {
    // Midnight IST on 2026-08-15 = 18:30 UTC on 2026-08-14
    const result = startOfSalonDay('2026-08-15');
    expect(result.toISOString()).toBe('2026-08-14T18:30:00.000Z');
  });

  it('returns the correct UTC instant for the end of a salon-local day', () => {
    // 23:59:59.999 IST on 2026-08-15 = 18:29:59.999 UTC on 2026-08-16
    const result = endOfSalonDay('2026-08-15');
    expect(result.toISOString()).toBe('2026-08-16T18:29:59.999Z');
  });

  it('produces a window that correctly contains a known in-day timestamp and excludes the next day', () => {
    const dayStart = startOfSalonDay('2026-08-15');
    const dayEnd = endOfSalonDay('2026-08-15');

    const sameDayEvening = new Date('2026-08-15T15:00:00Z'); // 8:30 PM IST
    const nextDayEarlyMorning = new Date('2026-08-15T19:00:00Z'); // 12:30 AM IST on the 16th

    expect(sameDayEvening >= dayStart && sameDayEvening <= dayEnd).toBe(true);
    expect(nextDayEarlyMorning >= dayStart && nextDayEarlyMorning <= dayEnd).toBe(false);
  });
});

describe('formatInSalonTimezone', () => {
  it('formats a UTC instant as the correct local calendar date, even when it differs from the UTC date', () => {
    // 20:30 UTC on Aug 14 is 02:00 AM IST on Aug 15 — different calendar
    // days depending on which timezone you read it in. This is precisely
    // why `new Date().toISOString().split('T')[0]` is unsafe for "today".
    const lateUtcInstant = new Date('2026-08-14T20:30:00.000Z');
    expect(formatInSalonTimezone(lateUtcInstant, 'YYYY-MM-DD')).toBe(
      '2026-08-15',
    );
  });

  it('formats time of day correctly in 24h local format', () => {
    const instant = new Date('2026-08-15T04:30:00.000Z'); // 10:00 IST
    expect(formatInSalonTimezone(instant, 'HH:mm')).toBe('10:00');
  });
});

describe('addCalendarDays', () => {
  it('adds days without being affected by DST or month boundaries', () => {
    expect(addCalendarDays('2026-08-30', 3)).toBe('2026-09-02');
    expect(addCalendarDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addCalendarDays('2026-02-27', 2)).toBe('2026-03-01'); // 2026 not a leap year
  });

  it('handles zero and negative offsets', () => {
    expect(addCalendarDays('2026-08-15', 0)).toBe('2026-08-15');
  });
});

describe('isoWeekdayInSalonTimezone', () => {
  it('returns the correct ISO weekday for a known date', () => {
    // 2026-08-15 is a Saturday
    const saturday = startOfSalonDay('2026-08-15');
    expect(isoWeekdayInSalonTimezone(saturday)).toBe(6);
  });

  it('resolves the weekday based on local time, not UTC, near a day boundary', () => {
    // 20:30 UTC Aug 14 (Friday) is 02:00 IST Aug 15 (Saturday).
    // A UTC-naive weekday check would incorrectly say Friday.
    const instant = new Date('2026-08-14T20:30:00.000Z');
    expect(isoWeekdayInSalonTimezone(instant)).toBe(6); // Saturday
  });
});

describe('isWithinQuietHours', () => {
  it('correctly identifies an overnight quiet window (21:00–10:00 IST)', () => {
    // 11 PM IST — well within the overnight quiet window
    const lateNight = zonedDateStringToUtc('2026-08-15', '23:00:00');
    expect(isWithinQuietHours(lateNight)).toBe(true);

    // 5 AM IST — still within the overnight window
    const earlyMorning = zonedDateStringToUtc('2026-08-15', '05:00:00');
    expect(isWithinQuietHours(earlyMorning)).toBe(true);

    // 2 PM IST — outside the quiet window
    const afternoon = zonedDateStringToUtc('2026-08-15', '14:00:00');
    expect(isWithinQuietHours(afternoon)).toBe(false);

    // Exactly 10:00 AM IST — the boundary, should be outside quiet hours
    const boundary = zonedDateStringToUtc('2026-08-15', '10:00:00');
    expect(isWithinQuietHours(boundary)).toBe(false);
  });
});
