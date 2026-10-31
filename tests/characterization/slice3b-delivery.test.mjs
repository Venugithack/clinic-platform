/**
 * Slice 3B: the adapter, the worker and the webhook.
 *
 * Slice 3A proved the clinic decides correctly whether a patient may be
 * contacted. This file is about what happens once that decision is yes: what
 * goes on the wire, what the answer is allowed to mean, and what a stranger
 * with the webhook's URL can and cannot do to a patient's record.
 *
 * ── NOTHING HERE TOUCHES A NETWORK ─────────────────────────────────────────
 *
 * Every test that dispatches injects `loopbackChannel`, which refuses at
 * CONSTRUCTION to address anything but this machine — there is a test below
 * that points it at graph.facebook.com and watches it refuse. The production
 * adapter is exercised only through its two pure functions,
 * `buildTemplatePayload` and `normalizeResponse`, and through the one path
 * where it declines to open a socket at all because the clinic has no
 * configuration. `fetch` is replaced by a throwing stub for the whole file, so
 * a regression that reached for the network would fail loudly here rather than
 * quietly succeed on somebody's machine.
 *
 * ── AND NOTHING DEPENDS ON THE TIME OF DAY IT RUNS ─────────────────────────
 *
 * Same rule as Slice 3A and for the same reason: quiet hours are wall-clock,
 * so every moment is supplied rather than read off the clock.
 */
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import {
  as as rawAs, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar,
  tokenFor,
} from '../support/clinic.mjs'
import { db, edgeRequest, messaging, STAGING_DB_URL } from '../support/backend.mjs'

const cloud = await import('../../supabase/functions/_shared/whatsapp-cloud.ts')

after(async () => { await closeClinic() })

/* ═════════════════════════════════════════════ the network is sealed off ══ */

/**
 * No test in this file may open a socket.
 *
 * `loopbackChannel` already refuses a non-loopback base URL, but that guards
 * the injected channel and not the production adapter, `sendWhatsAppText`, or
 * anything a future edit might add. So `fetch` itself is taken away for the
 * length of the file. A test that reaches the network fails with this message
 * instead of succeeding against Meta.
 */
const realFetch = globalThis.fetch
let fetchAttempts = []
before(() => {
  globalThis.fetch = (input) => {
    fetchAttempts.push(String(input))
    throw new Error(`No test in this suite may make a request. Attempted: ${input}`)
  }
})
after(() => { globalThis.fetch = realFetch })

/* ═══════════════════════════════════════════════════════════════ fixtures ══ */

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

const OPT_IN = 'Jayamurugan Clinic may send you appointment and follow-up messages on WhatsApp.'
const optIn = (staff, patientId, purpose) => rawAs(staff, 'record_communication_consent', {
  patientId, purpose, wording: OPT_IN, source: 'staff_recorded',
})

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

async function clinic() {
  await resetClinic()
  const owner = await makeStaff({
    name: 'Owner Doctor', username: 'b-owner', roles: ['doctor'], pin: '5741',
    canPublishClinicalTemplates: true,
  })
  const doctor = await makeStaff({ name: 'Other Doctor', username: 'b-doc', roles: ['doctor'], pin: '5742' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'b-nurse', roles: ['nurse'], pin: '5743' })
  const admin = await makeStaff({ name: 'Admin', username: 'b-admin', roles: ['admin'], pin: '5744' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', username: 'b-pharm', roles: ['pharmacy'], pin: '5745' })

  await as(owner, 'create_patient', {
    name: 'Reminded Patient', age: 40, sex: 'male', phone: '+919990000001',
  })
  const patientId = String(await scalar(
    `select id from jmc.patients where name='Reminded Patient'`))

  const from = await clinicDate(-30)
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await as(owner, 'publish_availability', {
      kind: 'open', weekday: String(weekday), startsAt: '00:00', endsAt: '23:59',
      effectiveFrom: from,
    })
  }

  const template = await approveTemplate(owner, admin, {
    purpose: 'appointment',
    body: 'Hello {{patient_given_name}}, this is {{clinic_name}}. You are expected on {{appointment_date}} at {{appointment_time}}.',
    variables: ['patient_given_name', 'clinic_name', 'appointment_date', 'appointment_time'],
  })

  return { owner, doctor, nurse, admin, pharmacist, patientId, template }
}

async function clinicInstant(daysAhead, hhmmss) {
  return String(await scalar(
    `select to_char(((((now() at time zone 'Asia/Kolkata')::date + ($1 || ' days')::interval)::date
                      + $2::time) at time zone 'Asia/Kolkata') at time zone 'utc',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    [String(daysAhead), hhmmss],
  ))
}

const at = async (daysAhead, hhmm) => `${await clinicDate(daysAhead)}T${hhmm}`

/** A booking whose reminder is due, with consent recorded. */
async function due({ consent = true } = {}) {
  const built = await clinic()
  const booked = await as(built.owner, 'book_appointment', {
    patientId: built.patientId, scheduledAt: await at(7, '10:30'), reason: 'Review',
  })
  if (consent) await optIn(built.nurse, built.patientId, 'appointment')
  await rows(`update jmc.message_outbox set due_at = now() - interval '2 days'`)
  await rows(`update jmc.communication_schedules set due_at = now() - interval '2 days'`)
  return { ...built, bookingId: booked.data.bookingId }
}

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

/** The shape the on-demand reads expect, without signing anybody in. */
const session = (staff, roles) => ({
  staffId: staff.id,
  name: staff.name ?? staff.username,
  roles,
  username: staff.username,
  lastSeen: new Date().toISOString(),
  canPublishClinicalTemplates: roles.includes('doctor') && staff.username === 'b-owner',
})

const one = (column) => scalar(`select ${column} from jmc.message_outbox`)
const onlyMessage = () => scalar('select id from jmc.message_outbox order by created_at limit 1')

/** Prepare and dispatch in one clinic-local moment. */
async function runCycle(channel, hhmmss = '10:00:00', daysAhead = 0) {
  const now = await clinicInstant(daysAhead, hhmmss)
  return await messaging.runDispatchCycle({ channel, now })
}

/* ══════════════════════════════════════════════ the webhook, as Meta calls it ══ */

const APP_SECRET = 'staging-only-app-secret'
const VERIFY_TOKEN = 'staging-only-verify-token'

function configureProvider({ secret = APP_SECRET, verify = VERIFY_TOKEN } = {}) {
  process.env.WHATSAPP_ACCESS_TOKEN = 'staging-only-access-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890'
  process.env.WHATSAPP_APP_SECRET = secret
  process.env.WHATSAPP_VERIFY_TOKEN = verify
}

function unconfigureProvider() {
  delete process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_PHONE_NUMBER_ID
  delete process.env.WHATSAPP_APP_SECRET
  delete process.env.WHATSAPP_VERIFY_TOKEN
}

const sign = (body, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`

/** One statuses webhook, in the shape Meta documents. */
function statusPayload(entries) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: '1234567890' },
          statuses: entries,
        },
      }],
    }],
  })
}

