/**
 * A bill whose arithmetic landed somewhere nobody intended.
 *
 * Slice 4 derived unpaid / part paid / paid from the payment events, which is
 * right, and had no word for anything else. Two states now have one.
 *
 * `over_refunded` is a bill BELOW zero. Take ₹100, refund ₹40, then reverse the
 * ₹100 because the card never settled: the refund stands, the payment does not,
 * and the clinic is ₹40 down on a bill nobody ever paid. Or it is simply
 * already true in the history being carried across and nobody knows why. Either
 * way it is not `unpaid` — `unpaid` is a bill printed five minutes ago and not
 * yet taken to the counter, and putting this in the same queue is how it gets
 * ignored for a year.
 *
 * `void_with_balance` is a CANCELLED bill that is not at zero, in either
 * direction: money still held against a bill nobody is charging for, or money
 * refunded past one. It is tested ahead of `over_refunded`, because of the two
 * facts true about a voided bill at minus forty, the one that tells somebody
 * what to do is that it was cancelled with money still against it.
 *
 * Each has a queue of its own — the same queue — and, the part this file spends
 * most of its length on, a set of refusals that leave the ledger exactly as
 * they found it. Two of those refusals are new. A voided bill is closed in both
 * directions: no receipt against one may be reversed and nothing may be
 * refunded from one, because either would move a cancelled bill off zero.
 * Against that, reversing a REFUND is now always allowed, whatever the bill is
 * at afterwards — it only ever moves towards zero, and it is the only way out
 * of an over-refund built from more than one refund.
 *
 * Everything is built through the real commands, with the exceptions commented
 * where they happen: the states that arrive from history cannot be created by
 * the commands any more, because the commands that used to create them now
 * refuse. A state the code refuses to produce still has to be readable, and
 * that is precisely what the migrations exist for.
 *
 * See docs/OWNER_POLICY_REGISTER.md items 49–52 and 58–61, and the migrations
 * supabase/migrations/20260915000000_financial_edge_states.sql and
 * supabase/migrations/20260916000000_void_balance_and_review_queue.sql.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { edgeGet, snapshot } from '../support/backend.mjs'
import {
  as, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor, tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  return {
    admin: await makeStaff({ name: 'Owner', username: 'fe-admin', roles: ['admin'], pin: '4829' }),
    doctor: await makeStaff({ name: 'Doctor', username: 'fe-doc', roles: ['doctor'], pin: '5731' }),
    nurse: await makeStaff({ name: 'Nurse', username: 'fe-nurse', roles: ['nurse'], pin: '6275' }),
    pharmacy: await makeStaff({ name: 'Pharmacist', username: 'fe-pharm', roles: ['pharmacy'], pin: '7048' }),
  }
}

async function patient(staff, name = 'Edge Case', phone = '+919000000801') {
  await as(staff, 'create_patient', { name, age: 44, sex: 'female', phone })
  return String(await scalar('select id from jmc.patients where name=$1', [name]))
}

/**
 * A patient with one ordinary ₹300 consultation-fee bill against them.
 *
 * The fee alone, deliberately: nothing here is about medicine, and a bill with
 * one line makes every figure below arithmetic anybody can check in their head.
 */
async function feeBill(clinicStaff, name = 'Edge Case', phone = '+919000000801') {
  const patientId = await patient(clinicStaff.doctor, name, phone)
  await as(clinicStaff.doctor, 'sign_consultation', {
    patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
    diagnosisStatus: 'provisional',
  })
  const invoiceId = String(await scalar(
    'select id from jmc.invoices where patient_id=$1 order by created_at desc limit 1', [patientId],
  ))
  return { patientId, invoiceId }
}

const balance = async (invoiceId) =>
  (await rows('select * from jmc.invoice_balances where id=$1', [invoiceId]))[0]

const reviewRow = async (invoiceId) =>
  (await rows('select * from jmc.financial_review_queue where invoice_id=$1', [invoiceId]))[0]

const patientRow = async (patientId) =>
  (await rows('select * from jmc.patient_balances where patient_id=$1', [patientId]))[0]

const paymentIdOf = async (receiptNumber) =>
  String(await scalar('select id from jmc.payments where receipt_number=$1', [receiptNumber]))

/**
 * Every row of the ledger that any of these commands could possibly touch.
 *
 * Read before a refused action and again after it, and compared in full. Spot
 * checks are not enough here: the claim being made is that a refusal writes
 * NOTHING, and a test that looks at `paid` alone would pass on the day a
 * refusal starts leaving an orphaned payment row, a half-written allocation or
 * an audit entry describing something that did not happen.
 *
 * `clinic_revision` is in the list for the same reason. It is bumped inside the
 * transaction, so a rollback takes it back with everything else — and if it
 * ever stopped being, every tablet in the clinic would re-fetch the whole
 * snapshot because of an action that was refused.
 */
async function ledger(patientId) {
  const plain = async (text, params = []) => (await rows(text, params)).map((row) => ({ ...row }))
  return {
    payments: await plain('select * from jmc.payments order by receipt_number'),
    payment_allocations: await plain(
      `select a.* from jmc.payment_allocations a
         join jmc.payments y on y.id = a.payment_id
        order by y.receipt_number, a.invoice_id`,
    ),
    invoices: await plain('select * from jmc.invoices order by invoice_number'),
    invoice_lines: await plain('select * from jmc.invoice_lines order by invoice_id, line_number'),
    invoice_balances: await plain('select * from jmc.invoice_balances order by invoice_number'),
    patient_balances: await plain(
      'select * from jmc.patient_balances where patient_id=$1', [patientId],
    ),
    financial_review_queue: await plain(
      'select * from jmc.financial_review_queue order by invoice_number',
    ),
    audit_events: await plain('select * from jmc.audit_events order by created_at, id'),
    clinic_revision: await plain('select * from jmc.clinic_revision'),
  }
}

/**
 * The ledger, before and after, table by table.
 *
 * Named per table so that a failure says WHICH one moved rather than printing
 * nine of them side by side. The structural comparison runs first because its
 * diff is readable; the serialised one behind it is the literal claim — the
 * same bytes, not merely an equivalent shape.
 */
function assertUnchanged(before, afterwards, refusal) {
  assert.deepEqual(
    Object.keys(afterwards), Object.keys(before),
    `${refusal}: the ledger snapshot itself changed shape, so nothing below was compared.`,
  )
  for (const table of Object.keys(before)) {
    const complaint =
      `${refusal}: jmc.${table} drifted. A refused action must write nothing at all.`
    assert.deepEqual(afterwards[table], before[table], complaint)
    assert.equal(JSON.stringify(afterwards[table]), JSON.stringify(before[table]), complaint)
  }
}

/** Run one action that must be refused, and prove the ledger did not move. */
async function refusedWithoutTrace(patientId, refusal, act, expected) {
  const before = await ledger(patientId)
  await assert.rejects(act(), expected, `${refusal}: this must be refused`)
  assertUnchanged(before, await ledger(patientId), refusal)
}

