/**
 * What the system does with a prescription written before it existed.
 *
 * `npm run staging:rehearse` proves the Slice 2.1 migration produces the right
 * rows. This file proves the application then behaves correctly around them:
 * that an unreadable line reaches the tablet saying so, that the pharmacy
 * cannot hand anything over against it, that only a doctor can resolve it, and
 * that resolving does not touch the signed record.
 *
 * The four legacy shapes are not built by hand here. The real migration file is
 * executed over them, because a test that asserts against rows the test itself
 * inserted is a test of the fixture. Re-running it is safe by construction —
 * every statement in it is guarded or idempotent, which the rehearsal also
 * checks — so it processes exactly the legacy rows this file adds.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260911190000_slice2_1_unresolved_prescription_history.sql',
)

/** The migration under test, run exactly as `apply-migrations.mjs` runs it. */
const applySlice21 = () => rows(readFileSync(MIGRATION, 'utf8'))

/**
 * A clinic holding one legacy prescription per awkward shape.
 *
 *   a. an item whose medicine row is gone
 *   b. an item with no `quantity` key at all
 *   c. an item with `quantity: 0`
 *   d. an ordinary item, which must be untouched by any of this
 */
async function clinicWithHistory() {
  await resetClinic()
  const doctor = await makeStaff({
    name: 'History Doctor', username: 'history-doctor', roles: ['doctor', 'admin'],
  })
  const pharmacy = await makeStaff({
    name: 'History Pharmacist', username: 'history-pharmacy', roles: ['pharmacy'],
  })

  await as(doctor, 'add_medicine', {
    code: 'HIST-PCM', name: 'Calpol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', saleClass: 'prescription',
    schedule: 'H', reorderLevel: 10, targetStock: 500, initialQuantity: 500,
    batchNumber: 'HIST-1', expiry: await clinicDate(400), mrp: 40,
    purchasePrice: 20, sellingPrice: 35,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='HIST-PCM'`))

  await as(doctor, 'create_patient', {
    name: 'History Patient', age: 51, sex: 'male', phone: '+999700000801',
  })
  const patientId = String(await scalar(`select id from jmc.patients where name='History Patient'`))

  // Straight into the tables: no command can create a prescription in the
  // legacy shape, which is the whole reason the migration has to cope with it.
  await rows(
    `insert into jmc.encounters (id,patient_id,doctor_id,diagnosis,advice,notes,created_at)
     values ('hist-e1',$1,$2,'Old fever','','','2024-02-01T10:00:00Z'),
            ('hist-e2',$1,$2,'Old cough','','','2024-02-02T10:00:00Z'),
            ('hist-e3',$1,$2,'Old pain','','','2024-02-03T10:00:00Z'),
            ('hist-e4',$1,$2,'Old review','','','2024-02-04T10:00:00Z')`,
    [patientId, doctor.id],
  )

  const item = (medicine, extra) => JSON.stringify([{
    medicineId: medicine, medicineName: 'Sirup Withdrawn 100 ml',
    dosage: '1-0-1', instructions: 'After food', ...extra,
  }])

  // `valid_until` is set explicitly and in the future.
  //
  // Slice 4 gives every prescription a remainder-validity date, defaulting to
  // seven days from signing — so left alone these 2024 rows would be refused
  // at the counter for being out of date, which is correct and is not what
  // this file is about. The validity rule has its own tests in the Slice 4
  // gate; here the question is what happens to a line nobody can read.
  await rows(
    `insert into jmc.prescriptions
       (id,patient_id,encounter_id,doctor_id,items_json,signed_at,prescription_number,valid_until)
     values ('hist-gone',$1,'hist-e1',$2,$3,'2024-02-01T10:05:00Z','RX-900001', current_date + 30),
            ('hist-noqty',$1,'hist-e2',$2,$4,'2024-02-02T10:05:00Z','RX-900002', current_date + 30),
            ('hist-zeroqty',$1,'hist-e3',$2,$5,'2024-02-03T10:05:00Z','RX-900003', current_date + 30),
            ('hist-normal',$1,'hist-e4',$2,$6,'2024-02-04T10:05:00Z','RX-900004', current_date + 30)`,
    [
      patientId, doctor.id,
      item('medicine-deleted-long-ago', { quantity: 6 }),
      item(medicineId, {}),
      item(medicineId, { quantity: 0 }),
      item(medicineId, { quantity: 8 }),
    ],
  )

  await applySlice21()
  return { doctor, pharmacy, patientId, medicineId }
}

const lineOf = async (prescriptionId) =>
  (await rows(
    `select * from jmc.prescription_lines_effective where prescription_id=$1 order by line_number`,
    [prescriptionId],
  ))[0]

describe('a legacy item whose medicine record is gone', () => {
  test('it still becomes a line, keeps what the prescription said, and names no medicine', async () => {
    await clinicWithHistory()
    const line = await lineOf('hist-gone')

    assert.ok(line, 'the item must not be dropped: a signed prescription cannot lose a line')
    assert.equal(line.medicine_state, 'unresolved_legacy')
    assert.equal(line.medicine_id, null)
    assert.equal(line.effective_medicine_id, null)

    // Everything the clinic actually recorded survives.
    assert.equal(line.medicine_name_snapshot, 'Sirup Withdrawn 100 ml')
    assert.equal(line.dosage_text, '1-0-1')
    assert.equal(line.instructions, 'After food')
    assert.equal(Number(line.prescribed_quantity), 6)
    assert.equal(line.quantity_state, 'recorded')

    assert.equal(line.needs_review, true)
    assert.equal(line.dispensable, false)

    // Nothing was reconnected to a medicine that happens to be in the
    // formulary. The unresolved state and a medicine id cannot coexist.
    await assert.rejects(
      rows(`update jmc.prescription_lines set medicine_id=(select id from jmc.medicines limit 1)
            where prescription_id='hist-gone'`),
      /cannot be changed/,
    )
  })
})

describe('a legacy item with no usable quantity', () => {
  test('a missing quantity is Unknown, never 1', async () => {
    await clinicWithHistory()
    const line = await lineOf('hist-noqty')

    assert.equal(line.quantity_state, 'unknown_legacy')
    assert.equal(line.prescribed_quantity, null)
    assert.equal(line.effective_quantity, null)
    // The medicine is fine; only the quantity is unknown.
    assert.equal(line.medicine_state, 'resolved')
    assert.equal(line.needs_review, true)
    assert.equal(line.dispensable, false)
  })

  test('a zero quantity is Unknown too, and is not treated as "none"', async () => {
    await clinicWithHistory()
    const line = await lineOf('hist-zeroqty')

    assert.equal(line.quantity_state, 'unknown_legacy')
    assert.equal(line.prescribed_quantity, null)
    assert.equal(line.needs_review, true)
    assert.equal(line.dispensable, false)
  })

  test('an ordinary legacy line is left completely alone', async () => {
    await clinicWithHistory()
    const line = await lineOf('hist-normal')

    assert.equal(line.medicine_state, 'resolved')
    assert.equal(line.quantity_state, 'recorded')
    assert.equal(Number(line.prescribed_quantity), 8)
    assert.equal(Number(line.effective_quantity), 8)
    assert.equal(line.needs_review, false)
    assert.equal(line.dispensable, true)
  })

  test('and a newly signed prescription still cannot be written without a real quantity', async () => {
    const { doctor, patientId, medicineId } = await clinicWithHistory()
    const payload = {
      patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
      diagnosisStatus: 'provisional', feeWaived: true, feeReason: 'Not what this test is about',
      prescriptionItems: [{ medicineId, instructions: 'After food', quantity: 0 }],
    }
    await assert.rejects(as(doctor, 'sign_consultation', payload), /quantity/i)

    // The relaxation is for history only: the column still refuses a zero or
    // negative quantity paired with a `recorded` state.
    await assert.rejects(
      rows(`insert into jmc.prescription_lines
        (id,prescription_id,line_number,medicine_id,medicine_name_snapshot,
         prescribed_quantity,quantity_unit,quantity_state,medicine_state)
        values ('bad','hist-normal',9,$1,'X',0,'tablet','recorded','resolved')`, [medicineId]),
      /prescribed_quantity_check|violates check constraint/,
    )
    await assert.rejects(
      rows(`insert into jmc.prescription_lines
        (id,prescription_id,line_number,medicine_id,medicine_name_snapshot,
         prescribed_quantity,quantity_unit,quantity_state,medicine_state)
        values ('bad2','hist-normal',10,$1,'X',null,'tablet','recorded','resolved')`, [medicineId]),
      /quantity_state_agrees/,
    )
  })
})

describe('an unresolved line cannot be handed over', () => {
  test('pharmacy is refused, and told which line and what is missing', async () => {
    const { pharmacy } = await clinicWithHistory()

    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-gone' }),
      /does not record which medicine it was/,
    )
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-noqty' }),
      /does not record what quantity it authorized/,
    )
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-zeroqty' }),
      /does not record what quantity it authorized/,
    )

    // Refused means nothing moved: no stock, no dispense marker.
    assert.equal(
      await scalar(`select count(*)::int from jmc.stock_movements where quantity_delta < 0`),
      0,
    )
    assert.equal(
      await scalar(`select count(*)::int from jmc.prescriptions where dispensed_at is not null`),
      0,
    )

    // The ordinary legacy prescription is unaffected by any of this.
    await as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-normal' })
    assert.equal(
      await scalar(`select sum(-quantity_delta)::int from jmc.stock_movements where quantity_delta < 0`),
      8,
    )
  })

  test('only a doctor may resolve it, and the signed record is untouched', async () => {
    const { doctor, pharmacy, medicineId } = await clinicWithHistory()
    const line = await lineOf('hist-gone')
    const before = String(await scalar(`select items_json from jmc.prescriptions where id='hist-gone'`))

    await assert.rejects(
      as(pharmacy, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId, reason: 'I think it was Calpol',
      }),
      /role cannot perform/,
    )
    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId, reason: '',
      }),
      /reason is required/,
    )
    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId: 'not-a-medicine', reason: 'Guess',
      }),
      /not in the active formulary/,
    )

    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, medicineId,
      reason: 'Pharmacy records show this was Calpol 500 mg',
    })

    const resolved = await lineOf('hist-gone')
    assert.equal(resolved.effective_medicine_id, medicineId)
    assert.equal(resolved.dispensable, true)
    assert.equal(resolved.needs_review, false)

    // The line itself never changed, and neither did the signed prescription.
    assert.equal(resolved.medicine_id, null)
    assert.equal(resolved.medicine_state, 'unresolved_legacy')
    assert.equal(await scalar(`select items_json from jmc.prescriptions where id='hist-gone'`), before)

    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events where action='prescription_line.resolved'`),
      1,
    )
    // Append-only, like every other clinical record here.
    await assert.rejects(
      rows(`delete from jmc.prescription_line_resolutions`),
      /cannot be changed/,
    )

    // And now it dispenses, using what the doctor determined.
    await as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-gone' })
    assert.equal(
      await scalar(`select sum(-quantity_delta)::int from jmc.stock_movements
        where quantity_delta < 0 and reference_id='hist-gone'`),
      6,
    )
  })

  test('an unknown quantity is resolved to a number, and a cancelled line supplies nothing', async () => {
    const { doctor, pharmacy } = await clinicWithHistory()

    const noqty = await lineOf('hist-noqty')
    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: noqty.id, quantity: 12,
      reason: 'Paper counterfoil records twelve tablets',
    })
    assert.equal(Number((await lineOf('hist-noqty')).effective_quantity), 12)
    await as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-noqty' })
    assert.equal(
      await scalar(`select sum(-quantity_delta)::int from jmc.stock_movements
        where quantity_delta < 0 and reference_id='hist-noqty'`),
      12,
    )

    // A DOCTOR cancelling: the quantity cannot be determined from any record,
    // so the order is withdrawn. This is not the patient declining to collect
    // it — OWNER_POLICY_REGISTER.md 20 keeps those apart, Patient Declined is a
    // dispensing outcome recorded at the counter, and this command cannot
    // record it.
    const zero = await lineOf('hist-zeroqty')
    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: zero.id, action: 'cancel',
      reason: 'No counterfoil or pharmacy record gives the quantity; withdrawing the order',
    })
    const cancelled = await lineOf('hist-zeroqty')
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.dispensable, false)
    assert.equal(cancelled.needs_review, false)

    // A prescription whose only line is cancelled has nothing to hand over,
    // and Slice 4 says so rather than completing silently. The older behaviour
    // — marking it dispensed and moving nothing — looked identical at the
    // counter to a prescription that had actually been supplied.
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-zeroqty' }),
      /nothing left to hand over/,
    )
    assert.equal(
      await scalar(`select count(*)::int from jmc.stock_movements where reference_id='hist-zeroqty'`),
      0,
    )
    assert.equal(await scalar(`select dispensed_at from jmc.prescriptions where id='hist-zeroqty'`), null)
  })
})

