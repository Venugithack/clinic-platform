-- Email-owned device access.
--
-- A clinic tablet still uses the same daily security model: the device holds a
-- long-lived trust token and a staff PIN names the person standing at it. What
-- changes is how a NEW browser earns that device trust. The old one-time code
-- is replaced by a verified Supabase email identity belonging to an active
-- admin or doctor.
--
-- Important: every browser already signs in anonymously so PostgREST can serve
-- the lock-screen views. `authenticated` is therefore NOT proof of ownership.
-- Every transition below explicitly requires a non-anonymous JWT with an email.

alter table staff add column if not exists email text;

create unique index if not exists staff_email_unique
  on staff (lower(email))
  where email is not null;

comment on column staff.email is
  'Pre-authorized email for admin/doctor device trust. Daily shared-tablet identity remains the 6-digit PIN.';

-- Read the verified identity from PostgREST JWT settings without depending on
-- Supabase-only SQL helpers, so the same functions run in bare-Postgres CI.
create or replace function app.current_auth_email()
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select lower(nullif(trim(coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    case
      when nullif(current_setting('request.jwt.claims', true), '') is null then null
      else (current_setting('request.jwt.claims', true)::jsonb ->> 'email')
    end,
    ''
  )), ''))
$$;

create or replace function app.current_auth_is_anonymous()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    case
      when nullif(current_setting('request.jwt.claims', true), '') is null then null
      else (current_setting('request.jwt.claims', true)::jsonb ->> 'is_anonymous')::boolean
    end,
    true
  )
$$;

revoke all on function app.current_auth_email() from public;
revoke all on function app.current_auth_is_anonymous() from public;
grant execute on function app.current_auth_email(), app.current_auth_is_anonymous()
  to authenticated, service_role;

-- One small pre-PIN read for the email entry screen. It leaks no email address,
-- only whether a privileged email has already been configured.
create or replace view email_access_state as
select
  exists (
    select 1 from staff
    where active and role in ('admin', 'doctor') and email is not null
  ) as has_email_owner;

grant select on email_access_state to authenticated;

-- Admin configuration. An email is an access credential, so only doctor/admin
-- rows may hold one. Changing it unbinds the previous Supabase auth user; the
-- next verified sign-in with the new address binds the new uid atomically.
create or replace function app.set_staff_email(
  p_staff_id uuid,
  p_email text
) returns staff
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff staff;
  v_email text;
  v_before jsonb;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'email access is configured by an administrator'
      using errcode = 'CL005';
  end if;

  select * into v_staff from staff where id = p_staff_id;
  if not found then
    raise exception 'no such staff member' using errcode = 'CL006';
  end if;

  v_email := lower(nullif(trim(coalesce(p_email, '')), ''));
  if v_email is not null and v_staff.role not in ('admin', 'doctor') then
    raise exception 'email device access is only for administrators and doctors'
      using errcode = 'CL005';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'enter a valid email address' using errcode = 'CL006';
  end if;

  v_before := to_jsonb(v_staff) - 'pin_hash';

  update staff
  set email = v_email,
      auth_user_id = case
        when email is not distinct from v_email then auth_user_id
        else null
      end
  where id = p_staff_id
  returning * into v_staff;

  perform app.write_audit(
    'set_staff_email', 'staff', p_staff_id,
    v_before,
    to_jsonb(v_staff) - 'pin_hash'
  );

  return v_staff;
exception
  when unique_violation then
    raise exception 'that email already belongs to another staff member'
      using errcode = 'CL006';
end
$$;

revoke all on function app.set_staff_email(uuid, text) from public;
grant execute on function app.set_staff_email(uuid, text) to authenticated, service_role;

