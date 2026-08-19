import { Button } from '@/components/ui';

/**
 * The clinic layout. TABLET.md §3.
 *
 *   ┌──┬──────────────────┬──────────────────────┬──────────────┐
 *   │br│ context pane     │ work pane            │ action rail  │
 *   │an│ (who / what)     │ (the task)           │ (fixed)      │
 *   │d │ 280 / 320px      │ minmax(0, 1fr)       │ 200 / 220px  │
 *   └──┴──────────────────┴──────────────────────┴──────────────┘
 *
 * Two panes and a rail, never stacked modals — landscape has the room, and a
 * modal over a modal on a tablet is a dead end. The action rail is fixed so
 * primary actions are reachable, never scrolled away and never behind the
 * keyboard.
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
 *
 * The previous shell was `grid-cols-[320px_1fr_220px]` on a container with
 * `overflow-hidden`, and the work pane had no `min-w-0`.
 *
 * A `1fr` track is shorthand for `minmax(auto, 1fr)`, and that `auto` minimum
 * is the track's CONTENT minimum — it will not shrink below the widest
 * unbreakable thing inside it. So a register with eight columns, or a drug name
 * that does not wrap, pushed the middle track past its share; the three tracks
 * then summed to more than the viewport; and `overflow-hidden` on the parent
 * clipped the excess rather than scrolling it. The right-hand columns of the
 * day-book and the expiry list were not merely ugly, they were unreachable.
 *
 * Two changes fix it at the root. `minmax(0, 1fr)` lets the track shrink to
 * nothing, and `min-w-0` on the pane itself stops the same auto-minimum
 * applying to the flex/grid child. Scrolling then belongs to whichever pane
 * actually overflows, which is what `Table` provides for the one case — a wide
 * register — where horizontal scroll is honest rather than a symptom.
 *
 * The fixed chrome also came down. 320 + 220 = 540px of a 1024px tablet is more
 * than half the screen spent on furniture; at the low end of the supported
 * range (TABLET.md §3: 1024–1366) the work pane had ~436px of usable width for
 * a consult form. It is now 280 + 200 below 1280px, and the old widths return
 * above it, where there is room to spend.
 */
export function ThreePane({
  context,
  rail,
  children,
}: {
  context?: React.ReactNode;
  rail?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid h-full grid-cols-[2.75rem_280px_minmax(0,1fr)_200px] xl:grid-cols-[2.75rem_320px_minmax(0,1fr)_220px]">
      {/* The strongest signal in the system — 44px of solid brand teal — spent
          on identity, so a shared tablet always says whose clinic it is. */}
      <div
        className="flex flex-col items-center justify-between bg-brand-deep py-3 text-paper"
        data-pane="brand"
        data-print="hide"
      >
        <span aria-hidden className="text-base font-semibold">
          JM
        </span>
        <span
          className="eyebrow whitespace-nowrap text-paper/80 [writing-mode:vertical-rl] [transform:rotate(180deg)]"
          aria-hidden
        >
          Jayamurugan Clinic
        </span>
        <span aria-hidden />
      </div>

      <aside
        className="min-w-0 overflow-y-auto border-r border-rule bg-sheet p-4"
        data-pane="context"
      >
        {context}
      </aside>

      {/* min-w-0 is load-bearing: without it this track refuses to shrink below
          its content and the whole grid overflows. See the note above. */}
      <main
        className="flex min-w-0 flex-col gap-4 overflow-y-auto p-5"
        data-pane="work"
      >
        {children}
      </main>

      <aside
        className="flex min-w-0 flex-col gap-2 overflow-y-auto border-l border-rule p-3"
        data-pane="rail"
        data-print="hide"
      >
        {rail}
      </aside>
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
