/**
 * One name for one attempt at one thing, kept until that thing is confirmed.
 *
 * ── WHAT AN IDEMPOTENCY KEY IS FOR, AND WHAT BREAKS IT ─────────────────────
 *
 * The server can only refuse to do something twice if the tablet calls it the
 * same thing twice. So the key must survive exactly the moments a person is
 * most likely to press the button again: a refusal they have corrected, a
 * reply that never came back, and an outcome nobody knows. And it must NOT
 * survive a confirmed success, or the next patient's consultation would be
 * answered with the last one's.
 *
 * ── WHY THIS IS NOT `useState` ─────────────────────────────────────────────
 *
 * The counter keeps its dispense and payment keys in component state, which is
 * right as far as it goes and has one hole: React state dies when the
 * component unmounts. A doctor whose consultation ends in `Outcome not
 * confirmed`, who then switches to Today to see whether the patient is still
 * in the queue and comes back, returns with a fresh key — and a fresh key is
 * no protection at all, in precisely the situation the key exists for. A
 * tablet reloaded in the same moment loses it the same way.
 *
 * `sessionStorage` closes both. It survives an unmount and a reload, it dies
 * with the tab rather than accumulating on a shared tablet, and it is scoped
 * per origin like the session token beside it.
 *
 * Every access is wrapped, because storage throws rather than returns null in
 * a private window or where site data is blocked by policy — and a consultation
 * that cannot be signed because a storage quota was exceeded would be a far
 * worse fault than the one this prevents. The in-memory map is the fallback,
 * and it is exactly as good as the component state this replaces.
 *
 * Nothing here is displayed. No key reaches a screen, a label, or a printed
 * sheet; it is a reference the tablet and the clinic use to agree about what
 * has already happened.
 *
 * ── WHY AN ATTEMPT IS A RECORD AND NOT A STRING ────────────────────────────
 *
 * The first version of this stored a bare key under `consultation:<patient>`.
 * The record now also remembers which visit the attempt began under, but that
 * visit is evidence for reconciliation rather than permission to mint. A new
 * live visit can be the patient's next attendance, or it can be a duplicate
 * arrival created after a signing response was lost. Only a doctor can decide
 * which, through the audited Slice 2 reconciliation command.
 *
 * So an attempt carries the facts that say WHICH consultation it belongs to:
 * the visit it was opened against, and the clinic day it was minted on. The
 * key and BOTH visits travel to the clinic — the live one as `appointmentId`,
 * the stored one as `openedVisitId`. Neither a changed visit nor elapsed time
 * releases it; a confirmed signing or an audited resolution does.
 */

const PREFIX = 'jayamurugan_attempt:'

/** Survives an unmount. Does not survive a reload — that is what storage is for. */
const volatile = new Map<string, string>()

function readRaw(scope: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(PREFIX + scope) ?? volatile.get(scope) ?? null
  } catch {
    return volatile.get(scope) ?? null
  }
}

function writeRaw(scope: string, value: string): void {
  volatile.set(scope, value)
  try {
    globalThis.sessionStorage?.setItem(PREFIX + scope, value)
  } catch {
    // Private browsing, blocked site data, or a full quota. The in-memory copy
    // still protects everything except a reload.
  }
}

/**
 * One attempt at one consultation.
 *
 * `visitId` is the appointment the consultation was opened against, or null
 * for a patient seen without one. It is captured once and sent to the clinic
 * as `openedVisitId` beside the live visit, never instead of it. Sending it
 * alone let a consultation succeed while the visit it
 * belonged to stayed `waiting` and unlinked; sending only the live visit let a
 * cancelled one be signed around.
 *
 * `day` is the clinic day it was minted on, as `YYYY-MM-DD`. It is evidence
 * and nothing branches on it: an attempt outlives its day precisely because
 * elapsed time says nothing about what committed, and minting on a date change
 * is how a reply lost at 23:59 got charged twice at 00:01.
 */
export type Attempt = {
  key: string
  visitId: string | null
  day: string
}

function parse(raw: string | null): Attempt | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Attempt>
    if (typeof value?.key !== 'string' || !value.key) return null
    if (typeof value.day !== 'string' || !value.day) return null
    if (value.visitId !== null && typeof value.visitId !== 'string') return null
    return { key: value.key, visitId: value.visitId ?? null, day: value.day }
  } catch {
    // A bare key from the build that stored strings, or anything else that is
    // not an attempt. It cannot be interpreted as one — it names no visit and
    // no day — so it is discarded rather than guessed at.
    return null
  }
}

