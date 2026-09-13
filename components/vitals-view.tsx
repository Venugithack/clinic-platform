'use client'

import { useRef, useState } from 'react'
import type { ClinicSnapshot, PatientView, VitalReviewRuleView, VitalView } from '@/lib/types'
import type { ActionRunner } from './clinic-context'
import { navigationFor } from './navigation'
import {
  ActionButton,
  Busy,
  DWELL_ROUTINE,
  Field,
  Input,
  Notice,
  Numpad,
  TaskFailure,
  formatDate,
  useTask,
} from '@/components/ui'

/**
 * How a set of readings is shown and taken, wherever it is shown and taken.
 *
 * These were private to `care-workspaces.tsx` until the nurse's Due-now list
 * needed the same five figures under the same rule. They are extracted rather
 * than copied because the rule they carry is a clinical safeguard, and two
 * implementations of a safeguard is one implementation and one liability.
 *
 * The entry pad moved here for the same reason. It is the Vitals station AND
 * the drawer the nurse opens from her round without losing the list she is
 * working through, and those two must never drift into disagreeing about what
 * an untaken reading is.
 */

/**
 * A reading as it was recorded, or nothing at all.
 *
 * An absent reading is NOT MEASURED and must never render as a blank cell or
 * as a zero. A blank reads as "the screen is broken" and a zero reads as a
 * measurement, and the second one is the dangerous one: a temperature of 0
 * that nobody took is indistinguishable from one that somebody did.
 */
