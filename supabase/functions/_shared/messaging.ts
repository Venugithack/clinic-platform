/**
 * Reminders, recalls, and the difference between a provider accepting a
 * message and a patient receiving one.
 *
 * Slice 3A. Owner policy register items 76 to 83, approved 17 September 2026.
 * The schema is `20260924000000_slice3a_communication_truth.sql` and its
 * header is the long explanation; this is the behaviour on top of it.
 *
 * ── WHAT SLICE 3B ADDED, AND WHAT IT STILL DOES NOT DO ─────────────────────
 *
 * Slice 3A had no adapter, no webhook and no scheduler. Slice 3B adds the
 * first two and the contract for the third:
 *
 *   - `officialWhatsAppChannel` now calls `whatsapp-cloud.ts`, which is the
 *     only way anything in this file reaches Meta. It sends approved TEMPLATE
 *     messages and nothing else — a clinic-initiated free-text message is not
 *     a thing this path can express. (The staff composer in `whatsapp.ts` has
 *     its own older, direct call; it is untouched, shares nothing with this,
 *     and is discussed in §16.8 of the schema contract.)
 *   - `applyProviderEvidence` is reached by a real endpoint, `functions/
 *     whatsapp`, which verifies Meta's signature over the raw request bytes
 *     before it parses anything.
 *   - `runDispatchCycle` is the worker, and `functions/worker` is the
 *     protected endpoint a scheduler will call. **No scheduler is
 *     provisioned**: no `pg_cron` job, no `pg_net` call, no Vault secret and
 *     no queue exists, and none is created by a migration. The provisioning
 *     steps are written down in `docs/operations/ROLLOUT.md` and deliberately
 *     not run.
 *
 * The adapter stays fully disabled without the complete accepted
 * configuration, and there is no fallback credential and no development
 * default anywhere in it. Owner item 76: "If the official channel is
 * unavailable or not approved, suppress the automated send and put the work in
 * a staff queue." So on a clinic with no connection configured, every due
 * message is still SUPPRESSED at the prepare step, with a reason, into the
 * admin's queue — which is where this application stands today, because no
 * credential has been issued to it.
 *
 * ── THE FOUR RULES EVERYTHING BELOW IS AN EXPRESSION OF ────────────────────
 *
 * **A row before a send.** `WHATSAPP.md` §10 rule 8. The outbox row exists
 * from the moment the intention does, and the attempt row is committed before
 * the provider is called — so a call whose answer is lost leaves evidence that
 * it happened, and the message sits at `outcome_unknown` rather than being
 * retried into a duplicate.
 *
 * **Acceptance is not delivery.** Meta's POST /messages answers `accepted`,
 * `held_for_quality_assessment` or `paused`. Only the statuses webhook ever
 * says `delivered`. `sent_to_provider` and `delivered` are therefore different
 * states and nothing in this file can produce the second from an HTTP 200.
 *
 * **No opt-in row, no send.** Owner item 78 and `WHATSAPP.md` §10 rule 2,
 * enforced here rather than in a screen, with no staff override anywhere.
 * Consent is rechecked under a lock immediately before queueing AND again
 * immediately before dispatch, because a withdrawal in between is exactly the
 * case that matters.
 *
 * **A schedule needs an authority.** Owner item 83. The only two things that
 * can produce one are a booking somebody made and a follow-up a doctor wrote.
 * There is no query, no cohort, no elapsed-time rule and no way to add one
 * without a migration.
 */
import { randomUUID } from 'node:crypto'
import { audit, db, isoNow, transaction } from './db.ts'
import { canonicalJson, isUniqueViolation, requestFingerprint } from './idempotency.ts'
import { hasRole } from './auth.ts'
import {
  CommandRefusal, optional, requireChoice, requireRole, value, type Payload,
} from './command-input.ts'
import type { SessionView } from './types.ts'
import { whatsappConfig, dialable } from './whatsapp.ts'
import { sendTemplateMessage } from './whatsapp-cloud.ts'
import type {
  ChannelSendRequest, MessageChannel, TransportFailure, TransportResult,
} from './messaging-transport.ts'
import {
  APPOINTMENT_REMINDER_HOUR, CLINICAL_RECALL_HOUR, CONSENT_CLINIC_NAME,
  CONSENT_WORDING_VERSION, DISPATCH_WINDOW_END_HOUR, DISPATCH_WINDOW_START_HOUR,
  FAILURE_ESCALATION_HOURS, MAX_PROVIDER_ATTEMPTS, RECALL_USEFUL_UNTIL_HOUR,
  RETRY_BACKOFF_MINUTES, RETRY_WINDOW_MINUTES,
} from './clinic-policy.ts'

type Row = Record<string, unknown>
const text = (value: unknown) => String(value ?? '')

/** Owner item 78's four purposes. A fifth is a policy decision, not a value. */
export const PURPOSES = [
  'appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption',
] as const
export type CommunicationPurpose = typeof PURPOSES[number]

export const SCHEDULE_KINDS = [
  'appointment_reminder', 'appointment_confirmation', 'clinical_recall',
] as const
export type ScheduleKind = typeof SCHEDULE_KINDS[number]

/** The variables a template may interpolate. The privacy boundary as a list. */
export const ALLOWED_VARIABLES = [
  'patient_given_name', 'clinic_name', 'appointment_date', 'appointment_time',
  'due_date', 'link',
] as const

/* ══════════════════════════════════════════════ clinic-local time in SQL ══ */

/**
 * Today in the clinic, not in Greenwich. The same expression every module
 * builds, for the same reason: the clinic runs on Asia/Kolkata and the runtime
 * this executes in thinks in UTC, so "the day before the appointment" computed
 * in JavaScript moves a 09:00 booking's reminder by five and a half hours and
 * occasionally onto the wrong day entirely.
 */
const CLINIC_ZONE = `'Asia/Kolkata'`

/** A clinic-local wall-clock hour of a clinic-local date, as an absolute instant. */
const atClinicHour = (dateExpr: string, hour: number) =>
  `(((${dateExpr}) + make_time(${hour}, 0, 0)) at time zone ${CLINIC_ZONE})`

/** The clinic-local calendar date of an instant. */
const clinicDateOf = (expr: string) => `((${expr}) at time zone ${CLINIC_ZONE})::date`

/**
 * Whether an instant falls inside owner item 77's dispatch window — 08:00
 * inclusive to 20:00 exclusive, clinic-local.
 *
 * Takes a COLUMN or a literal, never a `?`. Both this and `nextDispatchOpening`
 * repeat their argument, and `db.prepare` numbers placeholders by counting
 * them — so a `?` handed to either becomes two or five placeholders with one
 * value behind them, and Postgres refuses the bind. Callers that have an
 * instant in hand put it in a subquery and pass the column.
 *
 * `extract(hour ...)` truncates, so 08:00:00 gives 8 and is inside, 19:59:59
 * gives 19 and is inside, and 20:00:00 gives 20 and is not. Both boundaries
 * are asserted to the second in `slice3a-messaging.test.mjs`, because "quiet
 * hours" is the kind of rule that is checked once against a comfortable time
 * in the middle of the afternoon and is wrong at the edge for a year.
 */
const insideDispatchWindow = (expr: string) =>
  `(extract(hour from ((${expr}) at time zone ${CLINIC_ZONE})) >= ${DISPATCH_WINDOW_START_HOUR}
    and extract(hour from ((${expr}) at time zone ${CLINIC_ZONE})) < ${DISPATCH_WINDOW_END_HOUR})`

/**
 * The first moment at or after `expr` that the clinic may dispatch in.
 *
 * Before 08:00 it is this morning's opening; at or after 20:00 it is
 * tomorrow's; inside the window it is the instant itself.
 */
const nextDispatchOpening = (expr: string) => `(
  case
    when extract(hour from ((${expr}) at time zone ${CLINIC_ZONE})) < ${DISPATCH_WINDOW_START_HOUR}
      then ${atClinicHour(clinicDateOf(expr), DISPATCH_WINDOW_START_HOUR)}
    when extract(hour from ((${expr}) at time zone ${CLINIC_ZONE})) >= ${DISPATCH_WINDOW_END_HOUR}
      then ${atClinicHour(`${clinicDateOf(expr)} + 1`, DISPATCH_WINDOW_START_HOUR)}
    else (${expr})
  end)`

/* ═════════════════════════════════════════════════════════════ consent ══ */

export type ConsentState = 'opt_in' | 'withdraw' | 'none'

/**
 * What the patient's own instruction says about one channel and one purpose,
 * right now.
 *
 * The latest applicable row wins, and an unqualified withdrawal applies to
 * every purpose — owner item 82. No row at all is `none`, which is refused
 * exactly as a withdrawal is: `WHATSAPP.md` §10 rule 2, "no opt-in row, no
 * send", and item 78's "a registration choice is valid only for the purposes
 * it names".
 *
 * Ordered by `sequence_no` and not by time. `recorded_at` defaults to `now()`,
 * which is the transaction's start, so two rows written at one desk in one
 * transaction tie — and "the latest instruction" decided by a uuid is not a
 * property anybody should have to reason about.
 */
export async function effectiveConsent(
  patientId: string,
  purpose: CommunicationPurpose,
  channel = 'whatsapp',
): Promise<ConsentState> {
  const row = (await db.prepare(
    `select decision from communication_consents
      where patient_id = ? and channel = ?
        and (scope = 'all_purposes' or purpose = ?)
      order by sequence_no desc
      limit 1`,
  ).get(patientId, channel, purpose)) as Row | undefined
  if (!row) return 'none'
  return text(row.decision) === 'opt_in' ? 'opt_in' : 'withdraw'
}

/* ════════════════════════════════════════════════════════════ templates ══ */

/**
 * The material identity of a template's content — item 81's six fields, and
 * only those.
 *
 * `provider_template_name`, the approval state and the provider's verdict are
 * all deliberately outside it: submitting a template to Meta, or Meta pausing
 * it for quality, changes none of what a patient would read.
 */
export function templateFingerprint(material: {
  purpose: string
  channel: string
  locale: string
  body: string
  variables: readonly string[]
  linkDestination: string
  providerCategory: string
}): string {
  return requestFingerprint({
    purpose: material.purpose,
    channel: material.channel,
    locale: material.locale,
    body: material.body,
    // Sorted, because the order somebody typed the variables in is not part of
    // what the template says.
    variables: [...material.variables].sort(),
    linkDestination: material.linkDestination,
    providerCategory: material.providerCategory,
  })
}