describe('the tablets are told', () => {
  test('the unresolved state reaches the doctor and the counter, not just the database', async () => {
    const { doctor, pharmacy, patientId } = await clinicWithHistory()

    const record = await snapshot.readPatientRecord(patientId, doctor.id)
    const gone = record.prescriptions.find((rx) => rx.prescriptionNumber === 'RX-900001')
    assert.equal(gone.items[0].medicineName, 'Sirup Withdrawn 100 ml')
    assert.equal(gone.items[0].medicineState, 'unresolved_legacy')
    assert.equal(gone.items[0].needsReview, true)
    assert.equal(gone.items[0].medicineId, null)

    const noqty = record.prescriptions.find((rx) => rx.prescriptionNumber === 'RX-900002')
    assert.equal(noqty.items[0].quantityState, 'unknown_legacy')
    assert.equal(noqty.items[0].quantity, null)
    assert.equal(noqty.items[0].needsReview, true)

    const normal = record.prescriptions.find((rx) => rx.prescriptionNumber === 'RX-900004')
    assert.equal(normal.items[0].quantity, 8)
    assert.equal(normal.items[0].needsReview, false)

    // The counter sees the same thing, so a pharmacist finds out before
    // reaching for the shelf rather than when the command is refused.
    const counter = await snapshot.readSnapshot(sessionFor(pharmacy))
    const queued = counter.prescriptions.find((rx) => rx.prescriptionNumber === 'RX-900001')
    assert.equal(queued.items[0].needsReview, true)
  })
})

