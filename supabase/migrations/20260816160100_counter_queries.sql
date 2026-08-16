-- M2 — the doctor ↔ counter live link. His headline feature (PLAN.md §11).
--
--   consult room                          counter
--   ────────────                          ───────
--   doctor signs Rx  ──── realtime ────►  appears at top of queue, < 1s
--                                         stock checked live per line
--                                         partial? substitution? ──┐
--        ◄──────────── realtime ───────────────────────────────────┘
--   "Counter: Amoxicillin 500 out of stock. Substitute?"
--   doctor approves / edits / rejects ──► counter continues
--
-- §11.1: the whole loop is two tables and four transitions. The tables are
-- `prescriptions` (M1) and `counter_queries` (here); the transitions are
-- sign_prescription (M1) plus raise / answer / withdraw below.
--
-- The rule that shapes all of it is INVENTORY.md §7: the counter PROPOSES and
-- the doctor DECIDES. Never automatic, never inferred, and both sides recorded.

create type counter_query_kind as enum ('out_of_stock', 'substitution', 'clarification');
create type counter_query_status as enum ('open', 'answered', 'withdrawn');
create type counter_query_decision as enum ('approved', 'rejected', 'amended');

create table counter_queries (
  id                uuid primary key default gen_random_uuid(),
  prescription_id   uuid not null references prescriptions (id),
  -- Which line, identified by drug rather than by index into items[]. An index
  -- is a position in a JSON array; a drug is the thing the pharmacist is
  -- holding.
  drug_id           uuid not null references drugs (id),
  kind              counter_query_kind not null,
  -- What the counter proposes. Same salt, same strength, same form — enforced
  -- in the transition, because "similar" is a clinical judgement and this is a
  -- lookup (INVENTORY.md §7).
  proposed_drug_id  uuid references drugs (id),
  note              text,
  raised_by         uuid not null references staff (id),
  raised_at         timestamptz not null default now(),

  status            counter_query_status not null default 'open',
  decision          counter_query_decision,
  approved_drug_id  uuid references drugs (id),
  answer_note       text,
  answered_by       uuid references staff (id),
  answered_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint answered_queries_carry_an_answer check (
    (status <> 'answered')
    or (decision is not null and answered_by is not null and answered_at is not null)
  ),
  -- An amendment has to name what the doctor actually wants, or the counter is
  -- left holding an approval for nothing.
  constraint amendments_name_a_drug check (
    decision is distinct from 'amended' or approved_drug_id is not null
  )
);

-- One open question per line at a time. Two "is this out of stock?" queries on
-- the same drug is the counter asking twice because the first one scrolled off.
create unique index counter_queries_one_open_per_line
  on counter_queries (prescription_id, drug_id)
  where status = 'open';

create index counter_queries_open_idx on counter_queries (raised_at desc) where status = 'open';
create index counter_queries_prescription_idx on counter_queries (prescription_id);

create trigger counter_queries_touch
  before update on counter_queries
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The pharmacy queue. TABLET.md §7: newest prescription at the top, arriving
-- live, colour-coded fully in stock / partial / out.
--
-- The colour is computed here rather than in the screen so that the counter and
-- the doctor cannot disagree about what "partial" means.
-- ---------------------------------------------------------------------------
create view pharmacy_queue as
with lines as (
  select
    p.id                            as prescription_id,
    (i.item ->> 'drug_id')::uuid    as drug_id,
    (i.item ->> 'qty_base')::int    as qty_base
  from prescriptions p
  cross join lateral jsonb_array_elements(p.items) as i(item)
  where p.signed_at is not null
    and p.status in ('pending', 'partial')
),
on_hand as (
  select drug_id, sum(qty_base_on_hand)::int as available
  from available_stock
  group by drug_id
),
coverage as (
  select
    l.prescription_id,
    count(*)::int                                                          as lines,
    count(*) filter (where coalesce(o.available, 0) >= l.qty_base)::int    as lines_in_stock,
    count(*) filter (where coalesce(o.available, 0) = 0)::int              as lines_out
  from lines l
  left join on_hand o on o.drug_id = l.drug_id
  group by l.prescription_id
)
select
  p.id            as prescription_id,
  p.patient_id,
  pt.name         as patient_name,
  pt.allergies,
  a.token_no,
  p.signed_at,
  p.status,
  s.name          as doctor_name,
  c.lines,
  c.lines_in_stock,
  c.lines_out,
  -- One word for the row's colour. "out" wins over "partial": a line that
  -- cannot be filled at all is the one the counter has to act on.
  case
    when c.lines_out > 0                then 'out'
    when c.lines_in_stock < c.lines     then 'partial'
    else 'full'
  end             as stock_state,
  (select count(*)::int from counter_queries q
   where q.prescription_id = p.id and q.status = 'open') as open_queries
