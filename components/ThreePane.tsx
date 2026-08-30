'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { currentSession, lock, type StaffSession } from '@/lib/auth';
import { workspaceFor } from '@/lib/workspaces';

/**
 * The clinic shell. TABLET.md §3, revised for the devices that actually exist.
 *
 * ── WHY THIS IS NOT THREE PANES ANY MORE ────────────────────────────────────
 *
 * TABLET.md §3 specifies "1024–1366 CSS px, landscape. Not a phone breakpoint
 * that grew." That was right, and the app was built to it: a fixed
 * `grid-cols-[2.75rem_280px_minmax(0,1fr)_200px]`, four responsive utilities in
 * the entire codebase, `userScalable: false`, and rule 7 locking landscape.
 *
 * Then PR #29 deleted device trust. Staff no longer sign in on two registered
 * tablets on stands — they open the clinic URL on whatever is in their hand,
 * and in practice that is the two stands, personal phones, and a tablet held
 * in portrait. The layout premise had quietly stopped being true, and 524px of
 * fixed furniture on a 390px phone is not a cramped screen, it is a broken one.
 *
 * So the geometry now bends and the rules survive where they still mean
 * something:
 *
 *   base   phone. One column. Context folds into a disclosure; the rail
 *          becomes a bottom sheet with the primary action hoisted out of it so
 *          the thing you came to do is never behind a tap.
 *   md     portrait tablet. Context returns as a real column at 240px, the
 *          rail stays a bottom sheet — there is width to spare here but not
 *          520px of it.
 *   lg     the stands, landscape. The three panes as designed.
 *   xl     wider, and the panes get the room back that §3 allowed for.
 *
 * Rules 1, 2, 3 and 8 are untouched — no hover, 44px targets, the numpad, and
 * a second gesture for anything destructive. Rule 7, landscape lock, is the one
 * casualty, and it was already a casualty; this only stops pretending.
 *
 * ── THE 44px BRAND STRIP IS GONE, AND ON PURPOSE ────────────────────────────
 *
 * It spent a full column saying whose clinic this is and gave nothing back. The
 * identity moved into the top bar, which had to exist anyway: every screen now
 * says where you are and offers the way out, which is the pair of questions
 * twenty-six hand-rolled rails kept failing to answer.
 */
export function ThreePane({
  context,
  tabs,
  rail,
  primary,
  safety,
  children,
}: {
  context?: React.ReactNode;
  /**
   * The other jobs on this desk — see components/WorkspaceTabs.
   *
   * Rendered under the top bar at every width and outside the scrolling work
   * area, so it cannot be scrolled away mid-task. A desk with only one job
   * passes nothing and gets no strip.
   */
  tabs?: React.ReactNode;
  rail?: React.ReactNode;
  /**
   * The one action this screen exists to perform.
   *
   * Optional, and the shell is correct without it — the action is still in the
   * rail. Naming it here is what lets a phone show it in the bottom bar
   * instead of behind "Actions", so `Post receipt` costs one tap on a 390px
   * screen and not two.
   */
  primary?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    tone?: 'primary' | 'danger';
  };
  /**
   * Who this screen is about, and what would harm them.
   *
   * Rendered at every width, above the work, and never inside the `Details`
   * disclosure. That disclosure was a mistake applied uniformly: folding the
   * context pane away on a phone is right for a supplier's lead time and wrong
   * for an allergy, and /consult and /counter/dispense kept both in the same
   * pane. So a doctor on a phone could reach the prescribe button with the
   * allergy banner one tap out of sight, which is the one thing this shell must
   * not allow.
   *
   * Sticky, because scrolling a long prescription must not scroll it away
   * either.
   */
  safety?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [session, setSession] = useState<StaffSession | null>(null);

  // Read after mount, never during render: currentSession() touches
  // localStorage, and the export is prerendered at build time where there is
  // no window. Reading it in render is what makes a static export hydrate to
  // different markup than it shipped.
  useEffect(() => setSession(currentSession()), [pathname]);

  // Arriving somewhere closes whatever was open over the last screen.
  useEffect(() => {
    setActionsOpen(false);
    setDetailsOpen(false);
  }, [pathname]);

  // Whose desk this is. It used to be "which of twenty destinations is this
  // path", which is a question that stopped existing when the destinations
  // became tabs on one screen.
  const desk = workspaceFor(session?.role);

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={desk?.label ?? null}
        session={session}
        onSignOut={() => void lock().then(() => router.replace('/'))}
      />

      {tabs}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)_200px] xl:grid-cols-[320px_minmax(0,1fr)_220px]">
        {context ? (
          <aside
            className="hidden min-w-0 overflow-y-auto border-r border-rule bg-sheet p-4 md:block"
            data-pane="context"
          >
            {context}
          </aside>
        ) : null}

        {/* min-w-0 is load-bearing: a `1fr` track is minmax(auto, 1fr), and
            that auto minimum is the track's CONTENT minimum — without this a
            wide register or an unbreakable drug name pushes the grid past the
            viewport and the right-hand columns become unreachable rather than
            merely ugly. Kept from the original, where it was the fix for
            exactly that bug. */}
        <main
          className="flex min-w-0 flex-col gap-4 overflow-y-auto p-4 lg:p-5"
          data-pane="work"
        >
          {safety ? (
            <div className="sticky -top-4 z-30 -mx-4 border-b-2 border-ink bg-paper px-4 py-2 lg:-top-5 lg:-mx-5 lg:px-5">
              {safety}
            </div>
          ) : null}
          {/* The context pane's content is not optional information — it is who
              the patient is and what the total comes to. On a phone it folds
              rather than disappears. */}
          {context ? (
            <div className="md:hidden" data-print="hide">
              <button
                type="button"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((current) => !current)}
                className="h-11 w-full rounded-box border border-rule bg-sheet px-3 text-left text-sm font-semibold uppercase tracking-[0.08em] text-ink-2 active:bg-paper-2"
              >
                {detailsOpen ? 'Hide details' : 'Details'}
              </button>
              {detailsOpen ? (
                <div className="mt-2 rounded-box border border-rule bg-sheet p-4">
                  {context}
                </div>
              ) : null}
            </div>
          ) : null}

          {children}

          {/* The bottom bar is fixed, so the last thing on the page would sit
              under it. This is that gap, and it exists only where the bar
              does. */}
          {rail || primary ? <div className="h-2 lg:hidden" /> : null}
        </main>

        {rail ? (
          <aside
            className="hidden min-w-0 flex-col gap-2 overflow-y-auto border-l border-rule p-3 lg:flex"
            data-pane="rail"
            data-print="hide"
          >
            {rail}
          </aside>
        ) : null}
      </div>

      {rail || primary ? (
        <ActionBar
          primary={primary}
          hasRail={Boolean(rail)}
          open={actionsOpen}
          onToggle={() => setActionsOpen((current) => !current)}
        >
          {rail}
        </ActionBar>
      ) : null}

    </div>
  );
}

