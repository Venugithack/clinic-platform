-- ═══════════════════════════════════════════════════════════════════════════
-- SLICE 2: A FUTURE THAT CONVERGES WITH THE QUEUE, AND A WAY OUT OF AN
-- UNRESOLVED CONSULTATION ATTEMPT
--
-- Two things arrive together because owner policy approved them together on
-- 15 September 2026: items 65–71 (appointments) and items 72–74 (consultation
-- and visit reconciliation). They share this file because they share one fact —
-- a patient can be in the clinic's records twice for one attendance, and
-- deciding which row is which is a person's act rather than a timer's.
--
-- ── THE ONE DECISION THAT SHAPES EVERYTHING BELOW ──────────────────────────
--
-- `jmc.appointments` is NOT the appointment table. It is the ARRIVAL table,
-- and the name is a fossil: every row in it is somebody standing in the clinic
-- with a token in their hand, and `scheduled_at` is when they turned up rather
-- than when they were expected. The snapshot returns every row of it for today
-- plus anything still open, four statuses deep, to every tablet in the
-- building.
--
-- So a booking for next Tuesday does not go in it. Owner item 70 is explicit —
-- "A future booking does not enter the live queue until check-in" — and a row
-- in `appointments` IS the live queue. Putting a booked patient there means
-- either a fifth status value that every existing reader has to learn, or a
-- patient who appears in the corridor a week early. Both are how a queue comes
-- to be wrong.
--
-- `appointment_bookings` is therefore the future, `appointments` stays the
-- present, and `check_in_appointment` is the single door between them. A
-- walk-in still goes straight into `appointments` with no booking at all, and
-- nothing about the existing walk-in path changes: no column it reads is
-- altered, no status it writes is removed, no constraint it satisfies is
-- tightened.
--
-- ── WHAT IS ADDED ──────────────────────────────────────────────────────────
--
--   1. appointment_types              owner item 65 — 15 minutes, or a type's own
--   2. provider_availability          owner item 71 — doctor/admin own it
--   3. appointment_bookings           owner items 66–70 — the future
--   4. appointment_events             owner item 68 — append-only history
--   5. columns on appointments        the booking a walk-in row came from, and
--                                     owner item 70's urgent prioritization
--   6. two unique indexes on appointments
--   7. consultation_attempt_resolutions   owner items 72–74
--   8. row security, revoked grants, and the foreign-key indexes
--
-- Forward-only. No stored row is rewritten. No signed encounter is touched by
-- anything in this file, and nothing here invents a status for history that
-- history did not have. No new `text` timestamp and no new `real` money column:
-- every instant below is `timestamptz`.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ── 1. How long an appointment is ──────────────────────────────────────────
--
-- Owner item 65: fifteen minutes by default; an appointment type may define a
-- different duration; a doctor or admin manages them; and "a type change does
-- not rewrite the duration already recorded for an existing booking".
--
-- That last clause is why `duration_minutes` is copied onto the booking rather
-- than joined from here. A type is a default at the moment of booking and not
-- a fact about a booking already made — the same reasoning that snapshots the
-- consultation fee onto the encounter rather than reading it back from
-- `clinic_settings` a month later.
--
-- Nothing is seeded. A clinic with no types at all books fifteen-minute
-- appointments, which is exactly what item 65 says the default is; seeding a
-- row called "Consultation" would be inventing clinic content nobody approved.
create table if not exists jmc.appointment_types (
  id text primary key,
  name text not null check (length(trim(name)) > 0),
  duration_minutes integer not null default 15
    check (duration_minutes > 0 and duration_minutes <= 480),
  active boolean not null default true,
  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  updated_by text references jmc.staff(id),
  updated_at timestamptz
);

-- Two live types called "Follow up" are two things nobody can tell apart on a
-- screen. A retired one may share a name with its replacement, which is the
-- ordinary shape of renaming something without rewriting the bookings that
-- already point at it.
create unique index if not exists appointment_types_live_name
  on jmc.appointment_types (lower(trim(name)))
  where active;

