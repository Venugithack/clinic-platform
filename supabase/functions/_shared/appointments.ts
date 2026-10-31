/**
 * The future, and the door it comes through.
 *
 * Slice 2. Everything here is about a patient who is not in the building yet,
 * plus the one command that puts them in it. Owner policy items 65 to 71.
 *
 * ── THE SHAPE, IN ONE PARAGRAPH ────────────────────────────────────────────
 *
 * `jmc.appointments` is the ARRIVAL table — the live queue, one row per person
 * standing in the clinic with a token. `jmc.appointment_bookings` is the
 * FUTURE — one row per expectation, holding no token and appearing in no
 * queue. `check_in_appointment` is the single door between them, and it is the
 * only command in this file that writes an arrival. A walk-in never passes
 * through here at all: `create_appointment` in `commands.ts` is untouched, and
 * after check-in a booked patient and a walk-in are the same kind of row,
 * ordered by when they actually turned up. That is owner item 70, and it is
 * the reason a booking is not simply a fifth status on the queue.
 *
 * ── THE THREE THINGS A COMMAND HERE ALWAYS DOES ────────────────────────────
 *
 * Checks the conflict INSIDE the transaction, under a lock. A calendar that
 * decides two tablets may both have 10:00 is a calendar that double-books on
 * the one morning it matters.
 *
 * Writes an `appointment_events` row for every transition. Owner item 68: "No
 * appointment is silently deleted: the prior state, actor, time, and reason
 * remain in append-only history." The `status` column is only ever the latest
 * of those events; the events are what can be read back.
 *
 * Records an override rather than quietly allowing or quietly refusing it.
 * Owner item 67 permits overbooking only through "an explicit action that
 * records actor, time, and a required reason", and a clinic that discovers a
 * month later that half its bookings were overrides has not been given that.
 *
 * ── AND ONE THING IT NEVER DOES ────────────────────────────────────────────
 *
 * Send anything. That was true when this file was written because owner
 * decisions D8 to D12c were unanswered; it is still true now that they are
 * owner items 76 to 83, and for a better reason.
 *
 * Slice 3A gave the clinic somewhere to record that a patient should be
 * reminded, so `book_appointment`, `reschedule_appointment`,
 * `cancel_appointment`, `mark_no_show` and `check_in_appointment` each call
 * `syncAppointmentSchedule` inside the transaction they already open. That
 * writes a row and contacts nobody: there is no provider adapter, no webhook
 * and no scheduler in that slice either, and with the clinic's Meta connection
 * unconfigured every one of those schedules is suppressed into a staff queue
 * rather than sent. None of the responses below changed.
 */
import { randomUUID } from 'node:crypto'
import { audit, db, isoNow, transaction } from './db.ts'
import { requestFingerprint } from './idempotency.ts'
import type { SessionView } from './types.ts'
import type { AppointmentCommandName, AppointmentCommandOutcome } from './appointment-types.ts'
import { hasRole } from './auth.ts'
import {
  booleanValue, CommandRefusal, optional, optionalDate, optionalPositiveInteger,
  requireChoice, requireRole, sequence, value, type Payload,
} from './command-input.ts'
import { runInventoryCommand } from './inventory.ts'
import { syncAppointmentSchedule } from './messaging.ts'
import {
  BOOKING_HORIZON_DAYS, DEFAULT_DURATION_MINUTES, MAX_DURATION_MINUTES,
  NO_SHOW_AFTER_MINUTES,
} from './clinic-policy.ts'

/** Today in the clinic, not in Greenwich. The same expression every module builds. */
const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

/**
 * The advisory-lock namespace bookings serialize in.
 *
 * Arbitrary, like `bootstrap`'s, and its only property that matters is that
 * every caller picks the same one. One namespace per concern so that a
 * consultation attempt and a calendar conflict never wait on each other:
 * `commands.ts` holds `ATTEMPT_LOCK_NAMESPACE` for the other.
 */
const BOOKING_LOCK_NAMESPACE = 517_204

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')

/**
 * A moment the clinic means, from whatever the caller typed.
 *
 * The same distinction `clinicInstant` draws for the queue's TEXT column, for
 * a `timestamptz` one: a value carrying a zone is already absolute, and a
 * naive one is clinic-local — because the desk's `datetime-local` input sends
 * `2026-09-22T10:30` and the runtime this executes in thinks in UTC. Parsing
 * that in JavaScript moves every booking five and a half hours, which is a
 * morning appointment landing at four in the afternoon.
 *
 * Done in one statement with the horizon arithmetic beside it, so that "is
 * this inside ninety clinic days" is answered in the same timezone the value
 * was resolved in rather than in a second place that could disagree.
 */
async function clinicMoment(raw: string, field = 'scheduledAt'): Promise<{
  at: string
  clinicDate: string
  daysAhead: number
}> {
  /*
   * The shape is checked HERE, in JavaScript, before the database is asked.
   *
   * This is the one database round-trip still in front of `once()`, and the
   * blanket `catch` that used to wrap it reported every failure — a connection
   * reset, a statement timeout, a deadlock — as "scheduledAt is not a time".
   * On a retry after a transient fault that tells a tablet its date is
   * malformed while its earlier request has already committed, which is the
   * exact confusion the receipt exists to prevent. Found by the independent
   * review.
   *
   * So: a string that is not a date-time is refused without asking anybody,
   * and the narrow catch below covers only the shapes that parse and then turn
   * out not to be days — the thirtieth of February. Everything else is a real
   * failure and travels as one.
   */
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(raw)) {
    throw new Error(`${field} is not a time.`)
  }

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
  let row: Row | undefined
  try {
    row = await db.prepare(
      `select
         to_char(x.at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
         to_char((x.at at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as clinic_date,
         ((x.at at time zone 'Asia/Kolkata')::date - ${CLINIC_TODAY}) as days_ahead
       from (select ${
        hasZone
          ? `((?::text)::timestamptz)`
          // `(?::text)::timestamp` and not `?::timestamp`: the driver otherwise
          // pre-parses the parameter and the zone shift is applied twice.
          : `(((?::text)::timestamp) at time zone 'Asia/Kolkata')`
      } as at) x`,
    ).get(raw)
  } catch (error) {
    // 22007 invalid_datetime_format, 22008 datetime_field_overflow — the
    // caller's value. Anything else is the clinic's, and is not this
    // function's to describe.
    const code = String((error as { code?: unknown })?.code ?? '')
    if (code === '22007' || code === '22008') throw new Error(`${field} is not a time.`)
    throw error
  }
  if (!row?.at) throw new Error(`${field} is not a time.`)
  return {
    at: text(row.at),
    clinicDate: text(row.clinic_date),
    daysAhead: Number(row.days_ahead ?? 0),
  }
}

/**
 * Owner item 66, both halves of it.
 *
 * Ninety clinic-local days ahead is policy. The other end — not before today —
 * is a safe technical default rather than an owner decision, and it is drawn
 * at the DAY rather than at the minute deliberately: a patient booked for
 * 10:00 and written into the system at 10:05 is the ordinary shape of a busy
 * morning, and refusing that would make the honest record impossible while
 * preventing nothing.
 */
function requireInsideHorizon(moment: { clinicDate: string; daysAhead: number }): void {
  if (moment.daysAhead < 0) {
    throw new Error(
      `${moment.clinicDate} is in the past. An appointment is booked for today or a day ahead of it; ` +
      'a visit that has already happened is recorded on the queue, not on the calendar.',
    )
  }
  if (moment.daysAhead > BOOKING_HORIZON_DAYS) {
    throw new Error(
      `${moment.clinicDate} is ${moment.daysAhead} days away and the clinic books ` +
      `${BOOKING_HORIZON_DAYS} days ahead at most.`,
    )
  }
}

/** Who the appointment is with. One doctor today; named rather than assumed. */
async function requireDoctor(doctorId: string): Promise<string> {
  const doctor = await db.prepare(
    `select id, roles_json from staff where id=? and active=1`,
  ).get(doctorId) as Row | undefined
  if (!doctor) throw new Error('That member of staff was not found, or is no longer active.')
  if (!text(doctor.roles_json).includes('"doctor"')) {
    throw new Error('An appointment is booked with a doctor.')
  }
  return text(doctor.id)
}

/**
 * The doctor an appointment is with when the caller does not say.
 *
 * One doctor is the whole clinic today, so asking a nurse to pick one from a
 * list of one is a field that exists to be got wrong. Where there are several
 * and no doctor is named, this refuses rather than choosing: which doctor a
 * patient is seeing is not a default.
 */
async function resolveDoctor(session: SessionView, payload: Payload): Promise<string> {
  const named = optional(payload, 'doctorId')
  if (named) return await requireDoctor(named)

  const doctors = await db.prepare(
    `select id from staff where active=1 and roles_json like '%"doctor"%' order by id`,
  ).all() as Row[]
  if (doctors.length === 1) return text(doctors[0].id)
  if (doctors.length === 0) throw new Error('This clinic has no active doctor to book with.')
  if (hasRole(session, 'doctor')) return session.staffId
  throw new Error('Say which doctor this appointment is with.')
}

/* ─────────────────────────────────────────────────────── availability */

type AvailabilityVerdict = {
  /** Whether the whole appointment falls inside an open window. */
  inside: boolean
  /** Whether a blocked window overlaps it. */
  blocked: boolean
}

