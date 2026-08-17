/**
 * Staff reads. Part of the one seam (PLAN.md §5.3 rule 1) — screens ask this
 * module, never Supabase.
 */
import { db } from './index';

export interface StaffMember {
  id: string;
  name: string;
}

/**
 * The people who can unlock a tablet.
 *
 * Note what is not returned: pin_hash is not selectable here and is not
 * client-writable at all — the only path to it is app.set_staff_pin().
 */
export async function listActiveStaff(): Promise<StaffMember[]> {
  // `lock_screen_staff`, not `staff`: this read happens BEFORE anybody has
  // signed in, and the staff table's RLS requires a staff member to already be
  // resolved. Reading the table here worked only because the development key
  // carries a seeded doctor's id — on a database without that row the list came
  // back empty with no error, and the lock screen offered nobody to sign in as
  // (M11f).
  const { data, error } = await db()
    .from('lock_screen_staff')
    .select('id, name');

  if (error) throw new Error(error.message);

  // A null body with no error is not an empty clinic — it is a request that did
  // not complete. Coalescing it to [] would render a lock screen with nobody on
  // it and no explanation, which is exactly the "failed save as a mystery"
  // PLAN.md §5.2 rules out.
  if (data === null) throw new Error('The clinic database did not respond.');

  return data as StaffMember[];
}
