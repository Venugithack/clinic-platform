/**
 * What the two WhatsApp commands did before Slice 3A, and still do.
 *
 * `send_order` and `send_patient_whatsapp` are the only two things in this
 * application that have ever contacted a patient or a supplier, and Slice 3A
 * built a whole messaging model beside them without touching either. This file
 * was written BEFORE that model existed and is the record of what they
 * answered then, so that "nothing changed" is a measurement rather than a
 * claim.
 *
 * It also states the boundary between the two worlds plainly, because the
 * boundary is the thing most likely to be misread later:
 *
 *   `send_patient_whatsapp` is a member of staff typing a message and pressing
 *   send. It is gated on `patients.whatsapp_consent`, a blanket registration
 *   flag that names no purposes, and Slice 3A did not change that.
 *
 *   `communication_consents` governs the AUTOMATED, clinic-initiated outbox —
 *   the thing owner items 76 to 83 are about. It starts empty, deliberately:
 *   owner item 78 says "a registration choice is valid only for the purposes
 *   it names", and the old flag names none, so backfilling it into per-purpose
 *   consent would be inventing evidence about what patients were told.
 *
 * Moving the staff composer onto per-purpose consent is a documented piece of
 * deferred work, not an oversight — `docs/SCHEMA_AND_TYPES.md` §15.
 *
 * No test here sends anything. The clinic's Meta connection is unconfigured in
 * staging, which is exactly the state these commands refuse in.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  as, closeClinic, makeStaff, resetClinic, rows, scalar,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

let admin
let pharmacist
let supplierId
let medicineId
let consentingPatientId
let silentPatientId

before(async () => {
  await resetClinic()
  admin = await makeStaff({ name: 'Owner', username: 'wc-admin', roles: ['admin', 'doctor'], pin: '4829' })
  pharmacist = await makeStaff({ name: 'Pharmacist', username: 'wc-pharm', roles: ['pharmacy'], pin: '4830' })

  await as(admin, 'add_supplier', {
    code: 'WCS1', name: 'Chennai Distributors', whatsapp: '+919000000001', phone: '+919000000001',
  })
  supplierId = String(await scalar(`select id from jmc.suppliers where code='WCS1'`))

  await as(pharmacist, 'add_medicine', {
    code: 'WCM1', name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 100,
  })
  medicineId = String(await scalar(`select id from jmc.medicines where code='WCM1'`))

  await as(admin, 'create_patient', {
    name: 'Consenting Patient', age: 30, sex: 'female', phone: '+919000000501',
    whatsappConsent: true,
  })
  consentingPatientId = String(
    await scalar(`select id from jmc.patients where name='Consenting Patient'`))

  await as(admin, 'create_patient', {
    name: 'Silent Patient', age: 31, sex: 'male', phone: '+919000000502',
  })
  silentPatientId = String(await scalar(`select id from jmc.patients where name='Silent Patient'`))
})

describe('the supplier order, unchanged', () => {
  test('an unconnected clinic refuses to send and leaves the order pending', async () => {
    const draft = await as(admin, 'create_order', {
      supplierId, lines: [{ medicineId, quantity: 10 }],
    })
    const orderId = draft.data.orderId

    await assert.rejects(
      () => as(admin, 'send_order', { orderId }),
      /WhatsApp is not connected yet\./,
    )

    // The order did not move, and nothing was logged as sent. Both halves
    // matter: a status that advanced would tell a pharmacist the supplier had
    // been told.
    assert.equal(await scalar('select status from jmc.purchase_orders where id=$1', [orderId]), 'pending')
    assert.equal(Number(await scalar('select count(*) from jmc.whatsapp_messages')), 0)
  })

  test('nothing about it reaches the new messaging tables', async () => {
    // A supplier is not a patient and a purchase order is not a clinic-
    // initiated patient message. Slice 3A's outbox has no opinion about
    // either, and this asserts it stayed that way.
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)
    assert.equal(Number(await scalar('select count(*) from jmc.communication_schedules')), 0)
  })
})

describe('the staff message composer, unchanged', () => {
  test('a patient with no registration consent is refused before anything else', async () => {
    await assert.rejects(
      () => as(admin, 'send_patient_whatsapp', { patientId: silentPatientId, body: 'Hello' }),
      /WhatsApp consent is not recorded for this patient\./,
    )
  })

  test('a consenting patient is refused for the connection, not for consent', async () => {
    await assert.rejects(
      () => as(admin, 'send_patient_whatsapp', { patientId: consentingPatientId, body: 'Hello' }),
      /WhatsApp is not connected yet\./,
    )
    assert.equal(Number(await scalar('select count(*) from jmc.whatsapp_messages')), 0)
  })

  test('the pharmacy cannot use it, as it never could', async () => {
    await assert.rejects(
      () => as(pharmacist, 'send_patient_whatsapp', { patientId: consentingPatientId, body: 'Hello' }),
      /Your role cannot perform this action\./,
    )
  })

  test('the old blanket flag and the new per-purpose evidence are separate records', async () => {
    // The registration checkbox is set for this patient...
    assert.equal(
      Number(await scalar('select whatsapp_consent from jmc.patients where id=$1', [consentingPatientId])),
      1,
    )
    // ...and it granted them nothing in the automated model, because it named
    // no purposes. Owner item 78. Nothing backfilled it and nothing should.
    const evidence = await rows(
      'select * from jmc.communication_consents where patient_id=$1', [consentingPatientId])
    assert.equal(evidence.length, 0)
  })
})
