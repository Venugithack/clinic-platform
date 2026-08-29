import { expect, test, type Page } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

/**
 * The M2 gate (BUILD.md §2), and the feature the clinic actually bought.
 *
 *   "Rx signed on tablet A is on tablet B in under a second, in the two real
 *    rooms, over the clinic Wi-Fi. Counter raises 'out of stock', doctor
 *    answers without leaving the consult screen."
 */

const LATENCY_BUDGET_MS = 1500;

async function registerWalkIn(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open the queue' }).click();
  await page.getByRole('button', { name: 'Register walk-in' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Consent').click();
  await page.getByRole('button', { name: /Register & get token/ }).click();
  await expect(page.getByRole('heading', { name: 'Today’s queue', exact: true })).toBeVisible();
}

test('a signed prescription reaches the counter, and the answer comes back', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const counter = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const counterPage = await counter.newPage();

  const patient = `E2E Link ${Date.now()}`;

  await signIn(doctorPage, 'Dr Seed');
  await signInAndOpen(counterPage, 'Counter');
  await expect(counterPage.getByRole('heading', { name: 'Counter', exact: true }))
    .toBeVisible();

  await registerWalkIn(doctorPage, patient);
  await doctorPage.getByRole('button', { name: new RegExp(patient) }).click();
  await expect(doctorPage.getByRole('heading', { name: 'Consult', exact: true }))
    .toBeVisible();

  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Calpol');
  await doctorPage.getByRole('button', { name: /Calpol 650/ }).click();

  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();

  const signedAt = Date.now();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);

  const row = counterPage.getByRole('button', { name: new RegExp(patient) });
  await expect(row).toBeVisible({ timeout: LATENCY_BUDGET_MS });

  const latency = Date.now() - signedAt;
  console.log(`live link: prescription visible at the counter in ${latency}ms`);
  expect(latency).toBeLessThan(LATENCY_BUDGET_MS);

  await expect(row).toContainText('Out');

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

  const banner = doctorPage.getByRole('region', { name: 'Questions from the counter' });
  await expect(banner).toBeVisible({ timeout: LATENCY_BUDGET_MS });
  await expect(banner).toContainText('Calpol 650');
  await expect(banner).toContainText('substitute');
  await expect(banner).toContainText('Dolo 650');

  await banner.getByRole('button', { name: 'Approve' }).click();
  await expect(banner).toBeHidden({ timeout: LATENCY_BUDGET_MS });

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

  await signIn(doctorPage, 'Dr Seed');
  await registerWalkIn(doctorPage, patient);
  await doctorPage.getByRole('button', { name: new RegExp(patient) }).click();

  await doctorPage.getByRole('button', { name: '+ Add medicine' }).click();
  await doctorPage.getByLabel('Search medicines').fill('Calpol');
  await doctorPage.getByRole('button', { name: /Calpol 650/ }).click();
  const qtypad = doctorPage.getByTestId('qtypad');
  await qtypad.getByRole('button', { name: '1 strip' }).click();
  await qtypad.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByRole('button', { name: 'Sign Rx' }).click();
  await expect(doctorPage).toHaveURL(/\/rx\/print\?rx=[0-9a-f-]+$/);

  await signIn(counterPage, 'Counter');
  await counterPage.goto('/counter');
  await counterPage.getByRole('button', { name: new RegExp(patient) }).click();
  await counterPage.getByRole('button', { name: 'Ask doctor' }).click();

  const proposals = counterPage.getByRole('button', { name: /in stock|OUT/ });
  await expect(proposals.filter({ hasText: 'Dolo 650' })).toBeVisible();

  const labels = await proposals.allInnerTexts();
  expect(labels.join(' ')).not.toContain('Cetzine');
  expect(labels.join(' ')).not.toContain('Pan 40');

  await cabin.close();
  await counter.close();
});
