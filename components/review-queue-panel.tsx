'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClinicSnapshot,
  MedicineView,
  PatientRecordView,
  PrescriptionItemView,
} from '@/lib/types'
import { callApi } from '@/lib/api'
import { useBusy, type ActionRunner } from './clinic-context'
import { ReasonAction, Stack } from './shared-panels'
import { ResultReviewSection } from './result-review'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  Disclosure,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  SectionHeader,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
  Token,
} from '@/components/ui'

/**
 * The prescription lines only a doctor can settle.
 *
 * When the clinic's history was brought across, some lines could not be read:
 * the medicine named on them is in no formulary entry under any spelling, or
 * no usable quantity was ever recorded. Slice 2.1 refused to guess — an
 * invented quantity on a signed order is a clinical fiction — so it marked
 * them and stopped. `prescription_lines_effective.needs_review` is that mark,
 * and the counter is blocked from supplying any line carrying it.
 *
 * Until this screen there was nowhere to see them. A line nobody can see is a
 * patient who never gets their medicine, and the only route to one was psql.
 *
 * ── WHAT THIS SCREEN MAY AND MAY NOT DO ─────────────────────────────────────
 *
 * A signed prescription is immutable and nothing here edits one. What
 * `resolve_prescription_line` writes is a separate resolution event beside the
 * signed line, so the record always shows both what was signed and what the
 * doctor later determined — and it is scoped: it can only say what the line
 * was signed WITHOUT. Determining a medicine on a line that already records
 * one is a new prescription, and the server refuses it in those words.
 *
 * Withdrawing a line is a clinical determination — the doctor cannot tell what
 * it authorized — and it is final. It is NOT the patient choosing not to
 * collect; that is Patient declined, it is a dispensing outcome, it happens at
 * the counter, and it is not on this screen at all.
 *
 * ── WHERE THE LIST AND THE LINE ID COME FROM ────────────────────────────────
 *
 * The list is the `needsDoctor` section of the `outstanding_prescriptions`
 * report, which is doctor-readable and complete. It names the prescription,
 * the patient, the line number, the medicine as written and which half is
 * unreadable — and not the line's id, which is the one thing the command
 * needs.
 *
 * So the id is fetched from the clinical record, which is doctor-only and does
 * carry it. A prescription number is unique across the clinic, so the patients
 * on the register sharing that name are read in turn until one of them holds
 * it. Line numbers are assigned 1..n at signing and never renumbered, so the
 * line is the nth item — and the medicine text on it is checked against the
 * report's before the id is used for anything. An administrator's snapshot
 * already carries the prescriptions, so for that session no fetch happens.
 *
 * Nothing is looked up until the doctor opens a line. The backlog is a
 * migration artefact that may be long, and a screen that opens fifty record
 * requests to draw a list is a screen nobody opens twice.
 */

/** One row of the report's `needsDoctor` section, exactly as the server sends it. */
type NeedsDoctorRow = {
  prescription_number: string
  patient: string
  line_number: number
  medicine: string
  medicine_state: string
  quantity_state: string
  /*
   * The line's own id, and the patient's.
   *
   * A doctor-only session's snapshot does not carry prescriptions — those are
   * gated to the counter — so without these the one role allowed to settle a
   * line would hold the list and no way to name a row on it. Optional in the
   * type because the backend deploys separately from this bundle: a page
   * running against a server that predates them falls back to the clinical
   * record rather than breaking.
   */
  prescription_line_id?: string
  patient_id?: string
  quantity_unit?: string
}

function isRow(value: unknown): value is NeedsDoctorRow {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<NeedsDoctorRow>
  return (
    typeof row.prescription_number === 'string' &&
    typeof row.patient === 'string' &&
    typeof row.medicine === 'string' &&
    typeof row.line_number === 'number'
  )
}

type ReviewLine = {
  key: string
  prescriptionNumber: string
  patient: string
  lineNumber: number
  /** The medicine text as it was signed. Never re-spelled for the screen. */
  medicine: string
  medicineUnreadable: boolean
  quantityUnreadable: boolean
  /** From the report where the server sends it, else this tablet's snapshot. */
  prescriptionLineId?: string
  /** From the report. Saves searching the register by name. */
  patientId?: string
  quantityUnit?: string
}

