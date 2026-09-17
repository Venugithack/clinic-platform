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
