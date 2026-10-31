-- Slice 5: photographs of a patient, and who may ever see them.
--
-- This is the most dangerous feature in the application and the one with the
-- least forgiving failure mode. A stock figure that is wrong is a stock figure
-- that can be counted again. A clinical photograph shown to the wrong person
-- cannot be un-shown, and a photograph attached to the wrong patient is a
-- clinical error that will be believed.
--
-- So the schema is built around four questions, and every one of them is
-- answered by a row rather than by a convention:
--
--   WAS CONSENT GIVEN?      `image_consents`, before capture, naming the person
--                           who consented, how, for what, and who recorded it.
--   WHO MAY SEE THIS?       the doctor always; a nurse only while involved in
--                           that patient's care, which `nurse_care_involvement`
--                           derives from work the nurse actually did; the
--                           pharmacist never; an admin only through an explicit,
--                           expiring, reasoned grant.
--   WHAT HAPPENED TO IT?    `image_access_events` — every view, export and
--                           print, with the actor and the time.
--   WAS IT RIGHT?           an original is immutable. A wrong one is marked
--                           Captured in error with a reason and stays on the
--                           record; crops and annotations are separate derived
--                           objects and never overwrite it.
--
-- ── WHERE THE BYTES LIVE ───────────────────────────────────────────────────
--
-- Not here, and not anywhere a URL can reach. `storage_key` names an object in
-- private object storage; the bytes travel only through the authenticated
-- `images` Edge Function, which checks the questions above on every request.
-- There is no public bucket, no permanent URL, and nothing that a browser
-- history, a WhatsApp forward or a shared tablet can carry away.
--
-- Every object is schema-qualified.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. CONSENT, WHICH COMES FIRST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 27: recorded BEFORE capture, including the consenting
-- person, the method, the staff member, the time and the permitted purpose.
-- A consent that could be recorded afterwards is a consent that will be.

create table if not exists jmc.image_consents (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  -- Who actually consented: the patient, or a parent or guardian for a child.
  consenting_person text not null check (length(trim(consenting_person)) > 0),
  relationship text not null default 'self'
    check (relationship in ('self', 'parent', 'guardian', 'spouse', 'other')),
  method text not null check (method in ('verbal', 'written', 'digital')),
  -- What the photographs may be used for. Narrow by default.
  purpose text not null check (length(trim(purpose)) > 0),
  recorded_by text not null references jmc.staff(id),
  recorded_at timestamptz not null default now(),
  -- Consent can be withdrawn. What was already captured stays on the record;
  -- what the withdrawal stops is further capture and any export.
  withdrawn_at timestamptz,
  withdrawn_by text references jmc.staff(id),
  withdrawal_reason text not null default '',
  constraint image_consents_withdrawn_completely
    check ((withdrawn_at is null) = (withdrawn_by is null))
);

create index if not exists image_consents_patient_idx
  on jmc.image_consents (patient_id, recorded_at desc);
create index if not exists image_consents_recorded_by_idx on jmc.image_consents (recorded_by);
create index if not exists image_consents_withdrawn_by_idx on jmc.image_consents (withdrawn_by);
create index if not exists image_consents_live_idx on jmc.image_consents (patient_id)
  where withdrawn_at is null;

drop trigger if exists image_consents_immutable on jmc.image_consents;
create trigger image_consents_immutable
before delete on jmc.image_consents
for each row execute function jmc.reject_signed_line_change();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE IMAGE
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists jmc.clinical_images (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  /*
   * Captured only from an open patient/encounter context, which is the first
   * guard against the wrong-patient attachment. Nullable only because a
   * photograph taken during an observation on a bed has no encounter; it still
   * has a patient, and the command still requires one of the two.
   */
  encounter_id text references jmc.encounters(id),
  consent_id text not null references jmc.image_consents(id),

  category text not null check (category in ('before', 'progress', 'after', 'other')),
  -- A series ties Before to After for the same thing on the same person.
  series_key text not null default '',
  body_site text not null default '',
  side text not null default '' check (side in ('', 'left', 'right', 'bilateral', 'not_applicable')),
  caption text not null default '',

  -- Where the bytes are, in private storage. Never a URL.
  storage_key text not null unique,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0),
  -- SHA-256 of what was stored. An original that no longer hashes to this is
  -- not the original.
  checksum text not null check (length(checksum) = 64),

  status text not null default 'active'
    check (status in ('active', 'entered_in_error')),
  error_reason text not null default '',
  error_by text references jmc.staff(id),
  error_at timestamptz,

  captured_by text not null references jmc.staff(id),
  captured_at timestamptz not null default now(),

  constraint clinical_images_error_explained
    check ((status = 'entered_in_error')
           = (error_by is not null and error_at is not null and length(trim(error_reason)) > 0))
);

create index if not exists clinical_images_patient_idx
  on jmc.clinical_images (patient_id, captured_at desc);
