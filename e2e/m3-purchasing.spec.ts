import { expect, test, type Page } from '@playwright/test';

/**
 * Goods receipt and reordering — the two ends of the purchasing loop
 * (INVENTORY.md §1, §2, §8; TABLET.md §7).
 *
 * They live in one file because the second depends on the first having
 * happened: a purchase price only exists once something has actually been
 * bought, and "₹1.60 last time from Kumar" on a reorder line is the payoff for
 * having typed the receipt properly. Testing them apart would either fake the
 * history or assert nothing.
 *
 * Serial, and in this order.
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

/** Tap a number into whichever field is active on the receiving screen. */
async function type(page: Page, label: string, digits: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  for (const digit of digits) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test('a mistyped expiry year is refused at the door', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/receiving');

  await page.getByRole('button', { name: 'Kumar Distributors' }).click();
  await page.getByLabel('Invoice number').fill('INV-E2E-BAD');

  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Search medicines').fill('Calpol');
  await page.getByRole('button', { name: /Calpol 650/ }).click();

  await page.getByLabel('Batch number').fill('CP2599X');

  // Last year, which is exactly the typo: 2026 typed where 2028 was printed.
  // FEFO would then hand this batch out first for the rest of its life, or
  // refuse to hand it out at all — and nobody would know why.
  const lastYear = String(new Date().getFullYear() - 1);
  await page.getByRole('button', { name: 'Mar', exact: true }).click();
  await page.getByRole('button', { name: lastYear, exact: true }).click();

  await type(page, 'Strips', '5');
  await type(page, 'MRP per strip', '3200');
  await type(page, 'Rate per strip', '2400');

  await page.getByRole('button', { name: 'Add to receipt' }).click();
  await page.getByRole('button', { name: 'Post receipt' }).click();

  // The refusal names the batch, the drug and the date, and nothing was written.
  await expect(page.getByText(/that is in the past/)).toBeVisible();
});

test('the invoice is in strips, and the ledger is in tablets', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/receiving');

  await page.getByRole('button', { name: 'Kumar Distributors' }).click();
  await page.getByLabel('Invoice number').fill(`INV-E2E-${Date.now()}`);

  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Search medicines').fill('Calpol');
  await page.getByRole('button', { name: /Calpol 650/ }).click();

  await page.getByLabel('Batch number').fill(`CP${Date.now().toString().slice(-6)}`);
  await page.getByRole('button', { name: 'Mar', exact: true }).click();
  await page.getByRole('button', { name: String(new Date().getFullYear() + 2), exact: true })
    .click();

  // Five strips at ₹24.00 each, MRP ₹32.00. Calpol is 15 to a strip, so this is
  // 75 tablets at ₹1.60 — the one conversion, made once, inside the transition.
  await type(page, 'Strips', '5');
  await type(page, 'MRP per strip', '3200');
  await type(page, 'Rate per strip', '2400');

  await expect(page.getByText(/75 base units in · ₹1\.6000 each/)).toBeVisible();

  await page.getByRole('button', { name: 'Add to receipt' }).click();
  await expect(page.getByText(/75 tablets/)).toBeVisible();

  await page.getByRole('button', { name: 'Post receipt' }).click();
  await expect(page.getByText(/1 batch on the shelf, ₹120\.00 at cost/)).toBeVisible();
});

test('the reorder screen shows its working, and orders nothing by itself', async ({
  page,
}) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/reorder');

  const calpol = page.getByTestId('reorder-Calpol 650');
  await expect(calpol).toBeVisible();

  // The working, on the line: where the lead time came from, and what the
  // suggestion is built on. A proposed quantity with no working shown is one
  // the doctor either rubber-stamps or ignores.
  await expect(calpol).toContainText(/day lead \(the supplier.s own claim\)/);
  await expect(calpol).toContainText('no movement recorded yet');

  // And the price paid last time, from the receipt above — the number he needs
  // at the moment he can act on it.
  await expect(calpol).toContainText('₹1.60 Kumar Distributors');

  // The quantity is a proposal and it is editable.
  await calpol.getByRole('button', { name: '450' }).click();
  for (const digit of '600') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Set quantity' }).click();
  await expect(calpol.getByRole('button', { name: '600' })).toBeVisible();

  await page.getByRole('button', { name: /^Draft \d+ orders?$/ }).click();

  // Drafts, and the screen says so plainly. Nothing here can reach a supplier:
  // sending is still a separate deliberate step on Purchase orders.
  await expect(page.getByText(/draft orders? saved/)).toBeVisible();
  await expect(page.getByText(/Open Purchase orders to review the draft/)).toBeVisible();

  // Refresh after the draft: the same medicine stays visible for context but
  // cannot be ordered twice, and there is a direct route to the existing PO.
  await expect(calpol).toContainText(/Already on order:/);
  await expect(calpol.getByRole('button', { name: /Order quantity for Calpol 650/ })).toBeDisabled();
  await expect(calpol.getByRole('button', { name: /View purchase orders for Calpol 650/ })).toBeVisible();
});