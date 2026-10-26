'use client'

import { useEffect, useState } from 'react'
import type { AppointmentView, BedView, ClinicSnapshot, VitalView } from '@/lib/types'
import { useConnection, useSelectedPatient, type ActionRunner } from './clinic-context'
import { Stack } from './shared-panels'
import { ExpectedTodayPointer } from './appointment-book'
import {
  VitalStrip,
  VitalsEntry,
  missingReadings,
  reviewWarnings,
  stationsOf,
} from './vitals-view'
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  EmptyState,
  Icon,
  Notice,
  PageHeader,
  TaskFailure,
  TaskResult,
  Token,
  clinicDayOf,
  clinicToday,
  formatDate,
  useTask,
  type IconName,
} from '@/components/ui'

/**
 * Everything waiting on the nurse, grouped by the person it is waiting for.
 *
 * The clinic's work was filed by module: the queue on one screen, vitals on a
 * second, the bed board on a third, and a nurse walking a round holding a
 * tablet had to visit all three and hold the join in her head. Mrs Devi is a
 * row on Queue, a name in a dropdown on Vitals, and bed 2 on Beds, and nothing
 * anywhere said that her observation check went overdue eleven minutes ago
 * while she was still waiting for her first set of readings.
 *
 * So this screen is the join. One card per patient, carrying every outstanding
 * task for that patient and the one action each of them needs. It reads the
 * same snapshot the other three screens read and adds nothing to the database:
 * it is a different arrangement of the clinic, not a different clinic.
 *
 * The one thing it does write is a set of readings, and it writes them in a
 * drawer over this list rather than by sending the nurse to another station —
 * so the round she is halfway through is still behind the patient she is
 * standing in front of. That is the plan's rule for vitals entry, and the
 * reason the pad lives in `vitals-view.tsx` where both screens can mount it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Medicines due, given and skipped. Deferred from this release by owner policy
 * register item 64, decided 13 September 2026 — settled scope rather than an
 * unfinished panel.
 *
 * The clinic keeps working the way it works: the doctor writes what a patient
 * under observation is to be given as a free-text instruction on the bed, the
 * nurse reads it there, and what happened goes into the same timeline as an
 * observation note. Nothing in this application schedules a dose, marks one
 * due, or records one as given or skipped, and there is no order, no schedule
 * and no administration event anywhere in the schema to build such a list from.
 *
 * Which is the reason it is absent rather than approximated. A list of doses
 * here would look authoritative and would not be, on the one screen whose whole
 * job is to be the thing a nurse trusts about what is still outstanding. The
 * seven clinical questions a later release has to answer first are written out
 * in section K of the register.
 */

type TaskKind =
  | 'vitals'
  | 'review'
  | 'observation'
  | 'handoff'
  | 'closing'
  | 'waiting'

type Station = 'vitals' | 'beds' | 'consultation' | 'queue'

type Task = {
  kind: TaskKind
  /** Lower sorts first. Overdue clinical work outranks everything. */
  urgency: number
  label: string
  detail: string
  tone: 'stop' | 'attn' | 'plain'
  icon: IconName
  /** Absent when the task is waiting on somebody else. */
  action?: { label: string; station: Station; icon: IconName }
}

type Group = {
  patientId: string
  name: string
  age?: number
  token?: string
  bed?: BedView
  appointment?: AppointmentView
  /** The newest set on record, whenever it was taken. */
  latest?: VitalView
  /** The newest set taken on today's clinic day, if there is one. */
  today?: VitalView
  tasks: Task[]
}

/**
 * Where each kind of work sits against everything else on the round.
 *
 * Written out rather than inlined because the ordering IS the screen: a nurse
 * reads this list top to bottom and does the top thing, so a number chosen
 * carelessly at one call site quietly reorders somebody's morning.
 */
const URGENCY = {
  /** Minus the minutes it is overdue, so the longest-overdue check leads. */
  observationOverdue: 0,
  readingNeedsReview: 100,
  /** Plus the minutes until it falls due, so the soonest leads. */
  observationDueSoon: 150,
  /** Minus the minutes already waited, so the longest wait leads. */
  noReadingsYet: 300,
  visitFinishedBedHeld: 320,
  handoffAnswered: 340,
  noNextCheck: 360,
  handoffWaiting: 380,
  /** Minus the minutes already waited. */
  someReadingsMissing: 500,
  /** Minus the minutes already waited. */
  waitingForDoctor: 700,
} as const

