-- Stock that is going off, and the three things you can do about it.
--
-- INVENTORY.md §6: return it to the supplier, dispense it first (FEFO already
-- does), or write it off at cost. Until now the application could do none of
-- them: expired stock stayed on the shelf, counted as an asset, and nothing
-- stopped it being dispensed.
--
-- The part that pays for itself is the return window. Most suppliers take stock
-- back within a window before expiry — typically three to six months, and it
-- differs per supplier — so a batch expiring in five months from a supplier who
-- accepts returns at six is MORE urgent than one expiring in three from a
-- supplier who accepts none. Sorting that list by expiry date, which is the
-- obvious thing, quietly loses money every year.

set local search_path = jmc;

alter table suppliers
  add column if not exists return_window_days integer not null default 0
  check (return_window_days >= 0);

comment on column suppliers.return_window_days is
  'Days before expiry within which this supplier accepts returns. 0 = accepts none. '
  'Drives the ordering of the expiring list: what to act on is whose window closes first.';

-- ---------------------------------------------------------------------------
-- Writing stock off.
--
-- The quantity leaves through the ledger like every other movement, so the
-- shelf and its history never disagree. `cost_value` is captured at write-off
-- rather than recomputed later: it is what the loss actually was, and the
-- batch's cost can be corrected afterwards without rewriting last year's
-- reported losses.
-- ---------------------------------------------------------------------------
create table if not exists stock_writeoffs (
  id           text primary key,
  batch_id     text not null references batches (id),
  medicine_id  text not null references medicines (id),
  quantity     integer not null check (quantity > 0),
  reason       text not null check (reason in ('expiry', 'damage', 'loss')),
  cost_value   real not null check (cost_value >= 0),
  note         text not null default '',
  actor_id     text not null references staff (id),
  created_at   text not null
);

create index if not exists stock_writeoffs_created on stock_writeoffs (created_at);

-- ---------------------------------------------------------------------------
-- Returning stock to whoever sold it.
--
-- A return note takes the stock out and opens a credit the supplier owes. The
-- credit is tracked to settlement rather than assumed, because a credit nobody
-- follows up is the same as a write-off with extra paperwork — which is what
-- happens when the software stops at "returned".
-- ---------------------------------------------------------------------------
create table if not exists supplier_returns (
  id              text primary key,
  note_number     text not null unique,
  supplier_id     text not null references suppliers (id),
  batch_id        text not null references batches (id),
  medicine_id     text not null references medicines (id),
  quantity        integer not null check (quantity > 0),
  expected_credit real not null check (expected_credit >= 0),
  status          text not null check (status in ('sent', 'credited', 'rejected')),
  settled_at      text,
  note            text not null default '',
  actor_id        text not null references staff (id),
  created_at      text not null
);

create index if not exists supplier_returns_open on supplier_returns (supplier_id)
  where status = 'sent';
