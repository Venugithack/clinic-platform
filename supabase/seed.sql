-- Development seed. Never loaded into anything the clinic uses.
--
-- BUILD.md §3: the drug master is the doctor's deliverable and it is the real
-- bottleneck (1–2 weeks of his time, INVENTORY.md §9). Nothing waits for it —
-- the build runs against this ~20-drug seed and the schema does not care.
--
-- Note the shape of the stock inserts: a batch AND a matching `receipt` row in
-- the ledger. Stock never arrives by setting the cache. The GRN transition does
-- both atomically in M3; until it exists, the seed does the same thing by hand
-- so that stock_cache_drift stays empty from the first row.

insert into clinic (name, address, phone, timezone, open_hours) values (
  'Seed Clinic',
  '—',
  '+91 00000 00000',
  'Asia/Kolkata',
  '{"mon":["09:30-13:00","17:00-20:30"],"sun":[]}'::jsonb
);

insert into staff (id, name, role, reg_no, auth_user_id) values
  ('5eed0000-0000-0000-0000-000000000001', 'Dr Seed',  'doctor',  'REG-0000',
   'a5ed0000-0000-0000-0000-000000000001'),
  ('5eed0000-0000-0000-0000-000000000002', 'Counter',  'counter', null,
   'a5ed0000-0000-0000-0000-000000000002'),
  ('5eed0000-0000-0000-0000-000000000003', 'Admin',    'admin',   null,
   'a5ed0000-0000-0000-0000-000000000003');

-- A known PIN for every seeded staff member, so a fresh checkout can sign in.
-- Development only: app.set_staff_pin() is the real path and it requires an
-- admin to already be signed in, which is a chicken-and-egg the seed sidesteps
-- by writing the digest directly as superuser. The digits are in the repository
-- on purpose — this database holds no real patient.
update staff set pin_hash = crypt('481920', gen_salt('bf', 12)), pin_set_at = now();

insert into devices (label, device_token, idle_timeout_seconds, registered_by) values
  -- 10 minutes in the cabin, 3 at the counter (TABLET.md §5).
  ('Cabin tablet',   'seed-device-cabin',   600, '5eed0000-0000-0000-0000-000000000003'),
  ('Counter tablet', 'seed-device-counter', 180, '5eed0000-0000-0000-0000-000000000003');

insert into suppliers (id, name, contact_name, whatsapp_number, lead_time_days, return_window_days) values
  ('50990000-0000-0000-0000-000000000001', 'Kumar Distributors', 'Kumar', '+919000000001', 2, 180),
  ('50990000-0000-0000-0000-000000000002', 'Reddy Pharma',       'Reddy', '+919000000002', 4,  90);

