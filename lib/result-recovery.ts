/**
 * The note a doctor leaves themselves when the tablet stops answering.
 *
 * ── THE CASE THIS EXISTS FOR ───────────────────────────────────────────────
 *
 * A doctor presses Record review. The write reaches Mumbai, commits, and the
 * reply is lost on the way home. The drawer says "outcome not confirmed",
 * which is true — and then the tablet is reloaded, because that is what
 * somebody does when a screen stops responding.
 *
 * Everything that knew about the attempt was React state, so it is gone. And
 * the result is no longer in the review queue, because the queue is what
 * nobody has read and somebody has now read this. The doctor is left with a
 * result they cannot find, no way to learn whether the review landed, and a
 * notice that may or may not be owed. The honest recovery — read the
 * authoritative record and see — had no way to be reached.
 *
 * This is the pointer that survives the reload so it can be.
 *
 * ── WHAT IT MAY HOLD, AND WHAT IT MAY NOT ─────────────────────────────────
 *
 * Opaque identifiers and nothing else: an order id, a result id, which act
 * was in flight, and a client-side reference that keeps one attempt from
 * becoming several. **No patient name, no report text, no flag, no document
 * metadata, no ticket, no URL, no bytes.** A recovery note is not a clinical
 * record and must not become a second, weaker copy of one — `sessionStorage`
 * is readable by anything that can run script on this page, which is the same
 * trade `lib/api.ts` states about the session token and is acceptable for
 * exactly this much.
 *
 * `resultRecoveryIsOpaque` below is that rule as a function, and a unit test
 * walks it rather than trusting the type.
 *
 * ── WHY `sessionStorage`, AND WHAT THAT COSTS ─────────────────────────────
 *
 * It survives a reload, which is the whole requirement, and it dies with the
 * tab, which is the right lifetime for a note about work in progress. It is
 * per-tab and per-device: a doctor who reloads recovers, and a doctor who
 * picks up a different tablet does not. That is a real limit and it is
 * written down rather than papered over — closing it means a server-side
 * record of unfinished follow-up, which is a backend contract this bounded
 * cutover is not allowed to add.
 *
 * ── WHOSE NOTE IT IS ──────────────────────────────────────────────────────
 *
 * Every record carries the staff id it belongs to and is refused — and
 * deleted — when anybody else asks. Four people share four tablets and hand
 * them to each other all day; a note left by the doctor must not greet the
 * nurse who signs in next.
 */

const KEY = 'jayamurugan_result_followup'

/**
 * How long a note stays worth acting on.
 *
 * `sessionStorage` already dies with the tab, so this is the second bound
 * rather than the only one: a tablet left open on the counter overnight
 * should not greet the morning with yesterday's unfinished thought. Twelve
 * hours is longer than a clinic day and shorter than two.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000

/** The six consequential acts on the doctor's result surface. */
export type RecoveryAction =
  | 'acknowledge'
  | 'flag'
  | 'delegate'
  | 'review'
  | 'authorize'
  | 'contact'

/**
 * Why the note is still here.
 *
 * `outcome_unknown` is the dangerous one: a write went out and nothing came
 * back, so nothing may be repeated until the record has been read. `follow_up`
 * is the calm one: the review is recorded and the patient still has to be told
 * or telephoned, and the result has left the queue that would have reminded
 * anybody.
 */
export type RecoveryPhase = 'outcome_unknown' | 'follow_up'

export type ResultRecovery = {
  /** Whose note this is. Nobody else is shown it. */
  staffId: string
  orderId: string
  resultId: string
  action: RecoveryAction
  phase: RecoveryPhase
  /**
   * One attempt's client-side reference, kept across remounts, drawer
   * dismissals and reloads.
   *
   * It is **not** an idempotency key and is never sent to the server: these
   * commands are idempotent by construction — `unique (result_id)` on a
   * review, write-once columns on the rest — and minting a key for them would
   * be a second mechanism doing a job the database already does. What this
   * does is keep one in-flight act from becoming two notes when React
   * remounts the component, which it does on every workspace change.
   */
  reference: string
  /** Epoch milliseconds, for the age bound above. */
  at: number
}

