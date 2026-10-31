/**
 * Who may do what at the counter, asked of the commands themselves.
 *
 * Policy register item 17, as settled by the owner on 12 September 2026. Every
 * claim here is made by calling the command directly with a session of that
 * role and reading what comes back — not by inspecting a role list, and not
 * through a screen. A capability matrix that is only ever checked against
 * itself proves nothing; this file is the other end of it.
 *
 * The matrix, which `docs/OWNER_POLICY_REGISTER.md` holds in full:
 *
 *                        admin   doctor   nurse   pharmacy
 *   take_payment           ●                         ●
 *   dispense_rx                                      ●
 *   otc_sale                                         ●
 *   void / refund /        ●
 *     reverse
 *   otc_return             ●                         ●
 *   payments report        ●                         ●
 *   patient_dues report    ●                         ●
 *
 * Two of those rows are the ones worth arguing about, so they are stated
 * plainly. An ADMINISTRATOR cannot hand medicine over — not a prescription,
 * not a counter sale — because medicine leaving the shelf always requires a
 * pharmacist; what an administrator does is correct a hand-over afterwards,
 * which is why every reversal row is theirs alone. A NURSE does not touch
 * money at all; that capability was inherited from the retired application
 * rather than decided, and it is gone.
 *
 * The negative cases matter more than the positive ones here. A test that only
 * proves the allowed roles work would still pass on the day the gate is
 * deleted.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { edgeGet, snapshot } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, scalar, sessionFor, tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** One clinic, one of each role, and enough stock and history to act on. */
let clinic

