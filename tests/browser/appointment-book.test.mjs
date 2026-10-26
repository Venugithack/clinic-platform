/**
 * The appointment book, through the real screen.
 *
 * ── WHAT THESE JOURNEYS ARE FOR ───────────────────────────────────────────
 *
 * Slice 2's appointment domain has been tested at the database for a week —
 * owner items 65 to 71, every refusal, every replay — and nothing has ever
 * drawn it. These drive the station that does, against the real functions and
 * a real database, and most of them end by counting rows rather than reading
 * words: that a booking made here is one booking, that a check-in is one
 * queue row, and that recovering from a lost reply did not quietly do the
 * work twice.
 *
 * ── WHY IT BRINGS ITS OWN PATIENTS ─────────────────────────────────────────
 *
 * Checking somebody in puts them in today's queue, and every journey file
 * shares one staging database. So this file seeds its own patients, works only
 * on them, publishes its own hours, and removes all of it afterwards — the
 * bookings, their append-only history and receipts, the queue rows it made
 * and the reminder schedules the commands wrote.
 *
 * ── TWO BOOKINGS ARE WRITTEN BY HAND, AND WHY ─────────────────────────────
 *
 * A late arrival and a no-show both need a booking whose start is at least
 * half an hour gone. The command refuses a day in the past (owner item 66's
 * other end), so between midnight and half past in Chennai there is no way to
 * make one through it at all. Those two are inserted exactly as the command
 * would have left them forty-odd minutes later — the booking and its `booked`
 * event — and everything done TO them afterwards goes through the screen.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import {
  FUNCTIONS_URL, ab, closeBrowser, evaluate, launchBrowser, waitFor,
} from './support/harness.mjs'
import {
  EVERY_SHAPE, LANDSCAPE, PORTRAIT, allStations, clickButton, fillField, freshPage, goToStation,
  setViewport, signIn,
} from './support/clinic-ui.mjs'

const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }
const DOCTOR_ONLY = { name: 'Dr Kavitha Solo', pin: '3517' }
const NURSE = { name: 'Nirmaladevi Ponnusamy', pin: '7305' }
const ADMIN_ONLY = { name: 'Hemalatha Manoharan', pin: '905283' }
const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }

/** One patient per destructive journey, so no journey leans on another's leftovers. */
const P = {
  booked: { id: 'appt-p01', name: 'Appt Kalaivani Sundaram' },
  moved: { id: 'appt-p02', name: 'Appt Murugesan Ramalingam' },
  late: { id: 'appt-p03', name: 'Appt Selvi Late Arrival' },
  noShow: { id: 'appt-p04', name: 'Appt Pandian No Show' },
  refused: { id: 'appt-p05', name: 'Appt Outside Hours Nurse' },
  doctorOverride: { id: 'appt-p06', name: 'Appt Doctor Override' },
  adminOverride: { id: 'appt-p07', name: 'Appt Admin Overbook' },
  lost: { id: 'appt-p08', name: 'Appt Venkatalakshmi Lost Reply' },
  reloaded: { id: 'appt-p09', name: 'Appt Reloaded Tablet' },
  superseded: { id: 'appt-p10', name: 'Appt Superseded Checkin' },
  offline: { id: 'appt-p11', name: 'Appt Server Away' },
  longName: { id: 'appt-p12', name: 'Appt Thiruvengadathan Venkataramanujam Sundaravadivelu Parthasarathy' },
}
const MINE = Object.values(P)
const MY_IDS = MINE.map((who) => who.id)

/* ─────────────────────────────────────────────────────── the database ── */

function scratchDb() {
  const url = process.env.STAGING_DB_URL
  if (!url) throw new Error('STAGING_DB_URL is not set; browser-gate.mjs sets it')
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} })
}

