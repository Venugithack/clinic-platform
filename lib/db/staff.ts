/** Staff reads. Part of the one database seam. */
import { db } from './index';

export interface StaffMember {
  id: string;
  name: string;
  role: 'doctor' | 'nurse' | 'counter' | 'admin';
}

/** Public lock-screen identity list. No credential or contact data is exposed. */
export async function listActiveStaff(): Promise<StaffMember[]> {
  const { data, error } = await db()
    .from('lock_screen_staff')
    .select('id, name, role');

  if (error) throw new Error(error.message);
  if (data === null) throw new Error('The clinic database did not respond.');
  return data as StaffMember[];
}
