begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c4444444-4444-4444-4444-444444444444', 'Legacy Clinic');

insert into staff (id, name, role, pin_hash, pin_set_at, auth_user_id) values
  ('54000000-0000-0000-0000-000000000001', 'Legacy Admin', 'admin',
   crypt('481920', gen_salt('bf', 12)), now(),
   'a5000000-0000-0000-0000-000000000099');

insert into devices (
  id, label, device_token, idle_timeout_seconds, registered_by, last_seen_at
) values (
  'de400000-0000-0000-0000-000000000001', 'Old cabin', 'legacy-old-device', 180,
  '54000000-0000-0000-0000-000000000001', now()
);

select set_config('request.jwt.claim.sub', 'a5000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'owner@legacy.example', true);
select set_config('request.jwt.claims', '{"email":"owner@legacy.example","is_anonymous":false}', true);

select throws_ok(
  $$ select app.claim_legacy_admin_by_email('Legacy Clinic', 'Legacy Admin', '481920', 'Replacement tablet') $$,
  'CL027', null,
  'email claim cannot replace a clinic whose trusted device was active recently'
);

update devices set last_seen_at = now() - interval '2 hours';

select throws_ok(
  $$ select app.claim_legacy_admin_by_email('Legacy Clinic', 'Legacy Admin', '000000', 'Replacement tablet') $$,
  'CL005', null,
  'wrong existing administrator PIN cannot claim legacy ownership'
);

create temporary table t_claim as
select app.claim_legacy_admin_by_email(
  'Legacy Clinic', 'Legacy Admin', '481920', 'Replacement tablet'
) as result;

select is(
  (select email from staff where id = '54000000-0000-0000-0000-000000000001'),
  'owner@legacy.example',
  'successful legacy claim binds the verified email'
);
select is(
  (select auth_user_id from staff where id = '54000000-0000-0000-0000-000000000001'),
  'a5000000-0000-0000-0000-000000000001'::uuid,
  'legacy claim replaces the obsolete auth uid with the verified email uid'
);
select ok(
  (select revoked_at is not null from devices where id = 'de400000-0000-0000-0000-000000000001'),
  'legacy claim revokes the old device trust'
);
select is(
  (select count(*)::int from devices where revoked_at is null),
  1,
  'legacy claim leaves exactly one replacement trusted device'
);
select isnt_empty(
  $$ select result->>'session_token' from t_claim where result->>'session_token' <> '' $$,
  'replacement tablet receives a PIN session immediately'
);
select is(
  (select count(*)::int from audit_log where action = 'claim_legacy_email'),
  1,
  'legacy ownership claim is audited'
);

select throws_ok(
  $$ select app.claim_legacy_admin_by_email('Legacy Clinic', 'Legacy Admin', '481920', 'Another tablet') $$,
  'CL005', null,
  'the legacy bridge closes permanently after the first email owner is bound'
);

select ok(
  not has_function_privilege('authenticated', 'app.recover_admin_device(text,text,text,text)', 'EXECUTE'),
  'the older non-email recovery function is retired for browser clients'
);

select * from finish();
rollback;
