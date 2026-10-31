'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon, type IconName } from './Icon'
import { Button } from './Button'

/**
 * What a task looks like while it is happening, and afterwards.
 *
 * Before this, every write in the clinic reported itself the same way: one
 * global `busy` boolean that disabled every control on the tablet at once, and
 * one notice strip above the workspace carrying the server's sentence until
 * somebody dismissed it or navigated far enough away to forget it. Three things
 * were wrong with that and all three are the reason this file exists.
 *
 *   1. `Call in` on row two relabelled `Call in` on rows one and three, so the
 *      operator could not tell which patient had been called.
 *   2. A request that threw — a tablet that lost the clinic Wi-Fi halfway
 *      through a hand-over — was reported in exactly the same words as a
 *      refusal. "Not reachable" reads as "nothing happened", and it is not the
 *      same thing: the stock may already have moved.
 *   3. "Vitals saved." followed the nurse to the bed board.
 *
 * So a task is owned by the control that starts it, it knows the difference
 * between an answer and a silence, and its result is a thing that appears,
 * is read, and goes — leaving the evidence behind on the queue row, the bill
 * or the ledger where it belongs.
 *
 * The states, and they are the ones in `docs/UI_UX_PLAN.md`:
 *
 *   ready ──▶ working ──┬──▶ confirmed   the server said it is saved
 *                       ├──▶ partial     saved, and something is still owed
 *                       ├──▶ failed      the server refused, and said why
 *                       └──▶ unknown     the answer never arrived
 */

export type TaskPhase = 'ready' | 'working' | 'confirmed' | 'partial' | 'failed' | 'unknown'

/** A confirmed result stays this long. Routine work. */
export const DWELL_ROUTINE = 2000

/**
 * Consult completion, medicine hand-over and payment. Longer, because the
 * reader has to take in a patient or an amount before it goes.
 */
export const DWELL_MAJOR = 3000

export type TaskFact = { label: string; value: ReactNode }

/** What the result layer shows once the backend has confirmed the record. */
export type TaskOutcome = {
  /** `partial` is amber and says what is still owed. It is never a completion. */
  kind: 'confirmed' | 'partial'
  /** The completed action, in the clinic's words: `Vitals saved`. */
  title: string
  /** The patient or the transaction: `Meena R · JMC-0004`. */
  identity?: ReactNode
  /** The one thing worth reading: `₹300 received · Balance ₹0`. */
  detail?: ReactNode
  /** Anything else worth leaving on screen for the two or three seconds. */
  facts?: TaskFact[]
  /**
   * The task's own icon, which resolves into a check. A pulse settles into a
   * check for vitals; a signed sheet receives one for a consultation.
   */
  icon?: IconName
  /** Milliseconds before it dismisses itself. Defaults by `kind`. */
  dwell?: number
}

type Failure = { kind: 'failed' | 'unknown'; message: string }

export type TaskState = {
  phase: TaskPhase
  /** True once the request has been open longer than four seconds. */
  slow: boolean
  /** The present-tense label of the operation in flight. */
  working: string
  outcome: TaskOutcome | null
  failure: Failure | null
  /** Shorthand for `phase === 'working'`. */
  busy: boolean
}

/** The shape every command result must have for a task to read it. */
export type TaskResponse = {
  ok: boolean
  message: string
  /**
   * Set by the shell when the request threw rather than answering. The command
   * may well have committed; nothing may be retried blindly on the strength of
   * it, and it must never be reported as a plain refusal.
   */
  unconfirmed?: boolean
}

export type RunTask<R extends TaskResponse> = {
  /** `Saving vitals…`, `Handing over medicines…`, `Receiving ₹320…` */
  working: string
  /** The command. One call; the task does not retry it. */
  request: () => Promise<R>
  /**
   * Turns a confirmed response into what the operator sees. Returning `null`
   * completes the task silently — right for work that is its own evidence.
   */
  confirmed?: (result: R) => TaskOutcome | null
}

const SLOW_AFTER = 4000
export const SLOW_MESSAGE = 'Still saving—do not repeat this action'

/**
 * One task, owned by whatever starts it.
 *
 * ```tsx
 * const save = useTask()
 * …
 * <ActionButton busy={save.busy} busyLabel={save.workingLabel} onClick={() => save.run({
 *   working: 'Saving vitals…',
 *   request: () => run('record_vitals', payload),
 *   confirmed: () => ({ kind: 'confirmed', title: 'Vitals saved', icon: 'pulse', … }),
 * })}>Save vitals</ActionButton>
 * ```
 */
