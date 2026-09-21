/**
 * The outpatient diagnostics loop: order, result, review, tell the patient.
 *
 * Owner policy register items 84–88, approved 19 September 2026, closing
 * backend decision register entries D13 to D17. The schema is
 * `20260926000000_slice4_diagnostics.sql` and its header explains every table;
 * this file is the authority layer and the state derivation on top of it.
 *
 * ── THE FOUR AUTHORITIES, AND WHY THEY ARE FOUR ────────────────────────────
 *
 * Four different questions get asked here and they have four different
 * answers. Collapsing any two of them is how a permission system becomes a
 * rumour:
 *
 *   an AUTHORIZED DOCTOR       may approve catalogue content (item 84).
 *                              That is `staff.can_publish_clinical_templates`
 *                              AND the doctor role, never one without the
 *                              other, and never an admin.
 *   a DOCTOR WITH STANDING     on one order — its responsible doctor, the
 *                              doctor who ordered it, or a doctor explicitly
 *                              delegated to it — may flag, review, authorize
 *                              and contact (items 85–88).
 *   a TRANSCRIBER              — admin, nurse or doctor — may write down what
 *                              a report says, including the flag the report
 *                              itself carries, and may originate no clinical
 *                              judgment at all (items 85, 86).
 *   the PHARMACY               may do none of it and see none of it, and is
 *                              refused at the top of the endpoint rather than
 *                              beside each query (item 86).
 *
 * ── AND THE ONE THING NO AUTHORITY COVERS ──────────────────────────────────
 *
 * Nothing in this file decides that a result is abnormal. There is no
 * threshold, no range, no parse of the report text and no model. Every flag
 * this application holds was written down by somebody: a laboratory, an
 * identified feed, or a doctor with their name against it. `effective_flag` is
 * a generated column in the database that takes the more severe of the two
 * recorded flags, which is the only operation on a flag that exists anywhere
 * in this application — and it is in the schema so that it can be read rather
 * than searched for.
 */
import { randomUUID } from 'node:crypto'
import { hasRole } from './auth.ts'
import { audit, db, isoNow, transaction } from './db.ts'
import type { SessionView } from './types.ts'
/*
 * The read models, from the leaf that both halves import.
 *
 * Type-only, so nothing here reaches a browser bundle by accident — and the
 * screen consuming them imports the same declarations through `lib/types.ts`
 * rather than a hand-copy that agrees until the day it does not.
 */
import type {
  Escalations, EscalationRow, InvestigationItemView, InvestigationOrderView,
  ItemState, PatientInvestigations, ResultDocumentContentType, ResultDocumentSource,
  ResultDocumentStatus, ResultFlag, ResultReviewView, ResultSource, ResultStanding,
  ResultView, ReviewConclusion, ReviewQueue, ReviewQueueRow, SourceFlagOrigin,
  NotificationState, NotificationSuppressionReason, PatientContactMethod,
} from './diagnostics-types.ts'
export type {
  Escalations, EscalationRow, InvestigationItemView, InvestigationOrderView,
  ItemState, PatientInvestigations, ResultStanding, ResultView, ReviewQueue, ReviewQueueRow,
}
import {
  CommandRefusal, optional, optionalDate, requireChoice, requireRole, sequence, value,
  type Payload,
} from './command-input.ts'
import { isUniqueViolation, requestFingerprint } from './idempotency.ts'
import {
  closeResultReadySchedules, effectiveConsent, openResultReadySchedule,
} from './messaging.ts'
import { runMessagingCommand } from './messaging.ts'
import {
  DISPATCH_WINDOW_END_HOUR, DISPATCH_WINDOW_START_HOUR,
  RESULT_ESCALATION_CEILING_HOUR, UNREVIEWED_RESULT_ESCALATION_HOURS,
  CRITICAL_ACKNOWLEDGEMENT_MINUTES,
} from './clinic-policy.ts'

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')

/*
 * The clinic's own clock, as SQL, written out here rather than imported.
 *
 * `clinic-policy.ts` says why: "the clinic timezone stays where it is (an SQL
 * fragment repeated in six modules, with the reasoning written out in each)
 * because it is a fragment rather than a value and changing it is a
 * schema-wide decision rather than a policy edit". This is the seventh module
 * and follows the same convention rather than quietly starting a new one.
 *
 * Every hour comparison below happens in Postgres in `Asia/Kolkata`. The
 * server runs UTC five and a half hours behind, so an escalation computed in
 * JavaScript against a local hour would fire at the wrong time for the whole
 * evening, which is exactly the stretch owner item 87 is about.
 */
const CLINIC_ZONE = `'Asia/Kolkata'`
const clinicDateOf = (expr: string) => `((${expr}) at time zone ${CLINIC_ZONE})::date`
const atClinicHour = (dateExpr: string, hour: number) =>
  `(((${dateExpr}) + make_time(${hour}, 0, 0)) at time zone ${CLINIC_ZONE})`
const clinicHourOf = (expr: string) =>
  `extract(hour from ((${expr}) at time zone ${CLINIC_ZONE}))`

/**
 * Four elapsed hours, moved to the next clinic opening if they would land when
 * nobody is there.
 *
 * The same reading of "four clinic hours" that Slice 3A adopted for owner item
 * 79 and wrote down in `SCHEMA_AND_TYPES.md` §15.5, applied to item 87's
 * identical phrase. It is one interpretation used twice rather than two
 * interpretations that happen to agree today.
 */
const nextClinicOpening = (expr: string) => `(
  case
    when ${clinicHourOf(expr)} < ${DISPATCH_WINDOW_START_HOUR}
      then ${atClinicHour(clinicDateOf(expr), DISPATCH_WINDOW_START_HOUR)}
    when ${clinicHourOf(expr)} >= ${DISPATCH_WINDOW_END_HOUR}
      then ${atClinicHour(`${clinicDateOf(expr)} + 1`, DISPATCH_WINDOW_START_HOUR)}
    else (${expr})
  end)`

/**
 * The first ceiling at or after a moment — item 87's "or at clinic closing,
 * whichever is earlier".
 *
 * **This is not the clinic's closing time and must not be described as one.**
 * The clinic has not configured a closing time and this application holds
 * none: `provider_availability` is one doctor's optional consulting windows,
 * not the clinic's day. `RESULT_ESCALATION_CEILING_HOUR` is a conservative
 * technical ceiling under its own constant, and owner policy item 87 records
 * the interpretation and what one owner value would replace.
 */
const escalationCeiling = (expr: string) => `(
  case
    when ${clinicHourOf(expr)} < ${RESULT_ESCALATION_CEILING_HOUR}
      then ${atClinicHour(clinicDateOf(expr), RESULT_ESCALATION_CEILING_HOUR)}
    else ${atClinicHour(`${clinicDateOf(expr)} + 1`, RESULT_ESCALATION_CEILING_HOUR)}
  end)`

/**
 * When an unreviewed result reaches the owner-doctor. Item 87, both halves.
 *
 * `least(...)` of the two, and the two are computed from `received_at` so that
 * the answer does not depend on when the question is asked.
 */
const ESCALATION_DUE_AT = `least(
  ${nextClinicOpening(`r.received_at + make_interval(hours => ${UNREVIEWED_RESULT_ESCALATION_HOURS})`)},
  ${escalationCeiling('r.received_at')}
)`

/* ════════════════════════════════════════════════════════════ authority ══ */

/**
 * Whether this session may put its name to clinical catalogue content.
 *
 * Owner item 84's "another explicitly authorized registered doctor", and the
 * same authority `messaging.ts` uses for owner items 80 and 81:
 * `staff.can_publish_clinical_templates`, whose migration says in as many
 * words that after the one compatibility backfill "the flag is managed
 * explicitly and is never inferred from admin".
 *
 * Item 84's last clause is the reason both halves are checked separately:
 * "'Doctor-level' never means a non-doctor with an elevated software
 * permission." An administrator who has been given the flag — which the flag's
 * own history shows is possible — still fails `requireRole(session,'doctor')`.
 *
 * And item 84's other clause, which this cannot enforce and must not pretend
 * to: the doctor must be REGISTERED. This application has no evidence of
 * anybody's professional registration and does not check for one. That is an
 * onboarding and governance obligation, recorded under owner item 84 and in
 * `SCHEMA_AND_TYPES.md` §17, rather than implied by a permission passing.
 */
function requireAuthorizedDoctor(session: SessionView, what: string): void {
  requireRole(session, 'doctor')
  if (!session.canPublishClinicalTemplates) {
    throw new CommandRefusal(
      `You are not authorized to ${what}. The owner-doctor, or a doctor the owner has explicitly ` +
      'authorized, does that.',
      'NOT_AN_AUTHORIZED_DOCTOR',
    )
  }
}

/**
 * Which authority, if any, this doctor holds over one order.
 *
 * Owner item 86 names three and this returns exactly those three. It
 * deliberately does NOT return a fourth for the owner-doctor: item 86 says the
 * responsible, ordering or explicitly delegated doctor reviews, and an
 * owner-doctor who needs to take a stranded result over does so by delegating
 * it — to themselves if that is what is happening — which leaves an explicit,
 * audited delegation rather than an implicit standing that nothing records.
 *
 * Item 87's escalation is what makes that workable: a result nobody has
 * reviewed reaches the owner-doctor's queue, and `delegate_result_review` is
 * open to them precisely so that the queue has something to do about it.
 */
function standingOn(session: SessionView, order: Row): ResultStanding | null {
  if (!hasRole(session, 'doctor')) return null
  if (text(order.responsible_doctor_id) === session.staffId) return 'responsible_doctor'
  if (text(order.ordered_by) === session.staffId) return 'ordering_doctor'
  if (text(order.delegated_doctor_id) === session.staffId) return 'delegated_doctor'
  return null
}

function requireStanding(session: SessionView, order: Row, what: string): ResultStanding {
  const standing = standingOn(session, order)
  if (!standing) {
    throw new CommandRefusal(
      `Only the doctor responsible for this request, the doctor who ordered it, or a doctor ` +
      `explicitly delegated to it may ${what}. Owner policy item 86.`,
      'NOT_THE_RESPONSIBLE_DOCTOR',
    )
  }
  return standing
}

export type ResultAccess =
  | { allowed: true; basis: string; content: boolean }
  | { allowed: false; basis: string; message: string }

