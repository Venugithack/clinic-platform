-- ═══════════════════════════════════════════════════════════════════════════
-- BACKEND PROGRAMME SLICE 4: THE OUTPATIENT DIAGNOSTICS LOOP
--
-- Owner policy register items 84–88, approved 19 September 2026, closing
-- backend decision register entries D13 to D17. Six new tables, one widened
-- purpose list across four Slice 3A tables, and one new sequence. No existing
-- row is rewritten and no existing command response changes.
--
-- The loop this closes is order → the patient goes somewhere → a report comes
-- back → a doctor reads it → the patient is told. Today the clinic has none of
-- it: no table, column, command or type in this application mentions an
-- investigation, a lab order or a referral, and a report can only arrive as a
-- clinical photograph, which the pharmacy cannot see and which carries consent
-- semantics written for photographs of wounds.
--
-- ── WHAT THIS SLICE IS NOT ─────────────────────────────────────────────────
--
-- It is not a laboratory system. There is no analyzer integration, no
-- structured analyte model, no reference ranges, no PACS and no patient
-- portal. A result arrives here as the report the laboratory actually sent,
-- kept as it was sent, carrying whatever flag the laboratory itself put on it.
--
-- That is a deliberate refusal rather than a first version. A column called
-- `value numeric` and a column called `reference_high numeric` invite exactly
-- one line of code — `if (value > reference_high) flag = 'abnormal'` — and
-- that line is an application authoring a clinical judgment. Owner item 85
-- forbids it in as many words. The cheapest way to keep a rule is to make the
-- data it governs impossible to hold.
--
-- ── THE RULE BEHIND EVERY CONSTRAINT BELOW ─────────────────────────────────
--
-- **A clinical judgment has a clinician's name on it, or it does not exist.**
--
--   a flag         has one of three recorded origins and never a fourth
--   a review       is a row written by a doctor, and the laboratory's own
--                  technical validation is a different column entirely
--   a release      needs that review AND a separate authorization
--   a delivery     comes from authenticated provider evidence or from an
--                  audited telephone call, and never from an HTTP 200
--
-- Each of those is a fact with an author. Every state this slice can report is
-- derived from facts with authors, and the four things a clock is allowed to
-- do are: make something overdue, make something escalated, make a message
-- due, and stop a message being worth sending. A clock never reviews, never
-- flags, never authorizes and never releases.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. A FIFTH MESSAGING PURPOSE, WHICH IS AN OWNER DECISION AND NOT A VALUE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Slice 3A's own comment on this list reads: "Owner item 78's four purposes,
-- exactly as it names them ... A fifth purpose is a policy decision and not a
-- column value somebody may add in passing."
--
-- Owner item 88, approved 19 September 2026, is that policy decision. It
-- authorizes one automated patient-facing message about an investigation
-- result and fixes its entire wording:
--
--     "Your investigation result has been reviewed and is ready.
--      Please contact the clinic."
--
-- It is `result_ready` and NOT `ready_for_collection`, and the difference is
-- not tidiness. `ready_for_collection` is the pharmacy telling somebody their
-- medicine is on the counter. A patient who agreed to be told that has not
-- agreed to be told that a test result exists, which is a different fact about
-- them with a different sensitivity, and owner item 78's whole architecture is
-- that consent is per purpose. Folding the two together would silently enrol
-- every patient who ticked the pharmacy box.
--
-- Widening a check constraint admits a value; it changes no existing row, and
-- every table below keeps the four purposes it already had.
--
-- The constraints are found by what they SAY rather than by name, because
-- Slice 3A wrote them inline and Postgres named them. Only the purpose check
-- on each of these tables mentions `service_interruption`, so the marker is
-- exact; and because the replacements mention it too, running this file twice
-- drops and rebuilds them rather than failing on a duplicate name.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname
      from pg_constraint
     where contype = 'c'
       and conrelid in (
             'jmc.message_templates'::regclass,
             'jmc.communication_consents'::regclass,
             'jmc.communication_schedules'::regclass,
             'jmc.message_outbox'::regclass)
       and pg_get_constraintdef(oid) like '%service_interruption%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table jmc.message_templates
  add constraint message_templates_purpose_allowed
  check (purpose in ('appointment', 'clinical_recall', 'ready_for_collection',
                     'service_interruption', 'result_ready'));

alter table jmc.communication_consents
  add constraint communication_consents_purpose_allowed
  check (purpose in ('appointment', 'clinical_recall', 'ready_for_collection',
                     'service_interruption', 'result_ready'));

alter table jmc.communication_schedules
  add constraint communication_schedules_purpose_allowed
  check (purpose in ('appointment', 'clinical_recall', 'ready_for_collection',
                     'service_interruption', 'result_ready'));

alter table jmc.message_outbox
  add constraint message_outbox_purpose_allowed
  check (purpose in ('appointment', 'clinical_recall', 'ready_for_collection',
                     'service_interruption', 'result_ready'));