/** Minutes from now, negative when the moment has already passed. */
function minutesUntil(when: string | undefined, now: number): number | null {
  if (!when) return null
  const at = Date.parse(when)
  if (Number.isNaN(at)) return null
  return Math.round((at - now) / 60_000)
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/**
 * How long this person has been here, and only when that is a true thing to
 * say.
 *
 * The old arithmetic was `max(0, -minutesUntil(scheduledAt))`, which collapses
 * every appointment timed at or after this instant into a wait of zero and
 * prints "just arrived" against all of them. A visit booked for eleven o'clock
 * is not somebody standing in the corridor at nine, and a round that says it is
 * sends the nurse to a patient who is not in the building.
 *
 * `create_appointment` stamps the moment of arrival, so in ordinary use the
 * scheduled time IS the arrival — but the column allows a later one and the
 * screen has to be honest about which it is holding.
 */
function arrival(
  scheduledAt: string | undefined,
  now: number,
): { waited: number; text: string } {
  const ahead = minutesUntil(scheduledAt, now)
  if (ahead === null) return { waited: 0, text: 'arrival time not recorded' }
  // A minute of slack: a token issued this second is an arrival, not a booking.
  if (ahead > 1 && scheduledAt) return { waited: 0, text: `expected ${formatDate(scheduledAt)}` }
  const waited = Math.max(0, -ahead)
  return { waited, text: waited < 1 ? 'just arrived' : `waiting ${duration(waited)}` }
}

function build(data: ClinicSnapshot, now: number): Group[] {
  const groups = new Map<string, Group>()
  const today = clinicToday()

  function groupFor(patientId: string, name: string): Group {
    const existing = groups.get(patientId)
    if (existing) return existing
    const patient = data.patients.find((item) => item.id === patientId)
    // `data.vitals` arrives newest first, so the first match is the latest set.
    const latest = data.vitals.find((item) => item.patientId === patientId)
    const made: Group = {
      patientId,
      name,
      age: patient?.age,
      latest,
      // What was taken during THIS visit, which is a different question from
      // what was last taken. A patient whose only readings are from a visit
      // last month has no readings today, and a due list that cannot tell the
      // difference tells the nurse there is nothing to do.
      today: data.vitals.find(
        (item) => item.patientId === patientId && clinicDayOf(item.recordedAt) === today,
      ),
      tasks: [],
    }
    groups.set(patientId, made)
    return made
  }

  // Today's queue. A finished visit is carried too, without tasks of its own,
  // because a patient who is still in a bed after their visit ended is work.
  for (const appointment of data.appointments) {
    if (appointment.status === 'cancelled') continue
    const group = groupFor(appointment.patientId, appointment.patientName)
    if (!group.appointment || group.appointment.status === 'done') {
      group.appointment = appointment
      group.token = appointment.token
    }
  }

  // The four observation beds.
  for (const bed of data.beds) {
    if (bed.status !== 'occupied' || !bed.patientId) continue
    groupFor(bed.patientId, bed.patientName ?? 'Patient in observation').bed = bed
  }

  for (const group of groups.values()) {
    const { appointment, bed } = group
    const active =
      appointment !== undefined && appointment.status !== 'done' && appointment.status !== 'cancelled'

    if (appointment && active) {
      const { waited, text: waitedText } = arrival(appointment.scheduledAt, now)
      const reason = appointment.reason || 'No reason recorded'
      const absent = missingReadings(group.today)
      const nothingYet = group.today === undefined

      if (nothingYet || absent.length > 0) {
        group.tasks.push({
          kind: 'vitals',
          // A patient who has been sitting there longer needs seeing sooner,
          // and one with no readings at all outranks one missing a weight.
          urgency:
            (nothingYet ? URGENCY.noReadingsYet : URGENCY.someReadingsMissing) -
            Math.min(waited, 120),
          label: nothingYet ? 'Vitals not recorded' : 'Some readings missing',
          detail: nothingYet
            ? `${reason} · ${waitedText}`
            : `${absent.join(', ')} still to take · ${waitedText}`,
          tone: nothingYet ? 'attn' : 'plain',
          icon: 'pulse',
          action: { label: 'Record vitals', station: 'vitals', icon: 'pulse' },
        })
      } else if (appointment.status === 'waiting') {
        group.tasks.push({
          kind: 'waiting',
          urgency: URGENCY.waitingForDoctor - Math.min(waited, 120),
          label: 'Waiting for the doctor',
          detail: `${reason} · ${waitedText}`,
          tone: 'plain',
          icon: 'clock',
        })
      }

      // The clinic's own approved prompts, on the readings taken this visit.
      // Nothing here decides on its own that a reading is abnormal.
      const warnings = group.today
        ? reviewWarnings(group.today, group.age, data.vitalReviewRules)
        : []
      if (warnings.length > 0) {
        group.tasks.push({
          kind: 'review',
          urgency: URGENCY.readingNeedsReview,
          label: 'Reading needs review',
          detail: warnings.join(' · '),
          tone: 'stop',
          icon: 'alert',
          action: { label: 'Open vitals', station: 'vitals', icon: 'pulse' },
        })
      }
    }

    if (bed) {
      const where = bed.label
      const instruction = bed.doctorInstructions ? ` · ${bed.doctorInstructions}` : ''
      const due = minutesUntil(bed.nextCheckAt, now)

      if (due === null) {
        group.tasks.push({
          kind: 'observation',
          urgency: URGENCY.noNextCheck,
          label: 'No next check scheduled',
          detail: `${where} · set when the next observation is due${instruction}`,
          tone: 'attn',
          icon: 'bed',
          action: { label: 'Record observation', station: 'beds', icon: 'bed' },
        })
      } else if (due <= 0) {
        group.tasks.push({
          kind: 'observation',
          urgency: URGENCY.observationOverdue - Math.min(-due, 240),
          label: `Observation overdue · ${duration(-due)}`,
          detail: `${where}${instruction}`,
          tone: 'stop',
          icon: 'bed',
          action: { label: 'Record observation', station: 'beds', icon: 'bed' },
        })
      } else if (due <= 20) {
        group.tasks.push({
          kind: 'observation',
          urgency: URGENCY.observationDueSoon + due,
          label: `Observation due in ${duration(due)}`,
          detail: `${where}${instruction}`,
          tone: 'attn',
          icon: 'bed',
          action: { label: 'Record observation', station: 'beds', icon: 'bed' },
        })
      }

      const requested = bed.handoffRequestedAt ? Date.parse(bed.handoffRequestedAt) : null
      const resolved = bed.handoffResolvedAt ? Date.parse(bed.handoffResolvedAt) : null
      const answered = requested !== null && resolved !== null && resolved >= requested

      if (requested !== null && !answered) {
        group.tasks.push({
          kind: 'handoff',
          urgency: URGENCY.handoffWaiting,
          label: 'Doctor handoff requested',
          // No action: this one is waiting on somebody else, and a button that
          // does nothing about that is worse than no button.
          detail: `${where} · asked by ${bed.handoffRequestedBy ?? 'the nursing station'}`,
          tone: 'attn',
          icon: 'stethoscope',
        })
      }

      /*
       * The doctor has answered and the plan has not moved since.
       *
       * `handoffResolvedAt` never clears, so it cannot be the whole test or it
       * would sit on the round forever. The nurse's next act after an answer is
       * to record the observation and set the next check, so an answer that is
       * newer than the scheduled check is an answer nobody has acted on yet.
       */
      if (answered) {
        const next = bed.nextCheckAt ? Date.parse(bed.nextCheckAt) : null
        if (next === null || next <= resolved) {
          group.tasks.push({
            kind: 'handoff',
            urgency: URGENCY.handoffAnswered,
            label: 'Doctor has answered the handoff',
            detail: `${where} · record the observation, then continue or close${instruction}`,
            tone: 'attn',
            icon: 'stethoscope',
            action: { label: 'Open observation', station: 'beds', icon: 'bed' },
          })
        }
      }

      /*
       * The visit is over and the bed is still held.
       *
       * This is as close to "ready to go home" as this clinic's record gets,
       * and it is a fact rather than a judgement: the queue says the
       * consultation finished, the bed board says the bed is still occupied.
       * Discharging is the nurse's decision and it is taken on the bed board,
       * with the outcome note the closure needs.
       */
      if (appointment?.status === 'done') {
        group.tasks.push({
          kind: 'closing',
          urgency: URGENCY.visitFinishedBedHeld,
          label: 'Visit finished · bed still occupied',
          detail: `${where} · discharge or transfer when the patient is ready`,
          tone: 'attn',
          icon: 'bed',
          action: { label: 'Open observation', station: 'beds', icon: 'bed' },
        })
      }
    }
  }

  return [...groups.values()]
    .filter((group) => group.tasks.length > 0)
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((a, b) => a.urgency - b.urgency),
    }))
    .sort(
      (a, b) =>
        a.tasks[0].urgency - b.tasks[0].urgency ||
        // Two patients with the same kind of work outstanding are ordered by
        // the token they are holding, so the list does not reshuffle under the
        // thumb every time the clock ticks.
        (a.token ?? '~').localeCompare(b.token ?? '~') ||
        a.name.localeCompare(b.name),
    )
}

