-- A vital sign that was not measured, recorded as not measured.
--
-- Every column on `vitals` is NOT NULL, so the application refuses to save a
-- reading unless all five are present. On a day with a nurse that is a
-- reasonable discipline. On a day without one it is the fault that sends the
-- doctor looking for a number to type: the brief's Slice 1 gate is that a
-- doctor alone can "record available vitals", and today he can either record
-- all of them or none.
--
-- What people do when software insists on a number they do not have is enter
-- a plausible one. A weight of 0, a SpO2 of 98 because it usually is. That is
-- not a gap in the record, it is a false entry in it, and nothing downstream
-- can tell the difference afterwards. A blank that says "not measured" is
-- recoverable; an invented 98 is not.
--
-- ── WHY NULL AND NOT A SENTINEL ────────────────────────────────────────────
--
-- The obvious alternative is 0, or -1. Both are numbers, and every average,
-- chart and threshold comparison downstream would have to know to skip them —
-- which one of them eventually will not. NULL is the value the database
-- already has for "no value", and `avg()` already ignores it.
--
-- ── WHY THE ROW STILL HAS TO SAY SOMETHING ─────────────────────────────────
--
-- A row of five NULLs is not a vitals record, it is an accident. The check
-- constraint requires at least one measurement, so "I recorded nothing" stays
-- impossible while "I recorded what I could" becomes possible.
--
-- `not_measured_note` is optional and free text — "no pulse oximeter", "child
-- would not sit still". The UX plan asks for a reason and does not say it is
-- mandatory, and a required reason is another field between a busy doctor and
-- the patient in front of him.

set local search_path = jmc;

alter table vitals alter column bp drop not null;
alter table vitals alter column temperature drop not null;
alter table vitals alter column pulse drop not null;
alter table vitals alter column spo2 drop not null;
alter table vitals alter column weight drop not null;

-- Blank strings were the old way of saying nothing, and they are not the new
-- way. Only rows that already exist can hold one; the command layer refuses
-- to write one from here on.
update vitals set bp = null where bp = '';

alter table vitals
  add constraint vitals_at_least_one_reading check (
    bp is not null
    or temperature is not null
    or pulse is not null
    or spo2 is not null
    or weight is not null
  );

alter table vitals
  add column if not exists not_measured_note text not null default '';

comment on column vitals.not_measured_note is
  'Why a reading is missing, in the recorder''s own words. Optional. '
  'A NULL measurement means not measured; this says why, when anyone said.';
