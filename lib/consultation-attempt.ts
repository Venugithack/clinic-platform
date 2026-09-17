/**
 * The lifecycle of one attempt at signing one consultation.
 *
 * ── WHY THIS IS NOT INSIDE THE PANEL ───────────────────────────────────────
 *
 * `ConsultationPanel` is fifteen hundred lines of screen. The rules below are
 * four sentences, they are the difference between a patient being charged once
 * and twice, and two of the three defects found in this wiring during review
 * were of exactly the kind a test catches and a reading does not: a key
 * released on the wrong branch, and a key released inside a callback that does
 * not run when the panel unmounts mid-request.
 *
 * So the rules live here, where they can be exercised without a browser, and
 * the panel calls them. Nothing here touches React, the DOM, or the network;
 * the panel remains the only thing that knows how to draw a consultation.
 *
 * ── THE FOUR RULES ─────────────────────────────────────────────────────────
 *
 * 1. One attempt per consultation, named by the patient. It remembers the visit
 *    it was opened against until a confirmed signing or audited resolution ends
 *    it (`lib/attempt-key.ts`).
 * 2. The attempt survives a refusal, a lost reply and an outcome nobody knows.
 *    Those are the three moments somebody presses the button again.
 * 3. The attempt ends when the clinic CONFIRMS the signing, and at no other
 *    time — not when a draft is discarded, not when the panel unmounts, not on
 *    a timer.
 * 4. BOTH visits go to the clinic, in their own fields: the visit on screen as
 *    `appointmentId`, the attempt's own remembered one as `openedVisitId`.
 *    A later, different arrival never decides that this attempt is finished;
 *    the doctor-only reconciliation flow establishes that first.
 *
 *    Each was once the only one sent, and each omission had its own fault.
 *    Sending only the remembered value: for a walk-in it is `null` forever, so
 *    a consultation could be signed while the visit it belonged to sat in the
 *    queue, attached to nothing. Sending only the live value: an attempt whose
 *    visit was CANCELLED under it had nothing left to send, so the request
 *    looked like a direct consultation and the clinic wrote one — bypassing
 *    the cancellation and charging ₹300 against no visit at all.
 */
import { beginAttempt, clearAttempt, currentAttempt, type Attempt } from './attempt-key.ts'

/** The scope one patient's consultation attempt is stored under. */
export function consultationScope(patientId: string): string {
  // An empty patient is not a scope. Every caller reaches this with a selected
  // patient — the panel renders "No patient open" otherwise — but `consultation:`
  // as a shared bucket for "nobody" is the kind of thing that stops being
  // unreachable the day somebody adds a second caller, and an attempt in it
  // would be offered to whichever patient was opened next.
  if (!patientId) throw new Error('A consultation attempt needs a patient.')
  return `consultation:${patientId}`
}

/**
 * How a signing attempt ended, as far as the tablet can tell.
 *
 * `refused` and `unknown` are deliberately different words for what a person
 * experiences as the same disappointment, because they are not the same fact.
 * `refused` is the clinic answering — nothing was written and it said why.
 * `unknown` is no answer at all, which may mean nothing was written or may
 * mean everything was. Only the first is safe to treat as "nothing happened",
 * and neither is safe to treat as "start again with a new name".
 */
export type SigningResult =
  | { status: 'confirmed' }
  | { status: 'refused'; code?: string }
  | { status: 'unknown' }

/**
 * The refusal that means *this reference is not yours* — and the only refusal
 * a fresh one is the right answer to.
 *
 * The server raises it when the key names a consultation bound to a different
 * patient, doctor or visit. That is proof the attempt the tablet is holding
 * belongs to something else and is settled, so keeping it can only refuse
 * again, forever, for a patient who has done nothing wrong.
 *
 * Four siblings are deliberately NOT here, and all for the same reason: in
 * each of them a fresh reference writes a second encounter and a second fee
 * for what is probably one attendance, which is the whole of W1 arriving by
 * another road.
 *
 * - `CONSULTATION_ALREADY_SIGNED` — the key names THIS consultation, it
 *   committed, and the sheet has since been edited.
 * - `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` — it committed before the visit
 *   on screen existed.
 * - `ATTEMPT_VISIT_NO_LONGER_ACTIVE` — nothing committed, and the visit this
 *   attempt was opened against has been cancelled or closed. Rotating here is
 *   the most direct harm of the three: the next press would sign a direct
 *   consultation against a cancelled visit, which is precisely what the
 *   refusal exists to prevent.
 * - `ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE` — added by Slice 2. A doctor
 *   already recorded this visit as the same attendance as the consultation
 *   this reference signed, and closed the visit. A fresh reference would have
 *   no live visit left to name, so the next press would write a direct
 *   consultation and a second fee for the attendance just reconciled.
 * - `ATTEMPT_NEEDS_RECONCILIATION` — added by Slice 2. The key signed a
 *   consultation against one real visit and the tablet is naming a different
 *   real visit. That is either a patient who came back or a patient who never
 *   left and was arrived again by reception, and owner policy item 74 says the
 *   clinic must not decide between them: "Reception creating B is not, by
 *   itself, proof of a second consultation."
 *
 * ── SLICE 2 FRONTEND SAFETY CUTOVER ────────────────────────────────────────
 *
 * The backend exit is `resolve_consultation_attempt`, where a doctor records
 * **Same attendance**, **New attendance**, or an abandoned attempt, and the
 * read behind the control is `workspace?view=reconciliation`.
 *
 * The consultation screen now calls both contracts. It keeps the attempt when
 * the live visit changes, reads the durable outcome, and either permits a safe
 * retry or asks a doctor to record one of those audited decisions. Dismissal,
 * elapsed time, reload, unmount and a lost response do not release it. A
 * confirmed command response or an audited resolved read does. See
 * `docs/reference/SLICE2_FRONTEND_CONTRACT.md` §1.1.
 */
