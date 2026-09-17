-- ═══════════════════════════════════════════════════════════════════════════
-- SLICE 2 ACCEPTANCE CORRECTION
--
-- Slice 2 was returned unaccepted. The reviewer reproduced, against the guarded
-- loopback database, failures that the slice's own green suite did not see. The
-- three this migration answers are the ones that need the DATABASE rather than
-- more code:
--
--   1. A retry mechanism made of mutable state. `reschedule_appointment` and
--      `check_in_appointment` decided "have I already done this?" by reading
--      the booking's CURRENT status and time. That is not idempotency, it is a
--      guess that expires: a lost reply to "move to 11:00", arriving after
--      somebody moved the appointment to 12:00, moved it BACK to 11:00 — and a
--      lost check-in arriving after a reschedule minted a second token and put
--      the booking back into `checked_in`.
--
--      The programme's own rule is explicit: "Every client-retryable
--      consequential command accepts a scoped idempotency key and the server
--      stores enough request identity and result identity to return the
--      original outcome safely." Stored. Not derived.
--
--   2. An invariant the schema documented and did not enforce.
--      `appointment_bookings` required a reason for `overbooked` and required
--      nothing for `outside_availability`, although both are the same
--      reviewable override and the comment beside them said so.
--
--   3. A cross-patient reference the code checked and the schema did not.
--      `consultation_attempt_resolutions` could record that one patient's visit
--      was the same attendance as another patient's consultation. The command
--      refused it; nothing underneath did.
--
-- Forward-only. `20260920000000` is not edited. Re-runnable: every statement is
-- guarded, and the two normalisations below are idempotent by construction.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ── 1. What a command already did, stored rather than inferred ─────────────
--
-- One table for every appointment command, because the alternative is what
-- Slice 2 shipped: each command inventing its own answer to the same question
-- out of whatever state happened to be nearby, and each one wrong in its own
-- way.
--
-- `request_fingerprint` is what makes the key safe rather than merely unique:
-- a key alone answers "have I seen this?" and hands back whatever it finds,
-- which is how the counter once answered a second invoice's payment with the
-- first invoice's receipt. Same key and same material request is a retry. Same
-- key and a materially different request is a client fault and is refused out
-- loud.
--
-- `result` is the ORIGINAL outcome — the booking id, the queue token, the
-- numbers a screen printed. A retry gets those back rather than a fresh set,
-- because a second token for one arrival is two slips of paper that cannot be
-- told apart afterwards.
--
-- ── WHY IT IS NOT ENOUGH TO REPLAY, AND WHAT `superseded` IS FOR ───────────
--
-- A stale retry must not mutate anything. It must also not lie. A check-in
-- whose reply was lost, retried after the appointment was rescheduled and its
-- arrival cancelled, is entitled to hear what it originally did — and has to
-- be told that it no longer stands, or the tablet will print JMC-0001 for a
-- patient who is not in the queue. The command computes that when it replays;
-- this table holds what is needed to compute it.
create table if not exists jmc.appointment_command_receipts (
  id text primary key,
  idempotency_key text not null,
  command text not null,
  request_fingerprint text not null,
  -- The outcome, exactly as the caller first received it.
  result jsonb not null,
  -- What the command acted on, so a replay can say whether it still stands.
  booking_id text references jmc.appointment_bookings(id),
  arrival_id text references jmc.appointments(id),
  actor_id text not null references jmc.staff(id),
  created_at timestamptz not null default now()
);

-- The serialization point. Two tablets sending one key race here and exactly
-- one wins; the loser rolls back everything it wrote and is handed the
-- winner's result.
create unique index if not exists appointment_command_receipts_key
  on jmc.appointment_command_receipts (idempotency_key);

create index if not exists appointment_command_receipts_booking
  on jmc.appointment_command_receipts (booking_id) where booking_id is not null;
create index if not exists appointment_command_receipts_arrival
  on jmc.appointment_command_receipts (arrival_id) where arrival_id is not null;
create index if not exists appointment_command_receipts_actor
  on jmc.appointment_command_receipts (actor_id);

-- A receipt is what happened. Correcting it would be rewriting the answer a
-- tablet was already given.
--
-- Its own function rather than `reject_signed_line_change()`, which is what the
-- first version borrowed: an UPDATE here then raised "A signed prescription
-- line cannot be changed", which is a confident sentence about the wrong table
-- and is exactly the kind of thing somebody debugs for an hour.
create or replace function jmc.reject_receipt_change()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  raise exception 'A command receipt records what already happened and cannot be changed.';
end;
$$;

drop trigger if exists appointment_command_receipts_immutable
  on jmc.appointment_command_receipts;
create trigger appointment_command_receipts_immutable
before update or delete on jmc.appointment_command_receipts
for each row execute function jmc.reject_receipt_change();

comment on table jmc.appointment_command_receipts is
  'One row per completed appointment command, written in the same transaction as its effect. A retry under the same key replays this instead of acting again.';


