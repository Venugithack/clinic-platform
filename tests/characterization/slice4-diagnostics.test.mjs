/**
 * Backend programme Slice 4, against owner policy items 84 to 88.
 *
 * Every test is named for the clinic rule it holds rather than for the
 * function it calls, and the rules are the ones somebody would notice going
 * wrong: that one patient's report cannot be filed against another patient's
 * request, that a laboratory's own sign-off is not the clinic doctor reading
 * it, that a corrected report does not inherit the review the first one got,
 * that nobody is told a result is ready because a clock went off, and that the
 * clinic never says a patient was notified when all it knows is that it
 * queued something.
 *
 * ── NOTHING IN THIS FILE TOUCHES A NETWORK ─────────────────────────────────
 *
 * The messaging channel is injected, as it is in the Slice 3A and 3B suites,
 * and the one these tests use answers from a script rather than making a
 * request. The default channel is the real one and it is disabled without the
 * four `WHATSAPP_*` variables, which is the clinic's actual state — so the
 * notification tests below assert the suppression that produces, and one of
 * them asserts it by name.
 *
 * ── AND NOTHING IN IT DEPENDS ON THE TIME OF DAY IT RUNS ───────────────────
 *
 * Owner item 87's escalation is a wall-clock rule with a 20:00 clinic-local
 * ceiling in it, so a test that let the real clock decide would pass all
 * morning and fail after eight in the evening. The escalation tests move
 * `received_at` backwards through the append-only trigger rather than waiting,
 * and the one that checks the ceiling computes the expected answer in Postgres
 * in the clinic's own timezone instead of asserting a fixed hour.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor, tokenFor,
} from '../support/clinic.mjs'
import { diagnostics, edgeGet, edgeRequest, messaging, STAGING_DB_URL } from '../support/backend.mjs'

let documentRoot

before(() => {
  documentRoot = mkdtempSync(join(tmpdir(), 'jmc-result-documents-'))
  process.env.CLINIC_DOCUMENT_ROOT = documentRoot
})

after(async () => {
  await closeClinic()
  delete process.env.CLINIC_DOCUMENT_ROOT
  if (documentRoot && existsSync(documentRoot)) {
    rmSync(documentRoot, { recursive: true, force: true })
  }
})

const key = () => randomUUID()

/* ───────────────────────────────────────────────────────────── the clinic ── */

/**
 * A clinic with the five people this slice distinguishes between, two
 * patients, and one approved catalogue entry.
 *
 * `owner` holds `can_publish_clinical_templates`, which is this application's
 * "explicitly authorized doctor" flag and what owner item 84 means by one.
 * `doctor` is an ordinary doctor and does not. `other` is a third doctor with
 * no connection to anything, which is what makes the standing tests mean
 * something. The nurse is given care involvement by recording vitals, because
 * `nurse_care_involvement` is derived from work a nurse actually did.
 */