/** Exactly the keys a note may carry. Anything else is clinical content. */
const ALLOWED_KEYS = ['staffId', 'orderId', 'resultId', 'action', 'phase', 'reference', 'at']

const ACTIONS: RecoveryAction[] = [
  'acknowledge', 'flag', 'delegate', 'review', 'authorize', 'contact',
]

/**
 * Whether a note carries only opaque identifiers.
 *
 * Exported and tested rather than left to the type, because a type is a
 * promise the compiler keeps about code somebody has already written, and the
 * thing worth preventing is the field somebody adds later. It refuses an
 * unexpected key outright rather than stripping it: a silent strip is a bug
 * that ships.
 */
export function resultRecoveryIsOpaque(value: unknown): value is ResultRecovery {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.includes(key)) return false
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in record)) return false
  }
  if (typeof record.staffId !== 'string' || record.staffId === '') return false
  if (typeof record.orderId !== 'string' || record.orderId === '') return false
  if (typeof record.resultId !== 'string' || record.resultId === '') return false
  if (typeof record.reference !== 'string' || record.reference === '') return false
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return false
  if (!ACTIONS.includes(record.action as RecoveryAction)) return false
  return record.phase === 'outcome_unknown' || record.phase === 'follow_up'
}

/**
 * The store, resolved at call time and never cached.
 *
 * A getter rather than a module-level constant because this module is
 * imported during the static export's build, where there is no `window` at
 * all — and because a private window can make the accessor itself throw
 * rather than merely return null.
 */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * The note for this staff member, if there is a usable one.
 *
 * Anybody else's is deleted rather than ignored, which is the difference
 * between isolating the tablet and merely being polite about it. So is one
 * that has gone stale, and one that is not the shape this module writes —
 * including anything a future version of this file might have left behind.
 */
export function readResultRecovery(staffId: string): ResultRecovery | null {
  const storage = store()
  if (!storage) return null

  let raw: string | null = null
  try {
    raw = storage.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearResultRecovery()
    return null
  }

  if (!resultRecoveryIsOpaque(parsed)) {
    clearResultRecovery()
    return null
  }
  if (parsed.staffId !== staffId) {
    // Somebody else signed in on this tablet. Their note is not this
    // person's business and is not left lying about either.
    clearResultRecovery()
    return null
  }
  if (Date.now() - parsed.at > MAX_AGE_MS) {
    clearResultRecovery()
    return null
  }
  return parsed
}

/**
 * Leave a note, reusing the reference of the one already here when it is
 * about the same act on the same result.
 *
 * The reuse is the point of the reference existing: a remount, a closed
 * drawer and a reload must not each mint a new one, or "the attempt that is
 * in flight" stops being a single thing anybody can name.
 */
export function writeResultRecovery(
  next: Omit<ResultRecovery, 'reference' | 'at'> & { reference?: string },
): ResultRecovery | null {
  const storage = store()
  if (!storage) return null

  const existing = readResultRecovery(next.staffId)
  const sameAttempt =
    existing !== null &&
    existing.resultId === next.resultId &&
    existing.action === next.action

  const record: ResultRecovery = {
    staffId: next.staffId,
    orderId: next.orderId,
    resultId: next.resultId,
    action: next.action,
    phase: next.phase,
    reference: next.reference ?? (sameAttempt ? existing.reference : newReference()),
    at: sameAttempt ? existing.at : Date.now(),
  }

  try {
    storage.setItem(KEY, JSON.stringify(record))
  } catch {
    // Private browsing, or storage full. Recovery is a convenience over the
    // authoritative record, never a substitute for it, so losing it costs the
    // reminder and nothing else.
    return null
  }
  return record
}

export function clearResultRecovery(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    // As above.
  }
}

function newReference(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}
