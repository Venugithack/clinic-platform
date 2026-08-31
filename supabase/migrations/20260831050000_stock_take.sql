-- Stock-take: counting the shelf, and correcting the record against it.
--
-- Two rules are enforced here rather than in the UI, because both are the kind
-- of mistake that destroys the inventory rather than merely annoying someone.
--
-- 1. ONE OPEN STOCK-TAKE AT A TIME. Two people counting the same shelf into two
--    different sheets produces two different answers and no way to pick.
--
-- 2. A LINE EXISTS ONLY WHERE SOMEONE TYPED A NUMBER. There is no row for an
--    uncounted batch, so a partial count cannot post zeros for the rest of the
--    pharmacy. "Not counted" and "counted zero" must never collapse into each
--    other — the second is the most important count there is.
set local search_path = jmc, public;

create table if not exists stock_takes (
  id text primary key,
  reference text not null unique,
  scope text not null check (scope in ('full', 'partial')),
  scope_note text not null default '',
  status text not null check (status in ('counting', 'submitted', 'posted', 'abandoned')),
  -- Variance above this RUPEE value must be recounted before it can post.
  -- Value, not quantity: 3 missing insulin pens matter, 3 missing paracetamol
  -- tablets do not, and a threshold on quantity gets that exactly backwards.
  recount_threshold real not null default 500,
  started_at text not null,
  started_by text not null references staff(id),
  submitted_at text,
  submitted_by text references staff(id),
  posted_at text,
  posted_by text references staff(id),
  note text not null default ''
);

create unique index if not exists stock_takes_one_open
  on stock_takes ((1)) where status in ('counting', 'submitted');

create table if not exists stock_take_lines (
  id text primary key,
  stock_take_id text not null references stock_takes(id) on delete cascade,
  batch_id text not null references batches(id),
  medicine_id text not null references medicines(id),
  -- Snapshotted when the count is entered, NOT read again at posting time.
  -- The adjustment posted is (counted - expected), applied as a delta to
  -- whatever the batch holds then. Setting the batch to the counted figure
  -- would silently erase every dispense made between counting and approval.
  expected_quantity integer not null,
  counted_quantity integer not null check (counted_quantity >= 0),
  variance integer not null,
  variance_value real not null,
  count_number integer not null default 1,
  counted_by text not null references staff(id),
  counted_at text not null,
  unique (stock_take_id, batch_id)
);

create index if not exists stock_take_lines_take on stock_take_lines (stock_take_id);