async function clinic() {
  await resetClinic()

  const owner = await makeStaff({
    name: 'Owner Doctor', username: 'd-owner', roles: ['doctor'], pin: '6731',
    canPublishClinicalTemplates: true,
  })
  const doctor = await makeStaff({ name: 'Ward Doctor', username: 'd-ward', roles: ['doctor'], pin: '6732' })
  const other = await makeStaff({ name: 'Locum Doctor', username: 'd-locum', roles: ['doctor'], pin: '6733' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'd-nurse', roles: ['nurse'], pin: '6734' })
  const admin = await makeStaff({ name: 'Admin', username: 'd-admin', roles: ['admin'], pin: '6735' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', username: 'd-pharm', roles: ['pharmacy'], pin: '6736' })

  await as(doctor, 'create_patient', { name: 'Result Patient', age: 44, sex: 'female', phone: '+919990000011' })
  await as(doctor, 'create_patient', { name: 'Other Patient', age: 51, sex: 'male', phone: '+919990000012' })
  const patientId = String(await scalar("select id from jmc.patients where name='Result Patient'"))
  const otherPatientId = String(await scalar("select id from jmc.patients where name='Other Patient'"))

  // What makes the nurse involved in this patient's care, and deliberately
  // not in the other patient's.
  await as(nurse, 'add_vitals', { patientId, bp: '118/76', temperature: 36.8, pulse: 72 })

  const catalogue = await approveEntry(owner, {
    kind: 'investigation', displayName: 'Full blood count', category: 'haematology',
    specimen: 'EDTA whole blood',
  })

  return {
    owner, doctor, other, nurse, admin, pharmacist,
    patientId, otherPatientId, catalogue,
  }
}

async function approveEntry(owner, fields) {
  const drafted = await as(owner, 'draft_investigation', fields)
  await as(owner, 'approve_investigation', { catalogueId: drafted.data.catalogueId })
  return drafted.data
}

/** A request for one patient, and the line inside it. */
async function order(doctor, patientId, catalogueId, extra = {}) {
  const placed = await as(doctor, 'order_investigation', {
    idempotencyKey: key(), patientId, items: [catalogueId], ...extra,
  })
  return { orderId: placed.data.orderId, itemId: placed.data.items[0].itemId, placed }
}

/** A report filed against a line. */
async function fileResult(staff, itemId, extra = {}) {
  const recorded = await as(staff, 'record_result', {
    idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
    reportText: 'Hb 12.8 g/dL. Total count 7,400.', ...extra,
  })
  return recorded.data.resultId
}

/** The whole ordinary path up to a filed, unreviewed report. */
async function upToResult(extra = {}) {
  const c = await clinic()
  const { orderId, itemId } = await order(c.doctor, c.patientId, c.catalogue.catalogueId)
  const resultId = await fileResult(c.nurse, itemId, extra)
  return { ...c, orderId, itemId, resultId }
}

/**
 * Make a report older, through the trigger that refuses to let anything change
 * it.
 *
 * `received_at` is one of the columns `investigation_results_append_only`
 * fixes, which is the point of it — a report that can be re-dated can be moved
 * out of an escalation queue by editing a number. Nothing in the application
 * can do this; the trigger comes off for one statement so the test can
 * manufacture the passage of time, exactly as the Slice 5 image suite does,
 * and goes straight back on.
 */
async function age(resultId, interval) {
  await rows('alter table jmc.investigation_results disable trigger investigation_results_append_only')
  try {
    await rows(
      `update jmc.investigation_results set received_at = now() - $2::interval where id = $1`,
      [resultId, interval],
    )
  } finally {
    await rows('alter table jmc.investigation_results enable trigger investigation_results_append_only')
  }
}

/** A channel that answers from a script and cannot address anything but this machine. */
function channel(respond) {
  return messaging.loopbackChannel({ baseUrl: 'http://127.0.0.1:9', respond })
}

const ACCEPTS = () => ({
  ok: true, providerReference: `wamid.${randomUUID()}`, acceptStatus: 'accepted',
})

/* ═══════════════════════════ 1. the catalogue, owner item 84 ══ */

describe('who owns the investigation catalogue', () => {
  test('an ordinary doctor may draft clinical content and may not approve it', async () => {
    const { doctor } = await clinic()
    const drafted = await as(doctor, 'draft_investigation', {
      kind: 'investigation', displayName: 'Serum creatinine', category: 'biochemistry',
    })
    assert.ok(drafted.data.catalogueId)

    await assert.rejects(
      () => as(doctor, 'approve_investigation', { catalogueId: drafted.data.catalogueId }),
      (error) => error.code === 'NOT_AN_AUTHORIZED_DOCTOR',
    )
  })

  test('an administrator may prepare metadata and may not approve clinical content', async () => {
    const { owner, admin, catalogue } = await clinic()

    // Item 84's administrator clause: codes, the facility, the label.
    await as(admin, 'update_investigation_metadata', {
      catalogueId: catalogue.catalogueId,
      externalCode: '26604007', codeSystem: 'SNOMED-CT',
      defaultFacility: 'City Pathology', operationalLabel: 'FBC',
    })
    const row = (await rows(
      'select external_code, default_facility, metadata_updated_by, display_name from jmc.investigation_catalogue where id=$1',
      [catalogue.catalogueId],
    ))[0]
    assert.equal(row.external_code, '26604007')
    assert.equal(row.default_facility, 'City Pathology')
    assert.equal(row.metadata_updated_by, admin.id)
    assert.equal(row.display_name, 'Full blood count')

    const drafted = await as(admin, 'draft_investigation', {
      kind: 'referral', displayName: 'Cardiology opinion', category: 'specialist_referral',
    })
    // Refused for being an administrator rather than for lacking a flag, which
    // is item 84's own distinction: doctor-level is not a software permission.
    await assert.rejects(
      () => as(admin, 'approve_investigation', { catalogueId: drafted.data.catalogueId }),
      /Your role cannot perform this action/,
    )
    // And it takes a doctor to make it orderable.
    await as(owner, 'approve_investigation', { catalogueId: drafted.data.catalogueId })
    assert.equal(
      await scalar('select approval_state from jmc.investigation_catalogue where id=$1',
        [drafted.data.catalogueId]),
      'approved',
    )
  })

  test('an admin who has been given the clinical-authority flag is still not a doctor', async () => {
    await resetClinic()
    // The flag's own migration says it "is never inferred from admin", and item
    // 84 says doctor-level never means a non-doctor with an elevated software
    // permission. Both halves are checked, so holding one is not enough.
    const elevated = await makeStaff({
      name: 'Elevated Admin', username: 'd-elev', roles: ['admin'], pin: '6741',
      canPublishClinicalTemplates: true,
    })
    const drafted = await as(elevated, 'draft_investigation', {
      kind: 'investigation', displayName: 'Serum sodium', category: 'biochemistry',
    })
    await assert.rejects(
      () => as(elevated, 'approve_investigation', { catalogueId: drafted.data.catalogueId }),
      /Your role cannot perform this action|not authorized/,
    )
  })

  test('a nurse and a pharmacist cannot touch the catalogue at all', async () => {
    const { nurse, pharmacist, catalogue } = await clinic()
    for (const staff of [nurse, pharmacist]) {
      await assert.rejects(
        () => as(staff, 'draft_investigation', {
          kind: 'investigation', displayName: 'Anything', category: 'other',
        }),
        /Your role cannot perform this action/,
      )
      await assert.rejects(
        () => as(staff, 'update_investigation_metadata', {
          catalogueId: catalogue.catalogueId, externalCode: 'X',
        }),
        /Your role cannot perform this action/,
      )
    }
  })

  test('what an investigation IS cannot be edited; only a new version changes it', async () => {
    const { catalogue } = await clinic()
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `update jmc.investigation_catalogue set display_name='Something else' where id=$1`,
          [catalogue.catalogueId],
        ),
        /is fixed for a version/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.investigation_catalogue where id=$1', [catalogue.catalogueId]),
        /never deleted/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('a new version supersedes the old one, and orders already placed keep theirs', async () => {
    const { owner, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)

    const v2 = await as(owner, 'draft_investigation', {
      seriesId: catalogue.seriesId,
      kind: 'investigation', displayName: 'Full blood count (automated)',
      category: 'haematology', specimen: 'EDTA whole blood',
    })
    await as(owner, 'approve_investigation', { catalogueId: v2.data.catalogueId })

    assert.equal(
      await scalar('select approval_state from jmc.investigation_catalogue where id=$1',
        [catalogue.catalogueId]),
      'retired',
    )
    // The order snapshotted the name it printed, and still points at v1.
    const line = (await rows(
      'select item_name, catalogue_id from jmc.investigation_order_items where id=$1', [itemId]))[0]
    assert.equal(line.item_name, 'Full blood count')
    assert.equal(line.catalogue_id, catalogue.catalogueId)
  })

  test('an operational edit does not change what a request already printed', async () => {
    const { admin, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)

    await as(admin, 'update_investigation_metadata', {
      catalogueId: catalogue.catalogueId, externalCode: 'NEW-CODE',
      defaultFacility: 'A Different Laboratory',
    })

    const line = (await rows(
      'select item_name, item_code, external_facility from jmc.investigation_order_items where id=$1',
      [itemId],
    ))[0]
    assert.equal(line.item_name, 'Full blood count')
    assert.equal(line.item_code, '')
    assert.equal(line.external_facility, '')
  })

  test('only an approved, orderable entry can be ordered', async () => {
    const { owner, doctor, admin, patientId } = await clinic()
    const draft = await as(owner, 'draft_investigation', {
      kind: 'investigation', displayName: 'Blood culture', category: 'microbiology',
    })
    await assert.rejects(
      () => as(doctor, 'order_investigation', {
        idempotencyKey: key(), patientId, items: [draft.data.catalogueId],
      }),
      (error) => error.code === 'CATALOGUE_NOT_APPROVED',
    )

    await as(owner, 'approve_investigation', { catalogueId: draft.data.catalogueId })
    await as(admin, 'update_investigation_metadata', {
      catalogueId: draft.data.catalogueId, orderable: false,
    })
    await assert.rejects(
      () => as(doctor, 'order_investigation', {
        idempotencyKey: key(), patientId, items: [draft.data.catalogueId],
      }),
      (error) => error.code === 'CATALOGUE_NOT_ORDERABLE',
    )
  })
})

/* ═══════════════════════════ 2. ordering, and the patient boundary ══ */

describe('a request belongs to one patient and cannot be made to belong to another', () => {
  test('only a doctor orders', async () => {
    const { nurse, admin, pharmacist, patientId, catalogue } = await clinic()
    for (const staff of [nurse, admin, pharmacist]) {
      await assert.rejects(
        () => as(staff, 'order_investigation', {
          idempotencyKey: key(), patientId, items: [catalogue.catalogueId],
        }),
        /Your role cannot perform this action/,
      )
    }
  })

  test('an encounter belonging to another patient cannot be attached, by any route', async () => {
    const { doctor, patientId, otherPatientId, catalogue } = await clinic()
    await as(doctor, 'sign_consultation', {
      patientId: otherPatientId, complaint: 'Cough',
      diagnosis: 'Acute bronchitis', diagnosisStatus: 'provisional',
    })
    const otherEncounter = String(await scalar(
      'select id from jmc.encounters where patient_id=$1', [otherPatientId]))

    // Through the command.
    await assert.rejects(
      () => as(doctor, 'order_investigation', {
        idempotencyKey: key(), patientId, items: [catalogue.catalogueId],
        encounterId: otherEncounter,
      }),
      /foreign key|violates/i,
    )

    // And directly, because the composite foreign key is the guarantee rather
    // than the command being careful.
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `insert into jmc.investigation_orders
             (id, order_number, patient_id, encounter_id, ordered_by, responsible_doctor_id, status)
           values ($1,'REQ-999999',$2,$3,$4,$4,'open')`,
          [randomUUID(), patientId, otherEncounter, doctor.id],
        ),
        /investigation_orders_encounter_is_this_patients/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('a result cannot be attached to another patient’s order', async () => {
    const { doctor, patientId, otherPatientId, catalogue } = await clinic()
    const mine = await order(doctor, patientId, catalogue.catalogueId)
    const theirs = await order(doctor, otherPatientId, catalogue.catalogueId)

    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      // The caller-supplied patient id is the one thing a wrong-patient
      // attachment would need, and the composite key refuses it outright.
      await assert.rejects(
        () => db.unsafe(
          `insert into jmc.investigation_results
             (id, order_item_id, patient_id, recorded_by, source)
           values ($1,$2,$3,$4,'external_laboratory')`,
          [randomUUID(), theirs.itemId, patientId, doctor.id],
        ),
        /investigation_results_item_is_this_patients/,
      )
      // And a document cannot be hung off a result of another patient either.
      const resultId = await fileResult(doctor, mine.itemId)
      await assert.rejects(
        () => db.unsafe(
          `insert into jmc.result_documents
             (id, result_id, patient_id, storage_key, content_type, byte_size, checksum,
              source, uploaded_by)
           values ($1,$2,$3,'k','application/pdf',10,
                   '0000000000000000000000000000000000000000000000000000000000000000',
                   'external_laboratory',$4)`,
          [randomUUID(), resultId, otherPatientId, doctor.id],
        ),
        /result_documents_result_is_this_patients/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('an exact retry files one request, and a reused reference is refused', async () => {
    const { doctor, patientId, catalogue } = await clinic()
    const reference = key()
    const payload = { idempotencyKey: reference, patientId, items: [catalogue.catalogueId] }

    const first = await as(doctor, 'order_investigation', payload)
    const retry = await as(doctor, 'order_investigation', payload)

    assert.equal(retry.data.orderId, first.data.orderId)
    assert.equal(retry.data.orderNumber, first.data.orderNumber)
    assert.equal(retry.data.duplicate, true)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_orders')), 1)

    await assert.rejects(
      () => as(doctor, 'order_investigation', {
        idempotencyKey: reference, patientId, items: [catalogue.catalogueId], priority: 'urgent',
      }),
      (error) => error.code === 'INVESTIGATION_REFERENCE_REUSED',
    )
  })

  test('an exact retry still answers after the request has been cancelled', async () => {
    const { doctor, patientId, catalogue } = await clinic()
    const reference = key()
    const payload = { idempotencyKey: reference, patientId, items: [catalogue.catalogueId] }
    const first = await as(doctor, 'order_investigation', payload)
    await as(doctor, 'cancel_investigation_order', {
      orderId: first.data.orderId, reason: 'Patient declined',
    })

    // Accurate about the past and honest about the present, which is what a
    // replay owes a tablet whose reply was lost an hour ago.
    const retry = await as(doctor, 'order_investigation', payload)
    assert.equal(retry.data.orderId, first.data.orderId)
    assert.equal(retry.data.cancelled, true)
  })

  test('a request with a report on it cannot be cancelled away', async () => {
    const { doctor, itemId, orderId } = await upToResult()
    await assert.rejects(
      () => as(doctor, 'cancel_investigation_order', { orderId, reason: 'tidying up' }),
      (error) => error.code === 'RESULT_ALREADY_RECEIVED',
    )
    await assert.rejects(
      () => as(doctor, 'cancel_investigation_order', { itemId, reason: 'tidying up' }),
      (error) => error.code === 'RESULT_ALREADY_RECEIVED',
    )
  })
})

/* ═══════════════════════════ 3. the flag, owner item 85 ══ */

describe('a flag comes from one of three places and is never inferred', () => {
  test('a nurse may transcribe the report’s own flag, with its provenance', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)

    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'abnormal', sourceFlagOrigin: 'external_report',
      sourceFlagReference: 'Report CP-2211, page 1, marked H',
    })

    const row = (await rows(
      `select source_flag, source_flag_origin, source_flag_reference, source_flag_recorded_by,
              doctor_flag, effective_flag
         from jmc.investigation_results where id=$1`, [resultId]))[0]
    assert.equal(row.source_flag, 'abnormal')
    assert.equal(row.source_flag_origin, 'external_report')
    assert.equal(row.source_flag_reference, 'Report CP-2211, page 1, marked H')
    assert.equal(row.source_flag_recorded_by, nurse.id)
    // Transcription is not origination: the doctor's own flag is untouched.
    assert.equal(row.doctor_flag, 'none')
    assert.equal(row.effective_flag, 'abnormal')
  })

  test('a transcribed flag with nothing to trace it to is refused', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    await assert.rejects(
      () => as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'Hb 6.1', sourceFlag: 'critical', sourceFlagOrigin: 'external_report',
      }),
      (error) => error.code === 'FLAG_PROVENANCE_REQUIRED',
    )
  })

  test('a nurse or an administrator cannot originate a medical flag', async () => {
    const { nurse, admin, resultId } = await upToResult()
    for (const staff of [nurse, admin]) {
      await assert.rejects(
        () => as(staff, 'flag_result', { resultId, flag: 'critical', reason: 'looks low to me' }),
        /Your role cannot perform this action/,
      )
    }
    // And there is no parameter on record_result that reaches the doctor's
    // flag, so passing one changes nothing rather than being honoured.
    assert.equal(
      await scalar('select doctor_flag from jmc.investigation_results where id=$1', [resultId]),
      'none',
    )
  })

  test('a doctor’s flag never erases what the laboratory reported', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'abnormal', sourceFlagOrigin: 'external_report',
      sourceFlagReference: 'CP-2211 H',
    })

    await as(doctor, 'flag_result', {
      resultId, flag: 'critical', reason: 'Hb 6.1 with symptoms; treat as critical.',
    })

    const row = (await rows(
      `select source_flag, source_flag_origin, doctor_flag, doctor_flag_by, doctor_flag_reason,
              effective_flag
         from jmc.investigation_results where id=$1`, [resultId]))[0]
    assert.equal(row.source_flag, 'abnormal')
    assert.equal(row.source_flag_origin, 'external_report')
    assert.equal(row.doctor_flag, 'critical')
    assert.equal(row.doctor_flag_by, doctor.id)
    // The database takes the more severe of two recorded flags. It does not
    // read the report and form an opinion.
    assert.equal(row.effective_flag, 'critical')
  })

  test('a clinical flag is written once and cannot be withdrawn', async () => {
    const { doctor, resultId } = await upToResult()
    await as(doctor, 'flag_result', { resultId, flag: 'abnormal', reason: 'Borderline' })
    await assert.rejects(
      () => as(doctor, 'flag_result', { resultId, flag: 'none', reason: 'changed my mind' }),
      /flag is not valid|ALREADY_FLAGGED/,
    )
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `update jmc.investigation_results set doctor_flag='none', doctor_flag_at=null,
              doctor_flag_by=null, doctor_flag_reason='' where id=$1`, [resultId]),
        /cannot be rewritten or withdrawn/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('no application code infers abnormality from a report', async () => {
    // A report full of the words a threshold would key on, filed with no flag.
    // Nothing anywhere reads it and decides.
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      reportText: 'Hb 4.2 g/dL (ref 12.0-15.0) CRITICAL HIGH ABNORMAL ***PANIC VALUE***',
    })
    const row = (await rows(
      'select source_flag, doctor_flag, effective_flag from jmc.investigation_results where id=$1',
      [resultId]))[0]
    assert.equal(row.source_flag, 'none')
    assert.equal(row.doctor_flag, 'none')
    assert.equal(row.effective_flag, 'none')
  })
})

