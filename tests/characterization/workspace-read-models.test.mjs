/**
 * The reads a workspace opens with, held to what they claim.
 *
 * ── THE ONE PROPERTY THAT MATTERS MOST ─────────────────────────────────────
 *
 * Every count reconciles with the list behind it. That is the acceptance
 * criterion the backend programme names for this slice, and it is not a
 * property of careful coding — it is a property of the count and the list
 * being one SELECT. So the tests below do not check a number against a number
 * somebody typed; they open every count the role holds and assert the list
 * that comes back is the same size. If the two were ever computed separately,
 * this is the file that would say so.
 *
 * ── AND THE ONES THAT ARE ABOUT TELLING THE TRUTH ──────────────────────────
 *
 * A count must be actionable. A prescription whose validity has run out is not
 * on the counter's list, because the pharmacist cannot supply it — and it is
 * on the patient's obligations, because somebody still has to do something
 * about it. A bill under financial review is not "money due", because policy
 * register 55 says filing those two together is how one comes to be ignored.
 * Each of those is asserted below, in both directions: present where it should
 * be, absent where it should not.
 *
 * Duplicate names, a patient with no visit, a reading nobody took, a clinic
 * with nothing in it at all — the awkward cases are the ones a read model is
 * actually used on.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { edgeGet } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** One person holding every role, so a test can read every view. */
async function clinic() {
  await resetClinic()
  const all = await makeStaff({
    name: 'Owner', roles: ['admin', 'doctor', 'nurse', 'pharmacy'], username: 'owner', pin: '5731',
  })
  all.token = await tokenFor(all)
  return all
}

const read = (staff, path) => edgeGet('workspace', `?view=${path}`, staff.token)

async function patient(staff, name, phone, age = 40) {
  await as(staff, 'create_patient', { name, age, sex: 'male', phone })
  return String(await scalar('select id from jmc.patients where name=$1 order by created_at desc limit 1', [name]))
}

async function stockedMedicine(staff, code = 'PARA500', quantity = '0') {
  await as(staff, 'add_medicine', {
    code, name: `Paracetamol ${code}`, unit: 'tablet', saleClass: 'otc',
    reorderLevel: '10', targetStock: '100', initialQuantity: quantity,
    ...(quantity === '0' ? {} : {
      batchNumber: `B-${code}`, expiry: '2027-12-31',
      mrp: '2', purchasePrice: '1', sellingPrice: '2',
    }),
  })
  return String(await scalar('select id from jmc.medicines where code=$1', [code]))
}

