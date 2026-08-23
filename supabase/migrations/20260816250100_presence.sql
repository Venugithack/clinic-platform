-- Doctor presence, and the public status page behind it. PLAN.md §13.
--
-- The premise of the section is that "logged in = he is there" is false four
-- different ways, all of them daily or weekly: he forgets to log out and goes
-- home; he logs in from home to check something; the laptop sleeps; he steps
-- out for lunch. Every one of them ends with a patient being told he is in the
-- clinic when he is not, and that is the failure that gets the app blamed.
--
-- So presence here is never a stored fact that somebody has to remember to
-- change. It is computed, on read, from three things:
--
--   1. is the clinic open at all, by its own hours and closures — if not, the
--      answer is `closed` no matter who is signed in or how recently;
--   2. has the device pinged inside the last five minutes — if not, `away`,
--      with no scheduled job needed to make it true;
--   3. only then, what he last said he was doing.
--
-- Two consequences fall out of computing rather than storing. A laptop that
-- sleeps at 19:58 reads `away` at 20:03 without anything running. And closing
-- time cannot be missed by a cron that did not fire, because there is no cron.
--
-- Rule 6 lives here more than anywhere else in the build: **presence is never a
-- promise.** The view hands out `as_of` beside every status, and the wording on
-- the page is "in the clinic, as of 2 minutes ago" and never "available".
--
-- Error code added here:
--   CL023  this device cannot say he is in the clinic

create type presence_status as enum ('in_clinic', 'in_consult', 'break', 'away');

create table presence (
  staff_id          uuid primary key references staff (id),
  status            presence_status not null default 'away',
  -- `auto` means a heartbeat put it here; `manual` means he did. A heartbeat
  -- may promote `away` to `in_clinic`, and may never overwrite something he
  -- said on purpose — "back by 14:30" surviving until 14:30 is the whole
  -- value of having said it.
  source            text not null default 'auto' check (source in ('auto', 'manual')),
  last_heartbeat_at timestamptz,
  break_until       timestamptz,
  note              text,
  device_id         uuid references devices (id),
  updated_at        timestamptz not null default now()
);

create table clinic_closures (
  id         uuid primary key default gen_random_uuid(),
  on_date    date not null,
  reason     text,
  all_day    boolean not null default true,
  from_time  time,
  to_time    time,
  created_by uuid references staff (id),
  created_at timestamptz not null default now(),
  unique (on_date, all_day, from_time, to_time)
);

create index clinic_closures_date_idx on clinic_closures (on_date);

create trigger presence_touch before update on presence
  for each row execute function app.touch_updated_at();

alter table presence        enable row level security;
alter table clinic_closures enable row level security;

grant select on presence, clinic_closures to authenticated;
revoke insert, update, delete on presence, clinic_closures from authenticated, anon;

create policy presence_read on presence
  for select to authenticated using (app.current_staff_id() is not null);
create policy clinic_closures_read on clinic_closures
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- Which device is asking.
--
-- Resolved from the PIN session, so a caller holding only a JWT — his laptop at
-- home, a browser he signed into once — has no device at all and therefore no
-- clinic device. That is not a gap; it is §13.2's rule, expressed as the
-- absence of a row rather than as a check somebody has to write.
-- ---------------------------------------------------------------------------
create or replace function app.current_device_id() returns uuid
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select s.device_id
  from staff_sessions s
  where s.token_hash = encode(
          digest(nullif(current_setting('app.staff_session', true), ''), 'sha256'), 'hex')
    and s.ended_at is null
    and s.expires_at > now()
$$;

