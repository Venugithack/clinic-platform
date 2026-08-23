-- One appointment is one row on the board, whatever the encounters table says.
--
-- `queue_today` joined encounters with nothing behind it to keep the join
-- one-to-one:
--
--   left join encounters e on e.appointment_id = a.id
--
-- `encounters.appointment_id` is a plain reference with no unique constraint, so
-- an appointment with two encounters became two rows. The board showed token 1
-- twice while `appointments` held a single row for it, and the doctor's screen
-- was the one telling the lie.
--
-- The count is worse than the duplicate. `ahead` — "3 ahead of you", PLAN.md
-- §14 — is a window function over these rows, so a fanned-out row inflates the
-- position of every patient behind it and the wait estimate with it. A
-- duplicate the doctor could have spotted quietly moved a real number on a real
-- patient's screen.
--
-- Two encounters is not hypothetical: `startEncounter` reads-then-inserts, so
-- two overlapping calls both see nothing and both insert. React re-invoking an
-- effect is enough — this was reproduced live, two encounters 0.7 ms apart from
-- strict mode's double effect.
--
-- The lateral takes the earliest, which is the same choice
-- `encounterForAppointment` already makes (lib/db/encounters.ts) — so the board
-- and the consult screen now agree about which encounter an appointment has,
-- and the defence that had been applied only to the client reaches the view.
--
-- This is not the whole fix, deliberately. The whole fix is
-- `unique (appointment_id)` on encounters plus an upsert in `startEncounter`,
-- which is a forward-only migration over clinical data that already carries
-- duplicates, and it wants a plan of its own. This migration stops the
-- duplicate reaching a screen; it does not stop it being written.

-- `(created_at, id)` and not `created_at` alone: the two rows this exists to
-- survive were 0.7 ms apart, and nothing says a timestamp cannot tie. Without
-- the tiebreak "the earliest" is whichever row the plan happened to reach
-- first, and the view and the consult screen could pick differently for the
-- same appointment.
create index if not exists encounters_appointment_idx
  on encounters (appointment_id, created_at, id);

create or replace view queue_today as
select
  a.id            as appointment_id,
  a.date,
  a.token_no,
  a.status,
  a.source,
  a.reason,
  p.id            as patient_id,
  p.name          as patient_name,
  p.age,
  p.sex,
  p.phone,
  p.allergies,
  e.id            as encounter_id,
  -- "3 ahead of you" (PLAN.md §14) counted over the people actually waiting,
  -- not over the whole day's list.
  count(*) filter (where a.status = 'waiting')
    over (order by a.token_no rows between unbounded preceding and 1 preceding) as ahead
from appointments a
join patients p on p.id = a.patient_id
left join lateral (
  select en.id
  from encounters en
  where en.appointment_id = a.id
  order by en.created_at, en.id
  limit 1
) e on true
where a.date = current_date;

comment on view queue_today is
  'The default screen on both tablets (TABLET.md §7). One row per appointment: the lateral takes the earliest encounter, so a duplicate cannot double a token or inflate `ahead`.';