describe('finding a patient', () => {
  test('by name, by phone, by token and by id', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Murugan Selvaraj', '+91 98765 43210')
    await as(staff, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const token = String(await scalar('select token from jmc.appointments limit 1'))

    const byName = await read(staff, 'patients&q=murugan')
    assert.equal(byName.body.patients[0].patientId, patientId)
    assert.equal(byName.body.patients[0].matchedOn, 'name')

    // The same telephone, written the way somebody would type it in a hurry.
    const byPhone = await read(staff, 'patients&q=9876543210')
    assert.equal(byPhone.body.patients[0].patientId, patientId)
    assert.equal(byPhone.body.patients[0].matchedOn, 'phone')

    const byToken = await read(staff, `patients&q=${encodeURIComponent(token)}`)
    assert.equal(byToken.body.patients[0].patientId, patientId)
    assert.equal(byToken.body.patients[0].matchedOn, 'token')
    assert.equal(byToken.body.patients[0].token, token)

    const byId = await read(staff, `patients&q=${patientId}`)
    assert.equal(byId.body.patients[0].patientId, patientId)
    assert.equal(byId.body.patients[0].matchedOn, 'id')
  })

  /*
   * The same telephone, written the four ways it is actually written.
   *
   * The index and the predicate both compare the LAST TEN digits, so the query
   * has to be cut the same way. It was not: everything typed was reduced to
   * digits and compared whole, so a number written the way it appears on a
   * card — +91 98765 43210, twelve digits — matched the ten-digit expression
   * nowhere and fell through to a name scan that found nobody. The contract
   * claims "any formatting", and a claim like that is either true of every
   * form or it is a list of the forms somebody happened to test.
   */
  test('a phone is found however it was written, country code and all', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Murugan Selvaraj', '+91 98765 43210')

    for (const typed of ['9876543210', '+919876543210', '+91 98765 43210', '098765 43210']) {
      const { body } = await read(staff, `patients&q=${encodeURIComponent(typed)}`)
      assert.equal(body.patients[0]?.patientId, patientId, `typed as ${typed}`)
      assert.equal(body.patients[0].matchedOn, 'phone')
    }
  })

  test('a token is found in whatever case it was typed', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Token Case', '+919000000123')
    await as(staff, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const token = String(await scalar('select token from jmc.appointments limit 1'))

    for (const typed of [token, token.toLowerCase(), ` ${token.toLowerCase()} `]) {
      const { body } = await read(staff, `patients&q=${encodeURIComponent(typed)}`)
      assert.equal(body.patients[0]?.patientId, patientId, `typed as "${typed}"`)
      assert.equal(body.patients[0].matchedOn, 'token')
    }
  })

  test('a surname in the middle of a name is still found', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Anitha Rajendran', '+919000000002')
    const found = await read(staff, 'patients&q=rajendran')
    assert.equal(found.body.patients[0].patientId, patientId)
  })

  test('two patients of the same name come back separately, told apart by the phone', async () => {
    const staff = await clinic()
    const elder = await patient(staff, 'Kumar', '+919000000011', 61)
    const child = await patient(staff, 'Kumar', '+919000000022', 4)

    const { body } = await read(staff, 'patients&q=kumar')
    assert.equal(body.patients.length, 2)
    const ids = body.patients.map((hit) => hit.patientId).sort()
    assert.deepEqual(ids, [elder, child].sort())
    assert.notEqual(body.patients[0].phoneEnding, body.patients[1].phoneEnding,
      'four digits is what tells a 61-year-old Kumar from a 4-year-old one')
    assert.deepEqual(body.patients.map((hit) => hit.age).sort(), [4, 61])
  })

  test('an exact phone outranks a name that merely contains the query', async () => {
    const staff = await clinic()
    await patient(staff, 'Nine Eight Seven', '+919000000033')
    const target = await patient(staff, 'Someone', '+919876543210')

    const { body } = await read(staff, 'patients&q=9876543210')
    assert.equal(body.patients[0].patientId, target)
  })

  test('a name in another script is matched as typed', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'முருகன் செல்வராஜ்', '+919000000044')
    const { body } = await read(staff, `patients&q=${encodeURIComponent('முருகன்')}`)
    assert.equal(body.patients[0].patientId, patientId)
  })

  test('a very long name survives the round trip whole', async () => {
    const staff = await clinic()
    const long = 'Venkataraman Subrahmanya Krishnamoorthy Iyer'
    const patientId = await patient(staff, long, '+919000000055')
    const { body } = await read(staff, 'patients&q=venkataraman')
    assert.equal(body.patients[0].patientId, patientId)
    assert.equal(body.patients[0].name, long)
  })

  test('one letter finds nobody, rather than everybody', async () => {
    const staff = await clinic()
    await patient(staff, 'Anitha', '+919000000066')
    const { body } = await read(staff, 'patients&q=a')
    assert.deepEqual(body.patients, [], 'a search that matches the register is not a search')
  })

  test('a name nobody has finds nobody, and says so calmly', async () => {
    const staff = await clinic()
    await patient(staff, 'Anitha', '+919000000077')
    const { status, body } = await read(staff, 'patients&q=zzzzzz')
    assert.equal(status, 200)
    assert.deepEqual(body.patients, [])
  })

  test('the result set is capped', async () => {
    const staff = await clinic()
    for (let index = 0; index < 30; index += 1) {
      await patient(staff, `Common Name ${index}`, `+9190000${String(index).padStart(5, '0')}`)
    }
    const { body } = await read(staff, 'patients&q=common')
    assert.equal(body.patients.length, 25, 'the whole register never comes back in one answer')
  })
})

