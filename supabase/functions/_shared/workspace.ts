/**
 * The reads a workspace opens with, answered by the clinic rather than by the
 * tablet.
 *
 * ── WHAT WAS HAPPENING INSTEAD ─────────────────────────────────────────────
 *
 * Every one of these answers is computed in the browser today, out of the
 * whole-clinic snapshot. `care-workspaces.tsx` filters the entire patient
 * register in memory on every keystroke. `due-now.tsx` builds the nurse's
 * worklist by joining snapshot arrays and ticking a clock. `shared-panels.tsx`
 * re-reduces every invoice in the clinic for a total that `patient_balances`
 * has already aggregated. That works because the snapshot carries everything,
 * and the snapshot carries everything because nothing else could answer.
 *
 * Two consequences. The payload grows without bound — `patients`, `medicines`,
 * `batches`, `suppliers` and `orders` are all top-level keys with no LIMIT,
 * re-sent in full to four tablets whenever anything in the clinic changes. And
 * a count and the list behind it are computed by different code over the same
 * stale array, so they can disagree and nothing notices.
 *
 * ── THE TWO RULES THIS MODULE IS BUILT ON ──────────────────────────────────
 *
 * **Nothing joins the snapshot.** Everything here is asked for when somebody
 * opens the thing that needs it, exactly as `inventory.ts` and `reports` are.
 * The snapshot's five unbounded collections do not become six.
 *
 * **A count and its drill-down are one definition.** Each work list below is a
 * single SELECT. The count is `count(*)` over that select and the drill-down
 * is that select with an order and a cap. They cannot disagree, because there
 * is nothing to keep in step — and all the counts are gathered in ONE
 * statement, so they are all read from one snapshot of the database rather
 * than from eleven moments a few milliseconds apart.
 *
 * ── AND ONE THING IT DOES NOT DO ───────────────────────────────────────────
 *
 * No stored status is written anywhere in this file. Every stage, every
 * obligation and every count is derived from the authoritative record — the
 * appointment, the reading, the signed line, the ledger, the bill. Where a
 * fact does not exist, this says so rather than guessing at one: see the note
 * on vitals under `visitProgress`, which is a real limitation of the schema
 * and is reported as such instead of being papered over.
 */
import { db } from './db.ts'
import { ATTEMPT_LOCK_NAMESPACE, ATTEMPT_RESOLUTION_LOCK_NAMESPACE } from './idempotency.ts'
import { hasRole } from './auth.ts'
import {
  CAPABILITIES, PATIENT_CONTEXT_SECTIONS, listsFor, maySee, mayUse,
  type CapabilityId, type PatientContextSection,
} from './capabilities.ts'
import type { Role, SessionView } from './types.ts'

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')
const num = (value: unknown) => Number(value ?? 0)
const optional = (value: unknown) => (value === null || value === undefined ? undefined : String(value))

/**
 * Today, in the clinic rather than in Greenwich — the same expression
 * `snapshot.ts`, `commands.ts`, `counter.ts`, `inventory.ts` and `reports`
 * each build for themselves. It is repeated here for the same reason they
 * repeat it and with the same wording, so that a read model and the command it
 * describes are never comparing against two different days.
 */
const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

/** The clinic day a TEXT ISO timestamp falls on. */
const clinicDateOf = (column: string) =>
  `((${column})::timestamptz at time zone 'Asia/Kolkata')::date`

/**
 * How many rows a drill-down may return.
 *
 * A hard cap and no cursor, which is the convention every other on-demand read
 * in this backend already follows — `reports` caps at 200, 500, 1000 and 2000
 * depending on the question, `inventory` at 100 and 500, and nothing in the
 * repository does keyset pagination. A work list is a list of things somebody
 * is about to do; two hundred of them is already a bad day, and the count
 * beside it is exact however long the list is, so nothing is hidden by the cap.
 */
const LIST_CAP = 200

/** How many patients a search may hand back. */
const SEARCH_CAP = 25

/**
 * How far ahead a batch counts as expiring.
 *
 * A hundred and eighty days, and not a number chosen here: it is what the
 * `expiry_and_holds` report has meant by expiring since Slice 6
 * (`reports/index.ts`). Picking a different horizon for the count would mean
 * the badge and the report disagreed about the same shelf.
 */
const EXPIRY_HORIZON_DAYS = 180

/**
 * Owner item 69's half hour, repeated here from `appointments.ts` for the same
 * reason `CLINIC_TODAY` is repeated in six modules: a read model and the
 * command it describes must not be able to disagree about the number. The
 * command refuses a no-show before this many minutes; these lists offer one
 * after exactly the same many.
 */
const NO_SHOW_AFTER_MINUTES = 30

/* ────────────────────────────────────────────────────────── the work lists */

type WorkList = {
  /** Clinic words, for the count and the list heading. */
  readonly label: string
  /** Whose work it is when it is outstanding. */
  readonly owner: Role
  /** One select. The count wraps it; the drill-down orders and caps it. */
  readonly select: string
  /** How the drill-down sorts — oldest or most urgent first, always. */
  readonly order: string
}

/**
 * Every actionable set, defined once.
 *
 * Actionable is the word that does the work. A count that includes something
 * nobody can act on is a number that trains people to ignore the badge, so
 * each of these is filtered down to what the role it belongs to could pick up
 * now. Two deliberate exclusions are worth naming:
 *
 * A prescription whose validity has run out still has medicine remaining on
 * it, and it is NOT on the counter's list, because policy register 18 says the
 * pharmacist cannot supply that remainder without a new or amended order. It
 * has not disappeared — it is an obligation on the patient (`safeExit`), which
 * is where an unfinishable thing belongs.
 *
 * A bill that is over-refunded, or cancelled and not at zero, is not on the
 * money list either. Policy register 55 is explicit that it is not an unpaid
 * bill and that filing the two in one queue is how it comes to be ignored. It
 * has its own list, and its own role.
 */
const WORK_LISTS: Record<string, WorkList> = {
  /*
   * Owner item 70, in the two places it reaches: "one queue ordered by actual
   * arrival/check-in time", and "a doctor may explicitly prioritize an urgent
   * patient, with a required reason".
   *
   * The reason is HERE and not on the snapshot. This list is gated on
   * `list.today_queue` — admin, doctor, nurse — while the snapshot's
   * appointment collection has no gate at all, so a clinical sentence about
   * why somebody went first belongs on this side of the line.
   *
   * `booking_id` says whether the patient was expected or walked in. Once
   * checked in, that is the only thing distinguishing the two, which is what
   * owner item 70's "converge into the same arrival/queue workflow" means in
   * the data.
   */
  'list.today_queue': {
    label: 'Waiting',
    owner: 'doctor',
    select: `
      select a.id, a.token, a.status, a.reason, a.scheduled_at,
             a.urgent, a.urgent_reason, a.urgent_at, us.name as urgent_by,
             a.booking_id,
             p.id as patient_id, p.name as patient_name
        from appointments a
        join patients p on p.id = a.patient_id
        left join staff us on us.id = a.urgent_by
       where a.status in ('waiting', 'in_consult')`,
    order: 'order by urgent desc, urgent_at, scheduled_at, token',
  },

  'list.vitals_missing': {
    label: 'No reading today',
    owner: 'nurse',
    select: `
      select a.id, a.token, a.status, a.scheduled_at,
             p.id as patient_id, p.name as patient_name
        from appointments a
        join patients p on p.id = a.patient_id
       where a.status in ('waiting', 'in_consult')
         and not exists (
           select 1 from vitals v
            where v.patient_id = a.patient_id
              and ${clinicDateOf('v.recorded_at')} = ${CLINIC_TODAY}
         )`,
    order: 'order by scheduled_at, token',
  },

  'list.observation_due': {
    label: 'Observation due',
    owner: 'nurse',
    select: `
      select b.id, b.label as bed, b.next_check_at, b.doctor_instructions,
             b.patient_id, p.name as patient_name
        from beds b
        left join patients p on p.id = b.patient_id
       where b.status = 'occupied'
         and b.next_check_at is not null
         and b.next_check_at <= now()`,
    order: 'order by next_check_at',
  },

  'list.observation_handoff': {
    label: 'Doctor asked for',
    owner: 'doctor',
    select: `
      select b.id, b.label as bed, b.handoff_requested_at, b.notes,
             b.patient_id, p.name as patient_name
        from beds b
        left join patients p on p.id = b.patient_id
       where b.handoff_requested_at is not null
         and b.handoff_resolved_at is null`,
    order: 'order by handoff_requested_at',
  },

  'list.prescriptions_needs_review': {
    label: 'Needs a doctor',
    owner: 'doctor',
    select: `
      select l.id, l.line_number, l.medicine_name_snapshot as medicine,
             rx.id as prescription_id, rx.prescription_number, rx.signed_at,
             rx.patient_id, p.name as patient_name
        from prescription_line_supply l
        join prescriptions rx on rx.id = l.prescription_id
        join patients p on p.id = rx.patient_id
       where l.supply_state = 'needs_review'`,
    order: 'order by signed_at',
  },

  'list.follow_ups_due': {
    label: 'Follow-up due',
    owner: 'doctor',
    select: `
      select f.id, f.due_date, f.note,
             f.patient_id, p.name as patient_name
        from follow_ups f
        join patients p on p.id = f.patient_id
       where f.status = 'open'
         and f.due_date <= ${CLINIC_TODAY}`,
    order: 'order by due_date',
  },

  'list.counter_waiting': {
    label: 'At the counter',
    owner: 'pharmacy',
    select: `
      select rx.id, rx.prescription_number, rx.signed_at,
             to_char(rx.valid_until, 'YYYY-MM-DD') as valid_until,
             rx.patient_id, p.name as patient_name,
             count(*) filter (where l.supplyable) as lines_waiting
        from prescriptions rx
        join patients p on p.id = rx.patient_id
        join prescription_line_supply l on l.prescription_id = rx.id
       where rx.valid_until >= ${CLINIC_TODAY}
       group by rx.id, rx.prescription_number, rx.signed_at, rx.valid_until, rx.patient_id, p.name
      having count(*) filter (where l.supplyable) > 0`,
    order: 'order by signed_at',
  },

  'list.payments_due': {
    label: 'Money due',
    owner: 'pharmacy',
    select: `
      select b.id, b.invoice_number, b.due, b.total, b.paid, b.payment_state, b.created_at,
             b.patient_id, p.name as patient_name
        from invoice_balances b
        left join patients p on p.id = b.patient_id
       where b.status <> 'void'
         and b.payment_state in ('unpaid', 'part_paid')
         and b.due > 0`,
    order: 'order by created_at',
  },

  'list.financial_review': {
    label: 'Financial review',
    owner: 'admin',
    select: `
      select q.invoice_id as id, q.invoice_number, q.review_state, q.out_of_balance,
             q.total, q.paid, q.created_at, q.patient_id, q.patient_name
        from financial_review_queue q`,
    order: 'order by created_at',
  },

  'list.expiring_soon': {
    label: 'Expiring',
    owner: 'pharmacy',
    select: `
      select b.id, b.batch_number, b.expiry, b.available_quantity,
             (b.expiry::date - ${CLINIC_TODAY}) as days_left,
             m.id as medicine_id, m.name as medicine,
             sup.name as supplier,
             -- A batch with no supplier on it has nobody to return to, so the
             -- answer is false rather than an arithmetic accident. Coalescing
             -- the window to zero on its own made a batch expiring today with
             -- no supplier read 0 <= 0, and told the pharmacist to return it
             -- to nobody.
             (sup.id is not null
               and (b.expiry::date - ${CLINIC_TODAY}) <= coalesce(sup.return_window_days, 0))
               as inside_return_window
        from batches b
        join medicines m on m.id = b.medicine_id
        left join suppliers sup on sup.id = b.received_from_supplier_id
       where b.available_quantity > 0
         and b.status = 'active'
         and b.expiry::date <= ${CLINIC_TODAY} + ${EXPIRY_HORIZON_DAYS}`,
    order: 'order by days_left, medicine',
  },

  'list.stock_count_open': {
    label: 'Count open',
    owner: 'pharmacy',
    select: `
      select id, reference, status, 'opening_count' as kind, started_at
        from opening_counts
       where status in ('counting', 'submitted', 'recount')
       union all
      select id, reference, status, 'stock_take' as kind, started_at::timestamptz
        from stock_takes
       where status in ('counting', 'submitted')`,
    order: 'order by started_at',
  },

  /*
   * Slice 2. Who is expected, and who did not come.
   *
   * Both read `appointment_bookings` and neither reads the queue: a booking is
   * not in the queue until it is checked in, which is owner item 70 and the
   * whole reason the two tables are separate. So a patient already checked in
   * leaves these lists and appears in `list.today_queue` instead, and nobody
   * is on both.
   *
   * `appointments_today` is bounded by the clinic day rather than by a
   * horizon, because the actionable set is the people who may walk through the
   * door in the next few hours. Tomorrow's bookings are a calendar, and a
   * calendar is a read somebody asks for rather than a count sitting on a
   * badge.
   */
  'list.appointments_today': {
    label: 'Expected today',
    owner: 'nurse',
    select: `
      select b.id, b.scheduled_at, b.duration_minutes, b.reason,
             b.overbooked, b.outside_availability,
             b.patient_id, p.name as patient_name,
             t.name as appointment_type,
             (b.scheduled_at + make_interval(mins => ${NO_SHOW_AFTER_MINUTES})) <= now() as late
        from appointment_bookings b
        join patients p on p.id = b.patient_id
        left join appointment_types t on t.id = b.appointment_type_id
       where b.status = 'booked'
         and (b.scheduled_at at time zone 'Asia/Kolkata')::date = ${CLINIC_TODAY}`,
    order: 'order by scheduled_at',
  },

  /*
   * Owner item 69: "An appointment becomes eligible for no-show review 30
   * minutes after its scheduled start. Nothing marks it automatically."
   *
   * So this is a REVIEW list and not a list of no-shows. Every row on it is a
   * patient a person still has to make a decision about, and the decision is
   * as often "check them in, they are standing right here" as it is "record
   * that they did not come". It deliberately overlaps `appointments_today`
   * for that reason: taking a late patient off the check-in list would hide
   * them from the person most likely to be looking at it when they arrive.
   *
   * It is not bounded to today. A booking from last Thursday that nobody ever
   * closed is exactly what this is for — it is the only thing in the clinic
   * that will ever notice it.
   */
  'list.no_show_review': {
    label: 'No-show review',
    owner: 'nurse',
    select: `
      select b.id, b.scheduled_at, b.reason,
             b.patient_id, p.name as patient_name,
             floor(extract(epoch from (now() - b.scheduled_at)) / 60)::int as minutes_late
        from appointment_bookings b
        join patients p on p.id = b.patient_id
       where b.status = 'booked'
         and (b.scheduled_at + make_interval(mins => ${NO_SHOW_AFTER_MINUTES})) <= now()`,
    order: 'order by scheduled_at',
  },
}

