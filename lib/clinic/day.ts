/**
 * "Today", in the clinic's own timezone.
 *
 * NEXT.md §4 — the schema has two notions of a day and this is the client half
 * of the one that is right.
 *
 * `app.clinic_day(timestamptz)` converts an instant to the clinic's LOCAL date
 * and has since M4: "the counter closes at 21:00 IST, which is 15:30 UTC —
 * grouping bills by UTC date would split every evening in half". The registers
 * are stored that way. `h1_register.dispensed_on` is `app.clinic_day(d.at)`.
 *
 * A screen that builds a date range out of a bare `new Date()` is asking in the
 * BROWSER's timezone instead, and those two are different dates from 00:00 to
 * 05:30 IST. On a clinic tablet, which is set to IST, that never shows. On a CI
 * runner, which is set to UTC, it emptied the H1 register every night after
 * 18:30 UTC — `expect(register).toBeVisible()` against a table that is not
 * rendered when there are no rows.
 *
 * A civil date is carried here as a `Date` pinned to UTC midnight. That is not
 * an instant and should never be shown as one; it is a year-month-day triple in
 * the one representation whose arithmetic — `getUTCDate`, `setUTCMonth` — has
 * no timezone in it at all.
 */

/**
 * Matches `clinic.timezone`, which is `not null default 'Asia/Kolkata'`.
 *
 * Used when the clinic row has not been read yet, and when it names a zone this
 * browser does not know. The database learned the same lesson one migration ago:
 * its own fallback was spelled with a backslash and would have raised rather
 * than caught, and a safety net that throws is not a safety net.
 */
export const CLINIC_TIMEZONE = 'Asia/Kolkata';

/** The clinic's current calendar day, as a civil date. */
export function clinicToday(timeZone: string = CLINIC_TIMEZONE, now: Date = new Date()): Date {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    // RangeError: an unknown IANA zone. Falling back beats throwing on a screen
    // whose job is to hand an inspector a register.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CLINIC_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  }

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);

  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
}

/** `YYYY-MM-DD`, the form every `dispensed_on` / `billed_on` filter is compared against. */
export function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Civil-date arithmetic. Every one of these returns a new date; none mutates. */
export function addDays(day: Date, days: number): Date {
  const next = new Date(day.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function startOfMonth(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

/** The last day of the month before this one. `Date.UTC(y, m, 0)` is that day. */
export function endOfPreviousMonth(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 0));
}

export function startOfPreviousMonth(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1));
}

/**
 * 1 April, the Indian financial year — the range the accountant asks for.
 *
 * Before 1 April the current year's has not started, so the one running is last
 * year's. `app.financial_year(date)` draws the same line in the database.
 */
export function startOfFinancialYear(day: Date): Date {
  const year = day.getUTCMonth() >= 3 ? day.getUTCFullYear() : day.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1));
}
