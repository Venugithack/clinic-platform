-- ═══════════════════════════════════════════════════════════════════════════
-- SLICE 3A: THE DURABLE FOUNDATION FOR REMINDERS, RECALLS AND DELIVERY TRUTH
--
-- Owner policy register items 76–83, approved 17 September 2026, closing
-- backend decision register entries D8 to D12c. This file adds the five tables
-- that programme's migration sequence names for Slice 3 and nothing else:
-- `message_templates`, `communication_consents`, `communication_schedules`,
-- `message_outbox`, `message_attempts`.
--
-- ── WHAT THIS SLICE DELIBERATELY DOES NOT DO ───────────────────────────────
--
-- It does not send anything. There is no provider network adapter here, no
-- webhook endpoint, no scheduler, no credential and no live call. The clinic's
-- existing `whatsapp_messages` log and its two callers — `send_order` and
-- `send_patient_whatsapp` — are untouched, answer exactly what they answered
-- yesterday, and are characterized by tests that were written before this file
-- existed.
--
-- What it adds is the part that has to be right BEFORE a message is ever sent,
-- and that is almost impossible to retrofit afterwards: a versioned wording
-- with an approver's name on it, consent scoped to a channel and a purpose,
-- a schedule that can only exist because an authoritative record exists, and
-- an outbox that knows the difference between "the provider accepted this" and
-- "the patient received this". Meta's own contract is the reason that last
-- distinction is a table rather than a column: POST /messages answers
-- `accepted`, `held_for_quality_assessment` or `paused`, and the statuses
-- webhook is the only thing that ever says `delivered`.
--
-- ── THE RULE BEHIND EVERY CONSTRAINT BELOW ─────────────────────────────────
--
-- Fail closed. A patient with no opt-in row is not contactable. A purpose with
-- no approved template is not sendable. A schedule with no live source is not
-- due. A message whose reply was lost is `outcome_unknown` and never
-- `delivered`. Every one of those is a state somebody can read, not a silence.
--
-- Forward-only. Nothing stored is rewritten, nothing existing is altered, and
-- no row is backfilled — least of all a consent. `patients.whatsapp_consent`
-- is a blanket registration flag that names no purposes, and owner item 78 is
-- explicit that "a registration choice is valid only for the purposes it
-- names". Turning it into per-purpose consent here would be inventing evidence
-- about what patients were told. So this schema starts with zero consent rows
-- and the automated channel starts fully suppressed, which is the only honest
-- place to start from.
--
-- No new `text` timestamp and no new `real` money column: every instant below
-- is `timestamptz`, and nothing here holds money at all, by policy.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ── 1. The wording, and who stood behind it ────────────────────────────────
--
-- Owner item 81: "The owner-doctor or another explicitly authorized doctor
-- approves patient-facing wording, purpose, allowed variables, and link
-- destination. An admin may manage metadata and provider submission but may
-- not approve clinical wording. Any change to wording, purpose, variables,
-- locale, destination, or provider category creates a new immutable version
-- and requires clinic approval plus any provider approval. Queued messages
-- retain their pinned version."
--
-- So there are two independent approval states on one row and they are not the
-- same fact. `approval_state` is the CLINIC's — a doctor read this sentence and
-- put their name to it. `provider_state` is META's — the template was submitted
-- and approved, or rejected, or later paused for quality. A message may only
-- be queued when both say yes, and either can say no on its own.
--
-- The version is the row. Editing a wording is not an UPDATE, it is a new row
-- with the next `version` in the same `series_id`, and the trigger below makes
-- that a rule the database holds rather than an intention the command layer
-- has. An outbox row pins `template_id`, which is a version and not a series,
-- so retiring or replacing a template cannot reach a message already queued.
--
-- ── THE TWO GUARDS THAT ARE ABOUT CONTENT RATHER THAN PROCESS ──────────────
--
-- `variables_json` is constrained to a fixed whitelist, and that whitelist is
-- the privacy boundary expressed as data. There is no variable for a medicine,
-- a diagnosis, a balance or an image, so there is no way to interpolate one —
-- not by a command that forgets to check, and not by a later slice that adds a
-- field in a hurry. `WHATSAPP.md` §5 gives three separate reasons for the same
-- rule (Meta's restricted-goods list, DPDP, and the fact that a chat log is
-- forwardable), and owner item 81 makes it policy.
--
-- The money regex is the same idea for the body. Owner item 22 forbids
-- automated pay-later reminders and item 81 forbids balances in a template; a
-- structural refusal is worth having because both of those are the kind of
-- thing that arrives as one helpful sentence in a template nobody re-reads.
-- It is a guard and NOT a substitute for the doctor's approval: it cannot see
-- a medicine name or a diagnosis, and the command layer checks those against
-- the formulary and the approved vocabulary instead.
create table if not exists jmc.message_templates (
  id text primary key,
  -- The template's stable identity across versions. Versions of one series
  -- replace one another; different series never do.
  series_id text not null,
  version integer not null check (version > 0),

  -- Owner item 78's four purposes, exactly as it names them, and this same
  -- list governs consent, schedules and the outbox. A fifth purpose is a
  -- policy decision and not a column value somebody may add in passing.
  purpose text not null check (purpose in (
    'appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption'
  )),
  channel text not null check (channel in ('whatsapp')),
  -- Owner item 81: "Templates are English-only initially." One value, so that
  -- adding a second is a migration somebody writes on purpose.
  locale text not null check (locale in ('en')),

  body text not null check (length(trim(body)) > 0),
  variables_json text not null default '[]',
  link_destination text not null default 'none'
    check (link_destination in ('none', 'clinic_public_page')),

  -- Meta classifies a template utility, authentication, service or marketing,
  -- and reclassifies it later if it decides the content has promotional
  -- intent. Owner item 81 requires every template here to be "defensibly
  -- utility", so the two categories a clinic notice can honestly be are the
  -- only two this column accepts. Marketing is not a category to be avoided by
  -- convention; it is a value that does not exist here.
  provider_category text not null check (provider_category in ('utility', 'service')),
  provider_template_name text not null default '',
  provider_state text not null default 'not_submitted'
    check (provider_state in (
      'not_submitted', 'submitted', 'approved', 'rejected', 'paused', 'disabled'
    )),
  provider_state_at timestamptz,
  provider_state_by text references jmc.staff(id),

  approval_state text not null default 'draft'
    check (approval_state in ('draft', 'approved', 'retired')),
  approved_by text references jmc.staff(id),
  approved_at timestamptz,

  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  retired_by text references jmc.staff(id),
  retired_at timestamptz,
  supersedes_id text references jmc.message_templates(id),

  -- The hash of the six fields item 81 says a change to requires a new
  -- version. Stored so that "is this genuinely different wording?" is a
  -- comparison rather than a re-reading, and asserted by the test suite.
  content_fingerprint text not null,

  unique (series_id, version),

  check (jsonb_typeof(variables_json::jsonb) = 'array'),
  check (variables_json::jsonb <@ '[
    "patient_given_name", "clinic_name", "appointment_date",
    "appointment_time", "due_date", "link"
  ]'::jsonb),
  -- A body cannot carry a link it has no destination for, and a destination
  -- nothing links to is a destination nobody reviewed.
  check ((link_destination = 'none') = (position('{{link}}' in body) = 0)),
  check (body !~* '(₹|[$]|\mrs\M|\mrupees?\M|\minr\M|\mbalance\M|\mamount\M|\mpayment\M|\moutstanding\M)'),

  check ((approved_at is null) = (approved_by is null)),
  check (approval_state = 'draft' or approved_at is not null),
  check ((retired_at is null) = (retired_by is null)),
  check (approval_state <> 'retired' or retired_at is not null),
  check ((provider_state_at is null) = (provider_state_by is null)),
  check (provider_state = 'not_submitted' or provider_state_at is not null)
);

