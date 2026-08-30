import type { Route } from 'next';
import type { StaffRole } from '@/lib/db/admin';

/**
 * Three desks, the tabs on each, and the sections inside a tab.
 * This replaces `lib/nav.ts`.
 *
 * ── WHAT WAS WRONG WITH TWENTY DOORS ────────────────────────────────────────
 *
 * `lib/nav.ts` diagnosed the problem correctly — "fourteen nouns is a filing
 * cabinet, not a workflow" — and then fixed the labels instead of the doors.
 * `Receiving` became `Add stock`, which is a better name for a door nobody
 * should have had to go looking for. Twenty well-named doors behind a drawer is
 * still a drawer, and the counter screen had been reduced to giving directions
 * to it: "Stock and purchasing live under Go to."
 *
 * A pharmacist does not navigate. They stand at one counter and the work comes
 * to them. So the unit is not the screen, it is the DESK: everything one person
 * does is on one screen, and reaching any of it is reading, not remembering.
 *
 * ── TWO STRIPS, AND WHY THAT IS NOT THE DRAWER AGAIN ────────────────────────
 *
 * Some tabs cover more than one job. The shelf is looked at, added to, counted
 * and weeded — four jobs over one set of boxes. Rather than four tabs (which is
 * how twenty doors happened in the first place) a tab may carry SECTIONS, and
 * both strips are on the screen at all times.
 *
 * The difference from the drawer is not the depth, it is the visibility. A
 * drawer is always one tap away from showing nothing; a strip is always showing
 * everything. Nobody has to be told where the shelf is, because the word Shelf
 * is already in front of them. Two levels is the limit — a section may not have
 * sections of its own.
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 *
 * By how often the job is really done, because the first tab is what is open
 * when nobody has touched the tablet:
 *
 *   Counter    many times an hour — somebody is standing there
 *   Shelf      weekly — a delivery arrives, or something runs out
 *   Buying     weekly — ordering it
 *   Medicines  rarely, but URGENTLY, which is the whole point (see below)
 *   Money      daily, at the end of it
 *
 * ── STOCK AND SUPPLIERS BELONG TO THE PHARMACY ──────────────────────────────
 *
 * They were split across `stock`, `buying` and `setup` groups, and `/medicines`
 * and `/suppliers` were administrator-only. That produced the dead end this
 * rework exists to remove: a delivery arrives containing a medicine that is not
 * in the master, the pharmacist opens Add stock, cannot find it, and cannot add
 * it either — the screen refused them with "Only an administrator can manage
 * the medicine master." The boxes are on the counter, somebody is waiting, and
 * the answer was to go and find the owner.
 *
 * The shelf is the pharmacist's. So is the list of what may sit on it, and the
 * list of people it is bought from. See
 * `supabase/migrations/20260830120000_pharmacy_owns_the_shelf.sql`, which is
 * the half of this that a change up here could not do on its own.
 */
export interface WorkspaceSection {
  id: string;
  /** What the person is doing here. Rendered on the strip. */
  label: string;
  /** One line, for the strip's title attribute. */
  hint: string;
}

export interface WorkspaceTab {
  id: string;
  label: string;
  hint: string;
  /** Who may see this tab. A tab nobody may see is not rendered. */
  roles: readonly StaffRole[];
  /** The jobs inside this tab. Absent means no second strip. */
  sections?: readonly WorkspaceSection[];
}

export interface Workspace {
  id: WorkspaceId;
  href: Route;
  /** Whose desk this is. */
  label: string;
  roles: readonly StaffRole[];
  tabs: readonly WorkspaceTab[];
}

export type WorkspaceId = 'clinical' | 'pharmacy' | 'admin';

const CLINICAL: readonly StaffRole[] = ['doctor', 'nurse'];
const ADMIN: readonly StaffRole[] = ['admin'];

/**
 * The pharmacy desk, and who may stand at it.
 *
 * The doctor is on this list, and that is not generosity — it is what the app
 * has always done. Only `/admin` was ever role-gated; every other screen was
 * reachable by anybody who typed its URL, and the E2E suite drives the doctor
 * through billing, dispensing, receiving goods and sending purchase orders
 * because in a clinic this size the doctor IS the proprietor and does all of
 * it after hours.
 *
 * The first draft of this file gave each role exactly one desk, which was a
 * tidier model than the clinic. It cost the doctor eight screens, and the way
 * it cost them was the worst kind: not a refusal, which tells you where you
 * stand, but a redirect to their own desk as though they had never asked.
 *
 * The nurse is deliberately NOT here. The ward does not keep the shelf.
 */
