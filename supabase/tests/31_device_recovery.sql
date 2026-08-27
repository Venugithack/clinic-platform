-- Emergency device recovery is narrower than normal registration: it requires
-- the clinic identity + an existing admin PIN and is unavailable while a trusted
-- tablet has been active recently.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c4444444-4444-4444-4444-444444444444', 'Recovery Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-00000000004a', 'Recovery Admin', 'admin',
   'a0000000-0000-0000-0000-00000000004a');

insert into devices (
  id, label, device_token, idle_timeout_seconds, registered_by, last_seen_at
) values (
  'de000000-0000-0000-0000-00000000004a',
  'Old cabin tablet',
  'old-recovery-device-token',
  600,
  '50000000-0000-0000-0000-00000000004a',
  now()
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000004a', true);
select lives_ok(
  $$ select app.set_staff_pin('50000000-0000-0000-0000-00000000004a', '481920') $$,
  'the recovery administrator has an existing PIN'
);
select set_config('request.jwt.claim.sub', '', true);

select throws_ok(
  $$ select app.recover_admin_device('Recovery Clinic', 'Recovery Admin', '481920', 'Replacement tablet') $$,
  'CL005',
  null,
  'recovery is refused while a trusted tablet has been seen recently'
);

update devices
set last_seen_at = now() - interval '31 minutes'
where device_token = 'old-recovery-device-token';

select throws_ok(
  $$ select app.recover_admin_device('Recovery Clinic', 'Recovery Admin', '000000', 'Replacement tablet') $$,
  'CL005',
  null,
  'an incorrect administrator PIN cannot recover device trust'
);

create temporary table t_recovery as
select app.recover_admin_device(
  'Recovery Clinic',
  'Recovery Admin',
  '481920',
  'Replacement tablet'
) as result;

select ok(
  length((select result ->> 'device_token' from t_recovery)) >= 32,
  'successful recovery returns a new device token exactly once'
);

select ok(
  length((select result ->> 'session_token' from t_recovery)) >= 32,
  'successful recovery also signs the administrator in'
);

select isnt(
  (select result ->> 'device_token' from t_recovery),
  'old-recovery-device-token',
  'recovery never reuses the lost device credential'
);

select ok(
  (select revoked_at is not null from devices where device_token = 'old-recovery-device-token'),
  'the old device registration is revoked in the same transaction'
);

select is(
  (select count(*)::int from devices where revoked_at is null),
  1,
  'only the replacement device remains trusted'
);

select is(
  (select count(*)::int from audit_log where action = 'recover_device'),
  1,
  'device recovery is written to the append-only audit log'
);

select * from finish();
rollback;