/** The lists, and the capability table, must name exactly the same things. */
export const WORK_LIST_IDS = Object.keys(WORK_LISTS) as CapabilityId[]

/* ─────────────────────────────────────────────────────────────── workload */

export type WorkloadCount = {
  id: string
  label: string
  owner: Role
  count: number
}

/**
 * Every count the caller may act on, read in one statement.
 *
 * One statement matters. Eleven separate queries are eleven moments, and a
 * patient who walks from the queue to the consulting room between the second
 * and the third is counted in both or in neither. A single SELECT with one
 * scalar subquery per list is evaluated against one snapshot of the database,
 * so the numbers on a screen are a description of the clinic at an instant
 * rather than of a few seconds of it.
 */
export async function readWorkload(session: SessionView): Promise<WorkloadCount[]> {
  const allowed = listsFor(session).filter((id) => Object.hasOwn(WORK_LISTS, id))
  if (allowed.length === 0) return []

  const columns = allowed
    .map((id, index) => `(select count(*) from (${WORK_LISTS[id].select}) as c${index}) as n${index}`)
    .join(',\n           ')

  const row = (await db.prepare(`select ${columns}`).get()) as Row

  return allowed.map((id, index) => ({
    id,
    label: WORK_LISTS[id].label,
    owner: WORK_LISTS[id].owner,
    count: num(row[`n${index}`]),
  }))
}

export type WorkListPage = {
  id: string
  label: string
  owner: Role
  /** The exact size of the actionable set — never the length of `rows`. */
  count: number
  /** At most `LIST_CAP` of them. */
  rows: Row[]
  /** True when the set is larger than the cap, so a screen can say so. */
  truncated: boolean
}

/**
 * One count, opened.
 *
 * The count is recomputed here rather than taken from `readWorkload`, and it is
 * computed from the same SELECT the rows come from, in the same statement-level
 * snapshot. That is what makes "every count reconciles with its drill-down"
 * true by construction rather than by testing it and hoping.
 */
export async function readWorkList(
  session: SessionView,
  id: CapabilityId,
): Promise<WorkListPage | null> {
  // `Object.hasOwn`, because `id` reaches here from a query string and
  // `WORK_LISTS['constructor']` is inherited rather than absent.
  const list = Object.hasOwn(WORK_LISTS, id) ? WORK_LISTS[id] : undefined
  if (!list || !mayUse(session, id)) return null

  /*
   * The count column is named `_actionable_count` and not `total`.
   *
   * `actionable.*` expands to whatever the list selects, and one of these
   * lists selects `invoice_balances.total` — so a column called `total` here
   * was silently overwritten by the bill's own total, and the payments badge
   * reported ₹300 as a count of three hundred bills. A leading underscore is
   * not a name any domain column in this schema uses, which is what makes the
   * expansion safe to sit beside.
   */
  const rows = (await db.prepare(
    `with actionable as (${list.select})
     select (select count(*) from actionable) as _actionable_count, actionable.*
       from actionable ${list.order} limit ${LIST_CAP}`,
  ).all()) as Row[]

  // An empty set still has to report its count, and there is no row to read it
  // from. Zero is the only answer a zero-row query can carry.
  const count = rows.length === 0 ? 0 : num(rows[0]._actionable_count)

  return {
    id,
    label: list.label,
    owner: list.owner,
    count,
    rows: rows.map(({ _actionable_count: _count, ...rest }) => rest),
    truncated: count > rows.length,
  }
}

/* ───────────────────────────────────────────────────────── patient search */

export type PatientHit = {
  patientId: string
  name: string
  /** Last four digits only. Enough to tell two of a name apart; not a register. */
  phoneEnding: string
  matchedOn: 'phone' | 'token' | 'id' | 'name'
  age?: number
  sex?: string
  token?: string
  arrivalStatus?: string
}

/**
 * Find a patient, on the server, bounded.
 *
 * ── WHAT IS MATCHED, AND WHY EACH ──────────────────────────────────────────
 *
 * The phone, on its last ten digits, because a number is written +91 98765
 * 43210 one day and 9876543210 the next. The token, because the thing in the
 * patient's hand is a slip with a number on it. The patient id, because that
 * is what one screen hands another. And the name, normalized the same way
 * `find_possible_duplicates` has always normalized it — whitespace collapsed,
 * lowercased — so that two parts of the application agree about what makes two
 * names the same.
 *
 * ── WHAT COMES BACK, AND WHY SO LITTLE ─────────────────────────────────────
 *
 * A name, four digits of a telephone, and where they are in the clinic today.
 * No diagnosis, no balance, no allergy, no address — a search result is a
 * disambiguation aid and not a patient record, and the record has its own
 * endpoint with its own gate. The phone is cut to its last four digits for
 * every role including admin: the full number is available where it is
 * actually needed and a list of search results is not that place.
 *
 * Age and sex are added for the roles that already receive them in the
 * snapshot, because "Kumar, 4" and "Kumar, 61" are two different people and a
 * nurse choosing between them needs to be able to tell.
 */
/**
 * One row per patient, and it is the best row.
 *
 * The branches are a UNION ALL, so a patient whose id somebody typed and whose
 * name also begins with it appears in two of them. Without the `distinct on`
 * that person came back twice, one line above the other, in a list whose
 * entire job is to tell two people apart — and every caller would have had to
 * de-duplicate a result set it did not build.
 *
 * `distinct on (h.id)` keeps one row per patient under its OWN ordering, which
 * is why `h.rank` leads that inner ORDER BY: rank 0 is a phone that matched
 * exactly and rank 3 is a name that merely starts with what was typed, so the
 * row kept is the strongest evidence the clinic has for showing this person,
 * and `matched_on` then tells the truth about why they are on the list. The
 * outer query puts the survivors back in rank order for display, which
 * `distinct on` cannot do itself.
 */
const RANKED_SHELL = `
    select best.id, best.name, best.phone, best.age, best.sex,
           best.rank, best.matched_on, best.token, best.arrival_status
      from (
        select distinct on (h.id)
               p.id, p.name, p.phone, p.age, p.sex, p.created_at,
               h.rank, h.matched_on,
               a.token, a.status as arrival_status
          from (%BRANCHES%) as h
          join patients p on p.id = h.id
          left join lateral (
            select x.token, x.status from appointments x
             where x.patient_id = p.id and x.status in ('waiting', 'in_consult')
             order by x.scheduled_at limit 1
          ) a on true
         order by h.id, h.rank
      ) best
     order by best.rank, best.created_at desc
     limit ${SEARCH_CAP}`

/**
 * The two statements a search can run, built once so a test can read the same
 * ones the clinic runs.
 *
 * Separated out for exactly one reason: the performance assertions in
 * `tests/characterization/workspace-performance.test.mjs` run `EXPLAIN` over
 * these, and a test that restated the SQL beside the implementation would
 * prove that a copy of the query uses an index. It would keep passing on the
 * day somebody edited the real one. Both halves now come from here.
 */
