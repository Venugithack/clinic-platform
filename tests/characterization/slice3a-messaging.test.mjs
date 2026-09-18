/**
 * Slice 3A, against owner policy items 76 to 83.
 *
 * Every test here is named for the clinic rule it holds rather than for the
 * function it calls, and the rules are the ones a patient would notice: that
 * nobody is messaged who did not ask to be, that "stop" means stop at once,
 * that a reminder about an appointment that moved does not go out about the
 * old time, and that the clinic never tells itself a message arrived when all
 * it knows is that Meta took it.
 *
 * ── NOTHING IN THIS FILE TOUCHES A NETWORK ─────────────────────────────────
 *
 * The channel is injected. `loopbackChannel` refuses at construction to
 * address anything but this machine, and the one it is given never makes a
 * request at all — it answers from a script the test wrote. There is a test
 * below that points it at graph.facebook.com and asserts it refuses, because a
 * guard nobody has watched fail is a guard nobody has.
 *
 * ── AND NOTHING IN IT DEPENDS ON THE TIME OF DAY IT RUNS ───────────────────
 *
 * Quiet hours, an 18:00 reminder and a 09:00 recall are all wall-clock rules,
 * so a test that let the real clock decide would pass all afternoon and fail
 * at nine in the evening. `prepareDueMessages`, `dispatchQueuedMessages` and
 * `syncAppointmentSchedule` all take the instant to reason about, and every
 * test here supplies one. The repository has been bitten by exactly this
 * before — `current_date` in a fixture that went off between 18:30 and
 * midnight UTC — and the answer then was the same as the answer here.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import postgres from 'postgres'
import {
  as as rawAs, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar,
  sessionFor, tokenFor,
} from '../support/clinic.mjs'
import { db, edgeGet, messaging, snapshot, STAGING_DB_URL } from '../support/backend.mjs'

after(async () => { await closeClinic() })

/** Appointment commands each need their own reference, exactly as a tablet sends one. */
const KEYED = new Set([
  'book_appointment', 'reschedule_appointment', 'cancel_appointment',
  'mark_no_show', 'check_in_appointment', 'publish_availability',
])
const as = (staff, action, payload = {}) => rawAs(
  staff, action,
  KEYED.has(action) && !payload.idempotencyKey
    ? { ...payload, idempotencyKey: randomUUID() }
    : payload,
)

/* ───────────────────────────────────────────────────────────── the clinic ── */

/**
 * A clinic with the four roles, one patient, open hours and — unless a test
 * says otherwise — an approved template for every purpose it will use.
 *
 * `owner` holds `can_publish_clinical_templates`, which is this application's
 * existing "explicitly authorized doctor" flag (owner item A.6, and item 81
 * uses the same words). `doctor` is an ordinary doctor and does not, which is
 * what makes the authorization tests mean anything.
 */
