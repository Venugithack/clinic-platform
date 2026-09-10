/**
 * Sign-in, as it behaves today.
 *
 * These are characterization tests: they record what the clinic currently
 * does, not what it should do. Slice 1 changes the PIN from six digits to
 * four, and the value of writing these first is that the diff to this file
 * afterwards is the exact behavioural change — including the safeguards that
 * must NOT move. Every assertion about throttling, revocation, idle expiry and
 * generic errors is one Slice 1 has to keep passing.
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
    const doctor = await makeStaff({ name: 'Dr Test', roles: ['doctor'], pin: '482913' })

    const result = await auth.createSession(doctor.id, '482913', 'caller-a')

    assert.ok('token' in result, `expected a token, got ${JSON.stringify(result)}`)
    assert.equal(result.session.staffId, doctor.id)
    assert.deepEqual(result.session.roles, ['doctor'])

    // The raw token is never stored; only its hash.
    assert.equal(await scalar('select count(*)::int from jmc.sessions'), 1)
    assert.notEqual(await scalar('select token_hash from jmc.sessions'), result.token)
  })

  test('a wrong PIN is refused generically, without saying which part was wrong', async () => {
    await resetClinic()
    const nurse = await makeStaff({ name: 'Nurse Test', roles: ['nurse'], pin: '482913' })

    const wrongPin = await auth.createSession(nurse.id, '482914', 'caller-b')
    const noSuchStaff = await auth.createSession('staff-does-not-exist', '482913', 'caller-c')

    // The same refusal for both. A different answer for "no such staff" would
    // turn the lock screen into a way to enumerate who works here.
    assert.deepEqual(wrongPin, { reason: 'wrong' })
    assert.deepEqual(noSuchStaff, { reason: 'wrong' })
  })

  test('throttling is charged to the caller, not to the account', async () => {
    await resetClinic()
    const doctor = await makeStaff({ name: 'Dr Test', roles: ['doctor'], pin: '482913' })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await auth.createSession(doctor.id, '000001', 'attacker'), { reason: 'wrong' })
    }

    assert.deepEqual(
      await auth.createSession(doctor.id, '000001', 'attacker'),
      { reason: 'locked', minutes: 15 },
    )

    // The doctor is NOT locked out. This is the whole point of charging the
    // caller: anyone who can see the staff list could otherwise lock the
    // clinic's only doctor out of his own clinic from the waiting room.
    const stillWorks = await auth.createSession(doctor.id, '482913', 'the-doctors-tablet')
    assert.ok('token' in stillWorks, 'the account itself must not be locked')
  })

  test('a clean sign-in clears that caller’s failed attempts', async () => {
    await resetClinic()
    const doctor = await makeStaff({ pin: '482913', roles: ['doctor'] })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await auth.createSession(doctor.id, '000001', 'shared-tablet')
    }
    assert.equal(await scalar(`select count(*)::int from jmc.pin_attempts where caller='shared-tablet'`), 4)

    await auth.createSession(doctor.id, '482913', 'shared-tablet')
    assert.equal(await scalar(`select count(*)::int from jmc.pin_attempts where caller='shared-tablet'`), 0)
  })

  test('a failed attempt against an unknown staff id is still recorded', async () => {
    await resetClinic()
    await auth.createSession('no-such-staff', '482913', 'guessing-ids')

    // staff_id is null, caller is not. Guessing ids is rate-limited on exactly
    // the same budget as guessing PINs.
    const [attempt] = await rows(`select staff_id, caller from jmc.pin_attempts`)
    assert.equal(attempt.staff_id, null)
    assert.equal(attempt.caller, 'guessing-ids')
  })

  test('an inactive staff member cannot sign in with the right PIN', async () => {
    await resetClinic()
    const gone = await makeStaff({ name: 'Left The Clinic', pin: '482913', active: false })
    assert.deepEqual(await auth.createSession(gone.id, '482913', 'caller-d'), { reason: 'wrong' })
  })

  test('the session expires on idle and the row is deleted when it is presented', async () => {
    await resetClinic()
    const doctor = await makeStaff({ pin: '482913', roles: ['doctor'] })
    const signedIn = await auth.createSession(doctor.id, '482913', 'caller-e')

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
    await makeStaff({ name: 'Anita Doctor', roles: ['doctor'], pin: '482913' })
    await makeStaff({ name: 'Zahra Nurse', roles: ['nurse'], pin: '571304' })
    await makeStaff({ name: 'Departed', roles: ['nurse'], pin: '571305', active: false })

    const listed = await auth.lockScreenStaff()

    assert.deepEqual(listed.map((entry) => entry.name), ['Anita Doctor', 'Zahra Nurse'])
    for (const entry of listed) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'roles'])
    }
  })
})

describe('PIN policy — six digits today; Slice 1 makes this four', () => {
  const rejected = [
    ['4829', 'four digits'],
    ['48291', 'five digits'],
    ['4829134', 'seven digits'],
    ['48291a', 'a letter'],
    ['', 'nothing at all'],
    ['111111', 'the same digit six times'],
    ['123456', 'an ascending run'],
    ['654321', 'a descending run'],
  ]

  for (const [pin, why] of rejected) {
    test(`create_staff refuses ${why}`, async () => {
      await resetClinic()
      const admin = await makeStaff({ roles: ['admin'], pin: '482913' })
      await assert.rejects(
        as(admin, 'create_staff', { name: 'New', username: 'new', roles: ['nurse'], pin }),
        /PIN/,
        `expected "${pin}" to be refused`,
      )
    })
  }

  test('create_staff accepts an ordinary six-digit PIN, and it signs in', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], pin: '482913' })
    await as(admin, 'create_staff', {
      name: 'New Nurse', username: 'newnurse', roles: ['nurse'], pin: '573104',
    })

    const created = await scalar(`select id from jmc.staff where username='newnurse'`)
    assert.ok(created)
    assert.ok('token' in (await auth.createSession(String(created), '573104', 'caller-f')))
  })

  test('set_staff_pin replaces the PIN and revokes that staff member’s sessions', async () => {
    await resetClinic()
    const admin = await makeStaff({ roles: ['admin'], pin: '482913' })
    const nurse = await makeStaff({ roles: ['nurse'], pin: '573104' })

    const before = await auth.createSession(nurse.id, '573104', 'nurse-tablet')
    assert.ok('token' in before)
    assert.equal(await scalar(`select count(*)::int from jmc.sessions where staff_id=$1`, [nurse.id]), 1)

    await as(admin, 'set_staff_pin', { staffId: nurse.id, pin: '618205' })

    assert.equal(await auth.getSession(before.token), null, 'the old token must be dead')
    assert.deepEqual(await auth.createSession(nurse.id, '573104', 'caller-g'), { reason: 'wrong' })
    assert.ok('token' in (await auth.createSession(nurse.id, '618205', 'caller-h')))
  })

  test('only an admin may set another staff member’s PIN', async () => {
    await resetClinic()
    const nurse = await makeStaff({ roles: ['nurse'], pin: '573104' })
    const doctor = await makeStaff({ roles: ['doctor'], pin: '482913' })
    await assert.rejects(
      as(doctor, 'set_staff_pin', { staffId: nurse.id, pin: '618205' }),
      /role cannot perform/,
    )
  })
})
