-- Slice 2.1.1: a resolution may only answer a question the line actually asks.
--
-- Slice 2.1 gave a doctor an append-only way to say what an unreadable legacy
-- line meant. It checked the doctor's role and the shape of the payload, read
-- `medicine_state` and `quantity_state` — and then ignored them.
--
-- So a doctor who reached the command directly could write a resolution
-- against ANY line, including an ordinary one signed through this application
-- five minutes earlier. `prescription_lines_effective` folds the newest
-- resolution over the line with `coalesce(r.medicine_id, l.medicine_id)`, and
-- from Slice 4 that view is what the pharmacy hands over against. The signed
-- row and `items_json` would still say Amoxicillin 12; the counter would give
-- out Tramadol 60. Nothing in the record would look edited, because nothing
-- was: the amendment simply outranks it.
--
-- That is not a resolution, it is an amendment to signed clinical intent, and
-- OWNER_POLICY_REGISTER.md 21 and §4 of the brief both say an amendment is a
-- new or replacement order rather than a change to this one.
--
-- The rule this migration enforces:
--
--   * a resolution may target a line ONLY where the line was signed without a
--     readable medicine or without a readable quantity;
--   * it may name a medicine only where the medicine was the unreadable part;
--   * it may name a quantity only where the quantity was the unreadable part;
--   * after a cancellation, nothing further may be recorded against the line.
--
-- Correction stays possible, because the states being tested are the LINE's
-- and the line never changes: a doctor who identified the wrong medicine on
-- Tuesday records another resolution on Thursday and both remain visible.
--
-- ── WHY THE DATABASE AND NOT ONLY THE COMMAND ──────────────────────────────
--
-- commands.ts refuses these in friendly words, which is what a doctor should
-- meet. But the brief is explicit that authorization is enforced server-side
-- and that a check nobody can bypass belongs where the write lands. The
-- command layer is one `if` away from this being possible again; the trigger
-- is not, and it also covers the migration, the psql session and the repair
-- script that never went through a command.
--
-- Every object is schema-qualified.

create or replace function jmc.enforce_resolution_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  line_medicine_state text;
  line_quantity_state text;
  already_cancelled   boolean;
begin
  -- `for update` locks the line, and that lock is what serializes two doctors
  -- resolving the same line at the same moment. The cancellation test below
  -- runs after the lock is held, so under READ COMMITTED the second
  -- transaction re-reads and sees the first one's cancel rather than racing
  -- past it into a row that is now forbidden.
  select l.medicine_state, l.quantity_state
    into line_medicine_state, line_quantity_state
    from jmc.prescription_lines l
   where l.id = new.prescription_line_id
     for update;

  if not found then
    raise exception 'Prescription line % does not exist.', new.prescription_line_id;
  end if;

  -- Cancellation first: it is the most final thing that can be true of a line,
  -- and saying so is more useful than "this line is not legacy".
  select exists (
    select 1 from jmc.prescription_line_resolutions r
     where r.prescription_line_id = new.prescription_line_id
       and r.action = 'cancel'
  ) into already_cancelled;

  if already_cancelled then
    raise exception
      'That prescription line was cancelled by a doctor. Cancellation is final; supplying it again needs a new order.';
  end if;

  if line_medicine_state <> 'unresolved_legacy' and line_quantity_state <> 'unknown_legacy' then
    raise exception
      'That prescription line records both its medicine and its quantity. A signed prescription is not amended; write a new prescription instead.';
  end if;

  if new.medicine_id is not null and line_medicine_state <> 'unresolved_legacy' then
    raise exception
      'That prescription line already records which medicine was prescribed. Only its quantity may be determined.';
  end if;

  if new.prescribed_quantity is not null and line_quantity_state <> 'unknown_legacy' then
    raise exception
      'That prescription line already records the quantity prescribed. Only its medicine may be determined.';
  end if;

  return new;
end;
$$;

drop trigger if exists prescription_line_resolutions_in_scope
  on jmc.prescription_line_resolutions;
create trigger prescription_line_resolutions_in_scope
before insert on jmc.prescription_line_resolutions
for each row execute function jmc.enforce_resolution_scope();

comment on function jmc.enforce_resolution_scope() is
  'A resolution may only determine a part of a prescription line that was signed unreadable, '
  'and nothing may follow a cancellation. Mirrored in friendly words by commands.ts.';

-- ── the resolutions already recorded ───────────────────────────────────────
--
-- Nothing outside scope can exist: Slice 2.1 has never been deployed, so the
-- only resolutions anywhere are in staging databases built by this repository.
-- Asserting it costs one query and turns a silent surprise into a failed
-- migration, which is the right way round for a rule this migration is about
-- to make unbreakable.
do $$
declare
  bad integer;
begin
  select count(*) into bad
    from jmc.prescription_line_resolutions r
    join jmc.prescription_lines l on l.id = r.prescription_line_id
   where (l.medicine_state <> 'unresolved_legacy' and l.quantity_state <> 'unknown_legacy')
      or (r.medicine_id is not null and l.medicine_state <> 'unresolved_legacy')
      or (r.prescribed_quantity is not null and l.quantity_state <> 'unknown_legacy');

  if bad > 0 then
    raise exception
      '% existing prescription line resolution(s) fall outside the scope this migration enforces. Review them before applying.', bad;
  end if;
end $$;
