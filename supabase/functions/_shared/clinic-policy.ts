/**
 * The numbers the owner decided, in one place, because two copies of a policy
 * are one copy too many.
 *
 * Each of these appears in a command that enforces it AND in a read model that
 * describes the same rule back to a screen. Held separately, they drift: a
 * clinic that changed the no-show window to twenty minutes and forgot the
 * second copy would offer a nurse a patient to mark absent and then refuse to
 * mark them, which is the shape of fault nobody reports because it looks like
 * the software being slow.
 *
 * This is a leaf module on purpose. `workspace.ts` is a read endpoint and must
 * not import the command chain to reach a constant; the clinic timezone stays
 * where it is (an SQL fragment repeated in six modules, with the reasoning
 * written out in each) because it is a fragment rather than a value and
 * changing it is a schema-wide decision rather than a policy edit.
 *
 * Every entry cites the owner item it comes from, or says plainly that it has
 * none. A number here wearing a citation that does not cover it is how an
 * implementation bound comes to be quoted back as clinic policy.
 */

/**
 * Owner policy register item 65. The duration of an appointment whose type
 * says nothing, and of a clinic that has defined no types at all.
 *
 * Copied onto each booking when it is made, never joined, because item 65 also
 * says "A type change does not rewrite the duration already recorded for an
 * existing booking".
 */
export const DEFAULT_DURATION_MINUTES = 15

/**
 * The longest an appointment type may be — and **not** an owner decision.
 *
 * Item 65 decided the fifteen-minute default and the per-type override and said
 * nothing whatever about a maximum. Eight hours is an implementation safety
 * bound against a mistyped 4800 becoming an appointment that swallows the week.
 *
 * It is the one entry in this file with no owner item behind it, and it says so
 * rather than borrowing item 65's, which is what `20260920000000` did and what
 * the acceptance review caught. A number here wearing somebody else's citation
 * is worse than a number with none.
 */
export const MAX_DURATION_MINUTES = 480

/**
 * Owner policy register item 66. How far ahead the clinic books, in
 * clinic-local calendar days, for booking and rescheduling alike.
 *
 * Also the widest range the calendar read will answer: a range wider than the
 * clinic can book into is a range nobody meant to ask for.
 */
export const BOOKING_HORIZON_DAYS = 90

/**
 * Owner policy register item 69. How long after its scheduled start an
 * appointment becomes eligible for no-show review.
 *
 * A floor on when a PERSON may confirm one, not a moment at which anything
 * happens by itself. Item 69: "Nothing marks it automatically."
 */
export const NO_SHOW_AFTER_MINUTES = 30

/* ─────────────────────────────── Slice 3A: patient messaging ────────────── */

/**
 * Owner policy register item 77. The hours a clinic-initiated message may be
 * dispatched in, in the clinic's own local time.
 *
 * "Business-initiated messages may be dispatched from 08:00 inclusive until
 * 20:00 exclusive." Both halves of that sentence matter and both are tested at
 * the boundary: 08:00:00 is inside and 20:00:00 is not.
 *
 * It binds a RETRY as well as a first send — item 77 again: "A delivery retry
 * is not a new reminder, may not cross the message's usefulness deadline, and
 * must still obey quiet hours."
 */
export const DISPATCH_WINDOW_START_HOUR = 8
export const DISPATCH_WINDOW_END_HOUR = 20

/**
 * Owner policy register item 77. The one appointment reminder, at 18:00
 * clinic-local on the day before.
 *
 * "Send at most one appointment reminder, at 18:00 on the previous
 * clinic-local day; if the booking or reschedule occurs after that point, its
 * confirmation replaces the reminder."
 */
export const APPOINTMENT_REMINDER_HOUR = 18

/**
 * Owner policy register item 77. The one clinician-selected recall, at 09:00
 * clinic-local on its due date.
 */
export const CLINICAL_RECALL_HOUR = 9

/**
 * Owner policy register item 79. "Retryable failures may make at most three
 * provider attempts within two hours."
 *
 * Two independent bounds and both are enforced: a fourth attempt is refused
 * however long ago the first was, and a third attempt more than two hours
 * after the first is refused however few there have been.
 */
export const MAX_PROVIDER_ATTEMPTS = 3
export const RETRY_WINDOW_MINUTES = 120

/**
 * Owner policy register item 79. "Any unresolved failure older than four
 * clinic hours escalates to the owner-doctor's queue."
 *
 * Measured from the first failed attempt, which is also when item 79 says the
 * admin's ownership begins.
 */
export const FAILURE_ESCALATION_HOURS = 4

/**
 * How long to wait before each retry — and **not** an owner decision.
 *
 * Item 79 decided the ceiling (three attempts) and the window (two hours) and
 * said nothing about the spacing inside them. Fifteen minutes and then forty
 * minutes is an implementation choice that fits three attempts comfortably
 * inside two hours with room for a slow first one, and it is stated here as
 * having no owner item behind it rather than borrowing item 79's. A number
 * wearing somebody else's citation is worse than a number with none.
 *
 * Indexed by the attempt that just failed: after attempt 1, wait [0]; after
 * attempt 2, wait [1]. There is no wait after attempt 3 because there is no
 * attempt 4.
 */