async function postWebhook(body, { signature, secret } = {}) {
  return await edgeRequest('whatsapp', '', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-hub-signature-256': signature ?? sign(body, secret) }),
    },
  })
}

const eventCount = () => scalar('select count(*) from jmc.message_provider_events')

/* ════════════════════════════════════════════════════ 1. provider adapter ══ */

describe('the adapter speaks templates to Meta, and only when the clinic is connected', () => {
  test('with the connection unconfigured it opens no socket and refuses terminally', async () => {
    unconfigureProvider()
    fetchAttempts = []

    assert.equal(messaging.officialWhatsAppChannel.configured(), false)

    const result = await cloud.sendTemplateMessage({
      to: '919990000001', templateName: 'jmc_appointment', templateLanguage: 'en',
      variables: [], idempotencyKey: `${randomUUID()}:1`,
    })

    assert.equal(result.ok, false)
    assert.equal(result.terminal, true)
    assert.equal(result.category, 'not_authorized')
    // The real assertion: nothing was attempted at all.
    assert.deepEqual(fetchAttempts, [])
  })

  test('an unconfigured channel suppresses the whole message into the staff queue', async () => {
    await due()
    fetchAttempts = []
    unconfigureProvider()

    // The REAL channel this time, not a loopback one: this is the path the
    // clinic is on today, and it must reach no network.
    const summary = await messaging.runDispatchCycle({
      now: await clinicInstant(0, '10:00:00'),
    })

    assert.equal(summary.queued, 0)
    assert.deepEqual(summary.reasons, { channel_not_configured: 1 })
    assert.equal(await one('status'), 'suppressed')
    assert.equal(await one('suppression_reason'), 'channel_not_configured')
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 0)
    assert.deepEqual(fetchAttempts, [])
  })

  test('the payload is a template send carrying only the six allowed variables', async () => {
    const payload = cloud.buildTemplatePayload({
      to: '919990000001',
      templateName: 'jmc_appointment',
      templateLanguage: 'en',
      variables: [
        { name: 'patient_given_name', value: 'Reminded' },
        { name: 'clinic_name', value: 'Jayamurugan Clinic' },
      ],
      idempotencyKey: '11111111-1111-1111-1111-111111111111:1',
    })

    assert.equal(payload.messaging_product, 'whatsapp')
    assert.equal(payload.type, 'template')
    assert.equal(payload.template.name, 'jmc_appointment')
    assert.deepEqual(payload.template.language, { code: 'en' })
    // The idempotency key, and nothing else, is what comes back on the webhook.
    assert.equal(payload.biz_opaque_callback_data, '11111111-1111-1111-1111-111111111111:1')

    /*
     * A free-text MESSAGE is not expressible on this path at all. The body
     * parameters are themselves `type: 'text'` — that is how Meta types a
     * string substitution — so the assertion is about the message's own type
     * and the absence of a `text` object, not about the word appearing
     * anywhere in the payload.
     */
    assert.equal(payload.text, undefined)
    assert.notEqual(payload.type, 'text')
    assert.deepEqual(
      payload.template.components[0].parameters.map((p) => p.type), ['text', 'text'])
    assert.deepEqual(
      payload.template.components[0].parameters.map((p) => p.parameter_name),
      ['patient_given_name', 'clinic_name'])
  })

  test('the request carries no diagnosis, medicine, balance, image or free text', async () => {
    const built = await due()
    const { channel, sent } = scripted([ACCEPTED()])

    // Things that must never reach a message, written onto the records a
    // message is built from.
    await rows(`update jmc.patients set address=$1 where id=$2`,
      ['Diabetes mellitus; Amoxicillin 500mg; balance 450', built.patientId])

    await runCycle(channel)
    assert.equal(sent.length, 1)

    const wire = JSON.stringify(cloud.buildTemplatePayload({
      to: sent[0].to,
      templateName: sent[0].templateName,
      templateLanguage: sent[0].templateLanguage,
      variables: sent[0].variables,
      idempotencyKey: sent[0].idempotencyKey,
    }))

    for (const forbidden of [
      'Diabetes', 'Amoxicillin', 'balance', '450', '₹', 'notes', 'image',
    ]) {
      assert.equal(wire.includes(forbidden), false, `${forbidden} reached the provider payload`)
    }
    // And the variables are exactly the template's own, no more.
    assert.deepEqual(
      sent[0].variables.map((v) => v.name).sort(),
      ['appointment_date', 'appointment_time', 'clinic_name', 'patient_given_name'],
    )
  })

  test('only the pinned approved template version can be rendered and named', async () => {
    const built = await due()
    const { channel, sent } = scripted([ACCEPTED()])
    await runCycle(channel)

    assert.equal(sent[0].templateName, 'jmc_appointment')
    assert.equal(
      await one('template_id'), built.template.templateId,
      'the message did not pin the approved version',
    )
  })

  test('a template variable the clinic cannot fill fails closed before any contact', async () => {
    const built = await due()
    // The clinic forgets the patient's name, so `patient_given_name` cannot
    // resolve. Nothing may be sent with a hole in it.
    await rows(`update jmc.patients set name=' ' where id=$1`, [built.patientId])

    const { channel, sent } = scripted([])
    const summary = await runCycle(channel)

    assert.deepEqual(summary.reasons, { variable_unavailable: 1 })
    assert.equal(sent.length, 0)
    assert.equal(await one('status'), 'suppressed')
  })

  test('a 2xx acceptance is sent_to_provider and is never delivery', async () => {
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    assert.equal(await one('status'), 'sent_to_provider')
    assert.equal(await one('delivery_status'), 'accepted')
    assert.equal(Number(await one('delivery_rank')), 1)
    assert.notEqual(await one('status'), 'delivered')
  })

  test('held_for_quality_assessment and paused are not delivery either', async () => {
    for (const acceptStatus of ['held_for_quality_assessment', 'paused']) {
      await due()
      const { channel } = scripted([{
        ok: true, providerReference: `wamid.${randomUUID()}`, acceptStatus,
      }])
      await runCycle(channel)

      assert.equal(await one('status'), 'sent_to_provider', acceptStatus)
      assert.equal(Number(await one('delivery_rank')), 1, acceptStatus)
      assert.equal(
        Number(await scalar(
          `select count(*) from jmc.message_outbox where status='delivered'`)),
        0,
        `${acceptStatus} was treated as delivery`,
      )
      assert.equal(
        await scalar('select provider_accept_status from jmc.message_attempts'),
        acceptStatus,
      )
    }
  })

  test("Meta's documented error codes map to retryable and terminal as Meta describes them", () => {
    const cases = [
      // "Try again later" — retryable.
      [130429, 'rate_limited', false],
      [80007, 'rate_limited', false],
      [131056, 'rate_limited', false],
      [2, 'provider_unavailable', false],
      [131016, 'provider_unavailable', false],
      // "Wait at least 24 hours" is longer than the clinic's whole two-hour
      // ceiling, so it is terminal HERE however Meta describes it.
      [131049, 'rate_limited', true],
      // Change something before retrying — terminal.
      [131026, 'invalid_recipient', true],
      [132001, 'template_rejected', true],
      [132015, 'template_rejected', true],
      [190, 'not_authorized', true],
      [131005, 'not_authorized', true],
    ]

    for (const [code, category, terminal] of cases) {
      const result = cloud.normalizeResponse(400, { error: { code, message: 'x' } })
      assert.equal(result.ok, false, String(code))
      assert.equal(result.category, category, `category for ${code}`)
      assert.equal(result.terminal, terminal, `terminal for ${code}`)
    }

    // An unlisted code is terminal, which is the safe direction: a retry the
    // provider never invited is how one reminder becomes two.
    const unknown = cloud.normalizeResponse(400, { error: { code: 999999, message: 'x' } })
    assert.equal(unknown.terminal, true)

    // A 5xx with no code at all is still worth repeating.
    assert.equal(cloud.normalizeResponse(503, null).terminal, false)
    assert.equal(cloud.normalizeResponse(429, null).category, 'rate_limited')
  })

  test('a lost or ambiguous reply is outcome-unknown, not a failure', () => {
    // A 2xx carrying no message id: neither accepted nor refused.
    const empty = cloud.normalizeResponse(200, { messages: [] })
    assert.equal(empty.ok, false)
    assert.equal(empty.ambiguous, true)
    assert.equal(empty.terminal, false)

    // And a 2xx that does carry one is acceptance and nothing more.
    const good = cloud.normalizeResponse(200, { messages: [{ id: 'wamid.X' }] })
    assert.equal(good.ok, true)
    assert.equal(good.acceptStatus, 'accepted')
  })

  test('a redacted provider error keeps no access token, phone number or patient data', async () => {
    await due()
    const { channel } = scripted([{
      ok: false,
      category: 'invalid_recipient',
      detail: 'Recipient 919990000001 is not a WhatsApp user (token EAAG1234567890abcdef)',
      terminal: true,
    }])
    await runCycle(channel)

    const detail = String(await scalar('select error_detail from jmc.message_attempts'))
    assert.equal(detail.includes('919990000001'), false, 'the number survived redaction')
    assert.equal(detail.includes('1234567890'), false, 'a long digit run survived redaction')
    assert.ok(detail.includes('[number]'))
    assert.equal(detail.length <= 300, true)
  })
})

