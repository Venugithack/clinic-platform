-- The details that make a printed sheet a document.
--
-- Until now the clinic's name was a string in the source and its licence
-- numbers did not exist anywhere, which means every bill printed so far is a
-- piece of paper with numbers on it rather than a receipt. A pharmacy bill has
-- to carry the drug licence number and the GSTIN, and a prescription has to
-- carry the prescriber's registration number.
--
-- One row, enforced. A clinic has one identity, and a table that permits two is
-- a table that will eventually hold two — with no way to tell which one printed
-- on yesterday's bill.

set local search_path = jmc;

create table if not exists clinic_settings (
  id                integer primary key default 1 check (id = 1),

  name              text not null default 'Jayamurugan Clinic',
  address           text not null default '',
  phone             text not null default '',
  email             text not null default '',

  -- Form 20/21 under the Drugs and Cosmetics Rules. Printed on every bill that
  -- includes a medicine.
  drug_licence_number  text not null default '',
  -- The prescriber's council registration. Printed on every prescription.
  doctor_registration_number text not null default '',
  gstin             text not null default '',

  -- Kept in rupees, not paise: every other amount in this schema is `real` in
  -- rupees and one column counting differently is how a bill comes out a
  -- hundred times wrong.
  consultation_fee  real not null default 0 check (consultation_fee >= 0),

  -- Printed small at the foot of a bill: return policy, timings, whatever the
  -- clinic wants on paper.
  footer_note       text not null default '',

  updated_at        text not null,
  updated_by        text references staff (id)
);

-- The single row, created empty. The clinic fills it in from the Clinic screen;
-- until it does, the printed sheets say so rather than printing blanks.
insert into clinic_settings (id, updated_at)
values (1, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (id) do nothing;
