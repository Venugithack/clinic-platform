/**
 * What the diagnostics reads answer, described once for both halves.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM `diagnostics.ts` ─────
 *
 * Slice 4 deliberately kept its view types beside the queries that build them
 * and out of `types.ts`, on the grounds that publishing a contract nothing
 * consumes invites a breaking change on the first day a real screen wants
 * something different. That was right then. A screen consumes them now, so
 * they move — and they move HERE rather than into `diagnostics.ts` because
 * that file imports `db.ts`, which imports `npm:postgres`. A page that
 * imported it would drag the Deno runtime into a browser bundle.
 *
 * So this is a leaf: **types only, zero imports, zero runtime**. The same
 * device `messaging-transport.ts` used to let the adapter and the state
 * machine speak without importing each other, and the same reason
 * `types.ts` has no imports of its own.
 *
 *     diagnostics-types.ts ◀── diagnostics.ts   (the backend that builds them)
 *              ▲
 *              └── types.ts ◀── lib/types.ts ◀── components/   (the screen)
 *
 * `types.ts` re-exports it, so `lib/types.ts` gets it for free and the
 * single-source rule that file states — "add a field here and both ends see
 * it at once" — keeps holding.
 *
 * ── EVERY UNION IS WRITTEN OUT ────────────────────────────────────────────
 *
 * Not `string`. A screen that branches on a state has to fail to compile when
 * a state is added or renamed, because the alternative is a branch that
 * silently stops matching and a row that silently renders as nothing. The
 * states, access levels, flag origins, conclusions, notification states,
 * suppression reasons and refusal codes below are each the closed set the
 * database constrains, and each one names the check constraint or the owner
 * item it comes from.
 */

/* ────────────────────────────────────────────────────── who is looking ── */

/**
 * Which half of a read the caller was given. Owner item 86.
 *
 * `clinical` is a doctor, or a nurse involved in that patient's care.
 * `operational` is an administrator: the request, the patient, what was asked
 * for, when it came back and who owes it a review — and none of the report.
 *
 * A screen must branch on this rather than on the role, because roles combine
 * and the clinic's owner holds two. Fields the server withholds are **absent
 * keys**, not empty strings: an administrator is shown no report text, not an
 * empty report.
 */
export type ResultAccessLevel = 'clinical' | 'operational'

/** Whose authority a review was recorded under. Owner item 86 names exactly three. */
export type ResultStanding = 'responsible_doctor' | 'ordering_doctor' | 'delegated_doctor'

/* ───────────────────────────────────────────────────────────── the flag ── */

/** `investigation_results.source_flag` / `doctor_flag` / the generated `effective_flag`. */
export type ResultFlag = 'none' | 'abnormal' | 'urgent' | 'critical'

/**
 * Where a transcribed flag came from. Owner item 85 allows two origins for a
 * flag somebody wrote down, and a third — the doctor's own — which lives in a
 * separate column pair and therefore is not in this union.
 */
export type SourceFlagOrigin = 'none' | 'external_report' | 'imported_structured'

/** How the report reached the clinic. `investigation_results.source`. */
export type ResultSource =
  | 'external_laboratory'
  | 'external_facility'
  | 'imported_structured_feed'
  | 'clinic_recorded'

/** What a document is, and where it came from. `result_documents.source`. */
export type ResultDocumentSource =
  | 'external_laboratory'
  | 'external_facility'
  | 'clinic_scanned'
  | 'imported_structured_feed'

export type ResultDocumentStatus = 'active' | 'superseded'

/** The three media types `/results` accepts and serves. */
export type ResultDocumentContentType = 'application/pdf' | 'image/jpeg' | 'image/png'

/* ─────────────────────────────────────────────────────────── the review ── */

/**
 * What a doctor concluded. `result_reviews.conclusion`.
 *
 * None of the three releases anything to the patient: owner item 88 makes
 * telling them a separate authorization, so even `patient_to_be_informed` is
 * a note about intent rather than an instruction the software acts on.
 */
export type ReviewConclusion =
  | 'no_action_needed'
  | 'patient_to_be_informed'
  | 'clinical_action_taken'

/** How the clinic reached the patient, when it did. Owner item 88's fourth fact. */
export type PatientContactMethod = 'telephone' | 'in_person' | 'other'

/* ───────────────────────────────────────────────── telling the patient ── */

/**
 * `message_outbox.status`, as a result-ready notice can hold it.
 *
 * Only `delivered` means the patient was told, and only an authenticated
 * provider status event produces it. `sent_to_provider` is Meta having
 * accepted the message and is two steps short; `outcome_unknown` is a reply
 * nobody heard and is never retried.
 */
export type NotificationState =
  | 'scheduled'
  | 'suppressed'
  | 'queued'
  | 'sent_to_provider'
  | 'delivered'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled'
  | 'outcome_unknown'

