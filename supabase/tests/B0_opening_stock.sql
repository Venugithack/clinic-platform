-- M11e — opening stock (PLAN.md §16 step 1, INVENTORY.md §1 and §4).
--
-- The shelf on go-live morning already holds four hundred batches nobody
-- entered. Getting them in is the last thing that needed a developer, and the
-- three properties below are what make the numbers right rather than
-- plausible:
--
--   it goes through app.receive_goods, so the ledger and the cache agree;
--   a batch already on the shelf is refused, because receive_goods ADDS and a
--     doubled opening balance is found three months later at a stock-take;
--   the file declares whether its quantities and costs are strips, boxes or
--     loose units, because getting that wrong is a 10x or 150x error.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c1111111-1111-1111-1111-111111111111', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-000000000011', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-000000000011'),
  ('50000000-0000-0000-0000-000000000012', 'Latha', 'counter',
   'a0000000-0000-0000-0000-000000000012');

insert into suppliers (id, name) values
  ('70000000-0000-0000-0000-000000000011', 'Kumar Distributors'),
  ('70000000-0000-0000-0000-000000000012', 'Reddy Pharma');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule,
                   default_units_per_strip, default_strips_per_box, default_mrp_basis,
                   default_supplier_id)
values
  ('80000000-0000-0000-0000-000000000011', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', 15, 10, 'strip', '70000000-0000-0000-0000-000000000011'),
  ('80000000-0000-0000-0000-000000000012', 'Ascoril LS', 'Levosalbutamol', '100ml',
   'syrup', 'ml', 'H', 100, 1, 'strip', '70000000-0000-0000-0000-000000000012');

-- ---------------------------------------------------------------------------
-- Who may do this.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000012', true);

select throws_ok(
  $$ select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL2411A",
     "expiry": "03/2027", "qty": 20, "cost": 18, "mrp": 24}]'::jsonb, false) $$,
  'CL005',
  null,
  'the counter does not load opening stock — it is the whole value of the shelf'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);

-- ---------------------------------------------------------------------------
-- The expiry, written the four ways a person writes it.
-- ---------------------------------------------------------------------------
select is(app.parse_expiry('03/2027'), '2027-03-01'::date, '03/2027 is March 2027');
select is(app.parse_expiry('3-27'),    '2027-03-01'::date, 'and so is 3-27, which is what is printed on the strip');
select is(app.parse_expiry('2027-03'), '2027-03-01'::date, 'and 2027-03');
select is(app.parse_expiry('2027-03-31'), '2027-03-31'::date, 'and a full ISO date');
select is(app.parse_expiry('March 2027'), null, 'anything else is reported rather than guessed at');
select is(app.parse_expiry('13/2027'), null, 'and there is no thirteenth month');

-- ---------------------------------------------------------------------------
-- The dry run, and the number that catches a wrong basis.
-- ---------------------------------------------------------------------------
create temporary table t_file as select '[
  {"name": "Dolo 650", "strength": "650mg", "batch_no": "DL2411A",
   "expiry": "03/2027", "qty": 20, "qty_basis": "strip",
   "cost": 18.00, "cost_basis": "strip", "mrp": 34.50,
   "supplier": "Kumar Distributors"},
  {"name": "Dolo 650", "strength": "650mg", "batch_no": "DL2503B",
   "expiry": "2026-12", "qty": 2, "qty_basis": "box",
   "cost": 170.00, "cost_basis": "box", "mrp": 24.00,
   "supplier": "Kumar Distributors"},
  {"name": "Ascoril LS", "batch_no": "AS2502C", "expiry": "09/2027",
   "qty": 600, "qty_basis": "unit", "cost": 0.55, "cost_basis": "unit",
   "mrp": 118.00}
]'::jsonb as rows;

create temporary table t_dry as
select app.import_opening_stock((select rows from t_file)) as result;

select is(
  (select (result ->> 'batches')::int from t_dry),
  3,
  'the dry run counts the batches'
);

select is(
  (select (result ->> 'units')::bigint from t_dry),
  (20 * 15 + 2 * 150 + 600)::bigint,
  'in base units, converting strips and boxes and leaving loose units alone (INVENTORY.md §1)'
);

-- 1029.99, not the 1030.00 the invoice adds up to, and the one paisa is real:
-- a box at ₹170 over 150 tablets is ₹1.13333… and the batch stores a cost per
-- base unit to four places (INVENTORY.md §4). The preview deliberately shows
-- what will be STORED rather than what the invoice says — a number that
-- disagreed with the stock valuation screen five minutes later would read as a
-- bug. One paisa is not the error this figure exists to catch; a cost basis
-- declared as a strip when it is a box is, and that shows up as a 10x.
select is(
  (select (result ->> 'value')::numeric from t_dry),
  1029.99::numeric,
  'and values the shelf, which is the one number a doctor already knows — a misdeclared cost basis shows up here as a 10x, instantly'
);

select is(
  (select count(*)::int from stock_batches),
  0,
  'and it writes absolutely nothing while doing it'
);

-- ---------------------------------------------------------------------------
-- Rule 1: the drug master is step one.
-- ---------------------------------------------------------------------------
select alike(
  (select app.import_opening_stock('[{"name": "Zerodol SP", "batch_no": "ZS01",
     "expiry": "03/2027", "qty": 5, "cost": 60, "mrp": 90}]'::jsonb)
   -> 'errors' -> 0 ->> 'message'),
  '%load the drug master first%',
  'a drug the master has never heard of is a typo, not an invitation to invent one'
);