-- One live version per series, and one live series per purpose. Together they
-- make "the approved template for an appointment reminder" a question with
-- exactly one answer, which is what the prepare step needs before it pins one.
create unique index if not exists message_templates_live_version
  on jmc.message_templates (series_id)
  where approval_state = 'approved';

create unique index if not exists message_templates_live_purpose
  on jmc.message_templates (purpose, channel, locale)
  where approval_state = 'approved';

create index if not exists message_templates_series
  on jmc.message_templates (series_id, version desc);
create index if not exists message_templates_created_by_idx
  on jmc.message_templates (created_by);
create index if not exists message_templates_approved_by_idx
  on jmc.message_templates (approved_by) where approved_by is not null;
create index if not exists message_templates_retired_by_idx
  on jmc.message_templates (retired_by) where retired_by is not null;
create index if not exists message_templates_provider_state_by_idx
  on jmc.message_templates (provider_state_by) where provider_state_by is not null;
create index if not exists message_templates_supersedes_idx
  on jmc.message_templates (supersedes_id) where supersedes_id is not null;

comment on table jmc.message_templates is
  'Owner item 81. One immutable version per row. Clinic approval and provider approval are separate states and a message needs both. Queued messages pin a version, never a series.';


-- ── 2. Consent, as evidence rather than as a flag ──────────────────────────
--
-- Owner item 78: consent is "per channel and per purpose, not a blanket
-- registration flag", and the evidence "records the clinic name, WhatsApp as
-- the channel, purpose, wording/version, source, actor where applicable, and
-- time".
--
-- Owner item 82: "A purpose-specific request withdraws only that purpose; an
-- unqualified request such as 'stop WhatsApp' withdraws all clinic-initiated
-- WhatsApp purposes. [...] A later patient-initiated conversation does not
-- silently restore standing consent; re-enrolment requires a new explicit
-- opt-in record."
--
-- Append-only, and the effective answer is a query rather than a column: the
-- latest applicable row for a patient, channel and purpose wins, and no row at
-- all means no. That is why there is no `active` boolean anywhere here. A
-- boolean would have to be recomputed by whatever wrote last, and the first
-- time two writers disagreed the patient's actual instruction would be the one
-- thing nobody could reconstruct.
--
-- ── THE ORDERING COLUMN, AND WHY A TIMESTAMP IS NOT ENOUGH ─────────────────
--
-- `recorded_at` defaults to `now()`, which in Postgres is the TRANSACTION's
-- start time. Two consent rows written in one transaction — a withdrawal of
-- one purpose and an opt-in to another, recorded together at the desk — carry
-- the identical timestamp, and "the latest row" would then be decided by a
-- uuid. `sequence_no` gives a total order that cannot tie.
--
-- ── THE CONSTRAINT THAT IS ITEM 82's LAST SENTENCE ─────────────────────────
--
-- An opt-in may only come from a registration choice or a staff-recorded
-- request. It may NOT come from `patient_chat`. A patient messaging the clinic
-- permits a reply inside the provider's conversation window — which is a
-- different mechanism entirely and is not modelled here — and this schema has
-- no way to turn that into standing consent even by accident.
create table if not exists jmc.communication_consents (
  id text primary key,
  sequence_no bigint generated always as identity,
  patient_id text not null references jmc.patients(id),
  channel text not null check (channel in ('whatsapp')),
  decision text not null check (decision in ('opt_in', 'withdraw')),
  scope text not null check (scope in ('purpose', 'all_purposes')),
  purpose text check (purpose in (
    'appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption'
  )),

  -- Item 78's evidence, and Meta's opt-in rule underneath it: a compliant
  -- opt-in shows the exact business name, that it is WhatsApp, and what kind
  -- of messages are being agreed to.
  clinic_name text not null check (length(trim(clinic_name)) > 0),
  wording text not null check (length(trim(wording)) > 0),
  wording_version text not null check (length(trim(wording_version)) > 0),
  source text not null check (source in ('registration', 'staff_recorded', 'patient_chat')),
  actor_id text references jmc.staff(id),
  note text not null default '',
  recorded_at timestamptz not null default now(),

  -- Item 78: an opt-in is valid only for the purposes it names, so there is no
  -- such thing as an unqualified opt-in. A withdrawal may be either.
  check (decision = 'withdraw' or scope = 'purpose'),
  check ((scope = 'purpose') = (purpose is not null)),
  -- Item 82: re-enrolment requires an explicit opt-in record.
  check (decision = 'withdraw' or source in ('registration', 'staff_recorded')),
  -- Item 78: "actor where applicable". Staff-recorded evidence names the
  -- member of staff who took it; a registration choice and a chat opt-out do
  -- not have one.
  check ((source = 'staff_recorded') = (actor_id is not null))
);