/**
 * Every prescription this session already holds, by number and line number.
 *
 * The snapshot sends all of a prescription's lines in line order, and line
 * numbers are 1..n with no gaps, so the nth item is line n.
 */
function snapshotLines(
  data: ClinicSnapshot,
): Map<string, { patient: string; byLine: Map<number, PrescriptionItemView> }> {
  const index = new Map<string, { patient: string; byLine: Map<number, PrescriptionItemView> }>()
  for (const rx of data.prescriptions) {
    const byLine = new Map<number, PrescriptionItemView>()
    rx.items.forEach((item, position) => byLine.set(position + 1, item))
    index.set(rx.prescriptionNumber, { patient: rx.patientName, byLine })
  }
  return index
}

function reviewLines(data: ClinicSnapshot, reported: NeedsDoctorRow[] | null): ReviewLine[] {
  const held = snapshotLines(data)

  if (reported) {
    return reported
      .map((row) => {
        const item = held.get(row.prescription_number)?.byLine.get(row.line_number)
        // The id is used only when the line it came from is demonstrably the
        // line the report named. A number that lines up and a medicine that
        // does not is a mismatch, not a match.
        const matched = item && item.medicineName === row.medicine ? item : undefined
        return {
          key: `${row.prescription_number}#${row.line_number}`,
          prescriptionNumber: row.prescription_number,
          patient: row.patient,
          lineNumber: row.line_number,
          medicine: row.medicine,
          medicineUnreadable: row.medicine_state === 'unresolved_legacy',
          quantityUnreadable: row.quantity_state === 'unknown_legacy',
          // The report's own id first. `matched` is this tablet's snapshot,
          // which a doctor-only session does not have.
          prescriptionLineId: row.prescription_line_id ?? matched?.prescriptionLineId,
          patientId: row.patient_id,
          quantityUnit: row.quantity_unit ?? matched?.quantityUnit,
        }
      })
      .sort(
        (a, b) =>
          a.prescriptionNumber.localeCompare(b.prescriptionNumber) || a.lineNumber - b.lineNumber,
      )
  }

  // The report was refused or unreachable. Whatever this session already holds
  // is still shown — a shorter list is better than a blank screen, and the
  // notice above it says which one this is.
  const lines: ReviewLine[] = []
  for (const [prescriptionNumber, rx] of held) {
    for (const [lineNumber, item] of rx.byLine) {
      if (!item.needsReview) continue
      lines.push({
        key: `${prescriptionNumber}#${lineNumber}`,
        prescriptionNumber,
        patient: rx.patient,
        lineNumber,
        medicine: item.medicineName,
        medicineUnreadable: item.medicineState === 'unresolved_legacy',
        quantityUnreadable: item.quantityState === 'unknown_legacy',
        prescriptionLineId: item.prescriptionLineId,
        quantityUnit: item.quantityUnit,
      })
    }
  }
  return lines.sort(
    (a, b) =>
      a.prescriptionNumber.localeCompare(b.prescriptionNumber) || a.lineNumber - b.lineNumber,
  )
}

/** What is unreadable, in words. Never colour alone. */
function unreadablePart(line: ReviewLine): string {
  if (line.medicineUnreadable && line.quantityUnreadable) return 'Medicine and quantity'
  return line.medicineUnreadable ? 'Medicine' : 'Quantity'
}

/** Brand, ingredient, strength, form, route, code and what is on the shelf. Never abbreviated. */
function describeMedicine(medicine: MedicineView): string {
  const identity = [medicine.name, medicine.strength].filter(Boolean).join(' ')
  const detail = [medicine.dosageForm, medicine.route, medicine.genericName, medicine.code]
    .filter(Boolean)
    .join(' · ')
  const shelf = `${medicine.totalAvailable} ${medicine.baseUnit || medicine.unit} on the shelf`
  return detail ? `${identity} · ${detail} · ${shelf}` : `${identity} · ${shelf}`
}

