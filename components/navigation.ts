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
  | 'formulary'
  | 'receiving'
  | 'opening'
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
    { id: 'formulary', label: 'Formulary', eyebrow: 'Medicines & packages' },
    { id: 'receiving', label: 'Receiving', eyebrow: 'Goods received' },
    { id: 'opening', label: 'Opening count', eyebrow: 'Blind opening count' },
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
    // The nurse's station, on the doctor's rail, for the days there is no
    // nurse. Slice 1's gate is that a doctor alone can register a patient,
    // create the visit, record what vitals he can and open the consultation
    // without borrowing somebody else's login — and the command layer has
    // allowed him to record vitals all along. Only the rail said no, so
    // `Record vitals` on the queue and in Consult rendered for nobody who
    // needed it.
    //
    // For a staff member holding both roles this entry and the nurse's are
    // the same station and `navigationFor` keeps one of them; either label is
    // accurate, so which one wins does not matter.
    { id: 'vitals', label: 'Vitals', eyebrow: 'When the nurse is away' },
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
    { id: 'formulary', label: 'Formulary', eyebrow: 'Medicines & packages' },
    { id: 'receiving', label: 'Receiving', eyebrow: 'Goods received' },
    { id: 'opening', label: 'Opening count', eyebrow: 'Blind opening count' },
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