/**
 * Whether a slot is inside what the doctor has published.
 *
 * Read entirely in clinic-local time, because a window is "Tuesdays, nine to
 * one" and a Tuesday is a clinic Tuesday. An appointment that crosses midnight
 * is never inside a window; it is refused as outside availability rather than
 * silently spanning two days' worth of them.
 *
 * ── THE ESCAPE THAT WAS HERE, AND WHY IT IS GONE ───────────────────────
 *
 * Slice 2 returned a third answer, `published`, and used it to let a nurse book
 * any hour of a day the doctor had published nothing for. The reasoning was
 * that item 71 would otherwise refuse a nurse everything until somebody drew a
 * timetable. The acceptance review reproduced the consequence — a nurse
 * booking a patient for three in the morning — and pointed at the policy,
 * which does not admit the exception:
 *
 *   > A nurse may book, reschedule, or cancel within published availability
 *   > but may not change the availability itself.
 *
 * Within. So a day with no open window is a day a nurse cannot book, and the
 * clinic is not locked out, because the route was always there: a doctor or an
 * admin books it, with the recorded override below. Publishing hours is simply
 * the first thing a clinic does, and until it does, booking is a doctor's job.
 *
 * That the doctor keeps an override at all is an implementation default rather
 * than something item 71 says. Item 71 constrains the nurse and is silent
 * about the doctor, who owns the hours; item 67 supplies the shape — an
 * explicit action recording actor, time and a required reason — and this
 * reuses it rather than inventing a second one.
 */
async function availabilityFor(
  doctorId: string,
  startsAt: string,
  durationMinutes: number,
): Promise<AvailabilityVerdict> {
  const row = await db.prepare(
    `with slot as (
       select (?::timestamptz) as opens,
              (?::timestamptz + make_interval(mins => ?)) as closes,
              (?::timestamptz at time zone 'Asia/Kolkata')::date as day
     ),
     /*
      * Every open window that applies to the day, as an actual range of time
      * rather than a pair of clock readings.
      *
      * The first version asked whether ONE window contained the whole
      * appointment, which is wrong the moment a clinic publishes a morning and
      * an afternoon session — the ordinary shape. A 15-minute appointment at
      * 12:55, with 09:00-13:00 and 13:00-17:00 both published, was refused as
      * outside published hours although every minute of it is published. Found
      * by the independent review.
      *
      * Ranges union, so contiguous and overlapping windows behave the way
      * anybody reading a timetable expects them to.
      */
     open_windows as (
       select tstzrange(
                ((s.day + a.starts_at) at time zone 'Asia/Kolkata'),
                ((s.day + a.ends_at) at time zone 'Asia/Kolkata'),
                '[)'
              ) as span
         from provider_availability a, slot s
        where a.doctor_id = ? and a.active and a.kind = 'open'
          and (
            (a.on_date is not null and a.on_date = s.day)
            or (a.weekday is not null
                and a.weekday = extract(dow from s.day)::int
                and a.effective_from <= s.day
                and (a.effective_to is null or a.effective_to >= s.day))
          )
     )
     select
       /*
        * Inside means every minute of the appointment is published: subtract
        * the union of the open windows from the appointment and see whether
        * anything is left. An appointment crossing midnight leaves something
        * over by construction, because the windows are built on one day, which
        * is the safe answer rather than a silently spanning one.
        */
       (select isempty(
                 tstzmultirange(tstzrange(s.opens, s.closes, '[)'))
                 - coalesce((select range_agg(span) from open_windows), tstzmultirange())
               )
          from slot s) as inside,
       exists (
         select 1 from provider_availability a, slot s
          where a.doctor_id = ? and a.active and a.kind = 'blocked'
            and (
              (a.on_date is not null and a.on_date = s.day)
              or (a.weekday is not null
                  and a.weekday = extract(dow from s.day)::int
                  and a.effective_from <= s.day
                  and (a.effective_to is null or a.effective_to >= s.day))
            )
            -- Overlap, not containment: any blocked minute blocks the whole
            -- appointment.
            and tstzrange(
                  ((s.day + a.starts_at) at time zone 'Asia/Kolkata'),
                  ((s.day + a.ends_at) at time zone 'Asia/Kolkata'),
                  '[)'
                ) && tstzrange(s.opens, s.closes, '[)')
       ) as blocked`,
  ).get(startsAt, startsAt, durationMinutes, startsAt, doctorId, doctorId) as Row | undefined

  return {
    inside: row?.inside === true,
    blocked: row?.blocked === true,
  }
}

/* ─────────────────────────────────────────────────────────── conflicts */

/** The booking already standing in this slot, if there is one. */
async function conflictingBooking(
  doctorId: string,
  startsAt: string,
  durationMinutes: number,
  exceptBookingId: string,
): Promise<Row | undefined> {
  return await db.prepare(
    `select b.id, b.scheduled_at, b.duration_minutes, p.name as patient_name
       from appointment_bookings b
       join patients p on p.id = b.patient_id
      where b.doctor_id = ?
        and b.status = 'booked'
        -- The booking being MOVED is not in conflict with itself. Empty when
        -- there is none, which no id ever is.
        and b.id <> ?
        and b.scheduled_at < (?::timestamptz + make_interval(mins => ?))
        and (b.scheduled_at + make_interval(mins => b.duration_minutes)) > ?::timestamptz
      order by b.scheduled_at
      limit 1`,
  ).get(doctorId, exceptBookingId, startsAt, durationMinutes, startsAt) as Row | undefined
}

/**
 * Whether this slot may be taken, and what had to be overridden to take it.
 *
 * Owner item 67: overbooking is off by default, a doctor or admin may override
 * "only through an explicit action that records actor, time, and a required
 * reason", and a nurse cannot overbook at all. Owner item 71: a nurse books
 * within published availability.
 *
 * The override is one reason covering both, because from where the person is
 * standing they are one act — "book it anyway, and here is why" — and asking
 * for two sentences to place one appointment is how a required reason becomes
 * a full stop somebody types to get past the form.
 */
async function clearSlot(
  session: SessionView,
  {
    doctorId, startsAt, durationMinutes, overrideReason, exceptBookingId = '',
  }: {
    doctorId: string
    startsAt: string
    durationMinutes: number
    overrideReason: string
    exceptBookingId?: string
  },
): Promise<{ overbooked: boolean; overbookedReason: string; outsideAvailability: boolean }> {
  const mayOverride = hasRole(session, 'admin', 'doctor')
  const availability = await availabilityFor(doctorId, startsAt, durationMinutes)
  // Owner item 71: WITHIN published availability. A day with no open window
  // is a day that is not published, which is not the same as a day that is
  // open at every hour of it.
  const outside = availability.blocked || !availability.inside

  if (outside && !mayOverride) {
    throw new CommandRefusal(
      availability.blocked
        ? 'That time is inside a window the doctor has blocked. Choose another time, or ask the doctor or an administrator to place it.'
        : 'That time is outside the hours the doctor has published. Choose a time inside them, or ask the doctor or an administrator to place it.',
      'OUTSIDE_PUBLISHED_AVAILABILITY',
    )
  }

  const conflict = await conflictingBooking(doctorId, startsAt, durationMinutes, exceptBookingId)

  if (conflict && !mayOverride) {
    throw new CommandRefusal(
      `${text(conflict.patient_name)} already has that time. Choose another, or ask the doctor or an ` +
      'administrator to overbook it.',
      'SLOT_ALREADY_TAKEN',
    )
  }

  if ((conflict || outside) && !overrideReason) {
    throw new CommandRefusal(
      conflict
        ? `${text(conflict.patient_name)} already has that time. Overbooking is off by default — say why this ` +
          'appointment goes in beside it, and the reason is recorded with your name against it.'
        : 'That time is outside the published hours. Say why this appointment goes there, and the reason is ' +
          'recorded with your name against it.',
      'OVERRIDE_REASON_REQUIRED',
    )
  }

  return {
    overbooked: Boolean(conflict),
    overbookedReason: conflict || outside ? overrideReason : '',
    outsideAvailability: outside,
  }
}

/**
/* ──────────────────────────────────────────────────── doing it once */

/**
 * What a command did, and the reason it is written down rather than worked out.
 *
 * ── WHAT SLICE 2 SHIPPED, AND WHY IT WAS NOT IDEMPOTENCY ───────────────────
 *
 * `reschedule_appointment` and `check_in_appointment` answered "have I already
 * done this?" by reading the booking's CURRENT state: is it already at this
 * time, is it already checked in. That reads like idempotency and is a guess
 * that expires, because the current state keeps moving. The acceptance review
 * reproduced both endings against the clinic's own database:
 *
 *   Move to 11:00. Reply lost. Somebody moves it to 12:00. The lost reply's
 *   retry arrives — the booking is not at 11:00, so it is not a duplicate, so
 *   it moves BACK to 11:00 and writes a third transition.
 *
 *   Check in; JMC-0001 is issued. Reply lost. The appointment is rescheduled
 *   and that arrival cancelled. The retry arrives — the booking is not
 *   `checked_in`, so it is not a duplicate, so it mints JMC-0002 and puts the
 *   booking back to `checked_in`.
 *
 * Both are the same fault. A retry has to be recognised by what the REQUEST
 * was, not by what the world looks like when it lands, because the whole
 * reason it landed late is that the world moved.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * One receipt per command, written in the same transaction as its effect, and
 * read before anything else happens. The programme's rule in its own words:
 * "Every client-retryable consequential command accepts a scoped idempotency
 * key and the server stores enough request identity and result identity to
 * return the original outcome safely."
 *
 * Request identity is the fingerprint: same key and same material request is a
 * retry; same key and a materially different request is a client fault and is
 * refused rather than answered with somebody else's outcome. Result identity
 * is the stored outcome: the booking id, the queue token, the numbers a screen
 * already printed. A retry gets those back, never a fresh set.
 *
 * ── AND WHY A REPLAY IS NOT ALWAYS THE WHOLE TRUTH ─────────────────────────
 *
 * A stale retry must change nothing. It must also not lie. The check-in above,
 * replayed, would hand a tablet JMC-0001 for a patient who is not in the queue
 * any more — accurate about the past and useless about the present. So a
 * command may pass `standing`, which is asked, at replay time, whether what it
 * recorded still holds, and its answer rides on the response beside the
 * original one.
 */

