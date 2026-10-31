-- Slice 2.1: history that says "unknown" instead of guessing.
--
-- `npm run staging:rehearse` put the Slice 2 backfill in front of a clinic that
-- already had prescriptions, and it made two decisions nobody approved:
--
--   1. An item whose medicine row no longer exists produced NO normalized
--      line at all. The prescription kept the item in `items_json` and lost it
--      everywhere the application now looks. A line silently missing from a
--      signed prescription is worse than a line marked unreadable.
--
--   2. An item with a missing, zero or non-numeric quantity became quantity
--      **1**, because `prescribed_quantity` is `check (> 0)` and the backfill
--      used `greatest(coalesce(q, 1), 1)`. That is a clinical quantity the
--      clinic never wrote, and from Slice 4 it becomes the cap on what the
--      pharmacy may hand over. One tablet is not a safe default; it is a
--      different prescription.
--
-- This migration replaces both with an explicit unknown, and gives a doctor —
-- only a doctor — an append-only way to resolve it.
--
-- ── WHAT IS AND IS NOT REWRITTEN ───────────────────────────────────────────
--
-- The signed record is `prescriptions.items_json` plus the signed row, and
-- this migration does not touch either. `prescription_lines` is a derived
-- normalization of that record, introduced by Slice 2 and not yet deployed
-- anywhere; correcting a defect in how it was derived is not rewriting
-- clinical history, and the original JSON remains the thing it is derived
-- from. Resolutions are never written into the line either: they are separate
-- append-only rows, so the record always shows both what was signed and what
-- the doctor later determined.
--
-- Every object is schema-qualified.

-- ── 1. a line may now be honest about what it does not know ────────────────

alter table jmc.prescription_lines
  alter column medicine_id drop not null,
  alter column prescribed_quantity drop not null;

alter table jmc.prescription_lines
  add column if not exists medicine_state text not null default 'resolved',
  add column if not exists quantity_state text not null default 'recorded';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'jmc.prescription_lines'::regclass
                    and conname = 'prescription_lines_medicine_state_valid') then
    alter table jmc.prescription_lines
      add constraint prescription_lines_medicine_state_valid
        check (medicine_state in ('resolved', 'unresolved_legacy')),
      -- The state and the column cannot disagree. An `unresolved_legacy` line
      -- carrying a medicine id would be exactly the automatic reconnection
      -- this migration exists to refuse.
      add constraint prescription_lines_medicine_state_agrees
        check ((medicine_state = 'resolved') = (medicine_id is not null)),
      add constraint prescription_lines_quantity_state_valid
        check (quantity_state in ('recorded', 'unknown_legacy')),
      add constraint prescription_lines_quantity_state_agrees
        check ((quantity_state = 'recorded') = (prescribed_quantity is not null));
  end if;
end $$;

-- A newly signed line is unchanged: the command layer always supplies both, so
-- the column check `prescribed_quantity > 0` and the agreement checks above
-- still require a real medicine and a positive quantity. Only history may be
-- unknown, and only because it already was.

create index if not exists prescription_lines_needs_review_idx
  on jmc.prescription_lines (prescription_id)
  where medicine_state = 'unresolved_legacy' or quantity_state = 'unknown_legacy';

-- ── 2. undo the quantity the Slice 2 backfill invented ─────────────────────
--
-- Only lines whose own source item has no usable quantity are touched, so a
-- line signed through the application is never reached: `sign_consultation`
-- writes a positive integer into both the line and the JSON.
--
-- The immutability trigger has to come off for this, and that is the point at
-- which to be explicit: this is a migration correcting its own predecessor's
-- derivation, inside one transaction, on rows that have never reached a
-- clinic. It is not a runtime path. Nothing in the application can do this.

alter table jmc.prescription_lines disable trigger prescription_lines_immutable;

update jmc.prescription_lines l
   set prescribed_quantity = null,
       quantity_state = 'unknown_legacy'
  from jmc.prescriptions p
  cross join lateral jsonb_array_elements(p.items_json::jsonb)
       with ordinality item(value, ordinality)
 where l.prescription_id = p.id
   and l.line_number = item.ordinality
   and l.quantity_state = 'recorded'
   -- `is not true`, not `not (...)`. An item with no `quantity` key at all
   -- gives NULL here, `not NULL` is NULL, and a WHERE clause that is NULL
   -- does not match — so the one row that most needed correcting, the item
   -- written before quantity existed, would have kept its invented 1. That
   -- is the first thing the rehearsal caught.
   and (case
          when item.value->>'quantity' ~ '^[0-9]+$'
          then (item.value->>'quantity')::bigint between 1 and 2147483647
          else false
        end) is not true;

alter table jmc.prescription_lines enable trigger prescription_lines_immutable;

