-- Stop a stranger locking the clinic out of its own app.
--
-- ── THE VULNERABILITY ───────────────────────────────────────────────────────
--
-- Three facts that are each fine alone:
--
--   1. The sign-in page lists every active staff member, with their id. It has
--      to — staff pick their name from it, and 20260827224600 made that list
--      public on purpose.
--   2. `app.unlock_pin` is granted to `anon`, because the picker runs before
--      anybody is signed in.
--   3. Five wrong PINs set `staff.pin_locked_until` to ten minutes out.
--
-- Together they are a denial of service on a working surgery. The lock was
-- keyed to the VICTIM, so anybody on the internet could read the staff list off
-- the sign-in page and post five wrong PINs for each person — locking the
-- doctor, the nurse, the pharmacy and the administrator out of the clinic's own
-- app, and keeping them out with a loop. No account, no session, no rate limit
-- of any other kind standing in the way.
--
-- ── THE RULE THIS RESTORES ──────────────────────────────────────────────────
--
-- A failed attempt must cost the person who made it. Never the person it was
-- made against.
--
-- Brute force still has to be stopped: a six-digit PIN is a million guesses,
-- which is nothing without a limit. So the counting moves to the caller. The
-- clinic's own staff share one address and are given a generous allowance;
-- somebody guessing from elsewhere exhausts their own and locks nobody but
-- themselves.
--
-- `staff.pin_failed_attempts` keeps counting, because an administrator should
-- still be able to see that somebody's PIN is being guessed at. It simply stops
-- being a reason to refuse. `pin_locked_until` is still honoured if it is set,
-- so an administrator can still lock an account deliberately — it is just no
-- longer set by strangers.

-- ---------------------------------------------------------------------------
-- Who is asking.
--
-- PostgREST exposes the request headers, and app.pre_request already lifts the
-- staff session out of them. The caller's address comes the same way.
-- Cloudflare sets cf-connecting-ip and it is the trustworthy one here, because
-- the app is only reachable through Cloudflare; x-forwarded-for is a fallback
-- for the dev stack and is client-settable, which is why it is second.
-- ---------------------------------------------------------------------------
create or replace function app.pre_request() returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claims  jsonb;
  v_headers jsonb;
  v_ip      text;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if v_claims is not null and v_claims ? 'sub' then
    perform set_config('request.jwt.claim.sub', v_claims ->> 'sub', true);
  end if;

  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  perform set_config(
    'app.staff_session',
    coalesce(v_headers ->> 'x-staff-session', ''),
    true
  );

  v_ip := coalesce(
    v_headers ->> 'cf-connecting-ip',
    v_headers ->> 'x-real-ip',
    -- x-forwarded-for is a list; the client is the first entry.
    nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), ''),
    ''
  );
  perform set_config('app.client_ip', btrim(v_ip), true);
exception
  -- A malformed header must not take the request down; it just means nobody is
  -- identified, and current_staff_id() returns null, and the transitions refuse.
  when others then
    perform set_config('app.staff_session', '', true);
    perform set_config('app.client_ip', '', true);
end
$$;

comment on function app.pre_request() is
  'PostgREST db-pre-request hook. Lifts the PIN session out of x-staff-session '
  'so audit rows name a person, and the caller address out of cf-connecting-ip '
  'so a failed PIN is charged to whoever typed it.';

/**
 * The caller, for rate-limiting purposes only.
 *
 * Falls back to a single shared bucket when no address reaches us. That is a
 * degraded mode rather than a hole: it still limits brute force, it is what the
 * pgTAP and dev stacks run in, and it is strictly better than charging the
 * attempt to the account being attacked.
 */
create or replace function app.current_client_ip() returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.client_ip', true), ''), 'unknown');
$$;

-- Called only from inside unlock_pin, which is SECURITY DEFINER and runs as
-- the owner, so no role needs a grant of its own. A5_permissions asserts that
-- nothing in `app` is executable by PUBLIC, because a grant to public is a
-- grant to anon.
revoke all on function app.current_client_ip() from public;

-- ---------------------------------------------------------------------------
-- Failed attempts, by caller.
-- ---------------------------------------------------------------------------
create table if not exists pin_attempts (
  client       text primary key,
  failures     int not null default 0,
  locked_until timestamptz,
  window_from  timestamptz not null default now(),
  last_at      timestamptz not null default now()
);

comment on table pin_attempts is
  'Failed PIN attempts per caller address. Rate limiting lives here rather than '
  'on the staff row, so a stranger cannot lock a staff member out.';

-- No policies, and no grants. Everything that touches it is SECURITY DEFINER.
alter table pin_attempts enable row level security;
revoke all on table pin_attempts from anon, authenticated;

