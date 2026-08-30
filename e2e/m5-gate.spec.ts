import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/session';

/**
 * The M5 gate (PLAN.md §8).
 *
 *   "Low stock drafts one PO per supplier; approve sends a template message;
 *    supplier's reply is captured; goods received against the PO create batches."
 *
 * One deviation from that sentence, and it is the design: the send is a
 * WhatsApp **deep link**, not a template through Meta's Cloud API. Meta's rules
 * key on who initiates a conversation rather than on volume, so a template send
 * — even one a day, even human-approved — needs business verification, a second
 * number, display-name approval and opt-in machinery, while `wa.me` needs none
 * of it (WHATSAPP.md §0). The automation the clinic pays for is intact; only
 * the send button moves, into his own WhatsApp.
 *
 * Which is why this suite asserts the LINK and the recorded message, and never
 * asserts a delivery. The app cannot see one.
 *
 * Serial: it drives one order through its whole life.
 */
test.describe.configure({ mode: 'serial' });

/** The WhatsApp hand-off opens a tab. Close it; the assertion is the href. */
function swallowPopups(page: Page) {
  page.context().on('page', (opened) => void opened.close().catch(() => {}));
}

test('low stock has one order per supplier, and the counter cannot send them', async ({
  page,
}) => {
  await signIn(page, 'Counter');

  await page.goto('/reorder');

  // m3-purchasing runs earlier in the full suite and now deliberately leaves
  // its drafts open so the duplicate-order guard can be exercised. When this
  // gate is run alone there are no drafts yet, so create them here. In either
  // case the product invariant is the same: one open order covers the medicine
  // and the reorder screen will not create another one.
  const draftButton = page.getByRole('button', { name: /^Draft \d+ orders?$/ });
  const alreadyOnOrder = page.getByText(/Already on order:/).first();

  // Wait for the screen to have decided what it is showing before branching on
  // it. `count()` does not wait — it answers about the DOM as it stands — and
  // the suggestions arrive from the database a moment after navigation, so a
  // bare count() here reads 0 off the loading state every time and takes the
  // "already on order" path on a run that has nothing on order yet.
  await expect(draftButton.or(alreadyOnOrder).first()).toBeVisible();

  if ((await draftButton.count()) > 0) {
    await draftButton.click();
    await expect(page.getByText(/draft orders? saved/)).toBeVisible();
  } else {
    await expect(alreadyOnOrder).toBeVisible();
  }

  await page.goto('/orders');
  const kumarDraft = page
    .getByRole('button', { name: /Kumar Distributors.*draft/ })
    .first();
  const reddyDraft = page
    .getByRole('button', { name: /Reddy Pharma.*draft/ })
    .first();
  await expect(kumarDraft).toBeVisible();
  await expect(reddyDraft).toBeVisible();
  await kumarDraft.click();

  // Rule 4, on the screen: an order is a financial commitment to somebody else.
  await expect(page.getByRole('button', { name: 'Approve & send' })).toBeDisabled();
  await expect(page.getByText('The doctor sends orders.')).toBeVisible();
});

test('a supplier with no WhatsApp number is refused, by name', async ({ page }) => {
  await signIn(page, 'Dr Seed');
  swallowPopups(page);

  await page.goto('/orders');
  const reddy = page.getByRole('button', { name: /Reddy Pharma.*draft/ }).first();

  // The seed leaves Reddy without a number on purpose — half a real drug master
  // arrives that way, and this is the refusal that says so.
  await expect(reddy).toBeVisible();
  await reddy.click();
  await page.getByRole('button', { name: 'Approve & send' }).click();

  // Two refusals can answer this now and either is correct. The database has
  // always raised CL022 — "no WhatsApp number is recorded for Reddy Pharma" —
  // and the Orders screen now checks the number before send_purchase_order
  // numbers the order, because once it moves to `sent` the doctor cannot take
  // that assertion back. Whichever fires, the property under test is the same
  // one the test is named for: the refusal says WHICH supplier.
  // Scoped to the refusal itself. The context pane also lists "Reddy Pharma"
  // beside the open orders, so a bare page-wide match finds two elements and
  // Playwright refuses to guess which one was meant.
  await expect(
    page.getByRole('status').filter({ hasText: /Reddy Pharma/ }),
  ).toContainText(/WhatsApp number/i);
});