from prescriptions p
join coverage c on c.prescription_id = p.id
join patients pt on pt.id = p.patient_id
join staff s on s.id = p.doctor_id
left join encounters e on e.id = p.encounter_id
left join appointments a on a.id = e.appointment_id;

comment on view pharmacy_queue is
  'Signed, undispensed prescriptions with their stock colour (TABLET.md §7).';

-- What the doctor needs to see without leaving the consult screen.
create view open_counter_queries as
select
  q.id,
  q.prescription_id,
  q.kind,
  q.note,
  q.raised_at,
  q.drug_id,
  d.name              as drug_name,
  d.strength          as drug_strength,
  q.proposed_drug_id,
  pd.name             as proposed_name,
  pd.strength         as proposed_strength,
  pd.salt_composition as proposed_salt,
  s.name              as raised_by_name,
  p.doctor_id,
  p.patient_id,
  pt.name             as patient_name
from counter_queries q
join prescriptions p on p.id = q.prescription_id
join patients pt on pt.id = p.patient_id
join drugs d on d.id = q.drug_id
join staff s on s.id = q.raised_by
left join drugs pd on pd.id = q.proposed_drug_id
where q.status = 'open';

grant select on counter_queries, pharmacy_queue, open_counter_queries to authenticated;

alter table counter_queries enable row level security;

create policy counter_queries_read on counter_queries
  for select to authenticated
  using (app.current_staff_id() is not null);

-- Transition-owned: raised, answered and withdrawn through the functions below.
revoke insert, update, delete on counter_queries from authenticated, anon;

-- ---------------------------------------------------------------------------
-- app.raise_counter_query — the counter asks.
-- ---------------------------------------------------------------------------
create or replace function app.raise_counter_query(
  p_prescription_id  uuid,
  p_drug_id          uuid,
  p_kind             counter_query_kind,
  p_proposed_drug_id uuid default null,
  p_note             text default null
) returns counter_queries
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_rx        prescriptions;
  v_original  drugs;
  v_proposed  drugs;
  v_row       counter_queries;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  select * into v_rx from prescriptions where id = p_prescription_id;
  if not found then
    raise exception 'unknown prescription %', p_prescription_id using errcode = 'PT006';
  end if;

  -- A draft is not a prescription. There is nothing to query until it is signed.
  if v_rx.signed_at is null then
    raise exception 'that prescription has not been signed yet' using errcode = 'PT006';
  end if;

  if v_rx.status in ('dispensed', 'cancelled') then
    raise exception 'that prescription is already %', v_rx.status using errcode = 'PT006';
  end if;

  -- The query has to be about a line that is actually on the prescription.
  if not exists (
    select 1 from jsonb_array_elements(v_rx.items) as i(item)
    where (i.item ->> 'drug_id')::uuid = p_drug_id
  ) then
    raise exception 'that drug is not on this prescription' using errcode = 'PT006';
  end if;

  select * into v_original from drugs where id = p_drug_id;

  if p_proposed_drug_id is not null then
    select * into v_proposed from drugs where id = p_proposed_drug_id;
    if not found then
      raise exception 'unknown substitute %', p_proposed_drug_id using errcode = 'PT006';
    end if;

    -- INVENTORY.md §7: same salt + same strength + same dosage form, or
    -- nothing. Matching identical salts is a lookup; anything looser is a
    -- therapeutic judgement, and rule 8 puts that with the doctor, not here.
    if v_proposed.salt_composition is distinct from v_original.salt_composition
       or v_proposed.strength is distinct from v_original.strength
       or v_proposed.form is distinct from v_original.form then
      raise exception
        '"%" is not an equivalent of "%" — substitution needs the same salt, strength and form',
        v_proposed.name, v_original.name
        using errcode = 'PT009';
    end if;

    if v_proposed.id = v_original.id then
      raise exception 'that is the same drug' using errcode = 'PT006';
    end if;
  end if;

  if p_kind = 'substitution' and p_proposed_drug_id is null then
    raise exception 'a substitution query has to name the proposed drug'
      using errcode = 'PT006';
  end if;

  insert into counter_queries
    (prescription_id, drug_id, kind, proposed_drug_id, note, raised_by)
  values
    (p_prescription_id, p_drug_id, p_kind, p_proposed_drug_id, p_note, v_staff_id)
  returning * into v_row;

  perform app.write_audit(
    'raise_counter_query', 'counter_queries', v_row.id, null,
    jsonb_build_object('prescription_id', p_prescription_id, 'drug_id', p_drug_id,
                       'kind', p_kind, 'proposed_drug_id', p_proposed_drug_id)
  );

  return v_row;
exception
  when unique_violation then
    raise exception 'there is already an open question about that line'
      using errcode = 'PT010';
end
$$;