-- ── 2. What a reschedule actually changed ──────────────────────────────────
--
-- `appointment_events` recorded the time before and after and nothing else, so
-- a reschedule that changed the appointment TYPE — and therefore its duration —
-- left a history that said the time had moved and stayed silent about the rest.
--
-- The override belongs here too. Owner item 67 permits an override "only
-- through an explicit action that records actor, time, and a required reason",
-- and an override applied during a reschedule was being validated and then
-- thrown away: the flags on the booking kept whatever the ORIGINAL booking had
-- decided, so an appointment moved out of a conflict into a clear slot went on
-- claiming it was overbooked, and one moved into a conflict did not.
alter table jmc.appointment_events
  add column if not exists appointment_type_before text references jmc.appointment_types(id),
  add column if not exists appointment_type_after text references jmc.appointment_types(id),
  add column if not exists duration_before integer,
  add column if not exists duration_after integer,
  add column if not exists overbooked boolean not null default false,
  add column if not exists outside_availability boolean not null default false,
  add column if not exists override_reason text not null default '';

create index if not exists appointment_events_type_before_idx
  on jmc.appointment_events (appointment_type_before) where appointment_type_before is not null;
create index if not exists appointment_events_type_after_idx
  on jmc.appointment_events (appointment_type_after) where appointment_type_after is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'appointment_events_override_is_explained'
       and conrelid = 'jmc.appointment_events'::regclass
  ) then
    alter table jmc.appointment_events
      add constraint appointment_events_override_is_explained
      check (
        case when overbooked or outside_availability
             then length(trim(override_reason)) > 0
             else override_reason = '' end
      );
  end if;
end $$;

comment on column jmc.appointment_events.override_reason is
  'Why a conflict or the published hours were overridden by THIS transition. Required when either flag is set on the event, and empty when neither is.';


-- ── 3. One override, one rule ──────────────────────────────────────────────
--
-- The constraint `20260920000000` added required a reason for `overbooked` and
-- said nothing about `outside_availability`, although the column comment beside
-- it described the reason as covering both. So a booking placed outside the
-- doctor's published hours could carry no explanation at all, and owner item
-- 67's "required reason" was enforced for one half of the override it governs.
--
-- The replacement is symmetric in both directions: either flag requires a
-- sentence, and NEITHER flag requires the absence of one. The second half
-- matters more than it looks — without it a reschedule that moves an
-- appointment into a clear slot can clear the flags and leave the old reason
-- standing, which reads on a screen as an override that is not there.
--
-- The normalisation below only touches rows whose flags are both false, which
-- by the new rule have nothing to say. It rewrites no decision.
update jmc.appointment_bookings
   set overbooked_reason = ''
 where not overbooked and not outside_availability and overbooked_reason <> '';

-- And the half a normalisation may NOT fix: a booking placed outside the
-- published hours with no explanation at all, which the old asymmetric
-- constraint permitted. Inventing a reason for it would be inventing evidence
-- about a decision somebody made, so the migration stops and says which rows.
--
-- `20260920000000` did this for duplicate queue tokens and the reasoning is
-- the same: a constraint violation names an index, and the operator needs to
-- know which bookings to look at. The acceptance review pointed out that the
-- reasoning had not been carried over to this file.
do $$
declare unexplained text;
begin
  select string_agg(id, ', ' order by id)
    into unexplained
    from jmc.appointment_bookings
   where (overbooked or outside_availability) and length(trim(overbooked_reason)) = 0;

  if unexplained is not null then
    raise exception
      'These bookings were placed over a conflict or outside the published hours with no reason '
      'recorded, which owner policy item 67 requires: %. Record why each one was placed, or cancel '
      'them, before applying this migration. It will not invent a reason for a decision somebody '
      'made.', unexplained;
  end if;
end $$;

do $$
declare weaker text;
begin
  /*
   * The constraint being replaced was created WITHOUT a name, so Postgres
   * called it `appointment_bookings_check` — and dropping it by the name the
   * comment above it implied would have been a silent no-op, leaving the
   * weaker rule in place beside the stronger one. It is found by what it SAYS
   * instead: a check on this table that mentions `overbooked` and is not the
   * one being added.
   *
   * Caught by the migration rehearsal, which set `overbooked = true` with no
   * reason and was refused by the old constraint rather than the new one.
   */
  for weaker in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'jmc.appointment_bookings'::regclass
       and c.contype = 'c'
       and c.conname <> 'appointment_bookings_override_is_explained'
       -- The one being replaced, by what it says: a bare implication on
       -- `overbooked` alone. Matching `%overbooked%` would also swallow a
       -- future named constraint about the same columns, which is a quiet way
       -- to lose somebody else's invariant.
       and pg_get_constraintdef(c.oid) like '%overbooked = false%'
       and pg_get_constraintdef(c.oid) not like '%outside_availability%'
  loop
    execute format('alter table jmc.appointment_bookings drop constraint %I', weaker);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'appointment_bookings_override_is_explained'
       and conrelid = 'jmc.appointment_bookings'::regclass
  ) then
    alter table jmc.appointment_bookings
      add constraint appointment_bookings_override_is_explained
      check (
        case when overbooked or outside_availability
             then length(trim(overbooked_reason)) > 0
             else overbooked_reason = '' end
      );
  end if;
