'use client'

import { useEffect, useRef, useState } from 'react'
import type { Attempt } from '@/lib/attempt-key'
import { abandonConsultationAttempt } from '@/lib/consultation-attempt'
import {
  mayRetrySigning,
  reconciliationRefusalAction,
  RESOLUTION_COPY,
  type Resolution,
} from '@/lib/consultation-reconciliation'
import { callApi, readJson } from '@/lib/api'
import type { ActionRunner } from './clinic-context'
import {
  ActionButton,
  Button,
  Field,
  Modal,
  Notice,
  Select,
  TaskFailure,
  Textarea,
  formatDate,
  useTask,
} from '@/components/ui'

type Option = {
  resolution: Resolution
  available: boolean
  refusalCode?: string
  detail: string
}

type Reconciliation = {
  key: string
  patientId: string
  priorOutcome: 'committed' | 'not_committed' | 'unknown'
  inFlight?: 'signing' | 'resolution'
  consultation?: {
    encounterId: string
    prescriptionNumber?: string
    signedAt: string
    visitId?: string
    visitToken?: string
  }
  resolved?: {
    resolutionId: string
    resolution: Resolution
    priorOutcome: string
    reason: string
    by: string
    at: string
    subjectVisitId?: string
    subjectVisitClosed: boolean
    subjectVisitDisposition: string
  }
  openVisits: { visitId: string; token: string; status: string; scheduledAt: string }[]
  options: Option[]
}

type ReadState =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; value: Reconciliation }

type ResolutionResult = {
  attemptReleased?: boolean
  resolution?: Resolution
  priorOutcome?: string
  prescriptionNumber?: string
  subjectVisitClosed?: boolean
  subjectVisitDisposition?: string
}

export type AttemptGate = 'none' | 'checking' | 'retry' | 'blocked'

function outcomeWords(value: Reconciliation): string {
  if (value.priorOutcome === 'unknown') {
    return value.inFlight === 'resolution'
      ? 'Another doctor is recording a decision now. Do not repeat it; look again when they finish.'
      : 'The earlier signing is still in progress. The clinic cannot yet say what it recorded. Do not sign or choose a recovery action.'
  }
  if (value.priorOutcome === 'not_committed') {
    return 'Nothing was signed and no fee was created under the earlier attempt.'
  }
  const named = value.consultation?.prescriptionNumber
    ? `Prescription ${value.consultation.prescriptionNumber}`
    : 'A consultation'
  return `${named} was already signed${value.consultation?.visitToken ? ` for ${value.consultation.visitToken}` : ''}. The signed record stays unchanged.`
}

function recordedWords(resolution: Resolution, closed: boolean, disposition: string): string {
  if (resolution === 'same_attendance') {
    return disposition === 'already_done'
      ? 'The finished visit was linked to the signed consultation. No new consultation or fee was created.'
      : closed
        ? 'The leftover visit was closed and linked to the signed consultation. No new consultation or fee was created.'
        : 'The signed consultation was recorded as this attendance. No new consultation or fee was created.'
  }
  if (resolution === 'new_attendance') {
    return 'The patient was recorded as having returned. The visit remains available to consult normally under a fresh attempt.'
  }
  return 'The incomplete attempt was recorded as abandoned. No visit was closed and no fee was created.'
}