const TONE_TEXT = { stop: 'text-stop', attn: 'text-attn', plain: 'text-ink' } as const
const TONE_ICON = { stop: 'text-stop', attn: 'text-attn', plain: 'text-ink-2' } as const
const TONE_ROW = {
  stop: 'border-stop bg-stop-wash',
  attn: 'border-attn bg-attn-wash',
  plain: 'border-rule bg-paper',
} as const

export function DueNowPanel({ data, run }: { data: ClinicSnapshot; run?: ActionRunner }) {
  const { select, goTo } = useSelectedPatient()
  const connection = useConnection()
  const stations = stationsOf(data)
  const save = useTask()
  /** The patient whose readings are being taken, over the list, or nobody. */
  const [entering, setEntering] = useState<string | null>(null)

  // "Overdue by 11 minutes" has to keep being true while nobody touches the
  // tablet. The snapshot poll is fifteen seconds; this is the clock, not the
  // clinic, so it ticks on its own and more slowly.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const groups = build(data, now)
  const pressing = groups.filter((group) => group.tasks[0].tone === 'stop').length
  const anybodyHere =
    data.appointments.some((item) => item.status !== 'cancelled' && item.status !== 'done') ||
    data.beds.some((bed) => bed.status === 'occupied')

  const enteringPatient = data.patients.find((item) => item.id === entering)

  /**
   * Take this patient with you.
   *
   * The selection is the clinic's, not this screen's, so the station that
   * opens already knows who it is about — which is the whole reason nobody has
   * to pick the same name out of the same dropdown a second time.
   */
  function open(patientId: string, station: Station) {
    select(patientId)
    /*
     * Readings are taken here, over the list, so the round survives the
     * interruption. Without a command runner — which is the shell's to give —
     * this falls back to walking to the Vitals station, which is where it
     * always went.
     */
    if (station === 'vitals' && run) {
      setEntering(patientId)
      return
    }
    if (stations.has(station)) goTo(station)
  }

  return (
    <Stack>
      <div data-testid="due-now" className="space-y-5">
        <PageHeader
          eyebrow="Everything waiting on you"
          title="Due now"
          sub={
            groups.length === 0
              ? 'Nothing outstanding'
              : `${groups.length} ${groups.length === 1 ? 'patient' : 'patients'}${
                  pressing > 0 ? ` · ${pressing} needing attention now` : ''
                }`
          }
        />

        {/* Who is booked and not yet here. Real bookings from the calendar's
            own work list, not a guess — and nothing on it is a task until the
            patient arrives and is checked in. */}
        <ExpectedTodayPointer data={data} />

        {/*
         * Every timing on this screen is arithmetic on the last answer the
         * clinic gave. If that answer is old then so is "overdue by 11 minutes",
         * and a round planned from a stale list is the one thing this screen
         * must not quietly do.
         */}
        {connection.stale ? (
          <Notice tone="bad">
            <span className="font-semibold">This list may be out of date.</span> The clinic has not
            answered since{' '}
            {connection.lastUpdated
              ? formatDate(new Date(connection.lastUpdated).toISOString())
              : 'this tablet was opened'}
            . Every time below was worked out from that answer.
          </Notice>
        ) : null}

        {/* A failure has to outlive the drawer it happened in, or a nurse who
            closed it would be told nothing at all. */}
        {entering === null ? (
          <TaskFailure failure={save.failure} onDismiss={save.dismiss} />
        ) : null}

        {groups.length === 0 ? (
          <EmptyState
            title={anybodyHere ? 'Nothing is due' : 'The clinic is quiet'}
            direction={
              anybodyHere
                ? 'Everyone here has their readings and no observation check is near. Patients reappear here as checks fall due.'
                : 'Nobody is in the queue and no bed is occupied. Patients appear here when they arrive, when a reading is missing, or when an observation check comes round.'
            }
            action={
              stations.has('queue') ? (
                <Button icon="queue" onClick={() => goTo('queue')}>
                  Open today&rsquo;s queue
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {groups.map((group) => {
          const shown = group.today ?? group.latest
          const absent = shown ? missingReadings(shown) : []
          const admitted = group.bed?.admittedAt
            ? minutesUntil(group.bed.admittedAt, now)
            : null

          return (
            <Card
              key={group.patientId}
              data-testid={`due-group-${group.patientId}`}
              // A record, not a panel: the most urgent thing on this screen
              // should look like the document it is, not like one card among
              // equals.
              variant={group.tasks[0].tone === 'stop' ? 'record' : 'panel'}
            >
              <CardBody className="grid gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* `min-w-0 flex-1` is what lets a long name wrap instead of
                      pushing the card open. Without the basis the block sizes
                      to its content and a name like "Nithyakalyani
                      Pazhaniappan" ran off the right edge at 390px. */}
                  <div className="flex min-w-0 flex-1 basis-[220px] items-start gap-3">
                    {group.token ? <Token code={group.token} size="md" /> : null}
                    <div className="min-w-0">
                      {/* Never truncated. Two patients on one register can share
                          the first fifteen letters of a name, and an ellipsis
                          on the one identifying fact on the card is a
                          misidentification waiting to happen. */}
                      <p className="text-[19px] leading-tight font-semibold [overflow-wrap:anywhere]">
                        {group.name}
                      </p>
                      <p className="mt-0.5 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
                        {group.age === undefined ? 'Age not recorded' : `${group.age} years`}
                        {group.bed ? ` · ${group.bed.label}` : ''}
                        {admitted !== null ? ` · in observation ${duration(Math.max(0, -admitted))}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {group.bed ? (
                      <Badge tone="live" icon="bed">
                        In observation
                      </Badge>
                    ) : null}
                    {group.appointment?.status === 'in_consult' ? (
                      <Badge tone="live" icon="stethoscope">
                        With the doctor
                      </Badge>
                    ) : null}
                    {group.appointment?.status === 'done' ? (
                      <Badge tone="free">Visit finished</Badge>
                    ) : null}
                  </div>
                </div>

                <ul className="grid gap-2" aria-label={`Outstanding for ${group.name}`}>
                  {group.tasks.map((task) => (
                    <li
                      key={`${task.kind}-${task.label}`}
                      className={`flex flex-wrap items-center justify-between gap-3 rounded-box border px-3 py-2.5 ${TONE_ROW[task.tone]}`}
                    >
                      <span className="flex min-w-0 flex-1 basis-[200px] items-start gap-2.5">
                        <Icon
                          name={task.icon}
                          size={20}
                          className={`mt-0.5 ${TONE_ICON[task.tone]}`}
                        />
                        <span className="min-w-0">
                          <span
                            className={`block text-[15px] font-semibold ${TONE_TEXT[task.tone]}`}
                          >
                            {task.label}
                          </span>
                          <span className="block text-[13px] leading-snug text-ink-2 [overflow-wrap:anywhere]">
                            {task.detail}
                          </span>
                        </span>
                      </span>
                      {/*
                       * One contextual action per task. Either it opens the pad
                       * over this list, or it selects this patient and opens the
                       * station the work is done on. Nothing is saved from here,
                       * so nothing here shows a success result; the pad owns
                       * that and the bed board owns its own.
                       */}
                      {task.action && (task.action.station !== 'vitals' || run
                        ? stations.has(task.action.station) || (task.action.station === 'vitals' && Boolean(run))
                        : false) ? (
                        <Button
                          size="sm"
                          variant={task.tone === 'plain' ? 'secondary' : 'primary'}
                          icon={task.action.icon}
                          onClick={() => open(group.patientId, task.action!.station)}
                        >
                          {task.action.label}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {shown ? (
                  <div className="border-t border-rule pt-3">
                    <p className="eyebrow mb-1.5">
                      {group.today ? 'Readings today' : 'Last readings'} ·{' '}
                      {formatDate(shown.recordedAt)} · {shown.recordedBy}
                    </p>
                    <VitalStrip vital={shown} age={group.age} rules={data.vitalReviewRules} />
                    {absent.length > 0 ? (
                      <p className="mt-2 text-[13px] text-ink-2">
                        Not taken: {absent.join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="border-t border-rule pt-3 text-[13px] text-ink-2">
                    No reading has ever been recorded for this patient.
                  </p>
                )}
              </CardBody>
            </Card>
          )
        })}
      </div>

      {/*
       * The pad, over the round rather than instead of it.
       *
       * The task belongs to this screen and not to the drawer, so closing the
       * drawer the instant the clinic confirms the record does not throw the
       * confirmation away with it.
       */}
      {run && enteringPatient ? (
        <Drawer
          open
          onClose={() => setEntering(null)}
          title="Record vitals"
          sub={`${enteringPatient.name} · ${enteringPatient.age} years`}
          width="md"
        >
          <VitalsEntry
            data={data}
            run={run}
            patient={enteringPatient}
            task={save}
            layout="narrow"
            onSaved={() => setEntering(null)}
          />
        </Drawer>
      ) : null}

      {save.outcome ? (
        <div data-testid="vitals-result">
          <TaskResult outcome={save.outcome} onDismiss={save.dismiss} />
        </div>
      ) : null}
    </Stack>
  )
}