/**
 * May this person see this patient's results, and may they see what the
 * reports say?
 *
 * Owner item 86, as one function, because the answer is asked from four read
 * models and a rule written four times is a rule that will differ in one of
 * them. `content` is the second, narrower question — report text, flags,
 * review notes — and it is what separates an administrator managing
 * outstanding work from an administrator reading a patient's serology.
 *
 *   DOCTOR      everything.
 *   NURSE       everything, while involved in that patient's care. Item 86
 *               lets a nurse attach and transcribe a report, which is not
 *               possible without reading it; "minimum necessary" is therefore
 *               about WHICH patients, and `nurse_care_involvement` — already
 *               the clinic's answer to that question for photographs — is
 *               derived from work the nurse actually did.
 *   ADMIN       that the order exists, what was asked for, when it came back,
 *               how long it has been waiting and who owes it a review. Not
 *               the report, not the flag, not the review note. Item 86:
 *               "operational/audit metadata needed to manage outstanding
 *               work, not unrestricted result content."
 *   PHARMACY    nothing, and it is refused first so that no later branch can
 *               be the one that forgets.
 */
export async function mayAccessResults(
  session: SessionView,
  patientId: string,
): Promise<ResultAccess> {
  if (hasRole(session, 'pharmacy') && !hasRole(session, 'admin', 'doctor', 'nurse')) {
    return {
      allowed: false,
      basis: 'pharmacy',
      message: 'The pharmacy counter has no access to investigations or results.',
    }
  }

  if (hasRole(session, 'doctor')) return { allowed: true, basis: 'doctor', content: true }

  if (hasRole(session, 'nurse')) {
    const involved = await db.prepare(
      `select involvement from nurse_care_involvement
        where nurse_id = ? and patient_id = ? order by since desc limit 1`,
    ).get(session.staffId, patientId) as Row | undefined
    if (involved) {
      return { allowed: true, basis: `nurse_care:${text(involved.involvement)}`, content: true }
    }
    return {
      allowed: false,
      basis: 'nurse_not_involved',
      message:
        'A nurse may see a patient\'s results only while involved in that patient\'s care. ' +
        'Record the vitals or the observation you are here for, or ask the doctor.',
    }
  }

  if (hasRole(session, 'admin')) {
    return { allowed: true, basis: 'admin_operational', content: false }
  }

  return { allowed: false, basis: 'no_role', message: 'Your role cannot see investigations.' }
}

/** The order behind one result, with everything an authority check needs. */
async function orderForResult(resultId: string): Promise<Row | undefined> {
  return await db.prepare(
    `select o.id, o.order_number, o.patient_id, o.ordered_by, o.responsible_doctor_id,
            o.delegated_doctor_id, o.status as order_status,
            i.id as item_id, i.item_name, i.cancelled_at as item_cancelled_at,
            r.id as result_id, r.superseded_at, r.effective_flag,
            r.critical_acknowledged_at, r.notification_authorized_at,
            r.notification_schedule_id, r.patient_contacted_at,
            r.source_flag, r.doctor_flag
       from investigation_results r
       join investigation_order_items i on i.id = r.order_item_id
       join investigation_orders o on o.id = i.order_id
      where r.id = ?`,
  ).get(resultId) as Row | undefined
}

/** The same, holding the result row so a second caller waits rather than races. */
async function lockResult(resultId: string): Promise<Row | undefined> {
  const locked = await db.prepare(
    `select id from investigation_results where id = ? for update`,
  ).get(resultId) as Row | undefined
  if (!locked) return undefined
  return await orderForResult(resultId)
}

/* ═══════════════════════════════════════════════════════ the catalogue ══ */

/**
 * The hash of the clinical half of a catalogue entry.
 *
 * The operational half — code, facility, label, orderable — is deliberately
 * outside it. Correcting a laboratory's telephone extension is not a new
 * version of a blood test, and a fingerprint that said it was would make every
 * administrator's tidy-up a clinical approval.
 */
function catalogueFingerprint(material: {
  kind: string
  displayName: string
  category: string
  specimen: string
  preparation: string
}): string {
  return requestFingerprint(material)
}

/* ══════════════════════════════════════════════════════════════ states ══ */

/**
 * What one requested item has reached, derived from the rows that justify it.
 *
 * There is no status column on an order item. Every value below is read off a
 * timestamp or the existence of a row, so there is no second copy of the truth
 * to fall out of step with the first — which is the failure mode the programme
 * names as "one mutable status erasing the events that justify it".
 *
 * `overdue` is the one value a clock produces, and it is deliberately about
 * the ORDER rather than about anybody's health: the expected-by date the
 * ordering doctor set has passed and nothing has come back. It releases
 * nothing and reviews nothing.
 */
/**
 * What the state is derived FROM, kept apart from what a reader is shown.
 *
 * The state of a line is a fact about the clinic, not about who is looking at
 * it, and the first version of this derived it from the already-minimized
 * `ResultView` — so an administrator, who is not shown a review's conclusion,
 * saw `reviewed` on a line a doctor saw as `closed`. Nothing leaked; the
 * clinic simply reported two different states for one line depending on who
 * asked, which is the kind of thing that is discovered during an argument
 * about whether something was dealt with.
 *
 * So the derivation reads these, which are never serialized, and the
 * minimization happens only on the way out. `closed` versus `reviewed` is
 * operational — is there outstanding work on this line — and is exactly what
 * owner item 86 lets an administrator see.
 */
export type ResultStateFacts = {
  current: boolean
  reviewed: boolean
  reviewConclusion: string
  notificationState: string
  providerSaidDelivered: boolean
  notificationAuthorized: boolean
  patientContacted: boolean
}

/* ════════════════════════════════════════════════════════════ commands ══ */