before(async () => {
  await resetClinic()

  const admin = await makeStaff({ name: 'Owner', username: 'ca-admin', roles: ['admin'], pin: '4931' })
  const doctor = await makeStaff({ name: 'Doctor', username: 'ca-doc', roles: ['doctor'], pin: '5824' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'ca-nurse', roles: ['nurse'], pin: '6275' })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 'ca-pharm', roles: ['pharmacy'], pin: '7136' })

  await as(pharmacy, 'add_medicine', {
    code: 'PCM500', name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 1000,
    initialQuantity: 500, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='PCM500'`))

  await as(doctor, 'create_patient', {
    name: 'Counter Patient', age: 44, sex: 'male', phone: '+919000000601',
  })
  const patientId = String(await scalar(`select id from jmc.patients where name='Counter Patient'`))

  clinic = { admin, doctor, nurse, pharmacy, patientId, medicineId }
})

/**
 * A fresh signed prescription with one line of twenty tablets.
 *
 * One per attempt, so a refusal and a success are never arguing over the same
 * remaining quantity — a test that reused one prescription could pass because
 * the stock ran out rather than because the role was refused.
 */
async function waitingPrescription() {
  await as(clinic.doctor, 'sign_consultation', {
    patientId: clinic.patientId, complaint: 'Fever',
    diagnosis: 'Acute viral febrile illness', diagnosisStatus: 'provisional',
    prescriptionItems: [{ medicineId: clinic.medicineId, instructions: 'After food', quantity: 20 }],
  })
  const prescriptionId = String(await scalar(
    'select id from jmc.prescriptions order by signed_at desc, prescription_number desc limit 1',
  ))
  const prescriptionLineId = String(await scalar(
    'select id from jmc.prescription_lines where prescription_id = $1 order by line_number limit 1',
    [prescriptionId],
  ))
  return { prescriptionId, prescriptionLineId }
}

/** The bill left by that consultation's fee, unpaid. */
async function unpaidInvoice() {
  return String(await scalar(
    `select id from jmc.invoice_balances where due > 0
      order by invoice_number desc limit 1`,
  ))
}

const dispensed = () => scalar('select coalesce(sum(quantity), 0)::int from jmc.dispense_lines')
const sales = () => scalar('select count(*)::int from jmc.otc_sales')
const paid = (invoiceId) => scalar('select paid from jmc.invoice_balances where id = $1', [invoiceId])

const readReport = async (staff, report) =>
  edgeGet('reports', `?report=${report}&days=7`, await tokenFor(staff))

// ═══════════════════════════════════════════════════════════════════════════

describe('handing medicine over requires a pharmacist', () => {
  test('pharmacy can dispense a prescription and complete a counter sale', async () => {
    const { prescriptionId, prescriptionLineId } = await waitingPrescription()
    const before = Number(await dispensed())

    const handOver = await as(clinic.pharmacy, 'dispense_rx', {
      idempotencyKey: randomUUID(),
      prescriptionId,
      lines: [{ prescriptionLineId, quantity: 8 }],
    })
    assert.ok(handOver.data?.dispenseNumber, 'a hand-over is recorded with its own number')
    assert.equal(Number(await dispensed()) - before, 8, 'eight tablets actually moved')

    const salesBefore = Number(await sales())
    const sale = await as(clinic.pharmacy, 'otc_sale', {
      idempotencyKey: randomUUID(),
      lines: [{ medicineId: clinic.medicineId, quantity: 5 }],
      parts: [{ method: 'cash', amount: 150 }],
    })
    assert.ok(sale.data?.receiptNumber, 'a counter sale is recorded with a receipt')
    assert.equal(Number(await sales()) - salesBefore, 1)
  })

  test('an administrator cannot dispense, and nothing moves when they try', async () => {
    const { prescriptionId, prescriptionLineId } = await waitingPrescription()
    const before = Number(await dispensed())

    await assert.rejects(
      as(clinic.admin, 'dispense_rx', {
        idempotencyKey: randomUUID(),
        prescriptionId,
        lines: [{ prescriptionLineId, quantity: 8 }],
      }),
      /role cannot perform/,
      'medicine leaving the shelf always requires a pharmacist',
    )

    // The refusal is the whole point, but a refusal that still moved stock
    // would be worse than no gate at all.
    assert.equal(Number(await dispensed()), before, 'not one tablet moved')
    assert.equal(
      Number(await scalar(
        'select count(*)::int from jmc.dispenses where prescription_id = $1', [prescriptionId],
      )),
      0,
      'and no empty hand-over header was left behind',
    )
  })

  test('an administrator cannot start a counter sale either', async () => {
    const before = Number(await sales())

    await assert.rejects(
      as(clinic.admin, 'otc_sale', {
        idempotencyKey: randomUUID(),
        lines: [{ medicineId: clinic.medicineId, quantity: 5 }],
        parts: [{ method: 'cash', amount: 150 }],
      }),
      /role cannot perform/,
      'an over-the-counter sale has no prescription behind it, so the pharmacist is the only check there is',
    )
    assert.equal(Number(await sales()), before, 'no sale was recorded')
  })

  test('a doctor and a nurse cannot dispense or sell', async () => {
    const { prescriptionId, prescriptionLineId } = await waitingPrescription()

    for (const role of ['doctor', 'nurse']) {
      await assert.rejects(
        as(clinic[role], 'dispense_rx', {
          idempotencyKey: randomUUID(), prescriptionId,
          lines: [{ prescriptionLineId, quantity: 8 }],
        }),
        /role cannot perform/,
        `${role} must not dispense`,
      )
      await assert.rejects(
        as(clinic[role], 'otc_sale', {
          idempotencyKey: randomUUID(),
          lines: [{ medicineId: clinic.medicineId, quantity: 5 }],
          parts: [{ method: 'cash', amount: 150 }],
        }),
        /role cannot perform/,
        `${role} must not sell over the counter`,
      )
    }
  })
})

describe('the payment counter is admin and pharmacy', () => {
  test('both of them can take a payment', async () => {
    for (const role of ['admin', 'pharmacy']) {
      await waitingPrescription()
      const invoiceId = await unpaidInvoice()

      await as(clinic[role], 'take_payment', {
        idempotencyKey: randomUUID(),
        invoiceId,
        parts: [{ method: 'cash', amount: 300 }],
      })
      assert.equal(String(await paid(invoiceId)), '300.00', `${role} collected the fee`)
    }
  })

  test('a doctor and a nurse cannot, and the bill is left exactly as it was', async () => {
    for (const role of ['doctor', 'nurse']) {
      await waitingPrescription()
      const invoiceId = await unpaidInvoice()

      await assert.rejects(
        as(clinic[role], 'take_payment', {
          idempotencyKey: randomUUID(),
          invoiceId,
          parts: [{ method: 'cash', amount: 300 }],
        }),
        /role cannot perform/,
        `${role} must not collect payment`,
      )

      assert.equal(String(await paid(invoiceId)), '0.00', 'nothing was taken')
      assert.equal(
        Number(await scalar(
          `select count(*)::int from jmc.payment_allocations a
             join jmc.payments p on p.id = a.payment_id
            where a.invoice_id = $1`, [invoiceId],
        )),
        0,
        'and no allocation was written',
      )
    }
  })

  test('the balance simply stays pending when nobody authorised is there', async () => {
    // The owner's rule: if no authorised counter staff member is available,
    // the charge remains pending. That is a real state the system models, not
    // an error — so a clinic staffed only by a doctor and a nurse ends the day
    // with an open balance and no way for either of them to close it.
    await waitingPrescription()
    const invoiceId = await unpaidInvoice()

    for (const role of ['doctor', 'nurse']) {
      await assert.rejects(
        as(clinic[role], 'take_payment', {
          idempotencyKey: randomUUID(), invoiceId, parts: [{ method: 'cash', amount: 300 }],
        }),
        /role cannot perform/,
      )
    }

    const state = String(await scalar(
      'select payment_state from jmc.invoice_balances where id = $1', [invoiceId],
    ))
    assert.equal(state, 'unpaid', 'the charge is still owed, and still collectable tomorrow')
  })
})

describe('an administrator corrects what a pharmacist did', () => {
  test('void, refund, reverse a payment, reverse a dispense, and authorise a return', async () => {
    // Everything below is a correction to something the pharmacy did, which is
    // exactly the split: the pharmacist moves medicine and money, the
    // administrator undoes it on the record without ever erasing it.
    const { prescriptionId, prescriptionLineId } = await waitingPrescription()
    await as(clinic.pharmacy, 'dispense_rx', {
      idempotencyKey: randomUUID(), prescriptionId,
      lines: [{ prescriptionLineId, quantity: 6 }],
    })
    const invoiceId = await unpaidInvoice()
    await as(clinic.pharmacy, 'take_payment', {
      idempotencyKey: randomUUID(), invoiceId, parts: [{ method: 'cash', amount: 100 }],
    })

    // 1. Refund part of it.
    await as(clinic.admin, 'refund_payment', {
      invoiceId, reason: 'Overcharged by one strip',
      refund: [{ method: 'cash', amount: 40 }],
    })
    assert.equal(String(await paid(invoiceId)), '60.00', 'a refund reduces what has been paid')

    /*
     * 2. Reverse the payment entirely — a different statement from refunding.
     *
     * Not in that order, though. The ₹40 refund stands against this bill, so
     * reversing the ₹100 receipt would leave forty rupees of the clinic's money
     * out against a bill nobody ever paid. That is not a correction an
     * administrator makes, it is an accounting exception somebody investigates,
     * and the command refuses it rather than creating one. Policy register 51:
     * the erroneous refund goes back first, and the reversal then lands on
     * nothing.
     */
    const paymentId = String(await scalar(
      `select id from jmc.payments where kind='payment' order by received_at desc limit 1`,
    ))
    await assert.rejects(
      as(clinic.admin, 'reverse_payment', {
        paymentId, reason: 'The UPI failed after the receipt printed',
      }),
      /would be ₹40\.00 over-refunded.*Reverse the refund first/s,
    )
    assert.equal(String(await paid(invoiceId)), '60.00', 'and nothing was reversed')

    const refundId = String(await scalar(
      `select id from jmc.payments where kind='refund' order by received_at desc limit 1`,
    ))
    await as(clinic.admin, 'reverse_payment', {
      paymentId: refundId, reason: 'The refund was keyed against the wrong bill',
    })
    await as(clinic.admin, 'reverse_payment', {
      paymentId, reason: 'The UPI failed after the receipt printed',
    })
    assert.equal(
      String(await paid(invoiceId)), '0.00',
      'both receipts stay on the record as reversed, and net nothing was paid',
    )

    // 3. Reverse the hand-over, which puts the medicine back on the ledger.
    const dispenseId = String(await scalar(
      'select id from jmc.dispenses order by dispensed_at desc, dispense_number desc limit 1',
    ))
    const onHandBefore = Number(await scalar(
      'select coalesce(sum(quantity_delta), 0)::int from jmc.stock_movements',
    ))
    await as(clinic.admin, 'reverse_dispense', {
      dispenseId, reason: 'Handed to the wrong patient',
    })
    assert.equal(
      Number(await scalar('select coalesce(sum(quantity_delta), 0)::int from jmc.stock_movements')),
      onHandBefore + 6,
      'the six tablets are back, as a compensating movement rather than a deletion',
    )

    /*
     * 4. Void the bill — this one, which is the point of doing it here.
     *
     * Voiding is allowed at exactly zero and nowhere else. Above zero the
     * money would be lost track of, so it says to refund it first. Below zero
     * more has gone out than came in, which is not a bill that can be tidied
     * away at all: voiding it would close the only record of where the money
     * went, so it says Over-refunded — financial correction required and sends
     * it to the review queue. After the refund and both reversals this bill
     * stands at exactly nothing, which is the one case that may be closed.
     */
    await as(clinic.admin, 'void_invoice', {
      invoiceId, reason: 'Raised against the wrong visit',
    })
    assert.equal(
      String(await scalar('select status from jmc.invoices where id = $1', [invoiceId])),
      'void',
    )
    assert.match(
      String(await scalar(
        'select invoice_number from jmc.invoice_balances where id = $1', [invoiceId],
      )),
      /^INV-\d{6}$/,
      'and it keeps its number',
    )

    // 5. And take part in an authorised counter return.
    const sale = await as(clinic.pharmacy, 'otc_sale', {
      idempotencyKey: randomUUID(),
      lines: [{ medicineId: clinic.medicineId, quantity: 4 }],
      parts: [{ method: 'cash', amount: 120 }],
    })
    const otcLineId = String(await scalar(
      `select l.id from jmc.otc_lines l
         join jmc.otc_sales s on s.id = l.otc_sale_id
        where s.id = $1 limit 1`, [sale.data.saleId],
    ))
    await as(clinic.admin, 'otc_return', {
      otcLineId, quantity: 2, reason: 'Unopened strip brought back the same day',
      refund: [{ method: 'cash', amount: 60 }],
    })
    assert.equal(Number(await scalar('select count(*)::int from jmc.otc_returns')), 1)
  })

  test('a nurse and a doctor cannot correct anything either', async () => {
    const invoiceId = await unpaidInvoice()
    for (const role of ['doctor', 'nurse']) {
      await assert.rejects(
        as(clinic[role], 'void_invoice', { invoiceId, reason: 'No' }),
        /role cannot perform/,
      )
    }
  })
})

describe('reading the money is gated the same way as touching it', () => {
  test('a nurse cannot read the payment or patient-dues reports', async () => {
    for (const report of ['payments', 'patient_dues']) {
      const refused = await readReport(clinic.nurse, report)
      assert.equal(refused.status, 403, `${report} must be refused to a nurse`)
      assert.match(refused.body.message, /cannot read that report/)
    }
  })

  test('a doctor cannot either, and admin and pharmacy can', async () => {
    for (const report of ['payments', 'patient_dues']) {
      assert.equal((await readReport(clinic.doctor, report)).status, 403)
      assert.equal((await readReport(clinic.admin, report)).status, 200)
      assert.equal((await readReport(clinic.pharmacy, report)).status, 200)
    }
  })

  test('a nurse cannot record an unknown barcode, which was never nursing work', async () => {
    await assert.rejects(
      as(clinic.nurse, 'record_unknown_barcode', { code: '8901234567890', symbology: 'ean13' }),
      /role cannot perform/,
    )
    // The desks that actually hold a scanner still can.
    await as(clinic.pharmacy, 'record_unknown_barcode', { code: '8901234567890', symbology: 'ean13' })
    assert.equal(Number(await scalar('select count(*)::int from jmc.unmapped_barcodes')), 1)
  })
})

describe('the snapshot sends each desk only what it may act on', () => {
  test('a nurse is sent no invoices, no balances, no counter sales and no till', async () => {
    const nurse = await snapshot.readSnapshot(sessionFor(clinic.nurse))

    assert.deepEqual(nurse.invoices, [], 'a nurse has no bills to settle')
    assert.deepEqual(nurse.patientBalances, [], 'nor anybody’s running balance')
    assert.deepEqual(nurse.otcSales, [], 'nor the counter’s sales')
    assert.equal(nurse.till, null, 'nor the till')
    assert.deepEqual(nurse.tillHistory, [], 'nor its history')
  })

  test('a doctor is sent none of it either', async () => {
    const doctor = await snapshot.readSnapshot(sessionFor(clinic.doctor))
    assert.deepEqual(doctor.invoices, [])
    assert.deepEqual(doctor.patientBalances, [])
    assert.equal(doctor.till, null)
  })

  test('admin and pharmacy are sent all of it, because both work the counter', async () => {
    for (const role of ['admin', 'pharmacy']) {
      const seen = await snapshot.readSnapshot(sessionFor(clinic[role]))
      assert.ok(seen.invoices.length > 0, `${role} needs the bills`)
      assert.ok(seen.otcSales.length > 0, `${role} needs the counter's sales`)
    }
  })
})
