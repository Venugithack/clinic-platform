/**
 * One reference for one act on one booking, kept until the clinic confirms it.
 *
 * ── THE RULE, FROM THE CONTRACT ───────────────────────────────────────────
 *
 * Every appointment command requires its own `idempotencyKey`, and a retry
 * must reuse the key AND the exact request (`SLICE2_FRONTEND_CONTRACT.md`
 * §4.0). A key minted afresh because a reply was lost, a component
 * re-rendered or a drawer closed is no protection at all, in exactly the
 * moment the key exists for: the first request may have committed, and the
 * second, under a new name, commits again — a second booking, or a second
 * queue token for one patient.
 *
 * So a key belongs to an ACT ON A SUBJECT — "book this patient", "check this
 * booking in", "move this booking" — and it is held until the clinic says the
 * act was carried out. Nothing else releases it:
 *
 *   confirmed (ok, including a replay)   released; the next act mints afresh
 *   refused, with or without a code      held — a refusal writes no receipt,
 *                                         so the reference is unspent and the
 *                                         corrected request goes under it
 *   no answer                            held, and noted for after a reload
 *
 * Holding a key across a refusal is what makes the override path safe:
 * `OVERRIDE_REASON_REQUIRED` consumes nothing, and the same request with a
 * reason goes out under the same reference. It is also what makes a lost
 * reply safe to recover from by hand: if the first request did commit, a
 * corrected second one under the same key is refused as
 * `APPOINTMENT_REFERENCE_REUSED` rather than carried out beside it.
 *
 * ── WHAT IS WRITTEN DOWN, AND WHAT IS NOT ─────────────────────────────────
 *
 * `sessionStorage` holds the note that survives a reload: **opaque
 * identifiers and nothing else** — whose note it is, which command, the
 * patient or booking id it is about, the reference, a phase and a time. No
 * patient name, no clinical reason, no appointment time. The task that set
 * this bound says it plainly: nothing sensitive goes into browser storage
 * merely to reconstruct a retry.
 *
 * The exact request lives in memory only. It is what lets "Send the same
 * request again" be exact while the tab is open. After a reload it is gone,
 * and what the tablet does instead is ASK — `workspace?view=appointment_outcome`
 * answers what the reference did, for the person who sent it. That read is
 * the smallest addition this station needed; the note is the smallest thing
 * that can make it.
 *
 * ── WHOSE NOTE IT IS ──────────────────────────────────────────────────────
 *
 * Every note carries its staff id, and anybody else's is deleted on sight.
 * The server would refuse a colleague's retry anyway — a reference names its
 * actor — but four people share four tablets and a note left by the nurse
 * must not greet the doctor who signs in next.
 */

const PREFIX = 'jayamurugan_appointment:'

/** The five acts the appointment station performs. */
export type AppointmentAct =
  | 'book_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'mark_no_show'
  | 'check_in_appointment'

const ACTS: AppointmentAct[] = [
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'mark_no_show',
  'check_in_appointment',
]

/**
 * `sent` — a request went out and the clinic has not confirmed it. After a
 * reload these are the notes the station asks about.
 *
 * `refused` — the clinic answered no. Nothing was recorded, the reference is
 * unspent, and it is kept only so the corrected request reuses it. Not
 * surfaced after a reload: there is nothing to recover.
 */
export type AttemptPhase = 'sent' | 'refused'

export type AppointmentAttempt = {
  staffId: string
  act: AppointmentAct
  /** The patient id for a booking; the booking id for everything else. */
  subjectId: string
  key: string
  phase: AttemptPhase
  /**
   * When the request went out, epoch milliseconds. Not an expiry: an
   * unanswered note is held until the clinic settles it, however long that is.
   */
  at: number
}

/** Exactly the keys a note may carry. Anything else would be clinical content. */
const ALLOWED_KEYS = ['staffId', 'act', 'subjectId', 'key', 'phase', 'at']

/**
 * Whether a note carries only opaque identifiers.
 *
 * Exported and unit-tested rather than left to the type, because the thing
 * worth preventing is the field somebody adds later — a patient's name "just
 * for the recovery card". It refuses an unexpected key outright rather than
 * stripping it.
 */
export function appointmentAttemptIsOpaque(value: unknown): value is AppointmentAttempt {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.includes(key)) return false
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in record)) return false
  }
  if (typeof record.staffId !== 'string' || record.staffId === '') return false
  if (typeof record.subjectId !== 'string' || record.subjectId === '') return false
  if (typeof record.key !== 'string' || record.key === '') return false
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return false
  if (!ACTS.includes(record.act as AppointmentAct)) return false
  return record.phase === 'sent' || record.phase === 'refused'
}

/* ─────────────────────────────────────────────────────────── storage ── */

/**
 * The store, resolved at call time and never cached: this module is imported
 * during the static export's build, where there is no `window`, and a private
 * window can make the accessor itself throw.
 */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** Survives an unmount and a closed drawer. A reload is what storage is for. */
const volatile = new Map<string, AppointmentAttempt>()

/**
 * The exact requests, in memory and nowhere else.
 *
 * Keyed by the same scope as the notes. This is the only place a patient id,
 * a reason or a time sits beside a reference, and it dies with the page.
 */