/** The namespace one command key serializes in. One point, as the review asks. */
export const RECEIPT_LOCK_NAMESPACE = 517_205

/*
 * ── WHAT MAY HAPPEN BEFORE THE RECEIPT IS READ, AND WHAT MAY NOT ─────────
 *
 * Only two things: the role check, and canonicalising what the caller sent.
 *
 * Everything else belongs inside `work()`, because everything else is a
 * question about the clinic NOW — and a retry arrives precisely when "now" has
 * moved. The third acceptance review reproduced two:
 *
 *   A reschedule that succeeded yesterday, retried today, was refused with
 *   "that day is in the past" — the horizon check ran before the receipt, so
 *   the stored outcome was unreachable and the tablet was told its committed
 *   work had failed.
 *
 *   A nurse booked with no `doctorId` while the clinic had one doctor. A locum
 *   was added. The exact retry was refused with "say which doctor this
 *   appointment is with", because resolving the default reads the roster.
 *
 * The fingerprint follows from the same rule: it is built from what the CALLER
 * sent, never from a value derived out of mutable state. The resolved doctor
 * is a result and is stored as one.
 *
 * Canonicalising the instant is allowed and is not an exception: a naive local
 * time in a fixed zone is the same instant whenever it is asked, so
 * `clinicMoment`'s `at` is a spelling of the caller's own value. Its
 * `daysAhead` is not, and nothing outside `work()` reads it.
 */

/** What a command hands back, plus what it touched. */
type Recorded = {
  message: string
  data?: Record<string, unknown>
  bookingId?: string
  arrivalId?: string
}

/** The receipt is already there and this caller is not the one who wrote it. */
class AlreadyDone extends Error {
  constructor() {
    super('This command was already carried out under the reference it was sent with.')
    this.name = 'AlreadyDone'
  }
}

async function receiptFor(key: string): Promise<Row | undefined> {
  return await db.prepare(
    `select id, command, request_fingerprint, result, booking_id, arrival_id, actor_id, created_at
       from appointment_command_receipts where idempotency_key = ?`,
  ).get(key) as Row | undefined
}

function isReceiptClash(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const detail = error as { code?: unknown; constraint_name?: unknown; message?: unknown }
  if (String(detail.code) !== '23505') return false
  /*
   * Two indexes, because two rows carry the reference: the authoritative
   * receipt, and the booking's own copy of the reference it was made under.
   * The advisory lock above means the second should never be the one to fire
   * — but if it ever does, it means exactly what the first means, and
   * rethrowing it raw would turn a duplicate into a stack trace.
   */
  const names = ['appointment_command_receipts_key', 'appointment_bookings_idempotency_key']
  return names.some((name) =>
    String(detail.constraint_name ?? '') === name || String(detail.message ?? '').includes(name))
}

/**
 * The reference this request is sent under.
 *
 * Required, and deliberately so. The consultation key had to stay optional
 * because a build already on the clinic's tablets sends none and refusing it
 * would have locked the clinic out of signing. These commands have no deployed
 * caller at all, so there is nobody to be compatible with — and a compatibility
 * window nobody needs is a hole that defeats the guarantee it sits beside. The
 * acceptance review says so in as many words.
 */
function referenceOf(payload: Payload): string {
  const key = optional(payload, 'idempotencyKey')
  if (!key) {
    throw new Error(
      'Send this request under a reference of its own (idempotencyKey), so that a reply lost on the ' +
      'way back cannot make it happen twice.',
    )
  }
  return key
}

/**
 * Carry out a command exactly once, whatever happens to its reply.
 *
 * `material` is everything about the request that reaches a durable record. A
 * retry agreeing on all of it is a retry; disagreeing on any of it is a reused
 * reference and is refused.
 *
 * `work` runs inside the transaction, after the serialization point and after
 * the receipt has been re-read under it. Whatever it returns is both the
 * caller's answer and the receipt's contents.
 *
 * `standing` is optional and is asked only on a replay: given the receipt, does
 * what it records still hold? Its answer is merged into the replayed data, so
 * a screen can say "this is what you did, and it has since been undone".
 */
async function once(
  session: SessionView,
  command: string,
  payload: Payload,
  material: Record<string, unknown>,
  work: () => Promise<Recorded>,
  standing?: (receipt: Row) => Promise<Record<string, unknown>>,
): Promise<{ message: string; data: Record<string, unknown> }> {
  const key = referenceOf(payload)
  const fingerprint = requestFingerprint({ command, actor: session.staffId, ...material })

  const already = await receiptFor(key)
  if (already) return await replayReceipt(already, command, fingerprint, standing)

  const raced = await transaction(async () => {
    /*
     * The serialization point, and there is one rather than several.
     *
     * Two tablets sending one reference meet here rather than at four
     * different unique indexes in four different tables, so the loser waits
     * on a short lock and then reads the winner's receipt instead of
     * discovering the collision halfway through its own writes.
     */
    await db.prepare(
      `select pg_advisory_xact_lock(${RECEIPT_LOCK_NAMESPACE}, hashtext(?))`,
    ).get(key)

    if (await receiptFor(key)) throw new AlreadyDone()

    const recorded = await work()

    await db.prepare(
      `insert into appointment_command_receipts
         (id, idempotency_key, command, request_fingerprint, result, booking_id, arrival_id, actor_id)
       values (?,?,?,?,?::text::jsonb,?,?,?)`,
    ).run(
      randomUUID(), key, command, fingerprint,
      JSON.stringify({ message: recorded.message, data: recorded.data ?? {} }),
      recorded.bookingId ?? null, recorded.arrivalId ?? null, session.staffId,
    )

    return recorded
  }).then((recorded) => ({ recorded, clash: null as unknown }), (error: unknown) => {
    if (error instanceof AlreadyDone) return { recorded: null, clash: error }
    if (isReceiptClash(error)) return { recorded: null, clash: error }
    throw error
  })

  if (raced.recorded) {
    return { message: raced.recorded.message, data: raced.recorded.data ?? {} }
  }

  const winner = await receiptFor(key)
  if (winner) return await replayReceipt(winner, command, fingerprint, standing)
  // The index refused this key and yet no receipt carries it. Unreachable; if
  // it ever happens the original error is the only truthful thing to report.
  throw raced.clash
}

/**
 * The stored outcome, whichever shape the driver hands it back in.
 *
 * `::text::jsonb` and not `::jsonb`, in the insert above, and this is why: the
 * driver serializes a parameter bound to a json column by JSON-stringifying
 * it, so an already-stringified value went in stringified TWICE and came back
 * as a JSON string scalar rather than an object. The replay then had a message
 * and no data at all — a check-in retry answered without the token it was
 * asked for, which is the exact failure a replay exists to prevent.
 *
 * Casting through text pins the parameter as text and lets Postgres parse it.
 * The string branch below costs one `typeof` and means a row written by the
 * broken shape is still readable rather than silently empty.
 */
function storedResult(value: unknown): { message?: string; data?: Record<string, unknown> } {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as { message?: string; data?: Record<string, unknown> }
    } catch {
      return {}
    }
  }
  return (value ?? {}) as { message?: string; data?: Record<string, unknown> }
}

async function replayReceipt(
  receipt: Row,
  command: string,
  fingerprint: string,
  standing?: (receipt: Row) => Promise<Record<string, unknown>>,
): Promise<{ message: string; data: Record<string, unknown> }> {
  if (text(receipt.command) !== command || text(receipt.request_fingerprint) !== fingerprint) {
    throw new CommandRefusal(
      'That reference was already used for a different request. Nothing was changed. Send this one ' +
      'under a reference of its own.',
      'APPOINTMENT_REFERENCE_REUSED',
    )
  }

  const stored = storedResult(receipt.result)
  const current = standing ? await standing(receipt) : {}

  return {
    message: text(stored.message),
    data: { ...(stored.data ?? {}), ...current, duplicate: true },
  }
}

/* ───────────────────────────────────────────────────────────── history */

/**
 * One transition, written down.
 *
 * Owner item 68: "the prior state, actor, time, and reason remain in
 * append-only history." Slice 2 recorded the time before and after and nothing
 * else, so a reschedule that changed the appointment TYPE left a history that
 * said the time had moved and stayed silent about the rest — and an override
 * applied during a reschedule was validated and then discarded entirely. Both
 * were reproduced by the acceptance review. What the transition changed and
 * what had to be overridden to make it are the transition.
 */
