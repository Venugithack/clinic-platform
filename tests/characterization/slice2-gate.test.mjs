/**
 * Slice 2 exit gate: the working clinical record, not a set of UI promises.
 *
 * This file deliberately crosses command, database and snapshot boundaries.
 * A draft that looks private only because the page hides it is not private; a
 * medicine name that looks exact only because the browser copied it is not an
 * immutable prescription; and a print button is not an audit trail.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import {
  as,
  clinicDate,
  closeClinic,
  makeStaff,
  resetClinic,
  rows,
  scalar,
  sessionFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  const publisher = await makeStaff({
    name: 'Owner Doctor', username: 'owner-doctor', roles: ['doctor', 'admin'],
    canPublishClinicalTemplates: true,
  })
  const doctor = await makeStaff({ name: 'Doctor Two', username: 'doctor-two', roles: ['doctor'] })
  const nurse = await makeStaff({ name: 'Nurse', username: 'nurse', roles: ['nurse'] })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 'pharmacy', roles: ['pharmacy'] })
  const admin = await makeStaff({ name: 'Operations Admin', username: 'operations', roles: ['admin'] })

  await as(publisher, 'create_patient', {
    name: 'Slice Two Patient', age: 42, sex: 'female', phone: '+999700000001',
  })
  const patientId = String(await scalar(`select id from jmc.patients where name='Slice Two Patient'`))

  await as(admin, 'add_medicine', {
    code: 'BRAND-PCM-650', name: 'Relief', genericName: 'Paracetamol', strength: '650 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', barcode: '8909991234567',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 10, targetStock: 100,
    initialQuantity: 100, batchNumber: 'S2-PCM', expiry: await clinicDate(400),
    mrp: 40, purchasePrice: 20, sellingPrice: 35,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='BRAND-PCM-650'`))

  return { publisher, doctor, nurse, pharmacy, admin, patientId, medicineId }
}

function clinicalPayload(patientId, medicineId, extra = {}) {
  return {
    patientId,
    complaint: 'Fever and body pain',
    complaintDurationValue: 3,
    complaintDurationUnit: 'day',
    examination: 'Chest clear',
    diagnosis: 'Acute viral fever',
    diagnosisStatus: 'provisional',
    aetiology: 'Likely viral',
    aetiologyCertainty: 'suspected',
    notes: 'Private note',
    advice: 'Drink plenty of fluids',
    prescriptionItems: [{
      medicineId,
      // Deliberately false. Signed identity must come from the server's
      // medicine master, never from a browser field anybody can change.
      medicineName: 'Wrong browser name',
      genericName: 'Wrong browser generic',
      strength: '1 mg',
      dosageForm: 'injection',
      medicineCode: 'WRONG',
      doseAmount: '1',
      doseUnit: 'tablet',
      frequency: 'twice_daily',
      timing: 'after_food',
      route: 'Oral',
      durationValue: 3,
      durationUnit: 'day',
      instructions: 'After food',
      quantity: 6,
    }],
    consultationFee: 300,
    ...extra,
  }
}

describe('private server-side consultation drafts', () => {
  test('one responsible doctor can resume; other roles and doctors cannot', async () => {
    const { publisher, doctor, pharmacy, patientId, medicineId } = await clinic()

    await as(publisher, 'save_consultation_draft', clinicalPayload(patientId, medicineId, {
      diagnosis: '', consultationFee: 0,
    }))

    const ownerRecord = await snapshot.readPatientRecord(patientId, publisher.id)
    assert.equal(ownerRecord.draft?.complaint, 'Fever and body pain')
    assert.equal(ownerRecord.draft?.items[0].medicineName, 'Relief 650 mg')
    assert.equal(ownerRecord.draft?.items[0].genericName, 'Paracetamol')
    assert.equal(ownerRecord.draft?.stale, false)

    assert.equal((await snapshot.readPatientRecord(patientId, doctor.id)).draft, undefined)
    assert.equal((await snapshot.readPatientRecord(patientId)).draft, undefined)
    assert.equal(JSON.stringify(await snapshot.readSnapshot(sessionFor(pharmacy))).includes('Private note'), false)

    await rows(`update jmc.consultation_drafts set updated_at=now()-interval '8 days' where doctor_id=$1`, [publisher.id])
    assert.equal((await snapshot.readPatientRecord(patientId, publisher.id)).draft?.stale, true)

    await as(publisher, 'save_consultation_draft', clinicalPayload(patientId, medicineId, {
      diagnosis: 'Changed but still unsigned', consultationFee: 0,
    }))
    assert.equal(await scalar('select count(*)::int from jmc.consultation_drafts'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.consultation_draft_lines'), 1)
  })
})

describe('the approved clinical vocabulary', () => {
  test('the starter release is versioned, attributed and reaches only doctors', async () => {
    const { publisher, nurse, pharmacy, patientId } = await clinic()

    const [release] = await rows(`select * from jmc.clinical_vocabulary_releases where version='en-2026.09'`)
    assert.equal(release.locale, 'en')
    assert.match(release.approval_reference, /SLICE3_CLINIC_APPROVAL_PACK/)
    assert.equal(release.retired_at, null)

    // Twenty each of the four lists the owner approved, and — deliberately —
    // no examination findings, because the owner approved four lists.
    const counts = await rows(`select kind,count(*)::int n from jmc.clinical_phrases
      where release_id=$1 group by kind order by kind`, [release.id])
    assert.deepEqual(
      Object.fromEntries(counts.map((row) => [row.kind, row.n])),
      { advice: 20, complaint: 20, diagnosis: 20, instruction: 20 },
    )

    // Every clinic-wide phrase says where it came from. An unattributed one
    // cannot be written at all.
    assert.equal(
      await scalar(`select count(*)::int from jmc.clinical_phrases
        where approved_by is null and release_id is null`),
      0,
    )
    await assert.rejects(
      rows(`insert into jmc.clinical_phrases (id,kind,display_text,normalized_text)
        values ('orphan','advice','From nowhere','from nowhere')`),
      /clinical_phrases_provenance_present/,
    )

    const record = await snapshot.readPatientRecord(patientId, publisher.id)
    assert.equal(record.phrases.filter((row) => row.kind === 'complaint').length, 20)
    assert.ok(record.phrases.some((row) => row.text === 'Fever' && row.source === 'clinic_starter'))
    assert.equal(record.phrases.some((row) => row.kind === 'examination'), false)

    // The vocabulary is the doctor's tool; it is not in the whole-clinic
    // snapshot every tablet polls.
    for (const staff of [nurse, pharmacy]) {
      const seen = JSON.stringify(await snapshot.readSnapshot(sessionFor(staff)))
      assert.equal(seen.includes('Peripheral vertigo'), false)
    }
  })

  test('approved wording cannot be reworded in place, only withdrawn and restored', async () => {
    const { publisher } = await clinic()

    await assert.rejects(
      rows(`update jmc.clinical_phrases set display_text='Fevers' where kind='complaint' and normalized_text='fever'`),
      /cannot be reworded/,
    )
    await assert.rejects(
      rows(`delete from jmc.clinical_phrases where kind='complaint' and normalized_text='fever'`),
      /cannot be deleted/,
    )

    await as(publisher, 'retire_clinical_phrase', { kind: 'complaint', text: 'Fever' })
    const [withdrawn] = await rows(`select active,retired_at,display_text from jmc.clinical_phrases
      where kind='complaint' and normalized_text='fever'`)
    assert.equal(Number(withdrawn.active), 0)
    assert.ok(withdrawn.retired_at)
    assert.equal(withdrawn.display_text, 'Fever')

    // Restoring brings back the approved wording, not the re-typing of it.
    await as(publisher, 'publish_clinical_phrase', { kind: 'complaint', text: '  fever  ' })
    const [restored] = await rows(`select active,retired_at,display_text,source from jmc.clinical_phrases
      where kind='complaint' and normalized_text='fever'`)
    assert.equal(Number(restored.active), 1)
    assert.equal(restored.retired_at, null)
    assert.equal(restored.display_text, 'Fever')
    assert.equal(restored.source, 'clinic_starter')
    assert.equal(
      await scalar(`select count(*)::int from jmc.clinical_phrases where kind='complaint' and normalized_text='fever'`),
      1,
    )
  })

  test('only the authorized doctor changes the clinic list; anyone may keep their own favourites', async () => {
    const { publisher, doctor, nurse, admin, patientId } = await clinic()
    const phrase = { kind: 'advice', text: 'Soak the foot in warm water twice a day' }

    await assert.rejects(as(doctor, 'publish_clinical_phrase', phrase), /not authorized to change the clinic-wide/)
    await assert.rejects(as(admin, 'publish_clinical_phrase', phrase), /role cannot perform/)
    await assert.rejects(as(nurse, 'retire_clinical_phrase', { kind: 'advice', text: 'Drink adequate fluids' }), /role cannot perform/)
    assert.equal(await scalar(`select count(*)::int from jmc.clinical_phrases where source='clinic'`), 0)

    // A.5: an ordinary doctor's favourites are their own and never touch the
    // clinic-wide approved list.
    await as(doctor, 'set_clinical_phrase_favourite', { ...phrase, favourite: true })
    assert.equal(await scalar(`select count(*)::int from jmc.clinical_phrases where source='clinic'`), 0)
    const own = await snapshot.readPatientRecord(patientId, doctor.id)
    assert.equal(own.phrasePreferences.some((row) => row.text === phrase.text && row.favourite), true)
    assert.equal(
      (await snapshot.readPatientRecord(patientId, publisher.id))
        .phrasePreferences.some((row) => row.text === phrase.text),
      false,
    )

    await as(publisher, 'publish_clinical_phrase', phrase)
    const [published] = await rows(`select source,approved_by,release_id,active from jmc.clinical_phrases
      where kind='advice' and normalized_text=$1`, [phrase.text.toLowerCase()])
    assert.equal(published.source, 'clinic')
    assert.equal(published.approved_by, publisher.id)
    assert.equal(published.release_id, null)
    await assert.rejects(as(publisher, 'publish_clinical_phrase', phrase), /already in the clinic list/)

    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events
        where action in ('clinical_phrase.published','clinical_phrase.retired','clinical_phrase.restored')`),
      1,
    )
    assert.equal(
      (await snapshot.readPatientRecord(patientId, doctor.id)).phrases.some((row) => row.text === phrase.text),
      true,
    )
  })

  test('a superseded release leaves new suggestions without touching signed history', async () => {
    const { publisher, patientId, medicineId } = await clinic()
    await as(publisher, 'sign_consultation', clinicalPayload(patientId, medicineId, {
      advice: 'Drink plenty of fluids', consultationFee: 0,
    }))

    await rows(`update jmc.clinical_vocabulary_releases set retired_at=now() where version='en-2026.09'`)

    const record = await snapshot.readPatientRecord(patientId, publisher.id)
    assert.equal(record.phrases.length, 0)
    assert.equal(record.encounters[0].advice, 'Drink plenty of fluids')
    assert.equal(
      await scalar(`select count(*)::int from jmc.clinical_phrases where release_id is not null`),
      80,
    )
  })
})

describe('doctor-owned and clinic-approved templates', () => {
  test('admin is not clinical authority; clinic templates are versioned and immutable', async () => {
    const { publisher, doctor, admin, patientId, medicineId } = await clinic()
    const base = clinicalPayload(patientId, medicineId, { title: 'Fever plan', consultationFee: 0 })

    await as(doctor, 'save_clinical_template', { ...base, scope: 'personal' })
    assert.equal((await snapshot.readPatientRecord(patientId, doctor.id)).templates.length, 1)
    assert.equal((await snapshot.readPatientRecord(patientId, publisher.id)).templates.length, 0)

    await assert.rejects(
      as(doctor, 'save_clinical_template', { ...base, scope: 'clinic' }),
      /not authorized to publish clinic-wide/,
    )
    await assert.rejects(
      as(admin, 'save_clinical_template', { ...base, scope: 'clinic' }),
      /role cannot perform/,
    )

    const created = await as(publisher, 'save_clinical_template', { ...base, scope: 'clinic' })
    const firstId = created.data.templateId
    assert.equal((await snapshot.readPatientRecord(patientId, doctor.id)).templates.some((t) => t.id === firstId), true)

    const revised = await as(publisher, 'save_clinical_template', {
      ...base, templateId: firstId, scope: 'clinic', diagnosis: 'Viral syndrome',
    })
    const secondId = revised.data.templateId
    const versions = await rows(`select id,version,retired_at,supersedes_id
      from jmc.consultation_templates where series_id=(select series_id from jmc.consultation_templates where id=$1)
      order by version`, [firstId])
    assert.deepEqual(versions.map((row) => Number(row.version)), [1, 2])
    assert.ok(versions[0].retired_at)
    assert.equal(versions[1].supersedes_id, firstId)
    assert.equal(versions[1].id, secondId)

    await assert.rejects(
      rows(`update jmc.consultation_templates set diagnosis='silently changed' where id=$1`, [secondId]),
      /cannot be changed/,
    )
    await assert.rejects(
      rows(`delete from jmc.consultation_template_lines where template_version_id=$1`, [secondId]),
      /cannot be changed/,
    )
    await assert.rejects(
      rows(`delete from jmc.consultation_templates where id=$1`, [secondId]),
      /cannot be deleted/,
    )
  })
})

describe('signing, exact medicine identity, follow-up and paper', () => {
  test('one queued visit cannot be signed twice from two doctor tablets', async () => {
    const { publisher, doctor, nurse, patientId, medicineId } = await clinic()
    await as(nurse, 'create_appointment', {
      patientId, reason: 'Concurrent sign test', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar('select id from jmc.appointments'))
    const payload = clinicalPayload(patientId, medicineId, {
      appointmentId, consultationFee: 0,
    })

    const results = await Promise.allSettled([
      as(publisher, 'sign_consultation', payload),
      as(doctor, 'sign_consultation', payload),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(await scalar('select count(*)::int from jmc.encounters'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.prescriptions'), 1)
    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'done')
  })

  test('one sign turns the draft into immutable normalized records', async () => {
    const { publisher, pharmacy, patientId, medicineId } = await clinic()
    const followUpDate = await clinicDate(7)
    const payload = clinicalPayload(patientId, medicineId, {
      followUpDate,
      followUpNote: 'Review fever and hydration',
    })
    await as(publisher, 'save_consultation_draft', payload)

    const signed = await as(publisher, 'sign_consultation', payload)
    assert.match(signed.data.prescriptionNumber, /^RX-[0-9]{6}$/)
    assert.equal(await scalar('select count(*)::int from jmc.consultation_drafts'), 0)
    assert.equal(await scalar('select count(*)::int from jmc.encounters'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.prescriptions'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.follow_ups'), 1)
    assert.equal(await scalar('select due_date::text from jmc.follow_ups'), followUpDate)

    const [line] = await rows(`select * from jmc.prescription_lines where prescription_id=$1`, [signed.data.prescriptionId])
    assert.equal(line.medicine_name_snapshot, 'Relief 650 mg')
    assert.equal(line.generic_name_snapshot, 'Paracetamol')
    assert.equal(line.strength_snapshot, '650 mg')
    assert.equal(line.dosage_form_snapshot, 'tablet')
    assert.equal(line.medicine_code_snapshot, 'BRAND-PCM-650')
    assert.equal(line.frequency, 'twice_daily')
    assert.equal(line.timing, 'after_food')
    assert.equal(Number(line.prescribed_quantity), 6)

    await rows(`update jmc.medicines set name='Renamed later',strength='999 mg' where id=$1`, [medicineId])
    const record = await snapshot.readPatientRecord(patientId, publisher.id)
    assert.equal(record.prescriptions[0].items[0].medicineName, 'Relief 650 mg')
    assert.equal(record.prescriptions[0].items[0].strength, '650 mg')

    await assert.rejects(
      rows(`update jmc.prescription_lines set prescribed_quantity=99 where prescription_id=$1`, [signed.data.prescriptionId]),
      /cannot be changed/,
    )
    await assert.rejects(
      rows(`delete from jmc.prescription_lines where prescription_id=$1`, [signed.data.prescriptionId]),
      /cannot be changed/,
    )
    await assert.rejects(
      rows(`update jmc.prescriptions set items_json='[]' where id=$1`, [signed.data.prescriptionId]),
      /cannot be changed/,
    )
    await assert.rejects(
      rows(`delete from jmc.prescriptions where id=$1`, [signed.data.prescriptionId]),
      /cannot be deleted/,
    )

    const queue = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.equal(queue.prescriptions[0].prescriptionNumber, signed.data.prescriptionNumber)
    assert.equal(queue.prescriptions[0].items[0].genericName, 'Paracetamol')
  })

  test('every physical print and reprint receives its own audited copy number', async () => {
    const { publisher, patientId, medicineId } = await clinic()
    const signed = await as(publisher, 'sign_consultation', clinicalPayload(patientId, medicineId))

    const copies = await Promise.all([
      as(publisher, 'record_prescription_print', { prescriptionId: signed.data.prescriptionId }),
      as(publisher, 'record_prescription_print', { prescriptionId: signed.data.prescriptionId }),
    ])
    assert.deepEqual(copies.map((copy) => copy.data.copyNumber).sort(), [1, 2])
    assert.equal(await scalar('select count(*)::int from jmc.prescription_prints'), 2)
    assert.equal(await scalar(`select count(*)::int from jmc.audit_events where action='prescription.printed'`), 2)
    assert.equal((await snapshot.readPatientRecord(patientId, publisher.id)).prescriptions[0].printCount, 2)
  })
})

describe('approved vital review and observation handoff', () => {
  test('only recorded doctor-approved rules reach care tablets', async () => {
    const { publisher, nurse, pharmacy, patientId } = await clinic()
    assert.deepEqual((await snapshot.readSnapshot(sessionFor(nurse))).vitalReviewRules, [])

    await rows(`insert into jmc.vital_review_rules
      (id,metric,minimum_value,minimum_age,prompt,approved_by)
      values ('rule-spo2','spo2',99,18,'Fixture: verify the oximeter reading',$1)`, [publisher.id])
    await as(nurse, 'add_vitals', { patientId, spo2: 97, pulse: 82, notMeasuredNote: '' })

    const careRules = (await snapshot.readSnapshot(sessionFor(nurse))).vitalReviewRules
    assert.equal(careRules.length, 1)
    assert.equal(careRules[0].prompt, 'Fixture: verify the oximeter reading')
    assert.deepEqual((await snapshot.readSnapshot(sessionFor(pharmacy))).vitalReviewRules, [])
  })

  test('timer, observation, doctor handoff and confirmed transfer stay in one history', async () => {
    const { publisher, nurse, patientId } = await clinic()
    await rows(`insert into jmc.beds (id,label,status) values ('bed-slice-2','Observation 1','available')`)
    const nextCheckAt = new Date(Date.now() + 30 * 60_000).toISOString()

    await as(nurse, 'update_bed', {
      bedId: 'bed-slice-2', status: 'occupied', patientId,
      notes: 'Started oral fluids', nextCheckAt,
    })
    await as(nurse, 'record_observation', {
      bedId: 'bed-slice-2', note: 'Tolerating fluids', nextCheckAt,
    })
    await as(nurse, 'request_observation_handoff', {
      bedId: 'bed-slice-2', note: 'Please review before transfer',
    })

    const waiting = (await snapshot.readSnapshot(sessionFor(publisher))).beds[0]
    assert.ok(waiting.handoffRequestedAt)
    assert.equal(waiting.handoffRequestedBy, 'Nurse')
    await assert.rejects(as(nurse, 'resolve_observation_handoff', { bedId: 'bed-slice-2' }), /role cannot perform/)

    await as(publisher, 'set_observation_instructions', {
      bedId: 'bed-slice-2', instructions: 'Continue fluids and repeat pulse',
    })
    await as(publisher, 'resolve_observation_handoff', {
      bedId: 'bed-slice-2', note: 'Reviewed',
    })
    await assert.rejects(
      as(nurse, 'close_observation', {
        bedId: 'bed-slice-2', outcome: 'transferred', note: 'Sent to hospital', confirmed: false,
      }),
      /Confirm before closing/,
    )
    await as(nurse, 'close_observation', {
      bedId: 'bed-slice-2', outcome: 'transferred', note: 'Sent to hospital', confirmed: true,
    })

    const [bed] = await rows(`select status,patient_id,next_check_at,doctor_instructions from jmc.beds where id='bed-slice-2'`)
    assert.equal(bed.status, 'cleaning')
    assert.equal(bed.patient_id, null)
    assert.equal(bed.next_check_at, null)
    assert.equal(bed.doctor_instructions, '')
    const events = await rows(`select event_type,actor_id from jmc.observation_events
      where bed_id='bed-slice-2' order by created_at,id`)
    assert.deepEqual(new Set(events.map((event) => event.event_type)), new Set([
      'admitted', 'note', 'handoff_requested', 'doctor_instruction', 'handoff_resolved', 'transferred',
    ]))
    assert.deepEqual(new Set(events.map((event) => event.actor_id)), new Set([nurse.id, publisher.id]))
  })
})