export function searchStatements(
  ranked: string,
  terms: { digits: string; trimmed: string; likeName: string },
): {
  indexed: { sql: string; params: string[] }
  fallback: { sql: string; params: string[] }
} {
  return {
    indexed: {
      sql: ranked.replace('%BRANCHES%', `
    select id, 0 as rank, 'phone' as matched_on from patients
     where ?::text <> '' and right(regexp_replace(phone, '\\D', '', 'g'), 10) = ?::text
    union all
    select x.patient_id, 1, 'token' from appointments x
     where x.token = upper(?::text) and x.status in ('waiting', 'in_consult')
    union all
    select id, 2, 'id' from patients where id = ?::text
    union all
    select id, 3, 'name' from patients
     where lower(regexp_replace(name, '\\s+', ' ', 'g')) like ?::text || '%' escape '\\'`),
      params: [terms.digits, terms.digits, terms.trimmed, terms.trimmed, terms.likeName],
    },
    fallback: {
      sql: ranked.replace('%BRANCHES%', `
      select id, 4 as rank, 'name' as matched_on from patients
       where lower(regexp_replace(name, '\\s+', ' ', 'g')) like '%' || ?::text || '%' escape '\\'`),
      params: [terms.likeName],
    },
  }
}

/** The shape every search statement is wrapped in. Exported for the same reason. */
export function searchRankedShell(): string {
  return RANKED_SHELL
}

export async function searchPatients(session: SessionView, query: string): Promise<PatientHit[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  /*
   * The last ten digits of whatever was typed, and the `slice` is the point.
   *
   * The index and the predicate both compare `right(digits_of_phone, 10)`, so
   * the query has to be cut the same way. Without it, a number typed the way it
   * is written on a card — +91 98765 43210 — became twelve digits, matched the
   * ten-digit expression nowhere, and fell through to a name scan that found
   * nobody. The contract says a phone matches "any formatting"; this is what
   * makes that true rather than true of the formats somebody happened to test.
   */
  const digits = trimmed.replace(/\D/g, '').slice(-10)
  const normalizedName = trimmed.toLowerCase().replace(/\s+/g, ' ')
  const detailed = maySee(session, 'demographics')

  /*
   * The name, made safe to put inside a LIKE.
   *
   * `%`, `_` and `\` are LIKE's own vocabulary, and a patient's name is not a
   * pattern somebody wrote — it is whatever they typed into a search box. Left
   * alone, `%` matches every patient in the clinic and the cap decides which
   * twenty-five come back, which is a way to page through the register without
   * knowing a single name; `_` quietly matches any character, so `Ab_` finds
   * Abu and Abi and reports both as an exact prefix; and a trailing `\` makes
   * the pattern malformed and the query raise. None of these is exotic input.
   * The counter's outcome lookup escapes its key for the same reason and with
   * the same three characters (`readOutcome` below); this is that rule applied
   * where the input is a person's name rather than a uuid.
   *
   * The backslash is replaced first — it is the escape character, so escaping
   * it after the others would escape the escapes. Every LIKE built from this
   * names its escape character explicitly. Postgres's default is already a
   * backslash, so this is not correcting a setting; it is saying out loud
   * which character the escaping above assumed, so that the two cannot drift
   * apart silently.
   */
  const likeName = normalizedName.replace(/([\\%_])/g, '\\$1')

  /*
   * Two statements, and the order of them is the whole point.
   *
   * The first asks only the questions an index can answer: an exact phone on
   * `patients_phone_digits`, a token on `appointments_token_idx`, the patient
   * id on the primary key, and a name PREFIX on `patients_normalized_name` —
   * whose expression is written below character for character as the migration
   * wrote it, because that is what makes a query qualify for an expression
   * index. They are separate branches of a UNION rather than one OR, because a
   * single OR containing even one unindexable branch makes Postgres scan the
   * whole table for all of them; a UNION lets each branch keep its own index.
   *
   * The second runs only when the first found nothing worth showing, and it is
   * the case no btree can serve: a surname typed on its own, matching in the
   * middle of a name. That is a sequential scan, bounded by the table and
   * capped like everything else. It is the honest cost of not having `pg_trgm`
   * installed, and it is paid on the searches that need it rather than on
   * every search — which is what the first version of this did by folding it
   * into the same OR, leaving the indexes it had just created unused.
   */
  const { indexed, fallback } = searchStatements(RANKED_SHELL, { digits, trimmed, likeName })

  let rows = (await db.prepare(indexed.sql).all(...indexed.params)) as Row[]

  if (rows.length === 0) {
    rows = (await db.prepare(fallback.sql).all(...fallback.params)) as Row[]
  }

  return rows.map((row) => ({
    patientId: text(row.id),
    name: text(row.name),
    phoneEnding: text(row.phone).replace(/\D/g, '').slice(-4),
    matchedOn: text(row.matched_on) as PatientHit['matchedOn'],
    ...(detailed ? { age: num(row.age), sex: text(row.sex) } : {}),
    ...(row.token ? { token: text(row.token), arrivalStatus: text(row.arrival_status) } : {}),
  }))
}

/**
 * The per-patient statements, named once so a test can EXPLAIN the real ones.
 *
 * Exported for the same reason `searchStatements` is: the performance
 * assertions restated these by hand, and the copies had already drifted from
 * production — the real vitals lookup carries a clinic-day predicate the copy
 * did not, and an extra expression in a WHERE is exactly the kind of thing
 * that changes a plan. A test that EXPLAINs its own paraphrase proves the
 * paraphrase is fast.
 */
export const PATIENT_READS = {
  /** The latest reading of any day — the patient band. */
  latestVitals:
    `select bp, temperature, pulse, spo2, weight, recorded_at, not_measured_note
       from vitals where patient_id = ? order by recorded_at desc limit 1`,
  /** Today's reading — the vitals stage. */
  vitalsToday:
    `select recorded_at, not_measured_note from vitals
      where patient_id = ? and ${clinicDateOf('recorded_at')} = ${CLINIC_TODAY}
      order by recorded_at desc limit 1`,
  /** Today's signed consultation — the consult stage. */
  encounterToday:
    `select id, created_at from encounters
      where patient_id = ? and ${clinicDateOf('created_at')} = ${CLINIC_TODAY}
      order by created_at desc limit 1`,
  /**
   * A consultation signed today that is attached to no visit, while a visit
   * for the same patient is still waiting.
   *
   * The residue of the case the second acceptance review found: a walk-in
   * signed from the register, the reply lost, the doctor creating today's
   * visit afterwards. The clinic refuses to sign it twice and says why, and
   * this is what stops the leftover visit being forgotten once that message
   * has been dismissed.
   *
   * BOTH sides are filtered to the clinic day. Without it, a `waiting` row
   * nobody cancelled last week plus any unlinked consultation today raised an
   * obligation whose words — "is still waiting in the queue" — were about a
   * queue row that has nothing to do with the consultation named beside it.
   * A stale arrival is a real problem and it is not this one.
   *
   * The visit's day is `scheduled_at` and NOT `created_at`, which is the
   * difference between when somebody is expected and when somebody typed it
   * in. Booked on `created_at`, an appointment made this morning for tomorrow
   * was reported as today's orphaned queue visit, and today's appointment
   * booked yesterday was missed — wrong in both directions at once. The
   * encounter keeps `created_at`, because a consultation has no scheduled time
   * and the moment it was signed IS its day.
   */
  unlinkedConsultationWithOpenVisit:
    `select e.id, a.token
       from encounters e
       join appointments a
         on a.patient_id = e.patient_id
        and a.status in ('waiting', 'in_consult')
        and ${clinicDateOf('a.scheduled_at')} = ${CLINIC_TODAY}
      where e.patient_id = ?
        and e.appointment_id is null
        and ${clinicDateOf('e.created_at')} = ${CLINIC_TODAY}
      order by a.scheduled_at limit 1`,
  /** The unsigned draft behind the consult stage. */
  latestDraft:
    'select updated_at from consultation_drafts where patient_id = ? order by updated_at desc limit 1',
  /** The band's own row. */
  patientRow: 'select id, name, phone, age, sex from patients where id = ?',
  /*
   * The two existence checks behind the safe-exit obligation. They are not the
   * same statements as the two above — no ordering, and only the columns the
   * question needs — so they are named separately rather than reused, and named
   * HERE so the plan test covers them too. Leaving them inline is how the
   * paraphrases this whole export exists to prevent get written again.
   */
  draftExists: 'select updated_at from consultation_drafts where patient_id = ? limit 1',
  encounterTodayExists:
    `select id from encounters
      where patient_id = ? and ${clinicDateOf('created_at')} = ${CLINIC_TODAY} limit 1`,
} as const

/* ──────────────────────────────────────────────────────── patient context */

export type PatientContext = {
  patientId: string
  /** Which sections this role was given, so a screen never guesses at absence. */
  sections: PatientContextSection[]
  identity?: { name: string; phoneEnding: string }
  demographics?: { age: number; sex: string }
  arrival?: { token: string; status: string; scheduledAt: string } | null
  vitals?: {
    recordedAt: string
    bp?: string; temperature?: number; pulse?: number; spo2?: number; weight?: number
    notMeasuredNote: string
  } | null
  clinicalAlerts?: { allergyStatus: string; allergyNotes: string; clinicalFlags: string }
  supply?: { prescriptionsWaiting: number; linesWaiting: number }
  money?: { outstanding: string; openInvoices: number; underReview: number }
}

/**
 * The band above a patient, assembled section by section from the gates that
 * already govern each fact.
 *
 * There is no single shape here and that is the point. A pharmacist gets a
 * name, four digits and what is owed. A doctor gets the allergy status and no
 * balance, because a doctor does not collect and the snapshot has never sent
 * one. A nurse gets the reading and the token and neither the allergy note nor
 * the money. Each of those boundaries already existed; this reproduces them
 * rather than deciding them, and `PATIENT_CONTEXT_SECTIONS` is where each one
 * is written down with the gate it was copied from.
 *
 * `sections` travels with the answer so that a screen can tell "this patient
 * has no allergy recorded" from "your role is not shown allergies" — which are
 * very different sentences to put above a prescription.
 */
