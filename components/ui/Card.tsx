/**
 * Law 1 as a component.
 *
 *   panel  — 1px rule.  An ordinary boundary: a list, a section, a summary.
 *   record — 2px ink.   A document: an encounter, a prescription, a bill.
 *
 * There is no third variant and no shadow. If something needs to stand out
 * beyond `record`, it is the thing happening now, and that is the ink fill —
 * which belongs to Token, not here.
 */
export function Card({
  variant = 'panel',
  className = '',
  children,
  ...rest
}: {
  variant?: 'panel' | 'record';
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const edge =
    variant === 'record' ? 'border-2 border-ink' : 'border border-rule';

  return (
    <div className={`rounded-box bg-sheet ${edge} ${className}`} {...rest}>
      {children}
    </div>
  );
}

/**
 * The header rule matches the card's own edge weight — a document's masthead is
 * ruled as heavily as its border, a panel's is not.
 */
export function CardHeader({
  variant = 'panel',
  className = '',
  children,
}: {
  variant?: 'panel' | 'record';
  className?: string;
  children: React.ReactNode;
}) {
  const rule =
    variant === 'record' ? 'border-b-2 border-ink' : 'border-b border-rule';

  return <div className={`px-4 py-3 ${rule} ${className}`}>{children}</div>;
}

export function CardBody({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}
