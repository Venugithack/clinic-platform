import type { ReactNode } from 'react'

/**
 * The register. Compositional rather than data-driven, because each screen
 * needs different cell contents (tokens, badges, row actions).
 *
 * `TD` has a `num` prop: any transcription-critical value — a quantity, a
 * stock count, an amount, a time — is set in mono and right-aligned so a
 * column of them can be scanned and compared. That is the whole reason for
 * the register.
 *
 * Rows are 56px so a row action clears the touch floor, and the table scrolls
 * inside its own box rather than pushing the page sideways.
 */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-px overflow-x-auto">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

export function TR({
  children,
  onClick,
  active = false,
  muted = false,
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  muted?: boolean
}) {
  const interactive = onClick
    ? 'cursor-pointer hover:bg-paper/60 focus-visible:bg-paper/60'
    : ''
  const state = active ? 'bg-active-wash' : muted ? 'opacity-60' : ''
  return (
    <tr
      className={`border-b border-rule last:border-b-0 ${interactive} ${state}`}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      {children}
    </tr>
  )
}

export function TH({ children, num = false }: { children: ReactNode; num?: boolean }) {
  return (
    <th
      scope="col"
      className={`eyebrow border-b-2 border-ink px-3 py-2.5 whitespace-nowrap ${num ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  )
}

export function TD({
  children,
  num = false,
  className = '',
}: {
  children: ReactNode
  /** Set for identifiers, quantities, times, amounts. */
  num?: boolean
  className?: string
}) {
  return (
    <td
      className={`h-[56px] px-3 py-2 align-middle text-[14px] ${num ? 'text-right font-mono tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  )
}
