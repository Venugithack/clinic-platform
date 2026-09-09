-- What a medicine legally IS, as distinct from how it may be sold.
--
-- The application records `sale_class` — otc, prescription, restricted, unknown
-- — which answers "may this leave on a counter sale?". That is a selling rule.
-- It is not the drug's schedule under the Drugs and Cosmetics Rules, and the
-- Schedule H1 register depends on the schedule, not the selling rule.
--
-- `restricted` could be H1 or X. A Schedule H1 antibiotic could perfectly well
-- be sitting as `prescription`. Deriving one from the other would build a
-- register that is wrong in both directions — missing entries that belong in it
-- and containing entries that do not — and a register an inspector can fault is
-- worse than admitting you do not have one.
--
-- So it is recorded, not inferred. And it is NOT back-filled by guessing:
-- every existing medicine starts at 'unset', the register reports how many are
-- unset, and the pharmacist sets them. A blank the register tells you about is
-- recoverable; a wrong value it does not is not.

set local search_path = jmc;

alter table medicines
  add column if not exists schedule text not null default 'unset'
  check (schedule in ('unset', 'OTC', 'H', 'H1', 'X'));

comment on column medicines.schedule is
  'Drugs and Cosmetics Rules schedule. Drives the Schedule H1 register. '
  'Distinct from sale_class, which decides whether a counter sale is allowed.';

-- The register reads this constantly; the table will not stay small.
create index if not exists medicines_schedule on medicines (schedule)
  where schedule in ('H1', 'X');