export async function readPatientContext(
  session: SessionView,
  patientId: string,
): Promise<PatientContext | null> {
  const patient = (await db.prepare(PATIENT_READS.patientRow)
    .get(patientId)) as Row | undefined
  if (!patient) return null

  const sections = (Object.keys(PATIENT_CONTEXT_SECTIONS) as PatientContextSection[])
    .filter((section) => maySee(session, section))

  const context: PatientContext = { patientId: text(patient.id), sections }

  if (maySee(session, 'identity')) {
    context.identity = {
      name: text(patient.name),
      phoneEnding: text(patient.phone).replace(/\D/g, '').slice(-4),
    }
  }

  if (maySee(session, 'demographics')) {
    context.demographics = { age: num(patient.age), sex: text(patient.sex) }
  }

  if (maySee(session, 'arrival')) {
    const arrival = (await db.prepare(
      `select token, status, scheduled_at from appointments
        where patient_id = ? and status in ('waiting', 'in_consult')
        order by scheduled_at limit 1`,
    ).get(patientId)) as Row | undefined
    context.arrival = arrival
      ? {
        token: text(arrival.token),
        status: text(arrival.status),
        scheduledAt: text(arrival.scheduled_at),
      }
      : null
  }

  if (maySee(session, 'vitals')) {
    const reading = (await db.prepare(PATIENT_READS.latestVitals)
      .get(patientId)) as Row | undefined
    context.vitals = reading
      ? {
        recordedAt: text(reading.recorded_at),
        // Null is "not measured" and is carried as absence, not as a zero.
        // A pulse of 0 and a pulse nobody took are not the same reading.
        ...(reading.bp === null ? {} : { bp: text(reading.bp) }),
        ...(reading.temperature === null ? {} : { temperature: num(reading.temperature) }),
        ...(reading.pulse === null ? {} : { pulse: num(reading.pulse) }),
        ...(reading.spo2 === null ? {} : { spo2: num(reading.spo2) }),
        ...(reading.weight === null ? {} : { weight: num(reading.weight) }),
        notMeasuredNote: text(reading.not_measured_note),
      }
      : null
  }

  if (maySee(session, 'clinical_alerts')) {
    const profile = (await db.prepare(
      `select allergy_status, allergy_notes, clinical_flags
         from patient_clinical_profiles where patient_id = ?`,
    ).get(patientId)) as Row | undefined
    context.clinicalAlerts = {
      // `not_recorded` is the schema's own default and means nobody has asked,
      // which is different from `no_known` and must not be flattened into it.
      allergyStatus: text(profile?.allergy_status ?? 'not_recorded'),
      allergyNotes: text(profile?.allergy_notes ?? ''),
      clinicalFlags: text(profile?.clinical_flags ?? ''),
    }
  }

  if (maySee(session, 'supply')) {
    const supply = (await db.prepare(
      `select count(distinct rx.id)::int as prescriptions, count(*)::int as lines
         from prescriptions rx
         join prescription_line_supply l on l.prescription_id = rx.id
        where rx.patient_id = ? and l.supplyable and rx.valid_until >= ${CLINIC_TODAY}`,
    ).get(patientId)) as Row | undefined
    context.supply = {
      prescriptionsWaiting: num(supply?.prescriptions),
      linesWaiting: num(supply?.lines),
    }
  }

  if (maySee(session, 'money')) {
    const balance = (await db.prepare(
      `select outstanding, open_invoices, under_review_invoices
         from patient_balances where patient_id = ?`,
    ).get(patientId)) as Row | undefined
    context.money = {
      // Money as the exact string Postgres holds. Parsing a numeric(12,2) into
      // a JavaScript number is how a rupee goes missing.
      outstanding: text(balance?.outstanding ?? '0.00'),
      openInvoices: num(balance?.open_invoices),
      underReview: num(balance?.under_review_invoices),
    }
  }

  return context
}

/* ────────────────────────────────────────────── visit progress and exits */

export type StageState =
  | 'not_started' | 'in_progress' | 'done' | 'blocked' | 'not_applicable' | 'withheld'

export type VisitStage = {
  stage: 'arrival' | 'vitals' | 'consult' | 'counter' | 'payment' | 'follow_up'
  state: StageState
  /** Whose move it is while the stage is open. */
  owner: Role
  detail: string
  /** How long it has been sitting there, in whole minutes, where knowable. */
  ageMinutes?: number
  /** The next safe thing to do, in clinic words. Never an instruction to a doctor. */
  nextAction?: string
}

const minutesSince = (value: unknown): number | undefined => {
  if (!value) return undefined
  const at = new Date(String(value)).getTime()
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, Math.floor((Date.now() - at) / 60_000))
}

/**
 * Where a patient's visit has reached, derived and never stored.
 *
 * ── THE ONE THING THIS CANNOT DO, STATED RATHER THAN GUESSED ───────────────
 *
 * `vitals` carries a patient and a time and NOTHING that ties a reading to a
 * visit — no appointment id, no encounter id. So "were this visit's vitals
 * taken" is not a question the schema can answer. What it can answer is
 * "was anything recorded for this patient today", and that is what the vitals
 * stage reports, in those words. For a patient who attends twice in one day
 * the two are not the same, and inventing the link would mean writing a
 * column that guesses — which is exactly the mutable duplicate status the
 * programme forbids. The honest fix is a foreign key on `vitals`, and it
 * belongs to a slice that may change that table.
 *
 * ── THREE STAGES ARE THE DAY, AND THREE ARE THE PATIENT ────────────────────
 *
 * Arrival, vitals and consult are filtered to the clinic day: they describe
 * today. Counter, payment and follow-up are not, and deliberately so — a
 * prescription signed last week with medicine still on it, and a balance
 * carried from a visit in August, are both genuinely outstanding and both
 * genuinely somebody's next move. Scoping them to today would hide them on the
 * one screen whose job is to say what is unfinished.
 *
 * But it does mean these three are NOT statements about this visit, and the
 * wording says so — "on this patient's account", not "for this visit". A
 * caller must not render them as today's progress, and the frontend contract
 * repeats the distinction where somebody building a screen will meet it.
 *
 * ── WITHHELD IS A STATE ────────────────────────────────────────────────────
 *
 * A doctor is not shown the counter and the bill, because the doctor's
 * snapshot has never carried prescriptions or invoices and this is not the
 * place to change who may read money. The stage still appears, still names the
 * role that owns it, and reports `withheld` instead of a status. That leaks
 * nothing — every visit has a counter stage — and it means the doctor can see
 * that the next move is somebody else's without being told what it is.
 */
export async function readVisitProgress(
  session: SessionView,
  patientId: string,
): Promise<VisitStage[] | null> {
  const exists = await db.prepare('select id from patients where id = ?').get(patientId)
  if (!exists) return null

  const stages: VisitStage[] = []

  /* Arrival */
  const arrival = (await db.prepare(
    `select token, status, scheduled_at from appointments
      where patient_id = ? and status in ('waiting', 'in_consult')
      order by scheduled_at limit 1`,
  ).get(patientId)) as Row | undefined

  if (!maySee(session, 'arrival')) {
    stages.push({ stage: 'arrival', state: 'withheld', owner: 'nurse', detail: 'Not shown to your role.' })
  } else if (!arrival) {
    stages.push({
      stage: 'arrival', state: 'not_started', owner: 'nurse',
      detail: 'No visit open for this patient.',
      nextAction: 'Create today’s visit if they have arrived.',
    })
  } else {
    stages.push({
      stage: 'arrival',
      state: text(arrival.status) === 'in_consult' ? 'done' : 'in_progress',
      owner: 'nurse',
      detail: `${text(arrival.token)} · ${text(arrival.status) === 'in_consult' ? 'called in' : 'waiting'}`,
      ageMinutes: minutesSince(arrival.scheduled_at),
    })
  }

  /* Vitals — for the clinic day, which is the most the schema can say. */
  if (!maySee(session, 'vitals')) {
    stages.push({ stage: 'vitals', state: 'withheld', owner: 'nurse', detail: 'Not shown to your role.' })
  } else {
    const reading = (await db.prepare(PATIENT_READS.vitalsToday)
      .get(patientId)) as Row | undefined
    stages.push(reading
      ? {
        stage: 'vitals', state: 'done', owner: 'nurse',
        detail: text(reading.not_measured_note)
          ? `Recorded today · ${text(reading.not_measured_note)}`
          : 'Recorded today',
        ageMinutes: minutesSince(reading.recorded_at),
      }
      : {
        stage: 'vitals', state: 'not_started', owner: 'nurse',
        detail: 'Nothing recorded for this patient today.',
        nextAction: 'Record what can be measured; Not measured is a valid answer.',
      })
  }

  /*
   * Consult, gated on `consultation_progress` — its own capability, and not
   * the allergy one it happens to share a role list with.
   *
   * This stage reads `encounters` and `consultation_drafts`. `encounters` is
   * behind `clinicalRecord` in the snapshot — doctor alone — and a draft
   * reaches a screen only through the `record` endpoint, which is also doctor
   * alone. So "a consultation draft is saved for this patient" and "a
   * consultation was signed for this patient today" are two facts a nurse has
   * no existing route to, and a read model is not the place to open one.
   * Gating on `arrival` instead would have handed both to every nurse and
   * administrator, which is the widening this slice's own rule forbids.
   *
   * It was gated on `clinical_alerts` until this correction. That was the same
   * role list reached by the wrong name, and the cost of the wrong name is
   * that granting a nurse allergy access — which the owner may well do —
   * would silently have granted them the doctor's draft status too. See the
   * entry in `capabilities.ts`.
   */
  if (!maySee(session, 'consultation_progress')) {
    stages.push({ stage: 'consult', state: 'withheld', owner: 'doctor', detail: 'Not shown to your role.' })
  } else {
    const encounter = (await db.prepare(PATIENT_READS.encounterToday)
      .get(patientId)) as Row | undefined
    const draft = (await db.prepare(PATIENT_READS.latestDraft)
      .get(patientId)) as Row | undefined

    stages.push(encounter
      ? {
        stage: 'consult', state: 'done', owner: 'doctor',
        detail: 'Signed today.',
        ageMinutes: minutesSince(encounter.created_at),
      }
      : draft
        ? {
          stage: 'consult', state: 'in_progress', owner: 'doctor',
          detail: 'Draft saved and still unsigned.',
          ageMinutes: minutesSince(draft.updated_at),
          nextAction: 'Open the draft and sign it, or discard it.',
        }
        : {
          stage: 'consult', state: 'not_started', owner: 'doctor',
          detail: 'No consultation today.',
        })
  }

  /* Counter */
  if (!maySee(session, 'supply')) {
    stages.push({ stage: 'counter', state: 'withheld', owner: 'pharmacy', detail: 'Not shown to your role.' })
  } else {
    const supply = (await db.prepare(
      `select
         count(*) filter (where l.supplyable and rx.valid_until >= ${CLINIC_TODAY})::int as waiting,
         count(*) filter (where l.supplyable and rx.valid_until < ${CLINIC_TODAY})::int as expired,
         count(*)::int as lines,
         min(rx.signed_at) filter (where l.supplyable) as oldest
        from prescriptions rx
        join prescription_line_supply l on l.prescription_id = rx.id
       where rx.patient_id = ?`,
    ).get(patientId)) as Row | undefined

    const waiting = num(supply?.waiting)
    const expired = num(supply?.expired)
    const lines = num(supply?.lines)

    stages.push(lines === 0
      ? { stage: 'counter', state: 'not_applicable', owner: 'pharmacy', detail: 'Nothing prescribed.' }
      : expired > 0 && waiting === 0
        ? {
          stage: 'counter', state: 'blocked', owner: 'doctor',
          detail: `${expired} line${expired === 1 ? '' : 's'} left over after the prescription’s validity ran out.`,
          nextAction: 'The remainder needs a new or amended order from the doctor.',
        }
        : waiting > 0
          ? {
            stage: 'counter', state: 'in_progress', owner: 'pharmacy',
            detail: `${waiting} line${waiting === 1 ? '' : 's'} still to supply on this patient's account.`,
            ageMinutes: minutesSince(supply?.oldest),
            nextAction: 'Open the prescription at the counter.',
          }
          : {
            stage: 'counter', state: 'done', owner: 'pharmacy',
            detail: 'Everything ever prescribed for this patient is accounted for.',
          })
  }

  /* Payment */
  if (!maySee(session, 'money')) {
    stages.push({ stage: 'payment', state: 'withheld', owner: 'pharmacy', detail: 'Not shown to your role.' })
  } else {
    const money = (await db.prepare(
      `select outstanding, open_invoices, under_review_invoices
         from patient_balances where patient_id = ?`,
    ).get(patientId)) as Row | undefined
    const outstanding = Number(text(money?.outstanding ?? '0'))
    const underReview = num(money?.under_review_invoices)

    stages.push(underReview > 0
      ? {
        stage: 'payment', state: 'blocked', owner: 'admin',
        detail: `${underReview} bill${underReview === 1 ? '' : 's'} under financial review.`,
        nextAction: 'An accountant-approved correction is needed; nothing here settles it.',
      }
      : outstanding > 0
        ? {
          stage: 'payment', state: 'in_progress', owner: 'pharmacy',
          detail: `₹${text(money?.outstanding)} outstanding on this patient's account.`,
          nextAction: 'Take payment at the counter, or leave it pending.',
        }
        : { stage: 'payment', state: 'done', owner: 'pharmacy', detail: 'Nothing owed.' })
  }

  /* Follow-up */
  if (!maySee(session, 'arrival')) {
    stages.push({ stage: 'follow_up', state: 'withheld', owner: 'doctor', detail: 'Not shown to your role.' })
  } else {
    /*
     * Both the date and the comparison are done in Postgres, deliberately.
     *
     * `follow_ups.due_date` is a `date`, and the driver hands a `date` back as
     * a JavaScript `Date` — so comparing it as a string compares "Mon Sep 14
     * 2026 00:00:00 GMT+0000" against "2026-09-14", and the weekday initial
     * sorts above the century digit, so the comparison is false for every
     * follow-up that has ever existed. An overdue reminder would read as not
     * started and never become an obligation.
     *
     * And the day it is compared against is the CLINIC's, not the server's.
     * Between midnight and half past five in the morning UTC is still on
     * yesterday's date, which is exactly the stretch when the clinic is being
     * opened up. `CLINIC_TODAY` is the same expression every other module here
     * builds for itself, for the same reason.
     */
    const followUp = (await db.prepare(
      `select to_char(due_date, 'YYYY-MM-DD') as due_date, note,
              (due_date <= ${CLINIC_TODAY}) as due_now
         from follow_ups
        where patient_id = ? and status = 'open' order by due_date limit 1`,
    ).get(patientId)) as Row | undefined
    stages.push(followUp
      ? {
        stage: 'follow_up',
        state: followUp.due_now === true ? 'in_progress' : 'not_started',
        owner: 'doctor',
        detail: `Due ${text(followUp.due_date)}`,
      }
      : { stage: 'follow_up', state: 'not_applicable', owner: 'doctor', detail: 'None arranged.' })
  }

  return stages
}