function MedicinePicker({
  medicines,
  value,
  onChange,
  disabled,
}: {
  medicines: MedicineView[]
  value: string
  onChange: (medicineId: string) => void
  disabled: boolean
}) {
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const active = medicines.filter((medicine) => medicine.active)
    const hits =
      needle === ''
        ? active
        : active.filter((medicine) =>
            [
              medicine.name,
              medicine.brandName,
              medicine.genericName,
              medicine.strength,
              medicine.dosageForm,
              medicine.route,
              medicine.code,
              medicine.barcode,
            ].some((field) => (field ?? '').toLowerCase().includes(needle)),
          )
    return hits.slice(0, 100)
  }, [medicines, query])

  const chosen = medicines.find((medicine) => medicine.id === value)

  return (
    <div className="space-y-3">
      <Field
        label="Find the medicine"
        hint="Brand, ingredient, strength, form or code. Strength and form are never collapsed together — read both before choosing."
      >
        <Input
          value={query}
          disabled={disabled}
          placeholder="Paracetamol, 500, tablet, PARA500"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>

      <Field
        label="Medicine this line authorized"
        required
        hint={
          matches.length === 100
            ? 'The first 100 matches. Narrow the search if what you want is not among them.'
            : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in the active formulary.`
        }
      >
        <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Not chosen</option>
          {chosen && !matches.some((medicine) => medicine.id === chosen.id) ? (
            <option value={chosen.id}>{describeMedicine(chosen)}</option>
          ) : null}
          {matches.map((medicine) => (
            <option key={medicine.id} value={medicine.id}>
              {describeMedicine(medicine)}
            </option>
          ))}
        </Select>
      </Field>

      {chosen ? (
        <div className="border border-rule bg-paper/50 px-3 py-2">
          <p className="eyebrow">Chosen</p>
          <p className="mt-1 font-mono text-[14px] break-words text-ink">
            {describeMedicine(chosen)}
          </p>
        </div>
      ) : null}
    </div>
  )
}

type Draft = { medicineId: string; quantity: string; reason: string }

const BLANK: Draft = { medicineId: '', quantity: '', reason: '' }

type Found =
  | { state: 'looking' }
  | { state: 'found'; prescriptionLineId: string; quantityUnit?: string }
  | { state: 'lost'; message: string }

function SettleCard({
  line,
  medicines,
  found,
  run,
  onResolved,
  onClose,
}: {
  line: ReviewLine
  medicines: MedicineView[]
  found: Found
  run: ActionRunner
  onResolved: () => void
  onClose: () => void
}) {
  const busy = useBusy()
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)

  // A new line is a new determination. Nothing typed against the last one
  // follows it across.
  useEffect(() => {
    setDraft(BLANK)
    setOutcome(null)
  }, [line.key])

  const lineId = found.state === 'found' ? found.prescriptionLineId : undefined
  const unit = line.quantityUnit ?? (found.state === 'found' ? found.quantityUnit : undefined)
  const where = `line ${line.lineNumber} of ${line.prescriptionNumber} for ${line.patient}`

  const reason = draft.reason.trim()
  const quantity = Number(draft.quantity)
  const quantityGiven =
    line.quantityUnreadable &&
    draft.quantity.trim() !== '' &&
    Number.isInteger(quantity) &&
    quantity > 0
  const medicineGiven = line.medicineUnreadable && draft.medicineId !== ''
  const chosenMedicine = medicineGiven
    ? medicines.find((medicine) => medicine.id === draft.medicineId)
    : undefined

  const missing = !reason
    ? 'Say what this determination is based on before it is recorded.'
    : !medicineGiven && !quantityGiven
      ? line.medicineUnreadable && line.quantityUnreadable
        ? 'Choose the medicine, or enter the quantity, or both.'
        : line.medicineUnreadable
          ? 'Choose which medicine this line authorized.'
          : 'Enter the whole number of units this line authorized.'
      : ''

  async function amend() {
    if (!lineId) return
    const result = await run('resolve_prescription_line', {
      prescriptionLineId: lineId,
      action: 'amend',
      reason,
      ...(medicineGiven ? { medicineId: draft.medicineId } : {}),
      ...(quantityGiven ? { quantity } : {}),
    })
    // The server's own sentence, whichever way it went. Nothing on this screen
    // says a determination was recorded because one was asked for.
    setOutcome({ ok: result.ok, message: result.message })
    if (result.ok) {
      setDraft(BLANK)
      onResolved()
    }
  }

  return (
    <Card variant="record">
      <CardHeader
        title="Settle this line"
        sub={`${line.prescriptionNumber} · line ${line.lineNumber} · ${line.patient}`}
        action={
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center rounded-box border border-rule px-3 text-[12px] font-semibold tracking-[0.08em] uppercase hover:bg-paper/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Close
          </button>
        }
      />
      <CardBody className="space-y-4">
        <div>
          <p className="eyebrow">As it was written on the prescription</p>
          <p className="mt-1 font-mono text-[16px] break-words text-ink">{line.medicine}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            {line.medicineUnreadable && line.quantityUnreadable
              ? 'Neither the medicine nor the quantity on this line can be matched to the clinic’s record, so the counter may not supply it.'
              : line.medicineUnreadable
                ? 'The medicine named here is in no formulary entry under any spelling, so the counter cannot tell what to hand over. The quantity is recorded and is not in question.'
                : 'No usable quantity was ever recorded against this line, so the counter cannot tell how much to hand over. The medicine is recorded and is not in question.'}
          </p>
        </div>

        {outcome ? (
          <Notice tone={outcome.ok ? 'good' : 'bad'} onDismiss={() => setOutcome(null)}>
            {outcome.message}
          </Notice>
        ) : null}

        {found.state === 'looking' ? (
          <p className="font-mono text-[13px] text-ink-2">Reading the clinical record for {line.patient}…</p>
        ) : null}

        {found.state === 'lost' ? <Notice tone="bad">{found.message}</Notice> : null}

        {lineId ? (
          <>
            {line.medicineUnreadable ? (
              <MedicinePicker
                medicines={medicines}
                value={draft.medicineId}
                disabled={busy}
                onChange={(medicineId) => setDraft((current) => ({ ...current, medicineId }))}
              />
            ) : null}

            {line.quantityUnreadable ? (
              <Field
                label="Quantity this line authorized"
                required
                unit={unit || 'units'}
                hint="Whole base units, as the order intended — not what is on the shelf today."
              >
                <Input
                  inputMode="numeric"
                  value={draft.quantity}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      quantity: event.target.value.replace(/[^0-9]/g, ''),
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field
              label="What this determination is based on"
              required
              hint="Recorded beside the signed line with your name and the time. The signed prescription itself does not change."
            >
              <Textarea
                value={draft.reason}
                disabled={busy}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reason: event.target.value }))
                }
              />
            </Field>

            <ConfirmButton
              variant="primary"
              busy={busy}
              disabled={missing !== ''}
              disabledReason={missing}
              title="Record what this line authorized"
              confirmLabel="Record it"
              question={
                <>
                  <p>
                    This records your determination beside {where}. The signed prescription does not
                    change, and the counter may supply against the line afterwards.
                  </p>
                  {chosenMedicine || quantityGiven ? (
                    <p className="mt-2 font-mono text-[13px] break-words">
                      {chosenMedicine ? describeMedicine(chosenMedicine) : null}
                      {chosenMedicine && quantityGiven ? <br /> : null}
                      {quantityGiven ? `${quantity} ${unit || 'units'}` : null}
                    </p>
                  ) : null}
                </>
              }
              onConfirm={amend}
            >
              Record what this line authorized
            </ConfirmButton>

            <Disclosure
              label="The doctor cannot determine what this line authorized"
              hint="Withdrawing it is final. Read this before using it."
            >
              <div className="space-y-3">
                <p className="text-[13px] leading-relaxed">
                  Withdrawing says that you, as the doctor, cannot determine what this line
                  authorized and are taking it back. It is final: the line can never be supplied,
                  and only a new prescription can order the medicine.
                </p>
                <p className="text-[13px] leading-relaxed">
                  <strong>This is not the patient declining to collect it.</strong> A patient who
                  chooses not to take a line the counter could supply is recorded as{' '}
                  <em>Patient declined</em> at the counter. That is a dispensing outcome, not a
                  clinical determination about the order, and it cannot be recorded from here.
                </p>
                <ReasonAction
                  variant="danger"
                  title="Withdraw this line"
                  confirmLabel="Withdraw the line"
                  reasonLabel="Why this cannot be determined"
                  reasonHint="Recorded with your name and the time. Withdrawing cannot be undone."
                  question={
                    <>
                      {where.charAt(0).toUpperCase() + where.slice(1)} —{' '}
                      <span className="font-mono">{line.medicine}</span> — will be withdrawn. It can
                      never be supplied. This is not the patient declining to collect it.
                    </>
                  }
                  onConfirm={async (withdrawReason) => {
                    const result = await run('resolve_prescription_line', {
                      prescriptionLineId: lineId,
                      action: 'cancel',
                      reason: withdrawReason,
                    })
                    setOutcome({ ok: result.ok, message: result.message })
                    if (result.ok) onResolved()
                    return result
                  }}
                >
                  Withdraw this line
                </ReasonAction>
              </div>
            </Disclosure>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

export function ReviewQueuePanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const [reported, setReported] = useState<NeedsDoctorRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [openKey, setOpenKey] = useState('')
  const [found, setFound] = useState<Found>({ state: 'looking' })
  /** Which line the answer now in flight belongs to. */
  const lookup = useRef(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const response = await callApi('reports?report=outstanding_prescriptions')
        const body = (await response.json()) as {
          ok: boolean
          message?: string
          needsDoctor?: unknown
        }
        if (!live) return
        if (!body.ok) {
          setReported(null)
          // The server's own sentence. It knows why it refused.
          setFailure(
            `${body.message ?? 'The outstanding prescriptions report could not be read.'} Only lines this tablet already holds are listed below.`,
          )
          return
        }
        setFailure(null)
        setReported(Array.isArray(body.needsDoctor) ? body.needsDoctor.filter(isRow) : [])
      } catch {
        if (!live) return
        setReported(null)
        setFailure(
          'The clinic server is not reachable, so the complete list could not be read. Only lines this tablet already holds are listed below.',
        )
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [nonce])

  const lines = useMemo(() => reviewLines(data, reported), [data, reported])
  const open = lines.find((line) => line.key === openKey) ?? null

  /**
   * The line's id, from the clinical record, for a session whose snapshot does
   * not carry prescriptions. Doctor-only, which is the only role this station
   * is offered to.
   *
   * Run from the tap that opens a line, not from an effect. The workspace
   * re-polls every fifteen seconds and rebuilds `lines` each time, so an effect
   * keyed on the open line would re-read the clinical record four times a
   * minute for as long as a doctor sat looking at one. `token` is what makes a
   * slower earlier answer lose to the line now open.
   */
  async function lookUp(line: ReviewLine, token: number) {
    const live = () => token === lookup.current
    // The report names the patient by id where the server sends one. Falling
    // back to the register by name is for a page running ahead of its backend;
    // two patients can share a name, which is why it tries each of them.
    const named = line.patientId
      ? [{ id: line.patientId }]
      : data.patients.filter((patient) => patient.name === line.patient)
    if (named.length === 0) {
      if (live()) {
        setFound({
          state: 'lost',
          message: `This tablet's patient register holds nobody called ${line.patient}, so the line behind ${line.prescriptionNumber} cannot be opened from here. Refresh the workspace, and if the name is still missing this line must be settled from a station that carries the prescription.`,
        })
      }
      return
    }

    for (const patient of named) {
      let body: { ok: boolean; message?: string; record?: PatientRecordView }
      try {
        const response = await callApi(`record?patientId=${encodeURIComponent(patient.id)}`)
        body = (await response.json()) as typeof body
      } catch {
        if (live()) {
          setFound({
            state: 'lost',
            message: 'The clinic server is not reachable, so this line could not be opened.',
          })
        }
        return
      }
      if (!live()) return
      if (!body.ok) {
        // The server's own sentence. It knows why it refused.
        setFound({ state: 'lost', message: body.message ?? 'That record could not be read.' })
        return
      }
      const rx = body.record?.prescriptions.find(
        (prescription) => prescription.prescriptionNumber === line.prescriptionNumber,
      )
      // A different patient of the same name. Try the next one.
      if (!rx) continue

      const item = rx.items[line.lineNumber - 1]
      if (!item?.prescriptionLineId) {
        setFound({
          state: 'lost',
          message: `${line.prescriptionNumber} was found, but it has no line ${line.lineNumber} to settle. Nothing has been changed.`,
        })
        return
      }
      if (item.medicineName !== line.medicine) {
        setFound({
          state: 'lost',
          message: `Line ${line.lineNumber} of ${line.prescriptionNumber} reads “${item.medicineName}” in the clinical record and “${line.medicine}” in the report. Nothing is recorded against a line this screen cannot identify with certainty.`,
        })
        return
      }
      setFound({
        state: 'found',
        prescriptionLineId: item.prescriptionLineId,
        quantityUnit: item.quantityUnit,
      })
      return
    }

    if (live()) {
      setFound({
        state: 'lost',
        message: `No record this tablet can read holds ${line.prescriptionNumber}. It must be settled from a station that carries the prescription.`,
      })
    }
  }

  function toggle(line: ReviewLine) {
    const token = ++lookup.current
    if (line.key === openKey) {
      setOpenKey('')
      return
    }
    setOpenKey(line.key)
    if (line.prescriptionLineId) {
      setFound({
        state: 'found',
        prescriptionLineId: line.prescriptionLineId,
        quantityUnit: line.quantityUnit,
      })
      return
    }
    setFound({ state: 'looking' })
    void lookUp(line, token)
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="What a doctor has to read"
        title="Review"
        sub={
          loading && reported === null
            ? 'Reading the lists…'
            : `${lines.length} legacy ${lines.length === 1 ? 'line' : 'lines'} waiting`
        }
      />

      {/*
       * Results first, because they are the live clinical work: a report that
       * has come back and nobody has read is a patient waiting on an answer
       * today. The legacy prescription lines below are a migration backlog —
       * real, and settled at whatever pace the doctor has time for.
       *
       * Two separate stations sharing one destination rather than two entries
       * on the rail: the plan's rule is three or four daily destinations per
       * clinical role, and both of these are "the things only a doctor can
       * settle".
       */}
      <ResultReviewSection data={data} run={run} />

      <SectionHeader
        title="Prescription lines from the old records"
        sub="A separate backlog, unchanged by the results above"
      />

      <Card>
        <CardBody className="space-y-2">
          <p className="text-[13px] leading-relaxed">
            These are prescription lines from the clinic’s earlier records whose medicine or
            quantity could not be read when the history was brought across. The counter is blocked
            from supplying any of them, and only a doctor may say what one authorized.
          </p>
          <p className="text-[13px] leading-relaxed text-ink-2">
            Nothing here changes a signed prescription. What you record is a separate determination
            kept beside the signed line, so the record always shows both.
          </p>
        </CardBody>
      </Card>

      {failure ? <Notice tone="bad">{failure}</Notice> : null}

      {lines.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title={loading ? 'Reading the list…' : 'No line is waiting on a doctor'}
              direction={
                loading
                  ? 'The complete list comes from the outstanding prescriptions report.'
                  : 'Every prescription line in the clinic’s record names a medicine the formulary knows and a quantity somebody wrote down. A line that loses one of those appears here.'
              }
            />
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Waiting on a doctor"
            sub={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
          />
          <Table>
            <THead>
              <TR>
                <TH>Prescription</TH>
                <TH>Patient</TH>
                <TH num>Line</TH>
                <TH>Medicine as written</TH>
                <TH>Unreadable</TH>
                <TH>Settle</TH>
              </TR>
            </THead>
            <TBody>
              {lines.map((line) => {
                const on = line.key === openKey
                return (
                  <TR
                    key={line.key}
                    active={on}
                    onClick={busy ? undefined : () => toggle(line)}
                  >
                    <TD>
                      <Token code={line.prescriptionNumber} />
                    </TD>
                    <TD className="font-semibold">{line.patient}</TD>
                    <TD num>{line.lineNumber}</TD>
                    <TD className="font-mono text-[13px]">{line.medicine}</TD>
                    <TD>
                      <Badge tone="stop">{unreadablePart(line)}</Badge>
                    </TD>
                    <TD>
                      {on ? (
                        <Badge tone="live">Open below</Badge>
                      ) : (
                        <span className="eyebrow">Open</span>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        </Card>
      )}

      {open ? (
        <SettleCard
          line={open}
          medicines={data.medicines}
          found={found}
          run={run}
          onClose={() => setOpenKey('')}
          onResolved={() => {
            setOpenKey('')
            setNonce((current) => current + 1)
          }}
        />
      ) : null}
    </Stack>
  )
}
