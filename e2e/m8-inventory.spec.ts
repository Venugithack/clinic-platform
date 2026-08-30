import { expect, test } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

test.describe('inventory', () => {
  /**
   * The reachability half of the feature, and the reason it is the first test.
   *
   * A screen only a URL can reach does not exist on a tablet with no keyboard,
   * so this walks the path the pharmacist actually has rather than calling
   * page.goto('/inventory').
   *
   * That path has moved twice. It was a rail button on the counter, which is
   * why the counter's rail had grown to eight destinations under three
   * headings — a navigation menu wearing an action rail's clothes. Then it was
   * an entry in the Go to sheet, which was the same menu with a door on it: the
   * counter screen ended up having to say "Stock and purchasing live under Go
   * to", and a screen giving directions to its own navigation has lost.
   *
   * Now the shelf is a tab on the pharmacy desk, on screen at all times. One
   * tap, and no tap needed first to reveal the thing to tap. The assertion is
   * the one it always was: reachable by tapping, from where the pharmacist
   * starts.
   */
  test('the counter can reach it without typing a URL', async ({ page }) => {
    await signInAndOpen(page, 'Counter');
    await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Shelf', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  });

  /**
   * The tab strip is the navigation, so it has to survive being looked at by
   * somebody who is not already holding the map. Every job the pharmacist does
   * is a word on the screen before they touch anything.
   */
  test('every pharmacy job is on screen without opening a menu', async ({ page }) => {
    await signInAndOpen(page, 'Counter');

    for (const job of ['Counter', 'Shelf', 'Buying', 'Medicines', 'Money']) {
      await expect(page.getByRole('link', { name: job, exact: true })).toBeVisible();
    }
  });

  /**
   * The dead end this rework exists to remove: a delivery arrives containing a
   * medicine the clinic has never stocked, and the pharmacist could neither
   * find it nor add it — /medicines refused them with "Only an administrator
   * can manage the medicine master", so the boxes sat on the counter until
   * somebody reached the owner. See
   * supabase/migrations/20260830120000_pharmacy_owns_the_shelf.sql.
   */
  test('the counter can open the medicine list and add to it', async ({ page }) => {
    await signInAndOpen(page, 'Counter');

    await page.getByRole('link', { name: 'Medicines', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Medicines' })).toBeVisible();
    await expect(page.getByText('Only an administrator')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add medicine' }).first()).toBeVisible();
  });

  test('a drug on the shelf shows its quantity, its packs and what it cost', async ({
    page,
  }) => {
    await signIn(page, 'Counter');
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
    await signIn(page, 'Counter');
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
    await signIn(page, 'Counter');
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
    await signIn(page, 'Counter');
    await page.goto('/inventory');

    await page.getByLabel('Search the shelf').fill('qqzz-not-a-medicine');

    await expect(page.getByText(/Nothing on the shelf matches/)).toBeVisible();
    await expect(page.getByText(/may still be in the catalogue with none in stock/)).toBeVisible();
  });
});
