import { describe, expect, it } from 'vitest';
import type { StaffRole } from '@/lib/db/admin';
import {
  WORKSPACES,
  homeFor,
  resolveSection,
  resolveTab,
  tabsFor,
  whereIs,
  workspaceFor,
} from '@/lib/workspaces';

const ROLES: StaffRole[] = ['doctor', 'nurse', 'counter', 'admin'];

/**
 * Every panel key the desks can produce.
 *
 * This list is the contract with the PANELS table in components/Desk.tsx: a key
 * the desk can generate but the table does not answer renders `null`, which on
 * a tablet is a tab that opens onto a blank screen with no error and nothing to
 * report. Adding a tab or a section without adding its panel is exactly the
 * mistake this catches, and the failure message points at the file to fix.
 *
 * Kept as a literal rather than derived from WORKSPACES, because a test that
 * computes its own expectation from the thing under test asserts nothing.
 */
const EVERY_PANEL_KEY = [
  'clinical/waiting',
  'clinical/presence',
  'clinical/registers',
  'clinical/setup/clinic',
  'clinical/setup/import',

  'pharmacy/counter',
  'pharmacy/shelf/on-hand',
  'pharmacy/shelf/add-stock',
  'pharmacy/shelf/expiring',
  'pharmacy/shelf/count',
  'pharmacy/buying/low-stock',
  'pharmacy/buying/orders',
  'pharmacy/buying/suppliers',
  'pharmacy/medicines',
  'pharmacy/money/bills',
  'pharmacy/money/day-book',
  'pharmacy/money/registers',

  'admin/today',
  'admin/staff',
  'admin/clinic',
  'admin/catalogue/medicines',
  'admin/catalogue/suppliers',
  'admin/registers',
  'admin/import',
].sort();

/** The same key components/Desk.tsx builds, by the same rule. */
function keysFor(): string[] {
  const keys: string[] = [];
  for (const space of WORKSPACES) {
    for (const tab of space.tabs) {
      if (tab.sections && tab.sections.length > 0) {
        for (const section of tab.sections) keys.push(`${space.id}/${tab.id}/${section.id}`);
      } else {
        keys.push(`${space.id}/${tab.id}`);
      }
    }
  }
  return keys.sort();
}

describe('desks', () => {
  it('gives every role a home desk', () => {
    for (const role of ROLES) {
      expect(workspaceFor(role), `${role} has no desk`).not.toBeNull();
    }
    expect(workspaceFor('doctor')!.id).toBe('clinical');
    expect(workspaceFor('nurse')!.id).toBe('clinical');
    expect(workspaceFor('counter')!.id).toBe('pharmacy');
    expect(workspaceFor('admin')!.id).toBe('admin');
  });

  /**
   * The doctor is the proprietor and stands at two desks; everybody else at
   * one. This asserts the exception is exactly one role wide — the nurse in
   * particular must not inherit it, because the ward does not keep the shelf.
   */
  it('lets the doctor stand at the pharmacy, and nobody else borrow a second desk', () => {
    const desksFor = (role: StaffRole) =>
      WORKSPACES.filter((entry) => entry.roles.includes(role)).map((entry) => entry.id);

    expect(desksFor('doctor')).toEqual(['clinical', 'pharmacy']);
    expect(desksFor('nurse')).toEqual(['clinical']);
    expect(desksFor('counter')).toEqual(['pharmacy']);
    expect(desksFor('admin')).toEqual(['admin']);
  });

  it('gives nobody a desk when nobody is signed in', () => {
    expect(workspaceFor(null)).toBeNull();
    expect(workspaceFor(undefined)).toBeNull();
    expect(tabsFor(WORKSPACES[0]!, null)).toEqual([]);
  });

  it('can reach a panel from every tab and section it offers', () => {
    expect(keysFor()).toEqual(EVERY_PANEL_KEY);
  });

  it('shows every role at least one tab on its own desk', () => {
    for (const role of ROLES) {
      const space = workspaceFor(role)!;
      expect(tabsFor(space, role).length, `${role} sees no tabs`).toBeGreaterThan(0);
    }
  });
});

describe('resolveTab', () => {
  it('lands somewhere real when the tab is missing, misspelt or forbidden', () => {
    const pharmacy = workspaceFor('counter')!;

    for (const asked of [null, 'nonsense', 'import', '']) {
      const tab = resolveTab(pharmacy, 'counter', asked);
      expect(tab, `"${asked}" resolved to nothing`).not.toBeNull();
      expect(tab!.id).toBe('counter');
    }
  });

  it('honours a tab that is really there', () => {
    const pharmacy = workspaceFor('counter')!;
    expect(resolveTab(pharmacy, 'counter', 'shelf')!.id).toBe('shelf');
  });

  it('resolves nothing for a role with no business on the desk', () => {
    const pharmacy = workspaceFor('counter')!;

    // The nurse, not the doctor: the doctor is the proprietor and may stand at
    // the pharmacy. components/Desk.tsx turns this null into a redirect to the
    // reader's own desk, so a nurse typing /counter gets the ward, not a blank
    // screen.
    expect(resolveTab(pharmacy, 'nurse', 'shelf')).toBeNull();
    expect(resolveTab(pharmacy, 'doctor', 'shelf')?.id).toBe('shelf');
  });
});

