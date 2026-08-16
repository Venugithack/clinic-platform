-- Clinic core: patients, appointments, encounters, prescriptions, vitals.
--
-- These are the "reads and simple writes stay client-side under RLS" half of
-- the split in HOSTING.md §3. Only the transitions that move money or stock go
-- into plpgsql; a consult note does neither.

create table patients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text,
  dob             date,
  age             int check (age between 0 and 130),
  sex             text check (sex in ('M', 'F', 'O')),
  address         text,
  allergies       text,
  notes           text,
  -- Families share one handset constantly; a phone number is not an identity.
  phone_is_shared boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index patients_phone_idx on patients (phone) where phone is not null;
create index patients_name_idx  on patients using gin (to_tsvector('simple', name));

create type appointment_status as enum ('booked', 'waiting', 'in_consult', 'done', 'no_show');
create type appointment_source as enum ('walkin', 'whatsapp', 'phone');

create table appointments (
  id                   uuid primary key default gen_random_uuid(),
  patient_id           uuid not null references patients (id),
  date                 date not null,
  token_no             int not null check (token_no > 0),
  status               appointment_status not null default 'booked',
  source               appointment_source not null default 'walkin',
  reason               text,
  follows_encounter_id uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (date, token_no)
);

create index appointments_day_idx on appointments (date, status);

create table encounters (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references patients (id),
  doctor_id      uuid not null references staff (id),
  appointment_id uuid references appointments (id),
  -- Free-form clinical content, entered by a human. PLAN.md §5.3 rule 8:
  -- nothing here is ever computed, inferred, flagged high/low or suggested.
  findings       jsonb not null default '{}'::jsonb,
  diagnoses      jsonb not null default '[]'::jsonb,
  advice         text,
  follow_up_date date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index encounters_patient_idx on encounters (patient_id, created_at desc);

alter table appointments
  add constraint appointments_follows_encounter_fkey
  foreign key (follows_encounter_id) references encounters (id);

create type prescription_status as enum ('pending', 'partial', 'dispensed', 'cancelled');

create table prescriptions (
  id            uuid primary key default gen_random_uuid(),
  encounter_id  uuid not null references encounters (id),
  patient_id    uuid not null references patients (id),
  doctor_id     uuid not null references staff (id),
  -- items[]: { drug_id, name, strength, dose, freq, days, food, schedule[], qty_base }
  items         jsonb not null default '[]'::jsonb,
  signed_at     timestamptz,
  status        prescription_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint prescription_items_is_array check (jsonb_typeof(items) = 'array')
);

create index prescriptions_pharmacy_queue_idx
  on prescriptions (signed_at desc)
  where signed_at is not null and status in ('pending', 'partial');

create table vitals (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references patients (id),
  encounter_id uuid references encounters (id),
  bp           text,
  pulse        int,
  temp         numeric(4, 1),
  spo2         int,
  weight       numeric(5, 2),
  height       numeric(5, 2),
  recorded_by  uuid not null references staff (id),
  recorded_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index vitals_patient_idx on vitals (patient_id, recorded_at desc);

create trigger patients_touch      before update on patients      for each row execute function app.touch_updated_at();
create trigger appointments_touch  before update on appointments  for each row execute function app.touch_updated_at();
create trigger encounters_touch    before update on encounters    for each row execute function app.touch_updated_at();
create trigger prescriptions_touch before update on prescriptions for each row execute function app.touch_updated_at();
create trigger vitals_touch        before update on vitals        for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Staff only, on all five. `anon` gets no policy — rule 7 again: findings
-- and notes never leave, and the patient portal reads through a later,
-- explicitly-shaped view rather than through these tables.
-- ---------------------------------------------------------------------------
alter table patients      enable row level security;
alter table appointments  enable row level security;
alter table encounters    enable row level security;
alter table prescriptions enable row level security;
alter table vitals        enable row level security;

grant select, insert, update on patients, appointments, encounters, prescriptions, vitals
  to authenticated;

create policy patients_staff on patients
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

create policy appointments_staff on appointments
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

create policy encounters_staff on encounters
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

create policy vitals_staff on vitals
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

-- A prescription is the doctor's artefact. Anyone on staff may read it — the
-- counter has to dispense from it — but only the doctor who owns it may write
-- it, and a signed prescription is closed to further edits.
create policy prescriptions_read on prescriptions
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy prescriptions_doctor_write on prescriptions
  for insert to authenticated
  with check (doctor_id = app.current_staff_id() and app.current_staff_role() = 'doctor');

create policy prescriptions_doctor_update on prescriptions
  for update to authenticated
  using (doctor_id = app.current_staff_id() and signed_at is null)
  with check (doctor_id = app.current_staff_id());

comment on column encounters.findings is
  'Human-entered only. PLAN.md §5.3 rule 8 — nothing clinical is ever inferred.';
comment on column prescriptions.items is
  'Quantities are qty_base — base units, never packs (INVENTORY.md §1).';
