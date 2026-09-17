/**
 * The attempt that makes a retry safe, held to every moment of its life.
 *
 * A refusal, a lost reply, and an outcome nobody knows are the three times a
 * person presses the button again — and they are exactly the three times the
 * attempt must be the SAME one. A confirmed signing is the only thing that
 * ends it. Getting that backwards is silent in both directions: an attempt
 * held too long files the next visit under the last one's reference, and one
 * released too early bills a patient twice.
 *
 * ── WHY THIS TESTS THE CONTROLLER AND NOT ONLY THE STORE ───────────────────
 *
 * An earlier version of this file tested `attemptKey` and `clearAttemptKey` in
 * isolation and passed while the wiring above it was wrong in two places, both
 * found by reading rather than by running. Storage that remembers a string is
 * not the thing that can be got wrong; WHEN to mint, WHEN to reuse and WHEN to
 * let go are, and they now live in `lib/consultation-attempt.ts` where a test
 * can reach them without a browser.
 *
 * The seven lifecycle cases below are the ones a real consultation goes
 * through. The database half of the same contract — what the server does when
 * two calls carry one attempt — is
 * `tests/characterization/consultation-idempotency.test.mjs`, and the
 * end-to-end half is `tests/browser/consultation-attempt.test.mjs`.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

/**
 * `sessionStorage` does not exist under `node --test`, and the module reads it
 * at call time rather than at import, so a stand-in installed here is the one
 * it finds. It is deliberately a real store and not a stub that always throws:
 * the throwing case has its own test below.
 */
function installStorage(entries = new Map<string, string>()) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value) },
      removeItem: (key: string) => { entries.delete(key) },
    },
  })
  return entries
}

const { beginAttempt, clearAttempt, currentAttempt, clinicDay } =
  await import('../lib/attempt-key.ts')
const {
  abandonConsultationAttempt, consultationScope, openConsultationAttempt,
  settleConsultationAttempt,
} = await import('../lib/consultation-attempt.ts')
const {
  mayRetrySigning, reconciliationRefusalAction, signingRefusalAction,
} = await import('../lib/consultation-reconciliation.ts')

const PATIENT = 'patient-1'
const SCOPE = `consultation:${PATIENT}`

/**
 * A fresh tab.
 *
 * The store alone is not enough. `lib/attempt-key.ts` keeps an in-memory copy
 * beside it — the fallback for a private window — and that map is module-level
 * and outlives a test the way it outlives a React unmount, which is the whole
 * point of it. Left alone it leaks one test's attempt into the next, and the
 * reload test below found exactly that. `clearAttempt` empties both.
 */
function freshTab(entries = new Map<string, string>()) {
  installStorage(entries)
  for (const scope of [SCOPE, 'consultation:patient-2']) clearAttempt(scope)
  return entries
}

describe('one visit, one attempt', () => {
  beforeEach(() => { freshTab() })

  test('the scope is the patient, and two patients never share one', () => {
    assert.equal(consultationScope(PATIENT), SCOPE)
    const a = openConsultationAttempt('patient-1', 'visit-1')
    const b = openConsultationAttempt('patient-2', 'visit-2')
    assert.notEqual(a.key, b.key)
  })

  test('asking twice for the same visit gives the same attempt', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const second = openConsultationAttempt(PATIENT, 'visit-1')
    assert.deepEqual(first, second,
      'a retry must reach the clinic under the name the first attempt used')
  })

  test('the visit it was opened against travels with it', () => {
    const attempt = openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(attempt.visitId, 'visit-1')
    assert.equal(attempt.day, clinicDay())
  })

  test('a patient seen with no visit row records that, rather than guessing', () => {
    assert.equal(openConsultationAttempt(PATIENT, undefined).visitId, null)
    clearAttempt(SCOPE)
    assert.equal(openConsultationAttempt(PATIENT, null).visitId, null)
  })
})

