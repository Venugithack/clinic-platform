-- The clinic's schema.
--
-- This existed only inside the application until now: it was built on first use
-- by whichever process started first. That was survivable when one Next server
-- owned the database and stopped being so the moment six Edge Functions could
-- cold-start independently and race each other running the same DDL.
--
-- It is also how the schema came to exist in production without existing in the
-- repository — which meant a fresh database could not be built from this code,
-- only from whatever had been run by hand. This file is that gap closed.
--
-- Everything lives in `jmc` rather than `public`, because the database is shared
-- with the application this one replaced and eight table names collide: staff,
-- patients, bills, appointments, vitals, prescriptions, encounters, suppliers.

create schema if not exists jmc;
set local search_path = jmc;


  create table if not exists staff (
    id text primary key,
    name text not null,
    username text not null unique,
    phone text not null default '',
    roles_json text not null,
    pin_hash text not null,
    pin_salt text not null,
    active integer not null default 1,
    last_login text,
    created_at text not null
  );

  -- Failed PIN attempts, charged to the CALLER rather than to the account.
  --
  -- Locking the account is the obvious design and it is wrong on a shared
  -- tablet: anybody who can see the staff list can lock the doctor out of his
  -- own clinic by tapping a wrong PIN five times. The person who typed it is
  -- the one who should be made to wait.
  create table if not exists pin_attempts (
    id text primary key,
    -- Nullable: a caller guessing staff ids fails against no real row, and
    -- that attempt still has to count against them.
    staff_id text references staff(id),
    caller text not null,
    failed_at text not null
  );

  create index if not exists pin_attempts_caller on pin_attempts (caller, failed_at);

  create table if not exists sessions (
    token_hash text primary key,
    staff_id text not null references staff(id),
    created_at text not null,
    last_seen text not null,
    expires_at text not null
  );

  create table if not exists patients (
    id text primary key,
    name text not null,
    age integer not null,
    sex text not null check (sex in ('female','male','other')),
    phone text not null,
    address text not null default '',
    whatsapp_consent integer not null default 0,
    created_at text not null
  );

  create table if not exists appointments (
    id text primary key,
    patient_id text not null references patients(id),
    token text not null,
    reason text not null,
    scheduled_at text not null,
    status text not null check (status in ('waiting','in_consult','done','cancelled')),
    created_at text not null
  );

  create table if not exists vitals (
    id text primary key,
    patient_id text not null references patients(id),
    bp text not null,
    temperature real not null,
    pulse integer not null,
    spo2 integer not null,
    weight real not null,
    recorded_by text not null references staff(id),
    recorded_at text not null
  );

  create table if not exists encounters (
    id text primary key,
    patient_id text not null references patients(id),
    doctor_id text not null references staff(id),
    appointment_id text references appointments(id),
    diagnosis text not null,
    notes text not null,
    advice text not null,
    created_at text not null
  );

  create table if not exists prescriptions (
    id text primary key,
    patient_id text not null references patients(id),
    encounter_id text references encounters(id),
    doctor_id text not null references staff(id),
    items_json text not null,
    signed_at text not null,
    dispensed_at text
  );

  create table if not exists bills (
    id text primary key,
    patient_id text not null references patients(id),
    label text not null,
    amount real not null check (amount >= 0),
    status text not null check (status in ('unpaid','paid')),
    payment_method text,
    created_at text not null,
    paid_at text
  );

  create table if not exists beds (
    id text primary key,
    label text not null unique,
    status text not null check (status in ('available','occupied','cleaning','out_of_service')),
    patient_id text references patients(id),
    admitted_at text,
    notes text not null default ''
  );

  create table if not exists suppliers (
    id text primary key,
    code text not null unique,
    name text not null,
    contact_person text not null default '',
    whatsapp text not null default '',
    phone text not null default '',
    email text not null default '',
    address text not null default '',
    gstin text not null default '',
    active integer not null default 1,
    created_at text not null
  );

  create table if not exists medicines (
    id text primary key,
    code text not null unique,
    name text not null,
    strength text not null default '',
    dosage_form text not null default '',
    unit text not null,
    barcode text not null default '',
    sale_class text not null check (sale_class in ('otc','prescription','restricted','unknown')),
    reorder_level integer not null check (reorder_level >= 0),
    target_stock integer not null check (target_stock >= reorder_level),
    preferred_supplier_id text references suppliers(id),
    active integer not null default 1,
    created_at text not null
  );

  create table if not exists supplier_medicines (
    supplier_id text not null references suppliers(id),
    medicine_id text not null references medicines(id),
    active integer not null default 1,
    primary key (supplier_id, medicine_id)
  );

  create table if not exists batches (
    id text primary key,
    medicine_id text not null references medicines(id),
    batch_number text not null,
    expiry text not null,
    available_quantity integer not null check (available_quantity >= 0),
    mrp real not null check (mrp >= 0),
    purchase_price real not null check (purchase_price >= 0),
    selling_price real not null check (selling_price >= 0),
    received_from_supplier_id text references suppliers(id),
    received_at text not null,
    version integer not null default 1,
    unique (medicine_id, batch_number)
  );

  create table if not exists stock_movements (
    id text primary key,
    medicine_id text not null references medicines(id),
    batch_id text not null references batches(id),
    movement_type text not null,
    quantity_delta integer not null,
    reference_type text not null,
    reference_id text not null,
    actor_id text not null references staff(id),
    created_at text not null
  );

  create table if not exists otc_sales (
    id text primary key,
    receipt_number text not null unique,
    total real not null check (total >= 0),
    payment_method text not null check (payment_method in ('cash','upi','card')),
    lines_json text not null,
    created_by text not null references staff(id),
    created_at text not null
  );

  create table if not exists purchase_orders (
    id text primary key,
    order_number text not null unique,
    supplier_id text not null references suppliers(id),
    status text not null check (status in ('pending','placed','partially_delivered','delivered','cancelled')),
    requested_date text not null,
    message_draft text not null,
    external_message_id text,
    message_status text,
    created_by text not null references staff(id),
    created_at text not null,
    placed_at text
  );

  create table if not exists purchase_order_lines (
    id text primary key,
    order_id text not null references purchase_orders(id),
    medicine_id text not null references medicines(id),
    ordered_quantity integer not null check (ordered_quantity > 0),
    received_quantity integer not null default 0 check (received_quantity >= 0),
    unique (order_id, medicine_id)
  );

  create table if not exists whatsapp_messages (
    id text primary key,
    direction text not null check (direction in ('inbound','outbound')),
    audience text not null check (audience in ('patient','supplier')),
    phone text not null,
    body text not null,
    external_message_id text,
    status text not null,
    related_type text,
    related_id text,
    created_at text not null
  );

  create table if not exists csv_imports (
    id text primary key,
    file_hash text not null unique,
    row_count integer not null,
    actor_id text not null references staff(id),
    created_at text not null
  );

  -- One row, one number, bumped by every transaction.
  --
  -- The tablets poll for changes and the snapshot costs sixteen queries to
  -- build. Asking "has anything happened?" costs one, and on a quiet afternoon
  -- the answer is no — which is the difference between about 150,000 queries a
  -- day and about 10,000, and therefore the difference between paying for the
  -- database gateway and not.
  create table if not exists clinic_revision (
    id integer primary key,
    revision bigint not null default 0,
    changed_at text not null
  );

  create table if not exists audit_events (
    id text primary key,
    actor_id text not null references staff(id),
    action text not null,
    entity_type text not null,
    entity_id text not null,
    summary text not null,
    created_at text not null
  );
