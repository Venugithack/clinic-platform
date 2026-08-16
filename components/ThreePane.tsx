/**
 * The clinic layout. TABLET.md §3.
 *
 *   ┌──────────────────┬──────────────────────┬──────────────┐
 *   │ context pane     │ work pane            │ action rail  │
 *   │ (who / what)     │ (the task)           │ (fixed)      │
 *   │ ~320px           │ flexible             │ ~200px       │
 *   └──────────────────┴──────────────────────┴──────────────┘
 *
 * Two panes and a rail, never stacked modals — landscape has the room, and a
 * modal over a modal on a tablet is a dead end. The rail is fixed so primary
 * actions are reachable, never scrolled away and never behind the keyboard.
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
    <div className="grid h-full grid-cols-[320px_1fr_220px] overflow-hidden">
      <aside
        className="overflow-y-auto border-r border-line bg-white/50 p-5"
        data-pane="context"
      >
        {context}
      </aside>

      <main className="overflow-y-auto p-6" data-pane="work">
        {children}
      </main>

      <aside
        className="flex flex-col gap-3 overflow-y-auto border-l border-line p-4"
        data-pane="rail"
      >
        {rail}
      </aside>
    </div>
  );
}

/**
 * The rail's primary button: 56px, because TABLET.md §2 rule 2 reserves that
 * size for anything destructive or primary and this is the one that signs a
 * legal document.
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
  const tones = {
    default: 'border-line bg-white text-ink',
    primary: 'border-ink bg-ink text-white',
    danger: 'border-danger bg-white text-danger',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-14 w-full rounded-xl border px-4 text-base font-medium active:opacity-80 disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