export async function runDiagnosticsCommand(
  session: SessionView,
  action: string,
  payload: Payload,
): Promise<{ message: string; data?: Record<string, unknown>; unchanged?: boolean }> {
  switch (action) {
    /* ─────────────────────────────────────── the catalogue, owner item 84 */

    /*
     * Justified by item 84 directly: an administrator "may prepare
     * non-clinical metadata" and an authorized doctor approves clinical
     * content, which only means something if there is a moment at which a
     * version became approvable. Without a command to write one there is no
     * catalogue at all, and a seeded catalogue would be clinical content
     * nobody approved — the same argument `draft_message_template` makes for
     * owner item 81, and the same shape.
     */
    case 'draft_investigation': {
      requireRole(session, 'admin', 'doctor')
      const kind = requireChoice(payload, 'kind', ['investigation', 'referral'] as const)
      const displayName = value(payload, 'displayName')
      const category = requireChoice(payload, 'category', [
        'haematology', 'biochemistry', 'microbiology', 'histopathology',
        'imaging', 'cardiology', 'specialist_referral', 'other',
      ] as const)
      const specimen = optional(payload, 'specimen')
      const preparation = optional(payload, 'preparation')
      const seriesId = optional(payload, 'seriesId') || randomUUID()

      if (kind === 'referral' && specimen) {
        throw new CommandRefusal(
          'A referral sends the patient, not a specimen.',
          'REFERRAL_HAS_NO_SPECIMEN',
        )
      }

      const fingerprint = catalogueFingerprint({
        kind, displayName, category, specimen, preparation,
      })

      const id = randomUUID()
      let version = 1
      await transaction(async () => {
        const previous = await db.prepare(
          `select id, version, content_fingerprint from investigation_catalogue
            where series_id = ? order by version desc limit 1 for update`,
        ).get(seriesId) as Row | undefined

        if (previous) {
          version = Number(previous.version) + 1
          if (text(previous.content_fingerprint) === fingerprint) {
            throw new CommandRefusal(
              'This is word for word the previous version of this entry. A new version records a ' +
              'change to what the investigation IS; codes, the facility and the label are the ' +
              'operational half and are maintained without a version.',
              'CATALOGUE_UNCHANGED',
            )
          }
        }

        await db.prepare(
          `insert into investigation_catalogue
             (id, series_id, version, kind, display_name, category, specimen, preparation,
              external_code, code_system, default_facility, operational_label, orderable,
              approval_state, created_by, supersedes_id, content_fingerprint)
           values (?,?,?,?,?,?,?,?, ?,?,?,?,?, 'draft', ?,?,?)`,
        ).run(
          id, seriesId, version, kind, displayName, category, specimen, preparation,
          optional(payload, 'externalCode'), optional(payload, 'codeSystem'),
          optional(payload, 'defaultFacility'), optional(payload, 'operationalLabel'),
          payload.orderable === false ? false : true,
          session.staffId, previous ? text(previous.id) : null, fingerprint,
        )

        await audit(
          session.staffId, 'investigation_catalogue.drafted', 'investigation_catalogue', id,
          `Drafted ${kind} “${displayName}” v${version}`,
        )
      })

      return {
        message:
          `Draft version ${version} saved. A doctor authorized to approve clinical content has to ` +
          'approve it before anybody can order it.',
        data: { catalogueId: id, seriesId, version, contentFingerprint: fingerprint },
      }
    }

    /*
     * Item 84's own act, by name. The previous live version of the series
     * retires in the same transaction, because one approved version per series
     * is a unique index and leaving the old one for somebody to tidy up would
     * make this command fail on its second use.
     */
    case 'approve_investigation': {
      requireAuthorizedDoctor(session, 'approve clinical catalogue content')
      const catalogueId = value(payload, 'catalogueId')

      let name = ''
      await transaction(async () => {
        const entry = await db.prepare(
          `select id, series_id, version, display_name, approval_state
             from investigation_catalogue where id = ? for update`,
        ).get(catalogueId) as Row | undefined
        if (!entry) throw new Error('That catalogue version was not found.')
        if (text(entry.approval_state) !== 'draft') {
          throw new CommandRefusal(
            `This version is already ${text(entry.approval_state)}.`,
            'CATALOGUE_NOT_A_DRAFT',
          )
        }
        name = text(entry.display_name)

        const live = await db.prepare(
          `select id from investigation_catalogue
            where series_id = ? and approval_state = 'approved' for update`,
        ).get(text(entry.series_id)) as Row | undefined
        if (live) {
          await db.prepare(
            `update investigation_catalogue
                set approval_state = 'retired', retired_by = ?, retired_at = now()
              where id = ?`,
          ).run(session.staffId, text(live.id))
        }

        await db.prepare(
          `update investigation_catalogue
              set approval_state = 'approved', approved_by = ?, approved_at = now()
            where id = ?`,
        ).run(session.staffId, catalogueId)

        await audit(
          session.staffId, 'investigation_catalogue.approved', 'investigation_catalogue',
          catalogueId, `Approved “${name}” v${text(entry.version)}`,
        )
      })

      return { message: `“${name}” is approved and can be ordered.`, data: { catalogueId } }
    }

    /*
     * Item 84 names retirement beside versioning, and they are different
     * things: a new version replaces a definition, retirement withdraws one
     * with nothing in its place. Orders already placed keep pointing at it,
     * which is why it is retired rather than deleted.
     */
    case 'retire_investigation': {
      requireAuthorizedDoctor(session, 'retire clinical catalogue content')
      const catalogueId = value(payload, 'catalogueId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const changed = await db.prepare(
          `update investigation_catalogue
              set approval_state = 'retired', retired_by = ?, retired_at = now()
            where id = ? and approval_state = 'approved'`,
        ).run(session.staffId, catalogueId)
        if (Number(changed.changes) !== 1) {
          throw new CommandRefusal(
            'Only an approved catalogue entry can be retired, and this one is not.',
            'CATALOGUE_NOT_APPROVED',
          )
        }
        await audit(
          session.staffId, 'investigation_catalogue.retired', 'investigation_catalogue',
          catalogueId, `Retired: ${reason}`,
        )
      })

      return { message: 'Retired. Requests already placed keep the definition they were placed under.' }
    }

    /*
     * Item 84's administrator clause, and the only command in this file an
     * administrator may run against the catalogue.
     *
     * The trigger on the table is what makes this safe to offer: an
     * administrator physically cannot reach the kind, the name, the category,
     * the specimen or the preparation from here or from anywhere else, so the
     * boundary between "preparing metadata" and "approving clinical content"
     * is held by the database rather than by this switch statement.
     */
    case 'update_investigation_metadata': {
      requireRole(session, 'admin', 'doctor')
      const catalogueId = value(payload, 'catalogueId')

      await transaction(async () => {
        const entry = await db.prepare(
          `select id, display_name, approval_state, external_code, code_system,
                  default_facility, operational_label, orderable
             from investigation_catalogue where id = ? for update`,
        ).get(catalogueId) as Row | undefined
        if (!entry) throw new Error('That catalogue version was not found.')
        if (text(entry.approval_state) === 'retired') {
          throw new CommandRefusal(
            'That entry is retired. Publish and approve a new version instead.',
            'CATALOGUE_RETIRED',
          )
        }

        const externalCode = payload.externalCode === undefined
          ? text(entry.external_code) : optional(payload, 'externalCode')
        const codeSystem = payload.codeSystem === undefined
          ? text(entry.code_system) : optional(payload, 'codeSystem')
        const facility = payload.defaultFacility === undefined
          ? text(entry.default_facility) : optional(payload, 'defaultFacility')
        const label = payload.operationalLabel === undefined
          ? text(entry.operational_label) : optional(payload, 'operationalLabel')
        const orderable = payload.orderable === undefined
          ? entry.orderable === true : payload.orderable !== false

        await db.prepare(
          `update investigation_catalogue
              set external_code = ?, code_system = ?, default_facility = ?,
                  operational_label = ?, orderable = ?,
                  metadata_updated_by = ?, metadata_updated_at = now()
            where id = ?`,
        ).run(externalCode, codeSystem, facility, label, orderable, session.staffId, catalogueId)

        await audit(
          session.staffId, 'investigation_catalogue.metadata_updated',
          'investigation_catalogue', catalogueId,
          `Operational details updated for “${text(entry.display_name)}”`,
        )
      })

      return {
        message:
          'Operational details updated. What the investigation is, clinically, is unchanged and ' +
          'still carries its approval.',
      }
    }

    /* ───────────────────────────────────────────── ordering, owner item 86 */

    /*
     * One of the four commands the programme names.
     *
     * Doctor only. Nothing in owner policy permits anybody else to order an
     * investigation or write a referral, and the safe default when policy is
     * silent is the narrower rule.
     */
    case 'order_investigation': {
      requireRole(session, 'doctor')
      const key = value(payload, 'idempotencyKey')
      const patientId = value(payload, 'patientId')
      const encounterId = optional(payload, 'encounterId')
      const priority = requireChoice(payload, 'priority', ['routine', 'urgent'] as const, 'routine')
      const catalogueIds = Array.isArray(payload.items)
        ? (payload.items as unknown[]).map((entry) => String(entry).trim()).filter(Boolean)
        : []
      const responsibleDoctorId = optional(payload, 'responsibleDoctorId') || session.staffId

      const fingerprint = requestFingerprint({
        command: 'order_investigation',
        actor: session.staffId,
        patientId, encounterId, priority, items: catalogueIds, responsibleDoctorId,
        clinicalIndication: optional(payload, 'clinicalIndication'),
        instructions: optional(payload, 'instructions'),
        externalFacility: optional(payload, 'externalFacility'),
        expectedBy: optionalDate(payload, 'expectedBy') ?? null,
      })

      /*
       * The receipt first, before any question about the clinic now.
       *
       * An exact retry that arrives after the patient has been discharged, or
       * after a catalogue entry has been retired, is still the same request
       * and must get the same answer. Deriving a mutable prerequisite before
       * locating the committed row is how a retry comes to be told that work
       * it already did has failed — the fault Slice 2's third acceptance
       * review reproduced twice.
       */
      const replay = await replayOrder(key, fingerprint)
      if (replay) return replay

      if (catalogueIds.length === 0) {
        throw new CommandRefusal('A request names at least one investigation or referral.', 'NOTHING_ORDERED')
      }

      const orderId = randomUUID()
      let orderNumber = ''
      const placed: { id: string; name: string }[] = []

      try {
        orderNumber = await sequence('REQ')
        await transaction(async () => {
          const patient = await db.prepare('select id, name from patients where id = ?')
            .get(patientId) as Row | undefined
          if (!patient) throw new Error('That patient was not found.')

          const doctor = await db.prepare(
            `select id, roles_json from staff where id = ? and active = 1`,
          ).get(responsibleDoctorId) as Row | undefined
          if (!doctor || !text(doctor.roles_json).includes('"doctor"')) {
            throw new CommandRefusal(
              'The doctor responsible for a request has to be a doctor.',
              'RESPONSIBLE_IS_NOT_A_DOCTOR',
            )
          }

          await db.prepare(
            `insert into investigation_orders
               (id, order_number, patient_id, encounter_id, ordered_by, responsible_doctor_id,
                priority, clinical_indication, instructions, external_facility, expected_by,
                status, idempotency_key, request_fingerprint)
             values (?,?,?,?,?,?, ?,?,?,?, ?::date, 'open', ?,?)`,
          ).run(
            orderId, orderNumber, patientId, encounterId || null, session.staffId,
            responsibleDoctorId, priority,
            optional(payload, 'clinicalIndication'), optional(payload, 'instructions'),
            optional(payload, 'externalFacility'), optionalDate(payload, 'expectedBy') ?? null,
            key, fingerprint,
          )

          for (const catalogueId of catalogueIds) {
            const entry = await db.prepare(
              `select id, kind, display_name, external_code, default_facility,
                      approval_state, orderable
                 from investigation_catalogue where id = ?`,
            ).get(catalogueId) as Row | undefined
            if (!entry) throw new Error('One of the investigations asked for was not found.')
            if (text(entry.approval_state) !== 'approved') {
              throw new CommandRefusal(
                `“${text(entry.display_name)}” is not an approved catalogue entry and cannot be ordered.`,
                'CATALOGUE_NOT_APPROVED',
              )
            }
            if (entry.orderable !== true) {
              throw new CommandRefusal(
                `“${text(entry.display_name)}” is not currently available to order.`,
                'CATALOGUE_NOT_ORDERABLE',
              )
            }

            const itemId = randomUUID()
            await db.prepare(
              `insert into investigation_order_items
                 (id, order_id, patient_id, catalogue_id, item_kind, item_name, item_code,
                  external_facility)
               values (?,?,?,?,?,?,?,?)`,
            ).run(
              itemId, orderId, patientId, catalogueId, text(entry.kind), text(entry.display_name),
              text(entry.external_code),
              optional(payload, 'externalFacility') || text(entry.default_facility),
            )
            placed.push({ id: itemId, name: text(entry.display_name) })
          }

          await audit(
            session.staffId, 'investigation.ordered', 'investigation_order', orderId,
            `${orderNumber}: ${placed.map((item) => item.name).join(', ')} for ${text(patient.name)}`,
          )
        })
      } catch (error) {
        if (isUniqueViolation(error, 'investigation_orders_idempotency')) {
          const winner = await replayOrder(key, fingerprint)
          if (winner) return winner
        }
        throw error
      }

      return {
        message: `${orderNumber} requested: ${placed.map((item) => item.name).join(', ')}.`,
        data: {
          orderId, orderNumber,
          items: placed.map((item) => ({ itemId: item.id, name: item.name })),
        },
      }
    }

    /*
     * A request, or one line of it, withdrawn. Justified because `cancelled`
     * is a state the programme names and nothing else can produce it: an
     * unreturned order and a withdrawn one look identical from every other
     * row in the database.
     */
    case 'cancel_investigation_order': {
      requireRole(session, 'doctor')
      const reason = value(payload, 'reason')
      const orderId = optional(payload, 'orderId')
      const itemId = optional(payload, 'itemId')
      if ((orderId === '') === (itemId === '')) {
        throw new Error('Cancel one request or one line of one, not both and not neither.')
      }

      let what = ''
      await transaction(async () => {
        if (itemId) {
          const item = await db.prepare(
            `select i.id, i.item_name, i.cancelled_at, o.id as order_id, o.order_number,
                    o.ordered_by, o.responsible_doctor_id, o.delegated_doctor_id
               from investigation_order_items i
               join investigation_orders o on o.id = i.order_id
              where i.id = ? for update of i`,
          ).get(itemId) as Row | undefined
          if (!item) throw new Error('That line was not found.')
          requireStanding(session, item, 'cancel this request')
          if (item.cancelled_at) {
            throw new CommandRefusal('That line is already cancelled.', 'ALREADY_CANCELLED')
          }

          const current = await db.prepare(
            `select id from investigation_results
              where order_item_id = ? and superseded_at is null`,
          ).get(itemId) as Row | undefined
          if (current) {
            throw new CommandRefusal(
              'A report has already come back for that line. Cancelling it now would hide a result ' +
              'somebody has to read.',
              'RESULT_ALREADY_RECEIVED',
            )
          }

          await db.prepare(
            `update investigation_order_items
                set cancelled_at = now(), cancelled_by = ?, cancelled_reason = ?
              where id = ?`,
          ).run(session.staffId, reason, itemId)
          what = text(item.item_name)
          await audit(
            session.staffId, 'investigation.line_cancelled', 'investigation_order',
            text(item.order_id), `${text(item.order_number)} — ${what} cancelled: ${reason}`,
          )
          return
        }

        const order = await db.prepare(
          `select id, order_number, status, ordered_by, responsible_doctor_id, delegated_doctor_id
             from investigation_orders where id = ? for update`,
        ).get(orderId) as Row | undefined
        if (!order) throw new Error('That request was not found.')
        requireStanding(session, order, 'cancel this request')
        if (text(order.status) !== 'open') {
          throw new CommandRefusal('That request is already cancelled.', 'ALREADY_CANCELLED')
        }

        const resulted = await db.prepare(
          `select count(*)::int as n from investigation_results r
             join investigation_order_items i on i.id = r.order_item_id
            where i.order_id = ? and r.superseded_at is null`,
        ).get(orderId) as Row | undefined
        if (Number(resulted?.n ?? 0) > 0) {
          throw new CommandRefusal(
            'Reports have already come back against this request. Cancel the lines that are still ' +
            'outstanding instead.',
            'RESULT_ALREADY_RECEIVED',
          )
        }

        await db.prepare(
          `update investigation_orders
              set status = 'cancelled', cancelled_at = now(), cancelled_by = ?, cancelled_reason = ?
            where id = ?`,
        ).run(session.staffId, reason, orderId)
        await db.prepare(
          `update investigation_order_items
              set cancelled_at = now(), cancelled_by = ?, cancelled_reason = ?
            where order_id = ? and cancelled_at is null`,
        ).run(session.staffId, reason, orderId)

        what = text(order.order_number)
        await audit(
          session.staffId, 'investigation.cancelled', 'investigation_order', String(orderId),
          `${what} cancelled: ${reason}`,
        )
      })

      return { message: `Cancelled: ${what}. The request stays on the record with the reason.` }
    }

    /*
     * The specimen went, or the patient was sent. Justified because
     * "referred or external work in progress" is a state the programme names
     * and no other row implies it — an order waiting for a courier and an
     * order the laboratory already has look the same otherwise.
     *
     * Operational, so the roles are the operational ones. It records no
     * clinical judgment and changes nothing about who may review.
     */
    case 'mark_investigation_sent': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const itemId = value(payload, 'itemId')
      const note = optional(payload, 'note')

      let name = ''
      await transaction(async () => {
        const item = await db.prepare(
          `select i.id, i.item_name, i.patient_id, i.in_progress_at, i.cancelled_at
             from investigation_order_items i where i.id = ? for update`,
        ).get(itemId) as Row | undefined
        if (!item) throw new Error('That line was not found.')

        const access = await mayAccessResults(session, text(item.patient_id))
        if (!access.allowed) throw new CommandRefusal(access.message, 'NOT_THIS_PATIENTS_CARE')
        if (item.cancelled_at) {
          throw new CommandRefusal('That line is cancelled.', 'ALREADY_CANCELLED')
        }
        if (item.in_progress_at) {
          throw new CommandRefusal(
            'That line is already recorded as sent.',
            'ALREADY_IN_PROGRESS',
          )
        }

        await db.prepare(
          `update investigation_order_items
              set in_progress_at = now(), in_progress_by = ?, in_progress_note = ?
            where id = ?`,
        ).run(session.staffId, note, itemId)
        name = text(item.item_name)
        await audit(
          session.staffId, 'investigation.sent', 'investigation_order_item', itemId,
          `${name} sent out${note ? `: ${note}` : ''}`,
        )
      })

      return { message: `${name} recorded as sent.` }
    }

    /* ─────────────────────────────── the report comes back, owner item 85 */

    /*
     * One of the four commands the programme names, and the one that carries
     * owner item 85's whole transcription rule.
     *
     * Admin, nurse and doctor, because item 86 says "nurses and administrators
     * may attach, transcribe, and operationally track results". What they may
     * write down is what the SOURCE said, with its provenance. What none of
     * them may do from here is originate a clinical judgment: there is no
     * parameter on this command that reaches `doctor_flag`, and the trigger on
     * the table is what makes that structural rather than a promise.
     *
     * A correction is the same command with `correctsResultId`. It appends a
     * new result and stamps the old one superseded; the old row keeps its
     * text, its flag, its documents and its review, and the new one starts
     * with none of those — which is how "a correction requires a fresh
     * clinical review and fresh notification authorization" ends up being the
     * shape of the tables rather than a rule somebody has to remember.
     */
    case 'record_result': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const key = value(payload, 'idempotencyKey')
      const itemId = value(payload, 'orderItemId')
      const source = requireChoice(payload, 'source', [
        'external_laboratory', 'external_facility', 'imported_structured_feed', 'clinic_recorded',
      ] as const)
      const reportText = optional(payload, 'reportText')
      const correctsResultId = optional(payload, 'correctsResultId')
      const correctionReason = optional(payload, 'correctionReason')
      const sourceFlag = requireChoice(
        payload, 'sourceFlag', ['none', 'abnormal', 'urgent', 'critical'] as const, 'none',
      )
      const sourceFlagOrigin = requireChoice(
        payload, 'sourceFlagOrigin',
        ['none', 'external_report', 'imported_structured'] as const,
        'none',
      )
      const sourceFlagReference = optional(payload, 'sourceFlagReference')

      const fingerprint = requestFingerprint({
        command: 'record_result',
        actor: session.staffId,
        itemId, source, reportText, correctsResultId, correctionReason,
        sourceFlag, sourceFlagOrigin, sourceFlagReference,
        sourceReference: optional(payload, 'sourceReference'),
        reportedAt: optional(payload, 'reportedAt'),
        externalValidatedBy: optional(payload, 'externalValidatedBy'),
        externalSignatoryReference: optional(payload, 'externalSignatoryReference'),
      })

      const replay = await replayResult(key, fingerprint)
      if (replay) return replay

      if ((sourceFlag === 'none') !== (sourceFlagOrigin === 'none')) {
        throw new CommandRefusal(
          'A flag has to say where it came from, and a source with no flag is not a flag. ' +
          'Owner policy item 85.',
          'FLAG_SOURCE_REQUIRED',
        )
      }
      if (sourceFlagOrigin !== 'none' && !sourceFlagReference) {
        throw new CommandRefusal(
          'Say where this flag is written — the report number, the page, the feed\'s own reference. ' +
          'A transcribed flag with nothing to trace it to is an opinion.',
          'FLAG_PROVENANCE_REQUIRED',
        )
      }
      if (!reportText && source !== 'external_laboratory' && source !== 'external_facility') {
        throw new CommandRefusal(
          'Record what the report says, or attach the report itself.',
          'NOTHING_RECORDED',
        )
      }
      if ((correctsResultId === '') !== (correctionReason === '')) {
        throw new CommandRefusal(
          'A corrected report says which report it corrects and why.',
          'CORRECTION_REASON_REQUIRED',
        )
      }

      const resultId = randomUUID()
      let patientName = ''
      let itemName = ''
      let supersededSchedules = 0

      try {
        await transaction(async () => {
          const item = await db.prepare(
            `select i.id, i.patient_id, i.item_name, i.cancelled_at,
                    o.id as order_id, o.order_number, o.status as order_status,
                    p.name as patient_name
               from investigation_order_items i
               join investigation_orders o on o.id = i.order_id
               join patients p on p.id = i.patient_id
              where i.id = ? for update of i`,
          ).get(itemId) as Row | undefined
          if (!item) throw new Error('That line was not found.')
          patientName = text(item.patient_name)
          itemName = text(item.item_name)

          const access = await mayAccessResults(session, text(item.patient_id))
          if (!access.allowed) throw new CommandRefusal(access.message, 'NOT_THIS_PATIENTS_CARE')

          if (item.cancelled_at) {
            throw new CommandRefusal(
              'That line was cancelled. A report against a cancelled request needs the request ' +
              'reinstating first, which is a decision rather than a filing.',
              'LINE_CANCELLED',
            )
          }

          const patientId = text(item.patient_id)

          if (correctsResultId) {
            /*
             * The old report, locked, and checked for belonging to this line
             * as well as to this patient.
             *
             * The composite foreign key already refuses a correction of
             * another patient's result. This also refuses a correction of the
             * same patient's DIFFERENT investigation, which the key cannot see.
             */
            const previous = await db.prepare(
              `select id, order_item_id, patient_id, superseded_at
                 from investigation_results where id = ? for update`,
            ).get(correctsResultId) as Row | undefined
            if (!previous) throw new Error('The report being corrected was not found.')
            if (text(previous.order_item_id) !== itemId) {
              throw new CommandRefusal(
                'That report belongs to a different investigation.',
                'CORRECTION_CROSSES_INVESTIGATION',
              )
            }
            if (previous.superseded_at) {
              throw new CommandRefusal(
                'That report has already been corrected. Correct the current one.',
                'ALREADY_SUPERSEDED',
              )
            }

            await db.prepare(
              `update investigation_results set superseded_at = now() where id = ?`,
            ).run(correctsResultId)

            /*
             * Owner item 88. Anything the clinic had authorized about the old
             * report stops here, because it was about a report that is no
             * longer current. The schedule is superseded rather than
             * cancelled — something IS taking its place, once a doctor has
             * reviewed and authorized the correction — and its unsent messages
             * stop with it.
             */
            supersededSchedules = await closeResultReadySchedules({
              actorId: session.staffId,
              resultId: correctsResultId,
              reason: 'The report was corrected, so this notice is about a result that is no longer current.',
              as: 'superseded',
            })
          } else {
            const current = await db.prepare(
              `select id from investigation_results
                where order_item_id = ? and superseded_at is null`,
            ).get(itemId) as Row | undefined
            if (current) {
              throw new CommandRefusal(
                'A report is already on file for this investigation. A later one is a CORRECTION ' +
                'and says which report it corrects and why, so that the first one is not quietly ' +
                'replaced.',
                'RESULT_ALREADY_RECORDED',
              )
            }
          }

          await db.prepare(
            `insert into investigation_results
               (id, order_item_id, patient_id, recorded_by, source, source_reference, reported_at,
                report_text, source_flag, source_flag_origin, source_flag_reference,
                source_flag_recorded_by, source_flag_recorded_at,
                external_validated_by, external_validated_at, external_signatory_reference,
                supersedes_result_id, correction_reason, idempotency_key, request_fingerprint)
             values (?,?,?,?,?,?, ?::timestamptz, ?, ?,?,?,
                     ?, ?,
                     ?, ?::timestamptz, ?,
                     ?,?,?,?)`,
          ).run(
            resultId, itemId, patientId, session.staffId, source,
            optional(payload, 'sourceReference'),
            optional(payload, 'reportedAt') || null,
            reportText, sourceFlag, sourceFlagOrigin, sourceFlagReference,
            sourceFlagOrigin === 'none' ? null : session.staffId,
            sourceFlagOrigin === 'none' ? null : isoNow(),
            optional(payload, 'externalValidatedBy'),
            optional(payload, 'externalValidatedAt') || null,
            optional(payload, 'externalSignatoryReference'),
            correctsResultId || null, correctionReason, key, fingerprint,
          )

          if (correctsResultId) {
            await db.prepare(
              `update investigation_results set superseded_by_result_id = ? where id = ?`,
            ).run(resultId, correctsResultId)
          }

          await audit(
            session.staffId,
            correctsResultId ? 'investigation.result_corrected' : 'investigation.result_recorded',
            'investigation_result', resultId,
            `${text(item.order_number)} — ${itemName} for ${patientName}` +
            (correctsResultId ? `, corrected: ${correctionReason}` : '') +
            (sourceFlag !== 'none' ? ` (source reported ${sourceFlag})` : ''),
          )
        })
      } catch (error) {
        if (isUniqueViolation(error, 'investigation_results_idempotency')) {
          const winner = await replayResult(key, fingerprint)
          if (winner) return winner
        }
        if (isUniqueViolation(error, 'investigation_results_current')
          || isUniqueViolation(error, 'investigation_results_one_correction')) {
          throw new CommandRefusal(
            'Another report for this investigation was filed at the same moment. Open the ' +
            'investigation and check what is on it before filing again.',
            'RESULT_ALREADY_RECORDED',
          )
        }
        throw error
      }

      return {
        message: correctsResultId
          ? `Corrected report filed for ${itemName}. It needs its own review before the patient ` +
            'can be told, and anything authorized about the previous one has stopped.'
          : `Report filed for ${itemName}. It is waiting for a doctor to review it.`,
        data: {
          resultId,
          corrects: correctsResultId || undefined,
          supersededNotifications: supersededSchedules || undefined,
        },
      }
    }

    /*
     * Owner item 85's third and only other permitted origin: an authorized
     * doctor's own clinical flag.
     *
     * Justified because without it item 85's third source cannot exist, and a
     * clinic whose laboratory sends an unflagged report has no way to record a
     * doctor noticing something in it. It is a separate column pair from the
     * transcribed flag, so raising the severity never erases what the
     * laboratory actually said.
     *
     * "Authorized" here is read as authorized FOR THIS RESULT — the doctor
     * responsible for it, the one who ordered it, or one explicitly delegated
     * to it. Item 85 names the authority without defining it; item 86 defines
     * exactly that set for the neighbouring act, and borrowing a definition
     * from the item next door is more defensible than inventing a fourth.
     */
    case 'flag_result': {
      requireRole(session, 'doctor')
      const resultId = value(payload, 'resultId')
      const flag = requireChoice(payload, 'flag', ['abnormal', 'urgent', 'critical'] as const)
      const reason = value(payload, 'reason')

      let itemName = ''
      await transaction(async () => {
        const result = await lockResult(resultId)
        if (!result) throw new Error('That report was not found.')
        requireStanding(session, result, 'flag this result')
        itemName = text(result.item_name)

        if (result.superseded_at) {
          throw new CommandRefusal(
            'That report has been corrected. Flag the current one.',
            'RESULT_SUPERSEDED',
          )
        }
        if (text(result.doctor_flag) !== 'none') {
          throw new CommandRefusal(
            'A doctor has already flagged this report, and a clinical flag is written once. If the ' +
            'reading has changed, that is a corrected report.',
            'ALREADY_FLAGGED',
          )
        }
        if (result.notification_authorized_at) {
          throw new CommandRefusal(
            'This result has already been authorized for a patient notice. Flagging it now would ' +
            'change what was released. Cancel the notice first.',
            'NOTIFICATION_ALREADY_AUTHORIZED',
          )
        }

        await db.prepare(
          `update investigation_results
              set doctor_flag = ?, doctor_flag_by = ?, doctor_flag_at = now(),
                  doctor_flag_reason = ?
            where id = ?`,
        ).run(flag, session.staffId, reason, resultId)

        await audit(
          session.staffId, 'investigation.result_flagged', 'investigation_result', resultId,
          `${itemName} flagged ${flag} by the doctor: ${reason}`,
        )
      })

      return {
        message: flag === 'critical'
          ? `${itemName} flagged critical. It is on the owner-doctor's queue now and needs an ` +
            'acknowledgement; the patient is told by a telephone call, not by a message.'
          : `${itemName} flagged ${flag}.`,
      }
    }

    /*
     * Owner item 87's acknowledgement. Justified because the item requires one
     * by name — "A doctor acknowledgement is required" — and there is no other
     * row in the database that could stand for it.
     *
     * Open to a doctor with standing on the result AND to an authorized
     * doctor, because item 87 escalates a critical result to the owner-doctor
     * and an escalation the recipient cannot act on is a notification, not an
     * escalation.
     */
    case 'acknowledge_critical_result': {
      requireRole(session, 'doctor')
      const resultId = value(payload, 'resultId')
      const note = optional(payload, 'note')

      let itemName = ''
      let already = false
      await transaction(async () => {
        const result = await lockResult(resultId)
        if (!result) throw new Error('That report was not found.')
        itemName = text(result.item_name)

        if (!standingOn(session, result) && !session.canPublishClinicalTemplates) {
          throw new CommandRefusal(
            'Only the doctor responsible for this result, the doctor who ordered it, a doctor ' +
            'delegated to it, or the owner-doctor it escalated to may acknowledge it.',
            'NOT_THE_RESPONSIBLE_DOCTOR',
          )
        }
        if (text(result.effective_flag) !== 'critical') {
          throw new CommandRefusal(
            'That result is not flagged critical, so there is nothing to acknowledge.',
            'NOT_A_CRITICAL_RESULT',
          )
        }
        if (result.critical_acknowledged_at) {
          already = true
          return
        }

        await db.prepare(
          `update investigation_results
              set critical_acknowledged_by = ?, critical_acknowledged_at = now(),
                  critical_acknowledgement_note = ?
            where id = ?`,
        ).run(session.staffId, note, resultId)

        await audit(
          session.staffId, 'investigation.critical_acknowledged', 'investigation_result', resultId,
          `Critical result acknowledged: ${itemName}${note ? ` — ${note}` : ''}`,
        )
      })

      return already
        ? {
          message: `${itemName} was already acknowledged. It still needs a review and a telephone call.`,
          data: { duplicate: true },
        }
        : {
          message:
            `Acknowledged. It still needs a clinical review, and the patient is told by a ` +
            'telephone call rather than by an automated message.',
        }
    }

    /*
     * Owner item 86's "explicitly delegated doctor", made explicit.
     *
     * Justified because without it that clause is unimplementable: a doctor
     * going on leave has no way to hand a patient's outstanding results to a
     * colleague, and the owner-doctor a result escalates to has no way to take
     * it on without pretending to an authority nothing recorded.
     *
     * Open to the responsible doctor, the ordering doctor, and an authorized
     * doctor — the last so that item 87's escalation has an action behind it.
     * Every delegation carries a reason and an audit row, which is what makes
     * it explicit rather than a drift.
     */
    case 'delegate_result_review': {
      requireRole(session, 'doctor')
      const orderId = value(payload, 'orderId')
      const toDoctorId = value(payload, 'toDoctorId')
      const reason = value(payload, 'reason')

      let orderNumber = ''
      let toName = ''
      await transaction(async () => {
        const order = await db.prepare(
          `select id, order_number, status, ordered_by, responsible_doctor_id, delegated_doctor_id
             from investigation_orders where id = ? for update`,
        ).get(orderId) as Row | undefined
        if (!order) throw new Error('That request was not found.')
        orderNumber = text(order.order_number)

        const mayDelegate = text(order.responsible_doctor_id) === session.staffId
          || text(order.ordered_by) === session.staffId
          || session.canPublishClinicalTemplates
        if (!mayDelegate) {
          throw new CommandRefusal(
            'Only the doctor responsible for this request, the doctor who ordered it, or the ' +
            'owner-doctor may delegate its review.',
            'NOT_THE_RESPONSIBLE_DOCTOR',
          )
        }

        const to = await db.prepare(
          `select id, name, roles_json from staff where id = ? and active = 1`,
        ).get(toDoctorId) as Row | undefined
        if (!to || !text(to.roles_json).includes('"doctor"')) {
          throw new CommandRefusal(
            'A result review is delegated to a doctor.',
            'DELEGATE_IS_NOT_A_DOCTOR',
          )
        }
        toName = text(to.name)

        await db.prepare(
          `update investigation_orders
              set delegated_doctor_id = ?, delegated_by = ?, delegated_at = now(),
                  delegation_reason = ?
            where id = ?`,
        ).run(toDoctorId, session.staffId, reason, orderId)

        await audit(
          session.staffId, 'investigation.review_delegated', 'investigation_order', orderId,
          `${orderNumber}: review delegated to ${toName} — ${reason}`,
        )
      })

      return { message: `${toName} may now review what comes back for ${orderNumber}.` }
    }

    /* ─────────────────────────────────── review and release, items 86–88 */

    /*
     * One of the four commands the programme names. Owner item 86.
     *
     * `unique (result_id)` on the table is what makes two doctors pressing
     * Review at the same moment produce one review rather than two opinions
     * with no order between them, and it is also why a corrected report cannot
     * inherit a review: a correction is a different result id.
     */
    case 'review_result': {
      requireRole(session, 'doctor')
      const resultId = value(payload, 'resultId')
      const conclusion = requireChoice(payload, 'conclusion', [
        'no_action_needed', 'patient_to_be_informed', 'clinical_action_taken',
      ] as const)
      const note = optional(payload, 'note')

      let itemName = ''
      let basis: ResultStanding = 'responsible_doctor'
      let existing: Row | undefined

      await transaction(async () => {
        const result = await lockResult(resultId)
        if (!result) throw new Error('That report was not found.')
        basis = requireStanding(session, result, 'review this result')
        itemName = text(result.item_name)

        if (result.superseded_at) {
          throw new CommandRefusal(
            'That report has been corrected. The corrected one is what needs reviewing.',
            'RESULT_SUPERSEDED',
          )
        }

        existing = await db.prepare(
          `select r.id, r.reviewed_by, r.conclusion, s.name as reviewed_by_name
             from result_reviews r join staff s on s.id = r.reviewed_by
            where r.result_id = ?`,
        ).get(resultId) as Row | undefined
        if (existing) return

        await db.prepare(
          `insert into result_reviews (id, result_id, patient_id, reviewed_by, basis, conclusion, note)
           values (?,?,?,?,?,?,?)`,
        ).run(
          randomUUID(), resultId, text(result.patient_id), session.staffId, basis, conclusion, note,
        )

        await audit(
          session.staffId, 'investigation.result_reviewed', 'investigation_result', resultId,
          `${itemName} reviewed as ${conclusion.replace(/_/g, ' ')}`,
        )
      })

      if (existing) {
        // The loser of a race, or the same doctor pressing twice. Either way
        // the truthful answer is the review that exists, named.
        const sameDoctor = text(existing.reviewed_by) === session.staffId
        if (!sameDoctor) {
          throw new CommandRefusal(
            `${text(existing.reviewed_by_name)} reviewed this result first, as ` +
            `“${text(existing.conclusion).replace(/_/g, ' ')}”. A review is written once.`,
            'ALREADY_REVIEWED',
          )
        }
        return {
          message: text(existing.conclusion) === conclusion
            ? `Already reviewed as ${conclusion.replace(/_/g, ' ')}.`
            : `You reviewed this as “${text(existing.conclusion).replace(/_/g, ' ')}” and a review is ` +
              'written once. Nothing was changed.',
          data: { duplicate: true, conclusion: text(existing.conclusion) },
        }
      }

      return {
        message:
          `${itemName} reviewed. Telling the patient is a separate decision — authorize the notice ` +
          'when you want it to go.',
        data: { basis },
      }
    }

    /*
     * One of the four commands the programme names. Owner item 88.
     *
     * "Notification requires completed doctor review plus a separate doctor
     * authorization", and those are two words that have to stay two acts: a
     * review that automatically released would mean a doctor could not read a
     * result without telling the patient about it.
     *
     * Everything this checks is asked again, under a row lock, in
     * `messaging.ts` before the message is queued and again before it is
     * dispatched — because the gap between authorizing and sending is exactly
     * where a corrected report arrives.
     */
    case 'authorize_result_notification': {
      requireRole(session, 'doctor')
      const resultId = value(payload, 'resultId')

      let itemName = ''
      let patientId = ''
      let scheduleId = ''
      let already = false

      await transaction(async () => {
        const result = await lockResult(resultId)
        if (!result) throw new Error('That report was not found.')
        requireStanding(session, result, 'authorize a notice about this result')
        itemName = text(result.item_name)
        patientId = text(result.patient_id)

        if (result.notification_authorized_at) {
          already = true
          scheduleId = text(result.notification_schedule_id)
          return
        }
        if (result.superseded_at) {
          throw new CommandRefusal(
            'That report has been corrected. The correction needs its own review and its own ' +
            'authorization.',
            'RESULT_SUPERSEDED',
          )
        }
        if (text(result.order_status) !== 'open' || result.item_cancelled_at) {
          throw new CommandRefusal(
            'That request has been cancelled.',
            'ORDER_CANCELLED',
          )
        }

        /*
         * Owner item 88: "Critical-result communication is clinician-led
         * direct contact, not an automated generic message."
         *
         * Refused here, and refused again by a check constraint on the table,
         * so there is no code path — this one or a later one — that can put a
         * critical result onto the automated channel.
         */
        if (text(result.effective_flag) === 'critical') {
          throw new CommandRefusal(
            'A critical result is not something a patient learns from an automated message. ' +
            'Telephone them, and record the call.',
            'CRITICAL_RESULT_NEEDS_DIRECT_CONTACT',
          )
        }

        const review = await db.prepare(
          `select id from result_reviews where result_id = ?`,
        ).get(resultId) as Row | undefined
        if (!review) {
          throw new CommandRefusal(
            'A patient may not be told a result is ready before a doctor has reviewed it. ' +
            'Owner policy item 86.',
            'RESULT_NOT_REVIEWED',
          )
        }

        const opened = await openResultReadySchedule({
          actorId: session.staffId,
          patientId,
          resultId,
          responsibleDoctorId: text(result.responsible_doctor_id),
        })
        if (!opened) {
          throw new CommandRefusal(
            'A notice for this result is already scheduled.',
            'NOTIFICATION_ALREADY_SCHEDULED',
          )
        }
        scheduleId = opened.scheduleId

        await db.prepare(
          `update investigation_results
              set notification_authorized_by = ?, notification_authorized_at = now(),
                  notification_schedule_id = ?
            where id = ?`,
        ).run(session.staffId, scheduleId, resultId)

        await audit(
          session.staffId, 'investigation.notification_authorized', 'investigation_result',
          resultId, `Authorized the generic result-ready notice for ${itemName}`,
        )
      })

      /*
       * What the patient has actually agreed to, reported rather than acted
       * on.
       *
       * The authorization stands either way and the preparation step decides:
       * with no consent the message is suppressed into the admin's queue with
       * `no_consent` against it, which is owner item 76's instruction and is
       * visible work rather than a silence. Saying so here means the doctor
       * knows a telephone call is coming rather than finding out in a week.
       */
      const consent = await effectiveConsent(patientId, 'result_ready')

      return {
        message: already
          ? 'A notice for this result was already authorized.'
          : consent === 'opt_in'
            ? 'Authorized. The clinic will send the generic notice; nothing about the result goes in it.'
            : 'Authorized, and this patient has not agreed to result messages on WhatsApp — so it ' +
              'will go to the admin queue to be dealt with by hand rather than being sent.',
        data: {
          scheduleId: scheduleId || undefined,
          consent,
          duplicate: already || undefined,
        },
      }
    }

    /*
     * Owner item 88's fourth fact: what somebody actually told the patient.
     *
     * Justified because the item names it as distinct from authorization,
     * provider acceptance and delivery, and requires that the final outcome
     * come from "authenticated provider evidence or an explicit audited
     * manual-contact event". This is that event. Nothing else in the database
     * can hold it: a delivered WhatsApp message is not a telephone call, and
     * an authorization is not a conversation.
     *
     * A doctor may always record one. A nurse or an administrator may record
     * an ordinary one — the message failed, so the desk telephoned — but not
     * for a critical result, because item 88 makes that contact clinician-led.
     */
    case 'record_patient_result_contact': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const resultId = value(payload, 'resultId')
      const method = requireChoice(
        payload, 'method', ['telephone', 'in_person', 'other'] as const,
      )
      const note = value(payload, 'note')

      let itemName = ''
      let already = false
      await transaction(async () => {
        const result = await lockResult(resultId)
        if (!result) throw new Error('That report was not found.')
        itemName = text(result.item_name)

        const access = await mayAccessResults(session, text(result.patient_id))
        if (!access.allowed) throw new CommandRefusal(access.message, 'NOT_THIS_PATIENTS_CARE')

        if (text(result.effective_flag) === 'critical' && !hasRole(session, 'doctor')) {
          throw new CommandRefusal(
            'A critical result is communicated by a clinician. Owner policy item 88.',
            'CRITICAL_CONTACT_IS_CLINICIAN_LED',
          )
        }
        if (result.patient_contacted_at) {
          already = true
          return
        }

        await db.prepare(
          `update investigation_results
              set patient_contacted_by = ?, patient_contacted_at = now(),
                  patient_contact_method = ?, patient_contact_note = ?
            where id = ?`,
        ).run(session.staffId, method, note, resultId)

        await audit(
          session.staffId, 'investigation.patient_contacted', 'investigation_result', resultId,
          `Patient contacted by ${method} about ${itemName}: ${note}`,
        )
      })

      return already
        ? { message: 'A contact was already recorded against this result.', data: { duplicate: true } }
        : { message: 'Recorded. This is what the clinic knows the patient was told, and by whom.' }
    }

    /*
     * Slice 3A's messaging commands are the next link in the chain, and
     * diagnostics sits in front of them rather than behind them so that this
     * file may import `messaging.ts` without the two importing each other.
     * `messaging.ts` reaches these tables with plain SQL where it must —
     * exactly as it reaches `appointment_bookings` and `follow_ups` — and
     * imports nothing from here.
     */
    default:
      return runMessagingCommand(session, action, payload)
  }
}