/** Every `{{name}}` the body actually interpolates, in order of appearance. */
function placeholdersIn(body: string): string[] {
  return [...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((match) => match[1])
}

/**
 * The clinical safety check on a wording, and the one thing here a regex in
 * the schema cannot do.
 *
 * Owner item 81: a template "never includes medicine names, diagnoses, or
 * balances", and `WHATSAPP.md` §5 gives the third reason — prescription drugs
 * are on WhatsApp's restricted-goods list, so a message naming one walks the
 * pharmacy up to a line it must not cross. The schema refuses money markers
 * structurally; medicines and diagnoses are content, so they are checked
 * against the clinic's own two lists of them.
 *
 * It is a guard and not a substitute for the doctor's approval. A wording that
 * passes this has been checked against the formulary and the approved
 * vocabulary; it has not been read by a clinician, and item 81 requires that
 * separately.
 */
async function refuseClinicalDetail(body: string): Promise<void> {
  const haystack = ` ${body.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `

  const medicines = (await db.prepare(
    `select name, generic_name from medicines`,
  ).all()) as Row[]
  for (const medicine of medicines) {
    for (const candidate of [text(medicine.name), text(medicine.generic_name)]) {
      const needle = candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (needle.length >= 4 && haystack.includes(` ${needle} `)) {
        throw new CommandRefusal(
          `This wording names a medicine (“${candidate}”). A patient message carries the fact and a ` +
          'controlled link, never the clinical record.',
          'TEMPLATE_CARRIES_CLINICAL_DETAIL',
        )
      }
    }
  }

  const diagnoses = (await db.prepare(
    `select display_text from clinical_phrases where kind = 'diagnosis' and active = 1`,
  ).all()) as Row[]
  for (const phrase of diagnoses) {
    const needle = text(phrase.display_text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (needle.length >= 4 && haystack.includes(` ${needle} `)) {
      throw new CommandRefusal(
        `This wording names a diagnosis (“${text(phrase.display_text)}”). A patient message carries the ` +
        'fact and a controlled link, never the clinical record.',
        'TEMPLATE_CARRIES_CLINICAL_DETAIL',
      )
    }
  }

  if (/\b(photo|photograph|image|picture|scan)\b/i.test(body)) {
    throw new CommandRefusal(
      'This wording refers to a clinical image. Owner policy item 28 forbids sending one through ' +
      'WhatsApp; images are released by controlled download or print.',
      'TEMPLATE_CARRIES_CLINICAL_DETAIL',
    )
  }
}

/**
 * Whether this session may put its name to patient-facing wording, or release
 * a clinical recall.
 *
 * Owner item 81 says "the owner-doctor or another explicitly authorized
 * doctor", and item 80 says the same about releasing a recall. This
 * application already has exactly that authority, added for owner item A.6 and
 * managed explicitly ever since: `staff.can_publish_clinical_templates`. Its
 * migration says in as many words that after the one compatibility backfill
 * "the flag is managed explicitly and is never inferred from admin".
 *
 * So this is not "has the doctor role". A clinic with three doctors has one or
 * two who may approve wording, and the difference is a column somebody set.
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

/* ══════════════════════════════════════════ the channel, and the seam ══ */

/*
 * The transport vocabulary now lives in `messaging-transport.ts`, a leaf
 * module, so that `whatsapp-cloud.ts` can speak it without importing this file
 * and creating a cycle. Every name this file used to export it still exports;
 * nothing that referred to them had to change.
 */
export type { ChannelSendRequest, MessageChannel, TransportFailure, TransportResult }

/**
 * The clinic's real channel.
 *
 * `configured()` is the honest answer and it is asked BEFORE anything is
 * attempted: with the clinic's Meta connection absent, the prepare step
 * suppresses every due message into the admin's queue with
 * `channel_not_configured` against it, and `send` is never reached at all.
 * That is owner item 76, and it is why this clinic — which has no credential
 * issued to it — sends nothing today without a line of this being a pretence.
 *
 * When it IS configured, `send` goes to `whatsapp-cloud.ts` and nowhere else.
 * The two-transaction shape around this call is what makes a lost answer
 * survivable, and the comment on `dispatchQueuedMessages` is why it may not be
 * collapsed into one.
 */
export const officialWhatsAppChannel: MessageChannel = {
  name: 'whatsapp_cloud_api',
  configured: () => whatsappConfig() !== null,
  send: (request) =>
    sendTemplateMessage({
      to: request.to,
      templateName: request.templateName,
      templateLanguage: request.templateLanguage,
      variables: request.variables,
      idempotencyKey: request.idempotencyKey,
    }),
}

/**
 * A channel that can only ever talk to this machine.
 *
 * The test adapter, and the guard is at construction rather than at send time
 * on purpose: a base URL pointing anywhere but loopback is refused before a
 * single row is written, so there is no arrangement of test state that ends
 * with a request leaving the building. `graph.facebook.com` is refused by the
 * same line that refuses a typo.
 */
export function loopbackChannel(options: {
  baseUrl: string
  configured?: boolean
  respond: (request: ChannelSendRequest) => TransportResult | Promise<TransportResult>
}): MessageChannel {
  const url = new URL(options.baseUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) {
    throw new Error(
      `A messaging transport in this release may only address loopback. ${url.hostname} is not.`,
    )
  }
  return {
    name: `loopback:${url.host}`,
    configured: () => options.configured !== false,
    send: (request) => Promise.resolve(options.respond(request)),
  }
}

/**
 * A provider's own words, made safe to store and to read out.
 *
 * Meta quotes the recipient's number back inside an error message, and this
 * string is read by a screen and pasted into support threads. Any run of six
 * or more digits becomes a marker; the rest is truncated, because an error
 * detail is a hint about a category, not a transcript.
 */
export function redactProviderDetail(detail: string): string {
  return detail.replace(/\d{6,}/g, '[number]').slice(0, 300)
}

/* ══════════════════════════════════════════════════ schedule maintenance ══ */

/**
 * What owner item 77 says about one booking, computed in the clinic's own
 * timezone and in one statement.
 *
 * "Send at most one appointment reminder, at 18:00 on the previous
 * clinic-local day; if the booking or reschedule occurs after that point, its
 * confirmation replaces the reminder."
 *
 * So which of the two a booking gets is not a preference — it is decided by
 * whether 18:00 yesterday has already gone by at the moment somebody books.
 * `useful_until` is the appointment itself, which needed no decision from
 * anybody.
 */
async function appointmentTiming(scheduledAt: string, now: string): Promise<{
  kind: 'appointment_reminder' | 'appointment_confirmation'
  dueAt: string
  usefulUntil: string
  stillUseful: boolean
}> {
  const row = (await db.prepare(
    `select
       to_char(reminder_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reminder_at,
       to_char(now_at    at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now_at,
       to_char(useful    at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as useful,
       (reminder_at > now_at) as reminder_still_ahead,
       (useful > now_at) as still_useful
     from (
       select
         ${atClinicHour(`${clinicDateOf('?::timestamptz')} - 1`, APPOINTMENT_REMINDER_HOUR)} as reminder_at,
         ?::timestamptz as now_at,
         ?::timestamptz as useful
     ) x`,
  ).get(scheduledAt, now, scheduledAt)) as Row

  const reminderAhead = row.reminder_still_ahead === true
  return {
    kind: reminderAhead ? 'appointment_reminder' : 'appointment_confirmation',
    dueAt: reminderAhead ? text(row.reminder_at) : text(row.now_at),
    usefulUntil: text(row.useful),
    stillUseful: row.still_useful === true,
  }
}

/** Owner item 77's recall: 09:00 clinic-local on the due date. */
async function recallTiming(dueDate: string, now: string): Promise<{
  dueAt: string
  usefulUntil: string
  stillUseful: boolean
}> {
  const row = (await db.prepare(
    `select
       to_char(due_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at,
       to_char(useful at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as useful,
       (useful > ?::timestamptz) as still_useful
     from (
       select ${atClinicHour('?::date', CLINICAL_RECALL_HOUR)} as due_at,
              ${atClinicHour('?::date', RECALL_USEFUL_UNTIL_HOUR)} as useful
     ) x`,
  ).get(now, dueDate, dueDate)) as Row

  return {
    dueAt: text(row.due_at),
    usefulUntil: text(row.useful),
    stillUseful: row.still_useful === true,
  }
}

/**
 * Create the schedule and its outbox row together.
 *
 * Together, because the brief's first requirement of an outbox is that "every
 * intended send is a committed row before any provider contact" — and the
 * moment the intention exists is the moment the schedule does, not the moment
 * a worker gets round to it. A clinic that has decided to contact somebody and
 * has nothing anywhere saying so has a gap exactly as long as the scheduler's
 * interval.
 *
 * Returns null when the live schedule already exists, which is what makes a
 * duplicate command one truthful result rather than two rows.
 */
async function openSchedule(input: {
  actorId: string
  patientId: string
  purpose: CommunicationPurpose
  kind: ScheduleKind
  sourceType: 'appointment_booking' | 'follow_up'
  sourceId: string
  dueAt: string
  usefulUntil: string
  responsibleDoctorId: string | null
  idempotencyKey?: string
  requestFingerprint?: string
}): Promise<{ scheduleId: string; outboxId: string } | null> {
  const scheduleId = randomUUID()
  try {
    await db.prepare(
      `insert into communication_schedules
         (id, patient_id, channel, purpose, schedule_kind, source_type, source_id,
          due_at, useful_until, responsible_doctor_id, status, created_by,
          idempotency_key, request_fingerprint)
       values (?,?, 'whatsapp', ?,?,?,?, ?::timestamptz, ?::timestamptz, ?, 'scheduled', ?, ?, ?)`,
    ).run(
      scheduleId, input.patientId, input.purpose, input.kind, input.sourceType, input.sourceId,
      input.dueAt, input.usefulUntil, input.responsibleDoctorId, input.actorId,
      input.idempotencyKey ?? null, input.requestFingerprint ?? null,
    )
  } catch (error) {
    if (isUniqueViolation(error, 'communication_schedules_one_live')) return null
    throw error
  }

  const outboxId = randomUUID()
  await db.prepare(
    `insert into message_outbox
       (id, schedule_id, patient_id, channel, purpose, idempotency_key, generation,
        status, due_at, useful_until, responsible_doctor_id, created_by)
     values (?,?,?, 'whatsapp', ?, ?, 1, 'scheduled', ?::timestamptz, ?::timestamptz, ?, ?)`,
  ).run(
    outboxId, scheduleId, input.patientId, input.purpose, `${scheduleId}:1`,
    input.dueAt, input.usefulUntil, input.responsibleDoctorId, input.actorId,
  )

  return { scheduleId, outboxId }
}

/**
 * Stop every live schedule for one source, and take its unsent messages with
 * it.
 *
 * `reason` is required and ends up on the row, because a schedule that stopped
 * for no recorded reason is indistinguishable from one that was never created.
 *
 * `status` picks between item 77's two ways of stopping. A schedule that is
 * being REPLACED — the appointment moved, so the old reminder is wrong — is
 * `superseded` and points at what replaced it. One whose source is simply gone
 * — cancelled, marked absent, already attended, the follow-up completed — is
 * `cancelled`. Both leave the row; neither deletes anything.
 *
 * Must be called inside a transaction: it relies on the caller's, and opening
 * its own would take a second connection out of a pool of two while the first
 * still holds the rows it wants.
 */
async function closeSchedulesForSource(input: {
  actorId: string
  sourceType: 'appointment_booking' | 'follow_up'
  sourceId: string
  reason: string
  kinds?: readonly ScheduleKind[]
  as?: 'cancelled' | 'superseded'
  supersededBy?: string
}): Promise<string[]> {
  const kinds = input.kinds ?? SCHEDULE_KINDS
  const placeholders = kinds.map(() => '?').join(',')

  const open = (await db.prepare(
    `select id from communication_schedules
      where source_type = ? and source_id = ? and status = 'scheduled'
        and schedule_kind in (${placeholders})
      order by id
      for update`,
  ).all(input.sourceType, input.sourceId, ...kinds)) as Row[]

  const closed: string[] = []
  for (const row of open) {
    const scheduleId = text(row.id)
    if (input.as === 'superseded') {
      await db.prepare(
        `update communication_schedules
            set status = 'superseded', superseded_at = now(), superseded_by = ?
          where id = ?`,
      ).run(input.supersededBy ?? null, scheduleId)
    } else {
      await db.prepare(
        `update communication_schedules
            set status = 'cancelled', cancelled_at = now(), cancelled_by = ?, cancelled_reason = ?
          where id = ?`,
      ).run(input.actorId, input.reason, scheduleId)
    }

    // The messages that had not gone anywhere yet stop with it. One that HAS
    // reached the provider does not: it was sent, and a row claiming otherwise
    // would be the clinic lying to itself about what the patient received.
    await db.prepare(
      `update message_outbox
          set status = 'cancelled'
        where schedule_id = ? and status in ('scheduled', 'queued', 'failed_retryable')`,
    ).run(scheduleId)

    closed.push(scheduleId)
  }
  return closed
}

/**
 * Bring one booking's schedule into line with what the booking now says.
 *
 * Called by `book_appointment`, `reschedule_appointment`, `cancel_appointment`,
 * `mark_no_show` and `check_in_appointment`, inside each of their existing
 * transactions. None of their responses change and none of them can fail
 * because of this: it writes rows in the same database on the same connection
 * and contacts nothing.
 *
 * The five cases, which are one rule seen from five places — a reminder exists
 * only while there is something to be reminded about:
 *
 *   booked        a reminder, or a confirmation if 18:00 yesterday has gone
 *   rescheduled   the old one is superseded and the new time gets its own
 *   cancelled     nothing to attend
 *   no_show       the appointment is over
 *   checked_in    the patient is standing in the clinic; a reminder tomorrow
 *                 morning about today would be worse than none
 */
export async function syncAppointmentSchedule(input: {
  actorId: string
  bookingId: string
  now?: string
}): Promise<{ scheduleId: string | null; kind: ScheduleKind | null }> {
  const now = input.now ?? isoNow()

  const booking = (await db.prepare(
    `select id, patient_id, status,
            to_char(scheduled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scheduled_at
       from appointment_bookings where id = ?`,
  ).get(input.bookingId)) as Row | undefined
  if (!booking) return { scheduleId: null, kind: null }

  const status = text(booking.status)
  if (status !== 'booked') {
    await closeSchedulesForSource({
      actorId: input.actorId,
      sourceType: 'appointment_booking',
      sourceId: input.bookingId,
      reason: status === 'checked_in'
        ? 'The patient has arrived, so there is nothing left to remind them about.'
        : status === 'no_show'
        ? 'The appointment was closed as not attended.'
        : 'The appointment was cancelled.',
    })
    return { scheduleId: null, kind: null }
  }

  const timing = await appointmentTiming(text(booking.scheduled_at), now)

  // Already correct? Then leave it exactly as it is. A reschedule that did not
  // move the time — a type change, say — must not churn the schedule, because
  // superseding and recreating would reset a message already prepared.
  const existing = (await db.prepare(
    `select id, schedule_kind,
            to_char(due_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at
       from communication_schedules
      where source_type = 'appointment_booking' and source_id = ? and status = 'scheduled'
      for update`,
  ).all(input.bookingId)) as Row[]

  const matching = existing.find(
    (row) => text(row.schedule_kind) === timing.kind && text(row.due_at) === timing.dueAt,
  )
  if (matching && timing.stillUseful) {
    return { scheduleId: text(matching.id), kind: timing.kind }
  }

  if (!timing.stillUseful) {
    await closeSchedulesForSource({
      actorId: input.actorId,
      sourceType: 'appointment_booking',
      sourceId: input.bookingId,
      reason: 'The appointment time has passed, so no message could still be useful.',
    })
    return { scheduleId: null, kind: null }
  }

  /*
   * Stop the old, then start the new, then point one at the other.
   *
   * The order is forced: one live schedule per source and kind, so the old
   * reminder has to stop being `scheduled` before a new one can be inserted —
   * and at that moment there is nothing yet for `superseded_by` to reference.
   * The supersession's TIME is recorded immediately and its pointer a line
   * later, which is why the schema requires the first and not the second.
   */
  const superseded = await closeSchedulesForSource({
    actorId: input.actorId,
    sourceType: 'appointment_booking',
    sourceId: input.bookingId,
    reason: 'replaced',
    as: 'superseded',
  })

  const opened = await openSchedule({
    actorId: input.actorId,
    patientId: text(booking.patient_id),
    purpose: 'appointment',
    kind: timing.kind,
    sourceType: 'appointment_booking',
    sourceId: input.bookingId,
    dueAt: timing.dueAt,
    usefulUntil: timing.usefulUntil,
    responsibleDoctorId: null,
  })

  if (opened) {
    for (const scheduleId of superseded) {
      await db.prepare(
        `update communication_schedules set superseded_by = ? where id = ?`,
      ).run(opened.scheduleId, scheduleId)
    }
  }

  return { scheduleId: opened?.scheduleId ?? null, kind: opened ? timing.kind : null }
}

/**
 * A follow-up that a doctor has completed or cancelled is no longer a reason
 * to contact anybody. Owner item 83: "Completing, cancelling, or superseding
 * that instruction removes eligibility before release."
 */
export async function cancelRecallForFollowUp(input: {
  actorId: string
  followUpId: string
  reason: string
}): Promise<void> {
  await closeSchedulesForSource({
    actorId: input.actorId,
    sourceType: 'follow_up',
    sourceId: input.followUpId,
    reason: input.reason,
    kinds: ['clinical_recall'],
  })
}

/* ═════════════════════════════════════════════════════════════ the worker ══ */

/**
 * Turn due intentions into queued messages, or into a reason they will not be
 * sent.
 *
 * This is the step owner item 80 describes for a cohort and which applies just
 * as much to one message: "consent, eligibility, completion/cancellation, and
 * opt-out are rechecked for each patient immediately before queueing". Every
 * one of those checks is here, under a row lock, and every failure produces a
 * SUPPRESSED row with a reason rather than a silence — because owner item 76
 * says the work goes to a staff queue, and a suppressed row is that queue
 * entry.
 *
 * It contacts nothing. The channel is consulted only for `configured()`.
 */
export async function prepareDueMessages(options: {
  now?: string
  limit?: number
  channel?: MessageChannel
} = {}): Promise<{
  prepared: number
  queued: number
  suppressed: number
  reasons: Record<string, number>
}> {
  const now = options.now ?? isoNow()
  const channel = options.channel ?? officialWhatsAppChannel
  const limit = options.limit ?? 200
  const configured = channel.configured()

  const due = (await db.prepare(
    `select o.id from message_outbox o
      where o.status = 'scheduled' and o.due_at <= ?::timestamptz
      order by o.due_at
      limit ?`,
  ).all(now, limit)) as Row[]

  const summary = { prepared: 0, queued: 0, suppressed: 0, reasons: {} as Record<string, number> }

  for (const candidate of due) {
    const result = await transaction(() => prepareOne(text(candidate.id), now, configured))
    if (!result) continue
    summary.prepared += 1
    if (result === 'queued') summary.queued += 1
    else {
      summary.suppressed += 1
      summary.reasons[result] = (summary.reasons[result] ?? 0) + 1
    }
  }

  return summary
}

async function prepareOne(
  outboxId: string,
  now: string,
  channelConfigured: boolean,
): Promise<'queued' | string | null> {
  /*
   * The outbox row first and its schedule second, and always in that order.
   *
   * `withdrawConsent` takes the schedules first and then the messages;
   * consistent ordering is what keeps a withdrawal racing a preparation from
   * becoming a deadlock, and the test that races them asserts the outcome
   * rather than the absence of an error.
   */
  const message = (await db.prepare(
    `select o.*, s.status as schedule_status,
            to_char(o.useful_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as useful_iso
       from message_outbox o
       join communication_schedules s on s.id = o.schedule_id
      where o.id = ?
      for update of o`,
  ).get(outboxId)) as Row | undefined

  if (!message || text(message.status) !== 'scheduled') return null

  const suppress = async (reason: string) => {
    await db.prepare(
      `update message_outbox set status = 'suppressed', suppression_reason = ? where id = ?`,
    ).run(reason, outboxId)
    return reason
  }

  // The source stopped being a reason to contact anybody.
  if (text(message.schedule_status) !== 'scheduled') {
    await db.prepare(`update message_outbox set status = 'cancelled' where id = ?`).run(outboxId)
    return 'cancelled'
  }

  if (text(message.useful_iso) <= now) return await suppress('past_useful_by')

  const purpose = text(message.purpose) as CommunicationPurpose
  const consent = await effectiveConsent(text(message.patient_id), purpose)
  if (consent !== 'opt_in') {
    return await suppress(consent === 'withdraw' ? 'consent_withdrawn' : 'no_consent')
  }

  // Owner item 76. No official channel, no automated send — and the work goes
  // to a staff queue rather than nowhere.
  if (!channelConfigured) return await suppress('channel_not_configured')

  const template = (await db.prepare(
    `select id, body, variables_json, link_destination, provider_state, provider_template_name
       from message_templates
      where purpose = ? and channel = 'whatsapp' and locale = 'en'
        and approval_state = 'approved'`,
  ).get(purpose)) as Row | undefined
  if (!template) return await suppress('no_approved_template')
  if (text(template.provider_state) !== 'approved') {
    return await suppress('provider_template_not_approved')
  }

  const patient = (await db.prepare(
    `select name, phone from patients where id = ?`,
  ).get(text(message.patient_id))) as Row | undefined
  const number = dialable(text(patient?.phone))
  if (!number.ok) return await suppress('no_contact_number')

  const rendered = await renderTemplate(text(template.body), text(template.link_destination), {
    patientName: text(patient?.name),
    scheduleId: text(message.schedule_id),
  })
  if (!rendered.ok) return await suppress(rendered.reason)

  await db.prepare(
    `update message_outbox
        set status = 'queued', template_id = ?, to_number = ?, rendered_body = ?,
            variables_json = ?
      where id = ?`,
  ).run(
    text(template.id), number.to, rendered.body, canonicalJson(rendered.variables), outboxId,
  )

  return 'queued'
}

/**
 * Fill a template's variables from the clinic's records.
 *
 * Every value here is either a fact about the appointment's time, the
 * patient's own given name, the clinic's name, or a controlled link. There is
 * deliberately no path by which a medicine, a diagnosis, an amount or an image
 * can reach a message body: the whitelist in the schema means such a variable
 * cannot be declared, and this function means nothing outside the whitelist
 * can be resolved.
 */
async function renderTemplate(
  body: string,
  linkDestination: string,
  context: { patientName: string; scheduleId: string },
): Promise<
  { ok: true; body: string; variables: Record<string, string> }
  | { ok: false; reason: string }
> {
  const needed = new Set(placeholdersIn(body))
  const variables: Record<string, string> = {}

  if (needed.has('patient_given_name')) {
    variables.patient_given_name = context.patientName.trim().split(/\s+/)[0] ?? ''
  }
  if (needed.has('clinic_name')) variables.clinic_name = CONSENT_CLINIC_NAME

  if (needed.has('appointment_date') || needed.has('appointment_time') || needed.has('due_date')) {
    const source = (await db.prepare(
      `select s.source_type, s.source_id,
              to_char(b.scheduled_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY') as appointment_date,
              to_char(b.scheduled_at at time zone ${CLINIC_ZONE}, 'HH24:MI') as appointment_time,
              to_char(f.due_date, 'DD Mon YYYY') as due_date
         from communication_schedules s
         left join appointment_bookings b
           on s.source_type = 'appointment_booking' and b.id = s.source_id
         left join follow_ups f
           on s.source_type = 'follow_up' and f.id = s.source_id
        where s.id = ?`,
    ).get(context.scheduleId)) as Row | undefined

    if (needed.has('appointment_date')) variables.appointment_date = text(source?.appointment_date)
    if (needed.has('appointment_time')) variables.appointment_time = text(source?.appointment_time)
    if (needed.has('due_date')) variables.due_date = text(source?.due_date)
  }

  if (needed.has('link')) {
    if (linkDestination !== 'clinic_public_page') {
      return { ok: false, reason: 'link_destination_unavailable' }
    }
    const url = Deno.env.get('CLINIC_PUBLIC_PAGE_URL') ?? ''
    if (!url) return { ok: false, reason: 'link_destination_unavailable' }
    variables.link = url
  }

  /*
   * A declared variable that resolved to nothing is a message with a hole in
   * it, and it goes to the staff queue rather than to the patient — better an
   * admin reading a reason than somebody reading "You are expected on at".
   *
   * It has its own reason and does not borrow `no_approved_template`, which
   * was the first version and was a lie: the template is approved, and it is
   * the clinic's own record that is missing a value. An admin told the wrong
   * thing goes and looks at the wrong screen.
   */
  for (const name of needed) {
    if (!variables[name]) return { ok: false, reason: 'variable_unavailable' }
  }

  const filled = body.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/g,
    (_, name: string) => variables[name] ?? '',
  )
  return { ok: true, body: filled, variables }
}

/**
 * Take queued messages to the provider, one at a time, in two transactions
 * with the call in between.
 *
 * The shape is the whole point and it is not an optimization anybody may undo:
 *
 *   T1  lock the row, prove the attempt is allowed, WRITE the attempt row,
 *       move the message to `outcome_unknown`.        commit
 *   --  call the provider
 *   T2  lock the row, settle the attempt, move the message to what the answer
 *       actually says.                                 commit
 *
 * A process that dies in the middle leaves an `in_flight` attempt and a
 * message that says `outcome_unknown`, which is true. The alternative — one
 * transaction around the call — leaves nothing at all when it dies, and the
 * next worker sends a second copy.
 *
 * `outcome_unknown` is never picked up again here. Only provider evidence can
 * settle it, because the one thing worse than not knowing is guessing.
 */
export async function dispatchQueuedMessages(options: {
  now?: string
  limit?: number
  channel?: MessageChannel
} = {}): Promise<{ attempted: number; accepted: number; failed: number; held: number }> {
  const now = options.now ?? isoNow()
  const channel = options.channel ?? officialWhatsAppChannel
  const limit = options.limit ?? 50
  const summary = { attempted: 0, accepted: 0, failed: 0, held: 0 }

  // Owner item 77's quiet hours, asked once for the whole run. Nothing is
  // picked up outside the window, first attempt or retry alike.
  const open = (await db.prepare(
    `select ${insideDispatchWindow('x.at')} as open from (select ?::timestamptz as at) x`,
  ).get(now)) as Row
  if (open.open !== true) return summary

  /*
   * ── WHY THE USEFULNESS DEADLINE IS NOT IN THIS QUERY ────────────────────
   *
   * It was, and that was a defect. `and useful_until > now` filtered an
   * expired message out of the candidate list, so `claimAttempt` — which
   * holds the only code that suppresses one with `past_useful_by` — was never
   * reached for exactly the rows that needed it. The message did not go out,
   * which was right, and it also stayed at `queued` for ever, which was not:
   * `queued` is not one of the statuses the admin's failure queue reads, so a
   * reminder that quietly expired became invisible to everybody. The clinic
   * would never learn that a patient had not been told.
   *
   * So the deadline is asked ONCE, under the row lock, where the answer can be
   * recorded. Selecting a row here is not a decision to send it; every such
   * decision belongs under the lock, and this is the only place one had leaked
   * out to.
   */
  const ready = (await db.prepare(
    `select id from message_outbox
      where status in ('queued', 'failed_retryable')
        and due_at <= ?::timestamptz
        and (next_attempt_at is null or next_attempt_at <= ?::timestamptz)
      order by due_at
      limit ?`,
  ).all(now, now, limit)) as Row[]

  for (const candidate of ready) {
    const claimed = await transaction(() => claimAttempt(text(candidate.id), now, channel.name))
    if (!claimed) continue
    summary.attempted += 1
    summary.held += 1

    let result: TransportResult
    try {
      result = await channel.send({
        to: claimed.to,
        body: claimed.body,
        templateName: claimed.templateName,
        templateLanguage: claimed.templateLanguage,
        variables: claimed.variables,
        idempotencyKey: claimed.idempotencyKey,
      })
    } catch (error) {
      /*
       * The transport threw rather than answering. It may have reached Meta
       * before it did — a socket that dies after the request went out looks
       * exactly like one that died before — so this is `ambiguous` and the
       * message stays `outcome_unknown` rather than being queued for another
       * go. `settleAttempt` is where that is enforced.
       */
      result = {
        ok: false,
        category: 'transport_error',
        detail: error instanceof Error ? error.message : 'The transport threw.',
        terminal: false,
        ambiguous: true,
      }
    }

    await transaction(() => settleAttempt(claimed.outboxId, claimed.attemptId, result, now))
    summary.held -= 1
    if (result.ok) summary.accepted += 1
    else summary.failed += 1
  }

  return summary
}

async function claimAttempt(
  outboxId: string,
  now: string,
  transport: string,
): Promise<{ outboxId: string; attemptId: string } & ChannelSendRequest | null> {
  const message = (await db.prepare(
    `select o.*, t.provider_template_name, t.provider_state, t.approval_state,
            t.body as template_body, t.locale as template_locale,
            s.status as schedule_status,
            to_char(o.useful_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as useful_iso,
            (o.first_attempt_at is null
             or o.first_attempt_at + make_interval(mins => ${RETRY_WINDOW_MINUTES}) >= ?::timestamptz)
              as inside_retry_window
       from message_outbox o
       join communication_schedules s on s.id = o.schedule_id
       left join message_templates t on t.id = o.template_id
      where o.id = ?
      for update of o skip locked`,
  ).get(now, outboxId)) as Row | undefined

  /*
   * `skip locked` and not a wait, because the row being held means another
   * worker is already dealing with it — waiting for that lock only to discover
   * the message has moved to `outcome_unknown` is a worker blocked for the
   * length of a provider call for no reason. This is what makes two concurrent
   * workers produce one attempt rather than two.
   */
  if (!message) return null
  if (!['queued', 'failed_retryable'].includes(text(message.status))) return null

  /*
   * The authoritative record, asked again under this lock.
   *
   * A cancellation sweeps its own queued messages inside the transaction that
   * cancels the schedule, so in the ordinary case this is already true. It is
   * asked anyway because the sweep and this check are two separate pieces of
   * code that have to agree, and the cost of them disagreeing is a patient
   * told to come to an appointment that was called off. A message whose
   * schedule is no longer live is cancelled here rather than sent.
   */
  if (text(message.schedule_status) !== 'scheduled') {
    await db.prepare(
      `update message_outbox set status = 'cancelled', next_attempt_at = null where id = ?`,
    ).run(outboxId)
    return null
  }

  // Every bound item 79 sets, asked again under the lock rather than trusted
  // from the query that selected this row a moment ago.
  const attemptCount = Number(message.attempt_count ?? 0)
  if (attemptCount >= MAX_PROVIDER_ATTEMPTS) {
    await failTerminally(outboxId, now, 'The three permitted attempts have been made.')
    return null
  }
  if (message.inside_retry_window !== true) {
    await failTerminally(outboxId, now, 'The two hours allowed for retries have passed.')
    return null
  }
  if (text(message.useful_iso) <= now) {
    // Not a failure: nobody refused it and nothing broke. The moment simply
    // passed, which is a suppression with a reason and a queue entry.
    await db.prepare(
      `update message_outbox
          set status = 'suppressed', suppression_reason = 'past_useful_by', next_attempt_at = null
        where id = ?`,
    ).run(outboxId)
    return null
  }

  // A withdrawal that landed between preparing and dispatching. Owner item 82
  // allows no override, and "it was already queued" is the override.
  const consent = await effectiveConsent(
    text(message.patient_id), text(message.purpose) as CommunicationPurpose,
  )
  if (consent !== 'opt_in') {
    await db.prepare(
      `update message_outbox
          set status = 'suppressed',
              suppression_reason = ?
        where id = ?`,
    ).run(consent === 'withdraw' ? 'consent_withdrawn' : 'no_consent', outboxId)
    return null
  }

  // And the template's own standing, which Meta can withdraw at any time.
  if (text(message.approval_state) !== 'approved' || text(message.provider_state) !== 'approved') {
    await db.prepare(
      `update message_outbox
          set status = 'suppressed', suppression_reason = 'provider_template_not_approved'
        where id = ?`,
    ).run(outboxId)
    return null
  }

  const attemptId = randomUUID()
  const attemptNumber = attemptCount + 1

  await db.prepare(
    `insert into message_attempts (id, outbox_id, attempt_number, transport, started_at)
     values (?,?,?,?, ?::timestamptz)`,
  ).run(attemptId, outboxId, attemptNumber, transport, now)

  await db.prepare(
    `update message_outbox
        set status = 'outcome_unknown',
            attempt_count = ?,
            first_attempt_at = coalesce(first_attempt_at, ?::timestamptz),
            last_attempt_at = ?::timestamptz,
            next_attempt_at = null
      where id = ?`,
  ).run(attemptNumber, now, now, outboxId)

  /*
   * The variables, ordered as the placeholders appear in the APPROVED BODY
   * rather than as they happen to sit in the stored JSON object.
   *
   * Meta renders the patient's copy itself, from the template it approved plus
   * these values, so the order is the contract when the account registered its
   * templates positionally — and even named parameters have to agree on the
   * set. Deriving the order from the pinned template's own body means it
   * cannot drift from what was approved: `template_id` is a version, and a
   * version's body cannot be edited.
   */
  const stored = JSON.parse(text(message.variables_json) || '{}') as Record<string, string>
  // Deduplicated on first appearance: a body that greets the patient by name
  // twice still has one `patient_given_name` variable, and sending it twice
  // would be a parameter count Meta refuses.
  const variables = [...new Set(placeholdersIn(text(message.template_body)))]
    .map((name) => ({ name, value: String(stored[name] ?? '') }))

  return {
    outboxId,
    attemptId,
    to: text(message.to_number),
    body: text(message.rendered_body),
    templateName: text(message.provider_template_name),
    templateLanguage: text(message.template_locale) || 'en',
    variables,
    idempotencyKey: text(message.idempotency_key),
  }
}

async function settleAttempt(
  outboxId: string,
  attemptId: string,
  result: TransportResult,
  now: string,
): Promise<void> {
  await db.prepare(`select id from message_outbox where id = ? for update`).get(outboxId)

  /*
   * `and outcome = 'in_flight'` on both settlements, which is new in Slice 3B
   * and exists because Slice 3B is what made the collision reachable.
   *
   * `recoverStaleAttempts` can settle a long-abandoned attempt as a call whose
   * answer never arrived. If the original worker were somehow still alive and
   * came back afterwards, an unconditional update would hit the
   * `message_attempts_settle_once` trigger, which raises — and the raise would
   * propagate out of the dispatch loop and abandon every remaining message in
   * the cycle. One stalled call must not cost the clinic a round of reminders.
   *
   * Conditional, the late settlement finds no row and changes nothing, while
   * the OUTBOX update below still runs and still records the truth the worker
   * came back with. The attempt row is a record of one call; the message's
   * state is the thing that matters, and it is not the attempt's to withhold.
   */
  if (result.ok) {
    await db.prepare(
      `update message_attempts
          set outcome = 'accepted', provider_reference = ?, provider_accept_status = ?,
              finished_at = ?::timestamptz
        where id = ? and outcome = 'in_flight'`,
    ).run(result.providerReference, result.acceptStatus, now, attemptId)

    /*
     * `sent_to_provider`, and `delivery_rank = 1` for `accepted`.
     *
     * Meta's own contract is the reason this is not `delivered`: the POST
     * answers `accepted`, `held_for_quality_assessment` or `paused`, and a
     * message held for quality assessment has demonstrably NOT reached
     * anybody. Rank 1 is below `sent` and `delivered`, so the webhook's later
     * evidence raises it and this cannot be the top of the ladder.
     */
    await db.prepare(
      `update message_outbox
          set status = 'sent_to_provider', provider_reference = ?,
              delivery_status = 'accepted', delivery_rank = 1, delivery_status_at = ?::timestamptz,
              error_category = '', next_attempt_at = null
        where id = ?`,
    ).run(result.providerReference, now, outboxId)
    return
  }

  await db.prepare(
    `update message_attempts
        set outcome = ?, error_category = ?, error_detail = ?, finished_at = ?::timestamptz
      where id = ? and outcome = 'in_flight'`,
  ).run(
    result.category === 'transport_error' ? 'transport_error' : 'rejected',
    result.category, redactProviderDetail(result.detail), now, attemptId,
  )

  /*
   * ── THE ANSWER NEVER CAME BACK ──────────────────────────────────────────
   *
   * A timeout, a dropped connection, or a 2xx carrying no message identifier.
   * The clinic does not know whether Meta took this message, and there is no
   * idempotency key on `POST /messages` — Meta documents none — so there is no
   * safe way to ask again.
   *
   * So it is not a failure and it is not scheduled for retry. The message
   * stays at `outcome_unknown`, where `claimAttempt` will never pick it up
   * again because that status is not in the dispatchable set, and the only
   * thing that can settle it is the statuses webhook finding it through the
   * `biz_opaque_callback_data` this clinic sent. `error_category` is recorded
   * so the admin's queue can say what happened; the STATUS is left alone,
   * because `outcome_unknown` is already the truth and anything else would be
   * a guess in the direction that sends a second reminder.
   *
   * `first_failed_at` is stamped, and that is a Slice 3B decision worth being
   * explicit about. It does NOT declare the message failed — the status still
   * says nobody knows. It starts item 79's four-clinic-hour clock, because
   * `readCommunicationFailures` measures escalation from that column and a
   * null there means this row would sit in the admin's queue for ever without
   * ever reaching the owner-doctor. An outcome nobody knows is the single
   * state most likely to need a person to pick up a telephone, so it is the
   * last one that should be unable to escalate.
   */
  if (result.ambiguous) {
    await db.prepare(
      `update message_outbox
          set error_category = ?, next_attempt_at = null,
              first_failed_at = coalesce(first_failed_at, ?::timestamptz),
              failure_owner_role = 'admin'
        where id = ? and status = 'outcome_unknown'`,
    ).run(result.category, now, outboxId)
    return
  }

  const counted = (await db.prepare(
    `select attempt_count from message_outbox where id = ?`,
  ).get(outboxId)) as Row
  const attemptCount = Number(counted.attempt_count ?? 0)

  /*
   * When the next attempt could happen, and whether item 79 still allows it.
   *
   * The backoff is measured from the FIRST attempt rather than from this one,
   * because item 79's two hours are measured from the first — so a slow third
   * attempt cannot push the window along in front of itself. Then it is moved
   * forward to the next dispatch opening, since item 77 binds a retry exactly
   * as it binds a first send, and the two questions that decide whether there
   * is a next attempt at all are asked of that moved time rather than of the
   * unmoved one.
   */
  const elapsed = RETRY_BACKOFF_MINUTES
    .slice(0, Math.min(attemptCount, RETRY_BACKOFF_MINUTES.length))
    .reduce((total, minutes) => total + minutes, 0)

  const plan = (await db.prepare(
    `select to_char(next_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as next_at,
            (next_at <= first_attempt_at + make_interval(mins => ${RETRY_WINDOW_MINUTES})) as fits_window,
            (next_at < useful_until) as still_useful
       from (
         select ${nextDispatchOpening('c.candidate')} as next_at, c.first_attempt_at, c.useful_until
           from (
             select first_attempt_at + make_interval(mins => ?) as candidate,
                    first_attempt_at, useful_until
               from message_outbox where id = ?
           ) c
       ) x`,
  ).get(elapsed, outboxId)) as Row

  const exhausted = attemptCount >= MAX_PROVIDER_ATTEMPTS
  const terminal = result.terminal || exhausted
    || plan.fits_window !== true || plan.still_useful !== true

  if (terminal) {
    await failTerminally(outboxId, now, '', result.category)
    return
  }

  await db.prepare(
    `update message_outbox
        set status = 'failed_retryable',
            error_category = ?,
            next_attempt_at = ?::timestamptz,
            first_failed_at = coalesce(first_failed_at, ?::timestamptz),
            failure_owner_role = 'admin'
      where id = ?`,
  ).run(result.category, text(plan.next_at), now, outboxId)
}

/**
 * The end of the line for one message, and the moment item 79's escalation
 * starts.
 *
 * "A terminal failure or exhausted retry escalates immediately" — so
 * `escalated_at` is stamped here rather than computed later by a query
 * somebody might change. The admin's ownership began at the FIRST failure,
 * which is what `first_failed_at` keeps, and the owner-doctor's four clinic
 * hours are measured from that rather than from this.
 */
async function failTerminally(
  outboxId: string,
  now: string,
  note: string,
  category?: string,
): Promise<void> {
  await db.prepare(
    `update message_outbox
        set status = 'failed_terminal',
            error_category = case when ? <> '' then ? else error_category end,
            first_failed_at = coalesce(first_failed_at, ?::timestamptz),
            escalated_at = coalesce(escalated_at, ?::timestamptz),
            failure_owner_role = 'admin',
            next_attempt_at = null,
            resolution_note = case when ? <> '' then ? else resolution_note end
      where id = ?`,
  ).run(category ?? '', category ?? '', now, now, note, note, outboxId)
}

/**
 * Apply one piece of authenticated provider evidence.
 *
 * Nothing in Slice 3A calls this from a request: there is no webhook endpoint,
 * because an endpoint that takes delivery evidence must verify Meta's
 * signature, and a signature check with no credentials to check against is a
 * hole shaped like a feature. What exists is the rule such an endpoint will
 * need, tested directly, so that Slice 3B writes the transport and not the
 * semantics.
 *
 * The rule is monotonic, and that single property is what makes duplicate and
 * out-of-order webhooks harmless. Meta may deliver the same status twice, and
 * may deliver `sent` after `delivered`; evidence may only RAISE the rank, so a
 * second copy changes nothing and a late one cannot un-deliver a message. A
 * message that has reached `delivered` or a terminal failure is settled, and
 * nothing later moves it.
 */
export async function applyProviderEvidence(input: {
  providerReference: string
  status: 'sent' | 'delivered' | 'failed'
  occurredAt?: string
  errorCategory?: TransportFailure
  errorDetail?: string
}): Promise<'applied' | 'ignored' | 'unknown_reference'> {
  const at = input.occurredAt ?? isoNow()
  const rank = { sent: 2, delivered: 3, failed: 4 }[input.status]

  return await transaction(async () => {
    const message = (await db.prepare(
      `select id, status, delivery_rank from message_outbox
        where provider_reference = ? for update`,
    ).get(input.providerReference)) as Row | undefined
    if (!message) return 'unknown_reference'

    // Settled is settled. `delivered` is the patient having received it and
    // `failed_terminal` is the clinic having been told it never will; neither
    // is a thing a later message from Meta gets to revise.
    if (['delivered', 'failed_terminal'].includes(text(message.status))) return 'ignored'
    if (Number(message.delivery_rank ?? 0) >= rank) return 'ignored'

    if (input.status === 'failed') {
      await db.prepare(
        `update message_outbox
            set status = 'failed_terminal',
                delivery_status = 'failed', delivery_rank = 4, delivery_status_at = ?::timestamptz,
                error_category = ?,
                first_failed_at = coalesce(first_failed_at, ?::timestamptz),
                escalated_at = coalesce(escalated_at, ?::timestamptz),
                failure_owner_role = 'admin',
                next_attempt_at = null
          where id = ?`,
      ).run(at, input.errorCategory ?? 'unknown', at, at, text(message.id))
      return 'applied'
    }

    await db.prepare(
      `update message_outbox
          set status = case when ? = 'delivered' then 'delivered' else 'sent_to_provider' end,
              delivery_status = ?, delivery_rank = ?, delivery_status_at = ?::timestamptz
        where id = ?`,
    ).run(input.status, input.status, rank, at, text(message.id))
    return 'applied'
  })
}

/* ══════════════════════════════════════════ Slice 3B: provider evidence ══ */

export type ProviderStatus = 'sent' | 'delivered' | 'read' | 'played' | 'failed'

export type ProviderEventOutcome =
  | 'applied' | 'ignored' | 'duplicate' | 'unknown_reference'

/**
 * Meta's five status words, and what each one proves.
 *
 * `read` and `played` both map to `delivered`, and that is a statement about
 * evidence rather than a shortcut: a message the patient opened was certainly
 * delivered, so it carries delivery's rank. It is stored AS `delivered`
 * because `message_outbox.delivery_status` is a closed list from Slice 3A, and
 * widening an accepted check constraint to record a stronger fact the clinic
 * has no use for would be a migration bought for nothing. What the clinic
 * needs to know is whether it reached the patient. It did.
 *
 * Nothing here can produce `delivered` from an acceptance. `accepted`,
 * `held_for_quality_assessment` and `paused` are answers to the POST, are not
 * status events at all, and never travel through this function.
 */
const EVIDENCE: Record<
  ProviderStatus,
  { status: 'sent' | 'delivered' | 'failed'; rank: number }
> = {
  sent: { status: 'sent', rank: 2 },
  delivered: { status: 'delivered', rank: 3 },
  read: { status: 'delivered', rank: 3 },
  played: { status: 'delivered', rank: 3 },
  failed: { status: 'failed', rank: 4 },
}

/**
 * Meta's numeric error code, in the clinic's vocabulary.
 *
 * A failure reported through the statuses webhook is already terminal for this
 * message — it is Meta saying the message will not arrive — so only the
 * category matters here, never the retryability.
 */
function providerErrorCategory(code?: number): TransportFailure {
  if (code === undefined) return 'unknown'
  if ([131026, 131021, 131047].includes(code)) return 'invalid_recipient'
  if ([132000, 132001, 132012, 132015, 132016].includes(code)) return 'template_rejected'
  if ([4, 80007, 130429, 131056, 131049].includes(code)) return 'rate_limited'
  if ([368, 131005, 190, 200, 10, 299].includes(code)) return 'not_authorized'
  if ([2, 131016, 131000].includes(code)) return 'provider_unavailable'
  return 'unknown'
}

/**
 * One authenticated status event from Meta, recorded and then applied.
 *
 * The endpoint has already verified the signature over the raw bytes; by the
 * time anything reaches here the event is known to have come from Meta. What
 * is left is making sure it lands exactly once, on the right message, and only
 * ever in the direction of stronger truth.
 *
 * ── HOW A MESSAGE IS FOUND ─────────────────────────────────────────────────
 *
 * Two ways, and the second is the reason this function exists at all.
 *
 *   1. By `provider_reference` — the wamid — which is the ordinary case: the
 *      POST answered, the clinic stored the id, and the webhook names it.
 *
 *   2. By the echoed `biz_opaque_callback_data`, which is the clinic's
 *      `idempotency_key`. This is the ONLY way to reach a message whose POST
 *      reply was lost: the clinic never learned the wamid, so there is nothing
 *      to match on, and the message would otherwise sit at `outcome_unknown`
 *      for ever. When it is found this way the wamid is adopted onto the row,
 *      which is the clinic learning — late, and from the provider — what it
 *      failed to hear at the time.
 *
 * ── HOW IT LANDS EXACTLY ONCE ──────────────────────────────────────────────
 *
 * The event row is inserted BEFORE the evidence is applied and in the same
 * transaction, against a unique index on (provider_reference, status). Two
 * webhooks carrying the same event therefore race on that index: one inserts
 * and applies, the other is refused and rolls back having changed nothing.
 * Meta retries a webhook for up to seven days until it gets a 200, so a
 * duplicate is documented behaviour rather than a hypothetical.
 */
export async function applyProviderStatusEvent(input: {
  providerReference: string
  status: ProviderStatus
  callbackData?: string
  occurredAt?: string
  errorCode?: number
  errorDetail?: string
}): Promise<ProviderEventOutcome> {
  const evidence = EVIDENCE[input.status]
  const at = input.occurredAt ?? isoNow()
  const callbackData = input.callbackData ?? ''

  try {
    return await transaction(async () => {
      /*
       * The message, by wamid first and by the clinic's own key second.
       *
       * Both take the row `for update`, so an event racing the worker that is
       * settling the very same message is serialized behind it rather than
       * reading a half-written row.
       */
      let message = (await db.prepare(
        `select id, status, delivery_rank, provider_reference
           from message_outbox where provider_reference = ? for update`,
      ).get(input.providerReference)) as Row | undefined

      if (!message && callbackData !== '') {
        message = (await db.prepare(
          `select id, status, delivery_rank, provider_reference
             from message_outbox where idempotency_key = ? for update`,
        ).get(callbackData)) as Row | undefined

        /*
         * Found by the clinic's key, and already carrying a DIFFERENT wamid.
         *
         * That is not this message's evidence. It means the echoed callback
         * value belongs to a send this row has already recorded another id
         * for, and adopting a second id would attach one delivery to another
         * message. Refuse it, and record it as naming no message at all.
         *
         * The comparison is against THIS event's reference and not merely
         * against empty, which is a race that was in the first version of this
         * and is worth naming. Two events for one message — `sent` and
         * `delivered` — can arrive together, both find no row by wamid because
         * neither has committed yet, and both then queue on this row's lock.
         * The first adopts the wamid and commits. The second acquires the lock,
         * re-reads the row under it, and sees a reference where there was none.
         * Testing for "not empty" discarded that second event as belonging to
         * somebody else, and the message stayed at `sent_to_provider` having
         * actually been delivered. Testing for "not mine" is the same guard
         * without the false positive.
         */
        if (
          message && text(message.provider_reference) !== ''
          && text(message.provider_reference) !== input.providerReference
        ) {
          message = undefined
        }
      }

      const outboxId = message ? text(message.id) : null
      const effect: 'applied' | 'ignored' | 'unknown_reference' = !message
        ? 'unknown_reference'
        : (['delivered', 'failed_terminal'].includes(text(message.status))
            || Number(message.delivery_rank ?? 0) >= evidence.rank)
        ? 'ignored'
        : 'applied'

      await db.prepare(
        `insert into message_provider_events
           (id, provider_reference, status, callback_data, outbox_id, effect,
            error_code, error_detail, occurred_at)
         values (?,?,?,?,?,?,?,?, ?::timestamptz)`,
      ).run(
        randomUUID(), input.providerReference, input.status, callbackData,
        outboxId, effect,
        input.errorCode ?? null, redactProviderDetail(input.errorDetail ?? ''), at,
      )

      if (!message) return 'unknown_reference'
      if (effect === 'ignored') return 'ignored'

      // Learned late: the identifier the lost reply was carrying.
      if (text(message.provider_reference) === '') {
        await db.prepare(
          `update message_outbox set provider_reference = ? where id = ?`,
        ).run(input.providerReference, outboxId)
      }

      if (evidence.status === 'failed') {
        await db.prepare(
          `update message_outbox
              set status = 'failed_terminal',
                  delivery_status = 'failed', delivery_rank = 4,
                  delivery_status_at = ?::timestamptz,
                  error_category = ?,
                  first_failed_at = coalesce(first_failed_at, ?::timestamptz),
                  escalated_at = coalesce(escalated_at, ?::timestamptz),
                  failure_owner_role = 'admin',
                  next_attempt_at = null
            where id = ?`,
        ).run(at, providerErrorCategory(input.errorCode), at, at, outboxId)
        return 'applied'
      }

      await db.prepare(
        `update message_outbox
            set status = case when ? = 'delivered' then 'delivered' else 'sent_to_provider' end,
                delivery_status = ?, delivery_rank = ?, delivery_status_at = ?::timestamptz
          where id = ?`,
      ).run(evidence.status, evidence.status, evidence.rank, at, outboxId)
      return 'applied'
    })
  } catch (error) {
    /*
     * The dedup index refused it: this exact event has already been recorded
     * and applied, by an earlier webhook or by one running concurrently. The
     * transaction rolled back, so nothing here changed anything, and the
     * caller answers Meta with the same 200 it would have answered anyway.
     *
     * Named rather than "any unique violation", so that a collision on
     * something else — `message_outbox_provider_reference`, if two events
     * somehow carried one wamid for two different messages — is raised and
     * logged instead of being quietly reported as a duplicate. A swallowed
     * constraint is how a real fault becomes a statistic.
     */
    if (isUniqueViolation(error, 'message_provider_events_identity')) return 'duplicate'
    throw error
  }
}

/**
 * Settle the attempts of workers that never came back.
 *
 * ── WHAT A STALE LEASE IS HERE, AND WHAT IT IS NOT ─────────────────────────
 *
 * The claim is not a lease over a row that expires and hands the work to
 * somebody else. That shape is exactly what must not exist here, because the
 * second worker would send a second copy of a message the first may well have
 * delivered. The claim moves the message to `outcome_unknown`, which no worker
 * can pick up, and that is permanent until evidence arrives.
 *
 * What goes stale is the ATTEMPT row. `in_flight` means a call is in progress,
 * and once the worker's process is gone that is no longer true of anything.
 * This settles those rows as what they actually are — a call this clinic never
 * heard the end of — and touches the MESSAGE not at all.
 *
 * So the attempt stops claiming to be running, the message stays
 * `outcome_unknown`, and nothing is retried. Elapsed time never converts an
 * unknown outcome into a failure, because time passing is not evidence.
 */
export async function recoverStaleAttempts(options: {
  now?: string
  olderThanMinutes?: number
} = {}): Promise<{ recovered: number }> {
  const now = options.now ?? isoNow()
  /*
   * Comfortably longer than the provider timeout, so a call that is merely
   * slow is never declared abandoned while it is still running and about to
   * write its own answer. **Not an owner decision**: an implementation bound.
   */
  const minutes = options.olderThanMinutes ?? 15

  const stale = (await db.prepare(
    `select id from message_attempts
      where outcome = 'in_flight'
        and started_at + make_interval(mins => ?) <= ?::timestamptz
      order by started_at
      limit 200`,
  ).all(minutes, now)) as Row[]

  let recovered = 0
  for (const row of stale) {
    const settled = await transaction(async () =>
      await db.prepare(
        `update message_attempts
            set outcome = 'transport_error', error_category = 'transport_error',
                error_detail = ?, finished_at = ?::timestamptz
          where id = ? and outcome = 'in_flight'`,
      ).run('The worker did not record an answer to this call.', now, text(row.id))
    )
    if (settled) recovered += 1
  }
  return { recovered }
}

/**
 * One turn of the worker: recover, prepare, dispatch.
 *
 * This is what the protected endpoint calls, and it calls the shared domain
 * functions directly rather than making HTTP requests to other Edge Functions.
 * A function that fans out to a function is one more place for a reply to be
 * lost, and a lost reply here is the most expensive kind this application has.
 *
 * Safe to run twice, late, or concurrently with itself. Everything that
 * decides whether a patient is contacted is asked again under a row lock
 * inside `prepareOne` and `claimAttempt`; invoking this function is not itself
 * a decision about anybody.
 */
export async function runDispatchCycle(options: {
  now?: string
  channel?: MessageChannel
  prepareLimit?: number
  dispatchLimit?: number
} = {}): Promise<{
  recovered: number
  prepared: number
  queued: number
  suppressed: number
  reasons: Record<string, number>
  attempted: number
  accepted: number
  failed: number
}> {
  const now = options.now ?? isoNow()
  const channel = options.channel ?? officialWhatsAppChannel

  const { recovered } = await recoverStaleAttempts({ now })
  const prepared = await prepareDueMessages({ now, channel, limit: options.prepareLimit })
  const dispatched = await dispatchQueuedMessages({ now, channel, limit: options.dispatchLimit })

  return {
    recovered,
    prepared: prepared.prepared,
    queued: prepared.queued,
    suppressed: prepared.suppressed,
    reasons: prepared.reasons,
    attempted: dispatched.attempted,
    accepted: dispatched.accepted,
    failed: dispatched.failed,
  }
}

/* ════════════════════════════════════════════════════════════ commands ══ */

/**
 * The messaging half of the command surface.
 *
 * Reached from the end of the chain that starts in `commands.ts` and passes
 * through `appointments.ts`, `inventory.ts`, `counter.ts` and `images.ts`.
 * Anything nobody here recognises still ends as 'Unknown action.', so the
 * contract at that boundary is unchanged.
 *
 * Nine commands, and the brief names three of them — `schedule_reminder`,
 * `cancel_reminder`, `resend_message` — while requiring that any other be
 * justified. The justification for each of the other six is in its own
 * comment, and each traces to a sentence of owner policy rather than to a
 * screen somebody wanted.
 */
export async function runMessagingCommand(
  session: SessionView,
  action: string,
  payload: Payload,
): Promise<{ message: string; data?: Record<string, unknown>; unchanged?: boolean }> {
  switch (action) {
    /* ──────────────────────────────────────────── templates, owner item 81 */

    /*
     * Justified by item 81: wording, purpose, variables and link destination
     * are approved by a doctor, and "an admin may manage metadata and provider
     * submission". Drafting is therefore open to both and approval is not.
     * Without a command to write a version there is no way to have one, and a
     * seeded template would be clinic content nobody approved.
     */
    case 'draft_message_template': {
      requireRole(session, 'admin', 'doctor')
      const purpose = requireChoice(payload, 'purpose', PURPOSES)
      const body = value(payload, 'body')
      const locale = requireChoice(payload, 'locale', ['en'] as const, 'en')
      const providerCategory = requireChoice(
        payload, 'providerCategory', ['utility', 'service'] as const, 'utility',
      )
      const linkDestination = requireChoice(
        payload, 'linkDestination', ['none', 'clinic_public_page'] as const, 'none',
      )
      const seriesId = optional(payload, 'seriesId') || randomUUID()
      const providerTemplateName = optional(payload, 'providerTemplateName')

      const declared = Array.isArray(payload.variables)
        ? (payload.variables as unknown[]).map((entry) => String(entry).trim()).filter(Boolean)
        : []
      for (const name of declared) {
        if (!(ALLOWED_VARIABLES as readonly string[]).includes(name)) {
          throw new CommandRefusal(
            `“${name}” is not a variable a patient message may carry. The permitted ones are ` +
            `${ALLOWED_VARIABLES.join(', ')}.`,
            'TEMPLATE_VARIABLE_NOT_ALLOWED',
          )
        }
      }

      // Both directions. A body interpolating something undeclared would be
      // approved without that value ever having been reviewed; a declared
      // variable the body never uses is a claim about the template that is not
      // true.
      const used = new Set(placeholdersIn(body))
      for (const name of used) {
        if (!declared.includes(name)) {
          throw new CommandRefusal(
            `The wording uses {{${name}}} but does not declare it. Every variable a message ` +
            'interpolates has to be one somebody approved.',
            'TEMPLATE_VARIABLE_NOT_DECLARED',
          )
        }
      }
      for (const name of declared) {
        if (!used.has(name)) {
          throw new CommandRefusal(
            `{{${name}}} is declared but the wording never uses it.`,
            'TEMPLATE_VARIABLE_UNUSED',
          )
        }
      }

      await refuseClinicalDetail(body)

      const fingerprint = templateFingerprint({
        purpose, channel: 'whatsapp', locale, body,
        variables: declared, linkDestination, providerCategory,
      })

      const templateId = randomUUID()
      let version = 1
      await transaction(async () => {
        const previous = (await db.prepare(
          `select id, version, content_fingerprint from message_templates
            where series_id = ? order by version desc limit 1 for update`,
        ).get(seriesId)) as Row | undefined

        if (previous) {
          version = Number(previous.version) + 1
          if (text(previous.content_fingerprint) === fingerprint) {
            throw new CommandRefusal(
              'This is word for word the previous version of this template. A new version records a ' +
              'change; there is nothing here to record.',
              'TEMPLATE_UNCHANGED',
            )
          }
        }

        await db.prepare(
          `insert into message_templates
             (id, series_id, version, purpose, channel, locale, body, variables_json,
              link_destination, provider_category, provider_template_name,
              approval_state, created_by, supersedes_id, content_fingerprint)
           values (?,?,?,?, 'whatsapp', ?,?,?::text, ?,?,?, 'draft', ?,?,?)`,
        ).run(
          templateId, seriesId, version, purpose, locale, body,
          JSON.stringify([...declared].sort()), linkDestination, providerCategory,
          providerTemplateName, session.staffId, previous ? text(previous.id) : null, fingerprint,
        )

        await audit(
          session.staffId, 'message_template.drafted', 'message_template', templateId,
          `Drafted ${purpose} template v${version}`,
        )
      })

      return {
        message: `Draft version ${version} saved. A doctor authorized to approve wording has to approve it.`,
        data: { templateId, seriesId, version, contentFingerprint: fingerprint },
      }
    }

    /*
     * Justified by item 81 directly: approval is a named act by a named
     * person, and "queued messages retain their pinned version" only means
     * something if there is a moment at which a version became approvable.
     */
    case 'approve_message_template': {
      requireAuthorizedDoctor(session, 'approve patient-facing wording')
      const templateId = value(payload, 'templateId')

      let purpose = ''
      await transaction(async () => {
        const template = (await db.prepare(
          `select id, series_id, version, purpose, approval_state from message_templates
            where id = ? for update`,
        ).get(templateId)) as Row | undefined
        if (!template) throw new Error('That template version was not found.')
        if (text(template.approval_state) !== 'draft') {
          throw new CommandRefusal(
            `This version is already ${text(template.approval_state)}.`,
            'TEMPLATE_NOT_A_DRAFT',
          )
        }
        purpose = text(template.purpose)

        // One approved version per series and one approved series per purpose,
        // so the previous one retires as part of the same act rather than
        // being left for somebody to tidy up.
        const live = (await db.prepare(
          `select id from message_templates
            where approval_state = 'approved' and channel = 'whatsapp'
              and (series_id = ? or purpose = ?)
            for update`,
        ).all(text(template.series_id), purpose)) as Row[]
        for (const row of live) {
          await db.prepare(
            `update message_templates
                set approval_state = 'retired', retired_at = now(), retired_by = ?
              where id = ?`,
          ).run(session.staffId, text(row.id))
        }

        await db.prepare(
          `update message_templates
              set approval_state = 'approved', approved_by = ?, approved_at = now()
            where id = ?`,
        ).run(session.staffId, templateId)

        await audit(
          session.staffId, 'message_template.approved', 'message_template', templateId,
          `Approved ${purpose} template v${text(template.version)}`,
        )
      })

      return {
        message: 'Approved. Messages queued from now on pin this exact version.',
        data: { templateId },
      }
    }

    /*
     * Justified by item 81's "plus any provider approval": Meta's verdict is a
     * separate state that an admin manages, and it can change without anybody
     * at the clinic doing anything — a template paused for quality has to be
     * recordable or the suppression that follows has no explanation.
     */
    case 'record_provider_template_state': {
      requireRole(session, 'admin')
      const templateId = value(payload, 'templateId')
      const providerState = requireChoice(payload, 'providerState', [
        'not_submitted', 'submitted', 'approved', 'rejected', 'paused', 'disabled',
      ] as const)
      const providerTemplateName = optional(payload, 'providerTemplateName')

      await transaction(async () => {
        const result = await db.prepare(
          `update message_templates
              set provider_state = ?, provider_state_at = now(), provider_state_by = ?,
                  provider_template_name = case when ? <> '' then ? else provider_template_name end
            where id = ?`,
        ).run(providerState, session.staffId, providerTemplateName, providerTemplateName, templateId)
        if (Number(result.changes) !== 1) throw new Error('That template version was not found.')
        await audit(
          session.staffId, 'message_template.provider_state', 'message_template', templateId,
          `Provider state ${providerState}`,
        )
      })

      return { message: `Recorded as ${providerState} with the provider.`, data: { templateId } }
    }

    /* ──────────────────────────────────── consent, owner items 78 and 82 */

    /*
     * Justified by item 78: consent evidence has to be recordable per channel
     * and per purpose with its wording, source, actor and time, and there is
     * no such record in this application — `patients.whatsapp_consent` is a
     * blanket flag that names nothing. Without this command the new tables
     * stay empty and the automated channel stays permanently suppressed.
     */
    case 'record_communication_consent': {
      // The roles with a Patients workspace, which is the gate
      // `send_patient_whatsapp` already applies to contacting a patient.
      requireRole(session, 'admin', 'doctor', 'nurse')
      const patientId = value(payload, 'patientId')
      const purpose = requireChoice(payload, 'purpose', PURPOSES)
      const source = requireChoice(
        payload, 'source', ['registration', 'staff_recorded'] as const, 'staff_recorded',
      )
      const wording = value(payload, 'wording')
      const note = optional(payload, 'note')

      const consentId = randomUUID()
      await transaction(async () => {
        const patient = (await db.prepare(
          `select id, name from patients where id = ?`,
        ).get(patientId)) as Row | undefined
        if (!patient) throw new Error('Patient was not found.')

        await db.prepare(
          `insert into communication_consents
             (id, patient_id, channel, decision, scope, purpose, clinic_name, wording,
              wording_version, source, actor_id, note)
           values (?,?, 'whatsapp', 'opt_in', 'purpose', ?,?,?,?,?,?,?)`,
        ).run(
          consentId, patientId, purpose, CONSENT_CLINIC_NAME, wording, CONSENT_WORDING_VERSION,
          source, source === 'staff_recorded' ? session.staffId : null, note,
        )

        await audit(
          session.staffId, 'communication_consent.opt_in', 'patient', patientId,
          `Recorded WhatsApp opt-in for ${purpose}`,
        )
      })

      return {
        message: 'Opt-in recorded for that purpose only.',
        data: { consentId, purpose },
      }
    }

    /*
     * Justified by item 82, which is a policy this application cannot satisfy
     * without a command: "Withdrawal suppresses every unsent scheduled/queued
     * message immediately and has no staff override." The suppression is the
     * command's real work; the consent row alone would leave a queue full of
     * messages the patient has asked not to receive.
     */
    case 'withdraw_communication_consent': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const patientId = value(payload, 'patientId')
      const scope = requireChoice(payload, 'scope', ['purpose', 'all_purposes'] as const)
      const purpose = scope === 'purpose'
        ? requireChoice(payload, 'purpose', PURPOSES)
        : null
      const source = requireChoice(
        payload, 'source', ['staff_recorded', 'patient_chat'] as const, 'staff_recorded',
      )
      const wording = value(payload, 'wording')

      let suppressed = 0
      let cancelled = 0
      await transaction(async () => {
        const patient = (await db.prepare(
          `select id from patients where id = ?`,
        ).get(patientId)) as Row | undefined
        if (!patient) throw new Error('Patient was not found.')

        await db.prepare(
          `insert into communication_consents
             (id, patient_id, channel, decision, scope, purpose, clinic_name, wording,
              wording_version, source, actor_id, note)
           values (?,?, 'whatsapp', 'withdraw', ?,?,?,?,?,?,?, '')`,
        ).run(
          randomUUID(), patientId, scope, purpose, CONSENT_CLINIC_NAME, wording,
          CONSENT_WORDING_VERSION, source,
          source === 'staff_recorded' ? session.staffId : null,
        )

        /*
         * The schedules FIRST and the messages second, and always in that
         * order.
         *
         * A preparation that is running right now holds its message row and is
         * about to read consent. Taking the schedules first means this waits
         * for that preparation to finish rather than racing past it, and the
         * message it queued is then visible to the sweep below. The other
         * order leaves a window exactly as long as one prepare transaction, in
         * which a withdrawal returns success and a message goes out anyway.
         */
        const schedules = (await db.prepare(
          `select id from communication_schedules
            where patient_id = ? and channel = 'whatsapp' and status = 'scheduled'
              and (?::text is null or purpose = ?)
            order by id
            for update`,
        ).all(patientId, purpose, purpose)) as Row[]

        for (const row of schedules) {
          await db.prepare(
            `update communication_schedules
                set status = 'cancelled', cancelled_at = now(), cancelled_by = ?,
                    cancelled_reason = 'The patient withdrew consent.'
              where id = ?`,
          ).run(session.staffId, text(row.id))
          cancelled += 1
        }

        const messages = (await db.prepare(
          `select id from message_outbox
            where patient_id = ? and channel = 'whatsapp'
              and status in ('scheduled', 'queued', 'failed_retryable')
              and (?::text is null or purpose = ?)
            order by id
            for update`,
        ).all(patientId, purpose, purpose)) as Row[]

        for (const row of messages) {
          await db.prepare(
            `update message_outbox
                set status = 'suppressed', suppression_reason = 'consent_withdrawn',
                    next_attempt_at = null
              where id = ?`,
          ).run(text(row.id))
          suppressed += 1
        }

        await audit(
          session.staffId, 'communication_consent.withdrawn', 'patient', patientId,
          scope === 'all_purposes'
            ? 'Withdrew every clinic-initiated WhatsApp purpose'
            : `Withdrew WhatsApp consent for ${purpose}`,
        )
      })

      return {
        message: scope === 'all_purposes'
          ? `Withdrawn from every clinic-initiated WhatsApp message. ${suppressed} unsent message(s) stopped.`
          : `Withdrawn for that purpose. ${suppressed} unsent message(s) stopped.`,
        data: { suppressed, cancelled, scope, purpose },
      }
    }

    /* ────────────────────────── schedules, owner items 77, 80 and 83 */

    case 'schedule_reminder': {
      const sourceType = requireChoice(
        payload, 'sourceType', ['appointment_booking', 'follow_up'] as const,
      )
      const sourceId = value(payload, 'sourceId')
      const idempotencyKey = optional(payload, 'idempotencyKey') || undefined

      if (sourceType === 'appointment_booking') {
        /*
         * The same gate `book_appointment` applies, because this schedules the
         * same fact. Booking already does this automatically; the command
         * exists for a booking made before this slice existed, and for a
         * screen that wants to put one back after a cancellation.
         */
        requireRole(session, 'admin', 'doctor', 'nurse')
        let result: { scheduleId: string | null; kind: ScheduleKind | null } = {
          scheduleId: null, kind: null,
        }
        await transaction(async () => {
          const booking = (await db.prepare(
            `select id, status from appointment_bookings where id = ? for update`,
          ).get(sourceId)) as Row | undefined
          if (!booking) throw new Error('That appointment was not found.')
          if (text(booking.status) !== 'booked') {
            throw new CommandRefusal(
              `This appointment is ${text(booking.status)}, so there is nothing to remind anybody about.`,
              'APPOINTMENT_CLOSED',
            )
          }
          result = await syncAppointmentSchedule({ actorId: session.staffId, bookingId: sourceId })
          if (result.scheduleId) {
            await audit(
              session.staffId, 'communication_schedule.created', 'appointment_booking', sourceId,
              `Scheduled the ${result.kind?.replace('appointment_', '')} for this appointment`,
            )
          }
        })

        if (!result.scheduleId) {
          return {
            message: 'Nothing was scheduled: the appointment time has already passed.',
            data: { scheduleId: null },
          }
        }
        return {
          message: result.kind === 'appointment_reminder'
            ? 'The reminder is set for 18:00 the day before.'
            : 'The reminder time has passed, so a confirmation is queued instead.',
          data: { scheduleId: result.scheduleId, scheduleKind: result.kind },
        }
      }

      /*
       * Owner item 83, and it is the whole reason this branch is doctor-only.
       *
       * "Eligibility begins only when a doctor explicitly records
       * recall/follow-up required, a purpose, due date, and responsible doctor
       * for that patient." The follow-up row IS that instruction, and issuing
       * this command is the responsible doctor releasing it — which is why an
       * admin cannot, however reasonable the request, and why a doctor who is
       * not the responsible one needs the owner's explicit authorization.
       */
      requireRole(session, 'doctor')
      let scheduleId: string | null = null
      let dueOn = ''
      await transaction(async () => {
        const followUp = (await db.prepare(
          `select id, patient_id, doctor_id, status, to_char(due_date, 'YYYY-MM-DD') as due_date
             from follow_ups where id = ? for update`,
        ).get(sourceId)) as Row | undefined
        if (!followUp) throw new Error('That follow-up was not found.')
        if (text(followUp.status) !== 'open') {
          throw new CommandRefusal(
            `This follow-up is ${text(followUp.status)}, so the patient is no longer eligible for a recall.`,
            'FOLLOW_UP_CLOSED',
          )
        }
        if (text(followUp.doctor_id) !== session.staffId && !session.canPublishClinicalTemplates) {
          throw new CommandRefusal(
            'This follow-up belongs to another doctor. They release their own recalls, or a doctor the ' +
            'owner has explicitly authorized does.',
            'NOT_AN_AUTHORIZED_DOCTOR',
          )
        }

        dueOn = text(followUp.due_date)
        const timing = await recallTiming(dueOn, isoNow())
        if (!timing.stillUseful) {
          throw new CommandRefusal(
            `This follow-up was due on ${dueOn} and a recall for it can no longer be useful. ` +
            'Record a new follow-up if the patient should still be seen.',
            'RECALL_PAST_USE',
          )
        }

        const opened = await openSchedule({
          actorId: session.staffId,
          patientId: text(followUp.patient_id),
          purpose: 'clinical_recall',
          kind: 'clinical_recall',
          sourceType: 'follow_up',
          sourceId,
          dueAt: timing.dueAt,
          usefulUntil: timing.usefulUntil,
          responsibleDoctorId: text(followUp.doctor_id),
          idempotencyKey,
          requestFingerprint: idempotencyKey
            ? requestFingerprint({ command: action, actor: session.staffId, sourceType, sourceId })
            : undefined,
        })

        if (opened) {
          scheduleId = opened.scheduleId
          await audit(
            session.staffId, 'communication_schedule.created', 'follow_up', sourceId,
            `Released a recall for ${dueOn}`,
          )
        } else {
          const existing = (await db.prepare(
            `select id from communication_schedules
              where source_type = 'follow_up' and source_id = ? and schedule_kind = 'clinical_recall'
                and status = 'scheduled'`,
          ).get(sourceId)) as Row | undefined
          scheduleId = existing ? text(existing.id) : null
        }
      })

      return {
        message: `The recall is set for 09:00 on ${dueOn}.`,
        data: { scheduleId },
      }
    }

    case 'cancel_reminder': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const scheduleId = value(payload, 'scheduleId')
      const reason = value(payload, 'reason')

      let suppressed = 0
      await transaction(async () => {
        const schedule = (await db.prepare(
          `select id, purpose, responsible_doctor_id, status from communication_schedules
            where id = ? for update`,
        ).get(scheduleId)) as Row | undefined
        if (!schedule) throw new Error('That reminder was not found.')
        if (text(schedule.status) !== 'scheduled') {
          throw new CommandRefusal(
            `This reminder is already ${text(schedule.status)}. Nothing was changed.`,
            'SCHEDULE_CLOSED',
          )
        }

        /*
         * A clinical recall is the doctor's instruction, so stopping it is a
         * clinical decision and not an administrative tidy-up. An appointment
         * reminder is administrative and the three roles that book may stop
         * one.
         */
        if (text(schedule.purpose) === 'clinical_recall') {
          requireRole(session, 'doctor')
          if (text(schedule.responsible_doctor_id) !== session.staffId
              && !session.canPublishClinicalTemplates) {
            throw new CommandRefusal(
              'This recall belongs to another doctor.',
              'NOT_AN_AUTHORIZED_DOCTOR',
            )
          }
        }

        await db.prepare(
          `update communication_schedules
              set status = 'cancelled', cancelled_at = now(), cancelled_by = ?, cancelled_reason = ?
            where id = ?`,
        ).run(session.staffId, reason, scheduleId)

        const result = await db.prepare(
          `update message_outbox
              set status = 'cancelled', next_attempt_at = null
            where schedule_id = ? and status in ('scheduled', 'queued', 'failed_retryable')`,
        ).run(scheduleId)
        suppressed = Number(result.changes)

        await audit(
          session.staffId, 'communication_schedule.cancelled', 'communication_schedule', scheduleId,
          `Cancelled: ${reason}`,
        )
      })

      return {
        message: `Cancelled. ${suppressed} unsent message(s) stopped, and the reminder keeps its history.`,
        data: { scheduleId, suppressed },
      }
    }

    /* ─────────────────────────────── the failure queue, owner item 79 */

    case 'resend_message': {
      /*
       * "The admin owns the delivery-failure queue from the first failed
       * attempt", so the admin is who resends. A resend is a NEW message on
       * the same schedule — a second generation — and never a fourth attempt
       * on the old one, because item 79's ceiling is about attempts and this
       * is a person deciding to try again.
       */
      requireRole(session, 'admin')
      const outboxId = value(payload, 'outboxId')
      let created: string | null = null

      await transaction(async () => {
        const previous = (await db.prepare(
          `select o.*, to_char(o.useful_until at time zone 'utc',
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as useful_iso,
                  s.status as schedule_status
             from message_outbox o
             join communication_schedules s on s.id = o.schedule_id
            where o.id = ? for update of o`,
        ).get(outboxId)) as Row | undefined
        if (!previous) throw new Error('That message was not found.')

        const status = text(previous.status)
        if (!['failed_terminal', 'failed_retryable', 'suppressed'].includes(status)) {
          throw new CommandRefusal(
            status === 'outcome_unknown'
              ? 'Nobody knows yet whether the provider took this message. Sending it again could give the ' +
                'patient two. Wait for the provider’s own evidence.'
              : `This message is ${status.replace(/_/g, ' ')}, so there is nothing to resend.`,
            'MESSAGE_NOT_RESENDABLE',
          )
        }
        /*
         * Consent first, and before the schedule's own state.
         *
         * A withdrawal cancels the schedule as well as the message, so both
         * refusals are true at once — and the admin standing at the screen
         * needs to be told the one that is about the patient. "The reason no
         * longer stands" reads like an appointment that moved.
         */
        const consent = await effectiveConsent(
          text(previous.patient_id), text(previous.purpose) as CommunicationPurpose,
        )
        if (consent !== 'opt_in') {
          throw new CommandRefusal(
            'This patient has not opted in to this kind of message, or has withdrawn. There is no override.',
            'NO_CONSENT',
          )
        }
        if (text(previous.schedule_status) !== 'scheduled') {
          throw new CommandRefusal(
            'The reason for this message no longer stands, so it is not resent.',
            'SCHEDULE_CLOSED',
          )
        }
        if (text(previous.useful_iso) <= isoNow()) {
          throw new CommandRefusal(
            'This message stopped being useful. A reminder about something that has already happened is ' +
            'worse than none.',
            'MESSAGE_PAST_USE',
          )
        }

        const generation = Number(previous.generation) + 1
        created = randomUUID()
        await db.prepare(
          `insert into message_outbox
             (id, schedule_id, patient_id, channel, purpose, idempotency_key, generation,
              status, due_at, useful_until, responsible_doctor_id, created_by)
           select ?, schedule_id, patient_id, 'whatsapp', purpose, schedule_id || ':' || ?, ?,
                  'scheduled', now(), useful_until, responsible_doctor_id, ?
             from message_outbox where id = ?`,
        ).run(created, generation, generation, session.staffId, outboxId)

        await db.prepare(
          `update message_outbox
              set resolved_at = now(), resolved_by = ?, resolution = 'resent'
            where id = ? and resolved_at is null`,
        ).run(session.staffId, outboxId)

        await audit(
          session.staffId, 'message.resent', 'message_outbox', outboxId,
          `Queued attempt generation ${generation}`,
        )
      })

      return {
        message: 'Queued again. It will go out inside the clinic’s dispatch hours, if consent still stands.',
        data: { outboxId: created, resentFrom: outboxId },
      }
    }

    /*
     * Justified by item 79's last sentence: "A manual call or other fallback is
     * recorded explicitly and never inferred from a provider response." There
     * is no way to record it without a command, and without it a failure queue
     * either grows forever or gets cleared by somebody editing a row.
     */
    case 'record_manual_fallback': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const outboxId = value(payload, 'outboxId')
      const note = value(payload, 'note')
      const resolution = requireChoice(
        payload, 'resolution', ['manual_fallback', 'no_longer_needed'] as const, 'manual_fallback',
      )

      await transaction(async () => {
        const failure = (await db.prepare(
          `select id, purpose, responsible_doctor_id, status, resolved_at
             from message_outbox where id = ? for update`,
        ).get(outboxId)) as Row | undefined
        if (!failure) throw new Error('That message was not found.')

        /*
         * Resolving a failure takes it off the queue, so whoever may resolve
         * one must be somebody it was shown to. Owner item 79 gives the queue
         * to the admin and shows a recall failure to the responsible doctor;
         * a nurse who could close one would be hiding a patient the doctor
         * asked to see again from the only person who knows why.
         */
        if (text(failure.purpose) === 'clinical_recall' && !hasRole(session, 'admin')) {
          requireRole(session, 'doctor')
          if (text(failure.responsible_doctor_id) !== session.staffId
              && !session.canPublishClinicalTemplates) {
            throw new CommandRefusal(
              'This recall belongs to another doctor. They close their own, or the admin who owns the ' +
              'failure queue does.',
              'NOT_AN_AUTHORIZED_DOCTOR',
            )
          }
        }

        const result = await db.prepare(
          `update message_outbox
              set resolved_at = now(), resolved_by = ?, resolution = ?, resolution_note = ?
            where id = ?
              and resolved_at is null
              and status in ('failed_retryable', 'failed_terminal', 'outcome_unknown', 'suppressed')`,
        ).run(session.staffId, resolution, note, outboxId)
        if (Number(result.changes) !== 1) {
          throw new CommandRefusal(
            'That message is not an open failure, or somebody has already recorded what was done about it.',
            'MESSAGE_NOT_OPEN',
          )
        }
        await audit(
          session.staffId, 'message.fallback_recorded', 'message_outbox', outboxId,
          resolution === 'manual_fallback' ? `Contacted by hand: ${note}` : `Closed: ${note}`,
        )
      })

      return { message: 'Recorded against the message.', data: { outboxId } }
    }

    default:
      throw new Error('Unknown action.')
  }
}

