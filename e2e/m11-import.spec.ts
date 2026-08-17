import { expect, test, type Page } from '@playwright/test';

/**
 * The M11a gate (PLAN.md §16 go-live step 1, BUILD.md §3).
 *
 *   "Load drug master, suppliers, opening stock (clinic closed, one day)."
 *
 * The property under test is the one that decides whether that day is one day:
 * **the doctor sees exactly what will happen before anything happens, and a
 * file with a bad row in it changes nothing at all.**
 *
 * `A6_import.sql` proves the transition. What a database cannot prove is that
 * the person holding a five-hundred-row spreadsheet can get it in — that the
 * headers his software wrote are understood, that the preview arrives before
 * the commitment, and that the row he has to fix is named by its row number
 * rather than reported as "import failed".
 *
 * Every assertion about what did or did not land is made at the counter's drug
 * search, because that is where a bad import actually hurts: mid-sale, with
 * somebody waiting.
 *
 * Serial, because it writes to the drug master the later tests read.
 */
test.describe.configure({ mode: 'serial' });

// Unique per run: this suite writes to the real master, and the master is
// deliberately never deleted from.
const STAMP = Date.now();
const DRUG = `E2E Import ${STAMP}`;
const SUPPLIER = `E2E Distributors ${STAMP}`;

/**
 * Deliberately not the tidy header set. This is closer to what a chemist's
 * billing software exports: title case, spaces, "Salt" rather than
 * "salt_composition", and a salt with a comma inside its quotes.
 */
const CLEAN_FILE =
  'Drug Name,Strength,Salt,Form,Schedule,Units Per Strip,Strips Per Box,Supplier\r\n' +
  `${DRUG},650mg,"Paracetamol, anhydrous",tablet,OTC,15,10,${SUPPLIER}\r\n` +
  `${DRUG} DS,1000mg,Paracetamol,tablet,OTC,10,10,${SUPPLIER}\r\n`;

/** Row 2 has no salt. Rows 1 and 3 are fine. The file is refused whole. */
const DIRTY_FILE =
  'Drug Name,Strength,Salt,Form\r\n' +
  `${DRUG} Bad A,50mg,Nimesulide,tablet\r\n` +
  `${DRUG} Bad B,100mg,,tablet\r\n` +
  `${DRUG} Bad C,200mg,Ibuprofen,tablet\r\n`;

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
 * What the counter can find — asserted against the number the search itself
 * reports.
 *
 * It waits for the search's own request to come back rather than for the text,
 * because "0 matches" is what the screen says while the query is still in
 * flight. Reading it too early makes every "nothing was written" assertion in
 * this file pass for the wrong reason, which is the failure mode a test like
 * this exists to avoid.
 */
async function matchesAtTheCounter(page: Page, query: string, expected: string) {
  await page.goto('/counter/sale');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const answered = page.waitForResponse(
    (response) => response.url().includes('or=') && response.status() === 200,
  );
  await page.getByLabel('Search medicines').fill(query);
  await answered;

  await expect(page.getByText(/^\d+ match(es)?$/)).toHaveText(expected);
}

test('a file with one unreadable row is refused whole, and says which row', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');

  await page.getByLabel('Paste the CSV').fill(DIRTY_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();

  const check = page.getByTestId('import-check');
  await expect(check).toBeVisible();
  await expect(check).toContainText('Some rows cannot be imported');

  // The row number and the reason, not "import failed". The person fixing this
  // file is looking at row 2 of a spreadsheet.
  await expect(page.getByTestId('check-errors')).toHaveText('1');
  await expect(check).toContainText('row 2');
  await expect(check).toContainText(/salt composition/i);

  // And the two good rows in that same file are NOT offered as a partial
  // import. That is the whole rule: a half-loaded master looks exactly like a
  // shelf that is missing stock.
  await expect(page.getByRole('button', { name: /^Import/ })).toBeDisabled();

  // Nothing was written — including the rows that read perfectly well.
  await matchesAtTheCounter(page, `${DRUG} Bad`, '0 matches');
});

test('the dry run counts the file without writing it, then the import writes it', async ({
  page,
}) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');

  await page.getByLabel('Paste the CSV').fill(CLEAN_FILE);

  // Read locally and shown before any round trip — including a header this
  // build had to be taught ("Drug Name") and a salt with a comma inside its
  // quotes, which is the case a naive split gets wrong silently.
  await expect(page.getByText('2 rows read')).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Paracetamol, anhydrous' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Check the file' }).click();
  const check = page.getByTestId('import-check');
  await expect(check).toContainText('The file reads cleanly');
  await expect(page.getByTestId('check-created')).toHaveText('2');
  await expect(page.getByTestId('check-updated')).toHaveText('0');

  // Still nothing on the shelf: a dry run is a dry run.
  await matchesAtTheCounter(page, DRUG, '0 matches');

  await page.goto('/import');
  await page.getByLabel('Paste the CSV').fill(CLEAN_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();

  const done = page.getByTestId('import-done');
  await expect(done).toContainText('2 new');
  await expect(done).toContainText('1 supplier created');

  // The point of the whole exercise: the counter can now find it.
  await matchesAtTheCounter(page, DRUG, '2 matches');
});

test('the same file again updates instead of duplicating', async ({ page }) => {
  await signIn(page, 'seed-device-cabin', 'Dr Seed');
  await page.goto('/import');

  // He will run it twice. Usually after fixing three rows, and usually in a
  // file that still contains all the others.
  await page.getByLabel('Paste the CSV').fill(CLEAN_FILE);
  await page.getByRole('button', { name: 'Check the file' }).click();

  await expect(page.getByTestId('check-created')).toHaveText('0');
  await expect(page.getByTestId('check-updated')).toHaveText('2');

  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  const done = page.getByTestId('import-done');
  await expect(done).toContainText('2 updated');
  // The supplier is matched by name, not created a second time.
  await expect(done).not.toContainText('supplier');

  // Two drugs, not four. A duplicated master is a week of cleanup, and it is
  // only ever noticed at the counter, mid-sale.
  await matchesAtTheCounter(page, DRUG, '2 matches');
});

test('the counter cannot load the drug master', async ({ page }) => {
  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/import');

  await expect(
    page.getByText(/loaded by the doctor or an administrator/),
  ).toBeVisible();

  // Not merely empty — a readable file in hand and the button still refuses.
  // The database would refuse it too (CL005); this is so the pharmacist is
  // told that in a sentence rather than by a failure.
  await page.getByLabel('Paste the CSV').fill(CLEAN_FILE);
  await expect(page.getByText('2 rows read')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check the file' })).toBeDisabled();
});
