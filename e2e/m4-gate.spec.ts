import { expect, test, type Page } from '@playwright/test';

/**
 * The M4 gate (BUILD.md §2, PLAN.md §8).
 *
 *   "A bill prints correctly for a consult plus 4 medicines across 2 batches;
 *    the day's total matches the sum of its bills; the till reconciles against
 *    counted cash."
 *
 * All three, in one run, through the screens rather than the database — because
 * the two failure modes this milestone actually has are a bill that prints the
 * wrong number and a drawer nobody counted, and neither shows up in SQL.
 *
 * Serial: it opens a till, and there can only be one.
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

async function tap(page: Page, digits: string) {
  for (const digit of digits) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

/** A counter sale, which is the quickest way to get unbilled medicine. */
async function sell(page: Page, items: Array<[drug: string, chip: string]>) {
  await page.goto('/counter/sale');

  for (const [drug, chip] of items) {
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel('Search medicines').fill(drug);
    await page.getByRole('button', { name: new RegExp(drug) }).click();

    const qtypad = page.getByTestId('qtypad');
    await qtypad.getByRole('button', { name: chip, exact: true }).click();
    await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  }

  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/The ledger has been written/)).toBeVisible();
}

test('cash cannot be taken into a drawer nobody has opened', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');

  await sell(page, [['Cetzine', '1 strip']]);

  await page.goto('/billing');
  await page.getByRole('button', { name: /Counter sale/ }).first().click();
  await page.getByRole('button', { name: 'Raise bill' }).click();

  await expect(page.getByText(/₹44\.00/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Cash', exact: true }).click();

  // The refusal is the database's, and it says what to do about it.
  await expect(page.getByText(/no till is open/i)).toBeVisible();

  // Card is unaffected — it never touches the drawer.
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  await expect(page.getByText(/settled — ₹44\.00 by card/)).toBeVisible();
});

/**
 * Found by M11e, in a run of the whole suite rather than this file alone: the
 * refusal above is real, and it could be erased before anybody read it.
 *
 * Raising a bill fires a background refresh. That refresh used to clear the
 * error on completion — so a refusal raised while it was still in flight
 * vanished the moment it landed, leaving a screen that had simply not done
 * what the pharmacist asked. Under load the window was wide enough to fail the
 * test; at a counter it is wide enough to make somebody tap Cash twice.
 *
 * The rule now is that a read clears the error when it STARTS, never when it
 * finishes: a read landing says nothing about whether the last write worked.
 */
test('a refusal is not erased by a refresh landing behind it', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await sell(page, [['Cetzine', '1 strip']]);
  await page.goto('/billing');

  // Hold the refresh open. Its first read is the clinic settings, and the rest
  // of it is sequential behind that one.
  await page.route('**/rest/v1/clinic?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.getByRole('button', { name: /Counter sale/ }).first().click();
  await page.getByRole('button', { name: 'Raise bill' }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();

  const refusal = page.getByText(/no till is open/i);
  await expect(refusal).toBeVisible();

  // The held read lands a second and a half in, and the three behind it follow.
  // A fixed wait is the right tool here: the assertion is that something does
  // NOT happen, and there is no event to wait for when it works.
  await page.waitForTimeout(3000);
  await expect(refusal).toBeVisible();
});

test('a bill for a consult and medicines across two batches, and it prints', async ({
  page,
}) => {
  await signIn(page, 'seed-device-counter', 'Counter');

  // Four medicines. Dolo seeds as two batches — DL2503B (10 to a strip, MRP
  // 24.00, expiring first) and DL2411A (15 to a strip, MRP 34.50) — so FEFO
  // decides which one this comes out of, and the bill copies one line per batch
  // the dispense actually drew from.
  await sell(page, [
    ['Dolo 650', '1 strip'],
    ['Cetzine', '1 strip'],
    ['Pan 40', '10'],
    ['Azithral 500', '1 strip'],
  ]);

  await page.goto('/billing');
  await page.getByRole('button', { name: 'Open till' }).click();
  await tap(page, '200000'); // ₹2,000 float
  await page.getByRole('button', { name: 'Open with this float' }).click();
  await expect(page.getByText('Till open. Cash can be taken.')).toBeVisible();

  // Read the medicines total off the worklist rather than hard-coding it: how
  // much four strips cost depends on which batches FEFO reached for, and this
  // test is about the bill, not about the shelf.
  const sale = page.getByRole('button', { name: /Counter sale/ }).first();
  const medicines = Number((await sale.innerText()).match(/₹([\d.]+)/)?.[1] ?? 0);
  expect(medicines).toBeGreaterThan(0);
  await sale.click();

  // A counter sale carries no consultation by default; this one is billed with
  // one, which is the "consult plus medicines" case in the gate.
  await page.getByRole('button', { name: /Add the consultation/ }).click();
  await page.getByRole('button', { name: 'Raise bill' }).click();

  // ₹300 consult + the medicines, rounded DOWN to the rupee.
  const total = `₹${Math.floor(medicines + 300).toFixed(2)}`;
  await expect(page.getByText(total).first()).toBeVisible();

  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(
    page.getByText(new RegExp(`settled — ${total.replace('.', '\\.')} by cash`)),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Print' }).click();
  await expect(page).toHaveURL(/\/bill\/[0-9a-f-]+\/print$/);

  // The printed sheet: the total, and the batch traceability §15.2 needs.
  await expect(page.getByTestId('bill-total')).toHaveText(total);
  await expect(page.getByText('Consultation').first()).toBeVisible();
  // Whichever element carries it: A4 gives the batch its own column, the roll
  // wraps it under the description. Both must SHOW it — a bill without batch
  // numbers is the one document in a recall chain that breaks it.
  await expect(
    page.getByText(/DL\d+[A-Z]/).filter({ visible: true }).first(),
  ).toBeVisible();

  // Both paper sizes are the same document, not a cut-down one.
  await page.getByRole('button', { name: '80mm roll' }).click();
  await expect(page.getByTestId('bill-total')).toHaveText(total);
  await expect(
    page.getByText(/DL\d+[A-Z]/).filter({ visible: true }).first(),
  ).toBeVisible();
});

test('the day total matches its bills, and the till reconciles against a count', async ({
  page,
}) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/day-book');

  // Part one: arithmetic. The day-book is derived from the bills, so this is a
  // guard against a view that quietly stops agreeing with them.
  const dayTotal = await page.getByTestId('day-total').innerText();

  await page.goto('/billing');
  const billRows = page.getByRole('button', { name: /\d{4}-\d{2}\/\d{5}/ });
  await expect(billRows.first()).toBeVisible();

  const billed = (await billRows.allInnerTexts())
    .filter((text) => !/cancelled/.test(text))
    .map((text) => Number(text.match(/₹([\d.]+)\s*$/)?.[1] ?? 0))
    .reduce((sum, value) => sum + value, 0);
  expect(billed).toBeGreaterThan(0);

  expect(Number(dayTotal.replace('₹', ''))).toBeCloseTo(billed, 2);

  // Part two: physical. Petty cash out of the drawer, then a count that is
  // deliberately short — and the short drawer is recorded as a short drawer.
  await page.goto('/day-book');
  await page.getByRole('button', { name: 'Cash out' }).click();
  await tap(page, '15000'); // ₹150
  await page.getByLabel('Reason').fill('courier');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText(/Taken from the drawer: ₹150\.00/)).toBeVisible();

  // What the drawer should hold: float, plus the cash it took, less the payout.
  // Read it rather than recompute it — then count ten rupees less than that, so
  // the assertion is about the variance and not about the arithmetic.
  //
  // Re-loaded first, deliberately: the payout above triggers a refresh whose
  // fetches land after its confirmation appears, so reading the table straight
  // away can catch the figure from before the payout.
  await page.goto('/day-book');
  const expectedCell = page
    .locator('table')
    .first()
    .locator('tbody tr')
    .first()
    .locator('td')
    .nth(4);
  const expected = Number((await expectedCell.innerText()).replace(/[₹,]/g, ''));
  expect(expected).toBeGreaterThan(0);

  await page.goto('/billing');
  await page.getByRole('button', { name: 'Close till' }).click();
  await tap(page, String(Math.round((expected - 10) * 100)));
  await page.getByRole('button', { name: 'Close and record' }).click();

  await expect(page.getByText(/Till closed ₹10\.00 short — recorded as it stands/))
    .toBeVisible();
});
