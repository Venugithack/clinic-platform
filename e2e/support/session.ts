import { expect, type Page } from '@playwright/test';

/**
 * Signing in, once, for the whole suite.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Twenty-one specs each carried their own copy of this function. That is why a
 * single change to how staff sign in turned into thirty-two red tests: the
 * knowledge of what the lock screen looks like was written down twenty-one
 * times, so it went stale twenty-one times.
 *
 * Two changes broke them, and only one of them was the obvious one.
 *
 *   1. `clinic.deviceToken`. Every copy seeded a trusted-device token into
 *      localStorage before navigating. PR #29 deleted device trust, so the line
 *      became inert — harmless, and therefore misleading: it looked like the
 *      cause and was not.
 *
 *   2. The staff row grew a role. Each copy clicked
 *      `getByRole('button', { name: staffName, exact: true })`, and the row now
 *      renders the name beside its role — so the accessible name of the
 *      pharmacy row is "Counter Pharmacy / Counter" and an exact match on
 *      "Counter" finds nothing. That was the real failure, in all twenty-one.
 *
 * The matcher below is deliberately not written against the accessible name at
 * all. It finds the button that CONTAINS an element whose exact text is the
 * staff member's name, which is true however the row is decorated — with a
 * role today, with a photograph or a shift badge tomorrow.
 */

/**
 * Every seeded staff member shares this PIN, which is fine for a disposable
 * database and forbidden in the clinic — GO_LIVE.md §9, because the audit trail
 * rests on a PIN identifying one person.
 */
export const SEED_PIN = '481920';

/**
 * Sign in and stop on the "Signed in as …" screen.
 *
 * Deliberately stops there rather than continuing into the app: the specs that
 * want the queue or the counter click their own "Open the …" button, and a
 * couple assert against this screen itself.
 */
export async function signIn(page: Page, staffName: string, pin = SEED_PIN): Promise<void> {
  await page.goto('/');
  await staffRow(page, staffName).click();

  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }

  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${escapeForRegExp(staffName)}`) }),
  ).toBeVisible();
}

/**
 * Leave the "Signed in as …" screen and enter the app.
 *
 * The button is matched on its shape rather than its words, because the words
 * depend on the role: a doctor is offered "Open the queue", the pharmacy "Open
 * the counter", an administrator "Open the control panel". Four specs asked for
 * "Open the queue" while signed in as Admin — they had been stale since PR #29
 * moved administrators to their own home, and were only ever going to pass for
 * a doctor.
 */
export async function openApp(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open the / }).click();
}

/** Sign in and go straight through to the role's own home screen. */
export async function signInAndOpen(page: Page, staffName: string): Promise<void> {
  await signIn(page, staffName);
  await openApp(page);
}

/** The row for one staff member on the lock screen. */
export function staffRow(page: Page, staffName: string) {
  return page
    .getByRole('button')
    .filter({ has: page.getByText(staffName, { exact: true }) })
    .first();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
