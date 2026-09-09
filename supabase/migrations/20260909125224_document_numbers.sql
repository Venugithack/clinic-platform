-- Document numbers that cannot be issued twice.
--
-- Every printed identifier this clinic uses — the OTC receipt, the purchase
-- order, the supplier return note, the stock-take reference, the queue token a
-- patient is holding in the corridor — was minted by counting the rows in its
-- own table and adding one. That is a number derived from a figure two people
-- can read at the same instant, and it fails in both of the ways such a figure
-- always fails.
--
-- It RACES. Two tablets ringing up a sale in the same second both see seven
-- rows, both mint OTC-0008, and the second insert dies on the unique index. All
-- the counter is told is "The request could not be completed.", so the sale is
-- rung again — a sale that was never wrong in the first place.
--
-- It REPEATS. Delete one row for any reason and the count falls back over a
-- number that is already printed on paper, already in a customer's hand and
-- already written into somebody's book. Two different sales, one receipt
-- number, and afterwards no way to say which is which.
--
-- The queue token is the same bug with the alarm disconnected: appointments.token
-- carries no unique index, so nothing complains at all. Two waiting patients
-- simply hold JMC-0004, and one of them is called in for the other's
-- consultation. That index is deliberately NOT added here. This has to apply to
-- a database that has been running a clinic for months, duplicate tokens are
-- precisely what such a database is likely to be holding, and a migration that
-- fails on the damage it exists to stop helps nobody.
--
-- ── STARTING EACH SERIES WHERE THE PAPER STOPPED ───────────────────────────
--
-- A sequence created fresh starts at 1, which on the live database would mint
-- OTC-0001 for a receipt whose number was used months ago. So each one is set
-- past the highest number its column already holds, read from the rows.
--
-- Those values are text — 'OTC-0007' — so the number is the run of digits at
-- the end. It is taken with a regex rather than by cutting after the prefix: a
-- value stored bare, with no prefix at all, still has to read as its number,
-- and appointments.token is a column nothing has ever policed. A value with no
-- trailing digits contributes nothing, and neither does one whose tail is too
-- long to be a bigint; the application pads to four digits and counts upward
-- from here, so it can never print either shape and can never collide with one.
-- An empty table falls through coalesce to 0 and the series begins at 1, which
-- is exactly where counting the rows began.
--
-- `setval(seq, n, false)` says "n is the next value to hand out", not "n was
-- the last one handed out" — so the argument is max + 1 and the first number
-- minted after this runs is one past everything already in the table.

set local search_path = jmc;

create sequence if not exists appointment_token_seq;
select setval(
  'jmc.appointment_token_seq',
  coalesce(
    (select max(tail::bigint)
       from (select substring(token from '[0-9]+$') as tail from appointments) s
      where tail is not null and length(tail) <= 18),
    0
  ) + 1,
  false
);

create sequence if not exists otc_receipt_seq;
select setval(
  'jmc.otc_receipt_seq',
  coalesce(
    (select max(tail::bigint)
       from (select substring(receipt_number from '[0-9]+$') as tail from otc_sales) s
      where tail is not null and length(tail) <= 18),
    0
  ) + 1,
  false
);

create sequence if not exists purchase_order_seq;
select setval(
  'jmc.purchase_order_seq',
  coalesce(
    (select max(tail::bigint)
       from (select substring(order_number from '[0-9]+$') as tail from purchase_orders) s
      where tail is not null and length(tail) <= 18),
    0
  ) + 1,
  false
);

create sequence if not exists supplier_return_seq;
select setval(
  'jmc.supplier_return_seq',
  coalesce(
    (select max(tail::bigint)
       from (select substring(note_number from '[0-9]+$') as tail from supplier_returns) s
      where tail is not null and length(tail) <= 18),
    0
  ) + 1,
  false
);

create sequence if not exists stock_take_seq;
select setval(
  'jmc.stock_take_seq',
  coalesce(
    (select max(tail::bigint)
       from (select substring(reference from '[0-9]+$') as tail from stock_takes) s
      where tail is not null and length(tail) <= 18),
    0
  ) + 1,
  false
);