-- The schedule's kind and its source. Same treatment, same markers: only the
-- kind check mentions `appointment_confirmation` as a bare member of an `in`
-- list, and only the source check mentions `follow_up` that way. The three
-- pairing constraints Slice 3A wrote — purpose to kind, and source to purpose
-- — are left exactly as they are, because each of them is an equality between
-- two falsehoods for a result notice and so is already satisfied. The two new
-- pairings below say the same thing for the new purpose.
do $$
declare c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where contype = 'c'
       and conrelid = 'jmc.communication_schedules'::regclass
       and (pg_get_constraintdef(oid) like 'CHECK ((schedule\_kind = ANY%' escape '\'
         or pg_get_constraintdef(oid) like 'CHECK ((source\_type = ANY%' escape '\')
  loop
    execute format('alter table jmc.communication_schedules drop constraint %I', c.conname);
  end loop;
end $$;

alter table jmc.communication_schedules
  add constraint communication_schedules_kind_allowed
  check (schedule_kind in ('appointment_reminder', 'appointment_confirmation',
                           'clinical_recall', 'result_ready'));

alter table jmc.communication_schedules
  add constraint communication_schedules_source_allowed
  check (source_type in ('appointment_booking', 'follow_up', 'investigation_result'));

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'communication_schedules_result_pairing'
                    and conrelid = 'jmc.communication_schedules'::regclass) then
    alter table jmc.communication_schedules
      add constraint communication_schedules_result_pairing
      check ((purpose = 'result_ready') = (schedule_kind = 'result_ready'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'communication_schedules_result_source'
                    and conrelid = 'jmc.communication_schedules'::regclass) then
    alter table jmc.communication_schedules
      add constraint communication_schedules_result_source
      check ((source_type = 'investigation_result') = (purpose = 'result_ready'));
  end if;

  -- Owner items 87 and 88 both name a doctor who owns a result. A result-ready
  -- schedule without one could escalate to nobody, exactly as item 83's recall
  -- could not.
  if not exists (select 1 from pg_constraint
                  where conname = 'communication_schedules_result_has_doctor'
                    and conrelid = 'jmc.communication_schedules'::regclass) then
    alter table jmc.communication_schedules
      add constraint communication_schedules_result_has_doctor
      check (purpose <> 'result_ready' or responsible_doctor_id is not null);
  end if;
end $$;

-- Two more suppression reasons, and they are the honest half of owner item 88.
--
-- A queued result notice can stop being true between the moment a doctor
-- authorized it and the moment a worker would send it: the report can be
-- corrected, the order cancelled, the authorization withdrawn with the result
-- it belonged to. Slice 3A's generic prepare and dispatch already re-ask
-- consent, the template's standing and the usefulness deadline under the row
-- lock. These two reasons are what the result-specific half of that recheck
-- records, so the admin's queue says which of the two happened rather than
-- "something".
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where contype = 'c'
       and conrelid = 'jmc.message_outbox'::regclass
       and pg_get_constraintdef(oid) like '%past\_useful\_by%' escape '\'
  loop
    execute format('alter table jmc.message_outbox drop constraint %I', c.conname);
  end loop;
end $$;

alter table jmc.message_outbox
  add constraint message_outbox_suppression_reason_allowed
  check (suppression_reason in (
    '', 'no_consent', 'consent_withdrawn', 'channel_not_configured',
    'no_approved_template', 'provider_template_not_approved', 'no_contact_number',
    'link_destination_unavailable', 'variable_unavailable', 'past_useful_by',
    'result_superseded', 'result_not_authorized'));


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE CATALOGUE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner item 84. The owner-doctor owns it; another explicitly authorized
-- doctor may approve, version, retire or replace clinical content; an
-- administrator may prepare non-clinical metadata and may not approve clinical
-- content.
--
-- That last sentence is the whole shape of this table. It has two halves:
--
--   CLINICAL     kind, name, category, specimen, preparation. Fixed on a
--                version. Only a doctor's approval brings a version into use,
--                and a change means a new version.
--   OPERATIONAL  the external code and its system, the facility this is
--                usually sent to, the label the front desk knows it by, and
--                whether it may currently be ordered at all. An administrator
--                may maintain these on the live version, audited, without
--                creating a version and without approving anything clinical.
--
-- The trigger below is where the boundary lives, and it is a boundary rather
-- than a convention: an administrator physically cannot change the clinical
-- half, and nobody at all can change an approval once it has a name on it.
--
-- ── WHY A HISTORICAL ORDER CANNOT MOVE ─────────────────────────────────────
--
-- An order points at a catalogue VERSION and also copies the four facts it
-- prints — the name, the code, the kind and the facility — onto its own line.
-- The pointer is for provenance and the copy is for truth: an administrator
-- correcting a facility's name next March must not silently change what a
-- request form said last September.
create table if not exists jmc.investigation_catalogue (
  id text primary key,
  series_id text not null,
  version integer not null check (version > 0),

  -- ── the clinical half ──
  kind text not null check (kind in ('investigation', 'referral')),
  display_name text not null check (length(trim(display_name)) > 0),
  category text not null check (category in (
    'haematology', 'biochemistry', 'microbiology', 'histopathology',
    'imaging', 'cardiology', 'specialist_referral', 'other'
  )),
  specimen text not null default '',
  preparation text not null default '',

  -- ── the operational half, which an administrator may maintain ──
  external_code text not null default '',
  code_system text not null default '',
  default_facility text not null default '',
  operational_label text not null default '',
  orderable boolean not null default true,
  metadata_updated_by text references jmc.staff(id),
  metadata_updated_at timestamptz,

  approval_state text not null default 'draft'
    check (approval_state in ('draft', 'approved', 'retired')),
  approved_by text references jmc.staff(id),
  approved_at timestamptz,
  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  retired_by text references jmc.staff(id),
  retired_at timestamptz,
  supersedes_id text references jmc.investigation_catalogue(id),

  -- The hash of the clinical half, so "is this genuinely different?" is a
  -- comparison rather than a re-reading. The operational half is deliberately
  -- outside it: changing a facility's telephone number is not a new version of
  -- a blood test.
  content_fingerprint text not null,

  unique (series_id, version),
  check ((approved_at is null) = (approved_by is null)),
  check (approval_state = 'draft' or approved_at is not null),
  check ((retired_at is null) = (retired_by is null)),
  check (approval_state <> 'retired' or retired_at is not null),
  check ((metadata_updated_at is null) = (metadata_updated_by is null)),
  -- A referral is to somebody. An investigation may be done in-house.
  check (kind <> 'referral' or category = 'specialist_referral'
         or category in ('imaging', 'cardiology', 'histopathology', 'other'))
);

-- One approved version per series, which is what makes "the current definition
-- of this test" a question with one answer.
create unique index if not exists investigation_catalogue_live_version
  on jmc.investigation_catalogue (series_id)
  where approval_state = 'approved';

create index if not exists investigation_catalogue_series
  on jmc.investigation_catalogue (series_id, version desc);
create index if not exists investigation_catalogue_orderable
  on jmc.investigation_catalogue (kind, category, display_name)
  where approval_state = 'approved' and orderable;
create index if not exists investigation_catalogue_created_by_idx
  on jmc.investigation_catalogue (created_by);
create index if not exists investigation_catalogue_approved_by_idx
  on jmc.investigation_catalogue (approved_by) where approved_by is not null;
create index if not exists investigation_catalogue_retired_by_idx
  on jmc.investigation_catalogue (retired_by) where retired_by is not null;
create index if not exists investigation_catalogue_metadata_by_idx
  on jmc.investigation_catalogue (metadata_updated_by) where metadata_updated_by is not null;
create index if not exists investigation_catalogue_supersedes_idx
  on jmc.investigation_catalogue (supersedes_id) where supersedes_id is not null;

comment on table jmc.investigation_catalogue is
  'Owner item 84. Clinical content is fixed on a version and approved by an authorized doctor; the operational half — code, facility, label, orderable — may be maintained by an administrator on the live version and is audited. An order snapshots what it printed.';

create or replace function jmc.protect_investigation_catalogue()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'A catalogue version is never deleted. Retire it, or publish the next version of its series.';
  end if;

  if new.id is distinct from old.id
     or new.series_id is distinct from old.series_id
     or new.version is distinct from old.version
     or new.kind is distinct from old.kind
     or new.display_name is distinct from old.display_name
     or new.category is distinct from old.category
     or new.specimen is distinct from old.specimen
     or new.preparation is distinct from old.preparation
     or new.content_fingerprint is distinct from old.content_fingerprint
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.supersedes_id is distinct from old.supersedes_id then
    raise exception
      'What an investigation IS — its kind, name, category, specimen and preparation — is fixed '
      'for a version. Publish the next version of this series instead. Codes, the facility, the '
      'label and whether it may be ordered are the operational half and may be maintained.';
  end if;

  if old.approval_state = 'approved' and new.approval_state = 'draft' then
    raise exception 'An approved catalogue entry cannot return to draft. Retire it and publish a new version.';
  end if;
  if old.approval_state = 'retired' and new.approval_state <> 'retired' then
    raise exception 'A retired catalogue entry stays retired.';
  end if;
  if old.approved_by is not null
     and (new.approved_by is distinct from old.approved_by
          or new.approved_at is distinct from old.approved_at) then
    raise exception 'Who approved a catalogue entry, and when, is evidence and cannot be rewritten.';
  end if;

  return new;
end;
$$;

drop trigger if exists investigation_catalogue_version_immutable on jmc.investigation_catalogue;
create trigger investigation_catalogue_version_immutable
before update or delete on jmc.investigation_catalogue
for each row execute function jmc.protect_investigation_catalogue();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE ORDER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `REQ-000123`. A request form, which is the paper this replaces, and one
-- series for investigations and referrals together because they are the same
-- act — the doctor sending a patient out for something and expecting a report
-- back — and one number is one thing to read down a telephone.
--
-- ── THE ONLY STORED STATE IS THE ONE NOTHING ELSE CAN DERIVE ───────────────
--
-- An order is `open` or `cancelled`, and that is the whole column. Everything
-- else a screen wants to say about it — ordered, out at the laboratory,
-- partly resulted, complete, overdue — is derived from the items and the
-- results underneath it, which are the events that justify it.
--
-- That is not minimalism for its own sake. A stored `completed` is a second
-- copy of a fact the results already hold, and the day the two disagree the
-- clinic believes the copy. Cancellation is stored because it is the one thing
-- no other row implies: somebody decided, and that decision has an actor, a
-- time and a reason.
create sequence if not exists jmc.investigation_order_seq;

create table if not exists jmc.investigation_orders (
  id text primary key,
  order_number text not null unique,
  patient_id text not null references jmc.patients(id),
  -- Nullable, because a result can be ordered for a patient who is not in a
  -- consultation this minute. When there IS one it must be theirs, and the
  -- composite foreign key below is what makes that impossible to get wrong.
  encounter_id text references jmc.encounters(id),

  ordered_by text not null references jmc.staff(id),
  -- Item 86's "responsible ... doctor". Defaults to whoever ordered it, and is
  -- separate from `ordered_by` because the doctor who covers the clinic on
  -- Tuesday is not always the one whose patient this is.
  responsible_doctor_id text not null references jmc.staff(id),
  -- Item 86's "explicitly delegated doctor", recorded rather than assumed.
  -- Null is the ordinary case; a value here is an audited hand-over.
  delegated_doctor_id text references jmc.staff(id),
  delegated_by text references jmc.staff(id),
  delegated_at timestamptz,
  delegation_reason text not null default '',

  priority text not null default 'routine' check (priority in ('routine', 'urgent')),
  clinical_indication text not null default '',
  instructions text not null default '',
  external_facility text not null default '',
  -- How long before an unreturned order is worth chasing. An operational
  -- expectation set by the ordering doctor, never a clinical deadline, and
  -- never a thing that releases or reviews anything by itself.
  expected_by date,

  status text not null default 'open' check (status in ('open', 'cancelled')),
  cancelled_by text references jmc.staff(id),
  cancelled_at timestamptz,
  cancelled_reason text not null default '',

  created_at timestamptz not null default now(),
  idempotency_key text,
  request_fingerprint text,

  -- The half of every composite foreign key below that lives here.
  unique (id, patient_id),

  check ((cancelled_at is null) = (cancelled_by is null)),
  check ((status = 'cancelled')
         = (cancelled_at is not null and length(trim(cancelled_reason)) > 0)),
  check ((delegated_at is null) = (delegated_doctor_id is null)),
  check ((delegated_at is null) = (delegated_by is null)),
  check (delegated_doctor_id is null or length(trim(delegation_reason)) > 0),
  -- The same pairing `appointment_bookings` and `communication_schedules` use:
  -- a key with no fingerprint beside it cannot refuse a mismatch, and refusing
  -- a mismatch is the half that protects the patient.
  check (idempotency_key is null or request_fingerprint is not null)
);

-- The encounter has to be this patient's. Checking it in the command is
-- necessary and is not sufficient; `(encounter, patient)` can only point at a
-- row of `encounters` that has both, so a cross-patient order cannot be stored
-- however it arrives. `encounters_id_patient` was created for exactly this
-- purpose by `20260921000000` and is reused rather than duplicated.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'investigation_orders_encounter_is_this_patients'
                    and conrelid = 'jmc.investigation_orders'::regclass) then
    alter table jmc.investigation_orders
      add constraint investigation_orders_encounter_is_this_patients
      foreign key (encounter_id, patient_id)
      references jmc.encounters (id, patient_id);
  end if;
