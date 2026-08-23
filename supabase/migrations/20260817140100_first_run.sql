-- First run. PLAN.md §16, TABLET.md §5.
--
-- M11c gave `app.add_staff` a bootstrap: on a database with no staff at all,
-- the first person created is an admin whatever the form said, and the window
-- shuts the instant that row exists. That was half the problem, and the wrong
-- half to solve alone.
--
-- The other half is a deadlock, and it only appears on a database that has
-- never been seeded — which is to say, on the real one, on go-live morning:
--
--   to reach any screen you need a staff session
--   a staff session needs a PIN unlock
--   an unlock needs a registered device
--   registering a device needs an admin session
--   ...which needs a registered device.
--
-- Nothing could create the first tablet. Development never hit it because
-- `seed.sql` inserts two devices; production applies migrations only. So the
-- one thing M11 was built to remove — a developer with `psql` on day one —
-- survived in the single INSERT that starts everything.
--
-- This closes it. One transition, allowed only while BOTH `staff` and
-- `devices` are empty, that creates the clinic, the first admin and the first
-- tablet together and hands back the device token once. After it runs there is
-- a row in each table, so it can never run again — the guard is the data, not
-- a flag somebody could clear.
--
-- Granted to `authenticated`, exactly like `app.unlock`, because that is the
-- role the tablet's browser already holds before anybody has signed in: the
-- lock screen has always had to read the staff list and call unlock from that
-- same position.
--
-- Deliberately NOT here: opening hours, licence numbers, the consult fee.
-- Those are the settings screen's, and the person doing this is standing at a
-- tablet in a clinic that is not open yet. Ask for the four things without
-- which nothing else can happen, and let the rest be a screen he can reach.

create or replace function app.first_run(
  p_clinic_name  text,
  p_staff_name   text,
  p_pin          text,
  p_device_label text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_clinic clinic;
  v_staff  staff;
  v_device devices;
  v_token  text;
  v_session text;
begin
  -- The guard, and the reason it is two conditions rather than one: a database
  -- with staff but no devices is a clinic whose tablets were all revoked, and
  -- letting this run there would mint a fresh admin on a live system.
  if exists (select 1 from staff) or exists (select 1 from devices) then
    raise exception 'this clinic is already set up'
      using errcode = 'CL007';
  end if;

  if nullif(trim(coalesce(p_clinic_name, '')), '') is null then
    raise exception 'the clinic needs a name' using errcode = 'CL006';
  end if;

  if nullif(trim(coalesce(p_staff_name, '')), '') is null then
    raise exception 'your name goes on every prescription you sign'
      using errcode = 'CL006';
  end if;

  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  -- The clinic row may already exist on a database somebody prepared by hand.
  -- Take it as it is rather than overwriting a name that was typed carefully.
  select * into v_clinic from clinic limit 1;
  if v_clinic.id is null then
    insert into clinic (name) values (trim(p_clinic_name))
    returning * into v_clinic;
  end if;

  insert into staff (name, role, pin_hash, pin_set_at)
  values (trim(p_staff_name), 'admin', crypt(p_pin, gen_salt('bf', 12)), now())
  returning * into v_staff;

  v_token := encode(gen_random_bytes(24), 'hex');

  insert into devices (label, device_token, is_clinic_device, idle_timeout_seconds)
  values (
    coalesce(nullif(trim(coalesce(p_device_label, '')), ''), 'First tablet'),
    v_token, true, 180)
  returning * into v_device;

  -- And signs him in, on the tablet he is holding.
  --
  -- Not politeness. The lock screen reads the staff list under RLS, which
  -- requires a staff member to already be resolved — so immediately after
  -- setup that list is empty and there is nobody to tap. Handing back a
  -- session closes the loop the same way `app.unlock` does, and it spares
  -- somebody typing the PIN they chose four seconds ago.
  v_session := encode(gen_random_bytes(32), 'hex');

  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_staff.id, v_device.id,
    encode(digest(v_session, 'sha256'), 'hex'),
    now() + make_interval(secs => v_device.idle_timeout_seconds));

  -- Attributed to the system, because there is nobody signed in yet — this is
  -- the one write in the build that legitimately has no actor.
  perform app.write_audit('first_run', 'clinic', v_clinic.id, null,
    jsonb_build_object('clinic', v_clinic.name, 'admin', v_staff.name,
                       'device', v_device.label),
    'system');

  return jsonb_build_object(
    'clinic_name',  v_clinic.name,
    'staff_id',     v_staff.id,
    'staff_name',   v_staff.name,
    'device_label',  v_device.label,
    'device_token',  v_token,
    'session_token', v_session);
end
$$;

revoke all on function app.first_run(text, text, text, text) from public;
grant execute on function app.first_run(text, text, text, text) to authenticated;

comment on function app.first_run(text, text, text, text) is
  'The only way out of an empty database: registering a device needed an admin, and an admin needed a device. Runs while staff AND devices are both empty, never again.';

-- ---------------------------------------------------------------------------
-- Has this clinic ever been set up?
--
-- The lock screen has to tell two situations apart before anybody has signed
-- in: a clinic that exists and has not been told about this tablet, and a
-- database nobody has touched. It cannot ask the staff list — that list is
-- behind RLS which requires a resolved staff member, so on an empty database
-- it comes back empty for the right reason and on a live one it comes back
-- empty for the wrong one, and the screen cannot tell those apart either.
--
-- One boolean, computed, readable before sign-in. It leaks nothing: whether a
-- clinic has been set up is not a secret, and `app.first_run` refuses on its
-- own terms regardless of what any screen believes.
-- ---------------------------------------------------------------------------
create view clinic_setup_state as
select
  not exists (select 1 from staff)
  and not exists (select 1 from devices) as needs_setup;

grant select on clinic_setup_state to authenticated;

comment on view clinic_setup_state is
  'One boolean, for the lock screen, before anybody can sign in. Anon still reads exactly one object in this database, and it is not this one.';

-- ---------------------------------------------------------------------------
-- Who can unlock this tablet.
--
-- Found by the first-run drill, and it is not a first-run bug — it is a latent
-- production one that a seeded database hides.
--
-- The lock screen lists staff BEFORE anybody has signed in, and it was reading
-- the `staff` table, whose RLS policy requires `app.current_staff_id()` to
-- already resolve. In development that works by accident: the browser's key is
-- minted with the seeded doctor's id as its subject, so the fallback finds
-- him. On a database where that id does not exist — a real one — the list
-- comes back empty, with no error, and **nobody can sign in at all**. The
-- screen shows "Who is this?" above nothing.
--
-- A pre-sign-in read has to be readable pre-sign-in. Two columns, the two the
-- screen draws: whoever holds the tablet is about to be shown these names
-- anyway, and the secret on that screen is the PIN, not the staff list.
-- ---------------------------------------------------------------------------
create view lock_screen_staff as
select id, name from staff where active order by name;

grant select on lock_screen_staff to authenticated;

comment on view lock_screen_staff is
  'The names on the lock screen, readable before anybody has signed in — which the staff table is not, and which is why an unseeded database could show a lock screen with nobody on it.';