/* ══════════════════════════════════════════════════════════ read models ══ */

/*
 * Declared here beside the queries that build them, the way `workspace.ts`
 * declares its own. They are not in `_shared/types.ts` because that file is the
 * frontend's door to the backend, and Slice 3A deliberately builds no frontend
 * messaging workspace — putting view types there would publish a contract
 * nothing consumes and that a real screen would immediately want to change.
 */

export type DueMessage = {
  outboxId: string
  scheduleId: string
  patientName: string
  purpose: CommunicationPurpose
  scheduleKind: ScheduleKind
  status: string
  generation: number
  dueAt: string
  usefulUntil: string
  dueNow: boolean
  insideDispatchWindow: boolean
}

export type DueMessages = {
  withinHours: number
  dispatchWindow: { fromHour: number; untilHour: number }
  messages: DueMessage[]
}

export type DeliveryFailure = {
  outboxId: string
  patientName: string
  purpose: CommunicationPurpose
  status: string
  suppressionReason: string
  errorCategory: string
  attemptCount: number
  attemptsExhausted: boolean
  escalated: boolean
  ownerEscalationDue: boolean
  responsibleDoctor: string
  firstFailedAt: string
  dueAt: string
}

export type DeliveryFailures = {
  ownedBy: 'admin'
  escalationAfterClinicHours: number
  failures: DeliveryFailure[]
}

