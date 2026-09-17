/**
 * Frontend policy for consultation-attempt recovery.
 *
 * Codes are the backend contract; messages are for people. Keeping the branch
 * table here makes it testable that a new or reworded server message cannot
 * accidentally rotate an attempt or hide the recovery control.
 */

export type SigningRefusalAction = 'release' | 'inspect' | 'retry'

const SIGNING_REFUSALS: Record<string, SigningRefusalAction> = {
  ATTEMPT_NAMES_ANOTHER_CONSULTATION: 'release',
  ATTEMPT_SETTLED_BY_RECONCILIATION: 'release',
  ATTEMPT_NEEDS_RECONCILIATION: 'inspect',
  CONSULTATION_ALREADY_SIGNED: 'inspect',
  CONSULTATION_SIGNED_WITHOUT_THIS_VISIT: 'inspect',
  ATTEMPT_VISIT_NO_LONGER_ACTIVE: 'inspect',
  ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE: 'inspect',
  VISIT_RECONCILED_AND_CLOSED: 'inspect',
}

/** What the signing screen does after a coded refusal. */
export function signingRefusalAction(code?: string): SigningRefusalAction {
  if (!code) return 'retry'
  return SIGNING_REFUSALS[code] ?? 'retry'
}

export type Resolution = 'same_attendance' | 'new_attendance' | 'abandoned_attempt'

export const RESOLUTION_COPY: Record<Resolution, {
  label: string
  consequence: string
  confirmation: string
}> = {
  same_attendance: {
    label: 'Same attendance',
    consequence:
      'Keep the signed consultation unchanged, link this visit to it, and close the leftover visit. No new consultation or fee is created.',
    confirmation: 'Record same attendance',
  },
  new_attendance: {
    label: 'New attendance',
    consequence:
      'Record that the patient genuinely came back and keep this visit open. The old attempt is released; sign this visit normally afterwards. Nothing clinical or financial is created by this decision.',
    confirmation: 'Record new attendance',
  },
  abandoned_attempt: {
    label: 'Abandon attempt',
    consequence:
      'Record that the earlier attempt never completed and its original visit is no longer active. The attempt is released; no visit is closed and no fee is created.',
    confirmation: 'Record abandoned attempt',
  },
}

export type ReconciliationRefusalAction = 'look_again' | 'choose_visit' | 'show_duplicate' | 'hold'

const RECONCILIATION_REFUSALS: Record<string, ReconciliationRefusalAction> = {
  ATTEMPT_OUTCOME_NOT_ESTABLISHED: 'look_again',
  RECONCILIATION_ALREADY_RESOLVED: 'look_again',
  SUBJECT_VISIT_REQUIRED: 'choose_visit',
  SUBJECT_VISIT_NOT_OPEN: 'choose_visit',
  VISIT_NOT_THIS_PATIENTS: 'choose_visit',
  SUBJECT_VISIT_ALREADY_CONSULTED: 'show_duplicate',
  VISIT_RECONCILED_AND_CLOSED: 'look_again',
  ATTEMPT_NOT_COMMITTED: 'look_again',
  ATTEMPT_ALREADY_COMMITTED: 'look_again',
  ATTEMPT_VISIT_STILL_ACTIVE: 'look_again',
}

/** Every refusal leaves the attempt held. This only chooses the safe next UI. */
export function reconciliationRefusalAction(code?: string): ReconciliationRefusalAction {
  if (!code) return 'hold'
  return RECONCILIATION_REFUSALS[code] ?? 'hold'
}

/** A held attempt may be retried only after a read proves it wrote nothing. */
export function mayRetrySigning(
  priorOutcome: 'committed' | 'not_committed' | 'unknown',
  openedVisitId: string | null,
  liveVisitId?: string | null,
): boolean {
  if (priorOutcome !== 'not_committed') return false
  return openedVisitId === null || openedVisitId === (liveVisitId ?? null)
}