-- ---------------------------------------------------------------------------
-- Is the clinic open right now?
--
-- Hours are settings, not constants (PLAN.md §18 Q10 — he configures them once
-- the platform is ready), stored as {"mon": ["09:30-13:00", "17:00-20:30"]}.
-- A day with no key is a day the clinic is shut: absence means closed, which is
-- the safe direction for a page patients act on.
-- ---------------------------------------------------------------------------
create or replace function app.clinic_is_open(p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_clinic clinic%rowtype;
  v_local  timestamp;
  v_day    text;
  v_time   time;
begin
  select * into v_clinic from clinic limit 1;
  if not found then
    return false;
  end if;

  v_local := p_at at time zone coalesce(v_clinic.timezone, 'Asia/Kolkata');
  v_day   := lower(to_char(v_local, 'Dy'));
  v_time  := v_local::time;

  -- A closure beats the timetable. This is the unexpected day off, the
  -- afternoon he is at a home visit, and the public holiday.
  if exists (
    select 1 from clinic_closures c
    where c.on_date = v_local::date
      and (c.all_day
           or (v_time >= coalesce(c.from_time, time '00:00')
               and v_time <  coalesce(c.to_time, time '23:59:59')))
  ) then
    return false;
  end if;

  return exists (
    select 1
    from jsonb_array_elements_text(
           coalesce(v_clinic.open_hours -> v_day, '[]'::jsonb)) as r(window_text)
    where v_time >= split_part(r.window_text, '-', 1)::time
      and v_time <  split_part(r.window_text, '-', 2)::time
  );
end
$$;

comment on function app.clinic_is_open(timestamptz) is
  'A day with no hours recorded is closed. Absence means shut, which is the safe direction for a page patients drive to a clinic on.';

-- ---------------------------------------------------------------------------
-- app.presence_ping — the 30-second heartbeat.
--
-- No ping for five minutes reads as `away`, and that is decided in the view
-- rather than by a job: the truth is "we have not heard from him since X", and
-- computing it on read means it cannot be wrong because something did not run.
-- ---------------------------------------------------------------------------
create or replace function app.presence_ping()
returns presence
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_device_id uuid;
  v_clinic    boolean;
  v_row       presence;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  v_device_id := app.current_device_id();
  v_clinic := coalesce(
    (select is_clinic_device from devices where id = v_device_id), false);

  insert into presence (staff_id, status, source, last_heartbeat_at, device_id)
  values (v_staff_id,
          case when v_clinic then 'in_clinic' else 'away' end::presence_status,
          'auto', now(), v_device_id)
  on conflict (staff_id) do update
    set last_heartbeat_at = now(),
        device_id = excluded.device_id,
        -- A ping wakes an automatic `away` back up, and never touches anything
        -- he set himself. Overwriting "back by 14:30" because his tablet is
        -- still on the desk is precisely the lie this table exists to stop.
        status = case
                   when presence.source = 'manual' then presence.status
                   when v_clinic then 'in_clinic'::presence_status
                   else presence.status
                 end
  returning * into v_row;

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- app.set_presence — the big control in his window (§13.2).
--
--   In clinic · With a patient · Back by HH:MM · Done for the day
-- ---------------------------------------------------------------------------
create or replace function app.set_presence(
  p_status      text,
  p_break_until timestamptz default null,
  p_note        text default null
) returns presence
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_device_id uuid;
  v_clinic    boolean;
  v_row       presence;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_status not in ('in_clinic', 'in_consult', 'break', 'away') then
    raise exception 'unknown presence status %', p_status using errcode = 'CL006';
  end if;

  v_device_id := app.current_device_id();
  v_clinic := coalesce(
    (select is_clinic_device from devices where id = v_device_id), false);

  -- The rule that makes the whole feature trustworthy: only a device that is
  -- physically in the clinic may say he is physically in the clinic. His laptop
  -- at home signs in fine, sees everything he needs, and sets nothing.
  if p_status in ('in_clinic', 'in_consult') and not v_clinic then
    raise exception
      'this device is not registered as a clinic device, so it cannot say the doctor is in the clinic'
      using errcode = 'CL023';
  end if;

  insert into presence (staff_id, status, source, last_heartbeat_at,
                        break_until, note, device_id)
  values (v_staff_id, p_status::presence_status, 'manual', now(),
          p_break_until, p_note, v_device_id)
  on conflict (staff_id) do update
    set status            = excluded.status,
        source            = 'manual',
        last_heartbeat_at = now(),
        break_until       = excluded.break_until,
        note              = excluded.note,
        device_id         = excluded.device_id
  returning * into v_row;

  perform app.write_audit('set_presence', 'presence', v_staff_id, null,
    jsonb_build_object('status', p_status, 'break_until', p_break_until));

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- Closing the clinic, and opening it again.
--
-- Returns how many appointments today are affected. That number is the point:
-- §13.3 allows exactly one push message — `clinic_closed`, to patients who have
-- an appointment today — and it is the difference between an unexpected closure
-- being handled and being discovered at the door. The sending itself is the
-- Cloud API and waits for M7; the list does not have to.
-- ---------------------------------------------------------------------------
create or replace function app.close_clinic_today(p_reason text)
returns int
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_affected int;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'only the doctor closes the clinic' using errcode = 'CL005';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a closure needs a reason — it is what the patients are told'
      using errcode = 'CL006';
  end if;

  insert into clinic_closures (on_date, reason, all_day, created_by)
  values (current_date, p_reason, true, v_staff_id)
  on conflict do nothing;

  select count(*)::int into v_affected
  from appointments a
  where a.date = current_date
    and a.status in ('booked', 'waiting');

  perform app.write_audit('close_clinic_today', 'clinic_closures', null, null,
    jsonb_build_object('reason', p_reason, 'appointments_affected', v_affected));

  return v_affected;
end
$$;

create or replace function app.reopen_clinic_today()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_staff_id uuid;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'only the doctor opens the clinic' using errcode = 'CL005';
  end if;

  delete from clinic_closures where on_date = current_date and all_day;

  perform app.write_audit('reopen_clinic_today', 'clinic_closures', null, null,
    jsonb_build_object('on_date', current_date));
end
$$;

revoke all on function app.presence_ping()                          from public;
revoke all on function app.set_presence(text, timestamptz, text)    from public;
revoke all on function app.close_clinic_today(text)                 from public;
revoke all on function app.reopen_clinic_today()                    from public;

grant execute on function app.presence_ping()                       to authenticated, service_role;
grant execute on function app.set_presence(text, timestamptz, text) to authenticated, service_role;
grant execute on function app.close_clinic_today(text)              to authenticated, service_role;
grant execute on function app.reopen_clinic_today()                 to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What the public page reads. THE ONLY THING IN THIS BUILD ANON MAY SELECT.
--
-- Three columns of it are the clinic's name, the doctor's name and whether he
-- is in — all of which are already on the door — plus the "as of" that stops
-- the reading being a promise. No patient, no appointment, no token, nothing
-- that could identify anybody who has ever walked in.
--
-- Deliberately NOT security_invoker: anon has no privilege on `presence` or
-- `staff` and must not be given any. The view is the entire public surface, and
-- widening it is a decision somebody has to make on purpose.
-- ---------------------------------------------------------------------------
create view clinic_now as
select
  c.name                       as clinic_name,
  d.name                       as doctor_name,
  case
    -- Closing time beats everything, including a live session. §13.2's "hard
    -- close": at the end of the day the answer is closed regardless of who
    -- forgot to lock their tablet.
    when not app.clinic_is_open(now()) then 'closed'
    -- Then staleness. No heartbeat for five minutes and we simply do not know
    -- where he is, so we do not say.
    when p.last_heartbeat_at is null
         or p.last_heartbeat_at < now() - interval '5 minutes' then 'away'
    else p.status::text
  end                          as status,
  p.break_until,
  p.last_heartbeat_at          as as_of,
  app.clinic_is_open(now())    as clinic_open
from clinic c
left join lateral (
  select s.id, s.name from staff s
  where s.role = 'doctor' and s.active
  order by s.created_at
  limit 1
) d on true
left join presence p on p.staff_id = d.id;

comment on view clinic_now is
  'The public status page''s only source. Anon-readable on purpose; it carries no patient data and an as-of time on every reading (PLAN.md §13.3, rule 6).';

grant select on clinic_now to anon, authenticated;
grant execute on function app.clinic_is_open(timestamptz) to anon, authenticated;

-- The staff-side view, which may name the device and the note.
create view presence_detail as
select
  p.staff_id,
  s.name        as staff_name,
  s.role,
  p.status      as declared_status,
  case
    when not app.clinic_is_open(now()) then 'closed'
    when p.last_heartbeat_at is null
         or p.last_heartbeat_at < now() - interval '5 minutes' then 'away'
    else p.status::text
  end           as effective_status,
  p.source,
  p.last_heartbeat_at,
  p.break_until,
  p.note,
  dv.label      as device_label,
  dv.is_clinic_device
from presence p
join staff s on s.id = p.staff_id
left join devices dv on dv.id = p.device_id;

grant select on presence_detail to authenticated;

comment on view presence_detail is
  'declared_status is what he said; effective_status is what a patient would be told. They differ exactly when it matters.';
