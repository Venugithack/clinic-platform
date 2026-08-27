import { expect, test } from '@playwright/test';

/** Browser half of first-run owner setup. Email delivery/verification is covered
 * outside Playwright; this suite checks the empty-clinic path and refuses to
 * fake a verified Supabase identity. */
test.describe.configure({ mode: 'serial' });

test('while setup state is loading, the page does not show a staff picker early', async ({ page }) => {
  await page.route('**/rest/v1/clinic_setup_state*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByText('Opening clinic sign-in…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who are you?' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Jayamurugan Clinic' })).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/rest/v1/clinic_setup_state*');
});

test('an empty clinic starts with administrator email OTP', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jayamurugan Clinic' })).toBeVisible();
  await expect(page.getByText(/6-digit one-time code/i)).toBeVisible();
  await expect(page.getByText(/device|registration code/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Set up as administrator' }).click();
  await expect(page.getByRole('heading', { name: 'Set up Jayamurugan Clinic' })).toBeVisible();
  await expect(page.getByLabel('Administrator email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send 6-digit code' })).toBeVisible();
});

test('first-run form cannot open without a verified email OTP session', async ({ page }) => {
  await page.goto('/enroll');
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.getByLabel('Administrator email')).toBeVisible();
});