revoke all on function app.raise_counter_query(uuid, uuid, counter_query_kind, uuid, text) from public;
grant execute on function app.raise_counter_query(uuid, uuid, counter_query_kind, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.answer_counter_query — the doctor decides.
--
-- Only the prescribing doctor. Substitution is never automatic and never
-- inferred: what the counter sent was a proposal, and this is the approval that
-- INVENTORY.md §7 requires to be recorded with the person who gave it.
-- ---------------------------------------------------------------------------
create or replace function app.answer_counter_query(
  p_query_id         uuid,
  p_decision         counter_query_decision,
  p_approved_drug_id uuid default null,
  p_note             text default null
) returns counter_queries
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_query    counter_queries;
  v_rx       prescriptions;
  v_original drugs;
  v_approved drugs;
  v_row      counter_queries;
  v_approved_id uuid;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  select * into v_query from counter_queries where id = p_query_id for update;
  if not found then
    raise exception 'unknown query %', p_query_id using errcode = 'PT006';
  end if;

  if v_query.status <> 'open' then
    raise exception 'that question was already %', v_query.status using errcode = 'PT008';
  end if;

  select * into v_rx from prescriptions where id = v_query.prescription_id;

  if v_rx.doctor_id <> v_staff_id then
    raise exception 'only the prescribing doctor can answer this'
      using errcode = 'PT005';
  end if;

  -- Approving a substitution means approving the drug the counter proposed;
  -- amending means naming a different one. Either way a drug is named, and it
  -- still has to be a genuine equivalent.
  v_approved_id := case
    when p_decision = 'approved' then coalesce(p_approved_drug_id, v_query.proposed_drug_id)
    when p_decision = 'amended'  then p_approved_drug_id
    else null
  end;

  if p_decision = 'approved' and v_query.kind = 'substitution' and v_approved_id is null then
    raise exception 'approving a substitution needs a drug' using errcode = 'PT006';
  end if;

  -- Caught here rather than by the check constraint, so the counter gets a
  -- sentence instead of a constraint name.
  if p_decision = 'amended' and v_approved_id is null then
    raise exception 'an amendment has to name the drug to dispense instead'
      using errcode = 'PT006';
  end if;

  if v_approved_id is not null then
    select * into v_original from drugs where id = v_query.drug_id;
    select * into v_approved from drugs where id = v_approved_id;

    if not found then
      raise exception 'unknown drug %', v_approved_id using errcode = 'PT006';
    end if;

    if v_approved.salt_composition is distinct from v_original.salt_composition
       or v_approved.strength is distinct from v_original.strength
       or v_approved.form is distinct from v_original.form then
      raise exception
        '"%" is not an equivalent of "%" — substitution needs the same salt, strength and form',
        v_approved.name, v_original.name
        using errcode = 'PT009';
    end if;
  end if;

  update counter_queries
  set status           = 'answered',
      decision         = p_decision,
      approved_drug_id = v_approved_id,
      answer_note      = p_note,
      answered_by      = v_staff_id,
      answered_at      = now()
  where id = p_query_id
  returning * into v_row;

  perform app.write_audit(
    'answer_counter_query', 'counter_queries', p_query_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'answered', 'decision', p_decision,
                       'approved_drug_id', v_approved_id)
  );

  return v_row;
end
$$;

revoke all on function app.answer_counter_query(uuid, counter_query_decision, uuid, text) from public;
grant execute on function app.answer_counter_query(uuid, counter_query_decision, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.withdraw_counter_query — the counter found the box after all.
--
-- Withdrawing rather than deleting: the doctor may already have read it, and a
-- question that vanishes is worse than one marked as no longer needed.
-- ---------------------------------------------------------------------------
create or replace function app.withdraw_counter_query(p_query_id uuid, p_note text default null)
returns counter_queries
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_query    counter_queries;
  v_row      counter_queries;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  select * into v_query from counter_queries where id = p_query_id for update;
  if not found then
    raise exception 'unknown query %', p_query_id using errcode = 'PT006';
  end if;

  if v_query.status <> 'open' then
    raise exception 'that question was already %', v_query.status using errcode = 'PT008';
  end if;

  if v_query.raised_by <> v_staff_id then
    raise exception 'only the person who raised it can withdraw it'
      using errcode = 'PT005';
  end if;

  update counter_queries
  set status = 'withdrawn', answer_note = p_note
  where id = p_query_id
  returning * into v_row;

  perform app.write_audit(
    'withdraw_counter_query', 'counter_queries', p_query_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'withdrawn')
  );

  return v_row;
end
$$;

revoke all on function app.withdraw_counter_query(uuid, text) from public;
grant execute on function app.withdraw_counter_query(uuid, text) to authenticated, service_role;

comment on table counter_queries is
  'The counter proposes, the doctor decides (INVENTORY.md §7). Never automatic.';