/* ═══════════════════════════ 4. review, owner item 86 ══ */

describe('a doctor reads the result before the patient hears about it', () => {
  test('external technical validation is retained and is not clinic review', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      externalValidatedBy: 'Dr S. Pathologist, City Pathology',
      externalSignatoryReference: 'Digitally signed, ref CP-2211',
    })

    const row = (await rows(
      'select external_validated_by, external_signatory_reference from jmc.investigation_results where id=$1',
      [resultId]))[0]
    assert.equal(row.external_validated_by, 'Dr S. Pathologist, City Pathology')
    assert.ok(row.external_signatory_reference)

    // Retained, and it counts for nothing here: there is no review, and a
    // notification is refused because of that and not for any other reason.
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 0)
    await assert.rejects(
      () => as(doctor, 'authorize_result_notification', { resultId }),
      (error) => error.code === 'RESULT_NOT_REVIEWED',
    )
  })

  test('only the responsible, ordering or delegated doctor may review', async () => {
    const { doctor, other, owner, nurse, admin, orderId, resultId } = await upToResult()

    for (const staff of [nurse, admin]) {
      await assert.rejects(
        () => as(staff, 'review_result', { resultId, conclusion: 'no_action_needed' }),
        /Your role cannot perform this action/,
      )
    }
    // A doctor with no connection to the request, and the owner-doctor, who is
    // an escalation target rather than an implicit reviewer.
    for (const staff of [other, owner]) {
      await assert.rejects(
        () => as(staff, 'review_result', { resultId, conclusion: 'no_action_needed' }),
        (error) => error.code === 'NOT_THE_RESPONSIBLE_DOCTOR',
      )
    }

    // Explicit delegation is what gives the locum standing, and it is recorded.
    await as(doctor, 'delegate_result_review', {
      orderId, toDoctorId: other.id, reason: 'On leave until Monday',
    })
    const reviewed = await as(other, 'review_result', {
      resultId, conclusion: 'patient_to_be_informed',
    })
    assert.equal(reviewed.data.basis, 'delegated_doctor')
    assert.equal(
      await scalar('select basis from jmc.result_reviews where result_id=$1', [resultId]),
      'delegated_doctor',
    )
  })

  test('the owner-doctor takes a stranded result by delegating it, which is recorded', async () => {
    const { owner, orderId, resultId } = await upToResult()
    await as(owner, 'delegate_result_review', {
      orderId, toDoctorId: owner.id, reason: 'Unreviewed for a day; taking it on.',
    })
    const reviewed = await as(owner, 'review_result', { resultId, conclusion: 'no_action_needed' })
    assert.equal(reviewed.data.basis, 'delegated_doctor')
    const row = (await rows(
      'select delegated_doctor_id, delegated_by, delegation_reason from jmc.investigation_orders where id=$1',
      [orderId]))[0]
    assert.equal(row.delegated_doctor_id, owner.id)
    assert.ok(row.delegation_reason)
  })

  test('a review is written once and is never edited', async () => {
    const { doctor, resultId } = await upToResult()
    await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed', note: 'Normal' })
    const id = String(await scalar('select id from jmc.result_reviews where result_id=$1', [resultId]))

    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(`update jmc.result_reviews set conclusion='clinical_action_taken' where id=$1`, [id]),
        /never edited or deleted/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.result_reviews where id=$1', [id]),
        /never edited or deleted/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('the same doctor pressing Review twice does not write two reviews', async () => {
    const { doctor, resultId } = await upToResult()
    await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' })
    const again = await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' })
    assert.equal(again.data.duplicate, true)
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 1)
  })
})

/* ═══════════════════════════ 5. correction, and stale release ══ */

