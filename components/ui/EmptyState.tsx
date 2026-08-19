/**
 * An invitation to act, never a shrug.
 *
 * `direction` is a required prop rather than a convention, and that is the
 * whole design: "Nobody waiting" is a fact, while "Register a walk-in and the
 * token appears here" tells the reader what to do about it. Making it required
 * means a developer in a hurry cannot skip the useful half — the type checker
 * asks for it.
 */
export function EmptyState({
  title,
  direction,
  action,
}: {
  title: string;
  direction: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-box border border-dashed border-rule px-4 py-10 text-center">
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-sm text-sm text-ink-2">{direction}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