comment on table jmc.appointment_types is
  'Owner item 65. A named default duration. The booking copies the number; changing a type never rewrites a booking already made.';


-- ── 2. When the doctor is available ────────────────────────────────────────
--
-- Owner item 71: "Doctor and admin may create or edit provider availability. A
-- nurse may book, reschedule, or cancel within published availability but may
-- not change the availability itself. An availability change never silently
-- cancels or moves an existing booking."
--
-- Two shapes, one table, because a clinic needs both and neither is the other:
--
--   a recurring window   `weekday` — Tuesdays, 09:00 to 13:00, from 1 October
--   a single day         `on_date` — this Thursday, or the Thursday the clinic
--                        is shut for a wedding
--
-- `kind = 'blocked'` subtracts. A closed afternoon is a blocked window over an
-- open one rather than an edit to the open one, so the weekly pattern survives
-- the exception and the exception is visible as itself.
--
-- Nothing here ever writes a booking. That is item 71's last sentence and it
-- is held by the commands rather than by a constraint — there is no constraint
-- that can say "this statement did not touch another table" — so
-- `slice2-appointments.test.mjs` performs the availability change and asserts
-- the bookings are byte-identical afterwards.
create table if not exists jmc.provider_availability (
  id text primary key,
  doctor_id text not null references jmc.staff(id),
  kind text not null check (kind in ('open', 'blocked')),
  weekday smallint check (weekday between 0 and 6),
  on_date date,
  starts_at time not null,
  ends_at time not null,
  effective_from date,
  effective_to date,
  note text not null default '',
  active boolean not null default true,
  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  retired_by text references jmc.staff(id),
  retired_at timestamptz,
  check (ends_at > starts_at),
  -- A window is recurring or it is a date. Both, or neither, is a window
  -- nobody can evaluate.
  check (
    (weekday is not null and on_date is null and effective_from is not null)
    or (weekday is null and on_date is not null and effective_from is null and effective_to is null)
  ),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check ((retired_at is null) = (retired_by is null)),
  check (active or retired_at is not null)
);

create index if not exists provider_availability_doctor
  on jmc.provider_availability (doctor_id, kind)
  where active;

comment on table jmc.provider_availability is
  'Owner item 71. Doctor/admin publish it; a nurse books inside it. Weekday windows recur; on_date windows are one day. kind=blocked subtracts.';


-- ── 3. The future ──────────────────────────────────────────────────────────
--
-- Owner items 66–70.
--
-- `status` is a stored state with an explicit machine rather than a derived
-- one, and that is a deliberate exception to this programme's "derive it"
-- rule. A booking's state is not a consequence of other facts — nothing else
-- in the clinic knows that a doctor decided this patient did not come — so
-- there is nothing to derive it from. What IS derived is everything about
-- the transition: who, when, why, and what it was before all live in
-- `appointment_events`, append-only, and this column is only ever the latest
-- of them.
--
--     (none) ──book──▶ booked ──reschedule──▶ booked       (time moves, state does not)
--                        │
--                        ├──cancel────▶ cancelled          terminal
--                        ├──no_show───▶ no_show            terminal, item 69
--                        └──check_in──▶ checked_in ──cancel───▶ cancelled
--                                            └──reschedule──▶ booked
--
-- `checked_in` is the only state that has an arrival beside it, and the
-- arrival is found through `appointments.booking_id` rather than stored here
-- twice. One booking can hold at most one live arrival; §6 is the index that
-- makes that a guarantee rather than an intention.
--
-- `overbooked` and `outside_availability` are the two overrides item 67 and
-- item 71 allow, recorded ON the booking because "was this one of those?" is a
-- question somebody asks about a booking a month later, and walking the event
-- stream to answer it is how a reviewable override becomes an invisible one.
create table if not exists jmc.appointment_bookings (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  doctor_id text not null references jmc.staff(id),
  appointment_type_id text references jmc.appointment_types(id),
  scheduled_at timestamptz not null,
  duration_minutes integer not null
    check (duration_minutes > 0 and duration_minutes <= 480),
  -- Required, like the walk-in path's. `check_in_appointment` copies it onto
  -- the queue row, where `appointments.reason` is what the doctor reads before
  -- calling somebody in, and an empty one there is a row nobody can triage.
  reason text not null check (length(trim(reason)) > 0),
  status text not null check (status in ('booked', 'cancelled', 'no_show', 'checked_in')),
  overbooked boolean not null default false,
  overbooked_reason text not null default '',
  outside_availability boolean not null default false,
  checked_in_at timestamptz,
  checked_in_by text references jmc.staff(id),
  booked_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  idempotency_key text,
  request_fingerprint text,
  -- Item 67: an override is an explicit action with a required reason. A flag
  -- with no sentence behind it is not a reviewable override.
  check (overbooked = false or length(trim(overbooked_reason)) > 0),
  check ((checked_in_at is null) = (checked_in_by is null)),
  check (status <> 'checked_in' or checked_in_at is not null),
  -- The same pairing `encounters` uses: a key with no fingerprint beside it
  -- cannot refuse a mismatch, which is the half that protects the patient.
  check (idempotency_key is null or request_fingerprint is not null)
);

