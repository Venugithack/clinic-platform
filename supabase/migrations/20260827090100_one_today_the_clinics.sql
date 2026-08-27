-- ---------------------------------------------------------------------------
-- "Today" means the clinic's day. Everywhere, and from here on.
--
-- The schema has carried two of them since M4. `app.clinic_day(timestamptz)`
-- converts an instant to the clinic's LOCAL date, because "the counter closes
-- at 21:00 IST, which is 15:30 UTC - grouping bills by UTC date would split
-- every evening in half". `h1_register`, the daybook and `app.clinic_is_open`
-- are built on it. Everything else asked `current_date`, which is the SERVER's
-- date, and the Supabase project and the CI runner both keep the server in UTC.
--
-- Those two agree for eighteen and a half hours a day. From 00:00 to 05:30 IST
-- they are different dates.
--
-- Twice now that gap has been found by something breaking rather than by
-- reading the schema:
--
--   `app.close_clinic_today` wrote a closure at the server's date while
--   `app.clinic_is_open` read one back at the clinic's, so the doctor could
--   close the clinic and the page patients read stayed open. Migration
--   20260827000100 fixed that one and said, in its own header, that the rest of
--   this was "a real latent issue" left for later, on the grounds that "the
--   clinic is shut between midnight and half past five".
--
--   Three E2E register specs then failed on a CI runner, deterministically,
--   because the clinic being shut protects the clinic and protects nothing
--   else. Every green run of that suite had fallen inside 09:00-21:00 IST and
--   every red one outside it.
--
-- This is the rest of it. Twenty-five occurrences across six views and nine
-- functions, every one of them the word "today", all now `app.clinic_today()`
-- - which is `app.clinic_day(now())`, the conversion that has been here since
-- M4, reading `clinic.timezone` rather than naming a zone a second time.
--
-- WHY THE BODIES ARE REPRODUCED IN FULL. Postgres has no way to change one
-- token inside a view or a function; `create or replace` takes the whole
-- object. Each body below is the CURRENT one - the view sources as the last
-- migration to define them left them, the function bodies as
-- `pg_get_functiondef` returns them from a database with all thirty-four
-- migrations applied - with `current_date` replaced and nothing else touched.
--
-- The two settings this deliberately does NOT introduce:
--
--   No `alter database ... set timezone`. It would make `current_date` mean the
--   clinic's day in one line, and it lives in `pg_database.datconfig`, which
--   `pg_dump` does not carry. The restore drill would rebuild a database with a
--   different notion of "today" than the one it dumped, which is the one thing
--   a restore drill must not do.
--
--   No `alter function ... set timezone` either. Same result per function, and
--   `proconfig` does survive a dump - but it names the zone instead of reading
--   `clinic.timezone`, and a schema with the zone written down in fifteen
--   places is the drift 20260827000100 was written to end.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- The views.
-- ===========================================================================

