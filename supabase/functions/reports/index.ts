/**
 * The clinic's reports, fetched when somebody opens one.
 *
 * Every one of these reads history — stock movements, dispenses, payments,
 * image access — which is exactly the kind of data the brief keeps out of the
 * fifteen-second poll. A report is asked for by a person who is looking at it;
 * the snapshot is asked for by four tablets whether anybody is standing there
 * or not.
 *
 * ── WHAT A REPORT IS ALLOWED TO BE ─────────────────────────────────────────
 *
 * Derived, every time. Not one of these reads a cached total or a status
 * column: stock comes from the movement ledger, money from invoice lines and
 * payment allocations, supply state from dispense events. A report that agrees
 * with the screen only because both read the same stale number is a report
 * that cannot be used to check the screen.
 *
 * Ranges are half-open on the clinic's own day boundary, because the server
 * runs five and a half hours behind Chennai and "today" is not a question
 * about UTC.
 */
import { hasRole } from '../_shared/auth.ts'
import { db } from '../_shared/db.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'
import type { SessionView } from '../_shared/types.ts'

type Row = Record<string, unknown>

const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

/**
 * Who may read which report.
 *
 * Money to the desks that handle money, stock to the shelf, and the image
 * access audit to the admin alone — an audit of who looked at photographs is
 * not itself a reason for more people to look at photographs.
 */
type Report = {
  roles: Array<'admin' | 'doctor' | 'nurse' | 'pharmacy'>
  /** `since` is clinic-local midnight, `days` days ago, as an ISO string. */
  run: (since: string) => Promise<unknown>
}