export type ConsentView = {
  patientId: string
  patientName: string
  channel: 'whatsapp'
  clinicName: string
  purposes: Array<{
    purpose: CommunicationPurpose
    state: ConsentState
    suppressed: boolean
    reason: string
  }>
  evidence: Array<{
    decision: string
    scope: string
    purpose: string
    source: string
    wordingVersion: string
    actor: string
    note: string
    recordedAt: string
  }>
}

export type DeliveryOutcome = {
  outboxId: string
  patientName: string
  purpose: CommunicationPurpose
  status: string
  generation: number
  dueAt: string
  /** Provider evidence, and nothing else. An accepted attempt is not this. */
  delivered: boolean
  deliveryEvidence: string
  deliveryEvidenceAt: string
  suppressionReason: string
  errorCategory: string
  attemptCount: number
  attemptsAllowed: number
  nextAttemptAt: string
  pinnedTemplate: { seriesId: string; version: number } | null
  resolution: string
  resolutionNote: string
  resolvedBy: string
  attempts: Array<{
    attemptNumber: number
    transport: string
    outcome: string
    providerAcceptStatus: string
    errorCategory: string
    errorDetail: string
    startedAt: string
    finishedAt: string
  }>
}

/**
 * What is due, and what is about to be. Bounded by a horizon rather than
 * returning the whole future, and never in the snapshot — the programme's
 * first rule for every read model since Slice 1 is that nothing joins the
 * fifteen-second poll.
 */