async function recordEvent(
  actorId: string,
  event: string,
  where: { bookingId?: string; arrivalId?: string },
  detail: {
    fromStatus?: string | null
    toStatus?: string | null
    scheduledAtBefore?: string | null
    scheduledAtAfter?: string | null
    typeBefore?: string | null
    typeAfter?: string | null
    durationBefore?: number | null
    durationAfter?: number | null
    reason?: string
    detail?: string
    override?: { overbooked: boolean; outsideAvailability: boolean; overbookedReason: string }
  } = {},
): Promise<void> {
  const override = detail.override
    ?? { overbooked: false, outsideAvailability: false, overbookedReason: '' }

  await db.prepare(
    `insert into appointment_events
       (id, booking_id, arrival_id, event, from_status, to_status,
        scheduled_at_before, scheduled_at_after,
        appointment_type_before, appointment_type_after,
        duration_before, duration_after,
        overbooked, outside_availability, override_reason,
        reason, detail, actor_id)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(), where.bookingId ?? null, where.arrivalId ?? null, event,
    detail.fromStatus ?? null, detail.toStatus ?? null,
    detail.scheduledAtBefore ?? null, detail.scheduledAtAfter ?? null,
    detail.typeBefore ?? null, detail.typeAfter ?? null,
    detail.durationBefore ?? null, detail.durationAfter ?? null,
    override.overbooked, override.outsideAvailability, override.overbookedReason,
    detail.reason ?? '', detail.detail ?? '', actorId,
  )
}

/** The booking, held for the length of this transaction. */
async function lockBooking(bookingId: string): Promise<Row> {
  const booking = await db.prepare(
    `select * from appointment_bookings where id=? for update`,
  ).get(bookingId) as Row | undefined
  if (!booking) throw new Error('That appointment was not found.')
  return booking
}

/**
 * Owner item 68's role rule, which is a rule about WHEN and not only about who.
 *
 * "Before check-in, nurse, doctor, or admin may cancel or reschedule. After
 * check-in, only doctor or admin may do so, with a required reason."
 */
function requireMayChange(session: SessionView, booking: Row, what: string): void {
  if (text(booking.status) === 'checked_in' && !hasRole(session, 'admin', 'doctor')) {
    throw new CommandRefusal(
      `This patient has already checked in and is in the queue. Only a doctor or an administrator may ` +
      `${what} a visit that has started.`,
      'CHECKED_IN_ALREADY',
    )
  }
}

/** The live arrival this booking produced, whatever state it is in now. */
async function arrivalOf(bookingId: string): Promise<Row | undefined> {
  return await db.prepare(
    `select id, token, status from appointments where booking_id=? order by created_at desc limit 1`,
  ).get(bookingId) as Row | undefined
}

/* ──────────────────────────────────────────────────────────── dispatch */

export async function runAppointmentCommand(
  session: SessionView,
  action: string,
  payload: Payload,
) {
  switch (action) {
    /* ───────────────────────────────────────────── owner item 65 */

    case 'create_appointment_type': {
      requireRole(session, 'admin', 'doctor')
      const name = value(payload, 'name')
      const duration = optionalPositiveInteger(payload, 'durationMinutes') ?? DEFAULT_DURATION_MINUTES
      requireSaneDuration(duration)

      return await once(session, action, payload, { name, duration }, async () => {
        const id = randomUUID()
        await db.prepare(
          `insert into appointment_types (id, name, duration_minutes, created_by) values (?,?,?,?)`,
        ).run(id, name, duration, session.staffId)
        await audit(session.staffId, 'appointment_type.created', 'appointment_type', id,
          `Added appointment type ${name} of ${duration} minutes`)
        return {
          message: `${name} added, ${duration} minutes.`,
          // What this request set, which is what its message asserts, so a
          // replay can say whether the sentence is still true.
          data: { appointmentTypeId: id, applied: { name, durationMinutes: duration } },
        }
      }, standingFor('create_appointment_type'))
    }

    case 'update_appointment_type': {
      requireRole(session, 'admin', 'doctor')
      const id = value(payload, 'appointmentTypeId')
      const duration = optionalPositiveInteger(payload, 'durationMinutes')
      if (duration !== undefined) requireSaneDuration(duration)
      const name = optional(payload, 'name')
      const active = payload.active === undefined ? undefined : booleanValue(payload, 'active')

      return await once(session, action, payload, { id, name, duration, active }, async () => {
        const existing = await db.prepare(
          'select * from appointment_types where id=? for update',
        ).get(id) as Row | undefined
        if (!existing) throw new Error('That appointment type was not found.')

        await db.prepare(
          `update appointment_types
              set name = coalesce(?, name),
                  duration_minutes = coalesce(?, duration_minutes),
                  active = coalesce(?, active),
                  updated_by = ?, updated_at = now()
            where id = ?`,
        ).run(name || null, duration ?? null, active ?? null, session.staffId, id)

        /*
         * Owner item 65's second sentence: "A type change does not rewrite the
         * duration already recorded for an existing booking."
         *
         * Nothing above touches `appointment_bookings`, and nothing needs to:
         * the duration is COPIED onto the booking when it is made, exactly as
         * the consultation fee is copied onto the encounter. There is no join
         * to go stale and no backfill to get wrong.
         */
        await audit(session.staffId, 'appointment_type.updated', 'appointment_type', id,
          `Updated appointment type ${name || text(existing.name)}`)
        return {
          message: 'Appointment type updated. Bookings already made keep the duration they were made with.',
          // What this request CHANGED, so a replay can say whether it still
          // stands without claiming anything about the fields it left alone.
          data: {
            appointmentTypeId: id,
            applied: {
              ...(name ? { name } : {}),
              ...(duration !== undefined ? { durationMinutes: duration } : {}),
              ...(active !== undefined ? { active } : {}),
            },
          },
        }
      }, standingFor('update_appointment_type'))
    }

    /* ───────────────────────────────────────────── owner item 71 */

    case 'publish_availability': {
      requireRole(session, 'admin', 'doctor')
      const kind = requireChoice(payload, 'kind', ['open', 'blocked'] as const, 'open')
      const startsAt = value(payload, 'startsAt')
      const endsAt = value(payload, 'endsAt')
      const onDate = optionalDate(payload, 'onDate')
      const weekdayRaw = optional(payload, 'weekday')

      if (Boolean(onDate) === Boolean(weekdayRaw)) {
        throw new Error('A window repeats on a weekday or falls on one date. Give exactly one of them.')
      }
      const weekday = weekdayRaw === '' ? null : Number(weekdayRaw)
      if (weekday !== null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
        throw new Error('weekday is 0 for Sunday through 6 for Saturday.')
      }
      /*
       * The caller's value is material; the default is not.
       *
       * `currentClinicDate()` is read fresh on every attempt, so including it
       * made a retry that crossed midnight fingerprint differently and be
       * refused as a reused reference — the one retry the mechanism exists to
       * answer. The material set below carries what the caller SENT.
       */
      const askedEffectiveFrom = optionalDate(payload, 'effectiveFrom')
      const effectiveTo = weekday === null ? null : optionalDate(payload, 'effectiveTo') ?? null
      const note = optional(payload, 'note')

      return await once(
        session, action, payload,
        {
          doctorId: optional(payload, 'doctorId'), kind, weekday, onDate, startsAt, endsAt,
          effectiveFrom: askedEffectiveFrom, effectiveTo, note,
        },
        async () => {
          // Both read the clinic as it is now — the roster, and today — so both
          // are inside, and the material above is what the caller sent.
          const doctorId = await resolveDoctor(session, payload)
          const effectiveFrom = weekday === null
            ? null
            : askedEffectiveFrom ?? await currentClinicDate()

          const id = randomUUID()
          await db.prepare(
            `insert into provider_availability
               (id, doctor_id, kind, weekday, on_date, starts_at, ends_at,
                effective_from, effective_to, note, created_by)
             values (?,?,?,?,?,?::time,?::time,?::date,?::date,?,?)`,
          ).run(
            id, doctorId, kind, weekday, onDate ?? null, startsAt, endsAt,
            effectiveFrom, effectiveTo, note, session.staffId,
          )
          await audit(session.staffId, 'availability.published', 'availability', id,
            `${kind === 'open' ? 'Opened' : 'Blocked'} ${onDate ?? `weekday ${weekday}`} ${startsAt}–${endsAt}`)

          /*
           * Owner item 71: "An availability change never silently cancels or
           * moves an existing booking." Nothing above reads or writes
           * `appointment_bookings`, and the sentence below is the clinic being
           * told so rather than being left to discover it.
           */
          return {
            message: kind === 'open'
              ? 'Hours published. Appointments already booked are unchanged.'
              : 'Time blocked. Appointments already booked into it are unchanged — cancel or move them yourself.',
            data: { availabilityId: id, doctorId },
          }
        },
        standingFor('publish_availability'),
      )
    }

    case 'retire_availability': {
      requireRole(session, 'admin', 'doctor')
      const id = value(payload, 'availabilityId')
      const reason = value(payload, 'reason')

      return await once(session, action, payload, { id, reason }, async () => {
        /*
         * The note is the doctor's own words about the window and is left
         * alone. An earlier version wrote the retirement reason into it when
         * it happened to be empty, which meant the reason survived on some
         * rows and not others — the worst of both. It is in `audit_events`,
         * where every other actor-and-reason in this application is.
         */
        const changed = await db.prepare(
          `update provider_availability
              set active = false, retired_by = ?, retired_at = now()
            where id = ? and active`,
        ).run(session.staffId, id)
        if (changed.changes === 0) throw new Error('That window was not found, or has already been retired.')
        await audit(session.staffId, 'availability.retired', 'availability', id, `Retired: ${reason}`)
        return {
          message: 'Window retired. Appointments already booked into it are unchanged.',
          data: { availabilityId: id },
        }
      }, standingFor('retire_availability'))
    }

    /* ───────────────────────────────────────── owner items 66–70 */

    case 'book_appointment': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const patientId = value(payload, 'patientId')
      const reason = value(payload, 'reason')
      const typeId = optional(payload, 'appointmentTypeId')
      const overrideReason = optional(payload, 'overrideReason')
      const moment = await clinicMoment(value(payload, 'scheduledAt'))

      /*
       * The doctor the caller ASKED for, which may be nothing, and not the one
       * the roster resolves to. Resolving reads `staff` — mutable — so putting
       * it in the material made an exact retry a different request the moment
       * a locum was added, and the receipt unreachable.
       *
       * `overrideReason` is material too, and was missing before the second
       * review: two requests differing only in why an override was allowed are
       * two decisions.
       */
      const bookingMaterial = {
        patientId, doctorId: optional(payload, 'doctorId'), typeId, reason,
        scheduledAt: moment.at, overrideReason,
      }
      /*
       * The booking's own copy of the reference it was made under.
       *
       * `appointment_bookings` has carried `idempotency_key` and
       * `request_fingerprint` since `20260920000000` and nothing wrote them
       * after the receipt took over, so the schema documented a mechanism that
       * was doing nothing — an invitation for a later slice to reuse it and
       * get no protection. They are written now: the receipt is still what
       * answers a retry, and this is the booking able to say, on its own, what
       * it was made under.
       */
      const bookingFingerprint = requestFingerprint({
        command: action, actor: session.staffId, ...bookingMaterial,
      })


      return await once(
        session, action, payload,
        bookingMaterial,
        async () => {
          // Both inside, because both read the clinic as it is now.
          requireInsideHorizon(moment)
          const doctorId = await resolveDoctor(session, payload)

          await db.prepare(
            `select pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}, hashtext(?))`,
          ).get(doctorId)

          const id = randomUUID()
          const duration = await durationOf(typeId)
          const placed = await clearSlot(session, {
            doctorId, startsAt: moment.at, durationMinutes: duration, overrideReason,
          })

          await db.prepare(
            `insert into appointment_bookings
               (id, patient_id, doctor_id, appointment_type_id, scheduled_at, duration_minutes,
                reason, status, overbooked, overbooked_reason, outside_availability, booked_by,
                idempotency_key, request_fingerprint)
             values (?,?,?,?,?::timestamptz,?,?,'booked',?,?,?,?,?,?)`,
          ).run(
            id, patientId, doctorId, typeId || null, moment.at, duration, reason,
            placed.overbooked, placed.overbookedReason, placed.outsideAvailability, session.staffId,
            referenceOf(payload), bookingFingerprint,
          )

          await recordEvent(session.staffId, 'booked', { bookingId: id }, {
            toStatus: 'booked',
            scheduledAtAfter: moment.at,
            typeAfter: typeId || null,
            durationAfter: duration,
            reason,
            override: placed,
          })
          await audit(session.staffId, 'appointment.booked', 'appointment_booking', id,
            `Booked ${moment.clinicDate}${placed.overbooked ? ' (overbooked)' : ''}`)

          // Owner item 77. One reminder at 18:00 the day before, or — when
          // that moment has already gone by — the confirmation that replaces
          // it. A row, not a send: see this file's header.
          await syncAppointmentSchedule({ actorId: session.staffId, bookingId: id })

          return {
            message: placed.overbooked
              ? `Booked for ${moment.clinicDate}, beside an appointment already in that slot.`
              : `Booked for ${moment.clinicDate}.`,
            data: {
              bookingId: id,
              doctorId,
              appointmentTypeId: typeId || null,
              scheduledAt: moment.at,
              durationMinutes: duration,
              overbooked: placed.overbooked,
              outsideAvailability: placed.outsideAvailability,
            },
            bookingId: id,
          }
        },
        // A replay says what the booking IS now, not only what it was when the
        // reference was spent: a retry arriving after the patient telephoned
        // and the booking was cancelled must not report "already booked" with
        // an id a screen renders as live.
        standingFor('book_appointment'),
      )
    }

    case 'reschedule_appointment': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const bookingId = value(payload, 'bookingId')
      const reason = value(payload, 'reason')
      const overrideReason = optional(payload, 'overrideReason')
      const moment = await clinicMoment(value(payload, 'scheduledAt'))
      const typeId = optional(payload, 'appointmentTypeId')

      return await once(
        session, action, payload,
        { bookingId, scheduledAt: moment.at, typeId, reason, overrideReason },
        async () => {
          // Inside, so a move that succeeded yesterday still replays today
          // rather than being told its own day is in the past.
          requireInsideHorizon(moment)

          /*
           * The calendar lock BEFORE the booking's row lock, and in the same
           * order `book_appointment` takes them. The doctor is read without a
           * lock because no command in this application changes a booking's
           * doctor, so there is nothing for the read to race with.
           */
          const owner = await db.prepare(
            'select doctor_id from appointment_bookings where id=?',
          ).get(bookingId) as Row | undefined
          if (!owner) throw new Error('That appointment was not found.')
          await db.prepare(
            `select pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}, hashtext(?))`,
          ).get(text(owner.doctor_id))

          const booking = await lockBooking(bookingId)
          const wasStatus = text(booking.status)
          if (wasStatus === 'cancelled' || wasStatus === 'no_show') {
            throw new CommandRefusal(
              `This appointment was ${wasStatus === 'cancelled' ? 'cancelled' : 'marked a no-show'} and is closed. ` +
              'Book a new one rather than moving a closed record.',
              'APPOINTMENT_CLOSED',
            )
          }
          requireMayChange(session, booking, 'reschedule')

          /*
           * The duration follows the type, and the type may be the only thing
           * changing.
           *
           * Slice 2 treated "same scheduled_at" as a duplicate and returned
           * without doing anything, so a request that moved an appointment
           * from a fifteen-minute slot to a forty-five-minute one AT THE SAME
           * TIME silently kept the old type and the old duration. Time is not
           * the whole of what a reschedule changes, and a retry is recognised
           * by its reference now rather than by the state it lands in.
           */
          const typeBefore = optional(booking, 'appointment_type_id') || null
          const typeAfter = typeId || typeBefore
          const durationBefore = Number(booking.duration_minutes)
          const durationAfter = typeId ? await durationOf(typeId) : durationBefore

          const placed = await clearSlot(session, {
            doctorId: text(booking.doctor_id),
            startsAt: moment.at,
            durationMinutes: durationAfter,
            overrideReason,
            exceptBookingId: bookingId,
          })

          /*
           * A patient who has already checked in is standing in the clinic
           * with a token. Moving their appointment to Thursday and leaving
           * them in Tuesday's queue is a queue that is wrong about the
           * building, so the arrival is cancelled — visibly, with the same
           * reason, in its own timeline — and the booking goes back to
           * `booked`. A visit already signed is not cancellable: the
           * consultation happened and there is nothing to move.
           */
          let cancelledArrival = ''
          if (wasStatus === 'checked_in') {
            const arrival = await arrivalOf(bookingId)
            if (arrival && text(arrival.status) === 'done') {
              throw new CommandRefusal(
                'This visit has already been seen and its consultation signed. There is nothing left to move; ' +
                'book a new appointment instead.',
                'VISIT_ALREADY_FINISHED',
              )
            }
            if (arrival && text(arrival.status) !== 'cancelled') {
              await db.prepare(`update appointments set status='cancelled' where id=?`).run(arrival.id)
              await recordEvent(session.staffId, 'cancelled', { arrivalId: text(arrival.id) }, {
                fromStatus: text(arrival.status), toStatus: 'cancelled', reason,
                detail: 'The appointment behind this visit was rescheduled.',
              })
              cancelledArrival = text(arrival.token)
            }
          }

          /*
           * The override is APPLIED, not merely validated.
           *
           * Slice 2 called `clearSlot` here and threw its answer away, so a
           * booking moved out of a conflict into a clear slot went on claiming
           * it was overbooked, and one moved INTO a conflict did not — with
           * the original booking's reason still attached either way. The
           * schema now refuses a flag without a sentence and a sentence
           * without a flag, so getting this wrong is a constraint violation
           * rather than a quiet lie.
           */
          await db.prepare(
            `update appointment_bookings
                set scheduled_at = ?::timestamptz,
                    duration_minutes = ?,
                    appointment_type_id = ?,
                    status = 'booked',
                    overbooked = ?,
                    overbooked_reason = ?,
                    outside_availability = ?,
                    checked_in_at = null,
                    checked_in_by = null
              where id = ?`,
          ).run(
            moment.at, durationAfter, typeAfter,
            placed.overbooked, placed.overbookedReason, placed.outsideAvailability,
            bookingId,
          )

          await recordEvent(session.staffId, 'rescheduled', { bookingId }, {
            fromStatus: wasStatus, toStatus: 'booked',
            scheduledAtBefore: text(booking.scheduled_at) || null,
            scheduledAtAfter: moment.at,
            typeBefore, typeAfter,
            durationBefore, durationAfter,
            reason,
            override: placed,
          })
          await audit(session.staffId, 'appointment.rescheduled', 'appointment_booking', bookingId,
            `Moved to ${moment.clinicDate}: ${reason}`)

          // The old reminder was about a time that is no longer true. It is
          // superseded rather than deleted, and the new time gets its own —
          // or its confirmation, if 18:00 the day before has now passed.
          await syncAppointmentSchedule({ actorId: session.staffId, bookingId })

          return {
            message: cancelledArrival
              ? `Moved to ${moment.clinicDate}. ${cancelledArrival} has been taken out of today's queue.`
              : `Moved to ${moment.clinicDate}. The previous time is kept in this appointment's history.`,
            data: {
              bookingId,
              appointmentTypeId: typeAfter,
              scheduledAt: moment.at,
              durationMinutes: durationAfter,
              overbooked: placed.overbooked,
              outsideAvailability: placed.outsideAvailability,
            },
            bookingId,
          }
        },
        standingFor('reschedule_appointment'),
      )
    }

    case 'cancel_appointment': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const bookingId = value(payload, 'bookingId')
      const reason = value(payload, 'reason')

      return await once(session, action, payload, { bookingId, reason }, async () => {
        const booking = await lockBooking(bookingId)
        const wasStatus = text(booking.status)
        if (wasStatus === 'cancelled' || wasStatus === 'no_show') {
          throw new CommandRefusal(
            wasStatus === 'cancelled'
              ? 'This appointment is already cancelled. Nothing was changed.'
              : 'This appointment is already closed as a no-show. Nothing was changed.',
            'APPOINTMENT_CLOSED',
          )
        }
        requireMayChange(session, booking, 'cancel')

        let cancelledArrival = ''
        if (wasStatus === 'checked_in') {
          const arrival = await arrivalOf(bookingId)
          if (arrival && text(arrival.status) === 'done') {
            throw new CommandRefusal(
              'This visit has already been seen and its consultation signed. A finished visit is not cancelled; ' +
              'the record stands.',
              'VISIT_ALREADY_FINISHED',
            )
          }
          if (arrival && text(arrival.status) !== 'cancelled') {
            await db.prepare(`update appointments set status='cancelled' where id=?`).run(arrival.id)
            await recordEvent(session.staffId, 'cancelled', { arrivalId: text(arrival.id) }, {
              fromStatus: text(arrival.status), toStatus: 'cancelled', reason,
              detail: 'The appointment behind this visit was cancelled.',
            })
            cancelledArrival = text(arrival.token)
          }
        }

        await db.prepare(`update appointment_bookings set status='cancelled' where id=?`).run(bookingId)
        await recordEvent(session.staffId, 'cancelled', { bookingId }, {
          fromStatus: wasStatus, toStatus: 'cancelled', reason,
        })
        await audit(session.staffId, 'appointment.cancelled', 'appointment_booking', bookingId,
          `Cancelled: ${reason}`)

        // Nothing to attend, so nothing to be reminded about.
        await syncAppointmentSchedule({ actorId: session.staffId, bookingId })

        return {
          message: cancelledArrival
            ? `Cancelled. ${cancelledArrival} has been taken out of today's queue, and the appointment keeps its history.`
            : 'Cancelled. The appointment keeps its history and is not deleted.',
          data: { bookingId },
          bookingId,
        }
      }, standingFor('cancel_appointment'))
    }

    case 'mark_no_show': {
      /*
       * Owner item 69: "An appointment becomes eligible for no-show review 30
       * minutes after its scheduled start. Nothing marks it automatically.
       * Nurse, doctor, or admin confirms the no-show, and the actor and time
       * are recorded."
       *
       * Both halves are enforced here. Nothing anywhere in this application
       * writes this status on a timer, and the thirty minutes is a floor on
       * when a person may confirm it rather than a moment at which anything
       * happens by itself.
       */
      requireRole(session, 'admin', 'doctor', 'nurse')
      const bookingId = value(payload, 'bookingId')
      const reason = optional(payload, 'reason')

      return await once(session, action, payload, { bookingId, reason }, async () => {
        const booking = await lockBooking(bookingId)
        const wasStatus = text(booking.status)
        if (wasStatus !== 'booked') {
          throw new CommandRefusal(
            wasStatus === 'checked_in'
              ? 'This patient checked in, so they did not fail to attend.'
              : `This appointment is already closed as ${wasStatus === 'no_show' ? 'a no-show' : 'cancelled'}.`,
            'APPOINTMENT_CLOSED',
          )
        }

        const eligible = await db.prepare(
          `select (?::timestamptz + make_interval(mins => ?)) <= now() as ready,
                  to_char(?::timestamptz at time zone 'Asia/Kolkata',
                          case when (?::timestamptz at time zone 'Asia/Kolkata')::date
                                    = ${CLINIC_TODAY}
                               then 'HH24:MI'
                               else 'DD Mon at HH24:MI' end) as at`,
        ).get(
          text(booking.scheduled_at), NO_SHOW_AFTER_MINUTES,
          text(booking.scheduled_at), text(booking.scheduled_at),
        ) as Row | undefined

        if (eligible?.ready !== true) {
          throw new CommandRefusal(
            `This appointment was for ${text(eligible?.at)} and a no-show can only be confirmed ` +
            `${NO_SHOW_AFTER_MINUTES} minutes after that. The patient may still be on their way.`,
            'TOO_EARLY_FOR_NO_SHOW',
          )
        }

        await db.prepare(`update appointment_bookings set status='no_show' where id=?`).run(bookingId)
        await recordEvent(session.staffId, 'no_show', { bookingId }, {
          fromStatus: wasStatus, toStatus: 'no_show', reason,
        })
        await audit(session.staffId, 'appointment.no_show', 'appointment_booking', bookingId,
          reason ? `Did not attend: ${reason}` : 'Did not attend')

        await syncAppointmentSchedule({ actorId: session.staffId, bookingId })

        return {
          message: 'Recorded as not attended. The appointment keeps its history.',
          data: { bookingId },
          bookingId,
        }
      }, standingFor('mark_no_show'))
    }

    case 'check_in_appointment': {
      /*
       * The one door between the future and the queue.
       *
       * Owner item 70: at check-in a booked patient and a walk-in "converge
       * into the same arrival/queue workflow and are ordered by actual
       * arrival/check-in time". So the arrival row is an ordinary
       * `jmc.appointments` row in every respect — token from the same
       * sequence, `scheduled_at` stamped NOW rather than copied from the
       * booking, status `waiting` — and from this moment nothing downstream
       * can tell it from a walk-in except by following `booking_id`.
       *
       * ── RETRYING, AND THE WAY SLICE 2 GOT IT WRONG ──────────────────────
       *
       * It used to decide "have I already checked this in?" by reading the
       * booking's status. The acceptance review reproduced what that costs:
       * check in, lose the reply, reschedule the appointment (which cancels
       * the arrival and puts the booking back to `booked`), and the lost
       * reply's retry arrives to find a `booked` booking — so it minted
       * JMC-0002 and dragged the booking back into `checked_in`.
       *
       * The receipt recognises the retry by its reference instead, and
       * `standing` tells it the truth: here is JMC-0001, which you did, and it
       * has since been cancelled. A genuinely new check-in after the
       * reschedule is a new reference and creates a new arrival normally.
       */
      requireRole(session, 'admin', 'doctor', 'nurse')
      const bookingId = value(payload, 'bookingId')

      return await once(session, action, payload, { bookingId }, async () => {
        const booking = await lockBooking(bookingId)
        const wasStatus = text(booking.status)

        if (wasStatus !== 'booked') {
          throw new CommandRefusal(
            wasStatus === 'checked_in'
              ? 'This patient is already in the queue under a different reference. Nothing was added twice.'
              : `This appointment is closed as ${wasStatus === 'no_show' ? 'a no-show' : 'cancelled'}. ` +
                'Add the patient to today’s queue directly, or book them again.',
            wasStatus === 'checked_in' ? 'CHECKED_IN_ALREADY' : 'APPOINTMENT_CLOSED',
          )
        }

        const arrivalId = randomUUID()
        const token = await sequence('JMC')
        const arrivedAt = isoNow()

        await db.prepare(
          `insert into appointments
             (id, patient_id, token, reason, scheduled_at, status, created_at, booking_id)
           values (?,?,?,?,?,'waiting',?,?)`,
        ).run(arrivalId, text(booking.patient_id), token, text(booking.reason), arrivedAt, arrivedAt, bookingId)

        await db.prepare(
          `update appointment_bookings
              set status='checked_in', checked_in_at = now(), checked_in_by = ?
            where id = ?`,
        ).run(session.staffId, bookingId)

        await recordEvent(session.staffId, 'checked_in', { bookingId }, {
          fromStatus: wasStatus, toStatus: 'checked_in', detail: `Queue token ${token}`,
        })

        /*
         * The same audit event `create_appointment` writes, and it has to be
         * the same one. `jmc.nurse_care_involvement` derives "this nurse was
         * involved in that patient's care" partly from
         * `entity_type='appointment'` and `action='appointment.created'`,
         * because the queue table records no author. A check-in that wrote a
         * different action would quietly deny a nurse access to the clinical
         * images of every patient they arrived through the calendar.
         */
        await audit(session.staffId, 'appointment.created', 'appointment', arrivalId,
          `Checked in appointment ${token}`)

        // The patient is standing in the clinic. A reminder tomorrow morning
        // about a visit that has already happened is worse than none.
        await syncAppointmentSchedule({ actorId: session.staffId, bookingId })

        return {
          message: `Checked in. Queue token ${token}.`,
          data: { arrivalId, token, bookingId },
          bookingId,
          arrivalId,
        }
      }, standingFor('check_in_appointment'))
    }

    /* ───────────────────────────────────────────── owner item 70 */

    case 'set_queue_priority': {
      /*
       * "A doctor may explicitly prioritize an urgent patient, with a required
       * reason and audit event."
       *
       * Doctor alone, and not admin: this is a clinical judgement about who is
       * sicker, which is the one thing on the queue that is not an
       * administrative fact. An admin who is also a doctor holds it through
       * the doctor role, as everywhere else here.
       */
      requireRole(session, 'doctor')
      const appointmentId = value(payload, 'appointmentId')
      const urgent = payload.urgent === undefined ? true : booleanValue(payload, 'urgent')
      const reason = value(payload, 'reason')

      return await once(session, action, payload, { appointmentId, urgent, reason }, async () => {
        const arrival = await db.prepare(
          `select id, token, status, urgent from appointments where id=? for update`,
        ).get(appointmentId) as Row | undefined
        if (!arrival) throw new Error('That visit was not found.')
        const status = text(arrival.status)
        if (status !== 'waiting' && status !== 'in_consult') {
          throw new CommandRefusal(
            'That visit is already finished or cancelled, so its place in the queue no longer decides anything.',
            'VISIT_NOT_OPEN',
          )
        }

        await db.prepare(
          `update appointments
              set urgent = ?, urgent_reason = ?, urgent_by = ?, urgent_at = ?
            where id = ?`,
        ).run(
          urgent, urgent ? reason : '', urgent ? session.staffId : null,
          urgent ? new Date().toISOString() : null, appointmentId,
        )

        await recordEvent(session.staffId, urgent ? 'prioritized' : 'priority_cleared',
          { arrivalId: appointmentId }, { fromStatus: status, toStatus: status, reason })
        await audit(session.staffId, urgent ? 'appointment.prioritized' : 'appointment.priority_cleared',
          'appointment', appointmentId,
          `${urgent ? 'Moved up' : 'Returned to arrival order'} ${text(arrival.token)}: ${reason}`)

        return {
          message: urgent
            ? 'Moved up the queue. The reason and your name are on the record.'
            : 'Returned to arrival order.',
          data: { appointmentId, urgent, reason: urgent ? reason : '' },
          arrivalId: appointmentId,
        }
      }, standingFor('set_queue_priority'))
    }

    default:
      return runInventoryCommand(session, action, payload)
  }
}

