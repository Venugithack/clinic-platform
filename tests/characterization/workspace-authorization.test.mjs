/**
 * Every role, against every new endpoint, out of one table.
 *
 * ── WHY THIS FILE IS WRITTEN THE WAY IT IS ─────────────────────────────────
 *
 * The tempting way to test authorization is to write out the matrix a second
 * time and assert the code agrees with it. That proves the two lists agree and
 * nothing else, and it goes stale the moment somebody adds a capability to one
 * of them — which is exactly the failure the four independent role mechanisms
 * in this backend already demonstrate, where a capability added to
 * `requireRole` and forgotten in `snapshot.ts` fails silently in the direction
 * that shows a screen data it should not have.
 *
 * So this walks `_shared/capabilities.ts` itself. Every entry in that table is
 * tried by all four roles, the ones it names must be admitted and the ones it
 * does not must be refused, and a capability added tomorrow is covered the day
 * it is added rather than the day somebody remembers. What the table cannot
 * check about itself — that it lists every view the endpoint routes and every
 * work list the module defines, with nothing extra and nothing missing — is
 * checked here too, because a capability nobody routes and a route nobody
 * declares are the two ways this arrangement could quietly stop meaning
 * anything.
 *
 * ── AND THE PART THAT IS NOT A MATRIX ──────────────────────────────────────
 *
 * Field-level minimization. A role admitted to the patient context does not
 * thereby see all of it, and until this slice nothing in the repository
 * asserted that a specific field was withheld from a specific role — the
 * nearest existing test proves a nurse's snapshot arrays come back empty,
 * which is whole-collection and not field-level. The section assertions below
 * are that template.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { edgeFunction, edgeGet } from '../support/backend.mjs'
import {
  as, clinicToday, closeClinic, makeStaff, resetClinic, scalar, tokenFor,
} from '../support/clinic.mjs'
import {
  CAPABILITIES, PATIENT_CONTEXT_SECTIONS,
} from '../../supabase/functions/_shared/capabilities.ts'
import { WORK_LIST_IDS } from '../../supabase/functions/_shared/workspace.ts'

after(async () => { await closeClinic() })

const ROLES = ['admin', 'doctor', 'nurse', 'pharmacy']

/** The view each capability is reached through, and a request that reaches it. */
const REACHED_BY = {
  'view.patient_search': () => 'patients&q=walk',
  'view.patient_context': (ids) => `patient&patientId=${ids.patientId}`,
  'view.workload': () => 'workload',
  'view.visit_progress': (ids) => `progress&patientId=${ids.patientId}`,
  'view.safe_exit': (ids) => `obligations&patientId=${ids.patientId}`,
  'view.outcome': () => 'outcome&key=nothing-committed-this',
  'view.eligible_equivalents': (ids) => `equivalents&lineId=${ids.prescriptionLineId}`,
  // Slice 2.
  'view.appointment_calendar': (ids) => `calendar&from=${ids.today}`,
  'view.patient_appointments': (ids) => `appointments&patientId=${ids.patientId}`,
  'view.consultation_reconciliation': (ids) =>
    `reconciliation&key=nothing-committed-this&patientId=${ids.patientId}`,
  // The appointment station's recovery read. A key nobody sent answers
  // `not_committed` to a role that holds it and 403 to one that does not.
  'view.appointment_outcome': () => 'appointment_outcome&key=nothing-committed-this',
  // Slice 3A. `communication_outcome` names a message that does not exist, so
  // a role that holds it gets a 404 and one that does not still gets a 403 —
  // which is the distinction this matrix is for.
  'view.communication_due': () => 'communication_due',
  'view.communication_failures': () => 'communication_failures',
  'view.communication_consent': (ids) => `communication_consent&patientId=${ids.patientId}`,
  'view.communication_outcome': () => 'communication_outcome&outboxId=no-such-message',
  /*
   * Slice 4. The two patient-shaped reads name a record that does not exist,
   * for the same reason `communication_outcome` does: a role that holds the
   * capability gets a 404 and one that does not still gets a 403, which is
   * the distinction this matrix is for.
   *
   * It matters more here than there. Owner item 86 puts a SECOND gate behind
   * these two — `mayAccessResults`, which refuses a nurse who is not involved
   * in that patient's care and withholds the clinical half from an
   * administrator — and a real identifier would make this matrix fail on that
   * second gate while saying nothing about the first. That gate has its own
   * tests, per patient and per field, in `slice4-diagnostics.test.mjs`.
   */
  'view.result_review_queue': () => 'result_review_queue',
  'view.result_escalations': () => 'result_escalations',
  'view.investigation_order': () => 'investigation_order&orderId=no-such-request',
  'view.patient_investigations': () => 'patient_investigations&patientId=no-such-patient',
}