export function ConsultationReconciliation({
  open,
  patientId,
  patientName,
  liveVisitId,
  attempt,
  canReconcile,
  run,
  initialMessage,
  onClose,
  onGateChange,
  onReleased,
  onAlreadyResolved,
}: {
  open: boolean
  patientId: string
  patientName: string
  liveVisitId?: string
  attempt: Attempt | null
  canReconcile: boolean
  run: ActionRunner
  initialMessage?: string
  onClose: () => void
  onGateChange: (gate: AttemptGate) => void
  onReleased: () => void
  onAlreadyResolved: () => void
}) {
  const [readState, setReadState] = useState<ReadState>({ phase: 'loading' })
  const [choice, setChoice] = useState<Resolution | null>(null)
  const [reason, setReason] = useState('')
  const [subjectVisitId, setSubjectVisitId] = useState('')
  const [success, setSuccess] = useState<{ message: string; data: ResolutionResult } | null>(null)
  const readSequence = useRef(0)
  const mounted = useRef(true)
  const resolveTask = useTask()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function inspect() {
    if (!attempt || !canReconcile) return
    const sequence = ++readSequence.current
    setReadState({ phase: 'loading' })
    onGateChange('checking')
    try {
      const query = new URLSearchParams({
        view: 'reconciliation',
        key: attempt.key,
        patientId,
      })
      if (attempt.visitId) query.set('openedVisitId', attempt.visitId)
      const response = await callApi(`workspace?${query.toString()}`)
      const body = await readJson<{
        ok: boolean
        message?: string
        reconciliation?: Reconciliation
      }>(response, false)
      if (!mounted.current || sequence !== readSequence.current) return
      if (!response.ok || !body.ok || !body.reconciliation) {
        setReadState({ phase: 'failed', message: body.message ?? 'The earlier signing could not be checked.' })
        onGateChange('blocked')
        return
      }

      const value = body.reconciliation
      setReadState({ phase: 'ready', value })
      if (value.resolved) {
        // An append-only audited resolution is the backend proof owner policy
        // permits. A reload did not release the attempt; this confirmed read did.
        abandonConsultationAttempt(patientId)
        onReleased()
        onAlreadyResolved()
        return
      }
      onGateChange(mayRetrySigning(value.priorOutcome, attempt.visitId, liveVisitId) ? 'retry' : 'blocked')
    } catch {
      if (!mounted.current || sequence !== readSequence.current) return
      setReadState({
        phase: 'failed',
        message: 'The clinic did not answer. The earlier attempt is still held; nothing can be repeated until it is checked.',
      })
      onGateChange('blocked')
    }
  }

  useEffect(() => {
    setChoice(null)
    setReason('')
    setSubjectVisitId('')
    setSuccess(null)
    if (!attempt || !canReconcile) {
      setReadState({ phase: 'loading' })
      return
    }
    void inspect()
    // `inspect` deliberately keys the read to the attempt and patient. A live
    // visit change does not mint or restart the attempt; it only affects
    // whether a proven not-committed signing may be retried.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.key, patientId, canReconcile])

  useEffect(() => {
    if (readState.phase !== 'ready' || readState.value.openVisits.length === 0) return
    const visits = readState.value.openVisits
    const preferred = visits.find((visit) => visit.visitId === liveVisitId) ?? visits[0]
    setSubjectVisitId((current) => visits.some((visit) => visit.visitId === current)
      ? current
      : preferred.visitId)
  }, [liveVisitId, readState])

  useEffect(() => {
    if (!attempt || readState.phase !== 'ready' || readState.value.resolved) return
    onGateChange(mayRetrySigning(readState.value.priorOutcome, attempt.visitId, liveVisitId)
      ? 'retry'
      : 'blocked')
  }, [attempt, liveVisitId, onGateChange, readState])

  if (!attempt || !canReconcile) return null

  const activeAttempt = attempt
  const reconciliation = readState.phase === 'ready' ? readState.value : null
  const selected = choice ? RESOLUTION_COPY[choice] : null
  const selectedOption = choice
    ? reconciliation?.options.find((option) => option.resolution === choice)
    : undefined
  const needsVisit = Boolean(choice && choice !== 'abandoned_attempt' && reconciliation?.openVisits.length)
  const reasonProblem = reason.trim() ? undefined : 'Say why this is the correct attendance decision.'
  const visitProblem = needsVisit && !subjectVisitId ? 'Choose the visit this decision is about.' : undefined
  const resolutionProblem = reasonProblem ?? visitProblem

  async function resolve() {
    if (!choice || resolutionProblem) return
    const result = await resolveTask.run({
      working: 'Recording attendance decision…',
      request: () => run('resolve_consultation_attempt', {
        patientId,
        idempotencyKey: activeAttempt.key,
        resolution: choice,
        reason: reason.trim(),
        ...(choice !== 'abandoned_attempt' && subjectVisitId ? { subjectVisitId } : {}),
        ...(activeAttempt.visitId ? { openedVisitId: activeAttempt.visitId } : {}),
      }),
    })

    if (!result) return
    if (result.ok) {
      const data = (result.data ?? {}) as ResolutionResult
      if (data.attemptReleased === true) {
        // Do this outside useTask's confirmation callback: that callback does
        // not run after an unmount, but the backend's confirmed answer still
        // explicitly permits the release.
        abandonConsultationAttempt(patientId)
        if (mounted.current) {
          setSuccess({ message: result.message, data })
          onReleased()
        }
      } else if (mounted.current) {
        // A successful envelope without the contract field is not permission
        // to release. Read the durable record and remain closed meanwhile.
        onGateChange('blocked')
        await inspect()
      }
      return
    }

    if (result.unconfirmed) {
      // The lost response itself releases nothing. The follow-up read may
      // prove that the audited resolution committed, which is the durable
      // already-resolved state shown below.
      if (mounted.current) await inspect()
      return
    }

    const action = reconciliationRefusalAction(result.code)
    if (action === 'choose_visit' && mounted.current) setSubjectVisitId('')
    if (action !== 'hold' && mounted.current) await inspect()
  }

  const footer = success ? (
    <Button variant="primary" onClick={onClose}>Close</Button>
  ) : reconciliation?.resolved ? (
    <Button variant="primary" onClick={onClose}>Close</Button>
  ) : choice ? (
    <>
      <Button variant="ghost" onClick={() => setChoice(null)} disabled={resolveTask.busy}>Back</Button>
      <ActionButton
        variant="primary"
        busy={resolveTask.busy}
        busyLabel={resolveTask.workingLabel}
        disabled={Boolean(resolutionProblem)}
        disabledReason={resolutionProblem}
        onClick={resolve}
      >
        {selected?.confirmation ?? 'Record decision'}
      </ActionButton>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>Keep attempt and close</Button>
      <Button variant="secondary" onClick={() => void inspect()} disabled={readState.phase === 'loading'}>
        Look again
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={() => { if (!resolveTask.busy) onClose() }}
      title="Check an earlier signing"
      sub={patientName}
      busy={resolveTask.busy}
      busyLabel={resolveTask.workingLabel}
      footer={footer}
      wide
    >
      <div data-testid="consultation-reconciliation" className="space-y-4">
        {initialMessage ? <Notice tone="pending">{initialMessage}</Notice> : null}

        {success ? (
          <Notice tone="good">
            <span className="block font-semibold">Decision recorded</span>
            <span className="mt-1 block">{success.message}</span>
            <span className="mt-1 block">
              {recordedWords(
                success.data.resolution ?? choice ?? 'abandoned_attempt',
                Boolean(success.data.subjectVisitClosed),
                success.data.subjectVisitDisposition ?? 'not_applicable',
              )}
            </span>
          </Notice>
        ) : readState.phase === 'loading' ? (
          <p role="status" className="py-8 text-center text-[14px] text-ink-2">
            Checking what the clinic recorded…
          </p>
        ) : readState.phase === 'failed' ? (
          <Notice tone="unknown">{readState.message}</Notice>
        ) : reconciliation?.resolved ? (
          <div className="space-y-3">
            <Notice tone="info">
              <span className="block font-semibold">A decision is already recorded</span>
              <span className="mt-1 block">
                {RESOLUTION_COPY[reconciliation.resolved.resolution].label} · {reconciliation.resolved.by} · {formatDate(reconciliation.resolved.at)}
              </span>
            </Notice>
            <dl className="grid gap-2 rounded-box border border-rule p-3 text-[14px]">
              <div><dt className="font-semibold">Reason</dt><dd className="mt-0.5 text-ink-2">{reconciliation.resolved.reason}</dd></div>
              <div><dt className="font-semibold">What it means</dt><dd className="mt-0.5 text-ink-2">{recordedWords(reconciliation.resolved.resolution, reconciliation.resolved.subjectVisitClosed, reconciliation.resolved.subjectVisitDisposition)}</dd></div>
            </dl>
          </div>
        ) : reconciliation ? (
          <div className="space-y-4">
            <Notice tone={reconciliation.priorOutcome === 'unknown' ? 'unknown' : 'info'}>
              {outcomeWords(reconciliation)}
            </Notice>

            {reconciliation.consultation ? (
              <p className="rounded-box border border-rule p-3 text-[13px] text-ink-2">
                Signed {formatDate(reconciliation.consultation.signedAt)}
                {reconciliation.consultation.prescriptionNumber ? ` · ${reconciliation.consultation.prescriptionNumber}` : ''}
                {reconciliation.consultation.visitToken ? ` · ${reconciliation.consultation.visitToken}` : ''}
              </p>
            ) : null}

            {choice && selected ? (
              <div className="space-y-4">
                <div className="rounded-box border-2 border-ink p-4">
                  <h3 className="text-[16px] font-semibold">{selected.label}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                    {selectedOption?.detail ?? selected.consequence}
                  </p>
                </div>
                {needsVisit ? (
                  <Field label="Visit this decision is about" required>
                    <Select value={subjectVisitId} onChange={(event) => setSubjectVisitId(event.target.value)}>
                      <option value="">Choose a visit</option>
                      {reconciliation.openVisits.map((visit) => (
                        <option key={visit.visitId} value={visit.visitId}>
                          {visit.token} · {visit.status === 'in_consult' ? 'with doctor' : 'waiting'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label="Reason for this decision" required>
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Record the facts the next doctor should understand."
                    rows={3}
                  />
                </Field>
                <p className="text-[12px] text-ink-2">
                  Your name, reason, time and the result are kept in the clinic audit.
                </p>
              </div>
            ) : reconciliation.priorOutcome === 'unknown' ? (
              <p className="text-[13px] font-semibold text-attn">
                Recovery choices stay unavailable until the earlier work has settled.
              </p>
            ) : (
              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold">What happened?</h3>
                {reconciliation.options.filter((option) => option.available).map((option) => (
                  <div key={option.resolution} className="rounded-box border border-rule p-3">
                    <p className="font-semibold">{RESOLUTION_COPY[option.resolution].label}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{option.detail}</p>
                    <Button
                      className="mt-3 min-h-12 w-full sm:w-auto"
                      variant={option.resolution === 'same_attendance' ? 'primary' : 'secondary'}
                      onClick={() => setChoice(option.resolution)}
                    >
                      Review {RESOLUTION_COPY[option.resolution].label.toLowerCase()}
                    </Button>
                  </div>
                ))}
                {reconciliation.options.every((option) => !option.available) ? (
                  <Notice tone="pending">No recovery action is safe right now. Look again after the clinic finishes the earlier work.</Notice>
                ) : null}
              </div>
            )}

            <TaskFailure failure={resolveTask.failure} />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