describe('the three moments the attempt must survive', () => {
  beforeEach(() => { freshTab() })

  test('a refusal keeps it — the sheet is corrected, not renamed', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, { status: 'refused' })
    assert.equal(released, false)
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
  })

  test('an outcome nobody knows keeps it — this is the case it exists for', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'unknown' }), false)
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
  })

  test('an unmount and a remount keep it', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })

    // What an unmount costs: every module-level variable in the panel. The
    // store outlives it, which is the whole reason it is not `useState`.
    const remounted = openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(remounted.key, first.key)
    assert.equal(remounted.visitId, 'visit-1')
  })

  test('a reload keeps it, because the store is the tab and not the page', async () => {
    const entries = freshTab()
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })

    // A reload is a fresh module graph over the same sessionStorage. Re-import
    // with a cache-busting query so the in-memory fallback map starts empty and
    // only what the tab persisted can be found.
    //
    // The specifier is assembled rather than written out, because `tsc` tries
    // to resolve a literal one and there is no module called
    // `attempt-key.ts?reload` for it to find — the query is a message to
    // Node's loader, not part of a path. Built from a variable, it is a
    // runtime string and the type checker leaves it alone.
    installStorage(entries)
    assert.ok(entries.get('jayamurugan_attempt:' + SCOPE),
      'the attempt must be in the tab’s store, not only in the page’s memory')
    const freshCopy = '../lib/attempt-key.ts' + '?reload'
    const reloaded = await import(freshCopy) as typeof import('../lib/attempt-key.ts')
    const after = reloaded.beginAttempt(SCOPE, { visitId: 'visit-1' })
    assert.equal(after.key, first.key,
      'a tablet reloaded mid-consultation must not come back with a new name for the same attempt')
  })
})

describe('the retry after the visit has left the snapshot', () => {
  beforeEach(() => { freshTab() })

  test('no visit now and a visit then is a retry, under the same attempt', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })

    /*
     * The fifteen-second poll has landed. Signing set `visit-1` to `done`, so
     * the panel resolves no appointment at all and passes undefined — which is
     * exactly what an unprotected implementation reads as "a different
     * consultation". It is the same attempt, and what the panel SENDS is the
     * live value, which is nothing: the clinic treats a request naming no
     * visit as compatible with a stored one, because silence here is the poll
     * having done its job rather than a disagreement.
     */
    const retry = openConsultationAttempt(PATIENT, undefined)
    assert.equal(retry.key, first.key)
    assert.equal(retry.visitId, 'visit-1',
      'the attempt still REMEMBERS what it was opened against — which is how a later, '
      + 'different arrival is recognised — even though what the panel sends is the live value')
  })
})

/**
 * The direction the first version of this rule got backwards.
 *
 * It compared "is the live visit id different from the stored one" and called
 * any difference a second consultation. Going from a visit to no visit was
 * handled — that is the famous retry — but going from NO visit to a visit was
 * not, and it is just as ordinary: a walk-in opened from the register has no
 * visit row, and policy item 3 explicitly lets the doctor create one. Do that
 * between a lost reply and its retry and the tablet minted a fresh key, which
 * is a second encounter and a second ₹300 fee for one consultation.
 */
describe('a visit row appearing is not a second consultation', () => {
  beforeEach(() => { freshTab() })

  test('a walk-in that acquires a visit row mid-attempt keeps its attempt', () => {
    const walkIn = openConsultationAttempt(PATIENT, undefined)
    assert.equal(walkIn.visitId, null)

    // Signed, reply lost, attempt held. The doctor then creates today's visit.
    settleConsultationAttempt(PATIENT, { status: 'unknown' })
    const retry = openConsultationAttempt(PATIENT, 'visit-created-after')

    assert.equal(retry.key, walkIn.key, 'the same consultation, still unresolved')
    assert.equal(retry.visitId, null,
      'and it still re-sends what it was opened against, which is what the clinic recorded')
  })

  test('the same holds when the visit row arrives without an unknown outcome in between', () => {
    const first = openConsultationAttempt(PATIENT, null)
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
  })

  test('a different live visit cannot rotate an unresolved attempt', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })
    const second = openConsultationAttempt(PATIENT, 'visit-2')

    assert.equal(second.key, first.key,
      'reception creating another visit is not proof of another attendance')
    assert.equal(second.visitId, 'visit-1',
      'the opened visit stays immutable while the live visit travels separately')
  })
})

