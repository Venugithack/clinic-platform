/**
 * The appointment station's references, and the rules they must keep.
 *
 * What is tested here is the part with no screen in it: when a reference is
 * reused and when it is let go, what may be written into browser storage, and
 * whose note it is. The browser suite covers the recovery itself, because a
 * lost reply and a reload need a real page to mean anything.
 *
 * No database, no browser. `sessionStorage` does not exist in Node, so a small
 * stand-in is installed for the file and taken away afterwards — and one test
 * removes it mid-file, which is the private-browsing case the module is
 * written to survive.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  appointmentAttemptIsOpaque,
  beginAppointmentAttempt,
  forgetAppointmentAttempt,
  heldAppointmentAttempt,
  lastAppointmentRequest,
  refuseAppointmentAttempt,
  settleAppointmentAttempt,
  unresolvedAppointmentAttempts,
} from '../lib/appointment-attempt.ts'

/** The smallest thing that behaves like `sessionStorage`. */
class MemoryStorage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  getItem(key: string) { return this.items.get(key) ?? null }
  setItem(key: string, value: string) { this.items.set(key, String(value)) }
  removeItem(key: string) { this.items.delete(key) }
  clear() { this.items.clear() }
  /** Everything actually written, as one string, for the privacy assertions. */
  dump() { return JSON.stringify([...this.items.entries()]) }
}

let storage: MemoryStorage

const NURSE = 'staff-nurse-001'
const DOCTOR = 'staff-doctor-002'
const PATIENT = 'patient-0001'
const BOOKING = 'booking-0001'

/** What a real booking request looks like, clinical reason and all. */
const BOOKING_REQUEST = {
  patientId: PATIENT,
  reason: 'Chest pain on exertion',
  scheduledAt: '2026-09-25T10:30',
}

function install(value: unknown) {
  Object.defineProperty(globalThis, 'sessionStorage', { value, configurable: true, writable: true })
}

before(() => {
  storage = new MemoryStorage()
  install(storage)
})

after(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'sessionStorage')
})

beforeEach(() => {
  storage.clear()
  // The module's in-memory copies outlive `storage.clear()`, so each test
  // settles the scopes it uses rather than trusting a clean slate.
  for (const act of ['book_appointment', 'check_in_appointment', 'reschedule_appointment'] as const) {
    settleAppointmentAttempt(act, PATIENT)
    settleAppointmentAttempt(act, BOOKING)
  }
})

describe('one reference per act, held until the clinic confirms it', () => {
  test('a lost reply is retried under the same reference, with the exact request', () => {
    const first = beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    // No confirmation arrives. The next press — a remount, a closed drawer —
    // must not be a new name for the same act.
    const second = beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    assert.equal(second, first)

    const last = lastAppointmentRequest(NURSE, 'book_appointment', PATIENT)
    assert.ok(last)
    assert.equal(last.key, first)
    assert.deepEqual(last.request, BOOKING_REQUEST, 'the retry is the exact request')
  })

  test('a refusal keeps the reference, so the corrected request goes under it', () => {
    const first = beginAppointmentAttempt(DOCTOR, 'book_appointment', PATIENT, BOOKING_REQUEST)
    refuseAppointmentAttempt('book_appointment', PATIENT)

    // OVERRIDE_REASON_REQUIRED consumes no receipt; the same request with a
    // reason goes under the same reference.
    const withReason = beginAppointmentAttempt(DOCTOR, 'book_appointment', PATIENT, {
      ...BOOKING_REQUEST,
      overrideReason: 'Post-operative review, cannot wait',
    })
    assert.equal(withReason, first)
  })

  test('only a confirmation lets it go, and the next act mints afresh', () => {
    const first = beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
    settleAppointmentAttempt('check_in_appointment', BOOKING)
    assert.equal(heldAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING), null)
    assert.equal(lastAppointmentRequest(NURSE, 'check_in_appointment', BOOKING), null)

    const next = beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
    assert.notEqual(next, first)
  })

  test('different acts on one booking do not share a reference', () => {
    const checkIn = beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
    const move = beginAppointmentAttempt(NURSE, 'reschedule_appointment', BOOKING, {
      bookingId: BOOKING, scheduledAt: '2026-09-26T09:00', reason: 'Patient asked',
    })
    assert.notEqual(checkIn, move)
  })
})

