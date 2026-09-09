import type { ReactNode } from 'react'

/**
 * A surface. Two weights, and the difference is meaning, not decoration:
 *   panel  — 1px rule. A region of the workspace.
 *   record — 2px ink.  A document: a consultation, a prescription, a bill,
 *            an OTC receipt, a supplier order.
 * No shadows anywhere in this system.
 */
export function Card({
  variant = 'panel',
  className = '',
  children,
  ...rest
}: {
  variant?: 'panel' | 'record'
  className?: string
  children: ReactNode
} & Omit<React.HTMLAttributes<HTMLElement>, 'children' | 'className'>) {
  const weight = variant === 'record' ? 'border-2 border-ink' : 'border border-rule'
  return (
    <section className={`rounded-box bg-sheet ${weight} ${className}`} {...rest}>
      {children}
    </section>
  )
}

/** Card header. `sub` carries the identifying value, so it is set in mono. */
export function CardHeader({
  title,
  sub,
  action,
}: {
  title: string
  sub?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3">
      <div className="min-w-0">
        <h2 className="eyebrow">{title}</h2>
        {sub ? <div className="mt-1 font-mono text-[14px] text-ink">{sub}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}

export function CardBody({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>
}