export const RETRY_BACKOFF_MINUTES = [15, 40] as const

/**
 * The hour a clinical recall stops being worth sending, on its due date — and
 * **not** an owner decision either.
 *
 * Item 77 decided the recall goes once at 09:00 on its due date and that there
 * are no repeat or chase messages. It did not say when a retry of that
 * message stops being useful, and the brief requires every message to have a
 * usefulness deadline. The end of the same day's dispatch window is the
 * narrowest defensible answer: it cannot become a second day's chase, which is
 * the thing item 77 actually forbids.
 *
 * An appointment message needs no such choice. Its deadline is the
 * appointment, which is a fact rather than a preference.
 */
export const RECALL_USEFUL_UNTIL_HOUR = DISPATCH_WINDOW_END_HOUR

/**
 * The clinic name that appears in consent evidence, and the version of the
 * wording it was given under.
 *
 * Meta's opt-in rule and owner item 78 both require the evidence to name the
 * exact business the patient will receive messages from. It is a constant here
 * rather than a column on `clinic_settings` because changing it changes what a
 * past consent means, and a past consent is evidence: a new name is a new
 * wording version and a new opt-in, not an UPDATE.
 */
export const CONSENT_CLINIC_NAME = 'Jayamurugan Clinic'
export const CONSENT_WORDING_VERSION = 'en-2026.09'

/* ────────────────────────── Slice 4: investigations, results and review ── */

/**
 * Owner policy register item 87. "Other unreviewed results escalate to the
 * owner-doctor after four clinic hours or at clinic closing, whichever is
 * earlier."
 *
 * This is the first half, and it is exact. It is measured from the moment the
 * report was received, and "four clinic hours" is read the way Slice 3A reads
 * the identical phrase in item 79: four elapsed hours, moved forward to the
 * next dispatch opening if they would land when nobody is there. One
 * interpretation used twice, rather than two that happen to agree today.
 */
export const UNREVIEWED_RESULT_ESCALATION_HOURS = 4

/**
 * Item 87's second half — and **this is not the clinic's closing time.**
 *
 * The item says "or at clinic closing, whichever is earlier". A daily
 * clinic-local closing time is an owner value, and the clinic has not supplied
 * one: `clinic_settings` has no such column, and `provider_availability` is
 * one doctor's optional published consulting windows rather than the clinic's
 * day — a clinic that has published none would have no closing time at all.
 *
 * So this is a conservative technical CEILING, and it takes its value from
 * owner item 77's messaging dispatch cutoff because that is the only daily
 * clinic-local boundary this application can prove. It is deliberately its own
 * constant rather than a second reference to `DISPATCH_WINDOW_END_HOUR`: the
 * two mean different things, they will stop being equal the day the owner
 * supplies a closing time, and a shared constant is how that change silently
 * moves the messaging window too.
 *
 * What it costs while it stands: a clinic that shuts at 18:00 has unreviewed
 * results reaching the owner-doctor at 20:00 rather than at closing, which is
 * later than item 87 intends and never later than the messaging day. The
 * four-hour half is unaffected and is usually the earlier of the two anyway.
 * Owner policy item 87 records the interpretation and what replaces it.
 */
export const RESULT_ESCALATION_CEILING_HOUR = 20

/**
 * Owner policy register item 87. "If it remains unacknowledged for 15
 * minutes, it remains visibly escalated to the owner-doctor and any explicitly
 * configured backup doctor, with a manual-escalation obligation."
 *
 * Fifteen minutes is the owner's number. What the clock does when it expires
 * is make a row appear in a queue and say that somebody owes a telephone call;
 * it releases nothing, reviews nothing and tells nobody. Item 87's own last
 * sentence: "Never automatically release or notify the patient merely because
 * time elapsed."
 *
 * **There is no explicitly configured backup doctor.** The clinic has
 * configured none and this application has nowhere to hold one, so the
 * escalation reaches the owner-doctor alone and the read model says so in a
 * field rather than letting a screen imply otherwise.
 */
export const CRITICAL_ACKNOWLEDGEMENT_MINUTES = 15

/**
 * The hour a result-ready notice stops being worth sending — and **not** an
 * owner decision.
 *
 * Item 88 decided what the message says and what has to be true before it
 * goes. It said nothing about when an undelivered one stops being worth
 * sending, and the schema requires every message to have a deadline. The end
 * of the same day's dispatch window is the narrowest defensible answer: after
 * that the honest thing is a telephone call, and the message becomes a row in
 * the admin's queue with `past_useful_by` against it rather than a notice
 * arriving two days late about a result the patient has since collected.
 *
 * Stated here as having no owner item behind it rather than borrowing item
 * 88's. A number wearing somebody else's citation is worse than a number with
 * none.
 */
export const RESULT_READY_USEFUL_UNTIL_HOUR = DISPATCH_WINDOW_END_HOUR
