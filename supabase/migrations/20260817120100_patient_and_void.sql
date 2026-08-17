-- The two loose ends M8 and M4 left. PLAN.md §15.2, §16.
--
-- M8 built the Schedule H1 register and gave it an `address_missing` flag,
-- because the rule requires the patient's address and a register with blanks in
-- it is not one. Then it offered no way to fill the blank in. The pharmacist
-- reading that flag had to find a developer, which is a flag nobody acts on.
--
-- M4 wrote and tested `app.void_bill` — including the part where cancelling a
-- paid cash bill is a refund that comes out of an open drawer — and no screen
-- ever called it. A transition with no caller is a feature the clinic does not
-- have.
--
-- Neither needs a new transition. What they need is a way in, and one thing
-- that was missing underneath.
--
-- **Patient edits are now audited.** `patients` is one of the six tables this
-- build writes to directly (`A5_permissions.sql` §1): ordinary CRUD under RLS,
-- moving neither stock nor money. That is still the right call — registration
-- is a walk-in screen, not a transition — but an *edit* is different from a
-- creation. Somebody changing a recorded allergy, or a phone number that
-- appointment reminders go to, or an address the H1 register prints, leaves no
-- trace at all under plain CRUD. DPDP §15 wants accuracy and correction to be
-- accountable, and a clinical record wants to be able to answer "who changed
-- this, and when". A trigger closes that without moving the table behind a
-- transition and without touching the registration screen.

-- ---------------------------------------------------------------------------
-- Audit patient edits.
--
-- AFTER UPDATE only. Creating a patient is already a deliberate, consented act
-- on a screen that records `consent_given_at`; it is the *silent correction*
-- months later that has nobody's name on it.
--
-- `app.write_audit` stores changed fields only, so a row that touched one
-- field logs one field — this stays cheap even if a screen re-saves the whole
-- form on every keystroke.
-- ---------------------------------------------------------------------------
create or replace function app.audit_patient_edit() returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- `updated_at` moves on every write by trigger, so comparing whole rows
  -- would log every no-op save as a change. Compare without it.
  if to_jsonb(old) - 'updated_at' = to_jsonb(new) - 'updated_at' then
    return null;
  end if;

  perform app.write_audit('edit_patient', 'patient', new.id,
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at');

  return null;
end
$$;

-- Trigger functions do not need an EXECUTE grant to fire — the check is
-- TRIGGER on the table, at creation time. Postgres still grants EXECUTE to
-- PUBLIC by default, which is what A5_permissions.sql §5 refuses; it caught
-- this one the moment it was written, which is the entire point of that test.
revoke all on function app.audit_patient_edit() from public;

create trigger patients_edits_are_audited
  after update on patients
  for each row execute function app.audit_patient_edit();

comment on function app.audit_patient_edit() is
  'A recorded allergy or an address on the H1 register can be changed silently under plain CRUD. This is the trace (DPDP §15).';

-- ---------------------------------------------------------------------------
-- The H1 register learns which patient each row is about.
--
-- `address_missing` was a flag with no way to act on it: the view carried the
-- patient's name and address but not their id, so a screen could show the gap
-- and could not offer to fix it. One column, appended so the existing column
-- order — and therefore the CSV the inspector gets — is untouched.
-- ---------------------------------------------------------------------------
create or replace view h1_register as
select
  dl.id                       as dispense_line_id,
  d.at                        as dispensed_at,
  app.clinic_day(d.at)        as dispensed_on,
  p.name                      as patient_name,
  p.address                   as patient_address,
  p.phone                     as patient_phone,
  dr.name                     as drug_name,
  dr.strength,
  dr.schedule,
  dl.qty_base,
  b.batch_no,
  b.expiry,
  pres.id                     as prescription_id,
  pres.signed_at              as prescribed_at,
  doc.name                    as prescriber_name,
  doc.reg_no                  as prescriber_reg_no,
  disp.name                   as dispensed_by,
  (p.address is null or length(trim(p.address)) = 0) as address_missing,
  p.id                        as patient_id
from dispense_lines dl
join dispenses d       on d.id = dl.dispense_id
join drugs dr          on dr.id = dl.drug_id
join stock_batches b   on b.id = dl.batch_id
left join patients p   on p.id = d.patient_id
left join prescriptions pres on pres.id = d.prescription_id
left join staff doc    on doc.id = pres.doctor_id
left join staff disp   on disp.id = d.staff_id
where dr.schedule = 'H1';