/**
 * The allowance.
 *
 * The whole clinic shares one address, so this has to survive a normal day of
 * mistyping by four people — hence twenty rather than five. It still leaves a
 * guesser needing centuries for a six-digit PIN, and they burn their own
 * allowance doing it, not anybody else's.
 */
create or replace function app.pin_attempt_limit() returns int
language sql immutable as $$ select 20 $$;
revoke all on function app.pin_attempt_limit() from public;

create or replace function app.pin_attempt_window() returns interval
language sql immutable as $$ select interval '15 minutes' $$;
revoke all on function app.pin_attempt_window() from public;

-- ---------------------------------------------------------------------------
-- unlock_pin, charging failures to the caller.
-- ---------------------------------------------------------------------------
create or replace function app.unlock_pin(
  p_staff_id     uuid,
  p_pin          text,
  p_screen_token text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff        staff;
  v_token        text;
  v_client       text := app.current_client_ip();
  v_attempts     pin_attempts;
  v_device_id    uuid;
begin
  -- The caller's standing, first and regardless of who they claim to be. A
  -- locked caller is told nothing about whether the staff member or the PIN
  -- was real.
  select * into v_attempts from pin_attempts where client = v_client;

  if v_attempts.locked_until is not null and v_attempts.locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_attempts.locked_until - now())))
    );
  end if;

  -- A window that has expired starts again rather than accumulating over days.
  if v_attempts.client is not null
     and v_attempts.window_from < now() - app.pin_attempt_window() then
    update pin_attempts
    set failures = 0, locked_until = null, window_from = now()
    where client = v_client;
    v_attempts.failures := 0;
  end if;

  select * into v_staff from staff where id = p_staff_id and active;

  if not found
     or v_staff.pin_hash is null
     or v_staff.pin_hash <> crypt(coalesce(p_pin, ''), v_staff.pin_hash) then

    insert into pin_attempts (client, failures, window_from, last_at)
    values (v_client, 1, now(), now())
    on conflict (client) do update
      set failures     = pin_attempts.failures + 1,
          last_at      = now(),
          locked_until = case
            when pin_attempts.failures + 1 >= app.pin_attempt_limit()
              then now() + app.pin_attempt_window()
            else pin_attempts.locked_until
          end
    returning * into v_attempts;

    -- Still counted against the account, for an administrator to see. It is no
    -- longer a reason to refuse anybody.
    if v_staff.id is not null then
      update staff set pin_failed_attempts = pin_failed_attempts + 1
      where id = v_staff.id;

      perform app.write_audit(
        'unlock_failed', 'staff', v_staff.id, null,
        jsonb_build_object('client_locked', v_attempts.locked_until is not null), 'system'
      );
    end if;

    if v_attempts.locked_until is not null then
      return jsonb_build_object(
        'ok', false, 'code', 'locked',
        'retry_after_seconds', ceil(extract(epoch from (v_attempts.locked_until - now())))
      );
    end if;

    return jsonb_build_object(
      'ok', false,
      'code', 'incorrect',
      'attempts_remaining', greatest(app.pin_attempt_limit() - v_attempts.failures, 0)
    );
  end if;

  -- An administrator may still lock an account deliberately; that is honoured.
  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_staff.pin_locked_until - now())))
    );
  end if;

  -- A correct PIN clears the caller's record as well as the account's, so a
  -- clinic that mistypes through the morning never accumulates towards a lock.
  delete from pin_attempts where client = v_client;

  update staff
  set pin_failed_attempts = 0,
      pin_locked_until = null
  where id = v_staff.id;

  if nullif(trim(coalesce(p_screen_token, '')), '') is not null then
    select id into v_device_id
    from devices
    where device_token = p_screen_token
      and revoked_at is null
      and is_clinic_device;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id,
    v_device_id,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '10 minutes'
  );

  perform app.write_audit('unlock', 'staff', v_staff.id, null,
    jsonb_build_object('access', 'pin', 'clinic_screen', v_device_id is not null), 'system');

  return jsonb_build_object(
    'ok', true,
    'session_token', v_token,
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role
  );
end
$$;

revoke all on function app.unlock_pin(uuid, text, text) from public;
grant execute on function app.unlock_pin(uuid, text, text) to anon, authenticated, service_role;

comment on function app.unlock_pin(uuid, text, text) is
  'Name + PIN sign-in from any browser. Failed attempts are rate-limited by '
  'CALLER, never by the account being attempted — a stranger cannot lock a '
  'staff member out of the clinic.';

notify pgrst, 'reload config';