export async function readCommunicationDue(session: SessionView, options: {
  withinHours?: number
} = {}): Promise<DueMessages> {
  const horizon = Math.min(Math.max(options.withinHours ?? 24, 1), 24 * 14)

  const rows = (await db.prepare(
    `select o.id, o.purpose, o.status, o.generation,
            p.name as patient_name,
            s.schedule_kind, s.id as schedule_id,
            to_char(o.due_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as due_local,
            to_char(o.useful_until at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as useful_local,
            (o.due_at <= now()) as due_now,
            ${insideDispatchWindow('o.due_at')} as inside_dispatch_window
       from message_outbox o
       join communication_schedules s on s.id = o.schedule_id
       join patients p on p.id = o.patient_id
      where o.status in ('scheduled', 'queued', 'failed_retryable')
        and o.due_at <= now() + make_interval(hours => ?)
      order by o.due_at
      limit 200`,
  ).all(horizon)) as Row[]

  // A doctor who is not an admin sees their own recalls and the appointments
  // they would otherwise learn about from the queue; the counter has no
  // business here at all and never reaches this read.
  const filtered = hasRole(session, 'admin')
    ? rows
    : rows.filter((row) =>
      text(row.purpose) !== 'clinical_recall' || hasRole(session, 'doctor'))

  return {
    withinHours: horizon,
    dispatchWindow: { fromHour: DISPATCH_WINDOW_START_HOUR, untilHour: DISPATCH_WINDOW_END_HOUR },
    messages: filtered.map((row) => ({
      outboxId: text(row.id),
      scheduleId: text(row.schedule_id),
      patientName: text(row.patient_name),
      purpose: text(row.purpose) as CommunicationPurpose,
      scheduleKind: text(row.schedule_kind) as ScheduleKind,
      status: text(row.status),
      generation: Number(row.generation),
      dueAt: text(row.due_local),
      usefulUntil: text(row.useful_local),
      dueNow: row.due_now === true,
      insideDispatchWindow: row.inside_dispatch_window === true,
    })),
  }
}

