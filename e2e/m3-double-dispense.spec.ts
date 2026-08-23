import { expect, test, type Page } from '@playwright/test';

/**
 * One prescription, one deduction — proved across two devices.
 *
 * The bug this pins down needed no privilege and no tampering. The cabin tablet
 * and the counter tablet both open a pending prescription, both verify their
 * lines, and both press Dispense. `app.dispense` validated the request against
 * the SHELF and never against the PRESCRIPTION, so both calls succeeded: thirty
 * tablets left for a fifteen-tablet prescription, both screens showed "the
 * ledger has been written and the stock is down", and the patient appeared
 * twice on the billing screen at the same amount and the same second. Nothing
 * surfaced it until a stock-take months later.
 *
 * It lives in e2e rather than only in pgTAP because the pgTAP version proves
 * the guard refuses; only this one proves the two tablets can reach it at all.
 * Both screens are opened and verified BEFORE either dispenses, which is the
 * whole point — neither has seen the other's write.
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

/** Open the prescription and clear every verification gate on it. */
async function openAndVerify(page: Page, patient: string, drug: string) {
  await page.goto('/counter');
  await page.getByRole('button', { name: new RegExp(patient) }).first().click();
  await expect(page.getByRole('heading', { name: 'Dispense', exact: true })).toBeVisible();
  // The lines arrive after the heading; verifying before they render is a no-op
  // that leaves Dispense disabled and the test asserting nothing.
  await expect(page.getByText(drug).first()).toBeVisible();

  // The seed carries no barcodes, so this is the "confirm by name" path.
  // The second gesture is the clinic's own modal, so it is confirmed on the
  // page rather than through a dialog handler.
  const noBarcode = page.getByRole('button', { name: 'No barcode' });
  for (let remaining = await noBarcode.count(); remaining > 0; remaining = await noBarcode.count()) {
    await noBarcode.first().click();
    await page.getByRole('button', { name: 'Confirm by name' }).click();
  }

  const dispense = page.getByRole('button', { name: 'Dispense', exact: true });
  await expect(dispense).toBeEnabled();
  return dispense;
}

test('two tablets reaching for one prescription dispense it once', async ({ browser }) => {
  const patient = `Double ${Date.now()}`;
  const drug = 'Dolo 650';

  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  await signIn(doctorPage, 'seed-device-cabin', 'Dr Seed');
  await signIn(counterPage, 'seed-device-counter', 'Counter');

  // ---- one prescription, one strip -----------------------------------------
  await doctorPage.getByRole('button', { name: 'Open the queue' }).click();
  await doctorPage.getByRole('button', { name: 'Register walk-in' }).click();
  await doctorPage.getByLabel('Name').fill(patient);
  await doctorPage.getByLabel('Consent').click();
  await doctorPage.getByRole('button', { name: /Register & get token/ }).click();

  await doctorPage.getByRole('button', { name: new RegExp(patient) }).first().click();
  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill(drug);
  await doctorPage.getByRole('button', { name: new RegExp(drug) }).first().click();
  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/[0-9a-f-]+\/print$/);

  // ---- both tablets get as far as a live Dispense button --------------------
  const fromCounter = await openAndVerify(counterPage, patient, drug);
  const fromCabin = await openAndVerify(doctorPage, patient, drug);

  await Promise.all([fromCounter.click(), fromCabin.click()]);

  // The loser is told why, in the words the counter needs — not a stack trace,
  // and not silence, which is what it got before the guard existed.
  // Which tablet loses the race is not deterministic, so both are polled.
  await expect
    .poll(
      async () => {
        const texts = await Promise.all(
          [doctorPage, counterPage].map((page) => page.locator('body').innerText()),
        );
        return texts.some((text) =>
          /already been dispensed in full against this prescription/.test(text),
        );
      },
      { message: 'the tablet that lost the race is told why', timeout: 10_000 },
    )
    .toBe(true);

  // ---- and only one dispense stands against the prescription ---------------
  //
  // Asserted through billing rather than against a stock number: the suite runs
  // fullyParallel and other specs are moving this drug at the same time, so an
  // absolute shelf figure would be testing the scheduler. One unbilled row per
  // patient is the same guarantee, scoped to this prescription — and it is the
  // symptom the bug actually presented as, the patient listed twice at the same
  // amount and the same second, with no way for the counter to tell which to
  // charge for. Read last, because it navigates away from the screens above.
  await counterPage.goto('/billing');
  await expect(counterPage.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await expect(counterPage.getByRole('button', { name: new RegExp(patient) })).toHaveCount(1);
});

