/**
 * The three-pane clinic shell. TABLET.md §3.
 *
 *   ┌──────────────────┬──────────────────────┬──────────────┐
 *   │ context pane     │ work pane            │ action rail  │
 *   │ (who / what)     │ (the task)           │ (fixed)      │
 *   │ ~320px           │ flexible             │ ~200px       │
 *   └──────────────────┴──────────────────────┴──────────────┘
 *
 * It exists from the first commit rather than being fitted afterwards
 * (BUILD.md §4): a desktop layout made responsive later is exactly the thing
 * that produces a 10" screen nobody wants to use. Two panes and a rail, never
 * stacked modals — landscape has the room, and a modal over a modal on a tablet
 * is a dead end.
 */
export default function ClinicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="grid h-full grid-cols-[320px_1fr_200px] overflow-hidden">
      <aside className="overflow-y-auto border-r border-line p-5" data-pane="context" />
      <main className="overflow-y-auto p-6" data-pane="work">
        {children}
      </main>
      {/* Primary actions live here: reachable, never scrolled away, never
          behind the keyboard (TABLET.md §2 rule 6). */}
      <aside className="border-l border-line p-4" data-pane="rail" />
    </div>
  );
}
