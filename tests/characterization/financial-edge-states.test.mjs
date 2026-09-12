/**
 * A bill against which more money has gone out than ever came in.
 *
 * Slice 4 derived unpaid / part paid / paid from the payment events, which is
 * right, and had no word for the arithmetic landing BELOW zero. There are two
 * ways to get there. Take ₹100, refund ₹40, then reverse the ₹100 because the
 * card never settled: the refund stands, the payment does not, and the clinic
 * is ₹40 down on a bill nobody ever paid. Or it is simply already true in the
 * history being carried across and nobody knows why.
 *
 * Either way it is not `unpaid`. `unpaid` is a bill printed five minutes ago
 * and not yet taken to the counter, and putting this in the same queue is how
 * it gets ignored for a year. So it has its own word, `over_refunded`, a queue
 * of its own, and — the part this file spends most of its length on — a set of
 * refusals that leave the ledger exactly as they found it.
 *
 * Everything is built through the real commands, with one exception that is
 * commented where it happens: the over-refunded bill that arrives from history
 * cannot be created by the commands any more, because the command that used to
 * create it now refuses. A state the code refuses to produce still has to be
 * readable, and that is precisely what the migration exists for.
 *
 * See docs/OWNER_POLICY_REGISTER.md items 49–52, and the migration
 * supabase/migrations/20260915000000_financial_edge_states.sql.
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
    assert.equal(review.over_refunded_by, '40.00')
    assert.equal(review.paid, '-40.00')
    assert.equal(Number(review.receipts_in), 0, 'the payment was reversed, so nothing came in')
    assert.equal(Number(review.receipts_out), 1)
    assert.equal(Number(review.receipts_reversed), 1)
    assert.match(review.documents, new RegExp(`${carried.paymentReceipt} payment 100\\.00 \\(reversed\\)`))
    assert.match(review.documents, new RegExp(`${carried.refundReceipt} refund 40\\.00`))
  })

  test('a voided bill that is over-refunded still says over_refunded', async () => {
    const staff = await clinic()
    const carried = await carriedOverOverRefund(staff)

    /*
     * Voiding is refused below zero (the next describe block), so this too can
     * only arrive from history — a bill voided years ago with money still out
     * against it. `over_refunded` is tested ahead of `void` in the view for
     * exactly this row: letting `void` win would file the exception under
     * "closed" and it would never be seen again.
     */
    await rows(
      `update jmc.invoices
          set status='void', void_reason='Carried over: voided before the correction',
              voided_by=$1, voided_at=now()
        where id=$2`,
      [staff.admin.id, carried.invoiceId],
    )

    const bill = await balance(carried.invoiceId)
    assert.equal(bill.status, 'void')
    assert.equal(bill.payment_state, 'over_refunded', 'the void does not get to hide it')
    assert.ok(await reviewRow(carried.invoiceId), 'and it stays on the review queue')

    // The money columns exclude voided bills as they always did; the COUNT
    // does not, because money that left the drawer did not stop leaving it.
    const person = await patientRow(carried.patientId)
    assert.equal(person.outstanding, '0.00')
    assert.equal(Number(person.over_refunded_invoices), 1)
    assert.equal(person.over_refunded_amount, '40.00')
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
    assert.equal(queue.length, 1, 'one row per over-refunded bill')
    assert.equal(queue[0].invoice_number, 'INV-000001')
    assert.equal(queue[0].patient, 'Edge Case')
    assert.equal(queue[0].paid, '-40.00')
    assert.equal(queue[0].over_refunded_by, '40.00', 'as a magnitude, for a person to read')
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
