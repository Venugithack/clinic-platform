-- Browser-anywhere clinic access.
--
-- Daily identity is now staff name + six-digit PIN from any browser. Email OTP
-- is reserved for the owner/admin control plane. The browser itself is not a
-- security principal; Postgres remains the boundary through short-lived staff
-- session tokens carried in x-staff-session.

alter table staff_sessions alter column device_id drop not null;
alter table staff_sessions add column if not exists idle_timeout_seconds int not null default 600;

alter table staff add column if not exists pin_failed_attempts int not null default 0;
alter table staff add column if not exists pin_locked_until timestamptz;

create table if not exists app.bootstrap_owner (
  email text primary key,
  created_at timestamptz not null default now()
);
revoke all on table app.bootstrap_owner from public, anon, authenticated;

-- Daily PIN unlock from any browser. Five consecutive failures lock that staff
-- account for ten minutes. Successful unlock resets the failure counter.
create or replace function app.unlock_staff(
  p_staff_id uuid,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = public, app, extensions, pg_catalog
as $$
declare
  v_staff staff%rowtype;
  v_token text;
  v_failures int;
begin
  select * into v_staff from staff where id = p_staff_id and active;

  if not found or v_staff.pin_hash is null then
    raise exception 'incorrect PIN' using errcode = 'CL005';
  end if;

  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until > now() then
    raise exception 'too many incorrect attempts; try again later' using errcode = 'CL005';
  end if;

  if v_staff.pin_hash <> crypt(p_pin, v_staff.pin_hash) then
    v_failures := coalesce(v_staff.pin_failed_attempts, 0) + 1;
    update staff
    set pin_failed_attempts = case when v_failures >= 5 then 0 else v_failures end,
        pin_locked_until = case when v_failures >= 5 then now() + interval '10 minutes' else null end
    where id = v_staff.id;

    perform app.write_audit(
      'unlock_failed', 'staff', v_staff.id, null,
      jsonb_build_object('browser_access', true, 'locked', v_failures >= 5),
      'system'
    );
    raise exception 'incorrect PIN' using errcode = 'CL005';
  end if;

  update staff
  set pin_failed_attempts = 0,
      pin_locked_until = null
  where id = v_staff.id;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (
    staff_id, device_id, token_hash, expires_at, idle_timeout_seconds
  ) values (
    v_staff.id, null, encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '10 minutes', 600
  );

  perform app.write_audit(
    'unlock', 'staff', v_staff.id, null,
    jsonb_build_object('browser_access', true), 'system'
  );

  return jsonb_build_object(
    'session_token', v_token,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role
  );
end
$$;

revoke all on function app.unlock_staff(uuid, text) from public;
grant execute on function app.unlock_staff(uuid, text) to authenticated, service_role;

-- Browser sessions carry their own idle policy; no device lookup is needed.
create or replace function app.touch_session(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_ok boolean;
begin
  update staff_sessions s
  set last_seen_at = now(),
      expires_at = now() + make_interval(secs => s.idle_timeout_seconds)
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.ended_at is null
    and s.expires_at > now();

  get diagnostics v_ok = row_count;
  return v_ok;
end
$$;

revoke all on function app.touch_session(text) from public;
grant execute on function app.touch_session(text) to authenticated, service_role;

-- First setup is allowed only for a pre-seeded owner email. That prevents a
-- random visitor from claiming an empty public clinic before the real owner.
create or replace function app.first_run_owner(
  p_staff_name text,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = public, app, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_clinic clinic%rowtype;
  v_staff staff%rowtype;
  v_token text;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify the owner email first' using errcode = 'CL005';
  end if;

  if not exists (select 1 from app.bootstrap_owner where lower(email) = v_email) then
    raise exception 'this email is not the configured clinic owner' using errcode = 'CL005';
  end if;

  if exists (select 1 from staff) then
    raise exception 'this clinic is already set up' using errcode = 'CL007';
  end if;

  if nullif(trim(coalesce(p_staff_name, '')), '') is null then
    raise exception 'administrator name is required' using errcode = 'CL006';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  select * into v_clinic from clinic limit 1;
  if v_clinic.id is null then
    insert into clinic (name) values ('Jayamurugan Clinic') returning * into v_clinic;
  else
    update clinic set name = 'Jayamurugan Clinic' where id = v_clinic.id returning * into v_clinic;
  end if;

  insert into staff (name, role, email, auth_user_id, pin_hash, pin_set_at)
  values (
    trim(p_staff_name), 'admin', v_email, v_uid,
    crypt(p_pin, gen_salt('bf', 12)), now()
  ) returning * into v_staff;

  delete from app.bootstrap_owner;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (
    staff_id, device_id, token_hash, expires_at, idle_timeout_seconds
  ) values (
    v_staff.id, null, encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '30 minutes', 1800
  );

  perform app.write_audit(
    'first_run_owner', 'clinic', v_clinic.id, null,
    jsonb_build_object('clinic', v_clinic.name, 'admin', v_staff.name, 'email', v_email),
    'system'
  );

  return jsonb_build_object(
    'session_token', v_token,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role
  );
end
$$;

revoke all on function app.first_run_owner(text, text) from public;
grant execute on function app.first_run_owner(text, text) to authenticated, service_role;

-- Existing owner/admin email OTP sign-in. The verified auth identity is turned
-- into the same staff session shape used by PIN login, then the client may sign
-- the email identity out again.
create or replace function app.owner_session()
returns jsonb
language plpgsql
security definer
set search_path = public, app, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_staff staff%rowtype;
  v_token text;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify the owner email first' using errcode = 'CL005';
  end if;

  select * into v_staff
  from staff
  where active
    and role = 'admin'
    and lower(email) = v_email
    and (auth_user_id = v_uid or auth_user_id is null)
  limit 1;

  if not found then
    raise exception 'this email is not authorized for administration' using errcode = 'CL005';
  end if;

  if v_staff.auth_user_id is null then
    update staff set auth_user_id = v_uid where id = v_staff.id;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (
    staff_id, device_id, token_hash, expires_at, idle_timeout_seconds
  ) values (
    v_staff.id, null, encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '30 minutes', 1800
  );

  perform app.write_audit(
    'owner_login', 'staff', v_staff.id, null,
    jsonb_build_object('email', v_email), 'system'
  );

  return jsonb_build_object(
    'session_token', v_token,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role
  );
end
$$;

revoke all on function app.owner_session() from public;
grant execute on function app.owner_session() to authenticated, service_role;

-- Retire browser-callable device bootstrap paths. Historical functions remain
-- for forward-only migration history but are no longer part of the product API.
revoke execute on function app.unlock(text, uuid, text) from authenticated;
revoke execute on function app.first_run_email(text, text, text, text) from authenticated;
revoke execute on function app.trust_device_by_email(text, boolean, int) from authenticated;
revoke execute on function app.claim_legacy_admin_by_email(text, text, text, text) from authenticated;
revoke execute on function app.register_device(text, boolean, int) from authenticated;

comment on table staff_sessions is
  'Short-lived browser staff sessions created by PIN or owner email OTP; device_id is legacy and nullable.';