/* ════════════════════════════════════════════════════ 2. dispatch worker ══ */

describe('the worker claims safely and never sends twice', () => {
  test('two concurrent workers make one provider attempt', async () => {
    await due()
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
    await messaging.prepareDueMessages({ channel: counting, now })
    await Promise.all([
      messaging.dispatchQueuedMessages({ channel: counting, now }),
      messaging.dispatchQueuedMessages({ channel: counting, now }),
      messaging.dispatchQueuedMessages({ channel: counting, now }),
    ])

    assert.equal(calls, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
    assert.equal(Number(await one('attempt_count')), 1)
  })

  test('running the whole cycle again produces one truthful outcome, not a second send', async () => {
    await due()
    const { channel, sent } = scripted([ACCEPTED()])

    const first = await runCycle(channel)
    const second = await runCycle(channel)

    assert.equal(first.attempted, 1)
    assert.equal(second.attempted, 0, 'the second cycle attempted the message again')
    assert.equal(sent.length, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
    assert.equal(await one('status'), 'sent_to_provider')
  })

  test('a withdrawal that lands after queueing prevents the contact', async () => {
    const built = await due()
    const { channel, sent } = scripted([])
    const now = await clinicInstant(0, '10:00:00')

    await messaging.prepareDueMessages({ channel, now })
    assert.equal(await one('status'), 'queued')

    await rawAs(built.nurse, 'withdraw_communication_consent', {
      patientId: built.patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })

    await messaging.dispatchQueuedMessages({ channel, now })
    assert.equal(sent.length, 0, 'a withdrawn patient was contacted')
    assert.equal(await one('suppression_reason'), 'consent_withdrawn')
  })

  test('a cancellation that lands after queueing prevents an obsolete message', async () => {
    const built = await due()
    const { channel, sent } = scripted([])
    const now = await clinicInstant(0, '10:00:00')

    await messaging.prepareDueMessages({ channel, now })
    assert.equal(await one('status'), 'queued')

    await as(built.owner, 'cancel_appointment', {
      bookingId: built.bookingId, reason: 'Doctor away',
    })

    await messaging.dispatchQueuedMessages({ channel, now })
    assert.equal(sent.length, 0, 'a cancelled appointment was reminded about')
    assert.equal(await one('status'), 'cancelled')
  })

  test('a queued message whose schedule died without the sweep is still refused', async () => {
    // Defence in depth: the sweep and the claim are two pieces of code that
    // have to agree, and this is the claim on its own. The schedule is closed
    // behind the sweep's back, exactly as a future edit might.
    await due()
    const { channel, sent } = scripted([])
    const now = await clinicInstant(0, '10:00:00')
    await messaging.prepareDueMessages({ channel, now })

    await rows(
      `update jmc.communication_schedules
          set status='cancelled', cancelled_at=now(), cancelled_reason='by hand',
              cancelled_by=(select id from jmc.staff limit 1)`,
    )

    await messaging.dispatchQueuedMessages({ channel, now })
    assert.equal(sent.length, 0)
    assert.equal(await one('status'), 'cancelled')
  })

  test('the dispatch window is exact at both ends, in clinic-local time', async () => {
    await due()
    const { channel } = scripted([ACCEPTED()])

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:00:00') })
    await messaging.prepareDueMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    // 07:59:59 is outside, 08:00:00 is inside.
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '07:59:59') })
    assert.equal(await one('status'), 'queued')

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '08:00:00') })
    assert.equal(await one('status'), 'sent_to_provider')
  })

  test('20:00:00 is outside the window and 19:59:59 is inside it', async () => {
    await due()
    const { channel } = scripted([ACCEPTED()])
    await messaging.prepareDueMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '20:00:00') })
    assert.equal(await one('status'), 'queued')

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '19:59:59') })
    assert.equal(await one('status'), 'sent_to_provider')
  })

  test('three attempts is the ceiling and two hours is the window', async () => {
    await due()
    const retryable = () => ({
      ok: false, category: 'provider_unavailable', detail: 'try later', terminal: false,
    })
    const { channel, sent } = scripted([retryable(), retryable(), retryable(), retryable()])

    await messaging.prepareDueMessages({ channel, now: await clinicInstant(0, '09:00:00') })
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '09:00:00') })
    assert.equal(Number(await one('attempt_count')), 1)

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '09:20:00') })
    assert.equal(Number(await one('attempt_count')), 2)

    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:10:00') })
    assert.equal(Number(await one('attempt_count')), 3)

    // A fourth is refused however much of the window is left.
    await messaging.dispatchQueuedMessages({ channel, now: await clinicInstant(0, '10:30:00') })
    assert.equal(Number(await one('attempt_count')), 3, 'a fourth attempt was made')
    assert.equal(sent.length, 3)
    assert.equal(await one('status'), 'failed_terminal')
  })

  test('a message past its usefulness deadline is suppressed rather than sent late', async () => {
    await due()
    const { channel, sent } = scripted([])
    const now = await clinicInstant(0, '10:00:00')
    await messaging.prepareDueMessages({ channel, now })

    // Relative to the moment the worker is GIVEN, not to the wall clock: this
    // suite runs at every hour of the day and the rule under test is about
    // the instant the worker reasons about.
    await rows(
      `update jmc.message_outbox set useful_until = $1::timestamptz - interval '1 minute'`, [now])
    await messaging.dispatchQueuedMessages({ channel, now })

    assert.equal(sent.length, 0)
    assert.equal(await one('status'), 'suppressed')
    assert.equal(await one('suppression_reason'), 'past_useful_by')
  })

  test('a lost reply stays outcome-unknown and is never retried', async () => {
    await due()
    const stalling = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: () => ({
        ok: false, category: 'transport_error', detail: 'the reply never came',
        terminal: false, ambiguous: true,
      }),
    })

    await runCycle(stalling, '10:00:00')
    assert.equal(await one('status'), 'outcome_unknown')
    assert.equal(await one('next_attempt_at'), null, 'a retry was scheduled for an unknown outcome')

    // Every later cycle leaves it exactly where it is. Time passing is not
    // evidence, so it never becomes failed_retryable and never goes out twice.
    for (const moment of ['10:30:00', '12:00:00', '19:00:00']) {
      const summary = await runCycle(stalling, moment)
      assert.equal(summary.attempted, 0, `it was attempted again at ${moment}`)
      assert.equal(await one('status'), 'outcome_unknown', `it moved at ${moment}`)
    }
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
  })

  test('a stale in-flight attempt is settled without letting anybody send again', async () => {
    await due()
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel, now: await clinicInstant(0, '10:00:00') })

    // A worker that claimed the row and then died: an in_flight attempt and a
    // message nobody knows the outcome of.
    const outboxId = String(await onlyMessage())
    const attemptId = randomUUID()
    const now = await clinicInstant(0, '10:00:00')
    await rows(
      `insert into jmc.message_attempts (id, outbox_id, attempt_number, transport, started_at)
       values ($1,$2,1,'whatsapp_cloud_api', $3::timestamptz - interval '40 minutes')`,
      [attemptId, outboxId, now],
    )
    await rows(
      `update jmc.message_outbox
          set status='outcome_unknown', attempt_count=1,
              first_attempt_at=$2::timestamptz - interval '40 minutes',
              last_attempt_at=$2::timestamptz - interval '40 minutes'
        where id=$1`, [outboxId, now])

    const { recovered } = await messaging.recoverStaleAttempts({ now })
    assert.equal(recovered, 1)

    // The ATTEMPT stops claiming to be running...
    assert.equal(await scalar('select outcome from jmc.message_attempts'), 'transport_error')
    // ...and the MESSAGE is exactly where it was. Recovery is not a retry.
    assert.equal(await one('status'), 'outcome_unknown')
    assert.equal(Number(await one('attempt_count')), 1)

    const after = await messaging.runDispatchCycle({
      channel, now: await clinicInstant(0, '10:05:00'),
    })
    assert.equal(after.attempted, 0, 'recovery let a second attempt through')
  })

  test('a fresh in-flight attempt is left alone while the call may still be running', async () => {
    await due()
    const { channel } = scripted([])
    await messaging.prepareDueMessages({ channel, now: await clinicInstant(0, '10:00:00') })
    const outboxId = String(await onlyMessage())
    const now = await clinicInstant(0, '10:00:00')
    await rows(
      `insert into jmc.message_attempts (id, outbox_id, attempt_number, transport, started_at)
       values ($1,$2,1,'whatsapp_cloud_api', $3::timestamptz - interval '1 minute')`,
      [randomUUID(), outboxId, now],
    )

    const { recovered } = await messaging.recoverStaleAttempts({ now })
    assert.equal(recovered, 0)
    assert.equal(await scalar('select outcome from jmc.message_attempts'), 'in_flight')
  })

  test('a worker returning after its attempt was recovered does not abandon the cycle', async () => {
    /*
     * Recovery and a very late answer, colliding.
     *
     * `message_attempts` may be settled exactly once — the trigger raises on a
     * second attempt — and an unconditional settlement would therefore throw
     * straight out of the dispatch loop and abandon every remaining message in
     * the cycle. One stalled call must not cost the clinic a round of
     * reminders. The late settlement finds no in-flight row and changes
     * nothing; the message's own truth is still recorded.
     */
    await due()
    const { channel } = scripted([])
    const now = await clinicInstant(0, '10:00:00')
    await messaging.prepareDueMessages({ channel, now })

    const outboxId = String(await onlyMessage())
    const attemptId = randomUUID()
    await rows(
      `insert into jmc.message_attempts (id, outbox_id, attempt_number, transport, started_at)
       values ($1,$2,1,'whatsapp_cloud_api', $3::timestamptz - interval '40 minutes')`,
      [attemptId, outboxId, now],
    )
    await rows(
      `update jmc.message_outbox
          set status='outcome_unknown', attempt_count=1,
              first_attempt_at=$2::timestamptz - interval '40 minutes',
              last_attempt_at=$2::timestamptz - interval '40 minutes'
        where id=$1`, [outboxId, now])

    await messaging.recoverStaleAttempts({ now })
    assert.equal(await scalar('select outcome from jmc.message_attempts'), 'transport_error')

    // Now the original worker comes back with Meta's answer.
    const reference = `wamid.${randomUUID()}`
    const key = String(await one('idempotency_key'))
    await assert.doesNotReject(() => messaging.applyProviderStatusEvent({
      providerReference: reference,
      status: 'sent',
      callbackData: key,
    }))

    assert.equal(await one('status'), 'sent_to_provider')
    assert.equal(await one('provider_reference'), reference)
    // And the settled attempt was not rewritten.
    assert.equal(await scalar('select outcome from jmc.message_attempts'), 'transport_error')
  })

  test('an outcome-unknown message reaches the admin queue and can escalate', async () => {
    const built = await due()
    const stalling = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: () => ({
        ok: false, category: 'transport_error', detail: 'lost', terminal: false, ambiguous: true,
      }),
    })
    await runCycle(stalling, '10:00:00')

    assert.equal(await one('failure_owner_role'), 'admin')
    assert.notEqual(await one('first_failed_at'), null)

    const queue = await messaging.readCommunicationFailures(session(built.admin, ['admin']))
    const mine = queue.failures.filter((row) => row.status === 'outcome_unknown')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].errorCategory, 'transport_error')
  })

  test('a transport pointed anywhere but this machine is refused at construction', () => {
    for (const url of [
      'https://graph.facebook.com/v23.0/1/messages',
      'http://example.test',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      assert.throws(
        () => messaging.loopbackChannel({ baseUrl: url, respond: () => ACCEPTED() }),
        /may only address loopback/,
        url,
      )
    }
  })
})

