-- M8 — registers and reports (PLAN.md §8, §15.2).
--
-- The gate is "the H1 register exports for a date range in a form an inspector
-- accepts", and an inspector's definition of acceptable is narrow: date,
-- patient name AND address, drug, quantity, prescriber. So the assertions here
-- are about completeness, not about formatting — a register that is complete
-- can be laid out any way, and one that is missing the prescriber cannot be
-- rescued by a nice table.
--
-- The second property under test is the one M6 created: exactly ONE object in
-- this database is readable without a session, and it is not any of these.
begin;
select * from no_plan();

insert into clinic (id, name, timezone) values
  ('ceeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Test Clinic', 'Asia/Kolkata');

insert into staff (id, name, role, reg_no, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000e1', 'Dr Rao', 'doctor', 'KMC-12345',
   'a0000000-0000-0000-0000-0000000000e1'),
  ('50000000-0000-0000-0000-0000000000e2', 'Latha', 'counter', null,
   'a0000000-0000-0000-0000-0000000000e2');

insert into patients (id, name, phone, address, consent_given_at) values
  ('70000000-0000-0000-0000-0000000000e1', 'Ravi Kumar', '+919000000011',
   '12 Nehru Street, Kadapa', now()),
  -- Registered in a hurry, as most walk-ins are. The register has to say so.
  ('70000000-0000-0000-0000-0000000000e2', 'Sita Devi', '+919000000012', null, now());

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000e1', 'Alprax 0.25', 'Alprazolam', '0.25mg',
   'tablet', 'tablet', 'H1'),
  ('d0000000-0000-0000-0000-0000000000e2', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC');

insert into suppliers (id, name, gstin) values
  ('50990000-0000-0000-0000-0000000000e1', 'Kumar Distributors', '37AAAAA0000A1Z5');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id)
values
  ('b0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000e1',
   'AX-9001', current_date + 300, 15, 10, 60.00, 'strip', 2.00, 150, 150,
   '50990000-0000-0000-0000-0000000000e1'),
  ('b0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-0000000000e2',
   'DL-9001', current_date - 30, 15, 10, 34.50, 'strip', 1.90, 100, 100,
   '50990000-0000-0000-0000-0000000000e1');

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt', '50000000-0000-0000-0000-0000000000e2'
from stock_batches b;

insert into encounters (id, patient_id, doctor_id) values
  ('60000000-0000-0000-0000-0000000000e1', '70000000-0000-0000-0000-0000000000e1',
   '50000000-0000-0000-0000-0000000000e1'),
  ('60000000-0000-0000-0000-0000000000e2', '70000000-0000-0000-0000-0000000000e2',
   '50000000-0000-0000-0000-0000000000e1');

insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at, status) values
  ('80000000-0000-0000-0000-0000000000e1', '60000000-0000-0000-0000-0000000000e1',
   '70000000-0000-0000-0000-0000000000e1', '50000000-0000-0000-0000-0000000000e1',
   '[{"drug_id": "d0000000-0000-0000-0000-0000000000e1", "qty_base": 10}]'::jsonb,
   now(), 'pending'),
  ('80000000-0000-0000-0000-0000000000e2', '60000000-0000-0000-0000-0000000000e2',
   '70000000-0000-0000-0000-0000000000e2', '50000000-0000-0000-0000-0000000000e1',
   '[{"drug_id": "d0000000-0000-0000-0000-0000000000e1", "qty_base": 5}]'::jsonb,
   now(), 'pending');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000e2', true);

select lives_ok(
  $$ select app.dispense(
       '[{"drug_id": "d0000000-0000-0000-0000-0000000000e1", "qty_base": 10}]'::jsonb,
       '80000000-0000-0000-0000-0000000000e1',
       '70000000-0000-0000-0000-0000000000e1') $$,
  'a Schedule H1 medicine goes out against a prescription'
);

select lives_ok(
  $$ select app.dispense(
       '[{"drug_id": "d0000000-0000-0000-0000-0000000000e1", "qty_base": 5}]'::jsonb,
       '80000000-0000-0000-0000-0000000000e2',
       '70000000-0000-0000-0000-0000000000e2') $$,
  'and so does another, to a patient whose address nobody took'
);

