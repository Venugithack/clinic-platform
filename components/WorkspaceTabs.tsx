'use client';

import Link from 'next/link';
import type { Route } from 'next';
import type { StaffRole } from '@/lib/db/admin';
import {
  tabsFor,
  type Workspace,
  type WorkspaceSection,
  type WorkspaceTab,
} from '@/lib/workspaces';

/**
 * The jobs on this desk, on the screen, all the time.
 *
 * ── WHY THIS IS NOT A MENU ──────────────────────────────────────────────────
 *
 * `AppNav` was a drawer: twenty destinations in five groups, opened by a "Go
 * to" button and closed again on arrival. Everything it offered was one tap
 * away from being invisible, which is why the screens ended up describing it in
 * prose — the counter literally read "Stock and purchasing live under Go to."
 * A screen that has to give directions to its own navigation has already lost.
 *
 * A strip cannot do that. Every job on this desk is spelled out, in view, and
 * the one you are on is marked.
 *
 * ── REAL LINKS ──────────────────────────────────────────────────────────────
 *
 * Kept from AppNav, for the reason AppNav gave: a <Link> is prefetched when it
 * enters the viewport and a `router.push` on a <button> is not, and on a
 * clinic's connection that difference was most of what "slow to move around"
 * actually was.
 *
 * ── THE TAB LIVES IN THE URL ────────────────────────────────────────────────
 *
 * `?tab=` and `?section=` rather than component state, so the back button
 * works, a refresh keeps you where you were, and one pharmacist can read a URL
 * out to another. On a tablet four people share, coming back to where you left
 * off is not a nicety — the alternative is landing on the dispensing queue
 * every time the screen sleeps in the middle of a stock-take.
 */
export function WorkspaceTabs({
  space,
  role,
  activeTab,
  activeSection,
}: {
  space: Workspace;
  role: StaffRole | null | undefined;
  activeTab: WorkspaceTab | null;
  activeSection: WorkspaceSection | null;
}) {
  const tabs = tabsFor(space, role);
  if (tabs.length === 0) return null;

  const sections = activeTab?.sections ?? [];

  return (
    <div className="shrink-0" data-print="hide">
      {tabs.length > 1 ? (
        <nav
          aria-label={`${space.label} sections`}
          className="flex gap-1 overflow-x-auto border-b-2 border-ink bg-sheet px-2 py-1.5"
        >
          {tabs.map((tab) => {
            const here = tab.id === activeTab?.id;
            return (
              <Strip
                key={tab.id}
                href={`${space.href}?tab=${tab.id}` as Route}
                label={tab.label}
                hint={tab.hint}
                here={here}
                weight="primary"
              />
            );
          })}
        </nav>
      ) : null}

      {/* The second strip belongs to the tab above it, so it is quieter and it
          disappears with the tab rather than persisting as furniture. A tab
          with one job renders no strip at all — a control with a single option
          is a label pretending to be a choice. */}
      {sections.length > 1 ? (
        <nav
          aria-label={`${activeTab?.label} jobs`}
          className="flex gap-1 overflow-x-auto border-b border-rule bg-paper px-2 py-1"
        >
          {sections.map((section) => (
            <Strip
              key={section.id}
              href={`${space.href}?tab=${activeTab?.id}&section=${section.id}` as Route}
              label={section.label}
              hint={section.hint}
              here={section.id === activeSection?.id}
              weight="secondary"
            />
          ))}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * One entry on either strip. 44px tall on both, because TABLET.md §2 rule 2
 * does not get a discount for being the second row — a pharmacist reaching for
 * "Add stock" is not aiming more carefully because it is a subheading.
 */
function Strip({
  href,
  label,
  hint,
  here,
  weight,
}: {
  href: Route;
  label: string;
  hint: string;
  here: boolean;
  weight: 'primary' | 'secondary';
}) {
  const shape =
    weight === 'primary'
      ? here
        ? 'border-ink bg-ink text-paper'
        : 'border-transparent text-ink-2 active:bg-paper-2'
      : here
        ? 'border-ink bg-paper-2 text-ink'
        : 'border-transparent text-ink-2 active:bg-paper-2';

  return (
    <Link
      href={href}
      title={hint}
      aria-current={here ? 'page' : undefined}
      className={`flex h-11 shrink-0 items-center rounded-box border px-4 text-sm font-semibold tracking-[0.02em] active:opacity-80 ${shape}`}
    >
      {label}
    </Link>
  );
}