/**
 * The delivery-failure queue, owner item 79, with its ownership and its
 * escalations stated rather than implied.
 *
 * Who sees what is the whole of item 79's second and third sentences:
 *
 *   admin    everything, from the first failed attempt — they own it
 *   nurse    appointment-contact failures
 *   doctor   the recalls they are responsible for
 *   owner-doctor  additionally, anything unresolved past four clinic hours
 *
 * "Four clinic hours" is read here as four elapsed hours, moved forward to the
 * next dispatch opening if that lands outside the clinic's hours — so a
 * failure at 19:00 reaches the owner-doctor at 08:00 rather than at 23:00,
 * when nobody is there to act on it. The alternative reading is four hours of
 * wall-clock time regardless; this one is recorded as an interpretation in
 * `docs/SCHEMA_AND_TYPES.md` §15 rather than presented as the owner's words.
 */
export async function readCommunicationFailures(
  session: SessionView,
): Promise<DeliveryFailures> {
  const rows = (await db.prepare(
    `select o.id, o.purpose, o.status, o.error_category, o.attempt_count,
            o.suppression_reason, o.responsible_doctor_id, o.failure_owner_role,
            p.name as patient_name,
            d.name as responsible_doctor_name,
            (o.escalated_at is not null) as escalated,
            (o.attempt_count >= ${MAX_PROVIDER_ATTEMPTS}) as attempts_exhausted,
            to_char(o.first_failed_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as failed_local,
            to_char(o.due_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI') as due_local,
            (o.first_failed_at is not null
             and ${nextDispatchOpening(
               `o.first_failed_at + make_interval(hours => ${FAILURE_ESCALATION_HOURS})`,
             )} <= now()) as owner_escalation_due
       from message_outbox o
       join patients p on p.id = o.patient_id
       left join staff d on d.id = o.responsible_doctor_id
      where o.resolved_at is null
        and o.status in ('failed_retryable', 'failed_terminal', 'outcome_unknown', 'suppressed')
      order by coalesce(o.first_failed_at, o.due_at)
      limit 200`,
  ).all()) as Row[]

  const ownerDoctor = hasRole(session, 'doctor') && session.canPublishClinicalTemplates

  const visible = rows.filter((row) => {
    // "The admin owns the delivery-failure queue from the first failed attempt."
    if (hasRole(session, 'admin')) return true
    // "Any unresolved failure older than four clinic hours escalates to the
    // owner-doctor's queue" — and only then. A doctor authorized to approve
    // wording does not otherwise receive the clinic's appointment failures.
    if (ownerDoctor && row.owner_escalation_due === true) return true
    // "Follow-up or recall failures are also visible to the responsible doctor."
    if (text(row.purpose) === 'clinical_recall') {
      return hasRole(session, 'doctor')
        && (text(row.responsible_doctor_id) === session.staffId || ownerDoctor)
    }
    // "Appointment-contact failures are also visible to nurse/admin." Not to a
    // doctor, who has the queue in front of them and is not the person who
    // telephones somebody who could not be reached.
    return hasRole(session, 'nurse')
  })

  return {
    ownedBy: 'admin',
    escalationAfterClinicHours: FAILURE_ESCALATION_HOURS,
    failures: visible.map((row) => ({
      outboxId: text(row.id),
      patientName: text(row.patient_name),
      purpose: text(row.purpose) as CommunicationPurpose,
      status: text(row.status),
      suppressionReason: text(row.suppression_reason),
      errorCategory: text(row.error_category),
      attemptCount: Number(row.attempt_count),
      attemptsExhausted: row.attempts_exhausted === true,
      escalated: row.escalated === true,
      ownerEscalationDue: row.owner_escalation_due === true,
      responsibleDoctor: text(row.responsible_doctor_name),
      firstFailedAt: text(row.failed_local),
      dueAt: text(row.due_local),
    })),
  }
}