/* ══════════════════════════════════════════════════════════════ replays ══ */

/**
 * The order this reference already created, if it did.
 *
 * Read before anything mutable is consulted. Same reference and the same
 * material request is a retry and gets the original answer; the same reference
 * and a different request is a client fault, and the only safe answer is to
 * refuse it out loud rather than hand back somebody else's order number.
 */
async function replayOrder(
  key: string,
  fingerprint: string,
): Promise<{ message: string; data: Record<string, unknown> } | null> {
  const order = await db.prepare(
    `select id, order_number, request_fingerprint, status from investigation_orders
      where idempotency_key = ?`,
  ).get(key) as Row | undefined
  if (!order) return null

  if (text(order.request_fingerprint) !== fingerprint) {
    throw new CommandRefusal(
      'That reference was already used for a different request. Nothing was changed. Send this one ' +
      'under a reference of its own.',
      'INVESTIGATION_REFERENCE_REUSED',
    )
  }

  const items = await db.prepare(
    `select id, item_name from investigation_order_items where order_id = ? order by created_at`,
  ).all(text(order.id)) as Row[]

  return {
    message: `${text(order.order_number)} requested: ${items.map((i) => text(i.item_name)).join(', ')}.`,
    data: {
      orderId: text(order.id),
      orderNumber: text(order.order_number),
      items: items.map((i) => ({ itemId: text(i.id), name: text(i.item_name) })),
      // The standing of what the receipt records, asked now. A retry that
      // lands after somebody cancelled the request is accurate about the past
      // and must not be silent about the present.
      cancelled: text(order.status) === 'cancelled',
      duplicate: true,
    },
  }
}

