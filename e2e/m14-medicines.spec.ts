import { expect, test, type Page } from '@playwright/test';

const PIN = '481920';

async function signIn(page: Page, device: string, staffName: string) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  for (const digit of PIN) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }),
  ).toBeVisible();
}

test('admin adds a medicine and configures its reorder threshold', async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E Med ${stamp}`;

  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
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

  await expect(page.getByRole('status')).toContainText(`${name} saved`);
  await expect(page.getByText(`${name} · 650mg`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('50 tablets', { exact: true })).toBeVisible();
  await expect(page.getByText('300 tablets', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit settings' }).click();
  await page.getByLabel('Low-stock threshold').fill('40');
  await page.getByLabel('Reorder quantity').fill('240');
  await page.getByRole('button', { name: 'Save medicine' }).click();
  await expect(page.getByRole('status')).toContainText(`${name} saved`);
  await expect(page.getByText('40 tablets', { exact: true })).toBeVisible();
  await expect(page.getByText('240 tablets', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('status')).toContainText('inactive');
  await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
});

test('counter cannot manage the medicine master', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/medicines');
  await expect(page.getByText('Only an administrator can manage the medicine master.'))
    .toBeVisible();
});