/**
 * LIKE's own vocabulary, typed by a person into a search box.
 *
 * `%`, `_` and `\` mean something to LIKE and nothing to the person typing
 * them. Left unescaped the first is a way to page through the whole register
 * without knowing a name, the second silently widens an exact-looking prefix,
 * and the third makes the pattern malformed. A search box takes whatever it is
 * given, so all three are ordinary input here rather than an attack.
 */
describe('a search is a name and never a pattern', () => {
  async function register(staff) {
    await patient(staff, 'Abu Bakr', '+919000000001')
    await patient(staff, 'Abi Chandran', '+919000000002')
    await patient(staff, 'Zahir Khan', '+919000000003')
    return staff
  }

  test('a per cent sign matches nobody rather than everybody', async () => {
    const staff = await register(await clinic())
    const { body } = await read(staff, 'patients&q=%25')
    assert.deepEqual(body.patients, [],
      'one character must not enumerate the register the cap happens to truncate')
  })

  test('two per cent signs are no better', async () => {
    const staff = await register(await clinic())
    const { body } = await read(staff, 'patients&q=%25%25')
    assert.deepEqual(body.patients, [])
  })

  test('a per cent sign inside a real prefix does not widen it', async () => {
    const staff = await register(await clinic())
    const { body } = await read(staff, 'patients&q=Ab%25')
    assert.deepEqual(body.patients, [],
      'nobody is called "Ab%", so nobody comes back — Abu and Abi are not a match for it')
  })

  test('an underscore is a character somebody typed, not a single-character wildcard', async () => {
    const staff = await register(await clinic())
    const { body } = await read(staff, 'patients&q=Ab_')
    assert.deepEqual(body.patients, [],
      'unescaped, `Ab_` reports Abu and Abi as exact prefix matches, which is a lie about both')
  })

  test('two underscores are no better', async () => {
    const staff = await register(await clinic())
    const { body } = await read(staff, 'patients&q=A__')
    assert.deepEqual(body.patients, [])
  })

  test('a backslash is a character and not a malformed pattern', async () => {
    const staff = await register(await clinic())
    // Unescaped this is a trailing escape character, which Postgres rejects
    // outright — the endpoint would answer 500 rather than "nobody".
    const { status, body } = await read(staff, 'patients&q=Ab%5C')
    assert.equal(status, 200)
    assert.deepEqual(body.patients, [])
  })

  test('a patient actually named with one of them is found by typing it', async () => {
    const staff = await clinic()
    await patient(staff, 'R_D Kumar', '+919000000004')
    await patient(staff, 'Radha Kumar', '+919000000005')

    const { body } = await read(staff, 'patients&q=R_D')
    assert.equal(body.patients.length, 1, 'the underscore is matched literally, so Radha is not a match')
    assert.equal(body.patients[0].name, 'R_D Kumar')
  })
})

/**
 * One person, one line.
 *
 * The branches are a UNION ALL and a patient can satisfy more than one of
 * them, so without a de-duplication the same person appears twice in a list
 * whose entire job is to tell two people apart.
 */
describe('a patient appears once, under their best match', () => {
  test('matching by both id and name gives one row, ranked by the stronger', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Kumar Raj', '+919000000006')

    // The patient's own id, which is also a prefix of nothing else. Both the
    // `id` branch (rank 2) and the `name` branch would have to be checked, so
    // to make the collision certain, search by the id itself and then by a
    // name prefix that also matches, in one query each.
    const byId = await read(staff, `patients&q=${patientId}`)
    assert.equal(byId.body.patients.length, 1)
    assert.equal(byId.body.patients[0].matchedOn, 'id')

    // Now the case that used to duplicate: an exact phone AND a name prefix.
    const byBoth = await patient(staff, '9000000007', '+919000000007')
    assert.ok(byBoth)
    const { body } = await read(staff, 'patients&q=9000000007')
    assert.equal(body.patients.length, 1,
      'the phone branch and the name branch both matched this person; they are one person')
    assert.equal(body.patients[0].matchedOn, 'phone',
      'and the row kept is the strongest evidence, not whichever branch ran first')
  })

  test('a patient in the queue matching by name and token is still one row', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Token Patient', '+919000000008')
    await as(staff, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const token = String(await scalar('select token from jmc.appointments limit 1'))

    const { body } = await read(staff, `patients&q=${encodeURIComponent(token)}`)
    const mine = body.patients.filter((hit) => hit.patientId === patientId)
    assert.equal(mine.length, 1)
    assert.equal(mine[0].token, token, 'and the arrival travels with the row')
  })
})

