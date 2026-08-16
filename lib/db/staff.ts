/**
 * Staff reads. Part of the one seam (PLAN.md §5.3 rule 1) — screens ask this
 * module, never Supabase.
 */
import { db } from './index';

export interface StaffMember {
  id: string;
  name: string;
  role: 'doctor' | 'counter' | 'admin';
}

/**
 * The people who can unlock a tablet.
 *
 * Note what is not returned: pin_hash is not selectable here and is not
 * client-writable at all — the only path to it is app.set_staff_pin().
 */
export async function listActiveStaff(): Promise<StaffMember[]> {
  const { data, error } = await db()
    .from('staff')
    .select('id, name, role')
    .eq('active', true)
    .order('name');

  if (error) throw new Error(error.message);
  return (data ?? []) as StaffMember[];
}
