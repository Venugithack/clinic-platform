-- ═══════════════════════════════════════════════════════════════════════════
-- A VOIDED BILL THAT IS NOT AT ZERO
--
-- The previous migration gave a name to a bill more money had left than
-- entered. It left two ways for one to exist that nothing would say out loud.
--
-- THE FIRST WAS A DOOR THAT ONLY OPENED INWARDS. `reverse_payment` refused any
-- reversal that left a bill below zero — including the reversal of a REFUND,
-- which can only ever move a bill towards zero. A bill sitting at minus eighty
-- rupees with two forty-rupee refunds against it could not be walked back one
-- refund at a time, because the first step lands on minus forty and minus
-- forty is still below zero. The only exit from the state was refused by the
-- rule that existed to stop anyone entering it.
--
-- THE SECOND WAS THE OTHER SIDE OF THE SAME CHECK. Take ₹100, refund ₹100,
-- and the bill is at zero and may be voided — correctly. Then reverse the
-- refund. That moves the bill UP, to plus a hundred, so the old check waved it
-- through: a voided bill with a hundred rupees of the patient's money sitting
-- against it and no screen that would ever mention it. Voiding is allowed only
-- at exactly zero, so nothing else could put it there.
--
-- Both are closed in the commands. What this migration adds is the word for
-- the ones that are already true in history: `void_with_balance`, a voided
-- bill whose net allocated payment is not zero, in EITHER direction. Money
-- held against a cancelled bill and money refunded past a cancelled bill are
-- different errors, and neither is allowed to hide behind the word `void`.
--
-- Policy register items 58-61. Nothing here invents a balancing entry, and
-- nothing here changes a stored row: forward-only, views only.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The bill ────────────────────────────────────────────────────────────
--
-- `void_with_balance` is tested before everything, including `over_refunded`,
-- because it is the more specific statement about the same bill. A voided bill
-- at minus forty is over-refunded AND voided, and of those two facts the one
-- that tells somebody what to do is that it was cancelled with money still
-- against it. The money is not lost from the arithmetic by the relabelling:
-- `paid` is still negative, `patient_balances` still counts it as an
-- over-refund, and it is still on the review queue.
--
-- Going forward the state is unreachable. `void_invoice` allows a void only at
-- exactly zero, and `reverse_payment` now refuses every receipt allocated to a
-- voided bill. So every row this ever matches came out of the history the
-- clinic is carrying across, which is the only reason it needs a name at all.
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
    when i.status = 'void' and coalesce(p.paid, 0) <> 0 then 'void_with_balance'
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
-- The two over-refund columns are defined on the MONEY — `paid < 0` — and not
-- on the state label, which is what keeps them from silently emptying when a
-- bill is relabelled `void_with_balance` above. They count exactly the bills
-- they counted before this migration.
--
-- `under_review_invoices` is the queue's own membership test, so the number on
-- a patient's row and the number of their rows on the queue are the same
-- number, and a bill that is both over-refunded and voided is counted once.
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
  count(*) filter (where b.paid < 0) as over_refunded_invoices,
  coalesce(-sum(b.paid) filter (where b.paid < 0), 0)::numeric(12,2) as over_refunded_amount,
  count(*) filter (where b.status = 'void' and b.paid <> 0) as void_with_balance_invoices,
  coalesce(sum(b.paid) filter (where b.status = 'void' and b.paid <> 0), 0)::numeric(12,2)
    as void_with_balance_amount,
  count(*) filter (where b.paid < 0 or (b.status = 'void' and b.paid <> 0))
    as under_review_invoices
from jmc.patients pt
left join jmc.invoice_balances b on b.patient_id = pt.id
group by pt.id, pt.name;


-- ── 3. The review queue ────────────────────────────────────────────────────
--
-- Dropped and rebuilt rather than replaced, because `over_refunded_by` has to
-- go. It was a positive magnitude that assumed the balance was negative, and
-- the queue now carries rows where it is positive — money held against a
-- cancelled bill — for which "over-refunded by minus a hundred" is not a
-- sentence anybody should have to read.
--
-- In its place: `paid`, which is signed and says which side of zero the bill
-- is on, and `out_of_balance`, which is how far from zero it is regardless of
-- direction and is therefore what the queue sorts on. `review_state` repeats
-- the invoice's own `payment_state` so that a row and a badge cannot disagree.
--
-- Still derived, so nothing has to be enqueued and nothing can be dequeued by
-- forgetting. A bill is on this list exactly while the arithmetic says so.
drop view if exists jmc.financial_review_queue;

create view jmc.financial_review_queue
with (security_invoker = true) as
select
  b.id as invoice_id,
  b.invoice_number,
  b.patient_id,
  pt.name as patient_name,
  b.status,
  b.payment_state as review_state,
  b.created_at,
  b.total,
  b.paid,
  abs(b.paid)::numeric(12,2) as out_of_balance,
  b.due,
  i.void_reason,
  i.voided_at,
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
-- Both directions, and both reasons. A bill below zero whatever its status,
-- and a cancelled bill that is not at zero whichever side of zero it is on.
where b.paid < 0
   or (b.status = 'void' and b.paid <> 0);


-- ── 4. Access ──────────────────────────────────────────────────────────────
--
-- `drop view` took the queue's grants with it, so they are re-stated here
-- rather than assumed. Nothing in the private schema is reachable through the
-- Data API; the Edge Functions connect as the owner.
revoke all on jmc.invoice_balances, jmc.patient_balances, jmc.financial_review_queue
  from public, anon, authenticated, service_role;
