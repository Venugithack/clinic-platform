-- The cash drawer, and closing the day against it.
--
-- PLAN.md M4: "the day's total matches the sum of its bills; the till
-- reconciles against counted cash". Without this you cannot answer the only
-- question that matters at 8pm — is ₹400 missing, or was it never taken? — and
-- you will not find out for weeks, by which point nobody remembers the day.

set local search_path = jmc;

-- ---------------------------------------------------------------------------
-- A till session: opened with a float, closed against counted cash.
--
-- `expected_cash` and `variance` are STORED at close, not recomputed on
-- reading. A bill voided next week must not silently change what last Tuesday's
-- drawer was supposed to hold — the whole point of a day-close is that it is a
-- statement about a moment, and a figure that moves afterwards cannot be
-- reconciled against anything.
-- ---------------------------------------------------------------------------
create table if not exists till_sessions (
  id             text primary key,
  opened_at      text not null,
  opened_by      text not null references staff (id),
  opening_float  real not null check (opening_float >= 0),

  closed_at      text,
  closed_by      text references staff (id),
  counted_cash   real check (counted_cash >= 0),
  expected_cash  real,
  variance       real,
  note           text not null default '',

  -- Two open tills means two people counting the same drawer and neither
  -- figure meaning anything.
  constraint till_closed_completely check (
    (closed_at is null and closed_by is null and counted_cash is null
      and expected_cash is null and variance is null)
    or
    (closed_at is not null and closed_by is not null and counted_cash is not null
      and expected_cash is not null and variance is not null)
  )
);

create unique index if not exists till_only_one_open on till_sessions ((1))
  where closed_at is null;

-- ---------------------------------------------------------------------------
-- Cash that moves for reasons other than a sale: a float top-up, petty cash for
-- a delivery, the owner taking the day's takings to the bank. Without these the
-- drawer never reconciles and staff learn to ignore the variance, which is
-- worse than not counting at all.
-- ---------------------------------------------------------------------------
create table if not exists cash_movements (
  id          text primary key,
  till_id     text not null references till_sessions (id),
  direction   text not null check (direction in ('in', 'out')),
  amount      real not null check (amount > 0),
  reason      text not null,
  actor_id    text not null references staff (id),
  created_at  text not null
);

create index if not exists cash_movements_till on cash_movements (till_id);
