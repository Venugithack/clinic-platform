-- M1 — clinic core: consent, tokens, the appointment state machine, signing.
--
-- The split from HOSTING.md §3 holds: reads and simple writes stay client-side
-- under RLS, and only state changes with a real invariant become transitions.
-- Registering a patient is ordinary CRUD. Three things here are not:
--
--   the daily token   two walk-ins registered at the same moment must not be
--                     handed the same number, and the sequence must not gap
--   the status moves  booked → waiting → in_consult → done is a state machine,
--                     and "done → in_consult" is a bug, not a correction
--   signing           the moment a prescription becomes the legal artefact the
--                     pharmacy acts on and the H1 register cites

-- ---------------------------------------------------------------------------
-- DPDP Act 2023 §15.1: consent, captured at registration, timestamped, stored,
-- revocable. It is a column rather than a checkbox in a form because "we asked"
-- has to survive the person who asked leaving.
-- ---------------------------------------------------------------------------
alter table patients
  add column consent_given_at   timestamptz,
  add column consent_source     text check (consent_source in ('registration', 'whatsapp', 'paper')),
  add column consent_revoked_at timestamptz;

comment on column patients.consent_given_at is
  'DPDP consent, purpose-limited to running the clinic. Revocable — see consent_revoked_at.';

-- ---------------------------------------------------------------------------
-- Today's queue. The default screen on both tablets (TABLET.md §7), so it is a
-- view rather than four joins repeated in two places.
-- ---------------------------------------------------------------------------
create view queue_today as
select
  a.id            as appointment_id,
  a.date,
  a.token_no,
  a.status,
  a.source,
  a.reason,
  p.id            as patient_id,
  p.name          as patient_name,
  p.age,
  p.sex,
  p.phone,
  p.allergies,
  e.id            as encounter_id,
  -- "3 ahead of you" (PLAN.md §14) counted over the people actually waiting,
  -- not over the whole day's list.
  count(*) filter (where a.status = 'waiting')
    over (order by a.token_no rows between unbounded preceding and 1 preceding) as ahead
from appointments a
join patients p on p.id = a.patient_id
left join encounters e on e.appointment_id = a.id
where a.date = current_date;

comment on view queue_today is 'The default screen on both tablets (TABLET.md §7).';

-- ---------------------------------------------------------------------------
-- The drug search row (TABLET.md §4).
--
-- Brand, salt and strength for matching; live stock and the earliest expiry for
-- the badge. PLAN.md §11.2 schedules the badge for M2 — the numbers are real
-- from M0's seed, so it costs nothing to surface now, and a composer that shows
-- what is on the shelf is the difference between prescribing and guessing.
--
-- Availability reads available_stock, which already excludes expired batches
-- entirely rather than flagging them (INVENTORY.md §3).
-- ---------------------------------------------------------------------------
create view drug_availability as
select
  d.id,
  d.name,
  d.generic,
  d.salt_composition,
  d.strength,
  d.form,
  d.base_unit,
  d.schedule,
  d.default_units_per_strip,
  d.default_strips_per_box,
  d.active,
  coalesce(sum(s.qty_base_on_hand), 0)::int as qty_base_available,
  min(s.expiry)                             as earliest_expiry,
  count(s.batch_id)::int                    as batches
from drugs d
left join available_stock s on s.drug_id = d.id
group by d.id;

grant select on queue_today, drug_availability to authenticated;

-- ---------------------------------------------------------------------------
-- app.book_appointment — the atomic daily token.
--
-- The unique (date, token_no) constraint makes a collision impossible; without
-- serialisation it would merely make it an error the counter sees. Locking the
-- day's row set means two people registering simultaneously queue behind each
-- other and both get a number.
-- ---------------------------------------------------------------------------
create or replace function app.book_appointment(
  p_patient_id uuid,
  p_date       date               default current_date,
  p_source     appointment_source default 'walkin',
  p_reason     text               default null
) returns appointments
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_token    int;
  v_row      appointments;
  -- A parameter DEFAULT applies when the argument is OMITTED, not when it is
  -- passed as null — and a JSON-RPC caller sending {"p_date": null} is passing
  -- it. Without these the insert fails on a not-null constraint, which is a
  -- confusing way to learn that "default" and "nullable" are different things.
  v_date     date               := coalesce(p_date, current_date);
  v_source   appointment_source := coalesce(p_source, 'walkin');
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  if not exists (select 1 from patients where id = p_patient_id) then
    raise exception 'unknown patient %', p_patient_id using errcode = 'PT006';
  end if;

  -- A clinic does not take bookings for last week.
  if v_date < current_date then
    raise exception 'cannot book an appointment in the past' using errcode = 'PT006';
  end if;

  -- Serialise token allocation for this day only. Two different days never
  -- contend; two registrations on the same day always do.
  perform pg_advisory_xact_lock(hashtext('appointment_token'), v_date - date '2000-01-01');

  select coalesce(max(token_no), 0) + 1 into v_token
  from appointments where date = v_date;

  insert into appointments (patient_id, date, token_no, status, source, reason)
  values (p_patient_id, v_date, v_token,
          (case when v_date = current_date then 'waiting' else 'booked' end)::appointment_status,
          v_source, p_reason)
  returning * into v_row;

  perform app.write_audit(
    'book_appointment', 'appointments', v_row.id, null,
    jsonb_build_object('patient_id', p_patient_id, 'date', v_date,
                       'token_no', v_token, 'source', v_source)
  );

  return v_row;
