/** Staff administration transitions. */
import { appSchema } from '@/lib/db';
import type { StaffRole } from '@/lib/db/admin';
import { toTransitionError } from './errors';

export type { StaffRole } from '@/lib/db/admin';

export interface NewStaff {
  name: string;
  role: StaffRole;
  pin: string;
  phone?: string;
  regNo?: string;
}

export interface StaffRow {
  id: string;
  name: string;
  role: StaffRole;
  phone: string | null;
  reg_no: string | null;
  active: boolean;
  pin_set_at: string | null;
}

export async function addStaff(input: NewStaff): Promise<StaffRow> {
  const { data, error } = await appSchema().rpc('add_staff', {
    p_name: input.name,
    p_role: input.role,
    p_pin: input.pin,
    p_phone: input.phone ?? null,
    p_reg_no: input.regNo ?? null,
  });
  if (error) throw toTransitionError(error);
  return data as StaffRow;
}

export async function updateStaff(
  staffId: string,
  changes: {
    name?: string;
    role?: StaffRole;
    phone?: string;
    regNo?: string;
    active?: boolean;
  },
): Promise<StaffRow> {
  const { data, error } = await appSchema().rpc('update_staff', {
    p_staff_id: staffId,
    p_name: changes.name ?? null,
    p_role: changes.role ?? null,
    p_phone: changes.phone ?? null,
    p_reg_no: changes.regNo ?? null,
    p_active: changes.active ?? null,
  });
  if (error) throw toTransitionError(error);
  return data as StaffRow;
}

export async function setStaffPin(staffId: string, pin: string): Promise<void> {
  const { error } = await appSchema().rpc('set_staff_pin', {
    p_staff_id: staffId,
    p_pin: pin,
  });
  if (error) throw toTransitionError(error);
}