/**
 * Why a notice was not sent. Slice 3A's nine, plus Slice 4's two.
 *
 * Every one of them means the patient was not told, and each says something
 * different about whose job it now is. The empty string is a message that has
 * not been suppressed.
 */
export type NotificationSuppressionReason =
  | ''
  | 'no_consent'
  | 'consent_withdrawn'
  | 'channel_not_configured'
  | 'no_approved_template'
  | 'provider_template_not_approved'
  | 'no_contact_number'
  | 'link_destination_unavailable'
  | 'variable_unavailable'
  | 'past_useful_by'
  | 'result_superseded'
  | 'result_not_authorized'

/** What the patient has agreed to receive for this purpose. Owner item 78. */
export type ResultConsentState = 'opt_in' | 'withdraw' | 'none'

/**
 * The exact and entire wording owner item 88 permits.
 *
 * Here, as a constant, so a screen can show the doctor what will be sent
 * before they authorize it without retyping it — and so that the day the
 * wording changes, it changes in one place and the template's approved body
 * is the other. It carries no result value, no abnormal status, no diagnosis,
 * no medicine, no advice, no attachment and no link.
 */
export const RESULT_READY_MESSAGE =
  'Your investigation result has been reviewed and is ready. Please contact the clinic.'

/**
 * The sentence owner item 86 turns on, said in one place.
 *
 * A laboratory's signatory evidence and a clinic doctor's review are two
 * different facts and the screen has to say so beside them. Kept here so it
 * cannot drift from the field it qualifies.
 */
export const EXTERNAL_VALIDATION_CAVEAT =
  'Laboratory validation is not the clinic doctor’s review.'

/* ──────────────────────────────────────────────────────────── the state ── */

/**
 * What one requested line has reached, derived by the server from the rows
 * that justify it — never stored, and never dependent on who is reading.
 *
 * Read downwards: the first thing true is the answer.
 */
export type ItemState =
  | 'ordered'
  | 'in_progress'
  | 'overdue'
  | 'awaiting_review'
  | 'reviewed'
  | 'notification_pending'
  | 'provider_outcome_unknown'
  | 'notified'
  | 'manually_contacted'
  | 'closed'
  | 'cancelled'

/** Why owner item 87 put a result on the escalation list. */
export type EscalationReason = 'critical_unacknowledged' | 'unreviewed_past_clinic_hours'

/* ─────────────────────────────────────────────────────── refusal codes ── */

/**
 * Every refusal reachable from the doctor's result-review surface.
 *
 * The code decides what the screen DOES; the server's sentence is what it
 * SAYS. Matching on the sentence is how a reworded message becomes a silent
 * behaviour change, which is why these exist at all — and why this union is
 * exported rather than each screen keeping its own list of strings.
 */
export type ResultRefusalCode =
  | 'NOT_THE_RESPONSIBLE_DOCTOR'
  | 'DELEGATE_IS_NOT_A_DOCTOR'
  | 'ALREADY_FLAGGED'
  | 'ALREADY_REVIEWED'
  | 'NOT_A_CRITICAL_RESULT'
  | 'RESULT_SUPERSEDED'
  | 'RESULT_NOT_REVIEWED'
  | 'ORDER_CANCELLED'
  | 'CRITICAL_RESULT_NEEDS_DIRECT_CONTACT'
  | 'CRITICAL_CONTACT_IS_CLINICIAN_LED'
  | 'NOTIFICATION_ALREADY_AUTHORIZED'
  | 'NOTIFICATION_ALREADY_SCHEDULED'
  | 'NOT_THIS_PATIENTS_CARE'

/**
 * The refusals that mean somebody else already did it, or the world moved.
 *
 * The recovery is the same for all of them and it is not "try again": read
 * the authoritative order back, show what is actually recorded, and let the
 * doctor decide from that. Offering a retry here is how one tablet overwrites
 * another tablet's work.
 */
export const REFRESH_FIRST_REFUSALS: readonly ResultRefusalCode[] = [
  'ALREADY_FLAGGED',
  'ALREADY_REVIEWED',
  'RESULT_SUPERSEDED',
  'ORDER_CANCELLED',
  'NOTIFICATION_ALREADY_AUTHORIZED',
  'NOTIFICATION_ALREADY_SCHEDULED',
]

/* ──────────────────────────────────────────────────────── the read models ── */

export type ReviewQueueRow = {
  resultId: string
  orderId: string
  orderNumber: string
  patientName: string
  itemName: string
  receivedAt: string
  waitingHours: number
  responsibleDoctor: string
  delegatedDoctor: string
  escalatedToOwnerDoctor: boolean
  /** Clinical only. Absent for an administrator — owner item 86. */
  flag?: ResultFlag
  criticalUnacknowledged?: boolean
  acknowledgementOverdue?: boolean
}

