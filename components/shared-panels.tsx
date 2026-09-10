'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { BedView, ClinicSnapshot, PatientView, Role } from '@/lib/types'
import { useBusy, useSelectedPatient, type ActionRunner } from './clinic-context'
import { callApi } from '@/lib/api'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckRow,
  ConfirmButton,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  Input,
  Modal,
  Notice,
  PageHeader,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
  Token,
  clinicToday,
  formatDate,
  formatDay,
  money,
  words,
} from '@/components/ui'

export type { ActionRunner }

/** The vertical rhythm every workspace is stacked on. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>
}

/**
 * A counted figure. Nothing here is stored — every tile is counted out of the
 * snapshot on each render, the way the reference application's admin window
 * works, so there is no bookkeeping to fall out of sync.
 */
function Stat({ label, value, note }: { label: string; value: ReactNode; note: string }) {
  return (
    <Card>
      <div className="px-4 py-3">
        <p className="eyebrow">{label}</p>
        <p className="mt-1 font-mono text-[26px] leading-none font-medium tabular-nums">{value}</p>
        <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{note}</p>
      </div>
    </Card>
  )
}

const APPOINTMENT_TONE = {
  waiting: 'attn',
  in_consult: 'live',
  done: 'free',
  cancelled: 'plain',
} as const

const BED_TONE = {
  available: 'free',
  occupied: 'attn',
  cleaning: 'plain',
  out_of_service: 'stop',
} as const

