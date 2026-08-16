import { expect, test } from '@playwright/test';

/**
 * Tablet viewport only, with touch. TABLET.md §8.
 *
 * These run at 1280x800 because that is the device the pharmacist is holding.
 * A suite that passes at desktop width tells you nothing about a 10" screen on
 * a stand — and emulation still does not catch keyboard overlap or camera
 * permissions, which is why both tablets are tested on the clinic's own Wi-Fi
 * before go-live regardless of what this file says.
 */

test.describe('lock screen', () => {
  test('an unregistered tablet says so, and says what to do', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'This tablet is not registered' }),
    ).toBeVisible();
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
    // PLAN.md §5.2: the clinic must never be shown a failed request as a
    // mystery. Free tiers have no SLA (HOSTING.md §9), so this is a state the
    // staff will genuinely see one day.
    await page.route('**/rest/v1/**', (route) => route.abort());
    await page.goto('/');

    // lib/db bounds every request at 12s, so this is the worst case the staff
    // wait before being told something rather than nothing.
    await expect(page.getByText('Cannot reach the clinic database.')).toBeVisible({
      timeout: 20_000,
    });
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

    // The runtime companion to the tablet/min-touch-target lint rule: lint sees
    // the class names, this sees what the browser actually laid out.
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
    await expect(page.getByRole('heading', { name: 'Clinic status' })).toBeVisible();

    await page.goto('/p');
    await expect(page.getByRole('heading', { name: 'Your visit' })).toBeVisible();
  });
});
