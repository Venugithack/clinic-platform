-- The test that is the point of the whole harness (BUILD.md §1.5).
--
-- Rules 2 and 3 used to be enforced by convention: a TypeScript function
-- everyone agreed to route through, with nothing stopping a future edit from
-- writing around it. Moving the transitions into plpgsql with SECURITY DEFINER
-- and revoking the direct write grants means the DATABASE refuses the bypass.
--
-- This file is what proves that claim, in both directions:
--   the direct write is refused, and the transition still works.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c2222222-2222-2222-2222-222222222222', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-000000000009', 'Latha', 'counter',
   'a0000000-0000-0000-0000-000000000009');

insert into patients (id, name) values
  ('60000000-0000-0000-0000-000000000009', 'Walk-in');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-000000000009', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  ('b0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000009',
   'OPEN', app.month_end(current_date + 300), 15, 10, 45.00, 'strip', 1.0000, 100, 100);

insert into stock_movements (id, drug_id, batch_id, qty_base, type, staff_id) values
  ('11111111-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000009',
   'b0000000-0000-0000-0000-000000000009', 100, 'receipt',
   '50000000-0000-0000-0000-000000000009');

-- ---------------------------------------------------------------------------
-- Append-only, enforced even for the table owner. An edit is a story nobody can
-- reconstruct three months later; corrections are compensating rows.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update stock_movements set qty_base = 5
     where id = '11111111-0000-0000-0000-000000000009' $$,
  '23001',
  null,
  'the stock ledger refuses an UPDATE, even from the owner'
);

select throws_ok(
  $$ delete from stock_movements where id = '11111111-0000-0000-0000-000000000009' $$,
  '23001',
  null,
  'the stock ledger refuses a DELETE'
);

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

-- ---------------------------------------------------------------------------
-- Now as the role the application actually runs under.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000009', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000009', true);

set local role authenticated;

select throws_ok(
  $$ insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
     values ('d0000000-0000-0000-0000-000000000009',
             'b0000000-0000-0000-0000-000000000009', -1, 'dispense',
             '50000000-0000-0000-0000-000000000009') $$,
  '42501',
  null,
  'a direct write to the stock ledger is REFUSED by Postgres'
);

select throws_ok(
  $$ update stock_batches set qty_base_on_hand = 999
     where id = 'b0000000-0000-0000-0000-000000000009' $$,
  '42501',
  null,
  'a direct edit of the on-hand cache is REFUSED — the ledger is the only way in'
);

select throws_ok(
  $$ insert into dispenses (staff_id, is_counter_sale)
     values ('50000000-0000-0000-0000-000000000009', true) $$,
  '42501',
  null,
  'a dispense cannot be created outside the transition'
);

select throws_ok(
  $$ insert into dispense_lines (dispense_id, drug_id, batch_id, qty_base, unit_price, amount)
     values (gen_random_uuid(), 'd0000000-0000-0000-0000-000000000009',
             'b0000000-0000-0000-0000-000000000009', 1, 3.00, 3.00) $$,
  '42501',
  null,
  'nor can a dispense line'
);

select throws_ok(
  $$ insert into audit_log (actor_type, action, entity)
     values ('staff', 'forged', 'dispenses') $$,
  '42501',
  null,
  'the audit log cannot be written to directly — it is written from inside the transition'
);

select throws_ok(
  $$ update staff set pin_hash = 'forged'
     where id = '50000000-0000-0000-0000-000000000009' $$,
  '42501',
  null,
  'a PIN hash cannot be set by a direct column write'
);

-- ---------------------------------------------------------------------------
-- And the door that IS open: the transition itself, from the same role that was
-- just refused every direct write.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000009', 'qty_base', 15)),
       null, '60000000-0000-0000-0000-000000000009', true) $$,
  'the transition succeeds for the very role that cannot write the tables'
);

select is(
  (select qty_base_on_hand from stock_batches
   where id = 'b0000000-0000-0000-0000-000000000009'),
  85,
  'and it moved the stock it was supposed to move'
);

reset role;

select * from finish();
rollback;
