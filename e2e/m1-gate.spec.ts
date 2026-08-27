import { expect, test } from '@playwright/test';

/**
 * The M1 gate, end to end (BUILD.md §2).
 *
 *   "Doctor registers a walk-in, consults, signs an Rx, and it prints on the
 *    clinic's actual printer at A4."
 *
 * Everything up to the last clause is here, against a real Postgres with real
 * RLS and the real transitions. The last clause is a physical test on the
 * clinic's own printer and cannot be automated.
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
  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();
}

test('a walk-in becomes a token, a consult, a signed Rx and a printable sheet', async ({
  page,
}) => {
  await signIn(page);

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
  await page.getByLabel('Reason for visit').fill('Sore throat since yesterday');

  const register = page.getByRole('button', { name: /Register & get token/ });
  await expect(register).toBeDisabled();
  await page.getByLabel('Consent').click();
  await expect(register).toBeEnabled();
  await register.click();

  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();
  const row = page.getByRole('button', { name: new RegExp(patient) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Penicillin');
  await expect(row).toContainText('Sore throat since yesterday');

  const patientItem = page.getByRole('listitem').filter({ has: row });
  await patientItem.getByRole('button', { name: 'Vitals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record vitals', exact: true })).toBeVisible();
  await expect(page.getByText('Sore throat since yesterday')).toBeVisible();
  await page.getByLabel('Blood pressure').fill('120/80');
  await page.getByLabel('Pulse').fill('78');
  await page.getByLabel('SpO2').fill('98');
  await page.getByRole('button', { name: 'Save vitals' }).click();
  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();

  await page.getByRole('button', { name: new RegExp(patient) }).click();

  await expect(page.getByRole('heading', { name: 'Consult', exact: true })).toBeVisible();
  await expect(page.getByText('Allergies: Penicillin')).toBeVisible();
  await expect(page.getByText(/BP 120\/80/)).toBeVisible();
  await expect(page.getByText(/Pulse 78/)).toBeVisible();
  await expect(page.getByText(/SpO₂ 98%/)).toBeVisible();

  await page.getByLabel('Diagnosis').fill('Acute pharyngitis');
  await page.getByRole('button', { name: 'Add diagnosis' }).click();
  await expect(page.getByRole('button', { name: /Acute pharyngitis/ })).toBeVisible();

  await page.getByRole('button', { name: '+ Add medicine' }).click();

  const search = page.getByRole('dialog', { name: 'Find a medicine' });
  await expect(search).toBeVisible();
  await page.getByLabel('Search medicines').fill('Dolo');

  const result = page.getByRole('button', { name: /Dolo 650/ });
  await expect(result).toBeVisible();
  await expect(result).toContainText('in stock');
  await result.click();

  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await expect(page.getByTestId('qty-base')).toContainText('15 tablets');
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  await expect(page.getByText('Dolo 650')).toBeVisible();

  await page.getByRole('button', { name: 'Sign Rx' }).click();

  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
  await expect(page.getByText(patient)).toBeVisible();
  await expect(page.getByText('Acute pharyngitis')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Dolo 650');

  await expect(page.getByText('Reg. no. REG-0000').first()).toBeVisible();

  const sheet = page.locator('.rx-sheet');
  await expect(sheet).toBeVisible();
});

test('a signed prescription cannot be edited from the consult screen', async ({ page }) => {
  await signIn(page);

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

  await expect(page.getByText(/Signed at/)).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add medicine' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Signed' })).toBeDisabled();
});
