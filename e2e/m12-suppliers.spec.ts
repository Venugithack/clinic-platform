import { expect, test } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

test('admin can add a WhatsApp supplier, link a medicine and stop using the supplier', async ({ page }) => {
  const supplier = `E2E Supplier ${Date.now()}`;

  await signInAndOpen(page, 'Admin');
  await page.getByRole('button', { name: /^Suppliers/ }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByLabel('Supplier name').fill(supplier);
  await page.getByLabel('Contact person').fill('Ravi');
  await page.getByLabel('WhatsApp number').fill('+919876543210');
  await page.getByLabel('Lead time days').fill('2');
  await page.getByLabel('Return window days').fill('120');
  await page.getByLabel('Payment terms').fill('30 days');
  await page.getByRole('button', { name: 'Save supplier' }).click();

  await expect(page.getByRole('status')).toContainText(`${supplier} saved`);
  await expect(page.getByText('+919876543210').first()).toBeVisible();

  await page.getByLabel('Medicine to link').selectOption({ label: 'Dolo 650 · 650mg' });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dolo 650 linked');
  await expect(page.getByText('Dolo 650', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make preferred' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Stop using' }).click();
  await expect(page.getByRole('status')).toContainText('inactive');
  await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
});

test('non-admin staff cannot manage supplier configuration', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/suppliers');
  await expect(page.getByText('Only an administrator can manage suppliers.')).toBeVisible();
});
