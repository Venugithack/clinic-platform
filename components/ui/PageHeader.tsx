import type { ReactNode } from 'react'

/**
 * The top of a workspace: what desk you are standing at, what this screen is,
 * and the one or two controls that act on the whole screen.
 *
 * A 2px ink rule under it, because the screen below is the document.
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow: string
  title: string
  /** One line of context — counts, a filter, a state of play. */
  sub?: ReactNode
  action?: ReactNode
}) {
  return (
    <header
      className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-3"
      data-print="hide"
    >
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-1 text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
        {sub ? <div className="mt-1 font-mono text-[13px] text-ink-2">{sub}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  )
}

/** A titled division inside a workspace. One step quieter than PageHeader. */
export function SectionHeader({
  title,
  sub,
  action,
}: {
  title: string
  sub?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="eyebrow">{title}</h2>
        {sub ? <div className="mt-1 text-[13px] text-ink-2">{sub}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  )
}
