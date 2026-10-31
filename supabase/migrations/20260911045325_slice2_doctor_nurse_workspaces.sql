-- Slice 2: the doctor and nurse workspaces.
--
-- The old model stores a finished consultation in three broad rows:
-- encounters, a JSON-only prescription, and (sometimes) a bill. This migration
-- keeps those rows readable while adding the records needed for a safe working
-- draft, exact signed medicine lines, follow-up, printing, templates and the
-- observation handoff. Nothing here changes stock or payment behaviour.
--
-- Every object is schema-qualified. Older migrations depend on a transaction
-- making `set local search_path` effective; new work does not repeat that trap.

alter table jmc.staff
  add column if not exists can_publish_clinical_templates integer not null default 0
  check (can_publish_clinical_templates in (0, 1));

-- In the current clinic the owner account is the doctor+admin account. This
-- compatibility backfill gives that existing account the publishing authority;
-- after this, the flag is managed explicitly and is never inferred from admin.
update jmc.staff
   set can_publish_clinical_templates = 1
 where roles_json::jsonb ? 'doctor'
   and roles_json::jsonb ? 'admin';

alter table jmc.medicines
  add column if not exists generic_name text not null default '',
  add column if not exists route text not null default '';

alter table jmc.encounters
  add column if not exists complaint text not null default '',
  add column if not exists complaint_duration_value integer,
  add column if not exists complaint_duration_unit text,
  add column if not exists examination text not null default '',
  add column if not exists diagnosis_status text not null default 'unspecified',
  add column if not exists aetiology text not null default '',
  add column if not exists aetiology_certainty text not null default 'not_stated',
  add column if not exists follow_up_date date;

-- Everything else in this file is `if not exists`, and `add constraint` has no
-- such form. Without the guard the file claims to be re-runnable and is not:
-- applied a second time it stops here, on the constraint rather than on
-- anything that matters. See docs/operations/STAGING.md §3 for why this repository does
-- not assume how a migration will be applied.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'jmc.encounters'::regclass
                    and conname = 'encounters_complaint_duration_positive') then
    alter table jmc.encounters
      add constraint encounters_complaint_duration_positive
        check (complaint_duration_value is null or complaint_duration_value > 0),
      add constraint encounters_complaint_duration_unit_valid
        check (complaint_duration_unit is null or complaint_duration_unit in ('day', 'week', 'month')),
      add constraint encounters_diagnosis_status_valid
        check (diagnosis_status in ('unspecified', 'provisional', 'differential', 'confirmed')),
      add constraint encounters_aetiology_certainty_valid
        check (aetiology_certainty in ('not_stated', 'suspected', 'confirmed'));
  end if;
end $$;

create sequence if not exists jmc.prescription_number_seq start with 1;

alter table jmc.prescriptions
  add column if not exists prescription_number text;

with numbered as (
  select id, row_number() over (order by signed_at, id) as n
    from jmc.prescriptions
)
update jmc.prescriptions p
   set prescription_number = 'RX-' || lpad(numbered.n::text, 6, '0')
  from numbered
 where p.id = numbered.id
   and p.prescription_number is null;

select setval(
  'jmc.prescription_number_seq',
  greatest((select count(*) + 1 from jmc.prescriptions), 1),
  false
);

alter table jmc.prescriptions
  alter column prescription_number set default (
    'RX-' || lpad(nextval('jmc.prescription_number_seq')::text, 6, '0')
  ),
  alter column prescription_number set not null;

create unique index if not exists prescriptions_number_unique
  on jmc.prescriptions (prescription_number);

create table if not exists jmc.prescription_lines (
  id text primary key,
  prescription_id text not null references jmc.prescriptions(id),
  line_number integer not null check (line_number > 0),
  medicine_id text not null references jmc.medicines(id),
  medicine_name_snapshot text not null,
  generic_name_snapshot text not null default '',
  strength_snapshot text not null default '',
  dosage_form_snapshot text not null default '',
  route_snapshot text not null default '',
  medicine_code_snapshot text not null default '',
  dose_amount text not null default '',
  dose_unit text not null default '',
  frequency text not null default '',
  timing text not null default '',
  duration_value integer,
  duration_unit text,
  dosage_text text not null default '',
  instructions text not null default '',
  prescribed_quantity integer not null check (prescribed_quantity > 0),
  quantity_unit text not null,
  unique (prescription_id, line_number),
  check (duration_value is null or duration_value > 0),
  check (duration_unit is null or duration_unit in ('day', 'week', 'month'))
);