export type ReviewQueue = {
  access: ResultAccessLevel
  /** Owner item 87's four clinic hours, as the server measures them. */
  escalationAfterClinicHours: number
  /**
   * Owner item 87's second boundary, and **not the clinic's closing time.**
   * The clinic has configured none; this is owner item 77's messaging
   * dispatch cutoff used as a conservative technical ceiling. A screen must
   * not present it as opening hours or as when the doors shut.
   */
  escalationCeilingHour: number
  criticalAcknowledgementMinutes: number
  rows: ReviewQueueRow[]
}

export type EscalationRow = {
  resultId: string
  orderNumber: string
  patientName: string
  itemName: string
  flag: ResultFlag
  receivedAt: string
  reason: EscalationReason
  /** Item 87's fifteen minutes have passed. Somebody owes a telephone call. */
  manualEscalationOwed: boolean
  responsibleDoctor: string
}

export type Escalations = {
  /**
   * Always `false`. Owner item 87 names "any explicitly configured backup
   * doctor"; the clinic has configured none and this application has nowhere
   * to hold one. Typed as the literal so a screen cannot render an imaginary
   * one behind a truthy check.
   */
  backupDoctorConfigured: false
  criticalAcknowledgementMinutes: number
  rows: EscalationRow[]
}

export type ResultDocumentView = {
  documentId: string
  contentType: ResultDocumentContentType
  byteSize: number
  checksum: string
  source: ResultDocumentSource
  uploadedBy: string
  uploadedAt: string
  status: ResultDocumentStatus
}

export type ResultReviewView = {
  reviewedBy: string
  reviewedAt: string
  basis: ResultStanding
  /** Clinical only. */
  conclusion?: ReviewConclusion
  note?: string
}

export type ResultNotificationView = {
  state: NotificationState
  suppressionReason: NotificationSuppressionReason
  deliveryStatus: string
  /**
   * True only when an authenticated provider delivery event settled it.
   * An authorization, a queued row, Meta's acceptance and an HTTP 200 are
   * each two or more steps short of this.
   */
  providerSaidDelivered: boolean
}

export type ResultView = {
  resultId: string
  receivedAt: string
  source: ResultSource
  /** False once a corrected report supersedes it. History, and not actionable. */
  current: boolean
  correctsResultId: string
  correctedByResultId: string

  /** Clinical only — absent keys for an administrator, never blank strings. */
  reportText?: string
  flag?: ResultFlag
  sourceFlag?: ResultFlag
  sourceFlagOrigin?: SourceFlagOrigin
  sourceFlagReference?: string
  doctorFlag?: ResultFlag
  doctorFlagReason?: string
  doctorFlagBy?: string

  externalValidatedBy: string
  externalSignatoryReference: string
  /** Stated in the payload so a table built later cannot mislabel it. */
  externalValidationIsNotClinicReview: true

  review: ResultReviewView | null
  criticalAcknowledgedBy: string
  criticalAcknowledgedAt: string
  notificationAuthorizedBy: string
  notificationAuthorizedAt: string
  notification: ResultNotificationView | null
  patientContactedBy: string
  patientContactedAt: string
  patientContactMethod: PatientContactMethod | ''
  documents: ResultDocumentView[]
}

export type InvestigationItemView = {
  itemId: string
  itemKind: 'investigation' | 'referral'
  itemName: string
  itemCode: string
  externalFacility: string
  state: ItemState
  cancelledReason: string
  /** Newest first. At most one carries `current: true`. */
  results: ResultView[]
}

export type InvestigationOrderView = {
  orderId: string
  orderNumber: string
  patientId: string
  patientName: string
  encounterId: string
  orderedBy: string
  responsibleDoctor: string
  delegatedDoctor: string
  delegationReason: string
  priority: 'routine' | 'urgent'
  clinicalIndication: string
  instructions: string
  externalFacility: string
  expectedBy: string
  status: 'open' | 'cancelled'
  cancelledReason: string
  createdAt: string
  overdue: boolean
  access: ResultAccessLevel
  items: InvestigationItemView[]
}

export type PatientInvestigations = {
  access: ResultAccessLevel
  orders: InvestigationOrderView[]
}

/* ────────────────────────────────────────── what the endpoints answer ── */

export type ReviewQueueResponse = { ok: true; queue: ReviewQueue } | { ok: false; message: string }
export type EscalationsResponse =
  | { ok: true; escalations: Escalations }
  | { ok: false; message: string }
export type InvestigationOrderResponse =
  | { ok: true; order: InvestigationOrderView }
  | { ok: false; message: string }

/** `GET /results?action=ticket&documentId=…`. Good for sixty seconds, one reader, one document. */
export type ResultDocumentTicketResponse =
  | { ok: true; ticket: string; expiresInSeconds: number }
  | { ok: false; message: string }