/* ────────────────────────────────────────────────────────── helpers */

/**
 * Eight hours, and the reason this is not owner policy.
 *
 * `20260920000000` wrote the ceiling under a heading citing owner item 65, and
 * item 65 decided the fifteen-minute default and the per-type override and said
 * nothing whatever about a maximum. It is an implementation bound against a
 * mistyped 4800 becoming an appointment that swallows the week. The acceptance
 * review caught the false attribution; the bound stays, the citation goes.
 */
function requireSaneDuration(minutes: number): void {
  if (minutes > MAX_DURATION_MINUTES) {
    throw new Error('An appointment type is at most eight hours long.')
  }
}

async function currentClinicDate(): Promise<string> {
  const row = await db.prepare(
    `select to_char(${CLINIC_TODAY}, 'YYYY-MM-DD') as today`,
  ).get() as Row | undefined
  return text(row?.today)
}

/**
 * How long this appointment is, decided once and copied.
 *
 * Owner item 65: fifteen minutes unless a type says otherwise, and a later
 * change to the type never reaches a booking already made. The number is read
 * here and written onto the row; nothing joins back.
 */
async function durationOf(typeId: string): Promise<number> {
  if (!typeId) return DEFAULT_DURATION_MINUTES
  const row = await db.prepare(
    'select duration_minutes, active from appointment_types where id=?',
  ).get(typeId) as Row | undefined
  if (!row) throw new Error('That appointment type was not found.')
  if (row.active !== true) throw new Error('That appointment type has been retired.')
  return Number(row.duration_minutes)
}

