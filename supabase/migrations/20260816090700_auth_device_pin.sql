-- Sign-in on a shared device (TABLET.md §5).
--
-- Email-and-password on a tablet, forty times a day, will be defeated by the
-- staff within a week — they will pick a short password or never log out. So it
-- is designed around instead:
--
--   the DEVICE holds the session   — registered once, long-lived, revocable
--   the PIN holds the identity     — 6 digits, per staff member, idle-locked
--
-- Attribution stays exact, which the Schedule H1 register legally requires, and
-- nobody types a password. A PIN alone is useless on any other device.

create table staff_sessions (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references staff (id),
  device_id    uuid not null references devices (id),
  -- The token is returned to the caller exactly once and stored only as a
  -- digest, so a leaked table is not a set of live sessions.
  token_hash   text not null unique,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ended_at     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index staff_sessions_live_idx
  on staff_sessions (token_hash)
  where ended_at is null;

create trigger staff_sessions_touch
  before update on staff_sessions
  for each row execute function app.touch_updated_at();

alter table staff_sessions enable row level security;
grant select on staff_sessions to authenticated;

create policy staff_sessions_read on staff_sessions
  for select to authenticated
  using (app.current_staff_id() is not null);

-- Transition-owned: sessions are created and ended by the functions below.
revoke insert, update, delete on staff_sessions from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Setting a PIN. The PIN itself never lands in a column — only a bcrypt digest.
-- ---------------------------------------------------------------------------
create or replace function app.set_staff_pin(p_staff_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_actor uuid;
  v_role  staff_role;
begin
  v_actor := app.current_staff_id();
  v_role  := app.current_staff_role();

  -- An admin may set anyone's PIN; anyone may set their own. Nothing else.
  if v_actor is null or (v_role <> 'admin' and v_actor <> p_staff_id) then
    raise exception 'not permitted to set this PIN' using errcode = 'PT005';
  end if;

  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'PT006';
  end if;

  update staff
  set pin_hash = crypt(p_pin, gen_salt('bf', 12)),
      pin_set_at = now()
  where id = p_staff_id and active;

  if not found then
    raise exception 'unknown or inactive staff member %', p_staff_id using errcode = 'PT006';
  end if;

  perform app.write_audit('set_pin', 'staff', p_staff_id, null,
    jsonb_build_object('pin_set_at', now()));
end
$$;

revoke all on function app.set_staff_pin(uuid, text) from public;
grant execute on function app.set_staff_pin(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Unlocking. Returns the session token once; the caller keeps it for the life
-- of the unlock and presents it on every subsequent request.
-- ---------------------------------------------------------------------------
create or replace function app.unlock(
  p_device_token text,
  p_staff_id     uuid,
  p_pin          text
) returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_device  devices%rowtype;
  v_staff   staff%rowtype;
  v_token   text;
begin
  select * into v_device
  from devices
  where device_token = p_device_token and revoked_at is null;

  -- A revoked or unknown device fails here, before the PIN is even considered.
  -- This is the lost-tablet story: revoke from the admin screen and the PIN on
  -- it stops being worth anything.
  if not found then
    raise exception 'this device is not registered' using errcode = 'PT005';
  end if;

  select * into v_staff from staff where id = p_staff_id and active;
  if not found or v_staff.pin_hash is null then
    raise exception 'incorrect PIN' using errcode = 'PT005';
  end if;

  -- Same message and same shape of failure as an unknown staff member: a PIN
  -- prompt should not tell you which half you got wrong.
  if v_staff.pin_hash <> crypt(p_pin, v_staff.pin_hash) then
    perform app.write_audit('unlock_failed', 'staff', p_staff_id, null,
      jsonb_build_object('device_id', v_device.id), 'system');
    raise exception 'incorrect PIN' using errcode = 'PT005';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    p_staff_id,
    v_device.id,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + make_interval(secs => v_device.idle_timeout_seconds)
  );

  update devices set last_seen_at = now() where id = v_device.id;

  perform app.write_audit('unlock', 'staff', p_staff_id, null,
    jsonb_build_object('device_id', v_device.id), 'system');

  return v_token;
end
$$;

revoke all on function app.unlock(text, uuid, text) from public;
grant execute on function app.unlock(text, uuid, text) to authenticated;

-- Extends the idle window. Called on activity, not on a timer.
create or replace function app.touch_session(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_ok boolean;
begin
  update staff_sessions s
  set last_seen_at = now(),
      expires_at   = now() + make_interval(secs => d.idle_timeout_seconds)
  from devices d
  where d.id = s.device_id
    and s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.ended_at is null
    and s.expires_at > now();

  get diagnostics v_ok = row_count;
  return v_ok;
end
$$;

revoke all on function app.touch_session(text) from public;
grant execute on function app.touch_session(text) to authenticated;

create or replace function app.lock(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update staff_sessions
  set ended_at = now()
  where token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and ended_at is null;
end
$$;

revoke all on function app.lock(text) from public;
grant execute on function app.lock(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Attribution, rewired.
--
-- current_staff_id() now resolves the PIN session first and the Supabase auth
-- user second. The order matters: on a shared clinic tablet the auth session
-- belongs to the DEVICE, so auth.uid() alone would attribute every write to a
-- tablet. The session token is what names the person who is standing there.
--
-- The token travels in the `app.staff_session` GUC, set per request by
-- lib/auth (see that module for the Supabase `db-pre-request` wiring). The
-- auth.uid() fallback keeps single-user deployments and pgTAP tests simple.
-- ---------------------------------------------------------------------------
create or replace function app.current_staff_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
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
      where st.auth_user_id = auth.uid() and st.active
    )
  )
$$;

create or replace function app.current_staff_role() returns staff_role
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select st.role from staff st where st.id = app.current_staff_id()
$$;

comment on function app.current_staff_id() is
  'The PIN session names the person; the device session is only the fallback (TABLET.md §5).';
comment on table staff_sessions is
  'One row per PIN unlock. Idle timeout comes from the device, because it is a property of where the tablet stands.';
