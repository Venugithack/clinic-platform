/** Reads for the admin screen. PLAN.md §5.3 rule 1. */
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
  email: string | null;
}

export async function allStaff(): Promise<StaffAdminRow[]> {
  const { data, error } = await db()
    .from('staff')
    .select('id, name, role, phone, reg_no, active, pin_set_at, email')
    .order('active', { ascending: false })
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffAdminRow[];
}

export interface DeviceRow {
  id: string;
  label: string;
  is_clinic_device: boolean;
  idle_timeout_seconds: number;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export async function allDevices(): Promise<DeviceRow[]> {
  const { data, error } = await db()
    .from('devices')
    .select('id, label, is_clinic_device, idle_timeout_seconds, last_seen_at, revoked_at')
    .order('revoked_at', { ascending: true, nullsFirst: true })
    .order('label');
  if (error) throw new Error(error.message);
  return (data ?? []) as DeviceRow[];
}