end $$;


-- ── 4. A visit belongs to one patient, and the schema now says so ──────────
--
-- `consultation_attempt_resolutions` carries a patient and up to three
-- references that must be that patient's: the encounter the attempt signed,
-- the visit it was opened against, and the visit being decided about. The
-- command checked the first and, until this correction, not the other two — so
-- a doctor could record that one patient's queue row was the same attendance
-- as another patient's consultation, and the row would be accepted.
--
-- Checking it in the command is necessary and is not sufficient. The reviewer's
-- instruction is explicit about preferring an invariant the database holds, and
-- a composite foreign key is exactly that: `(visit, patient)` can only point at
-- a row of `appointments` that has BOTH, so a cross-patient reference cannot be
-- stored however it arrives.
--
-- The unique indexes below are what make those foreign keys possible. They are
-- redundant with the primary keys as constraints and cost a little space; that
-- is the price of an invariant that does not depend on remembering to check.
create unique index if not exists appointments_id_patient
  on jmc.appointments (id, patient_id);
create unique index if not exists encounters_id_patient
  on jmc.encounters (id, patient_id);

-- Named before it is refused, for the same reason as the tokens above: a
-- cross-patient row is exactly what the code this corrects could create, and
-- 23503 tells an operator the name of a constraint rather than which
-- reconciliation to go and look at.
do $$
declare crossed text;
begin
  select string_agg(r.id, ', ' order by r.id)
    into crossed
    from jmc.consultation_attempt_resolutions r
    left join jmc.appointments o on o.id = r.opened_visit_id
    left join jmc.appointments v on v.id = r.subject_visit_id
    left join jmc.encounters e on e.id = r.encounter_id
   where (r.opened_visit_id is not null and o.patient_id is distinct from r.patient_id)
      or (r.subject_visit_id is not null and v.patient_id is distinct from r.patient_id)
      or (r.encounter_id is not null and e.patient_id is distinct from r.patient_id);

  if crossed is not null then
    raise exception
      'These consultation-attempt resolutions name a visit or an encounter belonging to a different '
      'patient: %. They were recorded by code that did not check, and a reconciliation about the '
      'wrong patient is a clinical record that has to be looked at rather than migrated past.', crossed;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_opened_visit_is_this_patients'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_opened_visit_is_this_patients
      foreign key (opened_visit_id, patient_id)
      references jmc.appointments (id, patient_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_subject_visit_is_this_patients'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_subject_visit_is_this_patients
      foreign key (subject_visit_id, patient_id)
      references jmc.appointments (id, patient_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_encounter_is_this_patients'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_encounter_is_this_patients
      foreign key (encounter_id, patient_id)
      references jmc.encounters (id, patient_id);
  end if;
end $$;

-- Every composite foreign key above needs an index with its columns as a
-- leading prefix, for the same reason the single-column ones do.
create index if not exists resolutions_opened_visit_patient_idx
  on jmc.consultation_attempt_resolutions (opened_visit_id, patient_id)
  where opened_visit_id is not null;
create index if not exists resolutions_subject_visit_patient_idx
  on jmc.consultation_attempt_resolutions (subject_visit_id, patient_id)
  where subject_visit_id is not null;
create index if not exists resolutions_encounter_patient_idx
  on jmc.consultation_attempt_resolutions (encounter_id, patient_id)
  where encounter_id is not null;


-- ── 5. Access, exactly as every other table in this schema ─────────────────
do $$
declare t text;
begin
  foreach t in array array['appointment_command_receipts'] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;


-- ── 6. The duration ceiling is not owner policy ────────────────────────────
--
-- `20260920000000` wrote `check (duration_minutes > 0 and duration_minutes <=
-- 480)` under a heading that cited owner item 65, and item 65 decided the
-- fifteen-minute default and the per-type override and said nothing whatever
-- about a maximum. Eight hours is a technical safety bound chosen by the
-- implementation to stop a typed-in 4800 becoming a booking that swallows the
-- week; it is not a clinic rule and must not be read back as one.
--
-- The constraint stays because it is doing a useful job. Only the attribution
-- was false, and a comment is where that gets corrected without rewriting an
-- applied migration.
comment on column jmc.appointment_types.duration_minutes is
  'Minutes. The 15-minute default is owner policy item 65. The 480-minute ceiling is NOT: it is an implementation safety bound against a mistyped number, and no owner decision selected it.';