create index if not exists clinical_images_encounter_idx on jmc.clinical_images (encounter_id);
create index if not exists clinical_images_consent_idx on jmc.clinical_images (consent_id);
create index if not exists clinical_images_captured_by_idx on jmc.clinical_images (captured_by);
create index if not exists clinical_images_error_by_idx on jmc.clinical_images (error_by);
create index if not exists clinical_images_series_idx on jmc.clinical_images (patient_id, series_key)
  where series_key <> '';
create index if not exists clinical_images_active_idx on jmc.clinical_images (patient_id)
  where status = 'active';

/*
 * The original is the original.
 *
 * Only the entered-in-error fields may ever change, and only from active to
 * in error — never back. Everything else about the row describes bytes that
 * are already in storage, and changing the description of an object is a way
 * of editing it without touching it: re-point `patient_id` and the photograph
 * belongs to somebody else, with nothing in the record to say it moved.
 */
create or replace function jmc.protect_clinical_image()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'A clinical image is never deleted. Mark it Captured in error, which keeps it and says who decided.';
  end if;

  if new.id is distinct from old.id
     or new.patient_id is distinct from old.patient_id
     or new.encounter_id is distinct from old.encounter_id
     or new.consent_id is distinct from old.consent_id
     or new.category is distinct from old.category
     or new.body_site is distinct from old.body_site
     or new.side is distinct from old.side
     or new.storage_key is distinct from old.storage_key
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.checksum is distinct from old.checksum
     or new.captured_by is distinct from old.captured_by
     or new.captured_at is distinct from old.captured_at then
    raise exception
      'A captured image cannot be re-described. Mark it Captured in error and capture another.';
  end if;

  if old.status = 'entered_in_error' and new.status <> 'entered_in_error' then
    raise exception 'An image marked Captured in error stays that way.';
  end if;

  return new;
end;
$$;

drop trigger if exists clinical_images_protected on jmc.clinical_images;
create trigger clinical_images_protected
before update or delete on jmc.clinical_images
for each row execute function jmc.protect_clinical_image();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. CROPS AND ANNOTATIONS, BESIDE THE ORIGINAL
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists jmc.image_derivatives (
  id text primary key,
  source_image_id text not null references jmc.clinical_images(id),
  kind text not null check (kind in ('crop', 'annotation', 'rotation')),
  -- What was done, as data: the crop rectangle, the annotation geometry. Kept
  -- so a derivative can be regenerated from the original rather than being the
  -- only copy of somebody's reading of it.
  parameters jsonb not null,
  storage_key text unique,
  content_type text not null default 'image/png',
  byte_size integer check (byte_size is null or byte_size > 0),
  checksum text check (checksum is null or length(checksum) = 64),
  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now()
);

create index if not exists image_derivatives_source_idx on jmc.image_derivatives (source_image_id);
create index if not exists image_derivatives_created_by_idx on jmc.image_derivatives (created_by);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. WHO MAY SEE IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 26. The doctor has full clinical access. A nurse may capture
-- and view only while involved in that patient's care. The pharmacist has
-- none. An admin sees the metadata and the audit, and reaches image content
-- only through an explicit grant.
--
-- "Involved in that patient's care" is derived from work the nurse actually
-- did rather than from a checkbox somebody ticks: vitals recorded, an
-- observation entered, a visit booked, or the patient in a bed right now. A
-- checkbox is a permission; this is a record.

create or replace view jmc.nurse_care_involvement
with (security_invoker = true) as
select distinct nurse_id, patient_id, involvement, since from (
  select v.recorded_by as nurse_id, v.patient_id, 'vitals'::text as involvement,
         v.recorded_at::timestamptz as since
    from jmc.vitals v
  union all
  select o.actor_id, coalesce(o.patient_id, b.patient_id), 'observation', o.created_at
    from jmc.observation_events o
    left join jmc.beds b on b.id = o.bed_id
   where coalesce(o.patient_id, b.patient_id) is not null
  union all
  -- Who booked the visit. `appointments` records no author, so the audit event
  -- it wrote is the only place the name survives — which is itself worth
  -- knowing, and is why this reads an audit row rather than a column.
  select e.actor_id, ap.patient_id, 'arrival', ap.created_at::timestamptz
    from jmc.appointments ap
    join jmc.audit_events e
      on e.entity_type = 'appointment' and e.entity_id = ap.id
     and e.action = 'appointment.created'
) involvement;

/*
 * An admin's way in, and it is deliberately narrow.
 *
 * Granted by a DOCTOR, for a named reason, with an expiry. Policy register 26
 * says an admin sees only the technical and audit metadata unless specifically
 * authorized; this is what "specifically authorized" is made of, and it runs
 * out on its own rather than depending on somebody remembering to revoke it.
 */
