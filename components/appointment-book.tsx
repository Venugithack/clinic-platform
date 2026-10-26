'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type {
  AppointmentCommandOutcome,
  BookingStatus,
  Calendar,
  CalendarBooking,
  ClinicSnapshot,
  PatientAppointment,
  PatientView,
  Role,
} from '@/lib/types'
import { callApi, readJson } from '@/lib/api'
import {
  beginAppointmentAttempt,
  forgetAppointmentAttempt,
  heldAppointmentAttempt,
  lastAppointmentRequest,
  refuseAppointmentAttempt,
  settleAppointmentAttempt,
  unresolvedAppointmentAttempts,
  type AppointmentAct,
} from '@/lib/appointment-attempt'
import {
  DEFAULT_APPOINTMENT_MINUTES,
  NO_SHOW_AFTER_MINUTES,
  clinicClock,
  clinicDayOfInstant,
  clinicLocalInput,
  clinicSpan,
  dayLabel,
  describeReplay,
  hoursForDay,
  isClinicLocalInput,
  minutesPast,
  noShowEligible,
  shiftDay,
} from '@/lib/appointment-book'
import { useBusy, useSelectedPatient, type ActionResult, type ActionRunner } from './clinic-context'
import { Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DWELL_MAJOR,
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
  TaskResult,
  Textarea,
  Token,
  clinicToday,
  useTask,
  words,
  type IconName,
  type TaskOutcome,
  type Tone,
} from '@/components/ui'

/**
 * The appointment book, from booking through check-in.
 *
 * Backend programme Slice 2 built the whole appointment domain — owner items
 * 65 to 71 — and no screen for it. This is that screen, bounded: a clinic-local
 * day, the two work lists that say who is expected and who did not come, a
 * booking form, and the four acts on a booking. It is built against
 * `docs/reference/SLICE2_FRONTEND_CONTRACT.md` and invents nothing the
 * contract does not say.
 *
 * ── THE ONE RULE THE WHOLE SCREEN SERVES ──────────────────────────────────
 *
 * A booking is not a patient in the building. Owner item 70: "A future
 * booking does not enter the live queue until check-in." So nothing here
 * draws a booking the way the queue draws an arrival — no token until there
 * is one, "Booked · not in the queue" in words beside every one that has not
 * checked in — and check-in is the single control that crosses over.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not edit appointment types or publish hours. Both have commands and
 * neither has a read that lists what exists, so a form for them would be
 * guessing; every booking made here is the clinic default of fifteen minutes
 * (owner item 65), and the published hours are shown exactly as the calendar
 * read returns them. It does not message anybody, and it is not a public
 * booking page.
 *
 * ── HOW A LOST REPLY IS HANDLED ───────────────────────────────────────────
 *
 * Every command goes under a reference held by `lib/appointment-attempt.ts`
 * for that act on that patient or booking, and the reference is released
 * only by a confirmed answer. A refusal keeps it; a silence keeps it and
 * leaves a note of opaque identifiers that survives a reload; and after a
 * reload the station asks `workspace?view=appointment_outcome` what the
 * reference did rather than guessing. A replay's two facts — what was done,
 * and whether it still stands — are both shown.
 */

/* ───────────────────────────────────────────────────────── vocabulary ── */

const MAY_BOOK: Role[] = ['admin', 'doctor', 'nurse']

/** Owner item 68: after check-in, only these two may move or cancel. */
const MAY_OVERRIDE: Role[] = ['admin', 'doctor']

/** Words and a shape for every state. Never colour alone. */
const STATUS_SKIN: Record<BookingStatus, { label: string; tone: Tone; icon: IconName }> = {
  booked: { label: 'Booked · not in the queue', tone: 'plain', icon: 'calendar' },
  checked_in: { label: 'Checked in', tone: 'free', icon: 'check' },
  cancelled: { label: 'Cancelled', tone: 'plain', icon: 'x-circle' },
  no_show: { label: 'Did not attend', tone: 'attn', icon: 'skip' },
}

const ARRIVAL_WORD: Record<string, string> = {
  waiting: 'Waiting in the queue',
  in_consult: 'With the doctor',
  done: 'Seen',
  cancelled: 'Taken out of the queue',
}

const EVENT_WORD: Record<string, string> = {
  booked: 'Booked',
  rescheduled: 'Moved',
  cancelled: 'Cancelled',
  no_show: 'Did not attend',
  checked_in: 'Checked in',
  prioritized: 'Moved up the queue',
  priority_cleared: 'Returned to arrival order',
  closed_on_reconciliation: 'Closed as the same attendance',
}

/** What each act is called on a button while it is in flight. */
const WORKING: Record<AppointmentAct, string> = {
  book_appointment: 'Booking appointment…',
  reschedule_appointment: 'Moving appointment…',
  cancel_appointment: 'Cancelling appointment…',
  mark_no_show: 'Recording no-show…',
  check_in_appointment: 'Checking in…',
}

/** What each act is called in a sentence about it. */
const ACT_WORD: Record<AppointmentAct, string> = {
  book_appointment: 'Booking',
  reschedule_appointment: 'Moving the appointment',
  cancel_appointment: 'Cancelling the appointment',
  mark_no_show: 'Recording a no-show',
  check_in_appointment: 'Checking in',
}

/**
 * Refusals that mean the book moved under this screen — another tablet
 * checked the patient in, cancelled the booking, took the slot. The read is
 * repeated so the screen stops disagreeing with the clinic.
 */
const BOOK_MOVED = new Set([
  'CHECKED_IN_ALREADY',
  'APPOINTMENT_CLOSED',
  'VISIT_ALREADY_FINISHED',
  'SLOT_ALREADY_TAKEN',
  'TOO_EARLY_FOR_NO_SHOW',
])

/** A read open longer than this says so. The plan's four seconds, for reads. */
const SLOW_READ_MS = 4000

const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `25 Sept, 10:30` on the clinic's clock, whatever the tablet's zone. */
function clinicMoment(instant: string | undefined): string {
  if (!instant) return ''
  const parsed = new Date(instant)
  return Number.isNaN(parsed.getTime()) ? '' : clock.format(parsed)
}

/* ──────────────────────────────────────────────────────────── reading ── */

type ReadAnswer<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * One on-demand read. A failed read is a connection problem and says so; it
 * is never an empty appointment book.
 */
async function readWorkspace<T>(path: string): Promise<ReadAnswer<T>> {
  try {
    const response = await callApi(path)
    const body = await readJson<T & { ok?: boolean; message?: string }>(response, false)
    if (body.ok === false) {
      return { ok: false, message: body.message ?? 'The clinic refused that read.' }
    }
    return { ok: true, value: body }
  } catch {
    return {
      ok: false,
      message: 'The clinic server is not reachable, so this could not be read. Nothing has been changed.',
    }
  }
}

type BookRead<T> = {
  value: T | null
  loading: boolean
  slow: boolean
  /** The last read failed. With a value, what is on screen may be out of date. */
  failure: string | null
  readAt: number | null
  refresh: () => Promise<void>
}

/**
 * A read that keeps what it had when a refresh fails.
 *
 * A new path — another day — starts empty, because a day's bookings drawn
 * under the next day's heading is worse than a moment of "Reading…". A failed
 * REFRESH of the same path keeps the old answer and says it may be out of
 * date: the stale-read state. Answers that arrive after a newer request, or
 * after the station has gone, are dropped.
 */
function useBookRead<T>(path: string | null, field: string): BookRead<T> {
  const [state, setState] = useState<Omit<BookRead<T>, 'refresh'>>({
    value: null,
    loading: path !== null,
    slow: false,
    failure: null,
    readAt: null,
  })
  const sequence = useRef(0)

  const load = useCallback(async () => {
    if (!path) return
    sequence.current += 1
    const mine = sequence.current
    setState((previous) => ({ ...previous, loading: true, slow: false }))
    const slowTimer = window.setTimeout(() => {
      if (sequence.current === mine) setState((previous) => ({ ...previous, slow: true }))
    }, SLOW_READ_MS)

    const answer = await readWorkspace<Record<string, unknown>>(path)
    window.clearTimeout(slowTimer)
    if (sequence.current !== mine) return

    if (answer.ok) {
      setState({
        value: (answer.value[field] ?? null) as T | null,
        loading: false,
        slow: false,
        failure: null,
        readAt: Date.now(),
      })
    } else {
      setState((previous) => ({ ...previous, loading: false, slow: false, failure: answer.message }))
    }
  }, [path, field])

  useEffect(() => {
    setState({ value: null, loading: path !== null, slow: false, failure: null, readAt: null })
    void load()
    return () => {
      // Anything still on its way belongs to a path or a station that is gone.
      sequence.current += 1
    }
  }, [load, path])

  return { ...state, refresh: load }
}

type Doctor = { id: string; name: string }