export function useTask(): TaskState & {
  run: <R extends TaskResponse>(task: RunTask<R>) => Promise<R | null>
  /** Clears the result layer. Never clears the record behind it. */
  dismiss: () => void
  /** `busyLabel` for the control that owns the task. */
  workingLabel: string
} {
  const [phase, setPhase] = useState<TaskPhase>('ready')
  const [slow, setSlow] = useState(false)
  const [working, setWorking] = useState('')
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  // The guard against a second tap. State would not do: two taps in the same
  // tick both read the old value and both send the command.
  const inFlight = useRef(false)
  const timers = useRef<number[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const timer of timers.current) window.clearTimeout(timer)
      timers.current = []
    }
  }, [])

  const dismiss = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    setPhase('ready')
    setOutcome(null)
    setFailure(null)
    setSlow(false)
  }, [])

  const run = useCallback(async function run<R extends TaskResponse>(
    task: RunTask<R>,
  ): Promise<R | null> {
    // Four tablets share one clinic and a thumb on a counter is not precise.
    if (inFlight.current) return null
    inFlight.current = true

    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    setOutcome(null)
    setFailure(null)
    setSlow(false)
    setWorking(task.working)
    setPhase('working')

    const slowTimer = window.setTimeout(() => {
      if (mounted.current) setSlow(true)
    }, SLOW_AFTER)
    timers.current.push(slowTimer)

    try {
      const result = await task.request()
      window.clearTimeout(slowTimer)
      if (!mounted.current) return result

      if (!result.ok) {
        // A refusal and a silence are different facts about the clinic.
        setPhase(result.unconfirmed ? 'unknown' : 'failed')
        setFailure({
          kind: result.unconfirmed ? 'unknown' : 'failed',
          message: result.message,
        })
        setSlow(false)
        return result
      }

      // Success is the backend's word, never the animation's.
      const next = task.confirmed?.(result) ?? null
      setSlow(false)
      if (!next) {
        setPhase('ready')
        return result
      }

      setOutcome(next)
      setPhase(next.kind)

      const dwell = next.dwell ?? (next.kind === 'partial' ? DWELL_MAJOR : DWELL_ROUTINE)
      if (dwell > 0) {
        const close = window.setTimeout(() => {
          if (!mounted.current) return
          setPhase('ready')
          setOutcome(null)
        }, dwell)
        timers.current.push(close)
      }
      return result
    } catch {
      // `request` is expected to resolve rather than throw; this is the
      // last line of defence, and it is the unknown case, not the refused one.
      window.clearTimeout(slowTimer)
      if (mounted.current) {
        setPhase('unknown')
        setFailure({ kind: 'unknown', message: 'The clinic did not confirm this. Check the record before trying again.' })
        setSlow(false)
      }
      return null
    } finally {
      inFlight.current = false
    }
  }, [])

  return {
    phase,
    slow,
    working,
    outcome,
    failure,
    busy: phase === 'working',
    workingLabel: slow ? SLOW_MESSAGE : working,
    run,
    dismiss,
  }
}

/**
 * The quiet layer over the panel that is saving.
 *
 * Not the workspace — the plan reserves a full-screen loading state for
 * sign-in and for a workspace with nothing safe to show. Everything else
 * covers only the work it could change, so the patient band, the queue and the
 * bill behind it all stay readable while the request is open.
 *
 * `inert` is what actually stops the second tap: the content underneath leaves
 * the tab order and stops taking pointer events, so a control cannot be
 * pressed, focused or typed into while the command it would repeat is open.
 */
export function Busy({
  on,
  label,
  children,
  className = '',
}: {
  on: boolean
  /** The present-tense operation. Never a percentage; nothing here knows one. */
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <div inert={on || undefined}>{children}</div>
      {on ? (
        <div
          data-testid="panel-busy"
          data-print="hide"
          className="absolute inset-0 z-30 flex items-center justify-center bg-sheet/75 backdrop-blur-[1px]"
        >
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-2.5 rounded-box border border-rule bg-sheet px-3.5 py-2.5 text-[14px] font-medium text-ink"
          >
            <Icon name="ring" size={20} className="jmc-spin text-ink-2" />
            {label}
          </p>
        </div>
      ) : null}
    </div>
  )
}

const OUTCOME_SKIN = {
  confirmed: { ring: 'border-free text-free', word: 'text-free' },
  partial: { ring: 'border-attn text-attn', word: 'text-attn' },
} as const

/**
 * The result, centred over the workspace it did not change.
 *
 * It is the same clarity as a payment screen in the clinic's own language: a
 * large mark, the action in words, who or what it was for, and the one figure
 * that matters. It is dismissible immediately and it goes by itself, because a
 * result that has to be cleared is a result somebody stops reading.
 *
 * It is deliberately NOT `role="dialog"`. It takes no decision, it traps
 * nothing, and the work behind it is still the work. Announcing it is the
 * `role="status"` region inside.
 */
