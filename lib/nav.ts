import type { Route } from 'next';
import type { StaffRole } from '@/lib/db/admin';

/**
 * Every place a staff member can go, in one list. TABLET.md §3 — revised.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * Twenty-six screens, each hand-rolling its own action rail out of
 * `router.push` buttons. Three things followed from that, and all three were
 * reported as "the app is hard to navigate":
 *
 *   1. `/stock-take` had NO exit. Not a bad one — none. It was reachable from
 *      the counter and the only way back out was the browser's back button,
 *      which an installed PWA does not necessarily show. A screen can only be
 *      a dead end if each screen is responsible for its own doors, so the doors
 *      moved here, into the shell, where forgetting one is not possible.
 *
 *   2. Eleven screens hard-coded "Back" to `/counter` regardless of who was
 *      looking. An administrator finishing an import landed at the pharmacy
 *      counter and was then bounced to `/admin/home` by the guard in
 *      app/(clinic)/layout.tsx. The redirect had become the navigation.
 *
 *   3. Reachability was arbitrary. `/inventory` could reach `/receiving`;
 *      `/expiry`, which is the same job on the same stock, could reach only
 *      `/counter`.
 *
 * ── WHY THE LABELS ARE VERBS ────────────────────────────────────────────────
 *
 * The old control centre listed fourteen nouns — Medicines, Inventory,
 * Suppliers, Billing, Day book — which is a filing cabinet, not a workflow.
 * Nobody walks up to the counter thinking "Inventory". They think "these boxes
 * came in, put them on the shelf", and then they look for a door with that
 * written on it. `Add stock` is the same route `Receiving` always was; the
 * difference is that it now says what it is for.
 *
 * `noun` is kept because a few screens legitimately need the short form — a
 * page title, a breadcrumb — and because a pharmacist who has already learned
 * "Receiving" should not have to unlearn it.
 */
export interface Destination {
  href: Route;
  /** What the person is trying to DO. This is the label that gets rendered. */
  label: string;
  /** The short noun, for titles and breadcrumbs. */
  noun: string;
  /** One line, shown where there is room for it. */
  hint: string;
  group: NavGroup;
  /** Who may see the door at all. An empty list would mean nobody. */
  roles: readonly StaffRole[];
}

export type NavGroup = 'today' | 'stock' | 'buying' | 'money' | 'setup';

export const GROUP_LABEL: Record<NavGroup, string> = {
  today: 'Today',
  stock: 'Stock',
  buying: 'Buying',
  money: 'Money',
  setup: 'Setup',
};

const CLINICAL: readonly StaffRole[] = ['doctor', 'nurse'];
const PHARMACY: readonly StaffRole[] = ['counter'];
const ADMIN: readonly StaffRole[] = ['admin'];

/**
 * Ordered within each group by how often the job is actually done, not
 * alphabetically and not by how the tables relate. The first entry in a group
 * is the one that gets the primary treatment when the group is collapsed.
 */
