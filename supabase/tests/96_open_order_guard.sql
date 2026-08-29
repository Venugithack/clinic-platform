-- Purchasing safety: a medicine with quantity still outstanding on an open PO
-- must not be drafted again. The UI filters this case, but the transition is the
-- authority because two tablets can act on stale reorder screens concurrently.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Purchasing Guard Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('51000000-0000-0000-0000-0000000000a1', 'Dr Guard', 'doctor',
   'a1000000-0000-0000-0000-0000000000a1');

insert into suppliers (id, name, lead_time_days) values
  ('51990000-0000-0000-0000-0000000000a1', 'Guard Distributors', 3);

insert into drugs (
  id, name, salt_composition, strength, form, base_unit, schedule,
  default_units_per_strip, default_strips_per_box,
  default_supplier_id, reorder_level_base, reorder_qty_base
) values (
  'd1000000-0000-0000-0000-0000000000a1', 'Guardmol 500', 'Paracetamol', '500mg',
  'tablet', 'tablet', 'OTC', 10, 10,
  '51990000-0000-0000-0000-0000000000a1', 50, 200
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

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000a1', true);
select set_config('app.staff_session', 'sess-a1000000-0000-0000-0000-0000000000a1', true);

select is(
  (select app.draft_purchase_orders(
    '[{"drug_id":"d1000000-0000-0000-0000-0000000000a1",
       "supplier_id":"51990000-0000-0000-0000-0000000000a1",
       "qty_base":200,"suggested_qty_base":200}]'::jsonb)),
  1,
  'the first draft is created normally'
);

select throws_ok(
  $$ select app.draft_purchase_orders(
    '[{"drug_id":"d1000000-0000-0000-0000-0000000000a1",
       "supplier_id":"51990000-0000-0000-0000-0000000000a1",
       "qty_base":100,"suggested_qty_base":100}]'::jsonb) $$,
  'CL007',
  null,
  'a second draft for a medicine already outstanding is refused'
);

select is(
  (select count(*)::int from purchase_orders where status = 'draft'),
  1,
  'the refusal leaves only the original draft'
);

select is(
  (select count(*)::int from po_lines where drug_id = 'd1000000-0000-0000-0000-0000000000a1'),
  1,
  'and does not leak a second purchase-order line'
);

select throws_ok(
  $$ select app.draft_purchase_orders(
    '[{"drug_id":"d1000000-0000-0000-0000-0000000000a1",
       "supplier_id":"51990000-0000-0000-0000-0000000000a1","qty_base":100},
      {"drug_id":"d1000000-0000-0000-0000-0000000000a1",
       "supplier_id":"51990000-0000-0000-0000-0000000000a1","qty_base":100}]'::jsonb) $$,
  'CL006',
  null,
  'the same medicine cannot appear twice in one draft request either'
);

select lives_ok(
  $$ select app.cancel_purchase_order(
    (select id from purchase_orders where status = 'draft' limit 1),
    'replacement order required') $$,
  'the existing draft can be cancelled deliberately'
);

select is(
  (select app.draft_purchase_orders(
    '[{"drug_id":"d1000000-0000-0000-0000-0000000000a1",
       "supplier_id":"51990000-0000-0000-0000-0000000000a1",
       "qty_base":120,"suggested_qty_base":120}]'::jsonb)),
  1,
  'after cancellation the medicine can be drafted again'
);

select is(
  (select count(*)::int from purchase_orders where status = 'draft'),
  1,
  'the replacement is the only open draft'
);

select * from finish();
rollback;
