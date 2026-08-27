import { expect, test } from '@playwright/test';

test.describe('lock screen', () => {
  test('an untrusted device sends the owner to email access', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trust this device' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with email' })).toBeVisible();
    await expect(page.getByLabel('Registration code')).toHaveCount(0);
  });

  test('a registered tablet offers the staff who can unlock it', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('clinic.deviceToken', 'seed-device-cabin');
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Who is this?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dr Seed' })).toBeVisible();
  });

  test('an unreachable database is a sentence, not a stack trace', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('clinic.deviceToken', 'seed-device-cabin');
    });
    await page.route('**/rest/v1/**', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByText('Cannot reach the clinic database.')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('tablet layout rules', () => {
  test('the page never scrolls horizontally at 1280x800', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every interactive element clears the 44px touch target', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('clinic.deviceToken', 'e2e-device');
    });
    await page.goto('/');
    const undersized = await page.evaluate(() => {
      const selector = 'button, a, input, select, textarea, [role="button"]';
      return Array.from(document.querySelectorAll(selector))
        .map((el) => {
          const box = el.getBoundingClientRect();
          return { text: el.textContent?.trim() ?? '', h: box.height, w: box.width };
        })
        .filter((box) => box.h > 0 && (box.h < 44 || box.w < 44));
    });
    expect(undersized).toEqual([]);
  });
});

test.describe('public surfaces', () => {
  test('the status page and the patient portal render', async ({ page }) => {
    await page.goto('/now');
    await expect(page.getByTestId('status')).toBeVisible();
    await expect(page.getByTestId('as-of')).toBeVisible();
    await page.goto('/p');
    await expect(page.getByRole('heading', { name: 'Your visit' })).toBeVisible();
  });
});
