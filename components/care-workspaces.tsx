'use client'

import { useState, type FormEvent } from 'react'
import type { AppointmentView, ClinicSnapshot, PrescriptionItemView } from '@/lib/types'
import { useBusy, useSelectedPatient, type ActionRunner } from './clinic-context'
import { usePatientRecord } from './use-patient-record'
import {
  NotMeasured,
  VitalStrip,
  VitalsEntry,
  reading,
  stationsOf,
} from './vitals-view'
import { ClinicLetterhead, Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
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
  TaskFailure,
  TaskResult,
  Textarea,
  Token,
  formatDate,
  useTask,
  words,
} from '@/components/ui'

const TONE = {
  waiting: 'attn',
  in_consult: 'live',
  done: 'free',
  cancelled: 'plain',
} as const

/**
 * The one primary action on a care screen is pressed with a thumb while the
 * patient is standing there, so it is 56px rather than the 48px this system
 * gives an ordinary control (`docs/reference/TABLET.md` §2, rule 2).
 */
const PRIMARY = 'min-h-[56px]'


/**
 * Who this screen is working on.
 *
 * The queue comes first because on an ordinary day the answer is somebody who
 * is already in it; the whole register sits underneath for the patient who
 * walked in without a token. Choosing here changes the clinic's selection, not
 * this screen's — the point of the shared selection is that the next screen
 * already knows.
 */
