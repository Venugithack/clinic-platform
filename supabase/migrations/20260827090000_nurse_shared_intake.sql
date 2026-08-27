-- Shared clinical intake for this clinic: doctors and nurses may register
-- patients and record vitals. The first-run admin remains a clinical superuser
-- in this custom build. Diagnosis/prescribing remain on the doctor/admin side.

alter type staff_role add value if not exists 'nurse' before 'counter';

-- Vitals used to belong only to the patient. That loses which visit/token the
-- measurement was taken for, so the doctor cannot reliably distinguish today's
-- intake from an older reading. Existing rows stay valid with a null visit;
-- every new intake row written by this feature carries its appointment.
alter table vitals
  add column if not exists appointment_id uuid references appointments (id);

create index if not exists vitals_appointment_idx
  on vitals (appointment_id, recorded_at desc)
  where appointment_id is not null;

-- The original broad policy let any signed-in staff member insert a vitals row
-- naming any staff member as `recorded_by`. Keep reads shared, but make writes
-- attributable to the clinical staff member actually holding the tablet
-- session. Admin is included because the very first clinic user is created as
-- admin and historically performs the doctor's workflow too.
--
-- Compare the enum as text here: PostgreSQL does not allow a newly-added enum
-- value to be used as an enum literal until the transaction that added it has
-- committed, and Supabase applies this migration transactionally.
drop policy if exists vitals_staff on vitals;

create policy vitals_staff_read on vitals
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy vitals_clinical_insert on vitals
  for insert to authenticated
  with check (
    recorded_by = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'nurse', 'admin')
  );

create policy vitals_clinical_update on vitals
  for update to authenticated
  using (
    recorded_by = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'nurse', 'admin')
  )
  with check (
    recorded_by = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'nurse', 'admin')
  );

-- Adding a nurse creates a new role boundary the old two-role application did
-- not need. `encounters_staff` allowed every signed-in staff member to create
-- and edit consultation notes; the UI was the only thing keeping the pharmacy
-- out. Make that boundary explicit now. Reads remain available because other
-- parts of the clinic use encounter history, but only the doctor/admin who owns
-- the encounter may write it.
drop policy if exists encounters_staff on encounters;

create policy encounters_staff_read on encounters
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy encounters_clinician_insert on encounters
  for insert to authenticated
  with check (
    doctor_id = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'admin')
  );

create policy encounters_clinician_update on encounters
  for update to authenticated
  using (
    doctor_id = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'admin')
  )
  with check (
    doctor_id = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'admin')
  );

-- The original prescription policies were doctor-only, while the application
-- has always treated the bootstrap admin as the doctor/owner. Preserve that
-- custom-clinic behavior, but do not widen it to nurses.
drop policy if exists prescriptions_doctor_write on prescriptions;
drop policy if exists prescriptions_doctor_update on prescriptions;

create policy prescriptions_clinician_write on prescriptions
  for insert to authenticated
  with check (
    doctor_id = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'admin')
  );

create policy prescriptions_clinician_update on prescriptions
  for update to authenticated
  using (
    doctor_id = app.current_staff_id()
    and signed_at is null
    and app.current_staff_role()::text in ('doctor', 'admin')
  )
  with check (
    doctor_id = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'admin')
  );