-- Partial, because most rows will carry a key and the ones that do not are
-- not worth an index entry each. Postgres treats NULLs as distinct in a unique
-- index anyway, so this constrains exactly what the full form did.
create unique index if not exists appointment_bookings_idempotency_key
  on jmc.appointment_bookings (idempotency_key)
  where idempotency_key is not null;

-- The calendar query, and the conflict check inside the booking transaction.
-- Partial on `booked` because a cancelled or finished booking conflicts with
-- nothing and the table only grows.
create index if not exists appointment_bookings_open
  on jmc.appointment_bookings (doctor_id, scheduled_at)
  where status = 'booked';

create index if not exists appointment_bookings_patient
  on jmc.appointment_bookings (patient_id, scheduled_at desc);

comment on table jmc.appointment_bookings is
  'Owner items 66-70. A future booking. It is NOT in the live queue: check-in creates the arrival row in jmc.appointments and that is the only door between them.';

-- Named for the override it was written for and used by both, because they are
-- one act from where the person is standing: "book it anyway, and here is
-- why". `overbooked` says a booking was already in the slot;
-- `outside_availability` says the slot is outside the doctor's published
-- hours; either can be true, both can be, and this column holds the one
-- sentence that covers whichever it was.
comment on column jmc.appointment_bookings.overbooked_reason is
  'Why this booking was placed over a conflict or outside published hours. Required when overbooked is true, and also carried when outside_availability is true.';


-- ── 4. What happened to a booking, and to a queue row ──────────────────────
--
-- Owner item 68: "No appointment is silently deleted: the prior state, actor,
-- time, and reason remain in append-only history."
--
-- One table for both halves of the domain, because a patient's appointment
-- history is one timeline and reading it out of two tables in a screen is how
-- two orderings come to disagree. `booking_id` for the future, `arrival_id`
-- for the queue row, exactly one of them per row.
--
-- `closed_on_reconciliation` is the one event owner item 72 writes here: a
-- leftover queue row closed because a doctor determined it was the same
-- attendance as a consultation already signed. The full record of that
-- decision is §7; this row exists so that the visit's own timeline says why it
-- stopped waiting, rather than showing a `done` with nobody's name on it.
create table if not exists jmc.appointment_events (
  id text primary key,
  booking_id text references jmc.appointment_bookings(id),
  arrival_id text references jmc.appointments(id),
  event text not null check (event in (
    'booked', 'rescheduled', 'cancelled', 'no_show', 'checked_in',
    'prioritized', 'priority_cleared', 'closed_on_reconciliation'
  )),
  from_status text,
  to_status text,
  scheduled_at_before timestamptz,
  scheduled_at_after timestamptz,
  reason text not null default '',
  detail text not null default '',
  actor_id text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  check ((booking_id is null) <> (arrival_id is null))
);

