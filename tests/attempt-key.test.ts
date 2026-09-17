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

  /**
   * And the case that must still mint: a genuinely new arrival while the
   * previous attempt is unresolved. Both ids present and different is the only
   * shape that is authoritative evidence of a second consultation.
   */
  test('a different visit while the previous attempt is unresolved does mint', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })
    const second = openConsultationAttempt(PATIENT, 'visit-2')

    assert.notEqual(second.key, first.key)
    assert.equal(second.visitId, 'visit-2')
  })
})

describe('a later visit is never the same consultation', () => {
  beforeEach(() => { freshTab() })

  test('a different visit for the same patient mints a new attempt', () => {
    const monday = openConsultationAttempt(PATIENT, 'visit-1')
    settleConsultationAttempt(PATIENT, { status: 'unknown' })

    // The patient is back, and this time there is a live visit row that is not
    // the one the attempt was opened against. That is authoritative.
    const thursday = openConsultationAttempt(PATIENT, 'visit-2')
    assert.notEqual(thursday.key, monday.key,
      'an unresolved attempt on one visit must never be spent on the next')
    assert.equal(thursday.visitId, 'visit-2')
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
  test('a signed visit that cannot be edited keeps its reference, and a new visit gets a new one', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'CONSULTATION_ALREADY_SIGNED',
    })

    assert.equal(released, false, 'a signed visit is not re-signed under a new name')
    assert.equal(openConsultationAttempt(PATIENT, 'visit-1').key, first.key)

    // The recovery, and it is an ordinary clinic action: the patient is seen
    // again, which means a visit row, which is a different consultation.
    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-2').key, first.key,
      'a second visit is never blocked by the first visit’s reference')
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
  test('a visit cancelled under the attempt keeps its reference, and a new visit gets a new one', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')
    const released = settleConsultationAttempt(PATIENT, {
      status: 'refused', code: 'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
    })

    assert.equal(released, false,
      'rotating here signs a direct consultation against a visit somebody cancelled')
    // The poll has taken the cancelled visit out of the snapshot, so the tablet
    // now has nothing live — and that is not a reason to start again.
    assert.equal(openConsultationAttempt(PATIENT, null).key, first.key)

    assert.notEqual(openConsultationAttempt(PATIENT, 'visit-2').key, first.key,
      'a visit created to replace the cancelled one is a second arrival, and mints')
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

  /**
   * ── A ROAD TO A SECOND FEE THAT THIS SLICE DOES NOT CLOSE ────────────────
   *
   * Characterization, not a specification. It records what the mint rule does
   * today and what that costs, because the independent review of the third
   * acceptance correction found it and the fix is an owner decision.
   *
   * The rule is *the attempt holds visit A and a different visit B is live*,
   * and it is meant to read "the patient arrived again". It cannot tell that
   * apart from the sequence below, which is ordinary:
   *
   *   a signing on queued visit A commits; the reply is lost; the screen says
   *   Outcome not confirmed; A is now `done`, so the snapshot drops it and the
   *   queue row disappears; reception arrives the patient again as visit B,
   *   because they are still standing there; the doctor presses Finish on the
   *   unchanged sheet.
   *
   * A fresh key is minted, the server has never seen it, and it signs against
   * B. Two encounters, two ₹300 fees, one attendance — W1's harm reached by
   * minting rather than by rotating, and invisible to the server, because two
   * keys against two genuine visits is exactly what a patient seen twice in
   * one day looks like.
   *
   * Every fix was a policy choice, and owner item 74 has since made it: do not
   * mint automatically, establish the old reference's outcome first, and let a
   * doctor say which it was. Slice 2 built that —
   * `resolve_consultation_attempt`, and the server-side refusal
   * `ATTEMPT_NEEDS_RECONCILIATION` that a non-minting client would meet.
   *
   * **On THIS path the client still mints, so it still never meets that
   * refusal**, and the second fee is still reachable from the build on the
   * clinic's tablets. On the path where the attempt holds no visit it does
   * meet it, holds the reference, and has nowhere to go — the test below
   * walks that one. The cutover is two changes in the frontend programme: stop
   * minting here, and put the resolution in front of the doctor. Until then
   * these two tests are what say so out loud.
   *
   * **Do not make this test pass by changing the rule** — change it as part
   * of the cutover, together with the control, or the doctor is left holding a
   * reference with no exit.
   */
  test('a patient re-queued after a lost reply looks exactly like a second arrival', () => {
    const first = openConsultationAttempt(PATIENT, 'visit-1')

    // The signing committed and the reply never arrived, so the attempt is
    // held — which is rule 2 working exactly as intended.
    assert.equal(settleConsultationAttempt(PATIENT, { status: 'unknown' }), false)

    // Signing set visit-1 to `done`; the poll drops it; reception re-arrives
    // the same patient, who never left, as visit-2.
    const second = openConsultationAttempt(PATIENT, 'visit-2')

    assert.notEqual(second.key, first.key,
      'the tablet mints, because a different live visit is the one thing that mints — ' +
      'and the next press writes a second encounter and a second fee for one attendance')
    assert.equal(second.visitId, 'visit-2')
  })

  /**
   * And the path the mint rule does NOT cover, which is the one the
   * independent acceptance review found.
   *
   * `supersededByANewArrival` requires a STORED visit, and an attempt opened
   * from the register stores `null` for its whole life — `beginAttempt` writes
   * the record only at mint time. So an attempt that began with no visit never
   * mints, however many visits appear afterwards, and it is the one shape of
   * attempt that reaches `ATTEMPT_NEEDS_RECONCILIATION` on the deployed build.
   *
   * The register, the frontend contract and this file's own comments all said
   * that refusal was unreachable. It is unreachable from the other path, and
   * "unreachable" and "unreachable from one of two paths" are not the same
   * claim. **Do not make this test pass by changing the rule** — change it as
   * part of the cutover, with the control, or the doctor is left holding a
   * reference with no exit at all.
   */
  test('an attempt that began without a visit never mints, whatever arrives later', () => {
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
      'no mint, because the attempt never stored a visit to be superseded')

    // Which is what the server answers with ATTEMPT_NEEDS_RECONCILIATION, and
    // the client correctly refuses to rotate on it. Correct, and a dead end
    // until the resolution control exists.
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
