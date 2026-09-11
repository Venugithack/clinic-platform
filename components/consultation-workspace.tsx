'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import type {
  ClinicalPhraseKind,
  ClinicSnapshot,
  ConsultationDraftView,
  ConsultationTemplateView,
  MedicineView,
  PatientClinicalProfileView,
  PrescriptionItemView,
} from '@/lib/types'
import { useBusy, useSelectedPatient, type ActionRunner } from './clinic-context'
import { usePatientRecord } from './use-patient-record'
import { ClinicLetterhead, Stack } from './shared-panels'
import { ImagesPanel } from './images-panel'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  Input,
  Notice,
  PageHeader,
  Select,
  Textarea,
  Token,
  formatDate,
  formatDay,
  money,
} from '@/components/ui'

type DiagnosisStatus = 'provisional' | 'differential' | 'confirmed'
type Certainty = 'not_stated' | 'suspected' | 'confirmed'
type DurationUnit = 'day' | 'week' | 'month'

type ClinicalSheet = {
  complaint: string
  complaintDurationValue: string
  complaintDurationUnit: DurationUnit
  examination: string
  diagnosis: string
  diagnosisStatus: DiagnosisStatus
  aetiology: string
  aetiologyCertainty: Certainty
  notes: string
  advice: string
  followUpDate: string
  followUpNote: string
}

type DraftMedicine = Omit<
  PrescriptionItemView,
  'doseAmount' | 'doseUnit' | 'frequency' | 'timing' | 'route' | 'durationValue' | 'durationUnit' | 'quantityUnit'
> & {
  key: string
  doseAmount: string
  doseUnit: string
  frequency: string
  timing: string
  route: string
  durationValue: number | ''
  durationUnit: DurationUnit
  quantityUnit: string
}

type SignedPrint = {
  id: string
  number: string
  signedAt: string
  items: DraftMedicine[]
  copyNumber?: number
}

const EMPTY_SHEET: ClinicalSheet = {
  complaint: '',
  complaintDurationValue: '',
  complaintDurationUnit: 'day',
  examination: '',
  diagnosis: '',
  diagnosisStatus: 'provisional',
  aetiology: '',
  aetiologyCertainty: 'not_stated',
  notes: '',
  advice: '',
  followUpDate: '',
  followUpNote: '',
}

const FREQUENCIES = [
  ['once_daily', 'Once daily'],
  ['twice_daily', 'Twice daily'],
  ['three_times_daily', 'Three times daily'],
  ['four_times_daily', 'Four times daily'],
  ['at_night', 'At night'],
  ['as_needed', 'As needed'],
] as const

const TIMINGS = [
  ['after_food', 'After food'],
  ['before_food', 'Before food'],
  ['with_food', 'With food'],
  ['any_time', 'Any time'],
] as const

function optionLabel(
  options: ReadonlyArray<readonly [string, string]>,
  value: string,
): string {
  return options.find(([key]) => key === value)?.[1] ?? value
}

function medicineLine(medicine: MedicineView): DraftMedicine {
  return {
    key: crypto.randomUUID(),
    medicineId: medicine.id,
    medicineName: `${medicine.name} ${medicine.strength}`.trim(),
    genericName: medicine.genericName,
    strength: medicine.strength,
    dosageForm: medicine.dosageForm,
    route: medicine.route,
    medicineCode: medicine.code,
    doseAmount: '1',
    doseUnit: medicine.unit,
    frequency: 'twice_daily',
    timing: 'after_food',
    durationValue: 3,
    durationUnit: 'day',
    dosage: '',
    instructions: '',
    quantity: 6,
    quantityUnit: medicine.unit,
  }
}

function restoredLine(item: PrescriptionItemView): DraftMedicine {
  return {
    ...item,
    key: crypto.randomUUID(),
    doseAmount: item.doseAmount ?? '',
    doseUnit: item.doseUnit ?? item.quantityUnit ?? 'unit',
    frequency: item.frequency ?? '',
    timing: item.timing ?? '',
    route: item.route ?? '',
    durationValue: item.durationValue ?? '',
    durationUnit: item.durationUnit ?? 'day',
    quantityUnit: item.quantityUnit ?? 'unit',
  }
}

function fromSaved(source: ConsultationDraftView | ConsultationTemplateView): ClinicalSheet {
  return {
    complaint: source.complaint,
    complaintDurationValue: source.complaintDurationValue
      ? String(source.complaintDurationValue)
      : '',
    complaintDurationUnit: source.complaintDurationUnit ?? 'day',
    examination: source.examination,
    diagnosis: source.diagnosis,
    diagnosisStatus: source.diagnosisStatus,
    aetiology: source.aetiology,
    aetiologyCertainty: source.aetiologyCertainty,
    notes: source.notes,
    advice: source.advice,
    followUpDate: 'followUpDate' in source ? source.followUpDate ?? '' : '',
    followUpNote: '',
  }
}

function dateAfter(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * How the doctor is charging this one visit.
 *
 * Policy register 15, 16 and 33. The clinic default is set by an admin on the
 * Clinic screen and is the ordinary case; the doctor may charge something else
 * or nothing at all for this consultation, with a reason, and neither decision
 * reaches back to change the default or any earlier visit.
 */
type FeeChoice = 'clinic' | 'override' | 'waive'

/** The clinic's default validity for the remainder of a prescription. */
const VALIDITY_DAYS = 7

function daysFromToday(dateValue: string): number | undefined {
  if (!dateValue) return undefined
  const [year, month, day] = dateValue.split('-').map(Number)
  const chosen = new Date(year, month - 1, day)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((chosen.getTime() - today.getTime()) / 86_400_000))
}