/** What one patient has agreed to, and what is therefore suppressed. */
export async function readCommunicationConsent(
  _session: SessionView,
  patientId: string,
): Promise<ConsentView | null> {
  const patient = (await db.prepare(
    `select id, name from patients where id = ?`,
  ).get(patientId)) as Row | undefined
  if (!patient) return null

  const purposes: ConsentView['purposes'] = []
  for (const purpose of PURPOSES) {
    const state = await effectiveConsent(patientId, purpose)
    purposes.push({
      purpose,
      state,
      suppressed: state !== 'opt_in',
      // The reason a screen should print, and it distinguishes the two ways of
      // not being contactable: nobody has ever asked this patient, or they
      // asked to stop.
      reason: state === 'opt_in'
        ? ''
        : state === 'withdraw'
        ? 'The patient has withdrawn consent for this purpose.'
        : 'No opt-in has been recorded for this purpose.',
    })
  }

  const evidence = (await db.prepare(
    `select decision, scope, purpose, source, wording_version, note,
            to_char(recorded_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as recorded_local,
            s.name as actor_name
       from communication_consents c
       left join staff s on s.id = c.actor_id
      where c.patient_id = ? and c.channel = 'whatsapp'
      order by c.sequence_no desc
      limit 50`,
  ).all(patientId)) as Row[]

  return {
    patientId,
    patientName: text(patient.name),
    channel: 'whatsapp',
    clinicName: CONSENT_CLINIC_NAME,
    purposes,
    evidence: evidence.map((row) => ({
      decision: text(row.decision),
      scope: text(row.scope),
      purpose: text(row.purpose),
      source: text(row.source),
      wordingVersion: text(row.wording_version),
      actor: text(row.actor_name),
      note: text(row.note),
      recordedAt: text(row.recorded_local),
    })),
  }
}

