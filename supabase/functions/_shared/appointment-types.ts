/**
 * What the appointment-book reads answer, described once for both halves.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Slice 2 kept these shapes beside the queries that build them in
 * `workspace.ts`, which was right while nothing consumed them. A screen does
 * now — the appointment station — and it cannot import `workspace.ts`, which
 * imports `db.ts`, which imports `npm:postgres`. A page that did would drag the
 * Deno runtime into a browser bundle.
 *
 * So this is a leaf, on the pattern `diagnostics-types.ts` set: **types only,
 * zero imports, zero runtime.** `workspace.ts` and `appointments.ts` import
 * from it, `types.ts` re-exports it, and `lib/types.ts` gets it for free.
 *
 * ── EVERY UNION IS WRITTEN OUT ────────────────────────────────────────────
 *
 * A screen that branches on a booking's status has to fail to compile when a
 * status is added, because the alternative is a branch that quietly treats a
 * new state as whichever old one it happened to fall through to — and on this
 * screen that is a future booking drawn as a patient in the queue.
 */

/** Owner items 68–70. `checked_in` means a queue row exists; nothing else does. */
export type BookingStatus = 'booked' | 'checked_in' | 'cancelled' | 'no_show'

export type CalendarBooking = {
  bookingId: string
  patientId: string
  patientName: string
  doctorId: string
  doctorName: string
  /** The booked instant, UTC ISO-8601 with milliseconds. */
  scheduledAt: string
  durationMinutes: number
  reason: string
  status: BookingStatus
  appointmentType?: string
  overbooked: boolean
  outsideAvailability: boolean
  /** The one sentence covering either override, whichever it was written for. */
  overbookedReason?: string
  checkedInAt?: string
  /** The queue row this booking became, once it became one. */
  arrivalId?: string
  arrivalToken?: string
  arrivalStatus?: string
  /** The most recent transition, so a row can say why it looks like that. */
  lastEvent?: { event: string; reason: string; by: string; at: string }
}

export type AvailabilityWindow = {
  availabilityId: string
  doctorId: string
  kind: 'open' | 'blocked'
  weekday?: number
  onDate?: string
  startsAt: string
  endsAt: string
  effectiveFrom?: string
  effectiveTo?: string
  note: string
}

export type Calendar = {
  from: string
  to: string
  bookings: CalendarBooking[]
  availability: AvailabilityWindow[]
  truncated: boolean
}

/** One transition, oldest first. Owner item 68's append-only history, read back. */
export type AppointmentHistoryEvent = {
  event: string
  reason: string
  detail: string
  by: string
  at: string
}

export type PatientAppointment = CalendarBooking & {
  history: AppointmentHistoryEvent[]
}

/** Every command that spends an appointment reference. */
export type AppointmentCommandName =
  | 'create_appointment_type'
  | 'update_appointment_type'
  | 'publish_availability'
  | 'retire_availability'
  | 'book_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'mark_no_show'
  | 'check_in_appointment'
  | 'set_queue_priority'

/**
 * What one appointment reference did, told only to the person who sent it.
 *
 *   committed       a receipt carries this reference. `data` is the ORIGINAL
 *                   outcome merged with what stands now — `superseded` and the
 *                   `current…` fields — exactly as a replay would carry them.
 *   not_committed   no receipt carries it and nothing held its lock when asked.
 *                   A statement about that instant, not about the future: a
 *                   request still on its way that has not yet reached the
 *                   clinic's lock is not visible to anybody. Sending the SAME
 *                   request under the SAME reference is safe either way.
 *   in_flight       a request under this reference is being carried out now.
 *   not_yours       somebody else's receipt carries it. Nothing about it is
 *                   shown, and nothing sent under it by this person can ever
 *                   succeed, because the reference names its actor.
 */
export type AppointmentOutcomeState = 'committed' | 'not_committed' | 'in_flight' | 'not_yours'

export type AppointmentCommandOutcome = {
  key: string
  state: AppointmentOutcomeState
  /** Which command spent it. Present only when `state` is `committed`. */
  command?: AppointmentCommandName
  /** When the receipt was written, UTC ISO-8601. */
  at?: string
  /** The command's own sentence, as it was first answered. */
  message?: string
  /** The original result, with `superseded` and `current…` merged over it. */
  data?: Record<string, unknown>
  bookingId?: string
  arrivalId?: string
  /** Whose booking or visit it was, so a screen can name them from its own register. */
  patientId?: string
  /** What to tell the person, in the clinic's words. */
  detail: string
}
