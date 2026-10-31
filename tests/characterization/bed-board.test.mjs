/**
 * The list of observation beds: how many the clinic has, and who may change it.
 *
 * Until `add_bed` and `remove_bed` existed, nothing in the application could
 * change the beds. There were four because the retired application seeded
 * four, and a clinic with any other number had no way to say so.
 *
 * What this file holds the two commands to:
 *
 *   - only an administrator changes the list; a nurse moves patients through it
 *   - a name is unique however it is capitalised, even when two adds race
 *   - a bed with a patient in it, or one that has ever had one, stays, because
 *     its observation timeline points at it
 *   - the board tells the screen which beds may be removed, and lists Bed 10
 *     after Bed 9
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  const admin = await makeStaff({ name: 'Clinic Admin', username: 'admin', roles: ['admin'] })
  const nurse = await makeStaff({ name: 'Ward Nurse', username: 'nurse', roles: ['nurse'] })
  const doctor = await makeStaff({ name: 'Doctor', username: 'doctor', roles: ['doctor'] })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 'pharmacy', roles: ['pharmacy'] })
  return { admin, nurse, doctor, pharmacy }
}

const bedCount = async () => Number(await scalar('select count(*) from jmc.beds'))
const bedId = async (label) => String(await scalar('select id from jmc.beds where label=$1', [label]))
const board = async (staff) => (await snapshot.readSnapshot(sessionFor(staff))).beds

describe('adding a bed', () => {
  test('an administrator adds a bed, and it arrives empty and available on the care tablets', async () => {
    const { admin, nurse } = await clinic()

    const result = await as(admin, 'add_bed', { label: '  Bed   5 ' })
    assert.equal(result.message, 'Bed 5 is on the bed board.')

    const [bed] = await rows('select id,label,status,patient_id,admitted_at,notes from jmc.beds')
    assert.equal(bed.label, 'Bed 5', 'the name is trimmed and single-spaced')
    assert.equal(bed.status, 'available')
    assert.equal(bed.patient_id, null)
    assert.equal(bed.admitted_at, null)
    assert.equal(bed.notes, '')

    const [entry] = await rows(`select actor_id,entity_type,entity_id from jmc.audit_events where action='bed.created'`)
    assert.deepEqual(entry, { actor_id: admin.id, entity_type: 'bed', entity_id: bed.id })

    const [seen] = await board(nurse)
    assert.equal(seen.label, 'Bed 5')
    assert.equal(seen.status, 'available')
    assert.equal(seen.hasHistory, false)
  })

  test('a second bed with the same name, in any capitals, is refused', async () => {
    const { admin } = await clinic()
    await as(admin, 'add_bed', { label: 'Bed 5' })

    await assert.rejects(as(admin, 'add_bed', { label: 'bed 5' }), /already a bed called "Bed 5"/)
    await assert.rejects(as(admin, 'add_bed', { label: 'BED  5' }), /already a bed called "Bed 5"/)
    assert.equal(await bedCount(), 1)
  })

  test('two adds of the same name at the same moment leave one bed', async () => {
    const { admin } = await clinic()

    const outcomes = await Promise.allSettled([
      as(admin, 'add_bed', { label: 'Bed 7' }),
      as(admin, 'add_bed', { label: 'bed 7' }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const [refused] = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.match(String(refused.reason?.message), /already a bed called/)
    assert.equal(await bedCount(), 1)
  })

  test('a bed needs a name, and a short one', async () => {
    const { admin } = await clinic()

    await assert.rejects(as(admin, 'add_bed', { label: '   ' }), /label is required/)
    await assert.rejects(as(admin, 'add_bed', { label: 'B'.repeat(41) }), /at most 40 characters/)
    await as(admin, 'add_bed', { label: 'B'.repeat(40) })
    assert.equal(await bedCount(), 1)
  })

  test('the board lists Bed 10 after Bed 9, not after Bed 1', async () => {
    const { admin, nurse } = await clinic()
    for (const label of ['Bed 10', 'Bed 2', 'Bed 9', 'Bed 1']) await as(admin, 'add_bed', { label })

    assert.deepEqual((await board(nurse)).map((bed) => bed.label), ['Bed 1', 'Bed 2', 'Bed 9', 'Bed 10'])
  })
})

describe('who may change the beds', () => {
  for (const role of ['nurse', 'doctor', 'pharmacy']) {
    test(`a ${role} cannot add or remove a bed`, async () => {
      const staff = await clinic()
      await as(staff.admin, 'add_bed', { label: 'Bed 1' })
      const id = await bedId('Bed 1')

      await assert.rejects(as(staff[role], 'add_bed', { label: 'Bed 2' }), /role cannot perform/)
      await assert.rejects(as(staff[role], 'remove_bed', { bedId: id }), /role cannot perform/)
      assert.equal(await bedCount(), 1)
    })
  }
})

describe('removing a bed', () => {
  test('an empty bed that never had a patient in it comes off the board', async () => {
    const { admin, nurse } = await clinic()
    await as(admin, 'add_bed', { label: 'Bed 1' })
    await as(admin, 'add_bed', { label: 'Bed 2' })
    const id = await bedId('Bed 2')

    // Marked for cleaning and back is not a patient: it is still removable.
    await as(nurse, 'update_bed', { bedId: id, status: 'cleaning' })

    const result = await as(admin, 'remove_bed', { bedId: id })
    assert.equal(result.message, 'Bed 2 is off the bed board.')
    assert.deepEqual((await board(nurse)).map((bed) => bed.label), ['Bed 1'])

    const [entry] = await rows(`select actor_id,entity_id,summary from jmc.audit_events where action='bed.removed'`)
    assert.deepEqual(entry, { actor_id: admin.id, entity_id: id, summary: 'Removed observation bed Bed 2' })

    await assert.rejects(as(admin, 'remove_bed', { bedId: id }), /bed was not found/)
  })

  test('a bed with a patient in it, or one that has ever had one, stays', async () => {
    const { admin, nurse } = await clinic()
    await as(admin, 'add_bed', { label: 'Bed 1' })
    const id = await bedId('Bed 1')
    await as(nurse, 'create_patient', { name: 'Observed Patient', age: 50, sex: 'female', phone: '+999700000071' })
    const patientId = String(await scalar(`select id from jmc.patients where name='Observed Patient'`))

    await as(nurse, 'update_bed', { bedId: id, status: 'occupied', patientId })
    await assert.rejects(as(admin, 'remove_bed', { bedId: id }), /Bed 1 has a patient in it/)

    await as(nurse, 'close_observation', {
      bedId: id, outcome: 'discharged', note: 'Went home', confirmed: true,
    })
    const [seen] = await board(nurse)
    assert.equal(seen.status, 'cleaning')
    assert.equal(seen.hasHistory, true, 'the screen is told not to offer Remove')
    await assert.rejects(as(admin, 'remove_bed', { bedId: id }), /observation history stays/)

    // What the refusal points at instead works, and the history is untouched.
    await as(admin, 'update_bed', { bedId: id, status: 'out_of_service' })
    assert.equal(await bedCount(), 1)
    assert.ok(Number(await scalar('select count(*) from jmc.observation_events where bed_id=$1', [id])) >= 2)
  })
})