create index if not exists communication_consents_effective
  on jmc.communication_consents (patient_id, channel, sequence_no desc);
create index if not exists communication_consents_patient_idx
  on jmc.communication_consents (patient_id);
create index if not exists communication_consents_actor_idx
  on jmc.communication_consents (actor_id) where actor_id is not null;

drop trigger if exists communication_consents_immutable on jmc.communication_consents;
create trigger communication_consents_immutable
before update or delete on jmc.communication_consents
for each row execute function jmc.reject_signed_line_change();

comment on table jmc.communication_consents is
  'Owner items 78 and 82. Append-only consent evidence by channel and purpose. No row means no consent; the latest applicable row decides. An opt-in can never come from a patient-initiated chat.';


-- ── 3. The intent, and the record it is allowed to exist because of ────────
--
-- Owner item 83: "Eligibility begins only when a doctor explicitly records
-- recall/follow-up required, a purpose, due date, and responsible doctor for
-- that patient. A query result, diagnosis, medicine, missed appointment,
-- unpaid balance, or elapsed time cannot create eligibility."
--
-- `source_type` is therefore two values and not a free text, and both of them
-- name a table that already exists and already holds a person's decision:
--
--   appointment_booking  jmc.appointment_bookings — somebody booked a time
--   follow_up            jmc.follow_ups — a doctor wrote a due date
--
-- There is no `source_type = 'query'`, no cohort, no rule engine and no
-- elapsed-time trigger. A later slice that wants one has to add a value here,
-- which is a migration and a review rather than a filter somebody saved.
--
-- Not a foreign key, deliberately: the two sources are different tables and a
-- polymorphic reference cannot be one. The commands resolve and verify the
-- source inside their transaction, and `slice3a-messaging.test.mjs` asserts
-- that an unknown source is refused rather than scheduled.
--
-- ── THE TIMES, WHICH ARE THE WHOLE OF OWNER ITEM 77 ────────────────────────
--
--   appointment_reminder      18:00 clinic-local on the day BEFORE
--   appointment_confirmation  now, when 18:00 has already gone by
--   clinical_recall           09:00 clinic-local on the due date
--
-- `useful_until` is the deadline a retry may not cross. For an appointment it
-- is the appointment itself, which is not a choice anybody had to make. For a
-- recall it is the end of that day's dispatch window, which IS a choice and
-- has no owner item behind it — see `clinic-policy.ts`, where it says so.
create table if not exists jmc.communication_schedules (
  id text primary key,
  patient_id text not null references jmc.patients(id),
  channel text not null check (channel in ('whatsapp')),
  purpose text not null check (purpose in (
    'appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption'
  )),
  schedule_kind text not null check (schedule_kind in (
    'appointment_reminder', 'appointment_confirmation', 'clinical_recall'
  )),
  source_type text not null check (source_type in ('appointment_booking', 'follow_up')),
  source_id text not null,

  due_at timestamptz not null,
  useful_until timestamptz not null,

  -- Item 79: "follow-up or recall failures are also visible to the responsible
  -- doctor". The doctor is on the schedule because the follow-up names one and
  -- a failure three days later must not have to guess.
  responsible_doctor_id text references jmc.staff(id),

  status text not null check (status in ('scheduled', 'cancelled', 'superseded', 'completed')),
  cancelled_reason text not null default '',
  cancelled_by text references jmc.staff(id),
  cancelled_at timestamptz,
  superseded_at timestamptz,
  superseded_by text references jmc.communication_schedules(id),
  completed_at timestamptz,

  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  idempotency_key text,
  request_fingerprint text,

  check (useful_until >= due_at),
  -- The three pairings that keep a purpose and its kind from drifting apart.
  check ((purpose = 'appointment')
         = (schedule_kind in ('appointment_reminder', 'appointment_confirmation'))),
  check ((purpose = 'clinical_recall') = (schedule_kind = 'clinical_recall')),
  check ((source_type = 'appointment_booking') = (purpose = 'appointment')),
  -- Item 83: a recall without a responsible doctor is not a doctor-authored
  -- instruction, whatever else it is.
  check (purpose <> 'clinical_recall' or responsible_doctor_id is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and cancelled_by is not null
                                   and length(trim(cancelled_reason)) > 0)),
  /*
   * `superseded_at` and not `superseded_by`, and the difference is an ordering
   * problem rather than a preference.
   *
   * A reminder is superseded because a new one is taking its place, and the
   * new one cannot exist yet: the partial unique index below allows one live
   * schedule per source and kind, so the old row has to stop being `scheduled`
   * before the replacement can be inserted. A foreign key to a row that does
   * not exist yet is refused immediately, so requiring the pointer at the
   * moment of supersession would make the correct sequence impossible.
   *
   * The TIME is always known, so that is what is required. The pointer is
   * filled in a line later, once there is something to point at, and it stays
   * null in the one case where nothing replaced the schedule at all.
   */
  check ((status = 'superseded') = (superseded_at is not null)),
  check (status <> 'completed' or completed_at is not null),
  -- The same pairing `appointment_bookings` uses: a key with no fingerprint
  -- beside it cannot refuse a mismatch, which is the half that protects the
  -- patient.
  check (idempotency_key is null or request_fingerprint is not null)
);