describe('a later visit needs an audited decision', () => {
  beforeEach(() => { freshTab() })

  test('a different visit for the same patient keeps the unresolved attempt', () => {
    const monday = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })

    // This can be a genuine return or a duplicate arrival after a lost reply.
    // The queue row does not decide between them.
    const thursday = openConsultationAttempt(PATIENT, 'visit-2')
    assert.equal(thursday.key, monday.key)
    assert.equal(thursday.visitId, 'visit-1')
  })

  /**
   * Midnight is not evidence about what committed.
   *
   * This used to mint, and that was the second acceptance blocker: a reply lost
   * at 23:59 and retried at 00:01 got a fresh reference, and a fresh reference
   * writes a second encounter and a second ₹300 fee for one consultation. W1,
   * by the clock. Elapsed time says only that time passed.
   */
  test('an unresolved attempt is retained across midnight', () => {
    beginAttempt(SCOPE, { visitId: null, day: '2026-09-13' })
    const yesterday = currentAttempt(SCOPE)

    const today = beginAttempt(SCOPE, { visitId: null, day: '2026-09-14' })
    assert.equal(today.key, yesterday?.key,
      'the same unresolved consultation, and the clinic reconciles it rather than signing it twice')
    assert.equal(today.day, '2026-09-13',
      'and it still says when it was opened, which is what the reconciliation message needs')
  })

  test('the same holds for an attempt opened against a visit', () => {
    beginAttempt(SCOPE, { visitId: 'visit-1', day: '2026-09-13' })
    const yesterday = currentAttempt(SCOPE)
    // The visit was closed by the signing and the poll removed it, so the
    // tablet has nothing live to offer — the exact 23:59 shape.
    const today = beginAttempt(SCOPE, { visitId: null, day: '2026-09-14' })
    assert.equal(today.key, yesterday?.key)
  })

  test('starting the next consultation is an explicit act, not a date change', () => {
    const first = beginAttempt(SCOPE, { visitId: null, day: '2026-09-13' })
    settleConsultationAttempt(PATIENT, { status: 'confirmed' })
    const second = beginAttempt(SCOPE, { visitId: null, day: '2026-09-14' })
    assert.notEqual(first.key, second.key,
      'a confirmed signing ends the attempt; that is the transition, and the day is not')
  })

  test('and abandoning it is the other one', () => {
    const first = beginAttempt(SCOPE, { visitId: null, day: '2026-09-13' })
    abandonConsultationAttempt(PATIENT)
    const second = beginAttempt(SCOPE, { visitId: null, day: '2026-09-14' })
    assert.notEqual(first.key, second.key)
  })

  test('two direct consultations on one day do not share one once the first is confirmed', () => {
    const first = openConsultationAttempt(PATIENT, undefined)
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'confirmed' }), true)
    const second = openConsultationAttempt(PATIENT, undefined)
    assert.notEqual(first.key, second.key,
      'a confirmed signing ends the attempt, so the next consultation starts a new one')
  })
})

