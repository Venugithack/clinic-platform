import type { Role } from '@/lib/types'
import type { IconName } from './ui/Icon'

export type View =
  | 'overview'
  | 'patients'
  | 'queue'
  | 'appointments'
  | 'due'
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

type NavItem = { id: View; label: string; eyebrow: string; icon: IconName }

export const NAVIGATION: Record<Role, NavItem[]> = {
  admin: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today', icon: 'overview' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record', icon: 'search' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry', icon: 'users' },
    /*
     * The appointment book, on the admin, doctor and nurse rails and on no
     * other. Those are exactly the roles `book_appointment` and its siblings
     * admit and the calendar reads answer (SLICE2_FRONTEND_CONTRACT.md §8).
     * The pharmacy rail does not carry it because the counter holds none of
     * those commands and the reads refuse it — a station drawn over controls
     * that could only fail is not an arrangement of what the role may do.
     *
     * It sits under More for the doctor and the nurse: their daily bars stay
     * three stations, and a booking is occasional work beside the queue
     * rather than the queue itself.
     */
    { id: 'appointments', label: 'Appointments', eyebrow: 'Booked visits', icon: 'calendar' },
    { id: 'staff', label: 'Staff', eyebrow: 'Admin control', icon: 'user' },
    { id: 'clinic', label: 'Clinic', eyebrow: 'Details that print', icon: 'settings' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation', icon: 'bed' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic', icon: 'rupee' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close', icon: 'receipt' },
    /*
     * The counter, on the admin rail as well as the pharmacy one.
     *
     * `take_payment` authorizes admin — the owner runs this clinic and stands
     * at the counter when the pharmacist is away — and Slice 4's snapshot sends
     * an admin the queue and the bills. Without this entry the data arrived and
     * the station did not, so the one person who most needs to cover the
     * counter was the one person with no way to reach it.
     *
     * Handing over medicine and ringing up an OTC sale are still the
     * pharmacist's alone (policy register item 17); the counter itself shows an
     * administrator only what an administrator may do.
     */
    { id: 'counter', label: 'Counter', eyebrow: 'Pharmacy counter', icon: 'counter' },
    { id: 'inventory', label: 'Inventory', eyebrow: 'Batch inventory', icon: 'pack' },
    { id: 'formulary', label: 'Formulary', eyebrow: 'Medicines & packages', icon: 'tag' },
    { id: 'receiving', label: 'Receiving', eyebrow: 'Goods received', icon: 'truck' },
    { id: 'opening', label: 'Opening count', eyebrow: 'Blind opening count', icon: 'clipboard' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off', icon: 'alert' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf', icon: 'boxes' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network', icon: 'users' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders', icon: 'bag' },
    { id: 'printer', label: 'Printer', eyebrow: 'Clinic printing', icon: 'printer' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1', icon: 'lock' },
    { id: 'audit', label: 'Activity', eyebrow: 'Accountability', icon: 'shield' },
  ],
  doctor: [
    { id: 'queue', label: 'Today', eyebrow: "Today's flow", icon: 'queue' },
    { id: 'consultation', label: 'Consult', eyebrow: 'Doctor workspace', icon: 'stethoscope' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry', icon: 'users' },
    { id: 'appointments', label: 'Appointments', eyebrow: 'Booked visits', icon: 'calendar' },
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today', icon: 'overview' },
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
    { id: 'vitals', label: 'Vitals', eyebrow: 'When the nurse is away', icon: 'pulse' },
    { id: 'records', label: 'Records', eyebrow: 'Clinical record', icon: 'history' },
    /*
     * Two things only a doctor can settle, at one destination.
     *
     * Results that have come back and nobody has read are the live half —
     * owner items 84-88 — and the old prescription lines nobody can read are
     * the migration backlog. Both are refused to everybody but a doctor by
     * the commands themselves, and both would otherwise need a rail entry
     * each, which the plan's three-or-four daily destinations does not have
     * room for.
     */
    { id: 'review', label: 'Review', eyebrow: 'Results and lines to settle', icon: 'alert-circle' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Approve a count', icon: 'boxes' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record', icon: 'search' },
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
    { id: 'due', label: 'Due now', eyebrow: 'Everything waiting on you', icon: 'clock' },
    { id: 'vitals', label: 'Vitals', eyebrow: 'Nursing station', icon: 'pulse' },
    { id: 'beds', label: 'Observation', eyebrow: 'Four-bed observation', icon: 'bed' },
    { id: 'queue', label: 'Today', eyebrow: "Today's flow", icon: 'queue' },
    { id: 'appointments', label: 'Appointments', eyebrow: 'Booked visits', icon: 'calendar' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry', icon: 'users' },
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today', icon: 'overview' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record', icon: 'search' },
  ],
  pharmacy: [
    { id: 'counter', label: 'Counter', eyebrow: 'Sell, supply and collect', icon: 'counter' },
    { id: 'inventory', label: 'Stock', eyebrow: 'Batch inventory', icon: 'boxes' },
    { id: 'billing', label: 'History', eyebrow: 'Bills and payments', icon: 'receipt' },
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today', icon: 'overview' },
    { id: 'formulary', label: 'Formulary', eyebrow: 'Medicines & packages', icon: 'tag' },
    { id: 'receiving', label: 'Receiving', eyebrow: 'Goods received', icon: 'truck' },
    { id: 'opening', label: 'Opening count', eyebrow: 'Blind opening count', icon: 'clipboard' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off', icon: 'alert' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf', icon: 'boxes' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network', icon: 'users' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders', icon: 'bag' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close', icon: 'rupee' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1', icon: 'lock' },
    { id: 'reports', label: 'Reports', eyebrow: 'Ask the record', icon: 'search' },
  ],
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacy: 'Pharmacy',
}

/**
 * The three stations each clinical role works out of all day.
 *
 * Everything else that role is authorized for stays authorized and stays
 * reachable, one tap away under **More**. This is an arrangement of the same
 * capabilities and never a reduction of them: `moreFor` is defined as
 * "`navigationFor` minus these", so a station cannot be dropped by being
 * forgotten here — it can only move.
 *
 * The administrator has no primary set. That role investigates exceptions
 * across the whole clinic rather than repeating one job, and the plan keeps its
 * detailed grouped rail for exactly that reason.
 */
const PRIMARY: Partial<Record<Role, readonly View[]>> = {
  doctor: ['queue', 'consultation', 'patients'],
  nurse: ['due', 'vitals', 'beds'],
  pharmacy: ['counter', 'inventory', 'billing'],
}

/**
 * The first screen after sign-in.
 *
 * The plan's governing rule is that the next patient or task is already in
 * front of the staff member, so nobody lands on a summary of a clinic they are
 * about to work in. Every role but the administrator opens on its own work.
 *
 * Precedence runs clinical-first for a person holding several roles. Dr.
 * Jayamurugan is doctor AND admin; the job he opens the tablet to do is the
 * queue, and Overview is one tap away on a rail he already has.
 */
const LANDING: Record<Role, View> = {
  doctor: 'queue',
  nurse: 'due',
  pharmacy: 'counter',
  admin: 'overview',
}

const LANDING_ORDER: readonly Role[] = ['doctor', 'nurse', 'pharmacy', 'admin']

export function landingFor(roles: Role[]): View {
  for (const role of LANDING_ORDER) {
    if (roles.includes(role)) return LANDING[role]
  }
  return 'overview'
}

/**
 * The admin rail, in sections.
 *
 * A doctor's rail is nine stations and a pharmacist's is fourteen; an
 * administrator's is twenty-one, and twenty-one words in one column is a list
 * you read rather than a building you know your way around. The brief's Slice 6
 * names the five divisions — people and access, clinic operations, inventory,
 * finance, settings — so those are the headings, and nothing is renamed, moved
 * between roles or hidden to produce them.
 *
 * Overview and Reports sit above the first heading on purpose. Neither belongs
 * to one division: Overview is the whole clinic today, and Reports answers
 * questions about stock, money and people from the same screen. Filing either
 * one under a heading would be filing it under the wrong heading four fifths
 * of the time.
 *
 * These sections are also what **More** is built from for the other three
 * roles, so a secondary menu arrives already grouped rather than as a second
 * flat list.
 */
const ADMIN_GROUPS = [
  { ids: ['overview', 'reports'] },
  { heading: 'People and access', ids: ['staff', 'audit'] },
  {
    heading: 'Clinic operations',
    ids: [
      'patients',
      'queue',
      'appointments',
      'due',
      'vitals',
      'consultation',
      'records',
      'review',
      'beds',
      'registers',
    ],
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
 * The three or four stations on the daily bar, for a role that has a primary
 * set. An administrator gets none, because the administrator gets the rail.
 */
export function primaryFor(roles: Role[]): NavItem[] {
  if (roles.includes('admin')) return []
  const byId = new Map(navigationFor(roles).map((item) => [item.id, item]))
  const wanted = new Set<View>()
  for (const role of roles) for (const id of PRIMARY[role] ?? []) wanted.add(id)

  const items: NavItem[] = []
  for (const id of wanted) {
    const item = byId.get(id)
    if (item) items.push(item)
  }
  return items
}

/** Everything a session may reach that is not already on the daily bar. */
export function moreFor(roles: Role[]): NavGroup[] {
  const onBar = new Set(primaryFor(roles).map((item) => item.id))
  return groupsOf(navigationFor(roles).filter((item) => !onBar.has(item.id)))
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
  return groupsOf(items)
}

function groupsOf(items: NavItem[]): NavGroup[] {
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