describe('a corrected report keeps the first one and invalidates what it earned', () => {
  test('the old report stays, and the new one starts with no review', async () => {
    const { nurse, doctor, itemId, resultId } = await upToResult()
    await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' })

    const corrected = await as(nurse, 'record_result', {
      idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
      reportText: 'Corrected: Hb 10.1 g/dL.',
      correctsResultId: resultId, correctionReason: 'Laboratory re-issued with corrected Hb',
    })
    const newId = corrected.data.resultId

    const old = (await rows(
      'select report_text, superseded_at, superseded_by_result_id from jmc.investigation_results where id=$1',
      [resultId]))[0]
    assert.equal(old.report_text, 'Hb 12.8 g/dL. Total count 7,400.')
    assert.ok(old.superseded_at)
    assert.equal(old.superseded_by_result_id, newId)

    // The old review is still attached to the old report, and the new one has
    // none — because a review belongs to a result id and this is a new one.
    assert.equal(Number(await scalar(
      'select count(*) from jmc.result_reviews where result_id=$1', [resultId])), 1)
    assert.equal(Number(await scalar(
      'select count(*) from jmc.result_reviews where result_id=$1', [newId])), 0)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_results')), 2)
  })

  test('a stale review and a stale authorization cannot release a superseded report', async () => {
    const { nurse, doctor, itemId, resultId } = await upToResult()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(doctor, 'authorize_result_notification', { resultId })

    const corrected = await as(nurse, 'record_result', {
      idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
      reportText: 'Corrected.', correctsResultId: resultId, correctionReason: 'Re-issued',
    })
    assert.equal(corrected.data.supersededNotifications, 1)

    // The old notice stopped with the report it was about.
    const schedule = (await rows(
      `select status from jmc.communication_schedules
        where source_type='investigation_result' and source_id=$1`, [resultId]))[0]
    assert.equal(schedule.status, 'superseded')
    const outbox = (await rows(
      `select o.status from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id
        where s.source_id=$1`, [resultId]))[0]
    assert.equal(outbox.status, 'cancelled')

    // And the correction cannot be released on the strength of them.
    await assert.rejects(
      () => as(doctor, 'authorize_result_notification', { resultId: corrected.data.resultId }),
      (error) => error.code === 'RESULT_NOT_REVIEWED',
    )
    await assert.rejects(
      () => as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' }),
      (error) => error.code === 'RESULT_SUPERSEDED',
    )
  })

  test('a second report that does not say it is a correction is refused', async () => {
    const { nurse, itemId } = await upToResult()
    await assert.rejects(
      () => as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'A different reading entirely.',
      }),
      (error) => error.code === 'RESULT_ALREADY_RECORDED',
    )
  })

  test('a report cannot be corrected twice, and not across investigations', async () => {
    const { nurse, doctor, patientId, catalogue, itemId, resultId } = await upToResult()
    await as(nurse, 'record_result', {
      idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
      reportText: 'First correction.', correctsResultId: resultId, correctionReason: 'a',
    })
    await assert.rejects(
      () => as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'Second correction of the same one.',
        correctsResultId: resultId, correctionReason: 'b',
      }),
      (error) => error.code === 'ALREADY_SUPERSEDED',
    )

    const elsewhere = await order(doctor, patientId, catalogue.catalogueId)
    await assert.rejects(
      () => as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: elsewhere.itemId, source: 'external_laboratory',
        reportText: 'Belongs somewhere else.',
        correctsResultId: resultId, correctionReason: 'c',
      }),
      (error) => error.code === 'CORRECTION_CROSSES_INVESTIGATION',
    )
  })

  test('the report itself is written once', async () => {
    const { resultId } = await upToResult()
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(`update jmc.investigation_results set report_text='rewritten' where id=$1`, [resultId]),
        /written once/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.investigation_results where id=$1', [resultId]),
        /never deleted/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('an exact retry of a filing creates one report, and a reused reference is refused', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const reference = key()
    const payload = {
      idempotencyKey: reference, orderItemId: itemId, source: 'external_laboratory',
      reportText: 'Hb 12.8',
    }
    const first = await as(nurse, 'record_result', payload)
    const retry = await as(nurse, 'record_result', payload)
    assert.equal(retry.data.resultId, first.data.resultId)
    assert.equal(retry.data.duplicate, true)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_results')), 1)

    await assert.rejects(
      () => as(nurse, 'record_result', { ...payload, reportText: 'something else' }),
      (error) => error.code === 'RESULT_REFERENCE_REUSED',
    )
  })
})

/* ═══════════════════════════ 6. item 87, the clock that never releases ══ */

describe('an unreviewed result escalates, and escalation tells nobody but a doctor', () => {
  test('a critical result is on the owner-doctor’s escalation list at once', async () => {
    const { owner, doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report',
      sourceFlagReference: 'CP-2211 marked CRITICAL',
    })

    const ownerView = await diagnostics.readResultEscalations(sessionFor(owner))
    const row = ownerView.rows.find((entry) => entry.resultId === resultId)
    assert.ok(row, 'the owner-doctor sees it')
    assert.equal(row.reason, 'critical_unacknowledged')
    assert.equal(row.manualEscalationOwed, false)
    // Item 87 names a backup doctor the clinic has not configured. The read
    // says so rather than letting a screen imply one exists.
    assert.equal(ownerView.backupDoctorConfigured, false)

    // The responsible doctor sees it too; an unconnected doctor does not.
    const responsible = await diagnostics.readResultEscalations(sessionFor(doctor))
    assert.ok(responsible.rows.some((entry) => entry.resultId === resultId))
  })

  test('fifteen unacknowledged minutes owes somebody a telephone call and releases nothing', async () => {
    const { owner, doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })
    await age(resultId, '20 minutes')

    const view = await diagnostics.readResultEscalations(sessionFor(owner))
    const row = view.rows.find((entry) => entry.resultId === resultId)
    assert.equal(row.manualEscalationOwed, true)
    assert.equal(view.criticalAcknowledgementMinutes, 15)

    // And nothing was released by the clock. No review, no authorization, no
    // schedule, no message.
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 0)
    assert.equal(
      await scalar('select notification_authorized_at from jmc.investigation_results where id=$1', [resultId]),
      null,
    )
    assert.equal(Number(await scalar('select count(*) from jmc.communication_schedules')), 0)
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)
  })

  test('an acknowledgement takes it off the critical list and leaves the review owing', async () => {
    const { owner, doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })

    // The owner-doctor may acknowledge it even without standing, because item
    // 87 escalates to them and an escalation nobody can act on is a notice.
    await as(owner, 'acknowledge_critical_result', { resultId, note: 'Telephoned the patient.' })
    const row = (await rows(
      'select critical_acknowledged_by, critical_acknowledged_at from jmc.investigation_results where id=$1',
      [resultId]))[0]
    assert.equal(row.critical_acknowledged_by, owner.id)
    assert.ok(row.critical_acknowledged_at)

    const view = await diagnostics.readResultEscalations(sessionFor(doctor))
    assert.equal(view.rows.filter((entry) => entry.reason === 'critical_unacknowledged').length, 0)

    // Acknowledging is not reviewing.
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 0)
  })

  test('an acknowledgement is written once and cannot be undone', async () => {
    const { owner, doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })
    await as(owner, 'acknowledge_critical_result', { resultId })
    const again = await as(doctor, 'acknowledge_critical_result', { resultId })
    assert.equal(again.data.duplicate, true)
    assert.equal(
      await scalar('select critical_acknowledged_by from jmc.investigation_results where id=$1', [resultId]),
      owner.id,
    )
  })

  test('four clinic hours, or the ceiling, whichever comes first', async () => {
    const { owner, doctor, resultId } = await upToResult()

    // Not yet.
    let view = await diagnostics.readResultEscalations(sessionFor(owner))
    assert.equal(view.rows.filter((entry) => entry.resultId === resultId).length, 0)

    await age(resultId, '5 hours')
    view = await diagnostics.readResultEscalations(sessionFor(owner))
    const row = view.rows.find((entry) => entry.resultId === resultId)
    assert.ok(row, 'five hours later the owner-doctor has it')
    assert.equal(row.reason, 'unreviewed_past_clinic_hours')

    // The four-hour half and the ceiling half are both in the expression, and
    // the expected answer is computed in Postgres in the clinic's own timezone
    // rather than asserted as a fixed hour — a test that hard-coded one would
    // pass all morning and fail at nine at night.
    const expected = await scalar(
      `select least(
          case
            when extract(hour from ((r.received_at + interval '4 hours') at time zone 'Asia/Kolkata')) < 8
              then ((((r.received_at + interval '4 hours') at time zone 'Asia/Kolkata')::date
                     + make_time(8,0,0)) at time zone 'Asia/Kolkata')
            when extract(hour from ((r.received_at + interval '4 hours') at time zone 'Asia/Kolkata')) >= 20
              then ((((r.received_at + interval '4 hours') at time zone 'Asia/Kolkata')::date + 1
                     + make_time(8,0,0)) at time zone 'Asia/Kolkata')
            else r.received_at + interval '4 hours'
          end,
          case
            when extract(hour from (r.received_at at time zone 'Asia/Kolkata')) < 20
              then (((r.received_at at time zone 'Asia/Kolkata')::date + make_time(20,0,0))
                    at time zone 'Asia/Kolkata')
            else (((r.received_at at time zone 'Asia/Kolkata')::date + 1 + make_time(20,0,0))
                  at time zone 'Asia/Kolkata')
          end) <= now() as due
         from jmc.investigation_results r where r.id=$1`,
      [resultId],
    )
    assert.equal(expected, true)

    // And still nothing has been released to anybody.
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)
  })

  test('a reviewed result leaves the escalation list', async () => {
    const { owner, doctor, resultId } = await upToResult()
    await age(resultId, '9 hours')
    await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' })
    const view = await diagnostics.readResultEscalations(sessionFor(owner))
    assert.equal(view.rows.filter((entry) => entry.resultId === resultId).length, 0)
  })
})

/* ═══════════════════════════ 7. item 88, what the patient is told ══ */