-- Item 77: "Send at most one appointment reminder". This is that sentence as
-- an index — one live schedule per source and kind, so a duplicate command
-- meets a constraint rather than a convention, and two tablets pressing at
-- once produce one schedule.
create unique index if not exists communication_schedules_one_live
  on jmc.communication_schedules (source_type, source_id, schedule_kind)
  where status = 'scheduled';

create unique index if not exists communication_schedules_idempotency
  on jmc.communication_schedules (idempotency_key)
  where idempotency_key is not null;

create index if not exists communication_schedules_due
  on jmc.communication_schedules (due_at)
  where status = 'scheduled';
create index if not exists communication_schedules_source
  on jmc.communication_schedules (source_type, source_id);
create index if not exists communication_schedules_patient_idx
  on jmc.communication_schedules (patient_id, due_at desc);
create index if not exists communication_schedules_doctor_idx
  on jmc.communication_schedules (responsible_doctor_id)
  where responsible_doctor_id is not null;
create index if not exists communication_schedules_created_by_idx
  on jmc.communication_schedules (created_by);
create index if not exists communication_schedules_cancelled_by_idx
  on jmc.communication_schedules (cancelled_by) where cancelled_by is not null;
create index if not exists communication_schedules_superseded_by_idx
  on jmc.communication_schedules (superseded_by) where superseded_by is not null;

