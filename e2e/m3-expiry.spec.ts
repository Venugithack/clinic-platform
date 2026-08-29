import { expect, test } from '@playwright/test';
import { signIn } from './support/session';

/**
 * Expiry, worked all the way through (INVENTORY.md §6).
 *
 * The claim under test is the commercial one: the date that decides whether
 * stock can go back to the supplier is months before the expiry date, differs
 * per supplier, and passes while the stock still looks perfectly good. A screen
 * that lists batches by expiry date finds out too late every time.
 *
 * Two of these tests exist only to watch a refusal reach the pharmacist as a
 * sentence. That is the lesson from the PostgREST `PT` bug in BUILD.md §8: for
 * three milestones every refusal in this build was invisible, because no
 * browser test had ever exercised one.
 *
 * Serial, and deliberately so — these move real stock, and they expect the
 * development seed as `pnpm test` leaves it: the pgTAP run reseeds immediately
 * before Playwright starts. A batch returned once cannot be returned again.
 */
test.describe.configure({ mode: 'serial' });

test('the list is ordered by the supplier deadline, not the expiry date', async ({
  page,
}) => {
  await signIn(page, 'Counter');
  await page.goto('/expiry');

  // Shelcal expires in about seven months and Zincovit in six weeks, so an
  // expiry-ordered list would put Zincovit first. Kumar wants stock back 180
  // days early, which makes Shelcal the one with weeks left to act and Zincovit
  // the one where nothing can be done any more.
  const shelcal = page.getByRole('button', { name: /Shelcal 500/ });
  const zincovit = page.getByRole('button', { name: /Zincovit/ });

  await expect(shelcal).toContainText('Return by');
  await expect(shelcal).toContainText('days left');
  await expect(zincovit).toContainText('Window closed');

  const rows = await page.locator('ul > li').allInnerTexts();
  const shelcalRow = rows.findIndex((text) => text.includes('Shelcal 500'));
  const zincovitRow = rows.findIndex((text) => text.includes('Zincovit'));
  expect(shelcalRow).toBeGreaterThanOrEqual(0);
  expect(shelcalRow).toBeLessThan(zincovitRow);
});

test('a return after the window shut is refused, with the date it shut', async ({
  page,
}) => {
  await signIn(page, 'Counter');
  await page.goto('/expiry');

  await page.getByRole('button', { name: /Zincovit/ }).click();
  await page.getByRole('button', { name: /^Return to/ }).click();

  // The screen already said "Window closed". The refusal is still the
  // database's to make, and it names the date and what to do instead.
  await expect(page.getByText(/return window for batch .* closed on/)).toBeVisible();
});

test('good stock cannot be written off as expired', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/expiry');

  // Zincovit is six weeks from expiry and cannot go back to Kumar, so the
  // tempting move is to write it off and stop thinking about it. It is still
  // perfectly sellable stock, and this refusal is the difference between a
  // ₹810 loss and six weeks of sales.
  await page.getByRole('button', { name: /Zincovit/ }).click();
  await page.getByRole('button', { name: 'Write off' }).click();

  await expect(page.getByText(/has not expired yet/)).toBeVisible();
});

test('a return moves stock through the ledger and opens a credit', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/expiry');

  await page.getByRole('button', { name: /Shelcal 500/ }).click();
  await page.getByRole('button', { name: 'Return to Kumar Distributors' }).click();

  // 300 units at ₹6.20 cost. Valued at cost, because it is a credit and not a
  // sale — a return note priced at MRP is a claim no supplier pays.
  await expect(page.getByText(/₹1860\.00 credit opened/)).toBeVisible();

  // And it is on the list of what the supplier owes, ageing from today.
  await expect(
    page.getByRole('button', { name: /Kumar Distributors.*₹1860\.00/ }),
  ).toBeVisible();
});

test('expired stock is on exactly one screen, and it is this one', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/expiry');

  // Betadine expired six weeks ago. available_stock excludes it by design, so
  // the counter cannot sell it and no other screen can see it either.
  const betadine = page.getByRole('button', { name: /Betadine/ });
  await expect(betadine).toContainText('expired');

  await betadine.click();
  await page.getByRole('button', { name: 'Write off' }).click();

  // 12 pieces at ₹92 cost. The doctor is told what it cost him, which is the
  // only part of a write-off that teaches anybody anything.
  await expect(page.getByText(/₹1104\.00 at cost/)).toBeVisible();
  await expect(page.getByText('Nothing expired on the shelf.')).toBeVisible();
});