/** The result this reference already filed, if it did. */
async function replayResult(
  key: string,
  fingerprint: string,
): Promise<{ message: string; data: Record<string, unknown> } | null> {
  const result = await db.prepare(
    `select r.id, r.request_fingerprint, r.supersedes_result_id, r.superseded_at,
            i.item_name
       from investigation_results r
       join investigation_order_items i on i.id = r.order_item_id
      where r.idempotency_key = ?`,
  ).get(key) as Row | undefined
  if (!result) return null

  if (text(result.request_fingerprint) !== fingerprint) {
    throw new CommandRefusal(
      'That reference was already used for a different report. Nothing was changed. File this one ' +
      'under a reference of its own.',
      'RESULT_REFERENCE_REUSED',
    )
  }

  return {
    message: `Report already filed for ${text(result.item_name)}.`,
    data: {
      resultId: text(result.id),
      corrects: text(result.supersedes_result_id) || undefined,
      superseded: result.superseded_at !== null,
      duplicate: true,
    },
  }
}

/* ═══════════════════════════════════════════════════════════ read models ══ */

/*
 * Declared here beside the queries that build them, the way `workspace.ts` and
 * `messaging.ts` declare their own. They are not in `_shared/types.ts` because
 * that file is the frontend's door to the backend, and this slice deliberately
 * builds no frontend — putting view types there would publish a contract
 * nothing consumes and that a real screen would immediately want to change.
 */