/**
 * What a resolution may touch.
 *
 * Slice 2.1 checked the doctor's role and the payload shape and then ignored
 * the line's own state, so the command would happily write a resolution
 * against an ordinary line signed through this application minutes earlier.
 * Because `prescription_lines_effective` coalesces the newest resolution over
 * the line, and Slice 4 hands over against that view, the counter would supply
 * the amendment while the signed row and `items_json` still said something
 * else — with nothing in the record looking edited, because nothing was.
 *
 * Every refusal below is asserted twice: once through the command, which is
 * where a doctor meets it, and once through a direct INSERT, which is what a
 * psql session or a repair script would do. The second is the enforcement.
 */
describe('a resolution answers only what the line failed to record', () => {
  /** The resolution a doctor would have to type by hand to get past commands.ts. */
  const insertResolution = (lineId, staffId, { medicineId = null, quantity = null, action = 'amend' } = {}) =>
    rows(
      `insert into jmc.prescription_line_resolutions
         (id,prescription_line_id,action,medicine_id,prescribed_quantity,reason,resolved_by)
       values ($1,$2,$3,$4,$5,'Direct write',$6)`,
      [randomUUID(), lineId, action, medicineId, quantity, staffId],
    )

  test('an ordinary signed line cannot be amended, cancelled, or resolved at all', async () => {
    const { doctor, medicineId, patientId } = await clinicWithHistory()

    // Not the legacy-but-readable line, and not a line this test wrote: one
    // signed through the application just now, which is what the clinic will
    // have thousands of.
    await as(doctor, 'sign_consultation', {
      patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
      diagnosisStatus: 'provisional', feeWaived: true, feeReason: 'Not what this test is about',
      prescriptionItems: [{ medicineId, instructions: 'After food', quantity: 10 }],
    })
    const signed = String(await scalar(
      `select l.id from jmc.prescription_lines l
         join jmc.prescriptions p on p.id = l.prescription_id
        where p.id not like 'hist-%' order by p.signed_at desc limit 1`,
    ))

    for (const line of [signed, (await lineOf('hist-normal')).id]) {
      await assert.rejects(
        as(doctor, 'resolve_prescription_line', {
          prescriptionLineId: line, medicineId, reason: 'Changed my mind about the brand',
        }),
        /records both its medicine and its quantity/,
      )
      await assert.rejects(
        as(doctor, 'resolve_prescription_line', {
          prescriptionLineId: line, quantity: 60, reason: 'Meant sixty',
        }),
        /records both its medicine and its quantity/,
      )
      await assert.rejects(
        as(doctor, 'resolve_prescription_line', {
          prescriptionLineId: line, action: 'cancel', reason: 'Withdrawing it',
        }),
        /records both its medicine and its quantity/,
      )

      // And the same three straight at the table.
      await assert.rejects(insertResolution(line, doctor.id, { medicineId }), /records both/)
      await assert.rejects(insertResolution(line, doctor.id, { quantity: 60 }), /records both/)
      await assert.rejects(insertResolution(line, doctor.id, { action: 'cancel' }), /records both/)
    }

    assert.equal(await scalar(`select count(*)::int from jmc.prescription_line_resolutions`), 0)
  })

  test('a line that only lost its quantity cannot have its medicine replaced', async () => {
    const { doctor, medicineId } = await clinicWithHistory()
    const line = await lineOf('hist-noqty')
    assert.equal(line.medicine_state, 'resolved')

    // A second medicine, so the attempt is a real swap rather than a no-op.
    await as(doctor, 'add_medicine', {
      code: 'HIST-TRAM', name: 'Tramadol', genericName: 'Tramadol', strength: '50 mg',
      dosageForm: 'capsule', route: 'Oral', unit: 'capsule', saleClass: 'prescription',
      schedule: 'H', reorderLevel: 5, targetStock: 100, initialQuantity: 100,
      batchNumber: 'HIST-T1', expiry: await clinicDate(400), mrp: 90,
      purchasePrice: 50, sellingPrice: 80,
    })
    const other = String(await scalar(`select id from jmc.medicines where code='HIST-TRAM'`))

    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId: other, quantity: 12,
        reason: 'It was really Tramadol',
      }),
      /already records which medicine was prescribed/,
    )
    await assert.rejects(insertResolution(line.id, doctor.id, { medicineId: other }), /already records which medicine/)
    await assert.rejects(
      insertResolution(line.id, doctor.id, { medicineId: other, quantity: 12 }),
      /already records which medicine/,
    )

    // The quantity alone is still resolvable, and the medicine is untouched.
    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, quantity: 12, reason: 'Counterfoil records twelve',
    })
    const resolved = await lineOf('hist-noqty')
    assert.equal(resolved.effective_medicine_id, medicineId)
    assert.equal(Number(resolved.effective_quantity), 12)
  })

  test('a line that only lost its medicine cannot have its quantity rewritten', async () => {
    const { doctor, medicineId } = await clinicWithHistory()
    const line = await lineOf('hist-gone')
    assert.equal(line.quantity_state, 'recorded')
    assert.equal(Number(line.prescribed_quantity), 6)

    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId, quantity: 30,
        reason: 'Calpol, and thirty of them',
      }),
      /already records the quantity prescribed/,
    )
    await assert.rejects(insertResolution(line.id, doctor.id, { quantity: 30 }), /already records the quantity/)
    await assert.rejects(
      insertResolution(line.id, doctor.id, { medicineId, quantity: 30 }),
      /already records the quantity/,
    )

    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, medicineId, reason: 'Pharmacy records show Calpol',
    })
    const resolved = await lineOf('hist-gone')
    assert.equal(resolved.effective_medicine_id, medicineId)
    assert.equal(Number(resolved.effective_quantity), 6, 'the signed quantity stands')
  })

  test('nothing may be recorded after a cancellation', async () => {
    const { doctor, medicineId } = await clinicWithHistory()
    const line = await lineOf('hist-gone')

    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, action: 'cancel',
      reason: 'The medicine cannot be identified from any record; withdrawing the order',
    })

    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, medicineId, reason: 'Found it after all',
      }),
      /cancelled by a doctor on \d{4}-\d{2}-\d{2}/,
    )
    await assert.rejects(
      as(doctor, 'resolve_prescription_line', {
        prescriptionLineId: line.id, action: 'cancel', reason: 'Cancelling again',
      }),
      /Cancellation is final/,
    )
    await assert.rejects(insertResolution(line.id, doctor.id, { medicineId }), /Cancellation is final/)
    await assert.rejects(insertResolution(line.id, doctor.id, { action: 'cancel' }), /Cancellation is final/)

    assert.equal(await scalar(`select count(*)::int from jmc.prescription_line_resolutions`), 1)
    const cancelled = await lineOf('hist-gone')
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.dispensable, false)
  })

  test('a doctor may still correct a determination they made about an unknown part', async () => {
    const { doctor, pharmacy } = await clinicWithHistory()
    const line = await lineOf('hist-noqty')

    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, quantity: 12, reason: 'Read the counterfoil as twelve',
    })
    await as(doctor, 'resolve_prescription_line', {
      prescriptionLineId: line.id, quantity: 15, reason: 'Counterfoil re-read: fifteen, not twelve',
    })

    // The later determination governs, and the earlier one is still on record.
    assert.equal(Number((await lineOf('hist-noqty')).effective_quantity), 15)
    assert.equal(
      await scalar(
        `select count(*)::int from jmc.prescription_line_resolutions where prescription_line_id=$1`,
        [line.id],
      ),
      2,
    )

    await as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-noqty' })
    assert.equal(
      await scalar(`select sum(-quantity_delta)::int from jmc.stock_movements
        where quantity_delta < 0 and reference_id='hist-noqty'`),
      15,
    )
  })

  test('and an unresolved line is still refused at the counter while the scope is enforced', async () => {
    const { pharmacy } = await clinicWithHistory()

    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-gone' }),
      /does not record which medicine it was/,
    )
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId: 'hist-noqty' }),
      /does not record what quantity it authorized/,
    )
    assert.equal(
      await scalar(`select count(*)::int from jmc.stock_movements where quantity_delta < 0`),
      0,
    )
  })
})