function vitalPrompts(
  vital: ClinicSnapshot['vitals'][number] | undefined,
  age: number,
  rules: ClinicSnapshot['vitalReviewRules'],
): string[] {
  if (!vital) return []
  const [systolic, diastolic] = String(vital.bp ?? '').split('/').map(Number)
  const values = {
    systolic: Number.isFinite(systolic) ? systolic : undefined,
    diastolic: Number.isFinite(diastolic) ? diastolic : undefined,
    temperature: vital.temperature,
    pulse: vital.pulse,
    spo2: vital.spo2,
    weight: vital.weight,
  }
  return [...new Set(rules.filter((rule) => {
    const reading = values[rule.metric]
    if (reading === undefined || age < rule.minimumAge || (rule.maximumAge !== undefined && age > rule.maximumAge)) return false
    return (rule.minimumValue !== undefined && reading < rule.minimumValue) ||
      (rule.maximumValue !== undefined && reading > rule.maximumValue)
  }).map((rule) => rule.prompt))]
}

function SuggestField({
  label,
  kind,
  value,
  required,
  multiline,
  suggestions,
  onChange,
  onFavourite,
}: {
  label: string
  kind: ClinicalPhraseKind
  value: string
  required?: boolean
  multiline?: boolean
  suggestions: Array<{ text: string; favourite: boolean; useCount: number }>
  onChange: (value: string) => void
  onFavourite: (kind: ClinicalPhraseKind, text: string) => void
}) {
  const id = useId()
  const options = suggestions
    .filter((item) => !value || item.text.toLocaleLowerCase('en-IN').includes(value.toLocaleLowerCase('en-IN')))
    .slice(0, 5)

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="eyebrow flex items-baseline gap-1.5">
        {label}
        {required ? <span className="text-stop normal-case tracking-normal">required</span> : null}
      </label>
      {multiline ? (
        <Textarea id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input
          id={id}
          value={value}
          required={required}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" aria-label={`${label} suggestions`}>
          {options.map((item) => (
            <button
              key={item.text}
              type="button"
              className="min-h-[44px] rounded-full border border-rule bg-paper px-3 py-1 text-left text-[12px] hover:border-ink"
              onClick={() => onChange(item.text)}
            >
              {item.favourite ? '★ ' : ''}{item.text}
            </button>
          ))}
        </div>
      ) : null}
      {value.trim() ? (
        <button
          type="button"
          className="mt-1 min-h-[44px] text-[12px] font-semibold text-ink-2 underline underline-offset-4"
          onClick={() => onFavourite(kind, value)}
        >
          Save this wording as a favourite
        </button>
      ) : null}
    </div>
  )
}

function PatientFacts({ profile }: { profile: PatientClinicalProfileView }) {
  const allergyTone = profile.allergyStatus === 'known'
    ? 'stop'
    : profile.allergyStatus === 'no_known'
      ? 'free'
      : 'attn'
  const allergyText = profile.allergyStatus === 'known'
    ? `Allergy: ${profile.allergyNotes}`
    : profile.allergyStatus === 'no_known'
      ? 'No known allergies'
      : 'Allergies not recorded'

  return (
    <div className="flex flex-wrap gap-2">
      <Badge tone={allergyTone}>{allergyText}</Badge>
      {profile.clinicalFlags ? <Badge tone="attn">{profile.clinicalFlags}</Badge> : null}
    </div>
  )
}

