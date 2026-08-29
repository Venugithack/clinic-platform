import { expect, test } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

/**
 * The M8 gate (PLAN.md §8, §15.2).
 *
 *   "H1 register exports for a date range in a form an inspector accepts."
 */
test.describe.configure({ mode: 'serial' });

const PATIENT = `E2E H1 ${Date.now()}`;

test('a Schedule H1 medicine reaches a patient, with an address on file', async ({ browser }) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  await signInAndOpen(doctorPage, 'Dr Seed');
  await doctorPage.getByRole('button', { name: 'Register walk-in' }).click();
  await expect(
    doctorPage.getByRole('heading', { name: 'Register walk-in', exact: true }),
  ).toBeVisible();
  await doctorPage.getByLabel('Name', { exact: true }).fill(PATIENT);
  await doctorPage.getByLabel('Address').fill('12 Nehru Street, Kadapa');
  await doctorPage.getByLabel('Consent').click();
  await doctorPage.getByRole('button', { name: /Register & get token/ }).click();

  await doctorPage.getByRole('button', { name: new RegExp(PATIENT) }).click();
  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Alprax');
  await doctorPage.getByRole('button', { name: /Alprax/ }).click();

  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: /Sign Rx/ }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);

  await signIn(counterPage, 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(PATIENT) }).click();

  const scan = counterPage.getByTestId('scanfield');
  await scan.getByLabel('Barcode').fill('8900000000777');
  await scan.getByRole('button', { name: 'Check' }).click();
  await expect(counterPage.getByText(/Unknown code/)).toBeVisible();
  await counterPage.getByRole('button', { name: 'This one' }).click();
  await expect(counterPage.getByText(/learned and verified/)).toBeVisible();

  const dispense = counterPage.getByRole('button', { name: 'Dispense', exact: true });
  await expect(dispense).toBeEnabled();
  await dispense.click();
  await expect(counterPage.getByText(/The ledger has been written/)).toBeVisible();

  await cabin.close();
  await counter.close();
});

test('the register carries every column the rule names, and downloads', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/reports');

  const register = page.getByTestId('register');
  await expect(register).toBeVisible();

  const row = register.locator('tbody tr', { hasText: PATIENT });
  await expect(row).toContainText('12 Nehru Street, Kadapa');
  await expect(row).toContainText('Alprax 0.25');
  await expect(row).toContainText('Dr Seed');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^h1-register-\d{4}-\d{2}-\d{2}-to-/);

  const path = await download.path();
  const csv = await (await import('node:fs/promises')).readFile(path, 'utf8');

  expect(csv).toContain('Date,Patient,Address,Drug,Strength,Quantity,Batch');
  expect(csv).toContain(PATIENT);
  expect(csv).toContain('12 Nehru Street');
  expect(csv).toContain('Dr Seed');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
});

test('a recall finds everyone who was given a batch', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/reports');

  const row = page.getByTestId('register').locator('tbody tr', { hasText: PATIENT });
  const batch = (await row.locator('td').nth(6).innerText()).trim();
  expect(batch.length).toBeGreaterThan(2);

  await page.getByRole('button', { name: 'Recall' }).click();
  await page.getByLabel('Batch number').fill(batch);
  await page.getByRole('button', { name: 'Trace' }).click();

  await expect(page.getByTestId('register')).toContainText(PATIENT);
});