export type Obligation = {
  kind: string
  severity: 'pending' | 'blocked'
  detail: string
  owner: Role
}

/**
 * What is still unresolved before leaving this patient.
 *
 * The same facts as `readVisitProgress`, asked the other way round: not "where
 * has this reached" but "what would I be walking away from". A workspace uses
 * it when somebody closes a patient, which is the moment the unfinished thing
 * is cheapest to notice and most expensive to miss.
 *
 * `pending` is work somebody can pick up now. `blocked` is work that needs a
 * decision from a named role before it can move — an expired remainder needing
 * the doctor, a bill under financial review needing the accountant. The two
 * are kept apart on purpose: a list that files them together teaches people
 * that the list contains things nobody can do anything about.
 *
 * Only obligations the caller's role may be told about appear. A doctor
 * closing a patient is not shown the balance, so it is not listed — which
 * means this answer is a statement about what THIS role still owes, not about
 * the clinic. The payment and counter stages in `readVisitProgress` say
 * `withheld` for the same caller, so nothing about the existence of the other
 * work is concealed.
 */
export async function readSafeExit(
  session: SessionView,
  patientId: string,
): Promise<Obligation[] | null> {
  const stages = await readVisitProgress(session, patientId)
  if (!stages) return null

  const obligations: Obligation[] = []
  for (const stage of stages) {
    if (stage.state === 'in_progress' || stage.state === 'blocked') {
      // An arrival that is merely waiting is not an obligation — it is the
      // normal state of somebody in a waiting room, and listing it would put a
      // line on every patient in the clinic.
      if (stage.stage === 'arrival') continue
      obligations.push({
        kind: stage.stage,
        severity: stage.state === 'blocked' ? 'blocked' : 'pending',
        detail: stage.nextAction ? `${stage.detail} ${stage.nextAction}` : stage.detail,
        owner: stage.owner,
      })
    }
  }

  // `consultation_progress`, not `clinical_alerts`: an unsigned draft is the
  // state of the doctor's work and not a clinical fact about the patient.
  if (maySee(session, 'consultation_progress')) {
    const unsigned = await db.prepare(PATIENT_READS.draftExists).get(patientId)
    const signedToday = await db.prepare(PATIENT_READS.encounterTodayExists).get(patientId)
    if (unsigned && !signedToday) {
      obligations.push({
        kind: 'unsigned_draft',
        severity: 'pending',
        owner: 'doctor',
        detail: 'A consultation draft is saved and not signed. Pharmacy cannot see it and nothing is charged.',
      })
    }

    /*
     * A consultation signed today, attached to no visit, and a visit for the
     * same patient still sitting in the queue.
     *
     * The clinic refuses to sign that twice and says so at the moment it
     * happens, but a refusal is read once and dismissed. This is the same
     * fact written down where it survives: the queue row is real, nobody is
     * coming to call it, and somebody has to close it.
     *
     * `blocked`, not `pending`, and owned by the doctor: what to DO about it —
     * attach the consultation to the visit, or cancel a visit the doctor
     * deliberately created — is a clinic decision this slice deliberately does
     * not take. It is named in the programme register as an owner question.
     */
    const unlinked = await db.prepare(PATIENT_READS.unlinkedConsultationWithOpenVisit)
      .get(patientId) as Row | undefined
    if (unlinked) {
      obligations.push({
        kind: 'unlinked_consultation',
        severity: 'blocked',
        owner: 'doctor',
        detail: `A consultation was signed today and is attached to no visit, while ${text(unlinked.token)} `
          + 'is still waiting in the queue. Nothing was recorded twice. Close the visit, or decide '
          + 'what it was for — the clinic will not attach a signed consultation to it by itself.',
      })
    }
  }

  return obligations
}

/* ────────────────────────────────────────────────────────── outcome lookup */

export type Outcome = {
  key: string
  /** The command that owns this key, or `unknown` when nothing committed. */
  operation: 'consultation' | 'dispense' | 'otc_sale' | 'payment' | 'goods_receipt' | 'unknown'
  committed: boolean
  reference?: string
  at?: string
  detail?: string
}

/**
 * What committed under one idempotency key.
 *
 * ── THE QUESTION THIS EXISTS TO ANSWER ─────────────────────────────────────
 *
 * `lib/api.ts` is built on one honest admission: a browser cannot tell a
 * request that never left the tablet from one that reached Mumbai, committed a
 * dispense and lost the reply on the way home. Both arrive as the same
 * `TypeError`. So a failed write is an unknown outcome and never a known
 * nothing — and until now there was no way to resolve that unknown except to
 * go and look at the patient's record by eye.
 *
 * This is the resolution. The tablet already holds the key it sent; it can ask
 * what that key did.
 *
 * ── WHY `committed: false` IS NOT "NOTHING HAPPENED" ───────────────────────
 *
 * It means no record carries this key. For the five commands that take one
 * that is conclusive, because the key is written in the same transaction as
 * the work. What the caller must not do is read it as permission to retry
 * something else — it is permission to retry THE SAME REQUEST under THE SAME
 * KEY, which is safe by construction and is the only retry this answer
 * licenses.
 */
export async function readOutcome(session: SessionView, key: string): Promise<Outcome> {
  const trimmed = key.trim()
  if (!trimmed) return { key: trimmed, operation: 'unknown', committed: false }

  /*
   * A key is resolved only for a role that could have created it.
   *
   * Otherwise this becomes a way to read the counter's receipts from a role
   * that holds none of the counter's capabilities, by guessing at keys. The
   * roles below are the ones each command already requires, copied from the
   * command itself.
   */
  const consultation = hasRole(session, 'doctor')
    ? (await db.prepare(
      `select e.id, e.created_at, p.prescription_number from encounters e
         left join prescriptions p on p.encounter_id = e.id
        where e.idempotency_key = ?`,
    ).get(trimmed)) as Row | undefined
    : undefined
  if (consultation) {
    return {
      key: trimmed, operation: 'consultation', committed: true,
      reference: text(consultation.prescription_number) || text(consultation.id),
      at: text(consultation.created_at),
      detail: consultation.prescription_number
        ? `Consultation signed as ${text(consultation.prescription_number)}.`
        : 'Consultation signed; no medicines prescribed.',
    }
  }

  if (hasRole(session, 'admin', 'pharmacy')) {
    const dispense = (await db.prepare(
      'select dispense_number, dispensed_at, status from dispenses where idempotency_key = ?',
    ).get(trimmed)) as Row | undefined
    if (dispense) {
      return {
        key: trimmed, operation: 'dispense', committed: true,
        reference: text(dispense.dispense_number), at: text(dispense.dispensed_at),
        detail: `Medicines handed over as ${text(dispense.dispense_number)} (${text(dispense.status)}).`,
      }
    }

    const sale = (await db.prepare(
      'select receipt_number, created_at from otc_sales where idempotency_key = ?',
    ).get(trimmed)) as Row | undefined
    if (sale) {
      return {
        key: trimmed, operation: 'otc_sale', committed: true,
        reference: text(sale.receipt_number), at: text(sale.created_at),
        detail: `Counter sale rung up as ${text(sale.receipt_number)}.`,
      }
    }

    /*
     * Payments are the awkward one. A split payment is several rows, and
     * `take_payment` keys them `${key}:1`, `${key}:2` — so the key the tablet
     * holds appears in none of them exactly. Both shapes are matched.
     *
     * The pattern is escaped first, and that is not decoration. The caller's
     * key goes into a LIKE, so an unescaped `%` asks for every split payment
     * in the clinic and the first one comes back — a way to read a receipt
     * number, an amount's status and a time without knowing any key at all.
     * Everything it would return is already inside these two roles' access, so
     * this was a small hole; it was still a hole, and the contract claims in as
     * many words that keys cannot be fished for.
     */
    const pattern = `${trimmed.replace(/([\\%_])/g, '\\$1')}:%`
    const payment = (await db.prepare(
      `select receipt_number, received_at, kind, status from payments
        where idempotency_key = ? or idempotency_key like ? escape '\\'
        order by received_at limit 1`,
    ).get(trimmed, pattern)) as Row | undefined
    if (payment) {
      return {
        key: trimmed, operation: 'payment', committed: true,
        reference: text(payment.receipt_number), at: text(payment.received_at),
        detail: `${text(payment.kind) === 'refund' ? 'Refund' : 'Payment'} taken as receipt ${text(payment.receipt_number)} (${text(payment.status)}).`,
      }
    }

    const receipt = (await db.prepare(
      'select grn_number, received_at from goods_receipts where idempotency_key = ?',
    ).get(trimmed)) as Row | undefined
    if (receipt) {
      return {
        key: trimmed, operation: 'goods_receipt', committed: true,
        reference: text(receipt.grn_number), at: text(receipt.received_at),
        detail: `Delivery received as ${text(receipt.grn_number)}.`,
      }
    }
  }

  /*
   * Two different answers, because they are two different facts.
   *
   * A role that could have created this kind of key and found nothing has
   * learned that nothing committed, and may safely send the same request again
   * under the same reference. A role that was never allowed to look has
   * learned nothing at all, and must not be handed a retry licence on the
   * strength of it — telling a nurse "nothing happened" about a consultation
   * that did happen is the precise failure `lib/api.ts` refuses to make
   * anywhere else.
   */
  const couldHaveMadeOne = hasRole(session, 'doctor', 'admin', 'pharmacy')
  return {
    key: trimmed, operation: 'unknown', committed: false,
    detail: couldHaveMadeOne
      ? 'Nothing in the clinic carries this reference. The same request may be sent again under the same reference.'
      : 'Your role cannot resolve a reference of this kind. This is not a statement that nothing happened.',
  }
}

