/**
 * The same three lines at the top of every screen: eyebrow, title, mono sub.
 *
 * This is the cheapest consistency in the system and the most visible. Twenty
 * eight screens written by hand drift into twenty eight different headings;
 * one component means the doctor's eye lands in the same place on the queue,
 * the counter, the day-book and the expiry list without being taught to.
 *
 * The primary action sits right and baseline-aligned with the title, because
 * on a tablet the thumb is already at the edge of the screen.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-3">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-1 font-mono text-xs text-ink-2">{sub}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
    </header>
  );
}
