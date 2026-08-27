import { describe, expect, it } from 'vitest';
import {
  CLINIC_TIMEZONE,
  addDays,
  clinicToday,
  endOfPreviousMonth,
  isoDay,
  startOfFinancialYear,
  startOfMonth,
  startOfPreviousMonth,
} from './day';

/**
 * The window this whole module exists for.
 *
 * 2026-08-26T19:10:13Z is a real CI run — 33003712831, the one on `main` that
 * failed three register specs. In IST it is already the 27th. A register filter
 * built from the runner's own date asked for a range that ended on the 26th and
 * came back empty, and the table it should have filled is not rendered at all
 * when there are no rows.
 */
const DURING_THE_GAP = new Date('2026-08-26T19:10:13Z');
/** The same suite at 14:54 IST, when the two dates agree and it went green. */
const OUTSIDE_THE_GAP = new Date('2026-08-24T09:24:00Z');

describe('clinicToday', () => {
  it('is the clinic-local date, not the runner-local one', () => {
    expect(isoDay(clinicToday(CLINIC_TIMEZONE, DURING_THE_GAP))).toBe('2026-08-27');
    // What the browser would have said on a UTC machine, and the bug.
    expect(DURING_THE_GAP.toISOString().slice(0, 10)).toBe('2026-08-26');
  });

  it('agrees with UTC for the other eighteen and a half hours', () => {
    expect(isoDay(clinicToday(CLINIC_TIMEZONE, OUTSIDE_THE_GAP))).toBe('2026-08-24');
    expect(OUTSIDE_THE_GAP.toISOString().slice(0, 10)).toBe('2026-08-24');
  });

  it('holds the whole 00:00–05:30 IST window on the later date', () => {
    // 18:30 UTC is exactly midnight IST: the first instant of the next clinic day.
    expect(isoDay(clinicToday(CLINIC_TIMEZONE, new Date('2026-08-26T18:29:59Z')))).toBe(
      '2026-08-26',
    );
    expect(isoDay(clinicToday(CLINIC_TIMEZONE, new Date('2026-08-26T18:30:00Z')))).toBe(
      '2026-08-27',
    );
    expect(isoDay(clinicToday(CLINIC_TIMEZONE, new Date('2026-08-26T23:59:59Z')))).toBe(
      '2026-08-27',
    );
  });

  it('falls back rather than throwing on a zone this browser does not know', () => {
    // The shape of the bug migration 20260827000100 fixed in the database: a
    // fallback spelled with a BACKSLASH raised instead of catching.
    expect(isoDay(clinicToday(String.raw`Asia\Kolkata`, DURING_THE_GAP))).toBe('2026-08-27');
  });

  it('honours a clinic that really is somewhere else', () => {
    expect(isoDay(clinicToday('UTC', DURING_THE_GAP))).toBe('2026-08-26');
  });
});

describe('civil-date arithmetic', () => {
  const day = clinicToday(CLINIC_TIMEZONE, DURING_THE_GAP); // 2026-08-27

  it('adds and subtracts days across a month boundary', () => {
    expect(isoDay(addDays(day, -6))).toBe('2026-08-21');
    expect(isoDay(addDays(day, 5))).toBe('2026-09-01');
  });

  it('finds the month and the one before it', () => {
    expect(isoDay(startOfMonth(day))).toBe('2026-08-01');
    expect(isoDay(startOfPreviousMonth(day))).toBe('2026-07-01');
    expect(isoDay(endOfPreviousMonth(day))).toBe('2026-07-31');
  });

  it('rolls the previous month back across January', () => {
    const january = clinicToday(CLINIC_TIMEZONE, new Date('2026-01-14T06:00:00Z'));
    expect(isoDay(startOfPreviousMonth(january))).toBe('2025-12-01');
    expect(isoDay(endOfPreviousMonth(january))).toBe('2025-12-31');
  });

  it('puts the financial year on 1 April, and before April uses last year', () => {
    expect(isoDay(startOfFinancialYear(day))).toBe('2026-04-01');
    const march = clinicToday(CLINIC_TIMEZONE, new Date('2026-03-31T06:00:00Z'));
    expect(isoDay(startOfFinancialYear(march))).toBe('2025-04-01');
    const april = clinicToday(CLINIC_TIMEZONE, new Date('2026-04-01T06:00:00Z'));
    expect(isoDay(startOfFinancialYear(april))).toBe('2026-04-01');
  });

  it('does not mutate the date it is given', () => {
    const before = isoDay(day);
    addDays(day, 40);
    startOfMonth(day);
    expect(isoDay(day)).toBe(before);
  });
});
