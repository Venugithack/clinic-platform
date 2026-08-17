import { expect, test, type Page } from '@playwright/test';

/**
 * The M11e gate (PLAN.md §16 step 1, INVENTORY.md §1 and §4).
 *
 *   "Load drug master, suppliers, opening stock (clinic closed, one day)."
 *
 * `B0_opening_stock.sql` proves the transition — the conversions, the
 * refusals, the ledger row. What only a browser proves is that the number the
 * doctor is asked to trust is the number he gets:
 *
 *   the preview values the whole shelf before anything is written, and
 *   after loading, the counter can sell out of the batch that preview counted.
 *
 * The other half is the one that would cost a month: loading the same file
 * twice must not double the shelf. `receive_goods` ADDS, by design, so this is
 * the only thing standing between a second click and an opening balance that
 * is wrong in a way nobody finds until a stock-take.
 *
 * Serial: it puts stock on the real seeded shelf.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const DRUG = `E2E Shelf ${STAMP}`;
const BATCH = `OS${STAMP}`;

/**
 * The drug master first, because a stock row names a drug. Deliberately the
 * same two-step the clinic does on go-live morning, in the same order, on the
 * same screen.
 */
const DRUG_FILE =
  'Drug Name,Strength,Salt,Form,Schedule,Units Per Strip,Strips Per Box,Supplier\r\n' +
  `${DRUG},500mg,Metformin,tablet,OTC,10,10,Kumar Distributors\r\n`;

/**
 * Twenty strips of ten, at ₹150 a *box* — the case the whole design is shaped
 * around. A file that got the cost basis wrong would value this at ₹3,000
 * instead of ₹300, and nothing except that number would look unusual.
 */
const STOCK_FILE =
  'Drug Name,Batch,Expiry,Qty,Unit,Rate,Rate Basis,MRP,Supplier\r\n' +
  `${DRUG},${BATCH},03/2028,20,strips,150.00,box,22.50,Kumar Distributors\r\n`;

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

/**
 * What the shelf says at the counter.
 *
 * It waits for the search's own response before reading the badge: an empty
 * result is also what the screen shows while the query is in flight, so
 * reading it too early makes "nothing was written" pass for the wrong reason.
 */
async function atTheCounter(page: Page, query: string, badge: string) {
  await page.goto('/counter/sale');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const answered = page.waitForResponse(
    (response) => response.url().includes('or=') && response.status() === 200,
  );
  await page.getByLabel('Search medicines').fill(query);
  await answered;

  await expect(page.getByText(badge, { exact: false })).toBeVisible();
}

test('the shelf is loaded from a file, and the counter can sell out of it', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');

  // Step one, on the same screen and in the stated order.
  await page.getByLabel('Paste the CSV').fill(DRUG_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();
  await page.getByRole('button', { name: 'Import 1 rows' }).click();
  await expect(page.getByTestId('import-done')).toContainText('1 new');

  // Step two.
  await page.getByRole('button', { name: '2 · Opening stock' }).click();
  await page.getByLabel('Paste the CSV').fill(STOCK_FILE);

  // Read locally, before any round trip — and the unit is printed beside every
  // number, because the unit is the thing that goes wrong.
  await expect(page.getByRole('cell', { name: '20 strips' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '150 / box' })).toBeVisible();

  await page.getByRole('button', { name: 'Check the file' }).click();

  const check = page.getByTestId('stock-check');
  await expect(check).toContainText('The file reads cleanly');
  await expect(page.getByTestId('stock-batches')).toHaveText('1');
  // 20 strips of 10 is 200 tablets. Packs in, base units stored.
  await expect(page.getByTestId('stock-units')).toHaveText('200');
  // ₹150 a box of 100 is ₹1.50 a tablet; 200 tablets is ₹300. If the basis had
  // been read as "strip" this would say ₹3,000.00 and the doctor would know.
  await expect(page.getByTestId('stock-value')).toHaveText('₹300.00');

  // Still nothing on the shelf: a dry run is a dry run. Checked on this tablet
  // rather than a second one, because the staff session lives in sessionStorage
  // and a new tab is a locked tablet.
  await atTheCounter(page, DRUG, 'OUT');

  await page.goto('/import');
  await page.getByRole('button', { name: '2 · Opening stock' }).click();
  await page.getByLabel('Paste the CSV').fill(STOCK_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();
  await page.getByRole('button', { name: 'Load 1 batches' }).click();
  const done = page.getByTestId('stock-done');
  await expect(done).toContainText('1 batches, 200 units');
  await expect(done).toContainText('₹300.00 at cost');

  // The point of the whole exercise: it is stock, and it can be sold.
  await atTheCounter(page, DRUG, '200 in stock');
});

test('loading the same file twice does not double the shelf', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');
  await page.getByRole('button', { name: '2 · Opening stock' }).click();

  await page.getByLabel('Paste the CSV').fill(STOCK_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();

  const check = page.getByTestId('stock-check');
  await expect(check).toContainText('Some rows cannot be imported');
  await expect(check).toContainText('already on the shelf');
  await expect(check).toContainText(BATCH);

  // And there is no button to press anyway. `receive_goods` ADDS — that is
  // right for a real delivery and catastrophic here.
  await expect(page.getByRole('button', { name: /^Load/ })).toBeDisabled();

  await atTheCounter(page, DRUG, '200 in stock');
});

test('a stock file loaded before its drug master is refused, row by row', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');
  await page.getByRole('button', { name: '2 · Opening stock' }).click();

  await page
    .getByLabel('Paste the CSV')
    .fill(
      'Drug Name,Batch,Expiry,Qty,Rate,MRP\r\n' +
        `Not In The Master ${STAMP},NM1,03/2028,10,50,80\r\n`,
    );
  await page.getByRole('button', { name: 'Check the file' }).click();

  const check = page.getByTestId('stock-check');
  await expect(check).toContainText('load the drug master first');
  await expect(check).toContainText('row 1');
});

test('the counter cannot load the shelf', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/import');
  await page.getByRole('button', { name: '2 · Opening stock' }).click();

  await expect(page.getByText(/whole value of the shelf/)).toBeVisible();
  await page.getByLabel('Paste the CSV').fill(STOCK_FILE);
  await expect(page.getByRole('button', { name: 'Check the file' })).toBeDisabled();
});
