-- Shared clinical intake for this clinic: doctors and nurses may register
-- patients and record vitals. Diagnosis/prescribing remain doctor-only.

alter type staff_role add value if not exists 'nurse' before 'counter';

-- The original broad policy let any signed-in staff member insert a vitals row
-- naming any staff member as `recorded_by`. Keep reads shared, but make writes
-- attributable to the doctor/nurse actually holding the tablet session.
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
    and app.current_staff_role()::text in ('doctor', 'nurse')
  );

create policy vitals_clinical_update on vitals
  for update to authenticated
  using (
    recorded_by = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'nurse')
  )
  with check (
    recorded_by = app.current_staff_id()
    and app.current_staff_role()::text in ('doctor', 'nurse')
  );