/**
 * The doctors a booking can be with.
 *
 * The snapshot sends the staff list to an administrator alone, and a nurse
 * booking in a clinic with two doctors must name one — the command refuses
 * "Say which doctor this appointment is with" otherwise. The lock screen's
 * roster is public, carries names and roles and nothing else, and is the
 * smallest existing source; no new read was added for it. `null` while unread
 * or unreadable, and the form then leaves the doctor to the server's own rule.
 */
function useDoctors(): Doctor[] | null {
  const [doctors, setDoctors] = useState<Doctor[] | null>(null)
  useEffect(() => {
    let live = true
    void readWorkspace<{ staff?: { id: string; name: string; roles: Role[] }[] }>('staff').then((answer) => {
      if (!live || !answer.ok || !answer.value.staff) return
      setDoctors(
        answer.value.staff
          .filter((member) => member.roles.includes('doctor'))
          .map((member) => ({ id: member.id, name: member.name })),
      )
    })
    return () => {
      live = false
    }
  }, [])
  return doctors
}

/* ───────────────────────────────────────────── the rows of a work list ── */

/** A row of `list.appointments_today` or `list.no_show_review`, as it arrives. */
type ListRow = Record<string, unknown>
type WorkList = { id: string; label: string; count: number; rows: ListRow[]; truncated: boolean }

const str = (value: unknown) => (value === null || value === undefined ? '' : String(value))

/** What every act on a booking needs to know about it, wherever it was found. */
type BookingRef = {
  bookingId: string
  patientId: string
  patientName: string
  scheduledAt: string
  durationMinutes: number
  status: BookingStatus
  reason: string
  arrivalToken?: string
  arrivalStatus?: string
}

function refFromBooking(booking: CalendarBooking): BookingRef {
  return {
    bookingId: booking.bookingId,
    patientId: booking.patientId,
    patientName: booking.patientName,
    scheduledAt: booking.scheduledAt,
    durationMinutes: booking.durationMinutes,
    status: booking.status,
    reason: booking.reason,
    arrivalToken: booking.arrivalToken,
    arrivalStatus: booking.arrivalStatus,
  }
}

/** Both lists hold `booked` bookings only — owner item 70's whole point. */
function refFromListRow(row: ListRow): BookingRef {
  return {
    bookingId: str(row.id),
    patientId: str(row.patient_id),
    patientName: str(row.patient_name),
    scheduledAt: str(row.scheduled_at),
    durationMinutes: Number(row.duration_minutes ?? DEFAULT_APPOINTMENT_MINUTES),
    status: 'booked',
    reason: str(row.reason),
  }
}

/* ───────────────────────────────────────────── what is still unsettled ── */

type Unsettled = {
  act: AppointmentAct
  subjectId: string
  status: 'unknown' | 'checking' | 'check_failed' | AppointmentCommandOutcome['state']
  outcome?: AppointmentCommandOutcome
  message?: string
}

type Refusal = { act: AppointmentAct; subjectId: string; message: string; code?: string }

type OverrideAsk = { act: 'book_appointment' | 'reschedule_appointment'; subjectId: string; message: string }

type Dialog =
  | { kind: 'move'; booking: BookingRef }
  | { kind: 'cancel'; booking: BookingRef }
  | { kind: 'no_show'; booking: BookingRef }

const sameSubject = (a: { act: AppointmentAct; subjectId: string }, act: AppointmentAct, subjectId: string) =>
  a.act === act && a.subjectId === subjectId

/* ══════════════════════════════════════════════════════════ the station ══ */

export function AppointmentBookPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const allowed = data.session.roles.some((role) => MAY_BOOK.includes(role))
  if (!allowed) {
    return (
      <Stack>
        <PageHeader eyebrow="Booked visits" title="Appointments" />
        <Card>
          <CardBody>
            <EmptyState
              title="The appointment book is not part of this role"
              direction="Bookings are made and checked in by the nurse, the doctor or an administrator. The counter identifies a patient by prescription, not by booking."
            />
          </CardBody>
        </Card>
      </Stack>
    )
  }
  return <AppointmentBook data={data} run={run} />
}

