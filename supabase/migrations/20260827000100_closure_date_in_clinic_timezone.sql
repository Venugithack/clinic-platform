-- The closure the doctor writes and the closure the status page reads were not
-- the same day.
--
-- app.clinic_is_open resolves the clinic's LOCAL day. It has to: opening hours
-- are 09:00–21:00 in Asia/Kolkata, and comparing a time of day in UTC would be
-- meaningless. So it converts (20260816250100_presence.sql:122) and looks a
-- closure up by that local date.
--
-- app.close_clinic_today wrote one at `current_date` — the SERVER's date. The
-- Supabase project and the CI runner both keep the server in UTC.
--
-- Those two agree for eighteen and a half hours a day and disagree for the
-- other five and a half, because 00:00–05:30 IST is still the previous day in
-- UTC. In that window the doctor closes the clinic, the row lands on yesterday,
-- app.clinic_is_open never finds it, and the page patients read stays OPEN.
-- app.reopen_clinic_today carried the mirror image: it deleted the previous
-- day's closure and left the real one standing.
--
-- Found by accident at 00:04 IST. The identical commit passed A2_presence at
-- 23:57 and failed it seven minutes later — runs 32999763370 and 33000425136 —
-- because the IST date rolled over between them. It would have failed every
-- night in that window from here on.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE: the appointment count in
-- close_clinic_today stays on `current_date`. Every other "today" in this
-- schema — appointments.date, queue_today, the day registers — is the server's
-- date, and a count that disagreed with the rows being counted would be a
-- second bug rather than half a fix. That the whole app calls the server's date
-- "today" is a real latent issue and it is recorded in NEXT.md; it has never
-- bitten because the clinic is shut between midnight and half past five.

-- While here: the fallback in app.clinic_day was spelled with a BACKSLASH —
-- `coalesce((select timezone from clinic limit 1), 'Asia\Kolkata')` at
-- 20260816230200_till_and_daybook.sql:25. Postgres knows no zone by that name,
-- so the branch meant to keep the daybook working when no clinic row exists
-- would instead raise `time zone "Asia\Kolkata" not recognized`.
--
-- It has never fired, because clinic.timezone is `not null default
-- 'Asia/Kolkata'` and the coalesce therefore never reaches its second argument
-- while a clinic row exists. A safety net that throws instead of catching is
-- worth the one character it costs to correct. Body otherwise identical.
create or replace function app.clinic_day(p_at timestamptz)
returns date
language sql
stable
as $$
  -- A clinic day is a local day. The counter closes at 21:00 IST, which is
  -- 15:30 UTC — grouping bills by UTC date would split every evening in half.
  select (p_at at time zone coalesce(
            (select timezone from clinic limit 1), 'Asia/Kolkata'))::date
$$;

-- One expression, in one place, so the write and the read cannot drift apart
-- again.
--
-- app.clinic_day(timestamptz) already exists and already does this conversion
-- (20260816230200_till_and_daybook.sql:17) — the daybook has grouped bills by
-- the clinic's local day since M4, for the same reason clinic_is_open converts:
-- "the counter closes at 21:00 IST, which is 15:30 UTC — grouping bills by UTC
-- date would split every evening in half". This is that function applied to
-- now(), not a second copy of its body.
create or replace function app.clinic_today()
returns date
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select app.clinic_day(now());
$$;

comment on function app.clinic_today() is
  'The clinic''s local calendar day. The same conversion app.clinic_is_open performs, so a closure is written on the date it will be read back from.';

revoke all on function app.clinic_today() from public;
grant execute on function app.clinic_today() to authenticated, service_role;

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
  values (app.clinic_today(), p_reason, true, v_staff_id)
  on conflict do nothing;

  -- Server date on purpose. See the header.
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

  delete from clinic_closures where on_date = app.clinic_today() and all_day;

  perform app.write_audit('reopen_clinic_today', 'clinic_closures', null, null,
    jsonb_build_object('on_date', app.clinic_today()));
end
$$;