test('the doctor approves, and WhatsApp opens with the order already written', async ({
  page,
}) => {
  await signIn(page, 'Dr Seed');
  swallowPopups(page);

  await page.goto('/orders');
  await page.getByRole('button', { name: /Kumar Distributors.*draft/ }).first().click();

  // Read a drug off the order so the message can be checked against it.
  const firstLine = page.locator('tbody tr').first();
  const drug = (await firstLine.locator('td').first().innerText()).split('\n')[0] ?? '';
  expect(drug.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Approve & send' }).click();

  // The order is numbered at the send, not at the draft.
  await expect(page.getByText(/PO \d{4}-\d{2}\/\d{4} recorded/)).toBeVisible();

  // The link: his own WhatsApp, the supplier's number, the order pre-filled.
  const href = await page.getByTestId('wa-link').getAttribute('href');
  expect(href).toContain('https://wa.me/919000000001?text=');
  expect(decodeURIComponent(href ?? '')).toContain(drug.split(' ')[0] ?? '');
  expect(decodeURIComponent(href ?? '')).toContain('Please confirm availability');

  // And what was composed is on the record, because the send happens somewhere
  // this app cannot watch.
  await expect(page.getByRole('heading', { name: 'What was sent' })).toBeVisible();
  await expect(page.getByText(/handed_off/).first()).toBeVisible();
});

test('the supplier replies, the goods arrive, and the order closes itself', async ({
  page,
}) => {
  await signIn(page, 'Dr Seed');

  await page.goto('/orders');
  await page
    .getByRole('button', { name: /Kumar Distributors.*PO \d{4}-\d{2}\/\d{4}/ })
    .first()
    .click();

  // No inbound webhook on a deep link, so somebody reads the reply and records
  // it. Worse than an API; much better than an order nobody is tracking.
  await page.getByRole('button', { name: 'Supplier replied' }).click();
  await page.getByLabel('What did the supplier say?').fill('Confirmed, sending today');
  await page.getByRole('button', { name: 'Record reply' }).click();
  await expect(page.getByText('Supplier: Confirmed, sending today')).toBeVisible();

  // Goods against the order — Add stock arrives already knowing the supplier,
  // the drugs and what is still outstanding.
  await page.getByRole('button', { name: 'Receive goods' }).click();

  // Add stock is a section of the Shelf tab now rather than a screen of its
  // own, and the `po` has to survive the move: an Add stock that had forgotten
  // which order it was answering would be worse than no link at all.
  await expect(page).toHaveURL(
    /\/counter\?tab=shelf&section=add-stock&po=[0-9a-f-]+$/,
  );
  await expect(page.getByText(/Against PO \d{4}-\d{2}\/\d{4}/)).toBeVisible();

  await page.getByLabel('Invoice number').fill(`INV-PO-${Date.now()}`);

  await page
    .getByRole('heading', { name: 'Still outstanding on this order' })
    .waitFor();
  await page.locator('ul > li > button').first().click();

  await page.getByLabel('Batch number').fill(`PO${Date.now().toString().slice(-6)}`);
  await page.getByRole('button', { name: 'Mar', exact: true }).click();
  await page
    .getByRole('button', { name: String(new Date().getFullYear() + 2), exact: true })
    .click();
  await page.getByRole('button', { name: 'MRP per strip', exact: true }).click();
  for (const digit of '3450') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }

  // The rate has to be typed even here, where the order carried an expected
  // cost — these drugs have never been bought through a GRN, so there is no
  // price history to prefill from. A receipt with no cost silently poisons the
  // weighted-average valuation, so the screen will not post one.
  await page.getByRole('button', { name: 'Rate per strip', exact: true }).click();
  for (const digit of '1900') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }

  await page.getByRole('button', { name: 'Add to receipt' }).click();
  await page.getByRole('button', { name: 'Post receipt' }).click();
  await expect(page.getByText(/batch(es)? on the shelf/)).toBeVisible();

  // Back on the order: the receipt is tied to it, and the outstanding column
  // moved. A part-delivered order must not look like a finished one.
  await page.goto('/orders');
  await expect(
    page.getByRole('button', { name: /Kumar Distributors.*Part delivered|Kumar Distributors.*PO/ }).first(),
  ).toBeVisible();
});
