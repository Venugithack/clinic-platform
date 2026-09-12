'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  BedView,
  ClinicSnapshot,
  CommandResponse,
  InvoiceLineView,
  InvoiceView,
  PatientView,
  Role,
} from '@/lib/types'
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
  clinicToday,
  formatDate,
  formatDay,
  money,
  words,
  type Tone,
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

export function OverviewPanel({ data, run }: { data: ClinicSnapshot; run?: ActionRunner }) {
  const busy = useBusy()
  const { select, goTo } = useSelectedPatient()
  const waiting = data.appointments.filter(
    (item) => item.status === 'waiting' || item.status === 'in_consult',
  )
  const low = data.medicines.filter((item) => item.active && item.totalAvailable <= item.reorderLevel)
  /*
   * What is owed, derived rather than read off a flag.
   *
   * This used to count bills whose `status` column said `unpaid`, which could
   * not describe a bill that had been part paid — the commonest case at this
   * counter — and would have gone on saying "unpaid" beside a bill with ₹10
   * left on it. `due` comes from the lines and the payment allocations every
   * time it is read, so a part-paid bill counts once and for what is actually
   * left on it.
   *
   * An over-refunded bill is not one of these, however much its `due` looks
   * like one. Its `paid` is below zero, so its `due` is larger than its own
   * total, and counting it here would put money the clinic has already sent
   * back out into the figure for money the clinic is waiting to be given. It
   * is held out and said separately.
   *
   * A cancelled bill with money still on it is held out by `status` before any
   * of that, so it can never reach the owing figure — but it is counted over
   * every bill rather than over the live ones, because a count that comes from
   * `liveInvoices` would say nothing about it at all, on the one screen a
   * doctor or nurse reads in the morning.
   */
  const liveInvoices = data.invoices.filter((item) => item.status !== 'void')
  const underReview = data.invoices.filter(isUnderReview)
  const owing = liveInvoices.filter((item) => item.due > 0 && !isUnderReview(item))
  const outstanding = owing.reduce((sum, item) => sum + item.due, 0)
  const occupied = data.beds.filter((item) => item.status === 'occupied')
  const attention = [...low].slice(0, 5)
  const openFollowUps = data.followUps.filter((item) => item.status === 'open')

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
          label="Bills owing"
          value={owing.length}
          note={
            underReview.length > 0
              ? `${money(outstanding)} still due · ${underReview.length} ${underReview.length === 1 ? 'bill is' : 'bills are'} under review, left out of that figure and waiting on Billing`
              : `${money(outstanding)} still due`
          }
        />
        <Stat label="Low stock" value={low.length} note="At or below reorder level" />
      </div>

      {data.session.roles.includes('doctor') && openFollowUps.length ? (
        <Card variant="record">
          <CardHeader title="Follow-up reminders" sub={`${openFollowUps.length} open`} />
          <CardBody className="space-y-2">
            {openFollowUps.map((followUp) => {
              const overdue = followUp.dueDate < clinicToday()
              return (
                <div key={followUp.id} className="flex flex-wrap items-center gap-3 border-b border-rule pb-2 last:border-b-0">
                  <div className="min-w-[220px] flex-1">
                    <p className="font-semibold">{followUp.patientName}</p>
                    <p className={`text-[12px] ${overdue ? 'font-semibold text-stop' : 'text-ink-2'}`}>
                      {overdue ? 'Overdue' : 'Due'} {followUp.dueDate} · {followUp.note || 'Review'}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => { select(followUp.patientId); goTo('consultation') }}>Open patient</Button>
                  {run ? <ActionButton size="sm" busy={busy} onClick={() => run('complete_follow_up', { followUpId: followUp.id, status: 'completed' })}>Mark completed</ActionButton> : null}
                </div>
              )
            })}
          </CardBody>
        </Card>
      ) : null}

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
  const [observing, setObserving] = useState<BedView | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const free = data.beds.filter((bed) => bed.status === 'available').length
  const canNurse = data.session.roles.some((role) => role === 'admin' || role === 'nurse')
  const canDoctor = data.session.roles.includes('doctor')

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <Stack>
      <PageHeader
        eyebrow="Four-bed observation"
        title="Bed board"
        sub={`${free} free · ${data.beds.length - free} in use · ${data.beds.length} beds`}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
              {bed.status === 'occupied' ? (
                <div className="mt-3 space-y-2 border-t border-rule pt-3">
                  <ObservationTimer at={bed.nextCheckAt} clock={clock} />
                  {bed.doctorInstructions ? (
                    <p className="text-[12px]"><span className="font-semibold">Doctor:</span> {bed.doctorInstructions}</p>
                  ) : null}
                  {bed.handoffRequestedAt && !bed.handoffResolvedAt ? (
                    <Badge tone="stop">Doctor handoff requested</Badge>
                  ) : bed.handoffResolvedAt ? (
                    <Badge tone="free">Handoff acknowledged</Badge>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-auto flex flex-wrap gap-2 pt-3" data-print="hide">
                {canNurse ? <Button size="sm" onClick={() => setEditing(bed)}>Update bed</Button> : null}
                {bed.status === 'occupied' && (canNurse || canDoctor) ? (
                  <Button size="sm" variant={bed.handoffRequestedAt && !bed.handoffResolvedAt ? 'primary' : 'secondary'} onClick={() => setObserving(bed)}>
                    Observation actions
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <BedForm bed={editing} data={data} run={run} onClose={() => setEditing(null)} />
      <ObservationForm
        bed={observing}
        data={data}
        run={run}
        onClose={() => setObserving(null)}
      />
    </Stack>
  )
}

function ObservationTimer({ at, clock }: { at?: string; clock: number }) {
  if (!at) return <p className="text-[12px] text-ink-2">Next check not scheduled</p>
  const difference = new Date(at).getTime() - clock
  if (!Number.isFinite(difference)) return <p className="text-[12px] text-stop">Next check time needs review</p>
  const minutes = Math.max(0, Math.ceil(Math.abs(difference) / 60_000))
  return difference <= 0 ? (
    <p className="font-mono text-[13px] font-semibold text-stop">Check overdue · {minutes} min</p>
  ) : (
    <p className="font-mono text-[13px] font-semibold text-attn">Next check · {minutes} min</p>
  )
}

function localDateTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
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
  const [nextCheckAt, setNextCheckAt] = useState('')

  useEffect(() => {
    if (!bed) return
    setStatus(bed.status)
    setPatientId(bed.patientId ?? '')
    setNotes(bed.notes ?? '')
    setNextCheckAt(localDateTime(bed.nextCheckAt))
  }, [bed])

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
              const result = await run('update_bed', {
                bedId: bed.id, status, patientId, notes, nextCheckAt,
              })
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
            {bed?.status === 'occupied' ? null : <option value="available">Available</option>}
            <option value="occupied">Occupied</option>
            {bed?.status === 'occupied' ? null : <option value="cleaning">Cleaning</option>}
            {bed?.status === 'occupied' ? null : <option value="out_of_service">Out of service</option>}
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
        {status === 'occupied' ? (
          <Field label="Next check" hint="Starts the observation countdown on the bed board.">
            <Input type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}

function ObservationForm({
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
  const canNurse = data.session.roles.some((role) => role === 'admin' || role === 'nurse')
  const canDoctor = data.session.roles.includes('doctor')
  const [note, setNote] = useState('')
  const [nextCheckAt, setNextCheckAt] = useState('')
  const [instructions, setInstructions] = useState('')
  const [outcome, setOutcome] = useState<'discharged' | 'transferred'>('discharged')
  const [closureNote, setClosureNote] = useState('')

  useEffect(() => {
    setNote('')
    setNextCheckAt(localDateTime(bed?.nextCheckAt))
    setInstructions(bed?.doctorInstructions ?? '')
    setOutcome('discharged')
    setClosureNote('')
  }, [bed])

  return (
    <Modal open={bed !== null} onClose={onClose} title="Observation actions" sub={bed ? `${bed.label} · ${bed.patientName ?? 'No patient'}` : undefined}>
      <div className="space-y-5">
        {canNurse ? (
          <section className="space-y-3">
            <p className="eyebrow">Nursing observation</p>
            <Field label="Observation note"><Textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field>
            <Field label="Next check"><Input type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              <ActionButton busy={busy} disabled={!note.trim() && !nextCheckAt} onClick={async () => {
                if (!bed) return
                const result = await run('record_observation', { bedId: bed.id, note, nextCheckAt })
                if (result.ok) { setNote(''); onClose() }
              }}>Save observation</ActionButton>
              <ActionButton busy={busy} onClick={async () => {
                if (!bed) return
                const result = await run('request_observation_handoff', { bedId: bed.id, note })
                if (result.ok) onClose()
              }}>Request doctor handoff</ActionButton>
            </div>
          </section>
        ) : null}

        {canDoctor ? (
          <section className="space-y-3 border-t border-rule pt-4">
            <p className="eyebrow">Doctor instruction</p>
            <Field label="Instruction"><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              <ActionButton busy={busy} disabled={!instructions.trim()} onClick={async () => {
                if (!bed) return
                const result = await run('set_observation_instructions', { bedId: bed.id, instructions })
                if (result.ok) onClose()
              }}>Save instruction</ActionButton>
              {bed?.handoffRequestedAt && !bed.handoffResolvedAt ? (
                <ActionButton variant="primary" busy={busy} onClick={async () => {
                  const result = await run('resolve_observation_handoff', { bedId: bed.id, note: instructions })
                  if (result.ok) onClose()
                }}>Acknowledge handoff</ActionButton>
              ) : null}
            </div>
          </section>
        ) : null}

        {canNurse ? (
          <section className="space-y-3 border-t border-rule pt-4">
            <p className="eyebrow">Close observation</p>
            <FieldRow>
              <Field label="Outcome"><Select value={outcome} onChange={(event) => setOutcome(event.target.value as 'discharged' | 'transferred')}><option value="discharged">Discharged</option><option value="transferred">Transferred</option></Select></Field>
              <Field label="Outcome note" required><Input value={closureNote} onChange={(event) => setClosureNote(event.target.value)} /></Field>
            </FieldRow>
            <ConfirmButton
              variant="danger"
              confirmVariant="danger"
              busy={busy}
              disabled={!closureNote.trim()}
              title={outcome === 'discharged' ? 'Discharge patient?' : 'Record transfer?'}
              question={`${outcome === 'discharged' ? 'Discharge' : 'Transfer'} ${bed?.patientName ?? 'this patient'} and mark ${bed?.label ?? 'this bed'} for cleaning? The observation history is kept.`}
              confirmLabel={outcome === 'discharged' ? 'Confirm discharge' : 'Confirm transfer'}
              onConfirm={async () => {
                if (!bed) return
                const result = await run('close_observation', {
                  bedId: bed.id, outcome, note: closureNote, confirmed: true,
                })
                if (result.ok) onClose()
              }}
            >
              {outcome === 'discharged' ? 'Discharge patient' : 'Record transfer'}
            </ConfirmButton>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}

/* ══════════════════════════════════════════════════════ money, as a fabric */

/**
 * The pieces every screen that touches money is built from.
 *
 * They live here rather than beside the counter because both ends of the
 * clinic's money use them: the pharmacy takes a split payment at the counter
 * and an admin refunds one on the Billing screen, and those must be the same
 * control or they will drift into being two different sets of rules about what
 * a reference is and whether a method is optional.
 */

/** Where a charge came from, in the clinic's words rather than the column's. */
export const SOURCE_LABEL: Record<InvoiceLineView['source'], string> = {
  consultation_fee: 'Consultation',
  prescription: 'Medicine',
  otc: 'Counter sale',
  adjustment: 'Adjustment',
}

/*
 * `over_refunded` takes `stop`, the same tone as `unpaid`, because the tone set
 * says what kind of thing a state is and both of these are money the clinic
 * has to do something about. It is the word that says which: a bill nobody has
 * paid and a bill more money has left than ever entered are not the same
 * problem, and only one of them is settled at a counter.
 *
 * `void_with_balance` takes the same `stop` for the same reason, which means
 * two states now share the strongest tone. That is the point of the tone: both
 * are arithmetic nobody intended and both wait on the same two people, so a
 * reader scanning the register sees one colour for "somebody has to look at
 * this" and then reads the word for what it is. `void` keeps `plain` — a
 * cancelled bill at nothing is a closed matter, and a cancelled bill with
 * money on it is not, so they must not read alike from across the room.
 */
const PAYMENT_STATE: Record<InvoiceView['paymentState'], { word: string; tone: Tone }> = {
  unpaid: { word: 'Unpaid', tone: 'stop' },
  part_paid: { word: 'Part paid', tone: 'attn' },
  paid: { word: 'Paid', tone: 'free' },
  void: { word: 'Void', tone: 'plain' },
  over_refunded: { word: 'Over-refunded', tone: 'stop' },
  void_with_balance: { word: 'Void with money', tone: 'stop' },
}

/**
 * Is this bill an accounting exception rather than a stage of collection?
 *
 * Both states say the arithmetic landed somewhere nobody intended, and neither
 * is resolved by anything a counter or an admin button can do — they are
 * settled by a correction an administrator and the clinic's accountant agree
 * between them. A screen asking "may I offer an action on this bill?" asks
 * this, rather than naming one of the two states: naming one is exactly how
 * the first exception came to be handled on every screen and the second on
 * none of them.
 */
export function isUnderReview(invoice: Pick<InvoiceView, 'paymentState'>): boolean {
  return invoice.paymentState === 'over_refunded' || invoice.paymentState === 'void_with_balance'
}

/**
 * The money left on a cancelled bill, said as what it actually is.
 *
 * The figure is signed on purpose: above zero is money the clinic still holds
 * against a bill it is not charging anybody for, below zero is money that went
 * back out past one. Those need opposite sentences, so the sign is read in one
 * place rather than at each figure that prints it.
 */
export function voidBalanceWords(amount: number, count: number): string {
  const bills = count === 1 ? 'a cancelled bill' : 'cancelled bills'
  if (amount > 0) return `${money(amount)} is still held against ${bills}`
  if (amount < 0) return `${money(-amount)} went back out past ${bills}`
  return `money sits on both sides of zero against ${bills} and nets out to nothing`
}

/** The bill's state as a word. The tone repeats it; it never replaces it. */
export function PaymentStateBadge({ invoice }: { invoice: InvoiceView }) {
  const state = PAYMENT_STATE[invoice.paymentState]
  return state ? (
    <Badge tone={state.tone}>{state.word}</Badge>
  ) : (
    <Badge tone="plain">{words(invoice.paymentState)}</Badge>
  )
}

export const METHOD_LABEL = { cash: 'Cash', upi: 'UPI / GPay', card: 'Card' } as const
export type Method = keyof typeof METHOD_LABEL
const METHODS = ['cash', 'upi', 'card'] as const

/**
 * Paise, read the way `parseMoney` on the server reads them.
 *
 * For the screen, and for deciding whether a button says "Take payment" or
 * "Record part payment" — never for what is sent. What is sent is the string
 * the counter typed, so the figure on the bill is the one the server parsed and
 * not one this file rounded on the way past.
 */
function paiseOf(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/^₹\s*/, '').replaceAll(',', '')
  if (cleaned === '') return undefined
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return undefined
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** An amount held in paise, printed the one way this clinic prints money. */
export function fromPaise(paise: number): string {
  return money(paise / 100)
}

/**
 * One row of a split. Cash and GPay on the same bill is two of these, and two
 * receipt numbers, because that is what the day book reconciles against.
 */
export type PartDraft = { key: string; method: Method; amount: string; reference: string }

export function blankPart(amount = ''): PartDraft {
  return { key: crypto.randomUUID(), method: 'cash', amount, reference: '' }
}

/** What has been typed, totalled for the screen. Undefined if a row is not an amount. */
export function partsTotal(parts: PartDraft[]): number | undefined {
  let total = 0
  for (const part of parts) {
    if (part.amount.trim() === '') continue
    const paise = paiseOf(part.amount)
    if (paise === undefined) return undefined
    total += paise
  }
  return total
}

/** The `parts` a command reads. The amount goes across exactly as typed. */
export function partsPayload(parts: PartDraft[]) {
  return parts
    .filter((part) => part.amount.trim() !== '')
    .map((part) => ({
      method: part.method,
      amount: part.amount.trim(),
      reference: part.reference.trim(),
    }))
}

export function PaymentParts({
  parts,
  onChange,
  legend,
  hint,
}: {
  parts: PartDraft[]
  onChange: (parts: PartDraft[]) => void
  legend: string
  hint?: string
}) {
  const busy = useBusy()
  const total = partsTotal(parts)

  function patch(key: string, change: Partial<PartDraft>) {
    onChange(parts.map((part) => (part.key === key ? { ...part, ...change } : part)))
  }

  return (
    <div>
      <SectionHeader title={legend} sub={hint} />
      <div className="mt-2 space-y-3">
        {parts.map((part, index) => (
          <div
            key={part.key}
            className="grid grid-cols-1 gap-3 border-l-2 border-ink bg-paper/40 p-3 sm:grid-cols-[minmax(0,150px)_minmax(0,140px)_minmax(0,1fr)_auto] sm:items-end"
          >
            <Field label={`Part ${index + 1} · method`} required>
              <Select
                value={part.method}
                disabled={busy}
                onChange={(event) => patch(part.key, { method: event.target.value as Method })}
              >
                {METHODS.map((method) => (
                  <option key={method} value={method}>
                    {METHOD_LABEL[method]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" unit="₹">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={part.amount}
                disabled={busy}
                aria-label={`Amount of part ${index + 1}`}
                onChange={(event) => patch(part.key, { amount: event.target.value })}
              />
            </Field>
            <Field label="Reference" hint="Optional. The UPI or card reference, if there is one.">
              <Input
                value={part.reference}
                disabled={busy}
                aria-label={`Reference for part ${index + 1}`}
                onChange={(event) => patch(part.key, { reference: event.target.value })}
              />
            </Field>
            {parts.length > 1 ? (
              <Button
                variant="danger"
                disabled={busy}
                aria-label={`Remove part ${index + 1}`}
                onClick={() => onChange(parts.filter((row) => row.key !== part.key))}
              >
                Remove
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button disabled={busy} onClick={() => onChange([...parts, blankPart()])}>
            Add another part
          </Button>
          <p className="font-mono text-[13px] text-ink-2">
            {total === undefined
              ? 'One of those amounts is not an amount in rupees.'
              : `${parts.length} ${parts.length === 1 ? 'part' : 'parts'} · ${fromPaise(total)}`}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * An action that cannot be taken without saying why.
 *
 * Voiding a bill, reversing a receipt and recording that a patient declined a
 * line all keep their reason on the record beside the actor and the time, so
 * the reason is collected before the action rather than typed into an audit
 * note afterwards. A refusal keeps the dialog and the typed reason, so the next
 * attempt is a correction rather than a retype.
 */
export function ReasonAction({
  children,
  title,
  question,
  confirmLabel,
  reasonLabel = 'Reason',
  reasonHint,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  disabledReason,
  onConfirm,
}: {
  children: ReactNode
  title: string
  question: ReactNode
  confirmLabel: string
  reasonLabel?: string
  reasonHint?: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  disabledReason?: string
  onConfirm: (reason: string) => Promise<CommandResponse | void>
}) {
  const busy = useBusy()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  async function commit() {
    const result = await onConfirm(reason.trim())
    if (!result || result.ok) {
      setOpen(false)
      setReason('')
    }
  }

  return (
    <>
      <ActionButton
        variant={variant}
        size={size}
        busy={busy}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => setOpen(true)}
      >
        {children}
      </ActionButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ActionButton
              variant={variant === 'danger' ? 'danger' : 'primary'}
              busy={busy}
              disabled={reason.trim() === ''}
              disabledReason="Say why before this is recorded."
              onClick={commit}
            >
              {confirmLabel}
            </ActionButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="text-[14px] leading-relaxed">{question}</div>
          <Field label={reasonLabel} hint={reasonHint} required>
            <Textarea
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}

/** A figure with the word that says what it is. Never a number on its own. */
export function Figure({
  label,
  value,
  note,
  strong = false,
}: {
  label: string
  value: ReactNode
  note?: string
  strong?: boolean
}) {
  return (
    <div className={`min-w-0 border bg-sheet px-2.5 py-2 ${strong ? 'border-ink' : 'border-rule'}`}>
      <p className="eyebrow">{label}</p>
      <p
        className={`mt-1 font-mono tabular-nums ${strong ? 'text-[20px] font-medium' : 'text-[17px]'}`}
      >
        {value}
      </p>
      {note ? <p className="mt-0.5 text-[11px] leading-snug text-ink-2">{note}</p> : null}
    </div>
  )
}

/** Every charge on the bill, with the desk it came from beside it. */
export function InvoiceLines({ invoice }: { invoice: InvoiceView }) {
  if (invoice.lines.length === 0) {
    return <p className="text-[13px] text-ink-2">This bill has no charges on it yet.</p>
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH num>#</TH>
          <TH>From</TH>
          <TH>Charge</TH>
          <TH num>Quantity</TH>
          <TH num>Each</TH>
          <TH num>Amount</TH>
        </TR>
      </THead>
      <TBody>
        {invoice.lines.map((line) => (
          <TR key={line.id}>
            <TD num>{line.lineNumber}</TD>
            <TD>{SOURCE_LABEL[line.source] ?? words(line.source)}</TD>
            <TD className="font-semibold">{line.description}</TD>
            <TD num>{line.quantity}</TD>
            <TD num>{money(line.unitAmount)}</TD>
            <TD num>{money(line.amount)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}

/**
 * What has been taken against this bill, and what came back.
 *
 * A reversal and a refund are different rows and say so in words: one means the
 * money never arrived, the other that it went back. Reversing is an admin
 * decision, so the column only appears where somebody may take it.
 */
export function InvoicePayments({
  invoice,
  run,
  canReverse = false,
}: {
  invoice: InvoiceView
  run?: ActionRunner
  canReverse?: boolean
}) {
  return (
    <div>
      <SectionHeader title="Money against this bill" sub={`${invoice.payments.length} recorded`} />
      <Table>
        <THead>
          <TR>
            <TH num>Receipt</TH>
            <TH>Kind</TH>
            <TH>Method</TH>
            <TH>Reference</TH>
            <TH num>Amount</TH>
            <TH>State</TH>
            <TH num>Taken</TH>
            {canReverse ? <TH>Reverse</TH> : null}
          </TR>
        </THead>
        <TBody>
          {invoice.payments.map((payment) => (
            <TR key={payment.id} muted={payment.status === 'reversed'}>
              <TD num>{payment.receiptNumber}</TD>
              <TD>{payment.kind === 'refund' ? 'Refund' : 'Payment'}</TD>
              <TD>{METHOD_LABEL[payment.method] ?? words(payment.method)}</TD>
              <TD className="text-ink-2">{payment.reference || '—'}</TD>
              <TD num>{money(payment.amount)}</TD>
              <TD>
                {payment.status === 'reversed' ? (
                  <Badge tone="stop">Reversed</Badge>
                ) : (
                  <Badge tone="free">Received</Badge>
                )}
              </TD>
              <TD num>{formatDate(payment.receivedAt)}</TD>
              {canReverse ? (
                <TD>
                  {payment.status === 'reversed' || !run ? (
                    <span className="text-[12px] text-ink-2">{payment.reversalReason || '—'}</span>
                  ) : (
                    <ReasonAction
                      size="sm"
                      variant="danger"
                      title="Reverse this receipt"
                      confirmLabel="Reverse the receipt"
                      reasonLabel="Why it never arrived"
                      reasonHint="A reversal says the money never arrived. A refund says it came back — they are not the same."
                      question={
                        <>
                          Reverse receipt{' '}
                          <span className="font-mono font-semibold">{payment.receiptNumber}</span>{' '}
                          for {money(payment.amount)}? It keeps its number and stays on the record
                          as reversed, and it stops counting towards what has been paid.
                        </>
                      }
                      onConfirm={(reason) =>
                        run('reverse_payment', { paymentId: payment.id, reason })
                      }
                    >
                      Reverse
                    </ReasonAction>
                  )}
                </TD>
              ) : null}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  )
}

/**
 * The money the clinic is owed, and the corrections only an admin may make.
 *
 * Slice 4 replaced a bill — one row, one amount, a paid flag — with an invoice
 * header, immutable charge lines and payment allocations. Nothing on this
 * screen edits a total: a bill comes down because an adjustment line was added
 * to it, a receipt stops counting because it was reversed, and money goes back
 * because a refund was recorded. Each of those keeps the original exactly as it
 * was printed.
 */
export function BillingPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const admin = data.session.roles.includes('admin')
  const live = data.invoices.filter((invoice) => invoice.status !== 'void')
  /*
   * The two exceptions, held apart from the money the clinic is owed — and
   * counted over every bill rather than over `live`.
   *
   * An over-refunded bill has a `paid` below zero, so its `due` is bigger than
   * its own total and it reads exactly like a large unpaid bill. It is not
   * one: that figure is money the clinic has already sent back out twice over,
   * and no payment closes it. Counting it as owing inflates the day's
   * outstanding with money nobody is going to bring in. The magnitude is
   * `-paid` — what went out beyond what ever came in.
   *
   * A cancelled bill that is not at nothing has the opposite trouble. `live`
   * drops every voided bill, which is right for what is owed and wrong for
   * what needs looking at: counted that way the exception is nowhere on this
   * screen at all — not in the header, not in the notice, not in a figure —
   * and the only mark of it is a badge in the register that a reader has to
   * happen upon. So both exceptions are counted out of `data.invoices`.
   *
   * The two states are exclusive, `void_with_balance` being decided first, so
   * a bill is in one list or the other and the queue is the two added up.
   */
  const overRefunded = data.invoices.filter((invoice) => invoice.paymentState === 'over_refunded')
  const overRefundedAmount = overRefunded.reduce((total, invoice) => total - invoice.paid, 0)
  const voidWithBalance = data.invoices.filter(
    (invoice) => invoice.paymentState === 'void_with_balance',
  )
  /* Split by direction, because one of these is money the clinic is sitting on
     and the other is money it has already let go, and a net figure across the
     two would describe neither. */
  const voidHeld = voidWithBalance.filter((invoice) => invoice.paid > 0)
  const voidRefundedPast = voidWithBalance.filter((invoice) => invoice.paid < 0)
  const voidHeldAmount = voidHeld.reduce((total, invoice) => total + invoice.paid, 0)
  const voidRefundedPastAmount = voidRefundedPast.reduce((total, invoice) => total - invoice.paid, 0)
  const underReviewCount = overRefunded.length + voidWithBalance.length
  const bothKinds = overRefunded.length > 0 && voidWithBalance.length > 0
  /* The words the register actually shows today, so the notice sends a reader
     looking for a badge that is down there rather than one that is not. */
  const reviewMarks = bothKinds
    ? 'Over-refunded or Void with money'
    : overRefunded.length > 0
      ? 'Over-refunded'
      : 'Void with money'
  const owing = live.filter((invoice) => invoice.due > 0 && !isUnderReview(invoice))
  const voided = data.invoices.filter((invoice) => invoice.status === 'void')
  const outstanding = owing.reduce((total, invoice) => total + invoice.due, 0)
  const owedByPatients = data.patientBalances.reduce(
    (total, balance) => total + balance.outstanding,
    0,
  )
  /* The same money seen from the patient's side: the over-refund sits inside
     `outstanding` on their row, which is why the row has to say so. The money
     on a cancelled bill does not — the view's money columns leave voided bills
     out — so that one has to be said for the opposite reason. */
  const overRefundedByPatients = data.patientBalances.reduce(
    (total, balance) => total + balance.overRefundedAmount,
    0,
  )
  const voidWithBalanceByPatients = data.patientBalances.reduce(
    (total, balance) => total + balance.voidWithBalanceAmount,
    0,
  )
  const voidWithBalanceBillsByPatients = data.patientBalances.reduce(
    (total, balance) => total + balance.voidWithBalanceInvoices,
    0,
  )

  const [openId, setOpenId] = useState('')
  const open = data.invoices.find((invoice) => invoice.id === openId) ?? null

  return (
    <Stack>
      <PageHeader
        eyebrow="Collected at the clinic"
        title="Billing"
        sub={`${owing.length} bills owing · ${money(outstanding)} outstanding · ${data.patientBalances.length} patients carrying a balance${underReviewCount > 0 ? ` · ${underReviewCount} under financial review` : ''}`}
        action={
          <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
            Print register
          </Button>
        }
      />

      {/* One notice, two kinds, each said in its own sentence. They share a
          closing because they share an ending: neither is money owed and
          neither is closed from this screen. */}
      {underReviewCount > 0 ? (
        <div data-print="hide">
          <Notice tone="bad">
            {overRefunded.length > 0 ? (
              <>
                {overRefunded.length === 1
                  ? `One bill is over-refunded: ${money(overRefundedAmount)} more has gone back out on it than ever came in.`
                  : `${overRefunded.length} bills are over-refunded: ${money(overRefundedAmount)} more has gone back out on them than ever came in.`}{' '}
              </>
            ) : null}
            {voidWithBalance.length > 0 ? (
              <>
                {voidWithBalance.length === 1
                  ? 'One cancelled bill is not at nothing.'
                  : `${voidWithBalance.length} cancelled bills are not at nothing.`}{' '}
                {voidHeld.length > 0
                  ? `${money(voidHeldAmount)} is still held against ${voidHeld.length === 1 ? 'a bill' : 'bills'} nobody is being charged for. `
                  : ''}
                {voidRefundedPast.length > 0
                  ? `${money(voidRefundedPastAmount)} went back out past ${voidRefundedPast.length === 1 ? 'a bill' : 'bills'} already cancelled. `
                  : ''}
                Voiding now needs a bill at exactly nothing, and no receipt against a voided bill
                can be reversed, so {voidWithBalance.length === 1 ? 'this' : 'each of these'} came
                across with the old records rather than happening here.{' '}
              </>
            ) : null}
            {bothKinds
              ? 'Neither kind is money owed, so both are kept out of the figures beside this.'
              : underReviewCount === 1
                ? 'That is not money owed, so it is kept out of the figures beside this.'
                : 'None of that is money owed, so it is kept out of the figures beside this.'}{' '}
            Nothing can be collected at the counter, and nothing on this screen closes a bill in
            this state: it is settled by a correction an administrator and the clinic&rsquo;s
            accountant agree between them. The register below marks{' '}
            {underReviewCount === 1 ? 'it' : 'each of them'} {reviewMarks}.
          </Notice>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-print="hide">
        <Stat
          label="Bills owing"
          value={owing.length}
          note={
            underReviewCount > 0
              ? `${money(outstanding)} across every open bill, the ${underReviewCount === 1 ? 'one' : underReviewCount} under review apart`
              : `${money(outstanding)} across every open bill`
          }
        />
        <Stat
          label="Patients carrying a balance"
          value={data.patientBalances.length}
          note={
            overRefundedByPatients > 0 || voidWithBalanceBillsByPatients > 0
              ? `${money(owedByPatients)} against their names${overRefundedByPatients > 0 ? `, of which ${money(overRefundedByPatients)} is over-refunded and not owed` : ''}${
                  voidWithBalanceBillsByPatients > 0
                    ? `; ${voidBalanceWords(voidWithBalanceByPatients, voidWithBalanceBillsByPatients)}, outside this figure altogether`
                    : ''
                }`
              : `${money(owedByPatients)} owed to the clinic`
          }
        />
        {/* Voided bills are ordinarily the quietest tile on this screen, which
            is exactly why one with money still on it has to be named here. */}
        <Stat
          label="Bills voided"
          value={voided.length}
          note={
            voidWithBalance.length > 0
              ? `They keep their number and stay on the record · ${voidWithBalance.length === 1 ? 'one is not at nothing and is under review' : `${voidWithBalance.length} are not at nothing and are under review`}`
              : 'They keep their number and stay on the record'
          }
        />
      </div>

      <Card data-print="sheet">
        <ClinicLetterhead settings={data.settings} kind="register" />
        <CardHeader
          title="Bill register"
          sub={`${data.invoices.length} bills · every charge, what has been paid, and what is due`}
        />
        {data.invoices.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No bills yet"
              direction="A signed consultation raises one for the fee, the pharmacy counter adds the medicine handed over, and a counter sale raises its own."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Bill</TH>
                <TH>Patient</TH>
                <TH>Raised</TH>
                <TH num>Total</TH>
                <TH num>Paid</TH>
                <TH num>Due</TH>
                <TH>State</TH>
                <TH>Open</TH>
              </TR>
            </THead>
            <TBody>
              {data.invoices.map((invoice) => (
                <TR key={invoice.id} muted={invoice.status === 'void'}>
                  <TD num>{invoice.invoiceNumber}</TD>
                  <TD className="font-semibold">
                    {invoice.patientName ?? 'Counter sale — no patient'}
                  </TD>
                  <TD num>{formatDate(invoice.createdAt)}</TD>
                  <TD num>{money(invoice.total)}</TD>
                  <TD num>{money(invoice.paid)}</TD>
                  <TD num>{money(invoice.due)}</TD>
                  <TD>
                    <PaymentStateBadge invoice={invoice} />
                  </TD>
                  <TD>
                    <Button
                      size="sm"
                      aria-label={`Open bill ${invoice.invoiceNumber}`}
                      onClick={() => setOpenId(invoice.id === openId ? '' : invoice.id)}
                    >
                      {invoice.id === openId ? 'Close' : 'Open'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {open ? (
        <Card variant="record">
          <CardHeader
            title="Bill"
            sub={`${open.patientName ?? 'Counter sale — no patient attached'} · ${open.invoiceNumber}`}
            action={<PaymentStateBadge invoice={open} />}
          />
          <CardBody className="space-y-4">
            {open.status === 'void' ? (
              <Notice tone="bad">
                This bill was voided{open.voidReason ? `: ${open.voidReason}` : '.'} It keeps its
                number and its lines and stays on the record.
              </Notice>
            ) : null}

            {/* Said before the figures, because Due below is larger than Total
                and a reader who meets that without the sentence will read it
                as a patient owing more than they were ever charged. */}
            {open.paymentState === 'over_refunded' ? (
              <Notice tone="bad">
                {money(-open.paid)} more has gone back out on this bill than ever came in — usually
                a refund, and then the reversal of the payment that refund answered. The Due figure
                below is that money, not money the patient owes. Taking payment, refunding again
                and voiding are all refused; this is settled by a correction an administrator and
                the clinic&rsquo;s accountant agree, and the receipts below are the record of how
                it got here.
              </Notice>
            ) : null}

            {/* The other exception, and the one where Due is beside the point:
                a cancelled bill charges nobody anything, so the figure to read
                on this card is Paid. The sentence says which way it points. */}
            {open.paymentState === 'void_with_balance' ? (
              <Notice tone="bad">
                {open.paid > 0
                  ? `${money(open.paid)} is still held against this bill, and the bill was cancelled — so the clinic is holding money for something it is not charging anybody for.`
                  : `${money(-open.paid)} went back out on this bill after it was cancelled — so money left the drawer against a bill that was already charging nobody anything.`}{' '}
                Due below is not the story; nothing is owed on a cancelled bill. Voiding now needs a
                bill at exactly nothing and no receipt against a voided bill can be reversed, so
                this came across with the old records rather than happening here. Taking payment,
                refunding and voiding again are all refused: an administrator and the clinic&rsquo;s
                accountant settle it between them, and the receipts below are the record of how it
                got here.
              </Notice>
            ) : null}

            <InvoiceLines invoice={open} />

            <div className="grid grid-cols-3 gap-3">
              <div className="border border-rule bg-sheet px-2.5 py-2">
                <p className="eyebrow">Total</p>
                <p className="mt-1 font-mono text-[17px] tabular-nums">{money(open.total)}</p>
              </div>
              <div className="border border-rule bg-sheet px-2.5 py-2">
                <p className="eyebrow">Paid</p>
                <p className="mt-1 font-mono text-[17px] tabular-nums">{money(open.paid)}</p>
              </div>
              <div className="border border-ink bg-sheet px-2.5 py-2">
                <p className="eyebrow">Due</p>
                <p className="mt-1 font-mono text-[20px] font-medium tabular-nums">
                  {money(open.due)}
                </p>
              </div>
            </div>

            {open.payments.length > 0 ? (
              <InvoicePayments invoice={open} run={run} canReverse={admin} />
            ) : (
              <p className="text-[13px] text-ink-2">No money has been taken against this bill.</p>
            )}

            {admin ? (
              <div className="flex flex-wrap gap-2 border-t-2 border-ink pt-4" data-print="hide">
                <ReasonAction
                  variant="danger"
                  title="Void this bill"
                  confirmLabel="Void the bill"
                  reasonLabel="Why it should never have been raised"
                  question={
                    <>
                      Void <span className="font-mono font-semibold">{open.invoiceNumber}</span>? It
                      keeps its number and its lines and stays on the record as void. A bill that has
                      been paid against cannot be voided — refund the payment first, or the money is
                      lost.
                    </>
                  }
                  disabled={open.status === 'void' || open.paid > 0 || isUnderReview(open)}
                  /* "Already void" is true of a void-with-balance bill and no
                     use to the person reading it: it invites them to close the
                     card on a bill that still needs somebody. It gets its own
                     sentence, before the plain one. */
                  disabledReason={
                    open.paymentState === 'void_with_balance'
                      ? 'This bill is already void, and it still has money against it. That is under financial review — a correction the accountant approves, not a second void.'
                      : open.status === 'void'
                        ? 'This bill is already void.'
                        : open.paymentState === 'over_refunded'
                          ? 'This bill is over-refunded and under financial review. It is settled by a correction the accountant approves, not by voiding.'
                          : 'Money has been taken against this bill. Refund it first.'
                  }
                  onConfirm={(reason) => run('void_invoice', { invoiceId: open.id, reason })}
                >
                  Void the bill
                </ReasonAction>

                <RefundAction invoice={open} run={run} />
              </div>
            ) : (
              <p className="text-[12px] text-ink-2" data-print="hide">
                Voiding a bill, refunding money and reversing a receipt are admin decisions. Ask an
                admin; the request and the reason go on the record with their name.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card data-print="sheet">
        <CardHeader
          title="Patient balances"
          sub={
            overRefundedByPatients > 0
              ? `${data.patientBalances.length} carrying a balance · ${money(owedByPatients)} against their names, ${money(overRefundedByPatients)} of it over-refunded rather than owed`
              : `${data.patientBalances.length} carrying a balance · ${money(owedByPatients)} owed`
          }
        />
        {data.patientBalances.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nobody owes the clinic anything"
              direction="A balance appears here when a registered patient leaves without settling a bill in full. There is no credit limit and no due date."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH num>Billed</TH>
                <TH num>Paid</TH>
                <TH num>Outstanding</TH>
                <TH num>Open bills</TH>
                <TH num>Oldest unpaid</TH>
              </TR>
            </THead>
            <TBody>
              {data.patientBalances.map((balance) => (
                <TR key={balance.patientId}>
                  {/* Outstanding already carries the over-refund, which is how
                      a person who owes the clinic nothing can appear on a dues
                      list. The row has to say so where the name is read.
                      The money on a cancelled bill is the opposite case and
                      needs saying for the opposite reason: the view's money
                      columns leave voided bills out, so that figure is in none
                      of the numbers on this row and adding it would be wrong.
                      It is stated, not added. */}
                  <TD className="font-semibold">
                    {balance.patientName}
                    {balance.underReviewInvoices > 0 ? (
                      <span className="mt-0.5 block text-[11px] leading-snug font-normal text-stop">
                        {balance.underReviewInvoices === 1
                          ? 'One bill under review'
                          : `${balance.underReviewInvoices} bills under review`}
                        {balance.overRefundedInvoices > 0 ? (
                          <>
                            {' '}
                            · {money(balance.overRefundedAmount)} over-refunded, inside the
                            outstanding figure and not money to ask for
                          </>
                        ) : null}
                        {balance.voidWithBalanceInvoices > 0 ? (
                          <>
                            {' '}
                            ·{' '}
                            {voidBalanceWords(
                              balance.voidWithBalanceAmount,
                              balance.voidWithBalanceInvoices,
                            )}
                            , which none of the figures on this row include
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </TD>
                  <TD num>{money(balance.billed)}</TD>
                  <TD num>{money(balance.paid)}</TD>
                  <TD num>{money(balance.outstanding)}</TD>
                  <TD num>{balance.openInvoices}</TD>
                  <TD num>{balance.oldestDueAt ? formatDate(balance.oldestDueAt) : '—'}</TD>
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
 * Money back, with the parts it went back in.
 *
 * Kept apart from reversing a receipt on purpose. A refund says the money came
 * back; a reversal says it never arrived. The day book has to tell them apart,
 * so the screen does too.
 */
function RefundAction({
  invoice,
  run,
}: {
  invoice: ClinicSnapshot['invoices'][number]
  run: ActionRunner
}) {
  const busy = useBusy()
  const [open, setOpen] = useState(false)
  const [parts, setParts] = useState<PartDraft[]>([blankPart()])
  const [reason, setReason] = useState('')

  const typed = partsTotal(parts)
  const entered = partsPayload(parts)
  /*
   * The ceiling, in paise, and why the branches above it come first.
   *
   * On an over-refunded bill `paid` is below zero, and "-₹40.00 has been paid;
   * more than that cannot be refunded" is not a sentence anybody can act on —
   * it invites a smaller refund, which is the opposite of what this bill
   * needs. A void-with-balance bill can be the other way about: its `paid` is
   * above zero and the ceiling would happily allow a refund the server refuses,
   * so it is answered before the arithmetic is consulted at all. Each of the
   * three is answered in its own words, and by the time the ceiling is read
   * there is money here that genuinely came in and may genuinely go back.
   */
  const refundable = Math.round(invoice.paid * 100)
  const problem =
    invoice.paymentState === 'void_with_balance'
      ? 'This bill is void and still has money against it. Refunding against a cancelled bill is refused; the accountant settles it.'
      : invoice.paymentState === 'over_refunded'
        ? 'More has already gone back out on this bill than ever came in. Another refund is refused; the accountant settles it.'
        : invoice.paid <= 0
          ? 'Nothing has been paid on this bill, so nothing can be refunded.'
          : typed === undefined
            ? 'One of those amounts is not an amount in rupees.'
            : entered.length === 0
              ? 'Say how much is being refunded, and how.'
              : typed > refundable
                ? `${money(invoice.paid)} has been paid; more than that cannot be refunded.`
                : reason.trim() === ''
                  ? 'Say why the money is going back.'
                  : undefined

  async function commit() {
    const result = await run('refund_payment', {
      invoiceId: invoice.id,
      idempotencyKey: crypto.randomUUID(),
      reason: reason.trim(),
      refund: entered,
    })
    if (result.ok) {
      setOpen(false)
      setParts([blankPart()])
      setReason('')
    }
  }

  return (
    <>
      {/* `paid > 0` is not on its own a reason to open this form. A bill under
          review can have money on it — a cancelled one usually does, which is
          why it is under review — and the server refuses the refund either
          way. Offering the form and refusing at the end teaches the admin that
          the refusal is a glitch to retry; the button says so instead. */}
      <ActionButton
        variant="danger"
        busy={busy}
        disabled={isUnderReview(invoice) || invoice.paid <= 0}
        disabledReason={
          invoice.paymentState === 'void_with_balance'
            ? 'This bill is void and still has money against it. Refunding against a cancelled bill is refused; the accountant settles it.'
            : invoice.paymentState === 'over_refunded'
              ? 'More has already gone back out on this bill than came in. A further refund is refused; the accountant settles it.'
              : 'Nothing has been paid on this bill.'
        }
        onClick={() => setOpen(true)}
      >
        Refund money
      </ActionButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Refund against this bill"
        sub={invoice.invoiceNumber}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ActionButton
              variant="danger"
              busy={busy}
              disabled={Boolean(problem)}
              disabledReason={problem}
              onClick={commit}
            >
              Record the refund
            </ActionButton>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[14px] leading-relaxed">
            {money(invoice.paid)} has been paid on {invoice.invoiceNumber}. A refund is money going
            back out and is recorded beside the payment it answers — the original receipt keeps its
            number and its amount.
          </p>
          <PaymentParts
            parts={parts}
            onChange={setParts}
            legend="What is going back"
            hint="One row per method it goes back in."
          />
          <Field label="Why the money is going back" required>
            <Textarea
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </>
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
