/**
 * The two clinical decisions the result station makes about the record.
 *
 * Both were wrong when an independent review read them, and both were wrong
 * in a way no browser journey noticed: one told a doctor a delegation had
 * landed when a different doctor's had, the other read "the corrected report
 * replaced this one" as "this result does not exist" and so never fired,
 * leaving a superseded result saying "you can do it again".
 *
 * They are pure functions over a read the server already returns, so they can
 * be walked here in milliseconds instead of through seven minutes of Chrome.
 * That is the whole reason `lib/result-decisions.ts` is its own file.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  recoveryCommitted,
  resultFollowUpOwed,
  resultIn,
} from '../lib/result-decisions.ts'
import type { InvestigationOrderView, ResultView } from '../lib/types.ts'

/** A result as `view.investigation_order` returns one, with nothing done to it. */
function aResult(over: Partial<ResultView> = {}): ResultView {
  return {
    resultId: 'result-1',
    current: true,
    supersedesResultId: '',
    correctionReason: '',
    source: 'external_laboratory',
    reportText: 'Haemoglobin 11.4 g/dL',
    receivedAt: '20 Sep 2026 10:00',
    recordedBy: 'Reception',
    sourceFlag: 'none',
    sourceFlagOrigin: 'laboratory',
    doctorFlag: 'none',
    doctorFlagBy: '',
    flag: 'none',
    externallyValidatedBy: '',
    externallyValidatedAt: '',
    review: null,
    criticalAcknowledgedBy: '',
    criticalAcknowledgedAt: '',
    notificationAuthorizedBy: '',
    notificationAuthorizedAt: '',
    notification: null,
    patientContactedBy: '',
    patientContactedAt: '',
    patientContactMethod: '',
    documents: [],
    ...over,
  } as ResultView
}

function reviewed(conclusion: string): NonNullable<ResultView['review']> {
  return {
    reviewedBy: 'Dr. Anbarasan',
    reviewedAt: '20 Sep 2026 11:00',
    conclusion,
    note: '',
  } as NonNullable<ResultView['review']>
}

function anOrder(
  results: ResultView[],
  over: Partial<InvestigationOrderView> = {},
): InvestigationOrderView {
  return {
    orderId: 'order-1',
    orderNumber: 'REQ-000001',
    patientName: 'Arulmozhi Chinnadurai',
    status: 'open',
    orderedBy: 'Dr. Anbarasan',
    responsibleDoctor: 'Dr. Anbarasan',
    delegatedDoctor: '',
    access: 'clinical',
    items: [
      { itemId: 'item-1', itemKind: 'investigation', itemName: 'Full blood count', results },
    ],
    ...over,
  } as InvestigationOrderView
}

describe('who is still owed something', () => {
  test('an unreviewed result owes nothing here — the queue still has it', () => {
    assert.equal(resultFollowUpOwed(aResult()), false)
  })

  test('a review that closed the line owes nobody anything', () => {
    assert.equal(resultFollowUpOwed(aResult({ review: reviewed('no_action_needed') })), false)
  })

  test('"the patient is to be informed" owes follow-up until it is authorized', () => {
    const owed = aResult({ review: reviewed('patient_to_be_informed') })
    assert.equal(resultFollowUpOwed(owed), true, 'nothing authorized yet')
    assert.equal(
      resultFollowUpOwed({ ...owed, notificationAuthorizedAt: '20 Sep 11:05' }),
      false,
      'the doctor has done their part; delivery belongs to the messaging subsystem',
    )
  })

  test('a critical result owes a telephone call whatever the conclusion says', () => {
    const critical = aResult({ flag: 'critical', review: reviewed('no_action_needed') })
    assert.equal(resultFollowUpOwed(critical), true)
    assert.equal(
      resultFollowUpOwed({ ...critical, notificationAuthorizedAt: '20 Sep 11:05' }),
      true,
      'authorizing a notice is not a call — owner item 88',
    )
    assert.equal(
      resultFollowUpOwed({ ...critical, patientContactedAt: '20 Sep 11:10' }),
      false,
      'the call is what closes it',
    )
  })

  test('a superseded result owes its successor, not itself', () => {
    assert.equal(
      resultFollowUpOwed(aResult({ current: false, review: reviewed('patient_to_be_informed') })),
      false,
    )
  })

  test('nothing to ask about is not something owed', () => {
    assert.equal(resultFollowUpOwed(null), false)
    assert.equal(resultFollowUpOwed(undefined), false)
  })
})

describe('what the record says about an act nobody heard back from', () => {
  test('a result that is no longer current answers "the target is gone"', () => {
    /*
     * NOT `false`. `false` means "do it again", and there is nothing left to
     * do it to. `readResultsForItem` has no superseded filter, so the old
     * result stays in the order and plain absence never happens — which is
     * why asking it as absence left this answer unreachable.
     */
    assert.equal(recoveryCommitted(anOrder([aResult({ current: false })]), 'result-1', 'review'), null)
  })

  test('a result that is not in the order at all also answers "gone"', () => {
    assert.equal(recoveryCommitted(anOrder([aResult()]), 'result-9', 'review'), null)
  })

  test('each act reads its own evidence', () => {
    const order = (over: Partial<ResultView>) => anOrder([aResult(over)])
    assert.equal(recoveryCommitted(order({}), 'result-1', 'review'), false)
    assert.equal(
      recoveryCommitted(order({ review: reviewed('no_action_needed') }), 'result-1', 'review'),
      true,
    )
    assert.equal(
      recoveryCommitted(order({ criticalAcknowledgedAt: '20 Sep 11:00' }), 'result-1', 'acknowledge'),
      true,
    )
    assert.equal(recoveryCommitted(order({ doctorFlag: 'urgent' }), 'result-1', 'flag'), true)
    assert.equal(recoveryCommitted(order({ doctorFlag: 'none' }), 'result-1', 'flag'), false)
    assert.equal(
      recoveryCommitted(order({ notificationAuthorizedAt: '20 Sep 11:05' }), 'result-1', 'authorize'),
      true,
    )
    assert.equal(
      recoveryCommitted(order({ patientContactedAt: '20 Sep 11:10' }), 'result-1', 'contact'),
      true,
    )
  })

  test('a delegation to somebody else is not this delegation', () => {
    /*
     * The order was already delegated to Dr Aadhira. The owner-doctor
     * re-delegates to Dr Chandrasekaran and hears nothing back. "Somebody is
     * delegated" would say it landed; the doctor this attempt named did not
     * get it, and cannot review.
     */
    const order = anOrder([aResult()], { delegatedDoctor: 'Dr. Aadhira' })
    assert.equal(
      recoveryCommitted(order, 'result-1', 'delegate', 'Dr. Chandrasekaran'),
      false,
      'the named doctor does not have it',
    )
    assert.equal(
      recoveryCommitted(order, 'result-1', 'delegate', 'Dr. Aadhira'),
      true,
      'and this one does',
    )
    assert.equal(
      recoveryCommitted(order, 'result-1', 'delegate'),
      true,
      'without a name the best it can say is that somebody has it',
    )
  })
})

describe('finding one result in an order', () => {
  test('it looks through every item, not only the first', () => {
    const order = anOrder([aResult()])
    order.items.push({
      itemId: 'item-2',
      itemKind: 'referral',
      itemName: 'Cardiology opinion',
      results: [aResult({ resultId: 'result-2' })],
    } as InvestigationOrderView['items'][number])
    assert.equal(resultIn(order, 'result-2')?.resultId, 'result-2')
    assert.equal(resultIn(order, 'nope'), null)
  })
})
