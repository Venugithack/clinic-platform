import { expect, test, type Page } from '@playwright/test';

/**
 * The M11b gate (PLAN.md §16, §18 Q10).
 *
 * `A7_settings.sql` proves the transition — the timetable validation, the
 * GSTIN shape, the audit row. What only a browser can prove is the thing this
 * screen was built to stop:
 *
 *   **saving one field must not blank the others.**
 *
 * A settings form that sends only what changed, against a transition that
 * treats an absent field as "clear it", is a screen where updating the phone
 * number silently removes the drug licence from every bill printed afterwards.
 * Nobody notices for a month. So the test changes one thing and then asserts
 * everything else survived a reload.
 *
 * Serial: it edits the one singleton row the whole suite shares, and puts it
 * back at the end.
 */
test.describe.configure({ mode: 'serial' });

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
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByLabel('Doctor registration number').fill('APMC-44321');
  await page.getByLabel('Drug licence number').fill('AP/KDP/20B/1234');
  await page.getByLabel('GSTIN').fill('37abcde1234f1z5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  // Upper-cased by the database, not by the screen — it is what goes on a bill.
  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');

  // Now change ONE unrelated field, exactly as somebody would in month two.
  await page.getByLabel('Phone').fill('+91 90000 12345');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Phone')).toHaveValue('+91 90000 12345');
  await expect(page.getByLabel('Drug licence number')).toHaveValue('AP/KDP/20B/1234');
  await expect(page.getByLabel('Doctor registration number')).toHaveValue('APMC-44321');
  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');
});

test('a GSTIN that is one character short is refused before it reaches a bill', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  await page.getByLabel('GSTIN').fill('37ABCDE1234F1Z');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/does not look like a GSTIN/)).toBeVisible();

  // And the refusal did not take the rest of the form with it.
  await page.reload();
  await expect(page.getByLabel('GSTIN')).toHaveValue('37ABCDE1234F1Z5');
});

test('a timetable nobody can read is refused, by day, rather than meaning "closed"', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  // The exact way a person writes it, and the exact reason this validation
  // exists: app.clinic_is_open would read this as "shut on Wednesday, forever"
  // and the only screen that shows it is the one for patients.
  await page.getByLabel('Wednesday').fill('9:30 am - 1 pm');
  await page.getByRole('button', { name: 'Save' }).click();

  const refusal = page.getByText(/is not a time window/);
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('wed');
});

test('the hours the doctor keeps reach the public page', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/settings');

  // Two sittings a day, six days, closed Sunday. Written the way he says it.
  for (const day of [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ]) {
    await page.getByLabel(day).fill('00:00-23:59');
  }
  await page.getByLabel('Sunday').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Sunday')).toHaveValue('');
  await expect(page.getByLabel('Monday')).toHaveValue('00:00-23:59');

  // Put the seed back: the rest of the suite runs against a clinic that is
  // open every day, deliberately, so the presence tests do not depend on the
  // time of day they run at (BUILD.md §13).
  await page.getByLabel('Sunday').fill('00:00-23:59');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
});

test('the counter cannot change the fee or the licence numbers', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/settings');

  await expect(
    page.getByText(/changed by the doctor or an administrator/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});