/**
 * A bill that is already over-refunded, the way one arrives from history.
 *
 * The two money events are real and both go through the real commands: ₹100
 * taken at the counter, ₹40 refunded by the admin. The third step — reversing
 * the ₹100, which is what leaves the bill forty rupees below zero — is now
 * refused by `reverse_payment`, and that refusal is the whole point of this
 * change. So it is written here directly, setting exactly the four columns the
 * command sets and nothing else.
 *
 * This is the one place in this file that does not go through a command, and
 * it is deliberate: the state cannot be created going forward, it is
 * nevertheless in the history the clinic is carrying across, and a state that
 * can only be read is still a state that has to be read correctly.
 */
async function carriedOverOverRefund(clinicStaff, name = 'Edge Case', phone = '+919000000801') {
  const { patientId, invoiceId } = await feeBill(clinicStaff, name, phone)

  await as(clinicStaff.pharmacy, 'take_payment', {
    invoiceId, parts: [{ method: 'cash', amount: 100 }],
  })
  const paymentReceipt = String(await scalar(
    `select receipt_number from jmc.payments where kind='payment' order by received_at desc limit 1`,
  ))
  await as(clinicStaff.admin, 'refund_payment', {
    invoiceId, reason: 'Refunded at the counter against the wrong bill',
    refund: [{ method: 'cash', amount: 40 }],
  })
  const refundReceipt = String(await scalar(
    `select receipt_number from jmc.payments where kind='refund' order by received_at desc limit 1`,
  ))

  await rows(
    `update jmc.payments
        set status='reversed', reversed_by=$1, reversed_at=now(),
            reversal_reason='Carried over: the card never settled'
      where receipt_number=$2`,
    [clinicStaff.admin.id, paymentReceipt],
  )

  return {
    patientId, invoiceId, paymentReceipt, refundReceipt,
    paymentId: await paymentIdOf(paymentReceipt),
    refundId: await paymentIdOf(refundReceipt),
  }
}

/**
 * A bill carried across at minus EIGHTY, with two forty-rupee refunds on it.
 *
 * The shape that proved the old rule had no exit. Both refunds are real and
 * both go through `refund_payment` — ₹100 in, ₹40 back, ₹40 back again, which
 * leaves the bill at plus twenty and is legal every step of the way. Only the
 * last event is written directly, for the same reason as in
 * `carriedOverOverRefund` above: `reverse_payment` now refuses to take a bill
 * below zero, so the ₹100 receipt is marked reversed here, setting exactly the
 * four columns that command sets and nothing else.
 *
 * What matters about two refunds rather than one is the walk back. Undoing the
 * first lands on minus forty — still an over-refund — and the rule that used to
 * refuse anything still negative refused it, which left the only route out of
 * the state blocked by the rule meant to stop anybody entering it.
 */
async function carriedOverDoubleRefund(
  clinicStaff, name = 'Twice Refunded', phone = '+919000000851',
) {
  const { patientId, invoiceId } = await feeBill(clinicStaff, name, phone)

  await as(clinicStaff.pharmacy, 'take_payment', {
    invoiceId, parts: [{ method: 'cash', amount: 100 }],
  })
  const paymentReceipt = String(await scalar(
    `select receipt_number from jmc.payments where kind='payment' order by received_at desc limit 1`,
  ))
  for (const reason of [
    'Half given back at the counter on the day',
    'The rest given back the following morning',
  ]) {
    await as(clinicStaff.admin, 'refund_payment', {
      invoiceId, reason, refund: [{ method: 'cash', amount: 40 }],
    })
  }
  const [firstRefund, secondRefund] = (await rows(
    `select receipt_number from jmc.payments where kind='refund' order by receipt_number`,
  )).map((row) => String(row.receipt_number))

  await rows(
    `update jmc.payments
        set status='reversed', reversed_by=$1, reversed_at=now(),
            reversal_reason='Carried over: the card never settled'
      where receipt_number=$2`,
    [clinicStaff.admin.id, paymentReceipt],
  )

  return {
    patientId, invoiceId, paymentReceipt, firstRefund, secondRefund,
    firstRefundId: await paymentIdOf(firstRefund),
    secondRefundId: await paymentIdOf(secondRefund),
  }
}

/**
 * Cancel a bill the way history did, rather than the way the command allows.
 *
 * `void_invoice` permits a void only at exactly zero, so neither of the two
 * states below — a cancelled bill holding money, a cancelled bill in credit to
 * the patient — can be reached through it any more. They are nevertheless in
 * the history the clinic is carrying across, so they are written here, setting
 * exactly the four columns `void_invoice` sets: status, reason, who, and when.
 */
async function voidedByHistory(clinicStaff, invoiceId, reason) {
  await rows(
    `update jmc.invoices
        set status='void', void_reason=$1, voided_by=$2, voided_at=now()
      where id=$3`,
    [reason, clinicStaff.admin.id, invoiceId],
  )
}

// ═══════════════════════════════════════════════════════════════════════════