comment on table jmc.communication_schedules is
  'Owner items 77 and 83. One intended send, tied to an authoritative record that a person created. Cancellation, supersession and completion are states here, never deletions.';


-- ── 4. The outbox: a row before a send, and the states in between ──────────
--
-- `WHATSAPP.md` §10 rule 8, written long before this slice: "Every send is a
-- row before it is a send, with an idempotency key, so a webhook retry cannot
-- double-order." This is that row.
--
-- It is created at SCHEDULE time, not at send time, with `status='scheduled'`
-- and no template pinned. That ordering is the point: the durable record of an
-- intention exists from the moment the intention does, so there is no window
-- in which the clinic has decided to contact somebody and nothing anywhere
-- says so.
--
--   scheduled ─┬─ prepare ──▶ queued ──┬─ attempt accepted ──▶ sent_to_provider
--              │                       │                          │
--              │                       │                          ├─ webhook delivered ─▶ delivered
--              │                       │                          └─ webhook failed ────▶ failed_terminal
--              │                       ├─ attempt refused, retryable ─▶ failed_retryable ─┐
--              │                       ├─ attempt refused, terminal ──▶ failed_terminal   │
--              │                       └─ reply lost ────────────────▶ outcome_unknown    │
--              │                                                                          │
--              ├─ consent withdrawn / no template / channel not configured ▶ suppressed   │
--              └─ source cancelled ──────────────────────────────────────▶ cancelled      │
--                                                                        ◀────────────────┘
--                                                          (a retry re-enters the attempt loop)
--
-- ── THE THREE STATES THAT EXIST BECAUSE THE TRUTH IS AWKWARD ───────────────
--
-- `sent_to_provider` is not `delivered`, and this is the distinction the whole
-- slice is built around. Meta's POST /messages answers `accepted`,
-- `held_for_quality_assessment` or `paused` — none of which means a patient
-- saw anything — and only the statuses webhook ever says `delivered`. A screen
-- that reported an HTTP 200 as "sent to the patient" would be wrong most
-- reliably on exactly the days the channel was degraded.
--
-- `outcome_unknown` is what a lost reply leaves. The attempt row is committed
-- before the provider is called, so a process that dies mid-call leaves an
-- `in_flight` attempt and an outbox row that says, truthfully, that nobody
-- knows. It is not retryable by a worker: only provider evidence can settle
-- it, because a blind retry is how one reminder becomes two.
--
-- `suppressed` is a decision, not a silence, and it carries its reason. Owner
-- item 76: "If the official channel is unavailable or not approved, suppress
-- the automated send and put the work in a staff queue." A suppressed row IS
-- that queue entry.
--
-- ── THE IDEMPOTENCY KEY CARRIES NOTHING ABOUT ANYBODY ──────────────────────
--
-- `<schedule id>:<generation>`. A uuid and a small integer. No patient id, no
-- phone number, no name, no purpose and no clinical word — because this value
-- is the one field in the whole table that is designed to be repeated in logs,
-- and a log line is the least controlled place a clinic's data can end up.
create table if not exists jmc.message_outbox (
  id text primary key,
  schedule_id text not null references jmc.communication_schedules(id),
  patient_id text not null references jmc.patients(id),
  channel text not null check (channel in ('whatsapp')),
  purpose text not null check (purpose in (
    'appointment', 'clinical_recall', 'ready_for_collection', 'service_interruption'
  )),

  -- Pinned at queue time. A version, never a series: owner item 81's "queued
  -- messages retain their pinned version" is this foreign key.
  template_id text references jmc.message_templates(id),
  to_number text not null default '',
  variables_json text not null default '{}',
  rendered_body text not null default '',

  idempotency_key text not null,
  generation integer not null default 1 check (generation > 0),

  status text not null check (status in (
    'scheduled', 'suppressed', 'queued', 'sent_to_provider', 'delivered',
    'failed_retryable', 'failed_terminal', 'cancelled', 'outcome_unknown'
  )),
  suppression_reason text not null default '' check (suppression_reason in (
    '', 'no_consent', 'consent_withdrawn', 'channel_not_configured',
    'no_approved_template', 'provider_template_not_approved', 'no_contact_number',
    'link_destination_unavailable', 'variable_unavailable', 'past_useful_by'
  )),

  due_at timestamptz not null,
  useful_until timestamptz not null,

  -- Item 79: "at most three provider attempts within two hours".
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,

  first_failed_at timestamptz,
  error_category text not null default '',

  -- Provider evidence, and its rank, which is what makes duplicate and
  -- out-of-order webhooks harmless. 0 nothing, 1 accepted, 2 sent, 3
  -- delivered, 4 failed. Evidence may only raise it.
  provider_reference text,
  delivery_status text not null default 'none'
    check (delivery_status in ('none', 'accepted', 'sent', 'delivered', 'failed')),
  delivery_rank smallint not null default 0 check (delivery_rank between 0 and 4),
  delivery_status_at timestamptz,

  -- Item 79: "The admin owns the delivery-failure queue from the first failed
  -- attempt." There is one owner and it is not conditional, so this column has
  -- one non-empty value; it exists so the read model states the rule from the
  -- row rather than from a constant in a query somebody may later change.
  failure_owner_role text not null default '' check (failure_owner_role in ('', 'admin')),
  responsible_doctor_id text references jmc.staff(id),
  escalated_at timestamptz,

  resolved_at timestamptz,
  resolved_by text references jmc.staff(id),
  resolution text not null default ''
    check (resolution in ('', 'manual_fallback', 'resent', 'no_longer_needed')),
  resolution_note text not null default '',

  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),

  check (useful_until >= due_at),
  check ((status = 'suppressed') = (length(suppression_reason) > 0)),
  -- Anything that has reached the provider, or is about to, carries the
  -- wording it will send and the number it will go to.
  check (status not in ('queued', 'sent_to_provider', 'delivered', 'failed_retryable',
                        'failed_terminal', 'outcome_unknown')
         or (template_id is not null and length(trim(to_number)) > 0
             and length(trim(rendered_body)) > 0)),
  -- `delivered` is provider evidence and nothing else can produce it.
  check ((status = 'delivered') = (delivery_status = 'delivered')),
  check ((delivery_status = 'none') = (delivery_rank = 0)),
  check ((delivery_status_at is null) = (delivery_status = 'none')),
  check ((provider_reference is null) or status in (
    'sent_to_provider', 'delivered', 'failed_terminal', 'failed_retryable', 'outcome_unknown')),
  check ((attempt_count = 0) = (first_attempt_at is null)),
  check ((attempt_count = 0) = (last_attempt_at is null)),
  check ((resolved_at is null) = (resolved_by is null)),
  check ((resolved_at is null) = (length(resolution) = 0)),
  check (resolution <> 'manual_fallback' or length(trim(resolution_note)) > 0),
  check (jsonb_typeof(variables_json::jsonb) = 'object'),
  -- The key is the only string here meant to be repeated outside the database.
  -- Nothing about a patient may be in it.
  check (idempotency_key ~ '^[0-9a-f-]{36}:[0-9]+$')
);