-- ── 3. build the lines Slice 2 dropped on the floor ────────────────────────
--
-- Same id scheme as the Slice 2 backfill, so this is idempotent and so a line
-- keeps its identity if both ever run. `left join` where Slice 2 used `join`:
-- that single word is the defect.

insert into jmc.prescription_lines (
  id, prescription_id, line_number, medicine_id,
  medicine_name_snapshot, generic_name_snapshot, strength_snapshot,
  dosage_form_snapshot, route_snapshot, medicine_code_snapshot,
  dosage_text, instructions, prescribed_quantity, quantity_unit,
  medicine_state, quantity_state
)
select
  p.id || ':line:' || item.ordinality::text,
  p.id,
  item.ordinality::integer,
  m.id,
  -- What the prescription said, which is what was printed and handed over.
  coalesce(nullif(item.value->>'medicineName', ''), m.name, 'Unrecorded medicine'),
  coalesce(m.generic_name, ''),
  coalesce(m.strength, ''),
  coalesce(m.dosage_form, ''),
  coalesce(m.route, ''),
  coalesce(m.code, ''),
  coalesce(item.value->>'dosage', ''),
  coalesce(item.value->>'instructions', ''),
  -- Nested CASE rather than `regex and cast`: `and` is not required to
  -- short-circuit, so a planner free to evaluate the cast first would fail
  -- the whole migration on the first item whose quantity reads "SOS".
  case when item.value->>'quantity' ~ '^[0-9]+$' then
    case when (item.value->>'quantity')::bigint between 1 and 2147483647
         then (item.value->>'quantity')::integer end
  end,
  -- With no medicine row there is no unit to state, and 'unit' would be a
  -- guess about how the thing was counted.
  coalesce(nullif(m.unit, ''), ''),
  case when m.id is null then 'unresolved_legacy' else 'resolved' end,
  case when item.value->>'quantity' ~ '^[0-9]+$'
        and (case when item.value->>'quantity' ~ '^[0-9]+$'
                  then (item.value->>'quantity')::bigint between 1 and 2147483647
                  else false end)
       then 'recorded' else 'unknown_legacy'
  end
from jmc.prescriptions p
cross join lateral jsonb_array_elements(p.items_json::jsonb)
     with ordinality item(value, ordinality)
left join jmc.medicines m on m.id = item.value->>'medicineId'
where not exists (
  select 1 from jmc.prescription_lines l
   where l.prescription_id = p.id and l.line_number = item.ordinality
)
on conflict (prescription_id, line_number) do nothing;

-- ── 4. the doctor's resolution, as events beside the line ──────────────────

create table if not exists jmc.prescription_line_resolutions (
  id text primary key,
  prescription_line_id text not null references jmc.prescription_lines(id),
  action text not null check (action in ('amend', 'cancel')),
  -- What the doctor determined. Null means this resolution did not speak to
  -- that part of the line.
  medicine_id text references jmc.medicines(id),
  prescribed_quantity integer check (prescribed_quantity is null or prescribed_quantity > 0),
  reason text not null check (length(trim(reason)) > 0),
  resolved_by text not null references jmc.staff(id),
  resolved_at timestamptz not null default now(),
  -- An amendment that determines nothing is not an amendment.
  check (action <> 'amend' or medicine_id is not null or prescribed_quantity is not null),
  -- A cancellation determines that the line is not to be supplied at all, so
  -- it carries no replacement.
  check (action <> 'cancel' or (medicine_id is null and prescribed_quantity is null))
);

create index if not exists prescription_line_resolutions_line_idx
  on jmc.prescription_line_resolutions (prescription_line_id, resolved_at desc, id desc);
create index if not exists prescription_line_resolutions_actor_idx
  on jmc.prescription_line_resolutions (resolved_by, resolved_at desc);
create index if not exists prescription_line_resolutions_medicine_idx
  on jmc.prescription_line_resolutions (medicine_id)
  where medicine_id is not null;

-- Append-only, like every other clinical record here. A wrong resolution is
-- corrected by recording another one, which leaves both visible.
drop trigger if exists prescription_line_resolutions_immutable
  on jmc.prescription_line_resolutions;
create trigger prescription_line_resolutions_immutable
before update or delete on jmc.prescription_line_resolutions
for each row execute function jmc.reject_signed_line_change();

-- ── 5. what the line means once resolutions are taken into account ─────────
--
-- `security_invoker` so this view is never a way around the row security on
-- the table underneath it. The brief is explicit that a view must not silently
-- bypass RLS.

