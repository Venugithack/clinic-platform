'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  BedView,
  ClinicSnapshot,
  CommandResponse,
  InvoiceLineView,
  InvoiceView,
  PatientView,
  PrescriptionItemView,
  Role,
} from '@/lib/types'
import {
  useBusy,
  useConnection,
  useSelectedPatient,
  type ActionRunner,
} from './clinic-context'
import { navigationFor, type View } from './navigation'
import { callApi } from '@/lib/api'
import {
  ActionButton,
  Badge,
  Busy,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckRow,
  ConfirmButton,
  DWELL_MAJOR,
  DWELL_ROUTINE,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  Icon,
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
  TaskFailure,
  TaskResult,
  Textarea,
  Token,
  clinicToday,
  formatDate,
  formatDay,
  money,
  useTask,
  words,
  type IconName,
  type TaskOutcome,
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

/* ═══════════════════════════════════════════════ the operational overview */

/**
 * One thing that is wrong in the clinic right now, and where it is put right.
 *
 * The administrator's first screen used to be four tiles and two lists of
 * equal weight — a patient queue, a bed count, a bill count and a stock count,
 * all the same size whether the number under them was 0 or 9, and a "Needs
 * attention" column that only ever knew about low stock and beds. A reader had
 * to work out which of six panels was the one that mattered this morning, and
 * two of the things that matter most — a prescription past its `valid until`
 * and a bill on the financial review queue — appeared on none of them.
 *
 * So the screen is a list of exceptions instead. Each row is a count, the word
 * for what it counts, one sentence saying what it means, and the station that
 * settles it. Rows are ordered by what somebody owes a decision on rather than
 * by which module they came from, and the plan's rule holds: "Avoid a dashboard
 * made from equally prominent cards."
 *
 * Every figure is counted out of the snapshot on each render. Nothing here is
 * stored, dismissed or acknowledged, which is the plan's other requirement for
 * this screen — "Exceptions stay visible until resolved rather than
 * disappearing because they were opened." Opening one changes nothing; only
 * the clinic answering differently does.
 */
type Exception = {
  id: string
  /** The word. The count is never on the screen without it. */
  label: string
  count: number
  /** What the figure means and what happens next, in the clinic's own words. */
  detail: string
  /** `stop` is a decision owed now; `attn` is work to keep an eye on. */
  tone: 'stop' | 'attn'
  icon: IconName
  /** Where it is settled, most specific first. The first station this session can reach wins. */
  routes: View[]
  /** Said instead of a control when nobody on this session's rail can settle it. */
  whoSettles: string
}

/** Severity as a word, because colour is never the only signal. */
const SEVERITY: Record<Exception['tone'], { word: string; tone: Tone }> = {
  stop: { word: 'Act now', tone: 'stop' },
  attn: { word: 'Watch', tone: 'attn' },
}

function minutesSince(at: string, now: number): number {
  const then = new Date(at).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.round((now - then) / 60_000))
}

