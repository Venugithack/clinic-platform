/**
 * Registering a patient who may already be here.
 *
 * `find_possible_duplicates` is deliberately a question and not an action. It
 * returns candidates; it never merges, never blocks, and never picks. The plan
 * is explicit that the clinic does not merge patient records automatically,
 * and the reason is worth stating: two histories joined by mistake cannot be
 * separated again afterwards, whereas a duplicate somebody created on purpose
 * is a tidying job. The asymmetry decides the design.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { as, closeClinic, makeStaff, resetClinic, scalar } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinicWithPatients() {
  await resetClinic()
  const nurse = await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '6182' })
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  const pharmacy = await makeStaff({ name: 'Counter', roles: ['pharmacy'], username: 'pharm', pin: '7048' })

  await as(nurse, 'create_patient', {
    name: 'Kamala Rajan', age: 52, sex: 'female', phone: '+91 98765 43210',
  })
  await as(nurse, 'create_patient', {
    name: 'Murugan Selvam', age: 34, sex: 'male', phone: '9876500011',
  })
  return { nurse, doctor, pharmacy }
}

const matchesOf = (result) => result.data.matches

describe('finding a patient who may already be registered', () => {
  test('the same phone number written three different ways finds the same person', async () => {
    const { nurse } = await clinicWithPatients()

    // Stored as '+91 98765 43210'. The doctor types it bare, the referral
    // slip has a leading zero, somebody else uses dashes. Matching those as
    // strings finds nothing, which is why this compares the last ten digits.
    for (const typed of ['9876543210', '098765 43210', '+91-98765-43210', '91 98765 43210']) {
      const found = matchesOf(await as(nurse, 'find_possible_duplicates', { phone: typed }))
      assert.equal(found.length, 1, `"${typed}" should have found the existing patient`)
      assert.equal(found[0].name, 'Kamala Rajan')
      assert.equal(found[0].matchedOn, 'phone')
    }
  })

  test('a name matches regardless of case and extra spacing', async () => {
    const { nurse } = await clinicWithPatients()

    for (const typed of ['kamala rajan', 'KAMALA RAJAN', 'Kamala   Rajan']) {
      const found = matchesOf(await as(nurse, 'find_possible_duplicates', { name: typed }))
      assert.equal(found.length, 1, `"${typed}" should have matched`)
      assert.equal(found[0].matchedOn, 'name')
    }
  })

  test('a match on the phone is reported as a phone match even when the name also matches', async () => {
    const { nurse } = await clinicWithPatients()

    const found = matchesOf(await as(nurse, 'find_possible_duplicates', {
      name: 'Kamala Rajan', phone: '9876543210',
    }))
    assert.equal(found.length, 1)
    // The stronger signal is named, so the screen can say why it is asking.
    assert.equal(found[0].matchedOn, 'phone')
  })

  test('a near age is flagged, so "same name, different person" is visible', async () => {
    const { nurse } = await clinicWithPatients()

    const sameAge = matchesOf(await as(nurse, 'find_possible_duplicates', { name: 'Kamala Rajan', age: 53 }))
    assert.equal(sameAge[0].ageMatches, true)

    const differentPerson = matchesOf(await as(nurse, 'find_possible_duplicates', { name: 'Kamala Rajan', age: 12 }))
    assert.equal(differentPerson[0].ageMatches, false, 'a 12-year-old is not the 52-year-old of the same name')
    // Still returned. Deciding is the nurse's job, not the query's.
    assert.equal(differentPerson.length, 1)
  })

  test('no match is an empty list, not an error', async () => {
    const { nurse } = await clinicWithPatients()

    const found = matchesOf(await as(nurse, 'find_possible_duplicates', {
      name: 'Nobody Here', phone: '9000000000',
    }))
    assert.deepEqual(found, [])
  })

  test('too little to go on returns nothing rather than everybody', async () => {
    const { nurse } = await clinicWithPatients()

    // One letter would match half the register and teach staff to ignore the
    // warning, which is worse than not showing one.
    assert.deepEqual(matchesOf(await as(nurse, 'find_possible_duplicates', { name: 'K' })), [])
    assert.deepEqual(matchesOf(await as(nurse, 'find_possible_duplicates', { phone: '987' })), [])
    assert.deepEqual(matchesOf(await as(nurse, 'find_possible_duplicates', {})), [])
  })

  test('asking changes nothing — no patient, no revision, no audit event', async () => {
    const { nurse } = await clinicWithPatients()
    const revisionBefore = Number(await scalar('select revision from jmc.clinic_revision'))
    const auditBefore = Number(await scalar('select count(*)::int from jmc.audit_events'))

    const result = await as(nurse, 'find_possible_duplicates', {
      name: 'Kamala Rajan', phone: '9876543210',
    })

    assert.equal(await scalar('select count(*)::int from jmc.patients'), 2)
    // A read must not make four tablets refetch the whole clinic.
    assert.equal(Number(await scalar('select revision from jmc.clinic_revision')), revisionBefore)
    assert.equal(Number(await scalar('select count(*)::int from jmc.audit_events')), auditBefore)

    // And it says so, which is what stops /command attaching a whole snapshot
    // to the answer. This runs debounced while a nurse is still typing a
    // name: measured against the staging fixtures, the reply is 104 bytes
    // with this flag and 36,844 without it.
    assert.equal(result.unchanged, true)
  })

  test('the suggestion never blocks the registration', async () => {
    const { nurse } = await clinicWithPatients()

    const found = matchesOf(await as(nurse, 'find_possible_duplicates', { name: 'Kamala Rajan' }))
    assert.equal(found.length, 1)

    // Two people really can share a name, and the person at the desk is the
    // one who can tell. Creating goes ahead.
    await as(nurse, 'create_patient', {
      name: 'Kamala Rajan', age: 12, sex: 'female', phone: '9000000001',
    })
    assert.equal(await scalar(`select count(*)::int from jmc.patients where name='Kamala Rajan'`), 2)
  })

  test('nothing is ever merged', async () => {
    const { nurse } = await clinicWithPatients()

    await as(nurse, 'create_patient', { name: 'Kamala Rajan', age: 52, sex: 'female', phone: '9876543210' })

    // Same name, same age, same number — as close to a certain duplicate as
    // this clinic can produce, and there are still two rows with two ids and
    // two histories. Joining them is a decision with a person's name on it.
    assert.equal(await scalar(`select count(*)::int from jmc.patients where name='Kamala Rajan'`), 2)
    assert.equal(
      await scalar(`select count(distinct id)::int from jmc.patients where name='Kamala Rajan'`),
      2,
    )
  })

  test('the doctor and admin may ask; the pharmacy counter may not', async () => {
    const { doctor, pharmacy } = await clinicWithPatients()

    // The counter has no Patients station and never names a patient, so it has
    // no reason to be able to search the register by name or phone.
    await as(doctor, 'find_possible_duplicates', { name: 'Kamala Rajan' })
    await assert.rejects(
      as(pharmacy, 'find_possible_duplicates', { name: 'Kamala Rajan' }),
      /role cannot perform/,
    )
  })

  test('at most five candidates, newest first', async () => {
    const { nurse } = await clinicWithPatients()

    for (let n = 0; n < 7; n += 1) {
      await as(nurse, 'create_patient', {
        name: 'Common Name', age: 30 + n, sex: 'male', phone: `90000000${10 + n}`,
      })
    }

    const found = matchesOf(await as(nurse, 'find_possible_duplicates', { name: 'Common Name' }))
    assert.equal(found.length, 5, 'a long list is a list nobody reads')
    // Newest first: the most recently created is the likeliest accidental
    // duplicate, because it is the one somebody just made.
    assert.equal(found[0].age, 36)
  })
})