create unique index if not exists message_outbox_idempotency
  on jmc.message_outbox (idempotency_key);

-- One live message per schedule generation, so two workers preparing the same
-- due schedule produce one row rather than two.
create unique index if not exists message_outbox_schedule_generation
  on jmc.message_outbox (schedule_id, generation);

create unique index if not exists message_outbox_provider_reference
  on jmc.message_outbox (provider_reference)
  where provider_reference is not null;

create index if not exists message_outbox_preparable
  on jmc.message_outbox (due_at) where status = 'scheduled';
create index if not exists message_outbox_dispatchable
  on jmc.message_outbox (due_at) where status in ('queued', 'failed_retryable');
create index if not exists message_outbox_open_failure
  on jmc.message_outbox (first_failed_at)
  where status in ('failed_retryable', 'failed_terminal', 'outcome_unknown', 'suppressed')
    and resolved_at is null;
create index if not exists message_outbox_patient_idx
  on jmc.message_outbox (patient_id, created_at desc);
create index if not exists message_outbox_schedule_idx
  on jmc.message_outbox (schedule_id);
create index if not exists message_outbox_template_idx
  on jmc.message_outbox (template_id) where template_id is not null;
create index if not exists message_outbox_doctor_idx
  on jmc.message_outbox (responsible_doctor_id) where responsible_doctor_id is not null;