describe('what survives a reload', () => {
  test('an unanswered request is listed; a refused one is not', () => {
    beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
    refuseAppointmentAttempt('check_in_appointment', BOOKING)

    const open = unresolvedAppointmentAttempts(NURSE)
    assert.deepEqual(open.map((note) => note.act), ['book_appointment'])
    assert.equal(open[0].subjectId, PATIENT)
  })

  test('the note holds opaque identifiers and nothing a patient would recognise', () => {
    beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    const written = storage.dump()

    assert.ok(!written.includes('Chest pain'), 'the clinical reason is never written down')
    assert.ok(!written.includes('10:30'), 'nor the appointment time')
    for (const [, raw] of JSON.parse(written) as [string, string][]) {
      assert.ok(appointmentAttemptIsOpaque(JSON.parse(raw)), 'every note is the opaque shape')
    }
  })

  test('a note with anything extra in it is refused, not stripped', () => {
    assert.equal(
      appointmentAttemptIsOpaque({
        staffId: NURSE, act: 'book_appointment', subjectId: PATIENT, key: 'k', phase: 'sent', at: Date.now(),
        patientName: 'Somebody',
      }),
      false,
    )
    assert.equal(
      appointmentAttemptIsOpaque({
        staffId: NURSE, act: 'book_appointment', subjectId: PATIENT, key: 'k', phase: 'sent', at: Date.now(),
      }),
      true,
    )
    assert.equal(
      appointmentAttemptIsOpaque({
        staffId: NURSE, act: 'sign_consultation', subjectId: PATIENT, key: 'k', phase: 'sent', at: Date.now(),
      }),
      false,
      'only the five appointment acts',
    )
  })

  test('the reference is read back from storage after the page forgets it', () => {
    const key = beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    // What a reload leaves is this stored note — and no memory of the request.
    const raw = storage.getItem(`jayamurugan_appointment:book_appointment:${PATIENT}`)
    assert.ok(raw)
    assert.equal(JSON.parse(raw).key, key)
  })
})

describe('whose note it is', () => {
  test('another member of staff is not handed it, and it is deleted', () => {
    beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)

    assert.deepEqual(unresolvedAppointmentAttempts(DOCTOR), [])
    assert.equal(heldAppointmentAttempt(DOCTOR, 'book_appointment', PATIENT), null)
    assert.equal(lastAppointmentRequest(DOCTOR, 'book_appointment', PATIENT), null)
    assert.equal(storage.length, 0, 'the nurse’s note is gone, not merely ignored')
  })

  test('a doctor starting the same act gets a reference of their own', () => {
    const nurseKey = beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    const doctorKey = beginAppointmentAttempt(DOCTOR, 'book_appointment', PATIENT, BOOKING_REQUEST)
    assert.notEqual(doctorKey, nurseKey, 'a reference names its actor; a colleague’s would be refused')
  })

  test('an unanswered note survives overnight until the clinic settles it', () => {
    const key = beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    const name = `jayamurugan_appointment:book_appointment:${PATIENT}`
    const note = JSON.parse(storage.getItem(name) ?? '{}')
    storage.setItem(name, JSON.stringify({ ...note, at: Date.now() - 13 * 60 * 60 * 1000 }))

    assert.equal(unresolvedAppointmentAttempts(NURSE)[0]?.key, key)
    assert.equal(heldAppointmentAttempt(NURSE, 'book_appointment', PATIENT)?.key, key)
    assert.equal(beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST), key)
    settleAppointmentAttempt('book_appointment', PATIENT)
    assert.equal(storage.length, 0)
  })

  test('forgetting is explicit and complete', () => {
    beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
    forgetAppointmentAttempt('book_appointment', PATIENT)
    assert.equal(heldAppointmentAttempt(NURSE, 'book_appointment', PATIENT), null)
    assert.deepEqual(unresolvedAppointmentAttempts(NURSE), [])
  })
})

describe('without storage', () => {
  test('the reference is still held for the life of the page', () => {
    install(undefined)
    try {
      const first = beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
      const again = beginAppointmentAttempt(NURSE, 'check_in_appointment', BOOKING, { bookingId: BOOKING })
      assert.equal(again, first)
      settleAppointmentAttempt('check_in_appointment', BOOKING)
    } finally {
      install(storage)
    }
  })

  test('a different staff member removes the in-memory note and request', () => {
    install(undefined)
    try {
      beginAppointmentAttempt(NURSE, 'book_appointment', PATIENT, BOOKING_REQUEST)
      assert.deepEqual(unresolvedAppointmentAttempts(DOCTOR), [])
      assert.equal(lastAppointmentRequest(NURSE, 'book_appointment', PATIENT), null)
      assert.deepEqual(unresolvedAppointmentAttempts(NURSE), [])
    } finally {
      install(storage)
    }
  })
})