/** A wait said out loud rather than as a bare number. */
function waitWords(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}${rest > 0 ? ` ${rest} min` : ''}`
}

/** Whole days from the clinic's today to a plain `YYYY-MM-DD`. */
function daysUntil(day: string, today: string): number {
  const then = new Date(`${day.slice(0, 10)}T00:00:00`).getTime()
  const from = new Date(`${today}T00:00:00`).getTime()
  if (!Number.isFinite(then) || !Number.isFinite(from)) return Number.POSITIVE_INFINITY
  return Math.round((then - from) / 86_400_000)
}

/**
 * What a prescription line still owes, and whether anybody may act on it.
 *
 * Local copies of `remainingOf` and `isPending` from `components/counter-math.ts`
 * rather than imports of them. That module reaches `plural` out of
 * `formulary-workspace.tsx`, which imports `Stack` from this file — and an
 * import cycle through modules that evaluate at load time is how a shared
 * component becomes `undefined` on one screen and not another. The arithmetic
 * is four lines; the cycle would not be worth it.
 */
function lineRemaining(item: PrescriptionItemView): number {
  if (item.remaining !== undefined) return item.remaining
  return Math.max((item.quantity ?? 0) - (item.supplied ?? 0), 0)
}

/** A line the counter may still hand something over on. */
function lineOwed(item: PrescriptionItemView): boolean {
  if (item.supplyState) {
    return item.supplyState === 'waiting' || item.supplyState === 'part_supplied'
  }
  return !item.cancelled && !item.needsReview
}

/** A line only a doctor can settle. */
function lineNeedsDoctor(item: PrescriptionItemView): boolean {
  return item.supplyState === 'needs_review' || item.needsReview === true
}

/**
 * One exception, with the control that answers it.
 *
 * The station is resolved against what this session can actually reach rather
 * than assumed: a pure administrator's rail carries no Consult and no queue, so
 * a row that sent one there would land on a screen with no way back to it. When
 * nothing on the rail settles it, the row says who does instead of offering a
 * button that goes nowhere.
 */
function ExceptionRow({
  exception,
  station,
  onOpen,
}: {
  exception: Exception
  station?: { id: View; label: string }
  onOpen: (view: string) => void
}) {
  const severity = SEVERITY[exception.tone]

  return (
    <div
      data-testid="overview-exception"
      data-exception={exception.id}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-rule px-4 py-3 last:border-b-0"
    >
      <span
        aria-hidden="true"
        className={`mt-1 shrink-0 ${exception.tone === 'stop' ? 'text-stop' : 'text-attn'}`}
      >
        <Icon name={exception.icon} size={20} />
      </span>
      <p
        data-testid="exception-count"
        className="w-[46px] shrink-0 text-right font-mono text-[20px] leading-tight font-medium tabular-nums"
      >
        {exception.count}
      </p>
      <div className="min-w-[150px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] leading-snug font-semibold">{exception.label}</h3>
          <Badge tone={severity.tone}>{severity.word}</Badge>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{exception.detail}</p>
      </div>
      <div className="shrink-0" data-print="hide">
        {station ? (
          <Button
            size="sm"
            aria-label={`${exception.label} — open ${station.label}`}
            onClick={() => onOpen(station.id)}
          >
            Open {station.label}
          </Button>
        ) : (
          <p className="max-w-[190px] text-[12px] leading-snug text-ink-2">{exception.whoSettles}</p>
        )}
      </div>
    </div>
  )
}

/**
 * A confirmed admin result, centred over the screen it did not change.
 *
 * Wrapped rather than rendered bare so that a browser test can ask for the
 * administrator's own result, and so the wrapper is absent — not merely empty —
 * until the clinic has actually confirmed something.
 */
function AdminResult({
  task,
  next,
}: {
  task: ReturnType<typeof useTask>
  next?: { label: string; onPress: () => void }
}) {
  if (!task.outcome) return null
  return (
    <div data-testid="admin-result">
      <TaskResult outcome={task.outcome} onDismiss={task.dismiss} next={next} />
    </div>
  )
}

export function OverviewPanel({ data, run }: { data: ClinicSnapshot; run?: ActionRunner }) {
  const { select, goTo } = useSelectedPatient()
  const connection = useConnection()
  const followUpTask = useTask()
  /* Which row is saving. One global `busy` would relabel every Mark completed
     on the screen, which is the confusion the shared lifecycle exists to end. */
  const [completing, setCompleting] = useState('')
  const now = Date.now()
  const today = clinicToday()

  /* Waiting and in consultation are counted apart. One is a person nobody has
     started on and the other is a consultation nobody has finished; they are
     different facts and they are settled by different people. */
  const waitingNow = data.appointments.filter((item) => item.status === 'waiting')
  const inConsult = data.appointments.filter((item) => item.status === 'in_consult')
  const longestWait = waitingNow
    .map((item) => ({ item, minutes: minutesSince(item.scheduledAt, now) }))
    .sort((a, b) => b.minutes - a.minutes)[0]
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
  const overdueChecks = occupied.filter(
    (bed) => bed.nextCheckAt !== undefined && new Date(bed.nextCheckAt).getTime() <= now,
  )
  const handoffs = data.beds.filter(
    (bed) => bed.handoffRequestedAt !== undefined && bed.handoffResolvedAt === undefined,
  )
  const openFollowUps = data.followUps.filter((item) => item.status === 'open')
  const overdueFollowUps = openFollowUps.filter((item) => item.dueDate < today)

  /* Prescriptions counted by what is still owed on them rather than by a status
     column: one whose every line has been declined is finished, and one with a
     single part-supplied line is still work standing at the counter. */
  const owedRx = data.prescriptions.filter((rx) =>
    rx.items.some((item) => lineOwed(item) && lineRemaining(item) > 0),
  )
  const expiredRx = owedRx.filter(
    (rx) => rx.expired === true || (rx.validUntil !== undefined && rx.validUntil < today),
  )
  const liveRx = owedRx.filter((rx) => !expiredRx.includes(rx))
  const doctorRx = data.prescriptions.filter((rx) => rx.items.some(lineNeedsDoctor))

  /* Stock. Expired, recalled and blocked are held apart from merely low: one is
     medicine that must not leave the shelf and the other is a purchase order. */
  const expiredBatches = data.batches.filter(
    (batch) => batch.expired && batch.availableQuantity > 0,
  )
  /* Quantity, not merely status: a recalled batch that was exhausted years ago
     is history, and putting it on this list every morning teaches a reader to
     stop reading the list. */
  const blockedBatches = data.batches.filter(
    (batch) =>
      batch.quarantinedQuantity > 0 ||
      batch.blockedQuantity > 0 ||
      (batch.status !== 'active' && batch.availableQuantity > 0),
  )
  const expiringSoon = data.batches.filter((batch) => {
    if (batch.expired || batch.availableQuantity <= 0) return false
    const days = daysUntil(batch.expiry, today)
    return days >= 0 && days <= 60
  })

  const balances = data.patientBalances.filter((balance) => balance.outstanding > 0)
  const owedByPatients = balances.reduce((sum, balance) => sum + balance.outstanding, 0)

  /*
   * The financial review queue — policy register items 50, 55 and 61.
   *
   * Named in the words the command itself refuses in, so that the screen and
   * the server say one thing. `counter.ts` answers a counter with "Over-refunded
   * — financial correction required", "Voided with money against it — financial
   * correction required" or "Voided while over-refunded — financial correction
   * required" depending on which way the arithmetic went, and this is where the
   * one person who can do anything about it meets the same sentence.
   *
   * The two states are exclusive and `void_with_balance` is decided first, so a
   * bill appears in exactly one of these three lists and the row's count is the
   * queue.
   */
  const overRefunded = data.invoices.filter((item) => item.paymentState === 'over_refunded')
  const voidHeld = data.invoices.filter(
    (item) => item.paymentState === 'void_with_balance' && item.paid > 0,
  )
  const voidPast = data.invoices.filter(
    (item) => item.paymentState === 'void_with_balance' && item.paid <= 0,
  )
  const reviewWords = [
    overRefunded.length > 0
      ? `Over-refunded — financial correction required. ${money(
          overRefunded.reduce((sum, item) => sum - item.paid, 0),
        )} more has gone back out than ever came in.`
      : '',
    voidHeld.length > 0
      ? `Voided with money against it — financial correction required. ${money(
          voidHeld.reduce((sum, item) => sum + item.paid, 0),
        )} is still held against ${voidHeld.length === 1 ? 'a bill' : 'bills'} nobody is being charged for.`
      : '',
    voidPast.length > 0
      ? `Voided while over-refunded — financial correction required. ${money(
          voidPast.reduce((sum, item) => sum - item.paid, 0),
        )} went back out past ${voidPast.length === 1 ? 'a bill' : 'bills'} already cancelled.`
      : '',
    `${underReview.map((item) => item.invoiceNumber).join(', ')}. Nothing is collected at the counter and nothing on any screen closes one: an administrator and the clinic's accountant settle it between them.`,
  ]
    .filter(Boolean)
    .join(' ')

  /*
   * Every exception this clinic can be in, declared in the order a person
   * should meet them and then sorted so that what is owed a decision comes
   * first. A row with nothing behind it is dropped rather than drawn as a
   * reassuring zero — a screen of zeroes is a screen nobody reads.
   */
  const everyException: Exception[] = [
    {
      id: 'financial-review',
      label:
        underReview.length === 1 ? 'Bill under financial review' : 'Bills under financial review',
      count: underReview.length,
      tone: 'stop',
      icon: 'alert-circle',
      detail: reviewWords,
      routes: ['billing'],
      whoSettles: 'The administrator and the clinic’s accountant.',
    },
    {
      id: 'connection',
      label: 'Clinic refresh not answered',
      count: connection.stale ? 1 : 0,
      tone: 'stop',
      icon: 'signal-off',
      detail: connection.lastUpdated
        ? `Every figure on this screen is from ${formatDate(
            new Date(connection.lastUpdated).toISOString(),
          )}, the last answer that came back. It keeps trying by itself; until it succeeds nothing here is proof of what the clinic holds now.`
        : 'Nothing on this screen has been confirmed by the clinic yet.',
      routes: [],
      whoSettles: 'It retries by itself. Check the clinic Wi-Fi if it stays.',
    },
    {
      id: 'observation-overdue',
      label: overdueChecks.length === 1 ? 'Observation check overdue' : 'Observation checks overdue',
      count: overdueChecks.length,
      tone: 'stop',
      icon: 'clock',
      detail: `${overdueChecks
        .map((bed) => `${bed.label}${bed.patientName ? ` · ${bed.patientName}` : ''}`)
        .join(', ')}. The next check was due and has not been recorded.`,
      routes: ['beds'],
      whoSettles: 'A nurse on the bed board.',
    },
    {
      id: 'handoff',
      label: 'Doctor handoff requested',
      count: handoffs.length,
      tone: 'stop',
      icon: 'bed',
      detail: `${handoffs
        .map((bed) => `${bed.label}${bed.patientName ? ` · ${bed.patientName}` : ''}`)
        .join(', ')}. A nurse has asked for the doctor and nobody has acknowledged it.`,
      routes: ['beds'],
      whoSettles: 'The doctor, on the bed board.',
    },
    {
      id: 'rx-needs-doctor',
      label: doctorRx.length === 1 ? 'Prescription only a doctor can settle' : 'Prescriptions only a doctor can settle',
      count: doctorRx.length,
      tone: 'stop',
      icon: 'draft',
      detail:
        'A signed line carries no readable medicine or no recorded quantity. The counter cannot supply it and nobody but the doctor who is responsible may say what it authorised.',
      routes: ['review', 'counter'],
      whoSettles: 'A doctor, on the review queue.',
    },
    {
      id: 'stock-expired',
      label: expiredBatches.length === 1 ? 'Expired batch still on the shelf' : 'Expired batches still on the shelf',
      count: expiredBatches.length,
      tone: 'stop',
      icon: 'alert',
      detail: `${expiredBatches.reduce(
        (sum, batch) => sum + batch.availableQuantity,
        0,
      )} units past their expiry date. Nothing expired can be picked, so this is stock waiting to be returned or written off.`,
      routes: ['expiring', 'inventory'],
      whoSettles: 'The pharmacist, on Expiring.',
    },
    {
      id: 'rx-expired',
      label: expiredRx.length === 1 ? 'Prescription past its valid until' : 'Prescriptions past their valid until',
      count: expiredRx.length,
      tone: 'stop',
      icon: 'prescription',
      detail:
        'The remainder can no longer be supplied against the signed order. Only a new or amended prescription from the doctor can release it.',
      routes: ['counter', 'records'],
      whoSettles: 'The doctor writes a new order; the counter supplies it.',
    },
    {
      id: 'waiting',
      label: waitingNow.length === 1 ? 'Person waiting' : 'People waiting',
      count: waitingNow.length,
      tone: 'attn',
      icon: 'queue',
      detail: longestWait
        ? `Longest wait ${waitWords(longestWait.minutes)} — ${longestWait.item.patientName}, token ${longestWait.item.token}.`
        : 'Checked in and not yet called.',
      routes: ['queue', 'due', 'patients'],
      whoSettles: 'The doctor calls them in from today’s queue.',
    },
    {
      id: 'in-consult',
      label: inConsult.length === 1 ? 'Consultation unfinished' : 'Consultations unfinished',
      count: inConsult.length,
      tone: 'attn',
      icon: 'stethoscope',
      detail: `${inConsult
        .map((item) => `${item.patientName} (${item.token})`)
        .join(', ')}. Called in and not yet completed, so no fee has reached the counter.`,
      routes: ['consultation', 'queue', 'records'],
      whoSettles: 'The doctor, in Consult.',
    },
    {
      id: 'beds-occupied',
      label: 'Beds occupied',
      count: occupied.length,
      tone: 'attn',
      icon: 'bed',
      detail: `${occupied.length} of ${data.beds.length} observation beds in use${
        occupied.length > 0
          ? ` — ${occupied.map((bed) => bed.patientName ?? bed.label).join(', ')}`
          : ''
      }.`,
      routes: ['beds'],
      whoSettles: 'A nurse, on the bed board.',
    },
    {
      id: 'rx-waiting',
      label: liveRx.length === 1 ? 'Prescription waiting at the counter' : 'Prescriptions waiting at the counter',
      count: liveRx.length,
      tone: 'attn',
      icon: 'counter',
      detail: `${liveRx.reduce(
        (sum, rx) =>
          sum + rx.items.filter((item) => lineOwed(item) && lineRemaining(item) > 0).length,
        0,
      )} lines still to hand over, inside their valid until.`,
      routes: ['counter', 'billing'],
      whoSettles: 'The pharmacist hands medicine over; nobody else may.',
    },
    {
      id: 'stock-blocked',
      label: blockedBatches.length === 1 ? 'Batch blocked or quarantined' : 'Batches blocked or quarantined',
      count: blockedBatches.length,
      tone: 'attn',
      icon: 'lock',
      detail:
        'Recalled, quarantined or held back. The quantity is on the shelf and cannot be picked, so a stock figure that ignored it would be a surprise at the counter.',
      routes: ['expiring', 'inventory'],
      whoSettles: 'The pharmacist, on Expiring.',
    },
    {
      id: 'stock-expiring',
      label: 'Batches expiring within 60 days',
      count: expiringSoon.length,
      tone: 'attn',
      icon: 'clock',
      detail:
        'Still saleable today. Returned to the supplier while there is time, or it becomes the row above.',
      routes: ['expiring', 'inventory'],
      whoSettles: 'The pharmacist, on Expiring.',
    },
    {
      id: 'stock-low',
      label: 'Medicines at or below reorder level',
      count: low.length,
      tone: 'attn',
      icon: 'boxes',
      detail: `${low
        .slice(0, 4)
        .map((item) => `${item.name} ${item.strength} (${item.totalAvailable} left)`)
        .join(', ')}${low.length > 4 ? `, and ${low.length - 4} more` : ''}.`,
      routes: ['orders', 'inventory'],
      whoSettles: 'The pharmacist raises a purchase order.',
    },
    {
      id: 'bills-owing',
      label: owing.length === 1 ? 'Bill owing' : 'Bills owing',
      count: owing.length,
      tone: 'attn',
      icon: 'rupee',
      detail: `${money(outstanding)} still due${
        underReview.length > 0
          ? `, with the ${underReview.length === 1 ? 'bill' : `${underReview.length} bills`} under review kept out of that figure`
          : ''
      }.`,
      routes: ['billing', 'counter'],
      whoSettles: 'Admin or pharmacy at the counter.',
    },
    {
      id: 'patient-balances',
      label: balances.length === 1 ? 'Patient carrying a balance' : 'Patients carrying a balance',
      count: balances.length,
      tone: 'attn',
      icon: 'users',
      detail: `${money(owedByPatients)} against their names. There is no credit limit and no due date; a balance is settled whenever they next come in.`,
      routes: ['billing'],
      whoSettles: 'Admin or pharmacy at the counter.',
    },
    {
      id: 'follow-ups',
      label: overdueFollowUps.length === 1 ? 'Follow-up overdue' : 'Follow-ups overdue',
      count: overdueFollowUps.length,
      tone: 'attn',
      icon: 'history',
      detail: `${overdueFollowUps
        .slice(0, 4)
        .map((item) => `${item.patientName} (due ${item.dueDate})`)
        .join(', ')}${overdueFollowUps.length > 4 ? `, and ${overdueFollowUps.length - 4} more` : ''}.`,
      routes: ['records', 'patients'],
      whoSettles: 'The doctor who asked for the review.',
    },
  ]
  const exceptions = everyException.filter((exception) => exception.count > 0)

  /* What somebody owes a decision on, before what somebody should keep an eye
     on. Stable within each half, so the order does not dance between refreshes. */
  const ordered = [
    ...exceptions.filter((exception) => exception.tone === 'stop'),
    ...exceptions.filter((exception) => exception.tone === 'attn'),
  ]

  /*
   * The stations this session actually has. A pure administrator's rail carries
   * no Consult, no queue and no review queue — those belong to the clinical
   * roles — so an exception offers the first station on its list that this
   * person can reach, and says who settles it when that is nobody.
   */
  const reachable = new Map(navigationFor(data.session.roles).map((item) => [item.id, item]))
  const stationFor = (routes: View[]) => {
    for (const id of routes) {
      const station = reachable.get(id)
      if (station) return station
    }
    return undefined
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="The clinic today"
        title="Overview"
        sub={`${data.patients.length} patients on the register · ${data.appointments.length} appointments today`}
      />

      {/* The exceptions first, because this screen exists to answer "what is
          wrong in the clinic right now" and everything below is context for
          it. One list, ordered by what is owed a decision — not six panels of
          equal weight where the reader has to work out which one matters. */}
      <Card data-testid="admin-overview">
        <CardHeader
          title="What needs attention"
          sub={
            ordered.length === 0
              ? 'Nothing is waiting on anybody'
              : `${ordered.length} ${ordered.length === 1 ? 'exception' : 'exceptions'} · what is owed a decision first`
          }
        />
        {ordered.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nothing needs attention"
              direction="Nobody is waiting, every observation check is in date, no batch or prescription is blocked, and no bill is under financial review."
            />
          </CardBody>
        ) : (
          <div>
            {ordered.map((exception) => (
              <ExceptionRow
                key={exception.id}
                exception={exception}
                station={stationFor(exception.routes)}
                onOpen={goTo}
              />
            ))}
          </div>
        )}
      </Card>

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

      {data.session.roles.includes('doctor') && openFollowUps.length ? (
        <Card variant="record">
          <CardHeader title="Follow-up reminders" sub={`${openFollowUps.length} open`} />
          <CardBody className="space-y-2">
            {openFollowUps.map((followUp) => {
              const overdue = followUp.dueDate < today
              return (
                <div key={followUp.id} className="flex flex-wrap items-center gap-3 border-b border-rule pb-2 last:border-b-0">
                  <div className="min-w-[220px] flex-1">
                    <p className="font-semibold">{followUp.patientName}</p>
                    <p className={`text-[12px] ${overdue ? 'font-semibold text-stop' : 'text-ink-2'}`}>
                      {overdue ? 'Overdue' : 'Due'} {followUp.dueDate} · {followUp.note || 'Review'}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => { select(followUp.patientId); goTo('consultation') }}>Open patient</Button>
                  {/* Routine, and its own row's: the busy label names this
                      patient rather than every Mark completed on the screen. */}
                  {run ? (
                    <ActionButton
                      size="sm"
                      busy={followUpTask.busy && completing === followUp.id}
                      busyLabel={followUpTask.workingLabel}
                      onClick={() => {
                        if (followUpTask.busy) return
                        setCompleting(followUp.id)
                        void followUpTask.run({
                          working: `Completing ${followUp.patientName}’s follow-up…`,
                          request: () =>
                            run('complete_follow_up', {
                              followUpId: followUp.id,
                              status: 'completed',
                            }),
                          confirmed: () => ({
                            kind: 'confirmed',
                            title: 'Follow-up completed',
                            icon: 'history',
                            identity: followUp.patientName,
                            detail: `Due ${followUp.dueDate} · ${followUp.note || 'Review'}`,
                            dwell: DWELL_ROUTINE,
                          }),
                        })
                      }}
                    >
                      Mark completed
                    </ActionButton>
                  ) : null}
                </div>
              )
            })}
            <TaskFailure failure={followUpTask.failure} onDismiss={followUpTask.dismiss} />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4">
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

      </div>

      <AdminResult task={followUpTask} />
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
  const { patientId, select } = useSelectedPatient()
  const [messaging, setMessaging] = useState<PatientView | null>(null)
  /*
   * Two routine saves, each owning its own panel.
   *
   * Registering a patient and issuing a token are separate records and are
   * separately refused, so one shared `busy` would have greyed both forms for
   * either — and the plan's rule for admin is "Saved settings, staff changes
   * and routine corrections use a small two-second success result plus a
   * persistent updated value". The persistent value is the row on the register
   * below, which is where the evidence belongs.
   */
  const registerTask = useTask()
  const queueTask = useTask()

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
    const registered = { name: name.trim(), phone: phone.trim() }
    const result = await registerTask.run({
      working: `Registering ${registered.name || 'this patient'}…`,
      request: () =>
        run('create_patient', {
          name,
          age,
          sex: values.get('sex'),
          phone,
          address: values.get('address'),
          whatsappConsent: values.get('whatsappConsent') === 'on',
        }),
      confirmed: () => ({
        kind: 'confirmed',
        title: 'Patient registered',
        icon: 'user',
        identity: `${registered.name} · ${registered.phone}`,
        detail:
          'This tablet is now working on them. Give them a token beside this form, or go straight to Vitals or Consult.',
        dwell: DWELL_ROUTINE,
      }),
    })
    if (result?.ok) {
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
    const patient = data.patients.find((item) => item.id === patientId)
    const result = await queueTask.run({
      working: `Adding ${patient?.name ?? 'this patient'} to today’s queue…`,
      request: () =>
        run('create_appointment', {
          // The patient the clinic is working on, not a second choice from a
          // second dropdown. Selecting a duplicate candidate above lands here.
          patientId,
          reason: values.get('reason'),
          scheduledAt: values.get('scheduledAt'),
        }),
      // The server's own sentence, because it carries the token that was
      // issued — the one fact the desk is about to say out loud.
      confirmed: (answer) => ({
        kind: 'confirmed',
        title: 'Added to today’s queue',
        icon: 'queue',
        identity: patient?.name ?? 'Patient',
        detail: answer.message,
        dwell: DWELL_ROUTINE,
      }),
    })
    if (result?.ok) form.reset()
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
            <Busy on={registerTask.busy} label={registerTask.workingLabel}>
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

              <TaskFailure failure={registerTask.failure} onDismiss={registerTask.dismiss} />

              <ActionButton
                type="submit"
                variant="primary"
                busy={registerTask.busy}
                busyLabel={registerTask.workingLabel}
              >
                Save patient
              </ActionButton>
            </form>
            </Busy>
          </Disclosure>

          <Disclosure label="Add to today's queue" hint="Issues the next token in the queue">
            <Busy on={queueTask.busy} label={queueTask.workingLabel}>
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
              <TaskFailure failure={queueTask.failure} onDismiss={queueTask.dismiss} />

              <ActionButton
                type="submit"
                variant="primary"
                className="min-h-[56px]"
                busy={queueTask.busy}
                busyLabel={queueTask.workingLabel}
                disabled={patientId === ''}
                disabledReason="Choose the patient first."
              >
                Add to today&rsquo;s queue
              </ActionButton>
            </form>
            </Busy>
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

      <AdminResult task={registerTask} />
      <AdminResult task={queueTask} />
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
  const sendTask = useTask()
  const [body, setBody] = useState('')

  const blocked = !patient?.whatsappConsent
    ? 'This patient has not consented to WhatsApp messages.'
    : !connected
      ? connectionNote || 'WhatsApp is not connected yet, so nothing can be sent.'
      : undefined

  return (
    <>
      <Modal
        open={patient !== null}
        onClose={onClose}
        title="Patient WhatsApp"
        sub={patient ? `${patient.name} · ${patient.phone}` : undefined}
        // The dialog's own surface carries the wait. A message leaving the
        // clinic for a patient's phone cannot be un-sent, so the box stays up
        // and says what it is doing until Meta has actually answered.
        busy={sendTask.busy}
        busyLabel={sendTask.workingLabel}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={sendTask.busy}>
              Cancel
            </Button>
            <ActionButton
              variant="primary"
              busy={sendTask.busy}
              busyLabel={sendTask.workingLabel}
              disabled={Boolean(blocked) || body.trim() === ''}
              disabledReason={blocked ?? 'Write a message first.'}
              onClick={async () => {
                if (!patient) return
                const result = await sendTask.run({
                  working: `Sending to ${patient.name}…`,
                  request: () => run('send_patient_whatsapp', { patientId: patient.id, body }),
                  confirmed: () => ({
                    kind: 'confirmed',
                    title: 'Message sent',
                    icon: 'check-circle',
                    identity: `${patient.name} · ${patient.phone}`,
                    detail: body.trim(),
                    dwell: DWELL_ROUTINE,
                  }),
                })
                if (result?.ok) {
                  setBody('')
                  onClose()
                }
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
          {/* A refusal keeps the typed message. Nothing offers a blind retry:
              an unconfirmed send may already have reached the patient. */}
          <TaskFailure failure={sendTask.failure} onDismiss={sendTask.dismiss} />
        </div>
      </Modal>

      <AdminResult task={sendTask} />
    </>
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
        clock={clock}
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
  const saveTask = useTask()
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

  const chosen = data.patients.find((patient) => patient.id === patientId)

  return (
    <>
    <Modal
      key={key}
      open={bed !== null}
      onClose={onClose}
      title="Update bed"
      sub={bed?.label}
      busy={saveTask.busy}
      busyLabel={saveTask.workingLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saveTask.busy}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            busy={saveTask.busy}
            busyLabel={saveTask.workingLabel}
            disabled={status === 'occupied' && !patientId}
            disabledReason="Choose which patient is in this bed."
            onClick={async () => {
              if (!bed) return
              const result = await saveTask.run({
                working: `Saving ${bed.label}…`,
                request: () =>
                  run('update_bed', {
                    bedId: bed.id, status, patientId, notes, nextCheckAt,
                  }),
                confirmed: () => ({
                  kind: 'confirmed',
                  title: 'Bed updated',
                  icon: 'bed',
                  identity: `${bed.label} · ${words(status)}`,
                  detail:
                    status === 'occupied'
                      ? `${chosen?.name ?? 'Patient'} is in this bed${nextCheckAt ? `, next check ${formatDate(new Date(nextCheckAt).toISOString())}` : ''}.`
                      : 'Nobody is in this bed.',
                  dwell: DWELL_ROUTINE,
                }),
              })
              if (result?.ok) onClose()
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
        <TaskFailure failure={saveTask.failure} onDismiss={saveTask.dismiss} />
      </div>
    </Modal>

    <AdminResult task={saveTask} />
    </>
  )
}

/**
 * What just happened, said inside the window that asked for it.
 *
 * The result overlay is portalled to `<body>` and everything else in the
 * document is `inert` while a dialog is open, so an overlay raised by a dialog
 * that stays open would be unreachable behind it — which is the shape of the
 * bug this replaces, where the observation form closed itself and left its
 * answer in the shared notice bar behind where the reader was looking.
 *
 * So routine work done inside a window that must stay open answers here, with
 * no dwell: it is a persistent result and it stays until the next one replaces
 * it or the window closes. Consequential work — a discharge, a transfer, a
 * void, a refund — closes its window first and then gets the overlay.
 */
function DialogResult({ outcome }: { outcome: TaskOutcome | null }) {
  if (!outcome) return null
  return (
    <Notice tone={outcome.kind === 'partial' ? 'pending' : 'good'} icon={outcome.icon}>
      <span className="font-semibold">{outcome.title}</span>
      {outcome.identity ? <> · {outcome.identity}</> : null}
      {outcome.detail ? <span className="mt-0.5 block">{outcome.detail}</span> : null}
    </Notice>
  )
}

function ObservationForm({
  bed,
  data,
  clock,
  run,
  onClose,
}: {
  bed: BedView | null
  data: ClinicSnapshot
  /** The bed board's ticking clock, so the overdue figure here matches it. */
  clock: number
  run: ActionRunner
  onClose: () => void
}) {
  const canNurse = data.session.roles.some((role) => role === 'admin' || role === 'nurse')
  const canDoctor = data.session.roles.includes('doctor')
  /*
   * Four tasks, because these are four records and four refusals. One shared
   * state would have put "Saving observation…" on the Request doctor handoff
   * button, which is the confusion the shared lifecycle exists to end.
   */
  const noteTask = useTask()
  const handoffTask = useTask()
  const instructionTask = useTask()
  const closeTask = useTask()
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
    // The persistent results go with the bed they were about. Opening bed 3
    // must never begin by telling somebody what was recorded on bed 1.
    noteTask.dismiss()
    handoffTask.dismiss()
    instructionTask.dismiss()
    // `dismiss` is stable for the life of a task, so the bed is the whole
    // dependency. Adding them would only invite a reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bed])

  /*
   * The bed as the clinic has it now, not as it was when this window opened.
   *
   * `observing` is a view captured at the moment of the tap, so without this
   * the handoff badge and the overdue timer inside the window would be frozen
   * at whatever they said then — and a nurse saving an observation would watch
   * the next-check figure stay overdue after she had just moved it.
   */
  const live = bed ? (data.beds.find((row) => row.id === bed.id) ?? bed) : null
  const handoffOpen = Boolean(live?.handoffRequestedAt) && !live?.handoffResolvedAt

  const said = (title: string, detail: string): TaskOutcome => ({
    kind: 'confirmed',
    title,
    icon: 'bed',
    identity: `${live?.label ?? 'Bed'} · ${live?.patientName ?? 'No patient'}`,
    detail,
    // Persistent. This window stays open, so the result stays with it.
    dwell: 0,
  })

  return (
    <>
      <Modal
        open={bed !== null}
        onClose={onClose}
        title="Observation actions"
        sub={live ? `${live.label} · ${live.patientName ?? 'No patient'}` : undefined}
      >
        <div className="space-y-5">
          {/* The urgent state of this bed, inside the window rather than only
              behind it. Saving an observation no longer closes the window, so
              whoever is standing at the bed keeps the overdue figure and the
              outstanding handoff in front of them while they work. */}
          {live?.status === 'occupied' ? (
            <div className="space-y-2 border-l-2 border-ink pl-3">
              <ObservationTimer at={live.nextCheckAt} clock={clock} />
              {handoffOpen ? (
                <Badge tone="stop">Doctor handoff requested</Badge>
              ) : live.handoffResolvedAt ? (
                <Badge tone="free">Handoff acknowledged</Badge>
              ) : null}
              {live.doctorInstructions ? (
                <p className="text-[12px] leading-snug">
                  <span className="font-semibold">Doctor:</span> {live.doctorInstructions}
                </p>
              ) : null}
            </div>
          ) : null}

          {canNurse ? (
            <Busy
              on={noteTask.busy || handoffTask.busy}
              label={noteTask.busy ? noteTask.workingLabel : handoffTask.workingLabel}
            >
              <section className="space-y-3">
                <p className="eyebrow">Nursing observation</p>
                <Field label="Observation note"><Textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field>
                <Field label="Next check"><Input type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} /></Field>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    busy={noteTask.busy}
                    busyLabel={noteTask.workingLabel}
                    disabled={!note.trim() && !nextCheckAt}
                    disabledReason="Write an observation, or set the next check time."
                    onClick={async () => {
                      if (!bed) return
                      const written = note.trim()
                      const due = nextCheckAt
                      const result = await noteTask.run({
                        working: `Saving the observation for ${live?.label ?? 'this bed'}…`,
                        request: () => run('record_observation', { bedId: bed.id, note, nextCheckAt }),
                        confirmed: () =>
                          said(
                            'Observation recorded',
                            `${written || 'No note'}${
                              due
                                ? ` · next check ${formatDate(new Date(due).toISOString())}`
                                : ' · next check not scheduled'
                            }`,
                          ),
                      })
                      // The window stays open. The note is cleared because it
                      // is on the record now; the bed, the timer and the
                      // handoff stay in front of whoever is at the bedside.
                      if (result?.ok) setNote('')
                    }}
                  >
                    Save observation
                  </ActionButton>
                  <ActionButton
                    busy={handoffTask.busy}
                    busyLabel={handoffTask.workingLabel}
                    onClick={async () => {
                      if (!bed) return
                      const asked = note.trim()
                      await handoffTask.run({
                        working: `Asking the doctor to come to ${live?.label ?? 'this bed'}…`,
                        request: () => run('request_observation_handoff', { bedId: bed.id, note }),
                        confirmed: () =>
                          said(
                            'Doctor handoff requested',
                            asked
                              ? `${asked} — the request stays on the bed board until a doctor acknowledges it.`
                              : 'The request stays on the bed board until a doctor acknowledges it.',
                          ),
                      })
                    }}
                  >
                    Request doctor handoff
                  </ActionButton>
                </div>
                <TaskFailure failure={noteTask.failure} onDismiss={noteTask.dismiss} />
                <TaskFailure failure={handoffTask.failure} onDismiss={handoffTask.dismiss} />
                <DialogResult outcome={noteTask.outcome} />
                <DialogResult outcome={handoffTask.outcome} />
              </section>
            </Busy>
          ) : null}

          {canDoctor ? (
            <Busy on={instructionTask.busy} label={instructionTask.workingLabel}>
              <section className="space-y-3 border-t border-rule pt-4">
                <p className="eyebrow">Doctor instruction</p>
                <Field label="Instruction"><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} /></Field>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    busy={instructionTask.busy}
                    busyLabel={instructionTask.workingLabel}
                    disabled={!instructions.trim()}
                    disabledReason="Write the instruction first."
                    onClick={async () => {
                      if (!bed) return
                      const written = instructions.trim()
                      await instructionTask.run({
                        working: `Saving the instruction for ${live?.label ?? 'this bed'}…`,
                        request: () =>
                          run('set_observation_instructions', { bedId: bed.id, instructions }),
                        confirmed: () => said('Instruction saved', written),
                      })
                    }}
                  >
                    Save instruction
                  </ActionButton>
                  {handoffOpen ? (
                    <ActionButton
                      variant="primary"
                      busy={instructionTask.busy}
                      busyLabel={instructionTask.workingLabel}
                      onClick={async () => {
                        if (!bed) return
                        const written = instructions.trim()
                        await instructionTask.run({
                          working: `Acknowledging the handoff on ${live?.label ?? 'this bed'}…`,
                          request: () =>
                            run('resolve_observation_handoff', { bedId: bed.id, note: instructions }),
                          confirmed: () =>
                            said(
                              'Handoff acknowledged',
                              written || 'The nurse sees that a doctor has taken this on.',
                            ),
                        })
                      }}
                    >
                      Acknowledge handoff
                    </ActionButton>
                  ) : null}
                </div>
                <TaskFailure failure={instructionTask.failure} onDismiss={instructionTask.dismiss} />
                <DialogResult outcome={instructionTask.outcome} />
              </section>
            </Busy>
          ) : null}

          {canNurse ? (
            <section className="space-y-3 border-t border-rule pt-4">
              <p className="eyebrow">Close observation</p>
              <FieldRow>
                <Field label="Outcome"><Select value={outcome} onChange={(event) => setOutcome(event.target.value as 'discharged' | 'transferred')}><option value="discharged">Discharged</option><option value="transferred">Transferred</option></Select></Field>
                <Field label="Outcome note" required><Input value={closureNote} onChange={(event) => setClosureNote(event.target.value)} /></Field>
              </FieldRow>
              {/* Consequential: the bed empties and the patient leaves the
                  clinic's care, so this one reviews first, blocks its own
                  dialog while it commits, and answers on the overlay once this
                  window has closed. */}
              <ConfirmButton
                variant="danger"
                confirmVariant="danger"
                busy={closeTask.busy}
                busyLabel={closeTask.workingLabel}
                disabled={!closureNote.trim()}
                disabledReason="Say what happened to the patient first."
                title={outcome === 'discharged' ? 'Discharge patient?' : 'Record transfer?'}
                question={`${outcome === 'discharged' ? 'Discharge' : 'Transfer'} ${live?.patientName ?? 'this patient'} and mark ${live?.label ?? 'this bed'} for cleaning? The observation history is kept.`}
                confirmLabel={outcome === 'discharged' ? 'Confirm discharge' : 'Confirm transfer'}
                onConfirm={async () => {
                  if (!bed) return
                  const patientName = live?.patientName ?? 'The patient'
                  const label = live?.label ?? 'This bed'
                  const why = closureNote.trim()
                  const result = await closeTask.run({
                    working: `${outcome === 'discharged' ? 'Discharging' : 'Transferring'} ${patientName}…`,
                    request: () =>
                      run('close_observation', {
                        bedId: bed.id, outcome, note: closureNote, confirmed: true,
                      }),
                    confirmed: () => ({
                      kind: 'confirmed',
                      title: outcome === 'discharged' ? 'Patient discharged' : 'Transfer recorded',
                      icon: 'bed',
                      identity: `${patientName} · ${label}`,
                      detail: `${why} — ${label} is now for cleaning. The observation history is kept.`,
                      dwell: DWELL_MAJOR,
                    }),
                  })
                  if (result?.ok) onClose()
                }}
              >
                {outcome === 'discharged' ? 'Discharge patient' : 'Record transfer'}
              </ConfirmButton>
              <TaskFailure failure={closeTask.failure} onDismiss={closeTask.dismiss} />
            </section>
          ) : null}
        </div>
      </Modal>

      <AdminResult task={closeTask} />
    </>
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
  busyLabel = 'Recording…',
  failure,
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
  /**
   * The present-tense operation, shown on the dialog's own surface while it is
   * in flight. Optional and additive: every existing call site keeps working
   * and gets the generic word.
   */
  busyLabel?: string
  /**
   * A refusal, rendered inside this dialog rather than behind it.
   *
   * While a window is open every other child of `<body>` is `inert`, so a
   * refusal shown out on the workspace is one the person who caused it cannot
   * read or reach. Optional and additive; a call site that passes nothing keeps
   * the shared notice bar it had.
   */
  failure?: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  disabledReason?: string
  onConfirm: (reason: string) => Promise<CommandResponse | void>
}) {
  const busy = useBusy()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  /*
   * This dialog's own view of the request, kept apart from the clinic-wide
   * `busy`. The window stays up and says what it is doing until the clinic has
   * answered, rather than closing and putting the loading state on a trigger
   * behind where the reader is looking — which is what voiding a bill used to
   * do. A refusal keeps the window AND the typed reason, so the next attempt is
   * a correction rather than a retype.
   */
  const [committing, setCommitting] = useState(false)

  async function commit() {
    if (committing) return
    setCommitting(true)
    try {
      const result = await onConfirm(reason.trim())
      if (!result || result.ok) {
        setOpen(false)
        setReason('')
      }
    } finally {
      setCommitting(false)
    }
  }

  return (
    <>
      <ActionButton
        variant={variant}
        size={size}
        busy={busy || committing}
        busyLabel={busyLabel}
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
        busy={committing}
        busyLabel={busyLabel}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={committing}>
              Cancel
            </Button>
            <ActionButton
              variant={variant === 'danger' ? 'danger' : 'primary'}
              busy={committing}
              busyLabel={busyLabel}
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
              disabled={busy || committing}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {failure}
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
  /*
   * Reversing a receipt is money, and money is consequential: a review step
   * that collects the reason, a loading state on the dialog's own surface, and
   * a result that names the receipt, the amount and the bill it was against.
   * The task lives here rather than at the call site because the only screen
   * that passes `canReverse` is Billing, and a reversal offered anywhere else
   * should behave identically the day it is.
   */
  const reverseTask = useTask()

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
                      busyLabel={`Reversing ${payment.receiptNumber}…`}
                      failure={<TaskFailure failure={reverseTask.failure} />}
                      question={
                        <>
                          Reverse receipt{' '}
                          <span className="font-mono font-semibold">{payment.receiptNumber}</span>{' '}
                          for {money(payment.amount)}? It keeps its number and stays on the record
                          as reversed, and it stops counting towards what has been paid.
                        </>
                      }
                      /* A null answer means the task refused a second press or
                         the request threw. Nothing is confirmed either way, so
                         this stays `ok: false` and the window stays open with
                         the typed reason and the failure inside it. */
                      onConfirm={async (reason) =>
                        (await reverseTask.run({
                          working: `Reversing ${payment.receiptNumber}…`,
                          request: () => run('reverse_payment', { paymentId: payment.id, reason }),
                          confirmed: () => ({
                            kind: 'confirmed',
                            title: 'Receipt reversed',
                            icon: 'receipt',
                            identity: `${payment.receiptNumber} · ${invoice.invoiceNumber}`,
                            detail: `${money(payment.amount)} ${
                              payment.kind === 'refund'
                                ? 'that went back out'
                                : 'that never arrived'
                            } no longer counts against ${invoice.patientName ?? 'this counter sale'}. The receipt keeps its number and stays on the record as reversed.`,
                            facts: [{ label: 'Reason', value: reason }],
                            dwell: DWELL_MAJOR,
                          }),
                        })) ?? { ok: false, message: 'Not confirmed.' }
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

      <AdminResult task={reverseTask} />
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
  /* Voiding is consequential and it is the administrator's alone, so it gets
     the whole treatment: a review that collects the reason, a loading state on
     that review's own surface, and a result naming the bill and the patient. */
  const voidTask = useTask()

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
                {/* Policy register item 50 fixes these words and `counter.ts`
                    refuses in them. The same sentence on every screen is the
                    point of it, so the bill's own card leads with it. */}
                <span className="font-semibold">
                  Over-refunded — financial correction required.
                </span>{' '}
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
                {/* Policy register item 61, in the words `counter.ts` refuses a
                    counter in — and which of the two depends on the direction
                    the money went, because they are different errors. */}
                <span className="font-semibold">
                  {open.paid > 0
                    ? 'Voided with money against it — financial correction required.'
                    : 'Voided while over-refunded — financial correction required.'}
                </span>{' '}
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
                  busyLabel={`Voiding ${open.invoiceNumber}…`}
                  failure={<TaskFailure failure={voidTask.failure} />}
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
                  onConfirm={async (reason) =>
                    (await voidTask.run({
                      working: `Voiding ${open.invoiceNumber}…`,
                      request: () => run('void_invoice', { invoiceId: open.id, reason }),
                      confirmed: () => ({
                        kind: 'confirmed',
                        title: 'Bill voided',
                        icon: 'receipt',
                        identity: `${open.invoiceNumber} · ${open.patientName ?? 'Counter sale — no patient'}`,
                        detail: `${money(open.total)} is no longer charged to anybody. The bill keeps its number and its lines and stays on the record as void.`,
                        facts: [{ label: 'Reason', value: reason }],
                        dwell: DWELL_MAJOR,
                      }),
                      // Null means nothing was confirmed — a second press
                      // refused, or a request that threw. The window stays.
                    })) ?? { ok: false, message: 'Not confirmed.' }
                  }
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

      <AdminResult task={voidTask} />
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
  /* Real money leaving the drawer: the dialog reviews, blocks its own surface
     while the clinic decides, and answers with the bill, the patient and the
     amount once it has. A refusal never auto-dismisses and never offers a
     blind retry — see `refundKey` below for why that matters here above all. */
  const refundTask = useTask()
  const [open, setOpen] = useState(false)
  const [parts, setParts] = useState<PartDraft[]>([blankPart()])
  const [reason, setReason] = useState('')

  /**
   * One key per refund being attempted, held across a failure.
   *
   * It used to be `crypto.randomUUID()` written inline in the payload, which
   * means a brand-new key on every press — the exact shape that makes an
   * idempotency key useless. Refund ₹300, lose the reply on the clinic Wi-Fi,
   * press again because the screen still shows the form, and the server sees a
   * key it has never met and refunds ₹300 a second time. Real money, gone,
   * twice, against a bill that can now only be put right by an accountant
   * under policy item 56 — which is a workflow nobody has built yet.
   *
   * So the key belongs to the attempt and not to the press. It is minted once,
   * survives every refusal, and is replaced only after the clinic has confirmed
   * a refund actually happened. The counter's hand-over has always worked this
   * way (`keyFor` in `checkout-workspace.tsx`); this is the same discipline on
   * the one command where getting it wrong costs the patient money.
   */
  const [refundKey, setRefundKey] = useState(() => crypto.randomUUID())

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
    const going = typed ?? 0
    const why = reason.trim()
    const methods = entered.map((part) => METHOD_LABEL[part.method]).join(' + ')
    const result = await refundTask.run({
      working: `Refunding ${fromPaise(going)} on ${invoice.invoiceNumber}…`,
      request: () =>
        run('refund_payment', {
          invoiceId: invoice.id,
          idempotencyKey: refundKey,
          reason: why,
          refund: entered,
        }),
      confirmed: () => ({
        kind: 'confirmed',
        title: 'Refund recorded',
        icon: 'rupee',
        identity: `${invoice.patientName ?? 'Counter sale — no patient'} · ${invoice.invoiceNumber}`,
        detail: `${fromPaise(going)} went back out${methods ? ` by ${methods}` : ''}. The payment it answers keeps its number and its amount.`,
        facts: [{ label: 'Reason', value: why }],
        dwell: DWELL_MAJOR,
      }),
    })
    if (result?.ok) {
      setOpen(false)
      setParts([blankPart()])
      setReason('')
      // Only now. A refused or unanswered attempt keeps the key, so pressing
      // again asks the clinic about the same refund rather than a second one.
      setRefundKey(crypto.randomUUID())
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
        busy={refundTask.busy}
        busyLabel={refundTask.workingLabel}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={refundTask.busy}>
              Cancel
            </Button>
            <ActionButton
              variant="danger"
              busy={refundTask.busy}
              busyLabel={refundTask.workingLabel}
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
          {/* Inside the window, because the window stays open on a refusal and
              everything outside it is inert. No Try again: this command moves
              real money, and an unconfirmed one may already have moved it. The
              same `refundKey` is still held, so pressing Record the refund
              again asks the clinic about THIS refund rather than a second. */}
          <TaskFailure failure={refundTask.failure} />
        </div>
      </Modal>

      <AdminResult task={refundTask} />
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
  /* A routine save: the panel it changes is covered while it saves, a short
     result names what the clinic now prints, and the persistent value is the
     "Last changed" line in the header, which the snapshot moves by itself. */
  const saveTask = useTask()
  const s = data.settings

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const named = String(values.get('name') ?? s.name)
    const fee = Number(values.get('consultationFee') ?? 0)
    await saveTask.run({
      working: 'Saving the clinic details…',
      request: () =>
        run('update_clinic_settings', {
          name: values.get('name'),
          address: values.get('address'),
          phone: values.get('phone'),
          email: values.get('email'),
          drugLicenceNumber: values.get('drugLicenceNumber'),
          doctorRegistrationNumber: values.get('doctorRegistrationNumber'),
          gstin: values.get('gstin'),
          consultationFee: fee,
          footerNote: values.get('footerNote'),
        }),
      confirmed: () => ({
        kind: 'confirmed',
        title: 'Clinic details saved',
        icon: 'settings',
        identity: named,
        detail: `Every bill and prescription printed from now on carries these. Consultation fee ${money(fee)}.`,
        dwell: DWELL_ROUTINE,
      }),
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
          <Busy on={saveTask.busy} label={saveTask.workingLabel}>
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

            <TaskFailure failure={saveTask.failure} onDismiss={saveTask.dismiss} />

            <ActionButton
              type="submit"
              variant="primary"
              busy={saveTask.busy}
              busyLabel={saveTask.workingLabel}
            >
              Save clinic details
            </ActionButton>
          </form>
          </Busy>
        </CardBody>
      </Card>

      <AdminResult task={saveTask} />
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

      {/* A search, so it loads inline and announces itself. No result overlay:
          reading a register is not a thing that happened to the clinic, and a
          popup congratulating somebody on a query is noise on a screen an
          inspector is standing in front of. */}
      {loading ? (
        <Card data-print="hide">
          <CardHeader title="Schedule H1 register" sub={`${from} to ${to}`} />
          <CardBody>
            <p role="status" aria-live="polite" className="text-[13px] text-ink-2">
              Reading the register…
            </p>
            <div aria-hidden="true" className="mt-3 space-y-2">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="h-[36px] rounded-box bg-paper" />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {result && !loading ? (
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