const PHARMACY: readonly StaffRole[] = ['counter', 'doctor'];

/**
 * The doctor, wearing the owner's hat.
 *
 * In this clinic the doctor IS the proprietor, and four screens have always
 * said so in their own permission checks rather than in any navigation:
 * `/settings` and `/import` allow `doctor || admin`, the purchase order screen
 * says "The doctor sends orders." in as many words, and a stock-take is posted
 * by somebody other than whoever counted it.
 *
 * The first draft of this file missed all four, because it modelled the doctor
 * as purely clinical. The screens still refused nobody — but the doctor could
 * no longer GET to them, which is a worse bug than a refusal: a refusal tells
 * you where you stand.
 */
const OWNER: readonly StaffRole[] = ['doctor'];

export const WORKSPACES: readonly Workspace[] = [
  {
    id: 'clinical',
    href: '/queue',
    label: 'Consulting room',
    roles: CLINICAL,
    tabs: [
      {
        id: 'waiting',
        label: 'Waiting room',
        hint: 'Who is here, in the order they arrived.',
        roles: CLINICAL,
      },
      {
        id: 'presence',
        label: 'Is the doctor in',
        hint: 'What the waiting room screen is telling people.',
        roles: CLINICAL,
      },
      {
        id: 'registers',
        label: 'Registers',
        hint: 'The statutory registers, ready to print.',
        roles: CLINICAL,
      },
      {
        // Approving an order and posting a count are the doctor's too, but they
        // live on the pharmacy desk where the rest of that work is — the doctor
        // can stand there. Only the two jobs with no pharmacy home are here,
        // because the administration desk is closed to a doctor by
        // app/(clinic)/layout.tsx and these two screens allow `doctor` in their
        // own permission checks.
        id: 'setup',
        label: 'Clinic',
        hint: 'The details that print on a bill, and loading a file.',
        roles: OWNER,
        sections: [
          {
            id: 'clinic',
            label: 'Details',
            hint: 'Name, licences, opening hours and the fee.',
          },
          {
            id: 'import',
            label: 'Import',
            hint: 'Load the medicine master or the opening shelf from a file.',
          },
        ],
      },
    ],
  },
  {
    id: 'pharmacy',
    href: '/counter',
    label: 'Pharmacy',
    roles: PHARMACY,
    tabs: [
      {
        id: 'counter',
        label: 'Counter',
        hint: 'Signed prescriptions waiting to be handed over.',
        roles: PHARMACY,
      },
      {
        id: 'shelf',
        label: 'Shelf',
        hint: 'What is on it, putting a delivery away, and what is going off.',
        roles: PHARMACY,
        sections: [
          {
            id: 'on-hand',
            label: 'What is on it',
            hint: 'Look up a medicine, its batches and what it is worth.',
          },
          {
            id: 'add-stock',
            label: 'Add stock',
            hint: 'Boxes have arrived — put them on the shelf.',
          },
          {
            id: 'expiring',
            label: 'Expiring',
            hint: 'Return windows, and writing off what has gone off.',
          },
          {
            id: 'count',
            label: 'Count it',
            hint: 'Count what is physically there and correct the record.',
          },
        ],
      },
      {
        id: 'buying',
        label: 'Buying',
        hint: 'What is running out, who to buy it from, and the orders sent.',
        roles: PHARMACY,
        sections: [
          {
            id: 'low-stock',
            label: 'Running out',
            hint: 'What is low, and drafting an order for it.',
          },
          {
            id: 'orders',
            label: 'Orders',
            hint: 'Send an order on WhatsApp and record the reply.',
          },
          {
            id: 'suppliers',
            label: 'Suppliers',
            hint: 'Who to buy from, and how to reach them.',
          },
        ],
      },
      {
        id: 'medicines',
        label: 'Medicines',
        hint: 'Every medicine the shelf may hold. Add one here.',
        roles: PHARMACY,
      },
      {
        id: 'money',
        label: 'Money',
        hint: 'Payments taken, and closing the day.',
        roles: PHARMACY,
        sections: [
          { id: 'bills', label: 'Bills', hint: 'Take payment and reprint a bill.' },
          { id: 'day-book', label: 'Day book', hint: 'Cash in the till, and closing the day.' },
          { id: 'registers', label: 'Registers', hint: 'The statutory registers, ready to print.' },
        ],
      },
    ],
  },
  {
    id: 'admin',
    href: '/admin/home',
    label: 'Administration',
    roles: ADMIN,
    tabs: [
      {
        id: 'today',
        label: 'Today',
        hint: 'What the clinic has done since it opened.',
        roles: ADMIN,
      },
      {
        id: 'staff',
        label: 'Staff',
        hint: 'Who can sign in, and as what.',
        roles: ADMIN,
      },
      {
        id: 'clinic',
        label: 'Clinic',
        hint: 'Name, licences, opening hours and the fee.',
        roles: ADMIN,
      },
      {
        // The pharmacy owns the shelf, but the owner is barred from the
        // pharmacy desk entirely by app/(clinic)/layout.tsx, so the masters
        // have to be reachable from here too. Same panels, different desk.
        id: 'catalogue',
        label: 'Catalogue',
        hint: 'The medicines the shelf may hold, and who they are bought from.',
        roles: ADMIN,
        sections: [
          { id: 'medicines', label: 'Medicines', hint: 'Every medicine the shelf may hold.' },
          { id: 'suppliers', label: 'Suppliers', hint: 'Who to buy from, and how to reach them.' },
        ],
      },
      {
        id: 'registers',
        label: 'Registers',
        hint: 'The statutory registers, ready to print.',
        roles: ADMIN,
      },
      {
        id: 'import',
        label: 'Import',
        hint: 'Load the medicine master or the opening shelf from a file.',
        roles: ADMIN,
      },
    ],
  },
];