async function query(text, params = []) {
  const sql = scratchDb()
  try {
    return await sql.unsafe(text, params)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function bookingsOf(patientId) {
  return await query(
    `select id, status, overbooked, outside_availability, overbooked_reason,
            scheduled_at, idempotency_key
       from jmc.appointment_bookings where patient_id = $1 order by created_at`,
    [patientId],
  )
}

async function arrivalsOf(patientId) {
  return await query(
    `select id, token, status, scheduled_at, booking_id
       from jmc.appointments where patient_id = $1 order by created_at`,
    [patientId],
  )
}

async function receiptsOf(patientId) {
  return await query(
    `select r.command, r.idempotency_key from jmc.appointment_command_receipts r
       join jmc.appointment_bookings b on b.id = r.booking_id
      where b.patient_id = $1 order by r.created_at`,
    [patientId],
  )
}

/** The clinic's own now: its date, its clock, and tomorrow. */
async function clinicNow() {
  const [row] = await query(
    `select to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as today,
            to_char(now() at time zone 'Asia/Kolkata', 'HH24:MI') as clock,
            to_char((now() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD') as tomorrow`,
  )
  return row
}

/**
 * A time later today on the clinic's clock, never past 23:44 — the last start
 * a fifteen-minute appointment can have inside a window closing at 23:59.
 */
async function laterToday(minutes = 10) {
  const [row] = await query(
    `select to_char(least(
        date_trunc('minute', (now() at time zone 'Asia/Kolkata') + make_interval(mins => $1)),
        ((now() at time zone 'Asia/Kolkata')::date + time '23:44')), 'YYYY-MM-DD"T"HH24:MI') as at`,
    [minutes],
  )
  return row.at
}

async function seedPatients() {
  for (const who of MINE) {
    await query(
      `insert into jmc.patients (id, name, phone, age, sex, created_at)
       values ($1, $2, $3, 38, 'female', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       on conflict (id) do nothing`,
      [who.id, who.name, `+91990${who.id.slice(-2)}0000`],
    )
  }
}

/**
 * A booking whose start has gone by — see the file header for why this one
 * alone is written directly. It is exactly the row and the event the command
 * writes; the clinic cannot tell it from one booked forty minutes ago.
 */
async function bookingAlreadyStarted(patientId, minutesAgo, bookedBy) {
  const id = randomUUID()
  await query(
    `insert into jmc.appointment_bookings
       (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status,
        overbooked, overbooked_reason, outside_availability, booked_by, idempotency_key, request_fingerprint)
     values ($1, $2, $3, now() - make_interval(mins => $4), 15, 'Follow-up', 'booked',
             false, '', false, $3, $5, 'seeded-by-the-browser-gate')`,
    [id, patientId, bookedBy, minutesAgo, randomUUID()],
  )
  await query(
    `insert into jmc.appointment_events (id, booking_id, event, to_status, scheduled_at_after, reason, actor_id)
     select $1, b.id, 'booked', 'booked', b.scheduled_at, 'Follow-up', $3
       from jmc.appointment_bookings b where b.id = $2`,
    [randomUUID(), id, bookedBy],
  )
  return id
}

/** Everything this file created, and nothing else. */
async function removeEverything(availabilityIds) {
  const sql = scratchDb()
  try {
    const bookings = (await sql`select id from jmc.appointment_bookings where patient_id = any(${MY_IDS})`)
      .map((row) => row.id)
    const arrivals = (await sql`select id from jmc.appointments where patient_id = any(${MY_IDS})`)
      .map((row) => row.id)

    // The reminder rows the commands wrote (Slice 3A). Nothing was ever sent.
    await sql`delete from jmc.message_attempts where outbox_id in (
                select id from jmc.message_outbox where patient_id = any(${MY_IDS}))`
    await sql`delete from jmc.message_provider_events where outbox_id in (
                select id from jmc.message_outbox where patient_id = any(${MY_IDS}))`
    await sql`delete from jmc.message_outbox where patient_id = any(${MY_IDS})`
    await sql`delete from jmc.communication_schedules where patient_id = any(${MY_IDS})`

    /*
     * The history and the receipts are append-only in the clinic, and those
     * triggers are doing their job. These rows belong to patients this file
     * invented on a scratch database `guard.mjs` refuses to let be anything
     * else, so the triggers are lifted for exactly this cleanup and put back.
     */
    await sql`alter table jmc.appointment_events disable trigger appointment_events_immutable`
    await sql`alter table jmc.appointment_command_receipts disable trigger appointment_command_receipts_immutable`
    try {
      await sql`delete from jmc.appointment_events
                 where booking_id = any(${bookings}) or arrival_id = any(${arrivals})`
      await sql`delete from jmc.appointment_command_receipts
                 where booking_id = any(${bookings}) or arrival_id = any(${arrivals})`
    } finally {
      await sql`alter table jmc.appointment_command_receipts enable trigger appointment_command_receipts_immutable`
      await sql`alter table jmc.appointment_events enable trigger appointment_events_immutable`
    }
    await sql`delete from jmc.appointments where patient_id = any(${MY_IDS})`
    await sql`delete from jmc.appointment_bookings where patient_id = any(${MY_IDS})`
    await sql`delete from jmc.vitals where patient_id = any(${MY_IDS})`
    if (availabilityIds.length > 0) {
      await sql`delete from jmc.provider_availability where id = any(${availabilityIds})`
    }
    await sql`delete from jmc.patients where id = any(${MY_IDS})`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/* ─────────────────────────────────────────────────── arranging over HTTP ── */

async function signInApi(name, pin) {
  const roster = await (await fetch(`${FUNCTIONS_URL}/staff`)).json()
  const member = roster.staff?.find((candidate) => candidate.name === name)
  if (!member) throw new Error(`no staff member called ${name} on the lock screen`)
  const response = await fetch(`${FUNCTIONS_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `10.1.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ staffId: member.id, pin }),
  })
  const body = await response.json()
  if (!body.token) throw new Error(`could not sign in as ${name}: ${JSON.stringify(body)}`)
  return { token: body.token, id: member.id }
}

async function command(who, action, payload = {}) {
  const response = await fetch(`${FUNCTIONS_URL}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ action, payload: { idempotencyKey: randomUUID(), ...payload } }),
  })
  return { status: response.status, ...(await response.json()) }
}

async function must(who, action, payload = {}) {
  const answer = await command(who, action, payload)
  if (!answer.ok) throw new Error(`${action} refused: ${answer.message}`)
  return answer
}

async function read(who, path) {
  const response = await fetch(`${FUNCTIONS_URL}/${path}`, {
    headers: { Authorization: `Bearer ${who.token}` },
  })
  return { status: response.status, body: await response.json() }
}

const staff = {}
const published = []
let day = { today: '', tomorrow: '', clock: '' }

before(async () => {
  await seedPatients()
  staff.owner = await signInApi(OWNER.name, OWNER.pin)
  staff.nurse = await signInApi(NURSE.name, NURSE.pin)
  staff.pharmacist = await signInApi(PHARMACIST.name, PHARMACIST.pin)
  day = await clinicNow()

  // The hours this file books inside: all of today, and a morning tomorrow.
  // Published by the owner-doctor through the real command, as a clinic does.
  for (const window of [
    { onDate: day.today, startsAt: '00:00', endsAt: '23:59' },
    { onDate: day.tomorrow, startsAt: '09:00', endsAt: '13:00' },
  ]) {
    const answer = await must(staff.owner, 'publish_availability', { kind: 'open', ...window })
    published.push(answer.data.availabilityId)
  }
  launchBrowser()
})

after(async () => {
  closeBrowser()
  await removeEverything(published)
})

/* ─────────────────────────────────────────────────────── the page ── */

async function openBook(who) {
  await freshPage()
  await signIn(who.name, who.pin)
  await goToStation('Appointments')
  await waitFor(`(document.querySelector('main')?.innerText ?? '').includes('The book for')`, {
    what: 'the appointment station',
  })
  await waitFor(
    `!!document.querySelector('[data-testid=appointment-day] [aria-label="Bookings"], [data-testid=appointment-day] [data-testid=published-hours]')`,
    { what: 'the day to be read', timeout: 20_000 },
  )
}

/** Click a button, by its words, inside one element. */
function clickWithin(selector, label) {
  const clicked = evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    if (!root) return 'no-root'
    const button = [...root.querySelectorAll('button')]
      .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
      .find((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase()
        .startsWith(${JSON.stringify(label.toLowerCase())}))
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  if (!clicked.includes('ok')) throw new Error(`${clicked}: "${label}" inside ${selector}`)
}

function exists(selector) {
  return evaluate(`!!document.querySelector(${JSON.stringify(selector)})`).includes('true')
}

function textOf(selector) {
  return evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`)
}

/** Choose a patient through the station's own finder, which is the shared selection. */
async function choosePatient(who) {
  fillField('Find patient', who.name)
  await waitFor(
    `[...document.querySelectorAll('[aria-label="Matching patients"] button')].some(b => b.innerText.includes(${JSON.stringify(who.name)}))`,
    { what: `${who.name} among the matches` },
  )
  clickWithin('[aria-label="Matching patients"]', who.name)
  await waitFor(`(document.querySelector('[data-testid=book-patient]')?.innerText ?? '').includes(${JSON.stringify(who.name)})`, {
    what: `${who.name} chosen`,
  })
}

/**
 * The staging clinic has two doctors — the gate seeds a doctor-only account —
 * so a nurse or an administrator must name one, and the station asks.
 */
async function chooseDoctor(doctorId) {
  await waitFor(
    `[...document.querySelectorAll('label')].some(l => l.innerText.trim().toLowerCase().startsWith('doctor'))`,
    { what: 'the doctor chooser' },
  )
  fillField('Doctor', doctorId)
}

async function bookThroughForm({ who, at, reason, doctorId }) {
  await choosePatient(who)
  if (doctorId) await chooseDoctor(doctorId)
  fillField('Date and time', at)
  fillField('Reason for the visit', reason)
  clickWithin('[data-testid=book-appointment]', 'Book appointment')
}

/**
 * The result overlay's words, read in the same breath as the wait that saw
 * them. A routine result goes after two seconds, and a second read afterwards
 * finds nothing — which is the overlay working, not failing.
 */
async function resultShows(needle) {
  const seen = await waitFor(
    `(() => {
      const words = document.querySelector('[data-testid=result-overlay]')?.innerText ?? ''
      return words.toLowerCase().includes(${JSON.stringify(needle.toLowerCase())}) ? words : ''
    })()`,
    { what: `the result to say "${needle}"`, timeout: 20_000 },
  )
  try {
    const once = JSON.parse(seen)
    return typeof once === 'string' ? once : seen
  } catch {
    return seen
  }
}

function closeResult() {
  evaluate(`(() => {
    const overlay = document.querySelector('[data-testid=result-overlay]')
    const close = overlay && [...overlay.querySelectorAll('button')].find(b => b.innerText.trim() === 'Close')
    if (close) close.click()
    return 'ok'
  })()`)
}

async function dismissResult() {
  closeResult()
  await waitFor(`!document.querySelector('[data-testid=result-overlay]')`, { what: 'the result to close' })
}

/**
 * One wrapper over `fetch`, steered by `window.__line`, recording the
 * reference every command was sent under. What each flag does is the real
 * condition, not a mock of the clinic: `swallow` lets the command reach the
 * clinic and commit and throws the reply away; `cut` stops it leaving the
 * tablet; `readsDown` and `slowReads` do the same to the workspace reads.
 */
function armLine(line) {
  evaluate(`(() => {
    window.__line = ${JSON.stringify(line)}
    window.__keys = window.__keys || []
    if (window.__lineInstalled) return 'ok'
    window.__lineInstalled = true
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const now = window.__line || {}
      if (url.indexOf('/command') !== -1) {
        try {
          const body = JSON.parse((init && init.body) || '{}')
          window.__keys.push({ action: body.action, key: body.payload && body.payload.idempotencyKey })
        } catch (e) { /* not JSON */ }
        if (now.cut) throw new TypeError('Failed to fetch')
        if (now.swallow) {
          try { await real(input, init) } catch (e) { /* it happened or it did not */ }
          throw new TypeError('Failed to fetch')
        }
      }
      if (url.indexOf('/workspace') !== -1) {
        if (now.readsDown) throw new TypeError('Failed to fetch')
        if (now.slowReads) await new Promise((done) => setTimeout(done, now.slowReads))
      }
      return real(input, init)
    }
    return 'ok'
  })()`)
}

function sentKeys(action) {
  return evalJson(`(window.__keys || []).filter(k => k.action === ${JSON.stringify(action)}).map(k => k.key)`, [])
}

/** A value the page built with JSON.stringify, through the bridge's own quoting. */
function evalJson(expression, fallback) {
  const raw = evaluate(`JSON.stringify(${expression})`)
  try {
    const once = JSON.parse(raw)
    return typeof once === 'string' ? JSON.parse(once) : once
  } catch {
    return fallback
  }
}

/** Every appointment note this tab is holding, as the raw strings stored. */
function heldNotes() {
  return evalJson(`Object.keys(window.sessionStorage)
    .filter(k => k.indexOf('jayamurugan_appointment:') === 0)
    .map(k => window.sessionStorage.getItem(k))`, [])
}

async function reloadTablet() {
  evaluate(`location.reload()`)
  await waitFor(`!!document.querySelector('nav[aria-label="Clinic stations"]')`, {
    what: 'the tablet to come back signed in', timeout: 20_000,
  })
}

/* ══════════════════════════════════════════════════════════ journeys ══ */

describe('booking, and the door into the queue', () => {
  test('a nurse books a known patient; the booking is not in the live queue until check-in, which issues one token', async () => {
    setViewport(LANDSCAPE)
    await openBook(NURSE)
    const at = await laterToday(10)

    await bookThroughForm({ who: P.booked, at, reason: 'Fever for three days', doctorId: staff.owner.id })
    const result = await resultShows('Appointment booked')
    assert.match(result, /Not in the queue until checked in/)
    assert.match(result, /15 minutes/, 'owner item 65: the clinic default, as the clinic recorded it')
    await dismissResult()

    const [booking] = await bookingsOf(P.booked.id)
    assert.equal(booking.status, 'booked')
    assert.equal((await arrivalsOf(P.booked.id)).length, 0, 'owner item 70: a booking is not a queue row')
    // Sent as typed: the clinic reads the naive time as Chennai time.
    assert.equal(
      (await query(`select to_char(scheduled_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI') as at
                      from jmc.appointment_bookings where id = $1`, [booking.id]))[0].at,
      at,
      'the datetime-local value arrived unshifted by the browser’s zone',
    )

    const row = `[data-testid="booking-${booking.id}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(row)})`, { what: 'the booking on the day' })
    assert.match(textOf(row), /Booked · not in the queue/)
    assert.equal(/JMC-/.test(textOf(row)), false, 'no token is drawn for a booking that has none')

    // The queue does not have them, and says who is expected instead.
    await goToStation('Today')
    await waitFor(`!!document.querySelector('[data-testid=expected-today-pointer]')`, {
      what: 'the expected-today pointer on the queue',
    })
    assert.equal(exists(`[data-testid="queue-row-${P.booked.id}"]`), false, 'not in the live queue before check-in')

    // Check in from Expected today.
    await goToStation('Appointments')
    const line = `[data-testid="list-booking-${booking.id}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(line)})`, { what: 'the booking on Expected today' })
    clickWithin(line, 'Check in')
    const checkedIn = await resultShows('Checked in')
    const [arrival] = await arrivalsOf(P.booked.id)
    assert.ok(arrival, 'check-in made a queue row')
    assert.ok(checkedIn.includes(arrival.token), `the result names the token ${arrival.token}`)
    await dismissResult()

    assert.equal((await arrivalsOf(P.booked.id)).length, 1, 'exactly one arrival')
    assert.equal((await bookingsOf(P.booked.id))[0].status, 'checked_in')
    await waitFor(`(document.querySelector(${JSON.stringify(row)})?.innerText ?? '').includes('Waiting in the queue')`, {
      what: 'the day to show the token and where the visit is',
    })
    assert.ok(textOf(row).includes(arrival.token.replace('JMC-', '')))

    // Owner item 68, at the server: a nurse cannot cancel a visit that has
    // started — and the screen offers her no button that the server refuses.
    assert.equal(exists(`${row} button.border-stop`), false)
    assert.match(textOf(row), /Only a doctor or an administrator can move or cancel it/)
    const refused = await command(staff.nurse, 'cancel_appointment', { bookingId: booking.id, reason: 'Trying' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'CHECKED_IN_ALREADY')

    await goToStation('Today')
    await waitFor(`!!document.querySelector('[data-testid="queue-row-${P.booked.id}"]')`, {
      what: 'the checked-in patient in the live queue',
    })
  })

  test('a move and a cancellation keep the whole history, read back in a drawer', async () => {
    setViewport(LANDSCAPE)
    const booked = await must(staff.nurse, 'book_appointment', {
      patientId: P.moved.id, reason: 'Wound review', scheduledAt: `${day.tomorrow}T10:00`, doctorId: staff.owner.id,
    })
    const bookingId = booked.data.bookingId
    await openBook(NURSE)
    clickButton('Next day')
    const row = `[data-testid="booking-${bookingId}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(row)})`, { what: 'tomorrow’s booking' })

    clickWithin(row, 'Move')
    await waitFor(`!!document.querySelector('[data-testid=dialog-move]')`, { what: 'the move dialog' })
    fillField('New date and time', `${day.tomorrow}T11:30`)
    fillField('Why it is moving', 'Patient asked for later')
    clickWithin('[role=dialog]', 'Move appointment')
    await resultShows('Appointment moved')
    await dismissResult()

    await waitFor(`(document.querySelector(${JSON.stringify(row)})?.innerText ?? '').includes('11:30')`, {
      what: 'the moved time on the day',
    })
    clickWithin(row, 'Cancel')
    await waitFor(`!!document.querySelector('[data-testid=dialog-cancel]')`, { what: 'the cancel dialog' })
    fillField('Why it is cancelled', 'Travelling that week')
    clickWithin('[role=dialog]', 'Cancel appointment')
    await resultShows('Appointment cancelled')
    await dismissResult()

    await waitFor(`(document.querySelector(${JSON.stringify(row)})?.dataset.status ?? '') === 'cancelled'`, {
      what: 'the row to read cancelled',
    })
    assert.match(textOf(row), /Cancelled by Nirmaladevi Ponnusamy/)
    assert.match(textOf(row), /Travelling that week/)
    assert.equal((await bookingsOf(P.moved.id)).length, 1, 'cancelled, not deleted')

    clickWithin(row, 'History')
    await waitFor(`!!document.querySelector('[data-testid=appointment-history] [data-testid="history-${bookingId}"]')`, {
      what: 'the history drawer',
    })
    // The timeline alone: the card's own status badge also says Cancelled,
    // above it, and is not a transition.
    const history = textOf(`[data-testid="history-${bookingId}"] ol`)
    const order = ['Booked', 'Moved', 'Cancelled'].map((word) => history.indexOf(word))
    assert.ok(order.every((at) => at >= 0), `every transition is there: ${history}`)
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first')
    assert.match(history, /Reason: Patient asked for later/)
    assert.match(history, /Reason: Travelling that week/)
    assert.match(history, /Nirmaladevi Ponnusamy/, 'the actor is named')
  })

  test('a late arrival is checked in by hand and joins the queue by when they actually arrived', async () => {
    setViewport(LANDSCAPE)
    const bookingId = await bookingAlreadyStarted(P.late.id, 45, staff.owner.id)
    await openBook(NURSE)

    const line = `[data-testid=no-show-review] [data-testid="list-booking-${bookingId}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(line)})`, { what: 'the late booking on No-show review' })
    assert.match(textOf(line), /min past the start/)
    assert.equal((await bookingsOf(P.late.id))[0].status, 'booked', 'nothing closed it on a timer')

    const pressedAt = Date.now()
    clickWithin(line, 'Check in')
    await resultShows('Checked in')
    await dismissResult()

    const [arrival] = await arrivalsOf(P.late.id)
    const [booking] = await bookingsOf(P.late.id)
    assert.ok(Date.parse(arrival.scheduled_at) >= pressedAt - 60_000, 'the arrival is stamped with the arrival, not the booking')
    assert.ok(new Date(booking.scheduled_at).getTime() < Date.parse(arrival.scheduled_at) - 30 * 60_000)

    const queue = await query(
      `select patient_id from jmc.appointments
        where status in ('waiting','in_consult') order by urgent desc, scheduled_at, created_at`,
    )
    assert.equal(queue.at(-1).patient_id, P.late.id, 'owner item 70: behind everybody who arrived before them')

    await goToStation('Today')
    await waitFor(`!!document.querySelector('[data-testid="queue-row-${P.late.id}"]')`, { what: 'the late patient in the queue' })
    const order = evalJson(`[...document.querySelectorAll('[data-testid^="queue-row-"]')].map(r => r.dataset.testid)`, [])
    const earlier = order.indexOf(`queue-row-${P.booked.id}`)
    const later = order.indexOf(`queue-row-${P.late.id}`)
    assert.ok(later >= 0, `the late patient is in the queue: ${order}`)
    assert.ok(earlier < 0 || later > earlier,
      'drawn after the patient checked in before them, although they were booked earlier')
  })

  test('a no-show is a person’s act after thirty minutes, and never offered before', async () => {
    setViewport(LANDSCAPE)
    const bookingId = await bookingAlreadyStarted(P.noShow.id, 50, staff.owner.id)
    await openBook(NURSE)

    // Not before thirty minutes: a booking for later today offers no such
    // button, and the server refuses one sent anyway.
    const soon = await must(staff.nurse, 'book_appointment', {
      patientId: P.noShow.id, reason: 'Later today', scheduledAt: await laterToday(40), doctorId: staff.owner.id,
    })
    const early = await command(staff.nurse, 'mark_no_show', { bookingId: soon.data.bookingId })
    assert.equal(early.ok, false)
    assert.equal(early.code, 'TOO_EARLY_FOR_NO_SHOW')
    const soonRow = `[data-testid="booking-${soon.data.bookingId}"]`
    clickButton('Refresh')
    await waitFor(`!!document.querySelector(${JSON.stringify(soonRow)})`, { what: 'the later booking on today' })
    assert.equal(/Did not attend/.test(textOf(soonRow)), false, 'the control is not offered early')

    const line = `[data-testid=no-show-review] [data-testid="list-booking-${bookingId}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(line)})`, { what: 'the booking on No-show review' })
    const statusOf = async (id) => (await bookingsOf(P.noShow.id)).find((row) => row.id === id)?.status
    assert.equal(await statusOf(bookingId), 'booked', 'fifty minutes on, still only booked')

    clickWithin(line, 'Did not attend')
    await waitFor(`!!document.querySelector('[data-testid=dialog-no_show]')`, { what: 'the no-show dialog' })
    assert.match(textOf('[data-testid=dialog-no_show]'), /Nothing records a no-show by itself/)
    fillField('Note', 'Phone switched off')
    clickWithin('[role=dialog]', 'Record did not attend')
    await resultShows('Recorded as not attended')
    await dismissResult()

    assert.equal(await statusOf(bookingId), 'no_show')
    assert.equal(await statusOf(soon.data.bookingId), 'booked', 'the later booking is untouched')
    assert.equal((await arrivalsOf(P.noShow.id)).length, 0)
    // Out of the way of the later journeys that book today: a nurse cannot
    // overbook, and this slot was only here to be too early.
    await must(staff.nurse, 'cancel_appointment', { bookingId: soon.data.bookingId, reason: 'Journey finished' })
    await waitFor(`!document.querySelector(${JSON.stringify(line)})`, { what: 'the review list to drop it' })
    const [event] = await query(
      `select e.reason, s.name from jmc.appointment_events e join jmc.staff s on s.id = e.actor_id
        where e.booking_id = $1 and e.event = 'no_show'`, [bookingId])
    assert.equal(event.name, NURSE.name, 'the actor is recorded')
    assert.equal(event.reason, 'Phone switched off')
  })
})

