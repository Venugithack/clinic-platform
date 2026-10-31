-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES FOR THE READS THAT USED TO HAPPEN IN THE BROWSER
--
-- Slice 1 of the backend programme moves patient search and the actionable
-- work lists onto the server. Today the whole patient register is a top-level
-- key in the clinic snapshot with no LIMIT, re-sent in full on every poll that
-- changes anything, and `care-workspaces.tsx` filters that array in memory on
-- every keystroke. That works at twelve patients and is the wrong shape at
-- twelve thousand, in both directions: the payload and the scan.
--
-- What this migration adds is indexes and nothing else. No table, no column,
-- no status field. Every read model in this slice is derived from facts the
-- clinic already records — the programme is explicit that a mutable duplicate
-- status column must not be added to make a screen easier to draw, and none is.
--
-- ── WHY EXPRESSION INDEXES AND NOT NEW COLUMNS ─────────────────────────────
--
-- `patients` carries a name and a phone as typed. Matching either means
-- normalizing first, and the normalization already exists — it is exactly what
-- `find_possible_duplicates` has done since Slice 1 of the original programme
-- (`commands.ts`): collapse whitespace and lowercase a name, strip non-digits
-- from a phone and keep the last ten. A stored normalized column would be a
-- second copy of the name that can fall out of step with the first. An
-- expression index cannot: Postgres maintains it from the row itself, and a
-- query written with the same expression uses it.
--
-- Both expressions are IMMUTABLE (`lower`, `regexp_replace`, `right`), which
-- is what makes them indexable at all.
--
-- Forward-only, additive, and nothing here changes a stored value. Policy
-- item 34.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Finding a patient by name ───────────────────────────────────────────
--
-- `text_pattern_ops` rather than the default operator class, because the
-- default collation's btree cannot serve a `like 'prefix%'` and this one can.
-- That is the whole point of the index: a name search that starts with what
-- was typed is an index range scan, and the query in `_shared/workspace.ts`
-- is written with the identical expression so that it qualifies.
--
-- ── AN INDEX IS ONLY USED IF THE QUERY LETS IT BE ──────────────────────────
--
-- Worth writing down here, because the first version of the search had this
-- index and never used it. It asked all four questions — phone, token, id,
-- name — as one OR, and one unindexable branch in an OR makes Postgres scan
-- the whole table for all of them. The search is two statements now: the
-- indexable branches as a UNION, each keeping its own index, and the
-- middle-of-a-name case as a separate fallback that runs only when the first
-- found nothing. Measured on 20,001 rows in staging: phone equality 0.03 ms on
-- an Index Scan against 12 ms scanning, a selective name prefix 0.03 ms on a
-- Bitmap Index Scan against 29 ms.
--
-- What this does NOT accelerate is that fallback — a surname typed on its own.
-- It needs a trigram index, `pg_trgm` is not installed on this database, and
-- installing an extension is a deployment decision rather than a read model's
-- to take. That case stays a scan with a hard cap on the rows returned, which
-- is bounded and correct and slower than it could be; the upgrade is recorded
-- in the programme register.
create index if not exists patients_normalized_name
  on jmc.patients (lower(regexp_replace(name, '\s+', ' ', 'g')) text_pattern_ops);


-- ── 2. Finding a patient by phone ──────────────────────────────────────────
--
-- The last ten digits, because a number is written +91 98765 43210 one day and
-- 9876543210 the next and they are the same telephone. Equality against this
-- expression is an index lookup.
create index if not exists patients_phone_digits
  on jmc.patients (right(regexp_replace(phone, '\D', '', 'g'), 10));


-- ── 3. The open queue ──────────────────────────────────────────────────────
--
-- Every workload count that starts "who is still waiting" filters
-- `appointments` on status and then orders by time. Partial, because the rows
-- that matter are the open ones and they are a vanishing fraction of the table
-- after the first year — a full index would carry every finished visit the
-- clinic has ever had in order to answer a question about eleven people.
create index if not exists appointments_open_idx
  on jmc.appointments (scheduled_at)
  where status in ('waiting', 'in_consult');


-- ── 4. Today's token ───────────────────────────────────────────────────────
--
-- Searching by the number on the slip in somebody's hand. Note that
-- `appointments.token` deliberately has NO unique index — duplicate tokens are
-- a known condition of the carried-over data and `20260909125224` declined to
-- rewrite history to pretend otherwise — so this is a lookup index and the
-- search must be able to return more than one row for one token.
create index if not exists appointments_token_idx
  on jmc.appointments (token);


-- ── 5. A patient's own history ─────────────────────────────────────────────
--
-- `encounters_patient_id_idx` exists; what the visit-progress model needs on
-- top of it is the LATEST encounter for a patient, which is a sort. Same for
-- vitals, where "was anything recorded today" is the nurse's whole question.
-- Both `created_at` and `recorded_at` are the original schema's TEXT
-- timestamps — fixed-width ISO-8601 with a Z, so they order correctly as text
-- and this index is usable — and no new text timestamp is introduced here.
create index if not exists encounters_patient_recent
  on jmc.encounters (patient_id, created_at desc);

create index if not exists vitals_patient_recent
  on jmc.vitals (patient_id, recorded_at desc);


-- ── 6. Open follow-ups ─────────────────────────────────────────────────────
--
-- Partial again, and on the due date, because the list is "open and due on or
-- before today" and a completed follow-up from two years ago never answers it.
--
-- `follow_ups_doctor_open_due_idx` already exists and this is not a duplicate
-- of it: that one leads on `doctor_id`, which answers "what is due for THIS
-- doctor" and cannot serve a clinic-wide due list, because a btree cannot skip
-- its leading column. One doctor today makes the two nearly the same query and
-- will not always.
create index if not exists follow_ups_open_due
  on jmc.follow_ups (due_date)
  where status = 'open';


-- ── 7. Resolving an idempotency key ────────────────────────────────────────
--
-- Nothing is added, and that is the finding rather than an omission. The
-- outcome lookup asks five tables what one key committed, and every one of
-- them already carries a unique index on that key because its own command
-- depends on it: `encounters_idempotency_key` (added by the migration before
-- this one), `dispenses.idempotency_key`, `payments_idempotency_key_key`,
-- `goods_receipts_idempotency_key_key`, and the partial
-- `otc_sales_idempotency`. An index that duplicates a unique constraint is
-- one more thing to maintain on every write and nothing gained on any read.