create index if not exists message_outbox_created_by_idx
  on jmc.message_outbox (created_by);
create index if not exists message_outbox_resolved_by_idx
  on jmc.message_outbox (resolved_by) where resolved_by is not null;

comment on table jmc.message_outbox is
  'One intended message. Committed before any provider contact. sent_to_provider is not delivered: only the provider statuses webhook produces delivered, and outcome_unknown is what a lost reply honestly leaves behind.';

comment on column jmc.message_outbox.idempotency_key is
  'Schedule id and generation. Deliberately carries no patient, clinical or contact data: this is the value that ends up in logs.';


-- ── 5. What was actually attempted, one row per provider call ──────────────
--
-- Inserted BEFORE the call and completed once, afterwards. That ordering is
-- why `outcome_unknown` is possible at all: a row that stays `in_flight` is a
-- call whose answer never came back, and a clinic that cannot distinguish that
-- from a call that never happened will eventually send a second reminder to
-- somebody who already had one.
--
-- "Append-only" is claimed here in a precise sense and the trigger holds
-- exactly that sense: a row is never deleted, its identity and its start are
-- never edited, and its outcome may be written exactly once, moving out of
-- `in_flight` and never back. It is not a table where anything is rewritten.
create table if not exists jmc.message_attempts (
  id text primary key,
  outbox_id text not null references jmc.message_outbox(id),
  attempt_number integer not null check (attempt_number between 1 and 3),
  transport text not null check (length(trim(transport)) > 0),
  started_at timestamptz not null default now(),

  outcome text not null default 'in_flight'
    check (outcome in ('in_flight', 'accepted', 'rejected', 'transport_error')),
  provider_reference text,
  -- Meta's own three answers to POST /messages. None of them is delivery.
  provider_accept_status text not null default ''
    check (provider_accept_status in ('', 'accepted', 'held_for_quality_assessment', 'paused')),
  error_category text not null default '' check (error_category in (
    '', 'rate_limited', 'provider_unavailable', 'invalid_recipient',
    'template_rejected', 'not_authorized', 'transport_error', 'unknown'
  )),
  -- Normalized and redacted by the caller. A provider's own error text can
  -- quote the recipient's number back at you, and this table is read by
  -- screens and copied into support threads.
  error_detail text not null default '',
  finished_at timestamptz,

  unique (outbox_id, attempt_number),
  check ((outcome = 'in_flight') = (finished_at is null)),
  check ((outcome = 'accepted') = (provider_reference is not null)),
  check ((outcome = 'accepted') = (length(provider_accept_status) > 0)),
  check ((outcome in ('in_flight', 'accepted')) = (length(error_category) = 0))
);

