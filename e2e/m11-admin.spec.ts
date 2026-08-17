import { expect, test, type Page } from '@playwright/test';

/**
 * The M11c gate (PLAN.md §16, TABLET.md §5).
 *
 * `A8_admin.sql` proves the transitions. What only a browser proves is that
 * the two errands actually complete end to end:
 *
 *   somebody added on this screen can sign in on a tablet, and somebody marked
 *     as left cannot — the lock screen is the test, not the row;
 *   a tablet registered here can be brought up from nothing with the code it
 *     showed once, and revoking it takes that away again.
 *
 * Serial: it adds a person and a tablet to the seeded clinic, and puts both
 * back.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const PHARMACIST = `E2E Pharmacist ${STAMP}`;
const TABLET = `E2E Tablet ${STAMP}`;

async function typePin(page: Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

async function signIn(page: Page, device: string, staffName: string, pin = '481920') {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  await typePin(page, pin);
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }),
  ).toBeVisible();
}

test('somebody added here can sign in, and somebody marked as left cannot', async ({
  browser,
}) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await page.getByRole('button', { name: 'Add someone' }).click();
  await page.getByLabel('Name', { exact: true }).fill(PHARMACIST);
  await page.getByLabel('Phone').fill('+91 90000 00009');
  await typePin(page, '246810');
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('can sign in now');

  // The assertion that matters: a different tablet, and the new person is on
  // its lock screen with a PIN that works.
  const counter = await browser.newContext();
  const theirs = await counter.newPage();
  await signIn(theirs, 'seed-device-counter', PHARMACIST, '246810');

  // Now they leave.
  await page.getByRole('button', { name: `Mark ${PHARMACIST} as left` }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('Nothing they did has changed');

  const after = await browser.newContext();
  const gone = await after.newPage();
  await gone.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', 'seed-device-counter'] as const,
  );
  await gone.goto('/');
  await expect(gone.getByRole('button', { name: PHARMACIST, exact: true })).toHaveCount(0);
  // And they are still on the list here, because their name is on prescriptions.
  await expect(
    page.getByRole('button', { name: `Bring ${PHARMACIST} back` }),
  ).toBeVisible();

  await admin.close();
  await counter.close();
  await after.close();
});

test('the last administrator cannot switch themselves off', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await page.getByRole('button', { name: 'Mark Admin as left' }).click();

  // The refusal comes from the database, and it says what to do about it.
  await expect(page.getByText(/only administrator left/)).toBeVisible();
  await expect(page.getByText(/make somebody else an admin first/)).toBeVisible();
});

test('a tablet is registered once, brought up from its code, and revoked', async ({
  browser,
}) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await page.getByLabel('Tablet name').fill(TABLET);
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  const panel = page.getByTestId('registration-code');
  await expect(panel).toBeVisible();
  const code = ((await panel.locator('p.font-mono').textContent()) ?? '').trim();
  expect(code).toMatch(/^[0-9a-f]{48}$/);

  // A tablet out of the box: nothing in local storage, the registration screen,
  // and the code read off the admin's screen.
  const fresh = await browser.newContext();
  const tablet = await fresh.newPage();
  await tablet.goto('/');
  await expect(tablet.getByText('This tablet is not registered')).toBeVisible();
  await tablet.getByLabel('Registration code').fill(code);
  await tablet.getByRole('button', { name: 'Register this tablet' }).click();

  await tablet.getByRole('button', { name: 'Admin', exact: true }).click();
  await typePin(tablet, '481920');
  await expect(tablet.getByRole('heading', { name: /Signed in as Admin/ })).toBeVisible();

  // Dismiss the one-time code and revoke the tablet from the other one.
  await page.getByRole('button', { name: 'Done — it is on the tablet' }).click();
  await page.getByRole('button', { name: `Revoke ${TABLET}` }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('revoked');

  // The credential is worthless now, on a tablet that still has it.
  await tablet.goto('/');
  await tablet.evaluate(() => window.sessionStorage.clear());
  await tablet.reload();
  await tablet.getByRole('button', { name: 'Admin', exact: true }).click();
  await typePin(tablet, '481920');

  // "Incorrect PIN", not "this tablet was revoked" — the lock screen refuses a
  // wrong PIN, an unknown person and a revoked device identically on purpose
  // (TABLET.md §5). Somebody holding a stolen tablet learns nothing from it.
  await expect(tablet.getByText('Incorrect PIN.')).toBeVisible();

  await admin.close();
  await fresh.close();
});

test('the tablet in your hands is not the one you revoke', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await page.getByRole('button', { name: 'Revoke Cabin tablet' }).click();

  await expect(page.getByText(/that is the tablet you are using/)).toBeVisible();
});

test('the counter cannot add staff or register a tablet', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/admin');

  await expect(page.getByText(/Only an administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add someone' })).toBeDisabled();

  await page.getByLabel('Tablet name').fill('A tablet the counter wants');
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeDisabled();
});
