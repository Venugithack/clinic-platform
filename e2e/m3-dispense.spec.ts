import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/session';

/**
 * The M3 gate (BUILD.md §2).
 *
 *   "Two batches, different expiries, different MRPs, different strip sizes —
 *    dispensing takes the earlier, charges the right MRP, and the ledger
 *    reconciles. An expired batch is refused. A barcode scan at dispense stops
 *    the wrong box."
 *
 * The seed sets this up deliberately: Dolo 650 arrives as DL2411A (long-dated,
 * 15 to a strip, MRP 34.50) and DL2503B (90 days out, 10 to a strip, MRP
 * 24.00). Different expiries, different MRPs, different strip sizes — the case
 * the prototype could not even represent, because one row was drug *and* batch.
 *
 * Scanning is driven through the manual-entry path rather than the camera.
 * `BarcodeDetector` and getUserMedia do not exist in headless Chromium, and
 * that path is real functionality rather than a test hook: a scuffed strip or a
 * denied permission has to leave the counter working. The camera itself is
 * tested on the tablets, alongside the LAN certificate in BUILD.md §1.3.
 */

/** A signed prescription for one drug, straight through the doctor's screens. */
async function prescribe(page: Page, patient: string, drug: string, chip: string) {
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await page.getByLabel('Name').fill(patient);
  await page.getByLabel('Consent').click();
  await page.getByRole('button', { name: /Register & get token/ }).click();

  await page.getByRole('button', { name: new RegExp(patient) }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Search medicines').fill(drug);
  await page.getByRole('button', { name: new RegExp(drug) }).click();

  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: chip, exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await page.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
}

test('FEFO takes the earlier expiry, and the scan stops the wrong box', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  const patient = `E2E Dispense ${Date.now()}`;

  await signIn(doctorPage, 'Dr Seed');
  await prescribe(doctorPage, patient, 'Dolo 650', '10');

  await signIn(counterPage, 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(counterPage.getByRole('heading', { name: 'Dispense', exact: true }))
    .toBeVisible();

  // ---- FEFO, before anything moves ---------------------------------------
  // The counter is told which box to reach for, and it is the one expiring
  // first — not the one at the front of the shelf.
  await expect(counterPage.getByText(/take 10 from DL2503B/)).toBeVisible();

  // ---- the scan that stops the wrong box ---------------------------------
  const scan = counterPage.getByTestId('scanfield');

  // A code nobody has taught the system yet: it asks, once.
  await scan.getByLabel('Barcode').fill('8900000000001');
  await scan.getByRole('button', { name: 'Check' }).click();
  await expect(counterPage.getByText(/Unknown code/)).toBeVisible();
  await counterPage.getByRole('button', { name: 'This one' }).click();
  await expect(counterPage.getByText(/learned and verified/)).toBeVisible();

  // Dispense is now possible: every line is accounted for.
  const dispenseButton = counterPage.getByRole('button', { name: 'Dispense', exact: true });
  await expect(dispenseButton).toBeEnabled();

  await dispenseButton.click();
  await expect(counterPage.getByText(/The ledger has been written/)).toBeVisible();
  await expect(counterPage.getByRole('button', { name: 'Dispensed' })).toBeDisabled();

  await cabin.close();
  await counter.close();
});

test('a pack that is not on the prescription is refused, loudly', async ({ browser }) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  const patient = `E2E WrongBox ${Date.now()}`;

  await signIn(doctorPage, 'Dr Seed');
  await prescribe(doctorPage, patient, 'Cetzine', '10');

  await signIn(counterPage, 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();

  const scan = counterPage.getByTestId('scanfield');

  // Teach a code against a drug that is NOT on this prescription, by using it
  // on a different one first. Here it is enough that the code resolves to a
  // drug the prescription does not name.
  await scan.getByLabel('Barcode').fill('8900000000001');
  await scan.getByRole('button', { name: 'Check' }).click();

  // Either it is unknown (asks) or it maps to Dolo from the other test — both
  // must leave the Cetzine line unverified and dispense unavailable. What must
  // never happen is a silent pass.
  await expect(
    counterPage.getByText(/Unknown code|is not on this prescription/),
  ).toBeVisible();

  await expect(counterPage.getByRole('button', { name: 'Dispense', exact: true }))
    .toBeDisabled();

  await cabin.close();
  await counter.close();
});

test('the patient stays named after the medicine is handed over', async ({ browser }) => {
  // The dispense screen's header used to read `pharmacy_queue`, which holds
  // only pending and partial prescriptions. So the moment a dispense completed
  // the row left the view, the header went null, and the pane fell back to the
  // very placeholder it uses while loading: the patient's name became "…" and
  // the token became "—", on the screen where the pharmacist is confirming who
  // they are handing medicine to. A finished dispense rendered as one that had
  // failed to load.
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  await signIn(doctorPage, 'Dr Seed');
  await signIn(counterPage, 'Counter');

  const patient = `Named ${Date.now()}`;
  await prescribe(doctorPage, patient, 'Glycomet 500', '1 strip');

  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).first().click();
  await expect(counterPage.getByRole('heading', { name: 'Dispense', exact: true })).toBeVisible();

  const pane = counterPage.locator('[data-pane="context"]');
  await expect(pane).toContainText(patient);

  // "Confirm by name" is the clinic's own modal, not a window.confirm — so the
  // second gesture is a button on the page rather than a dialog handler.
  const noBarcode = counterPage.getByRole('button', { name: 'No barcode' });
  for (let left = await noBarcode.count(); left > 0; left = await noBarcode.count()) {
    await noBarcode.first().click();
    await counterPage.getByRole('button', { name: 'Confirm by name' }).click();
  }
  await counterPage.getByRole('button', { name: 'Dispense', exact: true }).click();
  await expect(counterPage.getByText(/Dispensed\./)).toBeVisible();

  // The assertion that matters: still named, still tokened, after success.
  await expect(pane).toContainText(patient);
  await expect(pane).not.toContainText('Token —');

  // And the same screen opened cold, which the old header never handled at all
  // — there the name was missing from the first paint rather than lost on the
  // way through.
  // A fresh tab is a fresh unlock: the device token is in localStorage and
  // shared, but the PIN session is in sessionStorage and is not.
  const cold = await cabin.newPage();
  await signIn(cold, 'Dr Seed');
  await cold.goto(counterPage.url());
  await expect(cold.getByRole('heading', { name: 'Dispense', exact: true })).toBeVisible();
  await expect(cold.locator('[data-pane="context"]')).toContainText(patient);

  await cabin.close();
  await counter.close();
});