end $$;

create unique index if not exists investigation_orders_idempotency
  on jmc.investigation_orders (idempotency_key)
  where idempotency_key is not null;

create index if not exists investigation_orders_patient
  on jmc.investigation_orders (patient_id, created_at desc);
create index if not exists investigation_orders_open
  on jmc.investigation_orders (created_at desc) where status = 'open';
create index if not exists investigation_orders_encounter_idx
  on jmc.investigation_orders (encounter_id, patient_id) where encounter_id is not null;
create index if not exists investigation_orders_ordered_by_idx
  on jmc.investigation_orders (ordered_by);
create index if not exists investigation_orders_responsible_idx
  on jmc.investigation_orders (responsible_doctor_id);
create index if not exists investigation_orders_delegated_idx
  on jmc.investigation_orders (delegated_doctor_id) where delegated_doctor_id is not null;
create index if not exists investigation_orders_delegated_by_idx
  on jmc.investigation_orders (delegated_by) where delegated_by is not null;
create index if not exists investigation_orders_cancelled_by_idx
  on jmc.investigation_orders (cancelled_by) where cancelled_by is not null;

comment on table jmc.investigation_orders is
  'Owner items 84 and 86. One request form. open or cancelled is the only stored state; everything else is derived from the items and results beneath it. The responsible doctor, and any explicit delegation, are who may review what comes back.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. WHAT WAS ASKED FOR, ONE LINE EACH
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Carries `patient_id` although the order already has one. That is redundancy
-- on purpose: it is the column the composite foreign keys hang from, in both
-- directions. The line can only belong to an order of this patient, and a
-- result can only belong to a line of this patient. Between the two there is
-- no arrangement of ids, however they arrive, that attaches one patient's
-- report to another patient's request.
--
-- There is no status column, for the reason section 3 gives. A line is
-- cancelled, or it has a current result, or somebody marked it sent, or it is
-- merely ordered — and each of those is a row or a timestamp that somebody
-- wrote, read in that order.
create table if not exists jmc.investigation_order_items (
  id text primary key,
  order_id text not null references jmc.investigation_orders(id),
  patient_id text not null references jmc.patients(id),
  catalogue_id text not null references jmc.investigation_catalogue(id),

  -- The snapshot. What this request form said, kept where a later correction
  -- to the catalogue's operational half cannot reach it.
  item_kind text not null check (item_kind in ('investigation', 'referral')),
  item_name text not null check (length(trim(item_name)) > 0),
  item_code text not null default '',
  external_facility text not null default '',
  line_note text not null default '',

  -- The one operational event between ordering and a report arriving: the
  -- sample went, or the patient was sent. Optional, because plenty of reports
  -- come back without anybody having recorded this.
  in_progress_at timestamptz,
  in_progress_by text references jmc.staff(id),
  in_progress_note text not null default '',

  cancelled_by text references jmc.staff(id),
  cancelled_at timestamptz,
  cancelled_reason text not null default '',

  created_at timestamptz not null default now(),

  unique (id, patient_id),
  check ((in_progress_at is null) = (in_progress_by is null)),
  check ((cancelled_at is null) = (cancelled_by is null)),
  check (cancelled_at is null or length(trim(cancelled_reason)) > 0)
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'investigation_items_order_is_this_patients'
                    and conrelid = 'jmc.investigation_order_items'::regclass) then
    alter table jmc.investigation_order_items
      add constraint investigation_items_order_is_this_patients
      foreign key (order_id, patient_id)
      references jmc.investigation_orders (id, patient_id);
  end if;
