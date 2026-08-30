import { expect, test } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

test('admin adds a medicine and configures its reorder threshold', async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E Med ${stamp}`;

  await signInAndOpen(page, 'Admin');
  await page.getByRole('button', { name: /Medicines/ }).first().click();

  await expect(page.getByRole('heading', { name: 'Medicines', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add medicine' }).click();
  await page.getByLabel('Medicine name').fill(name);
  await page.getByLabel('Generic name').fill('Paracetamol');
  await page.getByLabel('Salt composition').fill('Paracetamol');
  await page.getByLabel('Strength').fill('650mg');
  await page.getByLabel('Dosage form').fill('tablet');
  await page.getByLabel('Base unit').selectOption('tablet');
  await page.getByLabel('Default units per strip').fill('10');
  await page.getByLabel('Default strips per box').fill('10');
  await page.getByLabel('Low-stock threshold').fill('50');
  await page.getByLabel('Reorder quantity').fill('300');
  await page.getByRole('button', { name: 'Save medicine' }).click();

  await expect(page.getByText(`${name} saved.`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${name} · 650mg`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('50 tablets', { exact: true })).toBeVisible();
  await expect(page.getByText('300 tablets', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit settings' }).click();
  await page.getByLabel('Low-stock threshold').fill('40');
  await page.getByLabel('Reorder quantity').fill('240');
  await page.getByRole('button', { name: 'Save medicine' }).click();
  await expect(page.getByText(`${name} saved.`, { exact: true })).toBeVisible();
  await expect(page.getByText('40 tablets', { exact: true })).toBeVisible();
  await expect(page.getByText('240 tablets', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText(`${name} is inactive. Existing prescriptions, stock history and bills are unchanged.`, { exact: true })).toBeVisible();
  await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
});

/**
 * The dead end this rework exists to remove, kept as the assertion that it is
 * gone.
 *
 * A delivery arrives containing a medicine the clinic has never stocked. The
 * pharmacist opened Add stock, could not find it, and could not add it either —
 * this screen refused them with "Only an administrator can manage the medicine
 * master." The boxes sat on the counter until somebody reached the owner, who
 * was not holding the strip and could not read the salt off it.
 *
 * See supabase/migrations/20260830120000_pharmacy_owns_the_shelf.sql, which is
 * the half of this a screen change could not do: the refusal was raised by
 * Postgres, so opening the UI alone would have produced a form that failed on
 * save.
 */
test('the counter keeps the medicine master, because it is holding the box', async ({
  page,
}) => {
  await signIn(page, 'Counter');
  await page.goto('/medicines');

  await expect(page.getByRole('heading', { name: 'Medicines' })).toBeVisible();
  await expect(page.getByText('Only an administrator can manage the medicine master.'))
    .toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add medicine' }).first()).toBeVisible();
});
