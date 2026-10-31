'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ClinicSnapshot,
  EscalationRow,
  Escalations,
  InvestigationOrderView,
  PatientContactMethod,
  ResultFlag,
  ResultRefusalCode,
  ResultView,
  ReviewConclusion,
  ReviewQueue,
} from '@/lib/types'
import {
  EXTERNAL_VALIDATION_CAVEAT,
  REFRESH_FIRST_REFUSALS,
  RESULT_READY_MESSAGE,
} from '@/lib/types'
import { callApi } from '@/lib/api'
import { recoveryCommitted, resultFollowUpOwed, resultIn } from '@/lib/result-decisions'
import {
  clearResultRecovery,
  readResultRecovery,
  writeResultRecovery,
  type RecoveryAction,
  type ResultRecovery,
} from '@/lib/result-recovery'
import { useBusy, type ActionResult, type ActionRunner } from './clinic-context'
import type { IconName } from '@/components/ui'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Drawer,
  EmptyState,
  Field,
  Icon,
  Notice,
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
  useTask,
} from '@/components/ui'

/**
 * The doctor's station for results that have come back.
 *
 * Backend programme Slice 4 built the whole diagnostics loop and no screen for
 * it, deliberately — `SLICE4_FRONTEND_CONTRACT.md` was written before this so
 * that the first screen could not quietly invent a rule. This is the bounded
 * cutover of the half that is unsafe to leave unbuilt: a report nobody has
 * read is a report nobody knows about, and until now the only way to read one
 * was psql.
 *
 * ── WHAT THIS SCREEN WILL NOT DO, AND WHY IT MATTERS ──────────────────────
 *
 * It does not order an investigation, manage the catalogue, take a report in,
 * or upload a document. Those belong to other people at other moments and
 * putting them here would make this the diagnostics module rather than the
 * doctor's review.
 *
 * It does not read the report and form an opinion. There is no parsing, no
 * reference range, no threshold, no summary. Owner item 85 allows a flag from
 * three places and an application is not one of them; `effective_flag` is a
 * generated column in the database and the only thing this file does with a
 * flag is print it.
 *
 * ── THE FOUR THINGS THAT MUST NOT COLLAPSE INTO EACH OTHER ────────────────
 *
 *   the laboratory signed it   evidence, retained, and NOT a clinic review
 *   a doctor reviewed it       owner item 86
 *   a doctor authorized a notice   owner item 88, a separate act
 *   the patient was told       authenticated provider evidence, or a call
 *
 * Every one of them is a different row in the database and a different line
 * on this screen. The whole value of the station is that the words on it are
 * true, so a green tick that means "we asked Meta" is worse than no screen.
 */

/* ───────────────────────────────────────────────────────── vocabulary ── */

const FLAG_WORD: Record<ResultFlag, string> = {
  none: 'No flag',
  abnormal: 'Abnormal',
  urgent: 'Urgent',
  critical: 'Critical',
}

/** Words and an icon. Never colour alone — the plan's rule and the clinic's. */
const FLAG_SKIN: Record<ResultFlag, { tone: 'plain' | 'attn' | 'stop'; icon: 'info' | 'alert' | 'alert-circle' }> = {
  none: { tone: 'plain', icon: 'info' },
  abnormal: { tone: 'attn', icon: 'alert' },
  urgent: { tone: 'attn', icon: 'alert' },
  critical: { tone: 'stop', icon: 'alert-circle' },
}

const CONCLUSION_WORD: Record<ReviewConclusion, string> = {
  no_action_needed: 'No action needed',
  patient_to_be_informed: 'Patient to be informed',
  clinical_action_taken: 'Clinical action taken',
}

/** What each conclusion actually records, said before it is chosen. */
const CONCLUSION_MEANS: Record<ReviewConclusion, string> = {
  no_action_needed:
    'You have read it and nothing further is needed. The line closes. The patient is not told anything by this.',
  patient_to_be_informed:
    'You have read it and the patient should hear. This does not tell them — authorizing the notice is a separate step below.',
  clinical_action_taken:
    'You have read it and already acted — a prescription, a referral, a call. The line closes.',
}

const BASIS_WORD = {
  responsible_doctor: 'as the responsible doctor',
  ordering_doctor: 'as the doctor who ordered it',
  delegated_doctor: 'as the delegated doctor',
} as const

const CONTACT_WORD: Record<PatientContactMethod, string> = {
  telephone: 'Telephone',
  in_person: 'In person',
  other: 'Other',
}

const SOURCE_WORD = {
  external_laboratory: 'External laboratory',
  external_facility: 'External facility',
  imported_structured_feed: 'Imported feed',
  clinic_recorded: 'Recorded at the clinic',
} as const

const ITEM_STATE_WORD = {
  ordered: 'Requested',
  in_progress: 'Sent out',
  overdue: 'Overdue',
  awaiting_review: 'Waiting for a doctor',
  reviewed: 'Reviewed',
  notification_pending: 'Notice not delivered yet',
  provider_outcome_unknown: 'Outcome unknown',
  notified: 'Patient notified',
  manually_contacted: 'Patient contacted',
  closed: 'Closed',
  cancelled: 'Cancelled',
} as const

/**
 * Why a notice did not reach the patient, in the clinic's words.
 *
 * Every one of these means the same thing about the patient — they were not
 * told — and a different thing about whose job it now is. None of them is a
 * failure of the doctor's authorization, which is why none of them is phrased
 * as one.
 */
const SUPPRESSION_WORD: Record<string, string> = {
  channel_not_configured:
    'The clinic has no WhatsApp connection configured, so nothing was sent. This is expected today. Telephone the patient, or leave it for the desk.',
  no_consent:
    'This patient has not agreed to result messages on WhatsApp, so nothing was sent. It is in the admin queue to be dealt with by hand.',
  consent_withdrawn:
    'This patient has withdrawn consent, so nothing was sent and nothing will be.',
  no_approved_template: 'No approved wording exists for this notice, so nothing was sent.',
  provider_template_not_approved:
    'The wording is approved by the clinic but not by the provider, so nothing was sent.',
  no_contact_number: 'No usable number is saved for this patient, so nothing was sent.',
  link_destination_unavailable: 'The notice could not be prepared, so nothing was sent.',
  variable_unavailable: 'The notice could not be prepared, so nothing was sent.',
  past_useful_by:
    'The moment passed before it could go, so nothing was sent. A telephone call is the honest answer now.',
  result_superseded:
    'The report was corrected after this was authorized, so nothing was sent. The corrected report needs its own review.',
  result_not_authorized:
    'The authorization behind this notice is no longer in force, so nothing was sent.',
}

/* ────────────────────────────────────── what is still owed on a result ── */

/* ──────────────────────────────────────────────── reading the clinic ── */

type QueueRead =
  | { state: 'loading' }
  | { state: 'ready'; queue: ReviewQueue; escalations: Escalations | null }
  | { state: 'failed'; message: string }

async function getJson<T>(path: string): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
  try {
    const response = await callApi(path)
    const body = (await response.json()) as T & { ok?: boolean; message?: string }
    if (body.ok === false) {
      return { ok: false, message: body.message ?? 'The clinic refused that read.' }
    }
    return { ok: true, body: body as T }
  } catch {
    return { ok: false, message: 'The clinic server is not reachable, so this could not be read.' }
  }
}

/* ══════════════════════════════════════════════════════ the station ══ */