const staff = {}
const ids = {}

before(async () => {
  await resetClinic()
  for (const role of ROLES) {
    staff[role] = await makeStaff({
      name: `The ${role}`, roles: [role], username: role, pin: '5731',
    })
    staff[role].token = await tokenFor(staff[role])
  }

  await as(staff.doctor, 'create_patient', { name: 'Walk In', age: 40, sex: 'male', phone: '+919990000001' })
  ids.patientId = String(await scalar('select id from jmc.patients where name=$1', ['Walk In']))

  await as(staff.pharmacy, 'add_medicine', {
    code: 'PARA500', name: 'Paracetamol 500', unit: 'tablet', saleClass: 'otc',
    reorderLevel: '10', targetStock: '100', initialQuantity: '0',
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='PARA500'`))

  await as(staff.doctor, 'sign_consultation', {
    patientId: ids.patientId, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    prescriptionItems: [{
      medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
      timing: 'after_food', quantity: 10, instructions: '',
    }],
  })
  ids.prescriptionLineId = String(await scalar('select id from jmc.prescription_lines limit 1'))
  ids.today = await clinicToday()
})

const read = (role, path) => edgeGet('workspace', `?view=${path}`, staff[role].token)

describe('the capability table and the endpoint describe the same surface', () => {
  test('every view capability is reachable, and every reachable view is declared', () => {
    const declared = Object.keys(CAPABILITIES).filter((id) => id.startsWith('view.')).sort()
    assert.deepEqual(Object.keys(REACHED_BY).sort(), declared,
      'a capability nobody routes, or a route nobody declares, is how this stops meaning anything')
  })

  test('every work list declares a capability, and every list capability is a list', () => {
    const declared = Object.keys(CAPABILITIES).filter((id) => id.startsWith('list.')).sort()
    assert.deepEqual([...WORK_LIST_IDS].sort(), declared)
  })

  test('no capability names a role that does not exist', () => {
    for (const [id, capability] of Object.entries(CAPABILITIES)) {
      for (const role of capability.roles) {
        assert.ok(ROLES.includes(role), `${id} names ${role}`)
      }
      assert.ok(capability.roles.length > 0, `${id} admits nobody at all`)
      assert.ok(capability.mirrors.length > 0, `${id} does not say which gate it was copied from`)
    }
  })

  test('an undeclared view is refused rather than guessed at', async () => {
    const response = await read('admin', 'something_else')
    assert.equal(response.status, 400)
    assert.match(response.body.message, /Unknown workspace view/)
  })

  test('a word inherited from Object.prototype is not a view', async () => {
    // `?view=constructor` is a string somebody can type, and a lookup checked
    // with `in` or with bare truthiness lets it past — after which the code is
    // working with a capability id that names a function. Refused as unknown,
    // like any other word nobody declared.
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const response = await read('admin', word)
      assert.equal(response.status, 400, `?view=${word} must be refused, not crash`)
      assert.match(response.body.message, /Unknown workspace view/)
    }
  })

  test('and is not a work list either', async () => {
    for (const word of ['constructor', 'toString', '__proto__']) {
      const response = await read('admin', `list&list=${word}`)
      assert.equal(response.status, 400, `?list=${word} must be refused, not crash`)
      assert.match(response.body.message, /Unknown list/)
    }
  })

  test('an unsigned-in caller is refused before any view is chosen', async () => {
    const response = await edgeGet('workspace', '?view=workload', undefined)
    assert.equal(response.status, 401)
  })
})

describe('every role against every view', () => {
  for (const [id, reach] of Object.entries(REACHED_BY)) {
    const allowed = CAPABILITIES[id].roles
    for (const role of ROLES) {
      const permitted = allowed.includes(role)
      test(`${role} is ${permitted ? 'admitted to' : 'refused'} ${id}`, async () => {
        const response = await read(role, reach(ids))
        if (permitted) {
          assert.notEqual(response.status, 403, `${role} holds ${id} and must not be refused`)
          assert.ok(response.status === 200 || response.status === 404,
            `unexpected ${response.status}: ${JSON.stringify(response.body)}`)
        } else {
          assert.equal(response.status, 403, `${role} does not hold ${id}`)
          assert.equal(response.body.ok, false)
        }
      })
    }
  }
})

describe('every role against every work list', () => {
  for (const id of WORK_LIST_IDS) {
    const allowed = CAPABILITIES[id].roles
    for (const role of ROLES) {
      const permitted = allowed.includes(role)
      test(`${role} is ${permitted ? 'admitted to' : 'refused'} ${id}`, async () => {
        const response = await read(role, `list&list=${id}`)
        if (permitted) {
          assert.equal(response.status, 200, JSON.stringify(response.body))
          assert.equal(response.body.list.id, id)
        } else {
          assert.equal(response.status, 403)
        }
      })
    }
  }

  test('the workload summary offers exactly the lists the role may open', async () => {
    for (const role of ROLES) {
      const response = await read(role, 'workload')
      assert.equal(response.status, 200)
      const offered = response.body.counts.map((count) => count.id).sort()
      const expected = WORK_LIST_IDS.filter((id) => CAPABILITIES[id].roles.includes(role)).sort()
      assert.deepEqual(offered, expected, `${role} was offered the wrong set of counts`)
    }
  })

  test('a count is never offered for a list the same role would be refused', async () => {
    for (const role of ROLES) {
      const { body } = await read(role, 'workload')
      for (const count of body.counts) {
        const drill = await read(role, `list&list=${count.id}`)
        assert.equal(drill.status, 200,
          `${role} was shown a count for ${count.id} it cannot open`)
      }
    }
  })
})

describe('field-level minimization inside the patient context', () => {
  test('each role receives exactly the sections the table gives it', async () => {
    for (const role of ROLES) {
      const { status, body } = await read(role, `patient&patientId=${ids.patientId}`)
      assert.equal(status, 200)
      const expected = Object.entries(PATIENT_CONTEXT_SECTIONS)
        .filter(([, section]) => section.roles.includes(role))
        .map(([name]) => name).sort()
      assert.deepEqual([...body.context.sections].sort(), expected, `${role} got the wrong sections`)
    }
  })

  test('a pharmacist is given the money and never the allergy or the age', async () => {
    const { body } = await read('pharmacy', `patient&patientId=${ids.patientId}`)
    assert.ok(body.context.money, 'the counter collects, so the counter is told what is owed')
    assert.equal(body.context.clinicalAlerts, undefined, 'policy register 26 and the record gate')
    assert.equal(body.context.demographics, undefined, 'the snapshot gives pharmacy no age either')
    assert.equal(body.context.vitals, undefined)
  })

  test('a doctor is given the allergy and never the balance', async () => {
    const { body } = await read('doctor', `patient&patientId=${ids.patientId}`)
    assert.ok(body.context.clinicalAlerts)
    assert.equal(body.context.money, undefined, 'policy register 17 — a doctor does not collect')
    assert.equal(body.context.supply, undefined)
  })

  test('a nurse is given the reading and neither the allergy nor the money', async () => {
    const { body } = await read('nurse', `patient&patientId=${ids.patientId}`)
    assert.ok(Object.hasOwn(body.context, 'vitals'))
    assert.ok(body.context.demographics)
    assert.equal(body.context.clinicalAlerts, undefined,
      'only the doctor reads the clinical record today; widening that is the owner’s')
    assert.equal(body.context.money, undefined, 'policy register 17 — a nurse does not touch money')
  })

  test('nobody is handed a whole telephone number in a search result', async () => {
    for (const role of ROLES) {
      const { body } = await read(role, 'patients&q=walk')
      assert.ok(body.patients.length > 0, `${role} found nobody`)
      for (const hit of body.patients) {
        assert.equal(hit.phoneEnding.length, 4)
        assert.equal(hit.phone, undefined, 'a search result is a disambiguation aid, not the register')
        assert.equal(hit.address, undefined)
        assert.equal(hit.diagnosis, undefined)
        assert.equal(hit.outstanding, undefined)
      }
    }
  })

  test('a pharmacist searching is given no age and no sex', async () => {
    const { body } = await read('pharmacy', 'patients&q=walk')
    assert.equal(body.patients[0].age, undefined)
    assert.equal(body.patients[0].sex, undefined)
  })

  test('a visit stage a role may not read says so instead of vanishing', async () => {
    const { body } = await read('doctor', `progress&patientId=${ids.patientId}`)
    const payment = body.stages.find((stage) => stage.stage === 'payment')
    assert.equal(payment.state, 'withheld',
      'the doctor learns that the counter owns the next move, and not what it is')
    assert.equal(payment.owner, 'pharmacy')
    assert.equal(payment.detail.includes('₹'), false, 'and no amount rides along in the words')
  })
})

describe('an idempotency key is only resolved for a role that could have made it', () => {
  test('a nurse is told nothing about a consultation key', async () => {
    const key = String(await scalar(
      'select idempotency_key from jmc.encounters where patient_id=$1', [ids.patientId]))
    const doctor = await read('doctor', `outcome&key=${encodeURIComponent(key)}`)
    assert.equal(doctor.body.outcome.committed, true, 'a doctor may resolve a consultation key')
    assert.equal(doctor.body.outcome.operation, 'consultation')

    const nurse = await read('nurse', `outcome&key=${encodeURIComponent(key)}`)
    assert.equal(nurse.body.outcome.committed, false,
      'a role that cannot sign a consultation cannot read one back by guessing at keys')
    assert.equal(nurse.body.outcome.operation, 'unknown')
  })

  test('and is not told, in those words, that nothing happened', async () => {
    const key = String(await scalar(
      'select idempotency_key from jmc.encounters where patient_id=$1', [ids.patientId]))
    const nurse = await read('nurse', `outcome&key=${encodeURIComponent(key)}`)

    /*
     * The consultation DID commit. "Nothing in the clinic carries this
     * reference. The same request may be sent again" would be false to this
     * caller and would license a retry on the strength of a refusal — the
     * precise failure `lib/api.ts` refuses to make anywhere else. Being gated
     * out and finding nothing are different facts and need different sentences.
     */
    assert.doesNotMatch(nurse.body.outcome.detail, /may be sent again/)
    assert.match(nurse.body.outcome.detail, /not a statement that nothing happened/i)

    const doctorOnMissing = await read('doctor', 'outcome&key=never-used-by-anything')
    assert.match(doctorOnMissing.body.outcome.detail, /may be sent again/,
      'a role that could have made one, and found none, has genuinely learned that')
  })
})

describe('the capability table still agrees with the gates it copied', () => {
  /*
   * The matrix tests above prove the CODE agrees with the table. Nothing there
   * would notice if somebody widened a `roles` list in the table itself — which
   * is exactly the failure `capabilities.ts` was written to describe. These
   * compare the table against the gates it names as its source.
   */
  test('the money and review lists match the reports that already answer them', async () => {
    // `reports/index.ts` calls `Deno.serve` at module scope, which plain Node
    // has nothing to answer with. `edgeFunction` installs the capturing stub
    // the whole database suite uses and leaves the module in the registry, so
    // the import below gets its exports rather than a TypeError.
    await edgeFunction('reports')
    const { REPORTS } = await import('../../supabase/functions/reports/index.ts')
    assert.deepEqual(
      [...CAPABILITIES['list.financial_review'].roles].sort(),
      [...REPORTS.financial_review.roles].sort(),
      'the badge and the report must not disagree about who may see a bill under review')
    assert.deepEqual(
      [...CAPABILITIES['list.follow_ups_due'].roles].sort(),
      [...REPORTS.follow_ups.roles].sort())
  })

  test('the clinical record stays doctor-only, as the record endpoint has it', async () => {
    assert.deepEqual([...PATIENT_CONTEXT_SECTIONS.clinical_alerts.roles], ['doctor'],
      'a nurse has no route to a patient’s allergy record today; widening that is the owner’s')
  })

  test('a nurse is not told that a consultation exists', async () => {
    // `encounters` is behind `clinicalRecord` in the snapshot and a draft
    // reaches a screen only through the doctor-only `record` endpoint. The
    // consult stage reads both, so a nurse gets `withheld` and not a status.
    const { body } = await read('nurse', `progress&patientId=${ids.patientId}`)
    const consult = body.stages.find((stage) => stage.stage === 'consult')
    assert.equal(consult.state, 'withheld')
    assert.equal(consult.owner, 'doctor')

    const obligations = await read('nurse', `obligations&patientId=${ids.patientId}`)
    assert.equal(obligations.body.obligations.find((item) => item.kind === 'consult'), undefined,
      'and it must not leak back through the obligations derived from the same stages')
    assert.equal(obligations.body.obligations.find((item) => item.kind === 'unsigned_draft'), undefined)
  })

  test('money stays with the roles policy register 17 names', () => {
    for (const id of ['list.payments_due', 'view.eligible_equivalents']) {
      assert.deepEqual([...CAPABILITIES[id].roles].sort(), ['admin', 'pharmacy'],
        `${id}: a doctor does not collect and a nurse does not touch money`)
    }
    assert.deepEqual([...PATIENT_CONTEXT_SECTIONS.money.roles].sort(), ['admin', 'pharmacy'])
  })
})

/**
 * Two questions that happen to have the same answer today.
 *
 * "Is this person allergic to penicillin?" and "has the doctor drafted or
 * signed a consultation for them?" are both doctor-only right now, and the
 * first version of the read models used the allergy gate for both because one
 * lookup was less code than two. The role lists were identical, the tests
 * passed, and the arrangement would have held right up until somebody granted
 * a nurse allergy access — a small, reasonable change the owner may well make —
 * and discovered afterwards that it had also handed every nurse the doctor's
 * unsigned drafts.
 *
 * `consultation_progress` is its own capability for that reason. These tests
 * hold the two apart by name, and the last one performs the widening on a copy
 * of the table to prove the two no longer move together.
 */
describe('allergy access and consultation status are different capabilities', () => {
  test('each is declared under its own name', () => {
    assert.ok(PATIENT_CONTEXT_SECTIONS.clinical_alerts, 'the allergy record')
    assert.ok(PATIENT_CONTEXT_SECTIONS.consultation_progress, 'the state of the doctor’s own work')
  })

  test('they hold the same roles today, which is why the names have to differ', () => {
    assert.deepEqual(
      [...PATIENT_CONTEXT_SECTIONS.consultation_progress.roles].sort(),
      [...PATIENT_CONTEXT_SECTIONS.clinical_alerts.roles].sort(),
      'identical lists are exactly the condition under which one is silently used for the other')
  })

  test('the consult stage and the draft obligation are gated on consultation_progress', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../supabase/functions/_shared/workspace.ts', import.meta.url), 'utf8'))

    // The consult stage withholds on it, and the unsigned-draft obligation is
    // built behind it. Neither may reach for the allergy gate.
    assert.match(source, /if \(!maySee\(session, 'consultation_progress'\)\) \{/,
      'the consult stage must withhold on its own capability')
    assert.match(source, /if \(maySee\(session, 'consultation_progress'\)\) \{/,
      'and so must the unsigned-draft obligation')

    // `clinical_alerts` may still appear — it gates the allergy section of the
    // patient context, which is what it is for — but only once.
    const allergyGates = source.match(/maySee\(session, 'clinical_alerts'\)/g) ?? []
    assert.equal(allergyGates.length, 1,
      'the allergy capability gates the allergy section, and nothing else')
  })

  test('granting a nurse allergy access would not disclose a consultation draft', async () => {
    const { maySee } = await import('../../supabase/functions/_shared/capabilities.ts')
    const nurse = { staffId: 'n', name: 'N', username: 'n', roles: ['nurse'], lastSeen: '', canPublishClinicalTemplates: false, theme: 'system' }

    assert.equal(maySee(nurse, 'clinical_alerts'), false, 'today, neither')
    assert.equal(maySee(nurse, 'consultation_progress'), false)

    /*
     * The widening, performed here rather than imagined.
     *
     * `PATIENT_CONTEXT_SECTIONS` is frozen by `as const` at the type level
     * only, so the roles array can be swapped for the length of this
     * assertion. This is what the owner deciding "a nurse may see allergies"
     * looks like in the table, and the point is what does NOT change beside it.
     */
    const original = PATIENT_CONTEXT_SECTIONS.clinical_alerts.roles
    try {
      Object.defineProperty(PATIENT_CONTEXT_SECTIONS.clinical_alerts, 'roles', {
        configurable: true, value: ['doctor', 'nurse'],
      })
      assert.equal(maySee(nurse, 'clinical_alerts'), true,
        'the widening took effect, so the next assertion is about a real state')
      assert.equal(maySee(nurse, 'consultation_progress'), false,
        'and the doctor’s drafts did not come with it, which is the whole reason for the second name')
    } finally {
      Object.defineProperty(PATIENT_CONTEXT_SECTIONS.clinical_alerts, 'roles', {
        configurable: true, value: original,
      })
    }
    assert.equal(maySee(nurse, 'clinical_alerts'), false, 'and the table is put back')
  })
})