const REPORTS: Record<string, Report> = {
  /** What is on the shelf, and what it is worth at cost. */
  stock_on_hand: {
    roles: ['admin', 'pharmacy', 'doctor'],
    run: async () => ({
      rows: await all(`
        select m.code, m.name, m.strength,
               coalesce(nullif(m.base_unit, ''), m.unit) as base_unit,
               s.sellable_base_quantity, s.quarantined_base_quantity, s.blocked_base_quantity,
               s.expired_base_quantity, s.earliest_pickable_expiry,
               coalesce(sum(b.available_quantity * b.purchase_price), 0)::numeric(14,2) as cost_value,
               coalesce(sum(b.available_quantity * b.selling_price), 0)::numeric(14,2) as retail_value,
               m.reorder_level, m.target_stock,
               (s.sellable_base_quantity <= m.reorder_level) as at_or_below_reorder
          from jmc.medicines m
          join jmc.medicine_stock s on s.medicine_id = m.id
          left join jmc.batches b on b.medicine_id = m.id and b.status = 'active'
         where m.active = 1
         group by m.id, m.code, m.name, m.strength, m.base_unit, m.unit,
                  s.sellable_base_quantity, s.quarantined_base_quantity, s.blocked_base_quantity,
                  s.expired_base_quantity, s.earliest_pickable_expiry, m.reorder_level, m.target_stock
         order by m.name`),
    }),
  },

  /** Every movement, with what it was for and who did it. */
  stock_movements: {
    roles: ['admin', 'pharmacy'],
    run: async (since) => ({
      rows: await all(`
        select v.created_at, m.name as medicine, b.batch_number, v.bucket, v.movement_type,
               v.quantity_delta, v.reference_type, v.reference_id, v.reason,
               s.name as actor, a.name as approved_by
          from jmc.stock_movements v
          join jmc.medicines m on m.id = v.medicine_id
          join jmc.batches b on b.id = v.batch_id
          join jmc.staff s on s.id = v.actor_id
          left join jmc.staff a on a.id = v.approved_by
         where v.created_at >= ?
         order by v.created_at desc
         limit 2000`, since),
    }),
  },

  /** What is going off, held, recalled or already returned. */
  expiry_and_holds: {
    roles: ['admin', 'pharmacy', 'doctor'],
    run: async () => ({
      expiring: await all(`
        select m.name as medicine, b.batch_number, b.expiry, b.available_quantity,
               (b.expiry::date - ${CLINIC_TODAY}) as days_left,
               sup.name as supplier, sup.return_window_days,
               ((b.expiry::date - ${CLINIC_TODAY}) <= sup.return_window_days) as inside_return_window
          from jmc.batches b
          join jmc.medicines m on m.id = b.medicine_id
          left join jmc.suppliers sup on sup.id = b.received_from_supplier_id
         where b.available_quantity > 0 and b.status = 'active'
           and b.expiry::date <= ${CLINIC_TODAY} + 180
         order by (b.expiry::date - ${CLINIC_TODAY}) - coalesce(sup.return_window_days, 0)`),
      held: await all(`
        select m.name as medicine, b.batch_number, b.expiry, b.status, b.status_reason,
               b.quarantined_quantity, b.blocked_quantity, s.name as changed_by, b.status_changed_at
          from jmc.batches b
          join jmc.medicines m on m.id = b.medicine_id
          left join jmc.staff s on s.id = b.status_changed_by
         where b.status <> 'active' or b.quarantined_quantity > 0 or b.blocked_quantity > 0
         order by m.name, b.expiry`),
      returns: await all(`
        select r.note_number, m.name as medicine, r.quantity, r.expected_credit, r.status,
               sup.name as supplier, r.created_at, r.settled_at
          from jmc.supplier_returns r
          join jmc.medicines m on m.id = r.medicine_id
          join jmc.suppliers sup on sup.id = r.supplier_id
         order by r.created_at desc limit 200`),
      writeoffs: await all(`
        select w.created_at, m.name as medicine, w.quantity, w.reason, w.cost_value, s.name as actor
          from jmc.stock_writeoffs w
          join jmc.medicines m on m.id = w.medicine_id
          join jmc.staff s on s.id = w.actor_id
         order by w.created_at desc limit 200`),
    }),
  },

  /** Every package version, who verified it against what, and what it holds. */
  package_audit: {
    roles: ['admin', 'pharmacy'],
    run: async () => ({
      rows: await all(`
        select m.name as medicine, m.code, p.version, p.base_unit, p.status,
               p.verification_source, p.verification_note,
               v.name as verified_by, p.verified_at, e.name as entered_by, p.entered_at,
               r.name as retired_by, p.retired_at,
               (select count(*)::int from jmc.batches b where b.package_version_id = p.id) as batches,
               (select string_agg(l.level_name || '=' || l.base_factor, ', ' order by l.depth)
                  from jmc.package_levels l where l.package_version_id = p.id) as ladder
          from jmc.package_versions p
          join jmc.medicines m on m.id = p.medicine_id
          join jmc.staff e on e.id = p.entered_by
          left join jmc.staff v on v.id = p.verified_by
          left join jmc.staff r on r.id = p.retired_by
         order by m.name, p.version desc`),
      unclassified: await all(`
        select code, name, strength, schedule, schedule_source,
               (schedule_verified_at is not null) as verified
          from jmc.medicines
         where active = 1 and (schedule = 'unset' or schedule_verified_at is null)
         order by name`),
      unpackaged: await all(`
        select m.code, m.name, m.strength
          from jmc.medicines m
         where m.active = 1
           and not exists (select 1 from jmc.medicine_active_package p where p.medicine_id = m.id)
         order by m.name`),
      unlinked: await all(`
        select code, name, strength from jmc.medicines
         where active = 1 and clinical_drug_id is null order by name`),
    }),
  },

  /** What was ordered against what arrived. */
  purchasing: {
    roles: ['admin', 'pharmacy'],
    run: async () => ({
      orders: await all(`
        select o.order_number, sup.name as supplier, o.status, o.created_at, o.placed_at,
               coalesce(sum(l.ordered_quantity), 0)::int as ordered,
               coalesce(sum(l.received_quantity), 0)::int as received
          from jmc.purchase_orders o
          join jmc.suppliers sup on sup.id = o.supplier_id
          left join jmc.purchase_order_lines l on l.order_id = o.id
         group by o.id, sup.name
         order by o.created_at desc limit 200`),
      receipts: await all(`
        select g.grn_number, sup.name as supplier, g.supplier_invoice_number, g.supplier_invoice_date,
               g.subtotal, g.tax_total, g.total, g.received_at, s.name as received_by,
               o.order_number,
               (select count(*)::int from jmc.goods_receipt_lines l where l.goods_receipt_id = g.id) as lines,
               (select coalesce(sum(l.accepted_base_quantity + l.free_base_quantity), 0)::bigint
                  from jmc.goods_receipt_lines l where l.goods_receipt_id = g.id) as base_units
          from jmc.goods_receipts g
          join jmc.suppliers sup on sup.id = g.supplier_id
          join jmc.staff s on s.id = g.received_by
          left join jmc.purchase_orders o on o.id = g.purchase_order_id
         order by g.received_at desc limit 200`),
    }),
  },

  /** What was prescribed and never collected, and what is still collectable. */
  outstanding_prescriptions: {
    roles: ['admin', 'pharmacy', 'doctor'],
    run: async () => ({
      rows: await all(`
        select rx.prescription_number, p.name as patient, d.name as doctor, rx.signed_at,
               rx.valid_until, (rx.valid_until < ${CLINIC_TODAY}) as expired,
               l.line_number, l.medicine_name_snapshot as medicine,
               l.effective_quantity as prescribed, l.supplied, l.remaining, l.supply_state
          from jmc.prescription_line_supply l
          join jmc.prescriptions rx on rx.id = l.prescription_id
          join jmc.patients p on p.id = rx.patient_id
          join jmc.staff d on d.id = rx.doctor_id
         where l.remaining > 0 and l.supplyable
         order by rx.valid_until, rx.signed_at`),
      /*
       * The doctor's review queue.
       *
       * `prescription_line_id` and `patient_id` are here for the screen rather
       * than for the reader: `resolve_prescription_line` takes the line id,
       * and the only role that may call it — doctor — is the one role whose
       * snapshot does NOT carry prescriptions (those are gated to the counter).
       * Without the id on this row a doctor would hold the authoritative list
       * of lines they alone can settle and no way to name one of them. The
       * table renderer drops `_id` columns, so neither appears on screen.
       */
      needsDoctor: await all(`
        select rx.prescription_number, p.name as patient, l.line_number,
               l.medicine_name_snapshot as medicine, l.medicine_state, l.quantity_state,
               l.quantity_unit, l.id as prescription_line_id, p.id as patient_id
          from jmc.prescription_lines_effective l
          join jmc.prescriptions rx on rx.id = l.prescription_id
          join jmc.patients p on p.id = rx.patient_id
         where l.needs_review
         order by rx.signed_at`),
    }),
  },

  /** Every hand-over, with the batches it came from. */
  dispensing: {
    roles: ['admin', 'pharmacy'],
    run: async (since) => ({
      rows: await all(`
        select d.dispense_number, d.dispensed_at, p.name as patient, s.name as dispensed_by,
               rx.prescription_number, m.name as medicine, l.quantity,
               b.batch_number, a.quantity as from_batch, a.unit_amount, d.status,
               cd.display_name as substituted_for, l.substitution_reason
          from jmc.dispenses d
          join jmc.patients p on p.id = d.patient_id
          join jmc.staff s on s.id = d.dispensed_by
          join jmc.prescriptions rx on rx.id = d.prescription_id
          join jmc.dispense_lines l on l.dispense_id = d.id
          join jmc.medicines m on m.id = l.medicine_id
          left join jmc.dispense_allocations a on a.dispense_line_id = l.id
          left join jmc.batches b on b.id = a.batch_id
          left join jmc.clinical_drugs cd on cd.id = l.substituted_for_clinical_drug_id
         where d.dispensed_at >= ?::timestamptz
         order by d.dispensed_at desc limit 2000`, since),
    }),
  },

  /** What was charged for consultations, and what was waived or discounted. */
  consultation_fees: {
    roles: ['admin'],
    run: async (since) => ({
      rows: await all(`
        select e.created_at, p.name as patient, d.name as doctor,
               e.consultation_fee, e.consultation_fee_default, e.fee_waived, e.fee_reason,
               f.name as fee_set_by,
               (e.consultation_fee <> e.consultation_fee_default) as overridden
          from jmc.encounters e
          join jmc.patients p on p.id = e.patient_id
          join jmc.staff d on d.id = e.doctor_id
          left join jmc.staff f on f.id = e.fee_set_by
         where e.created_at >= ? and e.consultation_fee is not null
         order by e.created_at desc limit 1000`, since),
    }),
  },

  /** What was sold, how, and whether it has been paid for. */
  sales: {
    roles: ['admin', 'pharmacy'],
    run: async (since) => ({
      byLine: await all(`
        select l.source, count(*)::int as lines,
               coalesce(sum(l.amount), 0)::numeric(14,2) as amount
          from jmc.invoice_lines l
          join jmc.invoices i on i.id = l.invoice_id
         where i.created_at >= ?::timestamptz and i.status <> 'void'
         group by l.source order by l.source`, since),
      otc: await all(`
        select s.receipt_number, s.created_at, s.total, s.status,
               coalesce(p.name, 'Anonymous') as patient, st.name as sold_by,
               (select count(*)::int from jmc.otc_lines l where l.otc_sale_id = s.id) as lines
          from jmc.otc_sales s
          join jmc.staff st on st.id = s.created_by
          left join jmc.patients p on p.id = s.patient_id
         where s.created_at >= ?
         order by s.created_at desc limit 500`, since),
      returns: await all(`
        select r.created_at, s.receipt_number, m.name as medicine, r.quantity,
               r.refund_amount, r.reason, st.name as authorized_by
          from jmc.otc_returns r
          join jmc.otc_sales s on s.id = r.otc_sale_id
          join jmc.otc_lines l on l.id = r.otc_line_id
          join jmc.medicines m on m.id = l.medicine_id
          join jmc.staff st on st.id = r.authorized_by
         order by r.created_at desc limit 200`),
    }),
  },

  /** Cash, UPI and card, reconciled — the day-close question. */
  payments: {
    roles: ['admin', 'pharmacy'],
    run: async (since) => ({
      byMethod: await all(`
        select y.method, y.kind, count(*)::int as receipts,
               coalesce(sum(y.amount), 0)::numeric(14,2) as amount
          from jmc.payments y
         where y.received_at >= ?::timestamptz and y.status = 'received'
         group by y.method, y.kind order by y.method, y.kind`, since),
      receipts: await all(`
        select y.receipt_number, y.received_at, y.kind, y.method, y.reference, y.amount,
               y.status, y.reversal_reason, s.name as received_by,
               coalesce(p.name, 'Anonymous') as patient,
               (select string_agg(i.invoice_number, ', ')
                  from jmc.payment_allocations a
                  join jmc.invoices i on i.id = a.invoice_id
                 where a.payment_id = y.id) as invoices
          from jmc.payments y
          join jmc.staff s on s.id = y.received_by
          left join jmc.patients p on p.id = y.patient_id
         where y.received_at >= ?::timestamptz
         order by y.received_at desc limit 1000`, since),
      splits: await all(`
        select i.invoice_number, coalesce(p.name, 'Anonymous') as patient,
               count(distinct y.method)::int as methods,
               string_agg(distinct y.method, ' + ') as used,
               coalesce(sum(a.amount), 0)::numeric(14,2) as paid
          from jmc.payment_allocations a
          join jmc.payments y on y.id = a.payment_id and y.status = 'received'
          join jmc.invoices i on i.id = a.invoice_id
          left join jmc.patients p on p.id = i.patient_id
         where y.received_at >= ?::timestamptz
         group by i.invoice_number, p.name
        having count(distinct y.method) > 1 or count(*) > 1
         order by i.invoice_number`, since),
    }),
  },

  /**
   * Who owes the clinic what, and what they have paid so far.
   *
   * Four of these columns are not a debt. An over-refunded bill inflates
   * `outstanding` — `due` is the total minus a negative `paid`, so it is larger
   * than the bill — and the person reading this list to decide who to ask for
   * money must be able to see that one of the figures is the clinic's own
   * mistake rather than the patient's. Hence the over-refund and
   * void-with-balance counts and amounts on the row, and the two changes below.
   *
   * The list no longer selects on `outstanding <> 0` alone, and the test it
   * selects on is the review queue's own membership — `under_review_invoices`,
   * which is both kinds counted once. Three ways a patient under review nets to
   * nothing here: an overpayment on one bill against an over-refund on another;
   * an over-refund on a bill that was later voided; and a cancelled bill with
   * money still against it, which contributes to none of `billed`, `paid` or
   * `outstanding`, because all three exclude voided bills. That last one has
   * `outstanding = 0` and nothing else on the row to say otherwise, so a test
   * on the money alone drops it — which is the one thing that must not happen
   * to this list. The order puts them first for the same reason: a descending
   * `outstanding` is a list of people to chase, and these are not that.
   * `financial_review` is where they are actually worked (policy register 52,
   * 58–61).
   */
  patient_dues: {
    roles: ['admin', 'pharmacy'],
    run: async () => ({
      rows: await all(`
        select b.patient_id, b.name as patient, pt.phone, b.billed, b.paid, b.outstanding,
               b.open_invoices, b.oldest_due_at,
               (${CLINIC_TODAY} - b.oldest_due_at::date) as days_outstanding,
               b.over_refunded_invoices, b.over_refunded_amount,
               b.void_with_balance_invoices, b.void_with_balance_amount
          from jmc.patient_balances b
          join jmc.patients pt on pt.id = b.patient_id
         where b.outstanding <> 0 or b.under_review_invoices > 0
         order by (b.under_review_invoices > 0) desc, b.outstanding desc`),
      repayments: await all(`
        select y.received_at, p.name as patient, y.receipt_number, y.kind, y.method, y.amount
          from jmc.payments y
          join jmc.patients p on p.id = y.patient_id
         where y.status = 'received'
         order by y.received_at desc limit 500`),
    }),
  },

  /** Voids, refunds and reversals — the three ways money moves backwards. */
  reversals: {
    roles: ['admin'],
    run: async () => ({
      voidedInvoices: await all(`
        select i.invoice_number, coalesce(p.name, 'Anonymous') as patient, i.void_reason,
               s.name as voided_by, i.voided_at
          from jmc.invoices i
          join jmc.staff s on s.id = i.voided_by
          left join jmc.patients p on p.id = i.patient_id
         where i.status = 'void' order by i.voided_at desc limit 200`),
      refunds: await all(`
        select y.receipt_number, y.received_at, y.method, y.amount, y.note,
               s.name as issued_by, coalesce(p.name, 'Anonymous') as patient
          from jmc.payments y
          join jmc.staff s on s.id = y.received_by
          left join jmc.patients p on p.id = y.patient_id
         where y.kind = 'refund' order by y.received_at desc limit 200`),
      reversedPayments: await all(`
        select y.receipt_number, y.received_at, y.method, y.amount, y.reversal_reason,
               s.name as reversed_by, y.reversed_at
          from jmc.payments y
          join jmc.staff s on s.id = y.reversed_by
         where y.status = 'reversed' order by y.reversed_at desc limit 200`),
      reversedDispenses: await all(`
        select d.dispense_number, p.name as patient, d.reversal_reason,
               s.name as reversed_by, d.reversed_at
          from jmc.dispenses d
          join jmc.patients p on p.id = d.patient_id
          join jmc.staff s on s.id = d.reversed_by
         where d.status = 'reversed' order by d.reversed_at desc limit 200`),
      adjustments: await all(`
        select v.created_at, m.name as medicine, b.batch_number, v.movement_type,
               v.quantity_delta, v.bucket, v.reason, s.name as actor, a.name as approved_by
          from jmc.stock_movements v
          join jmc.medicines m on m.id = v.medicine_id
          join jmc.batches b on b.id = v.batch_id
          join jmc.staff s on s.id = v.actor_id
          left join jmc.staff a on a.id = v.approved_by
         where v.movement_type like 'adjust%' or v.reverses_movement_id is not null
         order by v.created_at desc limit 200`),
    }),
  },

  /**
   * The bills whose money does not agree with the document it is attached to.
   *
   * `reversals` above is the three ordinary ways money moves backwards, each of
   * which lands somewhere sensible. This is the queue of the two that do not,
   * and `review_state` on every row says which one it is rather than leaving
   * the reader to work it out from the sign of a number:
   *
   *   `over_refunded` — net allocated payment BELOW zero. A refund that stands
   *   and a receipt that turned out never to have settled: two real events that
   *   disagree, and the clinic is down the difference.
   *
   *   `void_with_balance` — a CANCELLED bill that is not at zero, in either
   *   direction. Money held against a document that says it was never owed, or
   *   money refunded past one. Going forward it is unreachable — voiding
   *   requires exactly zero and no receipt on a voided bill may be reversed —
   *   so every row of it came out of carried-over history (policy register
   *   58–61).
   *
   * Nothing at the counter resolves either. Voiding an over-refund is refused,
   * taking payment against one would charge the patient for the clinic's own
   * error, and refunding a void-with-balance away — the obvious repair — is a
   * correction an accountant has to approve. Which is why this report is admin
   * only: it is the accountant's work, not the counter's (policy register
   * 49–52, 56, 58–61).
   *
   * `paid` is signed, so the row says which side of zero the bill is on, and
   * `out_of_balance` is how far from zero it is whichever side that is — which
   * is why it, and not a figure that assumes a negative balance, is what the
   * queue sorts on.
   *
   * The documents travel with the queue rather than being left to a second
   * lookup. "Which receipts?" is the first question anybody asks of one of
   * these, and an exception that cannot answer it sends the reader back to the
   * database to find out — which is how an exception stops being looked at.
   */
  financial_review: {
    roles: ['admin'],
    run: async () => ({
      queue: await all(`
        select q.invoice_number, q.patient_name as patient, q.review_state, q.status,
               q.created_at, q.total, q.paid, q.out_of_balance, q.due,
               q.void_reason, q.voided_at,
               q.receipts_in, q.receipts_out, q.receipts_reversed, q.documents
          from jmc.financial_review_queue q
         order by q.out_of_balance desc, q.created_at limit 500`),
      /*
       * One row per linked document, not one string per bill.
       *
       * `amount` is what this receipt put against THIS invoice — a receipt
       * split across two bills appears once per bill, for its share — because
       * what moved the balance to where it sits now is the allocation rather
       * than the receipt total. Reversed receipts stay in the list with
       * their status and reason: a reversal is most of the story of how the
       * bill got here.
       */
      documents: await all(`
        select y.receipt_number, y.received_at, y.kind, y.method, y.reference,
               a.amount, y.status, y.reversal_reason, y.note,
               s.name as received_by, q.invoice_number,
               coalesce(p.name, 'Anonymous') as patient
          from jmc.financial_review_queue q
          join jmc.payment_allocations a on a.invoice_id = q.invoice_id
          join jmc.payments y on y.id = a.payment_id
          join jmc.staff s on s.id = y.received_by
          left join jmc.patients p on p.id = y.patient_id
         order by q.out_of_balance desc, y.received_at, y.receipt_number
         limit 1000`),
      /*
       * The patients behind the queue, on the queue's own membership test.
       *
       * `under_review_invoices` rather than `over_refunded_invoices`, or a
       * patient whose only exception is a cancelled bill with money against it
       * has no row here while their bill has one above — the two halves of the
       * same report disagreeing about who is on it. The sort adds the two
       * magnitudes because either alone buries the other kind at the bottom of
       * the list at zero; it is a worst-first ordering, not a total anybody
       * should read off the screen, and the two amounts are carried separately
       * for that reason.
       */
      patients: await all(`
        select b.name as patient, pt.phone, b.billed, b.paid, b.outstanding,
               b.over_refunded_invoices, b.over_refunded_amount,
               b.void_with_balance_invoices, b.void_with_balance_amount
          from jmc.patient_balances b
          join jmc.patients pt on pt.id = b.patient_id
         where b.under_review_invoices > 0
         order by (b.over_refunded_amount + abs(b.void_with_balance_amount))::numeric(14,2) desc,
                  b.name limit 500`),
    }),
  },

  /** Who is due back, and who has not come. */
  follow_ups: {
    roles: ['admin', 'doctor', 'nurse'],
    run: async () => ({
      rows: await all(`
        select f.due_date, p.name as patient, p.phone, d.name as doctor, f.note, f.status,
               (f.due_date::date < ${CLINIC_TODAY}) as overdue
          from jmc.follow_ups f
          join jmc.patients p on p.id = f.patient_id
          join jmc.staff d on d.id = f.doctor_id
         where f.status = 'open'
         order by f.due_date`),
    }),
  },

  /**
   * Who looked at which photograph, and who was turned away.
   *
   * Admin only, and it carries no image content — an audit of who saw a
   * clinical photograph is not itself a reason for more people to see one.
   */
  image_access: {
    roles: ['admin'],
    run: async (since) => ({
      rows: await all(`
        select e.created_at, s.name as actor, e.action, e.basis,
               p.name as patient, i.category, i.body_site, i.status as image_status
          from jmc.image_access_events e
          join jmc.staff s on s.id = e.actor_id
          join jmc.clinical_images i on i.id = e.image_id
          join jmc.patients p on p.id = i.patient_id
         where e.created_at >= ?::timestamptz
         order by e.created_at desc limit 1000`, since),
      refusals: await all(`
        select e.basis, count(*)::int as times, max(e.created_at) as last_seen
          from jmc.image_access_events e
         where e.action = 'refused' and e.created_at >= ?::timestamptz
         group by e.basis order by times desc`, since),
      grants: await all(`
        select g.reason, s.name as granted_to, d.name as granted_by, g.granted_at, g.expires_at,
               g.revoked_at, r.name as revoked_by,
               coalesce(p.name, 'one image') as scope
          from jmc.image_access_grants g
          join jmc.staff s on s.id = g.staff_id
          join jmc.staff d on d.id = g.granted_by
          left join jmc.staff r on r.id = g.revoked_by
          left join jmc.patients p on p.id = g.patient_id
         order by g.granted_at desc limit 200`),
      retention: await all(`
        select image_id, patient_name, captured_at, last_contact, review_due_at
          from jmc.image_retention_queue order by review_due_at limit 500`),
    }),
  },
}

