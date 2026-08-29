import { expect, test } from '@playwright/test';
import { signIn, signInAndOpen } from './support/session';

/**
 * The control panel is where an administrator's back-office work is gathered.
 *
 * Its cards carry a title AND a one-line description, so the accessible name of
 * the staff card is "Staff access Doctors, nurses, pharmacy/counter staff,
 * administrators and their PINs." — matching it exactly finds nothing. This
 * spec used to get away with `exact: true` because the same words also sat on
 * a rail button beside the cards; that rail was navigation wearing an action
 * rail's clothes and moved into the Go to sheet, which left the exact matches
 * pointing at something that no longer exists.
 */
const CARDS = [
  /^Staff access/,
  /^Import medicine master/,
  /^Opening stock/,
  /^Suppliers/,
  /^Low stock & reorder/,
  /^Purchase orders/,
  /^Receiving/,
  /^Clinic settings/,
];

test('admin opens one control center for setup, go-live data and back-office work', async ({ page }) => {
  // An administrator is offered "Open the control panel" and lands on
  // /admin/home directly — there is no queue in between. This spec asked for
  // "Open the queue" and then for an "Administration" button on the queue rail,
  // and both had been gone since the roles were separated.
  await signInAndOpen(page, 'Admin');

  await expect(page.getByRole('heading', { name: 'Clinic control center', level: 1 }))
    .toBeVisible();

  for (const card of CARDS) {
    await expect(page.getByRole('button', { name: card })).toBeVisible();
  }

  await expect(page.getByRole('button', { name: /Printing/ })).toHaveCount(0);

  await page.getByRole('button', { name: /^Staff access/ }).click();
  await expect(page.getByRole('heading', { name: 'Staff access', level: 1 })).toBeVisible();
});

test('counter staff cannot use the admin control center', async ({ page }) => {
  await signIn(page, 'Counter');
  await page.goto('/admin/home');

  // Turned away rather than shown a refusal. The layout guard now mirrors the
  // one that keeps administrators off the operational screens, so a
  // non-administrator who types the URL is returned to their own home before
  // the roster renders — the point being that they never see it at all.
  await expect(page).toHaveURL(/\/counter$/);
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
});