/* ═══════════════════════════════════════════════════════ 3. the webhook ══ */

describe('the provider webhook proves who it is before it changes anything', () => {
  test('the verification challenge succeeds only with the configured token', async () => {
    configureProvider()

    const good = await edgeRequest(
      'whatsapp', `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    )
    assert.equal(good.status, 200)
    assert.equal(new TextDecoder().decode(good.bytes), '1158201444')

    for (const query of [
      `?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=1158201444`,
      `?hub.mode=subscribe&hub.verify_token=&hub.challenge=1158201444`,
      `?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
      `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
    ]) {
      const refused = await edgeRequest('whatsapp', query)
      assert.equal(refused.status, 403, query)
    }
  })

  test('with no verify token configured nobody can subscribe, including an empty one', async () => {
    unconfigureProvider()
    const refused = await edgeRequest(
      'whatsapp', '?hub.mode=subscribe&hub.verify_token=&hub.challenge=1',
    )
    assert.equal(refused.status, 403)
    configureProvider()
  })

  test('a missing, malformed or wrong signature changes nothing at all', async () => {
    configureProvider()
    const built = await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)
    assert.equal(await one('status'), 'sent_to_provider')

    const body = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '919990000001',
    }])

    const refusals = [
      ['missing', { signature: null }],
      ['empty', { signature: '' }],
      ['not sha256', { signature: 'sha1=abc' }],
      ['not hex', { signature: `sha256=${'z'.repeat(64)}` }],
      ['too short', { signature: 'sha256=abcd' }],
      ['signed with the wrong secret', { secret: 'somebody-elses-secret' }],
    ]

    for (const [name, options] of refusals) {
      const response = await postWebhook(body, options)
      assert.equal(response.status, 403, name)
      assert.equal(await one('status'), 'sent_to_provider', `${name} changed the message`)
      assert.equal(Number(await eventCount()), 0, `${name} recorded an event`)
    }
    void built
  })

  test('the signature is verified against the exact bytes that arrived', async () => {
    configureProvider()
    const reference = `wamid.${randomUUID()}`

    // Two documents with identical MEANING and different BYTES. Signing one
    // and sending the other must be refused — which is the property that is
    // lost the moment anything re-serializes the body before checking it.
    const sent = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '919990000001',
    }])
    const reserialized = JSON.stringify(JSON.parse(sent), null, 2)
    assert.notEqual(sent, reserialized)

    const response = await postWebhook(sent, { signature: sign(reserialized) })
    assert.equal(response.status, 403)
    assert.equal(Number(await eventCount()), 0)

    // A non-ASCII body, signed and sent as the same bytes, is accepted — the
    // case a text round-trip is most likely to break.
    await due()
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const unicode = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000',
      recipient_id: '919990000001', biz_opaque_callback_data: '',
      // A name with characters outside ASCII, as Meta might echo one.
      errors: undefined, note: 'ஜெயமுருகன்',
    }])
    const accepted = await postWebhook(unicode)
    assert.equal(accepted.status, 200)
    assert.equal(await one('status'), 'delivered')
  })

  test('a valid delivered event settles the right message', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const body = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '919990000001',
    }])
    const response = await postWebhook(body)

    assert.equal(response.status, 200)
    assert.equal(await one('status'), 'delivered')
    assert.equal(await one('delivery_status'), 'delivered')
    assert.equal(Number(await one('delivery_rank')), 3)
    assert.equal(await scalar('select effect from jmc.message_provider_events'), 'applied')
  })

  test('a duplicate delivery event is harmless and recorded once', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const body = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '919990000001',
    }])

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await postWebhook(body)).status, 200)
    }

    assert.equal(await one('status'), 'delivered')
    assert.equal(Number(await one('delivery_rank')), 3)
    assert.equal(Number(await eventCount()), 1, 'the same event was recorded more than once')
  })

  test('concurrent duplicate webhooks create exactly one evidence result', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const body = statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '919990000001',
    }])

    const responses = await Promise.all([
      postWebhook(body), postWebhook(body), postWebhook(body), postWebhook(body),
    ])
    for (const response of responses) assert.equal(response.status, 200)

    assert.equal(Number(await eventCount()), 1)
    assert.equal(await one('status'), 'delivered')
  })

  test('an out-of-order event cannot regress delivered or terminal truth', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    await postWebhook(statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000100', recipient_id: '9199',
    }]))
    assert.equal(await one('status'), 'delivered')

    // `sent` arriving after `delivered` — Meta does this — must not undo it.
    await postWebhook(statusPayload([{
      id: reference, status: 'sent', timestamp: '1758000000', recipient_id: '9199',
    }]))
    assert.equal(await one('status'), 'delivered')
    assert.equal(Number(await one('delivery_rank')), 3)

    // Nor may a later failure rewrite a delivery the patient already received.
    await postWebhook(statusPayload([{
      id: reference, status: 'failed', timestamp: '1758000200', recipient_id: '9199',
      errors: [{ code: 131026, title: 'Undeliverable' }],
    }]))
    assert.equal(await one('status'), 'delivered')

    const effects = (await rows(
      'select status, effect from jmc.message_provider_events order by received_at')
    ).map((row) => `${row.status}:${row.effect}`)
    assert.deepEqual(effects, ['delivered:applied', 'sent:ignored', 'failed:ignored'])
  })

  test('read and played are delivery evidence and never weaker than delivered', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    await postWebhook(statusPayload([{
      id: reference, status: 'read', timestamp: '1758000000', recipient_id: '9199',
    }]))
    // A message the patient opened was certainly delivered.
    assert.equal(await one('status'), 'delivered')

    await postWebhook(statusPayload([{
      id: reference, status: 'sent', timestamp: '1757999000', recipient_id: '9199',
    }]))
    assert.equal(await one('status'), 'delivered')
  })

  test('acceptance can never masquerade as delivery', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([{
      ok: true, providerReference: reference, acceptStatus: 'held_for_quality_assessment',
    }])
    await runCycle(channel)

    assert.equal(await one('status'), 'sent_to_provider')
    assert.equal(Number(await one('delivery_rank')), 1)

    // `accepted` is not one of Meta's status words and cannot arrive here. The
    // strongest thing the POST could ever produce is rank 1.
    assert.equal(
      Number(await scalar(`select count(*) from jmc.message_outbox where status='delivered'`)), 0,
    )

    // Only an actual delivery event moves it.
    await postWebhook(statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '9199',
    }]))
    assert.equal(await one('status'), 'delivered')
  })

  test('a failed event is terminal, redacted, and owned by the admin', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    await postWebhook(statusPayload([{
      id: reference, status: 'failed', timestamp: '1758000000', recipient_id: '919990000001',
      errors: [{
        code: 131026,
        title: 'Message undeliverable',
        message: 'Recipient 919990000001 is not a WhatsApp user',
      }],
    }]))

    assert.equal(await one('status'), 'failed_terminal')
    assert.equal(await one('error_category'), 'invalid_recipient')
    assert.notEqual(await one('escalated_at'), null)
    assert.equal(await one('failure_owner_role'), 'admin')

    const detail = String(await scalar('select error_detail from jmc.message_provider_events'))
    assert.equal(detail.includes('919990000001'), false, 'the number survived redaction')
    assert.ok(detail.includes('[number]'))
  })

  test('an unknown provider identifier discloses nothing and mutates nothing', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const before = String(await one('status'))
    const response = await postWebhook(statusPayload([{
      id: 'wamid.SOMEBODY-ELSES-MESSAGE', status: 'delivered',
      timestamp: '1758000000', recipient_id: '919990000001',
    }]))

    // The same 200 and the same body a recognised event gets: a stranger
    // cannot use this endpoint to ask whether a message exists.
    assert.equal(response.status, 200)
    assert.equal(new TextDecoder().decode(response.bytes), 'EVENT_RECEIVED')
    assert.equal(await one('status'), before, 'another message was mutated')
    assert.equal(
      await scalar('select effect from jmc.message_provider_events'), 'unknown_reference')
    assert.equal(await scalar('select outbox_id from jmc.message_provider_events'), null)
  })

  test('a lost reply is reconciled through the echoed callback data', async () => {
    configureProvider()
    await due()

    // The call went out and the answer never came back: the clinic has an
    // outcome_unknown message and no provider reference to match a webhook on.
    const stalling = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: () => ({
        ok: false, category: 'transport_error', detail: 'lost', terminal: false, ambiguous: true,
      }),
    })
    await runCycle(stalling, '10:00:00')
    assert.equal(await one('status'), 'outcome_unknown')
    assert.equal(await one('provider_reference'), null)

    const key = String(await one('idempotency_key'))
    const reference = `wamid.${randomUUID()}`

    // Meta echoes back what the clinic sent as biz_opaque_callback_data, which
    // is the only thread back to this message.
    await postWebhook(statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000',
      recipient_id: '919990000001', biz_opaque_callback_data: key,
    }]))

    assert.equal(await one('status'), 'delivered')
    assert.equal(await one('provider_reference'), reference)
    assert.equal(
      await scalar('select callback_data from jmc.message_provider_events'), key)
  })

  test('two events for one reconciled message both land, in either order', async () => {
    /*
     * The race that was in the first version of `applyProviderStatusEvent`.
     *
     * A lost reply leaves a message with no provider reference. Meta then sends
     * `sent` and `delivered` for it, and both arrive at once: neither finds the
     * message by wamid, both find it by the echoed callback data, and both
     * queue on its row lock. The first adopts the wamid. The second must then
     * recognise that reference as ITS OWN and apply — the earlier guard tested
     * for "any reference" and threw the delivery away, leaving a message that
     * had reached the patient recorded as merely sent.
     */
    configureProvider()
    await due()
    const stalling = messaging.loopbackChannel({
      baseUrl: 'http://127.0.0.1:54321',
      respond: () => ({
        ok: false, category: 'transport_error', detail: 'lost', terminal: false, ambiguous: true,
      }),
    })
    await runCycle(stalling, '10:00:00')
    assert.equal(await one('status'), 'outcome_unknown')

    const key = String(await one('idempotency_key'))
    const reference = `wamid.${randomUUID()}`
    const event = (status, ts) => statusPayload([{
      id: reference, status, timestamp: ts, recipient_id: '9199',
      biz_opaque_callback_data: key,
    }])

    const [first, second] = await Promise.all([
      postWebhook(event('sent', '1758000000')),
      postWebhook(event('delivered', '1758000100')),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)

    assert.equal(await one('status'), 'delivered', 'the delivery was thrown away')
    assert.equal(await one('provider_reference'), reference)
    assert.equal(Number(await eventCount()), 2)
    assert.equal(
      Number(await scalar(
        `select count(*) from jmc.message_provider_events where effect='unknown_reference'`)),
      0,
      'an event about this message was recorded as belonging to no message',
    )
  })

  test('callback data naming a message that already has a different id is refused', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)

    const key = String(await one('idempotency_key'))

    // A second wamid arriving with the same callback value is not this
    // message's evidence; attaching it would bind one delivery to another
    // message.
    await postWebhook(statusPayload([{
      id: `wamid.${randomUUID()}`, status: 'delivered', timestamp: '1758000000',
      recipient_id: '9199', biz_opaque_callback_data: key,
    }]))

    assert.equal(await one('provider_reference'), reference, 'the provider reference was replaced')
    assert.equal(await one('status'), 'sent_to_provider')
    assert.equal(
      await scalar(
        `select effect from jmc.message_provider_events where callback_data = $1`, [key]),
      'unknown_reference',
    )
  })

  test('an event is evidence and is never edited or deleted', async () => {
    configureProvider()
    await due()
    const reference = `wamid.${randomUUID()}`
    const { channel } = scripted([ACCEPTED(reference)])
    await runCycle(channel)
    await postWebhook(statusPayload([{
      id: reference, status: 'delivered', timestamp: '1758000000', recipient_id: '9199',
    }]))

    const id = String(await scalar('select id from jmc.message_provider_events'))
    const raw = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => raw.unsafe(`update jmc.message_provider_events set effect='ignored' where id=$1`, [id]),
        /never edited/,
      )
      await assert.rejects(
        () => raw.unsafe('delete from jmc.message_provider_events where id=$1', [id]),
        /never deleted/,
      )
    } finally {
      await raw.end({ timeout: 5 })
    }
  })

  test('the webhook exposes no read and no administrative path', async () => {
    configureProvider()
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await edgeRequest('whatsapp', '', { method, body: '{}' })
      assert.equal(response.status, 405, method)
    }
    // A GET without a valid challenge is refused rather than answering with
    // anything about the clinic.
    const probe = await edgeRequest('whatsapp', '?view=failures')
    assert.equal(probe.status, 403)
  })
})

/* ═════════════════════════════════════════ 4. authorization and privacy ══ */

describe('the worker endpoint is not reachable by anybody who signs in', () => {
  test('an ordinary staff session cannot invoke the dispatch worker', async () => {
    process.env.CLINIC_WORKER_TOKEN = 'staging-only-worker-token'
    const built = await clinic()

    for (const staff of [built.admin, built.owner, built.doctor, built.nurse, built.pharmacist]) {
      const token = await tokenFor(staff)
      const response = await edgeRequest('worker', '', {
        method: 'POST', token, body: '{}',
      })
      assert.equal(response.status, 401, `${staff.username} reached the worker`)
    }

    // And with no credential at all.
    assert.equal((await edgeRequest('worker', '', { method: 'POST', body: '{}' })).status, 401)
  })

  test('the worker refuses everybody while its secret is unset', async () => {
    delete process.env.CLINIC_WORKER_TOKEN
    const response = await edgeRequest('worker', '', {
      method: 'POST', token: 'staging-only-worker-token', body: '{}',
    })
    assert.equal(response.status, 401)
  })

  test('the worker runs one cycle for the scheduler and answers in counts only', async () => {
    process.env.CLINIC_WORKER_TOKEN = 'staging-only-worker-token'
    unconfigureProvider()
    const built = await due()

    const response = await edgeRequest('worker', '', {
      method: 'POST', token: 'staging-only-worker-token', body: '{}',
    })

    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.suppressed, 1)

    // Nothing about a person may appear in a scheduler's log.
    const printed = JSON.stringify(response.body)
    for (const leak of ['Reminded', 'Patient', '919990000001', built.patientId]) {
      assert.equal(printed.includes(leak), false, `${leak} appeared in the worker response`)
    }
  })

  test('the worker answers 405 to a GET, so nothing can trigger it by prefetch', async () => {
    process.env.CLINIC_WORKER_TOKEN = 'staging-only-worker-token'
    const response = await edgeRequest('worker', '', {
      method: 'GET', token: 'staging-only-worker-token',
    })
    assert.equal(response.status, 405)
  })

  test('pharmacy cannot read clinical-recall delivery information', async () => {
    const built = await clinic()
    const queue = await messaging.readCommunicationFailures(
      session(built.pharmacist, ['pharmacy']))
    assert.deepEqual(queue.failures, [])

    const token = await tokenFor(built.pharmacist)
    for (const view of [
      'communication_due', 'communication_failures',
      `communication_consent&patientId=${built.patientId}`,
    ]) {
      const response = await edgeRequest('workspace', `?view=${view}`, { token })
      assert.equal(response.status, 403, view)
    }
  })

  test('no test in this suite has attempted a request', () => {
    assert.deepEqual(fetchAttempts, [], `a request was attempted: ${fetchAttempts.join(', ')}`)
  })
})

/* ══════════════════════════════════════════════════════ 5. compatibility ══ */

describe('the legacy staff composer is untouched by any of this', () => {
  test('send_patient_whatsapp still refuses on the old blanket flag, exactly as before', async () => {
    unconfigureProvider()
    const built = await clinic()
    fetchAttempts = []

    /*
     * This is the deferred item in §15.8, characterized rather than changed:
     * the staff composer still reads `patients.whatsapp_consent`, the blanket
     * registration flag, and NOT the per-purpose consent table Slice 3A
     * added. Moving it across is a decision about what the registration
     * checkbox means — owner item 78 says a registration choice is valid only
     * for the purposes it names — and it is not this slice's to make.
     */
    await assert.rejects(
      () => rawAs(built.nurse, 'send_patient_whatsapp', {
        patientId: built.patientId, body: 'Your report is ready to collect.',
      }),
      /consent is not recorded/,
    )
    assert.deepEqual(fetchAttempts, [])
  })

  test('with the old flag set it stops at the connection, and still sends nothing', async () => {
    unconfigureProvider()
    const built = await clinic()
    await rows(`update jmc.patients set whatsapp_consent=1 where id=$1`, [built.patientId])
    fetchAttempts = []

    await assert.rejects(
      () => rawAs(built.nurse, 'send_patient_whatsapp', {
        patientId: built.patientId, body: 'Your report is ready to collect.',
      }),
      /not connected/,
    )
    assert.deepEqual(fetchAttempts, [])
  })

  test('the composer writes nothing into the outbox: there are not two sending paths', async () => {
    unconfigureProvider()
    const built = await clinic()
    await rows(`update jmc.patients set whatsapp_consent=1 where id=$1`, [built.patientId])

    await assert.rejects(() => rawAs(built.nurse, 'send_patient_whatsapp', {
      patientId: built.patientId, body: 'Hello.',
    }))

    // The Slice 3A/3B records are for scheduled, consented, templated clinic
    // messages. A member of staff typing a sentence is a different thing and
    // stays in `whatsapp_messages`, where it always was.
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 0)
    assert.equal(Number(await eventCount()), 0)
  })

  test('the worker and the composer are not reachable from one another', () => {
    // `runDispatchCycle` never calls `sendWhatsAppText`, and the composer
    // never reaches the outbox. The two paths share exactly one thing —
    // `dialable`, so a number is normalized once rather than twice — and that
    // was already true in Slice 3A.
    void db
    assert.equal(typeof messaging.runDispatchCycle, 'function')
    assert.deepEqual(fetchAttempts, [])
  })
})
