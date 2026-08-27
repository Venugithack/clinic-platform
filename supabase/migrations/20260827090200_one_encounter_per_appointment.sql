-- ---------------------------------------------------------------------------
-- One appointment has one encounter, and now the database is the one saying so.
--
-- `20260824090100_queue_today_one_encounter.sql` stopped a duplicate reaching a
-- screen and said, in as many words, that it was not the whole fix: "the whole
-- fix is `unique (appointment_id)` on encounters plus an upsert in
-- `startEncounter`, which is a forward-only migration over clinical data that
-- already carries duplicates, and it wants a plan of its own."
--
-- This is the plan.
--
-- HOW THE DUPLICATES GET THERE. `startEncounter` reads-then-inserts with no
-- constraint behind it, so two overlapping calls both see nothing and both
-- insert. React re-invoking an effect is enough; it was reproduced live, two
-- encounters 0.7 ms apart from strict mode's double effect.
--
-- WHAT HAPPENS TO ONE THAT IS ALREADY THERE. It is DETACHED, not deleted.
--
-- Deleting would be the short way and it is the wrong one twice over. An
-- encounter is clinical content a doctor typed, and `prescriptions.encounter_id`
-- may point at it — a signed prescription hanging off the losing row would lose
-- its parent. This build's whole posture on corrections is that they are
-- compensating rows and never erasures (A5_permissions test 2: "nothing is
-- deletable by anybody through the API"), and a migration is not the place to
-- make the one exception.
--
-- So the EARLIEST encounter keeps the appointment. That is not an arbitrary
-- choice: `queue_today`'s lateral and `encounterForAppointment` both already
-- take the earliest by `(created_at, id)`, so this migration hands the link to
-- the row the board and the consult screen have been agreeing on all along.
-- Every later one keeps its id, its findings, its prescriptions and its patient,
-- and gives up only `appointment_id`.
--
-- Each detachment writes an audit row, because a row that quietly changed under
-- a doctor is exactly what the audit log is for. `app.write_audit` needs a
-- signed-in staff member and there is nobody signed in during a migration, so
-- these are written directly with actor_type 'system' — the same shape the
-- replay log uses for work no human did.
-- ---------------------------------------------------------------------------

do $$
declare
  v_detached int;
begin
  with ranked as (
    select
      id,
      appointment_id,
      row_number() over (partition by appointment_id order by created_at, id) as rn
    from encounters
    where appointment_id is not null
  ),
  losers as (
    select id, appointment_id from ranked where rn > 1
  ),
  logged as (
    insert into audit_log (actor_type, actor_staff_id, action, entity, entity_id, before, after)
    select
      'system', null,
      'detach_duplicate_encounter', 'encounters', l.id,
      jsonb_build_object('appointment_id', l.appointment_id),
      jsonb_build_object('appointment_id', null,
                         'reason', 'unique (appointment_id) added; the earliest encounter keeps the appointment')
    from losers l
    returning 1
  )
  update encounters e
  set appointment_id = null
  from losers l
  where e.id = l.id;

  get diagnostics v_detached = row_count;
  raise notice 'detached % duplicate encounter(s) from their appointments', v_detached;
end
$$;

-- NOT a partial index, though `appointment_id` is nullable and only the
-- non-null ones are being constrained.
--
-- Postgres already treats nulls as distinct in a unique index, so a plain one
-- permits any number of encounters with no appointment — which is the same
-- thing a partial index would have bought. What a partial index would also have
-- cost is the upsert: `ON CONFLICT (appointment_id)` cannot infer a partial
-- index unless the statement repeats the index predicate, and PostgREST has no
-- way to send one. The constraint had to be inferrable or the client half of
-- this fix could not be written.
alter table encounters
  add constraint encounters_one_per_appointment unique (appointment_id);

comment on constraint encounters_one_per_appointment on encounters is
  'One appointment, one encounter. Nulls stay distinct, so encounters with no appointment are unaffected. Named and non-partial so `ON CONFLICT (appointment_id)` can infer it from PostgREST.';

-- `encounters_appointment_idx` from 20260824090100 was `(appointment_id,
-- created_at, id)`, and existed to make "the earliest encounter for this
-- appointment" cheap and unambiguous. The unique constraint's own index now
-- covers lookup by appointment_id, and there is at most one row to be earliest
-- among, so the tiebreak columns have nothing left to break.
--
-- Dropped rather than left: a redundant index is write amplification on a table
-- every consultation inserts into.
drop index if exists encounters_appointment_idx;