create table if not exists jmc.image_access_grants (
  id text primary key,
  -- One image, or every image of one patient. Nothing wider exists.
  image_id text references jmc.clinical_images(id),
  patient_id text references jmc.patients(id),
  staff_id text not null references jmc.staff(id),
  reason text not null check (length(trim(reason)) > 0),
  granted_by text not null references jmc.staff(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text references jmc.staff(id),
  constraint image_access_grants_scope
    check ((image_id is null) <> (patient_id is null)),
  constraint image_access_grants_expires_after_grant
    check (expires_at > granted_at),
  constraint image_access_grants_revoked_completely
    check ((revoked_at is null) = (revoked_by is null))
);

create index if not exists image_access_grants_staff_idx
  on jmc.image_access_grants (staff_id, expires_at desc);
create index if not exists image_access_grants_image_idx on jmc.image_access_grants (image_id);
create index if not exists image_access_grants_patient_idx on jmc.image_access_grants (patient_id);
create index if not exists image_access_grants_granted_by_idx on jmc.image_access_grants (granted_by);
create index if not exists image_access_grants_revoked_by_idx on jmc.image_access_grants (revoked_by);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. WHAT HAPPENED TO IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 28: audit access, export and printing. Append-only, because
-- an access log somebody can edit is not one.

create table if not exists jmc.image_access_events (
  id text primary key,
  image_id text not null references jmc.clinical_images(id),
  actor_id text not null references jmc.staff(id),
  action text not null check (action in ('view', 'thumbnail', 'export', 'print', 'refused')),
  -- Why the actor was allowed, or why they were not. 'doctor', 'nurse_care',
  -- 'grant:<id>', or the refusal.
  basis text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists image_access_events_image_idx
  on jmc.image_access_events (image_id, created_at desc);
create index if not exists image_access_events_actor_idx
  on jmc.image_access_events (actor_id, created_at desc);
create index if not exists image_access_events_refused_idx
  on jmc.image_access_events (created_at desc) where action = 'refused';

drop trigger if exists image_access_events_immutable on jmc.image_access_events;
create trigger image_access_events_immutable
before update or delete on jmc.image_access_events
for each row execute function jmc.reject_signed_line_change();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RETENTION, REVIEWED RATHER THAN PURGED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 29: three years after the patient's last relevant clinical
-- contact, or longer where treatment, complaint, legal hold or an applicable
-- rule requires it. At the boundary an admin review queue appears. Nothing is
-- purged automatically — the queue is the feature, and a scheduled delete is
-- exactly what the policy refuses.

create table if not exists jmc.image_retention_decisions (
  id text primary key,
  image_id text not null references jmc.clinical_images(id),
  decision text not null check (decision in ('keep', 'delete', 'legal_hold')),
  reason text not null check (length(trim(reason)) > 0),
  -- A deletion is a tombstone, not a disappearance: the row stays, the bytes
  -- go, and `purged_at` says when.
  purged_at timestamptz,
  decided_by text not null references jmc.staff(id),
  decided_at timestamptz not null default now(),
  review_due_at timestamptz
);

create index if not exists image_retention_decisions_image_idx
  on jmc.image_retention_decisions (image_id, decided_at desc);
create index if not exists image_retention_decisions_by_idx
  on jmc.image_retention_decisions (decided_by);

/*
 * The queue, three years after the patient's last clinical contact.
 *
 * "Last relevant clinical contact" is the latest of the patient's encounters,
 * vitals and images — not the image's own age. A photograph taken in year one
 * of a course of treatment that is still running has not aged out, and dating
 * the review from the photograph would say it had.
 */
create or replace view jmc.image_retention_queue
with (security_invoker = true) as
select
  i.id as image_id,
  i.patient_id,
  p.name as patient_name,
  i.captured_at,
  contact.last_contact,
  (contact.last_contact + interval '3 years') as review_due_at,
  d.decision as last_decision,
  d.reason as last_decision_reason
from jmc.clinical_images i
join jmc.patients p on p.id = i.patient_id
cross join lateral (
  select greatest(
    i.captured_at,
    coalesce((select max(e.created_at::timestamptz) from jmc.encounters e where e.patient_id = i.patient_id), i.captured_at),
    coalesce((select max(v.recorded_at::timestamptz) from jmc.vitals v where v.patient_id = i.patient_id), i.captured_at)
  ) as last_contact
) contact
left join lateral (
  select decision, reason from jmc.image_retention_decisions r
   where r.image_id = i.id order by r.decided_at desc limit 1
) d on true
where i.status = 'active'
  and (d.decision is null or d.decision <> 'legal_hold')
  and (contact.last_contact + interval '3 years') <= now();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ACCESS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'image_consents', 'clinical_images', 'image_derivatives',
    'image_access_grants', 'image_access_events', 'image_retention_decisions'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

revoke all on jmc.nurse_care_involvement, jmc.image_retention_queue
  from public, anon, authenticated, service_role;
