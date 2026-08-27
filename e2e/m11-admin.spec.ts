import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const PHARMACIST = `E2E Pharmacist ${STAMP}`;

async function typePin(page: Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

async function signIn(page: Page, device: string, staffName: string, pin = '481920') {
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', device] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: staffName, exact: true }).click();
  await typePin(page, pin);
  await expect(page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) })).toBeVisible();
}

test('somebody added here can sign in, and somebody marked as left cannot', async ({ browser }) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await page.getByRole('button', { name: 'Add someone' }).click();
  await page.getByLabel('Name', { exact: true }).fill(PHARMACIST);
  await page.getByLabel('Phone').fill('+91 90000 00009');
  await typePin(page, '246810');
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('can sign in with their PIN');

  const counter = await browser.newContext();
  const theirs = await counter.newPage();
  await signIn(theirs, 'seed-device-counter', PHARMACIST, '246810');

  await page.getByRole('button', { name: `Mark ${PHARMACIST} as left` }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('marked as no longer here');

  const after = await browser.newContext();
  const gone = await after.newPage();
  await gone.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ['clinic.deviceToken', 'seed-device-counter'] as const,
  );
  await gone.goto('/');
  await expect(gone.getByRole('button', { name: PHARMACIST, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Bring ${PHARMACIST} back` })).toBeVisible();

  await admin.close();
  await counter.close();
  await after.close();
});

test('the last administrator cannot switch themselves off', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Mark Admin as left' }).click();
  await expect(page.getByText(/only administrator left/)).toBeVisible();
  await expect(page.getByText(/make somebody else an admin first/)).toBeVisible();
});

test('admin configures owner email and no registration code is generated', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: 'No registration code anymore' })).toBeVisible();
  await expect(page.getByText(/Continue with email/)).toBeVisible();
  await expect(page.getByLabel('Tablet name')).toHaveCount(0);
  await expect(page.getByTestId('registration-code')).toHaveCount(0);

  await page.getByRole('button', { name: 'Email access for Admin' }).click();
  const input = page.getByLabel('Email for Admin');
  await input.fill('admin-e2e@example.com');
  await page.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('can use admin-e2e@example.com');
  await expect(
    page.getByText(/admin · PIN set .* · admin-e2e@example\.com/),
  ).toBeVisible();

  // Leave the shared seeded database as we found it for parallel specs.
  await page.getByRole('button', { name: 'Email access for Admin' }).click();
  await page.getByLabel('Email for Admin').fill('');
  await page.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByTestId('admin-notice')).toContainText('Email access removed');
});

test('the tablet in your hands is not the one you revoke', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Admin');
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Revoke Cabin tablet' }).click();
  await expect(page.getByText(/that is the tablet you are using/)).toBeVisible();
});

test('the counter cannot change staff, email access or trusted devices', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/admin');
  await expect(page.getByText(/Only an administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add someone' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Email access for Admin' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Revoke Cabin tablet' })).toBeDisabled();
});