describe('who may override, and who may not', () => {
  test('a nurse outside published hours is refused, is offered no override, and nothing is booked', async () => {
    setViewport(LANDSCAPE)
    await openBook(NURSE)
    await bookThroughForm({
      who: P.refused, at: `${day.tomorrow}T15:00`, reason: 'Afternoon please', doctorId: staff.owner.id,
    })
    await waitFor(`!!document.querySelector('[data-testid=appointment-refused]')`, { what: 'the refusal' })
    const said = textOf('[data-testid=appointment-refused]')
    assert.match(said, /outside the hours the doctor has published/)
    assert.match(said, /A nurse cannot override this/)
    assert.equal(exists('[data-testid=override-dialog]'), false, 'no reason is asked of a nurse')
    assert.equal((await bookingsOf(P.refused.id)).length, 0)

    // At the server, not only on the screen: a reason sent anyway does not help.
    const forced = await command(staff.nurse, 'book_appointment', {
      patientId: P.refused.id, reason: 'Afternoon please', scheduledAt: `${day.tomorrow}T15:00`,
      doctorId: staff.owner.id, overrideReason: 'I insist',
    })
    assert.equal(forced.ok, false)
    assert.equal(forced.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
    assert.equal((await bookingsOf(P.refused.id)).length, 0)
  })

  test('a doctor outside their hours is asked why, and the same reference carries the reason', async () => {
    setViewport(LANDSCAPE)
    await openBook(DOCTOR_ONLY)
    armLine({})
    // The doctor-only account has published no hours, so every time is outside
    // them; she books herself, which is the server's own default for a doctor.
    await bookThroughForm({ who: P.doctorOverride, at: `${day.tomorrow}T10:30`, reason: 'Suture removal' })
    await waitFor(`!!document.querySelector('[data-testid=override-dialog]')`, { what: 'the override question' })
    assert.match(textOf('[data-testid=override-dialog]'), /outside the published hours/)
    assert.equal((await bookingsOf(P.doctorOverride.id)).length, 0, 'asking spent nothing')

    fillField('Why this appointment goes here', 'Only day the patient can travel')
    clickButton('Book with this reason')
    const result = await resultShows('Appointment booked')
    assert.match(result, /outside the published hours, reason recorded/)
    await dismissResult()

    const [booking] = await bookingsOf(P.doctorOverride.id)
    assert.equal(booking.outside_availability, true)
    assert.equal(booking.overbooked_reason, 'Only day the patient can travel')
    const keys = sentKeys('book_appointment')
    assert.equal(keys.length, 2, 'asked, then answered')
    assert.equal(keys[0], keys[1], 'the refusal consumed nothing, so the answer went under the same reference')
    assert.equal(booking.idempotency_key, keys[0])

    // The day shown follows the booking, so its evidence is already on screen.
    const row = `[data-testid="booking-${booking.id}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(row)})`, { what: 'the override on the booked day' })
    assert.match(textOf(row), /Outside published hours/)
    assert.match(textOf(row), /Override reason: Only day the patient can travel/)
  })

  test('an administrator overbooking a taken slot gives a reason, and the booking says overbooked', async () => {
    setViewport(LANDSCAPE)
    await must(staff.nurse, 'book_appointment', {
      patientId: P.longName.id, reason: 'Review', scheduledAt: `${day.tomorrow}T12:00`, doctorId: staff.owner.id,
    })
    await openBook(ADMIN_ONLY)
    await bookThroughForm({
      who: P.adminOverride, at: `${day.tomorrow}T12:00`, reason: 'Relative of staff', doctorId: staff.owner.id,
    })
    await waitFor(`!!document.querySelector('[data-testid=override-dialog]')`, { what: 'the override question' })
    assert.match(textOf('[data-testid=override-dialog]'), /already has that time/)
    fillField('Why this appointment goes here', 'Two-minute prescription renewal')
    clickButton('Book with this reason')
    await resultShows('Appointment booked')
    await dismissResult()

    const [booking] = await bookingsOf(P.adminOverride.id)
    assert.equal(booking.overbooked, true)
    assert.equal(booking.overbooked_reason, 'Two-minute prescription renewal')
  })

  test('pharmacy has no appointment station, and the reads and commands refuse it at the server', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    const stations = await allStations()
    assert.equal(stations.some((label) => label.toLowerCase().startsWith('appointments')), false, stations.join(', '))

    const calendar = await read(staff.pharmacist, `workspace?view=calendar&from=${day.today}`)
    assert.equal(calendar.status, 403)
    const history = await read(staff.pharmacist, `workspace?view=appointments&patientId=${P.booked.id}`)
    assert.equal(history.status, 403)
    const outcome = await read(staff.pharmacist, `workspace?view=appointment_outcome&key=${randomUUID()}`)
    assert.equal(outcome.status, 403)
    const list = await read(staff.pharmacist, 'workspace?view=list&list=list.appointments_today')
    assert.equal(list.status, 403)

    const booked = await command(staff.pharmacist, 'book_appointment', {
      patientId: P.refused.id, reason: 'Counter', scheduledAt: `${day.tomorrow}T10:00`, doctorId: staff.owner.id,
    })
    assert.equal(booked.ok, false)
    assert.equal((await bookingsOf(P.refused.id)).length, 0)
  })
})

