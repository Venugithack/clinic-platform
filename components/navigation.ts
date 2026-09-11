import type { Role } from '@/lib/types'

export type View =
  | 'overview'
  | 'patients'
  | 'queue'
  | 'vitals'
  | 'consultation'
  | 'records'
  | 'review'
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
  | 'reports'
  | 'audit'

type NavItem = { id: View; label: string; eyebrow: string }

export const NAVIGATION: Record<Role, NavItem[]> = {
  admin: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'staff', label: 'Staff', eyebrow: 'Admin control' },
    { id: 'clinic', label: 'Clinic', eyebrow: 'Details that print' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
    /*
     * The counter, on the admin rail as well as the pharmacy one.
     *
     * `dispense_rx`, `otc_sale` and `take_payment` all authorize admin — the
     * owner runs this clinic and stands at the counter when the pharmacist is
     * away — and Slice 4's snapshot sends an admin the queue and the bills.
     * Without this entry the data arrived and the station did not, so the one
     * person who most needs to cover the counter was the one person with no
     * way to reach it.
     */
    { id: 'counter', label: 'Counter', eyebrow: 'Pharmacy counter' },
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
    // Old prescription lines nobody can read. Only a doctor may say what one
    // of them authorized, so only a doctor is offered the station.
    { id: 'review', label: 'Review', eyebrow: 'Lines only a doctor can settle' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Approve a count' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record' },
  ],
  /*
   * No Billing and no Day book.
   *
   * The nurse held both because the retired application let a nurse take
   * payment. Policy register item 17 settled that on 12 September 2026: the
   * payment counter is admin and pharmacy. `take_payment` refuses a nurse and
   * the snapshot sends a nurse no invoices, no patient balances and no till,
   * so these two stations would have drawn empty screens over controls that
   * could only fail. Reports stays — a nurse still reads follow-ups.
   *
   * A nurse who also covers the counter holds the pharmacy role too, and the
   * rail is the union of both, so nothing is taken from that person.
   */
  nurse: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'queue', label: 'Queue', eyebrow: "Today's flow" },
    { id: 'vitals', label: 'Vitals', eyebrow: 'Nursing station' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record' },
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
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record' },
  ],
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacy: 'Pharmacy',
}

/**
 * The admin rail, in sections.
 *
 * A doctor's rail is seven stations and a pharmacist's is thirteen; an
 * administrator's is twenty, and twenty tracked-caps words in one column is a
 * list you read rather than a building you know your way around. The brief's
 * Slice 6 names the five divisions — people and access, clinic operations,
 * inventory, finance, settings — so those are the headings, and nothing is
 * renamed, moved between roles or hidden to produce them.
 *
 * Overview and Reports sit above the first heading on purpose. Neither belongs
 * to one division: Overview is the whole clinic today, and Reports answers
 * questions about stock, money and people from the same screen. Filing either
 * one under a heading would be filing it under the wrong heading four fifths
 * of the time.
 *
 * Only the administrator gets headings. The other three rails are short and
 * task-ordered already, and a heading over two entries is furniture.
 */
const ADMIN_GROUPS = [
  { ids: ['overview', 'reports'] },
  { heading: 'People and access', ids: ['staff', 'audit'] },
  {
    heading: 'Clinic operations',
    ids: ['patients', 'queue', 'vitals', 'consultation', 'records', 'review', 'beds', 'registers'],
  },
  {
    heading: 'Inventory',
    ids: [
      'inventory',
      'formulary',
      'receiving',
      'opening',
      'expiring',
      'stocktake',
      'suppliers',
      'orders',
    ],
  },
  { heading: 'Finance', ids: ['counter', 'billing', 'daybook'] },
  { heading: 'Settings', ids: ['clinic', 'printer'] },
] as const satisfies ReadonlyArray<{ heading?: string; ids: readonly View[] }>

type GroupedView = (typeof ADMIN_GROUPS)[number]['ids'][number]

/**
 * A station added to `View` and left out of the sections above would vanish
 * from the administrator's rail — present in the router, reachable by nobody.
 * This fails the typecheck instead, and names the station it is missing.
 */
type EveryViewIsFiled = [Exclude<View, GroupedView>] extends [never]
  ? true
  : ['This view has no admin rail section:', Exclude<View, GroupedView>]
const EVERY_VIEW_IS_FILED: EveryViewIsFiled = true
void EVERY_VIEW_IS_FILED

export type NavGroup = {
  /** Absent for the stations that sit above the first heading. */
  heading?: string
  items: NavItem[]
}

export function navigationFor(roles: Role[]): NavItem[] {
  return [
    ...new Map(
      roles.flatMap((role) => NAVIGATION[role]).map((item) => [item.id, item]),
    ).values(),
  ]
}

/**
 * The same stations `navigationFor` returns, divided for the rail.
 *
 * Non-administrators get one unheaded group holding their flat rail unchanged,
 * so nothing about those three rails moves. An administrator gets the sections
 * above, in that order, holding exactly the stations that session actually has
 * — a doctor-administrator's Consult appears under Clinic operations, and an
 * empty section is not drawn.
 */
export function navigationGroupsFor(roles: Role[]): NavGroup[] {
  const items = navigationFor(roles)
  if (!roles.includes('admin')) return [{ items }]

  const byId = new Map(items.map((item) => [item.id, item]))
  const groups: NavGroup[] = []

  for (const group of ADMIN_GROUPS as ReadonlyArray<{ heading?: string; ids: readonly View[] }>) {
    const present = group.ids
      .map((id) => byId.get(id))
      .filter((item): item is NavItem => item !== undefined)
    for (const item of present) byId.delete(item.id)
    if (present.length > 0) {
      groups.push(group.heading ? { heading: group.heading, items: present } : { items: present })
    }
  }

  // Nothing should reach here — the type above proves every `View` is filed —
  // but a station that somehow escaped the sections belongs on the rail rather
  // than nowhere.
  const unfiled = [...byId.values()]
  if (unfiled.length > 0) groups.push({ heading: 'Other', items: unfiled })

  return groups
}