end $$;

create index if not exists investigation_items_order
  on jmc.investigation_order_items (order_id);
create index if not exists investigation_items_order_patient_idx
  on jmc.investigation_order_items (order_id, patient_id);
create index if not exists investigation_items_patient
  on jmc.investigation_order_items (patient_id, created_at desc);
create index if not exists investigation_items_catalogue_idx
  on jmc.investigation_order_items (catalogue_id);
create index if not exists investigation_items_open
  on jmc.investigation_order_items (created_at) where cancelled_at is null;
create index if not exists investigation_items_in_progress_by_idx
  on jmc.investigation_order_items (in_progress_by) where in_progress_by is not null;
create index if not exists investigation_items_cancelled_by_idx
  on jmc.investigation_order_items (cancelled_by) where cancelled_by is not null;

comment on table jmc.investigation_order_items is
  'One requested investigation or referral. Carries patient_id so that both composite foreign keys — up to the order and down from the result — make a cross-patient attachment unstorable.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. THE REPORT THAT CAME BACK
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── THE FLAG, WHICH IS OWNER ITEM 85 IN TWO COLUMN PAIRS ───────────────────
--
-- Item 85 allows a flag from exactly three places, and the first two are
-- transcription while the third is a clinical act. So there are two flags on
-- this row and not one:
--
--   source_flag    what the report itself said, or what an identified
--                  structured feed carried. A nurse or an administrator may
--                  write this down — that is transcription, and item 85 permits
--                  it — and `source_flag_reference` records the provenance
--                  without which it would just be somebody's opinion.
--   doctor_flag    an authorized doctor's own clinical judgment, with a
--                  reason. Only a doctor writes this.
--
-- Two columns rather than one, because the alternative is a doctor raising a
-- laboratory's `abnormal` to `critical` by overwriting it — and afterwards
-- nobody can say what the laboratory reported. A clinical record where the
-- doctor's judgment has erased the source's is a record that cannot be
-- defended.
--
-- `effective_flag` is a STORED GENERATED column, and it is generated rather
-- than computed anywhere in the application deliberately: it is the more
-- severe of two flags that both have authors, which is the only operation on
-- a flag this application is allowed to perform. There is no branch anywhere
-- that reads a number, a range or a word and decides something is abnormal.
--
-- ── A CORRECTION APPENDS ───────────────────────────────────────────────────
--
-- A corrected report is a new row that supersedes the old one. The old row
-- keeps its text, its flag, its documents and its review; it simply stops
-- being current. The partial unique index is what makes "current" a fact
-- rather than a convention, and it forces the order of a correction — stamp
-- the old one superseded, then insert the new — which is why `superseded_at`
-- is required and `superseded_by_result_id` is filled a line later. The same
-- ordering problem `communication_schedules` has, for the same reason.
--
-- Because a review belongs to a result ID and a correction is a new result ID,
-- **a correction cannot inherit a review.** That is not a rule the code
-- remembers to apply; it is the shape of the tables.
create table if not exists jmc.investigation_results (
  id text primary key,
  order_item_id text not null references jmc.investigation_order_items(id),
  patient_id text not null references jmc.patients(id),

  received_at timestamptz not null default now(),
  recorded_by text not null references jmc.staff(id),

  source text not null check (source in (
    'external_laboratory', 'external_facility', 'imported_structured_feed', 'clinic_recorded'
  )),
  source_reference text not null default '',
  reported_at timestamptz,

  -- The report as it arrived. Free text and documents, and deliberately no
  -- analyte, value, unit or reference range: see the header of this file.
  report_text text not null default '',

  -- ── item 85, first pair: what the source said ──
  source_flag text not null default 'none'
    check (source_flag in ('none', 'abnormal', 'urgent', 'critical')),
  source_flag_origin text not null default 'none'
    check (source_flag_origin in ('none', 'external_report', 'imported_structured')),
  source_flag_reference text not null default '',
  source_flag_recorded_by text references jmc.staff(id),
  source_flag_recorded_at timestamptz,

  -- ── item 85, second pair: what an authorized doctor decided ──
  doctor_flag text not null default 'none'
    check (doctor_flag in ('none', 'abnormal', 'urgent', 'critical')),
  doctor_flag_by text references jmc.staff(id),
  doctor_flag_at timestamptz,
  doctor_flag_reason text not null default '',

  effective_flag text generated always as (
    case
      when source_flag = 'critical' or doctor_flag = 'critical' then 'critical'
      when source_flag = 'urgent' or doctor_flag = 'urgent' then 'urgent'
      when source_flag = 'abnormal' or doctor_flag = 'abnormal' then 'abnormal'
      else 'none'
    end
  ) stored,

  -- Item 86. The laboratory's own technical validation is retained, and it
  -- lives in columns that cannot be mistaken for the clinic's clinical review
  -- — different names, different table for the review, and no staff foreign
  -- key here because the person who signed the report does not work here.
  external_validated_by text not null default '',
  external_validated_at timestamptz,
  external_signatory_reference text not null default '',

  -- ── correction ──
  supersedes_result_id text references jmc.investigation_results(id),
  correction_reason text not null default '',
  superseded_at timestamptz,
  superseded_by_result_id text references jmc.investigation_results(id),

  -- ── item 87's acknowledgement ──
  critical_acknowledged_by text references jmc.staff(id),
  critical_acknowledged_at timestamptz,
  critical_acknowledgement_note text not null default '',

  -- ── item 88. Authorization is a separate act from review, and both are
  --    separate from anything the patient was actually told. ──
  notification_authorized_by text references jmc.staff(id),
  notification_authorized_at timestamptz,
  notification_schedule_id text references jmc.communication_schedules(id),

  patient_contacted_by text references jmc.staff(id),
  patient_contacted_at timestamptz,
  patient_contact_method text not null default ''
    check (patient_contact_method in ('', 'telephone', 'in_person', 'other')),
  patient_contact_note text not null default '',

  idempotency_key text,
  request_fingerprint text,
  created_at timestamptz not null default now(),

  unique (id, patient_id),

  check ((source_flag = 'none') = (source_flag_origin = 'none')),
  check ((source_flag_origin = 'none') = (source_flag_recorded_at is null)),
  check ((source_flag_recorded_at is null) = (source_flag_recorded_by is null)),
  -- "with its source and provenance recorded" — item 85. A transcribed flag
  -- with nothing to trace it to is the thing item 85 exists to forbid.
  check (source_flag_origin = 'none' or length(trim(source_flag_reference)) > 0),

  check ((doctor_flag = 'none') = (doctor_flag_at is null)),
  check ((doctor_flag_at is null) = (doctor_flag_by is null)),
  check (doctor_flag = 'none' or length(trim(doctor_flag_reason)) > 0),

  check ((supersedes_result_id is null) = (length(trim(correction_reason)) = 0)),
  check (superseded_by_result_id is null or superseded_at is not null),
  check (superseded_by_result_id is distinct from id),
  check (supersedes_result_id is distinct from id),

  check ((critical_acknowledged_at is null) = (critical_acknowledged_by is null)),
  check (critical_acknowledged_at is null
         or source_flag = 'critical' or doctor_flag = 'critical'),

  check ((notification_authorized_at is null) = (notification_authorized_by is null)),
  check (notification_schedule_id is null or notification_authorized_at is not null),
  -- Item 88: "Critical-result communication is clinician-led direct contact,
  -- not an automated generic message." A critical result cannot hold an
  -- authorization for the automated path at all, so there is no code path,
  -- present or future, that can put one onto the generic channel.
  check (notification_authorized_at is null
         or (source_flag <> 'critical' and doctor_flag <> 'critical')),

  check ((patient_contacted_at is null) = (patient_contacted_by is null)),
  check ((patient_contacted_at is null) = (length(patient_contact_method) = 0)),

  check (idempotency_key is null or request_fingerprint is not null)
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'investigation_results_item_is_this_patients'
                    and conrelid = 'jmc.investigation_results'::regclass) then
    alter table jmc.investigation_results
      add constraint investigation_results_item_is_this_patients
      foreign key (order_item_id, patient_id)
      references jmc.investigation_order_items (id, patient_id);
  end if;

  -- A correction of another patient's result is not a correction.
  if not exists (select 1 from pg_constraint
                  where conname = 'investigation_results_correction_is_this_patients'
                    and conrelid = 'jmc.investigation_results'::regclass) then
    alter table jmc.investigation_results
      add constraint investigation_results_correction_is_this_patients
      foreign key (supersedes_result_id, patient_id)
      references jmc.investigation_results (id, patient_id);
  end if;