export function reading(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

/**
 * The stations this person actually has in their own rail.
 *
 * `Call in` opens Consult, and Consult is the doctor's screen — the same
 * button on the nurse's queue must not walk her into a form only a doctor may
 * sign, on a screen her rail does not even list. The navigation already knows
 * who has what, so ask it rather than re-deciding it here from the roles.
 */
export function stationsOf(data: ClinicSnapshot): Set<string> {
  return new Set(navigationFor(data.session.roles).map((item) => item.id))
}

/** The words that stand in for a reading nobody took. */
export function NotMeasured({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={`text-ink-2 ${size === 'lg' ? 'text-[14px]' : 'text-[13px]'}`}>
      Not measured
    </span>
  )
}

/**
 * Which of the clinic's approved review prompts this set of readings trips.
 *
 * The rules are the clinic's, held server-side and sent to care roles only.
 * Nothing here decides that a reading is abnormal on its own.
 */
export function reviewWarnings(
  vital: Pick<VitalView, 'bp' | 'temperature' | 'pulse' | 'spo2' | 'weight'>,
  age: number | undefined,
  rules: VitalReviewRuleView[],
): string[] {
  if (age === undefined) return []
  const [systolic, diastolic] = String(vital.bp ?? '').split('/').map(Number)
  const values: Record<VitalReviewRuleView['metric'], number | undefined> = {
    systolic: Number.isFinite(systolic) ? systolic : undefined,
    diastolic: Number.isFinite(diastolic) ? diastolic : undefined,
    temperature: vital.temperature === undefined ? undefined : Number(vital.temperature),
    pulse: vital.pulse === undefined ? undefined : Number(vital.pulse),
    spo2: vital.spo2 === undefined ? undefined : Number(vital.spo2),
    weight: vital.weight === undefined ? undefined : Number(vital.weight),
  }
  return [...new Set(rules.filter((rule) => {
    const value = values[rule.metric]
    if (value === undefined || age < rule.minimumAge || (rule.maximumAge !== undefined && age > rule.maximumAge)) return false
    return (rule.minimumValue !== undefined && value < rule.minimumValue) ||
      (rule.maximumValue !== undefined && value > rule.maximumValue)
  }).map((rule) => rule.prompt))]
}

export type ReadingKey = 'bp' | 'temperature' | 'pulse' | 'spo2' | 'weight'

/**
 * The five readings, in the order they are taken at the door.
 *
 * One list, used by the pad that takes them, the strip that shows them and the
 * due list that says which are missing — so a reading cannot be added in one
 * place and go unnoticed in another.
 *
 * `keypad` says which extra key this reading needs beside the digits: a slash
 * for a blood pressure, a decimal point for a temperature or a weight, and
 * nothing at all for a pulse or an SpO₂, which are whole numbers.
 *
 * `limit` is a transcription guard rather than a clinical range — the clinic
 * server range-checks every reading it is actually given. It exists so a key
 * held down does not produce a nine-digit pulse.
 */
export const READINGS: Array<{
  key: ReadingKey
  label: string
  /** The column heading, on a strip or a due row where there is no room. */
  short: string
  unit: string
  keypad: 'bp' | 'decimal' | 'whole'
  limit: number
}> = [
  { key: 'bp', label: 'Blood pressure', short: 'BP', unit: 'mmHg', keypad: 'bp', limit: 7 },
  { key: 'temperature', label: 'Temperature', short: 'Temp', unit: '°C', keypad: 'decimal', limit: 5 },
  { key: 'pulse', label: 'Pulse', short: 'Pulse', unit: '/min', keypad: 'whole', limit: 3 },
  { key: 'spo2', label: 'SpO₂', short: 'SpO₂', unit: '%', keypad: 'whole', limit: 3 },
  { key: 'weight', label: 'Weight', short: 'Weight', unit: 'kg', keypad: 'decimal', limit: 5 },
]

/** Which of the five this set is missing, by name, for a due list to say so. */
export function missingReadings(vital: VitalView | undefined): string[] {
  if (!vital) return READINGS.map((item) => item.short)
  return READINGS.filter((item) => !reading(vital[item.key])).map((item) => item.short)
}

/**
 * The vitals strip — five figures a doctor reads in one glance before saying
 * anything. Every one is mono and labelled, because the label is printed on
 * the case sheet and the figure is written onto it.
 *
 * Since readings became optional this strip has a second job: saying which of
 * the five is missing, and carrying the recorder's own reason for it.
 */
export function VitalStrip({
  vital,
  age,
  rules = [],
  size = 'sm',
}: {
  vital: VitalView
  age?: number
  rules?: VitalReviewRuleView[]
  size?: 'sm' | 'lg'
}) {
  const warnings = reviewWarnings(vital, age, rules)
  const cells = READINGS.map((item) => ({
    label: item.short,
    value: vital[item.key],
    unit: item.unit,
  }))
  return (
    <div className="min-w-0">
      <dl className={`flex flex-wrap ${size === 'lg' ? 'gap-x-8 gap-y-3' : 'gap-x-5 gap-y-2'}`}>
        {cells.map((cell) => {
          const taken = reading(cell.value)
          return (
            <div key={cell.label}>
              <dt className="eyebrow">{cell.label}</dt>
              <dd
                className={`mt-0.5 ${
                  taken
                    ? `font-mono tabular-nums ${size === 'lg' ? 'text-[18px]' : 'text-[15px]'}`
                    : ''
                }`}
              >
                {taken ? (
                  <>
                    {taken}
                    <span className="ml-1 text-[12px] text-ink-2">{cell.unit}</span>
                  </>
                ) : (
                  <NotMeasured size={size} />
                )}
              </dd>
            </div>
          )
        })}
      </dl>
      {vital.notMeasuredNote ? (
        <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{vital.notMeasuredNote}</p>
      ) : null}
      {warnings.length ? (
        <ul className="mt-2 space-y-1" aria-label="Abnormal vital warnings">
          {warnings.map((warning) => (
            <li key={warning} className="text-[13px] font-semibold text-stop">
              Review: {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════ taking the readings */

const NOTHING_TAKEN: Record<ReadingKey, string> = {
  bp: '',
  temperature: '',
  pulse: '',
  spo2: '',
  weight: '',
}

/** Matches the pad's own keys, because these sit directly under them. */
const PAD_KEY =
  'tabular h-14 rounded-box border border-rule bg-sheet text-2xl font-medium text-ink active:bg-paper-2 disabled:opacity-40'

/**
 * The pad the readings are actually taken on.
 *
 * Two screens mount this. The Vitals station gives it a whole workspace, side
 * by side with the pad on a landscape tablet. The nurse's round opens it in a
 * drawer over the Due-now list, so the rest of what is outstanding stays on
 * screen behind the patient she is standing in front of — which is the plan's
 * rule for where supporting context lives.
 *
 * ── WHY THE TASK IS A PROP ─────────────────────────────────────────────────
 *
 * The `useTask` that carries the save belongs to whoever mounted this, not to
 * this. In the drawer the save finishes by closing the drawer, which unmounts
 * this component — and a result owned by a component that has just unmounted is
 * a result nobody ever sees. The list behind the drawer holds it instead, shows
 * `Vitals saved`, and lets it go by itself two seconds later.
 */
export function VitalsEntry({
  data,
  run,
  patient,
  task,
  layout = 'wide',
  onSaved,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  patient: PatientView
  task: ReturnType<typeof useTask>
  /** `wide` puts the pad beside the readings; `narrow` stacks it in a drawer. */
  layout?: 'wide' | 'narrow'
  /** Called only after the clinic confirmed the record. */
  onSaved?: () => void
}) {
  const [values, setValues] = useState(NOTHING_TAKEN)
  const [active, setActive] = useState<ReadingKey>('bp')
  const [note, setNote] = useState('')

  /**
   * Readings belong to the patient they were taken from, and to nobody else.
   *
   * This screen kept whatever had been typed when the clinic's selected patient
   * changed underneath it — and the selection can change from four places
   * without this panel being touched: the chooser at the bottom of the Vitals
   * station, the `Vitals` button on a queue row, a row on the nurse's round,
   * and `Call in` on another tablet. So a nurse could type 138/86 for the
   * patient in front of her, be moved to another patient by any of those, press
   * `Save vitals`, and file one person's blood pressure against another
   * person's record. Nothing downstream could ever tell.
   *
   * Clearing on a patient change loses at most a few digits that are still on
   * the cuff in front of the person typing them. The alternative loses a
   * clinical fact into the wrong chart.
   */
  const forPatient = useRef(patient.id)
  if (forPatient.current !== patient.id) {
    forPatient.current = patient.id
    setValues(NOTHING_TAKEN)
    setNote('')
    setActive('bp')
  }

  const appointment = data.appointments.find(
    (item) =>
      item.patientId === patient.id && item.status !== 'done' && item.status !== 'cancelled',
  )
  const previous = data.vitals.find((item) => item.patientId === patient.id)
  const entering = READINGS.find((item) => item.key === active) ?? READINGS[0]
  const taken = READINGS.filter((item) => values[item.key].trim() !== '')
  const absent = READINGS.filter((item) => values[item.key].trim() === '')
  const liveWarnings = reviewWarnings(
    {
      bp: values.bp || undefined,
      temperature: values.temperature ? Number(values.temperature) : undefined,
      pulse: values.pulse ? Number(values.pulse) : undefined,
      spo2: values.spo2 ? Number(values.spo2) : undefined,
      weight: values.weight ? Number(values.weight) : undefined,
    },
    patient.age,
    data.vitalReviewRules,
  )

  function press(character: string) {
    setValues((current) => {
      const soFar = current[entering.key]
      // One separator, never at the start: '120//80' and '.5' are not readings.
      if (character === '/' || character === '.') {
        if (soFar === '' || soFar.includes('/') || soFar.includes('.')) return current
      }
      if (soFar.length >= entering.limit) return current
      return { ...current, [entering.key]: soFar + character }
    })
  }

  function backspace() {
    setValues((current) => ({ ...current, [entering.key]: current[entering.key].slice(0, -1) }))
  }

  /** Marking a reading not measured is the same act as clearing it: no value. */
  function notMeasured(key: ReadingKey) {
    setValues((current) => ({ ...current, [key]: '' }))
  }

  async function save() {
    // Read once, before the await. The panel is inert while the request is open
    // so nothing can change underneath, and the result then names exactly what
    // was sent rather than whatever the form holds when the answer lands.
    const entered = { ...values }
    const enteredNote = note
    const notTaken = absent.map((item) => item.label)
    const sent = taken.map((item) => ({
      label: item.label,
      value: `${entered[item.key]} ${item.unit}`,
    }))

    const result = await task.run({
      working: 'Saving vitals…',
      // Every reading goes up, and the empty ones go up empty. The clinic
      // server reads '' as NOT MEASURED and stores a NULL; sending 0 for a
      // reading nobody took is the thing this whole screen exists to prevent.
      request: () =>
        run('add_vitals', { patientId: patient.id, ...entered, notMeasuredNote: enteredNote }),
      confirmed: () => ({
        kind: 'confirmed' as const,
        title: 'Vitals saved',
        identity: appointment ? `${patient.name} · ${appointment.token}` : patient.name,
        detail:
          notTaken.length === 0
            ? 'All five readings taken'
            : `Not taken: ${notTaken.join(', ')}`,
        facts: sent,
        icon: 'pulse' as const,
        dwell: DWELL_ROUTINE,
      }),
    })

    // Only a confirmed record clears the pad. A refusal and a lost answer both
    // keep every typed digit, because in the second case nobody yet knows
    // whether the clinic has them.
    if (result?.ok) {
      setValues(NOTHING_TAKEN)
      setNote('')
      setActive('bp')
      onSaved?.()
    }
  }

  const columns =
    layout === 'wide' ? 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]' : 'grid-cols-1'

  return (
    <div data-testid="vitals-entry" className="space-y-3">
      <Busy on={task.busy} label={task.workingLabel}>
        <div className="space-y-4">
          {previous ? (
            <div className="border-b border-rule pb-3">
              <p className="eyebrow mb-1.5">
                Last reading · {formatDate(previous.recordedAt)} · {previous.recordedBy}
              </p>
              <VitalStrip vital={previous} age={patient.age} rules={data.vitalReviewRules} />
            </div>
          ) : (
            <p className="text-[13px] text-ink-2">
              No reading has ever been recorded for {patient.name}.
            </p>
          )}

          <div className={`grid gap-4 ${columns}`}>
            <div className="space-y-2">
              {READINGS.map((item) => {
                const on = item.key === active
                const value = values[item.key]
                return (
                  <div key={item.key} className="flex items-stretch gap-2">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setActive(item.key)}
                      className={`flex min-h-[56px] min-w-0 flex-1 items-center justify-between gap-3 rounded-box border px-3 text-left ${
                        on ? 'border-l-4 border-ink bg-active-wash' : 'border-rule bg-sheet'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="eyebrow block">{item.label}</span>
                        {/* A non-breaking space when this row is not the one
                            being typed into, so the row never changes height
                            under the thumb that is aiming at the next one. */}
                        <span className="mt-0.5 block text-[11px] text-ink-2">
                          {on ? 'Entering now' : ' '}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        {value ? (
                          <>
                            <span className="font-mono text-[20px] tabular-nums">{value}</span>
                            <span className="ml-1 font-mono text-[12px] text-ink-2">
                              {item.unit}
                            </span>
                          </>
                        ) : (
                          <NotMeasured />
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={value === ''}
                      aria-label={`${item.label} not measured`}
                      onClick={() => notMeasured(item.key)}
                      className={`min-h-[56px] w-[92px] shrink-0 rounded-box border px-2 text-[11px] leading-tight font-semibold ${
                        value === ''
                          ? 'border-ink bg-ink text-paper'
                          : 'border-rule bg-sheet text-ink-2'
                      }`}
                    >
                      Not measured
                    </button>
                  </div>
                )
              })}
            </div>

            {/* The pad, not the device keyboard. On a 10" tablet the OS
                keyboard covers the field being filled in, and it is half a
                screen of furniture to type one number (`docs/reference/TABLET.md` §4). */}
            <div className="rounded-box border border-rule bg-paper/40 p-3">
              <p className="eyebrow">Entering</p>
              <p className="mt-1 text-[15px] font-semibold">
                {entering.label}{' '}
                <span className="font-mono text-[12px] font-normal text-ink-2">
                  {entering.unit}
                </span>
              </p>
              <p
                className="mt-2 min-h-[34px] font-mono text-[26px] tabular-nums"
                aria-live="polite"
              >
                {values[entering.key] || <NotMeasured size="lg" />}
              </p>

              <div className="mt-2">
                <Numpad onDigit={press} onBackspace={backspace} />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3">
                {entering.keypad === 'whole' ? (
                  <span aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    onClick={() => press(entering.keypad === 'bp' ? '/' : '.')}
                    aria-label={entering.keypad === 'bp' ? 'Over' : 'Decimal point'}
                    className={PAD_KEY}
                  >
                    {entering.keypad === 'bp' ? '/' : '.'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => notMeasured(entering.key)}
                  className="col-span-2 h-14 rounded-box border border-rule bg-sheet text-[12px] font-semibold text-ink-2 active:bg-paper-2"
                >
                  Not measured
                </button>
              </div>
            </div>
          </div>

          <Field
            label="Why a reading is missing"
            hint="Only when something could not be taken — “No oximeter in the cabin”. It is filed with the reading."
          >
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          </Field>

          {liveWarnings.length ? (
            <Notice tone="bad">
              <span className="font-semibold">Review before saving:</span>{' '}
              {liveWarnings.join(' · ')}
            </Notice>
          ) : null}

          {/* In a drawer the pad is taller than the panel, so the one action
              that finishes the job stays on screen while the readings scroll. */}
          <div
            className={
              layout === 'narrow' ? 'sticky bottom-0 -mx-1 bg-sheet px-1 pt-2 pb-1' : ''
            }
          >
            <ActionButton
              variant="primary"
              className="min-h-[56px] w-full sm:w-auto"
              busy={task.busy}
              busyLabel={task.workingLabel}
              disabled={taken.length === 0}
              disabledReason="Record at least one reading."
              icon="pulse"
              onClick={save}
            >
              Save vitals
            </ActionButton>
          </div>
        </div>
      </Busy>

      {/* Outside the busy layer, because it is what is left when the busy layer
          goes — and neither a refusal nor a lost answer ever dismisses itself. */}
      <TaskFailure failure={task.failure} onDismiss={task.dismiss} />
    </div>
  )
}