/**
 * Everything current and not yet reviewed. Owner items 86 and 87.
 *
 * Two audiences and one query, filtered per row and per field rather than per
 * endpoint:
 *
 *   a DOCTOR sees their own outstanding results, and an authorized doctor also
 *   sees everything item 87 has escalated to them — and only what it has
 *   escalated, so the owner-doctor's queue is the escalation rather than a
 *   second copy of every colleague's inbox.
 *
 *   an ADMINISTRATOR sees all of them without the clinical fields. That is
 *   what "operational metadata needed to manage outstanding work" is: which
 *   request, which patient, how long, and who owes it a look.
 */
export async function readResultReviewQueue(session: SessionView): Promise<ReviewQueue> {
  const clinical = hasRole(session, 'doctor')
  const ownerDoctor = clinical && session.canPublishClinicalTemplates

  const rows = await db.prepare(
    `select r.id as result_id, r.effective_flag, r.critical_acknowledged_at,
            o.id as order_id, o.order_number, o.responsible_doctor_id, o.ordered_by,
            o.delegated_doctor_id,
            i.item_name,
            p.name as patient_name,
            rd.name as responsible_doctor_name,
            dd.name as delegated_doctor_name,
            to_char(r.received_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as received_local,
            round(extract(epoch from (now() - r.received_at)) / 3600.0, 1) as waiting_hours,
            (${ESCALATION_DUE_AT} <= now()) as escalated,
            (r.received_at + make_interval(mins => ${CRITICAL_ACKNOWLEDGEMENT_MINUTES}) <= now())
              as acknowledgement_overdue
       from investigation_results r
       join investigation_order_items i on i.id = r.order_item_id
       join investigation_orders o on o.id = i.order_id
       join patients p on p.id = r.patient_id
       join staff rd on rd.id = o.responsible_doctor_id
       left join staff dd on dd.id = o.delegated_doctor_id
      where r.superseded_at is null
        and i.cancelled_at is null
        and o.status = 'open'
        and not exists (select 1 from result_reviews v where v.result_id = r.id)
      order by
        case when r.effective_flag = 'critical' then 0
             when r.effective_flag = 'urgent' then 1
             when r.effective_flag = 'abnormal' then 2
             else 3 end,
        r.received_at
      limit 200`,
  ).all() as Row[]

  const mine = (row: Row) =>
    text(row.responsible_doctor_id) === session.staffId
    || text(row.ordered_by) === session.staffId
    || text(row.delegated_doctor_id) === session.staffId

  /*
   * The admin branch first, and that ordering matters for one person.
   *
   * The clinic's owner is a doctor AND an administrator, and the first
   * version of this asked `clinical` first — so he saw his own outstanding
   * results and lost the chase list entirely, which is the half of this read
   * an administrator opens it for. Holding both roles has to mean both views,
   * not the narrower one.
   *
   * It is not a widening. A doctor may already read any patient's results
   * through `view.investigation_order`; the per-doctor filter here is a
   * workload filter, not a privacy boundary, and `mayAccessResults` is where
   * the boundary lives.
   */
  const visible = rows.filter((row) => {
    if (hasRole(session, 'admin')) return true
    return clinical && (mine(row) || (ownerDoctor && row.escalated === true))
  })

  return {
    access: clinical ? 'clinical' : 'operational',
    escalationAfterClinicHours: UNREVIEWED_RESULT_ESCALATION_HOURS,
    escalationCeilingHour: RESULT_ESCALATION_CEILING_HOUR,
    criticalAcknowledgementMinutes: CRITICAL_ACKNOWLEDGEMENT_MINUTES,
    rows: visible.map((row) => ({
      resultId: text(row.result_id),
      orderId: text(row.order_id),
      orderNumber: text(row.order_number),
      patientName: text(row.patient_name),
      itemName: text(row.item_name),
      receivedAt: text(row.received_local),
      waitingHours: Number(row.waiting_hours),
      responsibleDoctor: text(row.responsible_doctor_name),
      delegatedDoctor: text(row.delegated_doctor_name),
      escalatedToOwnerDoctor: row.escalated === true,
      ...(clinical
        ? {
          flag: text(row.effective_flag) as ResultFlag,
          criticalUnacknowledged: text(row.effective_flag) === 'critical'
            && row.critical_acknowledged_at === null,
          acknowledgementOverdue: text(row.effective_flag) === 'critical'
            && row.critical_acknowledged_at === null
            && row.acknowledgement_overdue === true,
        }
        : {}),
    })),
  }
}