-- Salt and strength are mandatory and structured — substitution is a lookup on
-- (salt, strength, form), never a clinical inference (INVENTORY.md §7).
insert into drugs (name, generic, salt_composition, strength, form, base_unit,
                   default_units_per_strip, default_strips_per_box, schedule,
                   default_supplier_id, reorder_level_base, reorder_qty_base) values
  ('Dolo 650',        'Paracetamol',   'Paracetamol',                              '650mg',  'tablet',   'tablet', 15, 10, 'OTC', '50990000-0000-0000-0000-000000000001', 300, 900),
  ('Calpol 650',      'Paracetamol',   'Paracetamol',                              '650mg',  'tablet',   'tablet', 15, 10, 'OTC', '50990000-0000-0000-0000-000000000002', 150, 450),
  ('Combiflam',       'Ibuprofen',     'Ibuprofen + Paracetamol',                  '400/325mg', 'tablet','tablet', 20, 10, 'OTC', '50990000-0000-0000-0000-000000000001', 200, 600),
  ('Augmentin 625',   'Co-amoxiclav',  'Amoxicillin + Clavulanic Acid',            '625mg',  'tablet',   'tablet',  6, 10, 'H',   '50990000-0000-0000-0000-000000000001',  60, 180),
  ('Azithral 500',    'Azithromycin',  'Azithromycin',                             '500mg',  'tablet',   'tablet',  5, 10, 'H',   '50990000-0000-0000-0000-000000000001',  50, 150),
  ('Pan 40',          'Pantoprazole',  'Pantoprazole',                             '40mg',   'tablet',   'tablet', 15, 10, 'H',   '50990000-0000-0000-0000-000000000002', 150, 450),
  ('Zerodol-SP',      'Aceclofenac',   'Aceclofenac + Paracetamol + Serratiopeptidase', '100/325/15mg', 'tablet', 'tablet', 10, 10, 'H', '50990000-0000-0000-0000-000000000001', 100, 300),
  ('Cetzine',         'Cetirizine',    'Cetirizine',                               '10mg',   'tablet',   'tablet', 10, 10, 'OTC', '50990000-0000-0000-0000-000000000002', 100, 300),
  ('Montair-LC',      'Montelukast',   'Montelukast + Levocetirizine',             '10/5mg', 'tablet',   'tablet', 10, 10, 'H',   '50990000-0000-0000-0000-000000000002',  60, 180),
  ('Glycomet 500',    'Metformin',     'Metformin',                                '500mg',  'tablet',   'tablet', 20, 10, 'H',   '50990000-0000-0000-0000-000000000001', 200, 600),
  ('Telma 40',        'Telmisartan',   'Telmisartan',                              '40mg',   'tablet',   'tablet', 15, 10, 'H',   '50990000-0000-0000-0000-000000000002', 150, 450),
  ('Amlong 5',        'Amlodipine',    'Amlodipine',                               '5mg',    'tablet',   'tablet', 15, 10, 'H',   '50990000-0000-0000-0000-000000000002', 150, 450),
  ('Atorva 10',       'Atorvastatin',  'Atorvastatin',                             '10mg',   'tablet',   'tablet', 15, 10, 'H',   '50990000-0000-0000-0000-000000000001', 150, 450),
  ('Thyronorm 50',    'Levothyroxine', 'Levothyroxine',                            '50mcg',  'tablet',   'tablet', 30,  5, 'H',   '50990000-0000-0000-0000-000000000002', 120, 360),
  ('Shelcal 500',     'Calcium',       'Calcium Carbonate + Vitamin D3',           '500mg',  'tablet',   'tablet', 15, 10, 'OTC', '50990000-0000-0000-0000-000000000001', 150, 450),
  ('Zincovit',        'Multivitamin',  'Multivitamin + Multimineral',              '—',      'tablet',   'tablet', 15, 10, 'OTC', '50990000-0000-0000-0000-000000000001', 150, 450),
  ('Ondem 4',         'Ondansetron',   'Ondansetron',                              '4mg',    'tablet',   'tablet', 10, 10, 'H',   '50990000-0000-0000-0000-000000000002',  50, 150),
  ('Famocid 20',      'Famotidine',    'Famotidine',                               '20mg',   'tablet',   'tablet', 14, 10, 'H',   '50990000-0000-0000-0000-000000000002',  70, 210),
  -- Schedule H1: cannot leave on a counter sale, and the register needs the
  -- dispensing person's name (PLAN.md §15.2).
  ('Alprax 0.25',     'Alprazolam',    'Alprazolam',                               '0.25mg', 'tablet',   'tablet', 15, 10, 'H1',  '50990000-0000-0000-0000-000000000002',  30,  90),
  ('Tramazac 50',     'Tramadol',      'Tramadol',                                 '50mg',   'capsule',  'piece',  10, 10, 'H1',  '50990000-0000-0000-0000-000000000002',  30,  90),
  -- Not a tablet: base units are ml, and one "strip" is one bottle.
  ('Ascoril LS',      'Ambroxol',      'Ambroxol + Levosalbutamol + Guaifenesin',  '—',      'syrup',    'ml',    100,  1, 'H',   '50990000-0000-0000-0000-000000000001', 500, 2000),
  ('Betadine 15g',    'Povidone Iodine','Povidone Iodine',                         '5%',     'ointment', 'piece',   1,  1, 'OTC', '50990000-0000-0000-0000-000000000001',  10,  30);