-- Preserve the old JSON exactly and build normalized signed lines beside it.
-- Historical dosage remains in dosage_text; structure is not guessed from a
-- string such as "1-0-1".
insert into jmc.prescription_lines (
  id, prescription_id, line_number, medicine_id,
  medicine_name_snapshot, generic_name_snapshot, strength_snapshot,
  dosage_form_snapshot, route_snapshot, medicine_code_snapshot,
  dosage_text, instructions, prescribed_quantity, quantity_unit
)
select
  p.id || ':line:' || item.ordinality::text,
  p.id,
  item.ordinality::integer,
  item.value->>'medicineId',
  coalesce(item.value->>'medicineName', m.name),
  coalesce(m.generic_name, ''),
  coalesce(m.strength, ''),
  coalesce(m.dosage_form, ''),
  coalesce(m.route, ''),
  coalesce(m.code, ''),
  coalesce(item.value->>'dosage', ''),
  coalesce(item.value->>'instructions', ''),
  greatest(coalesce((item.value->>'quantity')::integer, 1), 1),
  coalesce(nullif(m.unit, ''), 'unit')
from jmc.prescriptions p
cross join lateral jsonb_array_elements(p.items_json::jsonb) with ordinality item(value, ordinality)
join jmc.medicines m on m.id = item.value->>'medicineId'
on conflict (prescription_id, line_number) do nothing;

create index if not exists prescription_lines_prescription_idx
  on jmc.prescription_lines (prescription_id, line_number);
create index if not exists prescription_lines_medicine_idx
  on jmc.prescription_lines (medicine_id, prescription_id);

create table if not exists jmc.consultation_drafts (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  doctor_id text not null references jmc.staff(id),
  appointment_id text references jmc.appointments(id),
  complaint text not null default '',
  complaint_duration_value integer,
  complaint_duration_unit text,
  examination text not null default '',
  diagnosis text not null default '',
  diagnosis_status text not null default 'provisional',
  aetiology text not null default '',
  aetiology_certainty text not null default 'not_stated',
  notes text not null default '',
  advice text not null default '',
  follow_up_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, doctor_id),
  check (complaint_duration_value is null or complaint_duration_value > 0),
  check (complaint_duration_unit is null or complaint_duration_unit in ('day', 'week', 'month')),
  check (diagnosis_status in ('provisional', 'differential', 'confirmed')),
  check (aetiology_certainty in ('not_stated', 'suspected', 'confirmed'))
);

create index if not exists consultation_drafts_doctor_recent_idx
  on jmc.consultation_drafts (doctor_id, updated_at desc);
create index if not exists consultation_drafts_patient_idx
  on jmc.consultation_drafts (patient_id);
create index if not exists consultation_drafts_appointment_idx
  on jmc.consultation_drafts (appointment_id)
  where appointment_id is not null;

