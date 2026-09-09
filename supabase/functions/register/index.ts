import { db } from '../_shared/db.ts'
import { hasRole } from '../_shared/auth.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'

/**
 * The Schedule H1 register.
 *
 * Required by the Drugs and Cosmetics Rules and retained three years: date,
 * patient name AND ADDRESS, drug, quantity, prescriber. An inspector asks for a
 * date range and expects a document, so that is what this returns — rows in
 * order, for a range, with nothing derived at read time that could differ from
 * the last time it was printed.
 *
 * ── WHAT IT REPORTS BESIDES THE ROWS ────────────────────────────────────────
 *
 * `unsetMedicines` — medicines whose schedule has never been recorded. They
 * cannot appear in this register because nobody has said whether they belong,
 * and a register silently missing entries is the failure mode that matters. The
 * screen shows the count and refuses to call the register complete.
 *
 * `counterExceptions` — Schedule H1 that left on a counter sale rather than
 * against a prescription. That should not happen; if it has, an inspector will
 * find it, and it is better found here first.
 */

const RANGE = /^\d{4}-\d{2}-\d{2}$/

/**
 * How far the clinic's day is ahead of the timestamps in the database.
 *
 * `created_at` is stored as an ISO instant in UTC, and the clinic is in Tamil
 * Nadu. Every date in this file — the two ends of the range, and the date
 * printed against each row — used to be worked out in UTC, which is a day that
 * begins at half past five in the morning in Chennai. A strip of Schedule H1
 * handed over at two in the morning to somebody who knocked on the door was
 * therefore both filed under the previous day and, if the previous day was
 * outside the range asked for, missing from the report altogether. On an
 * ordinary screen that is an off-by-one. On a register that an inspector reads
 * and that the Drugs and Cosmetics Rules require to be kept for three years, it
 * is a document that disagrees with the pharmacist who wrote it.
 *
 * A fixed number and not a timezone lookup because India has one offset and has
 * never observed daylight saving, so there is no rule here to get wrong.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * A stored instant, split into the date and time the clinic would write down.
 *
 * The fallback matters more than it looks. This is the one document that must
 * still print when something in it is malformed: a row with an unparseable
 * timestamp should show what it has and let a human see the problem, not throw
 * and take the whole three-year register down with it.
 */
function clinicMoment(stored: unknown): { date: string; time: string } {
  const raw = String(stored ?? '')
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return { date: raw.slice(0, 10), time: raw.slice(11, 16) }

  const local = new Date(at + IST_OFFSET_MS).toISOString()
  return { date: local.slice(0, 10), time: local.slice(11, 16) }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)
  if (!hasRole(session, 'admin', 'pharmacy', 'doctor')) {
    return json({ ok: false, message: 'Register access required.' }, 403)
  }

  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''

  if (!RANGE.test(from) || !RANGE.test(to)) {
    return json({ ok: false, message: 'Give a from and to date as YYYY-MM-DD.' }, 400)
  }

  // Both ends are clinic midnights expressed as the UTC instants the column
  // actually holds, so `from` starts at 00:00 in Chennai rather than at 05:30.
  // `to` stays inclusive to the reader — the query runs to the clinic midnight
  // that ends that day, which is 18:30 UTC on the day itself.
  const lower = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString()
  const upper = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS - IST_OFFSET_MS).toISOString()

  try {
    const rows = await db
      .prepare(
        `select sm.created_at,
                p.name          as patient_name,
                p.address       as patient_address,
                p.phone         as patient_phone,
                m.name          as medicine_name,
                m.strength      as medicine_strength,
                b.batch_number  as batch_number,
                -sm.quantity_delta as quantity,
                m.unit          as unit,
                d.name          as prescriber,
                rx.id           as prescription_id
           from stock_movements sm
           join medicines m    on m.id = sm.medicine_id and m.schedule = 'H1'
           join batches b      on b.id = sm.batch_id
           join prescriptions rx on rx.id = sm.reference_id
           join patients p     on p.id = rx.patient_id
           join staff d        on d.id = rx.doctor_id
          where sm.reference_type = 'prescription'
            and sm.quantity_delta < 0
            and sm.created_at >= ? and sm.created_at < ?
          order by sm.created_at`,
      )
      .all(lower, upper)

    const [unset] = (await db
      .prepare(`select count(*)::int as n from medicines where schedule = 'unset' and active = 1`)
      .all()) as Array<{ n: number }>

    const exceptions = await db
      .prepare(
        `select sm.created_at, m.name as medicine_name, -sm.quantity_delta as quantity,
                s.receipt_number
           from stock_movements sm
           join medicines m on m.id = sm.medicine_id and m.schedule = 'H1'
           join otc_sales s on s.id = sm.reference_id
          where sm.reference_type = 'otc_sale'
            and sm.created_at >= ? and sm.created_at < ?
          order by sm.created_at`,
      )
      .all(lower, upper)

    return json({
      ok: true,
      from,
      to,
      rows: rows.map((r) => ({
        ...clinicMoment(r.created_at),
        patientName: String(r.patient_name),
        patientAddress: String(r.patient_address ?? ''),
        patientPhone: String(r.patient_phone ?? ''),
        drug: `${r.medicine_name} ${r.medicine_strength ?? ''}`.trim(),
        batchNumber: String(r.batch_number ?? ''),
        quantity: Number(r.quantity),
        unit: String(r.unit ?? ''),
        prescriber: String(r.prescriber),
        prescriptionId: String(r.prescription_id),
      })),
      unsetMedicines: Number(unset?.n ?? 0),
      counterExceptions: exceptions.map((r) => ({
        date: clinicMoment(r.created_at).date,
        drug: String(r.medicine_name),
        quantity: Number(r.quantity),
        receiptNumber: String(r.receipt_number ?? ''),
      })),
    })
  } catch (error) {
    console.error('register failed:', error)
    return json({ ok: false, message: 'The register could not be read.' }, 503)
  }
})
