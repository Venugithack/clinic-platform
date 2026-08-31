import type { ReactNode } from 'react'

/**
 * A long form folded away until it is wanted — adding a medicine is sixteen
 * fields, and the pharmacist looking at the shelf list needs none of them.
 *
 * A native `<details>`, so it is keyboard-operable and openable with no
 * JavaScript. The summary is a full-width 48px target with the tracked caps
 * this system labels everything with.
 */
export function Disclosure({
  label,
  hint,
  defaultOpen = false,
  children,
}: {
  label: string
  hint?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details className="group rounded-box border border-rule bg-sheet" open={defaultOpen}>
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 hover:bg-paper/60 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="eyebrow block">{label}</span>
          {hint ? <span className="mt-0.5 block text-[12px] text-ink-2">{hint}</span> : null}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[13px] text-ink-2 group-open:hidden"
        >
          + Open
        </span>
        <span
          aria-hidden="true"
          className="hidden shrink-0 font-mono text-[13px] text-ink-2 group-open:inline"
        >
          − Close
        </span>
      </summary>
      <div className="border-t border-rule px-4 py-4">{children}</div>
    </details>
  )
}