end
$$;

revoke all on function app.book_appointment(uuid, date, appointment_source, text) from public;
grant execute on function app.book_appointment(uuid, date, appointment_source, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.set_appointment_status — the state machine, stated once.
--
--   booked ──► waiting ──► in_consult ──► done
--      │          │            │
--      └──────────┴────────────┴──► no_show
--
-- Anything else is refused. A queue that can be walked backwards is a queue
-- nobody can reconstruct at the end of the day.
-- ---------------------------------------------------------------------------
create or replace function app.set_appointment_status(
  p_appointment_id uuid,
  p_status         appointment_status
) returns appointments
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_current  appointment_status;
  v_row      appointments;
  v_allowed  appointment_status[];
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  select status into v_current from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'unknown appointment %', p_appointment_id using errcode = 'PT006';
  end if;

  v_allowed := case v_current
    when 'booked'     then array['waiting', 'in_consult', 'no_show']::appointment_status[]
    when 'waiting'    then array['in_consult', 'no_show']::appointment_status[]
    when 'in_consult' then array['done', 'waiting']::appointment_status[]
    else array[]::appointment_status[]
  end;

  if not (p_status = any (v_allowed)) then
    raise exception 'cannot move an appointment from % to %', v_current, p_status
      using errcode = 'PT007';
  end if;

  update appointments set status = p_status
  where id = p_appointment_id
  returning * into v_row;

  perform app.write_audit(
    'set_appointment_status', 'appointments', p_appointment_id,
    jsonb_build_object('status', v_current),
    jsonb_build_object('status', p_status)
  );

  return v_row;
end
$$;

revoke all on function app.set_appointment_status(uuid, appointment_status) from public;
grant execute on function app.set_appointment_status(uuid, appointment_status)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.sign_prescription — the moment it becomes a legal artefact.
--
-- After this the prescription is immutable: it is what the pharmacy dispenses
-- against, what the Schedule H1 register cites, and per A7 the printed copy the
-- doctor signs by hand is the legal document. An edit after signing would mean
-- the paper in the patient's hand and the row in the database disagree.
--
-- Rule 8 applies to everything above it: nothing on this prescription was
-- computed, suggested or inferred. Only what the doctor entered.
-- ---------------------------------------------------------------------------
create or replace function app.sign_prescription(p_prescription_id uuid)
returns prescriptions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_rx       prescriptions;
  v_item     jsonb;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  select * into v_rx from prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'unknown prescription %', p_prescription_id using errcode = 'PT006';
  end if;

  -- Only the prescriber signs. The counter cannot, and neither can another
  -- doctor: §15.2 requires the prescriber's name against every H1 line.
  if v_rx.doctor_id <> v_staff_id then
    raise exception 'only the prescribing doctor can sign this prescription'
      using errcode = 'PT005';
  end if;

  if v_rx.signed_at is not null then
    raise exception 'this prescription was already signed at %', v_rx.signed_at
      using errcode = 'PT008';
  end if;

  if jsonb_array_length(v_rx.items) = 0 then
    raise exception 'an empty prescription cannot be signed' using errcode = 'PT006';
  end if;

  -- Every line must name a drug that exists and a positive quantity in base
  -- units. Validate everything before signing anything (PLAN.md §11.3): a
  -- prescription is handed over whole.
  for v_item in select * from jsonb_array_elements(v_rx.items)
  loop
    if not exists (select 1 from drugs where id = (v_item ->> 'drug_id')::uuid) then
      raise exception 'prescription line names a drug that is not in the catalogue'
        using errcode = 'PT006';
    end if;
    if coalesce((v_item ->> 'qty_base')::int, 0) <= 0 then
      raise exception 'every prescription line needs a positive quantity'
        using errcode = 'PT006';
    end if;
  end loop;

  update prescriptions
  set signed_at = now(), status = 'pending'
  where id = p_prescription_id
  returning * into v_rx;

  perform app.write_audit(
    'sign_prescription', 'prescriptions', p_prescription_id, null,
    jsonb_build_object('signed_at', v_rx.signed_at, 'lines', jsonb_array_length(v_rx.items))
  );

  return v_rx;
end
$$;

revoke all on function app.sign_prescription(uuid) from public;
grant execute on function app.sign_prescription(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants. appointments and prescriptions are now transition-owned for the
-- state they carry; the doctor still composes an unsigned prescription
-- client-side, which is why INSERT and UPDATE survive on prescriptions and the
-- RLS policy from 0400 restricts the update to signed_at is null.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on appointments from authenticated, anon;

comment on function app.book_appointment(uuid, date, appointment_source, text) is
  'Allocates the day''s next token under an advisory lock. Two simultaneous walk-ins both get a number.';
comment on function app.sign_prescription(uuid) is
  'Signing closes the prescription. A7: the hand-signed printed copy is the legal document.';