end $$;

-- One current result per requested item. This is what "current" means, and it
-- is also what forces a correction to stamp the old row before inserting the
-- new one.
create unique index if not exists investigation_results_current
  on jmc.investigation_results (order_item_id)
  where superseded_at is null;

-- A result is corrected by at most one successor. Two concurrent corrections
-- of one report meet this index rather than each other.
create unique index if not exists investigation_results_one_correction
  on jmc.investigation_results (supersedes_result_id)
  where supersedes_result_id is not null;

create unique index if not exists investigation_results_idempotency
  on jmc.investigation_results (idempotency_key)
  where idempotency_key is not null;

create index if not exists investigation_results_item
  on jmc.investigation_results (order_item_id, received_at desc);
create index if not exists investigation_results_item_patient_idx
  on jmc.investigation_results (order_item_id, patient_id);
create index if not exists investigation_results_patient
  on jmc.investigation_results (patient_id, received_at desc);
create index if not exists investigation_results_recorded_by_idx
  on jmc.investigation_results (recorded_by);
create index if not exists investigation_results_flag_recorded_by_idx
  on jmc.investigation_results (source_flag_recorded_by) where source_flag_recorded_by is not null;
create index if not exists investigation_results_doctor_flag_by_idx
  on jmc.investigation_results (doctor_flag_by) where doctor_flag_by is not null;
