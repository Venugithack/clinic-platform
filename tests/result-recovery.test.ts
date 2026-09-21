/**
 * The note the result station leaves itself, and the three rules it must keep.
 *
 * It exists because a lost reply followed by a reload used to strand a doctor:
 * the attempt was React state and the reviewed result had left the queue, so
 * there was nothing to press and no way to learn whether the review landed.
 *
 * What is tested here is the part that has no screen in it — what may be
 * written down, whose it is, and when it stops counting. The browser suite
 * covers the recovery itself, because that needs a reload to mean anything.
 *
 * No database, no browser. `sessionStorage` does not exist in Node, so it is
 * installed on `globalThis` for the file and taken away afterwards — which is
 * also the closest thing to the private-browsing case the module is written
 * to survive.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  clearResultRecovery,
  readResultRecovery,
  resultRecoveryIsOpaque,
  writeResultRecovery,
} from '../lib/result-recovery.ts'

/** The smallest thing that behaves like `sessionStorage`. */
class MemoryStorage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  getItem(key: string) { return this.items.get(key) ?? null }
  setItem(key: string, value: string) { this.items.set(key, String(value)) }
  removeItem(key: string) { this.items.delete(key) }
  clear() { this.items.clear() }
  /** For the assertions below: everything actually written, as one string. */
  dump() { return JSON.stringify([...this.items.entries()]) }
}

let storage: MemoryStorage
const KEY = 'jayamurugan_result_followup'

const DOCTOR = 'staff-doctor-001'
const NURSE = 'staff-nurse-002'

before(() => {
  storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
})

after(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'sessionStorage')
})

beforeEach(() => {
  storage.clear()
})

const note = (over: Record<string, unknown> = {}) => ({
  staffId: DOCTOR,
  orderId: 'order-1',
  resultId: 'result-1',
  action: 'review' as const,
  phase: 'outcome_unknown' as const,
  ...over,
})

describe('a recovery note carries identifiers and nothing about a patient', () => {
  test('what is written down is only the seven allowed fields', () => {
    writeResultRecovery(note())
    const written = JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>

    assert.deepEqual(
      Object.keys(written).sort(),
      ['action', 'at', 'orderId', 'phase', 'reference', 'resultId', 'staffId'],
      'a field added here is a field that ends up in the weakest store in the application',
    )
  })

  test('nothing clinical survives a round trip, however it is offered', () => {
    // Fields a careless later change might add. They must not be stored.
    writeResultRecovery(note({
      patientName: 'Arulmozhi Chinnadurai',
      reportText: 'Haemoglobin 5.9 g/dL',
      flag: 'critical',
      ticket: 'abc.def',
    } as never))

    const raw = storage.dump()
    for (const secret of ['Arulmozhi', 'Haemoglobin', 'critical', 'abc.def']) {
      assert.ok(!raw.includes(secret), `"${secret}" reached sessionStorage`)
    }
  })

  test('a note somebody hand-edited into a clinical record is refused and removed', () => {
    storage.setItem(KEY, JSON.stringify({ ...note(), reference: 'r', at: Date.now(), patientName: 'X' }))
    assert.equal(readResultRecovery(DOCTOR), null)
    assert.equal(storage.getItem(KEY), null, 'and it is deleted rather than left to be read again')
  })

  test('the shape check refuses what it should', () => {
    assert.equal(resultRecoveryIsOpaque(null), false)
    assert.equal(resultRecoveryIsOpaque({}), false)
    assert.equal(resultRecoveryIsOpaque({ ...note(), reference: 'r', at: Date.now() }), true)
    assert.equal(
      resultRecoveryIsOpaque({ ...note(), action: 'delete_everything', reference: 'r', at: Date.now() }),
      false,
      'an action nobody declared is not an action',
    )
  })
})

describe('a note belongs to one person on one tablet', () => {
  test('another staff member is shown nothing, and the note is cleared', () => {
    writeResultRecovery(note())
    assert.ok(readResultRecovery(DOCTOR), 'the doctor still has theirs')

    assert.equal(readResultRecovery(NURSE), null, 'the nurse is shown nothing')
    assert.equal(
      storage.getItem(KEY),
      null,
      'and it is gone rather than waiting for the doctor to come back',
    )
  })
})

describe('one attempt is one note', () => {
  test('the same act on the same result keeps its reference across remounts', () => {
    const first = writeResultRecovery(note())
    const again = writeResultRecovery(note())
    assert.ok(first && again)
    assert.equal(again.reference, first.reference, 'a remount must not mint a second attempt')
    assert.equal(again.at, first.at, 'nor restart its clock')
  })

  test('a different act on the same result is a different attempt', () => {
    const review = writeResultRecovery(note({ action: 'review' }))
    const authorize = writeResultRecovery(note({ action: 'authorize' }))
    assert.ok(review && authorize)
    assert.notEqual(authorize.reference, review.reference)
  })

  test('a caller may carry a reference forward deliberately', () => {
    const review = writeResultRecovery(note({ action: 'review' }))
    assert.ok(review)
    // What the drawer does when a recorded review turns into owed follow-up:
    // the act changes, the attempt it came from does not.
    const followUp = writeResultRecovery(
      note({ action: 'contact', phase: 'follow_up', reference: review.reference }),
    )
    assert.equal(followUp?.reference, review.reference)
  })
})

describe('a note stops counting', () => {
  test('one older than twelve hours is not offered, and is removed', () => {
    const stale = { ...note(), reference: 'r', at: Date.now() - 13 * 60 * 60 * 1000 }
    storage.setItem(KEY, JSON.stringify(stale))
    assert.equal(readResultRecovery(DOCTOR), null)
    assert.equal(storage.getItem(KEY), null)
  })

  test('clearing it leaves nothing behind', () => {
    writeResultRecovery(note())
    clearResultRecovery()
    assert.equal(storage.getItem(KEY), null)
    assert.equal(readResultRecovery(DOCTOR), null)
  })

  test('unreadable rubbish is discarded rather than crashing the station', () => {
    storage.setItem(KEY, 'not json at all')
    assert.equal(readResultRecovery(DOCTOR), null)
    assert.equal(storage.getItem(KEY), null)
  })
})

describe('storage that is not there', () => {
  test('a tablet with no sessionStorage still works, it just does not remember', () => {
    // Private browsing, or storage disabled by policy. The station must open.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() { throw new Error('denied by policy') },
      configurable: true,
    })
    try {
      assert.equal(readResultRecovery(DOCTOR), null)
      assert.equal(writeResultRecovery(note()), null)
      assert.doesNotThrow(() => clearResultRecovery())
    } finally {
      if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved)
    }
  })
})