create table if not exists jmc.consultation_draft_lines (
  id text primary key,
  draft_id text not null references jmc.consultation_drafts(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  medicine_id text not null references jmc.medicines(id),
  dose_amount text not null default '',
  dose_unit text not null default '',
  frequency text not null default '',
  timing text not null default '',
  route text not null default '',
  duration_value integer,
  duration_unit text,
  dosage_text text not null default '',
  instructions text not null default '',
  prescribed_quantity integer not null check (prescribed_quantity > 0),
  unique (draft_id, line_number),
  check (duration_value is null or duration_value > 0),
  check (duration_unit is null or duration_unit in ('day', 'week', 'month'))
);

create index if not exists consultation_draft_lines_draft_idx
  on jmc.consultation_draft_lines (draft_id, line_number);
create index if not exists consultation_draft_lines_medicine_idx
  on jmc.consultation_draft_lines (medicine_id);

create table if not exists jmc.clinical_phrases (
  id text primary key,
  kind text not null check (kind in ('complaint', 'examination', 'diagnosis', 'instruction', 'advice')),
  display_text text not null,
  normalized_text text not null,
  source text not null default 'clinic',
  active integer not null default 1 check (active in (0, 1)),
  approved_by text not null references jmc.staff(id),
  approved_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (kind, normalized_text)
);

create index if not exists clinical_phrases_active_kind_idx
  on jmc.clinical_phrases (kind, normalized_text)
  where active = 1;
create index if not exists clinical_phrases_approved_by_idx
  on jmc.clinical_phrases (approved_by);

create table if not exists jmc.clinical_phrase_preferences (
  doctor_id text not null references jmc.staff(id),
  kind text not null check (kind in ('complaint', 'examination', 'diagnosis', 'instruction', 'advice')),
  display_text text not null,
  normalized_text text not null,
  favourite integer not null default 0 check (favourite in (0, 1)),
  use_count integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz,
  primary key (doctor_id, kind, normalized_text)
);

create index if not exists clinical_phrase_preferences_recent_idx
  on jmc.clinical_phrase_preferences (doctor_id, kind, last_used_at desc);
create index if not exists clinical_phrase_preferences_favourite_idx
  on jmc.clinical_phrase_preferences (doctor_id, kind, normalized_text)
  where favourite = 1;

create table if not exists jmc.consultation_templates (
  id text primary key,
  series_id text not null,
  version integer not null check (version > 0),
  scope text not null check (scope in ('personal', 'clinic')),
  owner_doctor_id text not null references jmc.staff(id),
  title text not null,
  complaint text not null default '',
  complaint_duration_value integer,
  complaint_duration_unit text,
  examination text not null default '',
  diagnosis text not null default '',
  diagnosis_status text not null default 'provisional',
  aetiology text not null default '',
  aetiology_certainty text not null default 'not_stated',
  notes text not null default '',
  advice text not null default '',
  follow_up_after_days integer,
  created_by text not null references jmc.staff(id),
  approved_by text references jmc.staff(id),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  supersedes_id text references jmc.consultation_templates(id),
  unique (series_id, version),
  check (complaint_duration_value is null or complaint_duration_value > 0),
  check (complaint_duration_unit is null or complaint_duration_unit in ('day', 'week', 'month')),
  check (diagnosis_status in ('provisional', 'differential', 'confirmed')),
  check (aetiology_certainty in ('not_stated', 'suspected', 'confirmed')),
  check (follow_up_after_days is null or follow_up_after_days >= 0),
  check ((scope = 'clinic' and approved_by is not null) or scope = 'personal')
);

create unique index if not exists consultation_templates_one_active_version
  on jmc.consultation_templates (series_id)
  where retired_at is null;
create index if not exists consultation_templates_personal_idx
  on jmc.consultation_templates (owner_doctor_id, created_at desc)
  where retired_at is null;
create index if not exists consultation_templates_clinic_idx
  on jmc.consultation_templates (created_at desc)
  where scope = 'clinic' and retired_at is null;
create index if not exists consultation_templates_created_by_idx
  on jmc.consultation_templates (created_by);
create index if not exists consultation_templates_approved_by_idx
  on jmc.consultation_templates (approved_by)
  where approved_by is not null;
create index if not exists consultation_templates_supersedes_idx
  on jmc.consultation_templates (supersedes_id)
  where supersedes_id is not null;

create table if not exists jmc.consultation_template_lines (
  id text primary key,
  template_version_id text not null references jmc.consultation_templates(id),
  line_number integer not null check (line_number > 0),
  medicine_id text not null references jmc.medicines(id),
  dose_amount text not null default '',
  dose_unit text not null default '',
  frequency text not null default '',
  timing text not null default '',
  route text not null default '',
  duration_value integer,
  duration_unit text,
  dosage_text text not null default '',
  instructions text not null default '',
  prescribed_quantity integer not null check (prescribed_quantity > 0),
  unique (template_version_id, line_number),
  check (duration_value is null or duration_value > 0),
  check (duration_unit is null or duration_unit in ('day', 'week', 'month'))
);

create index if not exists consultation_template_lines_template_idx
  on jmc.consultation_template_lines (template_version_id, line_number);
create index if not exists consultation_template_lines_medicine_idx
  on jmc.consultation_template_lines (medicine_id);

create table if not exists jmc.follow_ups (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  encounter_id text not null references jmc.encounters(id),
  doctor_id text not null references jmc.staff(id),
  due_date date not null,
  note text not null default '',
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text references jmc.staff(id),
  cancelled_at timestamptz,
  cancelled_by text references jmc.staff(id)
);

create index if not exists follow_ups_doctor_open_due_idx
  on jmc.follow_ups (doctor_id, due_date)
  where status = 'open';
create index if not exists follow_ups_patient_idx
  on jmc.follow_ups (patient_id, due_date desc);
create index if not exists follow_ups_encounter_idx
  on jmc.follow_ups (encounter_id);
create index if not exists follow_ups_completed_by_idx
  on jmc.follow_ups (completed_by)
  where completed_by is not null;
create index if not exists follow_ups_cancelled_by_idx
  on jmc.follow_ups (cancelled_by)
  where cancelled_by is not null;

create table if not exists jmc.prescription_prints (
  id text primary key,
  prescription_id text not null references jmc.prescriptions(id),
  printed_by text not null references jmc.staff(id),
  printed_at timestamptz not null default now(),
  copy_number integer not null check (copy_number > 0),
  unique (prescription_id, copy_number)
);

create index if not exists prescription_prints_prescription_idx
  on jmc.prescription_prints (prescription_id, printed_at);
create index if not exists prescription_prints_actor_idx
  on jmc.prescription_prints (printed_by, printed_at desc);

create table if not exists jmc.patient_clinical_profiles (
  patient_id text primary key references jmc.patients(id),
  allergy_status text not null default 'not_recorded'
    check (allergy_status in ('not_recorded', 'no_known', 'known')),
  allergy_notes text not null default '',
  clinical_flags text not null default '',
  updated_by text not null references jmc.staff(id),
  updated_at timestamptz not null default now(),
  check (allergy_status <> 'known' or length(trim(allergy_notes)) > 0)
);

create index if not exists patient_clinical_profiles_updated_by_idx
  on jmc.patient_clinical_profiles (updated_by);

create table if not exists jmc.vital_review_rules (
  id text primary key,
  metric text not null check (metric in ('systolic', 'diastolic', 'temperature', 'pulse', 'spo2', 'weight')),
  minimum_value numeric,
  maximum_value numeric,
  minimum_age integer not null default 0 check (minimum_age >= 0),
  maximum_age integer check (maximum_age is null or maximum_age >= minimum_age),
  prompt text not null default 'Review this reading',
  active integer not null default 1 check (active in (0, 1)),
  approved_by text not null references jmc.staff(id),
  approved_at timestamptz not null default now(),
  check (minimum_value is not null or maximum_value is not null),
  check (minimum_value is null or maximum_value is null or minimum_value <= maximum_value)
);

create index if not exists vital_review_rules_active_idx
  on jmc.vital_review_rules (metric, minimum_age, maximum_age)
  where active = 1;
create index if not exists vital_review_rules_approved_by_idx
  on jmc.vital_review_rules (approved_by);

alter table jmc.beds
  add column if not exists next_check_at timestamptz,
  add column if not exists doctor_instructions text not null default '',
  add column if not exists handoff_requested_at timestamptz,
  add column if not exists handoff_requested_by text references jmc.staff(id),
  add column if not exists handoff_resolved_at timestamptz,
  add column if not exists handoff_resolved_by text references jmc.staff(id);

create index if not exists beds_handoff_open_idx
  on jmc.beds (handoff_requested_at)
  where handoff_requested_at is not null and handoff_resolved_at is null;
create index if not exists beds_next_check_idx
  on jmc.beds (next_check_at)
  where status = 'occupied';
create index if not exists beds_handoff_requested_by_idx
  on jmc.beds (handoff_requested_by)
  where handoff_requested_by is not null;
create index if not exists beds_handoff_resolved_by_idx
  on jmc.beds (handoff_resolved_by)
  where handoff_resolved_by is not null;

create table if not exists jmc.observation_events (
  id text primary key,
  bed_id text not null references jmc.beds(id),
  patient_id text references jmc.patients(id),
  event_type text not null check (event_type in (
    'admitted', 'note', 'check_due', 'doctor_instruction',
    'handoff_requested', 'handoff_resolved', 'discharged', 'transferred'
  )),
  note text not null default '',
  next_check_at timestamptz,
  actor_id text not null references jmc.staff(id),
  created_at timestamptz not null default now()
);

create index if not exists observation_events_bed_recent_idx
  on jmc.observation_events (bed_id, created_at desc);
create index if not exists observation_events_patient_idx
  on jmc.observation_events (patient_id, created_at desc);
create index if not exists observation_events_actor_idx
  on jmc.observation_events (actor_id, created_at desc);

-- A prescription's clinical intent may never be changed after signing. The
-- legacy dispense marker is explicitly permitted until Slice 4 replaces it.
create or replace function jmc.protect_signed_prescription()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A signed prescription cannot be deleted.';
  end if;
  if new.id is distinct from old.id
     or new.patient_id is distinct from old.patient_id
     or new.encounter_id is distinct from old.encounter_id
     or new.doctor_id is distinct from old.doctor_id
     or new.items_json is distinct from old.items_json
     or new.signed_at is distinct from old.signed_at
     or new.prescription_number is distinct from old.prescription_number then
    raise exception 'A signed prescription cannot be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists prescriptions_signed_immutable on jmc.prescriptions;
create trigger prescriptions_signed_immutable
before update or delete on jmc.prescriptions
for each row execute function jmc.protect_signed_prescription();

create or replace function jmc.reject_signed_line_change()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  raise exception 'A signed prescription line cannot be changed.';
end;
$$;

drop trigger if exists prescription_lines_immutable on jmc.prescription_lines;
create trigger prescription_lines_immutable
before update or delete on jmc.prescription_lines
for each row execute function jmc.reject_signed_line_change();

-- Template versions are immutable clinical content. Retiring a version is the
-- sole allowed update; editing creates a new row and new line set.
create or replace function jmc.protect_template_version()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A clinical template version cannot be deleted; retire it.';
  end if;
  if new.id is distinct from old.id
     or new.series_id is distinct from old.series_id
     or new.version is distinct from old.version
     or new.scope is distinct from old.scope
     or new.owner_doctor_id is distinct from old.owner_doctor_id
     or new.title is distinct from old.title
     or new.complaint is distinct from old.complaint
     or new.complaint_duration_value is distinct from old.complaint_duration_value
     or new.complaint_duration_unit is distinct from old.complaint_duration_unit
     or new.examination is distinct from old.examination
     or new.diagnosis is distinct from old.diagnosis
     or new.diagnosis_status is distinct from old.diagnosis_status
     or new.aetiology is distinct from old.aetiology
     or new.aetiology_certainty is distinct from old.aetiology_certainty
     or new.notes is distinct from old.notes
     or new.advice is distinct from old.advice
     or new.follow_up_after_days is distinct from old.follow_up_after_days
     or new.created_by is distinct from old.created_by
     or new.approved_by is distinct from old.approved_by
     or new.created_at is distinct from old.created_at
     or new.supersedes_id is distinct from old.supersedes_id then
    raise exception 'A clinical template version cannot be changed; create a new version.';
  end if;
  return new;
end;
$$;

drop trigger if exists consultation_templates_versioned on jmc.consultation_templates;
create trigger consultation_templates_versioned
before update or delete on jmc.consultation_templates
for each row execute function jmc.protect_template_version();

drop trigger if exists consultation_template_lines_immutable on jmc.consultation_template_lines;
create trigger consultation_template_lines_immutable
before update or delete on jmc.consultation_template_lines
for each row execute function jmc.reject_signed_line_change();

-- These tables are reached only through authenticated Edge Functions using a
-- direct private database connection. They are not a second browser API.
alter table jmc.prescription_lines enable row level security;
alter table jmc.prescription_lines force row level security;
alter table jmc.consultation_drafts enable row level security;
alter table jmc.consultation_drafts force row level security;
alter table jmc.consultation_draft_lines enable row level security;
alter table jmc.consultation_draft_lines force row level security;
alter table jmc.clinical_phrases enable row level security;
alter table jmc.clinical_phrases force row level security;
alter table jmc.clinical_phrase_preferences enable row level security;
alter table jmc.clinical_phrase_preferences force row level security;
alter table jmc.consultation_templates enable row level security;
alter table jmc.consultation_templates force row level security;
alter table jmc.consultation_template_lines enable row level security;
alter table jmc.consultation_template_lines force row level security;
alter table jmc.follow_ups enable row level security;
alter table jmc.follow_ups force row level security;
alter table jmc.prescription_prints enable row level security;
alter table jmc.prescription_prints force row level security;
alter table jmc.patient_clinical_profiles enable row level security;
alter table jmc.patient_clinical_profiles force row level security;
alter table jmc.vital_review_rules enable row level security;
alter table jmc.vital_review_rules force row level security;
alter table jmc.observation_events enable row level security;
alter table jmc.observation_events force row level security;

revoke all on table
  jmc.prescription_lines,
  jmc.consultation_drafts,
  jmc.consultation_draft_lines,
  jmc.clinical_phrases,
  jmc.clinical_phrase_preferences,
  jmc.consultation_templates,
  jmc.consultation_template_lines,
  jmc.follow_ups,
  jmc.prescription_prints,
  jmc.patient_clinical_profiles,
  jmc.vital_review_rules,
  jmc.observation_events
from public, anon, authenticated, service_role;

revoke all on sequence jmc.prescription_number_seq
from public, anon, authenticated, service_role;

revoke all on function
  jmc.protect_signed_prescription(),
  jmc.reject_signed_line_change(),
  jmc.protect_template_version()
from public, anon, authenticated, service_role;