-- Create a trusted tablet from an already-authorized email identity. A doctor
-- may trust their own tablet; an admin can do the same. Counter/nurse email is
-- deliberately insufficient because those roles do not need remote ownership.
create or replace function app.trust_device_by_email(
  p_label text,
  p_is_clinic_device boolean default true,
  p_idle_timeout_seconds int default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_staff staff;
  v_device devices;
  v_device_token text;
  v_session_token text;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'open the sign-in link from your email first'
      using errcode = 'CL005';
  end if;

  select * into v_staff
  from staff
  where active
    and role in ('admin', 'doctor')
    and (
      auth_user_id = v_uid
      or (auth_user_id is null and lower(email) = v_email)
    )
  order by case when auth_user_id = v_uid then 0 else 1 end
  limit 1;

  if not found then
    raise exception 'this email is not authorized for clinic access'
      using errcode = 'CL005';
  end if;

  if v_staff.email is null or lower(v_staff.email) <> v_email then
    raise exception 'this signed-in email does not match the staff account'
      using errcode = 'CL005';
  end if;

  if v_staff.auth_user_id is null then
    if exists (select 1 from staff where auth_user_id = v_uid and id <> v_staff.id) then
      raise exception 'this email identity is already linked to another staff member'
        using errcode = 'CL005';
    end if;
    update staff set auth_user_id = v_uid where id = v_staff.id;
    v_staff.auth_user_id := v_uid;
  elsif v_staff.auth_user_id <> v_uid then
    raise exception 'this email identity does not match the staff account'
      using errcode = 'CL005';
  end if;

  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'give this device a name' using errcode = 'CL006';
  end if;
  if p_idle_timeout_seconds is not null
     and (p_idle_timeout_seconds < 30 or p_idle_timeout_seconds > 3600) then
    raise exception 'the idle lock is between 30 seconds and an hour'
      using errcode = 'CL006';
  end if;

  v_device_token := encode(gen_random_bytes(24), 'hex');
  insert into devices (
    label, device_token, is_clinic_device, idle_timeout_seconds, registered_by
  ) values (
    trim(p_label), v_device_token, coalesce(p_is_clinic_device, true),
    coalesce(p_idle_timeout_seconds,
      case when coalesce(p_is_clinic_device, true) then 180 else 600 end),
    v_staff.id
  ) returning * into v_device;

  v_session_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id, v_device.id,
    encode(digest(v_session_token, 'sha256'), 'hex'),
    now() + make_interval(secs => v_device.idle_timeout_seconds)
  );

  perform app.write_audit(
    'trust_device_email', 'device', v_device.id, null,
    jsonb_build_object('label', v_device.label, 'email', v_email,
                       'is_clinic_device', v_device.is_clinic_device)
  );

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'device_id', v_device.id,
    'device_label', v_device.label,
    'device_token', v_device_token,
    'session_token', v_session_token
  );
end
$$;

revoke all on function app.trust_device_by_email(text, boolean, int) from public;
grant execute on function app.trust_device_by_email(text, boolean, int)
  to authenticated, service_role;

-- First clinic setup through a verified email. This supersedes app.first_run:
-- the first administrator is now bound to a real auth identity from day one.
create or replace function app.first_run_email(
  p_clinic_name text,
  p_staff_name text,
  p_pin text,
  p_device_label text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_clinic clinic;
  v_staff staff;
  v_device devices;
  v_device_token text;
  v_session_token text;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify your email before setting up the clinic'
      using errcode = 'CL005';
  end if;

  if exists (select 1 from staff) or exists (select 1 from devices) then
    raise exception 'this clinic is already set up' using errcode = 'CL007';
  end if;
  if nullif(trim(coalesce(p_clinic_name, '')), '') is null then
    raise exception 'the clinic needs a name' using errcode = 'CL006';
  end if;
  if nullif(trim(coalesce(p_staff_name, '')), '') is null then
    raise exception 'your name is required' using errcode = 'CL006';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  select * into v_clinic from clinic limit 1;
  if v_clinic.id is null then
    insert into clinic (name) values (trim(p_clinic_name)) returning * into v_clinic;
  end if;

  insert into staff (name, role, email, auth_user_id, pin_hash, pin_set_at)
  values (
    trim(p_staff_name), 'admin', v_email, v_uid,
    crypt(p_pin, gen_salt('bf', 12)), now()
  ) returning * into v_staff;

  v_device_token := encode(gen_random_bytes(24), 'hex');
  insert into devices (
    label, device_token, is_clinic_device, idle_timeout_seconds, registered_by
  ) values (
    coalesce(nullif(trim(coalesce(p_device_label, '')), ''), 'First tablet'),
    v_device_token, true, 180, v_staff.id
  ) returning * into v_device;

  v_session_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id, v_device.id,
    encode(digest(v_session_token, 'sha256'), 'hex'),
    now() + interval '180 seconds'
  );

  perform app.write_audit(
    'first_run_email', 'clinic', v_clinic.id, null,
    jsonb_build_object('clinic', v_clinic.name, 'admin', v_staff.name,
                       'email', v_email, 'device', v_device.label),
    'system'
  );

  return jsonb_build_object(
    'clinic_name', v_clinic.name,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'device_label', v_device.label,
    'device_token', v_device_token,
    'session_token', v_session_token
  );
