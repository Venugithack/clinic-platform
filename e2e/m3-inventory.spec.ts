import { expect, test } from '@playwright/test';
import { signIn } from './support/session';

/**
 * Counter sale and the blind stock-take (INVENTORY.md §3, §5).
 *
 * Serial, and deliberately so. These tests move real stock, and only one
 * stock-take may be open at a time — running them against each other in
 * parallel produces failures that look like product bugs and are not. They also
 * touch batches no other spec asserts on, for the same reason.
 */
test.describe.configure({ mode: 'serial' });

test.describe('counter sale', () => {
  test('a walk-in buys an OTC medicine, and the total is right', async ({ page }) => {
    await signIn(page, 'Counter');
    await page.goto('/counter/sale');

    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel('Search medicines').fill('Cetzine');
    await page.getByRole('button', { name: /Cetzine/ }).click();

    // Cetzine seeds at MRP 44.00 for a strip of 10, so one strip is exactly
    // the printed MRP — no rounding, nothing above it.
    const qtypad = page.getByTestId('qtypad');
    await qtypad.getByRole('button', { name: '1 strip' }).click();
    await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

    await expect(page.getByTestId('sale-total')).toHaveText('₹44.00');

    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByText(/The ledger has been written/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sold' })).toBeDisabled();
  });

  // This test is the regression guard for a bug that hid behind every success
  // path in the build. The refusal is raised with SQLSTATE CL003 — and it used
  // to be PT003, which PostgREST reserves: it reads the three characters after
  // `PT` as the HTTP status to return. So an H1 refusal asked for HTTP status
  // 3, the response never framed, the browser's fetch neither resolved nor
  // rejected, and this screen sat on "Selling…" telling the pharmacist nothing.
  // Every transition refusal in the build was affected and none of them could
  // reach a screen. See the note in 20260816090600_transition_dispense.sql.
  test('Schedule H1 is refused, by the database rather than the screen', async ({ page }) => {
    await signIn(page, 'Counter');
    await page.goto('/counter/sale');

    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel('Search medicines').fill('Alprax');
    await page.getByRole('button', { name: /Alprax/ }).click();

    const qtypad = page.getByTestId('qtypad');
    await qtypad.getByRole('button', { name: '10', exact: true }).click();
    await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

    // The screen warns. The refusal is not the screen's to make.
    await expect(page.getByText(/H1 — needs a prescription/)).toBeVisible();

    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByText(/cannot be sold without a prescription/)).toBeVisible();
  });
});

test.describe('blind stock-take', () => {
  test('the count never shows what was expected, and only the doctor posts it', async ({
    browser,
  }) => {
    const counterCtx = await browser.newContext();
    const cabinCtx = await browser.newContext();
    const counterPage = await counterCtx.newPage();
    const doctorPage = await cabinCtx.newPage();

    await signIn(counterPage, 'Counter');
    await counterPage.goto('/stock-take');

    await counterPage.getByRole('button', { name: 'Start a count' }).click();
    await expect(counterPage.getByText(/batches counted/)).toBeVisible();

    // Nothing on this screen says what the system expects — not in the list,
    // not on the count pad. The counting role cannot even fetch it.
    const body = await counterPage.locator('body').innerText();
    expect(body).toContain('The expected quantity is not shown');

    // Telma's TM2504S, which no other spec touches. The seed puts 450 units on
    // that shelf, so counting 449 is the everyday discrepancy — one strip
    // miscounted, ~8 rupees, comfortably under the recount threshold. A bigger
    // gap would correctly refuse to post without a second count, which pgTAP
    // covers in 80_stock_take.sql.
    await counterPage.getByRole('button', { name: /TM2504S/ }).click();
    for (const digit of '449') {
      await counterPage.getByRole('button', { name: digit, exact: true }).click();
    }
    await counterPage.getByRole('button', { name: 'Record count' }).click();
    await expect(counterPage.getByText(/counted$/)).toBeVisible();

    await counterPage.getByRole('button', { name: 'Finish counting' }).click();

    // Now — and only now — the variance appears, and the counter cannot post it.
    await expect(counterPage.getByRole('table')).toBeVisible();
    await expect(
      counterPage.getByRole('button', { name: 'Approve and post' }),
    ).toHaveCount(0);

    // The doctor can.
    await signIn(doctorPage, 'Dr Seed');
    await doctorPage.goto('/stock-take');
    await expect(doctorPage.getByRole('table')).toBeVisible();

    const approve = doctorPage.getByRole('button', { name: 'Approve and post' });
    await expect(approve).toBeVisible();
    await approve.click();
    await expect(doctorPage.getByText(/Approved\./)).toBeVisible();

    await counterCtx.close();
    await cabinCtx.close();
  });
});
