-- M3 — barcodes (INVENTORY.md §2).
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c7777777-7777-7777-7777-777777777777', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000b1', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000b1');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000b1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000b2', 'Cetzine',  'Cetirizine',  '10mg',
   'tablet', 'tablet', 'OTC');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000b1', true);

select throws_ok(
  $$ select app.learn_barcode('123', 'd0000000-0000-0000-0000-0000000000b1') $$,
  'PT006',
  null,
  'three digits is not a barcode'
);

select lives_ok(
  $$ select app.learn_barcode('8901234567890', 'd0000000-0000-0000-0000-0000000000b1') $$,
  'the first scan of an unknown code asks once, and this is the answer being stored'
);

select is(
  (select drug_id from drug_barcodes where code = '8901234567890'),
  'd0000000-0000-0000-0000-0000000000b1'::uuid,
  'and it remembers'
);

select lives_ok(
  $$ select app.learn_barcode('8901234567890', 'd0000000-0000-0000-0000-0000000000b1') $$,
  'teaching it the same thing twice is not an error, it is a no-op'
);

select is(
  (select count(*)::int from drug_barcodes where code = '8901234567890'),
  1,
  'and it does not duplicate the row'
);

-- The one that matters. A code silently re-pointed at another drug is worse
-- than no code at all, because the scan that follows LOOKS like it worked —
-- and the whole point of scan-to-verify is that a wrong box gets stopped.
select throws_ok(
  $$ select app.learn_barcode('8901234567890', 'd0000000-0000-0000-0000-0000000000b2') $$,
  'PT013',
  null,
  'a code already registered to one drug cannot be quietly re-pointed at another'
);

select is(
  (select drug_id from drug_barcodes where code = '8901234567890'),
  'd0000000-0000-0000-0000-0000000000b1'::uuid,
  'and the original mapping survives the attempt'
);

select is(
  (select count(*)::int from audit_log where action = 'learn_barcode'),
  1,
  'learning a code is audited — it is a mapping the pharmacy will trust later'
);

set local role authenticated;

select throws_ok(
  $$ insert into drug_barcodes (code, drug_id, learned_by)
     values ('9999999999999', 'd0000000-0000-0000-0000-0000000000b2',
             '50000000-0000-0000-0000-0000000000b1') $$,
  '42501',
  null,
  'and a mapping cannot be created by a direct write'
);

reset role;

select * from finish();
rollback;