create index if not exists appointment_events_booking
  on jmc.appointment_events (booking_id, created_at desc, id desc)
  where booking_id is not null;

create index if not exists appointment_events_arrival
  on jmc.appointment_events (arrival_id, created_at desc, id desc)
  where arrival_id is not null;

-- Append-only, like every other history in this schema. A wrong event is
-- corrected by recording another one, which leaves both visible.
drop trigger if exists appointment_events_immutable on jmc.appointment_events;
create trigger appointment_events_immutable
before update or delete on jmc.appointment_events
for each row execute function jmc.reject_signed_line_change();

comment on table jmc.appointment_events is
  'Owner item 68. Append-only transition history for bookings and for queue rows. Also the durable hook a later reminder scheduler reads; nothing in this slice sends anything.';


-- ── 5. What a queue row gained ─────────────────────────────────────────────
--
-- `booking_id` — the booking this arrival came from, or null for a walk-in,
-- which is most of them and stays most of them.
--
-- `urgent` and its three companions — owner item 70: "A doctor may explicitly
-- prioritize an urgent patient, with a required reason and audit event." The
-- reason, the actor and the time are on the row because the queue is what
-- somebody looks at when they ask why the fourth patient went in third.
--
-- Every existing row takes `false` and an empty reason, which is what every
-- existing row means. Nothing is backfilled and nothing is guessed at.
alter table jmc.appointments
  add column if not exists booking_id text references jmc.appointment_bookings(id),
  add column if not exists urgent boolean not null default false,
  add column if not exists urgent_reason text not null default '',
  add column if not exists urgent_by text references jmc.staff(id),
  add column if not exists urgent_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'appointments_urgent_is_explained'
       and conrelid = 'jmc.appointments'::regclass
  ) then
    alter table jmc.appointments
      add constraint appointments_urgent_is_explained
      check (
        urgent = false
        or (length(trim(urgent_reason)) > 0 and urgent_by is not null and urgent_at is not null)
      );
  end if;
end $$;

comment on column jmc.appointments.booking_id is
  'The appointment_bookings row this arrival was checked in from, or null for a walk-in.';
comment on column jmc.appointments.urgent is
  'Owner item 70. A doctor moved this patient up the queue. Never true without a reason, an actor and a time.';


-- ── 6. Two indexes on the queue, and one of them can refuse to be created ──
--
-- ── 6a. One booking, one live arrival ──────────────────────────────────────
--
-- This is what makes "retrying check-in returns the same arrival and never
-- creates two queue entries" a guarantee rather than a hope. The command holds
-- the booking row with `for update` and replays on `checked_in`, which is the
-- courteous path; this is the one that holds when two tablets press Arrived in
-- the same breath.
--
-- `status <> 'cancelled'` is not a loophole. Owner item 68 lets a doctor or
-- admin reschedule AFTER check-in, and the honest way to record that is to
-- cancel the queue row the patient is no longer standing in and let the moved
-- booking check in again on the day it moved to. A cancelled arrival is not an
-- arrival.
create unique index if not exists appointments_one_live_arrival_per_booking
  on jmc.appointments (booking_id)
  where booking_id is not null and status <> 'cancelled';

