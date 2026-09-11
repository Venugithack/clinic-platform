/**
 * Slice 1's exit gate, run rather than asserted in a report.
 *
 * The brief states it as: "every active user can sign in with an individual
 * four-digit PIN, legacy PIN count is zero, throttling works, reset revokes
 * sessions, and doctor-alone check-in works."
 *
 * The pieces are each covered in sign-in.test.mjs and roles-and-snapshot.test.mjs.
 * What is not covered there is the thing that actually goes wrong on the day:
 * the runbook as a sequence. Resetting six people one at a time, in an order,
 * ending with the administrator resetting themselves and being signed out by
 * their own command — that is where a clinic gets locked out of its own
 * software, and no unit test of `set_staff_pin` catches it.
 *
 * So this file rehearses the whole thing against the staging fixtures, which
 * sit deliberately mid-migration: two people already on four digits, four
 * still on six.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import { auth, snapshot, STAGING_DB_URL } from '../support/backend.mjs'
import { as, closeClinic, emptyClinic, scalar, sessionFor } from '../support/clinic.mjs'
import { seedClinic } from '../../scripts/staging/fixtures.mjs'
import { FIXTURE_PINS, FIXTURE_PIN_FORMATS, FIXTURE_STAFF } from '../../scripts/staging/fixtures.mjs'

after(async () => { await closeClinic() })

/**
 * The fixtures, not an empty clinic.
 *
 * Every other file here builds its own state so a failure names one cause.
 * This one is the opposite on purpose: the gate is about a real clinic with
 * real people in it, half-migrated, and the fixtures are the closest thing to
 * that which does not involve patient data.
 */
before(async () => {
  const admin = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
  try {
    await emptyClinic(admin)
    await admin.unsafe(`
      insert into jmc.clinic_revision (id, revision, changed_at)
      values (1, 0, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      on conflict (id) do update set revision = 0
    `)
    await seedClinic(admin)
  } finally {
    await admin.end({ timeout: 5 })
  }
})

/**
 * The four-digit PIN each person is given during the reset appointment.
 *
 * Every one of them differs from that person's fixture PIN, which is not
 * decoration: the runbook check below asserts that the old PIN stops working,
 * and a "new" PIN that happens to equal the old one passes the sign-in half
 * while quietly proving nothing. Two of these were truncations of the fixture
 * value on the first attempt and the test caught it.
 */
const NEW_PINS = {
  doctor: '3746',
  nurse: '5028',
  pharmacist: '2681',
  manager: '9052',
  relief: '6147',
}