/**
 * Run one query, filling every `?` with the same cutoff.
 *
 * A report's date range appears once in the caller and several times in the
 * SQL — `where created_at >= ?` in three subqueries of the same report — and
 * the driver numbers placeholders positionally. Repeating the argument by hand
 * is a count that drifts the first time somebody adds a clause, so it is
 * counted here instead.
 */
async function all(text: string, since?: string): Promise<Row[]> {
  const placeholders = (text.match(/\?/g) ?? []).length
  if (placeholders === 0) return db.prepare(text).all() as Promise<Row[]>
  if (since === undefined) throw new Error('A dated report needs its range.')
  return db.prepare(text).all(...Array.from({ length: placeholders }, () => since)) as Promise<Row[]>
}

/**
 * Clinic-local midnight, `days` ago, as the ISO string the older text columns
 * hold and the newer timestamptz columns cast from.
 *
 * Asked of Postgres rather than computed in JavaScript, for the reason
 * `clinicInstant` in commands.ts sets out at length: the runtime is UTC, the
 * clinic is not, and a date arithmetic done in the wrong one of those is five
 * and a half hours wrong for part of every day.
 *
 * Default seven days rather than "everything", because a report that reads two
 * years of movements to draw one screen is a report nobody opens twice.
 */
async function cutoffFor(days: number): Promise<string> {
  const row = await db.prepare(
    `select to_char(
       ((date_trunc('day', now() at time zone 'Asia/Kolkata') - ((? || ' days')::interval))
          at time zone 'Asia/Kolkata') at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
  ).get(String(days)) as { at: string }
  return row.at
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  const url = new URL(request.url)
  const name = url.searchParams.get('report') ?? ''

  if (name === 'index') {
    return json({
      ok: true,
      reports: Object.entries(REPORTS)
        .filter(([, report]) => hasRole(session as SessionView, ...report.roles))
        .map(([id]) => id),
    })
  }

  const report = REPORTS[name]
  if (!report) return json({ ok: false, message: 'Unknown report.' }, 400)
  if (!hasRole(session as SessionView, ...report.roles)) {
    return json({ ok: false, message: 'Your role cannot read that report.' }, 403)
  }

  try {
    const asked = Number(url.searchParams.get('days') ?? 7)
    const days = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 0), 400) : 7
    const result = await report.run(await cutoffFor(days)) as Record<string, unknown>
    return json({ ok: true, report: name, days, ...result })
  } catch (error) {
    console.error(`report ${name} failed:`, error)
    return json({ ok: false, message: 'That report could not be read.' }, 500)
  }
})

/** Exported for the tests, which check the role matrix without a round trip. */
export { REPORTS }
