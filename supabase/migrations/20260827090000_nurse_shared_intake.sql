-- Shared clinical intake for this clinic: doctors and nurses may register
-- patients and record vitals. The first-run admin remains a clinical superuser
-- in this custom build. Diagnosis/prescribing remain doctor-owned elsewhere.

alter type staff_role add value if not exists 'nurse' before 'counter';

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