end
$$;

revoke all on function app.first_run_email(text, text, text, text) from public;
grant execute on function app.first_run_email(text, text, text, text)
  to authenticated, service_role;

-- Bridge clinics created before email ownership existed. It is intentionally a
-- one-time path: once any admin/doctor email exists, this function closes. The
-- existing clinic name + admin name + PIN prove continuity, and a recent live
-- trusted device blocks recovery so an attacker cannot replace an active clinic.
create or replace function app.claim_legacy_admin_by_email(
  p_clinic_name text,
  p_admin_name text,
  p_pin text,
  p_device_label text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_clinic clinic;
  v_staff staff;
  v_device devices;
  v_device_token text;
  v_session_token text;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify your email before recovering clinic access'
      using errcode = 'CL005';
  end if;

  if exists (
    select 1 from staff
    where active and role in ('admin', 'doctor') and email is not null
  ) then
    raise exception 'email access is already configured for this clinic'
      using errcode = 'CL005';
  end if;

  select * into v_clinic from clinic
  where lower(trim(name)) = lower(trim(coalesce(p_clinic_name, '')))
  limit 1;
  if not found then
    raise exception 'clinic details did not match' using errcode = 'CL005';
  end if;

  select * into v_staff
  from staff
  where active and role = 'admin'
    and lower(trim(name)) = lower(trim(coalesce(p_admin_name, '')))
  limit 1;
  if not found or v_staff.pin_hash is null
     or v_staff.pin_hash <> crypt(p_pin, v_staff.pin_hash) then
    raise exception 'clinic details did not match' using errcode = 'CL005';
  end if;

  if exists (
    select 1 from devices
    where revoked_at is null and last_seen_at > now() - interval '30 minutes'
  ) then
    raise exception 'a trusted clinic tablet was active recently — use it to configure email access'
      using errcode = 'CL027';
  end if;

  if exists (select 1 from staff where auth_user_id = v_uid and id <> v_staff.id) then
    raise exception 'this email identity is already linked to another staff member'
      using errcode = 'CL005';
  end if;

  update staff set email = v_email, auth_user_id = v_uid where id = v_staff.id;

  update staff_sessions set ended_at = now() where ended_at is null;
  update devices set revoked_at = now() where revoked_at is null;

  v_device_token := encode(gen_random_bytes(24), 'hex');
  insert into devices (
    label, device_token, is_clinic_device, idle_timeout_seconds, registered_by
  ) values (
    coalesce(nullif(trim(coalesce(p_device_label, '')), ''), 'Admin tablet'),
    v_device_token, true, 180, v_staff.id
  ) returning * into v_device;

  v_session_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id, v_device.id,
    encode(digest(v_session_token, 'sha256'), 'hex'),
    now() + interval '180 seconds'
  );

  perform app.write_audit(
    'claim_legacy_email', 'device', v_device.id, null,
    jsonb_build_object('email', v_email, 'label', v_device.label,
                       'old_device_trust_revoked', true)
  );

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'device_id', v_device.id,
    'device_label', v_device.label,
    'device_token', v_device_token,
    'session_token', v_session_token
  );
end
$$;

revoke all on function app.claim_legacy_admin_by_email(text, text, text, text) from public;
grant execute on function app.claim_legacy_admin_by_email(text, text, text, text)
  to authenticated, service_role;

-- The old public-facing bootstrap/recovery/code paths are retired. Historical
-- functions stay in the migration history for restores, but normal clients can
-- no longer invoke them.
revoke execute on function app.first_run(text, text, text, text) from authenticated;
revoke execute on function app.recover_admin_device(text, text, text, text) from authenticated;
revoke execute on function app.register_device(text, boolean, int) from authenticated;

comment on function app.trust_device_by_email(text, boolean, int) is
  'Verified non-anonymous admin/doctor email trusts a new device; staff then return to normal PIN unlock.';
comment on function app.claim_legacy_admin_by_email(text, text, text, text) is
  'One-time bridge for pre-email clinics. Closes permanently once any privileged staff email is configured.';
