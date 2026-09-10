/**
 * Sign-in.
 *
 * Written in Slice 0 as characterization — a record of what the clinic did
 * before anything was touched — and updated in Slice 1, which cut the PIN
 * from six digits to four. The diff between those two versions is the whole
 * behavioural change, which is why it was worth writing them first.
 *
 * What did NOT change is the more important half, and it is asserted here
 * exactly as it was: wrong attempts throttled and charged to the caller
 * rather than the account, a generic refusal that does not say which part was
 * wrong, a thirty-minute idle expiry, sessions revoked on reset, and a lock
 * screen that gives away nothing useful. Four digits is only defensible while
 * every one of those holds; each is a test that Slice 1 had to keep passing.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { auth } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar } from '../support/clinic.mjs'

// One teardown for the file. A per-describe `after` closes the shared reset
// connection while the next describe still needs it.
after(async () => { await closeClinic() })

describe('sign-in', () => {
  test('a correct PIN returns a token and a session view', async () => {
    await resetClinic()
    const doctor = await makeStaff({ name: 'Dr Test', roles: ['doctor'], pin: '4829' })

    const result = await auth.createSession(doctor.id, '4829', 'caller-a')

    assert.ok('token' in result, `expected a token, got ${JSON.stringify(result)}`)
    assert.equal(result.session.staffId, doctor.id)
    assert.deepEqual(result.session.roles, ['doctor'])

    // The raw token is never stored; only its hash.
    assert.equal(await scalar('select count(*)::int from jmc.sessions'), 1)
    assert.notEqual(await scalar('select token_hash from jmc.sessions'), result.token)
  })

  test('a wrong PIN is refused generically, without saying which part was wrong', async () => {
    await resetClinic()
    const nurse = await makeStaff({ name: 'Nurse Test', roles: ['nurse'], pin: '4829' })

    const wrongPin = await auth.createSession(nurse.id, '4830', 'caller-b')
    const noSuchStaff = await auth.createSession('staff-does-not-exist', '4829', 'caller-c')

    // The same refusal for both. A different answer for "no such staff" would
    // turn the lock screen into a way to enumerate who works here.
    assert.deepEqual(wrongPin, { reason: 'wrong' })
    assert.deepEqual(noSuchStaff, { reason: 'wrong' })
  })

  test('throttling is charged to the caller, not to the account', async () => {
    await resetClinic()
    const doctor = await makeStaff({ name: 'Dr Test', roles: ['doctor'], pin: '4829' })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await auth.createSession(doctor.id, '0001', 'attacker'), { reason: 'wrong' })
    }

    assert.deepEqual(
      await auth.createSession(doctor.id, '0001', 'attacker'),
      { reason: 'locked', minutes: 15 },
    )

    // The doctor is NOT locked out. This is the whole point of charging the
    // caller: anyone who can see the staff list could otherwise lock the
    // clinic's only doctor out of his own clinic from the waiting room.
    const stillWorks = await auth.createSession(doctor.id, '4829', 'the-doctors-tablet')
    assert.ok('token' in stillWorks, 'the account itself must not be locked')
  })

  test('a clean sign-in clears that caller’s failed attempts', async () => {
    await resetClinic()
    const doctor = await makeStaff({ pin: '4829', roles: ['doctor'] })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await auth.createSession(doctor.id, '0001', 'shared-tablet')
    }
    assert.equal(await scalar(`select count(*)::int from jmc.pin_attempts where caller='shared-tablet'`), 4)

    await auth.createSession(doctor.id, '4829', 'shared-tablet')
    assert.equal(await scalar(`select count(*)::int from jmc.pin_attempts where caller='shared-tablet'`), 0)
  })

  test('a failed attempt against an unknown staff id is still recorded', async () => {
    await resetClinic()
    await auth.createSession('no-such-staff', '4829', 'guessing-ids')

    // staff_id is null, caller is not. Guessing ids is rate-limited on exactly
    // the same budget as guessing PINs.
    const [attempt] = await rows(`select staff_id, caller from jmc.pin_attempts`)
    assert.equal(attempt.staff_id, null)
    assert.equal(attempt.caller, 'guessing-ids')
  })

  test('an inactive staff member cannot sign in with the right PIN', async () => {
    await resetClinic()
    const gone = await makeStaff({ name: 'Left The Clinic', pin: '4829', active: false })
    assert.deepEqual(await auth.createSession(gone.id, '4829', 'caller-d'), { reason: 'wrong' })
  })

  test('the session expires on idle and the row is deleted when it is presented', async () => {
    await resetClinic()
    const doctor = await makeStaff({ pin: '4829', roles: ['doctor'] })
    const signedIn = await auth.createSession(doctor.id, '4829', 'caller-e')

    assert.ok(await auth.getSession(signedIn.token))

    // Age the session past its 30-minute idle window. expires_at is TEXT and
    // compared as a string, which works only because both sides are ISO-8601
    // UTC of the same width — recorded here because it is a real constraint on
    // any later change to how times are stored.
    await rows(`update jmc.sessions set expires_at = $1`, [new Date(Date.now() - 1000).toISOString()])

    assert.equal(await auth.getSession(signedIn.token), null)
    assert.equal(await scalar('select count(*)::int from jmc.sessions'), 0)
  })

  test('the lock screen lists active staff, and nothing that helps guess a PIN', async () => {
    await resetClinic()
    await makeStaff({ name: 'Anita Doctor', roles: ['doctor'], pin: '4829' })
    await makeStaff({ name: 'Zahra Nurse', roles: ['nurse'], pin: '5713' })
    await makeStaff({ name: 'Departed', roles: ['nurse'], pin: '5714', active: false })

    const listed = await auth.lockScreenStaff()

    assert.deepEqual(listed.map((entry) => entry.name), ['Anita Doctor', 'Zahra Nurse'])
    for (const entry of listed) {
      // `pinLength` joined this list in Slice 1 and is the only thing here
      // that is not simply a label — the pad submits on the last digit, so it
      // has to know whether there are four or six. That does disclose which
      // accounts have been migrated. The alternatives are a confirm button
      // for everybody, hundreds of times a day, or a pad that guesses; and
      // the length is something one attempt would reveal anyway.
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'pinLength', 'roles'])
      // Still nothing that helps guess the PIN itself.
      assert.equal('pinHash' in entry, false)
      assert.equal('phone' in entry, false)
      assert.equal('lastLogin' in entry, false)
    }
  })
})

describe('PIN policy — four digits', () => {
  const rejected = [
    ['482', 'three digits'],
    ['48291', 'five digits'],
    ['482913', 'six digits — the old length is no longer settable'],
    ['482a', 'a letter'],
    ['', 'nothing at all'],
    ['1111', 'the same digit four times'],
    ['1234', 'an ascending run'],
    ['4321', 'a descending run'],
    ['8901', 'an ascending run that wraps'],
    ['1098', 'a descending run that wraps'],
  ]

  for (const [pin, why] of rejected) {
    test(`create_staff refuses ${why}`, async () => {
      await resetClinic()
      const admin = await makeStaff({ roles: ['admin'], pin: '4829' })
      await assert.rejects(
        as(admin, 'create_staff', { name: 'New', username: 'new', roles: ['nurse'], pin }),
        /PIN/,
        `expected "${pin}" to be refused`,
      )
    })
  }

  test('create_staff accepts an ordinary four-digit PIN, and it signs in', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], pin: '4829' })
    await as(admin, 'create_staff', {
      name: 'New Nurse', username: 'newnurse', roles: ['nurse'], pin: '5731',
    })

    const created = await scalar(`select id from jmc.staff where username='newnurse'`)
    assert.ok(created)
    assert.ok('token' in (await auth.createSession(String(created), '5731', 'caller-f')))
  })

  test('a new account is marked four, never legacy', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], pin: '4829' })
    await as(admin, 'create_staff', {
      name: 'New Nurse', username: 'newnurse', roles: ['nurse'], pin: '5731',
    })

    // Named in the insert rather than left to the column default. A PIN
    // written by one statement and its length recorded by another is the pair
    // that drifts, and drifting here means somebody cannot sign in.
    assert.equal(await scalar(`select pin_format from jmc.staff where username='newnurse'`), 'four')
  })

  test('set_staff_pin replaces the PIN and revokes that staff member’s sessions', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], pin: '4829' })
    const nurse = await makeStaff({ roles: ['nurse'], pin: '5731' })

    const before = await auth.createSession(nurse.id, '5731', 'nurse-tablet')
    assert.ok('token' in before)
    assert.equal(await scalar(`select count(*)::int from jmc.sessions where staff_id=$1`, [nurse.id]), 1)

    await as(admin, 'set_staff_pin', { staffId: nurse.id, pin: '6182' })

    assert.equal(await auth.getSession(before.token), null, 'the old token must be dead')
    assert.deepEqual(await auth.createSession(nurse.id, '5731', 'caller-g'), { reason: 'wrong' })
    assert.ok('token' in (await auth.createSession(nurse.id, '6182', 'caller-h')))
  })

  test('only an admin may set another staff member’s PIN', async () => {
    await resetClinic()
    const nurse = await makeStaff({ roles: ['nurse'], pin: '5731' })
    const doctor = await makeStaff({ roles: ['doctor'], pin: '4829' })
    await assert.rejects(
      as(doctor, 'set_staff_pin', { staffId: nurse.id, pin: '6182' }),
      /role cannot perform/,
    )
  })
})

describe('the two-stage PIN migration', () => {
  test('a staff member not yet reset still signs in with their six-digit PIN', async () => {
    await resetClinic()
    const nurse = await makeStaff({ roles: ['nurse'], pin: '730514' })

    assert.equal(nurse.pinFormat, 'legacy_six')
    assert.ok(
      'token' in (await auth.createSession(nurse.id, '730514', 'nurse-tablet')),
      'the clinic must keep working while the resets are being done',
    )
  })

  test('a six-digit account refuses a four-digit attempt, and the reverse', async () => {
    await resetClinic()
    const legacy = await makeStaff({ roles: ['nurse'], username: 'legacy', pin: '730514' })
    const migrated = await makeStaff({ roles: ['nurse'], username: 'migrated', pin: '4829' })

    // Accepting either length from everybody would halve the search space for
    // every account at once, including the ones already reset.
    assert.deepEqual(await auth.createSession(legacy.id, '7305', 'caller-i'), { reason: 'wrong' })
    assert.deepEqual(await auth.createSession(migrated.id, '482913', 'caller-j'), { reason: 'wrong' })
  })

  test('a wrong-length attempt is refused generically and still costs an attempt', async () => {
    await resetClinic()
    const migrated = await makeStaff({ roles: ['nurse'], pin: '4829' })

    // Identical answer to a wrong PIN — the lock screen must not become a way
    // to learn which accounts have been migrated by reading error text.
    assert.deepEqual(await auth.createSession(migrated.id, '482913', 'prober'), { reason: 'wrong' })
    assert.equal(await scalar(`select count(*)::int from jmc.pin_attempts where caller='prober'`), 1)
  })

  test('the lock screen tells the pad how many digits to expect', async () => {
    await resetClinic()
    await makeStaff({ name: 'Already Reset', roles: ['nurse'], username: 'a', pin: '4829' })
    await makeStaff({ name: 'Been Put Off', roles: ['nurse'], username: 'b', pin: '730514' })

    const listed = await auth.lockScreenStaff()
    assert.deepEqual(
      listed.map((entry) => [entry.name, entry.pinLength]),
      [['Already Reset', 4], ['Been Put Off', 6]],
    )
    // And still nothing else. The list is unauthenticated.
    for (const entry of listed) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'pinLength', 'roles'])
    }
  })

  test('resetting a staff member moves them off the legacy count', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], username: 'admin', pin: '4829' })
    const nurse = await makeStaff({ roles: ['nurse'], username: 'nurse', pin: '730514' })
    const pharmacist = await makeStaff({ roles: ['pharmacy'], username: 'pharm', pin: '268137' })

    assert.equal(await auth.legacyPinCount(), 2)

    await as(admin, 'set_staff_pin', { staffId: nurse.id, pin: '7305' })
    assert.equal(await auth.legacyPinCount(), 1)
    assert.equal(await scalar('select pin_format from jmc.staff where id=$1', [nurse.id]), 'four')
    assert.ok('token' in (await auth.createSession(nurse.id, '7305', 'nurse-tablet')))

    await as(admin, 'set_staff_pin', { staffId: pharmacist.id, pin: '2681' })
    assert.equal(await auth.legacyPinCount(), 0, 'zero is the gate that lets six-digit support be removed')
  })

  test('an inactive staff member does not hold the migration open', async () => {
    await resetClinic()
    await makeStaff({ roles: ['nurse'], username: 'gone', pin: '357046', active: false })

    // Somebody who has left cannot be sat down and reset, and counting them
    // would mean the gate never reaches zero.
    assert.equal(await auth.legacyPinCount(), 0)
  })

  test('the admin can reset themselves, and is signed out by doing it', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], username: 'admin', pin: '482913' })

    const before = await auth.createSession(admin.id, '482913', 'admin-tablet')
    assert.ok('token' in before)

    // The last step of the clinic's reset runbook: everybody else first, self
    // last. The session that authorised this command dies with it.
    const result = await as(admin, 'set_staff_pin', { staffId: admin.id, pin: '9052' })
    assert.match(result.message, /signed out/)

    assert.equal(await auth.getSession(before.token), null)
    assert.deepEqual(await auth.createSession(admin.id, '482913', 'caller-k'), { reason: 'wrong' })
    assert.ok(
      'token' in (await auth.createSession(admin.id, '9052', 'admin-tablet')),
      'and can sign straight back in to check it worked',
    )
    assert.equal(await auth.legacyPinCount(), 0)
  })

  test('the reset is audited against the admin who did it', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], username: 'admin', pin: '4829' })
    const nurse = await makeStaff({ roles: ['nurse'], username: 'nurse', pin: '730514' })

    await as(admin, 'set_staff_pin', { staffId: nurse.id, pin: '7305' })
    await as(admin, 'set_staff_pin', { staffId: admin.id, pin: '9052' })

    const events = await rows(
      `select actor_id, entity_id, summary from jmc.audit_events
        where action='staff.pin_set' order by created_at`,
    )
    assert.equal(events.length, 2)
    assert.equal(events[0].actor_id, admin.id)
    assert.equal(events[0].entity_id, nurse.id)
    assert.match(events[1].summary, /their own/)
  })
})