describe('the patient is told a result is ready, and nothing else', () => {
  test('no notification can be authorized before the current result is reviewed', async () => {
    const { doctor, resultId } = await upToResult()
    await assert.rejects(
      () => as(doctor, 'authorize_result_notification', { resultId }),
      (error) => error.code === 'RESULT_NOT_REVIEWED',
    )

    // And the database refuses it too, so there is no second code path.
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `update jmc.investigation_results
              set notification_authorized_by=$2, notification_authorized_at=now() where id=$1`,
          [resultId, doctor.id],
        ),
        /before a doctor has clinically reviewed it/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  test('a critical result never enters the automated path, by command or by column', async () => {
    const { doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })
    await as(doctor, 'review_result', { resultId, conclusion: 'clinical_action_taken' })

    await assert.rejects(
      () => as(doctor, 'authorize_result_notification', { resultId }),
      (error) => error.code === 'CRITICAL_RESULT_NEEDS_DIRECT_CONTACT',
    )

    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(
          `update jmc.investigation_results
              set notification_authorized_by=$2, notification_authorized_at=now() where id=$1`,
          [resultId, doctor.id],
        ),
        /violates check constraint/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }

    // The clinician-led route is open, and it is what gets recorded.
    await as(doctor, 'record_patient_result_contact', {
      resultId, method: 'telephone', note: 'Spoke to patient, asked her to come in today.',
    })
    assert.equal(
      await scalar('select patient_contact_method from jmc.investigation_results where id=$1', [resultId]),
      'telephone',
    )
  })

  test('a nurse or an administrator cannot record a critical result’s contact', async () => {
    const { doctor, nurse, admin, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })
    for (const staff of [nurse, admin]) {
      await assert.rejects(
        () => as(staff, 'record_patient_result_contact', {
          resultId, method: 'telephone', note: 'told them',
        }),
        (error) => error.code === 'CRITICAL_CONTACT_IS_CLINICIAN_LED',
      )
    }
  })

  test('the notice carries no clinical detail, and the template cannot be made to', async () => {
    const { owner, admin } = await clinic()
    // Owner item 88's exact wording, which the schema's own guards accept.
    const drafted = await as(owner, 'draft_message_template', {
      purpose: 'result_ready',
      body: 'Your investigation result has been reviewed and is ready. Please contact the clinic.',
      variables: [],
    })
    await as(owner, 'approve_message_template', { templateId: drafted.data.templateId })
    await as(admin, 'record_provider_template_state', {
      templateId: drafted.data.templateId, providerState: 'approved',
      providerTemplateName: 'jmc_result_ready',
    })

    const body = String(await scalar(
      'select body from jmc.message_templates where id=$1', [drafted.data.templateId]))
    assert.equal(body, 'Your investigation result has been reviewed and is ready. Please contact the clinic.')
    assert.equal(
      Number(await scalar(
        `select count(*) from jmc.message_templates where id=$1 and variables_json='[]'`,
        [drafted.data.templateId])),
      1,
    )

    // And a template that tried to carry the result is refused before anybody
    // could approve it: the variable whitelist has no name for one.
    await assert.rejects(
      () => as(owner, 'draft_message_template', {
        purpose: 'result_ready',
        body: 'Your {{result_value}} is ready.',
        variables: ['result_value'],
      }),
      (error) => error.code === 'TEMPLATE_VARIABLE_NOT_ALLOWED',
    )
  })

  test('result-ready consent is its own consent, and the pharmacy purpose is not it', async () => {
    const { nurse, patientId } = await clinic()
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'ready_for_collection',
      wording: 'Jayamurugan Clinic may tell you when your medicine is ready.',
      source: 'staff_recorded',
    })
    assert.equal(await messaging.effectiveConsent(patientId, 'ready_for_collection'), 'opt_in')
    assert.equal(await messaging.effectiveConsent(patientId, 'result_ready'), 'none')
  })

  test('authorization is not delivery, and neither is a queued message', async () => {
    const { owner, admin, nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready',
      wording: 'Jayamurugan Clinic may tell you when a result is ready.',
      source: 'staff_recorded',
    })

    const authorized = await as(doctor, 'authorize_result_notification', { resultId })
    assert.equal(authorized.data.consent, 'opt_in')

    // Authorized. Nothing has been told to anybody.
    let state = await itemStateOf(doctor, resultId)
    assert.equal(state, 'notification_pending')

    const sent = []
    await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })
    await messaging.dispatchQueuedMessages({
      channel: channel((request) => { sent.push(request); return ACCEPTS() }),
    })
    assert.equal(sent.length, 1)

    // Meta accepted it. That is not delivery, and the state says so.
    const outbox = (await rows(
      `select o.status, o.delivery_status from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id
        where s.source_id=$1`, [resultId]))[0]
    assert.equal(outbox.status, 'sent_to_provider')
    assert.equal(outbox.delivery_status, 'accepted')
    state = await itemStateOf(doctor, resultId)
    assert.equal(state, 'notification_pending')
    assert.notEqual(state, 'notified')
  })

  test('only authenticated provider evidence makes it notified', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })
    await messaging.dispatchQueuedMessages({ channel: channel(() => ACCEPTS()) })

    const reference = String(await scalar(
      `select o.provider_reference from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`,
      [resultId]))
    await messaging.applyProviderStatusEvent({
      providerReference: reference, status: 'delivered', occurredAt: new Date().toISOString(),
    })

    assert.equal(await itemStateOf(doctor, resultId), 'notified')
  })

  test('a lost provider reply stays unknown and nothing resends', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })

    // The call goes out and the answer never comes back.
    await messaging.dispatchQueuedMessages({
      channel: channel(() => { throw new Error('socket closed') }),
    }).catch(() => {})

    const before = (await rows(
      `select o.status, o.attempt_count from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`,
      [resultId]))[0]

    // Running the worker again changes nothing: outcome_unknown is not
    // dispatchable and no elapsed time moves it.
    await messaging.dispatchQueuedMessages({ channel: channel(() => ACCEPTS()) })
    const after = (await rows(
      `select o.status, o.attempt_count from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`,
      [resultId]))[0]
    assert.equal(after.status, before.status)
    assert.equal(Number(after.attempt_count), Number(before.attempt_count))
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
  })

  test('consent withdrawn before dispatch suppresses the notice', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await as(nurse, 'withdraw_communication_consent', {
      patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
    })

    const summary = await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })
    assert.equal(summary.queued, 0)
    // Suppressed with a reason, not silently dropped: owner item 76 sends the
    // work to the admin's queue and a suppressed row IS that queue entry.
    const outbox = (await rows(
      `select o.status, o.suppression_reason from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`,
      [resultId]))[0]
    assert.equal(outbox.status, 'suppressed')
    assert.equal(outbox.suppression_reason, 'consent_withdrawn')
  })

  test('a correction after queueing suppresses the stale notice with a reason', async () => {
    const { nurse, doctor, patientId, itemId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })

    // Queued, not sent. Then the laboratory re-issues.
    assert.equal(
      await scalar(`select o.status from jmc.message_outbox o
                      join jmc.communication_schedules s on s.id=o.schedule_id
                     where s.source_id=$1`, [resultId]),
      'queued',
    )
    await as(nurse, 'record_result', {
      idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
      reportText: 'Corrected.', correctsResultId: resultId, correctionReason: 'Re-issued',
    })

    const sent = []
    await messaging.dispatchQueuedMessages({
      channel: channel((request) => { sent.push(request); return ACCEPTS() }),
    })
    assert.equal(sent.length, 0, 'nothing left the building')
    assert.equal(
      await scalar(`select o.status from jmc.message_outbox o
                      join jmc.communication_schedules s on s.id=o.schedule_id
                     where s.source_id=$1`, [resultId]),
      'cancelled',
    )
  })

  test('an authorization withdrawn from under a queued message suppresses it by name', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })

    /*
     * There is no command that un-authorizes a notice — an authorization is
     * evidence and the trigger refuses to rewrite one. What this proves is
     * that the dispatch step asks the question rather than trusting the queue,
     * so the guard holds against a state no command can currently produce.
     *
     * It is also the one case the schedule-status check cannot see, and so the
     * one that proves the result-specific recheck is load-bearing rather than
     * decorative. A correction, by contrast, supersedes the schedule, so the
     * test above passes on either guard alone — which is what defence in depth
     * looks like and is worth saying rather than implying.
     */
    await rows('alter table jmc.investigation_results disable trigger investigation_results_append_only')
    try {
      // All three together, because a schedule pointer with no authorization
      // behind it is a state a check constraint already refuses — which is
      // itself worth knowing, and is asserted separately below.
      await rows(
        `update jmc.investigation_results
            set notification_authorized_at=null, notification_authorized_by=null,
                notification_schedule_id=null
          where id=$1`,
        [resultId],
      )
    } finally {
      await rows('alter table jmc.investigation_results enable trigger investigation_results_append_only')
    }

    const sent = []
    await messaging.dispatchQueuedMessages({
      channel: channel((request) => { sent.push(request); return ACCEPTS() }),
    })
    assert.equal(sent.length, 0)
    const outbox = (await rows(
      `select o.status, o.suppression_reason from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`,
      [resultId]))[0]
    assert.equal(outbox.status, 'suppressed')
    assert.equal(outbox.suppression_reason, 'result_not_authorized')
  })

  test('a notice pointer cannot outlive the authorization behind it', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results, please.', source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })

    // Even with the append-only trigger out of the way, the row cannot hold a
    // scheduled notice with nobody's authorization behind it.
    await rows('alter table jmc.investigation_results disable trigger investigation_results_append_only')
    try {
      await assert.rejects(
        () => rows(
          `update jmc.investigation_results
              set notification_authorized_at=null, notification_authorized_by=null where id=$1`,
          [resultId],
        ),
        /violates check constraint/,
      )
    } finally {
      await rows('alter table jmc.investigation_results enable trigger investigation_results_append_only')
    }
  })

  test('with the clinic’s channel unconfigured, nothing leaves and the admin gets the work', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results on WhatsApp, please.',
      source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })

    // The default channel is the real one, and it is disabled without the four
    // WHATSAPP_* variables — which is this clinic's actual state.
    const summary = await messaging.prepareDueMessages()
    assert.equal(summary.queued, 0)
    assert.equal(summary.reasons.channel_not_configured, 1)
  })

  test('a patient with no consent gets a queue entry rather than a message', async () => {
    const { doctor, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    const authorized = await as(doctor, 'authorize_result_notification', { resultId })
    assert.equal(authorized.data.consent, 'none')

    const summary = await messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) })
    assert.equal(summary.queued, 0)
    assert.equal(summary.reasons.no_consent, 1)
  })
})

/* ═══════════════════════════ 8. documents ══ */

