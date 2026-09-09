'use client'

import { useEffect, useState } from 'react'
import type { PatientRecordView } from '@/lib/types'
import { callApi } from '@/lib/api'

const EMPTY: Omit<PatientRecordView, 'patientId'> = {
  encounters: [],
  prescriptions: [],
  vitals: [],
  bills: [],
}

/**
 * One patient's history, fetched when that patient is opened.
 *
 * This used to arrive with everything else: every consultation, prescription,
 * vital sign and bill in the clinic's whole life, shipped to every tablet on
 * every tap. That is fine on the first day and unusable by the second year, and
 * there is no moment in between where anybody notices it break.
 *
 * `loading` is deliberately separate from empty. A patient with no history and
 * a patient whose history has not arrived look identical otherwise, and the
 * screen would flash "no previous visits" at a doctor mid-consultation.
 */
export function usePatientRecord(patientId: string): {
  record: Omit<PatientRecordView, 'patientId'>
  loading: boolean
  /** Re-read after writing something that belongs to this patient. */
  refresh: () => void
} {
  const [record, setRecord] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!patientId) {
      setRecord(EMPTY)
      return
    }

    // A doctor clicking down a list must not have an earlier, slower answer
    // land on top of the patient now on screen.
    let current = true
    setLoading(true)

    void (async () => {
      try {
        const response = await callApi(`record?patientId=${encodeURIComponent(patientId)}`)
        const result = (await response.json()) as { ok: boolean; record?: PatientRecordView }
        if (!current) return
        setRecord(result.ok && result.record ? result.record : EMPTY)
      } catch {
        if (current) setRecord(EMPTY)
      } finally {
        if (current) setLoading(false)
      }
    })()

    return () => {
      current = false
    }
  }, [patientId, nonce])

  return { record, loading, refresh: () => setNonce((n) => n + 1) }
}