/**
 * What the thing a receipt names looks like NOW, and whether the act still
 * stands.
 *
 * ── WHY `superseded` HAS TO BE COMPUTED PER COMMAND ────────────────────────
 *
 * The first version answered it for one case: the booking row is missing.
 * Nothing ever deletes a booking — cancelling sets a status — so that branch
 * was dead, and `superseded` was reachable from check-in alone while the
 * contract promised it for every command. The independent review walked the
 * consequence: a reschedule retry arriving after a newer move replays
 * "Moved to 11:00" with no flag at all, and a screen implementing the contract
 * by reading `superseded` prints eleven o'clock as a live fact.
 *
 * "Still stands" is not one question. A cancellation stands while the booking
 * is cancelled. A move stands while the booking is at the time it moved to. A
 * priority stands while the visit carries it. So each command supplies the
 * comparison, and this only fetches the row and merges the answer.
 */
type Standing = Record<string, unknown>

/**
 * Whether the effect a receipt records still holds, compared field by field.
 *
 * The first version compared the scheduled instant alone, so a second
 * reschedule to the SAME time with a different appointment type replayed a
 * thirty-minute booking, reported the current duration as forty-five, and said
 * `superseded: false` in the same breath. The third acceptance review
 * reproduced it. An effect is everything the request wrote, so standing is
 * everything the request wrote, still being what it wrote.
 */
