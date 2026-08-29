-- M11d — the two loose ends (PLAN.md §15.2, §16).
--
-- `app.void_bill` was written and tested in M4 and never called by a screen.
-- The H1 register flagged a missing address in M8 and offered no way to fix
-- it. This file covers what those two errands need underneath: a patient edit
-- that leaves a trace, and a register row that knows who it is about.
begin;
select * from no_plan();

insert into clinic (id, name, consult_fee) values
  ('c1111111-1111-1111-1111-111111111111', 'Test Clinic', 300);

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-000000000011', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-000000000011');

insert into patients (id, name, phone, allergies, consent_given_at) values
  ('60000000-0000-0000-0000-000000000011', 'Ravi Kumar', '+91 90000 00001',
   'Penicillin', now());

-- app.current_staff_id() resolves auth.uid() for administrators only since
-- 20260827224500 (device-free access); every other role now arrives with the
-- opaque PIN session token app.unlock_pin() issues. Give each seeded staff
-- member that session so this pre-rework fixture still acts as the role it
-- declares. The token tracks the actor on every switch below, because the
-- session branch is checked before the auth.uid() one.
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff
 where auth_user_id is not null;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000011', true);

-- ---------------------------------------------------------------------------
-- An edit leaves a trace. A creation already had one.
-- ---------------------------------------------------------------------------
update patients set address = '12 Nehru Street, Kadapa'
where id = '60000000-0000-0000-0000-000000000011';

select is(
  (select count(*)::int from audit_log where action = 'edit_patient'),
  1,
  'filling in a missing address is recorded — under plain CRUD it left no trace at all'
);

select is(
  (select after ->> 'address' from audit_log where action = 'edit_patient'),
  '12 Nehru Street, Kadapa',
  'with what it became'
);

select is(
  (select actor_staff_id from audit_log where action = 'edit_patient'),
  '50000000-0000-0000-0000-000000000011'::uuid,
  'and who did it, which is the question a corrected clinical record has to answer'
);

-- The one that decides whether the log is readable a year later.
update patients set allergies = 'Penicillin, Sulfa'
where id = '60000000-0000-0000-0000-000000000011';

select is(
  (select jsonb_object_keys(after)::text from audit_log
   where action = 'edit_patient' and after ? 'allergies'),
  'allergies',
  'changing one field logs one field, not the whole patient — a log full of unchanged columns is a log nobody reads'
);

update patients set name = 'Ravi Kumar'
where id = '60000000-0000-0000-0000-000000000011';

select is(
  (select count(*)::int from audit_log where action = 'edit_patient'),
  2,
  'and a save that changed nothing writes nothing, because `updated_at` moving is not an edit'
);

-- ---------------------------------------------------------------------------
-- The H1 register can now point at the patient it is complaining about.
-- ---------------------------------------------------------------------------
insert into suppliers (id, name) values
  ('70000000-0000-0000-0000-000000000011', 'Kumar Distributors');

insert into drugs (id, name, salt_composition, strength, form, base_unit,
                   schedule, default_units_per_strip, default_strips_per_box)
values ('80000000-0000-0000-0000-000000000011', 'Alprax 0.25', 'Alprazolam',
        '0.25mg', 'tablet', 'tablet', 'H1', 15, 10);

insert into stock_batches (id, drug_id, batch_no, expiry, units_per_strip,
                           strips_per_box, mrp, mrp_basis, cost_per_base_unit,
                           qty_base_received, qty_base_on_hand, supplier_id)
values ('90000000-0000-0000-0000-000000000011',
        '80000000-0000-0000-0000-000000000011', 'AZ2601', current_date + 400,
        15, 10, 60.00, 'strip', 2.00, 100, 90,
        '70000000-0000-0000-0000-000000000011');

insert into appointments (id, patient_id, date, token_no, status)
values ('c2000000-0000-0000-0000-000000000011',
        '60000000-0000-0000-0000-000000000011', current_date, 1, 'done');

insert into encounters (id, appointment_id, patient_id, doctor_id)
values ('d2000000-0000-0000-0000-000000000011',
        'c2000000-0000-0000-0000-000000000011',
        '60000000-0000-0000-0000-000000000011',
        '50000000-0000-0000-0000-000000000011');

insert into prescriptions (id, encounter_id, patient_id, doctor_id, signed_at)
values ('a1000000-0000-0000-0000-000000000011',
        'd2000000-0000-0000-0000-000000000011',
        '60000000-0000-0000-0000-000000000011',
        '50000000-0000-0000-0000-000000000011', now());

insert into dispenses (id, patient_id, prescription_id, staff_id, at)
values ('b1000000-0000-0000-0000-000000000011',
        '60000000-0000-0000-0000-000000000011',
        'a1000000-0000-0000-0000-000000000011',
        '50000000-0000-0000-0000-000000000011', now());

insert into dispense_lines (dispense_id, drug_id, batch_id, qty_base,
                            unit_price, amount, cost_at_dispense)
values ('b1000000-0000-0000-0000-000000000011',
        '80000000-0000-0000-0000-000000000011',
        '90000000-0000-0000-0000-000000000011', 10, 4.00, 40.00, 20.00);

select is(
  (select patient_id from h1_register),
  '60000000-0000-0000-0000-000000000011'::uuid,
  'the register names the patient it is about, so the missing-address flag is something a screen can act on'
);

select is(
  (select address_missing from h1_register),
  false,
  'and this row is complete, because somebody filled the address in above'
);

update patients set address = null
where id = '60000000-0000-0000-0000-000000000011';

select is(
  (select address_missing from h1_register),
  true,
  'take the address away and the register says so again — the flag is read from the patient, never cached'
);

-- ---------------------------------------------------------------------------
-- Voiding. The M4 transition, exercised from the state a screen reaches it in.
-- ---------------------------------------------------------------------------
create temporary table t_bill as
select app.raise_bill('60000000-0000-0000-0000-000000000011', null,
  '["b1000000-0000-0000-0000-000000000011"]'::jsonb) as bill;

select is(
  (select (bill).status::text from t_bill),
  'unpaid',
  'a bill starts unpaid'
);

select throws_ok(
  format($$ select app.void_bill(%L, '') $$, (select (bill).id from t_bill)),
  'CL006',
  null,
  'and cannot be cancelled without a reason — "cancelled" with no why is the entry an auditor asks about'
);

select is(
  (select (app.void_bill((select (bill).id from t_bill),
     'billed the wrong patient')).status::text),
  'cancelled',
  'with a reason, it cancels'
);

select is(
  (select bill_id from dispenses where id = 'b1000000-0000-0000-0000-000000000011'),
  null,
  'the dispense is released, so it can be billed again to the right person'
);

select is(
  (select qty_base_on_hand from stock_batches
   where id = '90000000-0000-0000-0000-000000000011'),
  90,
  'but the stock does NOT come back — cancelling a bill is paperwork, and medicine that left the counter returns through the ledger or not at all'
);

select throws_ok(
  format($$ select app.void_bill(%L, 'again') $$, (select (bill).id from t_bill)),
  'CL007',
  null,
  'and cancelling it twice is refused rather than quietly repeated'
);

select * from finish();
rollback;
