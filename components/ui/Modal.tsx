'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

/**
 * A short decision taken on top of the current screen: confirm a dispense,
 * collect a payment, receive a delivery. Anything longer belongs on the page
 * itself.
 */
export function Modal({
  open,
  onClose,
  title,
  sub,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)

  /**
   * The latest `onClose`, without making the effect below depend on it.
   *
   * Every call site passes an inline arrow, which is a new function identity
   * on every render. With `onClose` in the dependency array the effect re-runs
   * on every keystroke and its `panel.focus()` pulls the caret out of whatever
   * input is being typed into — one letter per click, in a form asking for a
   * batch number. (Same bug and same fix as the reference application.)
   */
  const latestClose = useRef(onClose)
  latestClose.current = onClose

  // Depends on `open` alone, so focus moves exactly once — when it opens.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latestClose.current()
    }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-print="hide">
      <div className="absolute inset-0 bg-ink/35" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-focus-ring="none"
        className="relative flex max-h-full w-full max-w-xl flex-col rounded-box border-2 border-ink bg-sheet"
      >
        <header className="flex items-start justify-between gap-4 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <h2 className="eyebrow">{title}</h2>
            {sub ? <div className="mt-1 font-mono text-[14px]">{sub}</div> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-rule px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