-- ── 6b. Two waiting patients cannot hold one token ─────────────────────────
--
-- `20260909125224_document_numbers.sql` fixed the MINTING — every token now
-- comes from `appointment_token_seq` and no two callers can be handed the same
-- number — and deliberately declined to constrain the TABLE:
--
--   > That index is deliberately NOT added here. This has to apply to a
--   > database that has been running a clinic for months, duplicate tokens are
--   > precisely what such a database is likely to be holding, and a migration
--   > that fails on the damage it exists to stop helps nobody.
--
-- That reasoning is sound about the whole table and too broad about the part
-- that matters. The harm it describes — "two waiting patients simply hold
-- JMC-0004, and one of them is called in for the other's consultation" — needs
-- both rows to be OPEN. A pair of duplicates among last spring's finished
-- visits is untidy history; a pair among the eleven people in the corridor is
-- the wrong patient in the consulting room. So the constraint is scoped to
-- exactly the rows where it is a clinical safeguard, and the historical
-- duplicates are left exactly as they are, because rewriting them would be
-- inventing evidence about visits that already happened.
--
-- It can still refuse. A clinic whose corridor holds two JMC-0004 today gets a
-- sentence naming them rather than a constraint violation naming an index,
-- because the operator has to resolve the queue before this can be true and a
-- SQLSTATE does not tell them which two rows to look at.
do $$
declare
  clash text;
begin
  select string_agg(token || ' (' || n || ' open rows)', ', ' order by token)
    into clash
    from (
      select token, count(*) as n
        from jmc.appointments
       where status in ('waiting', 'in_consult')
       group by token
      having count(*) > 1
    ) duplicates;

  if clash is not null then
    raise exception
      'Two or more patients are waiting under one queue token: %. Close, cancel or re-token '
      'those visits from the Queue before applying this migration; it will not rewrite them '
      'for you, because a token already printed on somebody''s slip is not a value a migration '
      'may decide about. Finished and cancelled visits are not affected.', clash;
  end if;
end $$;

create unique index if not exists appointments_open_token_unique
  on jmc.appointments (token)
  where status in ('waiting', 'in_consult');

-- And the index it replaces goes, because it is now being maintained for
-- nothing. `appointments_token_idx` was added by `20260919000000` for exactly
-- one query — the patient search's token branch — and that query filters
-- `status in ('waiting','in_consult')`, which is this index's predicate. A
-- partial index over the same column and the same rows serves it strictly
-- better, and the full index would go on costing a write on every arrival the
-- clinic ever records in order to answer nothing. `20260919000000`'s own
-- comment set that test: "the migration is maintaining it for nothing".
--
-- Forward-only: dropping an index removes no fact. The plan assertion in
-- `workspace-performance.test.mjs` names the new index.
drop index if exists jmc.appointments_token_idx;