describe('letting go, and refusing to', () => {
  beforeEach(() => { freshTab() })

  test('only a confirmed signing releases it', () => {
    openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'refused' }), false)
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'unknown' }), false)
    assert.ok(currentAttempt(SCOPE), 'still held')

    assert.equal(settleConsultationAttempt(PATIENT, { status: 'confirmed' }), true)
    assert.equal(currentAttempt(SCOPE), null, 'and let go exactly once')
  })

  test('the operator moving on releases it, and that is a person and not a confirmation', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })
    abandonConsultationAttempt(PATIENT)
    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
  })

  /**
   * The one refusal a fresh reference is the right answer to.
   *
   * The server raises `ATTEMPT_NAMES_ANOTHER_CONSULTATION` when the key is
   * bound to a different patient, doctor or visit, and its message promises in
   * so many words that "the tablet will use a fresh reference". A promise the
   * tablet does not keep is worse than one it never made: the attempt would
   * refuse again on the next press, and again, for a patient who has done
   * nothing wrong.
   */
  test('a reference that names another consultation is let go, so the next press is a fresh one', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
    })

    assert.equal(released, true)
    assert.equal(currentAttempt(SCOPE), null)
    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-1').key, first.key,
      'and the recovery is automatic rather than a doctor reloading the tablet')
  })

  /**
   * And the sibling that it must NOT be the answer to.
   *
   * `CONSULTATION_ALREADY_SIGNED` means the key names THIS visit, the visit
   * committed, and the sheet has since been edited. A fresh reference there
   * writes a second encounter and a second ₹300 fee for one visit — W1
   * arriving by another road. The visit is signed and immutable; a further
   * consultation is a further VISIT, and creating one mints a new attempt
   * through the ordinary rule.
   */
  test('a signed visit and a later visit stay held until an audited resolution', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'CONSULTATION_ALREADY_SIGNED',
    })

    assert.equal(released, false, 'a signed visit is not re-signed under a new name')
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)

    assert.equal(openConsultationAttempt(PATIENT, 'visit-2').key, first.key,
      'the doctor, not the appearance of a queue row, decides whether this is new')
    assert.equal(settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_SETTLED_BY_RECONCILIATION',
    }), true)
    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-2').key, first.key,
      'the audited New attendance resolution permits the fresh attempt')
  })

  /**
   * The third sibling, and the one where rotating does the most direct harm.
   *
   * `ATTEMPT_VISIT_NO_LONGER_ACTIVE` means nothing committed and the visit the
   * attempt was opened against has been cancelled or closed. A fresh reference
   * makes the next press a signing with no visit named at all — a DIRECT
   * consultation against a cancelled visit, which is exactly what the refusal
   * was raised to prevent. The recovery is a clinic act: today's visit is
   * created, which is a different visit id, which mints through the ordinary
   * rule.
   */
  test('a cancelled opened visit keeps its reference until abandonment is audited', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
    })

    assert.equal(released, false,
      'rotating here signs a direct consultation against a visit somebody cancelled')
    // The poll has taken the cancelled visit out of the snapshot, so the tablet
    // now has nothing live — and that is not a reason to start again.
    assert.equal(openConsultationAttempt(PATIENT, null).key, first.key)

    assert.equal(openConsultationAttempt(PATIENT, 'visit-2').key, first.key,
      'a replacement visit does not silently discard the cancelled visit’s attempt')
    assert.equal(settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_SETTLED_BY_RECONCILIATION',
    }), true)
    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-2').key, first.key)
  })

  /**
   * The fourth sibling, added by Slice 2 and owner policy item 74.
   *
   * `ATTEMPT_NEEDS_RECONCILIATION` means the reference signed a consultation
   * against one real visit and the tablet is naming a different real visit.
   * That is either a patient who came back or a patient who never left and was
   * arrived again by reception, and the clinic is not allowed to decide
   * between them on its own: "Reception creating B is not, by itself, proof of
   * a second consultation."
   *
   * So it does not rotate. What ends it is a doctor recording **Same
   * attendance** or **New attendance** through
   * `resolve_consultation_attempt`, after which the tablet is told
   * `attemptReleased` and calls `abandonConsultationAttempt`. That control is
   * the frontend programme's; this test holds the half that is here, which is
   * that an unrecognised-by-the-client code does not become a fresh reference.
   */
  test('a reference that needs a doctor to reconcile it is held, not rotated', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_NEEDS_RECONCILIATION',
    })

    assert.equal(released, false,
      'a fresh reference here writes a second encounter and a second fee for one attendance')
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
  })

  /** A later visit is evidence to inspect, never permission to mint. */
  test('a patient re-queued after a lost reply stays on the earlier attempt', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')

    // The signing committed and the reply never arrived, so the attempt is
    // held — which is rule 2 working exactly as intended.
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'unknown' }), false)

    // Signing set visit-1 to `done`; the poll drops it; reception re-arrives
    // the same patient, who never left, as visit-2.
    const second = openConsultationAttempt(PATIENT, 'visit-2')

    assert.equal(second.key, first.key,
      'the second queue row must reach reconciliation instead of creating a second fee')
    assert.equal(second.visitId, 'visit-1')
  })

  /** A direct walk-in keeps the null opened identity while live visits change. */
  test('an attempt that began without a visit stays held, whatever arrives later', () => {
    // Opened from the register: no visit on screen.
    const first = openConsultationAttempt(PATIENT, null)
    assert.equal(first.visitId, null)
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'unknown' }), false)

    // Somebody creates today's visit. Policy item 3 allows it, and this is the
    // same consultation, so the attempt is kept and the live visit is sent.
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)
    assert.equal(currentAttempt(SCOPE)?.visitId, null,
      'and the stored value stays null, which is what the rule below turns on')

    // That signing commits and its reply is lost; visit-1 goes done and drops
    // out of the poll; reception arrives the patient again as visit-2.
    const third = openConsultationAttempt(PATIENT, 'visit-2')
    assert.equal(third.key, first.key,
      'a live visit changing never rotates a held attempt')

    // The reconciliation screen can now inspect and resolve this refusal; the
    // attempt itself remains held until that audited outcome.
    assert.equal(
      settleConsultationAttempt(PATIENT, {
        status: 'refused', code: 'ATTEMPT_NEEDS_RECONCILIATION',
      }),
      false)
    assert.equal(openConsultationAttempt(PATIENT, 'visit-2').key, first.key)
  })

  test('an unrecognised refusal code keeps the attempt', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(
      settleConsultationAttempt(PATIENT, { status: 'refused', code: 'SOMETHING_ELSE' }), false)
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key,
      'only the code that means "not yours" rotates; everything else is rule 2')
  })
})

