/** Staff and clinic administration. */
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
  email?: string | null;
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

export interface FirstRunOwner {
  staff_id: string;
  staff_name: string;
  staff_role: 'admin';
  email: string;
  clinic_name: string;
}

export async function firstRunOwner(staffName: string, pin: string): Promise<FirstRunOwner> {
  const { data, error } = await appSchema().rpc('first_run_owner', {
    p_staff_name: staffName,
    p_pin: pin,
  });
  if (error) throw toTransitionError(error);
  return data as FirstRunOwner;
}

// Legacy exports are retained for old clients/tests but normal browser execute
// privileges for device enrollment are revoked by the device-free migration.
export async function setStaffEmail(staffId: string, email: string | null): Promise<StaffRow> {
  const { data, error } = await appSchema().rpc('set_staff_email', {
    p_staff_id: staffId,
    p_email: email,
  });
  if (error) throw toTransitionError(error);
  return data as StaffRow;
}

export interface RegisteredDevice {
  id: string;
  label: string;
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

export async function revokeDevice(deviceId: string): Promise<number> {
  const { data, error } = await appSchema().rpc('revoke_device', {
    p_device_id: deviceId,
  });
  if (error) throw toTransitionError(error);
  return Number(data);
}

export interface EmailTrustedDevice {
  staff_id: string;
  staff_name: string;
  staff_role: StaffRole;
  device_id: string;
  device_label: string;
  device_token: string;
  session_token: string;
}

export async function trustDeviceByEmail(input: {
  deviceLabel: string;
  isClinicDevice?: boolean;
  idleTimeoutSeconds?: number;
}): Promise<EmailTrustedDevice> {
  const { data, error } = await appSchema().rpc('trust_device_by_email', {
    p_label: input.deviceLabel,
    p_is_clinic_device: input.isClinicDevice ?? true,
    p_idle_timeout_seconds: input.idleTimeoutSeconds ?? null,
  });
  if (error) throw toTransitionError(error);
  return data as EmailTrustedDevice;
}

export async function firstRunEmail(input: {
  clinicName: string;
  staffName: string;
  pin: string;
  deviceLabel?: string;
}): Promise<EmailTrustedDevice & { clinic_name: string }> {
  const { data, error } = await appSchema().rpc('first_run_email', {
    p_clinic_name: input.clinicName,
    p_staff_name: input.staffName,
    p_pin: input.pin,
    p_device_label: input.deviceLabel ?? null,
  });
  if (error) throw toTransitionError(error);
  return data as EmailTrustedDevice & { clinic_name: string };
}

export async function claimLegacyAdminByEmail(input: {
  clinicName: string;
  adminName: string;
  pin: string;
  deviceLabel: string;
}): Promise<EmailTrustedDevice> {
  const { data, error } = await appSchema().rpc('claim_legacy_admin_by_email', {
    p_clinic_name: input.clinicName,
    p_admin_name: input.adminName,
    p_pin: input.pin,
    p_device_label: input.deviceLabel,
  });
  if (error) throw toTransitionError(error);
  return data as EmailTrustedDevice;
}
