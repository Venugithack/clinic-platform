import { expect, test } from '@playwright/test';

test.describe('staff sign-in', () => {
  test('the clinic URL directly offers staff without device registration', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Who are you?' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Dr Seed.*Doctor/i })).toBeVisible();
    await expect(page.getByText(/trusted device/i)).toHaveCount(0);
  });

  test('choosing a staff member asks only for their PIN', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Dr Seed.*Doctor/i }).click();
    await expect(page.getByRole('heading', { name: 'Dr Seed' })).toBeVisible();
    await expect(page.getByText('Enter your 6-digit PIN')).toBeVisible();
  });

  test('the administrator OTP entry point remains separate from daily PIN sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Administrator email OTP' })).toBeVisible();
    await page.getByRole('button', { name: 'Administrator email OTP' }).click();
    await expect(page.getByRole('heading', { name: 'Open the control panel' })).toBeVisible();
    await expect(page.getByLabel('Administrator email')).toBeVisible();
  });

  test('an unreachable database is a sentence, not a stack trace', async ({ page }) => {
    await page.route('**/rest/v1/**', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByText(/clinic database|could not reach|failed to fetch/i)).toBeVisible({ timeout: 20_000 });
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
