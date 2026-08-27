import { expect, test } from '@playwright/test';

/**
 * The M1 gate, end to end (BUILD.md §2).
 *
 *   "Doctor registers a walk-in, consults, signs an Rx, and it prints on the
 *    clinic's actual printer at A4."
 *
 * Everything up to the last clause is here, against a real Postgres with real
 * RLS and the real transitions. The last clause is a physical test on the
 * clinic's own printer and cannot be automated — and if that printer turns out
 * to be USB-only, a tablet cannot print to it at all (TABLET.md §1).
 */

const DEVICE = 'seed-device-cabin';
const PIN = '481920';

async function signIn(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', DEVICE] as const,
  );
  await page.goto('/');

  await page.getByRole('button', { name: 'Dr Seed' }).click();
  for (const digit of PIN) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }

  await expect(page.getByRole('heading', { name: /Signed in as Dr Seed/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
}

test('a walk-in becomes a token, a consult, a signed Rx and a printable sheet', async ({
  page,
}) => {
  await signIn(page);

  // ---- register a walk-in ------------------------------------------------
  const patient = `E2E Patient ${Date.now()}`;

  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await page.getByLabel('Name').fill(patient);

  await page.getByLabel('Age', { exact: true }).click();
  for (const digit of '42') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'M', exact: true }).click();
  await page.getByLabel('Allergies').fill('Penicillin');

  // DPDP §15.1: consent is a deliberate step, and registration is blocked
  // until it is given.
  const register = page.getByRole('button', { name: /Register & get token/ });
  await expect(register).toBeDisabled();
  await page.getByLabel('Consent').click();
  await expect(register).toBeEnabled();
  await register.click();

  // ---- the queue ---------------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  const row = page.getByRole('button', { name: new RegExp(patient) });
  await expect(row).toBeVisible();
  // The allergy is legible from the queue, before the record is even opened.
  await expect(row).toContainText('Penicillin');

  // Vitals are a shared intake action, separate from registration.
  await page.getByRole('button', { name: `Vitals for ${patient}` }).click();
  await expect(page.getByRole('heading', { name: 'Vitals', exact: true })).toBeVisible();
  await page.getByLabel('Blood pressure').fill('120/80');
  await page.getByLabel('Pulse').fill('78');
  await page.getByLabel('SpO2').fill('98');
  await page.getByRole('button', { name: 'Save vitals' }).click();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();

  await page.getByRole('button', { name: new RegExp(patient) }).click();

  // ---- consult -----------------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Consult', exact: true })).toBeVisible();
  await expect(page.getByText('Allergies: Penicillin')).toBeVisible();
  await expect(page.getByText(/BP 120\/80/)).toBeVisible();
  await expect(page.getByText(/Pulse 78/)).toBeVisible();
  await expect(page.getByText(/SpO₂ 98%/)).toBeVisible();

  await page.getByLabel('Diagnosis').fill('Acute pharyngitis');
  await page.getByRole('button', { name: 'Add diagnosis' }).click();
  await expect(page.getByRole('button', { name: /Acute pharyngitis/ })).toBeVisible();

  // ---- prescribe ---------------------------------------------------------
  await page.getByRole('button', { name: '+ Add medicine' }).click();

  // The search overlay opens full-screen with the frequent list, and three
  // characters is enough to filter it (TABLET.md §4).
  const search = page.getByRole('dialog', { name: 'Find a medicine' });
  await expect(search).toBeVisible();
  await page.getByLabel('Search medicines').fill('Dolo');

  const result = page.getByRole('button', { name: /Dolo 650/ });
  await expect(result).toBeVisible();
  // The live stock badge is what stops him prescribing off his own shelf.
  await expect(result).toContainText('in stock');
  await result.click();

  // Quantity in base units, entered on the app's own numpad — the OS keyboard
  // never appears for a number.
  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await expect(page.getByTestId('qty-base')).toContainText('15 tablets');
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  await expect(page.getByText('Dolo 650')).toBeVisible();

  // ---- sign --------------------------------------------------------------
  await page.getByRole('button', { name: 'Sign Rx' }).click();

  // ---- print -------------------------------------------------------------
  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
  await expect(page.getByText(patient)).toBeVisible();
  await expect(page.getByText('Acute pharyngitis')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Dolo 650');

  // A7: the printed, hand-signed copy is the legal document, so the prescriber
  // and their registration number are on the sheet, not implied by it.
  await expect(page.getByText('Reg. no. REG-0000').first()).toBeVisible();

  // The sheet is A4-width. A prescription that needs a horizontal scroll to
  // read is a prescription that will print wrong.
  const sheet = page.locator('.rx-sheet');
  await expect(sheet).toBeVisible();
});

test('a signed prescription cannot be edited from the consult screen', async ({ page }) => {
  await signIn(page);

  // Unique per run: the development database is not reset between runs, so a
  // previous run's patient is still in the queue.
  const patient = `E2E Locked ${Date.now()}`;

  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await page.getByLabel('Name').fill(patient);
  await page.getByLabel('Consent').click();
  await page.getByRole('button', { name: /Register & get token/ }).click();

  await page.getByRole('button', { name: new RegExp(patient) }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Search medicines').fill('Cetzine');
  await page.getByRole('button', { name: /Cetzine/ }).click();
  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await page.getByRole('button', { name: 'Sign Rx' }).click();

  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
  await page.goBack();

  // Back on the consult, the composer is closed: no add, no remove, no re-sign.
  await expect(page.getByText(/Signed at/)).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add medicine' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Signed' })).toBeDisabled();
});