export function TaskResult({
  outcome,
  onDismiss,
  next,
  returnFocusTo,
}: {
  outcome: TaskOutcome | null
  onDismiss: () => void
  /**
   * The one thing to do next: `Next patient`, `New sale`, `Return to queue`.
   * It takes focus, so the next action is a press away without hunting for it.
   * Nothing here selects the next patient or starts the next sale by itself.
   */
  next?: { label: string; onPress: () => void }
  /** Where focus goes when it closes without a `next`. */
  returnFocusTo?: RefObject<HTMLElement | null>
}) {
  const nextRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const open = outcome !== null

  useEffect(() => {
    if (!open) return
    // The next action, not the dismiss: whoever is reading this is about to
    // call the next patient far more often than they are about to close a box.
    const target = nextRef.current ?? closeRef.current
    target?.focus()
  }, [open])

  const returned = useRef(false)
  useEffect(() => {
    if (open) {
      returned.current = false
      return
    }
    if (returned.current) return
    returned.current = true
    returnFocusTo?.current?.focus()
  }, [open, returnFocusTo])

  // Escape closes it, like every other transient layer in the application.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onDismiss])

  if (!outcome) return null

  const skin = OUTCOME_SKIN[outcome.kind]
  const mark: IconName =
    outcome.kind === 'partial' ? (outcome.icon ?? 'clock') : (outcome.icon ?? 'check-circle')

  return (
    <div
      data-testid="result-overlay"
      data-print="hide"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Quiet, not opaque: the queue or the bill behind this is still the
          evidence, and it is about to be the only thing left. */}
      <button
        type="button"
        aria-label="Dismiss result"
        onClick={onDismiss}
        className="absolute inset-0 bg-ink/25"
      />
      <section
        aria-labelledby={titleId}
        className="jmc-rise relative w-full max-w-md rounded-box border-2 border-ink bg-sheet px-5 py-6 text-center"
      >
        <span
          aria-hidden="true"
          className={`jmc-mark mx-auto flex h-[68px] w-[68px] items-center justify-center rounded-full border-2 ${skin.ring}`}
        >
          <Icon name={mark} size={40} />
        </span>

        <div role="status" aria-live="polite" aria-atomic="true" className="mt-4">
          <h2 id={titleId} className={`text-[20px] leading-tight font-semibold ${skin.word}`}>
            {outcome.title}
          </h2>
          {outcome.identity ? (
            <p className="mt-1.5 font-mono text-[15px] text-ink">{outcome.identity}</p>
          ) : null}
          {outcome.detail ? (
            <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{outcome.detail}</p>
          ) : null}
        </div>

        {outcome.facts && outcome.facts.length > 0 ? (
          <dl className="mt-4 grid gap-1.5 border-t border-rule pt-3 text-left">
            {outcome.facts.map((fact) => (
              <div key={fact.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-[13px] text-ink-2">{fact.label}</dt>
                <dd className="font-mono text-[14px] tabular-nums text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {next ? (
            <Button
              ref={nextRef}
              variant="primary"
              onClick={() => {
                onDismiss()
                next.onPress()
              }}
            >
              {next.label}
            </Button>
          ) : null}
          <Button ref={closeRef} variant={next ? 'ghost' : 'secondary'} onClick={onDismiss}>
            Close
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * A failure or an unconfirmed outcome, stated where the action was taken.
 *
 * Neither ever dismisses itself, and neither is ever green. The difference
 * between them is the difference between "this did not happen" and "nobody
 * knows yet whether this happened", and a clinic that confuses the two hands
 * over the same medicine twice.
 */
export function TaskFailure({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: Failure | null
  /**
   * Offered only when repeating the command is safe — which for anything that
   * moves stock or money means an idempotency key is carrying the retry.
   */
  onRetry?: () => void
  onDismiss?: () => void
}) {
  if (!failure) return null
  const unknown = failure.kind === 'unknown'

  return (
    <div
      role="alert"
      data-testid={unknown ? 'outcome-unknown' : 'task-failed'}
      data-print="hide"
      className={`flex items-start gap-2.5 rounded-box border px-3 py-2.5 text-[13px] leading-relaxed ${
        unknown ? 'border-attn bg-attn-wash text-attn' : 'border-stop bg-stop-wash text-stop'
      }`}
    >
      <Icon name={unknown ? 'question-circle' : 'alert-circle'} size={20} className="mt-px" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{unknown ? 'Outcome not confirmed' : 'Not saved'}</p>
        <p className="mt-0.5">{failure.message}</p>
        {unknown ? (
          <p className="mt-1">
            Everything typed here has been kept. Check the record before doing this again.
          </p>
        ) : null}
        {onRetry || onDismiss ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {onRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {onDismiss ? (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