-- ── 7. The way out of an unresolved consultation attempt ───────────────────
--
-- Owner items 72, 73 and 74, which are one policy read three ways.
--
-- The situation, in the order it actually happens: a doctor presses Finish,
-- the consultation commits in Chennai, and the reply is lost on the way back.
-- The tablet says "Outcome not confirmed". The clinic now holds a signed
-- encounter the doctor cannot see, and within a minute it may also hold a
-- second queue row for the same patient — because signing set the first one to
-- `done`, the poll dropped it, and reception arrived the patient again while
-- they were still standing there.
--
-- Slice 1 made every one of those endings honest and none of them finishable.
-- The signing is refused rather than repeated, the leftover visit is reported
-- as an obligation, and the attempt is held — held forever, because releasing
-- it on a refusal reopens the second ₹300 fee that the whole mechanism exists
-- to prevent. What was missing was a way for a person to say which of the two
-- things in front of them is true.
--
-- ── WHAT THIS TABLE IS, AND THE FOUR THINGS IT IS NOT ──────────────────────
--
-- It is one append-only row per attempt, written by a doctor, recording what
-- the server established about the attempt's outcome and what the doctor then
-- determined. `idempotency_key` is unique, so an attempt is resolved once: a
-- repeat of the same resolution replays it, a different one is refused, and
-- two doctors resolving at the same moment produce one row.
--
--   It is NOT an edit of a signed encounter. `same_attendance` links a visit
--   to an encounter HERE and leaves `encounters.appointment_id` exactly as the
--   doctor signed it. Owner item 72's first clause.
--
--   It is NOT a second consultation. Nothing in this table writes an
--   encounter, an invoice, an invoice line or a fee. The check constraints
--   below cannot say that; `slice2-reconciliation.test.mjs` asserts the
--   complete side-effect set on every branch.
--
--   It is NOT an automatic release. `prior_outcome` is what the SERVER
--   established under a lock, not what the tablet believed, and there is no
--   value for "probably". An outcome that cannot be established fails closed
--   before this row is reached.
--
--   It is NOT a guess about which visit is which. Reception creating a second
--   queue row is not evidence of a second consultation (item 74), so the
--   subject visit is named by the doctor and recorded here rather than
--   inferred from the queue.
create table if not exists jmc.consultation_attempt_resolutions (
  id text primary key,
  -- The attempt being resolved. Not a foreign key: the whole point of this
  -- table is that the key may name nothing at all, which is precisely the
  -- `not_committed` case.
  idempotency_key text not null,
  patient_id text not null references jmc.patients(id),
  resolved_by text not null references jmc.staff(id),
  resolution text not null
    check (resolution in ('same_attendance', 'new_attendance', 'abandoned_attempt')),
  prior_outcome text not null check (prior_outcome in ('committed', 'not_committed')),
  -- The consultation the attempt signed, when it signed one.
  encounter_id text references jmc.encounters(id),
  -- The visit the attempt was opened against, as the tablet reported it.
  opened_visit_id text references jmc.appointments(id),
  -- The visit the doctor is deciding about — the leftover queue row, or the
  -- second arrival. Absent where there is no queue row at all, which is the
  -- ordinary shape for a patient opened from the register.
  subject_visit_id text references jmc.appointments(id),
  subject_visit_closed boolean not null default false,
  reason text not null check (length(trim(reason)) > 0),
  request_fingerprint text not null,
  resolved_at timestamptz not null default now(),
  -- `committed` means the server found the encounter. The two travel together
  -- or the row is describing something nobody looked up.
  check ((prior_outcome = 'committed') = (encounter_id is not null)),
  -- Item 72: same attendance links a visit to a consultation that exists.
  -- With nothing signed there is nothing to be the same attendance AS, and
  -- the act available is signing rather than reconciling.
  check (resolution <> 'same_attendance' or prior_outcome = 'committed'),
  -- Item 73: an abandoned attempt is one that wrote nothing.
  check (resolution <> 'abandoned_attempt' or prior_outcome = 'not_committed'),
  -- Only same attendance closes a visit, and only a visit that was named.
  check (subject_visit_closed = false
         or (subject_visit_id is not null and resolution = 'same_attendance'))
);

create unique index if not exists consultation_attempt_resolutions_key
  on jmc.consultation_attempt_resolutions (idempotency_key);

create index if not exists consultation_attempt_resolutions_patient
  on jmc.consultation_attempt_resolutions (patient_id, resolved_at desc, id desc);

create index if not exists consultation_attempt_resolutions_encounter
  on jmc.consultation_attempt_resolutions (encounter_id)
  where encounter_id is not null;

drop trigger if exists consultation_attempt_resolutions_immutable
  on jmc.consultation_attempt_resolutions;
create trigger consultation_attempt_resolutions_immutable
before update or delete on jmc.consultation_attempt_resolutions
for each row execute function jmc.reject_signed_line_change();

comment on table jmc.consultation_attempt_resolutions is
  'Owner items 72-74. One append-only row per consultation attempt: what the server established about its outcome, and what a doctor then determined. Never edits a signed encounter and never writes a fee.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. ACCESS, AND THE INDEXES BEHIND THE FOREIGN KEYS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20260909125237_harden_active_clinic.sql` set the posture for this schema:
-- row security on every table, forced on none, and every privilege revoked
-- from `public`, `anon`, `authenticated` and `service_role`, so `jmc` is
-- unreachable except through the Edge Functions' own connection. A table added
-- later and left out of that is a table the Data API could reach, and
-- `slice3-gate.test.mjs` walks `pg_class` rather than a list precisely so that
-- forgetting is a failing test rather than a quiet hole.

