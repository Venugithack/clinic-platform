import { expect, test, type Page } from '@playwright/test';

/**
 * The M11d gate (PLAN.md §15.2, §16).
 *
 * Two things this build could describe and not do:
 *
 *   M8 flagged a Schedule H1 row with no patient address — because the rule
 *     requires one — and gave nobody a way to fix it;
 *   M4 wrote and tested `app.void_bill` and no screen ever called it.
 *
 * A flag nobody can act on is a flag nobody reads, and a transition with no
 * caller is a feature the clinic does not have. So both tests below start
 * where the person actually is: looking at the register, and holding a bill
 * made out to the wrong patient.
 *
 * Serial: it dispenses a controlled drug and then goes looking for it.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const PATIENT = `E2E Fix ${STAMP}`;

async function signIn(page: Page, device: string, staffName: string) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  for (const digit of '481920') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }),
  ).toBeVisible();
}

test('an H1 row with no address is fixed from the register that flagged it', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  await signIn(doctorPage, 'seed-device-cabin', 'Dr Seed');

  // Registered WITHOUT an address, which is the whole point: it is a required
  // field on a register nobody looks at until an inspection.
  await doctorPage.getByRole('button', { name: 'Open the queue' }).click();
  await doctorPage.getByRole('button', { name: 'Register walk-in' }).click();
  await doctorPage.getByLabel('Name').fill(PATIENT);
  await doctorPage.getByLabel('Consent').click();
  await doctorPage.getByRole('button', { name: /Register & get token/ }).click();

  await doctorPage.getByRole('button', { name: new RegExp(PATIENT) }).click();
  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Alprax');
  await doctorPage.getByRole('button', { name: /Alprax/ }).click();

  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/[0-9a-f-]+\/print$/);

  await signIn(counterPage, 'seed-device-counter', 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(PATIENT) }).click();

  // Scan-to-verify (M3): the counter cannot dispense a line it has not matched
  // against the box in its hand. Its own code, not the one m8-registers uses,
  // so the two specs never race to teach the same barcode.
  const scan = counterPage.getByTestId('scanfield');
  await scan.getByLabel('Barcode').fill('8900000000778');
  await scan.getByRole('button', { name: 'Check' }).click();
  await expect(counterPage.getByText(/Unknown code/)).toBeVisible();
  await counterPage.getByRole('button', { name: 'This one' }).click();
  await expect(counterPage.getByText(/learned and verified/)).toBeVisible();

  const dispense = counterPage.getByRole('button', { name: 'Dispense', exact: true });
  await expect(dispense).toBeEnabled();
  await dispense.click();
  await expect(counterPage.getByText(/The ledger has been written/)).toBeVisible();

  // The register, and the flag.
  await doctorPage.goto('/reports');
  const flagged = doctorPage
    .getByTestId('register')
    .locator('tr', { hasText: PATIENT });
  await expect(flagged).toBeVisible();

  // M8 stopped here. M11d adds the way out of it.
  await flagged.getByRole('button', { name: 'Add address' }).click();
  await expect(doctorPage.getByRole('heading', { name: 'Patient record' })).toBeVisible();
  await doctorPage.getByLabel('Address').fill('12 Nehru Street, Kadapa');
  await doctorPage.getByRole('button', { name: 'Save' }).click();
  await expect(doctorPage.getByTestId('patient-saved')).toBeVisible();

  // Back on the register the row is complete, and the offer to fix it is gone.
  await doctorPage.goto('/reports');
  const fixed = doctorPage.getByTestId('register').locator('tr', { hasText: PATIENT });
  await expect(fixed).toContainText('12 Nehru Street, Kadapa');
  await expect(fixed.getByRole('button', { name: 'Add address' })).toHaveCount(0);

  await cabin.close();
  await counter.close();
});

test('a bill made out to the wrong patient is cancelled, with a reason', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/billing');

  // Bill the dispense from the first test.
  await page.getByRole('button', { name: new RegExp(PATIENT) }).first().click();
  await page.getByRole('button', { name: 'Raise bill' }).click();

  const cancel = page.getByRole('button', { name: /^Cancel bill / }).first();
  await expect(cancel).toBeVisible();
  await cancel.click();

  // A reason is not optional — "cancelled" with no why is the entry an auditor
  // asks about, and the screen will not even offer the button without one.
  await expect(page.getByRole('button', { name: 'Cancel this bill' })).toBeDisabled();

  await page.getByLabel('Reason').fill('billed to the wrong patient');
  await page.getByRole('button', { name: 'Cancel this bill' }).click();

  const notice = page.getByRole('status');
  await expect(notice).toContainText('is cancelled');
  // The sentence the pharmacist most needs, said on the screen rather than
  // discovered at the next stock-take.
  await expect(notice).toContainText('not back on the shelf');

  // The dispense is billable again, which is the point of cancelling it.
  await expect(
    page.getByRole('button', { name: new RegExp(PATIENT) }).first(),
  ).toBeVisible();
});