describe('the patient band', () => {
  test('a patient with nothing recorded reports absence rather than guessing', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Fresh Arrival', '+919000000088')

    const { body } = await read(staff, `patient&patientId=${patientId}`)
    assert.equal(body.context.arrival, null, 'no visit open is null, not an invented one')
    assert.equal(body.context.vitals, null)
    assert.equal(body.context.clinicalAlerts.allergyStatus, 'not_recorded',
      'nobody has asked is not the same as no known allergy')
    assert.equal(body.context.money.outstanding, '0.00')
    assert.equal(body.context.supply.prescriptionsWaiting, 0)
  })

  test('a reading nobody took is absent, and a reading of zero would not be', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Partly Measured', '+919000000099')
    await as(staff, 'add_vitals', {
      patientId, pulse: 78, bp: '', temperature: '', spo2: '', weight: '',
      notMeasuredNote: 'Cuff was in use',
    })

    const { body } = await read(staff, `patient&patientId=${patientId}`)
    assert.equal(body.context.vitals.pulse, 78)
    assert.equal(Object.hasOwn(body.context.vitals, 'bp'), false,
      'not measured is absence; a zero would be a reading')
    assert.equal(body.context.vitals.notMeasuredNote, 'Cuff was in use')
  })

  test('a patient who does not exist is a 404 and not an empty band', async () => {
    const staff = await clinic()
    const { status } = await read(staff, `patient&patientId=${randomUUID()}`)
    assert.equal(status, 404)
  })
})

describe('every count reconciles with the list behind it', () => {
  test('in a clinic with nothing in it', async () => {
    const staff = await clinic()
    const { body } = await read(staff, 'workload')
    assert.ok(body.counts.length > 0, 'the lists exist even when they are empty')
    for (const count of body.counts) {
      assert.equal(count.count, 0, `${count.id} should be empty`)
      const drill = await read(staff, `list&list=${count.id}`)
      assert.equal(drill.body.list.count, 0)
      assert.deepEqual(drill.body.list.rows, [])
    }
  })

  test('in a clinic with a queue, a prescription, a bill and a follow-up', async () => {
    const staff = await clinic()
    const medicineId = await stockedMedicine(staff)
    const first = await patient(staff, 'Queued One', '+919100000001')
    const second = await patient(staff, 'Queued Two', '+919100000002')
    for (const id of [first, second]) {
      await as(staff, 'create_appointment', { patientId: id, reason: 'Fever', scheduledAt: new Date().toISOString() })
    }
    const appointmentId = String(await scalar(
      'select id from jmc.appointments where patient_id=$1', [first]))
    await as(staff, 'sign_consultation', {
      patientId: first, appointmentId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      followUpDate: new Date().toISOString().slice(0, 10), followUpNote: 'Review',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    })

    const { body } = await read(staff, 'workload')
    for (const count of body.counts) {
      const drill = await read(staff, `list&list=${count.id}`)
      assert.equal(drill.body.list.count, count.count,
        `${count.id}: the badge says ${count.count} and the list says ${drill.body.list.count}`)
      assert.equal(drill.body.list.rows.length, Math.min(count.count, 200))
    }

    const named = Object.fromEntries(body.counts.map((count) => [count.id, count.count]))
    assert.equal(named['list.today_queue'], 1, 'the signed visit left the queue; the other did not')
    assert.equal(named['list.vitals_missing'], 1, 'nobody took a reading for the one still waiting')
    assert.equal(named['list.counter_waiting'], 1, 'one prescription with something to supply')
    assert.equal(named['list.payments_due'], 1, 'and one bill carrying the consultation fee')
    assert.equal(named['list.follow_ups_due'], 1)
  })

  test('a count is the true size even when the list is capped', async () => {
    const staff = await clinic()
    for (let index = 0; index < 205; index += 1) {
      const id = await patient(staff, `Waiting ${index}`, `+9192${String(index).padStart(8, '0')}`)
      await as(staff, 'create_appointment', { patientId: id, reason: 'Fever', scheduledAt: new Date().toISOString() })
    }
    const drill = await read(staff, 'list&list=list.today_queue')
    assert.equal(drill.body.list.count, 205, 'the count is exact')
    assert.equal(drill.body.list.rows.length, 200, 'and the rows are capped')
    assert.equal(drill.body.list.truncated, true, 'and the screen is told that they were')
  })
})

