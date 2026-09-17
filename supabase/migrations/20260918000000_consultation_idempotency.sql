-- ═══════════════════════════════════════════════════════════════════════════
-- SIGNING A CONSULTATION TWICE IS ONE CONSULTATION
--
-- `sign_consultation` was the only operation named in
-- `docs/AGENT_IMPLEMENTATION_BRIEF.md` §7 with no idempotency key behind it.
-- Dispensing, the counter sale, the payment and the goods receipt each take a
-- key from the tablet and back it with a unique index. Encounter completion
-- took nothing, and `tests/characterization/unprotected-write-paths.test.mjs`
-- pinned what that costs: a sheet signed twice for a patient with no visit row
-- open today produced TWO encounters, TWO invoices and TWO ₹300 fee lines —
-- a ₹600 bill for one visit.
--
-- The reason the existing protection could not catch it is worth writing down,
-- because the code's own comment said the opposite. The fee line is keyed
-- `consultation:${encounterId}` and `invoice_lines.source_key` is uniquely
-- indexed clinic-wide, so `commands.ts` claimed "a retry cannot produce a
-- second one even on a second invoice". The index guarantees one fee per
-- ENCOUNTER. `encounterId` is a fresh `randomUUID()` at the top of every call,
-- so two calls never share one, and the two promises are not the same promise.
--
-- ── WHAT THIS ADDS, AND WHY IT IS TWO COLUMNS RATHER THAN ONE ───────────────
--
-- `idempotency_key` is the tablet's name for ONE attempt at ONE consultation.
-- The unique index is what makes it mean something: a second call carrying a
-- key the clinic has already recorded cannot insert, whether it arrives a
-- minute later or in the same millisecond on another tablet. Postgres treats
-- NULLs as distinct in a unique index, so every consultation already signed —
-- all of which have no key — stays exactly as it is, and a caller that sends
-- no key is refused nothing. That compatibility is deliberate and temporary;
-- see the exposure note in `docs/reference/BACKEND_PROGRAMME_REGISTER.md`.
--
-- `request_fingerprint` is what stops the key being a way to LOSE a
-- consultation. A key alone answers "have I seen this?" and then hands back
-- whatever it finds. If a doctor's tablet reused a key against a materially
-- different sheet — a different patient, a different diagnosis, a different
-- prescription — the reply would be the FIRST consultation's identity, and the
-- second one would silently never exist. So the server stores a hash of the
-- material request beside the key and refuses the mismatch out loud rather
-- than answering with the wrong encounter. This is the same lesson the counter
-- learned when one payment key was shared across two bills.
--
-- Forward-only. Two added columns, one unique index, one check. No stored row
-- is rewritten and no historical encounter acquires an invented key. Policy
-- item 34.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The two columns ─────────────────────────────────────────────────────
--
-- Both nullable, because every encounter signed before today has neither and
-- inventing one would be inventing evidence about a visit that already
-- happened. New rows always carry both: the command mints a key of its own
-- when the tablet does not send one, so the pair is only ever absent on
-- history.
alter table jmc.encounters
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text;

comment on column jmc.encounters.idempotency_key is
  'The tablet''s name for one attempt at one consultation. Unique clinic-wide; null on every encounter signed before this migration.';

comment on column jmc.encounters.request_fingerprint is
  'SHA-256 of the material consultation request behind this encounter. Reusing the key with a different fingerprint is refused rather than answered with the wrong encounter.';


-- ── 2. The unique index ────────────────────────────────────────────────────
--
-- This, not the code above it, is what makes a retry safe. The pre-check in
-- `completeConsultation` is the fast path and the courteous message; the index
-- is the guarantee, and it is the one that holds when two tablets submit the
-- same key in the same breath. The second insert blocks on the first, and then
-- either raises 23505 because the first committed or succeeds because it did
-- not. A check without the constraint is a race; a constraint without the
-- check is an ugly error. Both, like every other idempotent command here.
create unique index if not exists encounters_idempotency_key
  on jmc.encounters (idempotency_key);


-- ── 3. The pair travels together ───────────────────────────────────────────
--
-- A key with no fingerprint beside it is a key that cannot refuse a mismatch,
-- which is the half of this that protects the patient rather than the bill.
-- Every existing row has neither, so the constraint is true of the whole table
-- the moment it is added and needs no backfill and no NOT VALID.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'encounters_key_carries_fingerprint'
       and conrelid = 'jmc.encounters'::regclass
  ) then
    alter table jmc.encounters
      add constraint encounters_key_carries_fingerprint
      check (idempotency_key is null or request_fingerprint is not null);
  end if;
end $$;