-- Two batches of one drug at different MRPs, different strip sizes and
-- different expiries — the M3 gate in BUILD.md §2, seeded so it can be tried by
-- hand from the first day.
insert into stock_batches
  (drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id)
select d.id, v.batch_no, app.month_end(current_date + v.days), v.ups, v.spb,
       v.mrp, 'strip', v.cost, v.qty, v.qty, v.supplier::uuid
from (values
  ('Dolo 650',      'DL2411A',  400, 15, 10,  34.50, 1.9000, 1500, '50990000-0000-0000-0000-000000000001'),
  ('Dolo 650',      'DL2503B',   90, 10, 10,  24.00, 2.0000,  300, '50990000-0000-0000-0000-000000000001'),
  ('Augmentin 625', 'AU2502X',  300,  6, 10, 223.00, 30.0000,  180, '50990000-0000-0000-0000-000000000001'),
  ('Azithral 500',  'AZ2501M',  250,  5, 10, 132.00, 22.0000,  150, '50990000-0000-0000-0000-000000000001'),
  ('Pan 40',        'PN2506K',  500, 15, 10, 165.00,  9.5000,  450, '50990000-0000-0000-0000-000000000002'),
  ('Cetzine',       'CZ2412Q',  200, 10, 10,  44.00,  3.6000,  300, '50990000-0000-0000-0000-000000000002'),
  ('Glycomet 500',  'GM2505R',  450, 20, 10,  32.00,  1.2000,  600, '50990000-0000-0000-0000-000000000001'),
  ('Telma 40',      'TM2504S',  380, 15, 10, 148.00,  8.4000,  450, '50990000-0000-0000-0000-000000000002'),
  ('Alprax 0.25',   'AX2503H',  320, 15, 10,  38.00,  2.2000,   90, '50990000-0000-0000-0000-000000000002'),
  ('Ascoril LS',    'AS2502L',  270,100,  1, 128.00,  1.0500,  500, '50990000-0000-0000-0000-000000000001'),
  -- Inside the 90-day expiring window, and Kumar's 180-day return window shut
  -- months ago: still perfectly good stock, no longer sendable back. This is
  -- the case INVENTORY.md §6 calls pure loss, and the reason the list is built
  -- on the return deadline rather than on the expiry date.
  ('Zincovit',      'ZV2411E',   45, 15, 10,  98.00,  5.4000,  150, '50990000-0000-0000-0000-000000000001'),
  -- The other side of the same rule: expiry is a long way off, but Kumar wants
  -- it back 180 days before that, so the door closes within weeks.
  ('Shelcal 500',   'SC2506T',  200, 15, 10, 112.00,  6.2000,  300, '50990000-0000-0000-0000-000000000001'),
  -- Already expired: excluded from availability, invisible to every screen that
  -- asks what is on the shelf, and still physically in the cupboard. It appears
  -- in expired_stock and nowhere else, waiting to be written off at cost.
  ('Betadine 15g',  'BD2312V',  -60,  1,  1, 148.00, 92.0000,   12, '50990000-0000-0000-0000-000000000001')
) as v(drug_name, batch_no, days, ups, spb, mrp, cost, qty, supplier)
join drugs d on d.name = v.drug_name;

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id, note)
select b.drug_id, b.id, b.qty_base_received, 'receipt',
       '5eed0000-0000-0000-0000-000000000002', 'opening stock (seed)'
from stock_batches b;

insert into patients (name, phone, age, sex) values
  ('Ravi Kumar',    '+919000001001', 42, 'M'),
  ('Lakshmi Devi',  '+919000001002', 61, 'F'),
  ('Arun Prasad',   '+919000001003', 29, 'M'),
  -- Families share one handset constantly; a phone number is not an identity.
  ('Meena Prasad',  '+919000001003', 27, 'F');

update patients set phone_is_shared = true where phone = '+919000001003';