describe('a report document is private, provable and never a URL', () => {
  test('no table in this slice holds anything that looks like a link', async () => {
    const columns = await rows(
      `select table_name, column_name from information_schema.columns
        where table_schema='jmc'
          and table_name in ('investigation_catalogue','investigation_orders',
                             'investigation_order_items','investigation_results',
                             'result_documents','result_reviews')
          and (column_name ilike '%url%' or column_name ilike '%link%'
               or column_name ilike '%public%' or column_name ilike '%href%')`,
    )
    assert.equal(columns.length, 0, `unexpected link-shaped columns: ${JSON.stringify(columns)}`)
  })

  test('a doctor attaches a report and can open it; the bytes are verified on the way out', async () => {
    const { doctor, resultId } = await upToResult()
    const token = await tokenFor(doctor)
    const uploaded = await attach(resultId, token)
    assert.equal(uploaded.body.ok, true)

    const ticket = await edgeGet('results', `?action=ticket&documentId=${uploaded.body.documentId}`, token)
    assert.equal(ticket.body.ok, true)

    const fetched = await edgeRequest(
      'results', `?documentId=${uploaded.body.documentId}&ticket=${ticket.body.ticket}`, { token })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.contentType, 'application/pdf')
    assert.equal(fetched.cacheControl, 'no-store, private')
    assert.ok(fetched.bytes && fetched.bytes.byteLength > 0)
  })

  test('the bytes need a ticket as well as a session', async () => {
    const { doctor, resultId } = await upToResult()
    const token = await tokenFor(doctor)
    const uploaded = await attach(resultId, token)
    const refused = await edgeRequest(
      'results', `?documentId=${uploaded.body.documentId}&ticket=nonsense.deadbeef`, { token })
    assert.equal(refused.status, 403)
  })

  test('a duplicate upload, and a lost reply, produce one document', async () => {
    const { doctor, resultId } = await upToResult()
    const token = await tokenFor(doctor)
    const reference = key()

    const first = await attach(resultId, token, { idempotencyKey: reference })
    const retry = await attach(resultId, token, { idempotencyKey: reference })
    assert.equal(retry.body.documentId, first.body.documentId)
    assert.equal(retry.body.duplicate, true)

    // The same bytes under a fresh reference is the other shape of the same
    // mistake, and the checksum answers it.
    const again = await attach(resultId, token, { idempotencyKey: key() })
    assert.equal(again.body.documentId, first.body.documentId)
    assert.equal(again.body.duplicate, true)

    assert.equal(Number(await scalar('select count(*) from jmc.result_documents')), 1)
  })

  test('a reference reused for different bytes is refused', async () => {
    const { doctor, resultId } = await upToResult()
    const token = await tokenFor(doctor)
    const reference = key()
    await attach(resultId, token, { idempotencyKey: reference })
    const clash = await attach(resultId, token, {
      idempotencyKey: reference, content: '%PDF-1.4 a different report entirely',
    })
    assert.equal(clash.body.ok, false)
    assert.match(clash.body.message, /already used for a different upload/)
    assert.equal(Number(await scalar('select count(*) from jmc.result_documents')), 1)
  })

  test('an administrator may attach a report and may not open one', async () => {
    const { admin, doctor, resultId } = await upToResult()
    const adminToken = await tokenFor(admin)
    const uploaded = await attach(resultId, adminToken)
    assert.equal(uploaded.body.ok, true)

    const ticket = await edgeGet('results', `?action=ticket&documentId=${uploaded.body.documentId}`, adminToken)
    assert.equal(ticket.status, 403)
    assert.match(ticket.body.message, /not the report itself/)

    // A doctor opens the same document without trouble.
    const doctorToken = await tokenFor(doctor)
    const allowed = await edgeGet('results', `?action=ticket&documentId=${uploaded.body.documentId}`, doctorToken)
    assert.equal(allowed.body.ok, true)
  })

  test('a document cannot be attached to a superseded report', async () => {
    const { nurse, doctor, itemId, resultId } = await upToResult()
    await as(nurse, 'record_result', {
      idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
      reportText: 'Corrected.', correctsResultId: resultId, correctionReason: 'Re-issued',
    })
    const refused = await attach(resultId, await tokenFor(doctor))
    assert.equal(refused.status, 409)
  })

  test('a failed upload does not write the patient into a log line', async () => {
    /*
     * `console.error(error)` on a Postgres constraint violation prints the
     * server's `detail`, and for a check or a unique violation that field is
     * the failing row:
     *
     *     DETAIL: Failing row contains (Mrs Patient, HIV serology, x).
     *
     * `result_documents.original_filename` is whatever the laboratory called
     * the file, which is routinely `SMITH_JOHN_HIV_2026.pdf`. Edge Function
     * logs are read in a dashboard, kept by the platform and pasted into
     * support threads. Found reviewing this slice, in three endpoints — two
     * of them older than it — and `logFailure` is the answer.
     */
    const { doctor, resultId } = await upToResult()
    const token = await tokenFor(doctor)
    const reference = key()
    await attach(resultId, token, { idempotencyKey: reference })

    const logged = []
    const real = console.error
    console.error = (...parts) => { logged.push(parts.map(String).join(' ')) }
    try {
      // The same reference with different bytes: refused, and the refusal
      // path is the one that logs.
      await attach(resultId, token, {
        idempotencyKey: reference,
        content: '%PDF-1.4 SMITH_JOHN_HIV_2026 confidential serology report',
      })
    } finally {
      console.error = real
    }

    const everything = logged.join('\n')
    assert.doesNotMatch(everything, /Failing row contains/)
    assert.doesNotMatch(everything, /SMITH_JOHN_HIV/)
    assert.doesNotMatch(everything, /Result Patient/)
  })

  test('a stored document is what it is, and is never deleted', async () => {
    const { doctor, resultId } = await upToResult()
    const uploaded = await attach(resultId, await tokenFor(doctor))
    const db = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      await assert.rejects(
        () => db.unsafe(`update jmc.result_documents set checksum='0' where id=$1`,
          [uploaded.body.documentId]),
        /what it is/,
      )
      await assert.rejects(
        () => db.unsafe('delete from jmc.result_documents where id=$1', [uploaded.body.documentId]),
        /clinical record/,
      )
    } finally {
      await db.end({ timeout: 5 })
    }
  })
})

/* ═══════════════════════════ 9. the pharmacy, and minimum necessary ══ */