describe('resolveSection', () => {
  it('falls back to the first job in the tab', () => {
    const pharmacy = workspaceFor('counter')!;
    const shelf = resolveTab(pharmacy, 'counter', 'shelf')!;

    expect(resolveSection(shelf, null)!.id).toBe('on-hand');
    expect(resolveSection(shelf, 'nonsense')!.id).toBe('on-hand');
    expect(resolveSection(shelf, 'add-stock')!.id).toBe('add-stock');
  });

  it('is null for a tab that is one job', () => {
    const pharmacy = workspaceFor('counter')!;
    const counter = resolveTab(pharmacy, 'counter', 'counter')!;
    expect(resolveSection(counter, null)).toBeNull();
  });
});

/**
 * The forwarding stubs at the twenty old routes all resolve through this, so a
 * wrong answer here is a pinned home screen that opens on the wrong screen —
 * or, worse, silently on the desk's front page as though nothing was asked for.
 */
describe('whereIs', () => {
  const CASES: [StaffRole, string, string][] = [
    // The pharmacist's shelf, which is the point of the rework.
    ['counter', 'on-hand', '/counter?tab=shelf&section=on-hand'],
    ['counter', 'add-stock', '/counter?tab=shelf&section=add-stock'],
    ['counter', 'expiring', '/counter?tab=shelf&section=expiring'],
    ['counter', 'count', '/counter?tab=shelf&section=count'],
    ['counter', 'low-stock', '/counter?tab=buying&section=low-stock'],
    ['counter', 'orders', '/counter?tab=buying&section=orders'],
    ['counter', 'suppliers', '/counter?tab=buying&section=suppliers'],
    ['counter', 'medicines', '/counter?tab=medicines'],
    ['counter', 'bills', '/counter?tab=money&section=bills'],
    ['counter', 'day-book', '/counter?tab=money&section=day-book'],
    ['counter', 'registers', '/counter?tab=money&section=registers'],

    // The owner keeps the same masters in a different place, which is the
    // whole reason the stubs resolve per-role instead of hard-coding a URL.
    ['admin', 'medicines', '/admin/home?tab=catalogue&section=medicines'],
    ['admin', 'suppliers', '/admin/home?tab=catalogue&section=suppliers'],
    ['admin', 'staff', '/admin/home?tab=staff'],
    ['admin', 'clinic', '/admin/home?tab=clinic'],
    ['admin', 'import', '/admin/home?tab=import'],
    ['admin', 'registers', '/admin/home?tab=registers'],

    ['doctor', 'presence', '/queue?tab=presence'],
    ['doctor', 'registers', '/queue?tab=registers'],
    ['nurse', 'waiting', '/queue?tab=waiting'],

    // The doctor as proprietor. Every one of these allows `doctor` in the
    // screen's own permission check and always has; the first draft of the
    // desks left the doctor unable to reach any of them, which the E2E suite
    // caught as eight separate failures.
    //
    // The first four resolve to the PHARMACY desk even though the doctor's home
    // is the consulting room — that is the whole reason whereIs searches past
    // the home desk.
    ['doctor', 'bills', '/counter?tab=money&section=bills'],
    ['doctor', 'orders', '/counter?tab=buying&section=orders'],
    ['doctor', 'count', '/counter?tab=shelf&section=count'],
    ['doctor', 'add-stock', '/counter?tab=shelf&section=add-stock'],

    // These two have no pharmacy home, and the administration desk that holds
    // them is closed to a doctor, so they sit on the doctor's own desk.
    ['doctor', 'clinic', '/queue?tab=setup&section=clinic'],
    ['doctor', 'import', '/queue?tab=setup&section=import'],
  ];

  it.each(CASES)('sends a %s asking for "%s" to %s', (role, job, expected) => {
    expect(whereIs(role, job)).toBe(expected);
  });

  it('lands on the desk rather than nowhere when the job is not theirs', () => {
    // A pharmacist following a link to staff administration: they may not have
    // it, so they get their own desk instead of a blank screen.
    expect(whereIs('counter', 'staff')).toBe('/counter');
    // The nurse does not inherit the doctor's second desk.
    expect(whereIs('nurse', 'add-stock')).toBe('/queue');
    expect(whereIs('nurse', 'clinic')).toBe('/queue');
    expect(whereIs('admin', 'nonsense')).toBe('/admin/home');
  });

  it('falls back to the sign-in home when nobody is signed in', () => {
    expect(whereIs(null, 'medicines')).toBe(homeFor(null));
  });
});
