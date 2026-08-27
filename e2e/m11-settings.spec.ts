import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function reloaded(page: Page) {
  await page.reload();
  await expect(page.getByLabel('Clinic name')).toHaveValue('Seed Clinic');
}

async function signIn(page: Page, device: string, staffName: string) {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  for (const digit of '481920') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }),
  ).toBeVisible();
}

test('the details that print on a bill are typed once and kept', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  // Settings owns its own permission contract. Reaching it through a transient
  // queue shortcut made this test fail whenever the clinical workspace was
  // simplified, even though settings itself was unchanged.
  await page.goto('/settings');

  await page.getByLabel('Doctor registration number').fill('APMC-44321');
  await page.getByLabel('Drug licence number').fill('AP/KDP/20B/1234');
  await page.getByLabel('GSTIN').fill('37abcde1234f1z5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');

  await page.getByLabel('Phone').fill('+91 90000 12345');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await reloaded(page);
  await expect(page.getByLabel('Phone')).toHaveValue('+91 90000 12345');
  await expect(page.getByLabel('Drug licence number')).toHaveValue('AP/KDP/20B/1234');
  await expect(page.getByLabel('Doctor registration number')).toHaveValue('APMC-44321');
  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');
});

test('a GSTIN that is one character short is refused before it reaches a bill', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  await page.getByLabel('GSTIN').fill('37ABCDE1234F1Z');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/does not look like a GSTIN/)).toBeVisible();

  await reloaded(page);
  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');
});

test('a timetable nobody can read is refused, by day, rather than meaning "closed"', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  await page.getByLabel('Wednesday').fill('9:30 am - 1 pm');
  await page.getByRole('button', { name: 'Save' }).click();

  const refusal = page.getByText(/is not a time window/);
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('wed');
});

test('the hours the doctor keeps reach the public page', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
    await page.getByLabel(day).fill('00:00-23:59');
  }
  await page.getByLabel('Sunday').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await reloaded(page);
  await expect(page.getByLabel('Sunday')).toHaveValue('');
  await expect(page.getByLabel('Monday')).toHaveValue('00:00-23:59');

  await page.getByLabel('Sunday').fill('00:00-23:59');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
});

test('the counter cannot change the fee or the licence numbers', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/settings');

  await expect(page.getByText(/changed by the doctor or an administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});