function bookingStanding(
  stillHolds: (row: Row, recorded: Record<string, unknown>) => boolean,
) {
  return async (receipt: Row): Promise<Standing> => {
    const bookingId = text(receipt.booking_id)
    if (!bookingId) return {}

    const row = await db.prepare(
      `select status,
              to_char(scheduled_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as at,
              -- The same shape the receipt recorded, produced by the same
              -- to_char as clinicMoment, so the comparison below is between two
              -- strings Postgres wrote rather than between a string and
              -- whatever the driver decided a timestamptz should become.
              to_char(scheduled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at_utc,
              duration_minutes, appointment_type_id,
              overbooked, outside_availability
         from appointment_bookings where id = ?`,
    ).get(bookingId) as Row | undefined
    // Unreachable today — nothing deletes a booking — and the honest answer if
    // it ever happens is that whatever was recorded does not stand.
    if (!row) return { superseded: true }

    const recorded = storedResult(receipt.result).data ?? {}
    return {
      currentStatus: text(row.status),
      currentScheduledAt: text(row.at),
      currentAppointmentTypeId: row.appointment_type_id ?? null,
      currentDurationMinutes: Number(row.duration_minutes),
      currentOverbooked: row.overbooked === true,
      currentOutsideAvailability: row.outside_availability === true,
      superseded: !stillHolds(row, recorded),
    }
  }
}

/**
 * The whole of what a booking or a reschedule wrote, still being what it wrote.
 *
 * The type is compared as an ID rather than through its duration, because two
 * types may run to the same number of minutes and moving between them is still
 * a change. A recorded value absent from an older receipt is treated as
 * agreeing, so a receipt written before this comparison existed does not read
 * as superseded for a field it never carried.
 */
function bookingEffectStands(row: Row, recorded: Record<string, unknown>): boolean {
  const status = text(row.status)
  if (status !== 'booked' && status !== 'checked_in') return false

  if (recorded.scheduledAt !== undefined) {
    /*
     * `at_utc` and not `scheduled_at`.
     *
     * The driver turns a timestamptz into a JavaScript `Date`, and
     * `String(date)` is `toString()`, which has no milliseconds — so a booking
     * made for 10:30:00.500 compared as 10:30:00.000 and an untouched booking
     * came back `superseded: true`, telling a tablet its committed work no
     * longer stood. Reproduced by the independent review.
     *
     * Both sides are now the same `to_char` output, and `Date.parse` of an ISO
     * string with a `Z` is exact, so a receipt written in either shape still
     * compares correctly.
     */
    const wanted = Date.parse(String(recorded.scheduledAt))
    const now = Date.parse(String(row.at_utc ?? ''))
    if (!Number.isFinite(wanted) || !Number.isFinite(now) || wanted !== now) return false
  }
  if (recorded.appointmentTypeId !== undefined
    && (recorded.appointmentTypeId ?? null) !== (row.appointment_type_id ?? null)) return false
  if (recorded.durationMinutes !== undefined
    && Number(recorded.durationMinutes) !== Number(row.duration_minutes)) return false
  if (recorded.overbooked !== undefined
    && recorded.overbooked !== (row.overbooked === true)) return false
  if (recorded.outsideAvailability !== undefined
    && recorded.outsideAvailability !== (row.outside_availability === true)) return false
  return true
}

/** A booking, and a move, stand on exactly the same terms: all of what they set. */
const bookingStillStands = bookingStanding(bookingEffectStands)
const moveStillStands = bookingStanding(bookingEffectStands)

/** A cancellation stands while the booking is cancelled. */
const cancellationStillStands = bookingStanding((row) => text(row.status) === 'cancelled')

/** A no-show stands while the booking is closed as one. */
const noShowStillStands = bookingStanding((row) => text(row.status) === 'no_show')

/**
 * A priority stands while the visit still carries what this request set, and
 * while the visit is still in the queue at all.
 *
 * The reason is compared as well as the flag: two doctors prioritising one
 * patient for different reasons are two decisions, and replaying the first
 * one's words about the second one's decision is the same false confidence
 * this whole mechanism is for.
 */
async function priorityStanding(receipt: Row): Promise<Standing> {
  const arrivalId = text(receipt.arrival_id)
  if (!arrivalId) return {}

  const row = await db.prepare(
    'select status, urgent, urgent_reason from appointments where id = ?',
  ).get(arrivalId) as Row | undefined
  if (!row) return { superseded: true }

  const recorded = storedResult(receipt.result).data ?? {}
  const open = text(row.status) === 'waiting' || text(row.status) === 'in_consult'
  const sameFlag = recorded.urgent === undefined || recorded.urgent === (row.urgent === true)
  const sameReason = recorded.reason === undefined
    || String(recorded.reason) === text(row.urgent_reason)
  return {
    currentVisitStatus: text(row.status),
    currentUrgent: row.urgent === true,
    currentUrgentReason: text(row.urgent_reason),
    superseded: !(open && sameFlag && sameReason),
  }
}

/*
 * ── WHY CREATION AND UPDATE SHARE ONE RULE AFTER ALL ──────────────────────
 *
 * The first correction gave creation its own: a creation stands while the row
 * exists, because a creation is superseded by nothing short of the row going
 * away. That was wrong twice over, and the independent review found it.
 *
 * Nothing deletes an appointment type — `update_appointment_type` sets
 * `active = false` and there is no delete — so "while the row exists" is the
 * constant `false`, which is the exact shape the review rejected as HIGH for
 * the update half. And a creation's stored MESSAGE is "Antenatal added, 30
 * minutes", which asserts a name and a duration rather than an existence. A
 * type since renamed and lengthened makes that sentence untrue, and a replay
 * hands the sentence straight back.
 *
 * So both are the same question — does every field this request set still say
 * what it set — and both store what they applied so it can be asked.
 */

/**
 * A type request stands while every field IT set still has the value it set.
 *
 * "It set" is the important half. An update that sent only a duration must not
 * be reported as superseded because somebody later renamed the type, and must
 * be reported as superseded the moment the duration moves. A creation set both
 * its name and its duration, so both are its business and neither more.
 */
async function appointmentTypeStands(receipt: Row): Promise<Standing> {
  const row = await appointmentTypeRow(receipt)
  if (!row) return { superseded: true }

  const applied = (storedResult(receipt.result).data?.applied ?? {}) as Record<string, unknown>
  const stands = (applied.name === undefined || String(applied.name) === text(row.name))
    && (applied.durationMinutes === undefined
      || Number(applied.durationMinutes) === Number(row.duration_minutes))
    && (applied.active === undefined || applied.active === (row.active === true))

  return { ...appointmentTypeNow(row), superseded: !stands }
}