describe('the reply that never came back', () => {
  test('a lost reply is retried under one reference and books once', async () => {
    setViewport(LANDSCAPE)
    await openBook(NURSE)
    armLine({ swallow: true })
    await bookThroughForm({
      who: P.lost, at: `${day.tomorrow}T09:30`, reason: 'Chest tightness on stairs', doctorId: staff.owner.id,
    })
    await waitFor(`!!document.querySelector('[data-testid=appointment-outcome-unknown]')`, {
      what: 'the outcome to be reported as not confirmed', timeout: 20_000,
    })
    assert.equal(exists('[data-testid=result-overlay]'), false, 'no success is shown for a reply that never came')
    assert.equal((await bookingsOf(P.lost.id)).length, 1, 'it did reach the clinic')

    // What the tab holds is identifiers. Nothing a patient would recognise.
    const notes = heldNotes()
    assert.equal(notes.length, 1)
    for (const note of notes) {
      assert.equal(note.includes('Chest tightness'), false, 'no clinical reason in browser storage')
      assert.equal(note.includes(P.lost.name), false, 'no patient name in browser storage')
      assert.equal(note.includes('09:30'), false, 'no appointment time in browser storage')
    }
    assert.match(textOf('[data-testid=book-appointment] [data-testid=book-patient]'), /Venkatalakshmi/)
    // The form is kept, and the button waits for a check.
    assert.equal(
      evaluate(`[...document.querySelectorAll('[data-testid=book-appointment] button')].find(b => b.innerText.includes('Book appointment'))?.getAttribute('aria-disabled')`)
        .includes('true'),
      true,
      'Book appointment waits until the last attempt has been checked',
    )

    armLine({})
    clickWithin('[data-testid=appointment-outcome-unknown]', 'Send the same request again')
    const result = await resultShows('Appointment booked')
    assert.match(result, /already been recorded; nothing was done twice/)
    await dismissResult()

    const keys = sentKeys('book_appointment')
    assert.equal(keys.length, 2)
    assert.equal(keys[0], keys[1], 'the retry went under the same reference')
    assert.equal((await bookingsOf(P.lost.id)).length, 1, 'one booking')
    assert.equal((await receiptsOf(P.lost.id)).length, 1, 'one receipt')
    assert.deepEqual(heldNotes(), [], 'confirmed, so the reference is let go')
  })

  test('after a reload the tablet asks what its reference did, and does not do it again', async () => {
    setViewport(PORTRAIT)
    await openBook(NURSE)
    armLine({ swallow: true })
    await bookThroughForm({
      who: P.reloaded, at: `${day.tomorrow}T10:45`, reason: 'Thyroid follow-up', doctorId: staff.owner.id,
    })
    await waitFor(`!!document.querySelector('[data-testid=appointment-outcome-unknown]')`, {
      what: 'outcome not confirmed', timeout: 20_000,
    })
    assert.equal(heldNotes().length, 1)

    await reloadTablet()
    await goToStation('Appointments')
    await waitFor(`!!document.querySelector('[data-testid=appointment-recovered]')`, {
      what: 'the recovered outcome', timeout: 20_000,
    })
    const said = textOf('[data-testid=appointment-recovered]')
    assert.match(said, /Appt Reloaded Tablet/, 'named from the register the tablet already holds')
    assert.match(said, /the clinic recorded it/)
    assert.match(said, /Booked for/)
    assert.equal((await bookingsOf(P.reloaded.id)).length, 1, 'one booking')
    assert.deepEqual(heldNotes(), [], 'settled by the clinic’s answer, not by the reload')
  })

  test('a replayed check-in that has since been undone shows its token AND that the patient is not in the queue', async () => {
    setViewport(LANDSCAPE)
    const booked = await must(staff.nurse, 'book_appointment', {
      patientId: P.superseded.id, reason: 'Dizziness', scheduledAt: await laterToday(20), doctorId: staff.owner.id,
    })
    const bookingId = booked.data.bookingId
    await openBook(NURSE)
    const line = `[data-testid=expected-today] [data-testid="list-booking-${bookingId}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(line)})`, { what: 'the booking on Expected today' })

    armLine({ swallow: true })
    clickWithin(line, 'Check in')
    await waitFor(`!!document.querySelector('[data-testid=appointment-outcome-unknown]')`, {
      what: 'the check-in reported as not confirmed', timeout: 20_000,
    })
    const [arrival] = await arrivalsOf(P.superseded.id)
    assert.ok(arrival, 'the check-in did commit')

    // Meanwhile the doctor moves the appointment, which takes that visit out
    // of the queue.
    await must(staff.owner, 'reschedule_appointment', {
      bookingId, scheduledAt: `${day.tomorrow}T09:15`, reason: 'Needs a fasting sample',
    })

    armLine({})
    clickWithin('[data-testid=appointment-outcome-unknown]', 'Send the same request again')
    const result = await resultShows('since changed')
    assert.ok(result.includes(arrival.token), `the original token ${arrival.token} is named`)
    assert.match(result, /not in the queue under/)
    await dismissResult()

    // And it stays said after the overlay has gone.
    await waitFor(`!!document.querySelector('[data-testid=appointment-recovered]')`, { what: 'the durable notice' })
    const durable = textOf('[data-testid=appointment-recovered]')
    assert.ok(durable.includes(arrival.token))
    assert.match(durable, /Since then/)
    assert.match(durable, /not in the queue under/)

    const arrivals = await arrivalsOf(P.superseded.id)
    assert.equal(arrivals.length, 1, 'the retry minted no second token')
    assert.equal(arrivals[0].status, 'cancelled')
    assert.equal((await bookingsOf(P.superseded.id))[0].status, 'booked')
    const keys = sentKeys('check_in_appointment')
    assert.equal(keys[0], keys[1])

    await goToStation('Today')
    assert.equal(exists(`[data-testid="queue-row-${P.superseded.id}"]`), false, 'not drawn in the live queue')
  })
})

