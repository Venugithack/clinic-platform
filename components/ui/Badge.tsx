import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * Status. The tone set is deliberately small and reserved — a badge never
 * carries colour for emphasis, only for state, so that a red one always means
 * the same thing on every screen.
 *
 *   free  bed available · bill paid · stock healthy · order delivered
 *   attn  waiting · low stock · nearing expiry · partially delivered
 *   stop  expired · unpaid · disabled · failed
 *   live  happening right now (in consult, being dispensed)
 *   plain everything else
 *
 * Colour is never the only signal: every badge carries a word, and the ones
 * that mean something urgent carry a shape as well. `live` is a solid fill
 * rather than a wash, which is how this system distinguishes "now" from
 * "settled" without asking anyone to tell two greens apart.
 */
export type Tone = 'plain' | 'free' | 'attn' | 'stop' | 'live'

const TONES: Record<Tone, string> = {
  plain: 'border-rule bg-paper text-ink-2',
  free: 'border-free/40 bg-free-wash text-free',
  attn: 'border-attn/40 bg-attn-wash text-attn',
  stop: 'border-stop/40 bg-stop-wash text-stop',
  live: 'border-active bg-active text-sheet',
}

/** The shape each status carries, for anyone who cannot use the colour. */
const MARKS: Record<Tone, IconName | null> = {
  plain: null,
  free: 'check',
  attn: 'clock',
  stop: 'alert',
  live: null,
}

export function Badge({
  tone = 'plain',
  icon,
  children,
}: {
  tone?: Tone
  /** Overrides the tone's default mark. `null` draws none. */
  icon?: IconName | null
  children: ReactNode
}) {
  const mark = icon === undefined ? MARKS[tone] : icon

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-box border px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {mark ? <Icon name={mark} size={13} /> : null}
      {children}
    </span>
  )
}