describe('Slice 1 exit gate', () => {
  test('the clinic starts mid-migration, and keeps working that way', async () => {
    // Two reset, three active still on six digits, one inactive.
    assert.equal(await auth.legacyPinCount(), 3)

    for (const [key, staff] of Object.entries(FIXTURE_STAFF)) {
      if (!staff.active) continue
      const signedIn = await auth.createSession(staff.id, FIXTURE_PINS[key], `pre-${key}`)
      assert.ok(
        'token' in signedIn,
        `${staff.name} could not sign in with their ${FIXTURE_PIN_FORMATS[key]} PIN before the reset`,
      )
    }
  })

  test('the reset runbook: everyone else first, the administrator last', async () => {
    // Decision 2. Dr Anbarasan holds admin as well as doctor, so he is the
    // one who can run this; if the clinic had two admins they would reset
    // each other and nobody would have to reset themselves at all.
    const owner = FIXTURE_STAFF.doctor
    assert.ok(owner.roles.includes('admin'), 'the recovery administrator must actually hold admin')
    const ownerSession = sessionFor({ ...owner, id: owner.id })

    // Everyone else, in the order they would be sat down.
    for (const key of ['nurse', 'pharmacist', 'manager', 'relief']) {
      const staff = FIXTURE_STAFF[key]
      const result = await as({ ...owner }, 'set_staff_pin', { staffId: staff.id, pin: NEW_PINS[key] })
      assert.match(result.message, /New PIN saved/)

      // Verified with that person standing there, which is the whole reason
      // the runbook is in person.
      assert.ok(
        'token' in (await auth.createSession(staff.id, NEW_PINS[key], `reset-${key}`)),
        `${staff.name} could not sign in with their new PIN`,
      )
      // And the old one is dead.
      assert.deepEqual(
        await auth.createSession(staff.id, FIXTURE_PINS[key], `old-${key}`),
        { reason: 'wrong' },
      )
    }

    // The administrator, last, on an account that is already four digits —
    // Dr Anbarasan was one of the two seeded as migrated, so this is a
    // change rather than a migration. It still signs him out.
    const before = await auth.createSession(owner.id, FIXTURE_PINS.doctor, 'owner-tablet')
    assert.ok('token' in before)

    const selfReset = await as({ ...owner }, 'set_staff_pin', { staffId: owner.id, pin: NEW_PINS.doctor })
    assert.match(selfReset.message, /signed out/, 'the admin must be told they are about to be signed out')
    assert.equal(await auth.getSession(before.token), null, 'and actually be signed out')

    // Straight back in, before leaving the building.
    assert.ok('token' in (await auth.createSession(owner.id, NEW_PINS.doctor, 'owner-tablet')))
    void ownerSession
  })

  test('the legacy PIN count is zero — six-digit support may now be removed', async () => {
    assert.equal(
      await auth.legacyPinCount(),
      0,
      'this is the gate the brief names: do not remove six-digit compatibility before it reads zero',
    )
    assert.equal(
      await scalar(`select count(*)::int from jmc.staff where active=1 and pin_format <> 'four'`),
      0,
    )
  })

  test('every active staff member signs in with their own four-digit PIN', async () => {
    for (const [key, staff] of Object.entries(FIXTURE_STAFF)) {
      if (!staff.active) continue

      const signedIn = await auth.createSession(staff.id, NEW_PINS[key], `gate-${key}`)
      assert.ok('token' in signedIn, `${staff.name} cannot sign in`)
      // Individual attribution survives: the session names this person, not
      // a tablet and not a shared account.
      assert.equal(signedIn.session.staffId, staff.id)
      assert.deepEqual(signedIn.session.roles, staff.roles)
    }

    // Every PIN is different from every other. Four digits is only defensible
    // one-per-person; a shared PIN would make the audit trail a fiction.
    assert.equal(new Set(Object.values(NEW_PINS)).size, Object.keys(NEW_PINS).length)
  })

  test('the lock screen now asks everyone for four digits', async () => {
    const listed = await auth.lockScreenStaff()
    assert.equal(listed.length, 5)
    for (const entry of listed) {
      assert.equal(entry.pinLength, 4, `${entry.name} would still be shown a six-dot pad`)
    }
  })

  test('throttling still works, and still cannot lock a person out of their own clinic', async () => {
    const owner = FIXTURE_STAFF.doctor

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await auth.createSession(owner.id, '9999', 'waiting-room'), { reason: 'wrong' })
    }
    assert.deepEqual(
      await auth.createSession(owner.id, '9999', 'waiting-room'),
      { reason: 'locked', minutes: 15 },
    )

    // The doctor, on his own tablet, is unaffected. Shortening the PIN did
    // not change who the throttle is charged to, and that is the property
    // that makes four digits acceptable at all.
    assert.ok('token' in (await auth.createSession(owner.id, NEW_PINS.doctor, 'cabin-tablet')))
  })

  test('an admin can see how many resets are left; nobody else is told', async () => {
    const owner = FIXTURE_STAFF.doctor
    const nurse = FIXTURE_STAFF.nurse

    assert.equal((await snapshot.readSnapshot(sessionFor(owner))).legacyPinCount, 0)
    assert.equal((await snapshot.readSnapshot(sessionFor(nurse))).legacyPinCount, 0)

    // And the roster carries the format per person, so the queue is visible
    // rather than something an admin has to ask people about.
    const roster = (await snapshot.readSnapshot(sessionFor(owner))).staff
    assert.ok(roster.length >= 5)
    for (const member of roster) {
      assert.ok(member.pinFormat === 'four' || member.pinFormat === 'legacy_six')
    }
  })

  test('doctor-alone check-in, end to end, in one account', async () => {
    const owner = FIXTURE_STAFF.doctor

    // Find: nobody by this number.
    const search = await as({ ...owner }, 'find_possible_duplicates', {
      name: 'Walkin Patient', phone: '9990000123',
    })
    assert.deepEqual(search.data.matches, [])

    // Register.
    await as({ ...owner }, 'create_patient', {
      name: 'Walkin Patient', age: 41, sex: 'male', phone: '+999 9000 00123',
    })
    const patientId = String(await scalar(`select id from jmc.patients where name='Walkin Patient'`))

    // Today's visit and token.
    await as({ ...owner }, 'create_appointment', {
      patientId, reason: 'Chest pain', scheduledAt: new Date().toISOString(),
    })
    const appointment = String(await scalar('select id from jmc.appointments where patient_id=$1', [patientId]))
    assert.ok(appointment)

    // Vitals, with the ones he could not take left out rather than invented.
    await as({ ...owner }, 'add_vitals', {
      patientId, bp: '140/90', pulse: 92, temperature: 37.1,
      notMeasuredNote: 'No oximeter or scales in the cabin',
    })
    const vitals = (await snapshot.readPatientRecord(patientId)).vitals[0]
    assert.equal(vitals.pulse, 92)
    assert.equal(vitals.spo2, undefined)
    assert.equal(vitals.weight, undefined)

    // Consult, signed by the doctor, closing the visit.
    await as({ ...owner }, 'save_consultation', {
      patientId, appointmentId: appointment, diagnosis: 'Hypertension, uncontrolled',
      advice: 'Reduce salt; review in one week', consultationFee: 300,
    })
    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointment]), 'done')

    // And no borrowed login anywhere in it: every write is his.
    const actors = await scalar(
      `select count(distinct actor_id)::int from jmc.audit_events
        where entity_id in ($1, $2) or entity_id = (select id from jmc.encounters where patient_id=$1)`,
      [patientId, appointment],
    )
    assert.equal(Number(actors), 1, 'the whole visit must be attributed to one person — the doctor')
  })
})
