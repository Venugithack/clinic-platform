-- ═══════════════════════════════════════════════════════════════════════════
-- TWO THINGS THE SCREENS WERE HOLDING THAT THE CLINIC WAS NOT
--
-- Both of these existed in the interface and nowhere else, and in both cases
-- the interface was quietly telling a staff member something that was not true.
--
-- THE FOLLOW-UP NOTE. `consultation_drafts` stores every field on the doctor's
-- clinical sheet except one. `sign_consultation` reads a `followUpNote` from
-- its payload and writes it onto the follow-up it creates, so the field is real
-- and it matters — but a DRAFT had nowhere to put it. The doctor typed a
-- reminder, pressed `Save draft`, the sheet re-hydrated from the server, and
-- the reminder vanished underneath a green "Draft saved for you." A save that
-- silently drops a field is worse than a refusal, because nobody looks again.
--
-- THE APPEARANCE. Four people share four tablets and hand them to each other
-- all day. The plan asks for the chosen theme to follow the STAFF MEMBER, so
-- the pharmacist who works in the dim back room gets Night shift when they sign
-- in on the tablet the nurse just used at the window. A preference in the
-- browser follows the device instead, which is the opposite arrangement: it
-- gives the next person the last person's eyes.
--
-- `system` is the default and means "no choice made" — resolve it against the
-- device, which is the plan's sign-in fallback. It is stored rather than left
-- null so that choosing to follow the tablet is itself a choice that travels.
--
-- Forward-only, two added columns, no stored row rewritten. Policy item 34.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The follow-up note on a draft ───────────────────────────────────────
--
-- Not null with an empty default, exactly like `advice` and `notes` beside it,
-- so an existing draft reads as "no reminder typed" rather than as unknown.
alter table jmc.consultation_drafts
  add column if not exists follow_up_note text not null default '';

comment on column jmc.consultation_drafts.follow_up_note is
  'The reminder that goes on the follow-up when this draft is signed. Held here so a draft save stops destroying it.';


-- ── 2. The staff member''s appearance ───────────────────────────────────────
--
-- On the staff row, so it travels with the person rather than the tablet.
-- It is a preference and never an authorization: nothing reads it to decide
-- what anybody may do, and the lock screen — where nobody is identified yet —
-- cannot see it at all.
alter table jmc.staff
  add column if not exists theme text not null default 'system';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'staff_theme_is_known'
       and conrelid = 'jmc.staff'::regclass
  ) then
    alter table jmc.staff
      add constraint staff_theme_is_known
      check (theme in ('system', 'paper', 'night', 'contrast'));
  end if;
end
$$;

comment on column jmc.staff.theme is
  'Paper and ink, Night shift, High contrast, or system to follow the device. A preference, never an authorization.';