describe('a reversal that would take a bill below zero', () => {
  test('₹100 taken, ₹40 refunded, and the ₹100 cannot then be reversed', async () => {
    const staff = await clinic()
    const { patientId, invoiceId } = await feeBill(staff)

    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })
    await as(staff.admin, 'refund_payment', {
      invoiceId, reason: 'Overcharged by one strip', refund: [{ method: 'cash', amount: 40 }],
    })
    assert.equal((await balance(invoiceId)).paid, '60.00', 'a refund reduces what has been paid')

    const paymentId = await paymentIdOf('RCP-000001')

    // Refused, and the refusal is useful: it says by how much, on which bill,
    // that nothing happened, and which receipt has to be reversed first.
    await refusedWithoutTrace(
      patientId,
      'reversing a ₹100 receipt that has already been refunded against',
      () => as(staff.admin, 'reverse_payment', {
        paymentId, reason: 'The card never settled',
      }),
      (error) => {
        assert.match(error.message, /INV-000001 would be ₹40\.00 over-refunded/)
        assert.match(error.message, /nothing has been reversed/)
        assert.match(error.message, /Reverse the refund first \(RCP-000002\)/)
        return true
      },
    )

    // Atomically, which for a reversal means the receipt itself is untouched:
    // there is no half-reversed payment, and no audit entry claiming otherwise.
    const [receipt] = await rows(`select * from jmc.payments where receipt_number='RCP-000001'`)
    assert.equal(receipt.status, 'received')
    assert.equal(receipt.reversed_at, null)
    assert.equal(receipt.reversed_by, null)
    assert.equal(receipt.reversal_reason, '')
    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events where action='payment.reversed'`),
      0,
      'nothing was reversed, so nothing says it was',
    )
    assert.equal((await balance(invoiceId)).paid, '60.00')
    assert.equal((await balance(invoiceId)).payment_state, 'part_paid')
  })

  test('one receipt split across two bills is reversed for both, or for neither', async () => {
    const staff = await clinic()
    const first = await feeBill(staff, 'Split One', '+919000000811')
    const second = await feeBill(staff, 'Split Two', '+919000000812')

    await as(staff.pharmacy, 'take_payment', {
      invoiceId: first.invoiceId, parts: [{ method: 'cash', amount: 100 }],
    })
    const paymentId = await paymentIdOf('RCP-000001')

    /*
     * A receipt allocated to a SECOND bill, written directly.
     *
     * `take_payment` collects against one bill at a time, so the commands
     * cannot produce a split receipt today — but `reverse_payment` is written
     * for the case where one exists ("a receipt can be split across more than
     * one bill, and saying the money never arrived says it about all of them
     * at once"), and a loop that is never given more than one row to walk is
     * not evidence of anything. So the second allocation is inserted here.
     *
     * The refund below then puts the FIRST bill — whichever way the invoice
     * ids happen to sort — below zero if the receipt is reversed, while the
     * second bill would survive it perfectly well. Either both are reversed or
     * neither is, and the answer has to be neither.
     */
    await rows(
      `insert into jmc.payment_allocations (id, payment_id, invoice_id, amount, created_at)
       values ('split-allocation', $1, $2, 60.00, now())`,
      [paymentId, second.invoiceId],
    )
    await as(staff.admin, 'refund_payment', {
      invoiceId: first.invoiceId, reason: 'Refunded in cash at the counter',
      refund: [{ method: 'cash', amount: 80 }],
    })

    assert.equal((await balance(first.invoiceId)).paid, '20.00')
    assert.equal((await balance(second.invoiceId)).paid, '60.00', 'the other bill is fine')

    await refusedWithoutTrace(
      first.patientId,
      'reversing a split receipt where one of its two bills would go below zero',
      () => as(staff.admin, 'reverse_payment', { paymentId, reason: 'The card never settled' }),
      /would be ₹80\.00 over-refunded .* so nothing has been reversed/s,
    )

    // And the bill that would have survived it is untouched too, which is the
    // atomicity: a reversal is one event about one receipt, not a per-bill
    // decision taken row by row.
    assert.equal((await balance(second.invoiceId)).paid, '60.00')
    assert.equal(
      String(await scalar(`select status from jmc.payments where id=$1`, [paymentId])),
      'received',
    )
  })

  test('reverse the erroneous refund first and the payment then reverses cleanly', async () => {
    const staff = await clinic()
    const { invoiceId } = await feeBill(staff)

    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })
    await as(staff.admin, 'refund_payment', {
      invoiceId, reason: 'Refunded against the wrong bill', refund: [{ method: 'cash', amount: 40 }],
    })

    // The order the refusal asked for: the ₹40 refund was the mistake, so it
    // goes back first and the ₹100 reversal then lands on exactly zero.
    await as(staff.admin, 'reverse_payment', {
      paymentId: await paymentIdOf('RCP-000002'),
      reason: 'The refund was keyed against the wrong bill and never left the drawer',
    })
    assert.equal((await balance(invoiceId)).paid, '100.00', 'reversing money OUT puts it back')

    await as(staff.admin, 'reverse_payment', {
      paymentId: await paymentIdOf('RCP-000001'),
      reason: 'The card never settled',
    })

    const settled = await balance(invoiceId)
    assert.equal(settled.paid, '0.00', 'net nothing was ever paid against this bill')
    assert.equal(settled.due, '300.00', 'so the whole fee is owed again')
    assert.equal(settled.payment_state, 'unpaid')
    assert.equal(
      await scalar('select count(*)::int from jmc.financial_review_queue'), 0,
      'and there is nothing for an accountant to look at',
    )

    // Both receipts keep their numbers and stay on the record as reversed;
    // neither is deleted, because neither is a thing that did not happen.
    assert.deepEqual(
      (await rows('select receipt_number, kind, status from jmc.payments order by receipt_number'))
        .map((row) => `${row.receipt_number} ${row.kind} ${row.status}`),
      ['RCP-000001 payment reversed', 'RCP-000002 refund reversed'],
    )
  })
})

describe('a bill that arrived below zero', () => {
  test('a negative historical balance reads as over_refunded, not as unpaid', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    const bill = await balance(carried.invoiceId)
    assert.equal(bill.paid, '-40.00', 'forty rupees more went out than ever came in')
    assert.equal(
      bill.payment_state, 'over_refunded',
      'the state a counter must not treat as a bill waiting to be paid',
    )
    // `due` is the total minus a negative, so it is LARGER than the bill. That
    // is what the arithmetic says, and flattening it would hide the exception.
    assert.equal(bill.total, '300.00')
    assert.equal(bill.due, '340.00')

    // The patient's row carries the exception as a count, not only as money
    // folded into `outstanding`, so a dues list can tell a person to chase
    // apart from a case to investigate.
    const person = await patientRow(carried.patientId)
    assert.equal(Number(person.over_refunded_invoices), 1)
    assert.equal(person.over_refunded_amount, '40.00', 'a positive magnitude, being a quantity')
    assert.equal(person.outstanding, '340.00')

    // And it is on the queue, with the documents that explain it.
    const review = await reviewRow(carried.invoiceId)
    assert.ok(review, 'an over-refunded bill is on the financial review queue by being one')
    assert.equal(review.invoice_number, 'INV-000001')
    assert.equal(review.patient_name, 'Edge Case')
    assert.equal(review.review_state, 'over_refunded', 'the row and the badge cannot disagree')
    assert.equal(review.paid, '-40.00', 'signed, so the row says which side of zero it is on')
    assert.equal(review.out_of_balance, '40.00', 'and how far from zero, which is what it sorts on')
    /*
     * `over_refunded_by` is gone, and its absence is asserted rather than left
     * to be noticed. It was a positive magnitude that assumed the balance was
     * negative, and the queue now carries rows where it is positive — money
     * held against a cancelled bill — for which "over-refunded by minus a
     * hundred" is not a sentence anybody should have to read.
     */
    assert.ok(
      !('over_refunded_by' in review),
      'the column that assumed one direction must not come back',
    )
    assert.equal(Number(review.receipts_in), 0, 'the payment was reversed, so nothing came in')
    assert.equal(Number(review.receipts_out), 1)
    assert.equal(Number(review.receipts_reversed), 1)
    assert.match(review.documents, new RegExp(`${carried.paymentReceipt} payment 100\\.00 \\(reversed\\)`))
    assert.match(review.documents, new RegExp(`${carried.refundReceipt} refund 40\\.00`))
  })

  test('the only way out of an over-refund is walking the refunds back one at a time', async () => {
    const staff = await clinic()
    const carried = await carriedOverDoubleRefund(staff)

    assert.equal((await balance(carried.invoiceId)).paid, '-80.00', 'two refunds and no payment')
    assert.equal((await balance(carried.invoiceId)).payment_state, 'over_refunded')

    /*
     * ── THE FIRST STEP, WHICH USED TO BE THE WALL ─────────────────────────
     *
     * Reversing money OUT can only ever move a bill towards zero, so it is
     * permitted even though the bill is still below zero when it lands. The
     * old rule refused any reversal that left a bill negative and did not ask
     * which way the money was going, so this exact call was refused — and with
     * it the only exit from the state, by the rule that existed to stop
     * anybody entering it.
     */
    await as(staff.admin, 'reverse_payment', {
      paymentId: carried.firstRefundId,
      reason: 'The first ₹40 was keyed against the wrong bill and never left the drawer',
    })

    const halfway = await balance(carried.invoiceId)
    assert.equal(halfway.paid, '-40.00', 'one refund undone, one still standing')
    assert.equal(halfway.payment_state, 'over_refunded', 'so it is still the exception')

    // Queue MEMBERSHIP, not just the balance. A bill that is still forty
    // rupees out and has quietly left the accountant's list is worse than one
    // that never reached it: the figure is still wrong and nothing says so.
    const stillThere = await reviewRow(carried.invoiceId)
    assert.ok(stillThere, 'halfway out of an over-refund is still an over-refund')
    assert.equal(stillThere.review_state, 'over_refunded')
    assert.equal(stillThere.paid, '-40.00')
    assert.equal(stillThere.out_of_balance, '40.00')
    assert.equal(Number((await patientRow(carried.patientId)).under_review_invoices), 1)

    // ── AND THE SECOND STEP, WHICH FINISHES IT ────────────────────────────
    await as(staff.admin, 'reverse_payment', {
      paymentId: carried.secondRefundId,
      reason: 'The second ₹40 was the same mistake keyed again',
    })

    const settled = await balance(carried.invoiceId)
    assert.equal(settled.paid, '0.00', 'net nothing was ever paid against this bill')
    assert.equal(settled.due, '300.00', 'so the whole fee is owed again')
    assert.equal(settled.payment_state, 'unpaid')

    assert.equal(
      await reviewRow(carried.invoiceId), undefined,
      'and at zero it leaves the queue, because the queue is derived rather than enqueued',
    )
    assert.equal(await scalar('select count(*)::int from jmc.financial_review_queue'), 0)

    const person = await patientRow(carried.patientId)
    assert.equal(Number(person.under_review_invoices), 0)
    assert.equal(Number(person.over_refunded_invoices), 0)
    assert.equal(person.over_refunded_amount, '0.00')

    // Three receipts, all keeping their numbers. Nothing is deleted, because
    // none of them is a thing that did not happen.
    assert.deepEqual(
      (await rows('select receipt_number, kind, status from jmc.payments order by receipt_number'))
        .map((row) => `${row.receipt_number} ${row.kind} ${row.status}`),
      [
        `${carried.paymentReceipt} payment reversed`,
        `${carried.firstRefund} refund reversed`,
        `${carried.secondRefund} refund reversed`,
      ],
    )
  })
})

describe('a cancelled bill that did not land on zero', () => {
  test('money still held against a cancelled bill is not filed under closed', async () => {
    const staff = await clinic()
    const { patientId, invoiceId } = await feeBill(staff, 'Void In Credit', '+919000000861')
    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })

    /*
     * Voiding above zero is refused (`Refund the payment first`), and so is
     * reversing any receipt against a voided bill — which was the other route
     * in: take ₹100, refund ₹100, void at zero, then reverse the refund and the
     * bill is cancelled with a hundred rupees of the patient's money on it. Both
     * doors are shut, so this can only be written directly. It is nevertheless
     * in the history being carried across, and this is what it has to read as.
     */
    await voidedByHistory(staff, invoiceId, 'Carried over: cancelled with the money still on it')

    const bill = await balance(invoiceId)
    assert.equal(bill.status, 'void')
    assert.equal(bill.paid, '100.00', 'a hundred rupees of the patient’s money, against nothing')
    assert.equal(bill.total, '300.00')
    assert.equal(bill.due, '200.00')
    assert.equal(
      bill.payment_state, 'void_with_balance',
      'not `void`, which would say there is nothing to look at',
    )

    // On the queue, with the receipt that explains it.
    const review = await reviewRow(invoiceId)
    assert.ok(review, 'a cancelled bill holding money is under review by being one')
    assert.equal(review.invoice_number, 'INV-000001')
    assert.equal(review.patient_name, 'Void In Credit')
    assert.equal(review.status, 'void')
    assert.equal(review.review_state, 'void_with_balance')
    assert.equal(review.paid, '100.00', 'positive, and the row is able to say so')
    assert.equal(review.out_of_balance, '100.00', 'distance from zero, not a direction')
    assert.match(String(review.void_reason), /cancelled with the money still on it/)
    assert.ok(review.voided_at, 'with when it was cancelled, which is where the search starts')
    assert.equal(Number(review.receipts_in), 1)
    assert.equal(Number(review.receipts_out), 0)
    assert.equal(Number(review.receipts_reversed), 0)
    assert.match(String(review.documents), /RCP-000001 payment 100\.00/)

    /*
     * And on the patient's row — which is the only place it can appear.
     *
     * `billed`, `paid` and `outstanding` all exclude voided bills, and always
     * have, so a patient whose only problem is a cancelled bill with money on
     * it has an `outstanding` of zero and nothing to chase. The signed
     * `void_with_balance_amount` is the whole record of it.
     */
    const person = await patientRow(patientId)
    assert.equal(person.outstanding, '0.00', 'the money columns still exclude a voided bill')
    assert.equal(Number(person.void_with_balance_invoices), 1)
    assert.equal(
      person.void_with_balance_amount, '100.00',
      'signed, because money held and money over-refunded are different errors',
    )
    assert.equal(Number(person.under_review_invoices), 1)
    assert.equal(
      Number(person.over_refunded_invoices), 0,
      'nothing went back out, so this is not an over-refund',
    )
    assert.equal(person.over_refunded_amount, '0.00')
  })

  test('a cancelled bill below zero says void_with_balance, and is still counted as an over-refund', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    /*
     * Voiding is refused below zero (the next describe block), so this too can
     * only arrive from history — a bill voided years ago with money still out
     * against it.
     *
     * This test used to assert `over_refunded`, on the reasoning that letting
     * `void` win would file the exception under "closed". That reasoning was
     * right and the word was wrong: `void_with_balance` is the more specific
     * statement about the same bill, and of the two facts true about it, the
     * one that tells somebody what to do is that it was CANCELLED with money
     * still against it. The exception is not hidden by the relabelling, and
     * the second half of this test is what proves that.
     */
    await voidedByHistory(staff, carried.invoiceId, 'Carried over: voided before the correction')

    const bill = await balance(carried.invoiceId)
    assert.equal(bill.status, 'void')
    assert.equal(bill.paid, '-40.00')
    assert.equal(
      bill.payment_state, 'void_with_balance',
      'the more specific of the two true statements, which is the tested-first one',
    )
    assert.notEqual(
      bill.payment_state, 'over_refunded',
      'the ordering in the view is the contract: void_with_balance is tested first',
    )

    // ── AND NOTHING IS LOST BY THE MORE SPECIFIC WORD ─────────────────────
    //
    // The queue's `where` and the patient's over-refund columns are defined on
    // the MONEY — `paid < 0` — rather than on the state word, which is exactly
    // what keeps them from emptying when a bill is relabelled above them.
    const review = await reviewRow(carried.invoiceId)
    assert.ok(review, 'it stays on the review queue')
    assert.equal(review.review_state, 'void_with_balance')
    assert.equal(review.paid, '-40.00')
    assert.equal(review.out_of_balance, '40.00')
    assert.equal(Number(review.receipts_in), 0, 'the payment was reversed, so nothing came in')
    assert.equal(Number(review.receipts_out), 1)
    assert.equal(Number(review.receipts_reversed), 1)

    const person = await patientRow(carried.patientId)
    assert.equal(person.outstanding, '0.00', 'the money columns exclude voided bills as they always did')
    assert.equal(
      Number(person.over_refunded_invoices), 1,
      'money that left the drawer did not stop leaving it because the bill was cancelled',
    )
    assert.equal(person.over_refunded_amount, '40.00', 'a positive magnitude, being a quantity')
    assert.equal(Number(person.void_with_balance_invoices), 1)
    assert.equal(
      person.void_with_balance_amount, '-40.00',
      'negative here, where the bill above it was positive — which is why it is signed',
    )
    // Counted ONCE. It is one case for one person to look at, not two.
    assert.equal(Number(person.under_review_invoices), 1)
  })
})

describe('what may be voided, and what may not', () => {
  test('voiding a bill below zero asks for a financial correction, not for a parser', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    await refusedWithoutTrace(
      carried.patientId,
      'voiding an over-refunded bill',
      () => as(staff.admin, 'void_invoice', {
        invoiceId: carried.invoiceId, reason: 'Tidying up an old bill',
      }),
      (error) => {
        /*
         * The defect this replaces, asserted by its absence.
         *
         * `void_invoice` used to read `paid` with the counter's own input
         * validator, which refuses a negative amount — so an admin who had
         * typed nothing was shown "amount paid cannot be negative", a true
         * sentence about an input and a useless one about a ledger, printed by
         * the very command whose job was to say what was wrong with the bill.
         */
        assert.doesNotMatch(
          error.message, /amount paid cannot be negative/,
          'the old parser complaint must not come back',
        )
        assert.ok(
          error.message.startsWith('Over-refunded — financial correction required.'),
          `the refusal must lead with the exception, and said: ${error.message}`,
        )
        assert.match(error.message, /₹40\.00 more has gone back out on INV-000001 than ever came in/)
        assert.match(error.message, /Nothing has been changed/)
        assert.match(error.message, /financial review queue for the admin or accountant/)
        return true
      },
    )

    assert.equal(
      String(await scalar('select status from jmc.invoices where id=$1', [carried.invoiceId])),
      'open',
      'the bill is still open, and still visible',
    )
  })

  test('a bill that has been paid against cannot be voided either', async () => {
    const staff = await clinic()
    const { patientId, invoiceId } = await feeBill(staff)
    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 300 }] })

    await refusedWithoutTrace(
      patientId,
      'voiding a bill that has been paid in full',
      () => as(staff.admin, 'void_invoice', { invoiceId, reason: 'Raised against the wrong patient' }),
      (error) => {
        assert.match(error.message, /INV-000001 has been paid against/)
        assert.match(error.message, /Refund the payment first; voiding it would lose the money/)
        // A positive balance is the ordinary mistake and gets the ordinary
        // instruction. It must not be dressed up as the exception.
        assert.doesNotMatch(error.message, /Over-refunded/)
        return true
      },
    )
  })

  test('exactly zero may be voided, whether nothing came in or it all went back', async () => {
    const staff = await clinic()

    // 1. Nothing was ever paid. The ordinary void, and the only one the
    //    command used to know about.
    const untouched = await feeBill(staff, 'Never Paid', '+919000000821')
    assert.equal((await balance(untouched.invoiceId)).paid, '0.00')
    await as(staff.admin, 'void_invoice', {
      invoiceId: untouched.invoiceId, reason: 'Raised against the wrong visit',
    })
    assert.equal((await balance(untouched.invoiceId)).payment_state, 'void')

    // 2. Paid, then refunded back to nothing. The money came in and went out
    //    again, both events stand on the record, and the net is zero — which
    //    is a bill that may be closed.
    const refunded = await feeBill(staff, 'Paid Then Refunded', '+919000000822')
    await as(staff.pharmacy, 'take_payment', {
      invoiceId: refunded.invoiceId, parts: [{ method: 'cash', amount: 300 }],
    })
    await as(staff.admin, 'refund_payment', {
      invoiceId: refunded.invoiceId, reason: 'The visit did not happen',
      refund: [{ method: 'cash', amount: 300 }],
    })
    assert.equal((await balance(refunded.invoiceId)).paid, '0.00')
    await as(staff.admin, 'void_invoice', {
      invoiceId: refunded.invoiceId, reason: 'Raised for a visit that did not happen',
    })
    assert.equal((await balance(refunded.invoiceId)).payment_state, 'void')

    // 3. Paid, then the payment reversed back to nothing. A different
    //    statement from refunding — the money never arrived — and it lands on
    //    the same zero.
    const reversed = await feeBill(staff, 'Paid Then Reversed', '+919000000823')
    await as(staff.pharmacy, 'take_payment', {
      invoiceId: reversed.invoiceId, parts: [{ method: 'card', amount: 300 }],
    })
    const cardReceipt = String(await scalar(
      `select receipt_number from jmc.payments where method='card' order by received_at desc limit 1`,
    ))
    await as(staff.admin, 'reverse_payment', {
      paymentId: await paymentIdOf(cardReceipt), reason: 'The card never settled',
    })
    assert.equal((await balance(reversed.invoiceId)).paid, '0.00')
    await as(staff.admin, 'void_invoice', {
      invoiceId: reversed.invoiceId, reason: 'Raised against the wrong patient',
    })
    assert.equal((await balance(reversed.invoiceId)).payment_state, 'void')

    // None of the three left anything on the review queue: zero is zero.
    assert.equal(await scalar('select count(*)::int from jmc.financial_review_queue'), 0)
  })
})

describe('a cancelled bill is closed in both directions', () => {
  /**
   * ₹300 billed, ₹100 taken, ₹100 given back, then cancelled at exactly zero.
   *
   * Every step through the real commands, and every step legal: the void is
   * allowed precisely because the two receipts net to nothing. What the tests
   * below are about is that the netting has to STAY true, and each of its two
   * halves is one command away from being undone.
   */
  async function voidedAtZero(staff) {
    const { patientId, invoiceId } = await feeBill(staff, 'Settled Then Cancelled', '+919000000871')
    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })
    await as(staff.admin, 'refund_payment', {
      invoiceId, reason: 'Taken against the wrong bill and given straight back',
      refund: [{ method: 'cash', amount: 100 }],
    })
    assert.equal((await balance(invoiceId)).paid, '0.00', 'zero, which is what makes the void legal')
    await as(staff.admin, 'void_invoice', {
      invoiceId, reason: 'Raised against the wrong visit',
    })
    return {
      patientId, invoiceId,
      paymentId: await paymentIdOf('RCP-000001'),
      refundId: await paymentIdOf('RCP-000002'),
    }
  }

  test('neither receipt behind a cancelled bill may be reversed', async () => {
    const staff = await clinic()
    const voided = await voidedAtZero(staff)

    assert.equal((await balance(voided.invoiceId)).payment_state, 'void')
    assert.equal(await scalar('select count(*)::int from jmc.financial_review_queue'), 0)

    /*
     * The two halves of the netting, refused in the same words.
     *
     * Reversing the REFUND is the one that used to be waved through: it moves
     * the bill UP, to plus a hundred, and the old check only ever asked
     * whether a reversal would take a bill below zero. That left a cancelled
     * bill with a hundred rupees of the patient's money against it and no
     * screen in the clinic that would ever mention it.
     *
     * Reversing the PAYMENT is the mirror image and would leave the same bill
     * at minus a hundred. Neither is a repair; both are corrections an
     * accountant has to approve, and there is no workflow for one yet.
     */
    const cancelledBillIsClosed = (receipt) => (error) => {
      assert.match(
        error.message,
        new RegExp(`INV-000001 has been voided, so ${receipt} cannot be reversed`),
      )
      assert.match(error.message, /nothing has been reversed/)
      assert.match(error.message, /A cancelled bill has to stay at exactly nothing/)
      assert.match(error.message, /accountant-approved correction, and there is no workflow for one yet/)
      return true
    }

    await refusedWithoutTrace(
      voided.patientId,
      'reversing the refund behind a cancelled bill, which would leave it holding money',
      () => as(staff.admin, 'reverse_payment', {
        paymentId: voided.refundId, reason: 'The refund never left the drawer',
      }),
      cancelledBillIsClosed('RCP-000002'),
    )

    await refusedWithoutTrace(
      voided.patientId,
      'reversing the payment behind a cancelled bill, which would take it below zero',
      () => as(staff.admin, 'reverse_payment', {
        paymentId: voided.paymentId, reason: 'The card never settled',
      }),
      cancelledBillIsClosed('RCP-000001'),
    )

    // Still exactly what it was: cancelled, at nothing, both receipts standing,
    // and nothing for an accountant to look at.
    const settled = await balance(voided.invoiceId)
    assert.equal(settled.status, 'void')
    assert.equal(settled.paid, '0.00')
    assert.equal(settled.payment_state, 'void')
    assert.deepEqual(
      (await rows('select receipt_number, kind, status from jmc.payments order by receipt_number'))
        .map((row) => `${row.receipt_number} ${row.kind} ${row.status}`),
      ['RCP-000001 payment received', 'RCP-000002 refund received'],
    )
    assert.equal(await scalar('select count(*)::int from jmc.financial_review_queue'), 0)
  })

  test('nothing may be refunded out of a cancelled bill either', async () => {
    const staff = await clinic()
    const voided = await voidedAtZero(staff)

    // At zero there is simply nothing there, and the refusal says that rather
    // than reaching for the review queue it does not belong on.
    await refusedWithoutTrace(
      voided.patientId,
      'refunding again from a bill that is cancelled and already at zero',
      () => as(staff.admin, 'refund_payment', {
        invoiceId: voided.invoiceId, reason: 'She came back and asked for it again',
        refund: [{ method: 'cash', amount: 40 }],
      }),
      (error) => {
        assert.match(
          error.message, /INV-000001 has been voided, so there is nothing to refund against it/,
        )
        return true
      },
    )

    // And on the carried-over bill that IS holding money, refunding the
    // balance away is the obvious repair and is exactly the correction nobody
    // has approved — so it gets the review-queue answer instead.
    const held = await feeBill(staff, 'Void In Credit', '+919000000872')
    await as(staff.pharmacy, 'take_payment', {
      invoiceId: held.invoiceId, parts: [{ method: 'cash', amount: 100 }],
    })
    await voidedByHistory(staff, held.invoiceId, 'Carried over: cancelled with the money still on it')

    await refusedWithoutTrace(
      held.patientId,
      'refunding the balance away from a cancelled bill that is holding money',
      () => as(staff.admin, 'refund_payment', {
        invoiceId: held.invoiceId, reason: 'Tidying up an old bill',
        refund: [{ method: 'cash', amount: 100 }],
      }),
      (error) => {
        assert.match(
          error.message,
          /INV-000002 has been voided with ₹100\.00 against it, and refunding that away is a correction an accountant has to approve/,
        )
        assert.match(error.message, /Nothing has been changed/)
        assert.match(error.message, /financial review queue/)
        return true
      },
    )
  })

  test('a void and a reversal arriving together cannot leave a cancelled bill off zero', async () => {
    /*
     * The two commands that are each legal on their own.
     *
     * At exactly zero, `void_invoice` is allowed — that is the whole rule —
     * and `reverse_payment` on the refund is allowed too, because the bill is
     * not void YET and reversing a refund only moves it towards zero. Run them
     * a second apart in either order and the second one is refused by the
     * first one's result. Run them in the same second and the question is
     * whether the row locks make that still true, or whether both read a bill
     * at zero and one of them cancels it while the other moves it off.
     *
     * THREE ARRANGEMENTS. The first two submit both at once, in each order,
     * and which one wins is a genuine coin flip: measured repeatedly, the same
     * arrangement produced both outcomes on different runs. That is the right
     * shape for the property — the invariant must hold however it lands — and
     * the wrong shape for coverage, because a coin flip can come down the same
     * way all week and leave the other branch of this test never run.
     *
     * So the third arrangement removes the flip. `reverse_payment` looks the
     * receipt up and takes ITS lock before it ever reaches the bill, while
     * `void_invoice` goes straight for the invoice row; a few milliseconds'
     * head start is therefore enough for the reversal to be holding the
     * invoice when the void asks for it, and the void then reliably meets a
     * transaction that has not committed yet. Every assertion below is still
     * written about whichever one won rather than about which one should.
     */
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    )

    for (const arrangement of [
      { label: 'with both submitted at once, the void first', reversalFirst: false, headStart: 0 },
      { label: 'with both submitted at once, the reversal first', reversalFirst: true, headStart: 0 },
      { label: 'with the reversal already holding the bill', reversalFirst: true, headStart: 25 },
    ]) {
      const staff = await clinic()
      const { patientId, invoiceId } = await feeBill(staff, 'Race Condition', '+919000000881')
      await as(staff.pharmacy, 'take_payment', {
        invoiceId, parts: [{ method: 'cash', amount: 100 }],
      })
      await as(staff.admin, 'refund_payment', {
        invoiceId, reason: 'Taken against the wrong bill and given straight back',
        refund: [{ method: 'cash', amount: 100 }],
      })
      assert.equal((await balance(invoiceId)).paid, '0.00', 'both commands are legal from here')
      const refundId = await paymentIdOf('RCP-000002')

      const voiding = () => settle(as(staff.admin, 'void_invoice', {
        invoiceId, reason: 'Raised against the wrong visit',
      }))
      const reversing = () => settle(as(staff.admin, 'reverse_payment', {
        paymentId: refundId, reason: 'The refund never left the drawer',
      }))

      const where = arrangement.label
      let started
      if (arrangement.reversalFirst) {
        const reversalRun = reversing()
        // Both are already settling, so neither rejection is unhandled while
        // this waits — which is the only reason a head start is safe to take.
        if (arrangement.headStart > 0) {
          await new Promise((resolve) => setTimeout(resolve, arrangement.headStart))
        }
        started = [reversalRun, voiding()]
      } else {
        const voidRun = voiding()
        started = [reversing(), voidRun]
      }
      const [reversal, voided] = await Promise.all(started)

      const bill = await balance(invoiceId)
      const [refund] = await rows('select * from jmc.payments where id=$1', [refundId])

      assert.equal(
        [reversal, voided].filter((result) => result.status === 'fulfilled').length, 1,
        `${where}: exactly one of the two may take effect, and got ` +
        JSON.stringify([reversal, voided].map((result) => result.status)),
      )

      if (voided.status === 'fulfilled') {
        // The void won, so the reversal met a cancelled bill and was refused.
        assert.equal(bill.status, 'void', where)
        assert.equal(bill.paid, '0.00', `${where}: a cancelled bill stays at exactly nothing`)
        assert.equal(bill.payment_state, 'void', where)
        assert.equal(refund.status, 'received', `${where}: the refund that made the zero still stands`)
        assert.equal(refund.reversed_at, null, where)
        assert.match(String(reversal.reason.message), /has been voided/, where)
      } else {
        // The reversal won, so the void met a bill in credit and was refused.
        assert.equal(refund.status, 'reversed', where)
        assert.equal(bill.status, 'open', `${where}: the bill was never cancelled`)
        assert.equal(bill.paid, '100.00', `${where}: the reversal put the payment back`)
        assert.equal(bill.payment_state, 'part_paid', where)
        assert.match(String(voided.reason.message), /has been paid against/, where)
        assert.match(String(voided.reason.message), /Refund the payment first/, where)
      }

      // The invariant, whichever way it resolved and wherever else it is read.
      assert.equal(
        await scalar(
          `select count(*)::int from jmc.invoice_balances where status='void' and paid <> 0`,
        ),
        0,
        `${where}: no race may produce a cancelled bill with money against it`,
      )
      assert.equal(
        await scalar(`select count(*)::int from jmc.invoice_balances where payment_state='void_with_balance'`),
        0,
        `${where}: and so nothing may reach the state the commands cannot create`,
      )
      assert.equal(
        await scalar('select count(*)::int from jmc.financial_review_queue'), 0,
        `${where}: nothing for an accountant either way`,
      )
      assert.equal(
        Number((await patientRow(patientId)).under_review_invoices), 0, where,
      )

      // One event, once: the losing command left no audit entry claiming it
      // happened, which is the same rollback claim `refusedWithoutTrace` makes
      // for the sequential refusals above.
      assert.equal(
        await scalar(
          `select count(*)::int from jmc.audit_events
            where action in ('invoice.voided', 'payment.reversed')`,
        ),
        1,
        `${where}: only the command that committed may be on the record`,
      )
    }
  })
})

describe('an over-refunded bill is not a counter’s business', () => {
  test('money can neither be taken on it nor refunded from it', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)
    // A function rather than a regular expression, because `assert.rejects`
    // matches a regular expression against `String(error)` — which begins
    // "Error: " — and the claim here is about the first word the admin reads.
    const sameComplaint = (error) => {
      assert.ok(
        error.message.startsWith('Over-refunded — financial correction required.'),
        `the refusal must lead with the exception, and said: ${error.message}`,
      )
      assert.match(error.message, /Nothing has been changed/)
      return true
    }

    // `due` on this bill is ₹340 — the total minus a negative — and handing
    // that figure to the counter would charge the patient ₹40 for the clinic's
    // own mistake. So the counter is told the truth instead.
    await refusedWithoutTrace(
      carried.patientId,
      'taking payment on an over-refunded bill',
      () => as(staff.pharmacy, 'take_payment', {
        invoiceId: carried.invoiceId, parts: [{ method: 'cash', amount: 340 }],
      }),
      sameComplaint,
    )

    // And refunding more from a bill that is already in credit is the action
    // that made the mess; it gets the same sentence, on purpose.
    await refusedWithoutTrace(
      carried.patientId,
      'refunding again from an over-refunded bill',
      () => as(staff.admin, 'refund_payment', {
        invoiceId: carried.invoiceId, reason: 'She asked for the rest back',
        refund: [{ method: 'cash', amount: 10 }],
      }),
      sameComplaint,
    )
  })

  test('a balance that is below zero can be READ, and a negative amount still cannot be TYPED', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    /*
     * The signed-parsing property, from both ends.
     *
     * Every figure on `jmc.invoice_balances` is derived, so `paid` can come
     * back below zero and reading it must not raise. Everything a person
     * offers at a counter goes through the input validator instead, where a
     * negative amount is a mistake and stays refused. The new `signed` option
     * exists to keep those two questions apart, and the failure that matters
     * is it leaking from the first into the second.
     */
    const seen = await snapshot.readSnapshot(sessionFor(staff.admin))
    const onScreen = seen.invoices.find((invoice) => invoice.id === carried.invoiceId)
    assert.ok(onScreen, 'the exception reaches the counter tablet rather than being filtered out')
    assert.equal(onScreen.paymentState, 'over_refunded')
    assert.equal(onScreen.paid, -40)

    const balanceRow = seen.patientBalances.find((row) => row.patientId === carried.patientId)
    assert.ok(balanceRow, 'and so does the patient it belongs to')
    assert.equal(balanceRow.overRefundedInvoices, 1)
    assert.equal(balanceRow.overRefundedAmount, 40)

    // The guard at the other end, unchanged: a counter cannot type a negative.
    const clean = await feeBill(staff, 'Typed By Hand', '+919000000831')
    await refusedWithoutTrace(
      clean.patientId,
      'taking a payment of minus three hundred rupees',
      () => as(staff.pharmacy, 'take_payment', {
        invoiceId: clean.invoiceId, parts: [{ method: 'cash', amount: -300 }],
      }),
      /Payment 1 cannot be negative\./,
    )
    await refusedWithoutTrace(
      clean.patientId,
      'refunding minus forty rupees',
      () => as(staff.admin, 'refund_payment', {
        invoiceId: clean.invoiceId, reason: 'Typed with the sign the wrong way round',
        refund: [{ method: 'cash', amount: -40 }],
      }),
      /Payment 1 cannot be negative\./,
    )
  })
})

describe('the exception reaches the people who can correct it', () => {
  test('the financial review report shows the bill, and every document behind it', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    const report = await edgeGet(
      'reports', '?report=financial_review&days=400', await tokenFor(staff.admin),
    )
    assert.equal(report.status, 200, 'the admin can read the financial review queue')

    // ── the bill ─────────────────────────────────────────────────────────
    const queue = report.body.queue
    assert.equal(queue.length, 1, 'one row per bill under review')
    assert.equal(queue[0].invoice_number, 'INV-000001')
    assert.equal(queue[0].patient, 'Edge Case')
    assert.equal(queue[0].review_state, 'over_refunded', 'in the same word every screen uses')
    assert.equal(queue[0].paid, '-40.00', 'signed, so it says which side of zero this bill is on')
    assert.equal(queue[0].out_of_balance, '40.00', 'and how far, as a magnitude to read and sort on')
    assert.equal(queue[0].total, '300.00')
    assert.equal(Number(queue[0].receipts_in), 0)
    assert.equal(Number(queue[0].receipts_out), 1)
    assert.equal(Number(queue[0].receipts_reversed), 1)

    /*
     * ── and every document, as its OWN retrievable row ───────────────────
     *
     * The exception is not hidden, and neither is what caused it. "Which
     * receipts?" is the first question anybody asks of one of these, and a
     * queue that answers with an invoice number alone sends the reader back to
     * the database — which is how an exception stops being looked at. Both
     * receipts appear, with the reversal on the one it happened to.
     */
    const documents = report.body.documents
    assert.equal(documents.length, 2, 'the payment and the refund, one row each')

    const [incoming] = documents.filter((row) => row.receipt_number === carried.paymentReceipt)
    assert.ok(incoming, 'the ₹100 that came in is on the list, though it was reversed')
    assert.equal(incoming.kind, 'payment')
    assert.equal(incoming.amount, '100.00', 'what this receipt put against THIS bill')
    assert.equal(incoming.status, 'reversed')
    assert.match(incoming.reversal_reason, /never settled/)
    assert.equal(incoming.invoice_number, 'INV-000001')
    assert.equal(incoming.patient, 'Edge Case')

    const [outgoing] = documents.filter((row) => row.receipt_number === carried.refundReceipt)
    assert.ok(outgoing, 'and so is the ₹40 that went back out')
    assert.equal(outgoing.kind, 'refund')
    assert.equal(outgoing.amount, '40.00')
    assert.equal(outgoing.status, 'received')
    assert.match(outgoing.note, /against the wrong bill/, 'with the reason it was given')

    // ── and the person the money is owed back to ─────────────────────────
    const patients = report.body.patients
    assert.equal(patients.length, 1)
    assert.equal(patients[0].patient, 'Edge Case')
    assert.equal(Number(patients[0].over_refunded_invoices), 1)
    assert.equal(patients[0].over_refunded_amount, '40.00')
    // The other kind, at zero here, so the two are carried separately rather
    // than added into one figure that would mean neither.
    assert.equal(Number(patients[0].void_with_balance_invoices), 0)
    assert.equal(patients[0].void_with_balance_amount, '0.00')
  })

  test('a cancelled bill holding money reaches the accountant, though nothing is owed', async () => {
    const staff = await clinic()
    const { patientId, invoiceId } = await feeBill(staff, 'Void In Credit', '+919000000851')
    await as(staff.pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })
    await voidedByHistory(staff, invoiceId, 'Carried over: cancelled with the money still on it')

    /*
     * The row that every money column in the clinic excludes.
     *
     * `billed`, `paid` and `outstanding` all filter out voided bills, so this
     * patient owes nothing and is owed nothing, and `over_refunded_invoices` is
     * zero because nothing went back out. A report keyed on either figure has
     * no row for them — while the queue above it has one for their bill, which
     * is the two halves of the same report disagreeing about who is on it.
     */
    const token = await tokenFor(staff.admin)
    const report = await edgeGet('reports', '?report=financial_review&days=400', token)
    assert.equal(report.status, 200)

    assert.equal(report.body.queue.length, 1)
    assert.equal(report.body.queue[0].review_state, 'void_with_balance')
    assert.equal(report.body.queue[0].paid, '100.00', 'positive, and the report can say so')
    assert.equal(report.body.queue[0].out_of_balance, '100.00')
    assert.equal(report.body.queue[0].status, 'void')
    assert.match(report.body.queue[0].void_reason, /cancelled with the money still on it/)
    assert.ok(report.body.queue[0].voided_at)

    assert.equal(report.body.documents.length, 1, 'the receipt that is still sitting against it')
    assert.equal(report.body.documents[0].kind, 'payment')
    assert.equal(report.body.documents[0].amount, '100.00')
    assert.equal(report.body.documents[0].status, 'received')

    const [person] = report.body.patients
    assert.ok(person, 'and the patient is on the same report as their bill')
    assert.equal(person.patient, 'Void In Credit')
    assert.equal(person.outstanding, '0.00', 'nothing to chase, which is why it needs its own column')
    assert.equal(Number(person.over_refunded_invoices), 0)
    assert.equal(Number(person.void_with_balance_invoices), 1)
    assert.equal(person.void_with_balance_amount, '100.00')

    // And the dues list, which is read at a counter, keeps them too — on the
    // same `under_review_invoices` test, so the two lists cannot disagree.
    const dues = await edgeGet('reports', '?report=patient_dues&days=400', token)
    assert.equal(dues.status, 200)
    const row = dues.body.rows.find((entry) => entry.patient_id === patientId)
    assert.ok(row, 'a patient with nothing outstanding but a cancelled bill in credit is still listed')
    assert.equal(String(row.outstanding), '0.00')
    assert.equal(Number(row.void_with_balance_invoices), 1)
    assert.equal(String(row.void_with_balance_amount), '100.00')
  })

  test('the financial review queue is the accountant’s, not the counter’s', async () => {
    const staff = await clinic()
    await carriedOverOverRefund(staff)

    // Nothing at a counter resolves one of these — taking payment and voiding
    // are both refused — so the queue for correcting them is admin only, and
    // it is not even offered to the other desks.
    assert.ok(
      (await edgeGet('reports', '?report=index', await tokenFor(staff.admin)))
        .body.reports.includes('financial_review'),
    )
    for (const role of ['pharmacy', 'doctor', 'nurse']) {
      const token = await tokenFor(staff[role])
      assert.ok(
        !(await edgeGet('reports', '?report=index', token)).body.reports.includes('financial_review'),
        `${role} is not offered the financial review queue`,
      )
      const refused = await edgeGet('reports', '?report=financial_review&days=400', token)
      assert.equal(refused.status, 403, `${role} must not read it by asking for it directly`)
      assert.match(refused.body.message, /cannot read that report/)
    }
  })

  test('the dues list separates a person to telephone from a case to investigate', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)
    // An ordinary unpaid bill for somebody else, so the two rows can be told
    // apart on the same list rather than in isolation.
    const ordinary = await feeBill(staff, 'Ordinary Debtor', '+919000000841')

    const dues = await edgeGet('reports', '?report=patient_dues&days=400', await tokenFor(staff.admin))
    assert.equal(dues.status, 200)

    const exception = dues.body.rows.find((row) => row.patient_id === carried.patientId)
    assert.ok(exception, 'the over-refunded bill still shows as money the clinic is owed back')
    assert.equal(String(exception.outstanding), '340.00', 'the total minus a negative')
    assert.equal(Number(exception.over_refunded_invoices), 1)
    assert.equal(String(exception.over_refunded_amount), '40.00')

    const debtor = dues.body.rows.find((row) => row.patient_id === ordinary.patientId)
    assert.ok(debtor, 'and an ordinary unpaid fee is on the same list')
    assert.equal(String(debtor.outstanding), '300.00')
    assert.equal(Number(debtor.over_refunded_invoices), 0, 'with nothing to investigate')
    assert.equal(String(debtor.over_refunded_amount), '0.00')

    // The exception sorts first, rather than at the far end of a descending
    // column of ordinary dues where nobody scrolls.
    assert.equal(dues.body.rows[0].patient_id, carried.patientId)
  })
})
