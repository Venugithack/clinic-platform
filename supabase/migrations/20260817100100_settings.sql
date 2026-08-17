-- Clinic settings, from a screen instead of psql. PLAN.md §16, §18 Q10.
--
-- Everything in the `clinic` row is a setting the doctor is supposed to decide:
-- his consultation fee, whether a follow-up inside N days is free, his opening
-- hours, his registration number, the pharmacy's drug licence, the GSTIN, and
-- whether bills round to the rupee. Until this migration there was no INSERT or
-- UPDATE grant on that table and no transition — every one of them was a
-- developer with `psql`, on a row that appears on every printed bill.
--
-- Three things here are load-bearing.
--
-- **The timetable is validated, hard.** `app.clinic_is_open` reads
-- `open_hours` and treats a day it cannot parse as *closed* — which is the
-- right default for a page patients drive to a clinic on, and a terrible
-- failure mode for a typo. `{"mon": ["9:30-1:00 pm"]}` does not error
-- anywhere; it silently means "shut on Monday, forever", on the one screen the
-- clinic staff never look at because it is for patients. So a malformed window
-- is refused here, by day and by window, in words.
--
-- **The GSTIN is checked against its actual shape.** It is printed on every
-- bill, and a bill is a legal document that cannot be un-printed. Fifteen
-- characters in a known pattern is cheap to verify and expensive to get wrong.
--
-- **Null means "leave it", empty means "clear it".** The screen submits the
-- whole form every time, so the two have to be distinguishable: a field the
-- caller did not send keeps its value, and a field sent empty is set to null.
--
-- It will also CREATE the singleton row if the database has none, because the
-- first thing a real go-live does is fill this screen in on an empty database
-- (PLAN.md §16), and "the clinic does not exist yet" is not a state anybody
-- should need psql to leave.
--
-- Error code added here:
--   CL026  a setting that would quietly break something