/**
 * Where you are, and the way out. On every screen, at every width.
 *
 * The way out is first and leftmost because it is the control somebody reaches
 * for when they are lost, and a lost person should not have to hunt. It is a
 * 44px target against the edge of the screen, which is the easiest thing on a
 * tablet to hit without looking.
 *
 * That control used to be "Go to", opening a drawer of twenty destinations.
 * With one desk per person there is nowhere else to go, so the leftmost button
 * is now the only leaving anybody does: signing out. It keeps the position
 * because the reason for the position has not changed — on a device four people
 * share, handing it over is the thing you do without looking.
 */
function TopBar({
  title,
  session,
  onSignOut,
}: {
  title: string | null;
  session: StaffSession | null;
  onSignOut: () => void;
}) {
  return (
    <header
      className="flex h-14 shrink-0 items-center gap-3 border-b-2 border-ink bg-brand-deep px-3 text-paper"
      data-print="hide"
    >
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Sign out"
        className="flex h-11 items-center gap-2 rounded-box border border-paper/40 px-3 text-xs font-semibold uppercase tracking-[0.08em] active:opacity-80"
      >
        <span aria-hidden className="text-base leading-none">
          ⏻
        </span>
        <span className="hidden sm:inline">Sign out</span>
      </button>

      <span aria-hidden className="text-base font-semibold">
        JM
      </span>

      <span className="min-w-0 flex-1 truncate text-lg">
        {title ?? 'Jayamurugan Clinic'}
      </span>

      {session ? (
        <span className="hidden shrink-0 truncate text-sm text-paper/80 sm:block">
          {session.staffName}
        </span>
      ) : null}
    </header>
  );
}

/**
 * The rail, on anything narrower than a landscape stand.
 *
 * The rail's contents are arbitrary JSX written by twenty-six screens — column
 * headings, spacers, a scan field — and reflowing that into a horizontal strip
 * produces nonsense. So it stays a vertical stack and moves into a sheet, with
 * the one action named by `primary` lifted out and left on the bar. That keeps
 * the common case at one tap and the long tail at two, instead of putting
 * everything at two or trying to fit ten buttons across a phone.
 */
function ActionBar({
  primary,
  hasRail,
  open,
  onToggle,
  children,
}: {
  primary?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    tone?: 'primary' | 'danger';
  };
  hasRail: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="shrink-0 lg:hidden" data-print="hide">
      {open && hasRail ? (
        <div className="max-h-[60vh] overflow-y-auto border-t-2 border-ink bg-sheet p-3">
          <div className="flex flex-col gap-2">{children}</div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t-2 border-ink bg-sheet p-2">
        {primary ? (
          <Button
            variant={primary.tone ?? 'primary'}
            onClick={primary.onClick}
            disabled={primary.disabled}
            className="min-w-0 flex-1"
          >
            <span className="truncate">{primary.label}</span>
          </Button>
        ) : null}

        {hasRail ? (
          <Button
            variant="default"
            size="lg"
            aria-expanded={open}
            onClick={onToggle}
            className={primary ? 'shrink-0' : 'w-full'}
          >
            {open ? 'Hide actions' : 'Actions'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The action rail's button. Full width, and 56px when it is the one that signs
 * a legal document or spends money — TABLET.md §2 rule 2 reserves that size for
 * anything primary or destructive.
 */
export function RailButton({
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={tone}
      size={tone === 'default' ? 'md' : 'lg'}
      onClick={onClick}
      disabled={disabled}
      className="w-full"
    >
      {children}
    </Button>
  );
}
