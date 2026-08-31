'use client'

import { useMemo, useState, type FormEvent } from 'react'
import type { ClinicSnapshot, PrescriptionItemView, VitalView } from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
import { usePatientRecord } from './use-patient-record'
import { ClinicLetterhead, Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
  Textarea,
  Token,
  formatDate,
  words,
} from '@/components/ui'

const TONE = {
  waiting: 'attn',
  in_consult: 'live',
  done: 'free',
  cancelled: 'plain',
} as const

/**
 * The vitals strip — five figures a doctor reads in one glance before saying
 * anything. Every one is mono and labelled, because the label is printed on
 * the case sheet and the figure is written onto it.
 */
function VitalStrip({ vital, size = 'sm' }: { vital: VitalView; size?: 'sm' | 'lg' }) {
  const cells = [
    { label: 'BP', value: vital.bp, unit: 'mmHg' },
    { label: 'Temp', value: vital.temperature, unit: '°C' },
    { label: 'Pulse', value: vital.pulse, unit: '/min' },
    { label: 'SpO₂', value: vital.spo2, unit: '%' },
    { label: 'Weight', value: vital.weight, unit: 'kg' },
  ]
  return (
    <dl className={`flex flex-wrap ${size === 'lg' ? 'gap-x-8 gap-y-3' : 'gap-x-5 gap-y-2'}`}>
      {cells.map((cell) => (
        <div key={cell.label}>
          <dt className="eyebrow">{cell.label}</dt>
          <dd
            className={`mt-0.5 font-mono tabular-nums ${size === 'lg' ? 'text-[18px]' : 'text-[14px]'}`}
          >
            {cell.value}
            <span className="ml-1 text-[11px] text-ink-2">{cell.unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function QueuePanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const queue = data.appointments.filter((item) => item.status !== 'cancelled')

  return (
    <Stack>
      <PageHeader
        eyebrow="Today's flow"
        title="Patient queue"
        sub={`${queue.filter((item) => item.status === 'waiting').length} waiting · ${queue.length} today`}
      />

      {queue.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="The queue is clear"
              direction="Reception adds a patient to the queue and they appear here, in token order."
            />
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {queue.map((appointment) => {
            const vital = data.vitals.find((item) => item.patientId === appointment.patientId)
            const live = appointment.status === 'in_consult'
            return (
              <Card key={appointment.id} variant={live ? 'record' : 'panel'}>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
                  <Token code={appointment.token} size="md" active={live} />

                  <div className="min-w-[180px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[16px] font-semibold">{appointment.patientName}</p>
                      <Badge tone={TONE[appointment.status]}>{words(appointment.status)}</Badge>
                    </div>
                    <p className="mt-0.5 text-[13px] text-ink-2">{appointment.reason}</p>
                  </div>

                  {vital ? (
                    <VitalStrip vital={vital} />
                  ) : (
                    <p className="text-[12px] text-ink-2">Vitals not recorded</p>
                  )}

                  <div className="flex gap-2" data-print="hide">
                    {appointment.status === 'waiting' ? (
                      <ActionButton
                        variant="primary"
                        busy={busy}
                        busyLabel="…"
                        onClick={() =>
                          run('set_appointment_status', {
                            appointmentId: appointment.id,
                            status: 'in_consult',
                          })
                        }
                      >
                        Call in
                      </ActionButton>
                    ) : null}
                    {appointment.status === 'in_consult' ? (
                      <ActionButton
                        busy={busy}
                        busyLabel="…"
                        onClick={() =>
                          run('set_appointment_status', {
                            appointmentId: appointment.id,
                            status: 'done',
                          })
                        }
                      >
                        Mark done
                      </ActionButton>
                    ) : null}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </Stack>
  )
}

export function VitalsPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const result = await run('add_vitals', Object.fromEntries(values))
    if (result.ok) form.reset()
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Nursing station"
        title="Vitals"
        sub={`${data.vitals.length} readings recorded`}
      />

      <Card data-print="hide">
        <CardHeader title="New reading" />
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            <FieldRow cols={3}>
              <Field label="Patient" required>
                <Select name="patientId" required defaultValue="">
                  <option value="" disabled>
                    Choose patient
                  </option>
                  {data.patients.map((patient) => (
                    <option value={patient.id} key={patient.id}>
                      {patient.name} · {patient.age}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Blood pressure" unit="mmHg" required>
                <Input name="bp" placeholder="120/80" required />
              </Field>
              <Field label="Temperature" unit="°C" required>
                <Input name="temperature" type="number" step="0.1" min="30" inputMode="decimal" required />
              </Field>
              <Field label="Pulse" unit="/min" required>
                <Input name="pulse" type="number" min="1" inputMode="numeric" required />
              </Field>
              <Field label="SpO₂" unit="%" required>
                <Input name="spo2" type="number" min="1" max="100" inputMode="numeric" required />
              </Field>
              <Field label="Weight" unit="kg" required>
                <Input name="weight" type="number" step="0.1" min="1" inputMode="decimal" required />
              </Field>
            </FieldRow>
            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
              Save vitals
            </ActionButton>
          </form>
        </CardBody>
      </Card>

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
                <TR key={vital.id}>
                  <TD className="font-semibold">
                    {data.patients.find((patient) => patient.id === vital.patientId)?.name ?? '—'}
                  </TD>
                  <TD num>{vital.bp}</TD>
                  <TD num>{vital.temperature}</TD>
                  <TD num>{vital.pulse}</TD>
                  <TD num>{vital.spo2}</TD>
                  <TD num>{vital.weight}</TD>
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

export function ConsultationPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const [patientId, setPatientId] = useState(
    data.appointments.find((item) => item.status === 'in_consult')?.patientId ?? '',
  )
  const [items, setItems] = useState<DraftItem[]>([])

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
      setPatientId('')
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Doctor workspace"
        title="Consultation"
        sub={patientAppointment ? `Token ${patientAppointment.token}` : 'No token selected'}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <form onSubmit={submit} className="space-y-4">
          <Card variant="record">
            <CardHeader title="Patient" />
            <CardBody className="space-y-4">
              <Field label="Patient" required>
                <Select
                  value={patientId}
                  onChange={(event) => setPatientId(event.target.value)}
                  required
                >
                  <option value="">Choose patient</option>
                  {data.patients.map((patient) => (
                    <option value={patient.id} key={patient.id}>
                      {patient.name}, {patient.age}
                    </option>
                  ))}
                </Select>
              </Field>

              {latestVitals ? (
                <div className="border-t border-rule pt-3">
                  <p className="eyebrow mb-2">Latest vitals</p>
                  <VitalStrip vital={latestVitals} size="lg" />
                </div>
              ) : patientId ? (
                <Notice>
                  No vitals recorded for this patient. A consultation can still be signed.
                </Notice>
              ) : null}
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
            busy={busy}
            busyLabel="Saving…"
            disabled={!patientId}
            disabledReason="Choose a patient first."
          >
            Sign & save consultation
          </ActionButton>
        </form>

        <aside className="xl:sticky xl:top-5 xl:self-start">
          <Card>
            <CardHeader title="Patient history" />
            <CardBody className="space-y-3">
              {!patientId ? (
                <p className="text-[13px] text-ink-2">
                  Choose a patient to read what was written last time.
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
                                {prescription.items.map((item) => (
                                  <li key={`${prescription.id}-${item.medicineId}`} className="text-[14px]">
                                    <span className="font-semibold">{item.medicineName}</span>
                                    <span className="ml-2 font-mono text-[12px] text-ink-2">
                                      {item.dosage} · {item.instructions} · qty {item.quantity}
                                    </span>
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
