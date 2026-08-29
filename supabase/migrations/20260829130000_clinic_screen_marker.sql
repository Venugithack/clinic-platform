-- The clinic screen marker — presence, after device trust.
--
-- ── WHAT BROKE ──────────────────────────────────────────────────────────────
--
-- `app.set_presence` refuses `in_clinic` and `in_consult` unless the caller's
-- device is a registered clinic device (20260816250100_presence.sql). The rule
-- is the one that makes the whole feature worth having, and it is written down
-- there in one sentence: "only a device that is physically in the clinic may
-- say he is physically in the clinic. His laptop at home signs in fine, sees
-- everything he needs, and sets nothing."
--
-- 20260827224500 then made device identity optional for SIGN-IN — correctly,
-- because staff now open the clinic URL on whatever is in their hand — and
-- `app.unlock_pin` inserts its session with `device_id => null`. So
-- `app.current_device_id()` returns null for every staff member, `v_clinic` is
-- always false, and CL023 is raised every time. The doctor cannot say he is in
-- the clinic at all, and `/now` can never tell a patient he is.
--
-- The mechanism was removed; the rule that depended on it was not. E2E caught
-- it (m6-presence) and had been red among thirty-one others, which is how a
-- dead headline feature went unnoticed.
--
-- ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
--
-- Device trust does NOT come back for sign-in. Nothing here can stop a staff
-- member signing in, nothing here is required to use the app, and a browser
-- with no marker is a completely normal browser. `unlock_pin` takes the marker
-- as an optional third argument and ignores its absence.
--
-- What comes back is one narrow claim: *this browser stands in the clinic*. An
-- administrator makes it once per screen, it is stored in that browser, and the
-- only thing it unlocks is the doctor's ability to say he is present. That is
-- the smallest thing that restores the rule rather than deleting it.
--
-- `app.register_device` already did exactly this job and still exists — it is
-- administrator-gated, mints a token and sets `is_clinic_device`. 20260827224500
-- revoked it from `authenticated` along with the rest of the device machinery.
-- It is granted back here, and nothing about it is changed.

grant execute on function app.register_device(text, boolean, int)
  to authenticated, service_role;
grant execute on function app.revoke_device(uuid)
  to authenticated, service_role;

comment on function app.register_device(text, boolean, int) is
  'Marks one browser as standing in the clinic. Administrator only. The token '
  'it returns is stored in that browser and gates nothing except app.set_presence '
  'saying the doctor is here — sign-in never needs it.';

-- ---------------------------------------------------------------------------
-- unlock_pin, with an optional marker.
--
-- The third argument is the browser's clinic-screen token. A wrong, revoked or
-- absent token is not an error and never blocks sign-in: it simply leaves
-- `device_id` null, which is exactly the state every browser is in today. The
-- only consequence is that presence stays refused there, which is the existing
-- behaviour and the safe direction to fail in.
-- ---------------------------------------------------------------------------
-- The two-argument form has to GO, not merely be superseded. A default argument
-- creates an overload rather than replacing anything, and leaving both means
-- PostgREST has two candidates for `unlock_pin` — it resolves on the exact
-- argument set, so a client that stops sending the marker would silently get
-- the old body back and every session would go deviceless again. One function.
drop function if exists app.unlock_pin(uuid, text);

create or replace function app.unlock_pin(
  p_staff_id     uuid,
  p_pin          text,
  p_screen_token text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff        staff;
  v_token        text;
  v_failures     int;
  v_locked_until timestamptz;
  v_device_id    uuid;
begin
  select * into v_staff from staff where id = p_staff_id and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'incorrect', 'attempts_remaining', 5);
  end if;

  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_staff.pin_locked_until - now())))
    );
  end if;

  if v_staff.pin_hash is null
     or v_staff.pin_hash <> crypt(coalesce(p_pin, ''), v_staff.pin_hash) then
    update staff
    set pin_failed_attempts = pin_failed_attempts + 1,
        pin_locked_until = case
          when pin_failed_attempts + 1 >= 5 then now() + interval '10 minutes'
          else pin_locked_until
        end
    where id = v_staff.id
    returning pin_failed_attempts, pin_locked_until into v_failures, v_locked_until;

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

  -- The marker, if this browser carries one. Revoked screens resolve to null,
  -- which is the same as not having one.
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
  'Name + PIN sign-in from any browser. The third argument is an optional '
  'clinic-screen marker; its absence is normal and never blocks sign-in, it only '
  'leaves the session unable to assert presence.';

-- ---------------------------------------------------------------------------
-- Which screens are marked, for the administrator who has to manage them.
-- ---------------------------------------------------------------------------
create or replace view clinic_screens as
select d.id,
       d.label,
       d.registered_at,
       d.last_seen_at,
       s.name as registered_by_name
from devices d
left join staff s on s.id = d.registered_by
where d.revoked_at is null
  and d.is_clinic_device;

comment on view clinic_screens is
  'Browsers an administrator has marked as standing in the clinic. The token is '
  'deliberately not exposed — it is shown once, to the browser that claimed it.';

grant select on clinic_screens to authenticated, service_role;
