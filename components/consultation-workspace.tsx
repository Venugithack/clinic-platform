'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  ClinicalPhraseKind,
  ClinicSnapshot,
  ConsultationDraftView,
  ConsultationTemplateView,
  EncounterView,
  FollowUpView,
  MedicineView,
  PatientClinicalProfileView,
  PrescriptionItemView,
  PrescriptionView,
} from '@/lib/types'
import { useBusy, useSelectedPatient, type ActionRunner } from './clinic-context'
import {
  abandonConsultationAttempt, heldConsultationAttempt, openConsultationAttempt,
  settleConsultationAttempt,
} from '@/lib/consultation-attempt'
import { signingRefusalAction } from '@/lib/consultation-reconciliation'
import {
  ConsultationReconciliation,
  type AttemptGate,
} from './consultation-reconciliation'
import { usePatientRecord } from './use-patient-record'
import { ClinicLetterhead, Stack } from './shared-panels'
import { ImagesPanel } from './images-panel'
import {
  ActionButton,
  Badge,
  Busy,
  Button,
  Card,
  CardBody,
  DWELL_MAJOR,
  Disclosure,
  Drawer,
  EmptyState,
  Field,
  FieldRow,
  Icon,
  Input,
  Modal,
  Notice,
  PageHeader,
  Select,
  TaskFailure,
  TaskResult,
  Textarea,
  Token,
  formatDate,
  formatDay,
  money,
  useTask,
} from '@/components/ui'

/**
 * The doctor's one screen.
 *
 * The doctor now lands on the queue and `Call in` brings the patient here, so
 * this is the second screen of a visit and the last one: identity, alerts,
 * vitals and draft state at the top; the clinical sheet, the prescription, the
 * fee and the validity in the middle; history beside the work where there is
 * room for it and one tap from the patient band where there is not.
 *
 * Four things this file is careful about, because each of them was wrong:
 *
 *   1. A history that failed to load is not a patient with no history. The
 *      record hook now reports `failed` separately and every place that would
 *      have said "First recorded visit." or drawn "No known allergies" says it
 *      could not read the record instead.
 *   2. The split was `xl` — 1280px — and the clinic's tablet is 1024px wide, so
 *      the column the whole layout exists for appeared on nobody's screen. It
 *      is `lg` now, and below that the same content is a drawer off the band.
 *   3. Signing froze the sheet and not the two disclosures under it, so a
 *      signed consultation could still have a template applied over its
 *      prescription list while a notice said a signed record cannot be edited.
 *   4. `Sign & finish` committed on one tap. It reviews first now, blocks while
 *      the clinic answers, and reports only what the clinic confirmed.
 */

type DiagnosisStatus = 'provisional' | 'differential' | 'confirmed'
type Certainty = 'not_stated' | 'suspected' | 'confirmed'
type DurationUnit = 'day' | 'week' | 'month'

/**
 * The clinical sheet as it is typed. Every field in here round-trips through
 * the server-side draft, `followUpNote` included: it has a column of its own on
 * `consultation_drafts` since 20260917000000, so it saves and re-hydrates like
 * the advice and the notes beside it.
 */
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
  /** What was charged, in words, as it stood at the moment of signing. */
  fee: string
  waived: boolean
  diagnosis: string
  followUpDate: string
  followUpNote: string
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