const requests = new Map<string, Record<string, unknown>>()

const scopeOf = (act: AppointmentAct, subjectId: string) => `${act}:${subjectId}`

function readNote(scope: string): AppointmentAttempt | null {
  const storage = store()
  if (storage) {
    let raw: string | null = null
    try {
      raw = storage.getItem(PREFIX + scope)
    } catch {
      raw = null
    }
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (appointmentAttemptIsOpaque(parsed)) return parsed
      } catch {
        // Fall through to removal: not the shape this module writes.
      }
      removeNote(scope)
      return null
    }
  }
  return volatile.get(scope) ?? null
}

function writeNote(note: AppointmentAttempt): void {
  const scope = scopeOf(note.act, note.subjectId)
  volatile.set(scope, note)
  try {
    store()?.setItem(PREFIX + scope, JSON.stringify(note))
  } catch {
    // Private browsing, blocked site data or a full quota. The in-memory copy
    // still protects everything short of a reload.
  }
}

function removeNote(scope: string): void {
  volatile.delete(scope)
  requests.delete(scope)
  try {
    store()?.removeItem(PREFIX + scope)
  } catch {
    // As above.
  }
}

/** An unanswered reference remains held for this person until the clinic settles it. */
function usable(note: AppointmentAttempt, staffId: string): boolean {
  return note.staffId === staffId
}

function newKey(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `appt-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
  }
}

/* ────────────────────────────────────────────────────────── the rules ── */

/**
 * The reference to send this act under — the held one if there is one.
 *
 * Called immediately before the request goes out, and it writes the note
 * FIRST, as `sent`, so a tab that is reloaded while the request is still open
 * already knows what to ask about. The exact request is remembered in memory
 * so a same-tab retry can be exact.
 */
export function beginAppointmentAttempt(
  staffId: string,
  act: AppointmentAct,
  subjectId: string,
  request: Record<string, unknown>,
): string {
  const scope = scopeOf(act, subjectId)
  const held = readNote(scope)
  const key = held && usable(held, staffId) ? held.key : newKey()
  if (held && !usable(held, staffId)) removeNote(scope)

  writeNote({ staffId, act, subjectId, key, phase: 'sent', at: Date.now() })
  requests.set(scope, { ...request })
  return key
}

/** The clinic carried it out — or replayed that it already had. Let it go. */
export function settleAppointmentAttempt(act: AppointmentAct, subjectId: string): void {
  const scope = scopeOf(act, subjectId)
  removeNote(scope)
  requests.delete(scope)
}

/**
 * The clinic answered no. Nothing was recorded; keep the reference for the
 * corrected request, and stop treating it as something to recover.
 */
export function refuseAppointmentAttempt(act: AppointmentAct, subjectId: string): void {
  const scope = scopeOf(act, subjectId)
  const held = readNote(scope)
  if (held) writeNote({ ...held, phase: 'refused' })
}

/**
 * The exact request last sent for this act, with its reference — only while
 * the tab that sent it is still open. Null after a reload, which is when the
 * outcome read takes over.
 */
export function lastAppointmentRequest(
  staffId: string,
  act: AppointmentAct,
  subjectId: string,
): { key: string; request: Record<string, unknown> } | null {
  const scope = scopeOf(act, subjectId)
  const held = readNote(scope)
  const request = requests.get(scope)
  if (!held || !usable(held, staffId) || !request) return null
  return { key: held.key, request: { ...request } }
}

/**
 * The reference held for this act, with or without its request — what the
 * outcome read is asked about. Null when nothing is held for this person.
 */
export function heldAppointmentAttempt(
  staffId: string,
  act: AppointmentAct,
  subjectId: string,
): AppointmentAttempt | null {
  const held = readNote(scopeOf(act, subjectId))
  return held && usable(held, staffId) ? held : null
}

/**
 * Every note this person left that still needs an answer.
 *
 * Deletes, rather than ignores, anybody else's note and anything not in the
 * shape this module writes. An unanswered note never expires merely because
 * the tablet was left open overnight. Only `sent` notes come back: a refused
 * one has nothing to recover.
 */
export function unresolvedAppointmentAttempts(staffId: string): AppointmentAttempt[] {
  const storage = store()
  const found = new Map<string, AppointmentAttempt>()

  if (storage) {
    const keys: string[] = []
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index)
        if (name && name.startsWith(PREFIX)) keys.push(name)
      }
    } catch {
      // Unreadable storage: fall back to what this page remembers.
    }
    for (const name of keys) {
      const scope = name.slice(PREFIX.length)
      const note = readNote(scope)
      if (!note) continue
      if (!usable(note, staffId)) {
        removeNote(scope)
        continue
      }
      found.set(scope, note)
    }
  }
  for (const [scope, note] of volatile) {
    if (!usable(note, staffId)) removeNote(scope)
    else if (!found.has(scope)) found.set(scope, note)
  }

  return [...found.values()].filter((note) => note.phase === 'sent')
}

/**
 * Forget a note on the person's word, once the clinic has said nothing was
 * recorded under it. Never called while an outcome is unknown.
 */
export function forgetAppointmentAttempt(act: AppointmentAct, subjectId: string): void {
  settleAppointmentAttempt(act, subjectId)
}
