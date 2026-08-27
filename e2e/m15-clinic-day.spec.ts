import { expect, test, type Page } from '@playwright/test';

/**
 * Printerless go-live rehearsal.
 *
 * One patient crosses the real role boundary from intake to doctor to pharmacy
 * to billing, against the real database/RLS/transitions. Physical printing is
 * deliberately outside this gate until clinic hardware exists.
 */
const PIN = '481920';

async function signIn(page: Page, device: string, staffName: string) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  for (const digit of PIN) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }),
  ).toBeVisible();
}

async function shelfQty(page: Page, drug: string): Promise<number> {
  await page.goto('/inventory');
  const row = page.locator(`[data-testid^="inventory-${drug}"]`).first();
  await expect(row).toBeVisible();
  const label = (await row.getAttribute('aria-label')) ?? '';
  const match = label.match(new RegExp(`${drug}:\\s*(\\d+)\\s`));
  if (!match) throw new Error(`Could not read shelf quantity from: ${label}`);
  return Number(match[1]);
}

test('one clinic day crosses intake, consult, pharmacy, stock and billing', async ({ browser }) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();
  const patient = `Clinic Day ${Date.now()}`;

  await signIn(counterPage, 'seed-device-counter', 'Counter');
  const before = await shelfQty(counterPage, 'Cetzine');

  await signIn(doctorPage, 'seed-device-cabin', 'Dr Seed');
  await doctorPage.getByRole('button', { name: 'Open the queue' }).click();

  // Intake.
  await doctorPage.getByRole('button', { name: 'Register walk-in' }).click();
  await doctorPage.getByLabel('Name').fill(patient);
  await doctorPage.getByLabel('Consent').click();
  await doctorPage.getByRole('button', { name: /Register & get token/ }).click();

  const patientRow = doctorPage.getByRole('button', { name: new RegExp(patient) });
  await expect(patientRow).toBeVisible();
  const item = doctorPage.getByRole('listitem').filter({ has: patientRow });
  await item.getByRole('button', { name: 'Vitals', exact: true }).click();
  await doctorPage.getByLabel('Blood pressure').fill('122/78');
  await doctorPage.getByLabel('Pulse').fill('76');
  await doctorPage.getByLabel('SpO2').fill('99');
  await doctorPage.getByRole('button', { name: 'Save vitals' }).click();

  // Consultation and prescription.
  await doctorPage.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(doctorPage.getByText(/BP 122\/78/)).toBeVisible();
  await expect(doctorPage.getByText(/Pulse 76/)).toBeVisible();
  await expect(doctorPage.getByText(/SpO₂ 99%/)).toBeVisible();

  await doctorPage.getByLabel('Diagnosis').fill('Test consultation');
  await doctorPage.getByRole('button', { name: 'Add diagnosis' }).click();
  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Cetzine');
  await doctorPage.getByRole('button', { name: /Cetzine/ }).first().click();
  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);

  // Pharmacy hand-over. No physical barcode is required for this rehearsal;
  // the supported confirm-by-name fallback exercises the same stock transition.
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(counterPage.getByRole('heading', { name: 'Dispense', exact: true })).toBeVisible();
  const noBarcode = counterPage.getByRole('button', { name: 'No barcode' });
  for (let left = await noBarcode.count(); left > 0; left = await noBarcode.count()) {
    await noBarcode.first().click();
    await counterPage.getByRole('button', { name: 'Confirm by name' }).click();
  }
  await counterPage.getByRole('button', { name: 'Dispense', exact: true }).click();
  await expect(counterPage.getByText(/The ledger has been written|Dispensed\./)).toBeVisible();

  // Billing. UPI avoids making the go-live rehearsal depend on the cash drawer;
  // till reconciliation has its own M4 gate.
  await counterPage.goto('/billing');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();
  await counterPage.getByRole('button', { name: 'Raise bill' }).click();
  await counterPage.getByRole('button', { name: 'UPI', exact: true }).click();
  await expect(counterPage.getByText(/settled — ₹[\d.]+ by upi/)).toBeVisible();

  // The medicine truly left the shelf, not merely the UI worklist. The suite is
  // fully parallel, so another legitimate Cetzine sale may also happen between
  // these two reads; require at least our ten-unit drop rather than pretending
  // this test owns the whole shelf while it runs.
  const after = await shelfQty(counterPage, 'Cetzine');
  expect(after).toBeLessThanOrEqual(before - 10);

  // And the completed prescription is no longer waiting at pharmacy.
  await counterPage.goto('/counter');
  await expect(counterPage.getByRole('button', { name: new RegExp(patient) })).toHaveCount(0);

  await cabin.close();
  await counter.close();
});
