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

test('while it is still asking, it waits rather than accusing the tablet', async ({
  page,
}) => {
  let releaseSetupState!: () => void;
  const setupStateGate = new Promise<void>((resolve) => {
    releaseSetupState = resolve;
  });

  await page.route('**/rest/v1/clinic_setup_state*', async (route) => {
    await setupStateGate;
    await route.continue();
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Just a moment' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'This tablet is not registered' }),
  ).toHaveCount(0);

  releaseSetupState();
  await expect(page.getByRole('heading', { name: 'Set this clinic up' })).toBeVisible({
    timeout: 15_000,
  });
  await page.unroute('**/rest/v1/clinic_setup_state*');
});

test('a clinic is stood up from nothing, on the tablet, by the doctor', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Set this clinic up' })).toBeVisible();

  await page.getByLabel('Clinic name').fill(CLINIC);
  await page.getByLabel('Your name').fill(DOCTOR);
  await page.getByLabel('This tablet').fill('Cabin tablet');
  await typePin(page, PIN);
  await page.getByRole('button', { name: 'Set up', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${DOCTOR}`) }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open the queue' }).click();
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();

  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Clinic control center', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /People & tablets/ })).toBeVisible();

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
  const fresh = await browser.newContext();
  const tablet = await fresh.newPage();
  await tablet.goto('/');

  await expect(tablet.getByRole('heading', { name: 'Set this clinic up' })).toHaveCount(0);
  await expect(
    tablet.getByRole('heading', { name: 'This tablet is not registered' }),
  ).toBeVisible();
  await expect(tablet.getByLabel('Registration code')).toBeVisible();

  await fresh.close();
});
