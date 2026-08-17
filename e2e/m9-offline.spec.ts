import { expect, test, type Page } from '@playwright/test';

/**
 * Offline write and reflush — the sixth Playwright path in PLAN.md §16.
 *
 * The clinic's Wi-Fi drops mid-sale. That is a router, a concrete wall and a 4G
 * backup that takes half a minute to take over (HOSTING.md §6), and the counter
 * cannot stop for any of it.
 *
 * What this proves in a browser, which `A4_replay.sql` cannot:
 *
 *   1. the sale does not fail — it is kept on the tablet;
 *   2. the screen does NOT say "sold", because the ledger has not been written
 *      and claiming otherwise is a lie in the direction that costs money;
 *   3. the strip above every screen says how many writes are waiting;
 *   4. when the network returns, they go in on their own.
 *
 * The at-most-once property behind it — the same key applied twice moving stock
 * once — is asserted in pgTAP, where the clock and the concurrency can be
 * controlled.
 *
 * Serial: it takes the network away from a shared browser context.
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

test('a sale made with no network is kept, and goes in when it returns', async ({
  browser,
}) => {
  // The offline attempt waits out lib/db's 12-second request bound before it
  // gives up, which is most of a default timeout on its own.
  test.setTimeout(90_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/counter/sale');

  await page.getByRole('button', { name: 'Search' }).click();
  // Glycomet, because no other spec touches it. The first run of this test
  // picked Shelcal — which the expiry spec returns to the supplier in full —
  // and the queue did exactly the right thing with the result: it flushed, the
  // database refused it for want of stock, and the strip said a person had to
  // deal with it. Correct behaviour, wrong fixture.
  await page.getByLabel('Search medicines').fill('Glycomet');
  await page.getByRole('button', { name: /Glycomet 500/ }).click();

  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  // The wall.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete sale' }).click();

  // Never "sold". The tablet has it; the ledger does not.
  await expect(page.getByText(/Saved on this tablet/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled();

  const queue = page.getByTestId('write-queue');
  await expect(queue).toContainText('1 write saved on this tablet, not yet in the ledger');

  // The manual push is there for a captive portal that reports itself online
  // before it routes. It is asserted as an affordance rather than tapped: the
  // first version of this test tapped it and lost the race, because the strip
  // had already flushed itself on the browser's own `online` event — which is
  // the behaviour that actually matters.
  await expect(queue.getByRole('button', { name: 'Try now' })).toBeVisible();

  // The network comes back, and nobody has to notice.
  await context.setOffline(false);
  await expect(page.getByTestId('write-queue')).toHaveCount(0, { timeout: 40_000 });

  // And it landed exactly once: the billing worklist has one unbilled counter
  // sale for it, not two.
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  const sales = page.getByRole('button', { name: /Counter sale.*₹32\.00/ });
  await expect(sales).toHaveCount(1);

  await context.close();
});

test('a refusal is never queued — the database answered, so it decided', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, 'seed-device-counter', 'Counter');
  await page.goto('/counter/sale');

  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Search medicines').fill('Alprax');
  await page.getByRole('button', { name: /Alprax/ }).click();

  const qtypad = page.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '10', exact: true }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  // Online, and refused: Schedule H1 cannot leave on a counter sale.
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/cannot be sold without a prescription/)).toBeVisible();

  // The distinction the queue is built on. Queuing this would retry it every
  // twenty seconds forever and tell the pharmacist it was "waiting for the
  // network", when it is never going to happen.
  await expect(page.getByTestId('write-queue')).toHaveCount(0);

  await context.close();
});
