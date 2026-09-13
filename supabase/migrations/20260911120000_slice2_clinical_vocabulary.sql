-- Slice 2: the approved English clinical vocabulary, as versioned clinic content.
--
-- `20260911045325_slice2_doctor_nurse_workspaces.sql` built the table the
-- doctor's autocomplete reads. It shipped empty, so the only wording in it came
-- from `scripts/staging/fixtures.mjs` — eleven phrases that exist to prove the
-- plumbing and that no owner ever approved. A clinic-wide suggestion list a
-- developer wrote into a fixture file is exactly what
-- docs/reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md §1.3 says must not happen:
-- preloaded clinical content is safe only when it is versioned and
-- clinician-reviewed.
--
-- This migration carries the four starter lists the owner approved — complaint,
-- assessment, dosage-direction and advice. The wording is transcribed verbatim
-- from `archive/docs/current-programme/SLICE3_CLINIC_APPROVAL_PACK.md` §7.A–D, which §8.C of that document
-- and OWNER_POLICY_REGISTER.md A.5 record as approved on 11 September 2026. It
-- is not re-worded here: what the doctor signed off is what the doctor sees.
-- The release id lets a later revision be a new release beside this one rather
-- than an edit over it (research document §2.4).
--
-- Three things this deliberately is not:
--
--   * It is not licensed terminology. Every phrase below is ordinary clinic
--     English prepared for this clinic and approved by its doctor. No SNOMED CT
--     concept, CDCI code or commercial catalogue row is copied here, because
--     the brief forbids redistributing licensed content before the
--     India/SNOMED/CDCI terms are confirmed, and §2.3 puts that in Phase 0.
--   * It is not decision support. These are typing shortcuts. Nothing here
--     links a complaint to a diagnosis or a diagnosis to a medicine, and
--     nothing is pre-selected for the doctor.
--   * It is not an examination-findings list. The owner approved four lists.
--     `examination` is a fifth kind the table allows and this release leaves
--     empty; inventing findings wording would be inventing clinical policy.
--
-- Every object is schema-qualified.

create table if not exists jmc.clinical_vocabulary_releases (
  id text primary key,
  version text not null unique,
  -- English only for the first release, per OWNER_POLICY_REGISTER.md §A.4.
  -- Widening this is an owner decision, so it is a later migration, not a
  -- value somebody can quietly insert.
  locale text not null default 'en' check (locale in ('en')),
  title text not null,
  source text not null,
  -- Where the approval is written down. The owner approved these lists in the
  -- policy register; on a fresh database there is no staff row to point a
  -- foreign key at, and inventing one would fake an approver.
  approval_reference text not null,
  approved_on date not null,
  published_at timestamptz not null default now(),
  retired_at timestamptz,
  notes text not null default ''
);

create index if not exists clinical_vocabulary_releases_active_idx
  on jmc.clinical_vocabulary_releases (published_at desc)
  where retired_at is null;

-- A phrase now carries its provenance: a release for clinic-wide approved
-- content, a staff member for anything a doctor publishes later. One or the
-- other must be present — an unattributed clinic-wide suggestion is the case
-- this constraint exists to make impossible.
alter table jmc.clinical_phrases
  add column if not exists release_id text references jmc.clinical_vocabulary_releases(id);

alter table jmc.clinical_phrases
  alter column approved_by drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'jmc.clinical_phrases'::regclass
                    and conname = 'clinical_phrases_provenance_present') then
    alter table jmc.clinical_phrases
      add constraint clinical_phrases_provenance_present
        check (approved_by is not null or release_id is not null);
  end if;
end $$;

create index if not exists clinical_phrases_release_idx
  on jmc.clinical_phrases (release_id)
  where release_id is not null;

-- Approved wording is not editable in place. Fixing a phrase is a new release;
-- withdrawing one is a retirement that leaves the row and its history behind.
-- Only `active` and `retired_at` may move.
create or replace function jmc.protect_approved_phrase()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An approved clinical phrase cannot be deleted; retire it.';
  end if;
  if new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.display_text is distinct from old.display_text
     or new.normalized_text is distinct from old.normalized_text
     or new.source is distinct from old.source
     or new.release_id is distinct from old.release_id
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'An approved clinical phrase cannot be reworded; publish a new one.';
  end if;
  return new;
