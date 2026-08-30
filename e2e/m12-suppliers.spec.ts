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

/**
 * Suppliers moved to the pharmacy with the shelf: the person who phones the
 * supplier is the person who keeps their number. The refusal that used to be
 * here was raised by Postgres, so this is paired with
 * supabase/migrations/20260830120000_pharmacy_owns_the_shelf.sql.
 */
test('the counter keeps the supplier list, because it does the phoning', async ({
  page,
}) => {
  await signIn(page, 'Counter');
  await page.goto('/suppliers');

  // level 1: the context pane carries an <h2 class="eyebrow">Suppliers</h2> as
  // well, and an unqualified name matches both.
  await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
  await expect(page.getByText('Only an administrator can manage suppliers.')).toHaveCount(0);
});

/**
 * And not to everybody signed in. The doctor is the proprietor and stands at
 * the pharmacy desk, so they REACH suppliers — and are then told, in a
 * sentence, that keeping the list is not their job. Being told beats being
 * redirected somewhere else without explanation.
 */
test('a doctor is told the supplier list is not theirs to keep', async ({ page }) => {
  await signIn(page, 'Dr Seed');
  await page.goto('/suppliers');

  await expect(
    page.getByText('Suppliers are kept by the pharmacy or an administrator.'),
  ).toBeVisible();
});