/** The desk this person works at. Everyone has exactly one. */
export function workspaceFor(role: StaffRole | null | undefined): Workspace | null {
  if (!role) return null;
  return WORKSPACES.find((space) => space.roles.includes(role)) ?? null;
}

/** The tabs this person may see on a desk, in order. */
export function tabsFor(space: Workspace, role: StaffRole | null | undefined): WorkspaceTab[] {
  if (!role) return [];
  return space.tabs.filter((tab) => tab.roles.includes(role));
}

/**
 * Which tab a `?tab=` value means.
 *
 * Falls back to the first tab this person may see rather than to a fixed id: a
 * forbidden or misspelt value has to land somewhere real, and "somewhere real"
 * differs by role.
 */
export function resolveTab(
  space: Workspace,
  role: StaffRole | null | undefined,
  requested: string | null,
): WorkspaceTab | null {
  const open = tabsFor(space, role);
  if (open.length === 0) return null;
  return open.find((tab) => tab.id === requested) ?? open[0] ?? null;
}

/** Which section a `?section=` value means, within an already-resolved tab. */
export function resolveSection(
  tab: WorkspaceTab | null,
  requested: string | null,
): WorkspaceSection | null {
  if (!tab?.sections || tab.sections.length === 0) return null;
  return tab.sections.find((section) => section.id === requested) ?? tab.sections[0] ?? null;
}

/**
 * Where a job lives on this person's desk.
 *
 * The same job sits in different places for different people: the pharmacist
 * keeps suppliers under Buying, and the owner — barred from the pharmacy desk
 * by the clinic layout — keeps them under Catalogue. Rather than a table of
 * every old URL against every role, the ids are searched. A tab id wins over a
 * section id, and anything unrecognised lands on the desk itself rather than on
 * a blank screen.
 *
 * This is what the redirect stubs left at the old routes use, so a bookmark, a
 * PWA shortcut or an E2E test that still says `/receiving` arrives at Add stock
 * on whichever desk the reader actually works at.
 */
export function findJob(role: StaffRole | null | undefined, job: string): Route | null {
  const home = workspaceFor(role);
  if (!home || !role) return null;

  // Home desk first, then any other desk this person may stand at — the doctor
  // has two, and a job they do at the pharmacy must not resolve to their own
  // desk just because that is where they start the day.
  const desks = [home, ...WORKSPACES.filter((s) => s !== home && s.roles.includes(role))];

  for (const space of desks) {
    const open = tabsFor(space, role);

    const asTab = open.find((tab) => tab.id === job);
    if (asTab) return `${space.href}?tab=${asTab.id}` as Route;

    for (const tab of open) {
      const asSection = tab.sections?.find((section) => section.id === job);
      if (asSection) return `${space.href}?tab=${tab.id}&section=${asSection.id}` as Route;
    }
  }

  return null;
}

/** As `findJob`, but never null: an unplaceable job lands on the reader's desk. */
export function whereIs(role: StaffRole | null | undefined, job: string): Route {
  return findJob(role, job) ?? homeFor(role);
}

/** Where this person belongs when they land somewhere they may not be. */
export function homeFor(role: StaffRole | null | undefined): Route {
  return workspaceFor(role)?.href ?? '/queue';
}