describe('who may see any of this', () => {
  test('a pharmacist is refused every command, every read and the document endpoint', async () => {
    const { pharmacist, orderId, itemId, resultId, patientId, catalogue } = await upToResult()

    const commands = [
      ['draft_investigation', { kind: 'investigation', displayName: 'X', category: 'other' }],
      ['approve_investigation', { catalogueId: catalogue.catalogueId }],
      ['retire_investigation', { catalogueId: catalogue.catalogueId, reason: 'x' }],
      ['update_investigation_metadata', { catalogueId: catalogue.catalogueId, externalCode: 'x' }],
      ['order_investigation', { idempotencyKey: key(), patientId, items: [catalogue.catalogueId] }],
      ['cancel_investigation_order', { orderId, reason: 'x' }],
      ['mark_investigation_sent', { itemId }],
      ['record_result', { idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory', reportText: 'x' }],
      ['flag_result', { resultId, flag: 'abnormal', reason: 'x' }],
      ['acknowledge_critical_result', { resultId }],
      ['delegate_result_review', { orderId, toDoctorId: pharmacist.id, reason: 'x' }],
      ['review_result', { resultId, conclusion: 'no_action_needed' }],
      ['authorize_result_notification', { resultId }],
      ['record_patient_result_contact', { resultId, method: 'telephone', note: 'x' }],
    ]
    for (const [action, payload] of commands) {
      await assert.rejects(
        () => as(pharmacist, action, payload),
        /Your role cannot perform this action|no access to investigations/,
        `${action} should refuse a pharmacist`,
      )
    }

    const token = await tokenFor(pharmacist)
    for (const view of [
      '?view=result_review_queue', '?view=result_escalations',
      `?view=investigation_order&orderId=${orderId}`,
      `?view=patient_investigations&patientId=${patientId}`,
    ]) {
      const response = await edgeGet('workspace', view, token)
      assert.equal(response.status, 403, `${view} should refuse a pharmacist`)
    }

    const document = await edgeGet('results', '?action=ticket&documentId=anything', token)
    assert.equal(document.status, 403)
    assert.match(document.body.message, /no access to results/)
  })

  test('an administrator gets the outstanding work and none of the clinical half', async () => {
    const { admin, doctor, nurse, patientId, catalogue } = await clinic()
    const { orderId, itemId } = await order(doctor, patientId, catalogue.catalogueId)
    await fileResult(nurse, itemId, {
      reportText: 'Hb 12.8 g/dL.',
      sourceFlag: 'abnormal', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP H',
    })

    const queue = await diagnostics.readResultReviewQueue(sessionFor(admin))
    assert.equal(queue.access, 'operational')
    const row = queue.rows.find((entry) => entry.orderId === orderId)
    assert.ok(row, 'the admin can chase it')
    assert.equal(row.itemName, 'Full blood count')
    assert.equal(row.flag, undefined)
    assert.equal(row.criticalUnacknowledged, undefined)

    const view = await diagnostics.readInvestigationOrder(sessionFor(admin), orderId)
    assert.equal(view.access, 'operational')
    assert.equal(view.items[0].results[0].reportText, undefined)
    assert.equal(view.items[0].results[0].flag, undefined)
    // Operational facts are there: that a report exists, and when.
    assert.ok(view.items[0].results[0].receivedAt)
    assert.equal(view.items[0].state, 'awaiting_review')
  })

  test('the state of a line is the same fact whoever is reading it', async () => {
    /*
     * The state is a fact about the clinic, not about the reader. The first
     * version derived it from the already-minimized view, so an administrator
     * — who is not shown a review's conclusion — saw `reviewed` on a line a
     * doctor saw as `closed`. Nothing leaked; the clinic simply reported two
     * different states for one line depending on who asked, which is the kind
     * of thing discovered during an argument about whether something was
     * dealt with. Found reviewing this slice.
     */
    const { admin, doctor, nurse, orderId, resultId } = await upToResult()
    await as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' })

    const asDoctor = await diagnostics.readInvestigationOrder(sessionFor(doctor), orderId)
    const asAdmin = await diagnostics.readInvestigationOrder(sessionFor(admin), orderId)
    const asNurse = await diagnostics.readInvestigationOrder(sessionFor(nurse), orderId)

    assert.equal(asDoctor.items[0].state, 'closed')
    assert.equal(asAdmin.items[0].state, 'closed')
    assert.equal(asNurse.items[0].state, 'closed')

    // And the minimization still happens, on the way out only.
    assert.equal(asDoctor.items[0].results[0].review.conclusion, 'no_action_needed')
    assert.equal(asAdmin.items[0].results[0].review.conclusion, undefined)
    assert.ok(asAdmin.items[0].results[0].review.reviewedBy, 'that it was reviewed, and by whom, is operational')
  })

  test('a nurse sees the results of a patient in their care and not of one who is not', async () => {
    const { nurse, doctor, patientId, otherPatientId, catalogue } = await clinic()
    const mine = await order(doctor, patientId, catalogue.catalogueId)
    const theirs = await order(doctor, otherPatientId, catalogue.catalogueId)
    await fileResult(doctor, mine.itemId)
    await fileResult(doctor, theirs.itemId)

    const allowed = await diagnostics.readInvestigationOrder(sessionFor(nurse), mine.orderId)
    assert.equal(allowed.access, 'clinical')
    assert.ok(allowed.items[0].results[0].reportText)

    const refused = await diagnostics.readInvestigationOrder(sessionFor(nurse), theirs.orderId)
    assert.equal(refused, 'refused')
  })

  test('the escalation list is doctors only, and an admin cannot reach it', async () => {
    const { admin, orderId } = await upToResult()
    const token = await tokenFor(admin)
    const escalations = await edgeGet('workspace', '?view=result_escalations', token)
    assert.equal(escalations.status, 403)
    // The admin's own view of the same backlog is the review queue.
    const queue = await edgeGet('workspace', '?view=result_review_queue', token)
    assert.equal(queue.status, 200)
    assert.equal(queue.body.queue.access, 'operational')
    assert.ok(queue.body.queue.rows.some((row) => row.orderId === orderId))
  })

  test('somebody who is both a doctor and an administrator gets both views', async () => {
    /*
     * The clinic's owner is exactly this, and the first version of the read
     * asked the doctor question first — so he saw his own outstanding results
     * and lost the chase list, which is the half an administrator opens it
     * for. Found reviewing this slice.
     */
    await resetClinic()
    const owner = await makeStaff({
      name: 'Owner', username: 'd-both', roles: ['doctor', 'admin'], pin: '6751',
      canPublishClinicalTemplates: true,
    })
    const colleague = await makeStaff({
      name: 'Colleague', username: 'd-coll', roles: ['doctor'], pin: '6752',
    })
    await as(colleague, 'create_patient', {
      name: 'Somebody Else', age: 30, sex: 'male', phone: '+919990000021',
    })
    const patientId = String(await scalar("select id from jmc.patients where name='Somebody Else'"))
    const catalogue = await approveEntry(owner, {
      kind: 'investigation', displayName: 'Serum creatinine', category: 'biochemistry',
    })
    const theirs = await order(colleague, patientId, catalogue.catalogueId)
    await fileResult(colleague, theirs.itemId)

    const queue = await diagnostics.readResultReviewQueue(sessionFor(owner))
    assert.equal(queue.access, 'clinical', 'holding the doctor role means the clinical half')
    assert.ok(
      queue.rows.some((row) => row.orderId === theirs.orderId),
      'holding the admin role means the whole chase list',
    )
  })

  test('a doctor sees their own outstanding results and not a colleague’s', async () => {
    const { doctor, other, owner, patientId, catalogue, nurse } = await clinic()
    const mine = await order(doctor, patientId, catalogue.catalogueId)
    await fileResult(nurse, mine.itemId)

    const theirs = await diagnostics.readResultReviewQueue(sessionFor(other))
    assert.equal(theirs.rows.filter((row) => row.orderId === mine.orderId).length, 0)

    // The owner-doctor gets it only once item 87 has escalated it to them.
    let ownerQueue = await diagnostics.readResultReviewQueue(sessionFor(owner))
    assert.equal(ownerQueue.rows.filter((row) => row.orderId === mine.orderId).length, 0)
    const resultId = String(await scalar(
      'select id from jmc.investigation_results where order_item_id=$1', [mine.itemId]))
    await age(resultId, '9 hours')
    ownerQueue = await diagnostics.readResultReviewQueue(sessionFor(owner))
    assert.equal(ownerQueue.rows.filter((row) => row.orderId === mine.orderId).length, 1)
  })
})

/* ═══════════════════════════ 10. racing ══ */

describe('two of everything, at once', () => {
  test('two doctors reviewing one result produce one review', async () => {
    const { doctor, other, orderId, resultId } = await upToResult()
    await as(doctor, 'delegate_result_review', {
      orderId, toDoctorId: other.id, reason: 'covering',
    })

    const outcomes = await Promise.allSettled([
      as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' }),
      as(other, 'review_result', { resultId, conclusion: 'patient_to_be_informed' }),
    ])
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 1)
    assert.ok(refused.length <= 1)
    if (refused.length === 1) {
      assert.match(String(refused[0].reason.message), /reviewed this result first|already/i)
    }
  })

  test('the database itself allows only one review per report', async () => {
    /*
     * The same shape as the index test below, and for the same reason.
     * `review_result` locks the result row and re-reads, so the test above
     * passes with this constraint dropped — the lock and the pre-check are
     * doing the work. `unique (result_id)` is what holds when they are not,
     * and it is proved here rather than assumed.
     */
    const { doctor, patientId, resultId } = await upToResult()
    const one = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    const two = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      const insert = (client) => client.unsafe(
        `insert into jmc.result_reviews
           (id, result_id, patient_id, reviewed_by, basis, conclusion)
         values ($1,$2,$3,$4,'responsible_doctor','no_action_needed')`,
        [randomUUID(), resultId, patientId, doctor.id],
      )
      const outcomes = await Promise.allSettled([insert(one), insert(two)])
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
      assert.match(
        String(outcomes.find((outcome) => outcome.status === 'rejected').reason.message),
        /result_reviews_result_id_key/,
      )
    } finally {
      await one.end({ timeout: 5 })
      await two.end({ timeout: 5 })
    }
    assert.equal(Number(await scalar('select count(*) from jmc.result_reviews')), 1)
  })

  test('two corrections of one report produce one', async () => {
    const { nurse, itemId, resultId } = await upToResult()
    const outcomes = await Promise.allSettled([
      as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'Correction A', correctsResultId: resultId, correctionReason: 'a',
      }),
      as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'Correction B', correctsResultId: resultId, correctionReason: 'b',
      }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_results')), 2)
    assert.equal(
      Number(await scalar(
        'select count(*) from jmc.investigation_results where order_item_id=$1 and superseded_at is null',
        [itemId])),
      1,
    )
  })

  test('two reports filed for one line at once produce one', async () => {
    const { nurse, doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const outcomes = await Promise.allSettled([
      as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory', reportText: 'A',
      }),
      as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory', reportText: 'B',
      }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_results')), 1)
  })

  test('the database itself allows only one current report per investigation', async () => {
    /*
     * `record_result` takes the order line `for update` and re-reads, so two
     * concurrent filings through the command are serialized by the lock and
     * the second is refused by the pre-check — which is what the test above
     * proves, and which is why it keeps passing with this index dropped.
     *
     * The index is the guarantee UNDER that courtesy: it is what holds if a
     * later code path forgets the lock. So it is proved here, against two
     * connections writing directly, rather than being assumed because a
     * well-behaved command never reaches it.
     */
    const { doctor, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)

    const one = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    const two = postgres(STAGING_DB_URL, { max: 1, prepare: false, onnotice: () => {} })
    try {
      const insert = (client) => client.unsafe(
        `insert into jmc.investigation_results
           (id, order_item_id, patient_id, recorded_by, source, report_text)
         values ($1,$2,$3,$4,'external_laboratory','filed directly')`,
        [randomUUID(), itemId, patientId, doctor.id],
      )
      const outcomes = await Promise.allSettled([insert(one), insert(two)])
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
      assert.match(
        String(outcomes.find((outcome) => outcome.status === 'rejected').reason.message),
        /investigation_results_current/,
      )
    } finally {
      await one.end({ timeout: 5 })
      await two.end({ timeout: 5 })
    }

    assert.equal(Number(await scalar(
      'select count(*) from jmc.investigation_results where order_item_id=$1 and superseded_at is null',
      [itemId])), 1)
  })

  test('two tablets sending one order reference produce one request', async () => {
    const { doctor, patientId, catalogue } = await clinic()
    const payload = { idempotencyKey: key(), patientId, items: [catalogue.catalogueId] }
    const outcomes = await Promise.allSettled([
      as(doctor, 'order_investigation', payload),
      as(doctor, 'order_investigation', payload),
    ])
    const done = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    assert.equal(done.length, 2, 'both callers get an answer')
    assert.equal(done[0].value.data.orderId, done[1].value.data.orderId)
    assert.equal(Number(await scalar('select count(*) from jmc.investigation_orders')), 1)
  })

  test('two authorizations of one result produce one notice', async () => {
    const { nurse, doctor, other, patientId, orderId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(doctor, 'delegate_result_review', { orderId, toDoctorId: other.id, reason: 'covering' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results, please.', source: 'staff_recorded',
    })

    await Promise.allSettled([
      as(doctor, 'authorize_result_notification', { resultId }),
      as(other, 'authorize_result_notification', { resultId }),
    ])
    assert.equal(Number(await scalar(
      `select count(*) from jmc.communication_schedules
        where source_type='investigation_result' and source_id=$1`, [resultId])), 1)
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 1)
  })

  test('a review racing a correction leaves exactly one current, reviewable report', async () => {
    const { nurse, doctor, itemId, resultId } = await upToResult()
    await Promise.allSettled([
      as(doctor, 'review_result', { resultId, conclusion: 'no_action_needed' }),
      as(nurse, 'record_result', {
        idempotencyKey: key(), orderItemId: itemId, source: 'external_laboratory',
        reportText: 'Corrected.', correctsResultId: resultId, correctionReason: 'Re-issued',
      }),
    ])

    const current = (await rows(
      'select id from jmc.investigation_results where order_item_id=$1 and superseded_at is null',
      [itemId]))
    assert.equal(current.length, 1)
    // Whatever order they landed in, the current report has no review it did
    // not earn.
    const reviewsOnCurrent = Number(await scalar(
      'select count(*) from jmc.result_reviews where result_id=$1', [current[0].id]))
    if (current[0].id !== resultId) assert.equal(reviewsOnCurrent, 0)
  })

  test('a consent withdrawal racing a preparing worker sends nothing either way', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results, please.', source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })

    const sent = []
    await Promise.allSettled([
      messaging.prepareDueMessages({ channel: channel(() => ACCEPTS()) }),
      as(nurse, 'withdraw_communication_consent', {
        patientId, scope: 'all_purposes', wording: 'STOP', source: 'patient_chat',
      }),
    ])
    await messaging.dispatchQueuedMessages({
      channel: channel((request) => { sent.push(request); return ACCEPTS() }),
    })
    assert.equal(sent.length, 0)
  })

  test('two workers preparing one result notice produce one message', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results, please.', source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })

    const sent = []
    await Promise.allSettled([
      messaging.runDispatchCycle({ channel: channel((r) => { sent.push(r); return ACCEPTS() }) }),
      messaging.runDispatchCycle({ channel: channel((r) => { sent.push(r); return ACCEPTS() }) }),
    ])
    assert.equal(sent.length, 1)
    assert.equal(Number(await scalar('select count(*) from jmc.message_attempts')), 1)
  })

  test('duplicate and out-of-order provider evidence settles once', async () => {
    const { nurse, doctor, patientId, resultId } = await resultReadyClinic()
    await as(doctor, 'review_result', { resultId, conclusion: 'patient_to_be_informed' })
    await as(nurse, 'record_communication_consent', {
      patientId, purpose: 'result_ready', wording: 'Results, please.', source: 'staff_recorded',
    })
    await as(doctor, 'authorize_result_notification', { resultId })
    await messaging.runDispatchCycle({ channel: channel(() => ACCEPTS()) })

    const reference = String(await scalar(
      `select o.provider_reference from jmc.message_outbox o
         join jmc.communication_schedules s on s.id=o.schedule_id where s.source_id=$1`, [resultId]))

    const at = new Date().toISOString()
    await messaging.applyProviderStatusEvent({ providerReference: reference, status: 'delivered', occurredAt: at })
    await messaging.applyProviderStatusEvent({ providerReference: reference, status: 'delivered', occurredAt: at })
    // And one that arrived late, claiming less.
    await messaging.applyProviderStatusEvent({ providerReference: reference, status: 'sent', occurredAt: at })

    assert.equal(await itemStateOf(doctor, resultId), 'notified')
    assert.equal(
      await scalar(`select o.delivery_status from jmc.message_outbox o
                      join jmc.communication_schedules s on s.id=o.schedule_id
                     where s.source_id=$1`, [resultId]),
      'delivered',
    )
  })

  test('a critical acknowledgement racing the escalation read produces one acknowledgement', async () => {
    const { owner, doctor, nurse, patientId, catalogue } = await clinic()
    const { itemId } = await order(doctor, patientId, catalogue.catalogueId)
    const resultId = await fileResult(nurse, itemId, {
      sourceFlag: 'critical', sourceFlagOrigin: 'external_report', sourceFlagReference: 'CP crit',
    })
    await age(resultId, '20 minutes')

    const [, , acknowledged] = await Promise.all([
      diagnostics.readResultEscalations(sessionFor(owner)),
      as(owner, 'acknowledge_critical_result', { resultId }),
      as(doctor, 'acknowledge_critical_result', { resultId }),
    ])
    assert.ok(acknowledged)
    const row = (await rows(
      'select critical_acknowledged_by, critical_acknowledged_at from jmc.investigation_results where id=$1',
      [resultId]))[0]
    assert.ok(row.critical_acknowledged_at)
    assert.ok([owner.id, doctor.id].includes(row.critical_acknowledged_by))
  })
})