-- ---------------------------------------------------------------------------
-- The H1 register: every column the rule names.
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select patient_name, patient_address, drug_name, qty_base,
            prescriber_name, prescriber_reg_no
     from h1_register order by patient_name $$,
  $$ values ('Ravi Kumar', '12 Nehru Street, Kadapa', 'Alprax 0.25', 10,
             'Dr Rao', 'KMC-12345'),
            ('Sita Devi', null, 'Alprax 0.25', 5, 'Dr Rao', 'KMC-12345') $$,
  'date, patient, address, drug, quantity, prescriber — the whole of what the rule asks for'
);

select ok(
  (select address_missing from h1_register where patient_name = 'Sita Devi'),
  'the missing address is FLAGGED rather than exported blank — it is a row to go and fix before somebody official asks'
);

select ok(
  not (select address_missing from h1_register where patient_name = 'Ravi Kumar'),
  'and a complete row is not flagged'
);

select is(
  (select count(*)::int from h1_register where prescriber_name is null),
  0,
  'no H1 row can lack a prescriber — the counter sale refusal makes the register complete by construction'
);

select is(
  (select batch_no from h1_register where patient_name = 'Ravi Kumar'),
  'AX-9001',
  'the batch is on the register, because a recall starts here'
);

select is(
  (select count(*)::int from h1_register where drug_name = 'Dolo 650'),
  0,
  'and nothing that is not Schedule H1 clutters it'
);

-- ---------------------------------------------------------------------------
-- Recall: who is holding batch AX-9001?
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select patient_name, qty_base from batch_trace
     where batch_no = 'AX-9001' order by patient_name $$,
  $$ values ('Ravi Kumar', 10), ('Sita Devi', 5) $$,
  'a recall names everyone who was given that batch, in one query'
);

select is(
  (select count(*)::int from batch_trace where batch_no = 'DL-9001'),
  0,
  'and a batch nobody was given traces to nobody'
);

-- ---------------------------------------------------------------------------
-- Purchase register and the expiry record.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000e1', true);

select lives_ok(
  $$ select app.receive_goods(
       '[{"drug_id": "d0000000-0000-0000-0000-0000000000e2", "batch_no": "DL-9002",
          "expiry": "2027-11-01", "units_per_strip": 15, "strips_per_box": 10,
          "mrp": 34.50, "cost_per_base_unit": 1.90, "qty_packs": 10}]'::jsonb,
       '50990000-0000-0000-0000-0000000000e1', 'INV-7001', current_date) $$,
  'an invoice is received'
);

select results_eq(
  $$ select invoice_no, supplier_name, supplier_gstin, lines, qty_base
     from purchase_register where invoice_no = 'INV-7001' $$,
  $$ values ('INV-7001', 'Kumar Distributors', '37AAAAA0000A1Z5', 1, 150) $$,
  'the purchase register names the invoice, the supplier and their GSTIN — which is what an inspection asks for'
);

select is(
  (select app.write_off_expired(
     '[{"batch_id": "b0000000-0000-0000-0000-0000000000e2"}]'::jsonb,
     'expired, destroyed on site')),
  190.00::numeric,
  'expired stock is written off'
);

select results_eq(
  $$ select batch_no, qty_base_written_off, value_at_cost, reason
     from expiry_writeoff_register $$,
  $$ values ('DL-9001', 100, 190.00::numeric, 'expired, destroyed on site') $$,
  'and the disposal record reads as a destruction rather than as a negative number'
);

-- ---------------------------------------------------------------------------
-- A date range means a clinic day, not a UTC one.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from h1_register
   where dispensed_on = app.clinic_day(now())),
  2,
  'today''s rows are today''s in the clinic''s own timezone — a UTC date would split every evening in half'
);

-- ---------------------------------------------------------------------------
-- The public surface is still exactly one view.
-- ---------------------------------------------------------------------------
set local role anon;

select throws_ok(
  $$ select * from h1_register $$,
  '42501',
  null,
  'the H1 register is the most sensitive object in the build — named people, addresses, controlled drugs — and anon cannot touch it'
);

select throws_ok(
  $$ select * from batch_trace $$,
  '42501',
  null,
  'nor the recall list'
);

select throws_ok(
  $$ select * from sales_register $$,
  '42501',
  null,
  'nor the day''s takings'
);

select lives_ok(
  $$ select status from clinic_now $$,
  'while the status page still answers — one public view, and still one'
);

reset role;

select * from finish();
rollback;