/**
 * Owner item 87's two escalations, and nothing else.
 *
 * Doctor-only, and an authorized doctor sees every row while any other doctor
 * sees only their own. Item 87 escalates to the owner-doctor; an administrator
 * is not named in it and the administrator's own view of outstanding work is
 * the review queue above.
 *
 * **`manualEscalationOwed` is a statement about a person, not a trigger.**
 * Item 87's fifteen-minute rule says the result "remains visibly escalated ...
 * with a manual-escalation obligation". Nothing here telephones anybody,
 * releases anything or tells a patient; the clock's entire power is to make a
 * row appear in this list and say that somebody now owes a call.
 *
 * **There is no configured backup doctor**, and the read says so in a field
 * rather than leaving a screen to imply one exists. Item 87 names "any
 * explicitly configured backup doctor"; the clinic has configured none and
 * this application has nowhere to hold one. It is a deployment dependency,
 * recorded in `SCHEMA_AND_TYPES.md` §17 and in `operations/ROLLOUT.md`.
 */
export async function readResultEscalations(session: SessionView): Promise<Escalations> {
  // Both halves, the way `requireAuthorizedDoctor` and
  // `readCommunicationFailures` ask it. The capability already admits only a
  // doctor, so this is the belt behind that brace rather than the brace —
  // item 84's "doctor-level never means a non-doctor with an elevated
  // software permission" should not depend on a routing table staying right.
  const ownerDoctor = hasRole(session, 'doctor') && session.canPublishClinicalTemplates

  const rows = await db.prepare(
    `select r.id as result_id, r.effective_flag, r.critical_acknowledged_at,
            o.order_number, o.responsible_doctor_id, o.ordered_by, o.delegated_doctor_id,
            i.item_name, p.name as patient_name,
            rd.name as responsible_doctor_name,
            to_char(r.received_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as received_local,
            (r.received_at + make_interval(mins => ${CRITICAL_ACKNOWLEDGEMENT_MINUTES}) <= now())
              as acknowledgement_overdue,
            (${ESCALATION_DUE_AT} <= now()) as escalated,
            exists (select 1 from result_reviews v where v.result_id = r.id) as reviewed
       from investigation_results r
       join investigation_order_items i on i.id = r.order_item_id
       join investigation_orders o on o.id = i.order_id
       join patients p on p.id = r.patient_id
       join staff rd on rd.id = o.responsible_doctor_id
      where r.superseded_at is null
        and i.cancelled_at is null
        and o.status = 'open'
      order by r.received_at
      limit 200`,
  ).all() as Row[]

  const escalated = rows.filter((row) => {
    const criticalOpen = text(row.effective_flag) === 'critical'
      && row.critical_acknowledged_at === null
    const unreviewedTooLong = row.reviewed !== true && row.escalated === true
    if (!criticalOpen && !unreviewedTooLong) return false
    if (ownerDoctor) return true
    return text(row.responsible_doctor_id) === session.staffId
      || text(row.ordered_by) === session.staffId
      || text(row.delegated_doctor_id) === session.staffId
  })

  return {
    backupDoctorConfigured: false,
    criticalAcknowledgementMinutes: CRITICAL_ACKNOWLEDGEMENT_MINUTES,
    rows: escalated.map((row) => {
      const criticalOpen = text(row.effective_flag) === 'critical'
        && row.critical_acknowledged_at === null
      return {
        resultId: text(row.result_id),
        orderNumber: text(row.order_number),
        patientName: text(row.patient_name),
        itemName: text(row.item_name),
        flag: text(row.effective_flag) as ResultFlag,
        receivedAt: text(row.received_local),
        reason: criticalOpen
          ? 'critical_unacknowledged' as const
          : 'unreviewed_past_clinic_hours' as const,
        manualEscalationOwed: criticalOpen && row.acknowledgement_overdue === true,
        responsibleDoctor: text(row.responsible_doctor_name),
      }
    }),
  }
}

/**
 * One request form, with everything underneath it.
 *
 * The state of each line is derived here, in one place, from the rows that
 * justify it — and the order below is the order of precedence, most settled
 * first. `notified` requires provider evidence and nothing weaker: an
 * authorization, a queued message and an HTTP 200 are each two or more steps
 * short of it, and each of them has its own name in this list so that a screen
 * cannot round them up.
 */