select alike(
  (select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL9",
     "expiry": "03/2027", "qty": 5, "cost": 60, "mrp": 90,
     "supplier": "Somebody Else"}]'::jsonb) -> 'errors' -> 0 ->> 'message'),
  '%no supplier called%',
  'and neither is a supplier nobody has heard of'
);

-- ---------------------------------------------------------------------------
-- The refusals that protect the shelf's numbers.
-- ---------------------------------------------------------------------------
select alike(
  (select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL1",
     "expiry": "03/2019", "qty": 5, "cost": 60, "mrp": 90}]'::jsonb)
   -> 'errors' -> 0 ->> 'message'),
  '%expired%written off, not loaded%',
  'expired stock is not opening stock — it is a write-off, and it has its own screen'
);

select alike(
  (select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL1",
     "expiry": "03/2027", "qty": 5, "cost": 60}]'::jsonb)
   -> 'errors' -> 0 ->> 'message'),
  '%no MRP%',
  'a batch with no MRP cannot be sold, so it is refused rather than shelved unsellable'
);

select alike(
  (select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL1",
     "expiry": "03/2027", "qty": 5, "mrp": 90}]'::jsonb)
   -> 'errors' -> 0 ->> 'message'),
  '%cannot be valued%',
  'and one with no cost cannot be valued (INVENTORY.md §4)'
);

select alike(
  (select app.import_opening_stock('[{"name": "Dolo 650", "batch_no": "DL1",
     "expiry": "03/2027", "qty": 2.5, "cost": 60, "mrp": 90}]'::jsonb)
   -> 'errors' -> 0 ->> 'message'),
  '%whole packs%',
  'two and a half strips is a quantity in the wrong unit, not a half strip'
);

select is(
  (select jsonb_array_length(app.import_opening_stock('[
     {"name": "Dolo 650", "batch_no": "DL1", "expiry": "03/2027", "qty": 5, "cost": 60},
     {"name": "Nothing Real", "batch_no": "X", "expiry": "03/2027", "qty": 1, "cost": 1, "mrp": 1},
     {"name": "Dolo 650", "batch_no": "DL2", "expiry": "banana", "qty": 5, "cost": 60, "mrp": 90}
   ]'::jsonb) -> 'errors')),
  3,
  'every bad row is reported, not the first — a five-hundred-row file fixed one error at a time is a file somebody abandons'
);

-- ---------------------------------------------------------------------------
-- The real thing, and what it leaves behind.
-- ---------------------------------------------------------------------------
create temporary table t_real as
select app.import_opening_stock((select rows from t_file), false) as result;

select is(
  (select count(*)::int from stock_batches),
  3,
  'the shelf is loaded'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL2411A'),
  300,
  '20 strips of 15 is 300 tablets — packs in, base units stored'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL2503B'),
  300,
  'and 2 boxes of 10 strips of 15 is also 300, by a different route'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'AS2502C'),
  600,
  'while 600ml of syrup is 600, because loose units are already base units'
);

select is(
  (select cost_per_base_unit from stock_batches where batch_no = 'DL2503B'),
  1.1333::numeric(12, 4),
  'a cost quoted per box becomes a cost per tablet, to four places'
);

select is(
  (select expiry from stock_batches where batch_no = 'DL2411A'),
  '2027-03-31'::date,
  'and the expiry is the END of the printed month, because the strip is good all month'
);

-- Rule 3 of PLAN.md §5.3: the cache agrees with the ledger, because the same
-- transition wrote both.
select is(
  (select sum(m.qty_base)::int from stock_movements m
   join stock_batches b on b.id = m.batch_id where b.batch_no = 'DL2411A'),
  300,
  'the ledger has the movement, not just the batch — opening stock goes THROUGH goods receipt, never around it'
);

select is(
  (select count(distinct grn_id)::int from stock_batches),
  2,
  'one goods receipt per supplier, because a batch that does not know who supplied it can never be returned to them'
);

select is(
  (select awaiting_invoice from goods_receipts g
   join stock_batches b on b.grn_id = g.id where b.batch_no = 'DL2411A'),
  true,
  'and a receipt with no invoice says so — the clinic genuinely has no invoice for stock that was already on the shelf'
);

select is(
  (select supplier_id from stock_batches where batch_no = 'AS2502C'),
  '70000000-0000-0000-0000-000000000012'::uuid,
  'a row that names no supplier falls back to the drug''s usual one, so the return route still exists'
);

-- ---------------------------------------------------------------------------
-- Rule 2: the one that stops the shelf doubling.
-- ---------------------------------------------------------------------------
select alike(
  (select app.import_opening_stock((select rows from t_file))
   -> 'errors' -> 0 ->> 'message'),
  '%already on the shelf%',
  'running the file again is refused by name, because receive_goods ADDS and nobody would notice until a stock-take'
);

select throws_ok(
  format($$ select app.import_opening_stock(%L::jsonb, false) $$, (select rows from t_file)),
  'CL025',
  null,
  'and the real run of it is refused outright'
);

select is(
  (select sum(qty_base_on_hand)::int from stock_batches),
  1200,
  'so the shelf still holds what it held — not twice that'
);

select alike(
  (select app.import_opening_stock('[
     {"name": "Dolo 650", "batch_no": "NEW1", "expiry": "03/2027", "qty": 1, "cost": 18, "mrp": 34.5},
     {"name": "Dolo 650", "batch_no": "new1", "expiry": "03/2027", "qty": 1, "cost": 18, "mrp": 34.5}
   ]'::jsonb) -> 'errors' -> 0 ->> 'message'),
  '%appears twice in this file%',
  'and the same batch listed twice in one file is caught too, which is the same mistake made faster'
);

select * from finish();
rollback;
