'use client'

import type { ReactNode } from 'react'

/**
 * The outcome of an action, stated where the action was taken.
 *
 * The command API refuses with a sentence naming what went wrong rather than a
 * code, so this renders that sentence verbatim. Errors do not apologise and
 * are never vague about what happened. This is the only channel for a result
 * message — the app never uses a browser alert for a normal workflow.
 */
export function Notice({
  tone = 'info',
  children,
  onDismiss,
}: {
  tone?: 'info' | 'good' | 'bad'
  children: ReactNode
  onDismiss?: () => void
}) {
  const skin =
    tone === 'bad'
      ? 'border-stop bg-stop-wash text-stop'
      : tone === 'good'
        ? 'border-free bg-free-wash text-free'
        : 'border-rule bg-paper text-ink-2'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start justify-between gap-3 rounded-box border px-3 py-2.5 text-[13px] leading-relaxed ${skin}`}
    >
      <span className="min-w-0">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1 -mr-1 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center font-mono text-[16px] leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