create index if not exists investigation_results_superseded_by_idx
  on jmc.investigation_results (superseded_by_result_id) where superseded_by_result_id is not null;
-- Both columns of the correction's composite foreign key, in its order. The
-- single-column index above `investigation_results_one_correction` covers the
-- supersession pointer; a composite key needs its own columns as a leading
-- prefix or the parent's every update walks the table, and
-- `slice3-gate.test.mjs` fails a foreign key that has no such index rather
-- than leaving it to be noticed under load.
create index if not exists investigation_results_correction_patient_idx
  on jmc.investigation_results (supersedes_result_id, patient_id)
  where supersedes_result_id is not null;
create index if not exists investigation_results_ack_by_idx
  on jmc.investigation_results (critical_acknowledged_by) where critical_acknowledged_by is not null;
create index if not exists investigation_results_authorized_by_idx
  on jmc.investigation_results (notification_authorized_by) where notification_authorized_by is not null;
create index if not exists investigation_results_schedule_idx
  on jmc.investigation_results (notification_schedule_id) where notification_schedule_id is not null;
create index if not exists investigation_results_contacted_by_idx
  on jmc.investigation_results (patient_contacted_by) where patient_contacted_by is not null;

-- The two queues owner item 87 needs: everything current and unreviewed, and
-- everything current, critical and unacknowledged.
create index if not exists investigation_results_awaiting_review
  on jmc.investigation_results (received_at)
  where superseded_at is null;
create index if not exists investigation_results_critical_open
  on jmc.investigation_results (received_at)
  where superseded_at is null and critical_acknowledged_at is null
    and (source_flag = 'critical' or doctor_flag = 'critical');

comment on table jmc.investigation_results is
  'Owner items 85 to 88. The report as it arrived. Two flag pairs, one per permitted origin, and an effective_flag the DATABASE derives as the more severe of them — no application code infers abnormality. A correction is a new row; the old one keeps everything including its review.';

comment on column jmc.investigation_results.effective_flag is
  'Generated. The more severe of the transcribed source flag and the authorized doctor flag. Generated rather than computed in code so that the only operation this application performs on a flag is visible in the schema.';

comment on column jmc.investigation_results.external_validated_by is
  'The external laboratory''s own technical validation. Evidence, retained, and NOT clinic clinical review — owner item 86. No staff foreign key, because this person does not work here.';

/*
 * What may change on a result after it exists, and what may not.
 *
 * Everything about the REPORT is written once: its text, its source, its
 * provenance, its external validation, and the correction relationship that
 * brought it into being. A corrected report is a new row.
 *
 * What may be added afterwards is what people then DO about it — a flag from
 * each of the two permitted origins, each write-once; an acknowledgement; an
 * authorization; a telephone call. None of them may be taken back, because
 * each one is somebody's name against a clinical act, and an act that can be
 * un-recorded is not evidence.
 *
 * The one thing this trigger does that a check constraint cannot: it refuses a
 * notification authorization unless a review of THIS result exists. That is
 * owner item 88's "requires completed doctor review" as an invariant the
 * database holds, rather than as a sentence in a command that a second caller
 * could one day be written around.
 */