-- queue_today: The queue is the clinic's day. Between 00:00 and 05:30 IST `a.date =
-- current_date` asked for yesterday's, and both tablets open on an empty screen.
create or replace view queue_today as
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
left join lateral (
  select en.id
  from encounters en
  where en.appointment_id = a.id
  order by en.created_at, en.id
  limit 1
) e on true
where a.date = app.clinic_today();

-- available_stock: What is dispensable now - `b.expiry >= today` - on the day the counter is
-- standing in.
create or replace view available_stock as
select
  b.id            as batch_id,
  b.drug_id,
  b.batch_no,
  b.expiry,
  b.units_per_strip,
  b.strips_per_box,
  b.mrp,
  b.mrp_basis,
  b.cost_per_base_unit,
  b.qty_base_on_hand,
  app.units_in_pack(b.units_per_strip, b.strips_per_box, b.mrp_basis::text) as units_in_pack,
  b.supplier_id
from stock_batches b
where b.qty_base_on_hand > 0
  and b.expiry >= app.clinic_today();

-- expiring_soon: Seven of them, all arithmetic against today: days_to_expiry, the supplier's
-- return window, and the 90-day horizon.
create or replace view expiring_soon as
select
  b.id                            as batch_id,
  b.drug_id,
  d.name                          as drug_name,
  d.schedule,
  b.batch_no,
  b.expiry,
  (b.expiry - app.clinic_today())::int  as days_to_expiry,
  b.qty_base_on_hand,
  b.units_per_strip,
  b.strips_per_box,
  round(b.qty_base_on_hand * b.cost_per_base_unit, 2) as value_at_cost,
  b.supplier_id,
  s.name                          as supplier_name,
  s.return_window_days,
  case when s.return_window_days is not null
       then b.expiry - s.return_window_days end as return_by,
  case when s.return_window_days is not null
       then (b.expiry - s.return_window_days - app.clinic_today())::int end as days_to_return_by,
  -- The whole point of the section. Returnable is a supplier-specific date, and
  -- it passes long before the expiry does.
  coalesce(
    s.return_window_days is not null
      and app.clinic_today() <= b.expiry - s.return_window_days,
    false
  ) as returnable
from stock_batches b
join drugs d on d.id = b.drug_id
left join suppliers s on s.id = b.supplier_id
where b.qty_base_on_hand > 0
  and b.expiry >= app.clinic_today()
  and (
    -- Either the stock itself is close, PLAN.md §12.3's ninety days …
    b.expiry <= app.clinic_today() + 90
    -- … or the door to the supplier is about to shut, which happens first and
    -- is the reason this view exists at all. Note the lower bound: a window
    -- that closed long ago on stock that is still a year from expiring is not
    -- news, it is noise. Those batches arrive here later, through the clause
    -- above, at the point where they are about to become a write-off.
    or (s.return_window_days is not null
        and b.expiry - s.return_window_days
            between app.clinic_today() and app.clinic_today() + 90)
  );

-- expired_stock: days_expired, and the line between expired and not.
create or replace view expired_stock as
select
  b.id                            as batch_id,
  b.drug_id,
  d.name                          as drug_name,
  b.batch_no,
  b.expiry,
  (app.clinic_today() - b.expiry)::int  as days_expired,
  b.qty_base_on_hand,
  round(b.qty_base_on_hand * b.cost_per_base_unit, 2) as value_at_cost,
  b.supplier_id,
  s.name                          as supplier_name
from stock_batches b
join drugs d on d.id = b.drug_id
left join suppliers s on s.id = b.supplier_id
where b.qty_base_on_hand > 0
  and b.expiry < app.clinic_today();

-- open_supplier_credits: days_open on a credit note.
create or replace view open_supplier_credits as
select
  c.id            as credit_id,
  c.supplier_id,
  s.name          as supplier_name,
  c.return_id,
  c.amount_expected,
  c.amount_settled,
  c.amount_expected - c.amount_settled as outstanding,
  c.opened_at,
  (app.clinic_today() - c.opened_at::date)::int as days_open
from supplier_credits c
join suppliers s on s.id = c.supplier_id
where c.status = 'open';

-- stock_valuation: Unexpired stock at cost.
create or replace view stock_valuation as
select
  b.drug_id,
  d.name          as drug_name,
  d.schedule,
  count(*)::int   as batches,
  sum(b.qty_base_on_hand)::int as qty_base_on_hand,
  round(sum(b.qty_base_on_hand * b.cost_per_base_unit), 2) as value_at_cost,
  min(b.expiry)   as earliest_expiry
from stock_batches b
join drugs d on d.id = b.drug_id
where b.qty_base_on_hand > 0
  and b.expiry >= app.clinic_today()
group by b.drug_id, d.name, d.schedule;

-- ===========================================================================
-- The functions. Each body is verbatim from a database at migration 34; the
-- only edit in each is the one word.
-- ===========================================================================

-- app.book_appointment: Four of them.
--
-- The p_date DEFAULT and its coalesce twin: a walk-in with no date given is
-- being registered TODAY, and at 00:30 IST the server's date would file them
-- under yesterday - where the token numbering and the `unique (date, token_no)`
-- constraint already are.
--
-- Then the past-date guard, which would otherwise refuse a booking made for
-- the clinic's own today. Then 'waiting' versus 'booked': a patient standing at
-- the counter is waiting, and only the clinic's date knows they are standing
-- there now.
--
-- A parameter DEFAULT is evaluated in the CALLER's context rather than this
-- function's, which is why app.clinic_today() is granted to `authenticated`.
CREATE OR REPLACE FUNCTION app.book_appointment(p_patient_id uuid, p_date date DEFAULT app.clinic_today(), p_source appointment_source DEFAULT 'walkin'::appointment_source, p_reason text DEFAULT NULL::text)
 RETURNS appointments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id uuid;
  v_token    int;
  v_row      appointments;
  -- A parameter DEFAULT applies when the argument is OMITTED, not when it is
  -- passed as null — and a JSON-RPC caller sending {"p_date": null} is passing
  -- it. Without these the insert fails on a not-null constraint, which is a
  -- confusing way to learn that "default" and "nullable" are different things.
  v_date     date               := coalesce(p_date, app.clinic_today());
  v_source   appointment_source := coalesce(p_source, 'walkin');
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if not exists (select 1 from patients where id = p_patient_id) then
    raise exception 'unknown patient %', p_patient_id using errcode = 'CL006';
  end if;

  -- A clinic does not take bookings for last week.
  if v_date < app.clinic_today() then
    raise exception 'cannot book an appointment in the past' using errcode = 'CL006';
  end if;

  -- Serialise token allocation for this day only. Two different days never
  -- contend; two registrations on the same day always do.
  perform pg_advisory_xact_lock(hashtext('appointment_token'), v_date - date '2000-01-01');

  select coalesce(max(token_no), 0) + 1 into v_token
  from appointments where date = v_date;

  insert into appointments (patient_id, date, token_no, status, source, reason)
  values (p_patient_id, v_date, v_token,
          (case when v_date = app.clinic_today() then 'waiting' else 'booked' end)::appointment_status,
          v_source, p_reason)
  returning * into v_row;

  perform app.write_audit(
    'book_appointment', 'appointments', v_row.id, null,
    jsonb_build_object('patient_id', p_patient_id, 'date', v_date,
                       'token_no', v_token, 'source', v_source)
  );

  return v_row;
end
$function$;

-- app.close_clinic_today: The one 20260827000100 left on purpose. It counted appointments at the
-- server's date because every row it counted was STORED against the server's
-- date, and a count that disagreed with its own rows would have been a second
-- bug. `book_appointment` above is the other half, so the two move together.
CREATE OR REPLACE FUNCTION app.close_clinic_today(p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
  where a.date = app.clinic_today()
    and a.status in ('booked', 'waiting');

  perform app.write_audit('close_clinic_today', 'clinic_closures', null, null,
    jsonb_build_object('reason', p_reason, 'appointments_affected', v_affected));

  return v_affected;
end
$function$;

-- app.dispense: The expiry guard. The counter must not hand over a box that expired today,
-- and today is the day the counter is standing in.
CREATE OR REPLACE FUNCTION app.dispense(p_lines jsonb, p_prescription_id uuid DEFAULT NULL::uuid, p_patient_id uuid DEFAULT NULL::uuid, p_is_counter_sale boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id      uuid;
  v_dispense_id   uuid;
  v_line          jsonb;
  v_drug          drugs%rowtype;
  v_batch         record;
  v_drug_id       uuid;
  v_qty_base      int;
  v_remaining     int;
  v_take          int;
  v_units_in_pack int;
  v_unit_price    numeric(12, 4);
  v_cap           numeric(12, 2);
  v_amount        numeric(12, 2);
  v_movement_type stock_movement_type;
  v_total         numeric(12, 2) := 0;
  v_line_count    int := 0;
  v_prescribed_id uuid;
  v_approved_by   uuid;
  v_fully_dispensed boolean;
  v_over            record;
begin
  -- Attribution first. Every write carries the staff id from the PIN, because
  -- the Schedule H1 register legally needs a person's name, not a tablet's.
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'dispense needs at least one line' using errcode = 'CL006';
  end if;

  if p_prescription_id is null and not p_is_counter_sale then
    raise exception 'a dispense must be against a prescription or flagged as a counter sale'
      using errcode = 'CL006';
  end if;

  v_movement_type := case when p_is_counter_sale then 'sale' else 'dispense' end;

  -- ---------------------------------------------------------------------------
  -- What this prescription still has outstanding.
  --
  -- Until this block existed, `dispense` checked only whether the SHELF could
  -- satisfy the request. It never asked whether the PRESCRIPTION could. Status
  -- was computed afterwards by summing every dispense_line ever recorded
  -- against it, which made "dispense the remainder" and "dispense the whole
  -- thing a second time" the same call.
  --
  -- Reachable with two taps and no privilege: the cabin tablet and the counter
  -- tablet both open one prescription while it is still pending, both verify,
  -- both press Dispense. Thirty tablets leave the shelf for a fifteen-tablet
  -- prescription, both screens report success, and the patient appears twice on
  -- the billing screen at the same amount and the same second. Nothing is
  -- flagged until a stock-take months later.
  --
  -- The FOR UPDATE is the half that fixes the race rather than merely the
  -- repeat. Two concurrent calls both read "15 outstanding" and both proceed
  -- unless one of them is made to wait here; the second then sees the first's
  -- dispense_lines and is refused.
  --
  -- Partial dispensing is why no guard was here in the first place, so the test
  -- is against the REMAINDER, never against "has this been dispensed at all":
  -- 4 of 10 then 6 of 10 still works, and the 11th unit does not.
  -- ---------------------------------------------------------------------------
  if p_prescription_id is not null then
    perform 1 from prescriptions where id = p_prescription_id for update;
    if not found then
      raise exception 'unknown prescription %', p_prescription_id using errcode = 'CL006';
    end if;

    for v_over in
      with requested as (
        select coalesce((l ->> 'prescribed_drug_id')::uuid, (l ->> 'drug_id')::uuid) as drug_id,
               sum((l ->> 'qty_base')::int) as qty
        from jsonb_array_elements(p_lines) l
        group by 1
      ),
      -- A substitute counts against the drug it replaced, exactly as the status
      -- calculation below already counts it. Keying these two differently is
      -- how a guard like this ends up refusing every approved substitution.
      prescribed as (
        select (i ->> 'drug_id')::uuid as drug_id, sum((i ->> 'qty_base')::int) as qty
        from prescriptions p, jsonb_array_elements(p.items) i
        where p.id = p_prescription_id
        group by 1
      ),
      already as (
        select coalesce(dl.prescribed_drug_id, dl.drug_id) as drug_id, sum(dl.qty_base) as qty
        from dispense_lines dl
        join dispenses d on d.id = dl.dispense_id
        where d.prescription_id = p_prescription_id
        group by 1
      )
      select r.drug_id,
             r.qty                                             as want,
             coalesce(pr.qty, 0)                               as prescribed_qty,
             coalesce(pr.qty, 0) - coalesce(a.qty, 0)          as outstanding
      from requested r
      left join prescribed pr on pr.drug_id = r.drug_id
      left join already    a  on a.drug_id  = r.drug_id
      where r.qty > coalesce(pr.qty, 0) - coalesce(a.qty, 0)
    loop
      select * into v_drug from drugs where id = v_over.drug_id;

      if v_over.prescribed_qty = 0 then
        raise exception '"%" is not on this prescription', coalesce(v_drug.name, v_over.drug_id::text)
          using errcode = 'CL028';
      end if;

      if v_over.outstanding <= 0 then
        raise exception '"%" has already been dispensed in full against this prescription',
          v_drug.name
          using errcode = 'CL028';
      end if;

      raise exception
        'only % base units of "%" are still outstanding on this prescription, not %',
        v_over.outstanding, v_drug.name, v_over.want
        using errcode = 'CL028';
    end loop;
  end if;

  insert into dispenses (prescription_id, patient_id, staff_id, is_counter_sale)
  values (p_prescription_id, p_patient_id, v_staff_id, p_is_counter_sale)
  returning id into v_dispense_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_drug_id       := (v_line ->> 'drug_id')::uuid;
    v_qty_base      := (v_line ->> 'qty_base')::int;
    v_prescribed_id := (v_line ->> 'prescribed_drug_id')::uuid;
    v_approved_by   := (v_line ->> 'substitution_approved_by')::uuid;

    if v_drug_id is null or v_qty_base is null or v_qty_base <= 0 then
      raise exception 'each line needs a drug_id and a positive qty_base'
        using errcode = 'CL006';
    end if;

    select * into v_drug from drugs where id = v_drug_id;
    if not found then
      raise exception 'unknown drug %', v_drug_id using errcode = 'CL006';
    end if;

    -- Legal, not a preference: a Schedule H1 drug cannot leave the counter
    -- without a prescription (PLAN.md §15.2, INVENTORY.md §3).
    if p_is_counter_sale and v_drug.schedule = 'H1' then
      raise exception 'Schedule H1 drug "%" cannot be sold without a prescription', v_drug.name
        using errcode = 'CL003';
    end if;

    v_remaining := v_qty_base;

    -- FEFO: first expiry, first out. Expired batches are not in this cursor at
    -- all — they are excluded from on-hand, not merely flagged, which is the
    -- INVENTORY.md §3 rule that stops the prototype's expired-stock bug.
    -- Allocation splits across batches and records each, for recall traceability.
    for v_batch in
      select b.id, b.qty_base_on_hand, b.mrp, b.mrp_basis,
             b.units_per_strip, b.strips_per_box, b.cost_per_base_unit
      from stock_batches b
      where b.drug_id = v_drug_id
        and b.qty_base_on_hand > 0
        and b.expiry >= app.clinic_today()
      order by b.expiry asc, b.received_at asc
      for update
    loop
      exit when v_remaining = 0;

      v_take := least(v_remaining, v_batch.qty_base_on_hand);

      v_units_in_pack := app.units_in_pack(
        v_batch.units_per_strip, v_batch.strips_per_box, v_batch.mrp_basis::text
      );
      v_unit_price := round(v_batch.mrp / v_units_in_pack, 4);

      -- The MRP ceiling. Selling above the printed MRP is illegal, so rounding
      -- a loose-tablet price up past it is a legal problem, not a rounding
      -- problem: the paise-rounded figure is clamped to the exact pro-rata cap.
      v_cap    := trunc(v_batch.mrp * v_take::numeric / v_units_in_pack, 2);
      v_amount := least(round(v_take * v_unit_price, 2), v_cap);

      if v_amount > v_cap then
        raise exception 'line total % exceeds MRP ceiling % for batch %',
          v_amount, v_cap, v_batch.id
          using errcode = 'CL004';
      end if;

      insert into dispense_lines (
        dispense_id, drug_id, batch_id, qty_base, unit_price, amount,
        cost_at_dispense, prescribed_drug_id, substitution_approved_by
      )
      values (
        v_dispense_id, v_drug_id, v_batch.id, v_take, v_unit_price, v_amount,
        v_batch.cost_per_base_unit, v_prescribed_id, v_approved_by
      );

      -- The ledger row and the cache update, in the same transaction. Rule 3.
      insert into stock_movements (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id)
      values (v_drug_id, v_batch.id, -v_take, v_movement_type, 'dispense', v_dispense_id, v_staff_id);

      update stock_batches
      set qty_base_on_hand = qty_base_on_hand - v_take
      where id = v_batch.id;

      v_remaining  := v_remaining - v_take;
      v_total      := v_total + v_amount;
      v_line_count := v_line_count + 1;
    end loop;

    -- Stock can never go negative: no override, no staff role, no "allow" flag.
    -- A short dispense fails the whole transaction rather than inventing stock.
    -- The counter's route out of "it is on the shelf but not in the system" is
    -- the inline quick-GRN (INVENTORY.md §3), not a negative number.
    if v_remaining > 0 then
      if v_remaining = v_qty_base then
        raise exception
          'no unexpired stock of "%" — % base units required', v_drug.name, v_qty_base
          using errcode = 'CL002';
      end if;
      raise exception
        'insufficient stock of "%" — short by % of % base units',
        v_drug.name, v_remaining, v_qty_base
        using errcode = 'CL001';
    end if;
  end loop;

  -- Prescription status follows from what has actually been dispensed against
  -- it, across every dispense, counting a substitute against what it replaced.
  if p_prescription_id is not null then
    select bool_and(coalesce(g.qty, 0) >= w.qty)
    into v_fully_dispensed
    from (
      select (i ->> 'drug_id')::uuid as drug_id, sum((i ->> 'qty_base')::int) as qty
      from prescriptions p, jsonb_array_elements(p.items) i
      where p.id = p_prescription_id
      group by 1
    ) w
    left join (
      select coalesce(dl.prescribed_drug_id, dl.drug_id) as drug_id, sum(dl.qty_base) as qty
      from dispense_lines dl
      join dispenses d on d.id = dl.dispense_id
      where d.prescription_id = p_prescription_id
      group by 1
    ) g on g.drug_id = w.drug_id;

    update prescriptions
    set status = (case
                   when coalesce(v_fully_dispensed, false) then 'dispensed'
                   else 'partial'
                 end)::prescription_status
    where id = p_prescription_id;
  end if;

  -- The audit row, written here rather than by a caller who remembers to, and
  -- carrying changed fields only rather than a row snapshot (HOSTING.md §4).
  perform app.write_audit(
    'dispense',
    'dispenses',
    v_dispense_id,
    null,
    jsonb_build_object(
      'prescription_id', p_prescription_id,
      'patient_id',      p_patient_id,
      'is_counter_sale', p_is_counter_sale,
      'lines',           v_line_count,
      'total',           v_total
    )
  );

  return v_dispense_id;
end
$function$;

-- app.import_opening_stock: An expiry already past on the day of the import is rejected.
CREATE OR REPLACE FUNCTION app.import_opening_stock(p_rows jsonb, p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id     uuid;
  v_row          jsonb;
  v_index        int := 0;
  v_errors       jsonb := '[]'::jsonb;
  v_prepared     jsonb := '[]'::jsonb;
  v_seen         text[] := '{}';
  v_drug         drugs%rowtype;
  v_supplier_id  uuid;
  v_name         text;
  v_strength     text;
  v_batch_no     text;
  v_expiry       date;
  v_qty          numeric;
  v_qty_basis    text;
  v_cost         numeric;
  v_cost_basis   text;
  v_mrp          numeric;
  v_mrp_basis    text;
  v_ups          int;
  v_spb          int;
  v_key          text;
  v_units        int;
  v_cost_base    numeric;
  v_total_units  bigint := 0;
  v_total_value  numeric := 0;
  v_group        jsonb;
  v_group_sup    text;
  v_group_inv    text;
  v_invoice_date date;
  v_batches      int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- Opening stock is the shelf's whole value. It is not a counter errand.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'opening stock is loaded by the doctor or an admin'
      using errcode = 'CL005';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'there is nothing in that file' using errcode = 'CL006';
  end if;

  -- ------------------------------------------------------------------------
  -- Pass one: read every row, complain about all of them, write nothing.
  -- ------------------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;
    v_name     := nullif(trim(coalesce(v_row ->> 'name', '')), '');
    v_strength := nullif(trim(coalesce(v_row ->> 'strength', '')), '');
    v_batch_no := nullif(trim(coalesce(v_row ->> 'batch_no', '')), '');

    if v_name is null then
      v_errors := v_errors || jsonb_build_object('row', v_index, 'message', 'no drug name');
      continue;
    end if;

    -- Rule 1. The master is step one for a reason.
    if v_strength is null then
      select * into v_drug from drugs where lower(name) = lower(v_name);
    else
      select * into v_drug from drugs
      where lower(name) = lower(v_name) and lower(strength) = lower(v_strength);
    end if;

    if not found then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', format('no drug called "%s%s" in the master — load the drug master first',
                          v_name, coalesce(' ' || v_strength, '')));
      continue;
    end if;

    if v_batch_no is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', 'no batch number — expiry, returns and any recall are all kept by batch');
      continue;
    end if;

    v_expiry := app.parse_expiry(v_row ->> 'expiry');
    if v_expiry is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('cannot read the expiry "%s" — write it as 03/2027',
                          coalesce(v_row ->> 'expiry', '')));
      continue;
    end if;

    if app.month_end(v_expiry) < app.clinic_today() then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s expired %s — expired stock is written off, not loaded',
                          v_batch_no, to_char(v_expiry, 'Mon YYYY')));
      continue;
    end if;

    -- Rule 2. The one that stops the shelf doubling.
    v_key := v_drug.id::text || '|' || lower(v_batch_no);

    if exists (select 1 from stock_batches
               where drug_id = v_drug.id and lower(batch_no) = lower(v_batch_no)) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s of %s is already on the shelf — opening stock is loaded once',
                          v_batch_no, v_drug.name));
      continue;
    end if;

    if v_key = any (v_seen) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s of %s appears twice in this file',
                          v_batch_no, v_drug.name));
      continue;
    end if;

    -- Rule 3. What the numbers mean.
    v_qty_basis  := lower(coalesce(nullif(trim(coalesce(v_row ->> 'qty_basis', '')), ''), 'strip'));
    v_cost_basis := lower(coalesce(nullif(trim(coalesce(v_row ->> 'cost_basis', '')), ''), 'strip'));
    v_mrp_basis  := lower(coalesce(nullif(trim(coalesce(v_row ->> 'mrp_basis', '')), ''),
                                   v_drug.default_mrp_basis::text, 'strip'));

    if v_qty_basis not in ('unit', 'strip', 'box')
       or v_cost_basis not in ('unit', 'strip', 'box')
       or v_mrp_basis not in ('unit', 'strip', 'box') then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', 'quantity, cost and MRP are each counted in units, strips or boxes');
      continue;
    end if;

    v_ups := coalesce((v_row ->> 'units_per_strip')::int, v_drug.default_units_per_strip, 1);
    v_spb := coalesce((v_row ->> 'strips_per_box')::int, v_drug.default_strips_per_box, 1);

    if v_ups <= 0 or v_spb <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name, 'message', 'pack sizes have to be positive');
      continue;
    end if;

    v_qty  := (v_row ->> 'qty')::numeric;
    v_cost := (v_row ->> 'cost')::numeric;
    v_mrp  := (v_row ->> 'mrp')::numeric;

    if v_qty is null or v_qty <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no quantity', v_batch_no));
      continue;
    end if;

    if v_qty <> trunc(v_qty) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('%s %ss of batch %s — count in whole packs, or say the quantity is in units',
                          v_qty, v_qty_basis, v_batch_no));
      continue;
    end if;

    -- Valuation depends on it (INVENTORY.md §4), and so does every margin
    -- number the reorder screen shows.
    if v_cost is null or v_cost <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no cost — the shelf cannot be valued without it',
                          v_batch_no));
      continue;
    end if;

    -- A batch with no MRP cannot be sold: the counter has no price to charge.
    if v_mrp is null or v_mrp <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no MRP — the counter would have no price to charge',
                          v_batch_no));
      continue;
    end if;

    -- Who it came from. Named in the file if the doctor knows, otherwise the
    -- drug's usual supplier — and it matters beyond bookkeeping: an expiry
    -- return goes back to whoever supplied the batch (INVENTORY.md §6), so a
    -- batch with no supplier is a batch that can only ever be written off.
    v_supplier_id := null;
    if nullif(trim(coalesce(v_row ->> 'supplier', '')), '') is not null then
      select id into v_supplier_id from suppliers
      where lower(name) = lower(trim(v_row ->> 'supplier'));

      if v_supplier_id is null then
        v_errors := v_errors || jsonb_build_object(
          'row', v_index, 'name', v_drug.name,
          'message', format('no supplier called "%s" — add them, or leave the column empty',
                            trim(v_row ->> 'supplier')));
        continue;
      end if;
    else
      v_supplier_id := v_drug.default_supplier_id;
    end if;

    v_seen := v_seen || v_key;

    -- Base units, once, here. `receive_goods` multiplies packs by the pack
    -- size, so a quantity given in loose units is passed as units with a pack
    -- basis of one.
    v_units := (v_qty * app.units_in_pack(v_ups, v_spb, v_qty_basis))::int;
    v_cost_base := round(v_cost / app.units_in_pack(v_ups, v_spb, v_cost_basis), 4);

    v_total_units := v_total_units + v_units;
    v_total_value := v_total_value + round(v_cost_base * v_units, 2);
    v_batches := v_batches + 1;

    v_prepared := v_prepared || jsonb_build_object(
      'drug_id',            v_drug.id,
      'batch_no',           v_batch_no,
      'expiry',             v_expiry,
      'units_per_strip',    v_ups,
      'strips_per_box',     v_spb,
      'mrp',                v_mrp,
      'mrp_basis',          v_mrp_basis,
      'pack_basis',         v_qty_basis,
      'qty_packs',          v_qty::int,
      'cost_per_base_unit', v_cost_base,
      '_supplier_id',       v_supplier_id,
      '_invoice_no',        nullif(trim(coalesce(v_row ->> 'invoice_no', '')), ''),
      '_invoice_date',      app.parse_expiry(v_row ->> 'invoice_date'));
  end loop;

  if jsonb_array_length(v_errors) > 0 then
    if p_dry_run then
      return jsonb_build_object(
        'dry_run', true, 'batches', 0, 'units', 0, 'value', 0,
        'errors', v_errors);
    end if;

    raise exception '% of % rows cannot be loaded — nothing was written',
      jsonb_array_length(v_errors), jsonb_array_length(p_rows)
      using errcode = 'CL025';
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true, 'batches', v_batches, 'units', v_total_units,
      'value', v_total_value, 'errors', '[]'::jsonb);
  end if;

  -- ------------------------------------------------------------------------
  -- Pass two: one goods receipt per supplier, per invoice.
  --
  -- Per supplier because `stock_batches.supplier_id` comes from the receipt,
  -- and a batch that does not know who supplied it cannot be returned to them.
  -- Per invoice because that is what the purchase register is a register OF.
  -- Rows with no invoice number produce a receipt marked as awaiting one,
  -- which is the honest reading: the clinic has no invoice on file for stock
  -- that was already on the shelf when the system arrived.
  -- ------------------------------------------------------------------------
  for v_group_sup, v_group_inv in
    select distinct l ->> '_supplier_id', l ->> '_invoice_no'
    from jsonb_array_elements(v_prepared) l
  loop
    select jsonb_agg(l - '_supplier_id' - '_invoice_no' - '_invoice_date'),
           max((l ->> '_invoice_date')::date)
      into v_group, v_invoice_date
    from jsonb_array_elements(v_prepared) l
    where (l ->> '_supplier_id') is not distinct from v_group_sup
      and (l ->> '_invoice_no')  is not distinct from v_group_inv;

    perform app.receive_goods(
      v_group,
      v_group_sup::uuid,
      v_group_inv,
      v_invoice_date,
      v_group_inv is null,
      'Opening stock at go-live');
  end loop;

  perform app.write_audit('import_opening_stock', 'stock_batches', null, null,
    jsonb_build_object('batches', v_batches, 'units', v_total_units,
                       'value', v_total_value, 'rows', jsonb_array_length(p_rows)));

  return jsonb_build_object(
    'dry_run', false, 'batches', v_batches, 'units', v_total_units,
    'value', v_total_value, 'errors', '[]'::jsonb);
end
$function$;

-- app.raise_bill: The financial year a bill number belongs to. A bill raised at 00:30 IST on
-- 1 April belongs to the year that started that morning, not to the one that
-- ended the evening before.
CREATE OR REPLACE FUNCTION app.raise_bill(p_patient_id uuid DEFAULT NULL::uuid, p_encounter_id uuid DEFAULT NULL::uuid, p_dispense_ids jsonb DEFAULT '[]'::jsonb, p_consult_fee numeric DEFAULT NULL::numeric, p_discount numeric DEFAULT 0, p_note text DEFAULT NULL::text)
 RETURNS bills
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id   uuid;
  v_clinic     clinic%rowtype;
  v_bill       bills;
  v_line       record;
  v_fee        numeric(12, 2);
  v_basis      text;
  v_medicines  numeric(12, 2) := 0;
  v_discount   numeric(12, 2) := coalesce(p_discount, 0);
  v_subtotal   numeric(12, 2);
  v_total      numeric(12, 2);
  v_round      numeric(12, 2) := 0;
  v_fy         text;
  v_no         int;
  v_patient_id uuid := p_patient_id;
  v_ids        uuid[];
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_clinic from clinic limit 1;

  select coalesce(array_agg((value #>> '{}')::uuid), '{}')
  into v_ids
  from jsonb_array_elements(coalesce(p_dispense_ids, '[]'::jsonb));

  -- A bill for nothing is not a bill.
  if coalesce(array_length(v_ids, 1), 0) = 0 and coalesce(p_consult_fee, v_clinic.consult_fee) = 0 then
    raise exception 'a bill needs a consult fee or at least one dispense'
      using errcode = 'CL006';
  end if;

  if v_discount < 0 then
    raise exception 'a discount cannot be negative' using errcode = 'CL006';
  end if;

  -- The consult fee: what was passed, or clinic policy applied.
  if p_consult_fee is not null then
    v_fee   := p_consult_fee;
    v_basis := 'manual';
  elsif p_encounter_id is null then
    v_fee   := 0;
    v_basis := 'standard';
  elsif v_clinic.follow_up_free_days is not null
        and exists (
          select 1
          from bills b
          join encounters e on e.id = b.encounter_id
          where e.patient_id = (select patient_id from encounters where id = p_encounter_id)
            and b.status = 'paid'
            and b.consult_fee > 0
            and b.created_at >= now() - (v_clinic.follow_up_free_days || ' days')::interval
        )
  then
    -- Policy, not inference: he set a window, and a repeat visit inside it is
    -- not charged. It is still overridable by passing a fee.
    v_fee   := 0;
    v_basis := 'follow_up_free';
  else
    v_fee   := v_clinic.consult_fee;
    v_basis := 'standard';
  end if;

  if p_encounter_id is not null and v_patient_id is null then
    select patient_id into v_patient_id from encounters where id = p_encounter_id;
  end if;

  v_fy := app.financial_year(app.clinic_today());

  insert into bill_counters (financial_year) values (v_fy)
  on conflict (financial_year) do nothing;

  -- FOR UPDATE, so a rollback hands the number back instead of burning it.
  update bill_counters
  set last_no = last_no + 1
  where financial_year = v_fy
  returning last_no into v_no;

  insert into bills (patient_id, encounter_id, consult_fee, medicines_total,
                     discount, total, status, bill_no, financial_year,
                     raised_by, consult_fee_basis, note)
  values (v_patient_id, p_encounter_id, v_fee, 0, v_discount, 0, 'unpaid',
          v_fy || '/' || lpad(v_no::text, 5, '0'), v_fy, v_staff_id, v_basis, p_note)
  returning * into v_bill;

  if v_fee > 0 then
    insert into bill_lines (bill_id, kind, description, amount)
    values (v_bill.id, 'consult', 'Consultation', v_fee);
  elsif v_basis = 'follow_up_free' then
    -- Printed at zero rather than omitted: the patient should be able to see
    -- that the follow-up was free and not wonder whether it was forgotten.
    insert into bill_lines (bill_id, kind, description, amount)
    values (v_bill.id, 'consult', 'Consultation (follow-up, no charge)', 0);
  end if;

  for v_line in
    select dl.id, dl.drug_id, dl.qty_base, dl.unit_price, dl.amount,
           d.name as drug_name, d.strength, d.hsn,
           b.batch_no, b.expiry
    from dispense_lines dl
    join dispenses  dp on dp.id = dl.dispense_id
    join drugs      d  on d.id  = dl.drug_id
    join stock_batches b on b.id = dl.batch_id
    where dp.id = any (v_ids)
    order by d.name
  loop
    insert into bill_lines (bill_id, kind, description, drug_id, dispense_line_id,
                            batch_no, expiry, qty_base, unit_price, amount, hsn)
    values (v_bill.id, 'medicine',
            v_line.drug_name || ' ' || coalesce(v_line.strength, ''),
            v_line.drug_id, v_line.id, v_line.batch_no, v_line.expiry,
            v_line.qty_base, v_line.unit_price, v_line.amount, v_line.hsn);

    v_medicines := v_medicines + v_line.amount;
  end loop;

  -- Every dispense named here is now on this bill and cannot be on another.
  update dispenses set bill_id = v_bill.id
  where id = any (v_ids) and bill_id is null;

  if exists (select 1 from dispenses where id = any (v_ids) and bill_id <> v_bill.id) then
    raise exception 'one of those dispenses is already on another bill'
      using errcode = 'CL007';
  end if;

  v_subtotal := v_fee + v_medicines;

  if v_discount > v_subtotal then
    raise exception 'a discount of % is more than the bill of %',
      to_char(v_discount, 'FM999999990.00'), to_char(v_subtotal, 'FM999999990.00')
      using errcode = 'CL006';
  end if;

  v_total := v_subtotal - v_discount;

  if v_clinic.round_to_rupee then
    -- Down, never up. See note 3 at the top of this file.
    v_round := floor(v_total) - v_total;
    v_total := floor(v_total);
  end if;

  update bills
  set medicines_total = v_medicines,
      round_off       = v_round,
      total           = v_total
  where id = v_bill.id
  returning * into v_bill;

  perform app.write_audit(
    'raise_bill', 'bills', v_bill.id, null,
    jsonb_build_object('bill_no', v_bill.bill_no, 'consult_fee', v_fee,
                       'medicines_total', v_medicines, 'discount', v_discount,
                       'total', v_total, 'basis', v_basis)
  );

  return v_bill;
end
$function$;

-- app.receive_goods: Goods arriving already expired are refused, as of today.
CREATE OR REPLACE FUNCTION app.receive_goods(p_lines jsonb, p_supplier_id uuid DEFAULT NULL::uuid, p_invoice_no text DEFAULT NULL::text, p_invoice_date date DEFAULT NULL::date, p_awaiting_invoice boolean DEFAULT false, p_note text DEFAULT NULL::text)
 RETURNS goods_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id      uuid;
  v_grn           goods_receipts;
  v_line          jsonb;
  v_drug          drugs%rowtype;
  v_batch         stock_batches%rowtype;
  v_expiry        date;
  v_units_per_strip int;
  v_strips_per_box  int;
  v_basis         mrp_basis;
  v_units_in_pack int;
  v_qty_base      int;
  v_free_base     int;
  v_cost          numeric(12, 4);
  v_mrp           numeric(12, 2);
  v_total         numeric(12, 2) := 0;
  v_earliest_dispensed date;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a goods receipt needs at least one line' using errcode = 'CL006';
  end if;

  if not coalesce(p_awaiting_invoice, false) and p_invoice_no is null then
    raise exception 'a goods receipt needs an invoice number, or the awaiting-invoice flag'
      using errcode = 'CL006';
  end if;

  insert into goods_receipts
    (supplier_id, invoice_no, invoice_date, received_by, awaiting_invoice, note)
  values
    (p_supplier_id, p_invoice_no, p_invoice_date, v_staff_id,
     coalesce(p_awaiting_invoice, false), p_note)
  returning * into v_grn;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_drug from drugs where id = (v_line ->> 'drug_id')::uuid;
    if not found then
      raise exception 'unknown drug %', v_line ->> 'drug_id' using errcode = 'CL006';
    end if;

    -- The expiry is printed as a month. Stock is good through the end of it,
    -- so it is normalised once here and stored as the last usable date.
    v_expiry := app.month_end((v_line ->> 'expiry')::date);

    -- Catches a mistyped year at the door. A batch that is already expired
    -- cannot be received: either the date is wrong or the stock should not be
    -- on the shelf, and both need a human before anything is recorded.
    if v_expiry < app.clinic_today() then
      raise exception 'batch "%" of "%" expires % — that is in the past',
        v_line ->> 'batch_no', v_drug.name, to_char(v_expiry, 'Mon YYYY')
        using errcode = 'CL011';
    end if;

    -- Catches the other mistyped year. If stock of this drug has already gone
    -- out from a LATER-expiring batch under FEFO, then a batch arriving now
    -- with an earlier expiry means FEFO was wrong then or the date is wrong
    -- now. Either way it is not something to record silently.
    select min(b.expiry) into v_earliest_dispensed
    from stock_batches b
    where b.drug_id = v_drug.id
      and exists (
        select 1 from stock_movements m
        where m.batch_id = b.id and m.qty_base < 0
      );

    if v_earliest_dispensed is not null and v_expiry < v_earliest_dispensed then
      raise exception
        'batch "%" expires % — earlier than a batch already dispensed against (%). Check the year',
        v_line ->> 'batch_no', to_char(v_expiry, 'Mon YYYY'),
        to_char(v_earliest_dispensed, 'Mon YYYY')
        using errcode = 'CL012';
    end if;

    v_units_per_strip := coalesce((v_line ->> 'units_per_strip')::int,
                                  v_drug.default_units_per_strip, 1);
    v_strips_per_box  := coalesce((v_line ->> 'strips_per_box')::int,
                                  v_drug.default_strips_per_box, 1);
    v_basis           := coalesce((v_line ->> 'mrp_basis')::mrp_basis,
                                  v_drug.default_mrp_basis);
    v_mrp             := (v_line ->> 'mrp')::numeric;

    -- Packs in, base units stored. The one conversion, at the one boundary.
    v_units_in_pack := app.units_in_pack(
      v_units_per_strip, v_strips_per_box,
      coalesce(v_line ->> 'pack_basis', v_basis::text)
    );
    v_qty_base  := coalesce((v_line ->> 'qty_packs')::int, 0) * v_units_in_pack;
    v_free_base := coalesce((v_line ->> 'free_packs')::int, 0) * v_units_in_pack;

    if v_qty_base + v_free_base <= 0 then
      raise exception 'a goods receipt line has to bring something in'
        using errcode = 'CL006';
    end if;

    v_cost := (v_line ->> 'cost_per_base_unit')::numeric;
    if v_cost is null then
      raise exception 'a goods receipt line needs a cost — valuation depends on it (INVENTORY.md §4)'
        using errcode = 'CL006';
    end if;

    -- Free goods dilute the cost across everything that arrived, which is what
    -- weighted average means and what the accountant expects to see.
    if v_free_base > 0 then
      v_cost := round(v_cost * v_qty_base / (v_qty_base + v_free_base), 4);
    end if;

    select * into v_batch
    from stock_batches
    where drug_id = v_drug.id and batch_no = (v_line ->> 'batch_no')
    for update;

    if found then
      -- The same batch arriving again: quantities add, and the cost becomes the
      -- weighted average of what is now on the shelf.
      update stock_batches
      set qty_base_received  = qty_base_received + v_qty_base + v_free_base,
          qty_base_on_hand   = qty_base_on_hand + v_qty_base + v_free_base,
          cost_per_base_unit = round(
            (cost_per_base_unit * qty_base_on_hand + v_cost * (v_qty_base + v_free_base))
            / nullif(qty_base_on_hand + v_qty_base + v_free_base, 0), 4),
          mrp                = v_mrp,
          grn_id             = v_grn.id
      where id = v_batch.id
      returning * into v_batch;
    else
      insert into stock_batches
        (drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
         cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id, grn_id)
      values
        (v_drug.id, v_line ->> 'batch_no', v_expiry, v_units_per_strip, v_strips_per_box,
         v_mrp, v_basis, v_cost, v_qty_base + v_free_base, v_qty_base + v_free_base,
         p_supplier_id, v_grn.id)
      returning * into v_batch;
    end if;

    insert into grn_lines
      (grn_id, drug_id, batch_id, qty_base, free_qty_base, cost_per_base_unit, mrp)
    values
      (v_grn.id, v_drug.id, v_batch.id, v_qty_base, v_free_base, v_cost, v_mrp);

    -- The ledger row. Rule 3: this is the truth, and the cache above was
    -- updated in the same transaction.
    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, note)
    values
      (v_drug.id, v_batch.id, v_qty_base + v_free_base, 'receipt', 'goods_receipt',
       v_grn.id, v_staff_id, p_note);

    v_total := v_total + round(v_cost * (v_qty_base + v_free_base), 2);
  end loop;

  update goods_receipts set total = v_total where id = v_grn.id returning * into v_grn;

  perform app.write_audit(
    'receive_goods', 'goods_receipts', v_grn.id, null,
    jsonb_build_object('supplier_id', p_supplier_id, 'invoice_no', p_invoice_no,
                       'lines', jsonb_array_length(p_lines), 'total', v_total,
                       'awaiting_invoice', coalesce(p_awaiting_invoice, false))
  );

  return v_grn;
end
$function$;

-- app.return_to_supplier: Whether the supplier's return window has closed yet.
CREATE OR REPLACE FUNCTION app.return_to_supplier(p_lines jsonb, p_supplier_id uuid, p_note text DEFAULT NULL::text)
 RETURNS supplier_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id  uuid;
  v_supplier  suppliers%rowtype;
  v_return    supplier_returns;
  v_line      jsonb;
  v_batch     stock_batches%rowtype;
  v_drug_name text;
  v_qty       int;
  v_return_by date;
  v_amount    numeric(12, 2);
  v_total     numeric(12, 2) := 0;
  v_credit_id uuid;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a return needs at least one line' using errcode = 'CL006';
  end if;

  select * into v_supplier from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'unknown supplier %', p_supplier_id using errcode = 'CL006';
  end if;

  -- No window recorded is not "no limit" — it is not knowing, and shipping
  -- stock back on a guess is how a clinic ends up with neither the stock nor
  -- the credit.
  if v_supplier.return_window_days is null then
    raise exception
      'no return window is recorded for %, so nothing can be sent back until somebody asks them',
      v_supplier.name
      using errcode = 'CL016';
  end if;

  insert into supplier_returns (supplier_id, returned_by, note)
  values (p_supplier_id, v_staff_id, p_note)
  returning * into v_return;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_batch from stock_batches
    where id = (v_line ->> 'batch_id')::uuid
    for update;

    if not found then
      raise exception 'unknown batch %', v_line ->> 'batch_id' using errcode = 'CL006';
    end if;

    select name into v_drug_name from drugs where id = v_batch.drug_id;

    if v_batch.supplier_id is not null and v_batch.supplier_id <> p_supplier_id then
      raise exception 'batch "%" of "%" did not come from % — it cannot be returned to them',
        v_batch.batch_no, v_drug_name, v_supplier.name
        using errcode = 'CL006';
    end if;

    v_qty := coalesce((v_line ->> 'qty_base')::int, v_batch.qty_base_on_hand);
    if v_qty <= 0 then
      raise exception 'a return line has to send something back' using errcode = 'CL006';
    end if;

    if v_qty > v_batch.qty_base_on_hand then
      raise exception
        'only % of "%" batch "%" is on the shelf — % cannot be returned',
        v_batch.qty_base_on_hand, v_drug_name, v_batch.batch_no, v_qty
        using errcode = 'CL001';
    end if;

    -- The refusal this whole section exists for.
    v_return_by := v_batch.expiry - v_supplier.return_window_days;
    if app.clinic_today() > v_return_by then
      raise exception
        '%''s return window for batch "%" of "%" closed on % — it expires % and can only be dispensed or written off now',
        v_supplier.name, v_batch.batch_no, v_drug_name,
        to_char(v_return_by, 'DD Mon YYYY'), to_char(v_batch.expiry, 'Mon YYYY')
        using errcode = 'CL016';
    end if;

    v_amount := round(v_qty * v_batch.cost_per_base_unit, 2);

    insert into supplier_return_lines
      (return_id, batch_id, drug_id, qty_base, cost_per_base_unit, amount, return_by)
    values
      (v_return.id, v_batch.id, v_batch.drug_id, v_qty,
       v_batch.cost_per_base_unit, v_amount, v_return_by);

    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, reason)
    values
      (v_batch.drug_id, v_batch.id, -v_qty, 'return_out', 'supplier_return',
       v_return.id, v_staff_id, 'returned to ' || v_supplier.name);

    update stock_batches
    set qty_base_on_hand = qty_base_on_hand - v_qty
    where id = v_batch.id;

    v_total := v_total + v_amount;
  end loop;

  update supplier_returns set total_at_cost = v_total
  where id = v_return.id
  returning * into v_return;

  -- The credit, opened here rather than by a person who remembers to.
  insert into supplier_credits (supplier_id, return_id, amount_expected)
  values (p_supplier_id, v_return.id, v_total)
  returning id into v_credit_id;

  perform app.write_audit(
    'return_to_supplier', 'supplier_returns', v_return.id, null,
    jsonb_build_object('supplier_id', p_supplier_id,
                       'lines', jsonb_array_length(p_lines),
                       'total_at_cost', v_total,
                       'credit_id', v_credit_id)
  );

  return v_return;
end
$function$;

-- app.send_purchase_order: The financial year in the PO number. Same reasoning as raise_bill.
CREATE OR REPLACE FUNCTION app.send_purchase_order(p_po_id uuid)
 RETURNS TABLE(order_id uuid, order_no text, send_to_number text, message_body text, message_id uuid, send_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id  uuid;
  v_po        purchase_orders;
  v_supplier  suppliers%rowtype;
  v_clinic    clinic%rowtype;
  v_line      record;
  v_body      text;
  v_qty       text;
  v_n         int := 0;
  v_fy        text;
  v_no        int;
  v_po_no     text;
  v_message   uuid;
  v_sends     int;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- Rule 4, and §10.4's whole argument: an order is a financial commitment to a
  -- third party. One wrong reorder level and the clinic has paid for ten times
  -- the stock, so the person who owns that risk is the one who taps send.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'a purchase order is approved and sent by the doctor'
      using errcode = 'CL005';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  -- Re-sending a sent order is legitimate — suppliers lose messages. Anything
  -- past that has moved on and should not be re-ordered by accident.
  if v_po.status not in ('draft', 'sent') then
    raise exception 'purchase order % is %, and is not waiting to be sent',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  if not exists (select 1 from po_lines l where l.po_id = p_po_id) then
    raise exception 'that purchase order has no lines' using errcode = 'CL006';
  end if;

  select * into v_supplier from suppliers where id = v_po.supplier_id;

  if v_supplier.whatsapp_number is null or length(trim(v_supplier.whatsapp_number)) = 0 then
    raise exception 'no WhatsApp number is recorded for % — add one before ordering',
      v_supplier.name
      using errcode = 'CL022';
  end if;

  select * into v_clinic from clinic limit 1;

  -- The number, assigned now and kept for good.
  v_po_no := v_po.po_no;
  if v_po_no is null then
    v_fy := app.financial_year(app.clinic_today());
    insert into po_counters (financial_year) values (v_fy) on conflict do nothing;
    update po_counters set last_no = last_no + 1
    where financial_year = v_fy
    returning last_no into v_no;
    v_po_no := 'PO ' || v_fy || '/' || lpad(v_no::text, 4, '0');
  end if;

  v_body := v_clinic.name || E'\n' || v_po_no || E'\n\n';

  for v_line in
    select l.qty_base, d.name, d.strength, d.base_unit,
           d.default_units_per_strip as ups, d.default_strips_per_box as spb
    from po_lines l
    join drugs d on d.id = l.drug_id
    where l.po_id = p_po_id
    order by d.name
  loop
    v_n := v_n + 1;

    -- Said in the units the supplier sells in, with the base units in brackets
    -- so there is no ambiguity about what was meant. The bracketed number is
    -- the authoritative one — everything in this database is base units.
    if v_line.ups is not null and v_line.ups > 0
       and v_line.spb is not null and v_line.spb > 0
       and v_line.qty_base % (v_line.ups * v_line.spb) = 0 then
      v_qty := (v_line.qty_base / (v_line.ups * v_line.spb))::text || ' box'
               || case when v_line.qty_base / (v_line.ups * v_line.spb) = 1 then '' else 'es' end;
    elsif v_line.ups is not null and v_line.ups > 0 and v_line.qty_base % v_line.ups = 0 then
      v_qty := (v_line.qty_base / v_line.ups)::text || ' strip'
               || case when v_line.qty_base / v_line.ups = 1 then '' else 's' end;
    else
      v_qty := v_line.qty_base::text || ' ' || v_line.base_unit::text;
    end if;

    v_body := v_body || v_n::text || '. ' || v_line.name || ' ' ||
              coalesce(v_line.strength, '') || ' — ' || v_qty ||
              ' (' || v_line.qty_base::text || ')' || E'\n';
  end loop;

  v_body := v_body || E'\nPlease confirm availability and expected delivery.';

  v_sends := v_po.sends + 1;

  -- The row before the send (rule 5).
  insert into wa_messages (to_number, channel, body, status, ref_type, ref_id,
                           idempotency_key, staff_id)
  values (v_supplier.whatsapp_number, 'deeplink', v_body, 'handed_off',
          'purchase_order', p_po_id,
          'po:' || p_po_id::text || ':send:' || v_sends::text, v_staff_id)
  returning id into v_message;

  update purchase_orders
  set status  = 'sent',
      po_no   = v_po_no,
      sends   = v_sends,
      -- The FIRST send only. supplier_lead_time measures sent → received, and a
      -- chase message three days later must not make the supplier look faster
      -- than they were.
      sent_at = coalesce(v_po.sent_at, now())
  where id = p_po_id;

  perform app.write_audit('send_purchase_order', 'purchase_orders', p_po_id,
    jsonb_build_object('status', v_po.status),
    jsonb_build_object('status', 'sent', 'po_no', v_po_no, 'sends', v_sends,
                       'message_id', v_message));

  return query select p_po_id, v_po_no, v_supplier.whatsapp_number, v_body,
                      v_message, v_sends;
end
$function$;

-- app.write_off_expired: Whether the batch is in fact expired.
CREATE OR REPLACE FUNCTION app.write_off_expired(p_lines jsonb, p_reason text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_staff_id  uuid;
  v_line      jsonb;
  v_batch     stock_batches%rowtype;
  v_drug_name text;
  v_qty       int;
  v_total     numeric(12, 2) := 0;
  v_batches   int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a write-off needs at least one line' using errcode = 'CL006';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_batch from stock_batches
    where id = (v_line ->> 'batch_id')::uuid
    for update;

    if not found then
      raise exception 'unknown batch %', v_line ->> 'batch_id' using errcode = 'CL006';
    end if;

    select name into v_drug_name from drugs where id = v_batch.drug_id;

    -- This transition writes off expiry and nothing else. Stock that is still
    -- good has two better outcomes — sell it, or send it back while the window
    -- is open — and destroying it because a screen offered the button is the
    -- expensive mistake this refusal exists to prevent. Damage and breakage are
    -- a different reason code and a different day's work.
    if v_batch.expiry >= app.clinic_today() then
      raise exception
        'batch "%" of "%" expires % and has not expired yet — dispense it, or send it back while the supplier''s window is open',
        v_batch.batch_no, v_drug_name, to_char(v_batch.expiry, 'Mon YYYY')
        using errcode = 'CL017';
    end if;

    v_qty := coalesce((v_line ->> 'qty_base')::int, v_batch.qty_base_on_hand);

    if v_qty <= 0 then
      raise exception 'a write-off line has to write something off' using errcode = 'CL006';
    end if;

    if v_qty > v_batch.qty_base_on_hand then
      raise exception
        'only % of "%" batch "%" is on the shelf — % cannot be written off',
        v_batch.qty_base_on_hand, v_drug_name, v_batch.batch_no, v_qty
        using errcode = 'CL001';
    end if;

    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, reason)
    values
      (v_batch.drug_id, v_batch.id, -v_qty, 'writeoff_expiry', 'stock_batch',
       v_batch.id, v_staff_id, coalesce(p_reason, 'expired ' || to_char(v_batch.expiry, 'Mon YYYY')));

    update stock_batches
    set qty_base_on_hand = qty_base_on_hand - v_qty
    where id = v_batch.id;

    -- One audit row per batch rather than one per call: the question anybody
    -- asks later is "what happened to this batch", and audit_log is indexed to
    -- answer exactly that.
    perform app.write_audit(
      'write_off_expired', 'stock_batches', v_batch.id, null,
      jsonb_build_object('qty_base', v_qty,
                         'value_at_cost', round(v_qty * v_batch.cost_per_base_unit, 2),
                         'expiry', v_batch.expiry,
                         'reason', p_reason)
    );

    v_total   := v_total + round(v_qty * v_batch.cost_per_base_unit, 2);
    v_batches := v_batches + 1;
  end loop;

  return v_total;
end
$function$;

-- ---------------------------------------------------------------------------
-- The grants and the comment the replaced objects already carried.
--
-- `create or replace` keeps both on an object that already exists, so these are
-- restatements rather than changes. Written out because a migration replayed
-- onto a database rebuilt from an earlier point should not have to assume it.
-- ---------------------------------------------------------------------------
grant select on queue_today, available_stock, expiring_soon, expired_stock,
                open_supplier_credits, stock_valuation to authenticated;

comment on view queue_today is
  'The default screen on both tablets (TABLET.md 7). One row per appointment: the lateral takes the earliest encounter, so a duplicate cannot double a token or inflate `ahead`. Filtered on the CLINIC''s day, not the server''s.';
