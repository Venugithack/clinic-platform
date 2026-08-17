import { expect, test } from '@playwright/test';

/**
 * The M11f gate — and the only test in this repository that runs against an
 * EMPTY database.
 *
 * That is the whole point of it. Every other spec starts from `seed.sql`, and
 * the seed inserts two devices, which is exactly why the deadlock this closes
 * survived four milestones unnoticed: on a fresh production database, a staff
 * session needs an unlock, an unlock needs a registered device, and
 * registering a device needed an admin session. Nothing could create the first
 * tablet.
 *
 * It cannot run beside the rest of the suite — it needs the database to be
 * empty, and the rest of the suite needs it seeded. `scripts/first-run-drill.sh`
 * owns that: reset to migrations only, run this file alone, put the seed back.
 *
 * It is a drill in the same sense as `db-restore-drill.sh`. Standing the system
 * up from nothing is a thing that happens exactly once, in a clinic, with
 * somebody waiting — which is the worst possible moment to discover it was
 * never tried.
 */
test.describe.configure({ mode: 'serial' });

const CLINIC = 'Sri Sai Clinic';
const DOCTOR = 'Dr Venkat';
const PIN = '481920';

async function typePin(page: import('@playwright/test').Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test('a clinic is stood up from nothing, on the tablet, by the doctor', async ({
  page,
}) => {
  await page.goto('/');

  // Not "this tablet is not registered" — there is nothing to be registered
  // WITH. The screen has to tell those two situations apart, and it does it by
  // asking whether the clinic has any staff at all.
  await expect(page.getByRole('heading', { name: 'Set this clinic up' })).toBeVisible();

  await page.getByLabel('Clinic name').fill(CLINIC);
  await page.getByLabel('Your name').fill(DOCTOR);
  await page.getByLabel('This tablet').fill('Cabin tablet');
  await typePin(page, PIN);
  await page.getByRole('button', { name: 'Set up', exact: true }).click();

  // Signed in already, on a tablet that is now registered: the device token
  // and the session both came back from that one call, and the PIN chosen four
  // seconds ago is not asked for again.
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${DOCTOR}`) }),
  ).toBeVisible();

  // And the person who set it up is an admin, so the rest of go-live — the
  // settings, the second tablet, the drug master — is reachable from here
  // without anybody touching a database.
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await expect(page.getByRole('button', { name: 'People' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();

  // Then lock it and come back in the ordinary way. This is the assertion that
  // setup was a real sign-in on a real device registration, rather than a
  // special case bolted past the front door: the PIN he chose is the PIN that
  // works, on the tablet that call registered.
  await page.goto('/');
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Who is this?' })).toBeVisible();
  await page.getByRole('button', { name: DOCTOR, exact: true }).click();
  await typePin(page, PIN);
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${DOCTOR}`) }),
  ).toBeVisible();
});

test('the setup screen is never offered again, on any tablet', async ({ browser }) => {
  // A second tablet out of the box, against the clinic the first test created.
  const fresh = await browser.newContext();
  const tablet = await fresh.newPage();
  await tablet.goto('/');

  await expect(tablet.getByRole('heading', { name: 'Set this clinic up' })).toHaveCount(0);
  await expect(
    tablet.getByRole('heading', { name: 'This tablet is not registered' }),
  ).toBeVisible();

  // It asks for a code instead — which only an admin can produce, from the
  // tablet that already works. That is the difference between setting a clinic
  // up and walking into one.
  await expect(tablet.getByLabel('Registration code')).toBeVisible();

  await fresh.close();
});
