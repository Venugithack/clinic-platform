-- ═══════════════════════════════════════════════════════════════════════════
-- SAME ATTENDANCE CLOSES THE VISIT IT NAMES
--
-- Owner policy item 72: Same attendance "creates an append-only audited
-- reconciliation link and closes the leftover visit without another encounter
-- or fee". It does not describe a Same attendance that closes nothing.
--
-- `20260920000000` enforced the weaker half of that — only a same-attendance
-- may close a visit — and permitted the shape the third acceptance review
-- reproduced: a determination naming a visit that was ALREADY cancelled or
-- finished, recorded with `subject_visit_closed = false`, and then described on
-- the doctor's next press as a visit they had closed. A false sentence in a
-- clinical record, and one that spent the reference's single resolution on its
-- way to being said.
--
-- The command refuses that now, before anything is written. This is the other
-- half, and the reason for both is the one this schema keeps returning to: the
-- constraint is the guarantee and cannot be forgotten, and the command is the
-- sentence somebody reads, which a constraint violation is not.
--
-- Forward-only. Nothing already applied is edited, no column is dropped, no row
-- is rewritten. Re-runnable: the constraint is added under a name guard, and the
-- pre-flight below is a read.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ── The rows this would refuse, named before they are refused ──────────────
--
-- Same reasoning as the duplicate-token guard in `20260920000000`: the rows
-- that violate this are exactly the rows the code being corrected could write,
-- and 23514 tells an operator the name of a check rather than which
-- reconciliation to go and look at. A resolution is a clinical determination
-- by a named doctor, so it is read rather than migrated past.
do $$
declare hollow text;
begin
  select string_agg(id, ', ' order by id)
    into hollow
    from jmc.consultation_attempt_resolutions
   where resolution = 'same_attendance'
     and subject_visit_id is not null
     and not subject_visit_closed;

  if hollow is not null then
    raise exception
      'These reconciliations record a visit as the same attendance without having closed it, which owner '
      'policy item 72 does not describe and which the clinic afterwards reports as a closure that did not '
      'happen: %. A doctor recorded each one; read them, close or cancel the visits they name, and record '
      'the correction, before applying this migration.', hollow;
  end if;
end $$;


-- ── The invariant ─────────────────────────────────────────────────────────
--
-- Read both ways round:
--
--   a same-attendance that NAMES a visit has closed it;
--   nothing else may claim to have closed one.
--
-- The second half was already true and is restated here so that one constraint
-- carries the whole rule, rather than a reader having to find two and notice
-- that together they mean something neither says.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_same_attendance_closes_its_visit'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_same_attendance_closes_its_visit
      check (
        case
          when resolution = 'same_attendance' and subject_visit_id is not null
            then subject_visit_closed
          else not subject_visit_closed
        end
      );
  end if;
end $$;

comment on column jmc.consultation_attempt_resolutions.subject_visit_closed is
  'Whether this determination closed the visit it named. Owner item 72: a same-attendance naming a visit always closes it, and nothing else ever closes one.';