end;
$$;

drop trigger if exists clinical_phrases_approved_immutable on jmc.clinical_phrases;
create trigger clinical_phrases_approved_immutable
before update or delete on jmc.clinical_phrases
for each row execute function jmc.protect_approved_phrase();

insert into jmc.clinical_vocabulary_releases
  (id, version, locale, title, source, approval_reference, approved_on, notes)
values (
  'cvr-en-2026-09',
  'en-2026.09',
  'en',
  'Jayamurugan Clinic starter vocabulary (English)',
  'clinic',
  'docs/SLICE3_CLINIC_APPROVAL_PACK.md 7.A-D, signed off in 8.C; OWNER_POLICY_REGISTER.md A.5',
  date '2026-09-11',
  'Twenty each of complaint, assessment, dosage direction and advice, transcribed verbatim from the approved pack. Clinic-prepared English; no licensed terminology. Examination findings are deliberately not included.'
)
on conflict (version) do nothing;

-- `normalized_text` must match what the Edge Functions compute at runtime —
-- `normalizedPhrase()` in `_shared/commands.ts` trims, lowercases and collapses
-- runs of whitespace. If the two ever disagree, the unique key stops catching
-- duplicates and the doctor sees the same wording twice.
insert into jmc.clinical_phrases
  (id, kind, display_text, normalized_text, source, active, release_id, approved_at)
select
  'cp-en-2026-09-' || seed.kind || '-' || lpad(seed.n::text, 2, '0'),
  seed.kind,
  seed.display_text,
  lower(regexp_replace(btrim(seed.display_text), '\s+', ' ', 'g')),
  'clinic_starter',
  1,
  'cvr-en-2026-09',
  timestamptz '2026-09-11 00:00:00+05:30'