/* ─────────────────────────────────────────────────── eligible equivalents */

export type EquivalentCandidate = {
  medicineId: string
  name: string
  brandName: string
  strength: string
  dosageForm: string
  availableBaseQuantity: number
}

export type Equivalents =
  | { eligible: false; reason: string; prescribed?: { medicineId: string; name: string } }
  | {
    eligible: true
    prescribed: { medicineId: string; name: string; clinicalDrugId: string; clinicalDrugName: string }
    /** Approved candidates. Choosing one is the pharmacist's; requiring a reason is the server's. */
    candidates: EquivalentCandidate[]
    constraints: string[]
  }

/**
 * The products the backend can prove are the same clinical drug as a
 * prescribed generic.
 *
 * ── WHY THIS IS A SERVER CALL AND NOT A FILTER IN THE SCREEN ───────────────
 *
 * The counter already offers substitutes. It builds the list in
 * `components/counter-math.ts` by filtering the polled snapshot's `medicines`
 * array on the same four conditions the server checks — and the comment there
 * says plainly that the backend is the authority and this is the screen's copy
 * of the question. A copy of a rule is a rule that can drift, and this one
 * drifts against a snapshot that is up to fifteen seconds old: an admin who
 * deactivates a product, relinks its clinical drug or sets a brand name opens
 * a window in which the screen offers something `dispense_rx` will refuse.
 *
 * So there was no authoritative way to ask. There is one now, and it reads the
 * same rows `dispense_rx` reads, at the moment it is asked.
 *
 * ── WHAT IT MUST NEVER DO ──────────────────────────────────────────────────
 *
 * Choose. Policy register 21 permits a pharmacist to select an in-stock brand
 * against a genuinely generic order when the clinical drug matches exactly,
 * and permits nothing else — no ranking that amounts to a recommendation, no
 * clinical claim, no default. This returns the candidates and the constraints
 * and stops. The reason is still required at `dispense_rx`, the substitution
 * is still recorded against the signed line, and the refusals are still the
 * command's.
 */
export async function readEquivalents(
  session: SessionView,
  prescriptionLineId: string,
): Promise<Equivalents | null> {
  if (!mayUse(session, 'view.eligible_equivalents')) return null

  const line = (await db.prepare(
    `select l.id, l.effective_medicine_id, l.needs_review, l.supply_state,
            m.name, m.brand_name, m.clinical_drug_id
       from prescription_line_supply l
       left join medicines m on m.id = l.effective_medicine_id
      where l.id = ?`,
  ).get(prescriptionLineId)) as Row | undefined
  if (!line) return null

  const prescribed = { medicineId: text(line.effective_medicine_id), name: text(line.name) }

  if (line.needs_review === true || !line.effective_medicine_id) {
    return {
      eligible: false, prescribed,
      reason: 'This line is from before this system and does not record which medicine it was. A doctor must resolve it first.',
    }
  }
  if (text(line.brand_name)) {
    return {
      eligible: false, prescribed,
      reason: `${text(line.name)} was prescribed by brand (${text(line.brand_name)}). A brand-specific order is supplied exactly as written.`,
    }
  }
  if (!line.clinical_drug_id) {
    return {
      eligible: false, prescribed,
      reason: `${text(line.name)} is not linked to a clinical drug, so nothing can be proved to be the same medicine as it.`,
    }
  }

  const drug = (await db.prepare(
    'select id, display_name from clinical_drugs where id = ?',
  ).get(text(line.clinical_drug_id))) as Row | undefined

  const candidates = (await db.prepare(
    `select m.id, m.name, m.brand_name, m.strength, m.dosage_form,
            coalesce(s.sellable_base_quantity, 0) as available
       from medicines m
       left join medicine_stock s on s.medicine_id = m.id
      where m.active = 1
        and m.clinical_drug_id = ?
        and m.id <> ?
        and coalesce(s.sellable_base_quantity, 0) > 0
      order by coalesce(s.sellable_base_quantity, 0) desc, m.name`,
  ).all(text(line.clinical_drug_id), text(line.effective_medicine_id))) as Row[]

  return {
    eligible: true,
    prescribed: {
      ...prescribed,
      clinicalDrugId: text(line.clinical_drug_id),
      clinicalDrugName: text(drug?.display_name),
    },
    candidates: candidates.map((row) => ({
      medicineId: text(row.id),
      name: text(row.name),
      brandName: text(row.brand_name),
      strength: text(row.strength),
      dosageForm: text(row.dosage_form),
      availableBaseQuantity: num(row.available),
    })),
    constraints: [
      'Every candidate points at the same clinical drug as the signed order.',
      'A reason must be recorded with the hand-over; the server refuses one without it.',
      'The signed prescription is unchanged. What is recorded is the product actually supplied.',
      'Anything not listed here needs an amended order from the doctor.',
    ],
  }
}

/* ──────────────────────────────────────────────── the appointment book */

