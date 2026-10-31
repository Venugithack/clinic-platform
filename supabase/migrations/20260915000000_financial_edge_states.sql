-- ═══════════════════════════════════════════════════════════════════════════
-- FINANCIAL EDGE STATES
--
-- A bill against which more money has gone out than ever came in.
--
-- Slice 4 modelled money as events and derived unpaid / part paid / paid from
-- them, which is right. What it did not have was a word for the case where the
-- arithmetic lands BELOW zero. There are two ways to get there:
--
--   Take ₹100, refund ₹40, then reverse the ₹100 receipt because the card
--   never actually settled. The refund stands, the payment does not, and the
--   clinic is ₹40 down on a bill nobody ever paid.
--
--   Or it is simply already true in the history being carried across, and
--   nobody knows why.
--
-- Before this migration that invoice read `unpaid` — the same word as a bill
-- printed five minutes ago and not yet taken to the counter. It is not the
-- same thing, it is not resolved by taking payment, and calling it `unpaid`
-- puts it in a queue where it will be ignored.
--
-- So it gets its own word, `over_refunded`, and the counts that make it
-- findable on the patient's row and in the reports. Nothing here changes a
-- single stored row: an over-refund is two real events, and the correction for
-- it is an accountant's decision, not a balancing entry this schema invents.
-- See docs/OWNER_POLICY_REGISTER.md items 49–52.
--
-- Forward-only, and views only. No table, column, constraint or row is touched.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The bill ────────────────────────────────────────────────────────────
--
-- `over_refunded` is tested FIRST, ahead of `void`, and that order is the
-- point rather than an accident. A voided bill that is also over-refunded is
-- precisely the case somebody has to look at; letting `void` win would file
-- the exception under "closed" and it would never be seen again. Voiding is
-- refused while the balance is negative (see counter.ts), so going forward the
-- combination can only arrive from history — which is exactly the history that
-- must not be allowed to hide.
--
-- `due` is left as it is: total minus a negative paid, which is larger than
-- the total. That is what the arithmetic says and it is not this view's job to
-- flatten it into something more comfortable.
create or replace view jmc.invoice_balances
with (security_invoker = true) as
select
  i.id,
  i.invoice_number,
  i.patient_id,
  i.encounter_id,
  i.status,
  i.created_at,
  coalesce(l.total, 0)::numeric(12,2) as total,
  coalesce(p.paid, 0)::numeric(12,2) as paid,
  (coalesce(l.total, 0) - coalesce(p.paid, 0))::numeric(12,2) as due,
  case
    when coalesce(p.paid, 0) < 0                        then 'over_refunded'
    when i.status = 'void'                              then 'void'
    when coalesce(p.paid, 0) >= coalesce(l.total, 0)    then 'paid'
    when coalesce(p.paid, 0) > 0                        then 'part_paid'
    else 'unpaid'
  end as payment_state
from jmc.invoices i
left join lateral (
  select sum(amount) as total from jmc.invoice_lines where invoice_id = i.id
) l on true
left join lateral (
  -- A refund is money out, so it reduces what has been paid. A reversed
  -- payment counts for nothing at all, which is different from a refund: one
  -- says the money came back, the other says it never arrived.
  select sum(case when y.kind = 'refund' then -a.amount else a.amount end) as paid
    from jmc.payment_allocations a
    join jmc.payments y on y.id = a.payment_id
   where a.invoice_id = i.id and y.status = 'received'
) p on true;


-- ── 2. The patient ─────────────────────────────────────────────────────────
--
-- `outstanding` keeps summing `due`, so an over-refunded bill inflates it —
-- correctly, because the clinic really is owed that money back. What was
-- missing is any sign on the row that part of the figure is an exception
-- rather than an ordinary unpaid bill, so a dues list reads as a list of
-- people to chase when one of them is a list of entries to investigate.
--
-- The two new columns are counted over the same invoices as everything else,
-- so they cannot disagree with `outstanding` about which bills were included.
-- Voided bills are excluded from the money columns as before, but NOT from
-- `over_refunded_invoices`: a voided over-refund is still money that left the
-- drawer, and hiding it behind the void is the thing this migration exists to
-- stop.
create or replace view jmc.patient_balances
with (security_invoker = true) as
select
  pt.id as patient_id,
  pt.name,
  coalesce(sum(b.total) filter (where b.status <> 'void'), 0)::numeric(12,2) as billed,
  coalesce(sum(b.paid)  filter (where b.status <> 'void'), 0)::numeric(12,2) as paid,
  coalesce(sum(b.due)   filter (where b.status <> 'void'), 0)::numeric(12,2) as outstanding,
  count(*) filter (where b.status <> 'void' and b.due > 0) as open_invoices,
  max(b.created_at) filter (where b.status <> 'void' and b.due > 0) as oldest_due_at,
  count(*) filter (where b.payment_state = 'over_refunded') as over_refunded_invoices,
  coalesce(-sum(b.paid) filter (where b.payment_state = 'over_refunded'), 0)::numeric(12,2)
    as over_refunded_amount
from jmc.patients pt
left join jmc.invoice_balances b on b.patient_id = pt.id
group by pt.id, pt.name;


-- ── 3. The review queue ────────────────────────────────────────────────────
--
-- Policy register 52: when both the incoming payment and the outgoing refund
-- genuinely happened, both events are retained and the CASE goes to a person.
-- This view is that queue. It is derived, so nothing has to be enqueued and
-- nothing can be dequeued by forgetting: a bill is on it exactly while its net
-- allocated payment is below zero, and it leaves when an accountant-approved
-- correction makes that untrue.
--
-- Every linked document travels with the row — the receipts in, the receipts
-- out, the reversals — because the first question anybody asks of one of these
-- is "which payments?" and a queue that answers it with an invoice number
-- alone sends them back to the database to find out.
create or replace view jmc.financial_review_queue
with (security_invoker = true) as
select
  b.id as invoice_id,
  b.invoice_number,
  b.patient_id,
  pt.name as patient_name,
  b.status,
  b.created_at,
  b.total,
  b.paid,
  (-b.paid)::numeric(12,2) as over_refunded_by,
  b.due,
  i.void_reason,
  coalesce(d.receipts_in, 0)::int as receipts_in,
  coalesce(d.receipts_out, 0)::int as receipts_out,
  coalesce(d.receipts_reversed, 0)::int as receipts_reversed,
  d.documents
from jmc.invoice_balances b
join jmc.invoices i on i.id = b.id
left join jmc.patients pt on pt.id = b.patient_id
left join lateral (
  select
    count(*) filter (where y.kind = 'payment' and y.status = 'received') as receipts_in,
    count(*) filter (where y.kind = 'refund'  and y.status = 'received') as receipts_out,
    count(*) filter (where y.status = 'reversed')                        as receipts_reversed,
    string_agg(
      y.receipt_number || ' ' || y.kind || ' ' || a.amount::text ||
      case when y.status = 'reversed' then ' (reversed)' else '' end,
      ', ' order by y.received_at, y.receipt_number
    ) as documents
    from jmc.payment_allocations a
    join jmc.payments y on y.id = a.payment_id
   where a.invoice_id = b.id
) d on true
where b.paid < 0;


-- ── 4. Access ──────────────────────────────────────────────────────────────
--
-- Same as every other view in the private schema: nothing is reachable through
-- the Data API. The Edge Functions connect as the owner; the roles PostgREST
-- would use are given nothing.
revoke all on jmc.invoice_balances, jmc.patient_balances, jmc.financial_review_queue
  from public, anon, authenticated, service_role;
