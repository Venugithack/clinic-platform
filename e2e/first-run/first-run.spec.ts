import { expect, test } from '@playwright/test';

/**
 * Browser half of first-run email ownership. The database transition itself is
 * covered by pgTAP because local CI deliberately does not fake delivery of a
 * Supabase magic-link email.
 */
test.describe.configure({ mode: 'serial' });

test('while setup state is loading, the tablet waits instead of showing the wrong path', async ({ page }) => {
  await page.route('**/rest/v1/clinic_setup_state*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Just a moment' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trust this device' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Set up clinic with email' })).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/rest/v1/clinic_setup_state*');
});

test('an empty clinic starts with owner email, not a registration code', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up clinic with email' })).toBeVisible();
  await expect(page.getByLabel('Registration code')).toHaveCount(0);

  await page.getByRole('button', { name: 'Set up with email' }).click();
  await expect(page.getByRole('heading', { name: 'Continue with email' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByText(/daily clinic use goes back to name \+ 6-digit PIN/i)).toBeVisible();
});

test('enrollment cannot proceed without a verified email session', async ({ page }) => {
  await page.goto('/enroll');
  await expect(page.getByRole('heading', { name: 'Open the link from your email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send another link' })).toBeVisible();
});