create unique index if not exists message_attempts_provider_reference
  on jmc.message_attempts (provider_reference)
  where provider_reference is not null;

create index if not exists message_attempts_outbox_idx
  on jmc.message_attempts (outbox_id, attempt_number);

create or replace function jmc.protect_message_attempt()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A delivery attempt is evidence and is never deleted.';
  end if;

  if old.outcome <> 'in_flight' then
    raise exception 'This delivery attempt has already been settled as %. An attempt is written once.', old.outcome;
  end if;

  if new.id is distinct from old.id
     or new.outbox_id is distinct from old.outbox_id
     or new.attempt_number is distinct from old.attempt_number
     or new.transport is distinct from old.transport
     or new.started_at is distinct from old.started_at then
    raise exception 'Only the outcome of a delivery attempt may be recorded. Its identity and its start are fixed.';
  end if;

  return new;
end;
$$;

drop trigger if exists message_attempts_settle_once on jmc.message_attempts;
create trigger message_attempts_settle_once
before update or delete on jmc.message_attempts
for each row execute function jmc.protect_message_attempt();

comment on table jmc.message_attempts is
  'One provider call. Committed before the call and settled once afterwards, so a call whose answer was lost stays in_flight and the message stays outcome_unknown.';


-- ── 6. A template version cannot be edited into a different template ───────
--
-- Owner item 81's second half, as a rule the database holds. Retirement and
-- the provider's own verdict are the only things that may change after a row
-- exists; the six fields item 81 names cannot, and neither can an approval
-- once it has somebody's name on it.
create or replace function jmc.protect_message_template()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A message template version is never deleted. Retire it and publish a new version.';
  end if;

  if new.id is distinct from old.id
     or new.series_id is distinct from old.series_id
     or new.version is distinct from old.version
     or new.purpose is distinct from old.purpose
     or new.channel is distinct from old.channel
     or new.locale is distinct from old.locale
     or new.body is distinct from old.body
     or new.variables_json is distinct from old.variables_json
     or new.link_destination is distinct from old.link_destination
     or new.provider_category is distinct from old.provider_category
     or new.content_fingerprint is distinct from old.content_fingerprint
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.supersedes_id is distinct from old.supersedes_id then
    raise exception
      'Wording, purpose, variables, locale, link destination and provider category are fixed for a '
      'template version. Publish the next version of this series instead.';
  end if;

  if old.approval_state = 'approved' and new.approval_state = 'draft' then
    raise exception 'An approved template cannot return to draft. Retire it and publish a new version.';
  end if;
  if old.approval_state = 'retired' and new.approval_state <> 'retired' then
    raise exception 'A retired template stays retired.';
  end if;
  if old.approved_by is not null
     and (new.approved_by is distinct from old.approved_by
          or new.approved_at is distinct from old.approved_at) then
    raise exception 'Who approved a template, and when, is evidence and cannot be rewritten.';
  end if;

  return new;
end;
$$;

drop trigger if exists message_templates_version_immutable on jmc.message_templates;
create trigger message_templates_version_immutable
before update or delete on jmc.message_templates
for each row execute function jmc.protect_message_template();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ACCESS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The posture `20260909125237_harden_active_clinic.sql` set and every slice
-- since has kept: row security on, forced nowhere, every privilege revoked
-- from the Data API's roles, so `jmc` is reachable only through the Edge
-- Functions' own connection. `slice3-gate.test.mjs` and `slice6-gate.test.mjs`
-- walk `pg_class` rather than a list, so a table left out of this block is a
-- failing test rather than a quiet hole — but a table left out is also a
-- messaging table, and the rows in these five name who may be contacted and
-- what they were told. There is no version of this that is optional.
do $$
declare t text;
begin
  foreach t in array array[
    'message_templates', 'communication_consents', 'communication_schedules',
    'message_outbox', 'message_attempts'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
