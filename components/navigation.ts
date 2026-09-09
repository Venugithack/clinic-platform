import type { Role } from '@/lib/types'

export type View =
  | 'overview'
  | 'patients'
  | 'queue'
  | 'vitals'
  | 'consultation'
  | 'records'
  | 'beds'
  | 'billing'
  | 'staff'
  | 'clinic'
  | 'registers'
  | 'expiring'
  | 'daybook'
  | 'stocktake'
  | 'counter'
  | 'inventory'
  | 'suppliers'
  | 'orders'
  | 'printer'
  | 'audit'

type NavItem = { id: View; label: string; eyebrow: string }

export const NAVIGATION: Record<Role, NavItem[]> = {
  admin: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'staff', label: 'Staff', eyebrow: 'Admin control' },
    { id: 'clinic', label: 'Clinic', eyebrow: 'Details that print' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
    { id: 'inventory', label: 'Inventory', eyebrow: 'Batch inventory' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders' },
    { id: 'printer', label: 'Printer', eyebrow: 'Tablet printing' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1' },
    { id: 'audit', label: 'Activity', eyebrow: 'Accountability' },
  ],
  doctor: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'queue', label: 'Queue', eyebrow: "Today's flow" },
    { id: 'consultation', label: 'Consult', eyebrow: 'Doctor workspace' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'records', label: 'Records', eyebrow: 'Clinical record' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Approve a count' },
  ],
  nurse: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'queue', label: 'Queue', eyebrow: "Today's flow" },
    { id: 'vitals', label: 'Vitals', eyebrow: 'Nursing station' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
  ],
  pharmacy: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'counter', label: 'Counter', eyebrow: 'Pharmacy counter' },
    { id: 'inventory', label: 'Inventory', eyebrow: 'Batch inventory' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1' },
  ],
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacy: 'Pharmacy',
}

export function navigationFor(roles: Role[]): NavItem[] {
  return [
    ...new Map(
      roles.flatMap((role) => NAVIGATION[role]).map((item) => [item.id, item]),
    ).values(),
  ]
}
