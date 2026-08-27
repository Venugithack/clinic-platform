import { expect, test, type Page } from '@playwright/test';

const DEVICE = 'seed-device-cabin';
const PIN = '481920';

async function signIn(page: Page, staffName: string, deviceToken = DEVICE) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', deviceToken] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  for (const digit of PIN) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }))
    .toBeVisible();
}

test('admin can add a WhatsApp supplier, link a medicine and stop using the supplier', async ({
  page,
}) => {
  const supplier = `E2E Supplier ${Date.now()}`;

  await signIn(page, 'Admin');
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: 'Suppliers', exact: true }).click();
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

  // Link as an alternative only. Preferred-supplier switching is covered by
  // pgTAP because changing it affects the reorder engine; this browser test
  // deliberately leaves the seeded purchasing configuration untouched.
  await page.getByLabel('Medicine to link').selectOption({ label: 'Dolo 650 · 650mg' });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dolo 650 linked');
  await expect(page.getByText('Dolo 650', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make preferred' }).first()).toBeVisible();

  // "Remove supplier" in this clinic means stop using it, not destroy the
  // historical supplier row referenced by old orders and stock receipts.
  await page.getByRole('button', { name: 'Stop using' }).click();
  await expect(page.getByRole('status')).toContainText('inactive');
  await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
});

test('non-admin staff cannot manage supplier configuration', async ({ page }) => {
  // Use the counter tablet because a pharmacy staff member is the role most
  // likely to know supplier details but is not allowed to rewrite purchasing
  // configuration in this build.
  await signIn(page, 'Counter', 'seed-device-counter');
  await page.goto('/suppliers');
  await expect(page.getByText('Only an administrator can manage suppliers.')).toBeVisible();
});