describe('a count only carries what somebody can act on', () => {
  test('a prescription past its validity leaves the counter and becomes an obligation', async () => {
    const staff = await clinic()
    const medicineId = await stockedMedicine(staff)
    const patientId = await patient(staff, 'Left It Late', '+919300000001')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    })

    const before = await read(staff, 'list&list=list.counter_waiting')
    assert.equal(before.body.list.count, 1)

    // Age the prescription past its validity. Policy register 18: the
    // remainder then needs a new or amended order from the doctor.
    await rows(`update jmc.prescriptions set valid_until = (now() at time zone 'Asia/Kolkata')::date - 1`)

    const after = await read(staff, 'list&list=list.counter_waiting')
    assert.equal(after.body.list.count, 0,
      'the pharmacist cannot supply it, so it is not on the pharmacist’s list')

    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    const counter = body.obligations.find((item) => item.kind === 'counter')
    assert.ok(counter, 'but it has not vanished — somebody still has to do something')
    assert.equal(counter.severity, 'blocked')
    assert.equal(counter.owner, 'doctor', 'and it names who')
  })

  test('a bill under financial review is not filed as money due', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Over Refunded', '+919300000002')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    const invoiceId = String(await scalar('select id from jmc.invoices where patient_id=$1', [patientId]))

    await as(staff, 'take_payment', {
      invoiceId, idempotencyKey: randomUUID(), parts: [{ method: 'cash', amount: '300' }],
    })
    await as(staff, 'refund_payment', {
      invoiceId, idempotencyKey: randomUUID(), reason: 'Refunded against the wrong bill',
      refund: [{ method: 'cash', amount: '100' }],
    })

    /*
     * The third step is written straight at the table, exactly as
     * `financial-edge-states.test.mjs` does and for the same reason: reversing
     * the payment that leaves a bill below zero is REFUSED going forward
     * (policy register 60), so the state cannot be built through the commands
     * — and it is nevertheless in the history this clinic is carrying across.
     * A state that can only be read is still a state that has to be read
     * correctly, and filed correctly, which is what this test is about.
     */
    await rows(
      `update jmc.payments set status='reversed', reversed_by=$1, reversed_at=now(),
              reversal_reason='Carried over: the card never settled'
        where kind='payment'`, [staff.id])

    const state = String(await scalar(
      'select payment_state from jmc.invoice_balances where id=$1', [invoiceId]))
    assert.equal(state, 'over_refunded', 'a hundred rupees went out that never came in')

    const { body } = await read(staff, 'workload')
    const named = Object.fromEntries(body.counts.map((count) => [count.id, count.count]))
    assert.equal(named['list.payments_due'], 0,
      'policy register 55 — this is not an unpaid bill, and filing it as one is how it gets ignored')
    assert.equal(named['list.financial_review'], 1, 'it is its own state, with its own queue')

    const review = await read(staff, 'list&list=list.financial_review')
    assert.equal(review.body.list.rows[0].review_state, 'over_refunded')
    assert.equal(review.body.list.owner, 'admin', 'and the accountant’s decision, not the counter’s')
  })

  test('a bill that is merely refunded back to zero IS money due again', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Refunded To Zero', '+919300000003')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    const invoiceId = String(await scalar('select id from jmc.invoices where patient_id=$1', [patientId]))
    await as(staff, 'take_payment', {
      invoiceId, idempotencyKey: randomUUID(), parts: [{ method: 'cash', amount: '300' }],
    })
    await as(staff, 'refund_payment', {
      invoiceId, idempotencyKey: randomUUID(), reason: 'Wrong patient',
      refund: [{ method: 'cash', amount: '300' }],
    })

    const { body } = await read(staff, 'workload')
    const named = Object.fromEntries(body.counts.map((count) => [count.id, count.count]))
    assert.equal(named['list.payments_due'], 1,
      'the money went back, so the patient owes it again — that is an ordinary unpaid bill')
    assert.equal(named['list.financial_review'], 0, 'and nothing is out of balance')
  })
})

