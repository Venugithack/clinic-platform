import { expect, test } from '@playwright/test';
import { markClinicScreen, signIn } from './support/session';

/**
 * The M6 gate (PLAN.md §8, §13).
 *
 *   "Doctor logs in → status live in 30s. Laptop shut → 'away' within 5 min.
 *    Closing time → 'closed' regardless of session."
 *
 * The middle one is a five-minute wait and the last is a clock change, so both
 * are proved against the database in `A2_presence.sql` where the clock can be
 * moved. What a browser adds — and what pgTAP cannot see — is the WORDING. The
 * whole feature is worth nothing if the page says "available", because a
 * patient reads that as a promise and drives twenty kilometres on it.
 *
 * Serial: it changes one clinic's status.
 */
test.describe.configure({ mode: 'serial' });

test('he taps "in clinic" and the public page says so, with an as-of', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const doctorPage = await cabin.newPage();

  // The consulting-room screen is marked first, by the administrator, the way
  // it would be on the day the clinic opens. Presence is refused from an
  // unmarked browser — see the test below, which is the same rule from the
  // other side — so without this step the doctor cannot say he is here at all.
  await markClinicScreen(doctorPage, 'Consulting room');

  await signIn(doctorPage, 'Dr Seed');
  await doctorPage.goto('/presence');
  await doctorPage.getByRole('button', { name: 'In clinic', exact: true }).click();
  await expect(doctorPage.getByText('Patients now see: in the clinic.')).toBeVisible();

  // A patient's phone: no session, no device token, nothing.
  const publicCtx = await browser.newContext();
  const phone = await publicCtx.newPage();
  await phone.goto('/now');

  await expect(phone.getByTestId('status')).toContainText('Dr Seed is in the clinic');
  await expect(phone.getByTestId('as-of')).toContainText('as of');

  // Rule 6, as a word check. "Available" is a promise; "in the clinic, as of
  // two minutes ago" is a reading.
  const body = await phone.locator('body').innerText();
  expect(body.toLowerCase()).not.toContain('available');

  await cabin.close();
  await publicCtx.close();
});

test('his laptop at home signs in fine, and cannot say he is in the clinic', async ({
  page,
}) => {
  // A browser nobody has marked, which is every browser by default — the weekly
  // "logged in from home to check something", which on a naive presence model
  // tells every patient he is at his desk in the clinic.
  //
  // This assertion was passing for the wrong reason until the marker came back:
  // with device identity gone from sign-in, NO screen could set presence, so a
  // test that the laptop cannot was true of the consulting room too. It only
  // means something now that the test above passes.
  await signIn(page, 'Dr Seed');
  await page.goto('/presence');
  await page.getByRole('button', { name: 'In clinic', exact: true }).click();

  await expect(page.getByText(/not registered as a clinic device/)).toBeVisible();
});

test('stepping out says when he is back, and closing the clinic beats all of it', async ({
  browser,
}) => {
  const cabin = await browser.newContext();
  const doctorPage = await cabin.newPage();
  const publicCtx = await browser.newContext();
  const phone = await publicCtx.newPage();

  await signIn(doctorPage, 'Dr Seed');
  await doctorPage.goto('/presence');

  // "Back by 14:30" — one tap on the way out, and it survives the tablet
  // sitting on his desk pinging every thirty seconds.
  await doctorPage.getByRole('button', { name: 'Back by…' }).click();
  for (const digit of '2330') {
    await doctorPage.getByRole('button', { name: digit, exact: true }).click();
  }
  await doctorPage.getByRole('button', { name: 'Tell patients' }).click();
  await expect(doctorPage.getByText('Patients now see: stepped out.')).toBeVisible();

  await phone.goto('/now');
  await expect(phone.getByTestId('status')).toContainText('has stepped out');
  await expect(phone.getByText(/Back by/)).toBeVisible();

  // The hard close: he is signed in, his tablet is awake, and the answer is
  // still "closed" — because the clinic is what is closed, not him.
  await doctorPage.getByRole('button', { name: 'Close the clinic today' }).click();
  await doctorPage.getByLabel(/Why\? Patients will be told this/).fill('called away');
  await doctorPage.getByRole('button', { name: 'Close today', exact: true }).click();
  await expect(doctorPage.getByText(/^Closed\./)).toBeVisible();

  await phone.reload();
  await expect(phone.getByTestId('status')).toContainText('is closed right now');

  // And it can be undone, which matters because the tests after this one share
  // the clinic.
  await doctorPage.getByRole('button', { name: 'Open the clinic again' }).click();
  await expect(doctorPage.getByText('Open again.')).toBeVisible();

  await phone.reload();
  await expect(phone.getByTestId('status')).not.toContainText('is closed right now');

  await cabin.close();
  await publicCtx.close();
});