/** Today where the clinic is, which is the only day this application counts in. */
export function clinicDay(now: Date = new Date()): string {
  // `en-CA` is ISO-shaped, and the timezone is the clinic's rather than the
  // tablet's — a tablet whose clock is set to another zone still belongs to
  // this clinic's day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * The attempt in progress for this scope, or a new one.
 *
 * ── THE RULE, AND WHY EACH BRANCH OF IT ────────────────────────────────────
 *
 * An unresolved attempt is always REUSED. It is MINTED only when there is no
 * stored attempt because the previous one was confirmed or released by an
 * audited resolution. Getting that wrong costs something in both directions,
 * and the two costs are not symmetrical: minting when it should have reused
 * writes a second encounter and charges the patient twice, while reusing when
 * the patient genuinely returned produces a refusal and asks a doctor to say
 * so. The latter is the deliberate safe failure.
 *
 * - **A different clinic day is NOT a different consultation.** Elapsed time
 *   says nothing about what committed. The day used to mint, and a reply lost
 *   at 23:59 and retried at 00:01 therefore wrote a second encounter and a
 *   second fee — W1, by the clock. An unresolved attempt is retained across
 *   midnight and reconciled against what the clinic actually recorded: the
 *   same sheet replays, a different one is refused, and starting a genuinely
 *   new consultation is an explicit act rather than a date change.
 * - **One visit then and a DIFFERENT visit now is ambiguous.** Reception may
 *   have arrived the patient again after a lost response even though they
 *   never left. Reuse the attempt so the server can refuse with
 *   `ATTEMPT_NEEDS_RECONCILIATION`; the doctor then records Same attendance or
 *   New attendance. A queue row by itself is not proof of a second attendance.
 * - **No visit now, and a visit then** is the retry this whole mechanism
 *   exists for. Signing sets the appointment to `done` and the fifteen-second
 *   poll removes it from the snapshot, so the tablet correctly has nothing to
 *   send. Reuse the attempt — and send the LIVE value, which is nothing. The
 *   server treats a request naming no visit as compatible with a stored one,
 *   precisely because silence here is not disagreement.
 * - **A visit now, and NONE then** keeps the attempt, and the LIVE visit is
 *   what gets sent. A walk-in opened from the register has no visit row; if
 *   that signing ends outcome-unknown and the doctor then creates today's
 *   visit — which policy item 3 explicitly allows — the appearance of a visit
 *   row is not evidence of a second consultation, so the attempt is kept. But
 *   the attempt used to keep sending "no visit" as well, and that is what let
 *   a consultation succeed while the visit it belonged to sat in the queue as
 *   `waiting`, attached to nothing. Sending the live value lets the server
 *   link it when nothing has committed, and say so plainly when something has.
 * - **Neither then nor now** is a patient seen without a visit row, retried.
 *   Reuse.
 *
 * ── WHY REUSING IS THE SAFE DIRECTION TO GUESS IN ──────────────────────────
 *
 * Where the evidence is ambiguous this reuses, because the two mistakes do not
 * cost the same. Minting when it should have reused charges a patient twice
 * and nothing downstream can catch it — the fee's source key is derived from
 * the new encounter, so it is unique by construction. Reusing when it should
 * have minted sends a key the server can check against what that key actually
 * signed: a different live visit for this patient is answered with
 * `ATTEMPT_NEEDS_RECONCILIATION`, and the tablet offers the audited choice.
 * One explicit decision against a duplicate bill is not a close call.
 */
export function beginAttempt(
  scope: string,
  context: { visitId?: string | null; day?: string } = {},
): Attempt {
  const day = context.day ?? clinicDay()
  const liveVisit = context.visitId ?? null
  const stored = parse(readRaw(scope))

  /*
   * The clinic day is recorded and is NOT a reason to mint.
   *
   * It used to be. An attempt whose reply was lost at 23:59 and was retried at
   * 00:01 met a rule that said "a different day is a different consultation",
   * minted a fresh reference, and wrote a second encounter and a second ₹300
   * fee for one consultation — a known road back to W1, which is not something
   * a completed idempotency fix may leave open. Elapsed time is not evidence
   * about what committed; it is only evidence that time passed.
   *
   * So an unresolved attempt is retained across midnight and the earlier
   * outcome is reconciled instead: the same sheet replays, and a different one
   * is refused with `CONSULTATION_ALREADY_SIGNED` until the operator makes an
   * explicit transition. `day` stays on the record because it is worth knowing
   * when an attempt was opened, and because the reconciliation message says
   * so — but nothing branches on it.
   */
  if (stored) return stored

  const minted: Attempt = { key: crypto.randomUUID(), visitId: liveVisit, day }
  writeRaw(scope, JSON.stringify(minted))
  return minted
}

/** The attempt in progress for this scope, without minting one. */
export function currentAttempt(scope: string): Attempt | null {
  return parse(readRaw(scope))
}

/**
 * Let go of this attempt.
 *
 * Call it after the clinic has CONFIRMED the work, or when the operator
 * explicitly starts something new. Never after a failure, and never after an
 * outcome nobody knows — those are the two cases the attempt is holding open.
 */
export function clearAttempt(scope: string): void {
  volatile.delete(scope)
  try {
    globalThis.sessionStorage?.removeItem(PREFIX + scope)
  } catch {
    // As above.
  }
}