const ROTATE_ON = [
  'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
  /*
   * Added by Slice 2, and it is the one release that is neither a confirmed
   * signing nor a person pressing Next patient.
   *
   * It means a doctor has recorded, on the record and under their own name,
   * that this reference is closed — either as a genuinely new attendance or as
   * an attempt that was abandoned — and that nothing was written under it.
   * Owner policy item 73 names exactly that as the thing that may release an
   * attempt: "Only that audited resolution, or an already-confirmed successful
   * replay, may release the attempt."
   *
   * So this is not the automatic release the register spent three corrections
   * refusing. It is the audited one the owner approved, arriving as a code.
   * Its sibling `ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE` is deliberately absent:
   * there the doctor said the visit and the consultation are ONE attendance
   * and the visit was closed, so a fresh reference would have no live visit to
   * name and the next press would write a direct consultation and a second
   * fee for the attendance just reconciled.
   */
  'ATTEMPT_SETTLED_BY_RECONCILIATION',
]

/**
 * The key to sign under, and the visit to sign it against.
 *
 * `liveVisitId` is what the snapshot says right now. It is sent to the backend,
 * but it never rotates a held attempt: a different visit is ambiguous until
 * the doctor records the audited resolution.
 *
 * What the panel sends is both — the live visit as `appointmentId`, and the
 * attempt's stored `visitId` as `openedVisitId`. An earlier version kept the
 * stored value on the tablet and sent only the live one, and that is how a
 * visit cancelled under an attempt came to be signed around: with nothing live
 * left to name, the request looked like a direct consultation and the server
 * wrote one.
 */
export function openConsultationAttempt(
  patientId: string,
  liveVisitId?: string | null,
): Attempt {
  return beginAttempt(consultationScope(patientId), { visitId: liveVisitId ?? null })
}

/** The attempt this tab is already holding, without creating or releasing one. */
export function heldConsultationAttempt(patientId: string): Attempt | null {
  return currentAttempt(consultationScope(patientId))
}

/**
 * End the attempt, or deliberately do not.
 *
 * Returns whether it was released, which is what the tests assert and what
 * makes rule 3 a statement rather than an intention.
 *
 * Three things release an attempt and they are not the same thing. A CONFIRMED
 * signing releases it because the work is done. A refusal carrying
 * `ATTEMPT_NAMES_ANOTHER_CONSULTATION` releases it because the reference was
 * never this consultation's to begin with — the server says so in those words
 * and promises the tablet will use a fresh one, and a promise the tablet does
 * not keep is worse than one it never made. And a refusal carrying
 * `ATTEMPT_SETTLED_BY_RECONCILIATION` releases it because a doctor has
 * recorded that it is closed, which owner item 73 names as the one audited
 * release. Everything else — a plain refusal, an outcome nobody knows — keeps
 * it, which is rule 2.
 */
export function settleConsultationAttempt(
  patientId: string,
  result: SigningResult,
): boolean {
  const stale = result.status === 'refused'
    && result.code !== undefined
    && ROTATE_ON.includes(result.code)
  if (result.status !== 'confirmed' && !stale) return false
  clearAttempt(consultationScope(patientId))
  return true
}

/**
 * End the attempt after a permitted terminal transition.
 *
 * This covers Next patient after confirmed signing and the reconciliation
 * component after a confirmed command or durable resolved read. It must never
 * be called for a dismissed dialog, elapsed time, unmount, or lost response.
 */
export function abandonConsultationAttempt(patientId: string): void {
  clearAttempt(consultationScope(patientId))
}