const EMPTY_PROFILE: PatientClinicalProfileView = {
  allergyStatus: 'not_recorded',
  allergyNotes: '',
  clinicalFlags: '',
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
    // A template carries a follow-up interval rather than a reminder written
    // for one patient, so it starts this field empty; a draft restores what was
    // typed.
    followUpNote: 'followUpNote' in source ? source.followUpNote : '',
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

/** How the medicine lines read in one line of prose, for review and summary. */
function directions(item: DraftMedicine): string {
  return [
    item.doseAmount && `${item.doseAmount} ${item.doseUnit}`.trim(),
    optionLabel(FREQUENCIES, item.frequency),
    optionLabel(TIMINGS, item.timing),
    item.route,
    item.durationValue
      ? `${item.durationValue} ${item.durationUnit}${Number(item.durationValue) === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean).join(' · ')
}

function SuggestField({
  label,
  kind,
  value,
  required,
  multiline,
  hint,
  suggestions,
  onChange,
  onFavourite,
}: {
  label: string
  kind: ClinicalPhraseKind
  value: string
  required?: boolean
  multiline?: boolean
  hint?: string
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
      {hint ? <p className="mt-1 text-[12px] leading-snug text-ink-2">{hint}</p> : null}
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

/**
 * Allergies and clinical flags, in the patient band.
 *
 * The third state is the one that matters. Until the record has actually been
 * read, this says so; if the read failed it says THAT, in red, because "no
 * known allergies" and "this tablet could not find out" are not the same
 * sentence to put above a prescription.
 */
function PatientAlerts({
  profile,
  loading,
  failed,
}: {
  profile: PatientClinicalProfileView
  loading: boolean
  failed: boolean
}) {
  if (failed) {
    return (
      <div className="flex flex-wrap gap-2">
        <Badge tone="stop" icon="alert">Allergies unknown — record not read</Badge>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex flex-wrap gap-2">
        <Badge tone="plain" icon="clock">Reading allergies…</Badge>
      </div>
    )
  }

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

/**
 * What this patient has been here for before.
 *
 * One component, two placements: the column beside the sheet from 1024px up,
 * and the drawer off the patient band below it. Same words either way — the
 * layout changes, the record does not.
 */
function PatientContext({
  loading,
  failed,
  previous,
  previousPrescription,
  followUps,
  onRetry,
  onRepeat,
  frozen,
}: {
  loading: boolean
  failed: boolean
  previous?: EncounterView
  previousPrescription?: PrescriptionView
  followUps: FollowUpView[]
  onRetry: () => void
  onRepeat: () => void
  /** After signing nothing may be copied forward into an immutable record. */
  frozen: boolean
}) {
  const open = followUps.filter((item) => item.status === 'open')

  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow">Previous visit</p>
        {loading ? (
          <p className="mt-1 text-[13px] text-ink-2">Reading patient record…</p>
        ) : failed ? (
          <div className="mt-1.5">
            <p className="flex items-start gap-1.5 text-[13px] font-semibold text-stop">
              <Icon name="alert-circle" size={17} className="mt-px" />
              This patient’s record could not be read.
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
              This is not a patient with no history — it is a history this tablet does not have.
              Do not treat the blanks below as facts about the patient.
            </p>
            <Button className="mt-2" size="sm" icon="history" onClick={onRetry}>
              Try reading the record again
            </Button>
          </div>
        ) : previous ? (
          <>
            <p className="mt-1 font-mono text-[11px] text-ink-2">
              {formatDate(previous.createdAt)} · {previous.doctorName}
            </p>
            <p className="mt-1 text-[14px] font-semibold">{previous.diagnosis}</p>
            {previous.complaint ? <p className="mt-1 text-[12px]">{previous.complaint}</p> : null}
            {previous.advice ? <p className="mt-1 text-[12px] text-ink-2">{previous.advice}</p> : null}
            {frozen ? null : (
              <Button className="mt-3" size="sm" icon="draft" onClick={onRepeat}>
                Repeat as editable draft
              </Button>
            )}
          </>
        ) : (
          <p className="mt-1 text-[13px] text-ink-2">First recorded visit.</p>
        )}
      </div>

      <div className="border-t border-rule pt-3">
        <p className="eyebrow">Last prescribed medicines</p>
        {loading ? (
          <p className="mt-1 text-[13px] text-ink-2">Reading patient record…</p>
        ) : failed ? (
          <p className="mt-1 text-[13px] font-semibold text-stop">Not read — this is not “none”.</p>
        ) : previousPrescription?.items.length ? (
          <ul className="mt-2 space-y-2">
            {previousPrescription.items.map((item, index) => (
              <li key={`${item.medicineId}-${index}`} className="text-[12px]">
                <b>{item.medicineName}</b>
                <span className="block text-ink-2">
                  {item.dosage || item.instructions || 'Directions not recorded'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-2">None in the record.</p>
        )}
      </div>

      <div className="border-t border-rule pt-3">
        <p className="eyebrow">Before / after images</p>
        <p className="mt-1 text-[13px] text-ink-2">
          Consent, capture and comparison are on the Images card below.
        </p>
      </div>

      <div className="border-t border-rule pt-3">
        <p className="eyebrow">Open follow-ups</p>
        {loading ? (
          <p className="mt-1 text-[13px] text-ink-2">Reading patient record…</p>
        ) : failed ? (
          <p className="mt-1 text-[13px] font-semibold text-stop">Not read — this is not “none due”.</p>
        ) : open.length ? (
          <ul className="mt-2 space-y-2">
            {open.map((item) => (
              <li key={item.id} className="text-[12px]">
                <b>{item.dueDate}</b> · {item.note || 'Review due'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-2">None due.</p>
        )}
      </div>
    </div>
  )
}

/** One line of the review sheet: what is about to be signed, labelled. */
function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-t border-rule py-2 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 text-[14px] leading-relaxed">{children}</dd>
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
  const [profileDraft, setProfileDraft] = useState<PatientClinicalProfileView>(EMPTY_PROFILE)
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

  // Layers: the history drawer and the summary drawer share one slot, and the
  // review sheet is the only modal on this screen.
  const [drawer, setDrawer] = useState<'history' | 'summary' | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryAttempt, setRecoveryAttempt] = useState<ReturnType<typeof heldConsultationAttempt>>(null)
  const [attemptGate, setAttemptGate] = useState<AttemptGate>('none')
  const [recoveryMessage, setRecoveryMessage] = useState('')

  const sign = useTask()
  const draftTask = useTask()
  const discardTask = useTask()
  const templateTask = useTask()
  const profileTask = useTask()
  const printTask = useTask()

  const patient = data.patients.find((item) => item.id === patientId)
  const appointment = data.appointments.find(
    (item) => item.patientId === patientId && item.status !== 'done' && item.status !== 'cancelled',
  )
  const { record, loading, failed, refresh } = usePatientRecord(patientId)
  const canReconcile = data.session.roles.includes('doctor')

  const releaseRecoveryGate = useCallback(() => {
    setAttemptGate('none')
  }, [])

  const showRecordedRecovery = useCallback(() => {
    setRecoveryOpen(true)
  }, [])

  useEffect(() => {
    if (!patientId || !canReconcile) {
      setRecoveryAttempt(null)
      setAttemptGate('none')
      setRecoveryOpen(false)
      setRecoveryMessage('')
      return
    }
    const held = heldConsultationAttempt(patientId)
    setRecoveryAttempt(held)
    setAttemptGate(held ? 'checking' : 'none')
    setRecoveryOpen(false)
    setRecoveryMessage('')
  }, [canReconcile, patientId])

  /**
   * Which patient the record in hand actually belongs to.
   *
   * The record hook clears one render later than the selection changes, so the
   * render in which `patientId` becomes the next patient is still holding the
   * previous patient's record — their draft, their allergies. Until this
   * catches up, the record is treated as not yet read rather than as this
   * patient's, because an allergy under the wrong name is worse than a pause.
   */
  const [recordOwner, setRecordOwner] = useState(patientId)
  useEffect(() => { setRecordOwner(patientId) }, [patientId])
  const historyCurrent = recordOwner === patientId
  const historyLoading = Boolean(patientId) && (!historyCurrent || loading)
  const historyFailed = historyCurrent && !loading && failed
  const historyReady = historyCurrent && !loading && !failed

  const savedDraft = historyReady ? record.draft : undefined
  const clinicalProfile = historyReady ? record.clinicalProfile : EMPTY_PROFILE
  const templates = historyReady ? record.templates : []
  const latestVitals = record.vitals[0] ?? data.vitals.find((item) => item.patientId === patientId)
  const previous = historyReady ? record.encounters[0] : undefined
  const previousPrescription = historyReady ? record.prescriptions[0] : undefined
  const abnormalVitals = vitalPrompts(latestVitals, patient?.age ?? 0, data.vitalReviewRules)
  const staleDraft = Boolean(savedDraft?.stale) && !signed

  const sourceKey = patientId && historyReady
    ? `${patientId}:${savedDraft?.updatedAt ?? 'blank'}:${clinicalProfile.updatedAt ?? `${clinicalProfile.allergyStatus}:${clinicalProfile.allergyNotes}:${clinicalProfile.clinicalFlags}`}`
    : ''

  // Where focus goes when a patient is called in, and where the result layer
  // returns it when it is dismissed without choosing the next patient.
  const bandHeading = useRef<HTMLHeadingElement>(null)
  const afterSign = useRef<HTMLButtonElement>(null)
  const band = useRef<HTMLElement>(null)

  /**
   * How far down the sticky history column starts.
   *
   * It used to be `xl:top-40` — 160px, hard-coded against a patient band whose
   * height depends on the name, the allergy list, the review prompts and
   * whether there is a stale draft. Measuring it is four lines and is right at
   * every width and in every one of those cases.
   */
  const [bandHeight, setBandHeight] = useState(0)
  useEffect(() => {
    const element = band.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setBandHeight(element.getBoundingClientRect().height))
    observer.observe(element)
    setBandHeight(element.getBoundingClientRect().height)
    return () => observer.disconnect()
  }, [patientId])

  // Fee, validity and the signed record are decisions about one visit, so they
  // never travel to the next patient. A waiver left standing on the screen
  // would be charged to somebody who never asked for it, and a sheet left
  // standing would be filed against the wrong person.
  useEffect(() => {
    setSigned(null)
    setFeeChoice('clinic')
    setFeeAmount('')
    setFeeReason('')
    setValidUntil(dateAfter(VALIDITY_DAYS))
    setSupplyInParts(true)
    setValidityReason('')
    setSheet(EMPTY_SHEET)
    setItems([])
    setProfileDraft(EMPTY_PROFILE)
    setHydrated('')
    setDrawer(null)
    setReviewOpen(false)
    setRecoveryOpen(false)
    setRecoveryMessage('')
    setShowMedicinePicker(false)
    setMedicineSearch('')
  }, [patientId])

  /**
   * The sheet is rebuilt from the server-side draft, and only from a record
   * that actually arrived. A failed read leaves what is on screen alone: it
   * would otherwise wipe a half-typed consultation every time the corridor
   * Wi-Fi dropped a refresh.
   */
  useEffect(() => {
    if (!historyReady) return
    if (sourceKey === hydrated) return
    setHydrated(sourceKey)
    if (savedDraft) {
      setSheet(fromSaved(savedDraft))
      setItems(savedDraft.items.map(restoredLine))
    } else {
      setSheet(EMPTY_SHEET)
      setItems([])
    }
    setProfileDraft(clinicalProfile)
  }, [clinicalProfile, historyReady, hydrated, savedDraft, sourceKey])

  /**
   * Focus follows the patient.
   *
   * `Call in` used to leave focus on `<body>`, so the next Tab went to the top
   * of the application and a keyboard or screen-reader user had no idea which
   * patient had opened. It lands on the patient's name, which is the first
   * thing anybody needs to read anyway.
   */
  useEffect(() => {
    if (!patientId) return
    bandHeading.current?.focus()
  }, [patientId])

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
      // `followUpNote` rides in with the rest of the sheet: the draft stores it
      // and `sign_consultation` puts it on the follow-up it creates.
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

  const signProblem = !sheet.diagnosis.trim()
    ? 'Record the diagnosis before signing.'
    : feeProblem

  const attemptProblem = attemptGate === 'checking'
    ? 'The clinic is checking an earlier signing. Wait for that result before signing again.'
    : attemptGate === 'blocked'
      ? 'An earlier signing still needs a doctor’s decision. Check it before signing again.'
      : undefined

  const signDisabledReason = signProblem ?? attemptProblem

  /** What this visit is charged, in words, for the review and the result. */
  const feeWords = feeChoice === 'waive'
    ? `Waived · ${money(0)}`
    : feeChoice === 'override'
      ? (feeAmount.trim() ? `₹${feeAmount.trim()}` : '—')
      : money(clinicFee)

  function applyTemplate(template: ConsultationTemplateView) {
    setSheet({
      ...fromSaved(template),
      followUpDate: template.followUpAfterDays === undefined ? '' : dateAfter(template.followUpAfterDays),
    })
    setItems(template.items.map(restoredLine))
  }

  function repeatPrevious() {
    if (!previous) return
    setSheet({
      ...EMPTY_SHEET,
      complaint: previous.complaint,
      examination: previous.examination,
      diagnosis: previous.diagnosis,
      diagnosisStatus: previous.diagnosisStatus === 'unspecified' ? 'provisional' : previous.diagnosisStatus,
      aetiology: previous.aetiology,
      aetiologyCertainty: previous.aetiologyCertainty,
      notes: previous.notes,
      advice: previous.advice,
    })
    setItems(previousPrescription?.items.map(restoredLine) ?? [])
    setDrawer(null)
  }

  async function favourite(kind: ClinicalPhraseKind, text: string) {
    const result = await run('set_clinical_phrase_favourite', { kind, text, favourite: true })
    if (result.ok) refresh()
  }

  async function saveDraft() {
    const result = await draftTask.run({
      working: 'Saving draft…',
      request: () => run('save_consultation_draft', { ...payload(), draftId: savedDraft?.id }),
      /*
       * Amber, never green. The plan is explicit that a saved-but-unsigned
       * draft is not a completion: nothing has been prescribed, nothing has
       * been charged, and the pharmacy cannot see it.
       */
      confirmed: () => ({
        kind: 'partial' as const,
        title: 'Draft saved · Still unsigned',
        icon: 'draft' as const,
      }),
    })
    if (result?.ok) refresh()
  }

  async function discardDraft() {
    if (!savedDraft) return
    const result = await discardTask.run({
      working: 'Discarding draft…',
      request: () => run('discard_consultation_draft', { draftId: savedDraft.id }),
    })
    if (result?.ok) {
      /*
       * The signing key is deliberately NOT released here.
       *
       * Discarding a draft proves a draft row was deleted. It proves nothing
       * about whether a signing committed — and the sequence that matters is
       * exactly the one where it did: Finish, reply lost, `Outcome not
       * confirmed`, then Save draft, then Discard. Releasing the key on that
       * path lets the next Finish mint a fresh one and write a second
       * encounter, a second invoice and a second consultation fee, which is
       * the ₹600 bill this whole mechanism exists to prevent.
       *
       * The cost of keeping it is a refusal if the doctor then writes a
       * genuinely different consultation for the same patient in the same tab.
       * That is the safe direction to fail in, and the recovery is to check
       * what the clinic actually recorded — which is what the unconfirmed
       * message already asks for.
       */
      setSheet(EMPTY_SHEET)
      setItems([])
      setHydrated('')
      refresh()
    }
  }

  async function saveProfile() {
    const result = await profileTask.run({
      working: 'Saving patient alerts…',
      request: () => run('save_patient_clinical_profile', { patientId, ...profileDraft }),
    })
    if (result?.ok) refresh()
  }

  async function saveTemplate(previousVersion?: ConsultationTemplateView) {
    const title = previousVersion?.title ?? templateTitle.trim()
    const scope = previousVersion?.scope ?? templateScope
    if (!title) return
    const result = await templateTask.run({
      working: 'Saving template…',
      request: () => run('save_clinical_template', {
        ...payload(),
        title,
        scope,
        templateId: previousVersion?.id,
        followUpAfterDays: daysFromToday(sheet.followUpDate),
      }),
    })
    if (result?.ok) {
      setTemplateTitle('')
      refresh()
    }
  }

  async function retireTemplate(templateId: string) {
    const result = await templateTask.run({
      working: 'Retiring template…',
      request: () => run('retire_clinical_template', { templateId }),
    })
    if (result?.ok) refresh()
  }

  /**
   * Sign the consultation.
   *
   * Reviewed first, blocking while it is open, and confirmed only by the
   * clinic: the result layer is built inside `confirmed`, which the task runs
   * exclusively on `ok`. A request that does not come back leaves the review
   * sheet open carrying `Outcome not confirmed`, keeps everything typed, and
   * offers a record check rather than a second signing.
   */
  async function confirmSign() {
    const feeAtSigning = feeWords
    const waivedAtSigning = feeChoice === 'waive'
    /*
     * The attempt names the consultation; the LIVE visit names where the
     * patient is now, and both go.
     *
     * The correction the second acceptance review forced. The attempt used to
     * supply the appointment id too — the one it was opened against — and for
     * a walk-in that is `null` forever. So a doctor who signed from the
     * register, lost the reply, then created today's visit and pressed again
     * got a consultation that succeeded while the visit sat in the queue as
     * `waiting`, attached to nothing. Reproduced on staging in both the
     * committed and the uncommitted direction before this changed.
     *
     * Sending the live value is safe because the server compares the two as a
     * case analysis: naming no visit is compatible with a stored one (the
     * ordinary retry), naming one where none is stored gets its own refusal
     * that the tablet does NOT rotate on, and naming a different one is the
     * only case that means somebody else's consultation.
     */
    const attempt = openConsultationAttempt(patientId, appointment?.id)
    const result = await sign.run({
      working: 'Completing consultation…',
      /*
       * Both visits go, because they answer different questions.
       *
       * `payload()` carries `appointmentId` — the LIVE visit, whatever is on
       * screen — and it is not restated here, because two sources for one
       * field is how they come to disagree. `openedVisitId` is the attempt's
       * own, unchanging record of what this consultation began against, and it
       * is the one that survives the visit disappearing: without it, a visit
       * cancelled between a lost reply and the retry was bypassed and the
       * consultation was written against nothing at all.
       */
      request: () => run('sign_consultation', {
        ...payload(),
        openedVisitId: attempt.visitId ?? undefined,
        idempotencyKey: attempt.key,
      }),
      confirmed: (answer) => {
        const body = answer.data as { prescriptionId?: string; prescriptionNumber?: string; signedAt?: string } | undefined
        const signedAt = body?.signedAt ?? new Date().toISOString()
        setSigned({
          id: body?.prescriptionId ?? '',
          number: body?.prescriptionNumber ?? '',
          signedAt,
          items: body?.prescriptionId ? items : [],
          fee: feeAtSigning,
          waived: waivedAtSigning,
          diagnosis: sheet.diagnosis,
          followUpDate: sheet.followUpDate,
          followUpNote: sheet.followUpNote,
        })
        // Closed in the same batch as the result appears, so the dialog's focus
        // restore happens before the result layer takes focus and `Next
        // patient` is what ends up focused.
        setReviewOpen(false)
        return {
          kind: 'confirmed' as const,
          title: 'Consultation completed',
          identity: `${patient?.name ?? 'Patient'}${appointment ? ` · ${appointment.token}` : ''}`,
          detail: body?.prescriptionNumber
            ? `Prescription ${body.prescriptionNumber} · ${feeAtSigning} to collect at the counter`
            : `No medicines prescribed · ${feeAtSigning} to collect at the counter`,
          facts: [
            { label: 'Prescription', value: body?.prescriptionNumber ?? 'No medicines prescribed' },
            { label: 'Consultation fee', value: feeAtSigning },
            { label: 'Next', value: 'Pharmacy counter' },
          ],
          icon: 'prescription' as const,
          dwell: DWELL_MAJOR,
        }
      },
    })
    /*
     * The attempt is settled here and not inside `confirmed`.
     *
     * `useTask` returns early without running `confirmed` when the panel has
     * unmounted mid-request (`components/ui/task.tsx`), and a doctor stepping
     * back to Today while a slow signing is in flight is exactly the case the
     * attempt was moved out of component state to survive. Released there, a
     * confirmed consultation would leave its attempt behind, and the patient's
     * next genuine consultation would be refused as a mismatched replay.
     *
     * Settled on the response instead, so the rule is the whole rule, and it
     * is one call in `lib/consultation-attempt.ts` rather than a branch here:
     * confirmed by the clinic ends the attempt, and nothing else does.
     */
    const released = settleConsultationAttempt(
      patientId,
      result?.ok
        ? { status: 'confirmed' }
        : result?.unconfirmed
          ? { status: 'unknown' }
          : { status: 'refused', code: result?.code },
    )
    if (result?.ok) {
      setRecoveryAttempt(null)
      setAttemptGate('none')
      setRecoveryMessage('')
      refresh()
      return
    }

    if (!result) {
      // `useTask` can return null only for a duplicate press or an unexpected
      // client failure. Neither is evidence that the attempt ended.
      setRecoveryAttempt(attempt)
      setAttemptGate('blocked')
      return
    }

    if (released || signingRefusalAction(result.code) === 'release') {
      setRecoveryAttempt(null)
      setAttemptGate('none')
      setRecoveryMessage('')
      return
    }

    if (result.unconfirmed || signingRefusalAction(result.code) === 'inspect') {
      setRecoveryAttempt(attempt)
      setAttemptGate('checking')
      setRecoveryMessage(result.message)
      setReviewOpen(false)
      setRecoveryOpen(true)
      return
    }

    // An ordinary refusal changed nothing and kept the same attempt. It is
    // safe to correct the named field and retry under that attempt.
    setAttemptGate('retry')
  }

  /**
   * Record the request, then open the dialogue.
   *
   * ── WHAT THIS STILL CANNOT KNOW ────────────────────────────────────────────
   *
   * A browser is never told whether the paper came out. `window.print()` opens
   * the operating system's dialogue and never reports whether the operator
   * pressed Print or Cancel, whether the tray was empty, or whether the clinic
   * printer was awake. `afterprint` fires either way, so moving the audit there
   * would not make it more accurate — it would only add the case where a real
   * copy goes unrecorded because the event never arrived. Policy register 8
   * requires the audit, so the row is written BEFORE the dialogue opens: the
   * safer error is to hold a copy that was cancelled rather than to miss one
   * that was taken. That ordering is deliberate and must not be changed.
   *
   * So every word on this screen describes a REQUEST that was recorded, never
   * a sheet of paper — the same wording the command and the audit row now use.
   * There is no result layer: the dialogue opens in the same breath and is its
   * own evidence, and what the clinic now holds is stated in the line under the
   * actions, which stays. A count of paper that actually left the printer needs
   * something outside the browser and is named in the handoff.
   */
  async function printPrescription() {
    if (!signed?.id) return
    const result = await printTask.run({
      working: 'Recording the print request…',
      request: () => run('record_prescription_print', { prescriptionId: signed.id }),
    })
    if (!result?.ok) return
    const body = result.data as { copyNumber: number } | undefined
    setSigned((current) => current ? { ...current, copyNumber: body?.copyNumber } : current)
    document.documentElement.dataset.printMode = 'prescription'
    window.addEventListener('afterprint', () => {
      delete document.documentElement.dataset.printMode
    }, { once: true })
    window.setTimeout(() => window.print(), 0)
  }

  function nextPatient() {
    // Belt and braces: a confirmed signing already released it. This covers
    // leaving a result layer that was reached some other way, and it is the
    // one release that is a person saying they are done rather than the clinic
    // confirming anything.
    if (patientId) abandonConsultationAttempt(patientId)
    setSigned(null)
    setSheet(EMPTY_SHEET)
    setItems([])
    setHydrated('')
    select('')
    goTo('queue')
  }

  /** The one panel loading layer for everything that is not the signing. */
  const panelTask = draftTask.busy
    ? draftTask
    : discardTask.busy
      ? discardTask
      : templateTask.busy
        ? templateTask
        : profileTask.busy
          ? profileTask
          : printTask.busy
            ? printTask
            : null

  if (!patient) {
    return (
      <Stack>
        <PageHeader eyebrow="Doctor workspace" title="Consultation" sub="No patient open" />
        <Card variant="record">
          <CardBody className="space-y-4">
            <EmptyState
              title="Call in a patient"
              direction="Call the next person from Today and their case sheet opens here. For an unqueued patient, choose them below."
              action={<Button icon="queue" onClick={() => goTo('queue')}>Go to today’s queue</Button>}
            />
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

  const contextPanel = (
    <PatientContext
      loading={historyLoading}
      failed={historyFailed}
      previous={previous}
      previousPrescription={previousPrescription}
      followUps={historyReady ? record.followUps : []}
      onRetry={refresh}
      onRepeat={repeatPrevious}
      frozen={Boolean(signed)}
    />
  )

  return (
    <Stack>
      <PageHeader eyebrow="Doctor workspace" title="Consultation" sub="One patient · one clinical sheet" />

      {/* ------------------------------------------------- the patient band */}
      <section
        ref={band}
        data-testid="patient-band"
        className="sticky top-0 z-20 -mx-2 border-y border-ink bg-sheet/95 px-3 py-3 shadow-[0_5px_16px_rgba(25,28,25,0.08)] backdrop-blur sm:mx-0 sm:rounded-box sm:border"
        aria-label="Current patient"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {appointment ? <Token code={appointment.token} size="md" active={appointment.status === 'in_consult'} /> : null}
          <div className="min-w-[180px] flex-1">
            <h2
              ref={bandHeading}
              tabIndex={-1}
              data-focus-ring="none"
              className="text-[20px] leading-tight font-semibold"
            >
              {patient.name}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">{patient.age} years · {patient.sex}{patient.phone ? ` · ${patient.phone}` : ''}</p>
          </div>
          <PatientAlerts profile={clinicalProfile} loading={historyLoading} failed={historyFailed} />
          <div className="flex flex-wrap items-center gap-2">
            {/* Below the split, patient context is a drawer off this band. */}
            <Button className="lg:hidden" icon="history" onClick={() => setDrawer('history')}>
              History
            </Button>
            <Button icon="pulse" onClick={() => goTo('vitals')}>Vitals</Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-rule pt-2 text-[12px]">
          <span><b>BP</b> {latestVitals?.bp ?? 'Not measured'}</span>
          <span><b>Temp</b> {latestVitals?.temperature ?? 'Not measured'}</span>
          <span><b>Pulse</b> {latestVitals?.pulse ?? 'Not measured'}</span>
          <span><b>SpO₂</b> {latestVitals?.spo2 ?? 'Not measured'}</span>
          <span><b>Weight</b> {latestVitals?.weight ?? 'Not measured'}</span>

          {/* The draft state belongs on the band, not in a notice that scrolls
              away above a sheet the doctor is still typing into. */}
          <span data-testid="draft-status" className="flex flex-wrap items-center gap-2">
            {signed ? (
              <Badge tone="free">Signed{signed.number ? ` · ${signed.number}` : ''}</Badge>
            ) : savedDraft ? (
              <Badge tone="attn">Draft saved · Still unsigned</Badge>
            ) : historyLoading ? (
              <Badge tone="plain" icon="clock">Reading draft…</Badge>
            ) : historyFailed ? (
              <Badge tone="stop" icon="alert">Draft state unknown</Badge>
            ) : (
              <Badge tone="plain" icon={null}>Nothing saved yet</Badge>
            )}
            {staleDraft ? (
              <Badge tone="stop" icon="alert">
                Older than seven days · review every field
              </Badge>
            ) : null}
          </span>
        </div>

        {abnormalVitals.length ? <p className="mt-2 text-[12px] font-semibold text-stop">Review: {abnormalVitals.join(' · ')}</p> : null}
      </section>

      {/*
        * A record that did not arrive, said as what it is.
        *
        * Everything below — previous visit, allergies, last prescription — is
        * empty because nothing was read, and an empty history beside a
        * prescription pad is a clinical statement. So it is said once, loudly,
        * at the top, and again in every panel that would otherwise look answered.
        */}
      {historyFailed ? (
        <Notice tone="bad">
          This patient’s record could not be read, so allergies, previous visits and any saved
          draft are unknown — not absent. Do not prescribe on the strength of the blanks below.
          <span className="mt-2 block">
            <Button size="sm" icon="history" onClick={refresh}>Try reading the record again</Button>
          </span>
        </Notice>
      ) : null}

      {staleDraft ? (
        <Notice tone="pending">
          A draft from {savedDraft ? formatDate(savedDraft.updatedAt) : 'an earlier visit'} is open and
          is more than seven days old. Review every field before signing.
        </Notice>
      ) : null}

      {signed ? (
        <Notice tone="good">
          Consultation signed{signed.number ? ` as ${signed.number}` : ''}. A signed record cannot be edited.
        </Notice>
      ) : null}

      {/* ------------------------------------------------- the work surface */}
      <div
        data-testid="consult-surface"
        className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_290px] xl:grid-cols-[minmax(0,1fr)_320px]"
      >
        <section className="min-w-0" aria-label="Consultation form">
          <Busy on={Boolean(panelTask)} label={panelTask?.workingLabel ?? ''}>
            <div className="space-y-4">
              {/*
                * Everything a signed record makes immutable, inside one
                * `disabled` fieldset — INCLUDING the two disclosures.
                *
                * They used to sit outside it, so after signing a doctor could
                * still press `Apply` on a template and rewrite the on-screen
                * prescription list underneath a notice reading "A signed record
                * cannot be edited." The screen and the database disagreed, and
                * the screen was the one the doctor was reading.
                */}
              <fieldset disabled={Boolean(signed)} className="contents" aria-label="Clinical content">
                <Card variant="record">
                  <CardBody className="space-y-6 py-5">
                    <section aria-labelledby="history-title">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h2 id="history-title" className="eyebrow">Today’s clinical note</h2>
                        {templates.length ? <span className="text-[12px] text-ink-2">Start from a template below, then review and change it.</span> : null}
                      </div>
                      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_180px]">
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
                      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
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
                      <div>
                        <h2 className="flex items-center gap-2 text-[17px] font-semibold">
                          <Icon name="prescription" size={19} className="text-ink-2" />
                          Prescription
                        </h2>
                        <p className="text-[12px] text-ink-2">Brand or generic, strength and form stay visible at every step.</p>
                      </div>
                      <Button icon="plus" onClick={() => setShowMedicinePicker((open) => !open)}>{showMedicinePicker ? 'Close search' : 'Add medicine'}</Button>
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
                              {/* Live stock, as information. Policy register 39:
                                  it never stops the doctor prescribing. */}
                              <span className="shrink-0 font-mono text-[12px]">
                                {medicine.totalAvailable > 0 ? `Stock ${medicine.totalAvailable}` : 'None on the shelf'}
                              </span>
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
                  <CardBody className="grid grid-cols-1 gap-5 py-5 xl:grid-cols-2">
                    <SuggestField label="Advice to patient" kind="advice" value={sheet.advice} multiline suggestions={suggestions.get('advice') ?? []} onChange={(advice) => patchSheet({ advice })} onFavourite={favourite} />
                    <Field label="Private clinical notes" hint="Not printed on the prescription."><Textarea value={sheet.notes} onChange={(event) => patchSheet({ notes: event.target.value })} /></Field>
                    <Field label="Follow-up date"><Input type="date" value={sheet.followUpDate} onChange={(event) => patchSheet({ followUpDate: event.target.value })} /></Field>
                    <Field
                      label="Follow-up reminder"
                      hint="Kept on the draft with everything else here, and saved onto the follow-up when you sign."
                    >
                      <Input value={sheet.followUpNote} onChange={(event) => patchSheet({ followUpNote: event.target.value })} />
                    </Field>
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
                          <Input inputMode="decimal" value={feeAmount} placeholder={String(clinicFee)} onChange={(event) => setFeeAmount(event.target.value)} />
                        </Field>
                      ) : null}

                      {feeChoice !== 'clinic' ? (
                        <Field
                          label={feeChoice === 'waive' ? 'Why this visit is free' : 'Why the amount is different'}
                          required
                          hint="Kept on the record with your name and the time. A later change to the clinic fee never rewrites this visit."
                        >
                          <Textarea value={feeReason} onChange={(event) => setFeeReason(event.target.value)} rows={2} />
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
                            <Input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
                          </Field>
                          <Field label="May be supplied in parts" hint="Turn this off to require the whole prescription to be handed over in one go.">
                            <Select value={supplyInParts ? 'yes' : 'no'} onChange={(event) => setSupplyInParts(event.target.value === 'yes')}>
                              <option value="yes">Yes — the remainder may be collected later</option>
                              <option value="no">No — supply all of it, or none of it</option>
                            </Select>
                          </Field>
                        </FieldRow>
                        {validityChanged ? (
                          <Field label="Why the validity is being changed" required>
                            <Textarea value={validityReason} onChange={(event) => setValidityReason(event.target.value)} rows={2} />
                          </Field>
                        ) : null}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>

                <Disclosure label="Templates" hint={`${templates.length} available · applied as an editable draft`}>
                  <div className="space-y-4">
                    {historyFailed ? (
                      <p className="text-[13px] font-semibold text-stop">
                        Templates could not be read. This is not “no templates”.
                      </p>
                    ) : templates.length ? (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{templates.map((template) => <div key={template.id} className="border border-rule p-3"><p className="font-semibold">{template.title}</p><p className="text-[12px] text-ink-2">{template.scope} · v{template.version} · {template.ownerDoctorName}</p><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" onClick={() => applyTemplate(template)}>Apply</Button>{template.ownerDoctorId === data.session.staffId || (template.scope === 'clinic' && data.session.canPublishClinicalTemplates) ? <><Button size="sm" onClick={() => saveTemplate(template)}>Save as v{template.version + 1}</Button><Button size="sm" variant="danger" onClick={() => retireTemplate(template.id)}>Retire</Button></> : null}</div></div>)}</div>
                    ) : (
                      <p className="text-[13px] text-ink-2">No templates yet. Save the current sheet below when it is worth reusing.</p>
                    )}
                    <FieldRow>
                      <Field label="Template name"><Input value={templateTitle} onChange={(event) => setTemplateTitle(event.target.value)} /></Field>
                      <Field label="Who can use it"><Select value={templateScope} onChange={(event) => setTemplateScope(event.target.value as 'personal' | 'clinic')}><option value="personal">Only me</option>{data.session.canPublishClinicalTemplates ? <option value="clinic">Every doctor in the clinic</option> : null}</Select></Field>
                    </FieldRow>
                    <ActionButton
                      icon="draft"
                      busy={templateTask.busy}
                      busyLabel={templateTask.workingLabel}
                      disabled={!templateTitle.trim() || (busy && !templateTask.busy)}
                      onClick={() => saveTemplate()}
                    >
                      Save current sheet as template
                    </ActionButton>
                    <TaskFailure failure={templateTask.failure} onDismiss={templateTask.dismiss} />
                  </div>
                </Disclosure>

                <Disclosure label="Patient alerts" hint="Allergies and clinical flags stay visible in the patient band">
                  <div className="space-y-4">
                    {historyFailed ? (
                      <Notice tone="bad">
                        These fields are blank because the record could not be read, not because the
                        patient has no allergies. Read the record before saving over it.
                      </Notice>
                    ) : null}
                    <FieldRow>
                      <Field label="Allergy status"><Select value={profileDraft.allergyStatus} onChange={(event) => setProfileDraft((current) => ({ ...current, allergyStatus: event.target.value as PatientClinicalProfileView['allergyStatus'] }))}><option value="not_recorded">Not recorded</option><option value="no_known">No known allergies</option><option value="known">Known allergy</option></Select></Field>
                      <Field label="Allergy details" required={profileDraft.allergyStatus === 'known'}><Input value={profileDraft.allergyNotes} onChange={(event) => setProfileDraft((current) => ({ ...current, allergyNotes: event.target.value }))} /></Field>
                    </FieldRow>
                    <Field label="Clinical flags"><Input value={profileDraft.clinicalFlags} onChange={(event) => setProfileDraft((current) => ({ ...current, clinicalFlags: event.target.value }))} /></Field>
                    <ActionButton
                      busy={profileTask.busy}
                      busyLabel={profileTask.workingLabel}
                      disabled={busy && !profileTask.busy}
                      onClick={saveProfile}
                    >
                      Save patient alerts
                    </ActionButton>
                    <TaskFailure failure={profileTask.failure} onDismiss={profileTask.dismiss} />
                  </div>
                </Disclosure>
              </fieldset>

              {/* ------------------------------------------------ final actions */}
              <div className="sticky bottom-0 z-20 space-y-2 border-y border-ink bg-sheet/95 p-3 shadow-[0_-5px_16px_rgba(25,28,25,0.08)] backdrop-blur" data-print="hide">
                {recoveryAttempt && attemptGate !== 'none' && canReconcile ? (
                  <div className="space-y-2">
                    <Notice tone={attemptGate === 'retry' ? 'good' : 'pending'}>
                      <span>
                        <span className="font-semibold">
                          {attemptGate === 'retry'
                            ? 'The earlier attempt recorded nothing.'
                            : 'An earlier signing must be checked first.'}
                        </span>{' '}
                        {attemptGate === 'retry'
                          ? 'You may sign this same sheet now; the clinic will use the held attempt.'
                          : 'Do not start again until the clinic confirms what happened.'}
                      </span>
                    </Notice>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-11"
                      onClick={() => setRecoveryOpen(true)}
                    >
                      Check earlier signing
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {signed ? (
                    <>
                      {signed.id ? (
                        <ActionButton
                          ref={afterSign}
                          variant="primary"
                          icon="printer"
                          busy={printTask.busy}
                          busyLabel={printTask.workingLabel}
                          disabled={busy && !printTask.busy}
                          onClick={printPrescription}
                        >
                          Print prescription
                        </ActionButton>
                      ) : null}
                      <Button icon="clipboard" onClick={() => setDrawer('summary')}>View summary</Button>
                      <Button variant="primary" icon="queue" onClick={nextPatient}>Next patient</Button>
                    </>
                  ) : (
                    <>
                      <ActionButton
                        ref={afterSign}
                        variant="primary"
                        icon="prescription"
                        disabled={Boolean(signDisabledReason) || (busy && !sign.busy)}
                        disabledReason={signDisabledReason}
                        onClick={() => { sign.dismiss(); setReviewOpen(true) }}
                      >
                        Review &amp; sign
                      </ActionButton>
                      <ActionButton
                        icon="draft"
                        busy={draftTask.busy}
                        busyLabel={draftTask.workingLabel}
                        disabled={busy && !draftTask.busy}
                        onClick={saveDraft}
                      >
                        Save draft
                      </ActionButton>
                      {/* The button-level confirmation the plan asks for: it
                          appears on the control that was pressed, says the draft
                          is still unsigned, and goes by itself. The badge in the
                          patient band is what stays. */}
                      {draftTask.outcome ? (
                        <span
                          role="status"
                          className="flex items-center gap-1.5 text-[13px] font-semibold text-attn"
                        >
                          <Icon name="check" size={17} />
                          {draftTask.outcome.title}
                        </span>
                      ) : null}
                      {savedDraft ? (
                        <ActionButton
                          variant="danger"
                          busy={discardTask.busy}
                          busyLabel={discardTask.workingLabel}
                          disabled={busy && !discardTask.busy}
                          onClick={discardDraft}
                        >
                          Discard draft
                        </ActionButton>
                      ) : null}
                    </>
                  )}
                </div>

                {signed ? (
                  <p className="text-[12px] text-ink-2">
                    {signed.waived
                      ? 'Waived — recorded as ₹0 with your reason. The visit has gone to the pharmacy counter.'
                      : `${signed.fee} is waiting at the pharmacy counter for this patient.`}
                    {signed.copyNumber ? (
                      <span className="mt-1 block">
                        {signed.copyNumber === 1 ? 'Print requested' : 'Reprint requested'} — copy{' '}
                        {signed.copyNumber} recorded. That is what the clinic now holds: every request
                        is audited, including one cancelled at the printer dialog, so the number counts
                        requests and not sheets of paper.
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[12px] text-ink-2">
                      {feeChoice === 'waive'
                        ? 'Waived — recorded as ₹0 with your reason. The visit still goes to Pharmacy.'
                        : feeChoice === 'override'
                          ? `₹${feeAmount || '—'} goes to Pharmacy with the patient, instead of the clinic’s ${money(clinicFee)}.`
                          : `${money(clinicFee)} goes to Pharmacy with the patient, medicine or no medicine.`}
                    </p>
                    {staleDraft ? (
                      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-attn">
                        <Icon name="alert" size={16} />
                        This draft is more than seven days old. Review every field before signing.
                      </p>
                    ) : null}
                    {signDisabledReason ? <p className="text-[12px] font-semibold text-stop">{signDisabledReason}</p> : null}
                  </div>
                )}

                {/* A refusal or an unconfirmed signing, where the action was
                    taken — unless the review sheet is still open, which carries
                    it on its own surface instead. */}
                {reviewOpen ? null : <TaskFailure failure={sign.failure} onDismiss={sign.dismiss} />}
                <TaskFailure failure={draftTask.failure} onDismiss={draftTask.dismiss} />
                <TaskFailure failure={discardTask.failure} onDismiss={discardTask.dismiss} />
                <TaskFailure failure={printTask.failure} onDismiss={printTask.dismiss} />
              </div>
            </div>
          </Busy>
        </section>

        {/*
          * Patient context, beside the work from 1024px up.
          *
          * The split was `xl` — 1280px — which the clinic's 1024×768 tablet
          * never reaches, so the column this layout exists for was on nobody's
          * screen. Below the split the same content is one tap away in a drawer
          * off the patient band, and the identity and the final actions stay
          * where they are.
          */}
        <aside
          className="space-y-4 lg:sticky lg:self-start"
          style={{ top: bandHeight ? bandHeight + 12 : undefined }}
        >
          <Card data-testid="patient-history" className="hidden lg:block">
            <CardBody className="py-4">{contextPanel}</CardBody>
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

      {/* --------------------------------------------------- history drawer */}
      <Drawer
        open={drawer === 'history'}
        onClose={() => setDrawer(null)}
        title="Patient history"
        sub={`${patient.name} · ${patient.age} years`}
        width="md"
      >
        <div data-testid="history-drawer">{contextPanel}</div>
      </Drawer>

      {/* --------------------------------------------------- signed summary */}
      <Drawer
        open={drawer === 'summary'}
        onClose={() => setDrawer(null)}
        title="Consultation summary"
        sub={signed?.number || 'No medicines prescribed'}
        width="md"
      >
        <div data-testid="consult-summary" className="space-y-3">
          {signed ? (
            <dl>
              <ReviewRow label="Patient">
                {patient.name} · {patient.age} years{appointment ? ` · ${appointment.token}` : ''}
              </ReviewRow>
              <ReviewRow label="Signed">{formatDate(signed.signedAt)}</ReviewRow>
              <ReviewRow label="Diagnosis">{signed.diagnosis}</ReviewRow>
              <ReviewRow label="Prescription">
                {signed.number ? signed.number : 'No medicines prescribed'}
              </ReviewRow>
              <ReviewRow label="Medicines">
                {signed.items.length ? (
                  <ol className="space-y-1.5">
                    {signed.items.map((item) => (
                      <li key={item.key}>
                        <b>{item.medicineName} · {item.dosageForm}</b>
                        <span className="block text-[13px] text-ink-2">{directions(item)}</span>
                        <span className="block font-mono text-[13px]">Qty {item.quantity} {item.quantityUnit}</span>
                      </li>
                    ))}
                  </ol>
                ) : 'None'}
              </ReviewRow>
              <ReviewRow label="Consultation fee">{signed.fee} · payable at the counter</ReviewRow>
              <ReviewRow label="Follow-up">
                {signed.followUpDate ? formatDay(signed.followUpDate) : 'None recorded'}
                {signed.followUpNote ? <span className="block text-[13px] text-ink-2">{signed.followUpNote}</span> : null}
              </ReviewRow>
            </dl>
          ) : (
            <p className="text-[13px] text-ink-2">Nothing has been signed for this patient yet.</p>
          )}
        </div>
      </Drawer>

      {/* ----------------------------------------- safe attempt recovery */}
      <ConsultationReconciliation
        open={recoveryOpen}
        patientId={patientId}
        patientName={patient.name}
        liveVisitId={appointment?.id}
        attempt={recoveryAttempt}
        canReconcile={canReconcile}
        run={run}
        initialMessage={recoveryMessage}
        onClose={() => {
          setRecoveryOpen(false)
          setRecoveryMessage('')
          if (attemptGate === 'none') setRecoveryAttempt(null)
        }}
        onGateChange={setAttemptGate}
        onReleased={releaseRecoveryGate}
        onAlreadyResolved={showRecordedRecovery}
      />

      {/* ------------------------------------------------------ review sheet */}
      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Review before signing"
        sub={`${patient.name}${appointment ? ` · ${appointment.token}` : ''}`}
        busy={sign.busy}
        busyLabel={sign.workingLabel}
        wide
        footer={
          sign.failure?.kind === 'unknown' ? (
            <Button
              variant="secondary"
              icon="history"
              onClick={() => { sign.dismiss(); refresh() }}
            >
              Check the record first
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setReviewOpen(false)}>Back to the sheet</Button>
              <ActionButton
                variant="primary"
                icon="prescription"
                busy={sign.busy}
                busyLabel="Completing consultation…"
                disabled={Boolean(signDisabledReason)}
                disabledReason={signDisabledReason}
                onClick={confirmSign}
              >
                Sign &amp; finish
              </ActionButton>
            </>
          )
        }
      >
        <div data-testid="review-sheet" className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Signing makes the clinical record immutable and sends the fee to the pharmacy counter.
            Read it once.
          </p>

          {historyFailed ? (
            <Notice tone="bad">
              This patient’s record could not be read, so their allergies are unknown to this tablet.
            </Notice>
          ) : clinicalProfile.allergyStatus === 'known' ? (
            <Notice tone="bad">Known allergy: {clinicalProfile.allergyNotes}</Notice>
          ) : clinicalProfile.allergyStatus === 'not_recorded' && items.length > 0 ? (
            <Notice tone="pending">
              No allergy status has been recorded for this patient and medicines are being prescribed.
            </Notice>
          ) : null}

          {sign.failure ? <TaskFailure failure={sign.failure} /> : null}

          <dl>
            <ReviewRow label="Patient">
              {patient.name} · {patient.age} years · {patient.sex}
              {appointment ? ` · ${appointment.token}` : ''}
            </ReviewRow>
            <ReviewRow label="Complaint">
              {sheet.complaint || 'Not recorded'}
              {sheet.complaintDurationValue
                ? ` · ${sheet.complaintDurationValue} ${sheet.complaintDurationUnit}${Number(sheet.complaintDurationValue) === 1 ? '' : 's'}`
                : ''}
            </ReviewRow>
            <ReviewRow label="Examination">{sheet.examination || 'Not recorded'}</ReviewRow>
            <ReviewRow label="Diagnosis">
              <b>{sheet.diagnosis || 'Not recorded'}</b>
              <span className="block text-[13px] text-ink-2">{sheet.diagnosisStatus}</span>
            </ReviewRow>
            <ReviewRow label="Medicines">
              {items.length ? (
                <ol className="space-y-1.5">
                  {items.map((item) => (
                    <li key={item.key}>
                      <b>{item.medicineName} · {item.dosageForm}</b>
                      <span className="block text-[13px] text-ink-2">{directions(item)}</span>
                      <span className="block font-mono text-[13px]">Qty {item.quantity} {item.quantityUnit}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                'No medicines prescribed'
              )}
            </ReviewRow>
            {items.length ? (
              <ReviewRow label="Supply">
                Valid until {formatDay(validUntil)} ·{' '}
                {supplyInParts ? 'may be supplied in parts' : 'all of it, or none of it'}
              </ReviewRow>
            ) : null}
            <ReviewRow label="Advice">{sheet.advice || 'Not recorded'}</ReviewRow>
            <ReviewRow label="Follow-up">
              {sheet.followUpDate ? formatDay(sheet.followUpDate) : 'None'}
              {sheet.followUpNote ? <span className="block text-[13px] text-ink-2">{sheet.followUpNote}</span> : null}
            </ReviewRow>
            <ReviewRow label="Consultation fee">
              <b>{feeWords}</b>
              <span className="block text-[13px] text-ink-2">
                Collected at the pharmacy counter, medicine or no medicine.
                {feeChoice !== 'clinic' && feeReason.trim() ? ` Reason: ${feeReason.trim()}` : ''}
              </span>
            </ReviewRow>
          </dl>
        </div>
      </Modal>

      {/* ------------------------------------------------- confirmed result */}
      {sign.outcome ? (
        <div data-testid="consult-result" className="contents">
          <TaskResult
            outcome={sign.outcome}
            onDismiss={sign.dismiss}
            next={{ label: 'Next patient', onPress: nextPatient }}
            returnFocusTo={afterSign}
          />
        </div>
      ) : null}

      {signed?.id ? <PrintPrescription data={data} patient={patient} signed={signed} /> : null}
    </Stack>
  )
}