do $$
declare t text;
begin
  foreach t in array array[
    'appointment_types', 'provider_availability', 'appointment_bookings',
    'appointment_events', 'consultation_attempt_resolutions'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ── Every foreign key reaches its parent through an index ──────────────────
--
-- Asserted for the whole schema by `slice3-gate.test.mjs` and `slice6-gate`,
-- and it is not tidiness: without them, deleting or locking a parent row makes
-- Postgres read the whole child table to check the constraint, and the child
-- tables here are the ones that grow for ever.
--
-- Those two tests check that some index has the key as a leading prefix; they
-- do NOT check that a partial index's predicate is implied by the lookup. So
-- they can pass while the property does not hold, which is how the two
-- corrections below went unnoticed until somebody ran `EXPLAIN`. Twenty
-- pre-existing foreign keys across five earlier slices are in the same
-- position; tightening the gate is a hardening decision for somebody to take
-- deliberately rather than a change this slice may make on its way past, and
-- it is recorded as one in the programme register.
--
-- The ones the queries above already needed are declared beside those queries;
-- these are the remainder, which exist for the constraint rather than for a
-- read anybody performs.
create index if not exists appointment_types_created_by_idx
  on jmc.appointment_types (created_by);
create index if not exists appointment_types_updated_by_idx
  on jmc.appointment_types (updated_by) where updated_by is not null;

-- Plain, not the `(doctor_id, kind) where active` index above it. A partial
-- index serves a constraint check only when its predicate is IMPLIED by the
-- lookup: `where doctor_id is not null` is, because `doctor_id = $1` proves it,
-- and `where active` is not. The independent review proved the difference with
-- `EXPLAIN` under `enable_seqscan = off`, where this lookup was a sequential
-- scan and the ones over `is not null` predicates were index scans.
create index if not exists provider_availability_doctor_id_idx
  on jmc.provider_availability (doctor_id);

create index if not exists provider_availability_created_by_idx
  on jmc.provider_availability (created_by);
create index if not exists provider_availability_retired_by_idx
  on jmc.provider_availability (retired_by) where retired_by is not null;

create index if not exists appointment_bookings_type_idx
  on jmc.appointment_bookings (appointment_type_id) where appointment_type_id is not null;
create index if not exists appointment_bookings_booked_by_idx
  on jmc.appointment_bookings (booked_by);
create index if not exists appointment_bookings_checked_in_by_idx
  on jmc.appointment_bookings (checked_in_by) where checked_in_by is not null;
create index if not exists appointment_bookings_doctor_idx
  on jmc.appointment_bookings (doctor_id);

create index if not exists appointment_events_actor_idx
  on jmc.appointment_events (actor_id);

-- `appointments` gained two references of its own, and the first version of
-- this migration claimed the unique index in section 6a served `booking_id`.
-- It does not: that index is partial on `booking_id is not null AND status <>
-- 'cancelled'`, and the second conjunct cannot be implied by `booking_id = $1`,
-- so the constraint check fell back to a sequential scan over the one table
-- here that grows for ever. Proved with `EXPLAIN` under `enable_seqscan = off`
-- by the independent review; the claim is corrected and the index added.
--
-- `where booking_id is not null` IS implied — a lookup for a value proves the
-- column is not null — so this stays partial and skips the walk-ins, which are
-- most of the table.
create index if not exists appointments_booking_idx
  on jmc.appointments (booking_id) where booking_id is not null;

create index if not exists appointments_urgent_by_idx
  on jmc.appointments (urgent_by) where urgent_by is not null;

create index if not exists consultation_attempt_resolutions_actor_idx
  on jmc.consultation_attempt_resolutions (resolved_by);
create index if not exists consultation_attempt_resolutions_opened_visit_idx
  on jmc.consultation_attempt_resolutions (opened_visit_id) where opened_visit_id is not null;
create index if not exists consultation_attempt_resolutions_subject_visit_idx
  on jmc.consultation_attempt_resolutions (subject_visit_id) where subject_visit_id is not null;