create or replace function jmc.protect_investigation_result()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A result is a clinical record and is never deleted. Record a corrected report instead.';
  end if;

  if new.id is distinct from old.id
     or new.order_item_id is distinct from old.order_item_id
     or new.patient_id is distinct from old.patient_id
     or new.received_at is distinct from old.received_at
     or new.recorded_by is distinct from old.recorded_by
     or new.source is distinct from old.source
     or new.source_reference is distinct from old.source_reference
     or new.reported_at is distinct from old.reported_at
     or new.report_text is distinct from old.report_text
     or new.external_validated_by is distinct from old.external_validated_by
     or new.external_validated_at is distinct from old.external_validated_at
     or new.external_signatory_reference is distinct from old.external_signatory_reference
     or new.supersedes_result_id is distinct from old.supersedes_result_id
     or new.correction_reason is distinct from old.correction_reason
     or new.created_at is distinct from old.created_at then
    raise exception
      'The report itself is written once. A corrected report is a new result that supersedes this '
      'one; it never overwrites it.';
  end if;

  if old.source_flag_origin <> 'none'
     and (new.source_flag is distinct from old.source_flag
          or new.source_flag_origin is distinct from old.source_flag_origin
          or new.source_flag_reference is distinct from old.source_flag_reference
          or new.source_flag_recorded_by is distinct from old.source_flag_recorded_by
          or new.source_flag_recorded_at is distinct from old.source_flag_recorded_at) then
    raise exception
      'What the source reported is transcribed once. If the laboratory has changed its mind it '
      'issues a corrected report; if a doctor disagrees, that is their own flag.';
  end if;

  if old.doctor_flag <> 'none'
     and (new.doctor_flag is distinct from old.doctor_flag
          or new.doctor_flag_by is distinct from old.doctor_flag_by
          or new.doctor_flag_at is distinct from old.doctor_flag_at
          or new.doctor_flag_reason is distinct from old.doctor_flag_reason) then
    raise exception 'A doctor''s clinical flag is evidence and cannot be rewritten or withdrawn.';
  end if;

  if old.superseded_at is not null
     and (new.superseded_at is distinct from old.superseded_at
          or (old.superseded_by_result_id is not null
              and new.superseded_by_result_id is distinct from old.superseded_by_result_id)) then
    raise exception 'A superseded result stays superseded.';
  end if;

  if old.critical_acknowledged_at is not null
     and (new.critical_acknowledged_at is distinct from old.critical_acknowledged_at
          or new.critical_acknowledged_by is distinct from old.critical_acknowledged_by) then
    raise exception 'A critical result is acknowledged once, by name.';
  end if;

  if old.notification_authorized_at is not null
     and (new.notification_authorized_at is distinct from old.notification_authorized_at
          or new.notification_authorized_by is distinct from old.notification_authorized_by) then
    raise exception 'A notification authorization is evidence and cannot be rewritten.';
  end if;

  if old.patient_contacted_at is not null
     and (new.patient_contacted_at is distinct from old.patient_contacted_at
          or new.patient_contacted_by is distinct from old.patient_contacted_by) then
    raise exception 'A recorded contact with a patient cannot be un-recorded.';
  end if;

  -- Owner item 88, held by the database rather than by a command.
  if new.notification_authorized_at is not null and old.notification_authorized_at is null then
    if new.superseded_at is not null then
      raise exception
        'This report has been superseded by a corrected one. The correction needs its own review '
        'and its own authorization.';
    end if;
    if not exists (select 1 from result_reviews where result_id = new.id) then
      raise exception
        'A patient may not be told a result is ready before a doctor has clinically reviewed it. '
        'Owner policy item 86.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists investigation_results_append_only on jmc.investigation_results;
create trigger investigation_results_append_only
before update or delete on jmc.investigation_results
for each row execute function jmc.protect_investigation_result();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE DOCUMENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The PDF the laboratory emailed, or the photograph of the paper report the
-- front desk scanned. Private object storage, reached only through an
-- authenticated Edge Function and a sixty-second single-purpose ticket, the
-- same way a clinical photograph is reached.
--
-- ── WHAT IT DELIBERATELY DOES NOT REUSE ────────────────────────────────────
--
-- `clinical_images` and its consent model. A photograph of a wound is taken by
-- this clinic, of this patient, with a consent recorded before the shutter —
-- because taking it is an act performed on somebody. A laboratory report is a
-- document about a patient that the clinic RECEIVES; there is no shutter and
-- no moment to consent to, and asking a front-desk clerk to record a
-- photography consent before filing a PDF would teach everybody that the
-- consent screen is a formality. Owner item 27's semantics belong to
-- photographs and are not borrowed here.
--
-- ── THERE IS NO URL COLUMN, AND THERE NEVER WILL BE ────────────────────────
--
-- Not a public one, not a signed one, not an expiring one. The storage key is
-- an internal name that only the Edge Function resolves; a URL in a row is a
-- URL in a backup, in a log, in a screenshot and in a support thread.
create table if not exists jmc.result_documents (
  id text primary key,
  result_id text not null references jmc.investigation_results(id),
  patient_id text not null references jmc.patients(id),

  storage_key text not null unique,
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png'
  )),
  byte_size integer not null check (byte_size > 0),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),

  source text not null check (source in (
    'external_laboratory', 'external_facility', 'clinic_scanned', 'imported_structured_feed'
  )),
  source_reference text not null default '',
  original_filename text not null default '',

  uploaded_by text not null references jmc.staff(id),
  uploaded_at timestamptz not null default now(),

  supersedes_document_id text references jmc.result_documents(id),
  superseded_at timestamptz,
  superseded_by_document_id text references jmc.result_documents(id),
  status text not null default 'active' check (status in ('active', 'superseded')),

  idempotency_key text,
  request_fingerprint text,

  unique (id, patient_id),
  check ((status = 'superseded') = (superseded_at is not null)),
  check (superseded_by_document_id is null or superseded_at is not null),
  check (superseded_by_document_id is distinct from id),
  check (supersedes_document_id is distinct from id),
  check (idempotency_key is null or request_fingerprint is not null)
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'result_documents_result_is_this_patients'
                    and conrelid = 'jmc.result_documents'::regclass) then
    alter table jmc.result_documents
      add constraint result_documents_result_is_this_patients
      foreign key (result_id, patient_id)
      references jmc.investigation_results (id, patient_id);
  end if;
