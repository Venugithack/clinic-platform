'use client'

import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * The outcome of an action, stated where the action was taken.
 *
 * The command API refuses with a sentence naming what went wrong rather than a
 * code, so this renders that sentence verbatim. Errors do not apologise and are
 * never vague about what happened. This is the only channel for a result
 * message — the app never uses a browser alert for a normal workflow.
 *
 * Five tones, and the two new ones are the point:
 *
 *   good     it is saved
 *   pending  it is saved, and something is still owed. Never green: a part
 *            payment and a settled bill must not look alike from across a
 *            counter.
 *   bad      the clinic refused, and said why
 *   unknown  the request may have reached the clinic and the answer did not
 *            come back. Not the same as a refusal, and not safe to retry
 *            blindly.
 *   info     everything else
 *
 * `bad` and `unknown` are `role="alert"`, because they interrupt: something the
 * person believed had happened has not, or may not have. The rest are polite.
 */
type Tone = 'info' | 'good' | 'pending' | 'bad' | 'unknown'

const SKIN: Record<Tone, string> = {
  info: 'border-rule bg-paper text-ink-2',
  good: 'border-free bg-free-wash text-free',
  pending: 'border-attn bg-attn-wash text-attn',
  bad: 'border-stop bg-stop-wash text-stop',
  unknown: 'border-attn bg-attn-wash text-attn',
}

const MARK: Record<Tone, IconName> = {
  info: 'info',
  good: 'check-circle',
  pending: 'clock',
  bad: 'alert-circle',
  unknown: 'question-circle',
}

export function Notice({
  tone = 'info',
  children,
  onDismiss,
  icon,
}: {
  tone?: Tone
  children: ReactNode
  onDismiss?: () => void
  /** Overrides the tone's mark, for a result with a task icon of its own. */
  icon?: IconName
}) {
  const urgent = tone === 'bad' || tone === 'unknown'

  return (
    <div
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      className={`flex items-start justify-between gap-3 rounded-box border px-3 py-2.5 text-[14px] leading-relaxed ${SKIN[tone]}`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Icon name={icon ?? MARK[tone]} size={18} className="mt-0.5" />
        <span className="min-w-0">{children}</span>
      </span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1 -mr-1 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center opacity-60 hover:opacity-100"
        >
          <Icon name="close" size={18} />
        </button>
      ) : null}
    </div>
  )
}