export function OverviewPanel({ data }: { data: ClinicSnapshot }) {
  const waiting = data.appointments.filter(
    (item) => item.status === 'waiting' || item.status === 'in_consult',
  )
  const low = data.medicines.filter((item) => item.active && item.totalAvailable <= item.reorderLevel)
  const unpaid = data.bills.filter((item) => item.status === 'unpaid')
  const occupied = data.beds.filter((item) => item.status === 'occupied')
  const attention = [...low].slice(0, 5)

  return (
    <Stack>
      <PageHeader
        eyebrow="The clinic today"
        title="Overview"
        sub={`${data.patients.length} patients on the register · ${data.appointments.length} appointments today`}
      />

      {/* Doctor presence is a fact about the building, so it is stated in
          words on its own rule rather than decorated. It follows one thing
          only: whether a doctor is signed in right now. */}
      <Card variant="record">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">Doctor availability</p>
            <p className="mt-1 text-[15px] font-semibold">
              {data.doctorPresent ? 'A doctor is in the clinic' : 'No doctor is signed in'}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-2">
              Follows the doctor login alone — nothing else sets this.
            </p>
          </div>
          <Badge tone={data.doctorPresent ? 'live' : 'plain'}>
            {data.doctorPresent ? 'Doctor in' : 'Doctor out'}
          </Badge>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Patient queue" value={waiting.length} note="Waiting or in consultation" />
        <Stat label="Beds occupied" value={`${occupied.length}/${data.beds.length}`} note="Observation beds" />
        <Stat
          label="Unpaid bills"
          value={unpaid.length}
          note={`${money(unpaid.reduce((sum, item) => sum + item.amount, 0))} outstanding`}
        />
        <Stat label="Low stock" value={low.length} note="At or below reorder level" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Patient flow" sub={`${data.appointments.length} today`} />
          {data.appointments.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No appointments today"
                direction="Reception adds a patient to the queue, and they appear here in token order."
              />
            </CardBody>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Token</TH>
                  <TH>Patient</TH>
                  <TH>Reason</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {data.appointments.slice(0, 8).map((appointment) => (
                  <TR key={appointment.id}>
                    <TD>
                      <Token code={appointment.token} active={appointment.status === 'in_consult'} />
                    </TD>
                    <TD className="font-semibold">{appointment.patientName}</TD>
                    <TD className="text-ink-2">{appointment.reason}</TD>
                    <TD>
                      <Badge tone={APPOINTMENT_TONE[appointment.status]}>
                        {words(appointment.status)}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Needs attention" />
          <CardBody className="space-y-2">
            {attention.length === 0 && occupied.length === 0 ? (
              <EmptyState
                title="Nothing needs attention"
                direction="Stock is above every reorder level and no bed is occupied."
              />
            ) : null}
            {attention.map((item) => (
              <div
                key={item.id}
                className="flex items-baseline justify-between gap-3 border-b border-rule pb-2 last:border-b-0"
              >
                <span className="min-w-0 text-[14px] font-semibold">
                  {item.name} {item.strength}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-stop tabular-nums">
                  {item.totalAvailable} left · reorder at {item.reorderLevel}
                </span>
              </div>
            ))}
            {data.beds
              .filter((bed) => bed.status !== 'available')
              .map((bed) => (
                <div
                  key={bed.id}
                  className="flex items-baseline justify-between gap-3 border-b border-rule pb-2 last:border-b-0"
                >
                  <span className="min-w-0 text-[14px] font-semibold">{bed.label}</span>
                  <span className="shrink-0 font-mono text-[12px] text-ink-2">
                    {bed.patientName ?? words(bed.status)}
                  </span>
                </div>
              ))}
          </CardBody>
        </Card>
      </div>
    </Stack>
  )
}

/** One patient the register already holds who might be this one. */
type PossibleMatch = {
  id: string
  name: string
  age: number
  sex: string
  phone: string
  createdAt: string
  matchedOn: 'phone' | 'name'
  /** Absent when no age was typed to compare against. */
  ageMatches?: boolean
}

/**
 * Who might this already be?
 *
 * Asked while the name and the number are being typed, and answered above the
 * Save button, because a duplicate patient is only cheap to avoid before it
 * exists. Three rules hold this screen honest and none of them is negotiable:
 * it never merges anything, it never picks a match on the clinic's behalf, and
 * it never stops the desk creating the patient in front of them. Two people in
 * one street really do share a name, and the person at the desk can see which
 * of them is standing there.
 *
 * It goes to the command endpoint directly rather than through `run`, which is
 * the only read on this screen that does. `run` marks the whole clinic busy —
 * every button on every panel — and posts its answer into the shared notice
 * bar, and neither of those belongs on a keystroke.
 */
async function findPossibleMatches(
  name: string,
  phone: string,
  age: string,
): Promise<PossibleMatch[]> {
  const response = await callApi('command', {
    method: 'POST',
    body: JSON.stringify({
      action: 'find_possible_duplicates',
      // An age of nothing is left out rather than sent as 0, which would make
      // every candidate look like a different person.
      payload: { name, phone, age: Number(age) || undefined },
    }),
  })
  const body = (await response.json()) as { ok: boolean; data?: { matches?: PossibleMatch[] } }
  return body.ok && body.data?.matches ? body.data.matches : []
}

/** Why this candidate is being shown, in a sentence rather than a field name. */
function whyShown(match: PossibleMatch): string {
  const because = match.matchedOn === 'phone' ? 'Same mobile number' : 'Same name'
  const age =
    match.ageMatches === undefined
      ? 'no age typed to compare'
      : match.ageMatches
        ? 'and about the same age'
        : 'but a different age — probably another person'
  return `${because}, ${age}`
}

/**
 * The candidates, and what to do about them.
 *
 * Deliberately plain: a list, a sentence saying why each one is here, and one
 * action per row that opens that patient instead of creating a new one. There
 * is no merge button and there is no "these are the same person" — the clinic
 * has no way to unpick either afterwards.
 */
function PossibleMatches({
  matches,
  checking,
  opened,
  selectedId,
  onOpen,
}: {
  matches: PossibleMatch[]
  checking: boolean
  /** The candidate this desk opened, if it opened one. */
  opened: PossibleMatch | null
  selectedId: string
  onOpen: (match: PossibleMatch) => void
}) {
  const said =
    opened && opened.id === selectedId ? (
      <Notice tone="good">
        <span className="font-semibold">{opened.name}</span> is the patient this tablet is now
        working on — their existing record, not a new one. Add them to today&rsquo;s queue beside
        this form, or go straight to Vitals or Consult.
      </Notice>
    ) : null

  if (matches.length === 0) {
    if (said) return said
    return checking ? (
      <p className="text-[12px] text-ink-2">Looking for this patient on the register…</p>
    ) : null
  }

  return (
    <div className="space-y-2">
      {said}
      {/* Kept on screen after one is opened, because the second thing a desk
          does is discover it opened the wrong Kamala. */}
      <div className="border-l-2 border-attn pl-3">
        <p className="eyebrow">
          {matches.length === 1
            ? 'One patient already on the register'
            : `${matches.length} patients already on the register`}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-ink-2">
          Check whether one of these is the person in front of you. Opening one uses their record
          and their history; nothing is merged, and if this really is somebody new you can still
          register them below.
        </p>
        <div className="mt-2 space-y-2">
          {matches.map((match) => (
            <div
              key={match.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-rule bg-sheet px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">{match.name}</p>
                <p className="mt-0.5 font-mono text-[12px] text-ink-2">
                  {match.age} years · {match.sex} · {match.phone} · registered{' '}
                  {formatDay(match.createdAt)}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{whyShown(match)}</p>
              </div>
              {match.id === selectedId ? (
                <Badge tone="live">Open</Badge>
              ) : (
                <Button
                  className="min-h-[48px] shrink-0"
                  onClick={() => onOpen(match)}
                  aria-label={`Open the existing record for ${match.name}`}
                >
                  This is the patient
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Now, as this tablet's clock reads it, for a `datetime-local` blank.
 *
 * The queue is filled in for somebody standing at the desk, so the common case
 * is this minute and the uncommon one is typed over it. `toISOString()` would
 * put the field five and a half hours behind the clinic.
 */
function nowOnThisTablet(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function PatientsPanel({
  data,
  run,
  canRegister = true,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  canRegister?: boolean
}) {
  const busy = useBusy()
  const { patientId, select } = useSelectedPatient()
  const [messaging, setMessaging] = useState<PatientView | null>(null)

  // The three fields the duplicate check reads are held here; the rest of the
  // registration form stays uncontrolled, as the other forms in this app are.
  const [name, setName] = useState('')
  const [age, setAge] = useState('')
  const [phone, setPhone] = useState('')
  const [matches, setMatches] = useState<PossibleMatch[]>([])
  const [checking, setChecking] = useState(false)
  const [opened, setOpened] = useState<PossibleMatch | null>(null)
  const [justRegistered, setJustRegistered] = useState<{ name: string; phone: string } | null>(null)

  /**
   * A patient who has just been registered is the patient being worked on.
   *
   * `create_patient` answers with a sentence rather than an id, so the new row
   * is found in the snapshot that came back with it. Without this the desk
   * registers somebody and is then made to find that same person in a
   * dropdown of everybody, one second later, to give them a token.
   */
  useEffect(() => {
    if (!justRegistered) return
    const registered = data.patients
      .filter(
        (patient) =>
          patient.name === justRegistered.name && patient.phone === justRegistered.phone,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!registered) return
    select(registered.id)
    setJustRegistered(null)
  }, [justRegistered, data.patients, select])

  useEffect(() => {
    // The server answers nothing below this much to go on, so do not ask it on
    // every letter of a name that has only just started.
    if (name.trim().length < 2 && phone.replace(/\D/g, '').length < 6) {
      setMatches([])
      setChecking(false)
      return
    }

    let current = true
    setChecking(true)
    const timer = window.setTimeout(() => {
      void findPossibleMatches(name, phone, age)
        .then((found) => {
          if (current) setMatches(found)
        })
        .catch(() => {
          // A failed question is not a failed registration. The desk carries
          // on; the worst case is a duplicate somebody merges by hand later.
          if (current) setMatches([])
        })
        .finally(() => {
          if (current) setChecking(false)
        })
    }, 400)

    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [name, age, phone])

  async function addPatient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const result = await run('create_patient', {
      name,
      age,
      sex: values.get('sex'),
      phone,
      address: values.get('address'),
      whatsappConsent: values.get('whatsappConsent') === 'on',
    })
    if (result.ok) {
      setJustRegistered({ name, phone })
      form.reset()
      setName('')
      setAge('')
      setPhone('')
      setMatches([])
      setOpened(null)
    }
  }

  async function addAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const result = await run('create_appointment', {
      // The patient the clinic is working on, not a second choice from a
      // second dropdown. Selecting a duplicate candidate above lands here.
      patientId,
      reason: values.get('reason'),
      scheduledAt: values.get('scheduledAt'),
    })
    if (result.ok) form.reset()
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Patient registry"
        title="Patients & visits"
        sub={`${data.patients.length} registered`}
      />

      {canRegister ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-print="hide">
          <Disclosure label="Register a new patient" hint="Name, age and a mobile number are enough to start">
            <form onSubmit={addPatient} className="space-y-4">
              <FieldRow>
                <Field label="Full name" required>
                  <Input
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </Field>
                <Field label="Age" unit="years" required>
                  <Input
                    name="age"
                    type="number"
                    min="0"
                    max="130"
                    inputMode="numeric"
                    value={age}
                    onChange={(event) => setAge(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Sex">
                  <Select name="sex" defaultValue="female">
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Field label="Mobile number" required>
                  <Input
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Address" className="sm:col-span-2">
                  <Input name="address" />
                </Field>
              </FieldRow>
              <CheckRow
                name="whatsappConsent"
                label="WhatsApp consent recorded"
                hint="Without it this patient cannot be messaged."
              />

              {/* Before the create action, never after it. After is a report
                  of a mistake; before is a chance not to make it. */}
              <PossibleMatches
                matches={matches}
                checking={checking}
                opened={opened}
                selectedId={patientId}
                onOpen={(match) => {
                  select(match.id)
                  setOpened(match)
                }}
              />

              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
                Save patient
              </ActionButton>
            </form>
          </Disclosure>

          <Disclosure label="Add to today's queue" hint="Issues the next token in the queue">
            <form onSubmit={addAppointment} className="space-y-4">
              <FieldRow>
                <Field label="Patient" required className="sm:col-span-2">
                  <Select
                    value={patientId}
                    onChange={(event) => select(event.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Choose patient
                    </option>
                    {data.patients.map((patient) => (
                      <option key={patient.id} value={patient.id}>
                        {patient.name} · {patient.age}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason" required>
                  <Input name="reason" required />
                </Field>
                <Field label="Date and time" required>
                  <Input name="scheduledAt" type="datetime-local" defaultValue={nowOnThisTablet()} required />
                </Field>
              </FieldRow>
              <ActionButton
                type="submit"
                variant="primary"
                className="min-h-[56px]"
                busy={busy}
                busyLabel="Adding…"
                disabled={patientId === ''}
                disabledReason="Choose the patient first."
              >
                Add to today&rsquo;s queue
              </ActionButton>
            </form>
          </Disclosure>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Register" sub={`${data.patients.length} patients`} />
        {data.patients.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nobody is registered yet"
              direction="Register the first patient above and they appear on this register."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH num>Age</TH>
                <TH>Sex</TH>
                <TH>Mobile</TH>
                <TH>Last BP</TH>
                <TH>WhatsApp</TH>
                <TH>Message</TH>
                <TH>Work on</TH>
              </TR>
            </THead>
            <TBody>
              {data.patients.map((patient) => {
                const latestVital = data.vitals.find((vital) => vital.patientId === patient.id)
                const open = patient.id === patientId
                return (
                  <TR key={patient.id} active={open}>
                    <TD className="font-semibold">{patient.name}</TD>
                    <TD num>{patient.age}</TD>
                    <TD className="text-ink-2">{patient.sex}</TD>
                    <TD num>{patient.phone}</TD>
                    {/* An em dash means no reading was ever taken for this
                        patient; "Not measured" means one was taken without a
                        blood pressure in it. They are different facts. */}
                    <TD num>
                      {!latestVital ? (
                        '—'
                      ) : latestVital.bp ? (
                        latestVital.bp
                      ) : (
                        <span className="text-[11px] text-ink-2">Not measured</span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={patient.whatsappConsent ? 'free' : 'plain'}>
                        {patient.whatsappConsent ? 'Consented' : 'No consent'}
                      </Badge>
                    </TD>
                    <TD>
                      <Button size="sm" onClick={() => setMessaging(patient)} data-print="hide">
                        WhatsApp
                      </Button>
                    </TD>
                    <TD>
                      {open ? (
                        <Badge tone="live">Open</Badge>
                      ) : (
                        <Button
                          size="sm"
                          data-print="hide"
                          aria-label={`Work on ${patient.name}`}
                          onClick={() => select(patient.id)}
                        >
                          Open
                        </Button>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <PatientMessage
        patient={messaging}
        onClose={() => setMessaging(null)}
        connected={data.whatsapp.configured}
        connectionNote={data.whatsapp.note}
        run={run}
      />
    </Stack>
  )
}

/**
 * The patient WhatsApp composer.
 *
 * Two conditions gate the send and each one says so in words rather than
 * greying a button silently: consent must be on the record, and real Meta
 * credentials must exist. Nothing here ever pretends a message was sent.
 */
function PatientMessage({
  patient,
  onClose,
  connected,
  connectionNote,
  run,
}: {
  patient: PatientView | null
  onClose: () => void
  connected: boolean
  connectionNote: string
  run: ActionRunner
}) {
  const busy = useBusy()
  const [body, setBody] = useState('')

  const blocked = !patient?.whatsappConsent
    ? 'This patient has not consented to WhatsApp messages.'
    : !connected
      ? connectionNote || 'WhatsApp is not connected yet, so nothing can be sent.'
      : undefined

  return (
    <Modal
      open={patient !== null}
      onClose={onClose}
      title="Patient WhatsApp"
      sub={patient ? `${patient.name} · ${patient.phone}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            busy={busy}
            busyLabel="Sending…"
            disabled={Boolean(blocked) || body.trim() === ''}
            disabledReason={blocked ?? 'Write a message first.'}
            onClick={async () => {
              if (!patient) return
              const result = await run('send_patient_whatsapp', { patientId: patient.id, body })
              if (result.ok) onClose()
            }}
          >
            Send message
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Message" hint="Sent from the clinic's WhatsApp number.">
          <Textarea
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={
              patient ? `Hello ${patient.name}, this is a message from Jayamurugan Clinic.` : ''
            }
          />
        </Field>
        {blocked ? <Notice tone="bad">{blocked}</Notice> : null}
      </div>
    </Modal>
  )
}

export function BedsPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const [editing, setEditing] = useState<BedView | null>(null)
  const free = data.beds.filter((bed) => bed.status === 'available').length

  return (
    <Stack>
      <PageHeader
        eyebrow="Four-bed observation"
        title="Bed board"
        sub={`${free} free · ${data.beds.length - free} in use · ${data.beds.length} beds`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.beds.map((bed) => (
          <Card key={bed.id} variant={bed.status === 'occupied' ? 'record' : 'panel'}>
            <div className="flex h-full flex-col px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[16px] font-semibold">{bed.label}</p>
                <Badge tone={BED_TONE[bed.status]}>{words(bed.status)}</Badge>
              </div>
              <p className="mt-3 text-[14px]">
                {bed.patientName ?? <span className="text-ink-2">No patient assigned</span>}
              </p>
              {bed.admittedAt ? (
                <p className="mt-0.5 font-mono text-[12px] text-ink-2">
                  Since {formatDate(bed.admittedAt)}
                </p>
              ) : null}
              {bed.notes ? (
                <p className="mt-2 text-[12px] leading-snug text-ink-2">{bed.notes}</p>
              ) : null}
              <div className="mt-auto pt-3" data-print="hide">
                <Button size="sm" onClick={() => setEditing(bed)}>
                  Update bed
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <BedForm bed={editing} data={data} run={run} onClose={() => setEditing(null)} />
    </Stack>
  )
}

function BedForm({
  bed,
  data,
  run,
  onClose,
}: {
  bed: BedView | null
  data: ClinicSnapshot
  run: ActionRunner
  onClose: () => void
}) {
  const busy = useBusy()
  const [status, setStatus] = useState('available')
  const [patientId, setPatientId] = useState('')
  const [notes, setNotes] = useState('')

  // Re-key on the bed so each opening starts from that bed's own state.
  const key = bed?.id ?? 'none'

  return (
    <Modal
      key={key}
      open={bed !== null}
      onClose={onClose}
      title="Update bed"
      sub={bed?.label}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            busy={busy}
            busyLabel="Saving…"
            disabled={status === 'occupied' && !patientId}
            disabledReason="Choose which patient is in this bed."
            onClick={async () => {
              if (!bed) return
              const result = await run('update_bed', { bedId: bed.id, status, patientId, notes })
              if (result.ok) onClose()
            }}
          >
            Save bed
          </ActionButton>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Status" required>
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="available">Available</option>
            <option value="occupied">Occupied</option>
            <option value="cleaning">Cleaning</option>
            <option value="out_of_service">Out of service</option>
          </Select>
        </Field>
        {status === 'occupied' ? (
          <Field label="Patient" required>
            <Select value={patientId} onChange={(event) => setPatientId(event.target.value)} required>
              <option value="">Choose patient</option>
              {data.patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name} · {patient.age}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Notes" hint="Anything the next person on shift needs to know.">
          <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

export function BillingPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const unpaid = data.bills.filter((bill) => bill.status === 'unpaid')
  const outstanding = unpaid.reduce((sum, bill) => sum + bill.amount, 0)

  return (
    <Stack>
      <PageHeader
        eyebrow="Collected at the clinic"
        title="Billing"
        sub={`${unpaid.length} unpaid · ${money(outstanding)} outstanding`}
        action={
          <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
            Print register
          </Button>
        }
      />

      <Card data-print="sheet">
        <ClinicLetterhead settings={data.settings} kind="register" />
        <CardHeader title="Bill register" sub={`${data.bills.length} bills`} />
        {data.bills.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No bills yet"
              direction="A consultation raises its own bill, and the pharmacy counter raises one per sale."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH>Item</TH>
                <TH num>Amount</TH>
                <TH>Status</TH>
                <TH>Raised</TH>
                <TH>Collect</TH>
              </TR>
            </THead>
            <TBody>
              {data.bills.map((bill) => (
                <TR key={bill.id}>
                  <TD className="font-semibold">{bill.patientName}</TD>
                  <TD className="text-ink-2">{bill.label}</TD>
                  <TD num>{money(bill.amount)}</TD>
                  <TD>
                    <Badge tone={bill.status === 'paid' ? 'free' : 'attn'}>{bill.status}</Badge>
                  </TD>
                  <TD num>{formatDate(bill.createdAt)}</TD>
                  <TD>
                    {bill.status === 'unpaid' ? (
                      <CollectPayment bill={bill} run={run} />
                    ) : (
                      <span className="font-mono text-[12px] text-ink-2 uppercase">
                        {bill.paymentMethod ?? 'paid'}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}

function CollectPayment({
  bill,
  run,
}: {
  bill: ClinicSnapshot['bills'][number]
  run: ActionRunner
}) {
  const busy = useBusy()
  const [method, setMethod] = useState('cash')

  return (
    <div className="flex items-center gap-2" data-print="hide">
      <select
        aria-label={`Payment method for ${bill.patientName}`}
        value={method}
        onChange={(event) => setMethod(event.target.value)}
        className="blank min-h-[44px] px-2 py-1.5 text-[13px] outline-none focus:border-active"
      >
        <option value="cash">Cash</option>
        <option value="upi">UPI</option>
        <option value="card">Card</option>
      </select>
      <ConfirmButton
        size="sm"
        variant="primary"
        busy={busy}
        busyLabel="…"
        title="Collect payment"
        question={
          <>
            Record <span className="font-mono font-semibold">{money(bill.amount)}</span> taken from{' '}
            <span className="font-semibold">{bill.patientName}</span> by {method}? Money changing
            hands cannot be undone here.
          </>
        }
        confirmLabel="Collect"
        onConfirm={() => run('pay_bill', { billId: bill.id, paymentMethod: method })}
      >
        Collect
      </ConfirmButton>
    </div>
  )
}


export function AuditPanel({ data }: { data: ClinicSnapshot }) {
  return (
    <Stack>
      <PageHeader
        eyebrow="Accountability"
        title="Recent activity"
        sub={`${data.audits.length} events`}
      />
      <Card>
        {data.audits.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nothing recorded yet"
              direction="Every write in the clinic — a bill, a dispense, a stock movement — lands here with the name of whoever made it."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>What</TH>
                <TH>Action</TH>
              </TR>
            </THead>
            <TBody>
              {data.audits.map((event) => (
                <TR key={event.id}>
                  <TD num>{formatDate(event.createdAt)}</TD>
                  <TD className="font-semibold">{event.actorName}</TD>
                  <TD>{event.summary}</TD>
                  <TD className="font-mono text-[12px] text-ink-2">{event.action}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}

/**
 * Printing is the tablet's own, not ours: `window.print()` hands over to
 * AirPrint on iPad and the Mopria service on Android, and the operator picks
 * the Wi-Fi printer in that sheet. There is no driver, no queue and no
 * pretending in this app.
 */
export function PrinterPanel() {
  const steps = [
    {
      title: 'Join the clinic Wi-Fi',
      body: 'Keep the tablet and the printer on the same private clinic network. A printer on a guest network will not be found.',
    },
    {
      title: 'Add it on the tablet',
      body: 'AirPrint on iPad, or the Mopria print service on Android. The tablet remembers the printer after the first time.',
    },
    {
      title: 'Run a test',
      body: "The tablet's own print sheet opens, where staff choose the printer, paper size and number of copies.",
    },
  ]

  return (
    <Stack>
      <PageHeader
        eyebrow="Tablet printing"
        title="Wi-Fi printer setup"
        action={
          <Button variant="primary" onClick={() => window.print()}>
            Print test page
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-print="hide">
        {steps.map((step, index) => (
          <Card key={step.title}>
            <div className="px-4 py-3">
              <p className="eyebrow">Step {index + 1}</p>
              <p className="mt-1 text-[15px] font-semibold">{step.title}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card variant="record" data-print="sheet">
        <CardBody className="py-6">
          <p className="eyebrow">Printer test sheet</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">Jayamurugan Clinic</p>
          <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-ink-2">
            If this sheet prints clearly — the rules solid and the figures below sharp — this tablet
            is ready for receipts, bills and supplier orders.
          </p>
          <p className="mt-3 font-mono text-[15px] tabular-nums">
            0123456789 · ₹1,234.50 · {formatDate(new Date().toISOString())}
          </p>
        </CardBody>
      </Card>
    </Stack>
  )
}

/**
 * The details that print.
 *
 * A pharmacy bill carries the drug licence number and the GSTIN; a prescription
 * carries the prescriber's council registration. Without them a printed sheet
 * is a piece of paper with numbers on it, not a receipt or a prescription —
 * which is why this screen leads with a warning rather than a form when the
 * two required numbers are missing, and why the letterhead on every printed
 * sheet says so out loud rather than printing a blank.
 */
export function ClinicSettingsPanel({
  data,
  run,
}: {
  data: ClinicSnapshot
  run: ActionRunner
}) {
  const busy = useBusy()
  const s = data.settings

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    await run('update_clinic_settings', {
      name: values.get('name'),
      address: values.get('address'),
      phone: values.get('phone'),
      email: values.get('email'),
      drugLicenceNumber: values.get('drugLicenceNumber'),
      doctorRegistrationNumber: values.get('doctorRegistrationNumber'),
      gstin: values.get('gstin'),
      consultationFee: Number(values.get('consultationFee') ?? 0),
      footerNote: values.get('footerNote'),
    })
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Clinic"
        title="Details that print"
        sub={s.updatedAt ? `Last changed ${s.updatedAt.slice(0, 10)}` : 'Never set'}
      />

      {!s.complete ? (
        <Notice tone="bad">
          Bills and prescriptions are printing without a drug licence number or a
          doctor registration number. Until both are filled in below, what comes
          out of the printer is not a valid receipt or prescription.
        </Notice>
      ) : null}

      <Card variant="record">
        <CardHeader title="Clinic identity" sub="Printed at the top of every sheet" />
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            <FieldRow cols={2}>
              <Field label="Clinic name" required>
                <Input name="name" defaultValue={s.name} required />
              </Field>
              <Field label="Phone">
                <Input name="phone" type="tel" inputMode="tel" defaultValue={s.phone} />
              </Field>
            </FieldRow>

            <Field label="Address" hint="Printed under the name on bills and prescriptions.">
              <Input name="address" defaultValue={s.address} />
            </Field>

            <FieldRow cols={2}>
              <Field
                label="Drug licence number"
                required
                hint="Form 20/21. A pharmacy bill without it is not a valid receipt."
              >
                <Input name="drugLicenceNumber" defaultValue={s.drugLicenceNumber} required />
              </Field>
              <Field
                label="Doctor registration number"
                required
                hint="The prescriber's council registration. Prints on every prescription."
              >
                <Input
                  name="doctorRegistrationNumber"
                  defaultValue={s.doctorRegistrationNumber}
                  required
                />
              </Field>
            </FieldRow>

            <FieldRow cols={3}>
              <Field label="GSTIN">
                <Input name="gstin" autoCapitalize="characters" defaultValue={s.gstin} />
              </Field>
              <Field label="Consultation fee" hint="In rupees.">
                <Input
                  name="consultationFee"
                  inputMode="decimal"
                  defaultValue={String(s.consultationFee)}
                />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" defaultValue={s.email} />
              </Field>
            </FieldRow>

            <Field
              label="Footer note"
              hint="Printed small at the foot of a bill — return policy, timings, anything."
            >
              <Input name="footerNote" defaultValue={s.footerNote} />
            </Field>

            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
              Save clinic details
            </ActionButton>
          </form>
        </CardBody>
      </Card>
    </Stack>
  )
}

/**
 * What sits at the top of a printed sheet.
 *
 * Hidden on screen — the clinic knows its own name, and the space is better
 * spent on the work — and present on every sheet that leaves the printer,
 * because that is the difference between a document and a printout.
 *
 * When the licence numbers are missing it says so on the paper rather than
 * printing a blank line. A bill that silently omits the drug licence looks
 * valid and is not; one that says the number is missing gets fixed.
 */
export function ClinicLetterhead({
  settings,
  kind,
}: {
  settings: ClinicSnapshot['settings']
  kind: 'bill' | 'prescription' | 'register'
}) {
  const required =
    kind === 'prescription' ? settings.doctorRegistrationNumber : settings.drugLicenceNumber
  const label =
    kind === 'prescription' ? 'Doctor registration' : 'Drug licence'

  return (
    <header data-print="letterhead" className="hidden border-b-2 border-ink pb-3">
      <h1 className="text-[18px] font-semibold tracking-tight">{settings.name}</h1>

      {settings.address ? (
        <p className="mt-0.5 text-[12px] text-ink-2">{settings.address}</p>
      ) : null}

      <p className="mt-0.5 font-mono text-[11px] text-ink-2">
        {[
          settings.phone,
          required ? `${label} ${required}` : null,
          settings.gstin ? `GSTIN ${settings.gstin}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {!required ? (
        <p className="mt-1 font-mono text-[11px]">
          {label} number is not set — this sheet is not a valid{' '}
          {kind === 'prescription' ? 'prescription' : 'receipt'}.
        </p>
      ) : null}
    </header>
  )
}

/**
 * The Schedule H1 register.
 *
 * Required by the Drugs and Cosmetics Rules and retained three years. An
 * inspector asks for a date range and expects a document, so this is a date
 * range and a document — the letterhead prints above it and the app chrome
 * does not print at all.
 *
 * It reports its own gaps rather than looking complete. A register quietly
 * missing entries is the failure that matters: nobody discovers it until
 * somebody official is standing at the counter.
 */
export function RegistersPanel({ data }: { data: ClinicSnapshot }) {
  const today = clinicToday()
  const monthStart = `${today.slice(0, 7)}-01`

  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterResult | null>(null)

  async function load(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const response = await callApi(`register?from=${from}&to=${to}`)
      const body = (await response.json()) as RegisterResult & { ok: boolean; message?: string }
      if (!body.ok) setError(body.message ?? 'The register could not be read.')
      else setResult(body)
    } catch {
      setError('The clinic server is not reachable.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Registers"
        title="Schedule H1"
        sub="Date, patient and address, drug, quantity, prescriber — retained three years"
        action={
          result ? (
            <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
              Print register
            </Button>
          ) : null
        }
      />

      <div data-print="hide">
        <Card>
          <CardBody>
            <form onSubmit={load} className="flex flex-wrap items-end gap-3">
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <ActionButton type="submit" variant="primary" busy={loading} busyLabel="Reading…">
                Show the register
              </ActionButton>
            </form>

            {error ? (
              <div className="mt-3">
                <Notice tone="bad">{error}</Notice>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {result ? (
        <>
          {result.unsetMedicines > 0 ? (
            <div data-print="hide">
              <Notice tone="bad">
                {result.unsetMedicines} medicine{result.unsetMedicines === 1 ? ' has' : 's have'} no
                schedule recorded, so {result.unsetMedicines === 1 ? 'it is' : 'they are'} missing
                from this register whether {result.unsetMedicines === 1 ? 'it belongs' : 'they belong'}{' '}
                in it or not. Set the schedule on each from the Inventory screen before treating this
                as complete.
              </Notice>
            </div>
          ) : null}

          {result.counterExceptions.length > 0 ? (
            <Notice tone="bad">
              {result.counterExceptions.length} Schedule H1 item
              {result.counterExceptions.length === 1 ? '' : 's'} left on a counter sale rather than
              against a prescription. An inspector will find these.
            </Notice>
          ) : null}

          <Card data-print="sheet">
            <ClinicLetterhead settings={data.settings} kind="register" />
            <CardHeader
              title="Schedule H1 register"
              sub={`${result.from} to ${result.to} · ${result.rows.length} ${
                result.rows.length === 1 ? 'entry' : 'entries'
              }`}
            />
            <CardBody>
              {result.rows.length === 0 ? (
                <EmptyState
                  title="No Schedule H1 medicine left the counter in this range"
                  direction="Widen the dates, or check that the medicines you expect here have their schedule set to H1 on the Inventory screen."
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Patient</TH>
                      <TH>Address</TH>
                      <TH>Drug</TH>
                      <TH num>Qty</TH>
                      <TH>Batch</TH>
                      <TH>Prescriber</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.rows.map((row, index) => (
                      <TR key={`${row.prescriptionId}-${index}`}>
                        <TD>
                          {row.date} {row.time}
                        </TD>
                        <TD>{row.patientName}</TD>
                        <TD>{row.patientAddress || '—'}</TD>
                        <TD>{row.drug}</TD>
                        <TD num>
                          {row.quantity} {row.unit}
                        </TD>
                        <TD>{row.batchNumber}</TD>
                        <TD>{row.prescriber}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}
    </Stack>
  )
}

interface RegisterResult {
  from: string
  to: string
  rows: Array<{
    date: string
    time: string
    patientName: string
    patientAddress: string
    drug: string
    batchNumber: string
    quantity: number
    unit: string
    prescriber: string
    prescriptionId: string
  }>
  unsetMedicines: number
  counterExceptions: Array<{ date: string; drug: string; quantity: number; receiptNumber: string }>
}
