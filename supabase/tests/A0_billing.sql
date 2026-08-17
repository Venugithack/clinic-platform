-- M4 — billing, the day-book and the till (PLAN.md §8).
--
-- The milestone's gate is two equalities. One is arithmetic and cannot fail;
-- the other is physical and is the whole reason the till exists:
--
--   the day's total matches the sum of its bills
--   the till reconciles against counted cash
--
-- Both are asserted below, along with the three properties that make a bill
-- series survive an inspection: the numbers are gapless, they restart with the
-- financial year, and a cancelled bill keeps its number.
begin;
select * from no_plan();

insert into clinic (id, name, consult_fee, follow_up_free_days) values
  ('cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Test Clinic', 300, 7);

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000b1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000b1'),
  ('50000000-0000-0000-0000-0000000000b2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000b2');

insert into patients (id, name, consent_given_at) values
  ('70000000-0000-0000-0000-0000000000b1', 'Ravi Kumar', now());

insert into encounters (id, patient_id, doctor_id) values
  ('60000000-0000-0000-0000-0000000000b1', '70000000-0000-0000-0000-0000000000b1',
   '50000000-0000-0000-0000-0000000000b1');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule, hsn) values
  ('d0000000-0000-0000-0000-0000000000b1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', '3004'),
  ('d0000000-0000-0000-0000-0000000000b2', 'Cetzine', 'Cetirizine', '10mg',
   'tablet', 'tablet', 'OTC', '3004');

-- Two batches of the drug the patient is given, with different expiries, MRPs
-- and strip sizes — the gate says "4 medicines across 2 batches", and the
-- interesting half of that is one drug spanning two of them.
insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  ('b0000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1',
   'DL-A', current_date + 60,  10, 10, 24.00, 'strip', 1.20, 12, 12),
  ('b0000000-0000-0000-0000-0000000000b2', 'd0000000-0000-0000-0000-0000000000b1',
   'DL-B', current_date + 400, 15, 10, 34.50, 'strip', 1.90, 100, 100),
  ('b0000000-0000-0000-0000-0000000000b3', 'd0000000-0000-0000-0000-0000000000b2',
   'CZ-A', current_date + 300, 10, 10, 44.00, 'strip', 2.60, 100, 100);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt', '50000000-0000-0000-0000-0000000000b2'
from stock_batches b;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000b2', true);

-- 20 Dolo: FEFO empties DL-A (12 at 2.40 each) and takes 8 from DL-B (2.30
-- each), so this one drug produces two bill lines from two batches.
create temporary table t_dispense as
select app.dispense(
  '[{"drug_id": "d0000000-0000-0000-0000-0000000000b1", "qty_base": 20},
    {"drug_id": "d0000000-0000-0000-0000-0000000000b2", "qty_base": 10}]'::jsonb,
  null, '70000000-0000-0000-0000-0000000000b1', true) as id;

-- ---------------------------------------------------------------------------
-- The bill.
-- ---------------------------------------------------------------------------
create temporary table t_bill as
select * from app.raise_bill(
  '70000000-0000-0000-0000-0000000000b1',
  '60000000-0000-0000-0000-0000000000b1',
  (select jsonb_build_array(id) from t_dispense),
  null, 0, null);

select matches(
  (select bill_no from t_bill),
  '^\d{4}-\d{2}/00001$',
  'the first bill of the financial year is number one, and the year is in the number'
);

select is(
  (select count(*)::int from bill_lines where bill_id = (select id from t_bill)
   and kind = 'medicine'),
  3,
  'one line per batch: 20 Dolo across two batches is two lines, not one'
);

select is(
  (select consult_fee from t_bill),
  300.00::numeric,
  'the consult fee comes from clinic settings when the caller does not say'
);

-- 12 × 2.40 = 28.80, 8 × 2.30 = 18.40, 10 Cetzine at 4.40 = 44.00 → 91.20
select is(
  (select medicines_total from t_bill),
  91.20::numeric,
  'medicines are copied from the dispense, priced under the MRP ceiling app.dispense already applied'
);

select is(
  (select total from t_bill),
  391.00::numeric,
  'and the bill rounds DOWN to the rupee — rounding up can put a line over its printed MRP'
);

select is(
  (select round_off from t_bill),
  -0.20::numeric,
  'with the rounding recorded rather than lost'
);

select is(
  (select bill_id from dispenses where id = (select id from t_dispense)),
  (select id from t_bill),
  'the dispense is now on this bill and cannot be billed twice'
);

-- ---------------------------------------------------------------------------
-- Cash needs a drawer.
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select app.take_payment(%L, 'cash', 391.00) $$, (select id from t_bill)),
  'CL020',
  null,
  'cash with no till open cannot be reconciled against anything, so it is refused'
);

create temporary table t_till as
select * from app.open_till(2000);

select throws_ok(
  $$ select app.open_till(500) $$,
  'CL019',
  null,
  'two open tills means every sale lands in one of them arbitrarily'
);

select throws_ok(
  format($$ select app.take_payment(%L, 'cash', 400.00) $$, (select id from t_bill)),
  'CL021',
  null,
  'a payment that does not settle the bill is a typo, and v1 has no debtor ledger to put it in'
);

select is(
  (select status::text from app.take_payment((select id from t_bill), 'cash', 391.00)),
  'paid',
  'the right amount settles it'
);

select throws_ok(
  format($$ select app.take_payment(%L, 'cash', 391.00) $$, (select id from t_bill)),
  'CL007',
  null,
  'and it cannot be paid twice'
);

select is(
  (select expected_cash from till_reconciliation where till_id = (select id from t_till)),
  2391.00::numeric,
  'the drawer knows what should be in it: float plus the cash it took'
);