export function ResultReviewSection({
  data,
  run,
}: {
  data: ClinicSnapshot
  run: ActionRunner
}) {
  const [read, setRead] = useState<QueueRead>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [escalationMiss, setEscalationMiss] = useState('')
  const [openOrderId, setOpenOrderId] = useState('')
  const [openResultId, setOpenResultId] = useState('')

  /*
   * The note this tablet left itself, read once when the station opens.
   *
   * A reviewed result has left the queue, so without this a lost reply
   * followed by a reload leaves a doctor with nothing to press and no way to
   * find out what happened. `readResultRecovery` refuses anybody else's note
   * and deletes it, so signing in as somebody else on a shared tablet shows
   * nothing.
   */
  const staffId = data.session.staffId
  const [recovery, setRecovery] = useState<ResultRecovery | null>(null)
  useEffect(() => {
    setRecovery(readResultRecovery(staffId))
  }, [staffId])

  const load = useCallback(async (quiet: boolean) => {
    if (quiet) setRefreshing(true)
    else setRead({ state: 'loading' })

    const queue = await getJson<{ queue: ReviewQueue }>('workspace?view=result_review_queue')
    if (!queue.ok) {
      setRead({ state: 'failed', message: queue.message })
      setRefreshing(false)
      return
    }
    /*
     * The escalation list is doctor-only and this station is on the doctor's
     * rail, so the ordinary answer is a list. A refusal is not a failure of
     * the screen — a session that may read the queue and not the escalations
     * still has work to do — so it is carried as null rather than losing both.
     */
    const escalations = await getJson<{ escalations: Escalations }>('workspace?view=result_escalations')
    setRead({
      state: 'ready',
      queue: queue.body.queue,
      escalations: escalations.ok ? escalations.body.escalations : null,
    })
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const openOne = useCallback((orderId: string, resultId: string) => {
    setOpenOrderId(orderId)
    setOpenResultId(resultId)
  }, [])

  const close = useCallback(() => {
    setOpenOrderId('')
    setOpenResultId('')
  }, [])

  /*
   * The note first, and outside the read's own states, because it is not
   * about the queue. A tablet that lost the network mid-review and came back
   * to a network still down would otherwise show "Try again" and no sign at
   * all that a write may have landed — which is the one thing the doctor
   * needs to know before doing anything else.
   */
  const drawer =
    openOrderId !== '' && openResultId !== '' ? (
      <ResultDrawer
        orderId={openOrderId}
        resultId={openResultId}
        staff={data.staff}
        staffId={staffId}
        run={run}
        canDelegate={data.session.canPublishClinicalTemplates}
        recovery={recovery}
        onRecovery={setRecovery}
        onClose={close}
        onChanged={() => void load(true)}
      />
    ) : null

  const followUpCard = recovery ? (
    <ContinueFollowUp
      recovery={recovery}
      onOpen={() => openOne(recovery.orderId, recovery.resultId)}
    />
  ) : null

  if (read.state === 'loading') {
    return (
      <>
        {followUpCard}
        <Card>
          <CardHeader title="Results to review" />
          <CardBody>
            <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[14px]">
              <Icon name="ring" size={20} className="jmc-spin text-ink-2" />
              Reading the results waiting for a doctor…
            </p>
          </CardBody>
        </Card>
        {drawer}
      </>
    )
  }

  if (read.state === 'failed') {
    return (
      <>
        {followUpCard}
      <Card>
        <CardHeader title="Results to review" />
        <CardBody className="space-y-3">
          <Notice tone="bad">{read.message}</Notice>
          <p className="text-[13px] leading-relaxed text-ink-2">
            Nothing has been lost. This is a read; trying it again cannot change anything in the
            clinic.
          </p>
          <Button variant="secondary" icon="ring" onClick={() => void load(false)}>
            Try again
          </Button>
        </CardBody>
      </Card>
        {drawer}
      </>
    )
  }

  const { queue, escalations } = read
  const clinical = queue.access === 'clinical'

  return (
    <>
      {followUpCard}

      <EscalationCard
        escalations={escalations}
        missed={escalationMiss}
        onOpen={(row) => openResultForEscalation(row)}
      />

      <Card>
        <CardHeader
          title="Results to review"
          sub={
            queue.rows.length === 0
              ? 'Nothing waiting'
              : `${queue.rows.length} ${queue.rows.length === 1 ? 'result' : 'results'} waiting`
          }
          action={
            <Button
              variant="ghost"
              size="sm"
              icon="ring"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          }
        />
        <CardBody className="space-y-2">
          <p className="text-[13px] leading-relaxed">
            {clinical
              ? 'Reports that have come back and nobody has clinically reviewed. Opening one shows the report exactly as the laboratory sent it.'
              : 'Reports that have come back and nobody has clinically reviewed. You are seeing what is outstanding and who owes it a look — not the reports themselves.'}
          </p>
          <p className="text-[13px] leading-relaxed text-ink-2">
            A result stays here until a doctor records a review. After{' '}
            {queue.escalationAfterClinicHours} clinic hours — or by{' '}
            {String(queue.escalationCeilingHour).padStart(2, '0')}:00 at the latest — it also
            reaches the owner-doctor.
          </p>
        </CardBody>

        {queue.rows.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No result is waiting on a doctor"
              direction="Every report that has come back has been read. A new one appears here as soon as it is filed."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Request</TH>
                <TH>Patient</TH>
                <TH>Investigation</TH>
                <TH>Came back</TH>
                <TH num>Waiting</TH>
                <TH>Responsible</TH>
                {clinical ? <TH>Flag</TH> : null}
                <TH>Open</TH>
              </TR>
            </THead>
            <TBody>
              {queue.rows.map((row) => (
                <TR
                  key={row.resultId}
                  active={row.resultId === openResultId}
                  onClick={() => openOne(row.orderId, row.resultId)}
                >
                  <TD>
                    <Token code={row.orderNumber} />
                  </TD>
                  <TD className="font-semibold">{row.patientName}</TD>
                  <TD>{row.itemName}</TD>
                  <TD className="text-[13px] text-ink-2">{row.receivedAt}</TD>
                  <TD num>{row.waitingHours.toFixed(1)} h</TD>
                  <TD className="text-[13px]">
                    {row.delegatedDoctor || row.responsibleDoctor}
                    {row.delegatedDoctor ? (
                      <span className="block text-[12px] text-ink-2">delegated</span>
                    ) : null}
                  </TD>
                  {clinical ? (
                    <TD>
                      <FlagBadge flag={row.flag ?? 'none'} />
                      {row.criticalUnacknowledged ? (
                        <span className="mt-1 block">
                          <Badge tone="stop">Not acknowledged</Badge>
                        </span>
                      ) : null}
                    </TD>
                  ) : null}
                  <TD>
                    {row.escalatedToOwnerDoctor ? (
                      <Badge tone="attn">Escalated</Badge>
                    ) : (
                      <span className="eyebrow">Open</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {drawer}
    </>
  )

  function openResultForEscalation(row: EscalationRow) {
    // The escalation read does not carry the order id — it is a list of
    // results, not of requests — so the queue is where the pair is found. A
    // row on one and not the other means the queue moved under us, and the
    // refresh is the honest answer rather than opening something stale.
    const match = queue.rows.find((candidate) => candidate.resultId === row.resultId)
    if (!match) {
      /*
       * The escalation read does not carry the order id, so this list can
       * only be opened through the queue — and they are two requests, so
       * they can disagree. Re-reading silently made the row look broken.
       */
      setEscalationMiss(row.resultId)
      void load(true)
      return
    }
    setEscalationMiss('')
    openOne(match.orderId, match.resultId)
  }
}

function FlagBadge({ flag }: { flag: ResultFlag }) {
  const skin = FLAG_SKIN[flag]
  // The icon goes to `Badge`, not into its children: left to itself it draws
  // the tone's default mark, and `attn`'s default is a clock. An abnormal
  // result is not a result that is waiting for something.
  return (
    <Badge tone={skin.tone} icon={skin.icon}>
      {FLAG_WORD[flag]}
    </Badge>
  )
}

/**
 * The way back to a result this tablet has not finished with.
 *
 * Deliberately the first thing on the station, above the queue and above the
 * escalations, because it is about work somebody has already started and may
 * believe is done. The two phases say different things and must not be worded
 * the same: one is "nobody knows whether that saved", the other is "that
 * saved, and the patient still has to be told".
 */
function ContinueFollowUp({
  recovery,
  onOpen,
}: {
  recovery: ResultRecovery
  onOpen: () => void
}) {
  const unknown = recovery.phase === 'outcome_unknown'
  return (
    <Card>
      <CardBody className="space-y-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon name={unknown ? 'question-circle' : 'clock'} size={20} />
          Continue result follow-up
        </h3>
        <p className="text-[13px] leading-relaxed">
          {unknown
            ? `The clinic did not answer when you were ${RECOVERY_WORD[recovery.action]} a result. It may have been recorded. Open it and the record will say.`
            : `A result you reviewed still has to be followed up — the patient has not been told, and it has left the queue because you have read it.`}
        </p>
        {/*
         * No patient name and no investigation here, deliberately. This note
         * survives in the tablet's own storage and carries opaque identifiers
         * only; the moment it named a patient it would be a clinical record
         * kept in the weakest place in the application.
         */}
        {/*
         * One action, and it is a read.
         *
         * There was a "Not now" here, and it called `clearResultRecovery`.
         * Pressing something labelled "later" destroyed the only pointer to a
         * write that may have committed, on a result that has already left
         * the queue — after which there is nothing in the application that
         * can find it again. A note goes when the record settles it, when
         * the session ends, or when it is twelve hours old. Not before.
         */}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onOpen}>
            Open the result
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

const RECOVERY_WORD: Record<RecoveryAction, string> = {
  acknowledge: 'acknowledging',
  flag: 'flagging',
  delegate: 'delegating',
  review: 'reviewing',
  authorize: 'authorizing a notice for',
  contact: 'recording contact about',
}

/* ─────────────────────────────────────────── owner item 87's two lists ── */

function EscalationCard({
  escalations,
  onOpen,
  missed,
}: {
  escalations: Escalations | null
  onOpen: (row: EscalationRow) => void
  /** A row whose result the queue read did not have; see `openResultForEscalation`. */
  missed: string
}) {
  if (!escalations || escalations.rows.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Needs a doctor now"
        sub={`${escalations.rows.length} escalated`}
      />
      <CardBody className="space-y-2">
        <p className="text-[13px] leading-relaxed">
          A critical result waits for a doctor to acknowledge it within{' '}
          {escalations.criticalAcknowledgementMinutes} minutes. Anything still unreviewed past the
          clinic-hours limit also reaches the owner-doctor here.
        </p>
        {/*
         * Owner item 87 names "any explicitly configured backup doctor" and
         * the clinic has configured none. Said out loud, because a screen
         * that stays silent about it reads as though somebody else is also
         * watching this list.
         */}
        {missed ? (
          <Notice tone="pending">
            That one is not in the review queue this tablet last read. It is being read again —
            if it stays here after that, it has been reviewed or corrected since.
          </Notice>
        ) : null}
        {escalations.backupDoctorConfigured ? null : (
          <p className="text-[13px] leading-relaxed text-ink-2">
            No backup doctor is configured, so nothing here is going to anybody else.
          </p>
        )}
      </CardBody>
      <Table>
        <THead>
          <TR>
            <TH>Request</TH>
            <TH>Patient</TH>
            <TH>Investigation</TH>
            <TH>Flag</TH>
            <TH>Why</TH>
            <TH>Open</TH>
          </TR>
        </THead>
        <TBody>
          {escalations.rows.map((row) => (
            <TR key={row.resultId} onClick={() => onOpen(row)}>
              <TD>
                <Token code={row.orderNumber} />
              </TD>
              <TD className="font-semibold">{row.patientName}</TD>
              <TD>{row.itemName}</TD>
              <TD>
                <FlagBadge flag={row.flag} />
              </TD>
              <TD className="text-[13px]">
                {row.reason === 'critical_unacknowledged'
                  ? 'Critical, not acknowledged'
                  : 'Unreviewed past the clinic-hours limit'}
                {row.manualEscalationOwed ? (
                  <span className="mt-1 block">
                    <Badge tone="stop">Somebody owes a telephone call</Badge>
                  </span>
                ) : null}
              </TD>
              <TD>
                <span className="eyebrow">Open</span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  )
}

/* ═════════════════════════════════════════════════ one result, opened ══ */

type OrderRead =
  | { state: 'loading' }
  | { state: 'ready'; order: InvestigationOrderView }
  | { state: 'failed'; message: string }

/**
 * An action whose answer never came back.
 *
 * Not a failure, and it must not be retried on the strength of a person
 * pressing again. The control stays closed until the authoritative order has
 * been read back and can say whether the write landed — `Check again` is that
 * read, and there is deliberately no button that repeats the write.
 */
type Unsettled = {
  what: string
  /**
   * Whether the freshly-read order proves the write landed.
   *
   * Each action knows its own evidence — a review row, an authorization
   * stamp, a recorded call — so the check is the action's rather than a
   * generic "did anything change". Without it `Check again` would clear the
   * warning by reloading and say nothing about what it found.
   */
  settled: (order: InvestigationOrderView, resultId: string) => boolean
} | null

function ResultDrawer({
  orderId,
  resultId,
  staff,
  staffId,
  run,
  recovery,
  onRecovery,
  onClose,
  onChanged,
  canDelegate,
}: {
  orderId: string
  resultId: string
  staff: ClinicSnapshot['staff']
  staffId: string
  run: ActionRunner
  canDelegate: boolean
  recovery: ResultRecovery | null
  onRecovery: (recovery: ResultRecovery | null) => void
  onClose: () => void
  onChanged: () => void
}) {
  const [read, setRead] = useState<OrderRead>({ state: 'loading' })
  const [unsettled, setUnsettled] = useState<Unsettled>(null)
  const [checking, setChecking] = useState(false)
  /**
   * The present-tense operation while a command is in flight, or ''.
   *
   * A label rather than a flag because the drawer's busy layer covers the
   * actions, and the plan's rule is that a working state names the exact
   * operation — "Recording the review…", not "Working…".
   */
  const [writing, setWriting] = useState('')
  /** What the last `Check again` established, in the clinic's words. */
  const [settledWord, setSettledWord] = useState<{ tone: 'good' | 'info'; text: string } | null>(null)

  const load = useCallback(async (): Promise<InvestigationOrderView | null> => {
    const answer = await getJson<{ order: InvestigationOrderView }>(
      `workspace?view=investigation_order&orderId=${encodeURIComponent(orderId)}`,
    )
    if (!answer.ok) {
      setRead({ state: 'failed', message: answer.message })
      return null
    }
    setRead({ state: 'ready', order: answer.body.order })
    return answer.body.order
  }, [orderId])

  /**
   * Settle the tablet's note against what the clinic actually holds.
   *
   * This is the whole recovery, and it is a READ: the note says an act was in
   * flight, the order says whether it landed, and nothing is written either
   * way. A note whose act committed is replaced by a follow-up note or
   * cleared; one whose act did not is cleared, because retrying is then safe
   * and a warning nobody needs is a warning people learn to ignore.
   *
   * A note about a result that is no longer on the order — a correction
   * arrived — is cleared with a word about why, because there is nothing to
   * continue: the corrected report is a different result and needs its own
   * review.
   */
  const settle = useCallback(
    (fresh: InvestigationOrderView): void => {
      if (!recovery || recovery.resultId !== resultId) return

      const committed = recoveryCommitted(fresh, resultId, recovery.action)
      if (committed === null) {
        setSettledWord({
          tone: 'info',
          text: 'That report has been corrected, so there is nothing left to finish on it. The corrected report needs its own review.',
        })
        clearResultRecovery()
        onRecovery(null)
        return
      }

      if (recovery.phase === 'outcome_unknown') {
        setSettledWord(
          committed
            ? { tone: 'good', text: 'That was recorded after all. The record below is what happened.' }
            : { tone: 'info', text: 'That was not recorded, so nothing happened. You can do it again.' },
        )
      }

      const result = resultIn(fresh, resultId)
      if (resultFollowUpOwed(result)) {
        // Recorded, and the patient still has to hear. The note changes its
        // meaning rather than going away.
        onRecovery(
          writeResultRecovery({
            staffId,
            orderId: fresh.orderId,
            resultId,
            action: 'contact',
            phase: 'follow_up',
            reference: recovery.reference,
          }),
        )
        return
      }

      clearResultRecovery()
      onRecovery(null)
    },
    [recovery, resultId, staffId, onRecovery],
  )

  useEffect(() => {
    void (async () => {
      const fresh = await load()
      // Only a successful read may settle anything. A read that failed leaves
      // the note exactly where it was, which is what fail-closed means here.
      if (fresh) settle(fresh)
    })()
    // `settle` is deliberately not a dependency: it changes identity whenever
    // the note does, and re-running this on that would re-read the order
    // every time the note is rewritten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const order = read.state === 'ready' ? read.order : null
  const item = order?.items.find((candidate) =>
    candidate.results.some((result) => result.resultId === resultId),
  )
  const result = item?.results.find((candidate) => candidate.resultId === resultId) ?? null
  /*
   * The current report for this line, which is not always the one that was
   * opened. A correction lands while somebody is reading, and the report on
   * screen becomes history — so the drawer says so and points at the new one
   * rather than leaving live controls on a superseded record.
   */
  const current = item?.results.find((candidate) => candidate.current) ?? null

  const title = order ? `${order.patientName} · ${item?.itemName ?? 'Result'}` : 'Result'

  return (
    <Drawer
      open
      onClose={onClose}
      // A backdrop click or Escape mid-write unmounted the actions, and with
      // them the "Outcome not confirmed" notice and its Check again. The
      // durable note survived, but the doctor was never shown the question.
      busy={writing !== ''}
      busyLabel={writing}
      width="lg"
      title={title}
      sub={order ? `${order.orderNumber} · ${order.responsibleDoctor}` : undefined}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {read.state === 'loading' ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[14px]">
          <Icon name="ring" size={20} className="jmc-spin text-ink-2" />
          Reading the request…
        </p>
      ) : read.state === 'failed' ? (
        <div className="space-y-3">
          <Notice tone="bad">{read.message}</Notice>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : !order || !result ? (
        <div className="space-y-3">
          <Notice tone="pending">
            This report is no longer on the request. It has most likely been corrected. Close this
            and open the request again.
          </Notice>
        </div>
      ) : (
        <div className="space-y-4">
          {unsettled ? (
            <Notice tone="unknown">
              <span className="block font-semibold">Outcome not confirmed</span>
              <span className="mt-0.5 block">
                The clinic did not answer when {unsettled.what}. It may have been recorded.
                Nothing will be sent again until the record says what happened.
              </span>
              <span className="mt-2 block">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true)
                    const fresh = await load()
                    setChecking(false)
                    /*
                     * Only the record clears this. Not time, not a dismissal,
                     * not the drawer closing — and there is deliberately no
                     * button here that repeats the write.
                     */
                    if (!fresh) return
                    /*
                     * Through the same settle the drawer uses on open, so
                     * that reading the record here and reading it after a
                     * reload cannot disagree — and so the durable note goes
                     * or becomes owed follow-up rather than staying unknown
                     * on a question that has just been answered.
                     */
                    if (recovery && recovery.resultId === resultId) {
                      settle(fresh)
                    } else {
                      // No note to settle: storage refused, or this is a
                      // different result. The answer is still worth saying.
                      setSettledWord(
                        unsettled.settled(fresh, resultId)
                          ? { tone: 'good', text: 'It was recorded after all. The record below is what happened.' }
                          : { tone: 'info', text: 'It was not recorded, so nothing happened. You can do it again.' },
                      )
                    }
                    setUnsettled(null)
                    onChanged()
                  }}
                >
                  {checking ? 'Checking…' : 'Check again'}
                </Button>
              </span>
            </Notice>
          ) : null}

          {settledWord ? (
            <Notice tone={settledWord.tone} onDismiss={() => setSettledWord(null)}>
              {settledWord.text}
            </Notice>
          ) : null}

          <OrderFacts order={order} />

          {!result.current ? (
            <SupersededNotice result={result} current={current} />
          ) : null}

          <ResultFacts order={order} result={result} />

          {order.access === 'clinical' && result.current && order.status === 'open' ? (
            <ResultActions
              order={order}
              result={result}
              staff={staff}
              staffId={staffId}
              run={run}
              reload={load}
              onChanged={onChanged}
              onUnsettled={setUnsettled}
              onRecovery={onRecovery}
              blocked={unsettled !== null}
              canDelegate={canDelegate}
              onWriting={setWriting}
            />
          ) : null}

          {order.access === 'operational' ? (
            <Notice tone="info">
              You are seeing what is outstanding and who owes it a review. Reading the report, and
              acting on it, is the doctor&rsquo;s.
            </Notice>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}

function SupersededNotice({
  result,
  current,
}: {
  result: ResultView
  current: ResultView | null
}) {
  return (
    <Notice tone="pending">
      <span className="block font-semibold">This report has been corrected</span>
      <span className="mt-0.5 block">
        It is kept as history and nothing can be recorded against it — not a review, not a flag,
        not a notice, not a call.{' '}
        {current
          ? `The corrected report came back on ${current.receivedAt} and is the one that needs reading. Close this and open it from the queue.`
          : 'Close this and open the request again to find the report that replaced it.'}
      </span>
      {result.correctedByResultId ? (
        <span className="mt-1 block text-[13px]">
          Anything authorized about this report stopped when the correction was filed.
        </span>
      ) : null}
    </Notice>
  )
}

function OrderFacts({ order }: { order: InvestigationOrderView }) {
  return (
    <section className="rounded-box border border-rule bg-paper px-3.5 py-3">
      <h3 className="text-[15px] font-semibold">{order.orderNumber}</h3>
      <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <Fact label="Patient" value={order.patientName} />
        <Fact label="Requested by" value={order.orderedBy} />
        <Fact label="Responsible doctor" value={order.responsibleDoctor} />
        {order.delegatedDoctor ? (
          <Fact
            label="Delegated to"
            value={`${order.delegatedDoctor}${order.delegationReason ? ` — ${order.delegationReason}` : ''}`}
          />
        ) : null}
        <Fact label="Requested" value={order.createdAt} />
        {order.priority === 'urgent' ? <Fact label="Priority" value="Urgent" /> : null}
        {order.externalFacility ? <Fact label="Sent to" value={order.externalFacility} /> : null}
        {order.clinicalIndication ? (
          <Fact label="Why it was requested" value={order.clinicalIndication} />
        ) : null}
        {order.status === 'cancelled' ? (
          <Fact label="Cancelled" value={order.cancelledReason} />
        ) : null}
      </dl>
      <p className="mt-2 text-[13px] text-ink-2">
        {order.items.map((line) => `${line.itemName} — ${ITEM_STATE_WORD[line.state]}`).join(' · ')}
      </p>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="min-w-[8.5rem] text-[13px] text-ink-2">{label}</dt>
      <dd className="flex-1 text-[14px]">{value}</dd>
    </div>
  )
}

/* ────────────────────────────────────── the report, exactly as it came ── */

function ResultFacts({
  order,
  result,
}: {
  order: InvestigationOrderView
  result: ResultView
}) {
  const clinical = order.access === 'clinical'

  return (
    <section className="space-y-3">
      <SectionHeader title="The report" />

      <dl className="grid gap-1.5 rounded-box border border-rule px-3.5 py-3 sm:grid-cols-2">
        <Fact label="Came back" value={result.receivedAt} />
        <Fact label="Source" value={SOURCE_WORD[result.source]} />
        {result.correctsResultId ? (
          <Fact label="This is a correction" value="It replaces an earlier report, which is kept." />
        ) : null}
      </dl>

      {clinical ? (
        <>
          {/*
           * Verbatim, in a pre-wrapped block, and nothing else touches it.
           * No parsing, no ranges, no summary — owner item 85 and the
           * schema's refusal to hold a structured value are the same rule
           * seen from two sides.
           */}
          <div>
            <h4 className="text-[13px] font-semibold text-ink-2">As the laboratory sent it</h4>
            <pre className="mt-1 max-h-72 overflow-auto rounded-box border border-rule bg-paper px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
              {result.reportText || 'The report came as a document. Open it below.'}
            </pre>
          </div>

          <FlagFacts result={result} />
        </>
      ) : null}

      <ValidationFacts result={result} />

      <ReviewFacts result={result} />

      <NotificationFacts result={result} />

      <Documents result={result} clinical={clinical} />
    </section>
  )
}

/**
 * Two flags, shown as two flags.
 *
 * Owner item 85 allows a transcribed flag and a doctor's own, and the schema
 * keeps them in separate column pairs precisely so that a doctor raising a
 * laboratory's `abnormal` to `critical` never erases what the laboratory
 * said. A screen that printed only the effective flag would undo that in the
 * one place it is read.
 */
function FlagFacts({ result }: { result: ResultView }) {
  const sourceFlag = result.sourceFlag ?? 'none'
  const doctorFlag = result.doctorFlag ?? 'none'

  return (
    <div className="rounded-box border border-rule px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-ink-2">Flags</h4>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="min-w-[8.5rem] text-[13px] text-ink-2">The report said</span>
          <FlagBadge flag={sourceFlag} />
          {result.sourceFlagReference ? (
            <span className="text-[13px] text-ink-2">
              {result.sourceFlagOrigin === 'imported_structured' ? 'from a feed' : 'written at'}{' '}
              {result.sourceFlagReference}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="min-w-[8.5rem] text-[13px] text-ink-2">A doctor said</span>
          <FlagBadge flag={doctorFlag} />
          {result.doctorFlagBy ? (
            <span className="text-[13px] text-ink-2">
              {result.doctorFlagBy}
              {result.doctorFlagReason ? ` — ${result.doctorFlagReason}` : ''}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-baseline gap-2 border-t border-rule pt-2">
          <span className="min-w-[8.5rem] text-[13px] font-semibold">Taken as</span>
          <FlagBadge flag={result.flag ?? 'none'} />
          <span className="text-[13px] text-ink-2">the more serious of the two</span>
        </div>
      </div>
    </div>
  )
}

function ValidationFacts({ result }: { result: ResultView }) {
  return (
    <div className="rounded-box border border-rule px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-ink-2">Laboratory sign-off</h4>
      {result.externalValidatedBy || result.externalSignatoryReference ? (
        <dl className="mt-1.5 grid gap-1.5">
          {result.externalValidatedBy ? (
            <Fact label="Validated by" value={result.externalValidatedBy} />
          ) : null}
          {result.externalSignatoryReference ? (
            <Fact label="Signature" value={result.externalSignatoryReference} />
          ) : null}
        </dl>
      ) : (
        <p className="mt-1 text-[13px] text-ink-2">The report carries none.</p>
      )}
      {/*
       * Always shown, present or absent, because the sentence is about what
       * the field MEANS rather than about what it holds. Owner item 86.
       */}
      <p className="mt-2 flex items-start gap-2 text-[13px] font-semibold">
        <Icon name="info" size={17} className="mt-px shrink-0" />
        {EXTERNAL_VALIDATION_CAVEAT}
      </p>
    </div>
  )
}

function ReviewFacts({ result }: { result: ResultView }) {
  return (
    <div className="rounded-box border border-rule px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-ink-2">Clinic doctor&rsquo;s review</h4>
      {result.review ? (
        <p className="mt-1 text-[14px]">
          <Icon name="check-circle" size={17} className="mr-1.5 inline text-free" />
          {result.review.reviewedBy} reviewed this {BASIS_WORD[result.review.basis]} on{' '}
          {result.review.reviewedAt}
          {result.review.conclusion ? ` — ${CONCLUSION_WORD[result.review.conclusion]}` : ''}.
          {result.review.note ? (
            <span className="mt-1 block text-[13px] text-ink-2">{result.review.note}</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-ink-2">Nobody has reviewed this yet.</p>
      )}

      {result.criticalAcknowledgedAt ? (
        <p className="mt-2 text-[13px]">
          <Icon name="alert-circle" size={16} className="mr-1.5 inline text-attn" />
          Acknowledged as critical by {result.criticalAcknowledgedBy} on{' '}
          {result.criticalAcknowledgedAt}.{' '}
          <span className="text-ink-2">Acknowledging is not reviewing.</span>
        </p>
      ) : null}
    </div>
  )
}

/**
 * What the patient was told, which is the outbox's answer and never a guess.
 *
 * Owner item 88 makes authorization, provider acceptance, delivery and a
 * telephone call four separate facts, and this box shows whichever of them
 * are true. The one sentence it will not print unless the record says
 * `delivered` is that the patient was notified.
 */
function NotificationFacts({ result }: { result: ResultView }) {
  const notification = result.notification
  const delivered = notification?.providerSaidDelivered === true

  return (
    <div className="rounded-box border border-rule px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-ink-2">Telling the patient</h4>

      {result.notificationAuthorizedAt ? (
        <p className="mt-1 text-[14px]">
          {result.notificationAuthorizedBy} authorized the notice on{' '}
          {result.notificationAuthorizedAt}.
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-ink-2">No notice has been authorized.</p>
      )}

      {notification ? (
        delivered ? (
          <p className="mt-1.5 flex items-start gap-2 text-[14px] text-free">
            <Icon name="check-circle" size={17} className="mt-px shrink-0" />
            The provider confirmed the message was delivered.
          </p>
        ) : notification.state === 'outcome_unknown' ? (
          <p className="mt-1.5 flex items-start gap-2 text-[14px] text-attn">
            <Icon name="question-circle" size={17} className="mt-px shrink-0" />
            The message went out and the reply was lost, so nobody knows whether it arrived. The
            clinic will not send it again on a guess — telephone the patient if it matters.
          </p>
        ) : notification.suppressionReason ? (
          <p className="mt-1.5 flex items-start gap-2 text-[14px] text-attn">
            <Icon name="clock" size={17} className="mt-px shrink-0" />
            {SUPPRESSION_WORD[notification.suppressionReason] ??
              'Nothing was sent, and the admin queue has it.'}
          </p>
        ) : (
          <p className="mt-1.5 flex items-start gap-2 text-[14px] text-attn">
            <Icon name="clock" size={17} className="mt-px shrink-0" />
            {notification.state === 'sent_to_provider'
              ? 'The provider has accepted the message. That is not delivery — the patient has not been confirmed as told.'
              : 'The notice is waiting to go. The patient has not been told yet.'}
          </p>
        )
      ) : null}

      {result.patientContactedAt ? (
        <p className="mt-2 text-[14px]">
          <Icon name="check-circle" size={17} className="mr-1.5 inline text-free" />
          {result.patientContactedBy} contacted the patient on {result.patientContactedAt}
          {result.patientContactMethod
            ? ` — ${CONTACT_WORD[result.patientContactMethod].toLowerCase()}`
            : ''}
          .
        </p>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────── documents ── */

function Documents({ result, clinical }: { result: ResultView; clinical: boolean }) {
  const [openId, setOpenId] = useState('')

  if (result.documents.length === 0) return null

  return (
    <div className="rounded-box border border-rule px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-ink-2">Attached reports</h4>
      <ul className="mt-1.5 space-y-2">
        {result.documents.map((document) => (
          <li key={document.documentId} className="flex flex-wrap items-center gap-2">
            <Icon name="clipboard" size={17} className="text-ink-2" />
            <span className="text-[14px]">
              {document.contentType === 'application/pdf' ? 'PDF' : 'Image'} ·{' '}
              {Math.max(1, Math.round(document.byteSize / 1024))} KB
            </span>
            <span className="text-[13px] text-ink-2">
              filed by {document.uploadedBy} on {document.uploadedAt}
            </span>
            {document.status === 'superseded' ? <Badge tone="plain">Replaced</Badge> : null}
            {clinical ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setOpenId(document.documentId)}
              >
                Open
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {openId ? (
        <DocumentViewer
          documentId={openId}
          contentType={
            result.documents.find((document) => document.documentId === openId)?.contentType ??
            'application/pdf'
          }
          onClose={() => setOpenId('')}
        />
      ) : null}
    </div>
  )
}

/**
 * The bytes, for as long as they are being looked at and not one moment more.
 *
 * The same shape as `images-panel.tsx`, for the same reasons: a sixty-second
 * ticket that names one document, one reader and one purpose; the bytes
 * fetched with the session in the Authorization header where a URL bar cannot
 * reach it; a blob URL that lives in this tab and is revoked when this closes,
 * changes or unmounts.
 *
 * Nothing here is persisted. No localStorage, no sessionStorage, no cache —
 * `callApi` sends `cache: 'no-store'` — and the object URL does not survive
 * the component. A laboratory report in a shared tablet's disk cache outlives
 * the session that fetched it, which is the whole reason the backend refuses
 * to hold a URL at all.
 */
function DocumentViewer({
  documentId,
  contentType,
  onClose,
}: {
  documentId: string
  contentType: string
  onClose: () => void
}) {
  const [src, setSrc] = useState('')
  const [problem, setProblem] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    let objectUrl = ''

    void (async () => {
      setProblem('')
      setSrc('')
      try {
        const ticketResponse = await callApi(
          `results?action=ticket&documentId=${encodeURIComponent(documentId)}`,
        )
        const ticket = (await ticketResponse.json()) as { ok: boolean; ticket?: string; message?: string }
        if (!ticket.ok || !ticket.ticket) {
          throw new Error(ticket.message ?? 'That report could not be opened.')
        }

        const bytes = await callApi(
          `results?documentId=${encodeURIComponent(documentId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        )
        if (!bytes.ok) {
          const body = (await bytes.json().catch(() => ({}))) as { message?: string }
          throw new Error(body.message ?? 'That report could not be opened.')
        }
        objectUrl = URL.createObjectURL(await bytes.blob())
        if (live) setSrc(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch (error) {
        // The server's sentence, and nothing of the error object: a Postgres
        // or storage error can quote a filename, and a filename is routinely
        // the patient's name and the test.
        if (live) {
          setProblem(error instanceof Error ? error.message : 'That report could not be opened.')
        }
      }
    })()

    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [documentId, attempt])

  return (
    <div className="mt-3 rounded-box border-2 border-ink bg-sheet p-2">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <h5 className="text-[14px] font-semibold">Attached report</h5>
        <div className="flex gap-2">
          {problem ? (
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Open again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the report">
            Close
          </Button>
        </div>
      </div>

      {problem ? (
        <Notice tone="bad">
          {problem}
          {/*
           * A ticket is good for sixty seconds. An expired one is not an
           * error to work around silently — a fresh ticket is a fresh
           * authorization check, which is the point of it being short.
           */}
          <span className="mt-1 block text-[13px]">
            A report link lasts a minute. Open it again for a fresh one.
          </span>
        </Notice>
      ) : !src ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2.5 px-1 py-6 text-[14px]">
          <Icon name="ring" size={20} className="jmc-spin text-ink-2" />
          Opening the report…
        </p>
      ) : contentType === 'application/pdf' ? (
        <object data={src} type="application/pdf" className="h-[60vh] w-full" aria-label="Attached report">
          <p className="p-3 text-[13px]">
            This tablet cannot display a PDF inline.
          </p>
        </object>
      ) : (
        <img src={src} alt="Attached report" className="max-h-[60vh] w-full object-contain" />
      )}
    </div>
  )
}

/* ═════════════════════════════════════════════════════════ the actions ══ */

/** Every refusal this surface can meet, and what the screen does about it. */
function refusalCode(result: ActionResult): ResultRefusalCode | undefined {
  return result.code as ResultRefusalCode | undefined
}

function ResultActions({
  order,
  result,
  staff,
  staffId,
  run,
  reload,
  onChanged,
  onUnsettled,
  onRecovery,
  blocked,
  canDelegate,
  onWriting,
}: {
  order: InvestigationOrderView
  result: ResultView
  staff: ClinicSnapshot['staff']
  staffId: string
  /** Whether `delegate_result_review` would accept this session at all. */
  canDelegate: boolean
  onWriting: (working: string) => void
  run: ActionRunner
  reload: () => Promise<InvestigationOrderView | null>
  onChanged: () => void
  onUnsettled: (unsettled: Unsettled) => void
  onRecovery: (recovery: ResultRecovery | null) => void
  blocked: boolean
}) {
  const globallyBusy = useBusy()
  const task = useTask()
  const anchor = useRef<HTMLDivElement>(null)

  // The drawer locks itself shut while a command is out; see its `busy`.
  // The cleanup matters: unmounting mid-write — a correction arriving, the
  // result ceasing to be current — would otherwise leave the drawer locked
  // with nothing left inside it to unlock it.
  useEffect(() => {
    onWriting(task.busy ? task.workingLabel : '')
    return () => onWriting('')
  }, [task.busy, task.workingLabel, onWriting])

  const critical = (result.flag ?? 'none') === 'critical'
  const reviewed = result.review !== null
  const authorized = result.notificationAuthorizedAt !== ''
  const acknowledged = result.criticalAcknowledgedAt !== ''
  const contacted = result.patientContactedAt !== ''

  const [conclusion, setConclusion] = useState<ReviewConclusion>('no_action_needed')
  const [reviewNote, setReviewNote] = useState('')
  const [contactMethod, setContactMethod] = useState<PatientContactMethod>('telephone')
  const [contactNote, setContactNote] = useState('')
  const [delegateTo, setDelegateTo] = useState('')
  const [delegateReason, setDelegateReason] = useState('')
  const [offerDelegation, setOfferDelegation] = useState(false)
  const [flagChoice, setFlagChoice] = useState<'abnormal' | 'urgent' | 'critical'>('abnormal')
  const [flagReason, setFlagReason] = useState('')

  const doctors = staff.filter((member) => member.active && member.roles.includes('doctor'))
  const nameOf = (id: string) => doctors.find((doctor) => doctor.id === id)?.name ?? ''

  /*
   * `delegate_result_review` takes the responsible doctor, the ordering
   * doctor, or the owner-doctor. The first two are exactly the people the
   * review did NOT refuse, so in the panel below this is the owner-doctor.
   */
  const mayDelegate = canDelegate


  /**
   * One consequential action, with the three answers it can have.
   *
   * A refusal shows the server's sentence and, for the ones that mean somebody
   * else got there first, re-reads before offering anything else. A lost reply
   * is neither a success nor a failure: the control closes, the typed work
   * stays, and only a read of the authoritative order can open it again.
   */
  async function act(
    working: string,
    action: string,
    payload: Record<string, unknown>,
    confirmed: { title: string; detail?: string; icon?: IconName },
    /** What the record would show if this landed. Used only after a lost reply. */
    settled: (order: InvestigationOrderView, resultId: string) => boolean,
    /** Which act this is, for the note that survives a reload. */
    kind: RecoveryAction,
    after?: () => void,
  ) {
    /*
     * The note goes down BEFORE the request, because the case it exists for
     * is the one where nothing comes back — including the tablet being
     * reloaded mid-flight, when no `catch` of ours ever runs. Writing it
     * afterwards would miss exactly the failure it is for.
     *
     * It reuses the reference of a note already here about the same act on
     * the same result, so a remount does not turn one attempt into two.
     */
    onRecovery(
      writeResultRecovery({
        staffId,
        orderId: order.orderId,
        resultId: result.resultId,
        action: kind,
        phase: 'outcome_unknown',
      }),
    )

    const answer = await task.run({
      working,
      request: () => run(action, payload),
      /*
       * The server's own sentence unless the caller has a better one, and for
       * the authorization it is always better: it is the only thing that
       * knows whether this patient has agreed to be messaged, and it says so
       * in the clinic's words rather than in a guess made here.
       */
      confirmed: (answer) => ({
        kind: 'confirmed' as const,
        title: confirmed.title,
        identity: `${order.patientName} · ${order.orderNumber}`,
        /*
         * The caller's phrase, EXCEPT when the server says somebody was here
         * first. "Contact recorded · Telephone" over a contact the desk
         * nurse recorded in person, with the doctor's note dropped, is a
         * green tick on something that did not happen.
         */
        detail: (answer.data as { duplicate?: boolean } | undefined)?.duplicate
          ? answer.message
          : confirmed.detail ?? answer.message,
        icon: confirmed.icon ?? 'check-circle',
      }),
    })

    if (!answer) {
      // `useTask` swallowed a second press, or threw. Either way nothing was
      // learnt, and a thrown request is the unknown case.
      return
    }

    if (answer.unconfirmed) {
      // The note stays exactly as it was written. Nothing here may clear it;
      // only a read of the authoritative order can.
      onUnsettled({ what: working.replace(/…$/, '').toLowerCase(), settled })
      return
    }

    if (!answer.ok) {
      const code = refusalCode(answer)
      if (code === 'NOT_THE_RESPONSIBLE_DOCTOR') {
        // Not hidden in advance, because the client cannot prove standing.
        // The server decided; now the screen offers the only lawful way in.
        setOfferDelegation(true)
      }
      if (code && REFRESH_FIRST_REFUSALS.includes(code)) {
        // Somebody else got there, or the world moved. Read it back before
        // offering another action — never treat this as success. The read
        // settles the note too: `ALREADY_REVIEWED` means it committed.
        const fresh = await reload()
        if (fresh) settleAfter(fresh)
        onChanged()
        return
      }
      /*
       * A plain refusal. The clinic said no and nothing was written, so the
       * note has nothing to point at and is cleared rather than left to
       * greet the next reload with a question that has an answer.
       */
      clearResultRecovery()
      onRecovery(null)
      return
    }

    const fresh = await reload()
    if (fresh) settleAfter(fresh)
    onChanged()
    after?.()
  }

  /**
   * What the note should say now that the record has been read.
   *
   * Cleared when nothing is owed, and rewritten as a follow-up when the
   * review landed and the patient still has to be told — because at that
   * moment the result leaves the review queue and this note is the only
   * thing left pointing at it.
   */
  function settleAfter(fresh: InvestigationOrderView) {
    const current = resultIn(fresh, result.resultId)
    if (resultFollowUpOwed(current)) {
      onRecovery(
        writeResultRecovery({
          staffId,
          orderId: fresh.orderId,
          resultId: result.resultId,
          action: 'contact',
          phase: 'follow_up',
        }),
      )
      return
    }
    clearResultRecovery()
    onRecovery(null)
  }

  const busy = task.busy || globallyBusy || blocked

  return (
    // `tabIndex={-1}` because `TaskResult` restores focus here when the
    // confirmed overlay dismisses itself. Without it `.focus()` is a no-op
    // and focus falls to <body>, which inside a focus trap is nowhere.
    <section className="space-y-3" ref={anchor} tabIndex={-1} data-focus-ring="none">
      <SectionHeader title="What happens now" />

      <TaskFailure failure={task.failure} onDismiss={task.dismiss} />
      <TaskResult outcome={task.outcome} onDismiss={task.dismiss} returnFocusTo={anchor} />

      {/* ── 1. critical: acknowledge. Never a review. ── */}
      {critical ? (
        <div className="rounded-box border-2 border-stop bg-stop-wash px-3.5 py-3">
          <h4 className="flex items-center gap-2 text-[15px] font-semibold text-stop">
            <Icon name="alert-circle" size={20} />
            This result is critical
          </h4>
          <p className="mt-1 text-[13px] leading-relaxed">
            A doctor is expected to acknowledge it, and the patient is told by a telephone call
            rather than by a message. Acknowledging is not reviewing and it is not telling anybody.
          </p>
          {acknowledged ? (
            <p className="mt-2 text-[13px] font-semibold">
              Acknowledged by {result.criticalAcknowledgedBy} on {result.criticalAcknowledgedAt}.
            </p>
          ) : (
            <Button
              className="mt-2"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  'Acknowledging…',
                  'acknowledge_critical_result',
                  { resultId: result.resultId },
                  {
                    title: 'Critical result acknowledged',
                    detail: 'It still needs a review, and a telephone call to the patient.',
                    icon: 'alert-circle',
                  },
                  (fresh, id) => resultIn(fresh, id)?.criticalAcknowledgedAt !== '',
                  'acknowledge',
                )
              }
            >
              {task.busy ? task.workingLabel : 'Acknowledge this critical result'}
            </Button>
          )}
        </div>
      ) : null}

      {/* ── 2. the doctor's own flag ── */}
      {(result.doctorFlag ?? 'none') === 'none' && !authorized ? (
        <details className="rounded-box border border-rule px-3.5 py-2.5">
          <summary className="cursor-pointer text-[14px] font-semibold">
            Record your own clinical flag
          </summary>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            This is your judgment, kept beside what the laboratory reported rather than replacing
            it. It cannot be changed afterwards.
          </p>
          <div className="mt-2 space-y-2">
            <Field label="How serious">
              <Select
                value={flagChoice}
                onChange={(event) =>
                  setFlagChoice(event.target.value as 'abnormal' | 'urgent' | 'critical')
                }
              >
                <option value="abnormal">Abnormal</option>
                <option value="urgent">Urgent</option>
                <option value="critical">Critical</option>
              </Select>
            </Field>
            <Field label="Why">
              <Textarea
                rows={2}
                value={flagReason}
                onChange={(event) => setFlagReason(event.target.value)}
                placeholder="What in the report makes this so"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || flagReason.trim() === ''}
              onClick={() =>
                void act(
                  'Recording the flag…',
                  'flag_result',
                  { resultId: result.resultId, flag: flagChoice, reason: flagReason.trim() },
                  { title: 'Flag recorded', detail: FLAG_WORD[flagChoice] },
                  (fresh, id) => (resultIn(fresh, id)?.doctorFlag ?? 'none') !== 'none',
                  'flag',
                  () => setFlagReason(''),
                )
              }
            >
              {task.busy ? task.workingLabel : 'Record this flag'}
            </Button>
          </div>
        </details>
      ) : null}

      {/* ── 3. the clinic doctor's review ── */}
      <div className="rounded-box border border-rule px-3.5 py-3">
        <h4 className="text-[15px] font-semibold">Record your review</h4>
        {reviewed ? (
          <p className="mt-1 text-[13px] leading-relaxed">
            {result.review?.reviewedBy} already reviewed this. A review is written once, so nothing
            here can change it.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {CONCLUSION_MEANS[conclusion]}
            </p>
            <div className="mt-2 space-y-2">
              <Field label="What you concluded">
                <Select
                  value={conclusion}
                  onChange={(event) => setConclusion(event.target.value as ReviewConclusion)}
                >
                  {(Object.keys(CONCLUSION_WORD) as ReviewConclusion[]).map((value) => (
                    <option key={value} value={value}>
                      {CONCLUSION_WORD[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note" hint="Optional. Kept on the clinical record.">
                <Textarea
                  rows={2}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(
                    'Recording your review…',
                    'review_result',
                    {
                      resultId: result.resultId,
                      conclusion,
                      ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
                    },
                    {
                      title: 'Review recorded',
                      detail: 'Telling the patient is a separate decision.',
                      icon: 'check-circle',
                    },
                    (fresh, id) => resultIn(fresh, id)?.review !== null,
                    'review',
                    () => setReviewNote(''),
                  )
                }
              >
                {task.busy ? task.workingLabel : 'Record review'}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ── 3b. delegation, offered when the server says this is not yours ── */}
      {offerDelegation && !reviewed ? (
        <div className="rounded-box border border-attn bg-attn-wash px-3.5 py-3">
          <h4 className="text-[15px] font-semibold text-attn">
            {mayDelegate ? 'Hand this over to a doctor' : 'This one is not yours to review'}
          </h4>
          <p className="mt-1 text-[13px] leading-relaxed">
            Only the doctor responsible for this request, the one who ordered it, or a doctor
            explicitly delegated to it may review it.
            {mayDelegate
              ? ' Delegating is recorded with your name and the reason, and the doctor you name may then review it.'
              : ` Delegating it is the same three people plus the owner-doctor, so it is not a way through for you either. ${order.responsibleDoctor || order.orderedBy || 'The responsible doctor'} can review it, or hand it to somebody who can.`}
          </p>
          {/*
           * `delegate_result_review` accepts the responsible doctor, the
           * ordering doctor and the owner-doctor. Everybody the review
           * refused is none of the first two, so for anybody but the
           * owner-doctor the form below would be refused with the very
           * sentence that opened it. Offering it anyway is a dead end
           * dressed as a way out.
           */}
          {mayDelegate ? (
          <div className="mt-2 space-y-2">
            <Field label="Delegate to">
              <Select value={delegateTo} onChange={(event) => setDelegateTo(event.target.value)}>
                <option value="">Choose a doctor</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Why">
              <Textarea
                rows={2}
                value={delegateReason}
                onChange={(event) => setDelegateReason(event.target.value)}
                placeholder="On leave, covering the clinic, taking over an escalation"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || delegateTo === '' || delegateReason.trim() === ''}
              onClick={() =>
                void act(
                  'Recording the delegation…',
                  'delegate_result_review',
                  {
                    orderId: order.orderId,
                    toDoctorId: delegateTo,
                    reason: delegateReason.trim(),
                  },
                  { title: 'Review delegated' },
                  (fresh) =>
                    recoveryCommitted(fresh, result.resultId, 'delegate', nameOf(delegateTo)) === true,
                  'delegate',
                  () => {
                    setDelegateReason('')
                    setOfferDelegation(false)
                  },
                )
              }
            >
              {task.busy ? task.workingLabel : 'Delegate this review'}
            </Button>
          </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 4. telling the patient ── */}
      <div className="rounded-box border border-rule px-3.5 py-3">
        <h4 className="text-[15px] font-semibold">Tell the patient</h4>

        {critical ? (
          /*
           * Owner item 88: critical-result communication is clinician-led
           * direct contact, not an automated generic message. The backend
           * refuses an authorization for one with a check constraint as well
           * as a command, and the screen does not offer the path at all.
           */
          <p className="mt-1 text-[13px] leading-relaxed">
            A critical result is not something a patient learns from an automated message.
            Telephone them, and record the call below.
          </p>
        ) : !reviewed ? (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            A notice can only be authorized after the result has been reviewed.
          </p>
        ) : authorized ? (
          <p className="mt-1 text-[13px] leading-relaxed">
            A notice has been authorized. What actually reached the patient is above — an
            authorization is not a delivery.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[13px] leading-relaxed">
              The patient would receive exactly this and nothing else:
            </p>
            <blockquote className="mt-1.5 rounded-box border border-rule bg-paper px-3 py-2 text-[14px] italic">
              {RESULT_READY_MESSAGE}
            </blockquote>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              No value, no abnormal status, no diagnosis, no medicine, no advice, no attachment and
              no link.
            </p>
            <Button
              className="mt-2"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  'Authorizing the notice…',
                  'authorize_result_notification',
                  { resultId: result.resultId },
                  // No detail: the server's sentence names the consent state,
                  // and inventing one here would be quieter and less true.
                  { title: 'Notice authorized', icon: 'clock' },
                  (fresh, id) => resultIn(fresh, id)?.notificationAuthorizedAt !== '',
                  'authorize',
                )
              }
            >
              {task.busy ? task.workingLabel : 'Authorize the result-ready notice'}
            </Button>
          </>
        )}

        {/* ── 5. the telephone call, which is the only certain channel ── */}
        {contacted ? (
          <p className="mt-3 text-[13px]">
            Contact with the patient is already recorded above.
          </p>
        ) : (
          <div className="mt-3 space-y-2 border-t border-rule pt-3">
            <h5 className="text-[14px] font-semibold">Record contacting the patient</h5>
            <p className="text-[13px] leading-relaxed text-ink-2">
              This records what you did. Nothing here telephones anybody.
            </p>
            <Field label="How">
              <Select
                value={contactMethod}
                onChange={(event) =>
                  setContactMethod(event.target.value as PatientContactMethod)
                }
              >
                {(Object.keys(CONTACT_WORD) as PatientContactMethod[]).map((value) => (
                  <option key={value} value={value}>
                    {CONTACT_WORD[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="What was said">
              <Textarea
                rows={2}
                value={contactNote}
                onChange={(event) => setContactNote(event.target.value)}
                placeholder="Spoke to the patient, asked her to come in today"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || contactNote.trim() === ''}
              onClick={() =>
                void act(
                  'Recording the call…',
                  'record_patient_result_contact',
                  {
                    resultId: result.resultId,
                    method: contactMethod,
                    note: contactNote.trim(),
                  },
                  { title: 'Contact recorded', detail: CONTACT_WORD[contactMethod] },
                  (fresh, id) => resultIn(fresh, id)?.patientContactedAt !== '',
                  'contact',
                  () => setContactNote(''),
                )
              }
            >
              {task.busy ? task.workingLabel : 'Record this contact'}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