describe('when the tablet cannot remember', () => {
  test('storage that throws falls back to memory rather than refusing to sign', () => {
    freshTab()
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError') },
    })

    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const second = openConsultationAttempt(PATIENT, 'visit-1')
    assert.equal(second.key, first.key,
      'a private window is worth less protection, not a consultation that cannot be signed')
    assert.equal(second.visitId, 'visit-1')
  })

  test('a stored value that is not an attempt is discarded rather than guessed at', () => {
    const entries = freshTab()
    // What the build that stored bare strings left behind. It names no visit
    // and no day, so it cannot be interpreted as an attempt at anything.
    entries.set('jayamurugan_attempt:' + SCOPE, 'a-bare-key-from-an-older-build')
    const attempt = openConsultationAttempt(PATIENT, 'visit-1')
    assert.notEqual(attempt.key, 'a-bare-key-from-an-older-build')
    assert.equal(attempt.visitId, 'visit-1')
  })
})

describe('the frontend recovery branch table', () => {
  test('only the two backend-proven stale-reference codes release on signing', () => {
    assert.equal(signingRefusalAction('ATTEMPT_NAMES_ANOTHER_CONSULTATION'), 'release')
    assert.equal(signingRefusalAction('ATTEMPT_SETTLED_BY_RECONCILIATION'), 'release')

    for (const code of [
      'ATTEMPT_NEEDS_RECONCILIATION',
      'CONSULTATION_ALREADY_SIGNED',
      'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT',
      'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
      'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE',
      'VISIT_RECONCILED_AND_CLOSED',
    ]) {
      assert.equal(signingRefusalAction(code), 'inspect', `${code} must hold and inspect`)
    }
    assert.equal(signingRefusalAction('SOME_ORDINARY_REFUSAL'), 'retry')
  })

  test('every reconciliation refusal has an explicit safe next state', () => {
    for (const code of ['SUBJECT_VISIT_REQUIRED', 'SUBJECT_VISIT_NOT_OPEN', 'VISIT_NOT_THIS_PATIENTS']) {
      assert.equal(reconciliationRefusalAction(code), 'choose_visit')
    }
    assert.equal(reconciliationRefusalAction('SUBJECT_VISIT_ALREADY_CONSULTED'), 'show_duplicate')
    for (const code of [
      'ATTEMPT_OUTCOME_NOT_ESTABLISHED',
      'RECONCILIATION_ALREADY_RESOLVED',
      'VISIT_RECONCILED_AND_CLOSED',
      'ATTEMPT_NOT_COMMITTED',
      'ATTEMPT_ALREADY_COMMITTED',
      'ATTEMPT_VISIT_STILL_ACTIVE',
    ]) {
      assert.equal(reconciliationRefusalAction(code), 'look_again')
    }
    assert.equal(reconciliationRefusalAction('UNRECOGNISED'), 'hold')
  })

  test('a held signing retries only after a read proves nothing committed and the visit is compatible', () => {
    assert.equal(mayRetrySigning('unknown', 'visit-a', 'visit-a'), false)
    assert.equal(mayRetrySigning('committed', 'visit-a', 'visit-a'), false)
    assert.equal(mayRetrySigning('not_committed', 'visit-a', 'visit-a'), true)
    assert.equal(mayRetrySigning('not_committed', 'visit-a', 'visit-b'), false)
    assert.equal(mayRetrySigning('not_committed', null, 'visit-b'), true)
  })
})