export type CalendarBooking = {
  bookingId: string
  patientId: string
  patientName: string
  doctorId: string
  doctorName: string
  scheduledAt: string
  durationMinutes: number
  reason: string
  status: string
  appointmentType?: string
  overbooked: boolean
  outsideAvailability: boolean
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

/** How wide a calendar request may be. The booking horizon, and not a day more. */
const CALENDAR_SPAN_DAYS = 90

/** How many bookings one calendar answer carries. */
const CALENDAR_CAP = 500

const YMD = /^\d{4}-\d{2}-\d{2}$/

function mapBooking(row: Row): CalendarBooking {
  return {
    bookingId: text(row.id),
    patientId: text(row.patient_id),
    patientName: text(row.patient_name),
    doctorId: text(row.doctor_id),
    doctorName: text(row.doctor_name),
    scheduledAt: text(row.scheduled_at),
    durationMinutes: num(row.duration_minutes),
    reason: text(row.reason),
    status: text(row.status),
    appointmentType: optional(row.appointment_type),
    overbooked: row.overbooked === true,
    outsideAvailability: row.outside_availability === true,
    overbookedReason: text(row.overbooked_reason) || undefined,
    checkedInAt: optional(row.checked_in_at),
    arrivalId: optional(row.arrival_id),
    arrivalToken: optional(row.arrival_token),
    arrivalStatus: optional(row.arrival_status),
    lastEvent: row.last_event
      ? {
        event: text(row.last_event),
        reason: text(row.last_event_reason),
        by: text(row.last_event_by),
        at: text(row.last_event_at),
      }
      : undefined,
  }
}

/**
 * The booking query, written once.
 *
 * `... order by created_at desc, id desc limit 1` inside a lateral rather than
 * a window over the whole table: a calendar asks about a few dozen bookings
 * and the event table grows for ever, so the join has to be driven by the
 * bookings rather than the other way round.
 *
 * The arrival is found through `appointments.booking_id` rather than stored on
 * the booking a second time, which is why one booking can never disagree with
 * itself about which queue row it became.
 */
const BOOKING_SELECT = `
  select b.id, b.patient_id, b.doctor_id, b.scheduled_at, b.duration_minutes,
         b.reason, b.status, b.overbooked, b.overbooked_reason, b.outside_availability,
         b.checked_in_at,
         p.name as patient_name,
         d.name as doctor_name,
         t.name as appointment_type,
         a.id as arrival_id, a.token as arrival_token, a.status as arrival_status,
         e.event as last_event, e.reason as last_event_reason,
         e.created_at as last_event_at, es.name as last_event_by
    from appointment_bookings b
    join patients p on p.id = b.patient_id
    join staff d on d.id = b.doctor_id
    left join appointment_types t on t.id = b.appointment_type_id
    left join lateral (
      select id, token, status from appointments
       where booking_id = b.id order by created_at desc limit 1
    ) a on true
    left join lateral (
      select event, reason, created_at, actor_id from appointment_events
       where booking_id = b.id order by created_at desc, id desc limit 1
    ) e on true
    left join staff es on es.id = e.actor_id`

/**
 * Who is expected between two clinic days.
 *
 * Bounded at both ends and capped, like every other read here. The span is the
 * booking horizon, because a range wider than the clinic can book into is a
 * range nobody meant to ask for, and an unbounded calendar over a table that
 * only grows is the shape of query that is fine for a year and then is not.
 *
 * The dates are clinic-local days and the comparison is done in clinic-local
 * time. A calendar asked for "the 22nd" means the 22nd in Chennai, and a
 * server that thinks in UTC would hand back a day that starts at half past
 * five in the morning.
 */
export async function readCalendar(
  _session: SessionView,
  from: string,
  to: string,
  doctorId: string,
): Promise<Calendar | null> {
  if (!YMD.test(from) || !YMD.test(to)) return null

  const span = await db.prepare(
    `select (?::date - ?::date) as days, (?::date >= ?::date) as ordered`,
  ).get(to, from, to, from) as Row | undefined
  if (span?.ordered !== true) return null
  if (num(span.days) > CALENDAR_SPAN_DAYS) return null

  const filtered = doctorId ? 'and b.doctor_id = ?' : ''
  const params: unknown[] = [from, to]
  if (doctorId) params.push(doctorId)

  const rows = (await db.prepare(
    `${BOOKING_SELECT}
      where (b.scheduled_at at time zone 'Asia/Kolkata')::date between ?::date and ?::date
        ${filtered}
      order by b.scheduled_at, b.id
      limit ${CALENDAR_CAP + 1}`,
  ).all(...params)) as Row[]

  /*
   * The windows that could possibly apply anywhere in the range: a dated one
   * falling inside it, or a recurring one whose effective range overlaps it.
   * Which DAYS each covers is the caller's arithmetic — a weekly window is
   * three lines of data and expanding it here into ninety rows of the same
   * three lines would be sending a calendar the long way round.
   */
  const windowParams: unknown[] = doctorId ? [doctorId, from, to, to, from] : [from, to, to, from]
  const windows = (await db.prepare(
    `select id, doctor_id, kind, weekday,
            to_char(on_date, 'YYYY-MM-DD') as on_date,
            to_char(starts_at, 'HH24:MI') as starts_at,
            to_char(ends_at, 'HH24:MI') as ends_at,
            to_char(effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(effective_to, 'YYYY-MM-DD') as effective_to,
            note
       from provider_availability
      where active
        ${doctorId ? 'and doctor_id = ?' : ''}
        and (
          on_date between ?::date and ?::date
          or (weekday is not null
              and effective_from <= ?::date
              and (effective_to is null or effective_to >= ?::date))
        )
      order by weekday nulls last, on_date, starts_at`,
  ).all(...windowParams)) as Row[]

  return {
    from,
    to,
    bookings: rows.slice(0, CALENDAR_CAP).map(mapBooking),
    availability: windows.map((row) => ({
      availabilityId: text(row.id),
      doctorId: text(row.doctor_id),
      kind: text(row.kind) as 'open' | 'blocked',
      weekday: row.weekday === null || row.weekday === undefined ? undefined : num(row.weekday),
      onDate: optional(row.on_date),
      startsAt: text(row.starts_at),
      endsAt: text(row.ends_at),
      effectiveFrom: optional(row.effective_from),
      effectiveTo: optional(row.effective_to),
      note: text(row.note),
    })),
    truncated: rows.length > CALENDAR_CAP,
  }
}

export type PatientAppointment = CalendarBooking & {
  history: { event: string; reason: string; detail: string; by: string; at: string }[]
}

/** How many of a patient's appointments come back, newest first. */
const PATIENT_APPOINTMENT_CAP = 50

/**
 * One patient's appointments, each with the history owner item 68 requires.
 *
 * "No appointment is silently deleted: the prior state, actor, time, and
 * reason remain in append-only history." This is where a person reads that
 * back. A cancelled appointment is on this list exactly as a kept one is, and
 * the reason it was cancelled is on the row rather than in a log somebody has
 * to go and find.
 */
export async function readPatientAppointments(
  _session: SessionView,
  patientId: string,
): Promise<PatientAppointment[] | null> {
  const patient = await db.prepare('select id from patients where id = ?').get(patientId)
  if (!patient) return null

  const rows = (await db.prepare(
    `${BOOKING_SELECT}
      where b.patient_id = ?
      order by b.scheduled_at desc, b.id
      limit ${PATIENT_APPOINTMENT_CAP}`,
  ).all(patientId)) as Row[]
  if (rows.length === 0) return []

  const ids = rows.map((row) => text(row.id))
  const events = (await db.prepare(
    `select e.booking_id, e.event, e.reason, e.detail, e.created_at, s.name as actor
       from appointment_events e
       join staff s on s.id = e.actor_id
      where e.booking_id = any(?::text[])
      order by e.created_at, e.id`,
  ).all(ids)) as Row[]

  const byBooking = new Map<string, PatientAppointment['history']>()
  for (const event of events) {
    const key = text(event.booking_id)
    const list = byBooking.get(key) ?? []
    list.push({
      event: text(event.event),
      reason: text(event.reason),
      detail: text(event.detail),
      by: text(event.actor),
      at: text(event.created_at),
    })
    byBooking.set(key, list)
  }

  return rows.map((row) => ({
    ...mapBooking(row),
    history: byBooking.get(text(row.id)) ?? [],
  }))
}

/* ─────────────────────────────────────── consultation-attempt reconciliation */

export type ReconciliationOption = {
  resolution: 'same_attendance' | 'new_attendance' | 'abandoned_attempt'
  available: boolean
  /** The code `resolve_consultation_attempt` would refuse with, when it would. */
  refusalCode?: string
  detail: string
}

export type Reconciliation = {
  key: string
  patientId: string
  /**
   * What the server could establish at the moment it was asked. `unknown`
   * means a signing was in flight under this reference, and is the one answer
   * no resolution may be recorded against. It is a read: the command decides.
   */
  priorOutcome: 'committed' | 'not_committed' | 'unknown'
  /**
   * Which kind of work is running under this reference, when `priorOutcome` is
   * `unknown`. A signing is owner item 73's fail-closed state and the command
   * refuses against it; a resolution is another doctor deciding, which the
   * command waits for rather than refusing. Absent when nothing is running.
   */
  inFlight?: 'signing' | 'resolution'
  consultation?: {
    encounterId: string
    prescriptionNumber?: string
    signedAt: string
    /** The visit the encounter was signed against, if it was signed against one. */
    visitId?: string
    visitToken?: string
  }
  /** A determination already recorded for this reference. */
  resolved?: {
    resolutionId: string
    resolution: string
    priorOutcome: string
    reason: string
    by: string
    at: string
    subjectVisitId?: string
    subjectVisitClosed: boolean
    /** Owner decision, 16 September 2026: which of the three things it did. */
    subjectVisitDisposition: string
  }
  /** This patient's open queue rows — the candidates for the subject visit. */
  openVisits: { visitId: string; token: string; status: string; scheduledAt: string }[]
  options: ReconciliationOption[]
}

/**
 * What one consultation attempt did, and what may now be done about it.
 *
 * ── THIS IS THE READ BEHIND A SCREEN THAT DOES NOT EXIST YET ───────────────
 *
 * Owner items 72 to 74 require an explicit doctor resolution and the programme
 * puts the control itself in the later frontend programme. What belongs here
 * is everything that control needs in order to be honest: what the reference
 * actually signed, which queue rows are open for this patient, which of the
 * three determinations is available, and — for each one that is not — the
 * exact code the write would refuse with. A screen that offers a button the
 * server will refuse is a screen that teaches people to expect refusals.
 *
 * ── WHY IT TAKES A LOCK TO ANSWER A QUESTION, AND WHAT THAT DOES NOT PROVE ─
 *
 * `pg_try_advisory_lock` in a statement of its own: outside a transaction the
 * lock is acquired and released within the statement, so what it reports is
 * whether somebody ELSE was holding it at that instant — which is to say
 * whether a signing under this reference was in flight. That is the `unknown`
 * case, and it is the one owner item 73 says to fail closed on.
 *
 * **At that instant**, and this is a read rather than a decision. The
 * encounter is looked up in a second statement, so a signing can start and
 * commit between the two and this can report `not_committed` about a reference
 * that has just committed. That is survivable because nothing is released
 * here: the WRITE holds `pg_advisory_xact_lock` for its whole transaction and
 * re-reads under it, and it is the write that refuses. An earlier version of
 * this comment and of the frontend contract said the read answered "under the
 * same lock the write takes", which is not true and would have invited a
 * screen to believe it. Treat `not_committed` here as what the clinic held a
 * moment ago, and the command's answer as the decision.
 */
export async function readReconciliation(
  _session: SessionView,
  key: string,
  patientId: string,
  openedVisitId: string,
): Promise<Reconciliation | null> {
  const patient = await db.prepare('select id from patients where id = ?').get(patientId)
  if (!patient) return null

  /*
   * LOOK at the locks. Do not take them. And there are TWO.
   *
   * The first version took `pg_try_advisory_lock` and released it in the same
   * statement, carefully, because the lock is session-scoped and `db` is a
   * two-connection pool outside a transaction: a lock taken by one query and
   * released by the next may be released on the wrong connection and left held
   * for the life of the first, blocking every signing under that reference
   * until the instance died.
   *
   * It was careful about releasing the lock and not about holding it. For the
   * microseconds this read owned it, a concurrent `resolve_consultation_attempt`
   * taking `pg_try_advisory_xact_lock` on the same pair lost its try and
   * refused the doctor with "this consultation is being signed right now" — a
   * false sentence about the clinic, produced by a read. The third independent
   * review found that.
   *
   * The fourth acceptance review found the other half of the same confusion. A
   * RESOLUTION holds both namespaces: the resolution lock to serialize against
   * other resolutions, and the attempt lock to fail closed against a signing.
   * So watching the attempt lock alone and reporting "a consultation is being
   * signed" says the wrong thing whenever it is a determination in flight, not
   * a signature. Two different people are doing two different things and a
   * doctor waiting on the screen should be told which.
   *
   * `pg_locks` answers both by observation. An advisory lock appears there with
   * `classid` as the first key and `objid` as the second; `hashtext` is a
   * signed int4 and `objid` is an unsigned oid, so the mask converts the bit
   * pattern rather than the number. It is filtered to THIS database, because
   * `pg_locks` is cluster-wide and a staging database beside a scratch one on
   * the same server would otherwise answer for each other. Nothing is
   * acquired, so nothing can be leaked and nothing can be blocked.
   */
  const locks = (await db.prepare(
    `with holders as (
       select pid,
              bool_or(classid = ${ATTEMPT_LOCK_NAMESPACE}) as attempt,
              bool_or(classid = ${ATTEMPT_RESOLUTION_LOCK_NAMESPACE}) as resolution
         from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())
          and classid in (${ATTEMPT_LOCK_NAMESPACE}, ${ATTEMPT_RESOLUTION_LOCK_NAMESPACE})
          and objid = ((hashtext(?)::bigint) & 4294967295)::oid
          and objsubid = 2
          and granted
        group by pid
     )
     select
       coalesce(bool_or(attempt and not resolution), false) as signing,
       coalesce(bool_or(resolution), false) as resolving
       from holders`,
  ).get(key)) as Row | undefined

  /*
   * GROUPED BY PID, and the grouping is the whole point.
   *
   * A resolution holds both namespaces on ONE backend. A signing holds the
   * attempt lock alone. The first version asked whether each lock was held
   * anywhere and concluded "resolution" whenever both appeared — so a doctor
   * signing on one connection while another doctor resolved a different thing
   * on another was reported as "nothing is being signed", which is the one
   * sentence owner item 73 must never produce. The fourth review reproduced it
   * with two connections.
   *
   * So: a backend holding the attempt lock and NOT the resolution lock is a
   * signing, and it wins, because a signing in flight is the fail-closed state
   * and a determination waiting behind one is not.
   */
  const inFlightWork: 'resolution' | 'signing' | null = locks?.signing === true
    ? 'signing'
    : locks?.resolving === true
    ? 'resolution'
    : null
  const inFlight = inFlightWork !== null

  const signed = inFlight
    ? undefined
    : (await db.prepare(
      `select e.id, e.created_at, e.patient_id, e.appointment_id,
              rx.prescription_number, a.token as visit_token
         from encounters e
         left join prescriptions rx on rx.encounter_id = e.id
         left join appointments a on a.id = e.appointment_id
        where e.idempotency_key = ?`,
    ).get(key)) as Row | undefined

  /*
   * `and r.patient_id = ?`, which the first version left off.
   *
   * The consultation two statements above is gated on belonging to this
   * patient and this was not, so a reference that resolved somebody else's
   * attempt handed back their doctor's free-text reason and the visit it
   * named. Doctor-only, so nothing was escalated; it was still the one place
   * in this slice that answered across patients, in the read that sits behind
   * the control the correction built.
   */
  const recorded = (await db.prepare(
    `select r.id, r.resolution, r.prior_outcome, r.reason, r.resolved_at,
            r.subject_visit_id, r.subject_visit_closed, r.subject_visit_disposition, r.patient_id,
            s.name as resolved_by
       from consultation_attempt_resolutions r
       join staff s on s.id = r.resolved_by
      where r.idempotency_key = ?`,
  ).get(key)) as Row | undefined

  /*
   * TWO questions, and the first correction answered both with one row.
   *
   * *Has this reference been resolved at all?* is the command's question:
   * `resolutionFor` looks the key up and nothing else, because the key is
   * unique across the whole clinic and a second determination under it is
   * refused whoever it names. That is the gate below.
   *
   * *What may this doctor be shown about this patient?* is this read's, and
   * the answer is nothing at all when the row belongs elsewhere — the second
   * review found this function handing back a stranger's doctor's free-text
   * reason and the visit it named.
   *
   * Filtering the LOOKUP answered the second and broke the first: a reference
   * resolved for another patient made the gate miss, so all three options were
   * offered as available and the command refused every one of them with
   * `RECONCILIATION_ALREADY_RESOLVED`. Reproduced by the independent review.
   * The filter belongs on what is shown, which is where it is now.
   */
  const resolvedHere = recorded && text(recorded.patient_id) === patientId
    ? recorded
    : undefined

  const openVisits = (await db.prepare(
    `select id, token, status, scheduled_at from appointments
      where patient_id = ? and status in ('waiting', 'in_consult')
      order by scheduled_at`,
  ).all(patientId)) as Row[]

  /*
   * Whether an abandoned attempt is actually available, asked the same way the
   * write asks it.
   *
   * The first version offered it whenever nothing had committed, with the
   * detail "the visit it was started against is no longer open" — which this
   * function had no way of knowing, because it was not given the visit. The
   * write then refused with `ATTEMPT_VISIT_STILL_ACTIVE`, which is precisely
   * the "a screen never offers a button the server will reject" promise two
   * paragraphs up, broken. Found by the independent review.
   */
  const openedVisit = openedVisitId
    ? (await db.prepare(
      'select status from appointments where id = ? and patient_id = ?',
    ).get(openedVisitId, patientId)) as Row | undefined
    : undefined
  const openedStillActive = Boolean(openedVisit)
    && (text(openedVisit?.status) === 'waiting' || text(openedVisit?.status) === 'in_consult')
  /*
   * A visit that is not this patient's, or does not exist, is not an inactive
   * visit — and treating it as one offered `abandoned_attempt` as available
   * while the command, tightened by the same correction, refuses it with
   * `VISIT_NOT_THIS_PATIENTS`. Which is this function's own promise broken by
   * the change that made the command keep it. Found by the second review.
   */
  const openedIsUnknown = Boolean(openedVisitId) && !openedVisit

  const belongsElsewhere = Boolean(signed) && text(signed?.patient_id) !== patientId
  const priorOutcome: Reconciliation['priorOutcome'] = inFlight
    ? 'unknown'
    : signed
      ? 'committed'
      : 'not_committed'

  const option = (
    resolution: ReconciliationOption['resolution'],
    available: boolean,
    detail: string,
    refusalCode?: string,
  ): ReconciliationOption => ({ resolution, available, detail, refusalCode })

  /*
   * ── THE GATES, IN THE ORDER THE COMMAND REACHES THEM ────────────────────
   *
   * Every entry below is exactly one refusal in `resolve_consultation_attempt`,
   * listed in that command's own order, against the determinations that
   * refusal can stop. The read walks the table once per determination and the
   * first gate that holds is the answer.
   *
   * A table rather than a nested conditional because the two drifted apart
   * twice. Once when the command was tightened to refuse a visit belonging to
   * another patient and this was not; once when the same correction was applied
   * to one determination of the three, so Same attendance and New attendance
   * were still offered as available against a stranger's visit and the doctor
   * discovered otherwise by pressing them. Both were found by review, not by
   * the suite.
   *
   * The promise is that a screen never offers a button the server will reject,
   * and as the command grows the only way to keep it is for the offer and the
   * refusal to be read off one list.
   */
  type Gate = {
    readonly when: boolean
    readonly applies: readonly ReconciliationOption['resolution'][]
    readonly detail: string
    readonly code?: string
  }

  const EVERY = ['same_attendance', 'new_attendance', 'abandoned_attempt'] as const

  const gates: readonly Gate[] = [
    {
      when: Boolean(recorded),
      applies: EVERY,
      detail: resolvedHere
        ? 'This reference has already been resolved.'
        : 'This reference has already been resolved, for a different patient.',
      code: 'RECONCILIATION_ALREADY_RESOLVED',
    },
    {
      when: inFlightWork === 'signing',
      applies: EVERY,
      detail: 'A consultation is being signed under this reference right now.',
      code: 'ATTEMPT_OUTCOME_NOT_ESTABLISHED',
    },
    {
      /*
       * No code, deliberately. A signing in flight is a refusal the command
       * will give — it fails closed on owner item 73. A determination in
       * flight is not: the command WAITS on the resolution lock, and by the
       * time it answers the other doctor has committed, so what comes back is
       * a replay or `RECONCILIATION_ALREADY_RESOLVED`, and which of the two
       * depends on what they recorded. Naming a code here would promise a
       * refusal that may not be the one that arrives.
       */
      when: inFlightWork === 'resolution',
      applies: EVERY,
      detail: 'Another doctor is recording a determination under this reference right now. '
        + 'Nothing is being signed. Look again in a moment to see what they decided.',
    },
    {
      when: belongsElsewhere,
      applies: EVERY,
      detail: 'That reference signed a consultation for a different patient.',
      code: 'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
    },
    {
      when: !signed,
      applies: ['same_attendance'],
      detail: 'Nothing was recorded under this reference, so there is no consultation for a visit to be '
        + 'the same attendance as. The visit is still open — sign it.',
      code: 'ATTEMPT_NOT_COMMITTED',
    },
    {
      when: Boolean(signed),
      applies: ['abandoned_attempt'],
      detail: 'A consultation WAS signed under this reference, so the attempt was not abandoned.',
      code: 'ATTEMPT_ALREADY_COMMITTED',
    },
    {
      // The command refuses this one with a plain sentence and no code: it is
      // a question to the caller rather than a determination about the clinic.
      when: !openedVisitId,
      applies: ['abandoned_attempt'],
      detail: 'Name the visit this attempt was started against and this can be answered. An attempt is '
        + 'abandoned because that visit is no longer open, so the clinic has to be told which visit it was.',
    },
    {
      when: openedIsUnknown,
      applies: EVERY,
      detail: 'That visit was not found, or belongs to a different patient.',
      code: 'VISIT_NOT_THIS_PATIENTS',
    },
    {
      when: openedStillActive,
      applies: ['abandoned_attempt'],
      detail: 'The visit this attempt was started against is still open in the queue, so nothing has been '
        + 'abandoned. Sign it.',
      code: 'ATTEMPT_VISIT_STILL_ACTIVE',
    },
  ]

  /** What each determination does, said in the case where nothing stops it. */
  const available: Record<ReconciliationOption['resolution'], string> = {
    same_attendance: openVisits.length > 0
      ? 'The consultation already signed IS this attendance. Name the open visit; it is closed, and nothing '
        + 'is charged again.'
      : 'The consultation already signed IS this attendance. It stands unchanged and nothing is charged again.',
    /*
     * A new attendance names its visit too, and this text said so for the one
     * determination and not the other.
     *
     * The fourth acceptance correction added `SUBJECT_VISIT_REQUIRED` to
     * `new_attendance` — owner item 74 is the doctor saying which attendance
     * continues — and left this branching on `signed` alone, so the option
     * came back available with a detail that never mentioned naming anything.
     * A screen built to this contract would have submitted without a subject
     * and met a refusal, which is the promise this whole table exists to keep,
     * broken for the case the same round had just created. The independent
     * review found it.
     */
    new_attendance: openVisits.length > 0
      ? (signed
        ? 'The patient has genuinely come back. Name the visit they have come back for; it is left open '
          + 'for a fresh consultation and the earlier reference is closed.'
        : 'Nothing was recorded. Name the visit in front of you; it is consulted in the ordinary way and '
          + 'the earlier reference is closed.')
      : (signed
        ? 'The patient has genuinely come back. The earlier reference is closed and nothing is charged '
          + 'again.'
        : 'Nothing was recorded. The earlier reference is closed and the consultation is done in the '
          + 'ordinary way.'),
    abandoned_attempt:
      'Nothing was recorded and the visit it was started against is no longer open. The reference is closed '
      + 'and nothing else changes.',
  }

  const options: ReconciliationOption[] = EVERY.map((resolution) => {
    const stopped = gates.find((gate) => gate.when && gate.applies.includes(resolution))
    return stopped
      ? option(resolution, false, stopped.detail, stopped.code)
      : option(resolution, true, available[resolution])
  })


  return {
    key,
    patientId,
    priorOutcome,
    /*
     * Which kind of work is in flight, when `priorOutcome` is `unknown`.
     * `signing` is owner item 73's fail-closed state; `resolution` is another
     * doctor deciding, which resolves itself. Absent when nothing is running.
     */
    inFlight: inFlightWork ?? undefined,
    consultation: signed && !belongsElsewhere
      ? {
        encounterId: text(signed.id),
        prescriptionNumber: optional(signed.prescription_number),
        signedAt: text(signed.created_at),
        visitId: optional(signed.appointment_id),
        visitToken: optional(signed.visit_token),
      }
      : undefined,
    resolved: resolvedHere
      ? {
        resolutionId: text(resolvedHere.id),
        resolution: text(resolvedHere.resolution),
        priorOutcome: text(resolvedHere.prior_outcome),
        reason: text(resolvedHere.reason),
        by: text(resolvedHere.resolved_by),
        at: text(resolvedHere.resolved_at),
        subjectVisitId: optional(resolvedHere.subject_visit_id),
        subjectVisitClosed: resolvedHere.subject_visit_closed === true,
        subjectVisitDisposition: text(resolvedHere.subject_visit_disposition),
      }
      : undefined,
    openVisits: openVisits.map((row) => ({
      visitId: text(row.id),
      token: text(row.token),
      status: text(row.status),
      scheduledAt: text(row.scheduled_at),
    })),
    options,
  }
}

/** The capability table and this module must describe the same surface. */
export const VIEW_CAPABILITIES = Object.keys(CAPABILITIES)
  .filter((id): id is CapabilityId => id.startsWith('view.'))

export { optional as optionalText }
