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

test('admin opens one control center for setup, go-live data and back-office work', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Administration', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Clinic control center', level: 1 }))
    .toBeVisible();

  await expect(page.getByRole('button', { name: 'People & tablets', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Import medicine master/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Opening stock/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suppliers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Low stock & reorder/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Purchase orders/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Receiving/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clinic settings', exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: /Printing/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'People & tablets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People and devices', level: 1 }))
    .toBeVisible();
});

test('counter staff cannot use the admin control center', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/admin/home');
  await expect(page.getByText('Only an administrator can open the clinic control center.'))
    .toBeVisible();
});
