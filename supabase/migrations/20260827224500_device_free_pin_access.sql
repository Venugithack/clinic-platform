-- Device-free clinic access.
--
-- Ownership is a verified Supabase email OTP bound to the administrator.
-- Everyday staff access is name + six-digit PIN from any browser. A successful
-- PIN creates a short-lived opaque staff session; failed PIN attempts are
-- rate-limited in Postgres so the public URL is not a brute-force oracle.

alter table staff_sessions
  alter column device_id drop not null;

alter table staff
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz;

comment on column staff.pin_failed_attempts is
  'Consecutive failed public PIN unlocks. Reset on success or admin PIN change.';
comment on column staff.pin_locked_until is
  'Temporary server-side lock after repeated wrong PINs.';

create or replace function app.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select coalesce(
    (
      select s.staff_id
      from staff_sessions s
      join staff st on st.id = s.staff_id and st.active
      where s.token_hash = encode(
              digest(nullif(current_setting('app.staff_session', true), ''), 'sha256'), 'hex')
        and s.ended_at is null
        and s.expires_at > now()
    ),
    (
      select st.id
      from staff st
      where st.auth_user_id = auth.uid()
        and st.active
        and st.role = 'admin'
    )
  )
$$;

create or replace function app.unlock_pin(
  p_staff_id uuid,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff staff%rowtype;
  v_token text;
  v_failures integer;
  v_locked_until timestamptz;
begin
  select * into v_staff
  from staff
  where id = p_staff_id and active
  for update;

  if not found or v_staff.pin_hash is null then
    return jsonb_build_object('ok', false, 'code', 'incorrect');
  end if;

  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'locked',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_staff.pin_locked_until - now())))::int)
    );
  end if;

  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until <= now() then
    update staff
    set pin_failed_attempts = 0,
        pin_locked_until = null
    where id = v_staff.id;
    v_staff.pin_failed_attempts := 0;
    v_staff.pin_locked_until := null;
  end if;

  if v_staff.pin_hash <> crypt(coalesce(p_pin, ''), v_staff.pin_hash) then
    v_failures := v_staff.pin_failed_attempts + 1;
    v_locked_until := case when v_failures >= 5 then now() + interval '10 minutes' else null end;

    update staff
    set pin_failed_attempts = case when v_failures >= 5 then 0 else v_failures end,
        pin_locked_until = v_locked_until
    where id = v_staff.id;

    perform app.write_audit(
      'unlock_failed', 'staff', v_staff.id, null,
      jsonb_build_object('locked', v_locked_until is not null), 'system'
    );

    if v_locked_until is not null then
      return jsonb_build_object('ok', false, 'code', 'locked', 'retry_after_seconds', 600);
    end if;

    return jsonb_build_object(
      'ok', false,
      'code', 'incorrect',
      'attempts_remaining', 5 - v_failures
    );
  end if;

  update staff
  set pin_failed_attempts = 0,
      pin_locked_until = null
  where id = v_staff.id;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id,
    null,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '10 minutes'
  );

  perform app.write_audit('unlock', 'staff', v_staff.id, null,
    jsonb_build_object('access', 'pin'), 'system');

  return jsonb_build_object(
    'ok', true,
    'session_token', v_token,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role
  );
end
$$;

revoke all on function app.unlock_pin(uuid, text) from public;
grant execute on function app.unlock_pin(uuid, text) to authenticated, service_role;

create or replace function app.touch_session(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_rows integer;
begin
  update staff_sessions
  set last_seen_at = now(),
      expires_at = now() + interval '10 minutes'
  where token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and ended_at is null
    and expires_at > now();

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$$;

revoke all on function app.touch_session(text) from public;
grant execute on function app.touch_session(text) to authenticated, service_role;

create or replace function app.set_staff_pin(p_staff_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_actor uuid := app.current_staff_id();
  v_role staff_role := app.current_staff_role();
begin
  if v_actor is null or (v_role <> 'admin' and v_actor <> p_staff_id) then
    raise exception 'not permitted to set this PIN' using errcode = 'CL005';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  update staff
  set pin_hash = crypt(p_pin, gen_salt('bf', 12)),
      pin_set_at = now(),
      pin_failed_attempts = 0,
      pin_locked_until = null
  where id = p_staff_id and active;

  if not found then
    raise exception 'unknown or inactive staff member' using errcode = 'CL006';
  end if;

  update staff_sessions
  set ended_at = now()
  where staff_id = p_staff_id and ended_at is null;

  perform app.write_audit('set_pin', 'staff', p_staff_id, null,
    jsonb_build_object('pin_set_at', now()));
end
$$;

revoke all on function app.set_staff_pin(uuid, text) from public;
grant execute on function app.set_staff_pin(uuid, text) to authenticated, service_role;

create or replace function app.first_run_owner(
  p_staff_name text,
  p_pin text
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
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify the administrator email first' using errcode = 'CL005';
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

  perform app.write_audit(
    'first_run_owner', 'clinic', v_clinic.id, null,
    jsonb_build_object('clinic', v_clinic.name, 'admin', v_staff.name, 'email', v_email),
    'system'
  );

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'email', v_email,
    'clinic_name', v_clinic.name
  );
end
$$;

revoke all on function app.first_run_owner(text, text) from public;
grant execute on function app.first_run_owner(text, text) to authenticated, service_role;

create or replace function app.owner_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_staff staff;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    return null;
  end if;

  select * into v_staff
  from staff
  where active
    and role = 'admin'
    and auth_user_id = v_uid
    and lower(email) = v_email
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'email', v_staff.email
  );
end
$$;

revoke all on function app.owner_profile() from public;
grant execute on function app.owner_profile() to authenticated, service_role;

revoke execute on function app.unlock(text, uuid, text) from authenticated;
revoke execute on function app.trust_device_by_email(text, boolean, int) from authenticated;
revoke execute on function app.first_run_email(text, text, text, text) from authenticated;
revoke execute on function app.claim_legacy_admin_by_email(text, text, text, text) from authenticated;
revoke execute on function app.register_device(text, boolean, int) from authenticated;
revoke execute on function app.recover_admin_device(text, text, text, text) from authenticated;

comment on table staff_sessions is
  'Short-lived staff PIN sessions. Device identity is deprecated; device_id is nullable for legacy rows.';