create or replace function app.update_clinic(
  p_name                text default null,
  p_address             text default null,
  p_phone               text default null,
  p_doctor_reg_no       text default null,
  p_drug_licence_no     text default null,
  p_gstin               text default null,
  p_consult_fee         numeric default null,
  p_follow_up_free_days int default null,
  p_round_to_rupee      boolean default null,
  p_open_hours          jsonb default null,
  p_timezone            text default null
) returns clinic
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_clinic   clinic;
  v_day      text;
  v_value    jsonb;
  v_window   text;
  v_from     time;
  v_to       time;
  v_gstin    text;
  v_before   jsonb;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- The consultation fee and the licence numbers are the doctor's, and they
  -- appear on every bill. The counter does not set them.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'clinic settings are changed by the doctor or an admin'
      using errcode = 'CL005';
  end if;

  -- ------------------------------------------------------------------------
  -- The timetable, window by window.
  --
  -- Every message below names the day and the window, because the person
  -- reading it is looking at seven boxes and needs to know which one.
  -- ------------------------------------------------------------------------
  if p_open_hours is not null then
    if jsonb_typeof(p_open_hours) <> 'object' then
      raise exception 'opening hours should be a day-by-day timetable'
        using errcode = 'CL026';
    end if;

    for v_day, v_value in select key, value from jsonb_each(p_open_hours)
    loop
      if v_day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
        raise exception '"%" is not a day — use mon, tue, wed, thu, fri, sat, sun', v_day
          using errcode = 'CL026';
      end if;

      if jsonb_typeof(v_value) <> 'array' then
        raise exception 'the hours for % should be a list, like ["09:30-13:00"]', v_day
          using errcode = 'CL026';
      end if;

      for v_window in select jsonb_array_elements_text(v_value)
      loop
        if v_window !~ '^[0-9]{1,2}:[0-9]{2}-[0-9]{1,2}:[0-9]{2}$' then
          raise exception '% on % is not a time window — write it like 09:30-13:00',
            v_window, v_day using errcode = 'CL026';
        end if;

        begin
          v_from := split_part(v_window, '-', 1)::time;
          v_to   := split_part(v_window, '-', 2)::time;
        exception when others then
          raise exception '% on % is not a real time of day', v_window, v_day
            using errcode = 'CL026';
        end;

        if v_to <= v_from then
          raise exception '% on % ends before it starts', v_window, v_day
            using errcode = 'CL026';
        end if;
      end loop;
    end loop;
  end if;

  -- ------------------------------------------------------------------------
  -- The GSTIN. 15 characters: state code, PAN, entity number, Z, checksum.
  -- ------------------------------------------------------------------------
  v_gstin := nullif(upper(trim(coalesce(p_gstin, ''))), '');
  if v_gstin is not null
     and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception
      'that does not look like a GSTIN — it is 15 characters, like 37ABCDE1234F1Z5'
      using errcode = 'CL026';
  end if;

  if p_consult_fee is not null and p_consult_fee < 0 then
    raise exception 'a consultation fee cannot be negative' using errcode = 'CL026';
  end if;

  select * into v_clinic from clinic limit 1;
  v_before := to_jsonb(v_clinic);

  -- ------------------------------------------------------------------------
  -- No clinic yet. This is a real state — it is day one of go-live, on an
  -- empty database — and the name is the only thing that cannot be defaulted.
  -- ------------------------------------------------------------------------
  if v_clinic.id is null then
    if nullif(trim(coalesce(p_name, '')), '') is null then
      raise exception 'the clinic needs a name before anything else'
        using errcode = 'CL026';
    end if;

    insert into clinic (
      name, address, phone, doctor_reg_no, drug_licence_no, gstin,
      consult_fee, follow_up_free_days, round_to_rupee, open_hours, timezone)
    values (
      trim(p_name),
      nullif(trim(coalesce(p_address, '')), ''),
      nullif(trim(coalesce(p_phone, '')), ''),
      nullif(trim(coalesce(p_doctor_reg_no, '')), ''),
      nullif(trim(coalesce(p_drug_licence_no, '')), ''),
      v_gstin,
      coalesce(p_consult_fee, 0),
      case when p_follow_up_free_days < 0 then null else p_follow_up_free_days end,
      coalesce(p_round_to_rupee, true),
      coalesce(p_open_hours, '{}'::jsonb),
      coalesce(nullif(trim(coalesce(p_timezone, '')), ''), 'Asia/Kolkata'))
    returning * into v_clinic;

    perform app.write_audit('create_clinic', 'clinic', v_clinic.id, null,
      to_jsonb(v_clinic));

    return v_clinic;
  end if;

  -- ------------------------------------------------------------------------
  -- The update. Null leaves a field alone; an empty string clears it.
  -- ------------------------------------------------------------------------
  update clinic set
    name                = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    address             = case when p_address is null then address
                               else nullif(trim(p_address), '') end,
    phone               = case when p_phone is null then phone
                               else nullif(trim(p_phone), '') end,
    doctor_reg_no       = case when p_doctor_reg_no is null then doctor_reg_no
                               else nullif(trim(p_doctor_reg_no), '') end,
    drug_licence_no     = case when p_drug_licence_no is null then drug_licence_no
                               else nullif(trim(p_drug_licence_no), '') end,
    gstin               = case when p_gstin is null then gstin else v_gstin end,
    consult_fee         = coalesce(p_consult_fee, consult_fee),
    -- Free follow-ups are a policy that can be switched off, and off is a
    -- number the caller cannot express: -1 means "no free window at all".
    follow_up_free_days = case when p_follow_up_free_days is null then follow_up_free_days
                               when p_follow_up_free_days < 0 then null
                               else p_follow_up_free_days end,
    round_to_rupee      = coalesce(p_round_to_rupee, round_to_rupee),
    open_hours          = coalesce(p_open_hours, open_hours),
    timezone            = coalesce(nullif(trim(coalesce(p_timezone, '')), ''), timezone)
  where id = v_clinic.id
  returning * into v_clinic;

  -- Audited with the before and after, because "since when has the fee been
  -- ₹400?" is a question somebody asks three months later, and the licence
  -- numbers on a bill are a legal claim about who dispensed it.
  perform app.write_audit('update_clinic', 'clinic', v_clinic.id,
    v_before, to_jsonb(v_clinic));

  return v_clinic;
end
$$;

revoke all on function app.update_clinic(
  text, text, text, text, text, text, numeric, int, boolean, jsonb, text) from public;
grant execute on function app.update_clinic(
  text, text, text, text, text, text, numeric, int, boolean, jsonb, text)
  to authenticated, service_role;

comment on function app.update_clinic(
  text, text, text, text, text, text, numeric, int, boolean, jsonb, text) is
  'The settings screen. A malformed timetable means "shut, forever" to app.clinic_is_open, so it is refused here rather than discovered by a patient (PLAN.md §18 Q10).';
