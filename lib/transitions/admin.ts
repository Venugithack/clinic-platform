/**
 * Staff and devices. PLAN.md §16, TABLET.md §5.
 *
 * Both were `psql` until M11c: "the new pharmacist starts on Monday" and "the
 * counter tablet was left in an auto-rickshaw".
 */
import { appSchema } from '@/lib/db';
import type { StaffRole } from '@/lib/db/admin';
import { toTransitionError } from './errors';

export type { StaffRole } from '@/lib/db/admin';

export interface NewStaff {
  name: string;
  role: StaffRole;
  /** Exactly six digits. It is not optional — see the transition's comment. */
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

export interface RegisteredDevice {
  id: string;
  label: string;
  /**
   * Shown once and never again.
   *
   * There is no read path back to it in this build's UI, deliberately: the
   * admin carries it to the new tablet and types it in, and a token that is
   * displayable forever is a token that is photographed once.
   */
  device_token: string;
  idle_timeout_seconds: number;
}

export async function registerDevice(
  label: string,
  isClinicDevice = true,
  idleTimeoutSeconds?: number,
): Promise<RegisteredDevice> {
  const { data, error } = await appSchema().rpc('register_device', {
    p_label: label,
    p_is_clinic_device: isClinicDevice,
    p_idle_timeout_seconds: idleTimeoutSeconds ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as RegisteredDevice;
}

/** Returns how many live sessions were ended along with the registration. */
export async function revokeDevice(deviceId: string): Promise<number> {
  const { data, error } = await appSchema().rpc('revoke_device', {
    p_device_id: deviceId,
  });

  if (error) throw toTransitionError(error);
  return Number(data);
}

/**
 * First run, on a database that has nothing in it.
 *
 * The deadlock this exists for: a staff session needs an unlock, an unlock
 * needs a registered device, and registering a device needs an admin session.
 * On a seeded development database nobody ever notices; on the real one,
 * nothing could create the first tablet.
 *
 * Allowed only while `staff` and `devices` are both empty, so it can run at
 * most once in the life of a clinic. The device token comes back exactly once
 * and the caller writes it to this tablet.
 */
export interface FirstRun {
  clinic_name: string;
  staff_id: string;
  staff_name: string;
  device_label: string;
  /** Shown once, written straight to this tablet. */
  device_token: string;
  /** Signs the new admin in on the tablet he is holding, like `unlock` does. */
  session_token: string;
}

export async function firstRun(input: {
  clinicName: string;
  staffName: string;
  pin: string;
  deviceLabel?: string;
}): Promise<FirstRun> {
  const { data, error } = await appSchema().rpc('first_run', {
    p_clinic_name: input.clinicName,
    p_staff_name: input.staffName,
    p_pin: input.pin,
    p_device_label: input.deviceLabel ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as FirstRun;
}

export interface RecoveredAdminDevice {
  staff_id: string;
  staff_name: string;
  device_id: string;
  device_label: string;
  device_token: string;
  session_token: string;
}

/**
 * Emergency recovery when a clinic already exists but every usable device
 * token has been lost. The database enforces the safety boundary: clinic name,
 * active administrator name + PIN, and no registered tablet seen recently.
 */
export async function recoverAdminDevice(input: {
  clinicName: string;
  adminName: string;
  pin: string;
  deviceLabel: string;
}): Promise<RecoveredAdminDevice> {
  const { data, error } = await appSchema().rpc('recover_admin_device', {
    p_clinic_name: input.clinicName,
    p_admin_name: input.adminName,
    p_pin: input.pin,
    p_device_label: input.deviceLabel,
  });

  if (error) throw toTransitionError(error);
  return data as RecoveredAdminDevice;
}