describe('slow, unavailable, and without a mouse', () => {
  test('a slow read says it is still reading; an unreachable one says so and recovers', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    armLine({ slowReads: 6000 })
    await goToStation('Appointments')
    await waitFor(`(document.querySelector('main')?.innerText ?? '').includes('Still reading')`, {
      what: 'the slow-read message', timeout: 12_000,
    })
    await waitFor(`!!document.querySelector('[data-testid=published-hours]')`, { what: 'the slow read to land', timeout: 20_000 })

    armLine({ readsDown: true })
    clickButton('Next day')
    await waitFor(`!!document.querySelector('[data-testid=read-failed]')`, { what: 'the read failure', timeout: 20_000 })
    assert.match(textOf('[data-testid=appointment-day]'), /not reachable/)
    assert.equal(exists('[data-testid=appointment-day] [aria-label="Bookings"]'), false, 'no stale day under a new heading')

    // The lists already read stay on screen, marked as possibly out of date.
    clickButton('Refresh')
    await waitFor(`!!document.querySelector('[data-testid=read-stale]')`, { what: 'the stale-read notice' })
    assert.match(textOf('[data-testid=read-stale]'), /may be out of date/)

    armLine({})
    clickWithin('[data-testid=appointment-day]', 'Try again')
    await waitFor(`!!document.querySelector('[data-testid=appointment-day] [data-testid=published-hours]')`, {
      what: 'the day after the clinic came back',
    })
  })

  test('a command that never leaves the tablet is unknown, is checked, and is then sent once', async () => {
    setViewport(PORTRAIT)
    const booked = await must(staff.nurse, 'book_appointment', {
      patientId: P.offline.id, reason: 'Cough', scheduledAt: await laterToday(25), doctorId: staff.owner.id,
    })
    const bookingId = booked.data.bookingId
    await openBook(NURSE)
    const line = `[data-testid=expected-today] [data-testid="list-booking-${bookingId}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(line)})`, { what: 'the booking on Expected today' })

    armLine({ cut: true, readsDown: true })
    clickWithin(line, 'Check in')
    await waitFor(`!!document.querySelector('[data-testid=appointment-outcome-unknown]')`, { what: 'not confirmed' })
    assert.equal((await arrivalsOf(P.offline.id)).length, 0)

    // Asking while the clinic is still away is a failed question, not an answer.
    clickWithin('[data-testid=appointment-outcome-unknown]', 'Check what happened')
    await waitFor(`!!document.querySelector('[data-testid=appointment-check_failed]')`, { what: 'the failed check' })

    armLine({})
    clickWithin('[data-testid=appointment-check_failed]', 'Check what happened')
    await waitFor(`!!document.querySelector('[data-testid=appointment-not_committed]')`, { what: 'nothing recorded' })
    clickWithin('[data-testid=appointment-not_committed]', 'Send the same request again')
    await resultShows('Checked in')
    await dismissResult()

    assert.equal((await arrivalsOf(P.offline.id)).length, 1, 'one queue row')
    const keys = sentKeys('check_in_appointment')
    assert.equal(keys.length, 2)
    assert.equal(keys[0], keys[1], 'the send after the check reused the reference')
  })

  test('the keyboard reaches a booking’s history; Escape closes it and focus comes back', async () => {
    setViewport(LANDSCAPE)
    await openBook(NURSE)
    // Real Tab presses from the top of the station until a History control
    // has focus — the tab ORDER is what is under test, not focus().
    evaluate(`(() => { document.querySelector('main h1, main h2')?.setAttribute('tabindex', '-1'); document.querySelector('main h1, main h2')?.focus(); return 'ok' })()`)
    let reached = ''
    for (let press = 0; press < 80 && !reached; press += 1) {
      ab(['press', 'Tab'])
      const focused = evaluate(`(document.activeElement?.innerText ?? '').trim()`)
      if (focused.includes('History')) reached = focused
    }
    assert.ok(reached, 'Tab reaches a History control')
    ab(['press', 'Enter'])
    await waitFor(`!!document.querySelector('[data-testid=appointment-history]')`, { what: 'the drawer by keyboard' })
    assert.equal(
      evaluate(`!!document.activeElement?.closest('[role=dialog]')`).includes('true'),
      true,
      'focus moves into the drawer',
    )
    ab(['press', 'Escape'])
    await waitFor(`!document.querySelector('[data-testid=appointment-history]')`, { what: 'Escape to close it' })
    assert.match(evaluate(`(document.activeElement?.innerText ?? '').trim()`), /History/, 'focus returns to what opened it')
  })
})

describe('every shape the plan names', () => {
  for (const shape of EVERY_SHAPE) {
    test(`no sideways scroll and no control under 44px — ${shape.name}`, async () => {
      setViewport(shape)
      await openBook(NURSE)
      await waitFor(`!!document.querySelector('[data-testid=expected-today] ul, [data-testid=expected-today] p')`, {
        what: 'expected today',
      })
      const overflow = Number(evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`))
      assert.ok(overflow <= 1, `${shape.name} scrolls sideways by ${overflow}px`)

      const tooSmall = evaluate(`(() => {
        const small = [...document.querySelectorAll('main button, main input, main select')]
          .filter(b => b.offsetParent !== null)
          .map(b => ({ label: (b.innerText || b.getAttribute('aria-label') || b.type || '?').trim().slice(0, 24),
                       h: Math.round(b.getBoundingClientRect().height) }))
          .filter(b => b.h > 0 && b.h < 44)
        return JSON.stringify(small.slice(0, 6))
      })()`)
      assert.equal(tooSmall.includes('[]'), true, `controls under 44px in ${shape.name}: ${tooSmall}`)
    })
  }
})
