/** Reads for the people and access control screen. */
import { db } from './index';

export type StaffRole = 'doctor' | 'nurse' | 'counter' | 'admin';

export interface StaffAdminRow {
  id: string;
  name: string;
  role: StaffRole;
  phone: string | null;
  reg_no: string | null;
  active: boolean;
  pin_set_at: string | null;
}

export async function allStaff(): Promise<StaffAdminRow[]> {
  const { data, error } = await db()
    .from('staff')
    .select('id, name, role, phone, reg_no, active, pin_set_at')
    .order('active', { ascending: false })
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffAdminRow[];
}