create or replace view jmc.prescription_lines_effective
with (security_invoker = true) as
select
  l.*,
  coalesce(r.medicine_id, l.medicine_id) as effective_medicine_id,
  coalesce(r.prescribed_quantity, l.prescribed_quantity) as effective_quantity,
  coalesce(r.cancelled, false) as cancelled,
  (r.medicine_id is not null or r.prescribed_quantity is not null
     or coalesce(r.cancelled, false)) as resolved_by_doctor,
  (
    not coalesce(r.cancelled, false)
    and coalesce(r.medicine_id, l.medicine_id) is not null
    and coalesce(r.prescribed_quantity, l.prescribed_quantity) is not null
  ) as dispensable,
  (
    not coalesce(r.cancelled, false)
    and (coalesce(r.medicine_id, l.medicine_id) is null
      or coalesce(r.prescribed_quantity, l.prescribed_quantity) is null)
  ) as needs_review
from jmc.prescription_lines l
left join lateral (
  -- The most recent determination of each part, independently: a doctor may
  -- identify the medicine on Tuesday and confirm the quantity on Thursday, and
  -- neither answer should erase the other. `array_remove` keeps the ordering
  -- of `array_agg`, so element 1 is the latest non-null.
  select
    (array_remove(array_agg(x.medicine_id order by x.resolved_at desc, x.id desc), null))[1]
      as medicine_id,
    (array_remove(array_agg(x.prescribed_quantity order by x.resolved_at desc, x.id desc), null))[1]
      as prescribed_quantity,
    -- Cancellation is final. Reinstating a cancelled line means a new order.
    bool_or(x.action = 'cancel') as cancelled
  from jmc.prescription_line_resolutions x
  where x.prescription_line_id = l.id
) r on true;

-- ── 6. access, and the FORCE that would have emptied the clinic ────────────
--
-- Slice 2 put `force row level security` on its thirteen new tables. That was
-- wrong, and measurably so. `FORCE` removes the table owner's normal exemption
-- from row security; those tables have no policies, because there is no policy
-- to write. So an owner that does not additionally hold the `BYPASSRLS`
-- attribute reads **nothing** from them and writes **nothing** to them, with
-- no error at either end.
--
-- Measured on this schema before the change, as a NOSUPERUSER NOBYPASSRLS
-- owner, with a draft row present:
--
--     select count(*) from jmc.consultation_drafts;   -- 1 as superuser, 0 as owner
--     insert into jmc.consultation_drafts ...          -- INSERT 0 0
--
-- Against `jmc.patients`, which has RLS enabled and not forced, the same role
-- read its row normally. So the difference is FORCE, not the grants and not
-- the schema.
--
-- The clinic has not met this only because the Edge Functions currently
-- connect as a role that holds BYPASSRLS. That is a property of the deployment
-- nobody chose and nothing checks, and Slice 2 has never been deployed, so the
-- clinic would have met it on the first release: the doctor's drafts,
-- templates, follow-ups, prints, the observation timeline and the approved
-- vocabulary would all have been silently empty.
--
-- The tempting repair is a policy, and it is the wrong one. The application
-- reaches this database as a single identity; the database is never told which
-- staff member is acting. The only policy that restores access for one shared
-- identity is `using (true)`, which enforces nothing and merely makes the
-- schema look as though row security is doing work. Real per-row policies
-- would need an end-user identity carried into the session, which is a change
-- to how every request opens a transaction — a Slice 6 decision with the
-- owner, not something to bolt on beneath a data-loss fix.
--
-- So these tables return to the posture of the other twenty-nine: row security
-- **enabled**, never forced. What that buys is precise, and §7 of
-- docs/SCHEMA_AND_TYPES.md states it rather than implying it — every role that
-- is not the owner, the Data API's `anon`, `authenticated` and `service_role`
-- among them, holds no grant on `jmc` and is additionally stopped by RLS with
-- no policy. Authorization for staff is enforced in the authenticated Edge
-- Function boundary, which is the only layer that knows who is asking.

alter table jmc.prescription_lines            no force row level security;
alter table jmc.consultation_drafts           no force row level security;
alter table jmc.consultation_draft_lines      no force row level security;
alter table jmc.clinical_phrases              no force row level security;
alter table jmc.clinical_phrase_preferences   no force row level security;
alter table jmc.consultation_templates        no force row level security;
alter table jmc.consultation_template_lines   no force row level security;
alter table jmc.follow_ups                    no force row level security;
alter table jmc.prescription_prints           no force row level security;
alter table jmc.patient_clinical_profiles     no force row level security;
alter table jmc.vital_review_rules            no force row level security;
alter table jmc.observation_events            no force row level security;
alter table jmc.clinical_vocabulary_releases  no force row level security;

alter table jmc.prescription_line_resolutions enable row level security;

revoke all on table jmc.prescription_line_resolutions
from public, anon, authenticated, service_role;

revoke all on table jmc.prescription_lines_effective
from public, anon, authenticated, service_role;
