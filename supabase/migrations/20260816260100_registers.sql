-- Registers and reports. PLAN.md §8 M8, §15.2.
--
-- This migration contains no transitions, and that is worth saying out loud: a
-- register is a **reading of what already happened**. If a register needed a
-- write to be correct, the thing it reports on was recorded wrong. Every column
-- below already exists somewhere in the ledger; the work here is arranging it
-- into the shape an inspector, an accountant or a recall notice asks for.
--
-- §15.2's four legally-motivated ones:
--
--   Schedule H1 register    date, patient name AND ADDRESS, drug, quantity,
--                           prescriber. Retained three years
--   Purchase register       inspection, and the invoice behind every batch
--   Batch traceability      recall: who was given this batch, and when
--   Expiry write-off        disposal audit
--
-- On retention: nothing here deletes anything, and nothing should. Three years
-- is the floor for the H1 register, and the audit log and stock ledger are both
-- append-only already, so the retention question is a backup question
-- (HOSTING.md §5) rather than a schema one.
--
-- On DPDP: the H1 register is the most sensitive object in the build — it is a
-- list of named people, their addresses, and the controlled drugs they were
-- given. It is granted to `authenticated` only, and a pgTAP test asserts that
-- `anon` cannot read it. M6 opened exactly one anon-readable view and this is
-- the migration that has to keep proving that number is still one.

-- ---------------------------------------------------------------------------
-- The Schedule H1 register.
--
-- H1 cannot leave on a counter sale — app.dispense refuses it — so every row
-- here has a prescription behind it, and therefore a prescriber to name. That
-- refusal is what makes this register complete by construction rather than by
-- diligence.
-- ---------------------------------------------------------------------------
create view h1_register as
select
  dl.id                       as dispense_line_id,
  d.at                        as dispensed_at,
  app.clinic_day(d.at)        as dispensed_on,
  p.name                      as patient_name,
  p.address                   as patient_address,
  p.phone                     as patient_phone,
  dr.name                     as drug_name,
  dr.strength,
  dr.schedule,
  dl.qty_base,
  b.batch_no,
  b.expiry,
  pres.id                     as prescription_id,
  pres.signed_at              as prescribed_at,
  doc.name                    as prescriber_name,
  doc.reg_no                  as prescriber_reg_no,
  disp.name                   as dispensed_by,
  -- The gap that makes a register unacceptable, surfaced instead of silently
  -- exported blank. The rule requires the patient's address; a row without one
  -- is a row to go and fix before somebody official asks.
  (p.address is null or length(trim(p.address)) = 0) as address_missing
from dispense_lines dl
join dispenses d       on d.id = dl.dispense_id
join drugs dr          on dr.id = dl.drug_id
join stock_batches b   on b.id = dl.batch_id
left join patients p   on p.id = d.patient_id
left join prescriptions pres on pres.id = d.prescription_id
left join staff doc    on doc.id = pres.doctor_id
left join staff disp   on disp.id = d.staff_id
where dr.schedule = 'H1';

comment on view h1_register is
  'Legally required, retained three years (PLAN.md §15.2). Complete by construction: H1 cannot leave on a counter sale, so every row has a prescriber.';

-- ---------------------------------------------------------------------------
-- Batch traceability — the recall query.
--
-- This is the one that justifies carrying batch_id on every dispense line. A
-- manufacturer recalls batch DL2411A; the question is who is holding it, and
-- the answer has to arrive in seconds rather than from a paper day-book.
-- ---------------------------------------------------------------------------
create view batch_trace as
select
  b.id                   as batch_id,
  b.batch_no,
  dr.name                as drug_name,
  dr.strength,
  b.expiry,
  d.at                   as dispensed_at,
  dl.qty_base,
  p.id                   as patient_id,
  p.name                 as patient_name,
  p.phone                as patient_phone,
  d.is_counter_sale,
  disp.name              as dispensed_by,
  bl.bill_id
from stock_batches b
join drugs dr          on dr.id = b.drug_id
join dispense_lines dl on dl.batch_id = b.id
join dispenses d       on d.id = dl.dispense_id
left join patients p   on p.id = d.patient_id
left join staff disp   on disp.id = d.staff_id
left join bill_lines bl on bl.dispense_line_id = dl.id;

comment on view batch_trace is
  'Who was given this batch. A counter sale has no patient — that gap is real and the row still appears, because it is stock that left the building.';

-- ---------------------------------------------------------------------------
-- Purchase register — every invoice, and what came in on it.
-- ---------------------------------------------------------------------------
create view purchase_register as
select
  g.id                as grn_id,
  g.received_at,
  app.clinic_day(g.received_at) as received_on,
  g.invoice_no,
  g.invoice_date,
  g.awaiting_invoice,
  s.name              as supplier_name,
  s.gstin             as supplier_gstin,
  po.po_no,
  g.total,
  st.name             as received_by,
  (select count(*) from grn_lines l where l.grn_id = g.id)::int as lines,
  (select coalesce(sum(l.qty_base + l.free_qty_base), 0) from grn_lines l
   where l.grn_id = g.id)::int as qty_base
from goods_receipts g
left join suppliers s        on s.id = g.supplier_id
left join purchase_orders po on po.id = g.po_id
left join staff st           on st.id = g.received_by;

-- ---------------------------------------------------------------------------
-- Expiry write-offs — the disposal record.
-- ---------------------------------------------------------------------------
create view expiry_writeoff_register as
select
  m.id               as movement_id,
  m.at,
  app.clinic_day(m.at) as written_off_on,
  dr.name            as drug_name,
  dr.strength,
  b.batch_no,
  b.expiry,
  -- Stored signed in the ledger; a register reads better with the quantity
  -- destroyed as a positive number and the sign carried by the column name.
  (-m.qty_base)      as qty_base_written_off,
  round((-m.qty_base) * b.cost_per_base_unit, 2) as value_at_cost,
  m.reason,
  st.name            as written_off_by
from stock_movements m
join stock_batches b on b.id = m.batch_id
join drugs dr        on dr.id = m.drug_id
left join staff st   on st.id = m.staff_id
where m.type = 'writeoff_expiry';

-- ---------------------------------------------------------------------------
-- Sales register — one row per bill, for the accountant and for GST the day it
-- is switched on (Q4).
-- ---------------------------------------------------------------------------
create view sales_register as
select
  bi.id             as bill_id,
  bi.bill_no,
  bi.created_at,
  app.clinic_day(bi.created_at) as billed_on,
  p.name            as patient_name,
  bi.consult_fee,
  bi.medicines_total,
  bi.discount,
  bi.round_off,
  bi.total,
  bi.status,
  bi.method,
  st.name           as raised_by,
  bi.void_reason
from bills bi
left join patients p on p.id = bi.patient_id
left join staff st   on st.id = bi.raised_by;

-- ---------------------------------------------------------------------------
-- Grants. Every one of these carries patient data or clinic money, so they stop
-- at `authenticated` — the public surface is still exactly one view.
-- ---------------------------------------------------------------------------
grant select on h1_register, batch_trace, purchase_register,
                expiry_writeoff_register, sales_register to authenticated;

comment on view sales_register is
  'One row per bill including cancelled ones, which is what makes it a register rather than a summary.';