describe('where a visit has reached', () => {
  test('the stages move as the visit does', async () => {
    const staff = await clinic()
    const medicineId = await stockedMedicine(staff)
    const patientId = await patient(staff, 'Whole Journey', '+919400000001')

    const stageOf = async (name) => {
      const { body } = await read(staff, `progress&patientId=${patientId}`)
      return body.stages.find((stage) => stage.stage === name)
    }

    assert.equal((await stageOf('arrival')).state, 'not_started')
    assert.equal((await stageOf('counter')).state, 'not_applicable', 'nothing prescribed yet')

    await as(staff, 'create_appointment', { patientId, reason: 'Fever', scheduledAt: new Date().toISOString() })
    assert.equal((await stageOf('arrival')).state, 'in_progress')
    assert.equal((await stageOf('vitals')).state, 'not_started')

    await as(staff, 'add_vitals', { patientId, pulse: 80, bp: '120/80', temperature: '', spo2: '', weight: '' })
    assert.equal((await stageOf('vitals')).state, 'done')

    const appointmentId = String(await scalar('select id from jmc.appointments where patient_id=$1', [patientId]))
    await as(staff, 'sign_consultation', {
      patientId, appointmentId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    })
    assert.equal((await stageOf('consult')).state, 'done')

    const counter = await stageOf('counter')
    assert.equal(counter.state, 'in_progress')
    assert.equal(counter.owner, 'pharmacy')
    assert.match(counter.nextAction, /counter/i)

    const payment = await stageOf('payment')
    assert.equal(payment.state, 'in_progress')
    assert.match(payment.detail, /300/)
  })

  test('an unsigned draft is an obligation the doctor still owns', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Half Written', '+919400000002')
    await as(staff, 'save_consultation_draft', {
      patientId, complaint: 'Cough', diagnosis: 'Bronchitis', notes: '', advice: '',
    })

    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    const draft = body.obligations.find((item) => item.kind === 'unsigned_draft')
    assert.ok(draft)
    assert.equal(draft.owner, 'doctor')
    assert.match(draft.detail, /not signed/)
  })

  test('a follow-up that is due reads as due, and becomes an obligation', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Overdue Review', '+919400000005')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      followUpDate: await clinicDate(0), followUpNote: 'Review today',
    })

    /*
     * `follow_ups.due_date` is a `date`, and the driver hands a date back as a
     * JavaScript Date — so comparing it as a string compares "Mon Sep 14 2026…"
     * against "2026-09-14", and the weekday initial sorts above the century
     * digit. The comparison was false for every follow-up that has ever
     * existed, so an overdue reminder read as not started and never reached
     * the obligations list. Comparing in SQL, against the CLINIC's day, is what
     * this holds.
     */
    const { body } = await read(staff, `progress&patientId=${patientId}`)
    const stage = body.stages.find((item) => item.stage === 'follow_up')
    assert.equal(stage.state, 'in_progress', 'due today is due')
    assert.match(stage.detail, /^Due \d{4}-\d{2}-\d{2}$/,
      'and the date reads as a date, not as a weekday')

    const obligations = await read(staff, `obligations&patientId=${patientId}`)
    assert.ok(obligations.body.obligations.some((item) => item.kind === 'follow_up'))
  })

  test('a follow-up that is not due yet is not an obligation', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Later Review', '+919400000006')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      followUpDate: await clinicDate(30), followUpNote: 'Review next month',
    })

    const { body } = await read(staff, `progress&patientId=${patientId}`)
    assert.equal(body.stages.find((item) => item.stage === 'follow_up').state, 'not_started')
    const obligations = await read(staff, `obligations&patientId=${patientId}`)
    assert.equal(obligations.body.obligations.find((item) => item.kind === 'follow_up'), undefined)
  })

  test('a patient with nothing outstanding has no obligations at all', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Nothing Owing', '+919400000003')
    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    assert.deepEqual(body.obligations, [])
  })

  test('merely waiting is not an obligation', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Just Arrived', '+919400000004')
    await as(staff, 'create_appointment', { patientId, reason: 'Fever', scheduledAt: new Date().toISOString() })
    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    assert.equal(body.obligations.find((item) => item.kind === 'arrival'), undefined,
      'everybody in the waiting room is waiting; that is not a thing left undone')
  })

  /*
   * Which day a visit belongs to is the day it is FOR, not the day it was
   * typed in — and the unlinked-consultation obligation was reading the wrong
   * column. The two tests below are the two halves of that mistake, and they
   * have to be separate because the old code was wrong in both directions at
   * once: it raised the obligation for appointments that are not today's, and
   * missed today's appointments that were booked earlier. Either one alone
   * would pass against a query that simply swapped the error over.
   *
   * What makes it more than a cosmetic difference is the words. The obligation
   * says a token "is still waiting in the queue" beside a consultation signed
   * today, and a doctor reading it is being asked to go and resolve those two
   * against each other. Naming a visit that is not today's sends them to look
   * for a patient who is not in the building.
   */
  test('a visit booked today FOR TOMORROW is not today’s orphaned queue row', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Coming Tomorrow', '+919400000007')

    // Booked this morning — so `created_at` is today — for tomorrow.
    await as(staff, 'create_appointment', {
      patientId, reason: 'Review', scheduledAt: `${await clinicDate(1)}T10:00:00`,
    })
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    assert.equal(
      body.obligations.find((item) => item.kind === 'unlinked_consultation'), undefined,
      'tomorrow’s appointment is nobody’s unfinished business today, and saying it '
      + 'is still waiting in the queue is simply false',
    )
  })

  test('a visit booked earlier FOR TODAY is', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Booked Last Week', '+919400000008')

    await as(staff, 'create_appointment', {
      patientId, reason: 'Review', scheduledAt: `${await clinicDate(0)}T10:00:00`,
    })
    /*
     * Backdated directly, because `create_appointment` stamps `created_at`
     * from the clock and an appointment booked last week is exactly what this
     * test needs. Nothing else about the row is touched: this is the ordinary
     * shape of a follow-up visit, and reading `created_at` made every one of
     * them invisible to this obligation.
     */
    await rows(
      `update jmc.appointments set created_at = to_char(
         (now() - interval '7 days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       where patient_id = $1`, [patientId])

    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    const unlinked = body.obligations.find((item) => item.kind === 'unlinked_consultation')
    assert.ok(unlinked, 'the patient is here today and their consultation is attached to nothing')
    assert.match(unlinked.detail, /JMC-\d+/, 'and it names the token so somebody can go and find it')
  })

  test('and a stale queue row from last week raises nothing at all', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Never Came', '+919400000009')

    await as(staff, 'create_appointment', {
      patientId, reason: 'Review', scheduledAt: `${await clinicDate(-7)}T10:00:00`,
    })
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    const { body } = await read(staff, `obligations&patientId=${patientId}`)
    assert.equal(
      body.obligations.find((item) => item.kind === 'unlinked_consultation'), undefined,
      'a row nobody cancelled last week is a real problem and it is not this one',
    )
  })
})

