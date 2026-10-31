'use client'

import { useEffect, useState } from 'react'
import type { PatientRecordView } from '@/lib/types'
import { callApi } from '@/lib/api'

const EMPTY: Omit<PatientRecordView, 'patientId'> = {
  encounters: [],
  prescriptions: [],
  vitals: [],
  invoices: [],
  templates: [],
  phrases: [],
  phrasePreferences: [],
  followUps: [],
  clinicalProfile: { allergyStatus: 'not_recorded', allergyNotes: '', clinicalFlags: '' },
  imageSeriesStatus: 'not_enabled',
}

/**
 * One patient's history, fetched when that patient is opened.
 *
 * This used to arrive with everything else: every consultation, prescription,
 * vital sign and bill in the clinic's whole life, shipped to every tablet on
 * every tap. That is fine on the first day and unusable by the second year, and
 * there is no moment in between where anybody notices it break.
 *
 * Slice 4 renamed `bills` to `invoices`, which is not a rename of a word: a
 * bill used to be one row with one amount and a paid flag, and an invoice is a
 * header with immutable charge lines and payment allocations hanging off it.
 * The old shape could not say what was charged, what was paid, and what is
 * still due at the same time.
 *
 * `loading` is deliberately separate from empty. A patient with no history and
 * a patient whose history has not arrived look identical otherwise, and the
 * screen would flash "no previous visits" at a doctor mid-consultation.
 *
 * ── AND `failed` IS SEPARATE FROM BOTH ─────────────────────────────────────
 *
 * For the same reason, one step further on. A failed fetch used to be swallowed
 * into `EMPTY`, so a patient whose history did not arrive — the clinic Wi-Fi in
 * the corridor, a 500, a timeout — was presented to the doctor as a patient who
 * has no history: "First recorded visit.", no allergies, no previous
 * prescription, nothing to review. That is not a slow screen, it is a screen
 * stating a clinical fact that is false, during a consultation, about somebody
 * who may well be allergic to what is about to be prescribed.
 *
 * So the failure is carried out to the caller, and the screens that show
 * history say they could not read it rather than saying there is none.
 */
export function usePatientRecord(patientId: string): {
  record: Omit<PatientRecordView, 'patientId'>
  loading: boolean
  /**
   * The history could not be read. What is in `record` is empty because
   * nothing arrived, NOT because the patient has no history — never present
   * either as an absence of allergies or as a first visit.
   */
  failed: boolean
  /** Re-read after writing something that belongs to this patient. */
  refresh: () => void
} {
  const [record, setRecord] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!patientId) {
      setRecord(EMPTY)
      setFailed(false)
      return
    }

    // A doctor clicking down a list must not have an earlier, slower answer
    // land on top of the patient now on screen.
    let current = true
    setRecord(EMPTY)
    setFailed(false)
    setLoading(true)

    void (async () => {
      try {
        const response = await callApi(`record?patientId=${encodeURIComponent(patientId)}`)
        const result = (await response.json()) as { ok: boolean; record?: PatientRecordView }
        if (!current) return
        if (result.ok && result.record) {
          setRecord(result.record)
          setFailed(false)
        } else {
          // The clinic answered and declined to give the record. Whatever the
          // reason, this tablet does not know this patient's history.
          setRecord(EMPTY)
          setFailed(true)
        }
      } catch {
        if (current) {
          setRecord(EMPTY)
          setFailed(true)
        }
      } finally {
        if (current) setLoading(false)
      }
    })()

    return () => {
      current = false
    }
  }, [patientId, nonce])

  return { record, loading, failed, refresh: () => setNonce((n) => n + 1) }
}