end $$;

-- The same bytes filed twice against one report is somebody pressing Upload
-- again after a lost reply, not a second document. The checksum says so
-- without anybody having to decide.
create unique index if not exists result_documents_one_copy
  on jmc.result_documents (result_id, checksum);

create unique index if not exists result_documents_idempotency
  on jmc.result_documents (idempotency_key)
  where idempotency_key is not null;

create index if not exists result_documents_result
  on jmc.result_documents (result_id, uploaded_at desc);
create index if not exists result_documents_result_patient_idx
  on jmc.result_documents (result_id, patient_id);
create index if not exists result_documents_patient
  on jmc.result_documents (patient_id, uploaded_at desc);
create index if not exists result_documents_uploaded_by_idx
  on jmc.result_documents (uploaded_by);
create index if not exists result_documents_supersedes_idx
  on jmc.result_documents (supersedes_document_id) where supersedes_document_id is not null;
create index if not exists result_documents_superseded_by_idx
  on jmc.result_documents (superseded_by_document_id) where superseded_by_document_id is not null;

comment on table jmc.result_documents is
  'The report as a file, in private object storage. Object identity, media type, size, checksum, provenance, uploader and supersession. There is no URL column, by design.';

create or replace function jmc.protect_result_document()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A result document is a clinical record. Supersede it with a corrected one.';
  end if;

  if new.id is distinct from old.id
     or new.result_id is distinct from old.result_id
     or new.patient_id is distinct from old.patient_id
     or new.storage_key is distinct from old.storage_key
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.checksum is distinct from old.checksum
     or new.source is distinct from old.source
     or new.source_reference is distinct from old.source_reference
     or new.uploaded_by is distinct from old.uploaded_by
     or new.uploaded_at is distinct from old.uploaded_at
     or new.supersedes_document_id is distinct from old.supersedes_document_id then
    raise exception 'A stored document is what it is. Only its supersession may be recorded.';
  end if;

  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'A superseded document stays superseded.';
  end if;

  return new;
end;
$$;

drop trigger if exists result_documents_append_only on jmc.result_documents;
create trigger result_documents_append_only
before update or delete on jmc.result_documents
for each row execute function jmc.protect_result_document();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. THE REVIEW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner item 86. One row, one doctor, one result, and `unique (result_id)`.
--
-- That index does three jobs at once, and each of them would otherwise be a
-- paragraph of code:
--
--   1. Two doctors opening the same report and both pressing Review produce
--      one review. The loser meets a constraint and is told who got there
--      first, rather than the record acquiring two opinions with no order
--      between them.
--   2. A correction cannot inherit a review, because a corrected report is a
--      different `result_id` and this table has nothing for it.
--   3. A review cannot be edited into a different review, because the trigger
--      below refuses an update and the index refuses a second row.
--
-- `basis` names WHICH authority the reviewer held, and it is recorded rather
-- than derived at read time, because who was responsible for a patient in
-- September is not a question a query in March should be answering.
create table if not exists jmc.result_reviews (
  id text primary key,
  result_id text not null references jmc.investigation_results(id),
  patient_id text not null references jmc.patients(id),

  reviewed_by text not null references jmc.staff(id),
  reviewed_at timestamptz not null default now(),
  basis text not null check (basis in (
    'responsible_doctor', 'ordering_doctor', 'delegated_doctor'
  )),
  conclusion text not null check (conclusion in (
    'no_action_needed', 'patient_to_be_informed', 'clinical_action_taken'
  )),
  note text not null default '',

  unique (result_id),
  unique (id, patient_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'result_reviews_result_is_this_patients'
                    and conrelid = 'jmc.result_reviews'::regclass) then
    alter table jmc.result_reviews
      add constraint result_reviews_result_is_this_patients
      foreign key (result_id, patient_id)
      references jmc.investigation_results (id, patient_id);
  end if;
end $$;

create index if not exists result_reviews_result_patient_idx
  on jmc.result_reviews (result_id, patient_id);
create index if not exists result_reviews_patient
  on jmc.result_reviews (patient_id, reviewed_at desc);
create index if not exists result_reviews_by_idx
  on jmc.result_reviews (reviewed_by, reviewed_at desc);

comment on table jmc.result_reviews is
  'Owner item 86. One clinical review per result, by the responsible, ordering or explicitly delegated doctor. A corrected report is a new result and therefore has no review until somebody writes one.';

create or replace function jmc.protect_result_review()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  raise exception
    'A clinical review is evidence and is never edited or deleted. A corrected report gets its own '
    'review.';
end;
$$;

drop trigger if exists result_reviews_append_only on jmc.result_reviews;
create trigger result_reviews_append_only
before update or delete on jmc.result_reviews
for each row execute function jmc.protect_result_review();


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. ACCESS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The posture `20260909125237_harden_active_clinic.sql` set and every slice
-- since has kept: row security on, forced nowhere, every privilege revoked
-- from the Data API's roles, so `jmc` is reachable only through the Edge
-- Functions' own connection. `slice3-gate.test.mjs` and `slice6-gate.test.mjs`
-- walk `pg_class` rather than a list, so a table left out of this block fails
-- a test rather than leaving a quiet hole.
--
-- These six hold a patient's laboratory reports. Owner item 86 puts the
-- pharmacy outside them entirely, and that boundary is enforced in the command
-- and read layer; this block is the reason a mistake there is not also an
-- open door on the internet.
do $$
declare t text;
begin
  foreach t in array array[
    'investigation_catalogue', 'investigation_orders', 'investigation_order_items',
    'investigation_results', 'result_documents', 'result_reviews'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

revoke all on sequence jmc.investigation_order_seq
  from public, anon, authenticated, service_role;
