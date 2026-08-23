import { expect, test, type Page } from '@playwright/test';

/**
 * The inventory window (INVENTORY.md §4).
 *
 * Read-only, so this spec is parallel-safe and does not need `serial` — nothing
 * here moves stock.
 *
 * It asserts against Augmentin 625 and Ascoril LS specifically, and that choice
 * is load-bearing rather than arbitrary. The suite runs fully parallel against
 * one seeded database, so any figure a *different* spec can move is a figure
 * this one must not assert on: m3-inventory sells Cetzine and counts Telma,
 * m3-expiry writes off Shelcal and Zincovit, m3-dispense draws Dolo and
 * Glycomet. Those two drugs are touched by no other spec, which is what makes
 * "180" and "₹5400.00" safe to write down.
 *
 * For the same reason there is no assertion on the shelf total or the number of
 * drugs on it: both are sums over the whole seed, and both legitimately change
 * when a spec in another worker writes off a batch.
 */
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

test.describe('inventory', () => {
  /**
   * The reachability half of the feature, and the reason it is the first test.
   *
   * A screen only a URL can reach does not exist on a tablet with no keyboard.
   * This walks the same path the pharmacist has — sign in, land on the counter,
   * tap the rail — rather than calling page.goto('/inventory').
   */
  test('the counter can reach it without typing a URL', async ({ page }) => {
    await signIn(page, 'seed-device-counter', 'Counter');
    await page.goto('/counter');

    await page.getByRole('button', { name: 'Inventory', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    await expect(page.getByText('Pharmacy')).toBeVisible();
  });

  test('a drug on the shelf shows its quantity, its packs and what it cost', async ({
    page,
  }) => {
    await signIn(page, 'seed-device-counter', 'Counter');
    await page.goto('/inventory');

    const augmentin = page.getByTestId('inventory-Augmentin 625');
    await expect(augmentin).toBeVisible();

    // 180 tablets at 6 to a strip and 10 strips to a box is exactly 3 boxes,
    // and the packs are the half a pharmacist can check against the shelf —
    // "180" is not a thing you can count without opening the boxes.
    await expect(augmentin).toContainText('180');
    await expect(augmentin).toContainText('3 boxes');
    await expect(augmentin).toContainText('₹5400.00');
    await expect(augmentin).toContainText('1 batch');

    // A schedule is printed as the fact it is. Augmentin is H.
    await expect(augmentin).toContainText('Schedule H');
  });

  /**
   * Salt search, which is the whole reason this screen has a search box rather
   * than a sorted list: the shelf says Augmentin and the person looking for it
   * is thinking amoxicillin. `searchDrugs` already matches this way for
   * prescribing, and the two surfaces disagreeing about what a word finds is
   * worse than neither having it.
   */
  test('searches by salt, not only by the name on the box', async ({ page }) => {
    await signIn(page, 'seed-device-counter', 'Counter');
    await page.goto('/inventory');

    await page.getByLabel('Search the shelf').fill('amoxicillin');

    await expect(page.getByTestId('inventory-Augmentin 625')).toBeVisible();
    await expect(page.getByTestId('inventory-Ascoril LS')).toHaveCount(0);
  });

  /**
   * The batches behind the number, in the order the next sale will draw them.
   * A total nobody can break down into boxes on a shelf is a number to be
   * argued with and not checked.
   */
  test('a row opens into the batches behind it', async ({ page }) => {
    await signIn(page, 'seed-device-counter', 'Counter');
    await page.goto('/inventory');

    const augmentin = page.getByTestId('inventory-Augmentin 625');
    await expect(augmentin).toHaveAttribute('aria-expanded', 'false');

    await augmentin.click();

    await expect(augmentin).toHaveAttribute('aria-expanded', 'true');

    // Scoped to the panel, not the page. The row summary already prints the
    // earliest expiry, so a bare getByText('Jun 2027') matches the collapsed
    // row too and would pass without the panel ever opening.
    const batches = page.getByTestId('inventory-batches-Augmentin 625');
    await expect(batches).toContainText('AU2502X');
    await expect(batches).toContainText('Jun 2027');
    await expect(batches).toContainText('₹30.00/tablet');
  });

  /**
   * The empty state has to separate "we do not stock it" from "we are out",
   * because those lead to different next actions and the screen cannot show
   * either one as a row: `stock_valuation` has no row at all for a drug with
   * nothing on hand.
   */
  test('says why a search found nothing, rather than just finding nothing', async ({
    page,
  }) => {
    await signIn(page, 'seed-device-counter', 'Counter');
    await page.goto('/inventory');

    await page.getByLabel('Search the shelf').fill('qqzz-not-a-medicine');

    await expect(page.getByText(/Nothing on the shelf matches/)).toBeVisible();
    await expect(page.getByText(/may still be in the catalogue with none in stock/)).toBeVisible();
  });
});