function PatientChooser({
  data,
  label = 'Work on a different patient',
  hint,
}: {
  data: ClinicSnapshot
  label?: string
  hint?: string
}) {
  const { patientId, select } = useSelectedPatient()
  const queued = data.appointments.filter(
    (item) => item.status === 'waiting' || item.status === 'in_consult',
  )
  const inQueue = new Set(queued.map((item) => item.patientId))

  return (
    <Field label={label} hint={hint}>
      <Select value={patientId} onChange={(event) => select(event.target.value)}>
        <option value="">Choose patient</option>
        {queued.length > 0 ? (
          <optgroup label="In the queue today">
            {queued.map((appointment) => (
              <option key={appointment.id} value={appointment.patientId}>
                {appointment.token} · {appointment.patientName}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Everyone on the register">
          {data.patients
            .filter((patient) => !inQueue.has(patient.id))
            .map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name}, {patient.age}
              </option>
            ))}
        </optgroup>
      </Select>
    </Field>
  )
}

/**
 * One patient's line on today's queue, and its own idea of being busy.
 *
 * The busy state used to be the tablet's: one boolean published by the shell,
 * read by every control on the screen. So `Call in` on row two put `…` on rows
 * one and three as well, and the operator standing at the door could not tell
 * which of three identical spinners belonged to the patient she had just
 * called. The row owns the task now, so the label is on the button that was
 * pressed and nowhere else.
 *
 * Calling a patient in is navigation, not a completion: it leads to the
 * consultation rather than finishing anything, so it earns a present-tense
 * label and no result overlay. The evidence is the row turning `In consult`.
 */
function QueueRow({
  appointment,
  data,
  run,
  stations,
  open,
  onOpenPatient,
}: {
  appointment: AppointmentView
  data: ClinicSnapshot
  run: ActionRunner
  stations: Set<string>
  /** Whether the clinic's selection is currently this patient. */
  open: boolean
  onOpenPatient: (patientId: string, view: 'consultation' | 'vitals') => void
}) {
  const tabletBusy = useBusy()
  const task = useTask()
  const vital = data.vitals.find((item) => item.patientId === appointment.patientId)
  const age = data.patients.find((item) => item.id === appointment.patientId)?.age
  const live = appointment.status === 'in_consult'
  const finished = appointment.status === 'done'

  /**
   * Marking the queue AND opening the patient, in that order.
   *
   * It used to set `in_consult` and stop there, which left the doctor to walk
   * to Consult himself and find an empty screen with an all-patient dropdown on
   * it — the same name, chosen a second time, from a list of everybody the
   * clinic has ever registered, with the patient already sitting down.
   *
   * The selection is only made once the clinic has agreed the status changed.
   * Opening a consultation for somebody the queue refused to call in would be a
   * screen that disagrees with the tablet in the next room.
   */
  async function callIn() {
    const result = await task.run({
      working: 'Opening consultation…',
      request: () => run('set_appointment_status', { appointmentId: appointment.id, status: 'in_consult' }),
      // No result overlay: nothing was completed, and the next screen is about
      // to be the whole answer.
      confirmed: () => null,
    })
    if (result?.ok) onOpenPatient(appointment.patientId, 'consultation')
  }

  async function markDone() {
    await task.run({
      working: 'Marking done…',
      request: () => run('set_appointment_status', { appointmentId: appointment.id, status: 'done' }),
      confirmed: () => null,
    })
  }

  /** Why every other control on the tablet is refused while one is in flight. */
  const elsewhere = tabletBusy && !task.busy ? 'Another action is being saved.' : undefined

  return (
    <Card variant={live ? 'record' : 'panel'} data-testid={`queue-row-${appointment.patientId}`}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
        <Token code={appointment.token} size="md" active={live} />

        <div className="min-w-[180px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[16px] font-semibold [overflow-wrap:anywhere]">
              {appointment.patientName}
            </p>
            <Badge tone={TONE[appointment.status]}>{words(appointment.status)}</Badge>
            {/* Which patient the tablet is holding open, in a word.
                Every other screen follows this one. */}
            {open ? <Badge tone="plain">Open on this tablet</Badge> : null}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
            {appointment.reason}
          </p>
        </div>

        {vital ? (
          <VitalStrip vital={vital} age={age} rules={data.vitalReviewRules} />
        ) : (
          <p className="text-[12px] text-ink-2">No vitals recorded</p>
        )}

        {/* One contextual primary action per row; everything else is quieter
            beside it, so a queue of eight patients has eight decisions on it
            rather than twenty-four. */}
        <div className="flex flex-wrap gap-2" data-print="hide">
          {appointment.status === 'waiting' ? (
            <ActionButton
              variant="primary"
              className={PRIMARY}
              icon="stethoscope"
              busy={task.busy}
              busyLabel={task.workingLabel}
              disabled={Boolean(elsewhere)}
              disabledReason={elsewhere}
              onClick={callIn}
            >
              Call in
            </ActionButton>
          ) : null}
          {live && stations.has('consultation') ? (
            <Button
              className={PRIMARY}
              variant="primary"
              icon="stethoscope"
              onClick={() => onOpenPatient(appointment.patientId, 'consultation')}
            >
              Open consult
            </Button>
          ) : null}
          {!finished && stations.has('vitals') ? (
            <Button icon="pulse" onClick={() => onOpenPatient(appointment.patientId, 'vitals')}>
              Vitals
            </Button>
          ) : null}
          {live ? (
            <ActionButton
              icon="check"
              busy={task.busy}
              busyLabel={task.workingLabel}
              disabled={Boolean(elsewhere)}
              disabledReason={elsewhere}
              onClick={markDone}
            >
              Mark done
            </ActionButton>
          ) : null}
        </div>
      </div>

      {/* A refusal belongs on the row it was refused on, not in a strip at the
          top of a queue of eight. */}
      {task.failure ? (
        <div className="px-4 pb-3">
          <TaskFailure failure={task.failure} onDismiss={task.dismiss} />
        </div>
      ) : null}
    </Card>
  )
}

export function QueuePanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const arrival = useTask()
  const { patientId, select, goTo } = useSelectedPatient()
  const [arrivalSearch, setArrivalSearch] = useState('')
  const [arrivalReason, setArrivalReason] = useState('')
  const stations = stationsOf(data)
  const queue = data.appointments.filter((item) => item.status !== 'cancelled')
  const selectedArrival = data.patients.find((patient) => patient.id === patientId)
  const activePatientIds = new Set(queue.filter((item) => item.status !== 'done').map((item) => item.patientId))
  const arrivalMatches = arrivalSearch.trim().length < 2
      ? []
      : data.patients.filter((patient) => {
        const query = arrivalSearch.trim().toLocaleLowerCase('en-IN')
        const digits = query.replace(/[^0-9]/g, '')
        return patient.name.toLocaleLowerCase('en-IN').includes(query) ||
          (digits.length > 0 && patient.phone.replace(/[^0-9]/g, '').includes(digits))
      }).slice(0, 6)

  /** Open a patient, and go where that patient is worked on if we have it. */
  function openPatient(patient: string, view: 'consultation' | 'vitals') {
    select(patient)
    if (stations.has(view)) goTo(view)
  }

  /**
   * Issuing the token, then walking the patient to the first thing done to
   * them. No result overlay: the token appearing on the queue and the vitals
   * pad opening on that patient is better evidence than a box saying so.
   */
  async function arrivePatient() {
    if (!patientId || !arrivalReason.trim()) return
    const result = await arrival.run({
      working: 'Issuing token…',
      request: () =>
        run('create_appointment', {
          patientId,
          reason: arrivalReason,
          scheduledAt: new Date().toISOString(),
        }),
      confirmed: () => null,
    })
    if (!result?.ok) return
    setArrivalSearch('')
    setArrivalReason('')
    if (stations.has('vitals')) goTo('vitals')
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Today's flow"
        title="Patient queue"
        sub={`${queue.filter((item) => item.status === 'waiting').length} waiting · ${queue.length} today`}
      />

      <Card variant="record" data-print="hide">
        <Disclosure label="Patient arrived" hint="Find them, record the reason, issue the token, then take vitals">
          <div className="space-y-4">
            <Field label="Find patient" hint="Name or mobile number">
              <Input value={arrivalSearch} onChange={(event) => setArrivalSearch(event.target.value)} autoComplete="off" />
            </Field>
            {arrivalMatches.length ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Matching patients">
                {arrivalMatches.map((patient) => (
                  <button key={patient.id} type="button" className={`min-h-[56px] border px-3 py-2 text-left ${patient.id === patientId ? 'border-ink bg-active-wash' : 'border-rule bg-sheet'}`} onClick={() => select(patient.id)}>
                    <span className="block text-[14px] font-semibold">{patient.name}</span>
                    <span className="block text-[12px] text-ink-2">{patient.age} years · {patient.phone}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {selectedArrival ? (
              <Notice tone={activePatientIds.has(selectedArrival.id) ? 'info' : 'good'}>
                <span className="font-semibold">{selectedArrival.name}</span>{activePatientIds.has(selectedArrival.id) ? ' is already in the active queue.' : ' is selected for arrival.'}
              </Notice>
            ) : null}
            <Field label="Reason for visit" required>
              <Input value={arrivalReason} onChange={(event) => setArrivalReason(event.target.value)} autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <ActionButton
                variant="primary"
                className={PRIMARY}
                icon="plus"
                busy={arrival.busy}
                busyLabel={arrival.workingLabel}
                disabled={
                  (busy && !arrival.busy) ||
                  !selectedArrival ||
                  !arrivalReason.trim() ||
                  activePatientIds.has(patientId)
                }
                disabledReason={
                  busy && !arrival.busy
                    ? 'Another action is being saved.'
                    : activePatientIds.has(patientId)
                      ? 'This patient is already in the queue.'
                      : 'Find the patient and record the reason first.'
                }
                onClick={arrivePatient}
              >
                Issue token &amp; open vitals
              </ActionButton>
              <Button className={PRIMARY} icon="user" onClick={() => goTo('patients')}>
                Register new patient
              </Button>
            </div>
            <TaskFailure failure={arrival.failure} onDismiss={arrival.dismiss} />
          </div>
        </Disclosure>
      </Card>

      {queue.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="The queue is clear"
              direction="Reception adds a patient to the queue and they appear here, in token order. A doctor working alone can add one from Patients."
            />
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {queue.map((appointment) => (
            <QueueRow
              key={appointment.id}
              appointment={appointment}
              data={data}
              run={run}
              stations={stations}
              open={appointment.patientId === patientId}
              onOpenPatient={openPatient}
            />
          ))}
        </div>
      )}
    </Stack>
  )
}

/**
 * The nursing station.
 *
 * Two things changed here and both come from the same day: the day the nurse
 * is not in. Readings open on the patient the clinic is already working on
 * rather than on a dropdown of everybody ever registered, and any one of them
 * may be left out — the doctor with no oximeter in the cabin records the three
 * he took, says why the fourth is missing, and moves on. What he must never do
 * is type 98 because it usually is.
 *
 * The pad itself now lives in `vitals-view.tsx`, because the nurse's round
 * opens the same pad in a drawer without leaving her list. This screen remains
 * the station on the rail and the doctor's way in when he is working alone.
 */
export function VitalsPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const { patientId } = useSelectedPatient()
  const save = useTask()

  const patient = data.patients.find((item) => item.id === patientId)
  const appointment = data.appointments.find(
    (item) =>
      item.patientId === patientId && item.status !== 'done' && item.status !== 'cancelled',
  )

  return (
    <Stack>
      <PageHeader
        eyebrow="Nursing station"
        title="Vitals"
        sub={
          patient
            ? `${patient.name}, ${patient.age} · ${appointment ? `token ${appointment.token}` : 'not in today’s queue'}`
            : `${data.vitals.length} readings recorded`
        }
      />

      {!patient ? (
        <Card data-print="hide">
          <CardBody className="space-y-4">
            <EmptyState
              title="No patient open"
              direction="Vitals are recorded against the patient the clinic is working on. Call one in from the queue, or choose one here."
            />
            <div className="mx-auto max-w-md">
              <PatientChooser data={data} label="Patient" />
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card variant="record" data-print="hide">
          <CardHeader
            title="New reading"
            sub={`${patient.name} · ${patient.age} · ${patient.sex}`}
          />
          <CardBody className="space-y-4">
            <VitalsEntry data={data} run={run} patient={patient} task={save} layout="wide" />

            <Disclosure label="Work on a different patient" hint="Every care screen follows this">
              <PatientChooser data={data} label="Patient" />
            </Disclosure>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Recent readings" sub={`${data.vitals.length} total`} />
        {data.vitals.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No vitals recorded"
              direction="Record the first reading above and it appears on this register."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH num>BP</TH>
                <TH num>Temp</TH>
                <TH num>Pulse</TH>
                <TH num>SpO₂</TH>
                <TH num>Weight</TH>
                <TH num>Recorded</TH>
              </TR>
            </THead>
            <TBody>
              {data.vitals.slice(0, 20).map((vital) => (
                <TR key={vital.id} active={vital.patientId === patientId}>
                  <TD className="font-semibold">
                    {data.patients.find((patient) => patient.id === vital.patientId)?.name ?? '—'}
                    {vital.notMeasuredNote ? (
                      <span className="mt-0.5 block text-[11px] leading-snug font-normal text-ink-2">
                        {vital.notMeasuredNote}
                      </span>
                    ) : null}
                  </TD>
                  <TD num>{reading(vital.bp) ?? <NotMeasured />}</TD>
                  <TD num>{reading(vital.temperature) ?? <NotMeasured />}</TD>
                  <TD num>{reading(vital.pulse) ?? <NotMeasured />}</TD>
                  <TD num>{reading(vital.spo2) ?? <NotMeasured />}</TD>
                  <TD num>{reading(vital.weight) ?? <NotMeasured />}</TD>
                  <TD num>{formatDate(vital.recordedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}

type DraftItem = PrescriptionItemView & { key: string }

/**
 * The doctor's workspace.
 *
 * The patient comes from the clinic's own selection, not from a dropdown on
 * this screen. `Call in` on the queue puts them here; so does opening one from
 * Patients or from Vitals. The all-patient list is still reachable, folded
 * away at the bottom of the patient card, for the case the flow did not cover
 * — but it is no longer the way in, and nobody chooses the same patient twice.
 */
export function ConsultationPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const { patientId, select, goTo } = useSelectedPatient()
  const stations = stationsOf(data)
  const [items, setItems] = useState<DraftItem[]>([])
  const [visitReason, setVisitReason] = useState('')

  const patient = data.patients.find((item) => item.id === patientId)
  const patientAppointment = data.appointments.find(
    (item) => item.patientId === patientId && item.status !== 'done' && item.status !== 'cancelled',
  )
  // This patient's own history, fetched when they are opened rather than
  // shipped to every tablet in the clinic on every tap.
  const { record, loading: recordLoading, refresh: refreshRecord } = usePatientRecord(patientId)

  // The reading taken at the door today is in the snapshot; the record has the
  // whole run. Either way the newest one is the one the doctor wants.
  const latestVitals =
    record.vitals[0] ?? data.vitals.find((item) => item.patientId === patientId)
  const patientHistory = record.encounters
  const activeMedicines = data.medicines.filter((medicine) => medicine.active)

  function addMedicine() {
    const medicine = activeMedicines[0]
    if (!medicine) return
    setItems((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        medicineId: medicine.id,
        medicineName: `${medicine.name} ${medicine.strength}`.trim(),
        dosage: '1-0-1',
        instructions: 'After food',
        quantity: 6,
      },
    ])
  }

  function patch(key: string, change: Partial<DraftItem>) {
    setItems((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))
  }

  /**
   * The patient is in the cabin and nobody put them in the queue.
   *
   * On a day without a nurse that is the normal case, and until this slice the
   * doctor's answer was to borrow the nurse's login — which attributed the
   * rest of the visit to her. Issuing the token from here is the same command
   * reception uses; the only difference is who is standing at the tablet.
   */
  async function addToQueue() {
    const result = await run('create_appointment', {
      patientId,
      reason: visitReason,
      // Now, to the second: this is a patient who has already arrived, not an
      // appointment being booked for later. An ISO instant, which is the shape
      // every other timestamp in this clinic is written in.
      scheduledAt: new Date().toISOString(),
    })
    if (result.ok) setVisitReason('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    // The consultation just written belongs to this patient's history, which
    // the snapshot no longer carries — so ask for it again rather than waiting
    // for a screen that will never update itself.
    const result = await run('save_consultation', {
      patientId,
      appointmentId: patientAppointment?.id,
      diagnosis: values.get('diagnosis'),
      notes: values.get('notes'),
      advice: values.get('advice'),
      consultationFee: values.get('consultationFee'),
      prescriptionItems: items,
    })
    if (result.ok) {
      refreshRecord()
      form.reset()
      setItems([])
      // The visit is over, so the clinic is working on nobody. Leaving them
      // selected would put the next patient's vitals under this one's name.
      select('')
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Doctor workspace"
        title="Consultation"
        sub={
          patient
            ? `${patient.name}${patientAppointment ? ` · token ${patientAppointment.token}` : ''}`
            : 'No patient open'
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <form onSubmit={submit} className="space-y-4">
          <Card variant="record">
            <CardHeader title="Patient" />
            <CardBody className="space-y-4">
              {patient ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {patientAppointment ? (
                    <Token
                      code={patientAppointment.token}
                      size="md"
                      active={patientAppointment.status === 'in_consult'}
                    />
                  ) : null}
                  <div className="min-w-0">
                    <p className="text-[18px] leading-tight font-semibold">{patient.name}</p>
                    <p className="mt-0.5 text-[13px] text-ink-2">
                      {patient.age} years · {patient.sex}
                      {patient.phone ? ` · ${patient.phone}` : ''}
                    </p>
                  </div>
                  {/* Only where this account has a vitals station of its own.
                      A doctor whose rail has no Vitals would otherwise be sent
                      to a screen his navigation cannot show him the way back
                      from. */}
                  {stations.has('vitals') ? (
                    <div className="ml-auto" data-print="hide">
                      <Button onClick={() => goTo('vitals')}>Record vitals</Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <EmptyState
                  title="No patient open"
                  direction="Call the next patient in from the queue and they arrive here already open. Choosing one below does the same thing."
                />
              )}

              {patient && !patientAppointment ? (
                <div className="border-t border-rule pt-3" data-print="hide">
                  <Notice>
                    {patient.name} is not in today&rsquo;s queue. A consultation can be signed
                    either way — adding them issues a token, so the visit appears on the queue and
                    at the counter.
                  </Notice>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="min-w-[220px] flex-1">
                      <Field label="Reason for the visit">
                        <Input
                          value={visitReason}
                          onChange={(event) => setVisitReason(event.target.value)}
                          autoComplete="off"
                        />
                      </Field>
                    </div>
                    <ActionButton
                      busy={busy}
                      busyLabel="Adding…"
                      disabled={visitReason.trim() === ''}
                      disabledReason="Say what the visit is for first."
                      onClick={addToQueue}
                    >
                      Add to today&rsquo;s queue
                    </ActionButton>
                  </div>
                </div>
              ) : null}

              {latestVitals ? (
                <div className="border-t border-rule pt-3">
                  <p className="eyebrow mb-2">Latest vitals</p>
                  <VitalStrip vital={latestVitals} size="lg" />
                </div>
              ) : patient ? (
                <Notice>
                  No vitals recorded for this patient. A consultation can still be signed.
                </Notice>
              ) : null}

              <div data-print="hide">
                <Disclosure
                  label="Work on a different patient"
                  hint="The queue is the usual way in; this is for the patient who is not on it"
                >
                  <PatientChooser data={data} label="Patient" />
                </Disclosure>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Diagnosis & notes" />
            <CardBody className="space-y-4">
              <FieldRow>
                <Field label="Diagnosis" required>
                  <Input name="diagnosis" required />
                </Field>
                <Field label="Consultation fee" unit="₹">
                  <Input
                    name="consultationFee"
                    type="number"
                    min="0"
                    defaultValue="300"
                    inputMode="decimal"
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Clinical notes" hint="Not shown to the patient.">
                  <Textarea name="notes" rows={4} />
                </Field>
                <Field label="Advice" hint="What the patient is told to do at home.">
                  <Textarea name="advice" rows={4} />
                </Field>
              </FieldRow>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Prescription"
              sub={`${items.length} ${items.length === 1 ? 'medicine' : 'medicines'}`}
              action={
                <Button onClick={addMedicine} disabled={activeMedicines.length === 0} data-print="hide">
                  Add medicine
                </Button>
              }
            />
            <CardBody className="space-y-3">
              {items.length === 0 ? (
                <EmptyState
                  title="No medicine added"
                  direction="A consultation can be signed without a prescription. Add a medicine only if one is being given."
                />
              ) : (
                items.map((item, index) => (
                  <div
                    key={item.key}
                    className="grid grid-cols-1 gap-3 border-l-2 border-ink bg-paper/40 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_90px_auto]"
                  >
                    <Field label={`Medicine ${index + 1}`}>
                      <Select
                        value={item.medicineId}
                        onChange={(event) => {
                          const medicine = activeMedicines.find((c) => c.id === event.target.value)
                          if (!medicine) return
                          patch(item.key, {
                            medicineId: medicine.id,
                            medicineName: `${medicine.name} ${medicine.strength}`.trim(),
                          })
                        }}
                      >
                        {activeMedicines.map((medicine) => (
                          <option key={medicine.id} value={medicine.id}>
                            {medicine.name} {medicine.strength}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Dosage">
                      <Input
                        value={item.dosage}
                        onChange={(event) => patch(item.key, { dosage: event.target.value })}
                      />
                    </Field>
                    <Field label="Instructions">
                      <Input
                        value={item.instructions}
                        onChange={(event) => patch(item.key, { instructions: event.target.value })}
                      />
                    </Field>
                    <Field label="Qty">
                      <Input
                        type="number"
                        min="1"
                        inputMode="numeric"
                        value={item.quantity}
                        onChange={(event) =>
                          patch(item.key, { quantity: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <div className="flex items-end" data-print="hide">
                      <Button
                        variant="danger"
                        aria-label={`Remove ${item.medicineName}`}
                        onClick={() =>
                          setItems((current) => current.filter((row) => row.key !== item.key))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          <ActionButton
            type="submit"
            variant="primary"
            className={PRIMARY}
            busy={busy}
            busyLabel="Saving…"
            disabled={!patient}
            disabledReason="Call a patient in from the queue first."
          >
            Sign &amp; save consultation
          </ActionButton>
        </form>

        <aside className="xl:sticky xl:top-5 xl:self-start">
          <Card>
            <CardHeader title="Patient history" />
            <CardBody className="space-y-3">
              {!patientId ? (
                <p className="text-[13px] text-ink-2">
                  Open a patient to read what was written last time.
                </p>
              ) : recordLoading ? (
                <p className="text-[13px] text-ink-2">Reading this patient&rsquo;s history…</p>
              ) : patientHistory.length === 0 ? (
                <p className="text-[13px] text-ink-2">No previous consultations for this patient.</p>
              ) : (
                patientHistory.map((encounter) => (
                  <div key={encounter.id} className="border-b border-rule pb-3 last:border-b-0">
                    <p className="font-mono text-[12px] text-ink-2">
                      {formatDate(encounter.createdAt)} · {encounter.doctorName}
                    </p>
                    <p className="mt-0.5 text-[14px] font-semibold">{encounter.diagnosis}</p>
                    {encounter.advice ? (
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-2">
                        {encounter.advice}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </Stack>
  )
}

export function RecordsPanel({ data }: { data: ClinicSnapshot }) {
  const [openId, setOpenId] = useState<string | null>(null)

  // Opening one consultation needs that patient's prescriptions, which are no
  // longer shipped with everything else.
  const openEncounter = data.encounters.find((encounter) => encounter.id === openId)
  const { record: openRecord } = usePatientRecord(openEncounter?.patientId ?? '')

  return (
    <Stack>
      <PageHeader
        eyebrow="Clinical record"
        title="Consultations"
        sub={`${data.encounters.length} recorded`}
        action={
          <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
            Print
          </Button>
        }
      />

      <Card data-print="sheet">
          <ClinicLetterhead settings={data.settings} kind="prescription" />
        <CardHeader title="Consultation register" />
        {data.encounters.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No consultations recorded"
              direction="A doctor signs a consultation and it is filed here, with the prescription that went with it."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Patient</TH>
                <TH>Doctor</TH>
                <TH>Diagnosis</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {data.encounters.map((encounter) => (
                <TR key={encounter.id}>
                  <TD num>{formatDate(encounter.createdAt)}</TD>
                  <TD className="font-semibold">{encounter.patientName}</TD>
                  <TD className="text-ink-2">{encounter.doctorName}</TD>
                  <TD>{encounter.diagnosis}</TD>
                  <TD>
                    <Button
                      size="sm"
                      data-print="hide"
                      onClick={() => setOpenId(openId === encounter.id ? null : encounter.id)}
                    >
                      {openId === encounter.id ? 'Hide' : 'Open'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {openId
        ? data.encounters
            .filter((encounter) => encounter.id === openId)
            .map((encounter) => {
              const rx = openRecord.prescriptions.filter(
                (item) => item.patientId === encounter.patientId,
              )
              return (
                <Card key={encounter.id} variant="record" data-print="sheet">
                  <CardHeader
                    title="Consultation"
                    sub={`${encounter.patientName} · ${formatDate(encounter.createdAt)}`}
                    action={
                      <Button data-print="hide" onClick={() => setOpenId(null)}>
                        Close
                      </Button>
                    }
                  />
                  <CardBody className="space-y-4">
                    <div>
                      <p className="eyebrow">Diagnosis</p>
                      <p className="mt-1 text-[15px] font-semibold">{encounter.diagnosis}</p>
                    </div>
                    <div>
                      <p className="eyebrow">Clinical notes</p>
                      <p className="mt-1 text-[14px] leading-relaxed whitespace-pre-line">
                        {encounter.notes || '—'}
                      </p>
                    </div>
                    <div>
                      <p className="eyebrow">Advice</p>
                      <p className="mt-1 text-[14px] leading-relaxed whitespace-pre-line">
                        {encounter.advice || '—'}
                      </p>
                    </div>
                    {rx.length > 0 ? (
                      <div>
                        <SectionHeader title="Prescriptions on this patient" />
                        <div className="mt-2 space-y-3">
                          {rx.map((prescription) => (
                            <div key={prescription.id} className="border-l-2 border-ink pl-3">
                              <p className="font-mono text-[12px] text-ink-2">
                                Signed {formatDate(prescription.signedAt)} ·{' '}
                                {prescription.dispensedAt
                                  ? `dispensed ${formatDate(prescription.dispensedAt)}`
                                  : 'not dispensed'}
                              </p>
                              <ul className="mt-1 space-y-1">
                                {prescription.items.map((item, index) => (
                                  <li key={`${prescription.id}-${item.medicineId ?? 'unresolved'}-${index}`} className="text-[14px]">
                                    <span className="font-semibold">{item.medicineName}</span>
                                    <span className="ml-2 font-mono text-[12px] text-ink-2">
                                      {item.dosage} · {item.instructions} ·{' '}
                                      {item.quantityState === 'unknown_legacy'
                                        ? 'quantity not recorded'
                                        : `qty ${item.quantity}`}
                                    </span>
                                    {/* A line from before this system that pharmacy cannot supply
                                        until this doctor says what it was. */}
                                    {item.needsReview ? (
                                      <span className="ml-2 text-[12px] font-semibold text-stop">
                                        needs review
                                      </span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              )
            })
        : null}
    </Stack>
  )
}