describe('asking what a lost reply committed', () => {
  test('a key that signed a consultation answers with it', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Lost The Answer', '+919500000001')
    const idempotencyKey = randomUUID()
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    const { body } = await read(staff, `outcome&key=${encodeURIComponent(idempotencyKey)}`)
    assert.equal(body.outcome.committed, true)
    assert.equal(body.outcome.operation, 'consultation')
    assert.ok(body.outcome.at)
  })

  test('a key that committed nothing says so, and licenses the same request again', async () => {
    const staff = await clinic()
    const { body } = await read(staff, `outcome&key=${randomUUID()}`)
    assert.equal(body.outcome.committed, false)
    assert.equal(body.outcome.operation, 'unknown')
    assert.match(body.outcome.detail, /same request may be sent again/)
  })

  test('a wildcard is not a key, and fishes nothing out', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Wildcard Target', '+919500000003')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    const invoiceId = String(await scalar('select id from jmc.invoices where patient_id=$1', [patientId]))
    await as(staff, 'take_payment', {
      invoiceId, idempotencyKey: randomUUID(),
      parts: [{ method: 'cash', amount: '100' }, { method: 'upi', amount: '200' }],
    })

    /*
     * Split payments are keyed `${key}:1`, `${key}:2`, so the lookup has to
     * match a prefix — and a prefix match means the caller's key goes into a
     * LIKE. Unescaped, `%` asked for every split payment in the clinic and the
     * first one came back: a receipt number, its status and its time, without
     * knowing any key at all.
     */
    for (const probe of ['%', '_', '%:%', 'a%']) {
      const { body } = await read(staff, `outcome&key=${encodeURIComponent(probe)}`)
      assert.equal(body.outcome.committed, false, `${probe} must find nothing`)
      assert.equal(body.outcome.reference, undefined)
    }
  })

  test('a split payment is found by the key the tablet actually holds', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Paid In Parts', '+919500000002')
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    const invoiceId = String(await scalar('select id from jmc.invoices where patient_id=$1', [patientId]))
    const paymentKey = randomUUID()
    await as(staff, 'take_payment', {
      invoiceId, idempotencyKey: paymentKey,
      parts: [{ method: 'cash', amount: '100' }, { method: 'upi', amount: '200' }],
    })

    // take_payment stores one row per part, keyed `${key}:1`, `${key}:2` — so
    // the key the tablet holds appears in none of them exactly.
    const { body } = await read(staff, `outcome&key=${encodeURIComponent(paymentKey)}`)
    assert.equal(body.outcome.committed, true)
    assert.equal(body.outcome.operation, 'payment')
    assert.match(body.outcome.reference, /^RCP-/)
  })
})