/**
 * What actually happened to one message, with every attempt under it.
 *
 * The `delivered` field is the one a screen should print, and it comes from
 * `delivery_status` rather than from the fact that an attempt was accepted. A
 * message may have three accepted attempts and still not have been delivered
 * to anybody, and saying so is the whole reason this slice exists.
 */
export async function readDeliveryOutcome(
  _session: SessionView,
  outboxId: string,
): Promise<DeliveryOutcome | null> {
  const message = (await db.prepare(
    `select o.id, o.status, o.purpose, o.generation, o.attempt_count, o.error_category,
            o.suppression_reason, o.delivery_status, o.resolution, o.resolution_note,
            p.name as patient_name,
            t.series_id as template_series, t.version as template_version,
            to_char(o.due_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as due_local,
            to_char(o.delivery_status_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as evidence_local,
            to_char(o.next_attempt_at at time zone ${CLINIC_ZONE}, 'DD Mon YYYY HH24:MI') as next_local,
            r.name as resolved_by_name
       from message_outbox o
       join patients p on p.id = o.patient_id
       left join message_templates t on t.id = o.template_id
       left join staff r on r.id = o.resolved_by
      where o.id = ?`,
  ).get(outboxId)) as Row | undefined
  if (!message) return null

  const attempts = (await db.prepare(
    `select attempt_number, transport, outcome, provider_accept_status, error_category,
            error_detail,
            to_char(started_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI:SS') as started_local,
            to_char(finished_at at time zone ${CLINIC_ZONE}, 'DD Mon HH24:MI:SS') as finished_local
       from message_attempts where outbox_id = ? order by attempt_number`,
  ).all(outboxId)) as Row[]

  return {
    outboxId,
    patientName: text(message.patient_name),
    purpose: text(message.purpose) as CommunicationPurpose,
    status: text(message.status),
    generation: Number(message.generation),
    dueAt: text(message.due_local),
    // Delivery is provider evidence and nothing else. An accepted attempt is
    // not one.
    delivered: text(message.delivery_status) === 'delivered',
    deliveryEvidence: text(message.delivery_status),
    deliveryEvidenceAt: text(message.evidence_local),
    suppressionReason: text(message.suppression_reason),
    errorCategory: text(message.error_category),
    attemptCount: Number(message.attempt_count),
    attemptsAllowed: MAX_PROVIDER_ATTEMPTS,
    nextAttemptAt: text(message.next_local),
    pinnedTemplate: message.template_series
      ? { seriesId: text(message.template_series), version: Number(message.template_version) }
      : null,
    resolution: text(message.resolution),
    resolutionNote: text(message.resolution_note),
    resolvedBy: text(message.resolved_by_name),
    attempts: attempts.map((row) => ({
      attemptNumber: Number(row.attempt_number),
      transport: text(row.transport),
      outcome: text(row.outcome),
      providerAcceptStatus: text(row.provider_accept_status),
      errorCategory: text(row.error_category),
      errorDetail: text(row.error_detail),
      startedAt: text(row.started_local),
      finishedAt: text(row.finished_local),
    })),
  }
}
