import type { ReactNode } from 'react'

/**
 * An empty screen is an invitation to act, not a shrug. Every one of these
 * says what would fill it and offers the control that does so — "No patients
 * waiting" is a fact; "Reception checks patients in, then they appear here"
 * tells a nurse what to do about it.
 */
export function EmptyState({
  title,
  direction,
  action,
}: {
  /** What is not here. */
  title: string
  /** What puts something here. One line, in the interface's voice. */
  direction: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 border border-dashed border-rule px-6 py-10 text-center">
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="max-w-md text-[13px] leading-relaxed text-ink-2">{direction}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