export const DESTINATIONS: readonly Destination[] = [
  // ── Today ────────────────────────────────────────────────────────────────
  {
    href: '/queue',
    label: 'Waiting room',
    noun: 'Queue',
    hint: 'Who is here, in the order they arrived.',
    group: 'today',
    roles: [...CLINICAL],
  },
  {
    href: '/queue/new',
    label: 'Register a walk-in',
    noun: 'New patient',
    hint: 'Give somebody a token and put them in the queue.',
    group: 'today',
    roles: [...CLINICAL],
  },
  {
    href: '/counter',
    label: 'Dispense counter',
    noun: 'Counter',
    hint: 'Signed prescriptions waiting to be handed over.',
    group: 'today',
    roles: [...PHARMACY],
  },
  {
    href: '/counter/sale',
    label: 'Sell over the counter',
    noun: 'Counter sale',
    hint: 'A sale with no prescription behind it.',
    group: 'today',
    roles: [...PHARMACY],
  },
  {
    href: '/presence',
    label: 'Is the doctor in',
    noun: 'Presence',
    hint: 'What the waiting room screen is telling people.',
    group: 'today',
    roles: [...CLINICAL, ...ADMIN],
  },

  // ── Stock ────────────────────────────────────────────────────────────────
  //
  // `Add stock` is first, and deliberately. It is the job that prompted this
  // rework: it was called "Receiving", filed third under a "Stock work"
  // heading in a ten-button rail, while the screen actually named after the
  // noun somebody would look for — `/inventory` — is read-only by design and
  // offers no way to add anything at all.
  {
    href: '/receiving',
    label: 'Add stock',
    noun: 'Receiving',
    hint: 'Boxes have arrived — put them on the shelf.',
    group: 'stock',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/inventory',
    label: 'What is on the shelf',
    noun: 'Inventory',
    hint: 'Look up a medicine, its batches and what it is worth.',
    group: 'stock',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/expiry',
    label: 'What is expiring',
    noun: 'Expiry',
    hint: 'Return windows, and writing off what has gone off.',
    group: 'stock',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/stock-take',
    label: 'Count the shelf',
    noun: 'Stock-take',
    hint: 'Count what is physically there and correct the record.',
    group: 'stock',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/medicines',
    label: 'Medicine list',
    noun: 'Medicines',
    hint: 'Pack sizes, schedule and reorder levels.',
    group: 'stock',
    roles: [...ADMIN],
  },

  // ── Buying ───────────────────────────────────────────────────────────────
  {
    href: '/reorder',
    label: 'What to reorder',
    noun: 'Low stock',
    hint: 'What is running out, and drafting orders for it.',
    group: 'buying',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/orders',
    label: 'Purchase orders',
    noun: 'Orders',
    hint: 'Send an order on WhatsApp and record the reply.',
    group: 'buying',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/suppliers',
    label: 'Suppliers',
    noun: 'Suppliers',
    hint: 'Who to buy from, and how to reach them.',
    group: 'buying',
    roles: [...ADMIN],
  },

  // ── Money ────────────────────────────────────────────────────────────────
  {
    href: '/billing',
    label: 'Bills and payments',
    noun: 'Billing',
    hint: 'Take payment and reprint a bill.',
    group: 'money',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/day-book',
    label: 'Takings for the day',
    noun: 'Day book',
    hint: 'Cash in the till, and closing the day.',
    group: 'money',
    roles: [...PHARMACY, ...ADMIN],
  },
  {
    href: '/reports',
    label: 'Registers and reports',
    noun: 'Reports',
    hint: 'The statutory registers, ready to print.',
    group: 'money',
    roles: [...CLINICAL, ...PHARMACY, ...ADMIN],
  },

  // ── Setup ────────────────────────────────────────────────────────────────
  {
    href: '/admin/home',
    label: 'Control panel',
    noun: 'Administration',
    hint: 'Everything an administrator sets up.',
    group: 'setup',
    roles: [...ADMIN],
  },
  {
    href: '/admin',
    label: 'Staff and PINs',
    noun: 'Staff access',
    hint: 'Who can sign in, and as what.',
    group: 'setup',
    roles: [...ADMIN],
  },
  {
    href: '/settings',
    label: 'Clinic details',
    noun: 'Clinic settings',
    hint: 'Name, licences, opening hours and the fee.',
    group: 'setup',
    roles: [...ADMIN],
  },
  {
    href: '/import',
    label: 'Import from a file',
    noun: 'Import',
    hint: 'Load the medicine master or the opening shelf from CSV.',
    group: 'setup',
    roles: [...ADMIN],
  },
];

/** The doors this person may use, in group order. */
export function destinationsFor(role: StaffRole | null | undefined): Destination[] {
  if (!role) return [];
  return DESTINATIONS.filter((entry) => entry.roles.includes(role));
}

/** The groups this person has anything in, in the canonical order. */
export function groupsFor(role: StaffRole | null | undefined): NavGroup[] {
  const open = destinationsFor(role);
  const order: NavGroup[] = ['today', 'stock', 'buying', 'money', 'setup'];
  return order.filter((group) => open.some((entry) => entry.group === group));
}

/**
 * Which destination a path is "on".
 *
 * Longest match wins, so `/counter/sale` resolves to Counter sale rather than
 * to the Dispense counter it is nested under. Screens that are not doors in
 * their own right — /consult, /vitals, /patient, /counter/dispense — resolve to
 * null and let the shell fall back to the page's own title.
 */
export function destinationFor(pathname: string): Destination | null {
  let best: Destination | null = null;
  for (const entry of DESTINATIONS) {
    const on = pathname === entry.href || pathname.startsWith(`${entry.href}/`);
    if (on && (!best || entry.href.length > best.href.length)) best = entry;
  }
  return best;
}

/**
 * Where this person belongs when they have landed somewhere they may not be,
 * or have finished a job and there is nowhere obvious to return to.
 *
 * This is the one answer that used to be hard-coded as `/counter` on eleven
 * screens, which is why an administrator kept being deposited in the pharmacy.
 */
export function homeFor(role: StaffRole | null | undefined): Route {
  if (role === 'admin') return '/admin/home';
  if (role === 'counter') return '/counter';
  return '/queue';
}