/* ═══════════════════════════ 11. everything else still works ══ */

describe('nothing that already worked stopped working', () => {
  test('an unknown action is still an unknown action', async () => {
    const { doctor } = await clinic()
    await assert.rejects(
      () => as(doctor, 'not_a_command_anybody_wrote', {}),
      /Unknown action/,
    )
  })

  test('the appointment, consultation and messaging paths are untouched', async () => {
    const { doctor, nurse, patientId } = await clinic()

    await as(nurse, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar(
      'select id from jmc.appointments where patient_id=$1', [patientId]))
    await as(doctor, 'save_consultation', {
      patientId, appointmentId, diagnosis: 'Viral fever',
    })
    assert.equal(
      await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'done')

    // The staff composer still reads the blanket registration flag and writes
    // nothing into the outbox, exactly as Slice 3B characterized it.
    await assert.rejects(
      () => as(doctor, 'send_patient_whatsapp', { patientId, body: 'Hello' }),
      /WhatsApp consent is not recorded/,
    )
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)
  })

  test('the four existing messaging purposes still behave as they did', async () => {
    const { nurse, patientId } = await clinic()
    for (const purpose of ['appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption']) {
      await as(nurse, 'record_communication_consent', {
        patientId, purpose, wording: `Consent for ${purpose}.`, source: 'staff_recorded',
      })
      assert.equal(await messaging.effectiveConsent(patientId, purpose), 'opt_in')
    }
    assert.equal(await messaging.effectiveConsent(patientId, 'result_ready'), 'none')
  })

  test('nothing reached a network, and nothing reached Meta', async () => {
    // The loopback channel refuses at construction to address anything else,
    // which is the guard the whole file leans on. A guard nobody has watched
    // fail is a guard nobody has.
    assert.throws(
      () => messaging.loopbackChannel({ baseUrl: 'https://graph.facebook.com', respond: () => ACCEPTS() }),
      /may only address loopback/,
    )
    // And the clinic's own channel is disabled, because none of the four
    // WHATSAPP_* variables is set here or anywhere in this repository.
    assert.equal(messaging.officialWhatsAppChannel.configured(), false)
  })
})

/* ───────────────────────────────────────────────────────────── helpers ── */

/** A clinic with a result ready to be released, and an approved notice to send. */
async function resultReadyClinic() {
  const c = await upToResult()
  const drafted = await as(c.owner, 'draft_message_template', {
    purpose: 'result_ready',
    body: 'Your investigation result has been reviewed and is ready. Please contact the clinic.',
    variables: [],
  })
  await as(c.owner, 'approve_message_template', { templateId: drafted.data.templateId })
  await as(c.admin, 'record_provider_template_state', {
    templateId: drafted.data.templateId, providerState: 'approved',
    providerTemplateName: 'jmc_result_ready',
  })
  return c
}

/** The derived state of the line one result belongs to, as a doctor sees it. */
async function itemStateOf(doctor, resultId) {
  const orderId = String(await scalar(
    `select i.order_id from jmc.investigation_results r
       join jmc.investigation_order_items i on i.id = r.order_item_id
      where r.id=$1`, [resultId]))
  const view = await diagnostics.readInvestigationOrder(sessionFor(doctor), orderId)
  return view.items[0].state
}

/** Attach a PDF to a result through the real endpoint. */
async function attach(resultId, token, { idempotencyKey = randomUUID(), content = '%PDF-1.4 report' } = {}) {
  const form = new FormData()
  form.set('resultId', resultId)
  form.set('idempotencyKey', idempotencyKey)
  form.set('source', 'external_laboratory')
  form.set('sourceReference', 'CP-2211')
  form.set('file', new File([content], 'report.pdf', { type: 'application/pdf' }))
  const response = await edgeRequest('results', '', { method: 'POST', token, body: form })
  return response
}