describe('what may be supplied instead', () => {
  test('a generic order offers the in-stock products that are the same clinical drug', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Needs A Swap', '+919600000001')

    await as(staff, 'save_substance', { name: 'Paracetamol' })
    const substanceId = String(await scalar('select id from jmc.substances limit 1'))
    await as(staff, 'save_clinical_drug', {
      displayName: 'Paracetamol 500 mg tablet', dosageForm: 'tablet', route: 'oral',
      ingredients: [{ substanceId, strengthValue: '500', strengthUnit: 'mg' }],
    })
    const clinicalDrugId = String(await scalar('select id from jmc.clinical_drugs limit 1'))

    // Stock on the alternative only. A candidate with nothing on the shelf is
    // not a candidate, and the prescribed product deliberately has none.
    const prescribed = await stockedMedicine(staff, 'PARAGEN')
    const alternative = await stockedMedicine(staff, 'PARABRAND', '50')
    for (const id of [prescribed, alternative]) {
      await as(staff, 'link_medicine_identity', { medicineId: id, clinicalDrugId })
    }

    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      prescriptionItems: [{
        medicineId: prescribed, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    })
    const lineId = String(await scalar('select id from jmc.prescription_lines limit 1'))

    const { body } = await read(staff, `equivalents&lineId=${lineId}`)
    assert.equal(body.equivalents.eligible, true)
    assert.deepEqual(body.equivalents.candidates.map((item) => item.medicineId), [alternative],
      'the prescribed product is not offered as a substitute for itself')
    assert.ok(body.equivalents.constraints.some((line) => /reason must be recorded/i.test(line)))
    assert.ok(body.equivalents.constraints.some((line) => /signed prescription is unchanged/i.test(line)))
  })

  test('a product with no clinical drug behind it offers nothing, and says why', async () => {
    const staff = await clinic()
    const patientId = await patient(staff, 'Unlinked', '+919600000002')
    const medicineId = await stockedMedicine(staff)
    await as(staff, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    })
    const lineId = String(await scalar('select id from jmc.prescription_lines limit 1'))

    const { body } = await read(staff, `equivalents&lineId=${lineId}`)
    assert.equal(body.equivalents.eligible, false)
    assert.match(body.equivalents.reason, /not linked to a clinical drug/)
  })

  test('a line that does not exist is a 404', async () => {
    const staff = await clinic()
    const { status } = await read(staff, `equivalents&lineId=${randomUUID()}`)
    assert.equal(status, 404)
  })
})