function PrintPrescription({
  data,
  patient,
  signed,
}: {
  data: ClinicSnapshot
  patient: ClinicSnapshot['patients'][number]
  signed: SignedPrint
}) {
  return (
    <section className="prescription-print" data-print="sheet" aria-label="Prescription print sheet">
      <ClinicLetterhead settings={data.settings} kind="prescription" />
      <div className="mt-5 flex items-start justify-between gap-4 border-y border-ink py-3 text-[13px]">
        <div>
          <p className="font-semibold">{patient.name}</p>
          <p>{patient.age} years · {patient.sex}{patient.phone ? ` · ${patient.phone}` : ''}</p>
        </div>
        <div className="text-right font-mono">
          <p>{signed.number}</p>
          <p>{formatDate(signed.signedAt)}</p>
          {signed.copyNumber && signed.copyNumber > 1 ? <p>Reprint copy {signed.copyNumber}</p> : null}
        </div>
      </div>
      <p className="mt-6 font-serif text-[28px]">℞</p>
      <ol className="mt-3 space-y-5">
        {signed.items.map((item, index) => (
          <li key={item.key} className="grid grid-cols-[28px_1fr_auto] gap-3 border-b border-rule pb-3">
            <span className="font-mono">{index + 1}.</span>
            <div>
              <p className="font-semibold">{item.medicineName} · {item.dosageForm}</p>
              {item.genericName ? <p className="text-[12px] text-ink-2">{item.genericName}</p> : null}
              <p className="mt-1 text-[13px]">
                {[item.doseAmount && `${item.doseAmount} ${item.doseUnit}`, optionLabel(FREQUENCIES, item.frequency), optionLabel(TIMINGS, item.timing), item.route]
                  .filter(Boolean).join(' · ')}
              </p>
              {item.instructions ? <p className="mt-1 text-[13px]">{item.instructions}</p> : null}
            </div>
            <div className="text-right font-mono text-[13px]">
              <p>Qty {item.quantity} {item.quantityUnit}</p>
              {item.durationValue ? <p>{item.durationValue} {item.durationUnit}{Number(item.durationValue) === 1 ? '' : 's'}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-16 ml-auto w-64 border-t border-ink pt-2 text-center text-[12px]">
        <p>Doctor’s signature</p>
        {data.settings.doctorRegistrationNumber ? <p>Reg. {data.settings.doctorRegistrationNumber}</p> : null}
      </div>
      {data.settings.footerNote ? <p className="mt-10 border-t border-rule pt-3 text-center text-[11px]">{data.settings.footerNote}</p> : null}
    </section>
  )
}

export function ConsultationPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const { patientId, select, goTo } = useSelectedPatient()
  const [sheet, setSheet] = useState<ClinicalSheet>(EMPTY_SHEET)
  const [items, setItems] = useState<DraftMedicine[]>([])
  const [medicineSearch, setMedicineSearch] = useState('')
  const [showMedicinePicker, setShowMedicinePicker] = useState(false)
  const [hydrated, setHydrated] = useState('')
  const [templateTitle, setTemplateTitle] = useState('')
  const [templateScope, setTemplateScope] = useState<'personal' | 'clinic'>('personal')
  const [profileDraft, setProfileDraft] = useState<PatientClinicalProfileView>({
    allergyStatus: 'not_recorded', allergyNotes: '', clinicalFlags: '',
  })
  const [signed, setSigned] = useState<SignedPrint | null>(null)

  // Slice 4: what this visit is charged, and how long its remainder may be
  // collected against. Both are decisions about THIS consultation and both
  // reset with the patient.
  const [feeChoice, setFeeChoice] = useState<FeeChoice>('clinic')
  const [feeAmount, setFeeAmount] = useState('')
  const [feeReason, setFeeReason] = useState('')
  const [validUntil, setValidUntil] = useState(() => dateAfter(VALIDITY_DAYS))
  const [supplyInParts, setSupplyInParts] = useState(true)
  const [validityReason, setValidityReason] = useState('')

  const patient = data.patients.find((item) => item.id === patientId)
  const appointment = data.appointments.find(
    (item) => item.patientId === patientId && item.status !== 'done' && item.status !== 'cancelled',
  )
  const { record, loading, refresh } = usePatientRecord(patientId)
  const latestVitals = record.vitals[0] ?? data.vitals.find((item) => item.patientId === patientId)
  const previous = record.encounters[0]
  const previousPrescription = record.prescriptions[0]
  const abnormalVitals = vitalPrompts(latestVitals, patient?.age ?? 0, data.vitalReviewRules)
  const sourceKey = patientId
    ? `${patientId}:${record.draft?.updatedAt ?? 'blank'}:${record.clinicalProfile.updatedAt ?? `${record.clinicalProfile.allergyStatus}:${record.clinicalProfile.allergyNotes}:${record.clinicalProfile.clinicalFlags}`}`
    : ''

  // Fee and validity are decisions about one visit, so they never travel to the
  // next patient. A waiver left standing on the screen would be charged to
  // somebody who never asked for it.
  useEffect(() => {
    setSigned(null)
    setFeeChoice('clinic')
    setFeeAmount('')
    setFeeReason('')
    setValidUntil(dateAfter(VALIDITY_DAYS))
    setSupplyInParts(true)
    setValidityReason('')
  }, [patientId])

  useEffect(() => {
    if (sourceKey === hydrated) return
    setHydrated(sourceKey)
    if (record.draft) {
      setSheet(fromSaved(record.draft))
      setItems(record.draft.items.map(restoredLine))
    } else {
      setSheet(EMPTY_SHEET)
      setItems([])
    }
    setProfileDraft(record.clinicalProfile)
  }, [hydrated, record.clinicalProfile, record.draft, sourceKey])

  const suggestions = useMemo(() => {
    const result = new Map<ClinicalPhraseKind, Array<{ text: string; favourite: boolean; useCount: number }>>()
    for (const kind of ['complaint', 'examination', 'diagnosis', 'instruction', 'advice'] as const) {
      const entries = new Map<string, { text: string; favourite: boolean; useCount: number }>()
      for (const item of record.phrases.filter((row) => row.kind === kind)) {
        entries.set(item.text.toLocaleLowerCase('en-IN'), { text: item.text, favourite: false, useCount: 0 })
      }
      for (const item of record.phrasePreferences.filter((row) => row.kind === kind)) {
        entries.set(item.text.toLocaleLowerCase('en-IN'), {
          text: item.text, favourite: item.favourite, useCount: item.useCount,
        })
      }
      result.set(kind, [...entries.values()].sort((a, b) => Number(b.favourite) - Number(a.favourite) || b.useCount - a.useCount || a.text.localeCompare(b.text)))
    }
    return result
  }, [record.phrasePreferences, record.phrases])

  const matchingMedicines = useMemo(() => {
    const query = medicineSearch.trim().toLocaleLowerCase('en-IN')
    return data.medicines
      .filter((medicine) => medicine.active)
      .filter((medicine) => !query || [
        medicine.name,
        medicine.genericName,
        medicine.strength,
        medicine.dosageForm,
        medicine.code,
        medicine.barcode,
      ].some((value) => value.toLocaleLowerCase('en-IN').includes(query)))
      .slice(0, 30)
  }, [data.medicines, medicineSearch])

  function patchSheet(change: Partial<ClinicalSheet>) {
    setSheet((current) => ({ ...current, ...change }))
  }

  function patchMedicine(key: string, change: Partial<DraftMedicine>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item))
  }

  const clinicFee = data.settings.consultationFee
  const validityDefault = dateAfter(VALIDITY_DAYS)
  const validityChanged = validUntil !== validityDefault || !supplyInParts

  /**
   * What the signed record will say about the money and the validity.
   *
   * `consultationFee` is sent ONLY when the doctor is overriding it. The server
   * reads its presence as the override — an empty string is "charge the clinic
   * default" — so echoing the default back would record every ordinary visit as
   * a doctor decision. Same reasoning for `validUntil`: leaving it out lets the
   * server apply the clinic's seven days, and sending it stamps this doctor's
   * name on the direction.
   */
  function payload() {
    return {
      patientId,
      appointmentId: appointment?.id,
      ...sheet,
      complaintDurationValue: sheet.complaintDurationValue || undefined,
      prescriptionItems: items,
      feeWaived: feeChoice === 'waive',
      consultationFee: feeChoice === 'override' ? feeAmount.trim() : '',
      feeReason: feeChoice === 'clinic' ? '' : feeReason.trim(),
      ...(items.length > 0 && validityChanged
        ? { validUntil, supplyInParts, validityReason: validityReason.trim() }
        : {}),
    }
  }

  /** Why the sheet cannot be signed yet, in the sentence the doctor needs. */
  const feeProblem =
    feeChoice === 'waive' && feeReason.trim() === ''
      ? 'Say why this consultation is being waived. A free visit is recorded as ₹0 with a reason, not left off the bill.'
      : feeChoice === 'override' && feeAmount.trim() === ''
        ? 'Enter what this visit is being charged.'
        : feeChoice === 'override' &&
            feeAmount.trim() !== String(clinicFee) &&
            feeReason.trim() === ''
          ? `The clinic fee is ${money(clinicFee)}. Say why this visit is being charged something else.`
          : items.length > 0 && validityChanged && validityReason.trim() === ''
            ? 'Say why this prescription’s validity is being changed from the clinic’s seven days.'
            : undefined

  function applyTemplate(template: ConsultationTemplateView) {
    setSheet({
      ...fromSaved(template),
      followUpDate: template.followUpAfterDays === undefined ? '' : dateAfter(template.followUpAfterDays),
    })
    setItems(template.items.map(restoredLine))
  }

  async function favourite(kind: ClinicalPhraseKind, text: string) {
    const result = await run('set_clinical_phrase_favourite', { kind, text, favourite: true })
    if (result.ok) refresh()
  }

  async function saveDraft() {
    const result = await run('save_consultation_draft', { ...payload(), draftId: record.draft?.id })
    if (result.ok) refresh()
  }

  async function discardDraft() {
    if (!record.draft) return
    const result = await run('discard_consultation_draft', { draftId: record.draft.id })
    if (result.ok) {
      setSheet(EMPTY_SHEET)
      setItems([])
      setHydrated('')
      refresh()
    }
  }

  async function saveProfile() {
    const result = await run('save_patient_clinical_profile', { patientId, ...profileDraft })
    if (result.ok) refresh()
  }

  async function saveTemplate(previous?: ConsultationTemplateView) {
    const title = previous?.title ?? templateTitle.trim()
    const scope = previous?.scope ?? templateScope
    if (!title) return
    const result = await run('save_clinical_template', {
      ...payload(),
      title,
      scope,
      templateId: previous?.id,
      followUpAfterDays: daysFromToday(sheet.followUpDate),
    })
    if (result.ok) {
      setTemplateTitle('')
      refresh()
    }
  }

  async function retireTemplate(templateId: string) {
    const result = await run('retire_clinical_template', { templateId })
    if (result.ok) refresh()
  }

  async function signConsultation() {
    const result = await run('sign_consultation', payload())
    if (!result.ok) return
    const resultData = result.data as { prescriptionId?: string; prescriptionNumber?: string; signedAt?: string }
    const signedAt = resultData.signedAt ?? new Date().toISOString()
    if (resultData.prescriptionId && resultData.prescriptionNumber) {
      setSigned({
        id: resultData.prescriptionId,
        number: resultData.prescriptionNumber,
        signedAt,
        items,
      })
    } else {
      setSigned({ id: '', number: '', signedAt, items: [] })
    }
    refresh()
  }

  async function printPrescription() {
    if (!signed?.id) return
    const result = await run('record_prescription_print', { prescriptionId: signed.id })
    if (!result.ok) return
    const resultData = result.data as { copyNumber: number }
    setSigned((current) => current ? { ...current, copyNumber: resultData.copyNumber } : current)
    document.documentElement.dataset.printMode = 'prescription'
    window.addEventListener('afterprint', () => {
      delete document.documentElement.dataset.printMode
    }, { once: true })
    window.setTimeout(() => window.print(), 0)
  }

  function nextPatient() {
    setSigned(null)
    setSheet(EMPTY_SHEET)
    setItems([])
    setHydrated('')
    select('')
    goTo('queue')
  }

  if (!patient) {
    return (
      <Stack>
        <PageHeader eyebrow="Doctor workspace" title="Consultation" sub="No patient open" />
        <Card variant="record">
          <CardBody className="space-y-4">
            <EmptyState title="Call in a patient" direction="Call the next person from Queue and their case sheet opens here. For an unqueued patient, choose them below." />
            <Field label="Open a patient">
              <Select value="" onChange={(event) => select(event.target.value)}>
                <option value="">Choose patient</option>
                {data.patients.map((item) => <option key={item.id} value={item.id}>{item.name}, {item.age}</option>)}
              </Select>
            </Field>
          </CardBody>
        </Card>
      </Stack>
    )
  }

  return (
    <Stack>
      <PageHeader eyebrow="Doctor workspace" title="Consultation" sub="One patient · one clinical sheet" />

      <section className="sticky top-0 z-20 -mx-2 border-y border-ink bg-sheet/95 px-3 py-3 shadow-[0_5px_16px_rgba(25,28,25,0.08)] backdrop-blur sm:mx-0 sm:rounded-box sm:border" aria-label="Current patient">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {appointment ? <Token code={appointment.token} size="md" active={appointment.status === 'in_consult'} /> : null}
          <div className="min-w-[180px] flex-1">
            <p className="text-[20px] leading-tight font-semibold">{patient.name}</p>
            <p className="mt-0.5 text-[13px] text-ink-2">{patient.age} years · {patient.sex}{patient.phone ? ` · ${patient.phone}` : ''}</p>
          </div>
          <PatientFacts profile={record.clinicalProfile} />
          <Button onClick={() => goTo('vitals')}>Vitals</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-2 text-[12px]">
          <span><b>BP</b> {latestVitals?.bp ?? 'Not measured'}</span>
          <span><b>Temp</b> {latestVitals?.temperature ?? 'Not measured'}</span>
          <span><b>Pulse</b> {latestVitals?.pulse ?? 'Not measured'}</span>
          <span><b>SpO₂</b> {latestVitals?.spo2 ?? 'Not measured'}</span>
          <span><b>Weight</b> {latestVitals?.weight ?? 'Not measured'}</span>
        </div>
        {abnormalVitals.length ? <p className="mt-2 text-[12px] font-semibold text-stop">Review: {abnormalVitals.join(' · ')}</p> : null}
      </section>

      {record.draft?.stale ? <Notice>A draft from {formatDate(record.draft.updatedAt)} is open. Review every field before signing; it is more than seven days old.</Notice> : null}
      {signed ? (
        <Notice>
          Consultation signed{signed.number ? ` as ${signed.number}` : ''}. A signed record cannot be edited.
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-4" aria-label="Consultation form">
          <fieldset disabled={Boolean(signed)} className="contents" aria-label="Clinical content">
          <Card variant="record">
            <CardBody className="space-y-6 py-5">
              <section aria-labelledby="history-title">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 id="history-title" className="eyebrow">Today’s clinical note</h2>
                  {record.templates.length ? <span className="text-[12px] text-ink-2">Start from a template below, then review and change it.</span> : null}
                </div>
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_210px]">
                  <SuggestField label="Complaint" kind="complaint" value={sheet.complaint} suggestions={suggestions.get('complaint') ?? []} onChange={(complaint) => patchSheet({ complaint })} onFavourite={favourite} />
                  <FieldRow className="gap-2">
                    <Field label="Duration">
                      <Input type="number" min="1" inputMode="numeric" value={sheet.complaintDurationValue} onChange={(event) => patchSheet({ complaintDurationValue: event.target.value })} />
                    </Field>
                    <Field label="Unit">
                      <Select value={sheet.complaintDurationUnit} onChange={(event) => patchSheet({ complaintDurationUnit: event.target.value as DurationUnit })}>
                        <option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option>
                      </Select>
                    </Field>
                  </FieldRow>
                </div>
              </section>

              <section className="border-t border-rule pt-5">
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <SuggestField label="Examination findings" kind="examination" value={sheet.examination} multiline suggestions={suggestions.get('examination') ?? []} onChange={(examination) => patchSheet({ examination })} onFavourite={favourite} />
                  <div className="space-y-4">
                    <SuggestField label="Diagnosis" kind="diagnosis" value={sheet.diagnosis} required suggestions={suggestions.get('diagnosis') ?? []} onChange={(diagnosis) => patchSheet({ diagnosis })} onFavourite={favourite} />
                    <FieldRow>
                      <Field label="Status">
                        <Select value={sheet.diagnosisStatus} onChange={(event) => patchSheet({ diagnosisStatus: event.target.value as DiagnosisStatus })}>
                          <option value="provisional">Provisional</option><option value="differential">Differential</option><option value="confirmed">Confirmed</option>
                        </Select>
                      </Field>
                      <Field label="Cause certainty">
                        <Select value={sheet.aetiologyCertainty} onChange={(event) => patchSheet({ aetiologyCertainty: event.target.value as Certainty })}>
                          <option value="not_stated">Not stated</option><option value="suspected">Suspected</option><option value="confirmed">Confirmed</option>
                        </Select>
                      </Field>
                    </FieldRow>
                    <Field label="Cause / aetiology" hint="Record only when clinically useful; do not guess.">
                      <Input value={sheet.aetiology} onChange={(event) => patchSheet({ aetiology: event.target.value })} />
                    </Field>
                  </div>
                </div>
              </section>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-[17px] font-semibold">Prescription</h2><p className="text-[12px] text-ink-2">Brand or generic, strength and form stay visible at every step.</p></div>
                <Button onClick={() => setShowMedicinePicker((open) => !open)}>{showMedicinePicker ? 'Close search' : 'Add medicine'}</Button>
              </div>
              {showMedicinePicker ? (
                <div className="border-y border-ink bg-paper p-3">
                  <Field label="Search medicine" hint="Name, generic, strength, form, clinic code or barcode">
                    <Input autoFocus value={medicineSearch} onChange={(event) => setMedicineSearch(event.target.value)} autoComplete="off" />
                  </Field>
                  <div className="mt-3 max-h-72 overflow-y-auto border-t border-rule">
                    {matchingMedicines.map((medicine) => (
                      <button key={medicine.id} type="button" className="flex min-h-[56px] w-full items-center justify-between gap-3 border-b border-rule px-2 py-2 text-left hover:bg-active-wash" onClick={() => { setItems((current) => [...current, medicineLine(medicine)]); setShowMedicinePicker(false); setMedicineSearch('') }}>
                        <span><span className="block text-[14px] font-semibold">{medicine.name} · {medicine.strength} · {medicine.dosageForm}</span><span className="block text-[12px] text-ink-2">{medicine.genericName || 'Generic not recorded'} · {medicine.route || 'Route not recorded'} · {medicine.code}</span></span>
                        <span className="shrink-0 font-mono text-[12px]">Stock {medicine.totalAvailable}</span>
                      </button>
                    ))}
                    {matchingMedicines.length === 0 ? <p className="py-4 text-[13px] text-ink-2">No active medicine matches all those characters.</p> : null}
                  </div>
                </div>
              ) : null}

              {items.length === 0 ? <EmptyState title="No medicine prescribed" direction="A consultation may be signed without a prescription." /> : (
                <ol className="space-y-4">
                  {items.map((item, index) => (
                    <li key={item.key} className="border-l-2 border-ink bg-paper/50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div><p className="text-[15px] font-semibold">{index + 1}. {item.medicineName} · {item.dosageForm}</p><p className="mt-0.5 text-[12px] text-ink-2">{item.genericName || 'Generic not recorded'} · {item.route || 'Route not recorded'} · {item.medicineCode}</p></div>
                        <Button variant="danger" size="sm" aria-label={`Remove ${item.medicineName}`} onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}>Remove</Button>
                      </div>
                      <FieldRow cols={4} className="mt-4">
                        <Field label="Dose"><Input value={item.doseAmount} onChange={(event) => patchMedicine(item.key, { doseAmount: event.target.value })} /></Field>
                        <Field label="Dose unit"><Input value={item.doseUnit} onChange={(event) => patchMedicine(item.key, { doseUnit: event.target.value })} /></Field>
                        <Field label="Frequency"><Select value={item.frequency} onChange={(event) => patchMedicine(item.key, { frequency: event.target.value })}><option value="">Choose</option>{FREQUENCIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
                        <Field label="Timing"><Select value={item.timing} onChange={(event) => patchMedicine(item.key, { timing: event.target.value })}><option value="">Choose</option>{TIMINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
                      </FieldRow>
                      <FieldRow cols={4} className="mt-4">
                        <Field label="Route"><Input value={item.route} onChange={(event) => patchMedicine(item.key, { route: event.target.value })} /></Field>
                        <Field label="Duration"><Input type="number" min="1" value={item.durationValue} onChange={(event) => patchMedicine(item.key, { durationValue: event.target.value ? Number(event.target.value) : '' })} /></Field>
                        <Field label="Duration unit"><Select value={item.durationUnit} onChange={(event) => patchMedicine(item.key, { durationUnit: event.target.value as DurationUnit })}><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option></Select></Field>
                        <Field label="Quantity" unit={item.quantityUnit}><Input type="number" min="1" required value={item.quantity} onChange={(event) => patchMedicine(item.key, { quantity: Number(event.target.value) })} /></Field>
                      </FieldRow>
                      <div className="mt-4"><SuggestField label="Instruction" kind="instruction" value={item.instructions} suggestions={suggestions.get('instruction') ?? []} onChange={(instructions) => patchMedicine(item.key, { instructions })} onFavourite={favourite} /></div>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="grid grid-cols-1 gap-5 py-5 lg:grid-cols-2">
              <SuggestField label="Advice to patient" kind="advice" value={sheet.advice} multiline suggestions={suggestions.get('advice') ?? []} onChange={(advice) => patchSheet({ advice })} onFavourite={favourite} />
              <Field label="Private clinical notes" hint="Not printed on the prescription."><Textarea value={sheet.notes} onChange={(event) => patchSheet({ notes: event.target.value })} /></Field>
              <Field label="Follow-up date"><Input type="date" value={sheet.followUpDate} onChange={(event) => patchSheet({ followUpDate: event.target.value })} /></Field>
              <Field label="Follow-up reminder"><Input value={sheet.followUpNote} onChange={(event) => patchSheet({ followUpNote: event.target.value })} /></Field>
            </CardBody>
          </Card>

          {/* ------------------------------------------- fee and validity */}
          <Card>
            <CardBody className="space-y-5 py-5">
              <div>
                <h2 className="text-[17px] font-semibold">Fee for this visit</h2>
                <p className="mt-0.5 text-[12px] text-ink-2">
                  The clinic charges {money(clinicFee)}, set by an admin on the Clinic screen. You
                  may charge something else or nothing for this consultation, with a reason. The
                  patient pays at the pharmacy counter — the fee goes there whether or not any
                  medicine is bought.
                </p>
              </div>

              <fieldset className="space-y-3">
                <legend className="eyebrow">What this visit is charged</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {([
                    ['clinic', `Clinic fee · ${money(clinicFee)}`, 'The ordinary case'],
                    ['override', 'A different amount', 'Charge more or less, once'],
                    ['waive', 'Waive it · ₹0', 'Recorded as ₹0 with a reason'],
                  ] as Array<[FeeChoice, string, string]>).map(([choice, label, note]) => (
                    <label
                      key={choice}
                      className="flex min-h-[56px] cursor-pointer items-center gap-3 rounded-box border border-rule bg-sheet px-3 py-2 transition-colors hover:bg-paper/60 has-[input:checked]:border-ink has-[input:checked]:bg-active-wash"
                    >
                      <input
                        type="radio"
                        name="consultation-fee-choice"
                        value={choice}
                        disabled={busy}
                        checked={feeChoice === choice}
                        onChange={() => setFeeChoice(choice)}
                      />
                      <span className="min-w-0">
                        <span className="block text-[14px] leading-tight font-semibold">{label}</span>
                        <span className="mt-0.5 block text-[12px] text-ink-2">{note}</span>
                      </span>
                    </label>
                  ))}
                </div>

                {feeChoice === 'override' ? (
                  <Field label="Amount to charge" unit="₹" required hint="Rupees and paise, e.g. 250 or 250.50.">
                    <Input inputMode="decimal" disabled={busy} value={feeAmount} placeholder={String(clinicFee)} onChange={(event) => setFeeAmount(event.target.value)} />
                  </Field>
                ) : null}

                {feeChoice !== 'clinic' ? (
                  <Field
                    label={feeChoice === 'waive' ? 'Why this visit is free' : 'Why the amount is different'}
                    required
                    hint="Kept on the record with your name and the time. A later change to the clinic fee never rewrites this visit."
                  >
                    <Textarea value={feeReason} disabled={busy} onChange={(event) => setFeeReason(event.target.value)} rows={2} />
                  </Field>
                ) : null}

                {feeChoice === 'waive' ? (
                  <Notice>
                    A waived visit is recorded as a ₹0 charge with this reason and your name against
                    it — it is not left off the bill. The pharmacy counter still sees the visit, and
                    the clinic can answer later why nothing was charged.
                  </Notice>
                ) : null}
              </fieldset>

              {items.length > 0 ? (
                <div className="space-y-3 border-t border-rule pt-5">
                  <div>
                    <h2 className="text-[17px] font-semibold">How long this prescription may be supplied</h2>
                    <p className="mt-0.5 text-[12px] text-ink-2">
                      The clinic default is {VALIDITY_DAYS} days from today —{' '}
                      {formatDay(validityDefault)}. It governs the REMAINDER: a first supply is
                      always in time, and after this date the pharmacy needs a new or amended order
                      from you before it hands over what is left.
                    </p>
                  </div>
                  <FieldRow>
                    <Field label="Valid until" hint={`Clinic default is ${formatDay(validityDefault)}.`}>
                      <Input type="date" disabled={busy} value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
                    </Field>
                    <Field label="May be supplied in parts" hint="Turn this off to require the whole prescription to be handed over in one go.">
                      <Select value={supplyInParts ? 'yes' : 'no'} disabled={busy} onChange={(event) => setSupplyInParts(event.target.value === 'yes')}>
                        <option value="yes">Yes — the remainder may be collected later</option>
                        <option value="no">No — supply all of it, or none of it</option>
                      </Select>
                    </Field>
                  </FieldRow>
                  {validityChanged ? (
                    <Field label="Why the validity is being changed" required>
                      <Textarea value={validityReason} disabled={busy} onChange={(event) => setValidityReason(event.target.value)} rows={2} />
                    </Field>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>

          </fieldset>

          <Disclosure label="Templates" hint={`${record.templates.length} available · applied as an editable draft`}>
            <div className="space-y-4">
              {record.templates.length ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{record.templates.map((template) => <div key={template.id} className="border border-rule p-3"><p className="font-semibold">{template.title}</p><p className="text-[12px] text-ink-2">{template.scope} · v{template.version} · {template.ownerDoctorName}</p><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" onClick={() => applyTemplate(template)}>Apply</Button>{template.ownerDoctorId === data.session.staffId || (template.scope === 'clinic' && data.session.canPublishClinicalTemplates) ? <><Button size="sm" onClick={() => saveTemplate(template)}>Save as v{template.version + 1}</Button><Button size="sm" variant="danger" onClick={() => retireTemplate(template.id)}>Retire</Button></> : null}</div></div>)}</div> : <p className="text-[13px] text-ink-2">No templates yet. Save the current sheet below when it is worth reusing.</p>}
              <FieldRow>
                <Field label="Template name"><Input value={templateTitle} onChange={(event) => setTemplateTitle(event.target.value)} /></Field>
                <Field label="Who can use it"><Select value={templateScope} onChange={(event) => setTemplateScope(event.target.value as 'personal' | 'clinic')}><option value="personal">Only me</option>{data.session.canPublishClinicalTemplates ? <option value="clinic">Every doctor in the clinic</option> : null}</Select></Field>
              </FieldRow>
              <ActionButton busy={busy} disabled={!templateTitle.trim()} onClick={() => saveTemplate()}>Save current sheet as template</ActionButton>
            </div>
          </Disclosure>

          <Disclosure label="Patient alerts" hint="Allergies and clinical flags stay visible in the sticky identity band">
            <div className="space-y-4">
              <FieldRow>
                <Field label="Allergy status"><Select value={profileDraft.allergyStatus} onChange={(event) => setProfileDraft((current) => ({ ...current, allergyStatus: event.target.value as PatientClinicalProfileView['allergyStatus'] }))}><option value="not_recorded">Not recorded</option><option value="no_known">No known allergies</option><option value="known">Known allergy</option></Select></Field>
                <Field label="Allergy details" required={profileDraft.allergyStatus === 'known'}><Input value={profileDraft.allergyNotes} onChange={(event) => setProfileDraft((current) => ({ ...current, allergyNotes: event.target.value }))} /></Field>
              </FieldRow>
              <Field label="Clinical flags"><Input value={profileDraft.clinicalFlags} onChange={(event) => setProfileDraft((current) => ({ ...current, clinicalFlags: event.target.value }))} /></Field>
              <ActionButton busy={busy} onClick={saveProfile}>Save patient alerts</ActionButton>
            </div>
          </Disclosure>

          <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-y border-ink bg-sheet/95 p-3 shadow-[0_-5px_16px_rgba(25,28,25,0.08)] backdrop-blur" data-print="hide">
            {signed ? (
              <>
                {signed.id ? <ActionButton variant="primary" busy={busy} busyLabel="Preparing…" onClick={printPrescription}>Print prescription</ActionButton> : null}
                <Button onClick={nextPatient}>Next patient</Button>
              </>
            ) : (
              <>
                <ActionButton
                  variant="primary"
                  busy={busy}
                  busyLabel="Signing…"
                  disabled={!sheet.diagnosis.trim() || Boolean(feeProblem)}
                  disabledReason={!sheet.diagnosis.trim() ? 'Record the diagnosis before signing.' : feeProblem}
                  onClick={signConsultation}
                >
                  Sign &amp; finish
                </ActionButton>
                <ActionButton busy={busy} busyLabel="Saving…" onClick={saveDraft}>Save draft</ActionButton>
                {record.draft ? <ActionButton variant="danger" busy={busy} onClick={discardDraft}>Discard draft</ActionButton> : null}
                <span className="text-[12px] text-ink-2">
                  {feeChoice === 'waive'
                    ? 'Waived — recorded as ₹0 with your reason. The visit still goes to Pharmacy.'
                    : feeChoice === 'override'
                      ? `₹${feeAmount || '—'} goes to Pharmacy with the patient, instead of the clinic’s ${money(clinicFee)}.`
                      : `${money(clinicFee)} goes to Pharmacy with the patient, medicine or no medicine.`}
                </span>
                {feeProblem ? <span className="text-[12px] font-semibold text-stop">{feeProblem}</span> : null}
              </>
            )}
          </div>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-40 xl:self-start">
          <Card>
            <CardBody className="space-y-4 py-4">
              <div><p className="eyebrow">Previous visit</p>{loading ? <p className="mt-1 text-[13px] text-ink-2">Reading patient record…</p> : previous ? <><p className="mt-1 font-mono text-[11px] text-ink-2">{formatDate(previous.createdAt)} · {previous.doctorName}</p><p className="mt-1 text-[14px] font-semibold">{previous.diagnosis}</p>{previous.complaint ? <p className="mt-1 text-[12px]">{previous.complaint}</p> : null}{previous.advice ? <p className="mt-1 text-[12px] text-ink-2">{previous.advice}</p> : null}<Button className="mt-3" size="sm" onClick={() => { setSheet({ ...EMPTY_SHEET, complaint: previous.complaint, examination: previous.examination, diagnosis: previous.diagnosis, diagnosisStatus: previous.diagnosisStatus === 'unspecified' ? 'provisional' : previous.diagnosisStatus, aetiology: previous.aetiology, aetiologyCertainty: previous.aetiologyCertainty, notes: previous.notes, advice: previous.advice }); setItems(previousPrescription?.items.map(restoredLine) ?? []) }}>Repeat as editable draft</Button></> : <p className="mt-1 text-[13px] text-ink-2">First recorded visit.</p>}</div>
              <div className="border-t border-rule pt-3"><p className="eyebrow">Last prescribed medicines</p>{previousPrescription?.items.length ? <ul className="mt-2 space-y-2">{previousPrescription.items.map((item, index) => <li key={`${item.medicineId}-${index}`} className="text-[12px]"><b>{item.medicineName}</b><span className="block text-ink-2">{item.dosage || item.instructions || 'Directions not recorded'}</span></li>)}</ul> : <p className="mt-1 text-[13px] text-ink-2">None in the record.</p>}</div>
              <div className="border-t border-rule pt-3"><p className="eyebrow">Before / after images</p><p className="mt-1 text-[13px] text-ink-2">Consent, capture and comparison are on the Images card below.</p></div>
              <div className="border-t border-rule pt-3"><p className="eyebrow">Open follow-ups</p>{record.followUps.filter((item) => item.status === 'open').length ? <ul className="mt-2 space-y-2">{record.followUps.filter((item) => item.status === 'open').map((item) => <li key={item.id} className="text-[12px]"><b>{item.dueDate}</b> · {item.note || 'Review due'}</li>)}</ul> : <p className="mt-1 text-[13px] text-ink-2">None due.</p>}</div>
            </CardBody>
          </Card>
          {/*
            * Clinical photographs, beside the consultation rather than inside
            * it. The doctor is already on the right patient, which is the
            * first guard against the wrong-patient attachment — and the
            * encounter is passed through so a photograph taken during a visit
            * is filed against that visit.
            */}
          <ImagesPanel
            patientId={patientId}
            patientName={patient?.name ?? 'this patient'}
            run={run}
            canCapture
          />

          <Disclosure label="Work on another patient" hint="Queue call-in is the normal route">
            <Field label="Patient"><Select value={patientId} onChange={(event) => select(event.target.value)}>{data.patients.map((item) => <option key={item.id} value={item.id}>{item.name}, {item.age}</option>)}</Select></Field>
          </Disclosure>
        </aside>
      </div>

      {signed?.id ? <PrintPrescription data={data} patient={patient} signed={signed} /> : null}
    </Stack>
  )
}
