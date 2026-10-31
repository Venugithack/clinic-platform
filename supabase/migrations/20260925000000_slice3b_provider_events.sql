-- ─────────────────────────────────────────────────────────────────────────────
-- Slice 3B: what the provider told us, and the two things Slice 3A could not do
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One table. Nothing existing is altered, no column is added to an accepted
-- table, no data is backfilled and no constraint is relaxed. Slice 3A's
-- migration is untouched.
--
-- ── WHY A TABLE AND NOT A COLUMN ──────────────────────────────────────────
--
-- Slice 3A's `applyProviderEvidence` is idempotent in its EFFECT: evidence may
-- only raise `message_outbox.delivery_rank`, so a duplicate `delivered` is a
-- no-op and a `sent` arriving after `delivered` cannot un-deliver anything.
-- That property is real and the tests for it stay exactly as they are.
--
-- What it cannot do is two things this slice needs:
--
--   1. **Say whether an event was already seen.** Rank monotonicity cannot
--      tell "Meta redelivered this" from "this evidence is weaker than what we
--      already know". Both are ignored, which is the right ANSWER and the
--      wrong RECORD: a clinic disputing whether a patient was told about an
--      appointment has nothing to read. Meta retries a webhook "with
--      decreasing frequency until the request succeeds, for up to 7 days", so
--      duplicates are not an edge case, they are the documented behaviour.
--
--   2. **Reach a message whose POST reply was lost.** This is the important
--      one. When the worker's call to Meta times out, the clinic never learns
--      the wamid — so `message_outbox.provider_reference` is null and the
--      status webhook, which is keyed on the wamid, matches nothing. The
--      message sits at `outcome_unknown` for ever. `POST /messages` has no
--      documented idempotency mechanism, so it cannot simply be sent again.
--
--      The way out is Meta's own `biz_opaque_callback_data`: a
--      business-assigned string echoed back verbatim in the status webhook.
--      The clinic sends its `idempotency_key` in it — which §15.6 of the
--      schema contract already designed to be the one string here that is safe
--      outside the database, carrying no patient id, name, number, purpose or
--      clinical word. The webhook can then find the message it belongs to and
--      settle it truthfully.
--
-- Both are therefore recorded here: every event, what it was about, and which
-- message it resolved to, with a uniqueness constraint that makes "apply this
-- twice" a database-level impossibility rather than a race nobody has run.

-- `jmc` alone, exactly as every migration before this one. The database is
-- shared with the retired application, whose tables live in `public`, and
-- eight names collide. Every object below is fully qualified anyway; the
-- convention is kept because the next person to add a statement here may not
-- qualify theirs.
set local search_path = jmc;

-- ── One provider status event, exactly once ────────────────────────────────
--
-- A row is written BEFORE the evidence is applied, inside the same
-- transaction. So two webhooks carrying the same event race on the unique
-- index rather than on the outbox row: one inserts and applies, the other is
-- refused by the index and rolls back, having changed nothing. There is no
-- ordering in which both apply.
create table if not exists jmc.message_provider_events (
  id text primary key,

  /*
   * Meta's wamid, and the status word it carried. Together they are the
   * identity of one event: a given message reaches each status at most once,
   * so a repeat of the pair is a redelivery by definition. The provider's
   * `timestamp` is deliberately NOT part of the key — Meta may redeliver the
   * same event and there is no documented guarantee the timestamp is stable,
   * and a key that lets a redelivery through is not a key.
   */
  provider_reference text not null check (length(trim(provider_reference)) > 0),
  status text not null check (status in ('sent', 'delivered', 'read', 'played', 'failed')),

  /*
   * What the clinic sent as `biz_opaque_callback_data`, echoed back. Shaped
   * exactly like `message_outbox.idempotency_key` when it is present, and
   * absent when the event is about a message this clinic did not send through
   * the outbox — an inbound reply's receipt, or a message sent by the old
   * staff composer.
   */
  callback_data text not null default ''
    check (callback_data = '' or callback_data ~ '^[0-9a-f-]{36}:[0-9]+$'),

  -- Null when the event named a message this clinic has no record of. Such an
  -- event is stored and applied to nothing: see the endpoint's own comment on
  -- why it must still answer 200 and disclose nothing.
  outbox_id text references jmc.message_outbox(id),

  /*
   * What `applyProviderEvidence` did with it, so the record says whether the
   * event moved anything rather than only that it arrived.
   *   applied            the message's delivery truth advanced
   *   ignored            weaker than, or equal to, what was already known
   *   unknown_reference  named no message this clinic sent
   */
  effect text not null check (effect in ('applied', 'ignored', 'unknown_reference')),

  -- Meta's own error code and title for a `failed` event, redacted by the
  -- caller exactly as `message_attempts.error_detail` is. A provider's error
  -- text quotes the recipient's number back at you.
  error_code integer,
  error_detail text not null default '',

  occurred_at timestamptz,
  received_at timestamptz not null default now(),

  check ((effect = 'unknown_reference') = (outbox_id is null))
);

-- The whole point. One event, one row, one application.
create unique index if not exists message_provider_events_identity
  on jmc.message_provider_events (provider_reference, status);

create index if not exists message_provider_events_outbox_idx
  on jmc.message_provider_events (outbox_id, received_at desc)
  where outbox_id is not null;

create index if not exists message_provider_events_received
  on jmc.message_provider_events (received_at desc);

comment on table jmc.message_provider_events is
  'One authenticated provider status event, deduplicated on (provider_reference, status). Written before the evidence is applied and in the same transaction, so a redelivered webhook cannot apply twice. callback_data is the echoed biz_opaque_callback_data, which is how a message whose POST reply was lost is reconciled at all.';

comment on column jmc.message_provider_events.callback_data is
  'The echoed biz_opaque_callback_data: message_outbox.idempotency_key, which deliberately carries no patient, contact or clinical data because this is the value that leaves the building.';

-- ── An event is evidence, and evidence is not edited ───────────────────────
--
-- Same rule as `message_attempts`, and for the same reason: this table is what
-- the clinic would produce if somebody asked whether a patient was told.
create or replace function jmc.protect_message_provider_event()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A provider event is evidence and is never deleted.';
  end if;
  raise exception 'A provider event records what arrived and is never edited.';
end;
$$;

drop trigger if exists message_provider_events_immutable on jmc.message_provider_events;
create trigger message_provider_events_immutable
before update or delete on jmc.message_provider_events
for each row execute function jmc.protect_message_provider_event();

-- ── ACCESS ─────────────────────────────────────────────────────────────────
--
-- The posture `20260909125237_harden_active_clinic.sql` set and every slice
-- since has kept: row security on, forced nowhere, every privilege revoked
-- from the Data API's roles, so `jmc` is reachable only through the Edge
-- Functions' own connection.
--
-- `slice3-gate.test.mjs` and `slice6-gate.test.mjs` walk `pg_class` rather
-- than a list, which is why the first version of this migration — which left
-- this block out entirely — was four failing tests rather than a quiet hole in
-- a table that records who was told what. That is the block working exactly as
-- its author intended, and the reason it is written this way.
do $$
declare t text;
begin
  foreach t in array array['message_provider_events'] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