from (values
  -- A. Presenting complaints. Ordinary words a patient uses at the desk,
  -- because this field records what was said, not what it turned out to be.
  ('complaint',  1, 'Fever'),
  ('complaint',  2, 'Cough'),
  ('complaint',  3, 'Runny or blocked nose'),
  ('complaint',  4, 'Sore throat'),
  ('complaint',  5, 'Headache'),
  ('complaint',  6, 'Body pain'),
  ('complaint',  7, 'Weakness or fatigue'),
  ('complaint',  8, 'Dizziness or giddiness'),
  ('complaint',  9, 'Breathlessness'),
  ('complaint', 10, 'Wheezing'),
  ('complaint', 11, 'Chest pain'),
  ('complaint', 12, 'Abdominal pain'),
  ('complaint', 13, 'Nausea or vomiting'),
  ('complaint', 14, 'Loose stools or diarrhoea'),
  ('complaint', 15, 'Heartburn or acidity'),
  ('complaint', 16, 'Back pain'),
  ('complaint', 17, 'Joint pain or swelling'),
  ('complaint', 18, 'Skin rash or itching'),
  ('complaint', 19, 'Burning urination or urinary frequency'),
  ('complaint', 20, 'Ear pain or discharge'),

  -- B. Assessments. The doctor chooses the verification status separately —
  -- provisional, differential or confirmed — so nothing here asserts
  -- certainty, and a symptom-based assessment stays available when no disease
  -- is established.
  ('diagnosis',  1, 'Acute upper respiratory tract infection'),
  ('diagnosis',  2, 'Acute viral febrile illness'),
  ('diagnosis',  3, 'Acute pharyngitis or tonsillitis'),
  ('diagnosis',  4, 'Allergic rhinitis'),
  ('diagnosis',  5, 'Acute bronchitis'),
  ('diagnosis',  6, 'Asthma'),
  ('diagnosis',  7, 'Chronic obstructive pulmonary disease'),
  ('diagnosis',  8, 'Hypertension'),
  ('diagnosis',  9, 'Type 2 diabetes mellitus'),
  ('diagnosis', 10, 'Dyspepsia or gastritis'),
  ('diagnosis', 11, 'Gastro-oesophageal reflux disease'),
  ('diagnosis', 12, 'Acute gastroenteritis'),
  ('diagnosis', 13, 'Urinary tract infection'),
  ('diagnosis', 14, 'Anaemia'),
  ('diagnosis', 15, 'Migraine'),
  ('diagnosis', 16, 'Peripheral vertigo'),
  ('diagnosis', 17, 'Non-specific low back or musculoskeletal pain'),
  ('diagnosis', 18, 'Osteoarthritis'),
  ('diagnosis', 19, 'Dermatitis'),
  ('diagnosis', 20, 'Superficial fungal infection'),

  -- C. Dosage-direction chips. Reusable pieces the doctor combines and reviews
  -- before signing. The medicine, dose and quantity are the doctor's, and a
  -- direction is never attached because a diagnosis was selected.
  ('instruction',  1, 'Once daily'),
  ('instruction',  2, 'Twice daily'),
  ('instruction',  3, 'Three times daily'),
  ('instruction',  4, 'Four times daily'),
  ('instruction',  5, 'At bedtime'),
  ('instruction',  6, 'When required'),
  ('instruction',  7, 'Before food'),
  ('instruction',  8, 'With food'),
  ('instruction',  9, 'After food'),
  ('instruction', 10, 'Swallow whole'),
  ('instruction', 11, 'Do not crush or chew'),
  ('instruction', 12, 'Chew before swallowing'),
  ('instruction', 13, 'Dissolve or disperse in water before taking'),
  ('instruction', 14, 'Shake well before use'),
  ('instruction', 15, 'Measure with the supplied cup or syringe'),
  ('instruction', 16, 'Apply a thin layer to the affected area'),
  ('instruction', 17, 'For external use only'),
  ('instruction', 18, 'Avoid contact with the eyes and mouth'),
  ('instruction', 19, 'Rinse the mouth after inhalation'),
  ('instruction', 20, 'Complete the prescribed course'),

  -- D. Advice and follow-up, including the safety-netting wording. These are
  -- optional phrases the doctor chooses; they must not appear on every
  -- prescription and do not replace patient-specific counselling. Number 11
  -- keeps its blank deliberately — the field stays editable.
  ('advice',  1, 'Drink adequate fluids'),
  ('advice',  2, 'Rest and avoid strenuous activity until better'),
  ('advice',  3, 'Take a light diet as tolerated'),
  ('advice',  4, 'Avoid spicy or oily food until symptoms settle'),
  ('advice',  5, 'Monitor and record temperature'),
  ('advice',  6, 'Monitor blood pressure and bring the readings'),
  ('advice',  7, 'Monitor blood glucose and bring the readings'),
  ('advice',  8, 'Continue regular medicines unless specifically advised otherwise'),
  ('advice',  9, 'Complete the requested tests before review'),
  ('advice', 10, 'Bring previous reports and current medicines at review'),
  ('advice', 11, 'Return for review in ___ days'),
  ('advice', 12, 'Return earlier if symptoms worsen'),
  ('advice', 13, 'Seek urgent care for difficulty breathing'),
  ('advice', 14, 'Seek urgent care for severe or persistent chest pain'),
  ('advice', 15, 'Seek urgent care for fainting, confusion, or unusual drowsiness'),
  ('advice', 16, 'Seek urgent care if unable to keep fluids down'),
  ('advice', 17, 'Seek urgent care for signs of dehydration or reduced urine'),
  ('advice', 18, 'Seek urgent care for blood in vomit, stool, or urine'),
  ('advice', 19, 'Keep the wound or affected area clean and dry'),
  ('advice', 20, 'Follow the diet and activity plan discussed')
) as seed(kind, n, display_text)
on conflict (kind, normalized_text) do nothing;

revoke all on table jmc.clinical_vocabulary_releases
from public, anon, authenticated, service_role;

revoke all on function jmc.protect_approved_phrase()
from public, anon, authenticated, service_role;

alter table jmc.clinical_vocabulary_releases enable row level security;
alter table jmc.clinical_vocabulary_releases force row level security;
