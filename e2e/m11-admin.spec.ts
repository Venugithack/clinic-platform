import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/session';

test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const PHARMACIST = `E2E Pharmacist ${STAMP}`;

async function typePin(page: Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test('admin can add pharmacy staff who can then sign in from another browser', async ({ browser }) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'Admin');
  await page.goto('/admin');

  // The rail's button opens the form; the form's own button submits it. Both
  // say "Add staff", so each one is addressed by where it lives rather than
  // by .first()/.last() — the rail is the last <aside> in the document, so
  // .last() was reaching back up and re-opening the form, which clears the
  // PIN boxes and leaves the submit disabled.
  await page.getByRole('complementary').getByRole('button', { name: 'Add staff' }).click();
  await page.getByLabel('Name', { exact: true }).fill(PHARMACIST);
  await page.getByLabel('Phone').fill('+91 90000 00009');
  await page.getByRole('button', { name: /Pharmacy \/ Counter/ }).click();
  await page.getByLabel('PIN', { exact: true }).fill('246810');
  await page.getByLabel('Confirm PIN').fill('246810');
  await page.getByRole('main').getByRole('button', { name: 'Add staff', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('ready to sign in');

  const counter = await browser.newContext();
  const theirs = await counter.newPage();
  await theirs.goto('/');
  await expect(theirs.getByRole('button', { name: new RegExp(PHARMACIST) })).toBeVisible();
  await theirs.getByRole('button', { name: new RegExp(PHARMACIST) }).click();
  await typePin(theirs, '246810');
  await theirs.getByRole('button', { name: 'Open the counter' }).click();
  await expect(theirs).toHaveURL(/\/counter$/);

  await admin.close();
  await counter.close();
});

test('admin can reset a PIN and the replacement PIN works', async ({ browser }) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'Admin');
  await page.goto('/admin');

  const row = page.getByRole('listitem').filter({ hasText: PHARMACIST });
  await row.getByRole('button', { name: 'Reset PIN' }).click();
  await page.getByLabel('PIN', { exact: true }).fill('135790');
  await page.getByLabel('Confirm PIN').fill('135790');
  await page.getByRole('button', { name: 'Set new PIN' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('PIN was changed');

  const counter = await browser.newContext();
  const theirs = await counter.newPage();
  await theirs.goto('/');
  await theirs.getByRole('button', { name: new RegExp(PHARMACIST) }).click();
  await typePin(theirs, '135790');
  await theirs.getByRole('button', { name: 'Open the counter' }).click();
  await expect(theirs).toHaveURL(/\/counter$/);

  await admin.close();
  await counter.close();
});

test('deactivated staff disappear from the public sign-in list', async ({ browser }) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'Admin');
  await page.goto('/admin');

  const row = page.getByRole('listitem').filter({ hasText: PHARMACIST });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('can no longer sign in');

  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.goto('/');
  await expect(theirs.getByRole('button', { name: new RegExp(PHARMACIST) })).toHaveCount(0);

  await admin.close();
  await other.close();
});

test('counter cannot change staff or PINs', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/admin');
  await expect(page.getByText(/Only the administrator/)).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Add staff' })).toBeDisabled();
});