function AppointmentBook({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const staffId = data.session.staffId
  const roles = data.session.roles
  const mayOverride = roles.some((role) => MAY_OVERRIDE.includes(role))
  const tabletBusy = useBusy()
  const { patientId: selectedPatientId, goTo } = useSelectedPatient()
  const task = useTask()
  const doctors = useDoctors()

  const today = clinicToday()
  const [day, setDay] = useState(today)

  const calendar = useBookRead<Calendar>(`workspace?view=calendar&from=${day}`, 'calendar')
  const expected = useBookRead<WorkList>('workspace?view=list&list=list.appointments_today', 'list')
  const review = useBookRead<WorkList>('workspace?view=list&list=list.no_show_review', 'list')

  const refreshCalendar = calendar.refresh
  const refreshExpected = expected.refresh
  const refreshReview = review.refresh
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshCalendar(), refreshExpected(), refreshReview()])
  }, [refreshCalendar, refreshExpected, refreshReview])

  /*
   * The clinic changed — a poll brought a new snapshot, or a command's answer
   * carried one. Any appointment command bumps the clinic's revision, so this
   * is how another tablet's check-in reaches this one without anybody pressing
   * Refresh. The first run is skipped: the reads have just started themselves.
   */
  const firstSnapshot = useRef(true)
  // Held in a ref so that changing the day — which gives the calendar read a
  // new identity — does not count as the clinic changing and re-read the two
  // lists that did not.
  const refreshLatest = useRef(refreshAll)
  useEffect(() => {
    refreshLatest.current = refreshAll
  }, [refreshAll])
  useEffect(() => {
    if (firstSnapshot.current) {
      firstSnapshot.current = false
      return
    }
    void refreshLatest.current()
  }, [data])

  // "Late" and "no-show available" have to become true while nobody touches
  // the tablet. This is the clock, not the clinic.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const [pending, setPending] = useState<{ act: AppointmentAct; subjectId: string } | null>(null)
  const [unsettled, setUnsettled] = useState<Unsettled[]>([])
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [overrideAsk, setOverrideAsk] = useState<OverrideAsk | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [history, setHistory] = useState<{ patientId: string; name: string } | null>(null)
  const [nextAfter, setNextAfter] = useState<{ label: string; onPress: () => void } | undefined>(undefined)
  const sending = useRef(false)
  const dayHeading = useRef<HTMLHeadingElement>(null)

  /* ─────────────────────────────────────────── naming a subject ── */

  const bookingsById = useMemo(() => {
    const found = new Map<string, BookingRef>()
    for (const booking of calendar.value?.bookings ?? []) found.set(booking.bookingId, refFromBooking(booking))
    for (const row of [...(expected.value?.rows ?? []), ...(review.value?.rows ?? [])]) {
      const ref = refFromListRow(row)
      if (!found.has(ref.bookingId)) found.set(ref.bookingId, ref)
    }
    return found
  }, [calendar.value, expected.value, review.value])

  /**
   * Who an act was about, from what this screen already holds. Nothing about a
   * patient is written down to make this possible: a booking act names its
   * booking and the patient is found in the reads; a booking names its
   * patient and the name is in the register the snapshot already carries.
   */
  const nameFor = useCallback(
    (act: AppointmentAct, subjectId: string, outcome?: AppointmentCommandOutcome): string => {
      const patientId = act === 'book_appointment' ? subjectId : outcome?.patientId
      const fromRegister = patientId ? data.patients.find((patient) => patient.id === patientId)?.name : ''
      if (fromRegister) return fromRegister
      if (act !== 'book_appointment') {
        const booking = bookingsById.get(subjectId)
        if (booking) return booking.patientName
      }
      return 'this appointment'
    },
    [data.patients, bookingsById],
  )

  /* ─────────────────────────────────────── the unsettled list ── */

  const upsertUnsettled = useCallback((entry: Unsettled) => {
    setUnsettled((current) => [
      ...current.filter((item) => !sameSubject(item, entry.act, entry.subjectId)),
      entry,
    ])
  }, [])

  const dropUnsettled = useCallback((act: AppointmentAct, subjectId: string) => {
    setUnsettled((current) => current.filter((item) => !sameSubject(item, act, subjectId)))
  }, [])

  /**
   * Ask the clinic what a held reference did.
   *
   * The only answer that releases the reference is `committed` — the act is
   * done, and the next one is a new act. `not_yours` releases it too, because
   * nothing this person sends under it can ever succeed. `not_committed` and
   * `in_flight` keep it: the next send reuses it, so a request still on its
   * way and the one sent now cannot both be carried out.
   */
  const checkOutcome = useCallback(
    async (act: AppointmentAct, subjectId: string, knownKey?: string) => {
      const key = knownKey ?? heldAppointmentAttempt(staffId, act, subjectId)?.key
      if (!key) {
        dropUnsettled(act, subjectId)
        return null
      }
      upsertUnsettled({ act, subjectId, status: 'checking' })
      const answer = await readWorkspace<{ outcome: AppointmentCommandOutcome }>(
        `workspace?view=appointment_outcome&key=${encodeURIComponent(key)}`,
      )
      if (!answer.ok) {
        upsertUnsettled({ act, subjectId, status: 'check_failed', message: answer.message })
        return null
      }
      const outcome = answer.value.outcome
      if (outcome.state === 'committed') {
        settleAppointmentAttempt(act, subjectId)
        void refreshAll()
      }
      if (outcome.state === 'not_yours') forgetAppointmentAttempt(act, subjectId)
      upsertUnsettled({ act, subjectId, status: outcome.state, outcome })
      return outcome
    },
    [staffId, upsertUnsettled, dropUnsettled, refreshAll],
  )

  /*
   * After a reload, or on coming back to this station: every reference this
   * person left unanswered is asked about, once. What it holds is identifiers;
   * what the clinic answers is the record.
   */
  useEffect(() => {
    const notes = unresolvedAppointmentAttempts(staffId)
    for (const note of notes) void checkOutcome(note.act, note.subjectId, note.key)
    // Once per person per visit to the station, and not again every time
    // `checkOutcome` is rebuilt by a read: the checks update state themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId])

  /* ────────────────────────────────────────────── sending ── */

  const outcomeFor = useCallback(
    (act: AppointmentAct, who: string, result: ActionResult): TaskOutcome => {
      const payload = (result.data ?? {}) as Record<string, unknown>
      const replay = describeReplay(act, payload)
      const base = baseOutcome(act, who, payload, result.message)

      if (replay.superseded) {
        return {
          ...base,
          kind: 'partial',
          title: `${base.title} earlier · since changed`,
          detail: replay.now,
          icon: 'clock',
          dwell: DWELL_MAJOR,
        }
      }
      if (replay.duplicate) {
        return {
          ...base,
          detail: `${base.detail ? `${base.detail} ` : ''}This had already been recorded; nothing was done twice.`,
        }
      }
      return base
    },
    [],
  )

  /**
   * One appointment command, sent once, under the reference held for it.
   *
   * The reference comes from `beginAppointmentAttempt`, which returns the held
   * one when there is one — after a refusal, after a lost reply, after the
   * override question — and mints only when nothing is held. The request is
   * exactly what the caller built; nothing here adds to it but the reference.
   */
  const send = useCallback(
    async (act: AppointmentAct, subjectId: string, request: Record<string, unknown>) => {
      if (sending.current) return 'ignored' as const
      sending.current = true

      const who = nameFor(act, subjectId)
      setRefusal(null)
      const key = beginAppointmentAttempt(staffId, act, subjectId, request)
      setPending({ act, subjectId })
      setNextAfter(
        act === 'check_in_appointment'
          ? { label: 'Open the queue', onPress: () => goTo('queue') }
          : undefined,
      )

      let result: ActionResult | null = null
      try {
        result = await task.run({
          working: WORKING[act],
          request: () => run(act, { ...request, idempotencyKey: key }),
          confirmed: (answer) => outcomeFor(act, who, answer as ActionResult),
        })
      } finally {
        setPending(null)
        sending.current = false
      }
      if (!result) return 'ignored' as const

      // The override question, if one was open, has been answered either way.
      // It is asked again below only if the clinic asks again.
      setOverrideAsk(null)

      if (result.ok) {
        settleAppointmentAttempt(act, subjectId)
        const replay = describeReplay(act, result.data as Record<string, unknown> | undefined)
        if (replay.superseded) {
          // The overlay goes in three seconds; this does not. A token that is
          // no longer in the queue has to stay said until somebody reads it.
          upsertUnsettled({
            act,
            subjectId,
            status: 'committed',
            outcome: {
              key,
              state: 'committed',
              command: act,
              message: result.message,
              data: { ...((result.data ?? {}) as Record<string, unknown>) },
              detail: result.message,
            },
          })
        } else {
          dropUnsettled(act, subjectId)
        }
        void refreshAll()
        return 'confirmed' as const
      }

      // Everything below is said by this screen's own panels rather than the
      // task's generic strip, because each needs different next steps.
      task.dismiss()

      if (result.unconfirmed) {
        upsertUnsettled({ act, subjectId, status: 'unknown' })
        void refreshAll()
        return 'unknown' as const
      }

      if (result.code === 'APPOINTMENT_REFERENCE_REUSED') {
        /*
         * The reference held for this act was spent by an earlier request —
         * the lost one, which did commit after all. Nothing was sent now.
         * What the earlier one did is read and shown; only then is the
         * reference let go, so the next press is a new act of its own.
         */
        await checkOutcome(act, subjectId, key)
        setRefusal({
          act,
          subjectId,
          code: result.code,
          message:
            'This was not carried out: an earlier request under the same reference already had been. ' +
            'What that request did is shown at the top of this screen.',
        })
        return 'refused' as const
      }

      refuseAppointmentAttempt(act, subjectId)
      dropUnsettled(act, subjectId)

      if (
        result.code === 'OVERRIDE_REASON_REQUIRED' &&
        mayOverride &&
        (act === 'book_appointment' || act === 'reschedule_appointment')
      ) {
        // Owner item 67: the override is asked for, never assumed. The same
        // request goes again under the same reference, with a reason.
        setOverrideAsk({ act, subjectId, message: result.message })
        return 'override' as const
      }

      setRefusal({ act, subjectId, message: result.message, code: result.code })
      if (result.code && BOOK_MOVED.has(result.code)) void refreshAll()
      return 'refused' as const
    },
    [staffId, nameFor, task, run, outcomeFor, upsertUnsettled, dropUnsettled, refreshAll, checkOutcome, mayOverride, goTo],
  )

  /** The exact request again, under the same reference. Only while this tab remembers it. */
  const resend = useCallback(
    async (act: AppointmentAct, subjectId: string) => {
      const last = lastAppointmentRequest(staffId, act, subjectId)
      if (!last) return
      await send(act, subjectId, last.request)
    },
    [staffId, send],
  )

  const forget = useCallback(
    (act: AppointmentAct, subjectId: string) => {
      forgetAppointmentAttempt(act, subjectId)
      dropUnsettled(act, subjectId)
    },
    [dropUnsettled],
  )

  const isPending = (act: AppointmentAct, subjectId: string) =>
    pending !== null && sameSubject(pending, act, subjectId)
  const elsewhere = tabletBusy && pending === null ? 'Another action is being saved.' : undefined

  const unsettledFor = (act: AppointmentAct, subjectId: string) =>
    unsettled.find((item) => sameSubject(item, act, subjectId)) ?? null

  /**
   * Why an act may not be pressed again yet: its last attempt's outcome is not
   * known. The plan's rule — check the saved record before enabling the action
   * again. "Send the same request again" stays offered on the card, because an
   * exact retry under the same reference is safe by construction.
   */
  const heldBack = (act: AppointmentAct, subjectId: string): string | undefined => {
    const item = unsettledFor(act, subjectId)
    if (!item) return undefined
    return item.status === 'unknown' || item.status === 'checking' || item.status === 'in_flight' || item.status === 'check_failed'
      ? 'The last attempt has not been confirmed. Check what happened first.'
      : undefined
  }
  const refusalFor = (act: AppointmentAct, subjectId: string) =>
    refusal && sameSubject(refusal, act, subjectId) ? refusal : null

  /* ─────────────────────────────────────────────── acts ── */

  async function checkIn(booking: BookingRef) {
    await send('check_in_appointment', booking.bookingId, { bookingId: booking.bookingId })
  }

  async function book(request: Record<string, unknown>, patientId: string): Promise<boolean> {
    const sent = await send('book_appointment', patientId, request)
    if (sent === 'confirmed') {
      const scheduled = String(request.scheduledAt ?? '')
      if (scheduled.length >= 10) setDay(scheduled.slice(0, 10))
      return true
    }
    return false
  }

  const unsettledOutsideDialogs = unsettled.filter(
    (item) =>
      !(dialog && item.act !== 'book_appointment' && item.subjectId === dialog.booking.bookingId),
  )

  const topRefusal =
    refusal && refusal.act === 'check_in_appointment' && !dialog ? refusal : null

  return (
    <Stack>
      <PageHeader
        eyebrow="Booked visits"
        title="Appointments"
        sub="A booking is not in the queue. It joins the queue only when the patient is checked in."
        action={
          <Button
            variant="ghost"
            size="sm"
            icon="ring"
            disabled={calendar.loading || expected.loading || review.loading}
            onClick={() => void refreshAll()}
          >
            {calendar.loading || expected.loading || review.loading ? 'Reading…' : 'Refresh'}
          </Button>
        }
      />

      {unsettledOutsideDialogs.length > 0 ? (
        <section aria-label="Not yet confirmed" className="space-y-2" data-testid="appointment-unsettled">
          {unsettledOutsideDialogs.map((item) => (
            <UnsettledCard
              key={`${item.act}:${item.subjectId}`}
              item={item}
              who={nameFor(item.act, item.subjectId, item.outcome)}
              canResend={lastAppointmentRequest(staffId, item.act, item.subjectId) !== null}
              busy={pending !== null || tabletBusy}
              onCheck={() => void checkOutcome(item.act, item.subjectId)}
              onResend={() => void resend(item.act, item.subjectId)}
              onDismiss={() =>
                item.status === 'committed' || item.status === 'not_yours'
                  ? dropUnsettled(item.act, item.subjectId)
                  : forget(item.act, item.subjectId)
              }
            />
          ))}
        </section>
      ) : null}

      {topRefusal ? (
        <RefusalNotice
          refusal={topRefusal}
          who={nameFor(topRefusal.act, topRefusal.subjectId)}
          mayOverride={mayOverride}
          onDismiss={() => setRefusal(null)}
        />
      ) : null}

      <div className="grid min-w-0 gap-5 md:grid-cols-2">
        <WorkListCard
          title="Expected today"
          testId="expected-today"
          read={expected}
          empty="Nobody booked for today is still to arrive."
          explain="Booked for today and not yet checked in. Checking a patient in gives them a token in the ordinary queue, in order of arrival."
          render={(row) => {
            const ref = refFromListRow(row)
            const late = row.late === true
            return (
              <ListLine
                key={ref.bookingId}
                booking={ref}
                when={clinicClock(ref.scheduledAt)}
                note={late ? <Badge tone="attn">Late · {Math.max(0, minutesPast(ref.scheduledAt, now))} min</Badge> : null}
                actions={
                  <>
                    <ActionButton
                      size="sm"
                      variant="primary"
                      icon="queue"
                      busy={isPending('check_in_appointment', ref.bookingId)}
                      busyLabel={task.workingLabel}
                      disabled={Boolean(elsewhere) || pending !== null || Boolean(heldBack('check_in_appointment', ref.bookingId))}
                      disabledReason={elsewhere ?? heldBack('check_in_appointment', ref.bookingId)}
                      onClick={() => void checkIn(ref)}
                    >
                      Check in
                    </ActionButton>
                    <Button size="sm" variant="ghost" onClick={() => setHistory({ patientId: ref.patientId, name: ref.patientName })}>
                      History
                    </Button>
                  </>
                }
              />
            )
          }}
        />
        <WorkListCard
          title="No-show review"
          testId="no-show-review"
          read={review}
          empty="No booking is more than half an hour past its start."
          explain={`Still booked more than ${NO_SHOW_AFTER_MINUTES} minutes after the start, on any day. Nothing is marked by itself: check them in if they are here, or record that they did not attend.`}
          render={(row) => {
            const ref = refFromListRow(row)
            return (
              <ListLine
                key={ref.bookingId}
                booking={ref}
                when={clinicMoment(ref.scheduledAt)}
                note={<Badge tone="attn">{str(row.minutes_late)} min past the start</Badge>}
                actions={
                  <>
                    <ActionButton
                      size="sm"
                      variant="primary"
                      icon="queue"
                      busy={isPending('check_in_appointment', ref.bookingId)}
                      busyLabel={task.workingLabel}
                      disabled={Boolean(elsewhere) || pending !== null || Boolean(heldBack('check_in_appointment', ref.bookingId))}
                      disabledReason={elsewhere ?? heldBack('check_in_appointment', ref.bookingId)}
                      onClick={() => void checkIn(ref)}
                    >
                      Check in
                    </ActionButton>
                    <Button
                      size="sm"
                      icon="skip"
                      disabled={pending !== null || tabletBusy}
                      onClick={() => setDialog({ kind: 'no_show', booking: ref })}
                    >
                      Did not attend
                    </Button>
                  </>
                }
              />
            )
          }}
        />
      </div>

      <BookCard
        data={data}
        doctors={doctors}
        selectedPatientId={selectedPatientId}
        today={today}
        busy={isPending('book_appointment', selectedPatientId)}
        busyLabel={task.workingLabel}
        blocked={
          elsewhere ??
          (pending !== null && !isPending('book_appointment', selectedPatientId)
            ? 'Another appointment action is being saved.'
            : selectedPatientId
              ? heldBack('book_appointment', selectedPatientId)
              : undefined)
        }
        refusal={refusal && refusal.act === 'book_appointment' ? refusal : null}
        unsettled={selectedPatientId ? unsettledFor('book_appointment', selectedPatientId) : null}
        mayOverride={mayOverride}
        onBook={book}
        onHistory={(patient) => setHistory({ patientId: patient.id, name: patient.name })}
        onDismissRefusal={() => setRefusal(null)}
      />

      <DayCard
        day={day}
        today={today}
        onDay={setDay}
        read={calendar}
        doctors={doctors}
        headingRef={dayHeading}
        renderBooking={(booking) => (
          <BookingLine
            key={booking.bookingId}
            booking={booking}
            now={now}
            showDoctor={(doctors?.length ?? 0) > 1}
            mayChangeStarted={mayOverride}
            checkingIn={isPending('check_in_appointment', booking.bookingId)}
            workingLabel={task.workingLabel}
            blocked={elsewhere ?? heldBack('check_in_appointment', booking.bookingId)}
            anyPending={pending !== null}
            onCheckIn={() => void checkIn(refFromBooking(booking))}
            onMove={() => setDialog({ kind: 'move', booking: refFromBooking(booking) })}
            onCancel={() => setDialog({ kind: 'cancel', booking: refFromBooking(booking) })}
            onNoShow={() => setDialog({ kind: 'no_show', booking: refFromBooking(booking) })}
            onHistory={() => setHistory({ patientId: booking.patientId, name: booking.patientName })}
          />
        )}
      />

      {dialog ? (
        <BookingDialog
          key={`${dialog.kind}:${dialog.booking.bookingId}`}
          dialog={dialog}
          mayOverride={mayOverride}
          busy={pending !== null && dialog.booking.bookingId === pending.subjectId}
          busyLabel={task.workingLabel}
          refusal={refusalFor(actOf(dialog), dialog.booking.bookingId)}
          overrideAsk={
            overrideAsk && overrideAsk.subjectId === dialog.booking.bookingId && overrideAsk.act === actOf(dialog)
              ? overrideAsk
              : null
          }
          unsettled={unsettledFor(actOf(dialog), dialog.booking.bookingId)}
          canResend={lastAppointmentRequest(staffId, actOf(dialog), dialog.booking.bookingId) !== null}
          now={now}
          onSend={async (request) => {
            const act = actOf(dialog)
            const sent = await send(act, dialog.booking.bookingId, request)
            if (sent === 'confirmed') {
              if (act === 'reschedule_appointment') {
                const scheduled = String(request.scheduledAt ?? '')
                if (scheduled.length >= 10) setDay(scheduled.slice(0, 10))
              }
              setDialog(null)
            }
          }}
          onCheck={() => void checkOutcome(actOf(dialog), dialog.booking.bookingId)}
          onResend={() => void resend(actOf(dialog), dialog.booking.bookingId)}
          onClose={() => {
            setDialog(null)
            setRefusal(null)
            setOverrideAsk(null)
          }}
        />
      ) : null}

      <BookOverrideDialog
        ask={overrideAsk && overrideAsk.act === 'book_appointment' ? overrideAsk : null}
        who={overrideAsk ? nameFor('book_appointment', overrideAsk.subjectId) : ''}
        busy={pending !== null && pending.act === 'book_appointment'}
        busyLabel={task.workingLabel}
        onConfirm={async (reason) => {
          if (!overrideAsk) return
          const last = lastAppointmentRequest(staffId, 'book_appointment', overrideAsk.subjectId)
          if (!last) return
          const request = { ...last.request, overrideReason: reason }
          await book(request, overrideAsk.subjectId)
        }}
        onClose={() => setOverrideAsk(null)}
      />

      {history ? (
        <HistoryDrawer patientId={history.patientId} name={history.name} onClose={() => setHistory(null)} />
      ) : null}

      <TaskResult
        outcome={task.outcome}
        onDismiss={task.dismiss}
        next={nextAfter}
        returnFocusTo={dayHeading}
      />
    </Stack>
  )
}

function actOf(dialog: Dialog): AppointmentAct {
  return dialog.kind === 'move'
    ? 'reschedule_appointment'
    : dialog.kind === 'cancel'
      ? 'cancel_appointment'
      : 'mark_no_show'
}

/**
 * What a confirmed answer shows, before any replay is taken into account.
 *
 * Built from the command's own data, never from the form: a confirmation says
 * what the clinic recorded, and the form is only what somebody asked for.
 */
function baseOutcome(
  act: AppointmentAct,
  who: string,
  data: Record<string, unknown>,
  message: string,
): TaskOutcome {
  const scheduledAt = typeof data.scheduledAt === 'string' ? data.scheduledAt : ''
  const when = scheduledAt
    ? `${dayLabel(clinicDayOfInstant(scheduledAt))} at ${clinicClock(scheduledAt)}`
    : ''
  const minutes = typeof data.durationMinutes === 'number' ? data.durationMinutes : null
  const overrides = [
    data.overbooked === true ? 'overbooked' : '',
    data.outsideAvailability === true ? 'outside the published hours' : '',
  ].filter(Boolean)

  switch (act) {
    case 'book_appointment':
      return {
        kind: 'confirmed',
        title: 'Appointment booked',
        identity: who,
        detail: when || message,
        icon: 'calendar',
        facts: [
          ...(minutes !== null ? [{ label: 'Length', value: `${minutes} minutes` }] : []),
          { label: 'Queue', value: 'Not in the queue until checked in' },
          ...(overrides.length ? [{ label: 'Override', value: `${overrides.join(' and ')}, reason recorded` }] : []),
        ],
      }
    case 'reschedule_appointment':
      return {
        kind: 'confirmed',
        title: 'Appointment moved',
        identity: who,
        detail: message,
        icon: 'calendar',
        facts: [
          ...(when ? [{ label: 'Now', value: when }] : []),
          ...(overrides.length ? [{ label: 'Override', value: `${overrides.join(' and ')}, reason recorded` }] : []),
        ],
      }
    case 'cancel_appointment':
      return { kind: 'confirmed', title: 'Appointment cancelled', identity: who, detail: message, icon: 'calendar' }
    case 'mark_no_show':
      return { kind: 'confirmed', title: 'Recorded as not attended', identity: who, detail: message, icon: 'skip' }
    case 'check_in_appointment': {
      const token = typeof data.token === 'string' ? data.token : ''
      return {
        kind: 'confirmed',
        title: 'Checked in',
        identity: token ? `${who} · ${token}` : who,
        detail: 'In the ordinary queue, in order of arrival.',
        icon: 'queue',
        dwell: DWELL_MAJOR,
        facts: token ? [{ label: 'Queue token', value: token }] : [],
      }
    }
  }
}

/* ══════════════════════════════════════════════════════ what is unsettled ══ */

/**
 * One act whose outcome this screen has not seen confirmed.
 *
 * Never green, never dismissed by time. `unknown` offers only the two safe
 * moves — ask the clinic, or send the exact same request under the same
 * reference — and nothing that would mint a new one.
 */
function UnsettledCard({
  item,
  who,
  canResend,
  busy,
  onCheck,
  onResend,
  onDismiss,
}: {
  item: Unsettled
  who: string
  canResend: boolean
  busy: boolean
  onCheck: () => void
  onResend: () => void
  onDismiss: () => void
}) {
  const what = `${ACT_WORD[item.act]} · ${who}`
  const replay = item.outcome ? describeReplay(item.act, item.outcome.data) : null

  if (item.status === 'committed' && item.outcome) {
    return (
      <div
        data-testid="appointment-recovered"
        role="status"
        className={`rounded-box border px-3 py-2.5 text-[14px] leading-relaxed ${
          replay?.superseded ? 'border-attn bg-attn-wash text-attn' : 'border-free bg-free-wash text-free'
        }`}
      >
        <p className="flex items-start gap-2 font-semibold">
          <Icon name={replay?.superseded ? 'clock' : 'check-circle'} size={18} className="mt-0.5" />
          <span className="[overflow-wrap:anywhere]">{what} — the clinic recorded it</span>
        </p>
        <p className="mt-1 text-ink">{item.outcome.message || item.outcome.detail}</p>
        {replay?.superseded ? (
          <p className="mt-1 font-semibold text-attn">Since then: {replay.now}</p>
        ) : null}
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    )
  }

  const words_ =
    item.status === 'unknown'
      ? 'The clinic did not confirm this. It may or may not have been recorded. Everything you entered is kept; check what happened before doing anything else.'
      : item.status === 'checking'
        ? 'Asking the clinic what was recorded…'
        : item.status === 'check_failed'
          ? `Could not ask the clinic: ${item.message ?? ''}`
          : item.outcome?.detail ?? ''

  const tone = item.status === 'not_yours' ? 'border-rule bg-paper text-ink-2' : 'border-attn bg-attn-wash text-attn'

  return (
    <div
      data-testid={item.status === 'unknown' ? 'appointment-outcome-unknown' : `appointment-${item.status}`}
      role={item.status === 'unknown' ? 'alert' : 'status'}
      className={`rounded-box border px-3 py-2.5 text-[14px] leading-relaxed ${tone}`}
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icon name={item.status === 'checking' ? 'ring' : 'question-circle'} size={18} className={`mt-0.5 ${item.status === 'checking' ? 'jmc-spin' : ''}`} />
        <span className="[overflow-wrap:anywhere]">
          {item.status === 'not_committed' ? `${what} — nothing recorded` : `${what} — outcome not confirmed`}
        </span>
      </p>
      <p className="mt-1">{words_}</p>
      {item.status === 'not_committed' ? (
        <p className="mt-1">
          {canResend
            ? 'Send it again below; it goes under the same reference, so the clinic carries it out once.'
            : 'Do it again from this screen; this tablet sends it under the same reference, so the clinic carries it out once.'}
        </p>
      ) : null}
      {item.status !== 'checking' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.status === 'unknown' || item.status === 'in_flight' || item.status === 'check_failed' ? (
            <Button size="sm" variant="secondary" icon="search" disabled={busy} onClick={onCheck}>
              Check what happened
            </Button>
          ) : null}
          {canResend && (item.status === 'unknown' || item.status === 'not_committed') ? (
            <Button size="sm" variant="secondary" icon="ring" disabled={busy} onClick={onResend}>
              Send the same request again
            </Button>
          ) : null}
          {item.status === 'not_committed' || item.status === 'not_yours' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A refusal, where the act was taken. Nothing was recorded; nothing is held against the patient. */
function RefusalNotice({
  refusal,
  who,
  mayOverride,
  onDismiss,
}: {
  refusal: Refusal
  who: string
  mayOverride: boolean
  onDismiss?: () => void
}) {
  const noOverride =
    !mayOverride &&
    (refusal.code === 'SLOT_ALREADY_TAKEN' || refusal.code === 'OUTSIDE_PUBLISHED_AVAILABILITY')
  return (
    <div data-testid="appointment-refused">
      <Notice tone="bad" onDismiss={onDismiss}>
        <span className="font-semibold">
          Not done · {ACT_WORD[refusal.act]} for {who}.
        </span>{' '}
        {refusal.message}
        {noOverride ? (
          <span className="mt-1 block">
            A nurse cannot override this. Choose another time, or ask the doctor or an administrator to place it.
          </span>
        ) : null}
        {refusal.code && BOOK_MOVED.has(refusal.code) ? (
          <span className="mt-1 block">The appointment book has been read again.</span>
        ) : null}
      </Notice>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════ work lists ══ */

function WorkListCard({
  title,
  testId,
  read,
  empty,
  explain,
  render,
}: {
  title: string
  testId: string
  read: BookRead<WorkList>
  empty: string
  explain: string
  render: (row: ListRow) => ReactNode
}) {
  const list = read.value
  return (
    <Card>
      <div data-testid={testId}>
        <CardHeader
          title={title}
          sub={list ? `${list.count} ${list.count === 1 ? 'booking' : 'bookings'}` : undefined}
        />
        <CardBody className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-2">{explain}</p>
          <ReadState read={read} what={title.toLowerCase()} />
          {list ? (
            list.rows.length === 0 ? (
              <p className="text-[14px] text-ink-2">{empty}</p>
            ) : (
              <ul className="space-y-2">{list.rows.map((row) => render(row))}</ul>
            )
          ) : null}
          {list?.truncated ? (
            <p className="text-[12px] text-ink-2">Showing the first {list.rows.length} of {list.count}.</p>
          ) : null}
        </CardBody>
      </div>
    </Card>
  )
}

function ListLine({
  booking,
  when,
  note,
  actions,
}: {
  booking: BookingRef
  when: string
  note: ReactNode
  actions: ReactNode
}) {
  return (
    <li
      data-testid={`list-booking-${booking.bookingId}`}
      className="flex flex-wrap items-start justify-between gap-3 border-t border-rule pt-2 first:border-t-0 first:pt-0"
    >
      {/* A floor under the name, so on a phone the buttons wrap below it
          rather than squeezing a long name into a column one word wide. */}
      <div className="min-w-[11rem] flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[15px]">
          <span className="font-mono tabular-nums">{when}</span>
          <span className="font-semibold [overflow-wrap:anywhere]">{booking.patientName}</span>
        </p>
        {booking.reason ? (
          <p className="text-[13px] text-ink-2 [overflow-wrap:anywhere]">{booking.reason}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge tone="plain" icon="calendar">
            Booked · not in the queue
          </Badge>
          {note}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </li>
  )
}

/** Loading, slow, failed, and out of date — the four ways a read can look. */
function ReadState<T>({ read, what }: { read: BookRead<T>; what: string }) {
  if (read.loading && read.value === null) {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[14px]">
        <Icon name="ring" size={18} className="jmc-spin text-ink-2" />
        {read.slow ? `Still reading ${what}. The clinic is slow to answer; nothing is lost by waiting.` : `Reading ${what}…`}
      </p>
    )
  }
  if (read.failure && read.value === null) {
    return (
      <div className="space-y-2" data-testid="read-failed">
        <Notice tone="bad">{read.failure}</Notice>
        <Button size="sm" variant="secondary" icon="ring" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </div>
    )
  }
  if (read.failure && read.value !== null) {
    return (
      <div data-testid="read-stale">
        <Notice tone="pending">
          Could not refresh {what}: {read.failure} What is shown was read at{' '}
          {read.readAt ? clinicClock(new Date(read.readAt).toISOString()) : 'an earlier moment'}{' '}
          and may be out of date.
          <span className="mt-2 block">
            <Button size="sm" variant="secondary" icon="ring" onClick={() => void read.refresh()}>
              Try again
            </Button>
          </span>
        </Notice>
      </div>
    )
  }
  if (read.loading && read.slow) {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-ink-2">
        <Icon name="ring" size={16} className="jmc-spin" />
        Still refreshing {what}…
      </p>
    )
  }
  return null
}

/* ═════════════════════════════════════════════════════════════ booking ══ */

function BookCard({
  data,
  doctors,
  selectedPatientId,
  today,
  busy,
  busyLabel,
  blocked,
  refusal,
  unsettled,
  mayOverride,
  onBook,
  onHistory,
  onDismissRefusal,
}: {
  data: ClinicSnapshot
  doctors: Doctor[] | null
  selectedPatientId: string
  today: string
  busy: boolean
  busyLabel: string
  blocked?: string
  refusal: Refusal | null
  unsettled: Unsettled | null
  mayOverride: boolean
  onBook: (request: Record<string, unknown>, patientId: string) => Promise<boolean>
  onHistory: (patient: PatientView) => void
  onDismissRefusal: () => void
}) {
  const { select } = useSelectedPatient()
  const [search, setSearch] = useState('')
  const [when, setWhen] = useState('')
  const [reason, setReason] = useState('')
  const sessionIsDoctor = data.session.roles.includes('doctor')
  const [doctorId, setDoctorId] = useState('')

  const several = (doctors?.length ?? 0) > 1
  // A doctor books themselves unless they say otherwise — the server's own
  // default, made visible rather than left implicit.
  const chosenDoctor =
    doctorId || (several && sessionIsDoctor && doctors?.some((doctor) => doctor.id === data.session.staffId)
      ? data.session.staffId
      : '')

  const patient = data.patients.find((item) => item.id === selectedPatientId)
  const inQueue = data.appointments.find(
    (item) => item.patientId === selectedPatientId && (item.status === 'waiting' || item.status === 'in_consult'),
  )

  const matches =
    search.trim().length < 2
      ? []
      : data.patients
          .filter((candidate) => {
            const query = search.trim().toLocaleLowerCase('en-IN')
            const digits = query.replace(/[^0-9]/g, '')
            return (
              candidate.name.toLocaleLowerCase('en-IN').includes(query) ||
              (digits.length > 0 && candidate.phone.replace(/[^0-9]/g, '').includes(digits))
            )
          })
          .slice(0, 6)

  const whenOk = isClinicLocalInput(when)
  const missing = !patient
    ? 'Find the patient first.'
    : !whenOk
      ? 'Choose the date and time.'
      : !reason.trim()
        ? 'Record the reason for the visit.'
        : several && !chosenDoctor
          ? 'Choose which doctor this appointment is with.'
          : ''

  async function submit() {
    if (!patient || missing) return
    /*
     * Exactly what the contract takes, and nothing derived: the
     * `datetime-local` string untouched — clinic-local by the server's reading
     * — and a doctor only when the clinic has more than one. No appointment
     * type: none is discoverable, so the clinic default of fifteen minutes
     * applies (owner item 65).
     */
    const request: Record<string, unknown> = {
      patientId: patient.id,
      reason: reason.trim(),
      scheduledAt: when,
      ...(several && chosenDoctor ? { doctorId: chosenDoctor } : {}),
    }
    const booked = await onBook(request, patient.id)
    if (booked) {
      setWhen('')
      setReason('')
    }
  }

  return (
    <Card variant="record">
      <div data-testid="book-appointment">
        <CardHeader
          title="Book an appointment"
          sub="For a patient already on the register. A booking is not a queue token."
        />
        <CardBody className="space-y-4">
          <Field label="Find patient" hint="Name or mobile number. Register a new patient from Patients first.">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" />
          </Field>
          {matches.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Matching patients">
              {matches.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={candidate.id === selectedPatientId}
                  className={`min-h-[56px] border px-3 py-2 text-left ${
                    candidate.id === selectedPatientId ? 'border-ink bg-active-wash' : 'border-rule bg-sheet'
                  }`}
                  onClick={() => select(candidate.id)}
                >
                  <span className="block text-[14px] font-semibold [overflow-wrap:anywhere]">{candidate.name}</span>
                  <span className="block text-[12px] text-ink-2">
                    {candidate.age} years · ending {candidate.phone.replace(/[^0-9]/g, '').slice(-4)}
                  </span>
                </button>
              ))}
            </div>
          ) : search.trim().length >= 2 ? (
            <p className="text-[13px] text-ink-2">No patient on the register matches that.</p>
          ) : null}

          {patient ? (
            <div
              data-testid="book-patient"
              className="flex flex-wrap items-center justify-between gap-3 border border-rule bg-paper px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-[16px] font-semibold [overflow-wrap:anywhere]">{patient.name}</p>
                <p className="text-[13px] text-ink-2">
                  {patient.age} years · {patient.sex}
                  {inQueue ? ` · already in today’s queue as ${inQueue.token}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" icon="history" onClick={() => onHistory(patient)}>
                Appointments
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-ink-2">No patient chosen.</p>
          )}

          <FieldRow cols={2}>
            <Field label="Date and time" hint="Clinic time (IST)." required>
              <Input
                type="datetime-local"
                value={when}
                min={`${today}T00:00`}
                max={`${shiftDay(today, 90)}T23:59`}
                onChange={(event) => setWhen(event.target.value)}
              />
            </Field>
            {several ? (
              <Field label="Doctor" required>
                <Select value={chosenDoctor} onChange={(event) => setDoctorId(event.target.value)}>
                  <option value="">Choose the doctor</option>
                  {doctors?.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <div className="text-[13px] leading-relaxed text-ink-2">
                <span className="eyebrow">Length</span>
                <p className="mt-1">{DEFAULT_APPOINTMENT_MINUTES} minutes, the clinic default.</p>
              </div>
            )}
          </FieldRow>
          {several ? (
            <p className="text-[13px] text-ink-2">
              Length: {DEFAULT_APPOINTMENT_MINUTES} minutes, the clinic default.
            </p>
          ) : null}

          <Field label="Reason for the visit" hint="Travels to the queue at check-in, where the doctor reads it." required>
            <Input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <ActionButton
              variant="primary"
              className="min-h-[56px]"
              icon="calendar"
              busy={busy}
              busyLabel={busyLabel}
              disabled={Boolean(missing) || Boolean(blocked)}
              disabledReason={blocked ?? missing}
              onClick={() => void submit()}
            >
              Book appointment
            </ActionButton>
            {missing && !busy ? <p className="text-[13px] text-ink-2">{missing}</p> : null}
          </div>

          {refusal && patient && refusal.subjectId === patient.id ? (
            <RefusalNotice refusal={refusal} who={patient.name} mayOverride={mayOverride} onDismiss={onDismissRefusal} />
          ) : null}
          {unsettled ? (
            <p className="text-[13px] text-attn">
              An earlier booking for this patient has not been confirmed — see the top of this screen. A new
              press goes under the same reference, so it cannot be carried out twice.
            </p>
          ) : null}
        </CardBody>
      </div>
    </Card>
  )
}

/** Owner item 67, for a doctor or an administrator: the reason, asked for once. */
function BookOverrideDialog({
  ask,
  who,
  busy,
  busyLabel,
  onConfirm,
  onClose,
}: {
  ask: OverrideAsk | null
  who: string
  busy: boolean
  busyLabel: string
  onConfirm: (reason: string) => Promise<void>
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (ask) setReason('')
  }, [ask])

  return (
    <Modal
      open={ask !== null}
      onClose={onClose}
      title="Book it anyway?"
      sub={who}
      busy={busy}
      busyLabel={busyLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Choose another time
          </Button>
          <Button
            variant="primary"
            icon="calendar"
            disabled={busy || !reason.trim()}
            onClick={() => void onConfirm(reason.trim())}
          >
            Book with this reason
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="override-dialog">
        <Notice tone="pending">{ask?.message}</Notice>
        <p className="text-[13px] leading-relaxed text-ink-2">
          The same request is sent again with your reason. It is recorded with your name against it, and the booking
          is marked as an override wherever it is shown.
        </p>
        <Field label="Why this appointment goes here" required>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  )
}

/* ════════════════════════════════════════════════════════════ the day ══ */

function DayCard({
  day,
  today,
  onDay,
  read,
  doctors,
  headingRef,
  renderBooking,
}: {
  day: string
  today: string
  onDay: (day: string) => void
  read: BookRead<Calendar>
  doctors: Doctor[] | null
  headingRef: RefObject<HTMLHeadingElement | null>
  renderBooking: (booking: CalendarBooking) => ReactNode
}) {
  const calendar = read.value
  const hours = calendar ? hoursForDay(calendar.availability, day) : []
  const doctorName = (id: string) =>
    doctors?.find((doctor) => doctor.id === id)?.name ??
    calendar?.bookings.find((booking) => booking.doctorId === id)?.doctorName ??
    'The doctor'
  const past = day < today

  return (
    <Card>
      <div data-testid="appointment-day">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">The book for</p>
            <h2 ref={headingRef} tabIndex={-1} className="text-[18px] font-semibold leading-snug">
              {dayLabel(day)}
              {day === today ? <span className="ml-2 text-[13px] font-normal text-ink-2">today</span> : null}
            </h2>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="secondary" icon="arrow-left" onClick={() => onDay(shiftDay(day, -1))}>
              Previous day
            </Button>
            <Button size="sm" variant="secondary" disabled={day === today} onClick={() => onDay(today)}>
              Today
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onDay(shiftDay(day, 1))}>
              Next day
              <Icon name="arrow-right" size={17} />
            </Button>
            <label className="block">
              <span className="sr-only">Go to a day</span>
              <Input
                type="date"
                aria-label="Go to a day"
                value={day}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) onDay(event.target.value)
                }}
                className="w-[11rem]"
              />
            </label>
          </div>
        </div>

        <CardBody className="space-y-4">
          <ReadState read={read} what="the appointment book" />

          {calendar ? (
            <>
              <section aria-label="Published hours" data-testid="published-hours" className="space-y-1.5">
                {hours.length === 0 ? (
                  <Notice tone="pending">
                    No hours are published for this day. A nurse cannot book it; a doctor or an administrator can, and is
                    asked for a reason that is recorded.
                  </Notice>
                ) : (
                  hours.map((entry) => (
                    <div key={entry.doctorId} className="text-[14px] leading-relaxed">
                      <span className="font-semibold">{doctorName(entry.doctorId)}</span>
                      {': '}
                      {entry.open.length === 0 ? (
                        <span>no open hours</span>
                      ) : (
                        <span>
                          open{' '}
                          {entry.open.map((window) => `${window.startsAt}–${window.endsAt}`).join(', ')}
                        </span>
                      )}
                      {entry.blocked.length > 0 ? (
                        <span className="text-attn">
                          {' · '}blocked{' '}
                          {entry.blocked
                            .map((window) => `${window.startsAt}–${window.endsAt}${window.note ? ` (${window.note})` : ''}`)
                            .join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
                {past ? (
                  <p className="text-[13px] text-ink-2">
                    This day has gone. Nothing new can be booked into it; what is shown is its record.
                  </p>
                ) : null}
              </section>

              {calendar.bookings.length === 0 ? (
                <EmptyState
                  title="Nobody is booked for this day"
                  direction="A booking made above appears here. Walk-ins join the queue from Today and are not shown in the book."
                />
              ) : (
                <ul className="space-y-3" aria-label="Bookings">
                  {calendar.bookings.map((booking) => renderBooking(booking))}
                </ul>
              )}
              {calendar.truncated ? (
                <Notice tone="pending">
                  More bookings exist for this day than one read carries. Only the first {calendar.bookings.length} are
                  shown.
                </Notice>
              ) : null}
            </>
          ) : null}
        </CardBody>
      </div>
    </Card>
  )
}

/**
 * One booking, stating plainly which side of the queue it is on.
 *
 * A `booked` row carries no token, because it has none. A checked-in row
 * carries the token the check-in issued and where that visit is now — and if
 * the visit was taken out of the queue, it says so rather than printing the
 * token as though the patient were still waiting.
 */
function BookingLine({
  booking,
  now,
  showDoctor,
  mayChangeStarted,
  checkingIn,
  workingLabel,
  blocked,
  anyPending,
  onCheckIn,
  onMove,
  onCancel,
  onNoShow,
  onHistory,
}: {
  booking: CalendarBooking
  now: number
  showDoctor: boolean
  mayChangeStarted: boolean
  checkingIn: boolean
  workingLabel: string
  blocked?: string
  anyPending: boolean
  onCheckIn: () => void
  onMove: () => void
  onCancel: () => void
  onNoShow: () => void
  onHistory: () => void
}) {
  const skin = STATUS_SKIN[booking.status]
  const booked = booking.status === 'booked'
  const started = booking.status === 'checked_in'
  const seen = started && booking.arrivalStatus === 'done'
  const past = minutesPast(booking.scheduledAt, now)
  const late = booked && Number.isFinite(past) && past >= NO_SHOW_AFTER_MINUTES
  const eligible = booked && noShowEligible(booking.scheduledAt, now)
  const mayChange = booked || (started && mayChangeStarted && !seen)
  const busyElsewhere = anyPending || Boolean(blocked)

  return (
    <li
      data-testid={`booking-${booking.bookingId}`}
      data-status={booking.status}
      className={`border px-3 py-3 ${
        booking.status === 'cancelled' || booking.status === 'no_show' ? 'border-rule bg-paper' : 'border-rule bg-sheet'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[11rem] flex-1">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[15px] tabular-nums">
              {clinicSpan(booking.scheduledAt, booking.durationMinutes)}
            </span>
            <span className="text-[16px] font-semibold [overflow-wrap:anywhere]">{booking.patientName}</span>
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
            {booking.reason}
            {booking.appointmentType ? ` · ${booking.appointmentType}` : ''}
            {` · ${booking.durationMinutes} min`}
            {showDoctor ? ` · ${booking.doctorName}` : ''}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={skin.tone} icon={skin.icon}>
              {skin.label}
            </Badge>
            {started && booking.arrivalToken ? (
              <>
                <Token code={booking.arrivalToken} size="sm" active={booking.arrivalStatus === 'waiting' || booking.arrivalStatus === 'in_consult'} />
                <Badge tone={booking.arrivalStatus === 'cancelled' ? 'attn' : 'plain'} icon={null}>
                  {ARRIVAL_WORD[booking.arrivalStatus ?? ''] ?? words(booking.arrivalStatus ?? '')}
                </Badge>
              </>
            ) : null}
            {late ? <Badge tone="attn">Late · {past} min</Badge> : null}
            {booking.overbooked ? <Badge tone="attn" icon="alert">Overbooked</Badge> : null}
            {booking.outsideAvailability ? <Badge tone="attn" icon="alert">Outside published hours</Badge> : null}
          </div>

          {booking.overbookedReason ? (
            <p className="mt-1 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
              Override reason: {booking.overbookedReason}
            </p>
          ) : null}
          {booking.lastEvent && booking.lastEvent.event !== 'booked' ? (
            <p className="mt-1 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
              {EVENT_WORD[booking.lastEvent.event] ?? words(booking.lastEvent.event)} by {booking.lastEvent.by},{' '}
              {clinicMoment(booking.lastEvent.at)}
              {booking.lastEvent.reason ? ` — ${booking.lastEvent.reason}` : ''}
            </p>
          ) : null}
          {started && !mayChangeStarted && !seen ? (
            <p className="mt-1 text-[13px] text-ink-2">
              This visit has started. Only a doctor or an administrator can move or cancel it.
            </p>
          ) : null}
          {seen ? (
            <p className="mt-1 text-[13px] text-ink-2">Seen. The visit is finished and its record stands.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2" data-print="hide">
          {booked ? (
            <ActionButton
              size="sm"
              variant="primary"
              icon="queue"
              busy={checkingIn}
              busyLabel={workingLabel}
              disabled={busyElsewhere}
              disabledReason={blocked}
              onClick={onCheckIn}
            >
              Check in
            </ActionButton>
          ) : null}
          {mayChange ? (
            <>
              <Button size="sm" disabled={busyElsewhere} onClick={onMove}>
                Move
              </Button>
              <Button size="sm" variant="danger" disabled={busyElsewhere} onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : null}
          {eligible ? (
            <Button size="sm" icon="skip" disabled={busyElsewhere} onClick={onNoShow}>
              Did not attend
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="history" onClick={onHistory}>
            History
          </Button>
        </div>
      </div>
    </li>
  )
}

/* ═════════════════════════════════════════════ move, cancel, no-show ══ */

function BookingDialog({
  dialog,
  mayOverride,
  busy,
  busyLabel,
  refusal,
  overrideAsk,
  unsettled,
  canResend,
  now,
  onSend,
  onCheck,
  onResend,
  onClose,
}: {
  dialog: Dialog
  mayOverride: boolean
  busy: boolean
  busyLabel: string
  refusal: Refusal | null
  overrideAsk: OverrideAsk | null
  unsettled: Unsettled | null
  canResend: boolean
  now: number
  onSend: (request: Record<string, unknown>) => Promise<void>
  onCheck: () => void
  onResend: () => void
  onClose: () => void
}) {
  const { booking } = dialog
  const [when, setWhen] = useState(() => clinicLocalInput(booking.scheduledAt))
  const [reason, setReason] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const started = booking.status === 'checked_in'

  const title =
    dialog.kind === 'move' ? 'Move this appointment' : dialog.kind === 'cancel' ? 'Cancel this appointment' : 'Record that the patient did not attend'

  const eligible = noShowEligible(booking.scheduledAt, now)
  const ready =
    dialog.kind === 'move'
      ? isClinicLocalInput(when) && reason.trim().length > 0 && (!overrideAsk || overrideReason.trim().length > 0)
      : dialog.kind === 'cancel'
        ? reason.trim().length > 0
        : eligible

  async function submit() {
    if (!ready) return
    if (dialog.kind === 'move') {
      // The same request as before plus the reason, when the clinic asked for
      // one; the reference is the one held since the question was asked.
      await onSend({
        bookingId: booking.bookingId,
        scheduledAt: when,
        reason: reason.trim(),
        ...(overrideAsk ? { overrideReason: overrideReason.trim() } : {}),
      })
    } else if (dialog.kind === 'cancel') {
      await onSend({ bookingId: booking.bookingId, reason: reason.trim() })
    } else {
      await onSend({ bookingId: booking.bookingId, ...(reason.trim() ? { reason: reason.trim() } : {}) })
    }
  }

  const primary =
    dialog.kind === 'move'
      ? overrideAsk
        ? 'Move with this reason'
        : 'Move appointment'
      : dialog.kind === 'cancel'
        ? 'Cancel appointment'
        : 'Record did not attend'

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      sub={`${booking.patientName} · ${clinicMoment(booking.scheduledAt)}`}
      busy={busy}
      busyLabel={busyLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant={dialog.kind === 'cancel' ? 'danger' : 'primary'}
            disabled={
              busy ||
              !ready ||
              unsettled?.status === 'unknown' ||
              unsettled?.status === 'checking' ||
              unsettled?.status === 'in_flight' ||
              unsettled?.status === 'check_failed'
            }
            onClick={() => void submit()}
          >
            {primary}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid={`dialog-${dialog.kind}`}>
        {started ? (
          <Notice tone="pending">
            This patient is checked in{booking.arrivalToken ? ` as ${booking.arrivalToken}` : ''}.{' '}
            {dialog.kind === 'move' ? 'Moving' : 'Cancelling'} the appointment takes them out of today’s queue; the
            reason is recorded on both.
          </Notice>
        ) : null}

        {dialog.kind === 'move' ? (
          <>
            <Field label="New date and time" hint="Clinic time (IST). The old time stays in the history." required>
              <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
            </Field>
            <Field label="Why it is moving" required>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
            </Field>
            {overrideAsk ? (
              <div data-testid="override-dialog" className="space-y-2">
                <Notice tone="pending">{overrideAsk.message}</Notice>
                <Field label="Why it goes there anyway" required>
                  <Textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={3} />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}

        {dialog.kind === 'cancel' ? (
          <Field label="Why it is cancelled" hint="The booking is not deleted; this reason stays in its history." required>
            <Input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
          </Field>
        ) : null}

        {dialog.kind === 'no_show' ? (
          <>
            <p className="text-[14px] leading-relaxed">
              Booked for {clinicMoment(booking.scheduledAt)}. Nothing records a no-show by itself: this records that you
              confirmed it, with your name and the time.
            </p>
            {!eligible ? (
              <Notice tone="pending">
                Not yet — a no-show can be confirmed {NO_SHOW_AFTER_MINUTES} minutes after the start. The patient may
                still be on the way.
              </Notice>
            ) : null}
            <Field label="Note" hint="Optional.">
              <Input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
            </Field>
          </>
        ) : null}

        {refusal ? <RefusalNotice refusal={refusal} who={booking.patientName} mayOverride={mayOverride} /> : null}
        {unsettled ? (
          <UnsettledCard
            item={unsettled}
            who={booking.patientName}
            canResend={canResend}
            busy={busy}
            onCheck={onCheck}
            onResend={onResend}
            onDismiss={onClose}
          />
        ) : null}
      </div>
    </Modal>
  )
}

/* ═══════════════════════════════════════════════════════════ history ══ */

/**
 * One patient's appointments, and every transition of each.
 *
 * Owner item 68: "No appointment is silently deleted: the prior state, actor,
 * time, and reason remain in append-only history." This is where that is read
 * back, oldest first within each booking, in the words of the event.
 */
function HistoryDrawer({ patientId, name, onClose }: { patientId: string; name: string; onClose: () => void }) {
  const read = useBookRead<PatientAppointment[]>(
    `workspace?view=appointments&patientId=${encodeURIComponent(patientId)}`,
    'appointments',
  )
  const appointments = read.value

  return (
    <Drawer open onClose={onClose} title="Appointments" sub={name} width="lg">
      <div className="space-y-4" data-testid="appointment-history">
        <ReadState read={read} what="this patient’s appointments" />
        {appointments && appointments.length === 0 ? (
          <p className="text-[14px] text-ink-2">No appointment has ever been booked for this patient.</p>
        ) : null}
        {appointments?.map((appointment) => {
          const skin = STATUS_SKIN[appointment.status]
          return (
            <article key={appointment.bookingId} className="border border-rule px-3 py-3" data-testid={`history-${appointment.bookingId}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[15px] font-semibold">{clinicMoment(appointment.scheduledAt)}</p>
                <Badge tone={skin.tone} icon={skin.icon}>
                  {skin.label}
                </Badge>
              </div>
              <p className="mt-0.5 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
                {appointment.reason} · {appointment.durationMinutes} min · {appointment.doctorName}
                {appointment.arrivalToken ? ` · token ${appointment.arrivalToken} (${ARRIVAL_WORD[appointment.arrivalStatus ?? ''] ?? appointment.arrivalStatus})` : ''}
              </p>
              {appointment.overbookedReason ? (
                <p className="mt-1 text-[13px] text-attn [overflow-wrap:anywhere]">
                  Override{appointment.overbooked ? ' · overbooked' : ''}
                  {appointment.outsideAvailability ? ' · outside published hours' : ''}: {appointment.overbookedReason}
                </p>
              ) : null}
              <ol className="mt-2 space-y-1.5 border-l-2 border-rule pl-3">
                {appointment.history.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="text-[13px] leading-relaxed">
                    <span className="font-semibold">{EVENT_WORD[event.event] ?? words(event.event)}</span>
                    {' · '}
                    {event.by} · {clinicMoment(event.at)}
                    {event.reason ? <span className="block [overflow-wrap:anywhere]">Reason: {event.reason}</span> : null}
                    {event.detail ? <span className="block text-ink-2 [overflow-wrap:anywhere]">{event.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </article>
          )
        })}
      </div>
    </Drawer>
  )
}

/* ═════════════════════════════════════════════ a pointer from elsewhere ══ */

/**
 * "Somebody booked is expected" — on the screens staff are already looking at.
 *
 * Today's queue and Due now show who is in the building; a booked patient is
 * not, until check-in. This says how many are expected and how many are late,
 * and takes the person to the station where they are checked in. It reads the
 * same `list.appointments_today` the station does, so the number and the list
 * behind it cannot disagree. Silent when nobody is expected, and silent for a
 * role that does not hold the list.
 */
export function ExpectedTodayPointer({ data }: { data: ClinicSnapshot }) {
  const allowed = data.session.roles.some((role) => MAY_BOOK.includes(role))
  const { goTo } = useSelectedPatient()
  const [counts, setCounts] = useState<{ expected: number; late: number } | null>(null)

  useEffect(() => {
    if (!allowed) return
    let live = true
    void readWorkspace<{ list?: WorkList }>('workspace?view=list&list=list.appointments_today').then((answer) => {
      if (!live || !answer.ok || !answer.value.list) return
      const list = answer.value.list
      setCounts({ expected: list.count, late: list.rows.filter((row) => row.late === true).length })
    })
    return () => {
      live = false
    }
  }, [allowed, data])

  if (!allowed || !counts || counts.expected === 0) return null

  return (
    <div data-testid="expected-today-pointer" data-print="hide">
      <Notice tone="info" icon="calendar">
        <span className="font-semibold">
          {counts.expected} booked {counts.expected === 1 ? 'patient is' : 'patients are'} expected today
        </span>
        {counts.late > 0 ? `, ${counts.late} late` : ''}. A booked patient is not in this queue until they are
        checked in.{' '}
        <span className="mt-2 block">
          <Button size="sm" variant="secondary" icon="calendar" onClick={() => goTo('appointments')}>
            Open appointments
          </Button>
        </span>
      </Notice>
    </div>
  )
}