-- ---------------------------------------------------------------------------
-- Petty cash, which is what makes a variance mean anything.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.record_cash('payout', 150.00, 'courier') $$,
  'money can leave the drawer for something that is not a bill'
);

select throws_ok(
  $$ select app.record_cash('payout', 50, null) $$,
  'CL006',
  null,
  'but never without a reason — an unexplained payout is indistinguishable from a shortfall'
);

select is(
  (select expected_cash from till_reconciliation where till_id = (select id from t_till)),
  2241.00::numeric,
  'and the expectation follows it down'
);

-- ---------------------------------------------------------------------------
-- THE GATE, part one: the day's total matches the sum of its bills.
-- ---------------------------------------------------------------------------
select is(
  (select net_total from day_book where day = app.clinic_day(now())),
  (select sum(total) from bills where status <> 'cancelled'),
  'the day-book total is the sum of the day''s bills'
);

select is(
  (select consult_total + medicines_total - discount + round_off
   from day_book where day = app.clinic_day(now())),
  (select net_total from day_book where day = app.clinic_day(now())),
  'and it adds up from its own parts: consult plus medicines, less discount, less the rounding'
);

select is(
  (select cash + upi + card + unpaid from day_book where day = app.clinic_day(now())),
  (select net_total from day_book where day = app.clinic_day(now())),
  'every rupee billed is in exactly one column — taken, or still owed'
);

-- ---------------------------------------------------------------------------
-- THE GATE, part two: the till reconciles against counted cash.
-- ---------------------------------------------------------------------------
select is(
  (select variance from app.close_till((select id from t_till), 2241.00)),
  0.00::numeric,
  'counted equals expected, and the drawer is square'
);

select is(
  (select expected_cash from till_sessions where id = (select id from t_till)),
  (select t.opening_float + coalesce(sum(m.amount), 0)
   from till_sessions t left join cash_movements m on m.till_id = t.id
   where t.id = (select id from t_till) group by t.opening_float),
  'the frozen expectation agrees with the drawer''s own movements'
);

select throws_ok(
  format($$ select app.close_till(%L, 2241.00) $$, (select id from t_till)),
  'CL007',
  null,
  'a closed till cannot be closed again'
);

-- A short drawer is information, and it is kept as information.
create temporary table t_till2 as select * from app.open_till(1000);

select is(
  (select variance from app.close_till((select id from t_till2), 900.00)),
  -100.00::numeric,
  'a hundred rupees short is recorded as a hundred rupees short — never reconciled away'
);

-- ---------------------------------------------------------------------------
-- The number series, which has to survive an inspection.
-- ---------------------------------------------------------------------------
create temporary table t_bill2 as
select * from app.raise_bill(
  '70000000-0000-0000-0000-0000000000b1', null, '[]'::jsonb, 200, 0, 'second');

select matches(
  (select bill_no from t_bill2),
  '/00002$',
  'numbers are sequential'
);

select lives_ok(
  format($$ select app.void_bill(%L, 'wrong patient') $$, (select id from t_bill2)),
  'an unpaid bill can be cancelled at the counter, with a reason'
);

select is(
  (select bill_no from bills where id = (select id from t_bill2)),
  (select bill_no from t_bill2),
  'and it KEEPS its number — deleting it would put a hole in the series, which is the thing the series rules out'
);

select is(
  (select status from bills where id = (select id from t_bill2)),
  'cancelled',
  'cancellation is a status'
);

select is(
  (select cancelled from day_book where day = app.clinic_day(now())),
  1,
  'the day-book counts it separately: what we took and what we got wrong are different questions'
);

select throws_ok(
  format($$ select app.void_bill(%L, 'changed my mind') $$, (select id from t_bill)),
  'CL005',
  null,
  'the counter cannot cancel a PAID bill — that is a refund, and it is the doctor''s call'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000b1', true);

select throws_ok(
  format($$ select app.void_bill(%L, 'refunded in full') $$, (select id from t_bill)),
  'CL020',
  null,
  'and the doctor cannot either while no drawer is open — a cash refund comes out of a till somebody is counting'
);

-- ---------------------------------------------------------------------------
-- The follow-up window: policy the doctor set, not an inference.
-- ---------------------------------------------------------------------------
insert into encounters (id, patient_id, doctor_id) values
  ('60000000-0000-0000-0000-0000000000b2', '70000000-0000-0000-0000-0000000000b1',
   '50000000-0000-0000-0000-0000000000b1');

create temporary table t_bill3 as
select * from app.raise_bill(
  '70000000-0000-0000-0000-0000000000b1',
  '60000000-0000-0000-0000-0000000000b2', '[]'::jsonb, null, 0, null);

select is(
  (select consult_fee from t_bill3),
  0.00::numeric,
  'a repeat visit inside the free-follow-up window his clinic set is not charged'
);

select is(
  (select consult_fee_basis from t_bill3),
  'follow_up_free',
  'and the bill records why it was free, rather than looking like a mistake'
);

select is(
  (select count(*)::int from bill_lines
   where bill_id = (select id from t_bill3) and amount = 0),
  1,
  'it is printed at zero rather than omitted, so the patient can see it was free'
);

-- ---------------------------------------------------------------------------
-- Transition-owned, like everything else that moves money.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ update bills set status = 'paid' $$,
  '42501',
  null,
  'no screen can mark a bill paid with a direct write'
);

select throws_ok(
  $$ insert into cash_movements (till_id, kind, amount, staff_id)
     values ((select id from t_till), 'sale', 5000, '50000000-0000-0000-0000-0000000000b2') $$,
  '42501',
  null,
  'and cash cannot be added to a drawer by hand'
);

reset role;

select * from finish();
rollback;