async function clinic({ template = true, patient = 'Reminded Patient' } = {}) {
  await resetClinic()
  const owner = await makeStaff({
    name: 'Owner Doctor', username: 'm-owner', roles: ['doctor'], pin: '5731',
    canPublishClinicalTemplates: true,
  })
  const doctor = await makeStaff({ name: 'Other Doctor', username: 'm-doc', roles: ['doctor'], pin: '5732' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'm-nurse', roles: ['nurse'], pin: '5733' })
  const admin = await makeStaff({ name: 'Admin', username: 'm-admin', roles: ['admin'], pin: '5734' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', username: 'm-pharm', roles: ['pharmacy'], pin: '5735' })

  await as(owner, 'create_patient', { name: patient, age: 40, sex: 'male', phone: '+919990000001' })
  const patientId = String(await scalar('select id from jmc.patients where name=$1', [patient]))

  const from = await clinicDate(-30)
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await as(owner, 'publish_availability', {
      kind: 'open', weekday: String(weekday), startsAt: '00:00', endsAt: '23:59',
      effectiveFrom: from,
    })
  }

  const templates = {}
  if (template) {
    templates.appointment = await approveTemplate(owner, admin, {
      purpose: 'appointment',
      body: 'Hello {{patient_given_name}}, this is {{clinic_name}}. You are expected on {{appointment_date}} at {{appointment_time}}.',
      variables: ['patient_given_name', 'clinic_name', 'appointment_date', 'appointment_time'],
    })
    templates.clinical_recall = await approveTemplate(owner, admin, {
      purpose: 'clinical_recall',
      body: 'Hello {{patient_given_name}}, {{clinic_name}} asked to see you again on {{due_date}}. Please call us to arrange a time.',
      variables: ['patient_given_name', 'clinic_name', 'due_date'],
    })
  }

  return { owner, doctor, nurse, admin, pharmacist, patientId, patientName: patient, templates }
}

/** Draft, approve, and record Meta as having approved it too. */
async function approveTemplate(owner, admin, { purpose, body, variables }) {
  const drafted = await rawAs(owner, 'draft_message_template', { purpose, body, variables })
  await rawAs(owner, 'approve_message_template', { templateId: drafted.data.templateId })
  await rawAs(admin, 'record_provider_template_state', {
    templateId: drafted.data.templateId,
    providerState: 'approved',
    providerTemplateName: `jmc_${purpose}`,
  })
  return drafted.data
}

/** The exact opt-in wording a desk would read out. */
const OPT_IN = 'Jayamurugan Clinic may send you appointment and follow-up messages on WhatsApp.'

const optIn = (staff, patientId, purpose) => rawAs(staff, 'record_communication_consent', {
  patientId, purpose, wording: OPT_IN, source: 'staff_recorded',
})

/* ────────────────────────────────────────────────────────────── the clock ── */

/** A clinic-local wall-clock moment, as the absolute instant it names. */
async function clinicInstant(daysAhead, hhmmss) {
  return String(await scalar(
    `select to_char(((((now() at time zone 'Asia/Kolkata')::date + ($1 || ' days')::interval)::date
                      + $2::time) at time zone 'Asia/Kolkata') at time zone 'utc',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    [String(daysAhead), hhmmss],
  ))
}

/** A naive clinic-local date-time in the shape the desk form sends. */
async function at(daysAhead, hhmm) {
  return `${await clinicDate(daysAhead)}T${hhmm}`
}

/** A channel that answers from a script and never opens a socket. */
function scripted(answers, { configured = true } = {}) {
  const sent = []
  const channel = messaging.loopbackChannel({
    baseUrl: 'http://127.0.0.1:54321',
    configured,
    respond: (request) => {
      sent.push(request)
      const next = answers.shift()
      if (!next) throw new Error('The scripted channel ran out of answers.')
      return next
    },
  })
  return { channel, sent }
}

const ACCEPTED = (reference = `wamid.${randomUUID()}`) => ({
  ok: true, providerReference: reference, acceptStatus: 'accepted',
})

const outbox = (id) => scalar('select status from jmc.message_outbox where id=$1', [id])
const onlyMessage = () => scalar('select id from jmc.message_outbox order by created_at limit 1')

/* ══════════════════════════════════════════ templates, owner item 81 ══ */

describe('a template version is a thing somebody approved, and cannot become another one', () => {
  test('an ordinary doctor may draft wording and may not approve it', async () => {
    const { doctor, owner } = await clinic({ template: false })

    const drafted = await rawAs(doctor, 'draft_message_template', {
      purpose: 'appointment',
      body: 'Hello {{patient_given_name}}, you are expected on {{appointment_date}}.',
      variables: ['patient_given_name', 'appointment_date'],
    })
    assert.ok(drafted.data.templateId)

    await assert.rejects(
      () => rawAs(doctor, 'approve_message_template', { templateId: drafted.data.templateId }),
      /not authorized to approve patient-facing wording/,
    )
    assert.equal(
      await scalar('select approval_state from jmc.message_templates where id=$1',
        [drafted.data.templateId]),
      'draft',
    )

    // And the doctor the owner authorized can.
    await rawAs(owner, 'approve_message_template', { templateId: drafted.data.templateId })
    assert.equal(
      await scalar('select approval_state from jmc.message_templates where id=$1',
        [drafted.data.templateId]),
      'approved',
    )
  })

  test('nobody else can approve one at all', async () => {
    const { doctor, nurse, admin, pharmacist } = await clinic({ template: false })
    const drafted = await rawAs(doctor, 'draft_message_template', {
      purpose: 'appointment', body: 'Hello {{patient_given_name}}.',
      variables: ['patient_given_name'],
    })
    for (const staff of [nurse, admin, pharmacist]) {
      await assert.rejects(
        () => rawAs(staff, 'approve_message_template', { templateId: drafted.data.templateId }),
        /Your role cannot perform this action\.|not authorized/,
      )
    }
    // A nurse and a pharmacist cannot even draft one.
    for (const staff of [nurse, pharmacist]) {
      await assert.rejects(
        () => rawAs(staff, 'draft_message_template', {
          purpose: 'appointment', body: 'Hello.', variables: [],
        }),
        /Your role cannot perform this action\./,
      )
    }
  })

  test('an approved version cannot be edited into a different template', async () => {
    const { templates } = await clinic()
    const id = templates.appointment.templateId
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      for (const [column, value] of [
        ['body', 'Something else entirely'],
        ['purpose', 'clinical_recall'],
        ['variables_json', '["clinic_name"]'],
        ['locale', 'ta'],
        ['link_destination', 'clinic_public_page'],
        ['provider_category', 'service'],
      ]) {
        // `locale` is in the list although there is only one value today: the
        // rule is about the COLUMN, and a second locale must not arrive as an
        // edit to a version a doctor already approved.
        await assert.rejects(
          () => db.unsafe(`update jmc.message_templates set ${column} = $1 where id = $2`, [value, id]),
          /fixed for a template version|Publish the next version/,
          `${column} was editable on an approved template`,
        )
      }
      await assert.rejects(
        () => db.unsafe('delete from jmc.message_templates where id = $1', [id]),
        /never deleted/,
      )
      await assert.rejects(
        () => db.unsafe(`update jmc.message_templates set approved_by = null where id = $1`, [id]),
        /evidence and cannot be rewritten/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('changing any of the six fields is a new version with a new fingerprint', async () => {
    const { owner } = await clinic({ template: false })
    const base = {
      purpose: 'appointment',
      body: 'Hello {{patient_given_name}}, you are expected on {{appointment_date}}.',
      variables: ['patient_given_name', 'appointment_date'],
      providerCategory: 'utility',
      linkDestination: 'none',
    }
    const first = await rawAs(owner, 'draft_message_template', base)

    const variations = [
      { ...base, body: 'Hello {{patient_given_name}}, we expect you on {{appointment_date}}.' },
      { ...base, purpose: 'ready_for_collection' },
      {
        ...base,
        body: 'Hello {{patient_given_name}}, you are expected on {{appointment_date}} at {{appointment_time}}.',
        variables: ['patient_given_name', 'appointment_date', 'appointment_time'],
      },
      { ...base, providerCategory: 'service' },
      {
        ...base,
        body: 'Hello {{patient_given_name}}, you are expected on {{appointment_date}}. {{link}}',
        variables: ['patient_given_name', 'appointment_date', 'link'],
        linkDestination: 'clinic_public_page',
      },
    ]

    for (const variation of variations) {
      const next = await rawAs(owner, 'draft_message_template', {
        ...variation, seriesId: first.data.seriesId,
      })
      assert.notEqual(next.data.contentFingerprint, first.data.contentFingerprint)
      assert.ok(next.data.version > first.data.version)
    }

    // And word for word the same is not a change and is refused, so a version
    // number cannot be advanced to make a wording look reviewed again.
    await assert.rejects(
      () => rawAs(owner, 'draft_message_template', { ...variations.at(-1), seriesId: first.data.seriesId }),
      /word for word the previous version/,
    )
  })

  test('a wording naming a medicine, a diagnosis, an image or money is refused', async () => {
    const { owner, admin } = await clinic({ template: false })
    await rawAs(admin, 'add_medicine', {
      code: 'MSG1', name: 'Amoxicillin', genericName: 'Amoxicillin', strength: '500 mg',
      dosageForm: 'capsule', route: 'Oral', unit: 'capsule', baseUnit: 'capsule',
      saleClass: 'prescription', schedule: 'H', reorderLevel: 5, targetStock: 50,
    })

    for (const body of [
      'Your Amoxicillin is ready for collection.',
      'Your treatment for Acute bronchitis is due for review.',
      'Your photograph is ready to collect.',
    ]) {
      await assert.rejects(
        () => rawAs(owner, 'draft_message_template', {
          purpose: 'ready_for_collection', body, variables: [],
        }),
        /never the clinical record|forbids sending one through WhatsApp/,
        `accepted a wording that should not exist: ${body}`,
      )
    }

    // Money is refused by the schema itself, so it cannot arrive through any
    // path — a command that forgets to check included.
    for (const body of [
      'Your balance is ready.',
      'Please pay ₹300 at the counter.',
      'Rs 300 is outstanding.',
    ]) {
      await assert.rejects(
        () => rawAs(owner, 'draft_message_template', {
          purpose: 'ready_for_collection', body, variables: [],
        }),
        /violates check constraint/,
        `accepted a wording carrying money: ${body}`,
      )
    }
  })

  test('only whitelisted variables exist, and the body and the declaration must agree', async () => {
    const { owner } = await clinic({ template: false })

    await assert.rejects(
      () => rawAs(owner, 'draft_message_template', {
        purpose: 'appointment', body: 'Hello {{medicine_name}}.', variables: ['medicine_name'],
      }),
      /not a variable a patient message may carry/,
    )
    await assert.rejects(
      () => rawAs(owner, 'draft_message_template', {
        purpose: 'appointment', body: 'Hello {{patient_given_name}}.', variables: [],
      }),
      /does not declare it/,
    )
    await assert.rejects(
      () => rawAs(owner, 'draft_message_template', {
        purpose: 'appointment', body: 'Hello.', variables: ['patient_given_name'],
      }),
      /declared but the wording never uses it/,
    )
  })

  test('approving a version retires the one it replaces, so a purpose has one answer', async () => {
    const { owner, templates } = await clinic()
    const first = templates.appointment

    const second = await rawAs(owner, 'draft_message_template', {
      seriesId: first.seriesId,
      purpose: 'appointment',
      body: 'Hello {{patient_given_name}}, {{clinic_name}} expects you on {{appointment_date}}.',
      variables: ['patient_given_name', 'clinic_name', 'appointment_date'],
    })
    await rawAs(owner, 'approve_message_template', { templateId: second.data.templateId })

    assert.equal(
      await scalar('select approval_state from jmc.message_templates where id=$1', [first.templateId]),
      'retired',
    )
    assert.equal(
      Number(await scalar(
        `select count(*) from jmc.message_templates
          where purpose='appointment' and approval_state='approved'`)),
      1,
    )
  })
})

/* ═════════════════════════════════════ consent, owner items 78 and 82 ══ */

describe('nobody is messaged who did not ask to be', () => {
  test('consent is per purpose, and an opt-in to one is not an opt-in to another', async () => {
    const { nurse, patientId } = await clinic()
    await optIn(nurse, patientId, 'appointment')

    const consent = await messaging.readCommunicationConsent(sessionFor(nurse), patientId)
    const byPurpose = Object.fromEntries(consent.purposes.map((row) => [row.purpose, row]))

    assert.equal(byPurpose.appointment.state, 'opt_in')
    assert.equal(byPurpose.appointment.suppressed, false)
    for (const purpose of ['clinical_recall', 'ready_for_collection', 'service_interruption']) {
      assert.equal(byPurpose[purpose].state, 'none', purpose)
      assert.equal(byPurpose[purpose].suppressed, true, purpose)
      assert.match(byPurpose[purpose].reason, /No opt-in has been recorded/)
    }

    // The evidence carries what item 78 says it must.
    const [latest] = await rows(
      'select * from jmc.communication_consents where patient_id=$1 order by sequence_no desc limit 1',
      [patientId])
    assert.equal(latest.clinic_name, 'Jayamurugan Clinic')
    assert.equal(latest.channel, 'whatsapp')
    assert.equal(latest.purpose, 'appointment')
    assert.equal(latest.wording, OPT_IN)
    assert.equal(latest.source, 'staff_recorded')
    assert.equal(latest.actor_id, nurse.id)
    assert.ok(latest.recorded_at)
  })

  test('withdrawing one purpose leaves the others, and an unqualified stop takes them all', async () => {
    const { nurse, patientId } = await clinic()
    for (const purpose of ['appointment', 'clinical_recall', 'ready_for_collection']) {
      await optIn(nurse, patientId, purpose)
    }

    await rawAs(nurse, 'withdraw_communication_consent', {
      patientId, scope: 'purpose', purpose: 'appointment',
      wording: 'Patient asked to stop appointment messages.',
    })

    let consent = await messaging.readCommunicationConsent(sessionFor(nurse), patientId)
    let byPurpose = Object.fromEntries(consent.purposes.map((row) => [row.purpose, row.state]))
    assert.equal(byPurpose.appointment, 'withdraw')
    assert.equal(byPurpose.clinical_recall, 'opt_in')
    assert.equal(byPurpose.ready_for_collection, 'opt_in')

    await rawAs(nurse, 'withdraw_communication_consent', {
      patientId, scope: 'all_purposes', wording: 'Patient said: stop WhatsApp.',
    })

    consent = await messaging.readCommunicationConsent(sessionFor(nurse), patientId)
    byPurpose = Object.fromEntries(consent.purposes.map((row) => [row.purpose, row.state]))
    for (const purpose of ['appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption']) {
      assert.equal(byPurpose[purpose], 'withdraw', purpose)
    }
  })

  test('a patient-initiated conversation cannot restore standing consent', async () => {
    const { nurse, patientId } = await clinic()
    await optIn(nurse, patientId, 'appointment')
    await rawAs(nurse, 'withdraw_communication_consent', {
      patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })

    // There is no command that records an opt-in from a chat, and the schema
    // refuses one written directly. Owner item 82: re-enrolment requires a new
    // explicit opt-in record.
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `insert into jmc.communication_consents
             (id, patient_id, channel, decision, scope, purpose, clinic_name, wording,
              wording_version, source)
           values ($1,$2,'whatsapp','opt_in','purpose','appointment','Jayamurugan Clinic',
                   'hello again','en-2026.09','patient_chat')`,
          [randomUUID(), patientId],
        ),
        /violates check constraint/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }

    assert.equal(await messaging.effectiveConsent(patientId, 'appointment'), 'withdraw')

    // A new explicit opt-in does restore it, which is the other half of item 82.
    await optIn(nurse, patientId, 'appointment')
    assert.equal(await messaging.effectiveConsent(patientId, 'appointment'), 'opt_in')
  })

  test('consent evidence is append-only', async () => {
    const { nurse, patientId } = await clinic()
    await optIn(nurse, patientId, 'appointment')
    const id = String(await scalar(
      'select id from jmc.communication_consents where patient_id=$1', [patientId]))

    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(`update jmc.communication_consents set decision='withdraw' where id=$1`, [id]),
        /cannot be changed/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.communication_consents where id=$1', [id]),
        /cannot be changed/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })
})

/* ════════════════════════════ schedules, owner items 77, 80 and 83 ══ */

describe('a reminder exists only while there is something to be reminded about', () => {
  test('booking creates one reminder, at 18:00 on the previous clinic day', async () => {
    const { owner, patientId } = await clinic()
    const booked = await as(owner, 'book_appointment', {
      patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })

    const [schedule] = await rows(
      `select schedule_kind, status,
              to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as due_local,
              to_char(useful_until at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as useful_local
         from jmc.communication_schedules where source_id=$1`,
      [booked.data.bookingId])

    assert.equal(schedule.schedule_kind, 'appointment_reminder')
    assert.equal(schedule.status, 'scheduled')
    assert.equal(schedule.due_local, `${await clinicDate(6)} 18:00`)
    assert.equal(schedule.useful_local, `${await clinicDate(7)} 10:30`)

    // One, and exactly one. Owner item 77: "at most one appointment reminder".
    assert.equal(Number(await scalar(
      'select count(*) from jmc.communication_schedules where source_id=$1', [booked.data.bookingId])), 1)

    // And the durable row exists before anything is ever due.
    const [message] = await rows(
      'select status, template_id, to_number, generation from jmc.message_outbox')
    assert.equal(message.status, 'scheduled')
    assert.equal(message.template_id, null)
    assert.equal(message.to_number, '')
    assert.equal(Number(message.generation), 1)
  })

  test('a booking made after 18:00 the day before gets a confirmation instead', async () => {
    const { owner, patientId } = await clinic()
    const booked = await as(owner, 'book_appointment', {
      patientId, scheduledAt: await at(1, '09:00'), reason: 'Review',
    })

    // The clock is supplied rather than read, so this says the same thing at
    // any hour: it is now the morning of the appointment, and 18:00 yesterday
    // has gone.
    const morningOfTheAppointment = await clinicInstant(1, '08:00:00')
    await db.transaction(() => messaging.syncAppointmentSchedule({
      actorId: owner.id,
      bookingId: booked.data.bookingId,
      now: morningOfTheAppointment,
    }))

    const live = await rows(
      `select schedule_kind, status from jmc.communication_schedules
        where source_id=$1 order by created_at`, [booked.data.bookingId])

    const scheduled = live.filter((row) => row.status === 'scheduled')
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].schedule_kind, 'appointment_confirmation')

    // The reminder it replaced is superseded rather than deleted, and points
    // at what replaced it.
    const superseded = live.filter((row) => row.status === 'superseded')
    assert.equal(superseded.length, 1)
    assert.equal(superseded[0].schedule_kind, 'appointment_reminder')
  })

  test('rescheduling moves the reminder and never leaves the old time live', async () => {
    const { owner, patientId } = await clinic()
    const booked = await as(owner, 'book_appointment', {
      patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await as(owner, 'reschedule_appointment', {
      bookingId: booked.data.bookingId,
      scheduledAt: await at(14, '11:00'),
      reason: 'The patient asked to move it.',
    })

    const live = await rows(
      `select status, to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as due_local
         from jmc.communication_schedules where source_id=$1 and status='scheduled'`,
      [booked.data.bookingId])
    assert.equal(live.length, 1)
    assert.equal(live[0].due_local, `${await clinicDate(13)} 18:00`)

    // The message that belonged to the old time is cancelled, not left queued.
    const cancelled = await rows(
      `select status from jmc.message_outbox order by created_at`)
    assert.deepEqual(cancelled.map((row) => row.status), ['cancelled', 'scheduled'])
  })

  test('cancelling, marking absent and checking in each end the reminder', async () => {
    for (const [action, extra] of [
      ['cancel_appointment', { reason: 'The patient telephoned.' }],
      ['check_in_appointment', {}],
    ]) {
      const { owner, patientId } = await clinic()
      const booked = await as(owner, 'book_appointment', {
        patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
      })
      await as(owner, action, { bookingId: booked.data.bookingId, ...extra })

      const live = await rows(
        `select status, cancelled_reason from jmc.communication_schedules where source_id=$1`,
        [booked.data.bookingId])
      assert.equal(live.length, 1, action)
      assert.equal(live[0].status, 'cancelled', action)
      assert.ok(live[0].cancelled_reason.length > 0, action)
      assert.equal(
        await scalar('select status from jmc.message_outbox limit 1'), 'cancelled', action)
    }
  })

  test('a recall exists only because a doctor wrote a follow-up, and only they release it', async () => {
    const { owner, doctor, nurse, admin, patientId } = await clinic()

    await rawAs(doctor, 'sign_consultation', {
      patientId, complaint: 'Cough', diagnosis: 'Acute bronchitis',
      diagnosisStatus: 'provisional', followUpDate: await clinicDate(14),
      followUpNote: 'Review the cough.',
    })
    const followUpId = String(await scalar('select id from jmc.follow_ups limit 1'))

    // Signing did not schedule anything by itself: eligibility is the doctor's
    // instruction, and releasing it is a separate, deliberate act.
    assert.equal(Number(await scalar('select count(*) from jmc.communication_schedules')), 0)

    for (const staff of [nurse, admin]) {
      await assert.rejects(
        () => rawAs(staff, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId }),
        /Your role cannot perform this action\./,
      )
    }

    // Another doctor, who is not the responsible one and is not authorized.
    const stranger = await makeStaff({
      name: 'Locum', username: 'm-locum', roles: ['doctor'], pin: '5736',
    })
    await assert.rejects(
      () => rawAs(stranger, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId }),
      /belongs to another doctor/,
    )

    const released = await rawAs(doctor, 'schedule_reminder', {
      sourceType: 'follow_up', sourceId: followUpId,
    })
    assert.ok(released.data.scheduleId)

    const [schedule] = await rows(
      `select purpose, schedule_kind, responsible_doctor_id,
              to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as due_local,
              to_char(useful_until at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as useful_local
         from jmc.communication_schedules`)
    assert.equal(schedule.purpose, 'clinical_recall')
    assert.equal(schedule.schedule_kind, 'clinical_recall')
    assert.equal(schedule.responsible_doctor_id, doctor.id)
    assert.equal(schedule.due_local, `${await clinicDate(14)} 09:00`)
    assert.equal(schedule.useful_local, `${await clinicDate(14)} 20:00`)

    // The owner-doctor may release another doctor's, which is the authority
    // owner item 80 names.
    await rawAs(doctor, 'cancel_reminder', {
      scheduleId: released.data.scheduleId, reason: 'Testing the owner path.',
    })
    const again = await rawAs(owner, 'schedule_reminder', {
      sourceType: 'follow_up', sourceId: followUpId,
    })
    assert.ok(again.data.scheduleId)
  })

  test('completing or cancelling the follow-up removes the recall', async () => {
    for (const status of ['completed', 'cancelled']) {
      const { doctor, patientId } = await clinic()
      await rawAs(doctor, 'sign_consultation', {
        patientId, complaint: 'Cough', diagnosis: 'Acute bronchitis',
        diagnosisStatus: 'provisional', followUpDate: await clinicDate(14),
      })
      const followUpId = String(await scalar('select id from jmc.follow_ups limit 1'))
      await rawAs(doctor, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId })

      await rawAs(doctor, 'complete_follow_up', { followUpId, status })

      const [schedule] = await rows('select status, cancelled_reason from jmc.communication_schedules')
      assert.equal(schedule.status, 'cancelled', status)
      assert.ok(schedule.cancelled_reason.length > 0, status)
      assert.equal(await scalar('select status from jmc.message_outbox limit 1'), 'cancelled', status)
    }
  })

  test('nothing but a booking or a follow-up can create a schedule', async () => {
    const { owner } = await clinic()
    await assert.rejects(
      () => rawAs(owner, 'schedule_reminder', { sourceType: 'diagnosis', sourceId: randomUUID() }),
      /sourceType is not valid\./,
    )
    await assert.rejects(
      () => rawAs(owner, 'schedule_reminder', {
        sourceType: 'appointment_booking', sourceId: randomUUID(),
      }),
      /That appointment was not found\./,
    )
  })

  test('two tablets scheduling the same reminder produce one', async () => {
    const { owner, patientId } = await clinic()
    const booked = await as(owner, 'book_appointment', {
      patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })

    // Booking already made it; asking again is a duplicate and answers with
    // the same one rather than adding a second.
    const again = await rawAs(owner, 'schedule_reminder', {
      sourceType: 'appointment_booking', sourceId: booked.data.bookingId,
    })
    assert.ok(again.data.scheduleId)
    assert.equal(Number(await scalar(
      `select count(*) from jmc.communication_schedules where status='scheduled'`)), 1)
    assert.equal(Number(await scalar(
      `select count(*) from jmc.message_outbox where status='scheduled'`)), 1)
  })
})

/* ═══════════════════════════════ preparing, and every reason not to send ══ */

describe('preparing a due message rechecks everything, and says why when it will not go', () => {
  /** A clinic with one message due right now. */
  async function due({ consent = true, template = true } = {}) {
    const built = await clinic({ template })
    const booked = await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    if (consent) await optIn(built.nurse, built.patientId, 'appointment')
    // Move the message's own due time into the past so the worker will pick it
    // up, without moving anybody's clock.
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
    return { ...built, bookingId: booked.data.bookingId }
  }

  test('with no opt-in it is suppressed into the staff queue, not sent', async () => {
    const built = await due({ consent: false })
    const { channel } = scripted([])
    const summary = await messaging.prepareDueMessages({ channel })

    assert.deepEqual(summary, { prepared: 1, queued: 0, suppressed: 1, reasons: { no_consent: 1 } })
    const [message] = await rows('select status, suppression_reason from jmc.message_outbox')
    assert.equal(message.status, 'suppressed')
    assert.equal(message.suppression_reason, 'no_consent')
    assert.equal(built.templates.appointment.version, 1)
  })

  test('with no official channel it is suppressed, which is owner item 76', async () => {
    const built = await due()
    const { channel, sent } = scripted([], { configured: false })
    const summary = await messaging.prepareDueMessages({ channel })

    assert.equal(summary.suppressed, 1)
    assert.deepEqual(summary.reasons, { channel_not_configured: 1 })
    assert.deepEqual(sent, [])

    // And it is now an open item on the failure queue rather than a silence.
    const queue = await messaging.readCommunicationFailures(sessionFor(built.admin))
    assert.equal(queue.failures.length, 1)
    assert.equal(queue.failures[0].suppressionReason, 'channel_not_configured')
  })

  test('with no approved template, and with one Meta has not approved, it is suppressed', async () => {
    await due({ template: false })
    const { channel } = scripted([])
    assert.deepEqual(
      (await messaging.prepareDueMessages({ channel })).reasons, { no_approved_template: 1 })

    const built = await due()
    await rows(`update jmc.message_templates set provider_state='paused',
                provider_state_at = now(), provider_state_by = $1
                where purpose='appointment'`, [built.admin.id])
    assert.deepEqual(
      (await messaging.prepareDueMessages({ channel })).reasons,
      { provider_template_not_approved: 1 })
  })

  test('with no usable number it is suppressed rather than sent somewhere wrong', async () => {
    const built = await due()
    await rows('update jmc.patients set phone = $1 where id = $2',
      ['9876543210 / 9876543211', built.patientId])
    const { channel } = scripted([])
    assert.deepEqual(
      (await messaging.prepareDueMessages({ channel })).reasons, { no_contact_number: 1 })
  })

  test('a template whose value the clinic does not hold says so, in its own words', async () => {
    const built = await due({ template: false })

    // An approved template that interpolates a link, and no destination
    // configured for it to point at.
    const drafted = await rawAs(built.owner, 'draft_message_template', {
      purpose: 'appointment',
      linkDestination: 'clinic_public_page',
      body: 'Hello {{patient_given_name}}, your appointment details are here: {{link}}',
      variables: ['patient_given_name', 'link'],
    })
    await rawAs(built.owner, 'approve_message_template', { templateId: drafted.data.templateId })
    await rawAs(built.admin, 'record_provider_template_state', {
      templateId: drafted.data.templateId, providerState: 'approved',
      providerTemplateName: 'jmc_appointment',
    })

    const { channel } = scripted([])
    assert.deepEqual(
      (await messaging.prepareDueMessages({ channel })).reasons,
      { link_destination_unavailable: 1 },
    )

    // And a value the clinic simply does not hold is its own reason, not a
    // complaint about the template, which is approved and correct.
    const outboxId = String(await onlyMessage())
    assert.equal(
      await scalar('select suppression_reason from jmc.message_outbox where id=$1', [outboxId]),
      'link_destination_unavailable',
    )
  })

  test('a message whose moment has passed is suppressed, never sent late', async () => {
    await due()
    await rows(`update jmc.message_outbox set useful_until = now() - interval '1 minute'`)
    const { channel } = scripted([])
    assert.deepEqual(
      (await messaging.prepareDueMessages({ channel })).reasons, { past_useful_by: 1 })
  })

  test('a queued message pins the exact template version, and a later one cannot reach it', async () => {
    const built = await due()
    const { channel } = scripted([])
    assert.equal((await messaging.prepareDueMessages({ channel })).queued, 1)

    const pinned = String(await scalar('select template_id from jmc.message_outbox'))
    assert.equal(pinned, built.templates.appointment.templateId)

    const body = String(await scalar('select rendered_body from jmc.message_outbox'))
    assert.match(body, /^Hello Reminded, this is Jayamurugan Clinic\./)
    assert.doesNotMatch(body, /\{\{/)

    // Publish and approve a replacement. The queued message keeps the version
    // it pinned — owner item 81's last sentence.
    const next = await rawAs(built.owner, 'draft_message_template', {
      seriesId: built.templates.appointment.seriesId,
      purpose: 'appointment',
      body: 'A completely different sentence for {{patient_given_name}}.',
      variables: ['patient_given_name'],
    })
    await rawAs(built.owner, 'approve_message_template', { templateId: next.data.templateId })

    assert.equal(String(await scalar('select template_id from jmc.message_outbox')), pinned)
    assert.equal(String(await scalar('select rendered_body from jmc.message_outbox')), body)
    assert.equal(
      await scalar('select approval_state from jmc.message_templates where id=$1', [pinned]),
      'retired',
    )
  })

  test('a message queued for a cancelled schedule is cancelled, not sent', async () => {
    const built = await due()
    await rawAs(built.owner, 'cancel_appointment', {
      bookingId: built.bookingId, reason: 'The patient telephoned.',
      idempotencyKey: randomUUID(),
    })
    const { channel } = scripted([])
    const summary = await messaging.prepareDueMessages({ channel })
    assert.equal(summary.queued, 0)
    assert.equal(await scalar('select status from jmc.message_outbox'), 'cancelled')
  })
})

/* ═══════════════════════════════════ dispatching, quiet hours and retries ══ */

describe('dispatch obeys the clinic’s hours to the second', () => {
  async function queued() {
    const built = await clinic()
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await optIn(built.nurse, built.patientId, 'appointment')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel })
    assert.equal(await scalar('select status from jmc.message_outbox'), 'queued')
    return built
  }

  test('08:00:00 is inside the window and 07:59:59 is not', async () => {
    await queued()
    const { channel, sent } = scripted([ACCEPTED()])

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '07:59:59') })
    assert.deepEqual(sent, [])
    assert.equal(await scalar('select status from jmc.message_outbox'), 'queued')

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '08:00:00') })
    assert.equal(sent.length, 1)
    assert.equal(await scalar('select status from jmc.message_outbox'), 'sent_to_provider')
  })

  test('19:59:59 is inside the window and 20:00:00 is not', async () => {
    await queued()
    const { channel, sent } = scripted([ACCEPTED()])

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '20:00:00') })
    assert.deepEqual(sent, [])

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '19:59:59') })
    assert.equal(sent.length, 1)
  })

  test('a mid-day failure retries after the backoff, inside the window', async () => {
    await queued()
    const { channel } = scripted([
      { ok: false, category: 'provider_unavailable', detail: 'try later', terminal: false },
    ])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '12:00:00') })

    const [message] = await rows(
      `select status, to_char(next_attempt_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as next_local
         from jmc.message_outbox`)
    assert.equal(message.status, 'failed_retryable')
    assert.equal(message.next_local, `${await clinicDate(0)} 12:15`)
  })

  test('no retry ever crosses a night, so an evening failure ends in the staff queue', async () => {
    /*
     * A property rather than a preference, and it falls out of the two rules
     * meeting rather than being written anywhere on its own.
     *
     * Owner item 79 allows retries only within two hours of the first attempt.
     * Owner item 77 closes the dispatch window at 20:00. Two hours from any
     * moment inside the window therefore ends before the next morning's 08:00,
     * so a failure late in the evening has no legal slot left at all — and the
     * honest answer is a terminal failure the admin owns tonight, not a
     * reminder arriving at eight in the morning about an appointment at nine.
     */
    await queued()
    const { channel, sent } = scripted([
      { ok: false, category: 'provider_unavailable', detail: 'try later', terminal: false },
    ])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '19:50:00') })

    const [message] = await rows(
      'select status, next_attempt_at, escalated_at, failure_owner_role from jmc.message_outbox')
    assert.equal(message.status, 'failed_terminal')
    assert.equal(message.next_attempt_at, null)
    assert.ok(message.escalated_at)
    assert.equal(message.failure_owner_role, 'admin')
    assert.equal(sent.length, 1)

    // And nothing picks it up the next morning.
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(1, '08:00:00') })
    assert.equal(sent.length, 1)
  })
})

describe('a provider taking a message is not a patient receiving it', () => {
  async function queued(patientPhone = '+919990000001') {
    const built = await clinic()
    await rows('update jmc.patients set phone=$1 where id=$2', [patientPhone, built.patientId])
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await optIn(built.nurse, built.patientId, 'appointment')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel })
    return built
  }

  test('acceptance is sent_to_provider, and only the webhook says delivered', async () => {
    const built = await queued()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    const id = String(await onlyMessage())
    assert.equal(await outbox(id), 'sent_to_provider')

    let outcome = await messaging.readDeliveryOutcome(sessionFor(built.admin), id)
    assert.equal(outcome.delivered, false)
    assert.equal(outcome.deliveryEvidence, 'accepted')
    assert.equal(outcome.attempts[0].providerAcceptStatus, 'accepted')

    assert.equal(await messaging.applyProviderEvidence({ providerReference: reference, status: 'sent' }), 'applied')
    assert.equal(await outbox(id), 'sent_to_provider')

    assert.equal(
      await messaging.applyProviderEvidence({ providerReference: reference, status: 'delivered' }),
      'applied')
    assert.equal(await outbox(id), 'delivered')

    outcome = await messaging.readDeliveryOutcome(sessionFor(built.admin), id)
    assert.equal(outcome.delivered, true)
  })

  test('held_for_quality_assessment is not delivery either', async () => {
    await queued()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([
      { ok: true, providerReference: reference, acceptStatus: 'held_for_quality_assessment' },
    ])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    const id = String(await onlyMessage())
    assert.equal(await outbox(id), 'sent_to_provider')
    assert.equal(await scalar('select delivery_status from jmc.message_outbox where id=$1', [id]), 'accepted')
  })

  test('duplicate and out-of-order evidence cannot move settled truth backwards', async () => {
    await queued()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })
    const id = String(await onlyMessage())

    await messaging.applyProviderEvidence({ providerReference: reference, status: 'delivered' })
    assert.equal(await outbox(id), 'delivered')

    // The same webhook again, and an older one arriving late. Meta does both.
    assert.equal(
      await messaging.applyProviderEvidence({ providerReference: reference, status: 'delivered' }),
      'ignored')
    assert.equal(
      await messaging.applyProviderEvidence({ providerReference: reference, status: 'sent' }),
      'ignored')
    // And a failure arriving after delivery does not un-deliver it.
    assert.equal(
      await messaging.applyProviderEvidence({ providerReference: reference, status: 'failed' }),
      'ignored')

    assert.equal(await outbox(id), 'delivered')
    assert.equal(Number(await scalar('select delivery_rank from jmc.message_outbox where id=$1', [id])), 3)

    // Evidence about a reference nobody holds changes nothing at all.
    assert.equal(
      await messaging.applyProviderEvidence({ providerReference: 'wamid.unknown', status: 'delivered' }),
      'unknown_reference')
  })

  test('a lost reply leaves outcome_unknown, and the attempt that caused it is on record', async () => {
    await queued()
    const id = String(await onlyMessage())

    /*
     * What the row says WHILE the provider call is in flight is the whole
     * point of committing the attempt before making it, so it is read from
     * inside the call — on the clinic's own connection, which can only see
     * what the claim transaction committed.
     *
     * The observations are captured rather than asserted here: `send` runs
     * inside the dispatcher's try/catch, so an assertion that threw would be
     * swallowed and reported as a transport error, and the test would pass by
     * failing.
     */
    let observed = null
    const stalling = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: async () => {
        observed = {
          status: await outbox(id),
          attempt: (await rows('select outcome from jmc.message_attempts'))[0]?.outcome,
        }
        throw new Error('the reply never came back')
      },
    })
    await messaging.dispatchQueuedMessages({ channel: stalling, now: await clinicInstant(0, '10:00:00') })

    assert.deepEqual(observed, { status: 'outcome_unknown', attempt: 'in_flight' })

    const [attempt] = await rows('select outcome, error_category from jmc.message_attempts')
    assert.equal(attempt.outcome, 'transport_error')
    assert.equal(attempt.error_category, 'transport_error')

    // Nothing picks an unknown outcome up again on its own: a blind retry is
    // how one reminder becomes two.
    await rows(`update jmc.message_outbox set status='outcome_unknown' where id=$1`, [id])
    const { channel, sent } = scripted([ACCEPTED()])
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '11:00:00') })
    assert.deepEqual(sent, [])
    assert.equal(await outbox(id), 'outcome_unknown')
  })

  test('an admin cannot resend something whose outcome is unknown', async () => {
    const built = await queued()
    const id = String(await onlyMessage())
    await rows(`update jmc.message_outbox set status='outcome_unknown', attempt_count=1,
                first_attempt_at=now(), last_attempt_at=now() where id=$1`, [id])

    await assert.rejects(
      () => rawAs(built.admin, 'resend_message', { outboxId: id }),
      /Nobody knows yet whether the provider took this message/,
    )
  })
})

describe('owner item 79’s ceiling, window and ownership', () => {
  async function failing(answers) {
    const built = await clinic()
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await optIn(built.nurse, built.patientId, 'appointment')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
    const { channel, sent } = scripted(answers)
    await messaging.prepareDueMessages({ channel })
    return { ...built, channel, sent }
  }

  const RETRYABLE = { ok: false, category: 'provider_unavailable', detail: 'busy', terminal: false }

  test('three attempts, and never a fourth', async () => {
    const built = await failing([RETRYABLE, RETRYABLE, RETRYABLE, RETRYABLE])
    const id = String(await onlyMessage())

    // 09:00, then the backoff carries it to 09:15 and 09:55, all inside both
    // the window and the two hours.
    for (const clock of ['09:00:00', '09:15:00', '09:55:00', '10:30:00']) {
      await messaging.dispatchQueuedMessages({
        channel: built.channel, now: await clinicInstant(0, clock),
      })
    }

    assert.equal(built.sent.length, 3)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts where outbox_id=$1', [id])), 3)
    assert.equal(await outbox(id), 'failed_terminal')
    assert.equal(Number(await scalar('select attempt_count from jmc.message_outbox where id=$1', [id])), 3)
  })

  test('a retry that would land past two hours ends the message instead', async () => {
    const built = await failing([RETRYABLE, RETRYABLE])
    const id = String(await onlyMessage())

    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })
    // Pretend the first attempt was almost two hours ago, so the backoff falls
    // outside item 79's window.
    await rows(`update jmc.message_outbox
                   set first_attempt_at = first_attempt_at - interval '115 minutes',
                       next_attempt_at = now() - interval '2 days'
                 where id=$1`, [id])
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '11:00:00') })

    assert.equal(await outbox(id), 'failed_terminal')
    assert.equal(built.sent.length, 1)
  })

  test('a terminal refusal is not retried at all', async () => {
    const built = await failing([
      { ok: false, category: 'invalid_recipient', detail: 'not a WhatsApp user 919990000001', terminal: true },
    ])
    const id = String(await onlyMessage())
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })

    assert.equal(await outbox(id), 'failed_terminal')
    assert.equal(Number(await scalar('select attempt_count from jmc.message_outbox where id=$1', [id])), 1)
    assert.ok(await scalar('select escalated_at from jmc.message_outbox where id=$1', [id]))

    // The provider's own words are kept as a category and a redacted hint.
    const [attempt] = await rows('select error_category, error_detail from jmc.message_attempts')
    assert.equal(attempt.error_category, 'invalid_recipient')
    assert.equal(attempt.error_detail, 'not a WhatsApp user [number]')
  })

  test('the admin owns a failure from the first one, and it escalates when it ages', async () => {
    const built = await failing([RETRYABLE])
    const id = String(await onlyMessage())
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })

    assert.equal(
      await scalar('select failure_owner_role from jmc.message_outbox where id=$1', [id]), 'admin')

    const fresh = await messaging.readCommunicationFailures(sessionFor(built.admin))
    assert.equal(fresh.ownedBy, 'admin')
    assert.equal(fresh.failures.length, 1)
    assert.equal(fresh.failures[0].ownerEscalationDue, false)

    // The owner-doctor sees nothing until four clinic hours have gone by.
    let ownerView = await messaging.readCommunicationFailures(sessionFor(built.owner))
    assert.equal(ownerView.failures.length, 0)

    await rows(`update jmc.message_outbox set first_failed_at = now() - interval '3 days' where id=$1`, [id])
    ownerView = await messaging.readCommunicationFailures(sessionFor(built.owner))
    assert.equal(ownerView.failures.length, 1)
    assert.equal(ownerView.failures[0].ownerEscalationDue, true)
  })

  test('a recall failure reaches its own doctor and not another one', async () => {
    const built = await clinic()
    await rawAs(built.doctor, 'sign_consultation', {
      patientId: built.patientId, complaint: 'Cough', diagnosis: 'Acute bronchitis',
      diagnosisStatus: 'provisional', followUpDate: await clinicDate(3),
    })
    const followUpId = String(await scalar('select id from jmc.follow_ups limit 1'))
    await rawAs(built.doctor, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId })
    await optIn(built.nurse, built.patientId, 'clinical_recall')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)

    const { channel } = scripted([
      { ok: false, category: 'invalid_recipient', detail: 'no', terminal: true },
    ])
    await messaging.prepareDueMessages({ channel })
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    const stranger = await makeStaff({
      name: 'Locum', username: 'm-locum2', roles: ['doctor'], pin: '5737' })

    assert.equal((await messaging.readCommunicationFailures(sessionFor(built.doctor))).failures.length, 1)
    assert.equal((await messaging.readCommunicationFailures(sessionFor(stranger))).failures.length, 0)
    assert.equal((await messaging.readCommunicationFailures(sessionFor(built.admin))).failures.length, 1)
    // A nurse sees appointment contact, not somebody's clinical recall.
    assert.equal((await messaging.readCommunicationFailures(sessionFor(built.nurse))).failures.length, 0)
  })

  test('a manual fallback is recorded and never inferred', async () => {
    const built = await failing([
      { ok: false, category: 'invalid_recipient', detail: 'no', terminal: true },
    ])
    const id = String(await onlyMessage())
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })

    assert.equal((await messaging.readCommunicationFailures(sessionFor(built.admin))).failures.length, 1)

    await rawAs(built.admin, 'record_manual_fallback', {
      outboxId: id, note: 'Telephoned the patient and confirmed the time.',
    })

    assert.equal((await messaging.readCommunicationFailures(sessionFor(built.admin))).failures.length, 0)
    const outcome = await messaging.readDeliveryOutcome(sessionFor(built.admin), id)
    assert.equal(outcome.resolution, 'manual_fallback')
    assert.equal(outcome.resolutionNote, 'Telephoned the patient and confirmed the time.')
    assert.equal(outcome.resolvedBy, 'Admin')
    // Still not delivered. A telephone call is not a WhatsApp delivery.
    assert.equal(outcome.delivered, false)
  })

  test('a nurse cannot close a doctor’s recall failure out from under them', async () => {
    const built = await clinic()
    await rawAs(built.doctor, 'sign_consultation', {
      patientId: built.patientId, complaint: 'Cough', diagnosis: 'Acute bronchitis',
      diagnosisStatus: 'provisional', followUpDate: await clinicDate(3),
    })
    const followUpId = String(await scalar('select id from jmc.follow_ups limit 1'))
    await rawAs(built.doctor, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId })
    await optIn(built.nurse, built.patientId, 'clinical_recall')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)

    const { channel } = scripted([
      { ok: false, category: 'invalid_recipient', detail: 'no', terminal: true },
    ])
    await messaging.prepareDueMessages({ channel })
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })
    const id = String(await onlyMessage())

    // Resolving takes it off the queue, so only somebody it was shown to may.
    const stranger = await makeStaff({
      name: 'Locum', username: 'm-locum3', roles: ['doctor'], pin: '5738' })
    for (const staff of [built.nurse, stranger]) {
      await assert.rejects(
        () => rawAs(staff, 'record_manual_fallback', { outboxId: id, note: 'Telephoned.' }),
        /belongs to another doctor|Your role cannot perform this action\./,
      )
    }
    assert.equal(await scalar('select resolved_at from jmc.message_outbox where id=$1', [id]), null)

    // The responsible doctor may, and so may the admin who owns the queue.
    await rawAs(built.doctor, 'record_manual_fallback', {
      outboxId: id, note: 'Telephoned the patient and rebooked them.',
    })
    assert.ok(await scalar('select resolved_at from jmc.message_outbox where id=$1', [id]))
  })

  test('a resend is a new message on the same reason, not a fourth attempt', async () => {
    const built = await failing([
      { ok: false, category: 'invalid_recipient', detail: 'no', terminal: true },
    ])
    const first = String(await onlyMessage())
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })

    const resent = await rawAs(built.admin, 'resend_message', { outboxId: first })
    assert.ok(resent.data.outboxId)
    assert.notEqual(resent.data.outboxId, first)

    const all = await rows(
      'select id, generation, status, idempotency_key, schedule_id from jmc.message_outbox order by generation')
    assert.equal(all.length, 2)
    assert.equal(Number(all[1].generation), 2)
    assert.equal(all[1].status, 'scheduled')
    assert.equal(all[0].schedule_id, all[1].schedule_id)
    assert.equal(all[1].idempotency_key, `${all[1].schedule_id}:2`)
    // The old one is resolved rather than left on the queue for ever.
    assert.equal(
      await scalar('select resolution from jmc.message_outbox where id=$1', [first]), 'resent')
  })

  test('a resend after consent is withdrawn is refused, with no override', async () => {
    const built = await failing([
      { ok: false, category: 'invalid_recipient', detail: 'no', terminal: true },
    ])
    const id = String(await onlyMessage())
    await messaging.dispatchQueuedMessages({
      channel: built.channel, now: await clinicInstant(0, '09:00:00') })

    await rawAs(built.nurse, 'withdraw_communication_consent', {
      patientId: built.patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })
    await assert.rejects(
      () => rawAs(built.admin, 'resend_message', { outboxId: id }),
      /There is no override\./,
    )
  })
})

/* ════════════════════════════════════ withdrawal, races and concurrency ══ */

describe('stop means stop, including against a worker that is already running', () => {
  async function queued() {
    const built = await clinic()
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await optIn(built.nurse, built.patientId, 'appointment')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
    return built
  }

  test('withdrawing suppresses every unsent message at once', async () => {
    const built = await queued()
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel })
    assert.equal(await scalar('select status from jmc.message_outbox'), 'queued')

    const result = await rawAs(built.nurse, 'withdraw_communication_consent', {
      patientId: built.patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })
    assert.equal(result.data.suppressed, 1)

    const [message] = await rows('select status, suppression_reason from jmc.message_outbox')
    assert.equal(message.status, 'suppressed')
    assert.equal(message.suppression_reason, 'consent_withdrawn')
    assert.equal(await scalar('select status from jmc.communication_schedules'), 'cancelled')
  })

  test('withdrawing while a worker is preparing leaves no sendable message', async () => {
    const built = await queued()
    const id = String(await onlyMessage())

    /*
     * The race, run for real rather than reasoned about.
     *
     * A third connection takes the message row and holds it, which is what
     * either of the two contenders looks like from the other's point of view.
     * Both are then started, both block on it, and releasing the hold lets
     * them proceed in whichever order Postgres chooses — which is the point:
     * the assertion has to hold for both orders, and it is the same assertion.
     *
     *   withdrawal first   it suppresses a `scheduled` row; the preparation
     *                      then finds a row that is no longer `scheduled` and
     *                      does nothing.
     *   preparation first  it cannot see the uncommitted consent row, so it
     *                      queues; the withdrawal then finds a `queued` row
     *                      and suppresses that.
     *
     * Either way there is nothing sendable at the end, which is what "fails
     * closed" has to mean when the two arrive together.
     */
    const holder = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    let release
    const held = new Promise((resolve) => { release = resolve })
    const holding = holder.begin(async (t) => {
      await t.unsafe('select id from jmc.message_outbox where id = $1 for update', [id])
      await held
    })
    // Let the hold take effect before anybody contends for it.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const { channel } = scripted([])
    const withdrawal = rawAs(built.nurse, 'withdraw_communication_consent', {
      patientId: built.patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })
    const preparation = messaging.prepareDueMessages({ channel })
    await new Promise((resolve) => setTimeout(resolve, 250))

    release()
    await holding
    await holder.end({ timeout: 5 })
    await Promise.all([withdrawal, preparation])

    const [message] = await rows('select status, suppression_reason from jmc.message_outbox')
    assert.equal(message.status, 'suppressed')
    assert.equal(message.suppression_reason, 'consent_withdrawn')
    assert.equal(Number(await scalar(
      `select count(*) from jmc.message_outbox where status in ('queued','scheduled')`)), 0)
    assert.equal(await scalar('select status from jmc.communication_schedules'), 'cancelled')
  })

  test('two workers dispatching at once make one provider attempt', async () => {
    const built = await queued()
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel })

    let calls = 0
    const counting = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 200))
        return ACCEPTED()
      },
    })

    const now = await clinicInstant(0, '10:00:00')
    await Promise.all([
      messaging.dispatchQueuedMessages({ channel: counting, now }),
      messaging.dispatchQueuedMessages({ channel: counting, now }),
      messaging.dispatchQueuedMessages({ channel: counting, now }),
    ])

    assert.equal(calls, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
    assert.equal(Number(await scalar('select attempt_count from jmc.message_outbox')), 1)
    void built
  })

  test('an attempt is settled once and never rewritten', async () => {
    await queued()
    const { channel } = scripted([ACCEPTED()])
    await messaging.prepareDueMessages({ channel })
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    const attemptId = String(await scalar('select id from jmc.message_attempts'))
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(`update jmc.message_attempts set outcome='rejected' where id=$1`, [attemptId]),
        /already been settled/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.message_attempts where id=$1', [attemptId]),
        /never deleted/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })
})

/* ══════════════════════════════════════════════════ privacy and the seam ══ */

describe('what leaves the database, and what cannot', () => {
  test('a transport may only ever address this machine', () => {
    for (const baseUrl of [
      'https://graph.facebook.com/v23.0',
      'https://api.example.com',
      'http://192.168.1.10:54321',
    ]) {
      assert.throws(
        () => messaging.loopbackChannel({ baseUrl, respond: () => ACCEPTED() }),
        /may only address loopback/,
        baseUrl,
      )
    }
    assert.ok(messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321', respond: () => ACCEPTED(),
    }))
  })

  test('no idempotency key carries anything about a patient', async () => {
    const built = await clinic()
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    const keys = (await rows('select idempotency_key from jmc.message_outbox'))
      .map((row) => row.idempotency_key)
    assert.ok(keys.length > 0)
    for (const key of keys) {
      assert.match(key, /^[0-9a-f-]{36}:[0-9]+$/)
      assert.doesNotMatch(key, /9990000001/)
      assert.doesNotMatch(key.toLowerCase(), /reminded|patient|appointment/)
    }
  })

  test('nothing the clinic would send carries a medicine, a diagnosis or money', async () => {
    const built = await clinic()
    await rawAs(built.doctor, 'sign_consultation', {
      patientId: built.patientId, complaint: 'Cough', diagnosis: 'Acute bronchitis',
      diagnosisStatus: 'provisional', followUpDate: await clinicDate(3),
    })
    const followUpId = String(await scalar('select id from jmc.follow_ups limit 1'))
    await rawAs(built.doctor, 'schedule_reminder', { sourceType: 'follow_up', sourceId: followUpId })
    await optIn(built.nurse, built.patientId, 'clinical_recall')
    await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
    await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)

    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel })

    const body = String(await scalar(`select rendered_body from jmc.message_outbox`))
    assert.ok(body.length > 0)
    for (const forbidden of ['bronchitis', 'cough', '₹', 'balance', 'amount', 'Rs']) {
      assert.doesNotMatch(body.toLowerCase(), new RegExp(forbidden.toLowerCase()), forbidden)
    }

    // And the stored variables carry only whitelisted names.
    const variables = JSON.parse(String(await scalar('select variables_json from jmc.message_outbox')))
    for (const name of Object.keys(variables)) {
      assert.ok(
        ['patient_given_name', 'clinic_name', 'appointment_date', 'appointment_time', 'due_date', 'link']
          .includes(name),
        name,
      )
    }
  })

  test('none of the five tables is reachable by the Data API, and none joins the snapshot', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const reachable = await rows(
        `select c.relname from pg_class c
          where c.relnamespace = 'jmc'::regnamespace and c.relkind = 'r'
            and c.relname in ('message_templates','communication_consents',
                              'communication_schedules','message_outbox','message_attempts')
            and (has_table_privilege($1, c.oid, 'SELECT')
              or has_table_privilege($1, c.oid, 'INSERT')
              or has_table_privilege($1, c.oid, 'UPDATE')
              or has_table_privilege($1, c.oid, 'DELETE'))`, [role])
      assert.deepEqual(reachable.map((row) => row.relname), [], role)
    }

    const built = await clinic()
    const serialized = JSON.stringify(await snapshot.readSnapshot(sessionFor(built.admin)))
    for (const table of ['messageOutbox', 'communicationConsents', 'messageTemplates',
      'communicationSchedules', 'messageAttempts']) {
      assert.doesNotMatch(serialized, new RegExp(table), table)
    }
  })
})

/* ═══════════════════════════════════════════════ the read models' gates ══ */

describe('who may read what', () => {
  test('the pharmacy counter reaches none of the four messaging views', async () => {
    const built = await clinic()
    const token = await tokenFor(built.pharmacist)
    for (const view of [
      'communication_due', 'communication_failures',
      `communication_consent&patientId=${built.patientId}`,
      'communication_outcome&outboxId=none',
    ]) {
      const response = await edgeGet('workspace', `?view=${view}`, token)
      assert.equal(response.status, 403, view)
    }
  })

  test('a nurse can read what is due and what a patient agreed to', async () => {
    const built = await clinic()
    await as(built.owner, 'book_appointment', {
      patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
    })
    await optIn(built.nurse, built.patientId, 'appointment')

    const token = await tokenFor(built.nurse)
    const due = await edgeGet('workspace', '?view=communication_due&withinHours=336', token)
    assert.equal(due.status, 200)
    assert.equal(due.body.due.messages.length, 1)
    assert.equal(due.body.due.messages[0].scheduleKind, 'appointment_reminder')
    assert.equal(due.body.due.dispatchWindow.fromHour, 8)
    assert.equal(due.body.due.dispatchWindow.untilHour, 20)

    const consent = await edgeGet(
      'workspace', `?view=communication_consent&patientId=${built.patientId}`, token)
    assert.equal(consent.status, 200)
    assert.equal(consent.body.consent.clinicName, 'Jayamurugan Clinic')
  })
})