export async function readInvestigationOrder(
  session: SessionView,
  orderId: string,
): Promise<InvestigationOrderView | null | 'refused'> {
  const order = await db.prepare(
    `select o.*, p.name as patient_name,
            ob.name as ordered_by_name, rd.name as responsible_doctor_name,
            dd.name as delegated_doctor_name,
            to_char(o.created_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as created_local,
            to_char(o.expected_by, 'DD Mon YYYY') as expected_local,
            (o.expected_by is not null and o.expected_by < (now() at time zone ${CLINIC_ZONE})::date)
              as past_expected
       from investigation_orders o
       join patients p on p.id = o.patient_id
       join staff ob on ob.id = o.ordered_by
       join staff rd on rd.id = o.responsible_doctor_id
       left join staff dd on dd.id = o.delegated_doctor_id
      where o.id = ?`,
  ).get(orderId) as Row | undefined
  if (!order) return null

  const access = await mayAccessResults(session, text(order.patient_id))
  if (!access.allowed) return 'refused'

  const items = await db.prepare(
    `select * from investigation_order_items where order_id = ? order by created_at`,
  ).all(orderId) as Row[]

  const view: InvestigationOrderView = {
    orderId: text(order.id),
    orderNumber: text(order.order_number),
    patientId: text(order.patient_id),
    patientName: text(order.patient_name),
    encounterId: text(order.encounter_id),
    orderedBy: text(order.ordered_by_name),
    responsibleDoctor: text(order.responsible_doctor_name),
    delegatedDoctor: text(order.delegated_doctor_name),
    delegationReason: text(order.delegation_reason),
    priority: text(order.priority) as 'routine' | 'urgent',
    clinicalIndication: access.content ? text(order.clinical_indication) : '',
    instructions: text(order.instructions),
    externalFacility: text(order.external_facility),
    expectedBy: text(order.expected_local),
    status: text(order.status) as 'open' | 'cancelled',
    cancelledReason: text(order.cancelled_reason),
    createdAt: text(order.created_local),
    overdue: order.past_expected === true,
    access: access.content ? 'clinical' : 'operational',
    items: [],
  }

  for (const item of items) {
    const { views, facts } = await readResultsForItem(text(item.id), access.content)
    view.items.push({
      itemId: text(item.id),
      itemKind: text(item.item_kind) as 'investigation' | 'referral',
      itemName: text(item.item_name),
      itemCode: text(item.item_code),
      externalFacility: text(item.external_facility),
      // Derived from `facts`, which is the same for everybody, and never from
      // `views`, which is not.
      state: deriveItemState({
        cancelled: item.cancelled_at !== null || text(order.status) === 'cancelled',
        inProgress: item.in_progress_at !== null,
        overdue: order.past_expected === true,
        results: facts,
      }),
      cancelledReason: text(item.cancelled_reason),
      results: views,
    })
  }

  return view
}

/** One patient's investigations, newest first. Same gating, less depth. */
export async function readPatientInvestigations(
  session: SessionView,
  patientId: string,
): Promise<{ access: 'clinical' | 'operational'; orders: InvestigationOrderView[] } | null | 'refused'> {
  const patient = await db.prepare('select id from patients where id = ?').get(patientId) as Row | undefined
  if (!patient) return null

  const access = await mayAccessResults(session, patientId)
  if (!access.allowed) return 'refused'

  const ids = await db.prepare(
    `select id from investigation_orders where patient_id = ? order by created_at desc limit 50`,
  ).all(patientId) as Row[]

  const orders: InvestigationOrderView[] = []
  for (const row of ids) {
    const order = await readInvestigationOrder(session, text(row.id))
    if (order && order !== 'refused') orders.push(order)
  }

  return { access: access.content ? 'clinical' : 'operational', orders }
}

async function readResultsForItem(
  itemId: string,
  content: boolean,
): Promise<{ views: ResultView[]; facts: ResultStateFacts[] }> {
  const results = await db.prepare(
    `select r.*,
            rb.name as recorded_by_name,
            df.name as doctor_flag_by_name,
            ca.name as critical_acknowledged_by_name,
            na.name as notification_authorized_by_name,
            pc.name as patient_contacted_by_name,
            to_char(r.received_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as received_local,
            to_char(r.critical_acknowledged_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as ack_local,
            to_char(r.notification_authorized_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as auth_local,
            to_char(r.patient_contacted_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as contact_local
       from investigation_results r
       left join staff rb on rb.id = r.recorded_by
       left join staff df on df.id = r.doctor_flag_by
       left join staff ca on ca.id = r.critical_acknowledged_by
       left join staff na on na.id = r.notification_authorized_by
       left join staff pc on pc.id = r.patient_contacted_by
      where r.order_item_id = ?
      order by r.received_at desc`,
  ).all(itemId) as Row[]

  const views: ResultView[] = []
  const facts: ResultStateFacts[] = []
  for (const row of results) {
    const resultId = text(row.id)

    const review = await db.prepare(
      `select v.reviewed_by, v.basis, v.conclusion, v.note, s.name as reviewed_by_name,
              to_char(v.reviewed_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as reviewed_local
         from result_reviews v join staff s on s.id = v.reviewed_by
        where v.result_id = ?`,
    ).get(resultId) as Row | undefined

    /*
     * What the patient was actually told, which is the outbox's answer and
     * never this table's.
     *
     * `providerSaidDelivered` is true only when `message_outbox.status` is
     * `delivered`, which Slice 3A's schema allows exactly one way in: an
     * authenticated status event on the provider webhook. An authorization, a
     * queued row, a `sent_to_provider` and an HTTP 200 are all false here.
     */
    const notification = await db.prepare(
      `select o.status, o.suppression_reason, o.delivery_status
         from message_outbox o
         join communication_schedules s on s.id = o.schedule_id
        where s.source_type = 'investigation_result' and s.source_id = ?
        order by o.created_at desc limit 1`,
    ).get(resultId) as Row | undefined

    const documents = await db.prepare(
      `select d.id, d.content_type, d.byte_size, d.checksum, d.source, d.status,
              s.name as uploaded_by_name,
              to_char(d.uploaded_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as uploaded_local
         from result_documents d join staff s on s.id = d.uploaded_by
        where d.result_id = ? order by d.uploaded_at desc`,
    ).all(resultId) as Row[]

    facts.push({
      current: row.superseded_at === null,
      reviewed: Boolean(review),
      reviewConclusion: text(review?.conclusion),
      notificationState: notification ? text(notification.status) : '',
      providerSaidDelivered: text(notification?.status) === 'delivered',
      notificationAuthorized: row.notification_authorized_at !== null,
      patientContacted: row.patient_contacted_at !== null,
    })

    views.push({
      resultId,
      receivedAt: text(row.received_local),
      source: text(row.source) as ResultSource,
      current: row.superseded_at === null,
      correctsResultId: text(row.supersedes_result_id),
      correctedByResultId: text(row.superseded_by_result_id),
      ...(content
        ? {
          reportText: text(row.report_text),
          flag: text(row.effective_flag) as ResultFlag,
          sourceFlag: text(row.source_flag) as ResultFlag,
          sourceFlagOrigin: text(row.source_flag_origin) as SourceFlagOrigin,
          sourceFlagReference: text(row.source_flag_reference),
          doctorFlag: text(row.doctor_flag) as ResultFlag,
          doctorFlagReason: text(row.doctor_flag_reason),
          doctorFlagBy: text(row.doctor_flag_by_name),
        }
        : {}),
      externalValidatedBy: text(row.external_validated_by),
      externalSignatoryReference: text(row.external_signatory_reference),
      // Stated in the payload rather than left to a screen's caption. Owner
      // item 86: the laboratory's technical validation is evidence and is not
      // the clinic's clinical review, and a field that says so cannot be
      // mislabelled by the next person who builds a table.
      externalValidationIsNotClinicReview: true,
      review: review
        ? {
          reviewedBy: text(review.reviewed_by_name),
          reviewedAt: text(review.reviewed_local),
          basis: text(review.basis) as ResultStanding,
          ...(content
            ? { conclusion: text(review.conclusion) as ReviewConclusion, note: text(review.note) }
            : {}),
        }
        : null,
      criticalAcknowledgedBy: text(row.critical_acknowledged_by_name),
      criticalAcknowledgedAt: text(row.ack_local),
      notificationAuthorizedBy: text(row.notification_authorized_by_name),
      notificationAuthorizedAt: text(row.auth_local),
      notification: notification
        ? {
          state: text(notification.status) as NotificationState,
          suppressionReason: text(notification.suppression_reason) as NotificationSuppressionReason,
          deliveryStatus: text(notification.delivery_status),
          providerSaidDelivered: text(notification.status) === 'delivered',
        }
        : null,
      patientContactedBy: text(row.patient_contacted_by_name),
      patientContactedAt: text(row.contact_local),
      patientContactMethod: text(row.patient_contact_method) as PatientContactMethod | '',
      documents: documents.map((doc) => ({
        documentId: text(doc.id),
        contentType: text(doc.content_type) as ResultDocumentContentType,
        byteSize: Number(doc.byte_size),
        checksum: text(doc.checksum),
        source: text(doc.source) as ResultDocumentSource,
        uploadedBy: text(doc.uploaded_by_name),
        uploadedAt: text(doc.uploaded_local),
        status: text(doc.status) as ResultDocumentStatus,
      })),
    })
  }

  return { views, facts }
}

/**
 * The state of one requested line, in precedence order.
 *
 * Read it downwards: the first thing that is true is the answer. Every branch
 * is a row or a timestamp somebody wrote, except `overdue`, which is the
 * ordering doctor's own expected-by date having passed with nothing back.
 */
export function deriveItemState(input: {
  cancelled: boolean
  inProgress: boolean
  overdue: boolean
  results: ResultStateFacts[]
}): ItemState {
  if (input.cancelled) return 'cancelled'

  const current = input.results.find((result) => result.current)
  if (!current) {
    if (input.overdue) return 'overdue'
    return input.inProgress ? 'in_progress' : 'ordered'
  }

  if (current.patientContacted) return 'manually_contacted'

  if (current.notificationState) {
    if (current.providerSaidDelivered) return 'notified'
    if (current.notificationState === 'outcome_unknown') return 'provider_outcome_unknown'
    /*
     * Everything else a message can be — scheduled, queued, accepted by the
     * provider, retryable, suppressed, cancelled, terminally failed — is the
     * patient not having been told. It is not `notified` and it is not
     * `closed`, and the suppression reason on the read says which of them it
     * is. Owner item 88: acceptance is not delivery.
     */
    return 'notification_pending'
  }

  if (current.notificationAuthorized) return 'notification_pending'
  if (current.reviewed) {
    return current.reviewConclusion === 'no_action_needed'
      || current.reviewConclusion === 'clinical_action_taken'
      ? 'closed'
      : 'reviewed'
  }
  return 'awaiting_review'
}
