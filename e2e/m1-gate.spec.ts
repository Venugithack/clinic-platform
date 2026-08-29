import { expect, test } from '@playwright/test';
import { signInAndOpen } from './support/session';

async function register(page: import('@playwright/test').Page, patient: string) {
  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await expect(page.getByRole('heading', { name: 'Register walk-in', exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(patient);
  await page.getByLabel('Consent').click();
  await page.getByRole('button', { name: /Register & get token/ }).click();
  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();
}

test('a walk-in becomes a token, a consult, a signed Rx and a printable sheet', async ({ page }) => {
  await signInAndOpen(page, 'Dr Seed');

  const patient = `E2E Patient ${Date.now()}`;
  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await expect(page.getByRole('heading', { name: 'Register walk-in', exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(patient);

  await page.getByLabel('Age', { exact: true }).click();
  for (const digit of '42') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'M', exact: true }).click();
  await page.getByLabel('Allergies').fill('Penicillin');
  await page.getByLabel('Reason for visit').fill('Sore throat since yesterday');

  const registerButton = page.getByRole('button', { name: /Register & get token/ });
  await expect(registerButton).toBeDisabled();
  await page.getByLabel('Consent').click();
  await expect(registerButton).toBeEnabled();
  await registerButton.click();

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

  await page.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(page.getByRole('heading', { name: 'Consult', exact: true })).toBeVisible();
  await expect(page.getByText('Allergies: Penicillin')).toBeVisible();
  await expect(page.getByText('BP', { exact: true })).toBeVisible();
  await expect(page.getByText('120/80', { exact: true })).toBeVisible();
  await expect(page.getByText('Pulse', { exact: true })).toBeVisible();
  await expect(page.getByText('78', { exact: true })).toBeVisible();
  await expect(page.getByText('SpO₂', { exact: true })).toBeVisible();
  await expect(page.getByText('98%', { exact: true })).toBeVisible();

  await page.getByLabel('Diagnosis').fill('Acute pharyngitis');
  await page.getByRole('button', { name: 'Add diagnosis' }).click();

  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Search medicines').fill('Dolo');
  const result = page.getByRole('button', { name: /Dolo 650/ });
  await expect(result).toContainText('in stock');
  await result.click();

  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await expect(page.getByTestId('qty-base')).toContainText('15 tablets');
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  await page.getByRole('button', { name: /Sign Rx/ }).click();

  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
  await expect(page.getByText(patient)).toBeVisible();
  await expect(page.getByText('Acute pharyngitis')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Dolo 650');
  await expect(page.getByText('Reg. no. REG-0000').first()).toBeVisible();
});

test('a signed prescription cannot be edited from the consult screen', async ({ page }) => {
  await signInAndOpen(page, 'Dr Seed');

  const patient = `E2E Locked ${Date.now()}`;
  await register(page, patient);

  await page.getByRole('button', { name: new RegExp(patient) }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Search medicines').fill('Cetzine');
  await page.getByRole('button', { name: /Cetzine/ }).click();
  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await page.getByRole('button', { name: /Sign Rx/ }).click();

  await expect(page).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);
  await page.goBack();

  await expect(page.getByText(/Prescription signed at/)).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add medicine' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open signed Rx', exact: true })).toBeVisible();
  await expect(page.getByLabel('Advice')).toBeDisabled();
});

test('finish visit saves diagnosis and advice before returning to the queue', async ({ page }) => {
  await signInAndOpen(page, 'Dr Seed');

  const patient = `E2E Finish ${Date.now()}`;
  await register(page, patient);
  await page.getByRole('button', { name: new RegExp(patient) }).click();

  await page.getByLabel('Diagnosis').fill('Viral fever');
  await page.getByRole('button', { name: 'Add diagnosis' }).click();
  await page.getByLabel('Advice').fill('Rest and fluids');

  await page.getByRole('button', { name: 'Finish visit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();

  await page.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(page.getByRole('button', { name: /Viral fever/ })).toBeVisible();
  await expect(page.getByLabel('Advice')).toHaveValue('Rest and fluids');
});
