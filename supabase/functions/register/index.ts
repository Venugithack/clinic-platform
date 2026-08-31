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

  // `to` is inclusive to the reader, so the query runs to the end of that day.
  const toExclusive = new Date(`${to}T00:00:00Z`)
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1)
  const upper = toExclusive.toISOString()

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
      .all(`${from}T00:00:00.000Z`, upper)

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
      .all(`${from}T00:00:00.000Z`, upper)

    return json({
      ok: true,
      from,
      to,
      rows: rows.map((r) => ({
        date: String(r.created_at).slice(0, 10),
        time: String(r.created_at).slice(11, 16),
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
        date: String(r.created_at).slice(0, 10),
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
