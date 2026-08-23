import { expect, test, type Page } from '@playwright/test';

/**
 * The M2 gate (BUILD.md §2), and the feature the clinic actually bought.
 *
 *   "Rx signed on tablet A is on tablet B in under a second, in the two real
 *    rooms, over the clinic Wi-Fi. Counter raises 'out of stock', doctor
 *    answers without leaving the consult screen."
 *
 * Two browser contexts, because one context proves nothing about a link
 * between two devices: separate storage, separate PIN sessions, separate
 * subscriptions. The doctor's context is signed in on the cabin tablet and the
 * pharmacist's on the counter tablet, exactly as they are in the clinic.
 *
 * What this cannot prove is the clause about the two real rooms. Wi-Fi latency,
 * a tablet's radio sleeping and the range from the cabin to the counter are
 * physical facts, and BUILD.md §2 schedules that check for the throwaway deploy
 * around M4. The latency budget here is deliberately tighter than a human
 * would notice, so that a regression to polling fails the build rather than
 * quietly costing a second.
 */

const LATENCY_BUDGET_MS = 1500;

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
  await expect(page.getByRole('heading', { name: new RegExp(`Signed in as ${staffName}`) }))
    .toBeVisible();
}

async function registerWalkIn(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Consent').click();
  await page.getByRole('button', { name: /Register & get token/ }).click();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
}

test('a signed prescription reaches the counter, and the answer comes back', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  const patient = `E2E Link ${Date.now()}`;

  await signIn(doctorPage, 'seed-device-cabin', 'Dr Seed');
  await signIn(counterPage, 'seed-device-counter', 'Counter');

  // The pharmacist is watching the counter before anything is signed — and
  // gets there the way she actually does, by pressing the one button on her
  // lock screen. That button used to say "Open the queue" and go to the
  // doctor's room; this spec asserted the wrong destination along with it, and
  // the `goto('/counter')` underneath was what hid the bug from the suite.
  await counterPage.getByRole('button', { name: 'Open the counter' }).click();
  await expect(counterPage.getByRole('heading', { name: 'Counter', exact: true }))
    .toBeVisible();

  // ---- the doctor consults and prescribes --------------------------------
  await registerWalkIn(doctorPage, patient);
  await doctorPage.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(doctorPage.getByRole('heading', { name: 'Consult', exact: true }))
    .toBeVisible();

  // Calpol 650 has no stock in the seed; Dolo 650 is the same salt, the same
  // strength and the same form, and is on the shelf. That is the substitution
  // INVENTORY.md §7 allows, and the only kind it allows.
  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Calpol');
  await doctorPage.getByRole('button', { name: /Calpol 650/ }).click();

  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  const signedAt = Date.now();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/[0-9a-f-]+\/print$/);

  // ---- and it is at the counter, without the counter doing anything ------
  const row = counterPage.getByRole('button', { name: new RegExp(patient) });
  await expect(row).toBeVisible({ timeout: LATENCY_BUDGET_MS });

  const latency = Date.now() - signedAt;
  console.log(`live link: prescription visible at the counter in ${latency}ms`);
  expect(latency).toBeLessThan(LATENCY_BUDGET_MS);

  // Colour-coded: nothing on the shelf for the only line (TABLET.md §7).
  await expect(row).toContainText('Out');

  // ---- the counter proposes ----------------------------------------------
  await row.click();
  await expect(counterPage.getByRole('heading', { name: 'Dispense', exact: true }))
    .toBeVisible();

  await counterPage.getByRole('button', { name: 'Ask doctor' }).click();
  await expect(
    counterPage.getByText(/same salt, same strength, same\s+form/),
  ).toBeVisible();

  await counterPage.getByRole('button', { name: /Dolo 650/ }).click();
  await expect(counterPage.getByRole('button', { name: /Waiting on doctor/ }))
    .toBeVisible();

  // ---- the doctor answers, from wherever they happen to be ---------------
  const banner = doctorPage.getByRole('region', { name: 'Questions from the counter' });
  await expect(banner).toBeVisible({ timeout: LATENCY_BUDGET_MS });
  await expect(banner).toContainText('Calpol 650');
  await expect(banner).toContainText('substitute');
  await expect(banner).toContainText('Dolo 650');

  await banner.getByRole('button', { name: 'Approve' }).click();
  await expect(banner).toBeHidden({ timeout: LATENCY_BUDGET_MS });

  // ---- and the counter sees the decision ---------------------------------
  await expect(counterPage.getByText(/Doctor approved/)).toBeVisible({
    timeout: LATENCY_BUDGET_MS,
  });
  await expect(counterPage.getByText(/dispense Dolo 650/)).toBeVisible();

  await cabin.close();
  await counter.close();
});

test('the counter cannot propose a drug that is not an equivalent', async ({ browser }) => {
  const counter = await browser.newContext();
  const cabin = await browser.newContext();
  const counterPage = await counter.newPage();
  const doctorPage = await cabin.newPage();

  const patient = `E2E Equiv ${Date.now()}`;

  await signIn(doctorPage, 'seed-device-cabin', 'Dr Seed');
  await registerWalkIn(doctorPage, patient);
  await doctorPage.getByRole('button', { name: new RegExp(patient) }).click();

  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Calpol');
  await doctorPage.getByRole('button', { name: /Calpol 650/ }).click();
  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/[0-9a-f-]+\/print$/);

  await signIn(counterPage, 'seed-device-counter', 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();
  await counterPage.getByRole('button', { name: 'Ask doctor' }).click();

  // The only proposals offered are same salt, same strength, same form. There
  // is no path in this screen to propose Cetzine for Paracetamol, which is the
  // point: matching salts is a lookup, and anything looser is a clinical
  // judgement that belongs to the doctor (INVENTORY.md §7, rule 8).
  const proposals = counterPage.getByRole('button', { name: /in stock|OUT/ });

  // Waited for, not read straight away. `allInnerTexts()` does not retry, so
  // reading it before the equivalents land returns an empty array and the
  // "Dolo is offered" assertion fails for a reason that has nothing to do with
  // equivalence. It flaked about one run in three under a loaded suite before
  // this line existed (M11f).
  await expect(proposals.filter({ hasText: 'Dolo 650' })).toBeVisible();

  const labels = await proposals.allInnerTexts();
  expect(labels.join(' ')).not.toContain('Cetzine');
  expect(labels.join(' ')).not.toContain('Pan 40');

  await cabin.close();
  await counter.close();
});