async function appointmentTypeRow(receipt: Row): Promise<Row | undefined> {
  const id = String(storedResult(receipt.result).data?.appointmentTypeId ?? '')
  if (!id) return undefined
  return await db.prepare(
    'select name, duration_minutes, active from appointment_types where id = ?',
  ).get(id) as Row | undefined
}

const appointmentTypeNow = (row: Row): Standing => ({
  currentName: text(row.name),
  currentDurationMinutes: Number(row.duration_minutes),
  currentActive: row.active === true,
})

/** A published window stands while it is active; a retired one while it is not. */
function availabilityStanding(wantedActive: boolean) {
  return async (receipt: Row): Promise<Standing> => {
    const recorded = storedResult(receipt.result).data ?? {}
    const id = String(recorded.availabilityId ?? '')
    if (!id) return {}

    const row = await db.prepare(
      'select active from provider_availability where id = ?',
    ).get(id) as Row | undefined
    if (!row) return { superseded: true }

    return {
      currentActive: row.active === true,
      superseded: (row.active === true) !== wantedActive,
    }
  }
}


/**
 * What the check-in a receipt names looks like NOW, and whether it still holds.
 *
 * The one place `superseded` earns its keep. Check in, lose the reply,
 * reschedule the appointment — which cancels the arrival and puts the booking
 * back to `booked` — and the lost reply's retry arrives. It gets JMC-0001
 * back, because that is what it did, together with the fact that JMC-0001 is
 * cancelled and the patient is not in the queue. Slice 2 minted JMC-0002
 * instead and dragged the booking back into `checked_in`.
 */
async function checkInStanding(receipt: Row): Promise<Record<string, unknown>> {
  const arrivalId = text(receipt.arrival_id)
  const bookingId = text(receipt.booking_id)

  const arrival = arrivalId
    ? await db.prepare('select status, token from appointments where id = ?').get(arrivalId) as Row | undefined
    : undefined
  const booking = bookingId
    ? await db.prepare('select status from appointment_bookings where id = ?').get(bookingId) as Row | undefined
    : undefined

  const stillInTheQueue = arrival !== undefined && text(arrival.status) !== 'cancelled'
  const stillCheckedIn = booking !== undefined && text(booking.status) === 'checked_in'

  return {
    currentArrivalStatus: arrival ? text(arrival.status) : undefined,
    currentBookingStatus: booking ? text(booking.status) : undefined,
    superseded: !(stillInTheQueue && stillCheckedIn),
  }
}

/* ──────────────────────────────────────────── what one reference did ── */

/**
 * Which `standing` each command replays with, written down once.
 *
 * The replay inside `once()` and the outcome read below both ask "does what
 * this receipt recorded still hold?", and two copies of that answer are two
 * copies that can disagree — a screen told `superseded: false` by one and
 * `true` by the other about the same reference. So the switch above reads its
 * `standing` out of this table and so does the read, and there is nothing to
 * keep in step.
 */
const STANDING: Record<AppointmentCommandName, (receipt: Row) => Promise<Standing>> = {
  create_appointment_type: appointmentTypeStands,
  update_appointment_type: appointmentTypeStands,
  publish_availability: availabilityStanding(true),
  retire_availability: availabilityStanding(false),
  book_appointment: bookingStillStands,
  reschedule_appointment: moveStillStands,
  cancel_appointment: cancellationStillStands,
  mark_no_show: noShowStillStands,
  check_in_appointment: checkInStanding,
  set_queue_priority: priorityStanding,
}

function standingFor(command: AppointmentCommandName): (receipt: Row) => Promise<Standing> {
  return (receipt) => STANDING[command](receipt)
}

const isAppointmentCommand = (value: string): value is AppointmentCommandName =>
  Object.hasOwn(STANDING, value)

/** An instant the driver handed back as a `Date`, as the contract spells one. */
const isoOf = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value))

/**
 * Whether a request under this reference is being carried out right now.
 *
 * `once()` takes `pg_advisory_xact_lock(RECEIPT_LOCK_NAMESPACE, hashtext(key))`
 * before it reads the receipt a second time and holds it until it commits, so
 * a lock on that pair IS a request in flight. It is observed in `pg_locks`
 * rather than tried, for the reason `readReconciliation` gives: a read that
 * took the lock, even for an instant, could make a real request wait on it —
 * and `db` is a pool, so a session lock taken by one query and released by the
 * next may be released on the wrong connection. Nothing is acquired here.
 *
 * `classid` is the first key and `objid` the second; `hashtext` is a signed
 * int4 and `objid` an unsigned oid, so the mask converts the bit pattern
 * rather than the number. Filtered to this database because `pg_locks` is
 * cluster-wide. A waiter counts as well as a holder: both are a request that
 * has reached the clinic and not finished.
 */
async function referenceInFlight(key: string): Promise<boolean> {
  const row = await db.prepare(
    `select exists (
       select 1 from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())
          and classid = ${RECEIPT_LOCK_NAMESPACE}
          and objid = ((hashtext(?)::bigint) & 4294967295)::oid
          and objsubid = 2
     ) as held`,
  ).get(key) as Row | undefined
  return row?.held === true
}

/** Whose booking or visit a receipt touched, so a screen can name them itself. */
async function patientOfReceipt(receipt: Row): Promise<string | undefined> {
  const bookingId = text(receipt.booking_id)
  if (bookingId) {
    const row = await db.prepare(
      'select patient_id from appointment_bookings where id = ?',
    ).get(bookingId) as Row | undefined
    if (row) return text(row.patient_id)
  }
  const arrivalId = text(receipt.arrival_id)
  if (arrivalId) {
    const row = await db.prepare(
      'select patient_id from appointments where id = ?',
    ).get(arrivalId) as Row | undefined
    if (row) return text(row.patient_id)
  }
  return undefined
}

async function describeReceipt(
  session: SessionView,
  key: string,
  receipt: Row,
): Promise<AppointmentCommandOutcome> {
  /*
   * Actor-scoped, and not merely role-scoped.
   *
   * The fingerprint every receipt is matched against names its actor (§4.0:
   * "the actor is part of what a reference names"), so nobody but the person
   * who spent a reference can ever retry under it — a colleague's exact
   * request is `APPOINTMENT_REFERENCE_REUSED`. The only person with a use for
   * this answer is therefore that one person, and answering anybody else
   * would turn a recovery read into a way to read another member of staff's
   * receipts by guessing at keys. They are told the reference is not theirs,
   * which is all they need to stop using it.
   */
  if (text(receipt.actor_id) !== session.staffId) {
    return {
      key,
      state: 'not_yours',
      detail:
        'Another member of staff sent a request under this reference, so nothing about it is shown here ' +
        'and nothing you send under it can be carried out. Start again; this tablet will use a reference ' +
        'of its own.',
    }
  }

  const command = text(receipt.command)
  const stored = storedResult(receipt.result)
  const standing = isAppointmentCommand(command) ? await STANDING[command](receipt) : {}
  const message = text(stored.message)

  return {
    key,
    state: 'committed',
    command: isAppointmentCommand(command) ? command : undefined,
    at: isoOf(receipt.created_at),
    message,
    // The same merge `replayReceipt` makes, minus `duplicate`: this is a read
    // about a reference, not a second answer to a command.
    data: { ...(stored.data ?? {}), ...standing },
    bookingId: text(receipt.booking_id) || undefined,
    arrivalId: text(receipt.arrival_id) || undefined,
    patientId: await patientOfReceipt(receipt),
    detail: message,
  }
}

/**
 * What one appointment reference did, for the person who sent it.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 *
 * Every appointment command answers a lost reply by replaying its receipt —
 * but only to a retry of the EXACT request, and a tablet reloaded after a lost
 * reply no longer has the request. Rebuilding it would mean keeping the
 * patient, the time and the clinical reason in browser storage, which the
 * appointment station must not do. `view=outcome` was no help: it reads
 * encounters, dispenses, sales, payments and goods receipts and has never
 * read `appointment_command_receipts`, so a nurse was told their role "cannot
 * resolve a reference of this kind" and a doctor was told "nothing in the
 * clinic carries this reference" about a booking that had committed.
 *
 * So the tablet keeps the reference and nothing else, and asks this.
 *
 * ── WHAT EACH ANSWER LICENSES ─────────────────────────────────────────────
 *
 * `committed` settles it: the original outcome, and whether it still stands,
 * exactly as a replay would have carried them. `in_flight` licenses nothing
 * but looking again. `not_committed` is what the clinic held at the instant
 * it was asked — a request that has not yet reached the lock is invisible to
 * everybody — so it licenses sending again UNDER THE SAME REFERENCE, which is
 * safe whatever is still on its way: an identical request is answered with
 * the one outcome, and a different one is refused as a reused reference.
 * It never licenses a fresh reference for the same act.
 *
 * The receipt is read twice, either side of the lock check, because a request
 * can commit between the first read and the check; the second read is what
 * stops that one being reported as nothing at all.
 */
export async function readAppointmentCommandOutcome(
  session: SessionView,
  key: string,
): Promise<AppointmentCommandOutcome> {
  const trimmed = key.trim()

  const first = await receiptFor(trimmed)
  if (first) return await describeReceipt(session, trimmed, first)

  if (await referenceInFlight(trimmed)) {
    return {
      key: trimmed,
      state: 'in_flight',
      detail:
        'A request under this reference is being carried out right now and has not finished. ' +
        'Look again in a moment, and send nothing else under it until it has.',
    }
  }

  const second = await receiptFor(trimmed)
  if (second) return await describeReceipt(session, trimmed, second)

  return {
    key: trimmed,
    state: 'not_committed',
    detail:
      'Nothing has been recorded under this reference. Sending it again under the same reference is ' +
      'safe: however many copies reach the clinic, it is carried out once.',
  }
}
