import type { ReactNode } from 'react'

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
 * Colour is never the only signal: every badge carries a word.
 */
export type Tone = 'plain' | 'free' | 'attn' | 'stop' | 'live'

const TONES: Record<Tone, string> = {
  plain: 'border-rule bg-paper text-ink-2',
  free: 'border-free/35 bg-free-wash text-free',
  attn: 'border-attn/35 bg-attn-wash text-attn',
  stop: 'border-stop/35 bg-stop-wash text-stop',
  live: 'border-active bg-active text-sheet',
}

export function Badge({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-box border px-2 py-0.5 text-[11px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}
