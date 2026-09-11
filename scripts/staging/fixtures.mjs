/**
 * A clinic's worth of synthetic data for the staging database.
 *
 * This is the second half of Slice 0's first item: `up.mjs` builds an empty
 * schema, and this fills it with a Tuesday that somebody could actually work
 * through — a queue with people in it, a shelf with stock on it that is not all
 * in date, an unpaid bill, a prescription still waiting at the counter.
 *
 * ── WHAT IS AND IS NOT IN HERE ─────────────────────────────────────────────
 *
 * Every name, phone number and address below was invented for this file.
 * Nothing is copied from the clinic's live database, from `archive/`, or from
 * anywhere else in this repository, and nothing here is a real person. The
 * phone numbers are in a range that cannot ring anyone at all — see
 * TEST_DIALLING_CODE.
 *
 * The staff PINs are hashed by the backend's OWN scrypt, imported from
 * `supabase/functions/_shared/password.ts`, so a test can sign a fixture staff
 * member in through `createSession` exactly the way a tablet does. They are
 * also exported in plaintext as `FIXTURE_PINS`, which is safe precisely
 * because this data only ever exists in a loopback scratch database that
 * `guard.mjs` refuses to point anywhere else.
 *
 * ── EVERYTHING IS FIXED ────────────────────────────────────────────────────
 *
 * No `randomUUID()`, no `Math.random()`, no `current_date`. Ids are literals
 * assembled by `uid()`, which is a formatter and not a source of randomness:
 * a test may assert on `FIXTURE_BATCHES.paracetamolEarlier.id` and a failure
 * reproduces on the next run and on somebody else's machine. The only thing
 * that moves between runs is the calendar, and it moves on purpose — see
 * "The clinic's calendar" below.
 *
 * ── THE AWKWARD CASES ARE THE POINT ────────────────────────────────────────
 *
 * A fixture of tidy rows proves nothing. The shelf here deliberately holds two
 * batches of the same tablet at two prices and two expiry dates so FEFO has to
 * choose; a batch that expired three weeks ago and is still sitting there; a
 * batch counted down to zero; a medicine with no stock at all; and a supplier
 * who takes nothing back. Each one is annotated with what it is for.
 */
import { hashPassword } from '../../supabase/functions/_shared/password.ts'

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * A fixed id, in the shape the application's `randomUUID()` produces.
 *
 * `uid('a5', 3)` is 'a5000000-0000-4000-8000-000000000003' today, tomorrow,
 * and in CI. The two-character bucket says what kind of row it is, so an id in
 * a failing assertion or a foreign-key error names its own table.
 */
const uid = (bucket, n) => `${bucket}000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---------------------------------------------------------------------------
// The clinic's calendar
// ---------------------------------------------------------------------------

/**
 * The clinic is in Chennai and the database keeps UTC.
 *
 * `commands.ts` and `snapshot.ts` both decide what "today" means with
 * `(now() at time zone 'Asia/Kolkata')::date`, and every timestamp column in
 * this schema is ISO-8601 **text in UTC**. A fixture that builds today's queue
 * out of UTC midnight is a bomb with a five-and-a-half-hour fuse: between
 * 18:30 and 24:00 UTC, Chennai has already turned over, so rows written for
 * "today" land on the clinic's yesterday and the queue seeds itself empty.
 * It passes every time anybody runs it in the morning.
 *
 * So the clinic's date is computed in the clinic's zone, and clock times are
 * written as `+05:30` and converted. India has never observed daylight saving
 * and the offset is fixed by statute, which is the only reason a literal
 * offset is safe here; anywhere with DST this would have to go through the
 * zone database.
 */
export const CLINIC_TIMEZONE = 'Asia/Kolkata'
const CLINIC_UTC_OFFSET = '+05:30'

/** Today in Chennai, as YYYY-MM-DD. `en-CA` is the locale that renders ISO order. */
function clinicToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * A calendar builder anchored on one clinic date.
 *
 * Day arithmetic runs over UTC midnight of that date, which has no daylight
 * saving and therefore no 23- or 25-hour days to lose an offset in; only the
 * final rendering goes back through Chennai.
 */
function calendar(anchor) {
  const base = Date.parse(`${anchor}T00:00:00Z`)
  if (Number.isNaN(base)) throw new Error(`fixtures: "${anchor}" is not a YYYY-MM-DD clinic date.`)

  /** A clinic date `offset` days from the anchor, as YYYY-MM-DD. */
  const day = (offset = 0) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10)

  /** A clinic wall-clock moment, as the ISO-8601 UTC text the columns hold. */
  const at = (offset, hhmm) => new Date(`${day(offset)}T${hhmm}:00${CLINIC_UTC_OFFSET}`).toISOString()

  return { today: anchor, day, at }
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Every number here begins +999, and that is a deliberate refusal to be
 * dialled.
 *
 * ITU-T Recommendation E.164 holds the +99x block in reserve and has assigned
 * +999 to no country and no operator, so a fixture number cannot reach a
 * person however far it escapes. That matters more than it looks: read
 * `whatsapp.ts` and a bare ten-digit number is taken to mean India, because
 * ten digits is the whole of an Indian national number. Seed a plausible
 * ten-digit number and the day somebody points a configured WhatsApp account
 * at a staging database, the clinic messages a stranger in Chennai.
 *
 * The shape is `+999` plus nine digits — twelve in all, which `dialable()`
 * passes through untouched as an already-international number (it accepts 11
 * to 15). Three series keep the audiences apart:
 *
 *     +999 701 xxx xxx   patients
 *     +999 702 xxx xxx   staff
 *     +999 703 xxx xxx   suppliers
 */
export const TEST_DIALLING_CODE = '+999'
const patientPhone = (n) => `+999701000${String(n).padStart(3, '0')}`
const staffPhone = (n) => `+999702000${String(n).padStart(3, '0')}`
const supplierPhone = (n) => `+999703000${String(n).padStart(3, '0')}`

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * Six PINs, and deliberately not all the same length.
 *
 * Slice 1 moves the clinic from a six-digit PIN to a four-digit one, and a
 * stored scrypt hash cannot be shortened — so there is a stretch of the
 * rollout during which both lengths are live, one per staff member, recorded
 * in `staff.pin_format`. That stretch is the interesting state and it is what
 * these fixtures sit in: two people already reset, four still waiting.
 *
 * A fixture where everybody has been migrated would never exercise the
 * compatibility path, and one where nobody has would never exercise the new
 * one. Neither would catch the failure that matters — a six-digit PIN offered
 * to an account that has been reset, or the reverse.
 *
 * None of them is a repeated digit or a run, which `requirePin` rejects: a
 * fixture PIN the validator would refuse is one that cannot be re-created
 * through `create_staff` in a test.
 */
export const FIXTURE_PINS = {
  doctor: '4819',
  nurse: '7305',
  pharmacist: '268137',
  manager: '905283',
  relief: '614729',
  departed: '357046',
}

/**
 * Where each of them is in the migration. `four` means they have been reset;
 * `legacy_six` means an admin still has to sit down with them.
 *
 * Keep this in step with FIXTURE_PINS — a four-digit PIN marked `legacy_six`
 * cannot sign in, which is the whole point of the column and an annoying way
 * to discover it.
 */
export const FIXTURE_PIN_FORMATS = {
  doctor: 'four',
  nurse: 'four',
  pharmacist: 'legacy_six',
  manager: 'legacy_six',
  relief: 'legacy_six',
  departed: 'legacy_six',
}

/**
 * Four roles, and the two shapes that break naive role code: somebody holding
 * two of them at once, and somebody who no longer works here.
 *
 * `roles_json` is a JSON array of quoted strings and not, say, a comma list,
 * because `auth.ts` finds a doctor with `roles_json like '%"doctor"%"'`. The
 * quotes are load-bearing: without them "nurse" would match inside a longer
 * word the day somebody invents one.
 */
export const FIXTURE_STAFF = {
  /** The owner. Consults, and administers the clinic — hence two roles. */
  doctor: {
    id: uid('a1', 1),
    name: 'Dr. Anbarasan Kaliyaperumal',
    username: 'anbarasan',
    roles: ['doctor', 'admin'],
    phone: staffPhone(1),
    active: true,
  },
  nurse: {
    id: uid('a1', 2),
    name: 'Nirmaladevi Ponnusamy',
    username: 'nirmaladevi',
    roles: ['nurse'],
    phone: staffPhone(2),
    active: true,
  },
  pharmacist: {
    id: uid('a1', 3),
    name: 'Sathyaraj Vadivelan',
    username: 'sathyaraj',
    roles: ['pharmacy'],
    phone: staffPhone(3),
    active: true,
  },
  /** Front desk and the books. Admin only — no clinical role. */
  manager: {
    id: uid('a1', 4),
    name: 'Hemalatha Manoharan',
    username: 'hemalatha',
    roles: ['admin'],
    phone: staffPhone(4),
    active: true,
  },
  /** Covers the counter on the nurse's day off. The second dual-role case. */
  relief: {
    id: uid('a1', 5),
    name: 'Preethika Rajendran',
    username: 'preethika',
    roles: ['nurse', 'pharmacy'],
    phone: staffPhone(5),
    active: true,
  },
  /**
   * Left in June. Kept, deactivated, because her name is on last quarter's
   * bills and audit rows and deleting her would orphan them — and because a
   * correct PIN must still be refused for her. That refusal is a test.
   */
  departed: {
    id: uid('a1', 6),
    name: 'Vetrichelvan Duraisamy',
    username: 'vetrichelvan',
    roles: ['nurse'],
    phone: staffPhone(6),
    active: false,
  },
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

/**
 * Twelve people, invented, spread across seven decades and all three values
 * `sex` allows.
 *
 * Two are here for the layout rather than the clinic. `tamilScript` is written
 * in Tamil, which is what a Chennai clinic's register actually looks like and
 * what a print stylesheet with a Latin-only font stack quietly mangles.
 * `longName` is forty-nine characters, which is what overflows a queue card, a
 * bill header and a prescription heading — all three of which are meant to
 * survive it.
 */
export const FIXTURE_PATIENTS = {
  tamilScript: {
    id: uid('a2', 1),
    name: 'கஸ்தூரி வேலாயுதம்',
    age: 62,
    sex: 'female',
    phone: patientPhone(101),
    address: 'No. 14, Kambar Street, Villivakkam, Chennai 600 049',
    whatsappConsent: true,
  },
  longName: {
    id: uid('a2', 2),
    name: 'Venkataramanujam Thiruvengadathan Sundaravadivelu',
    age: 47,
    sex: 'male',
    phone: patientPhone(102),
    address: 'Flat 3B, Sengamalam Apartments, Perungudi, Chennai 600 096',
    whatsappConsent: true,
  },
  hypertensive: {
    id: uid('a2', 3),
    name: 'Arulmozhi Chinnadurai',
    age: 54,
    sex: 'female',
    phone: patientPhone(103),
    address: 'No. 8, Thendral Nagar Main Road, Ambattur, Chennai 600 053',
    whatsappConsent: false,
  },
  /** A child. Doses, and the age column, both behave differently down here. */
  child: {
    id: uid('a2', 4),
    name: 'Devanathan Kuppuswamy',
    age: 8,
    sex: 'male',
    phone: patientPhone(104),
    address: '',
    whatsappConsent: true,
  },
  diabetic: {
    id: uid('a2', 5),
    name: 'Ilakkiya Muthuvel',
    age: 29,
    sex: 'female',
    phone: patientPhone(105),
    address: 'No. 22, Pattabiram Bazaar Street, Chennai 600 072',
    whatsappConsent: true,
  },
  elderly: {
    id: uid('a2', 6),
    name: 'Saravanaperumal Ezhilarasan',
    age: 71,
    sex: 'male',
    phone: patientPhone(106),
    address: 'No. 5, Marudham Illam, Korattur, Chennai 600 080',
    whatsappConsent: false,
  },
  /** The only 'other' in the fixture, and the reason the column has three values. */
  otherSex: {
    id: uid('a2', 7),
    name: 'Jothimani Alagesan',
    age: 35,
    sex: 'other',
    phone: patientPhone(107),
    address: 'No. 61, Vaigai Street, Nolambur, Chennai 600 095',
    whatsappConsent: true,
  },
  infant: {
    id: uid('a2', 8),
    name: 'Nithyakalyani Pazhaniappan',
    age: 3,
    sex: 'female',
    phone: patientPhone(108),
    address: '',
    whatsappConsent: true,
  },
  retired: {
    id: uid('a2', 9),
    name: 'Raghuraman Andiappan',
    age: 66,
    sex: 'male',
    phone: patientPhone(109),
    address: 'No. 9, Ponvizha Nagar, Madhavaram, Chennai 600 060',
    whatsappConsent: false,
  },
  student: {
    id: uid('a2', 10),
    name: 'Yazhini Perumalsamy',
    age: 19,
    sex: 'female',
    phone: patientPhone(110),
    address: 'No. 30, Kalaimagal Street, Anna Nagar West, Chennai 600 101',
    whatsappConsent: true,
  },
  driver: {
    id: uid('a2', 11),
    name: 'Mohanraj Ellappan',
    age: 41,
    sex: 'male',
    phone: patientPhone(111),
    address: 'No. 2, Erikarai Road, Puzhal, Chennai 600 066',
    whatsappConsent: false,
  },
  oldest: {
    id: uid('a2', 12),
    name: 'Chandrakala Sivagnanam',
    age: 83,
    sex: 'female',
    phone: patientPhone(112),
    address: 'No. 17, Sannathi Street, Thiruvottiyur, Chennai 600 019',
    whatsappConsent: true,
  },
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * Four, and the reason they differ is `return_window_days`.
 *
 * `INVENTORY.md` §6 and the migration that added the column make the point:
 * stock expiring in five months from a supplier who takes returns at six is
 * more urgent than stock expiring in three from a supplier who takes none, so
 * the expiring list cannot simply sort by date. That is only testable with
 * suppliers whose windows disagree, including one at zero.
 *
 * The four `whatsapp` values are the four answers `dialable()` in
 * `whatsapp.ts` can give — clean, digits-only, refused, and missing — so the
 * WhatsApp path can be exercised without a fifth fixture.
 */
export const FIXTURE_SUPPLIERS = {
  /** Generous window. Near-expiry stock from here is worth returning. */
  wholesale: {
    id: uid('a3', 1),
    code: 'SUP-KVW',
    name: 'Kovai Wholesale Drug House',
    contactPerson: 'Selvakumaran Ayyanar',
    whatsapp: '+999 703 000 001', // written with spaces, as somebody would type it
    phone: supplierPhone(1),
    email: 'orders@kovai-wholesale.invalid',
    address: 'No. 3, Ranganathan Complex, Peelamedu, Coimbatore 641 004',
    gstin: '33ZZZZZ1111Z1Z1',
    returnWindowDays: 180,
    active: true,
  },
  generics: {
    id: uid('a3', 2),
    code: 'SUP-TGD',
    name: 'Thanjavur Generics Depot',
    contactPerson: 'Pushpavalli Rangasamy',
    whatsapp: '999703000002', // digits only, no plus — the other common shape
    phone: supplierPhone(2),
    email: 'depot@thanjavur-generics.invalid',
    address: 'No. 44, South Rampart, Thanjavur 613 001',
    gstin: '33ZZZZZ2222Z1Z2',
    returnWindowDays: 90,
    active: true,
  },
  /**
   * Takes nothing back. Their expiring stock has exactly one route — write it
   * off — and it should sort above stock that can still be returned.
   */
  surgicals: {
    id: uid('a3', 3),
    code: 'SUP-PBS',
    name: 'Perambur Surgicals',
    // Two numbers in one field, which is how a second number gets recorded
    // here. `dialable()` refuses it on purpose rather than joining them into
    // a twenty-digit number that reaches a stranger.
    whatsapp: '+999703000003 / +999703000009',
    contactPerson: 'Dhanasekaran Ponraj',
    phone: supplierPhone(3),
    email: '',
    address: 'No. 76, Paper Mills Road, Perambur, Chennai 600 011',
    gstin: '33ZZZZZ3333Z1Z3',
    returnWindowDays: 0,
    active: true,
  },
  /** No longer used. Kept because old batches still point at them. */
  retired: {
    id: uid('a3', 4),
    code: 'SUP-CPT',
    name: 'Chetpet Pharma Traders',
    contactPerson: 'Kamatchi Subbaiah',
    whatsapp: '', // nothing saved at all — the 'missing' branch
    phone: '',
    email: '',
    address: 'No. 12, Halls Road, Chetpet, Chennai 600 031',
    gstin: '',
    returnWindowDays: 45,
    active: false,
  },
}

// ---------------------------------------------------------------------------
// The formulary
// ---------------------------------------------------------------------------

/**
 * Eighteen lines — a small clinic's whole shelf, not a drug database.
 *
 * Between them they cover every `dosage_form` the documents care about
 * (tablet, capsule, syrup, cream, drops, injection, dressing, sachet), every
 * `sale_class` including `unknown`, and every `schedule` including `unset`.
 * The last two are not padding: `sale_class = 'unknown'` is what a CSV import
 * leaves behind, and `schedule = 'unset'` is the value the Schedule H1
 * register counts and refuses to call itself complete while any remain. A
 * formulary with none of either cannot test the register's honesty.
 */
export const FIXTURE_MEDICINES = {
  paracetamol: {
    id: uid('a4', 1), code: 'MED-001', name: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000017',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 200, targetStock: 1000,
    supplier: 'wholesale', active: true,
  },
  amoxicillin: {
    id: uid('a4', 2), code: 'MED-002', name: 'Amoxicillin', strength: '250 mg',
    dosageForm: 'capsule', unit: 'capsule', barcode: '8909990000024',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 100, targetStock: 600,
    supplier: 'wholesale', active: true,
  },
  /** Schedule H1. Every dispense of this has to reach the register. */
  azithromycin: {
    id: uid('a4', 3), code: 'MED-003', name: 'Azithromycin', strength: '500 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000031',
    saleClass: 'restricted', schedule: 'H1', reorderLevel: 30, targetStock: 150,
    supplier: 'wholesale', active: true,
  },
  cetirizine: {
    id: uid('a4', 4), code: 'MED-004', name: 'Cetirizine', strength: '10 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000048',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 100, targetStock: 500,
    supplier: 'generics', active: true,
  },
  coughSyrup: {
    id: uid('a4', 5), code: 'MED-005', name: 'Ambroxol and Guaiphenesin', strength: '100 ml',
    dosageForm: 'syrup', unit: 'bottle', barcode: '8909990000055',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 40,
    supplier: 'generics', active: true,
  },
  ibuprofen: {
    id: uid('a4', 6), code: 'MED-006', name: 'Ibuprofen', strength: '400 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000062',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 150, targetStock: 700,
    supplier: 'generics', active: true,
  },
  metformin: {
    id: uid('a4', 7), code: 'MED-007', name: 'Metformin', strength: '500 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000079',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 200, targetStock: 900,
    supplier: 'generics', active: true,
  },
  amlodipine: {
    id: uid('a4', 8), code: 'MED-008', name: 'Amlodipine', strength: '5 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000086',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 150, targetStock: 600,
    supplier: 'generics', active: true,
  },
  pantoprazole: {
    id: uid('a4', 9), code: 'MED-009', name: 'Pantoprazole', strength: '40 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000093',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 100, targetStock: 400,
    supplier: 'wholesale', active: true,
  },
  /**
   * OUT OF STOCK ON PURPOSE — no batch anywhere.
   *
   * `total_available` has to come back 0 rather than null, the reorder list
   * has to name it, and a dispense has to refuse with "Only 0 unit(s) are
   * available." rather than crashing on an empty allocation.
   */
  ondansetronInjection: {
    id: uid('a4', 10), code: 'MED-010', name: 'Ondansetron', strength: '2 mg/ml, 2 ml',
    dosageForm: 'injection', unit: 'vial', barcode: '8909990000109',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 10, targetStock: 40,
    supplier: 'wholesale', active: true,
  },
  /** Schedule X — the tightest register there is. */
  diazepam: {
    id: uid('a4', 11), code: 'MED-011', name: 'Diazepam', strength: '5 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000116',
    saleClass: 'restricted', schedule: 'X', reorderLevel: 10, targetStock: 50,
    supplier: 'wholesale', active: true,
  },
  clotrimazoleCream: {
    id: uid('a4', 12), code: 'MED-012', name: 'Clotrimazole', strength: '1% w/w, 15 g',
    dosageForm: 'cream', unit: 'tube', barcode: '8909990000123',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 5, targetStock: 25,
    supplier: 'generics', active: true,
  },
  ciprofloxacinDrops: {
    id: uid('a4', 13), code: 'MED-013', name: 'Ciprofloxacin eye drops', strength: '0.3% w/v, 5 ml',
    dosageForm: 'drops', unit: 'bottle', barcode: '8909990000130',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 5, targetStock: 24,
    supplier: 'wholesale', active: true,
  },
  /** A consumable. Its base unit is a piece, and it has no strength at all. */
  gauze: {
    id: uid('a4', 14), code: 'MED-014', name: 'Sterile gauze swab', strength: '7.5 cm x 7.5 cm',
    dosageForm: 'dressing', unit: 'piece', barcode: '8909990000147',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 100, targetStock: 500,
    supplier: 'surgicals', active: true,
  },
  ors: {
    id: uid('a4', 15), code: 'MED-015', name: 'Oral rehydration salts', strength: '21.8 g',
    dosageForm: 'sachet', unit: 'sachet', barcode: '8909990000154',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 40, targetStock: 200,
    supplier: 'generics', active: true,
  },
  /**
   * UNCLASSIFIED ON PURPOSE. Arrived through a CSV import with nothing in
   * either column, which is exactly how a real drug master gets holes in it.
   * The H1 register should report it as unset rather than guessing.
   */
  cyanocobalamin: {
    id: uid('a4', 16), code: 'MED-016', name: 'Cyanocobalamin', strength: '1500 mcg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '',
    saleClass: 'unknown', schedule: 'unset', reorderLevel: 50, targetStock: 200,
    supplier: null, active: true,
  },
  /**
   * DISCONTINUED but still holding stock. A deactivated medicine has to drop
   * out of search and off the counter while its remaining batch still counts
   * towards the shelf valuation — it did not stop being worth money.
   */
  nimesulide: {
    id: uid('a4', 17), code: 'MED-017', name: 'Nimesulide', strength: '100 mg',
    dosageForm: 'tablet', unit: 'tablet', barcode: '8909990000178',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 0, targetStock: 10,
    supplier: 'generics', active: false,
  },
  tramadol: {
    id: uid('a4', 18), code: 'MED-018', name: 'Tramadol', strength: '50 mg',
    dosageForm: 'capsule', unit: 'capsule', barcode: '8909990000185',
    saleClass: 'restricted', schedule: 'H1', reorderLevel: 10, targetStock: 60,
    supplier: 'wholesale', active: true,
  },
}

// ---------------------------------------------------------------------------
// Documents, so the ledger below can point at them
// ---------------------------------------------------------------------------

/**
 * Today's queue.
 *
 * Eight people, one in every status the column allows, holding tokens
 * JMC-0001 to JMC-0008. `appointment_token_seq` is wound past them at the end
 * of the seed; without that the first real check-in mints JMC-0001 again and
 * two patients in the corridor hold the same number, which is the fault the
 * document-numbers migration exists to prevent and which nothing in the schema
 * catches — `appointments.token` has no unique index.
 */
export const FIXTURE_APPOINTMENTS = {
  seenFirst: { id: uid('a6', 1), token: 'JMC-0001', patient: 'tamilScript', status: 'done', time: '08:50', reason: 'Fever and body pain for three days' },
  seenSecond: { id: uid('a6', 2), token: 'JMC-0002', patient: 'longName', status: 'done', time: '09:25', reason: 'Acidity and burning after meals' },
  inCabin: { id: uid('a6', 3), token: 'JMC-0003', patient: 'hypertensive', status: 'in_consult', time: '10:10', reason: 'Blood pressure review' },
  waitingChild: { id: uid('a6', 4), token: 'JMC-0004', patient: 'child', status: 'waiting', time: '10:40', reason: 'Dry cough, no fever' },
  waitingDiabetic: { id: uid('a6', 5), token: 'JMC-0005', patient: 'diabetic', status: 'waiting', time: '11:00', reason: 'Sugar review and repeat tablets' },
  waitingElderly: { id: uid('a6', 6), token: 'JMC-0006', patient: 'elderly', status: 'waiting', time: '11:15', reason: 'Giddiness since morning' },
  didNotWait: { id: uid('a6', 7), token: 'JMC-0007', patient: 'otherSex', status: 'cancelled', time: '11:30', reason: 'Ear pain' },
  waitingRash: { id: uid('a6', 8), token: 'JMC-0008', patient: 'infant', status: 'waiting', time: '11:45', reason: 'Skin rash on both arms' },
}

export const FIXTURE_ENCOUNTERS = {
  fever: { id: uid('a7', 1), patient: 'tamilScript', appointment: 'seenFirst', daysAgo: 0, time: '09:05' },
  acidity: { id: uid('a7', 2), patient: 'longName', appointment: 'seenSecond', daysAgo: 0, time: '09:40' },
  lastWeek: { id: uid('a7', 3), patient: 'hypertensive', appointment: null, daysAgo: 9, time: '10:20' },
  adviceOnly: { id: uid('a7', 4), patient: 'diabetic', appointment: null, daysAgo: 2, time: '11:00' },
}

/**
 * Three signed prescriptions, and the difference between them is the point.
 *
 * `dispensedToday` has stock movements behind it and a `dispensed_at`.
 * `waitingAtCounter` has neither — it is signed, it is real, and it is sitting
 * in the pharmacy queue, which is the state the counter screen exists to show
 * and the only state `dispense_rx` will accept.
 */
export const FIXTURE_PRESCRIPTIONS = {
  dispensedToday: { id: uid('a8', 1), encounter: 'fever', patient: 'tamilScript', dispensed: true },
  waitingAtCounter: { id: uid('a8', 2), encounter: 'acidity', patient: 'longName', dispensed: false },
  dispensedLastWeek: { id: uid('a8', 3), encounter: 'lastWeek', patient: 'hypertensive', dispensed: true },
}

export const FIXTURE_BILLS = {
  paidCashToday: { id: uid('a9', 1), patient: 'tamilScript', amount: 200, status: 'paid', method: 'cash' },
  unpaidToday: { id: uid('a9', 2), patient: 'longName', amount: 200, status: 'unpaid', method: null },
  paidUpiLastWeek: { id: uid('a9', 3), patient: 'hypertensive', amount: 200, status: 'paid', method: 'upi' },
  /** Two days old and still owed. Somebody has to chase this. */
  unpaidSince: { id: uid('a9', 4), patient: 'diabetic', amount: 200, status: 'unpaid', method: null },
}

export const FIXTURE_SALES = {
  yesterdayCash: { id: uid('b4', 1), receipt: 'OTC-0001', method: 'cash' },
  todayCash: { id: uid('b4', 2), receipt: 'OTC-0002', method: 'cash' },
  todayUpi: { id: uid('b4', 3), receipt: 'OTC-0003', method: 'upi' },
}

export const FIXTURE_ORDERS = {
  draft: { id: uid('b5', 1), number: 'PO-0001', supplier: 'wholesale', status: 'pending' },
  awaitingDelivery: { id: uid('b5', 2), number: 'PO-0002', supplier: 'generics', status: 'placed' },
  delivered: { id: uid('b5', 3), number: 'PO-0003', supplier: 'wholesale', status: 'delivered' },
}

export const FIXTURE_RETURN = { id: uid('b7', 1), number: 'RET-0001', supplier: 'wholesale', status: 'sent' }

export const FIXTURE_WRITEOFFS = {
  syrupDamage: { id: uid('b8', 1), reason: 'damage' },
  azithromycinLoss: { id: uid('b8', 2), reason: 'loss' },
  cetirizineExpiry: { id: uid('b8', 3), reason: 'expiry' },
}

export const FIXTURE_STOCK_TAKE = { id: uid('b9', 1), reference: 'ST-0001', status: 'posted' }

export const FIXTURE_TILLS = {
  closedYesterday: { id: uid('c2', 1) },
  openToday: { id: uid('c2', 2) },
}

export const FIXTURE_BEDS = {
  occupied: { id: uid('b2', 1), label: 'Bed 1' },
  free: { id: uid('b2', 2), label: 'Bed 2' },
  cleaning: { id: uid('b2', 3), label: 'Bed 3' },
  broken: { id: uid('b2', 4), label: 'Day care couch' },
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/**
 * What each product physically arrives in.
 *
 * Deliberately not all tablets. A clinic that only ever ships strips of
 * fifteen never finds out that the conversion is data: the ampoule tray, the
 * syrup carton, the cream box and the gauze dispenser are here so that every
 * screen and every query meets a ladder that is not the tablet one.
 *
 * The first entry is always the base — the smallest safe countable item the
 * clinic stocks, which is a whole bottle and a whole ampoule, never a
 * millilitre. The clinic answered "no" to dividing an opened container.
 */
const FIXTURE_PACKAGES = {
  paracetamol: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
      { levelName: 'case', levelType: 'case', contains: 'box', containsCount: 20 },
    ],
  },
  amoxicillin: {
    baseUnit: 'capsule',
    levels: [
      { levelName: 'capsule', levelType: 'capsule', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'capsule', containsCount: 10, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
    ],
  },
  azithromycin: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 3, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10 },
    ],
  },
  cetirizine: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 10, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 20, sellable: true },
    ],
  },
  /** Sealed. `breakable: false` is what keeps millilitres out of the counter. */
  coughSyrup: {
    baseUnit: 'bottle',
    levels: [
      { levelName: 'bottle', levelType: 'bottle', sellable: true, breakable: false, mrpBasis: true },
      { levelName: 'carton', levelType: 'carton', contains: 'bottle', containsCount: 12 },
    ],
  },
  clotrimazoleCream: {
    baseUnit: 'tube',
    levels: [
      { levelName: 'tube', levelType: 'tube', sellable: true, breakable: false, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'tube', containsCount: 24 },
    ],
  },
  /** Three rungs and a hard floor: no fraction of an ampoule exists. */
  ondansetronInjection: {
    baseUnit: 'vial',
    levels: [
      { levelName: 'vial', levelType: 'vial', sellable: true, breakable: false, mrpBasis: true },
      { levelName: 'tray', levelType: 'tray', contains: 'vial', containsCount: 5 },
      { levelName: 'carton', levelType: 'carton', contains: 'tray', containsCount: 10 },
    ],
  },
  /** A custom type, configured rather than coded. */
  gauze: {
    baseUnit: 'piece',
    levels: [
      { levelName: 'piece', levelType: 'piece', sellable: true },
      { levelName: 'inner pack', levelType: 'inner pack', contains: 'piece', containsCount: 5, sellable: true, mrpBasis: true },
      { levelName: 'dispenser', levelType: 'dispenser', contains: 'inner pack', containsCount: 20 },
    ],
  },
  ors: {
    baseUnit: 'sachet',
    levels: [
      { levelName: 'sachet', levelType: 'sachet', sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'sachet', containsCount: 20, sellable: true },
    ],
  },
  ibuprofen: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
    ],
  },
  metformin: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 20, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 15, sellable: true },
    ],
  },
  amlodipine: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 10, sellable: true, mrpBasis: true },
    ],
  },
  pantoprazole: {
    baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
    ],
  },
}

/**
 * Expand a fixture ladder into the rows the schema holds.
 *
 * The same arithmetic `supabase/functions/_shared/packages.ts` does, written
 * again rather than imported: the fixtures are a Node script and the backend
 * is Deno TypeScript, and the point of a fixture is to be an independent
 * statement of what the data should look like. If the two ever disagree the
 * package trigger raises, which is the check that matters.
 */
function expandLadder(pack) {
  const byName = new Map(pack.levels.map((level) => [level.levelName, level]))
  let factor = 1
  return pack.levels.map((level, depth) => {
    if (depth > 0) {
      const child = byName.get(level.contains)
      if (!child) throw new Error(`${level.levelName} contains ${level.contains}, which is not a level`)
      factor *= level.containsCount
    }
    return {
      levelName: level.levelName,
      levelType: level.levelType,
      contains: level.contains ?? null,
      containsCount: level.containsCount ?? null,
      depth,
      baseFactor: factor,
      receivable: level.receivable ?? true,
      sellable: level.sellable ?? depth === 0,
      breakable: level.breakable ?? depth > 0,
      minimumSaleMultiple: level.minimumSaleMultiple ?? 1,
      mrpBasis: level.mrpBasis ?? false,
      barcodeHint: '',
    }
  })
}

/**
 * Codes on the shelf.
 *
 * `carriesBatch` is false for every EAN-13 here, and that is not laziness: a
 * plain GTIN identifies a trade item, not a lot. Only the DataMatrix carries
 * batch and expiry, because only a GS1 payload with application identifiers
 * (10) and (17) actually does.
 */
const FIXTURE_BARCODES = [
  { medicine: 'paracetamol', levelName: 'strip', code: '8909990000017', symbology: 'ean13' },
  { medicine: 'paracetamol', levelName: 'box', code: '18909990000014', symbology: 'itf14' },
  { medicine: 'amoxicillin', levelName: 'strip', code: '8909990000024', symbology: 'ean13' },
  { medicine: 'cetirizine', levelName: 'strip', code: '8909990000048', symbology: 'ean13' },
  { medicine: 'coughSyrup', levelName: 'bottle', code: '8909990000055', symbology: 'ean13' },
  {
    medicine: 'azithromycin', levelName: 'strip',
    code: '0108909990000313172803311012AZ4471', symbology: 'gs1_datamatrix', carriesBatch: true,
  },
]

/** A code somebody scanned that maps to nothing. The admin's queue, not an error. */
const FIXTURE_UNMAPPED_BARCODE = { code: '5060337028134', symbology: 'ean13', seenCount: 3 }

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------

/**
 * Twenty batches, and about half of them are here to be difficult.
 *
 * `quantity` is never written down. Each batch carries its movements and
 * `available_quantity` is their sum, because `INVENTORY.md` §1 says the ledger
 * is the truth and the batch figure is a cache over it. A fixture that types
 * both numbers separately is a fixture that can disagree with itself, and
 * every reconciliation test written against it is then worthless. The seed
 * re-checks the arithmetic in SQL before it commits anyway.
 *
 * `expiryInDays` is relative to the clinic's today for the same reason nothing
 * else here is absolute: a batch that is "expiring soon" has to still be
 * expiring soon next month.
 */
const BATCH_PLAN = {
  /**
   * FEFO, half one. Cheaper, older, and expiring inside ninety days, so this
   * is both the batch the expiring list must raise and the batch every
   * allocation must empty before it touches the newer one.
   */
  paracetamolEarlier: {
    id: uid('a5', 1), medicine: 'paracetamol', batchNumber: 'PCM-2409A',
    expiryInDays: 82, mrp: 22, purchasePrice: 14.5, sellingPrice: 22,
    supplier: 'wholesale', receivedDaysAgo: 150,
    why: 'earliest live expiry of two, and a different MRP from its sibling',
    movements: [
      { type: 'opening_stock', delta: 600, refType: 'medicine', ref: 'medicine', daysAgo: 150, time: '10:00', actor: 'pharmacist' },
      { type: 'prescription', delta: -10, refType: 'prescription', ref: 'rx:dispensedLastWeek', daysAgo: 9, time: '10:55', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -50, refType: 'otc_sale', ref: 'sale:yesterdayCash', daysAgo: 1, time: '17:40', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -20, refType: 'otc_sale', ref: 'sale:todayCash', daysAgo: 0, time: '10:30', actor: 'pharmacist' },
      { type: 'prescription', delta: -10, refType: 'prescription', ref: 'rx:dispensedToday', daysAgo: 0, time: '09:40', actor: 'pharmacist' },
    ],
  },
  /** FEFO, half two. Dearer, newer, untouched — and it must stay untouched. */
  paracetamolLater: {
    id: uid('a5', 2), medicine: 'paracetamol', batchNumber: 'PCM-2502B',
    expiryInDays: 400, mrp: 24.5, purchasePrice: 15.75, sellingPrice: 24.5,
    supplier: 'wholesale', receivedDaysAgo: 20,
    why: 'later expiry and a higher MRP; FEFO must not reach it while PCM-2409A holds stock',
    movements: [
      { type: 'purchase_receipt', delta: 1000, refType: 'purchase_order', ref: 'order:delivered', daysAgo: 20, time: '11:15', actor: 'pharmacist' },
    ],
  },
  /**
   * Expiring in forty-five days from a supplier whose return window is a
   * hundred and eighty. Inside the window, so the right action is a credit
   * note and not a write-off — and a hundred of it has already gone back.
   */
  amoxicillinNearExpiry: {
    id: uid('a5', 3), medicine: 'amoxicillin', batchNumber: 'AMX-2411C',
    expiryInDays: 45, mrp: 68, purchasePrice: 41, sellingPrice: 68,
    supplier: 'wholesale', receivedDaysAgo: 120,
    why: 'inside ninety days AND inside the supplier return window',
    movements: [
      { type: 'opening_stock', delta: 400, refType: 'medicine', ref: 'medicine', daysAgo: 120, time: '09:30', actor: 'pharmacist' },
      { type: 'return_supplier', delta: -100, refType: 'return_supplier', ref: 'return', daysAgo: 12, time: '16:20', actor: 'pharmacist' },
      { type: 'prescription', delta: -20, refType: 'prescription', ref: 'rx:dispensedLastWeek', daysAgo: 9, time: '10:55', actor: 'pharmacist' },
    ],
  },
  /**
   * EXHAUSTED. Zero on hand, and an earlier expiry than the live batch beside
   * it — so `allocateStock`'s `available_quantity > 0` filter is the only
   * thing standing between FEFO and an empty shelf. Remove that filter and
   * this fixture fails.
   */
  azithromycinExhausted: {
    id: uid('a5', 4), medicine: 'azithromycin', batchNumber: 'AZT-2312D',
    expiryInDays: 210, mrp: 96, purchasePrice: 63, sellingPrice: 96,
    supplier: 'wholesale', receivedDaysAgo: 240,
    why: 'zero on hand with an earlier expiry than the live batch',
    movements: [
      { type: 'opening_stock', delta: 30, refType: 'medicine', ref: 'medicine', daysAgo: 240, time: '10:00', actor: 'pharmacist' },
      { type: 'writeoff_loss', delta: -30, refType: 'writeoff_loss', ref: 'writeoff:azithromycinLoss', daysAgo: 30, time: '18:05', actor: 'manager' },
    ],
  },
  azithromycinLive: {
    id: uid('a5', 5), medicine: 'azithromycin', batchNumber: 'AZT-2504E',
    expiryInDays: 300, mrp: 102, purchasePrice: 66.5, sellingPrice: 102,
    supplier: 'wholesale', receivedDaysAgo: 30,
    why: 'the H1 stock that is actually dispensable',
    movements: [
      { type: 'opening_stock', delta: 120, refType: 'medicine', ref: 'medicine', daysAgo: 30, time: '09:50', actor: 'pharmacist' },
      { type: 'prescription', delta: -3, refType: 'prescription', ref: 'rx:dispensedToday', daysAgo: 0, time: '09:40', actor: 'pharmacist' },
    ],
  },
  /**
   * EXPIRED THREE WEEKS AGO and still on the shelf with sixty in it.
   *
   * Somebody wrote off part of it and never came back. It must not count
   * towards `total_available`, must never be allocated, and must appear on the
   * expired list — which is three different behaviours that all look identical
   * when the fixture has no expired stock in it.
   */
  cetirizineExpired: {
    id: uid('a5', 6), medicine: 'cetirizine', batchNumber: 'CTZ-2401F',
    expiryInDays: -20, mrp: 18, purchasePrice: 11, sellingPrice: 18,
    supplier: 'generics', receivedDaysAgo: 300,
    why: 'already expired, still physically on the shelf, partially written off',
    movements: [
      { type: 'opening_stock', delta: 100, refType: 'medicine', ref: 'medicine', daysAgo: 300, time: '10:10', actor: 'pharmacist' },
      { type: 'writeoff_expiry', delta: -40, refType: 'writeoff_expiry', ref: 'writeoff:cetirizineExpiry', daysAgo: 5, time: '19:10', actor: 'pharmacist' },
    ],
  },
  cetirizineLive: {
    id: uid('a5', 7), medicine: 'cetirizine', batchNumber: 'CTZ-2503G',
    expiryInDays: 330, mrp: 19.5, purchasePrice: 12.25, sellingPrice: 19.5,
    supplier: 'generics', receivedDaysAgo: 25,
    why: 'the in-date sibling of the expired batch',
    movements: [
      { type: 'opening_stock', delta: 300, refType: 'medicine', ref: 'medicine', daysAgo: 25, time: '09:20', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -40, refType: 'otc_sale', ref: 'sale:yesterdayCash', daysAgo: 1, time: '17:40', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -12, refType: 'otc_sale', ref: 'sale:todayUpi', daysAgo: 0, time: '12:15', actor: 'relief' },
    ],
  },
  coughSyrup: {
    id: uid('a5', 8), medicine: 'coughSyrup', batchNumber: 'AMB-2502H',
    expiryInDays: 240, mrp: 92, purchasePrice: 58, sellingPrice: 92,
    supplier: 'generics', receivedDaysAgo: 40,
    why: 'a bottle unit, and six of it broken in transit',
    movements: [
      { type: 'opening_stock', delta: 48, refType: 'medicine', ref: 'medicine', daysAgo: 40, time: '09:45', actor: 'pharmacist' },
      { type: 'writeoff_damage', delta: -6, refType: 'writeoff_damage', ref: 'writeoff:syrupDamage', daysAgo: 35, time: '18:40', actor: 'pharmacist' },
    ],
  },
  ibuprofen: {
    id: uid('a5', 9), medicine: 'ibuprofen', batchNumber: 'IBU-2501J',
    expiryInDays: 285, mrp: 26, purchasePrice: 16.4, sellingPrice: 26,
    supplier: 'generics', receivedDaysAgo: 60, why: 'ordinary stock',
    movements: [
      { type: 'opening_stock', delta: 500, refType: 'medicine', ref: 'medicine', daysAgo: 60, time: '10:05', actor: 'pharmacist' },
      { type: 'prescription', delta: -15, refType: 'prescription', ref: 'rx:dispensedLastWeek', daysAgo: 9, time: '10:55', actor: 'pharmacist' },
    ],
  },
  /** The batch the stock-take corrected. Three short, and the ledger says so. */
  metformin: {
    id: uid('a5', 10), medicine: 'metformin', batchNumber: 'MET-2412K',
    expiryInDays: 365, mrp: 31, purchasePrice: 19.8, sellingPrice: 31,
    supplier: 'generics', receivedDaysAgo: 20,
    why: 'carries the posted stock-take adjustment',
    movements: [
      { type: 'opening_stock', delta: 900, refType: 'medicine', ref: 'medicine', daysAgo: 20, time: '09:15', actor: 'pharmacist' },
      { type: 'adjust', delta: -3, refType: 'stock_take', ref: 'stocktake', daysAgo: 6, time: '19:30', actor: 'doctor' },
    ],
  },
  /** Counted and correct. A stock-take with no clean line proves nothing. */
  amlodipine: {
    id: uid('a5', 11), medicine: 'amlodipine', batchNumber: 'AML-2503L',
    expiryInDays: 420, mrp: 28.5, purchasePrice: 17.9, sellingPrice: 28.5,
    supplier: 'generics', receivedDaysAgo: 35,
    why: 'counted at the stock-take and found exactly right',
    movements: [
      { type: 'opening_stock', delta: 450, refType: 'medicine', ref: 'medicine', daysAgo: 35, time: '09:35', actor: 'pharmacist' },
    ],
  },
  pantoprazole: {
    id: uid('a5', 12), medicine: 'pantoprazole', batchNumber: 'PAN-2502M',
    expiryInDays: 270, mrp: 44, purchasePrice: 27.6, sellingPrice: 44,
    supplier: 'wholesale', receivedDaysAgo: 50, why: 'ordinary stock',
    movements: [
      { type: 'opening_stock', delta: 300, refType: 'medicine', ref: 'medicine', daysAgo: 50, time: '10:20', actor: 'pharmacist' },
      { type: 'prescription', delta: -10, refType: 'prescription', ref: 'rx:dispensedLastWeek', daysAgo: 9, time: '10:55', actor: 'pharmacist' },
    ],
  },
  diazepam: {
    id: uid('a5', 13), medicine: 'diazepam', batchNumber: 'DZP-2410N',
    expiryInDays: 200, mrp: 12, purchasePrice: 7.1, sellingPrice: 12,
    supplier: 'wholesale', receivedDaysAgo: 100, why: 'the Schedule X line',
    movements: [
      { type: 'opening_stock', delta: 40, refType: 'medicine', ref: 'medicine', daysAgo: 100, time: '09:55', actor: 'pharmacist' },
    ],
  },
  /**
   * Expiring in seventy days from the supplier whose return window is ZERO.
   * Nobody will take it back, so it sorts above the amoxicillin that expires
   * sooner and can still be credited. Sorting the expiring list by date alone
   * gets this exactly backwards, which is the whole argument of
   * `20260831030000_expiry_and_returns.sql`.
   */
  clotrimazoleExpiring: {
    id: uid('a5', 14), medicine: 'clotrimazoleCream', batchNumber: 'CLO-2410P',
    expiryInDays: 70, mrp: 78, purchasePrice: 49, sellingPrice: 78,
    supplier: 'surgicals', receivedDaysAgo: 80,
    why: 'expiring soon from a supplier who accepts no returns at all',
    movements: [
      { type: 'opening_stock', delta: 24, refType: 'medicine', ref: 'medicine', daysAgo: 80, time: '10:30', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -2, refType: 'otc_sale', ref: 'sale:todayUpi', daysAgo: 0, time: '12:15', actor: 'relief' },
    ],
  },
  ciprofloxacinDrops: {
    id: uid('a5', 15), medicine: 'ciprofloxacinDrops', batchNumber: 'CIP-2501Q',
    expiryInDays: 310, mrp: 54, purchasePrice: 33.5, sellingPrice: 54,
    supplier: 'wholesale', receivedDaysAgo: 45, why: 'a drops presentation',
    movements: [
      { type: 'opening_stock', delta: 20, refType: 'medicine', ref: 'medicine', daysAgo: 45, time: '09:40', actor: 'pharmacist' },
    ],
  },
  gauze: {
    id: uid('a5', 16), medicine: 'gauze', batchNumber: 'GAU-2411R',
    expiryInDays: 500, mrp: 6, purchasePrice: 3.2, sellingPrice: 6,
    supplier: 'surgicals', receivedDaysAgo: 70,
    why: 'a consumable sold by the piece, and the only stock from the zero-window supplier that is nowhere near expiry',
    movements: [
      { type: 'opening_stock', delta: 400, refType: 'medicine', ref: 'medicine', daysAgo: 70, time: '10:15', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -40, refType: 'otc_sale', ref: 'sale:yesterdayCash', daysAgo: 1, time: '17:40', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -10, refType: 'otc_sale', ref: 'sale:todayCash', daysAgo: 0, time: '10:30', actor: 'pharmacist' },
    ],
  },
  ors: {
    id: uid('a5', 17), medicine: 'ors', batchNumber: 'ORS-2502S',
    expiryInDays: 350, mrp: 21, purchasePrice: 12.8, sellingPrice: 21,
    supplier: 'generics', receivedDaysAgo: 30, why: 'ordinary stock',
    movements: [
      { type: 'opening_stock', delta: 160, refType: 'medicine', ref: 'medicine', daysAgo: 30, time: '09:25', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -20, refType: 'otc_sale', ref: 'sale:yesterdayCash', daysAgo: 1, time: '17:40', actor: 'pharmacist' },
      { type: 'otc_sale', delta: -6, refType: 'otc_sale', ref: 'sale:todayCash', daysAgo: 0, time: '10:30', actor: 'pharmacist' },
    ],
  },
  /** Stock against a medicine nobody has classified. It still has to be counted. */
  cyanocobalamin: {
    id: uid('a5', 18), medicine: 'cyanocobalamin', batchNumber: 'CYA-2412T',
    expiryInDays: 260, mrp: 34, purchasePrice: 21, sellingPrice: 34,
    supplier: null, receivedDaysAgo: 55,
    why: 'a batch with no supplier recorded, so a return has nobody to go to',
    movements: [
      { type: 'opening_stock', delta: 120, refType: 'medicine', ref: 'medicine', daysAgo: 55, time: '10:40', actor: 'pharmacist' },
    ],
  },
  tramadol: {
    id: uid('a5', 19), medicine: 'tramadol', batchNumber: 'TRM-2501U',
    expiryInDays: 290, mrp: 41, purchasePrice: 25.5, sellingPrice: 41,
    supplier: 'wholesale', receivedDaysAgo: 65, why: 'the second H1 line',
    movements: [
      { type: 'opening_stock', delta: 50, refType: 'medicine', ref: 'medicine', daysAgo: 65, time: '09:05', actor: 'pharmacist' },
    ],
  },
  /** Live stock against a DEACTIVATED medicine. Worth money, cannot be sold. */
  nimesulide: {
    id: uid('a5', 20), medicine: 'nimesulide', batchNumber: 'NIM-2308V',
    expiryInDays: 30, mrp: 24, purchasePrice: 15, sellingPrice: 24,
    supplier: 'generics', receivedDaysAgo: 400,
    why: 'stock behind an inactive medicine, expiring within ninety days',
    movements: [
      { type: 'opening_stock', delta: 80, refType: 'medicine', ref: 'medicine', daysAgo: 400, time: '10:50', actor: 'pharmacist' },
    ],
  },
}

/** What a test needs to address a batch, without the movement machinery. */
export const FIXTURE_BATCHES = Object.fromEntries(
  Object.entries(BATCH_PLAN).map(([key, batch]) => [
    key,
    {
      id: batch.id,
      medicine: batch.medicine,
      medicineId: FIXTURE_MEDICINES[batch.medicine].id,
      batchNumber: batch.batchNumber,
      expiryInDays: batch.expiryInDays,
      mrp: batch.mrp,
      sellingPrice: batch.sellingPrice,
      quantity: batch.movements.reduce((sum, move) => sum + move.delta, 0),
      why: batch.why,
    },
  ]),
)

/**
 * What was written on each prescription.
 *
 * The quantities here are the same quantities the ledger moves, which is not
 * decoration: `dispense_rx` reads `items_json` and allocates against it, so a
 * fixture whose paper and whose shelf disagree would make a re-dispense test
 * pass for the wrong reason.
 */
const PRESCRIPTION_ITEMS = {
  dispensedToday: [
    { medicine: 'paracetamol', dosage: '1 tablet three times a day', instructions: 'After food', quantity: 10 },
    { medicine: 'azithromycin', dosage: '1 tablet once a day', instructions: 'Finish the course', quantity: 3 },
  ],
  waitingAtCounter: [
    { medicine: 'amoxicillin', dosage: '1 capsule three times a day', instructions: 'After food, five days', quantity: 15 },
    { medicine: 'pantoprazole', dosage: '1 tablet before breakfast', instructions: 'Empty stomach', quantity: 10 },
  ],
  dispensedLastWeek: [
    { medicine: 'paracetamol', dosage: '1 tablet when needed', instructions: 'Not more than four a day', quantity: 10 },
    { medicine: 'ibuprofen', dosage: '1 tablet twice a day', instructions: 'After food', quantity: 15 },
    { medicine: 'pantoprazole', dosage: '1 tablet before breakfast', instructions: 'Empty stomach', quantity: 10 },
    { medicine: 'amoxicillin', dosage: '1 capsule twice a day', instructions: 'Finish the course', quantity: 20 },
  ],
}

/** Counter sales, priced off the batch each line came out of. */
const SALE_LINES = {
  yesterdayCash: [
    { batch: 'paracetamolEarlier', quantity: 50 },
    { batch: 'ors', quantity: 20 },
    { batch: 'gauze', quantity: 40 },
    { batch: 'cetirizineLive', quantity: 40 },
  ],
  todayCash: [
    { batch: 'paracetamolEarlier', quantity: 20 },
    { batch: 'gauze', quantity: 10 },
    { batch: 'ors', quantity: 6 },
  ],
  todayUpi: [
    { batch: 'cetirizineLive', quantity: 12 },
    { batch: 'clotrimazoleExpiring', quantity: 2 },
  ],
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Rupees, to the paisa. `real` columns will round anyway; do it deliberately. */
const money = (value) => Math.round(value * 100) / 100

const rolesJson = (roles) => JSON.stringify(roles)

/**
 * Fill a freshly migrated staging database with a working clinic.
 *
 * @param {import('postgres').Sql} sql   an open porsager client. `search_path`
 *   is NOT assumed: every statement below names `jmc.` out loud, because on
 *   the clinic's real database eight of these table names also exist in
 *   `public` and belong to the application this one replaced. A qualified
 *   insert that goes to the wrong schema is an error; an unqualified one is a
 *   silent success in the wrong place.
 * @param {object} [options]
 * @param {boolean} [options.verify=true]  re-check the data before committing.
 * @param {string} [options.today]  pin the clinic's "today" to a YYYY-MM-DD
 *   date. Everything dated is relative to it, so a test that needs a fixed
 *   calendar can have one. Defaults to the real date in Chennai.
 * @returns {Promise<string>} a one-line summary, counted from the rows that
 *   are actually there rather than from the arrays above.
 */
export async function seedClinic(sql, options = {}) {
  const { verify = true, today = clinicToday() } = options
  const clock = calendar(today)

  // Hashed with the backend's own scrypt, on its own cost parameters, so these
  // PINs sign in through createSession exactly as a real one does. Six hashes
  // is about a second of deliberate CPU; that is the point of the algorithm.
  const secrets = {}
  for (const key of Object.keys(FIXTURE_STAFF)) {
    secrets[key] = await hashPassword(FIXTURE_PINS[key])
  }

  const staffId = (key) => FIXTURE_STAFF[key].id
  const patientId = (key) => FIXTURE_PATIENTS[key].id
  const medicineId = (key) => FIXTURE_MEDICINES[key].id
  const supplierId = (key) => (key ? FIXTURE_SUPPLIERS[key].id : null)

  /** Where a stock movement points. Resolved here so the plan can stay readable. */
  const referenceId = (batch, ref) => {
    if (ref === 'medicine') return medicineId(batch.medicine)
    if (ref === 'return') return FIXTURE_RETURN.id
    if (ref === 'stocktake') return FIXTURE_STOCK_TAKE.id
    const [kind, name] = ref.split(':')
    if (kind === 'rx') return FIXTURE_PRESCRIPTIONS[name].id
    if (kind === 'sale') return FIXTURE_SALES[name].id
    if (kind === 'order') return FIXTURE_ORDERS[name].id
    if (kind === 'writeoff') return FIXTURE_WRITEOFFS[name].id
    throw new Error(`fixtures: no reference resolver for "${ref}".`)
  }

  const saleTotals = Object.fromEntries(
    Object.entries(SALE_LINES).map(([key, lines]) => [
      key,
      money(lines.reduce((sum, line) => sum + line.quantity * BATCH_PLAN[line.batch].sellingPrice, 0)),
    ]),
  )

  await sql.begin(async (tx) => {
    // -- people ------------------------------------------------------------
    await tx`insert into jmc.staff ${tx(
      Object.entries(FIXTURE_STAFF).map(([key, staff]) => ({
        id: staff.id,
        name: staff.name,
        username: staff.username,
        phone: staff.phone,
        roles_json: rolesJson(staff.roles),
        pin_hash: secrets[key].hash,
        pin_salt: secrets[key].salt,
        pin_format: FIXTURE_PIN_FORMATS[key],
        // The synthetic owner-doctor is the one explicit clinic-template
        // publisher. Admin-only staff never receive clinical authority.
        can_publish_clinical_templates: key === 'doctor' ? 1 : 0,
        active: staff.active ? 1 : 0,
        last_login: staff.active ? clock.at(0, '08:30') : null,
        created_at: clock.at(-420, '09:00'),
      })),
    )}`

    await tx`insert into jmc.patients ${tx(
      Object.values(FIXTURE_PATIENTS).map((patient, index) => ({
        id: patient.id,
        name: patient.name,
        age: patient.age,
        sex: patient.sex,
        phone: patient.phone,
        address: patient.address,
        whatsapp_consent: patient.whatsappConsent ? 1 : 0,
        // Registered over the past year, oldest first, so the patient list has
        // an order that is not the order they were inserted in.
        created_at: clock.at(-360 + index * 25, '09:45'),
      })),
    )}`

    // -- the buying side ---------------------------------------------------
    await tx`insert into jmc.suppliers ${tx(
      Object.values(FIXTURE_SUPPLIERS).map((supplier) => ({
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        contact_person: supplier.contactPerson,
        whatsapp: supplier.whatsapp,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        gstin: supplier.gstin,
        return_window_days: supplier.returnWindowDays,
        active: supplier.active ? 1 : 0,
        created_at: clock.at(-400, '11:00'),
      })),
    )}`

    await tx`insert into jmc.medicines ${tx(
      Object.values(FIXTURE_MEDICINES).map((medicine) => ({
        id: medicine.id,
        code: medicine.code,
        name: medicine.name,
        generic_name: medicine.genericName ?? medicine.name,
        strength: medicine.strength,
        dosage_form: medicine.dosageForm,
        route: medicine.route ?? (
          medicine.dosageForm === 'cream' || medicine.dosageForm === 'dressing'
            ? 'Topical'
            : medicine.dosageForm === 'drops'
              ? 'Ophthalmic'
              : medicine.dosageForm === 'injection'
                ? 'Injection'
                : 'Oral'
        ),
        unit: medicine.unit,
        barcode: medicine.barcode,
        sale_class: medicine.saleClass,
        schedule: medicine.schedule,
        // A classification is a fact somebody checked. The two the clinic has
        // never reviewed stay unverified, which is what the anonymous counter
        // path refuses — see the register report.
        schedule_source: medicine.schedule === 'unset' ? '' : 'Printed on the pack',
        schedule_verified_by: medicine.schedule === 'unset' ? null : staffId('pharmacist'),
        schedule_verified_at: medicine.schedule === 'unset' ? null : clock.at(-200, '10:00'),
        reorder_level: medicine.reorderLevel,
        target_stock: medicine.targetStock,
        preferred_supplier_id: supplierId(medicine.supplier),
        // The unit `available_quantity` has always counted in, said out loud.
        base_unit: medicine.unit,
        brand_name: medicine.brandName ?? '',
        manufacturer: medicine.manufacturer ?? '',
        active: medicine.active ? 1 : 0,
        created_at: clock.at(-395, '11:30'),
      })),
    )}`

    // Who can supply what. Every medicine is linked to its preferred supplier,
    // and the two wholesalers overlap on the common tablets — a formulary
    // where each line has exactly one source cannot test a second quote.
    const links = new Set()
    for (const medicine of Object.values(FIXTURE_MEDICINES)) {
      if (medicine.supplier) links.add(`${medicine.supplier}|${medicine.id}`)
    }
    for (const key of ['paracetamol', 'cetirizine', 'ibuprofen', 'pantoprazole']) {
      links.add(`wholesale|${medicineId(key)}`)
      links.add(`generics|${medicineId(key)}`)
    }
    await tx`insert into jmc.supplier_medicines ${tx(
      [...links].map((link) => {
        const [supplier, medicine] = link.split('|')
        return { supplier_id: supplierId(supplier), medicine_id: medicine, active: 1 }
      }),
    )}`

    // -- what each product arrives in --------------------------------------
    //
    // Verified, because an unverified conversion cannot receive stock and
    // every batch below has already arrived. The verification is attributed to
    // the pharmacist and dated, like a real one.
    const packageVersionIds = new Map()
    const packageLadders = new Map()
    const versionRows = []
    const levelRows = []

    for (const [key, pack] of Object.entries(FIXTURE_PACKAGES)) {
      const medicine = medicineId(key)
      const versionId = uid('b1', versionRows.length + 1)
      const levels = expandLadder(pack)
      packageVersionIds.set(key, versionId)
      packageLadders.set(key, { baseUnit: pack.baseUnit, levels })

      // Drafted, then verified, in that order — which is not a formality. A
      // verified ladder is frozen, so its levels cannot be inserted after the
      // fact; the application's own two commands take the same two steps for
      // the same reason.
      versionRows.push({
        id: versionId,
        medicine_id: medicine,
        version: 1,
        base_unit: pack.baseUnit,
        status: 'draft',
        entered_by: staffId('pharmacist'),
        entered_at: clock.at(-394, '09:30'),
        verification_source: '',
        verification_note: '',
        note: '',
      })

      const levelIds = new Map()
      for (const level of levels) {
        const levelId = uid('b2', levelRows.length + 1)
        levelIds.set(level.levelName, levelId)
        levelRows.push({
          id: levelId,
          package_version_id: versionId,
          level_name: level.levelName,
          level_type: level.levelType,
          child_level_id: level.contains ? levelIds.get(level.contains) : null,
          child_count: level.containsCount,
          base_factor: level.baseFactor,
          depth: level.depth,
          receivable: level.receivable,
          sellable: level.sellable,
          breakable: level.breakable,
          minimum_sale_multiple: level.minimumSaleMultiple,
          mrp_basis: level.mrpBasis,
          barcode_hint: '',
        })
      }
    }

    await tx`insert into jmc.package_versions ${tx(versionRows)}`
    // Base first: the chain trigger checks each level against the one it
    // contains, so the child has to exist by the time the parent lands.
    await tx`insert into jmc.package_levels ${tx(levelRows)}`

    await tx`update jmc.package_versions
                set status = 'verified',
                    verified_by = ${staffId('pharmacist')},
                    verified_at = ${clock.at(-394, '09:45')},
                    verification_source = 'physical_pack',
                    verification_note = 'Checked against the pack on the shelf'
              where id in ${tx(versionRows.map((row) => row.id))}`

    await tx`insert into jmc.medicine_barcodes ${tx(
      FIXTURE_BARCODES.map((entry, index) => ({
        id: uid('b3', index + 1),
        medicine_id: medicineId(entry.medicine),
        level_name: entry.levelName,
        code: entry.code,
        symbology: entry.symbology,
        carries_batch: entry.carriesBatch ?? false,
        verified_by: staffId('pharmacist'),
        verified_at: clock.at(-393, '10:15'),
        created_by: staffId('pharmacist'),
        created_at: clock.at(-393, '10:15'),
      })),
    )}`

    await tx`insert into jmc.unmapped_barcodes ${tx([{
      code: FIXTURE_UNMAPPED_BARCODE.code,
      symbology: FIXTURE_UNMAPPED_BARCODE.symbology,
      seen_count: FIXTURE_UNMAPPED_BARCODE.seenCount,
      first_seen_at: clock.at(-9, '11:20'),
      last_seen_at: clock.at(-1, '17:40'),
      first_seen_by: staffId('pharmacist'),
    }])}`

    // -- the shelf ---------------------------------------------------------
    await tx`insert into jmc.batches ${tx(
      Object.values(BATCH_PLAN).map((batch) => ({
        id: batch.id,
        medicine_id: medicineId(batch.medicine),
        batch_number: batch.batchNumber,
        expiry: clock.day(batch.expiryInDays),
        // Never typed. The ledger below has to add up to this, and it is
        // computed from the ledger so that it always does.
        available_quantity: batch.movements.reduce((sum, move) => sum + move.delta, 0),
        mrp: money(batch.mrp),
        purchase_price: money(batch.purchasePrice),
        selling_price: money(batch.sellingPrice),
        received_from_supplier_id: supplierId(batch.supplier),
        received_at: clock.at(-batch.receivedDaysAgo, '09:00'),
        version: 1,
        // The conversion this lot arrived under, copied onto it. A later pack
        // size change creates a new version and cannot reach back into this.
        base_unit: FIXTURE_MEDICINES[batch.medicine].unit,
        package_version_id: packageVersionIds.get(batch.medicine) ?? null,
        package_snapshot: packageLadders.has(batch.medicine)
          ? JSON.stringify(packageLadders.get(batch.medicine))
          : null,
        // These fixture prices were always per base unit, so the basis is the
        // base level and the factor is 1. Saying so explicitly is the point:
        // a price with no basis is the ambiguity Slice 3 removed.
        mrp_basis_level: FIXTURE_MEDICINES[batch.medicine].unit,
        mrp_basis_factor: 1,
        purchase_basis_level: FIXTURE_MEDICINES[batch.medicine].unit,
        purchase_basis_factor: 1,
        status: 'active',
      })),
    )}`

    // -- today's work ------------------------------------------------------
    await tx`insert into jmc.appointments ${tx(
      Object.values(FIXTURE_APPOINTMENTS).map((appointment) => ({
        id: appointment.id,
        patient_id: patientId(appointment.patient),
        token: appointment.token,
        reason: appointment.reason,
        scheduled_at: clock.at(0, appointment.time),
        status: appointment.status,
        created_at: clock.at(0, appointment.time),
      })),
    )}`

    await tx`insert into jmc.vitals ${tx([
      { id: uid('b1', 1), patient: 'tamilScript', bp: '138/86', temperature: 38.4, pulse: 96, spo2: 97, weight: 58.5, by: 'nurse', daysAgo: 0, time: '08:55' },
      { id: uid('b1', 2), patient: 'longName', bp: '126/80', temperature: 36.9, pulse: 78, spo2: 99, weight: 74.2, by: 'nurse', daysAgo: 0, time: '09:30' },
      { id: uid('b1', 3), patient: 'hypertensive', bp: '152/94', temperature: 36.7, pulse: 84, spo2: 98, weight: 66.8, by: 'nurse', daysAgo: 0, time: '10:05' },
      { id: uid('b1', 4), patient: 'elderly', bp: '108/64', temperature: 36.5, pulse: 62, spo2: 96, weight: 61.1, by: 'relief', daysAgo: 0, time: '11:20' },
      { id: uid('b1', 5), patient: 'hypertensive', bp: '148/90', temperature: 36.8, pulse: 80, spo2: 98, weight: 67.3, by: 'nurse', daysAgo: 9, time: '10:10' },
    ].map((vital) => ({
      id: vital.id,
      patient_id: patientId(vital.patient),
      bp: vital.bp,
      temperature: vital.temperature,
      pulse: vital.pulse,
      spo2: vital.spo2,
      weight: vital.weight,
      recorded_by: staffId(vital.by),
      recorded_at: clock.at(-vital.daysAgo, vital.time),
    })))}`

    await tx`insert into jmc.encounters ${tx([
      { key: 'fever', complaint: 'Fever and body pain', duration: 3, unit: 'day', examination: 'Chest clear. Throat mildly congested.', diagnosis: 'Acute viral fever', notes: 'Three days of fever with body ache.', advice: 'Plenty of fluids and rest. Return if the fever crosses three more days.' },
      { key: 'acidity', complaint: 'Burning after meals', duration: 2, unit: 'week', examination: 'No alarm features. No weight loss.', diagnosis: 'Gastro-oesophageal reflux', notes: 'Symptoms are worse after late dinners.', advice: 'Avoid late dinners and lying down straight after eating.' },
      { key: 'lastWeek', complaint: 'Blood pressure review', duration: null, unit: null, examination: 'Home readings consistently above 145 systolic.', diagnosis: 'Essential hypertension, uncontrolled', notes: 'On amlodipine 5 mg.', advice: 'Reduce salt. Bring the home readings book to the next visit.' },
      { key: 'adviceOnly', complaint: 'Diabetes review', duration: null, unit: null, examination: 'Sugars steady on diet alone.', diagnosis: 'Type 2 diabetes, review', notes: 'No medicine started today.', advice: 'Continue diet and walking. Repeat fasting sugar in three months.' },
    ].map((encounter) => {
      const plan = FIXTURE_ENCOUNTERS[encounter.key]
      return {
        id: plan.id,
        patient_id: patientId(plan.patient),
        doctor_id: staffId('doctor'),
        appointment_id: plan.appointment ? FIXTURE_APPOINTMENTS[plan.appointment].id : null,
        complaint: encounter.complaint,
        complaint_duration_value: encounter.duration,
        complaint_duration_unit: encounter.unit,
        examination: encounter.examination,
        diagnosis: encounter.diagnosis,
        diagnosis_status: 'confirmed',
        notes: encounter.notes,
        advice: encounter.advice,
        created_at: clock.at(-plan.daysAgo, plan.time),
      }
    }))}`

    await tx`insert into jmc.prescriptions ${tx(
      Object.entries(FIXTURE_PRESCRIPTIONS).map(([key, prescription]) => {
        const encounter = FIXTURE_ENCOUNTERS[prescription.encounter]
        const items = PRESCRIPTION_ITEMS[key].map((item) => ({
          medicineId: medicineId(item.medicine),
          medicineName: `${FIXTURE_MEDICINES[item.medicine].name} ${FIXTURE_MEDICINES[item.medicine].strength}`.trim(),
          dosage: item.dosage,
          instructions: item.instructions,
          quantity: item.quantity,
        }))
        return {
          id: prescription.id,
          patient_id: patientId(prescription.patient),
          encounter_id: encounter.id,
          doctor_id: staffId('doctor'),
          items_json: JSON.stringify(items),
          signed_at: clock.at(-encounter.daysAgo, encounter.time),
          // Undispensed means NULL, not an empty string. `dispense_rx` tests
          // the column for truthiness and '' would read as "already done".
          dispensed_at: prescription.dispensed ? clock.at(-encounter.daysAgo, '10:55') : null,
        }
      }),
    )}`

    // Signed lines are immutable snapshots. The old JSON is retained only for
    // compatibility with dispensing until Slice 4 moves that flow over.
    let prescriptionLineNumber = 0
    await tx`insert into jmc.prescription_lines ${tx(
      Object.entries(FIXTURE_PRESCRIPTIONS).flatMap(([key, prescription]) =>
        PRESCRIPTION_ITEMS[key].map((item, index) => {
          prescriptionLineNumber += 1
          const medicine = FIXTURE_MEDICINES[item.medicine]
          const route = medicine.route ?? (
            medicine.dosageForm === 'cream' || medicine.dosageForm === 'dressing'
              ? 'Topical'
              : medicine.dosageForm === 'drops'
                ? 'Ophthalmic'
                : medicine.dosageForm === 'injection'
                  ? 'Injection'
                  : 'Oral'
          )
          return {
            id: uid('d1', prescriptionLineNumber),
            prescription_id: prescription.id,
            line_number: index + 1,
            medicine_id: medicine.id,
            medicine_name_snapshot: `${medicine.name} ${medicine.strength}`.trim(),
            generic_name_snapshot: medicine.genericName ?? medicine.name,
            strength_snapshot: medicine.strength,
            dosage_form_snapshot: medicine.dosageForm,
            route_snapshot: route,
            medicine_code_snapshot: medicine.code,
            dose_amount: '',
            dose_unit: '',
            frequency: '',
            timing: '',
            duration_value: null,
            duration_unit: null,
            dosage_text: item.dosage,
            instructions: item.instructions,
            prescribed_quantity: item.quantity,
            quantity_unit: medicine.unit,
          }
        }),
      ),
    )}`

    await tx`insert into jmc.patient_clinical_profiles ${tx([
      {
        patient_id: patientId('hypertensive'), allergy_status: 'known',
        allergy_notes: 'Staging fixture allergy — not a real patient',
        clinical_flags: 'Bring home BP record', updated_by: staffId('doctor'),
        updated_at: clock.at(-9, '10:25'),
      },
      {
        patient_id: patientId('child'), allergy_status: 'no_known',
        allergy_notes: '', clinical_flags: '', updated_by: staffId('doctor'),
        updated_at: clock.at(-30, '11:10'),
      },
    ])}`

    // The clinic-wide vocabulary is no longer seeded here. It arrives with
    // `20260911120000_slice2_clinical_vocabulary.sql` as the owner-approved
    // release, so staging exercises the real list rather than eleven phrases a
    // fixture file invented. What belongs here is the layer above it: one
    // doctor's own favourites and recents, which is what makes the ranking in
    // the consultation screen visible — favourites first, then most used.
    //
    // Two of these are approved wording the doctor has favourited; the third is
    // the doctor's own phrasing, which is not in the approved release and must
    // still be suggested back to them.
    await tx`insert into jmc.clinical_phrase_preferences ${tx([
      { kind: 'complaint', text: 'Fever', favourite: 1, uses: 34, days: -1 },
      { kind: 'advice', text: 'Drink adequate fluids', favourite: 1, uses: 28, days: -1 },
      { kind: 'diagnosis', text: 'Acute viral febrile illness', favourite: 0, uses: 19, days: -2 },
      { kind: 'instruction', text: 'After food', favourite: 0, uses: 41, days: -1 },
      { kind: 'examination', text: 'Chest clear, no added sounds', favourite: 1, uses: 12, days: -3 },
    ].map((row) => ({
      doctor_id: staffId('doctor'), kind: row.kind, display_text: row.text,
      normalized_text: row.text.trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' '),
      favourite: row.favourite, use_count: row.uses,
      last_used_at: clock.at(row.days, '11:40'),
    })))}`

    await tx`insert into jmc.bills ${tx([
      { key: 'paidCashToday', createdDaysAgo: 0, createdTime: '09:20', paidTime: '09:35' },
      { key: 'unpaidToday', createdDaysAgo: 0, createdTime: '10:05', paidTime: null },
      { key: 'paidUpiLastWeek', createdDaysAgo: 9, createdTime: '10:35', paidTime: '10:50' },
      { key: 'unpaidSince', createdDaysAgo: 2, createdTime: '11:15', paidTime: null },
    ].map((entry) => {
      const bill = FIXTURE_BILLS[entry.key]
      return {
        id: bill.id,
        patient_id: patientId(bill.patient),
        label: 'Consultation',
        amount: money(bill.amount),
        status: bill.status,
        payment_method: bill.method,
        created_at: clock.at(-entry.createdDaysAgo, entry.createdTime),
        paid_at: entry.paidTime ? clock.at(-entry.createdDaysAgo, entry.paidTime) : null,
      }
    }))}`

    await tx`insert into jmc.beds ${tx([
      { key: 'occupied', status: 'occupied', patient: 'elderly', admitted: '11:30', notes: 'Observation after IV fluids.' },
      { key: 'free', status: 'available', patient: null, admitted: null, notes: '' },
      { key: 'cleaning', status: 'cleaning', patient: null, admitted: null, notes: '' },
      { key: 'broken', status: 'out_of_service', patient: null, admitted: null, notes: 'Mattress replaced; awaiting delivery.' },
    ].map((bed) => ({
      id: FIXTURE_BEDS[bed.key].id,
      label: FIXTURE_BEDS[bed.key].label,
      status: bed.status,
      patient_id: bed.patient ? patientId(bed.patient) : null,
      admitted_at: bed.admitted ? clock.at(0, bed.admitted) : null,
      notes: bed.notes,
    })))}`

    // -- the counter -------------------------------------------------------
    //
    // `lines_json` copies the exact shape `otc_sale` writes, allocations and
    // all, because the snapshot counts it with json_array_length and the day
    // book reads the prices back out of it.
    await tx`insert into jmc.otc_sales ${tx([
      { key: 'yesterdayCash', daysAgo: 1, time: '17:40', by: 'pharmacist' },
      { key: 'todayCash', daysAgo: 0, time: '10:30', by: 'pharmacist' },
      { key: 'todayUpi', daysAgo: 0, time: '12:15', by: 'relief' },
    ].map((entry) => {
      const sale = FIXTURE_SALES[entry.key]
      const lines = SALE_LINES[entry.key].map((line) => {
        const batch = BATCH_PLAN[line.batch]
        const medicine = FIXTURE_MEDICINES[batch.medicine]
        return {
          medicineId: medicine.id,
          quantity: line.quantity,
          name: `${medicine.name} ${medicine.strength}`.trim(),
          allocations: [{
            batchId: batch.id,
            batchNumber: batch.batchNumber,
            quantity: line.quantity,
            unitPrice: money(batch.sellingPrice),
          }],
          lineTotal: money(line.quantity * batch.sellingPrice),
        }
      })
      return {
        id: sale.id,
        receipt_number: sale.receipt,
        total: saleTotals[entry.key],
        payment_method: sale.method,
        lines_json: JSON.stringify(lines),
        created_by: staffId(entry.by),
        created_at: clock.at(-entry.daysAgo, entry.time),
      }
    }))}`

    // -- ordering ----------------------------------------------------------
    await tx`insert into jmc.purchase_orders ${tx([
      {
        key: 'draft', requestedDaysAgo: 0, placedDaysAgo: null, messageStatus: null, externalId: null,
        draftLines: 'Ondansetron injection — 40\nDiazepam 5 mg — 20',
      },
      {
        key: 'awaitingDelivery', requestedDaysAgo: 3, placedDaysAgo: 3, messageStatus: 'sent',
        externalId: 'wamid.fixture-po-0002', draftLines: 'Cetirizine 10 mg — 300\nIbuprofen 400 mg — 400',
      },
      {
        key: 'delivered', requestedDaysAgo: 25, placedDaysAgo: 25, messageStatus: 'delivered',
        externalId: 'wamid.fixture-po-0003', draftLines: 'Paracetamol 500 mg — 1000',
      },
    ].map((entry) => {
      const order = FIXTURE_ORDERS[entry.key]
      const supplier = FIXTURE_SUPPLIERS[order.supplier]
      return {
        id: order.id,
        order_number: order.number,
        supplier_id: supplier.id,
        status: order.status,
        requested_date: clock.day(-entry.requestedDaysAgo),
        message_draft:
          `Hello ${supplier.name},\n\nPlease place this order for Jayamurugan Clinic (${order.number}):\n` +
          `${entry.draftLines}\n\nPlease confirm availability and expected delivery. Thank you.`,
        external_message_id: entry.externalId,
        message_status: entry.messageStatus,
        created_by: staffId('pharmacist'),
        created_at: clock.at(-entry.requestedDaysAgo, '12:30'),
        placed_at: entry.placedDaysAgo === null ? null : clock.at(-entry.placedDaysAgo, '12:45'),
      }
    }))}`

    await tx`insert into jmc.purchase_order_lines ${tx([
      { n: 1, order: 'draft', medicine: 'ondansetronInjection', ordered: 40, received: 0 },
      { n: 2, order: 'draft', medicine: 'diazepam', ordered: 20, received: 0 },
      { n: 3, order: 'awaitingDelivery', medicine: 'cetirizine', ordered: 300, received: 0 },
      { n: 4, order: 'awaitingDelivery', medicine: 'ibuprofen', ordered: 400, received: 0 },
      // Fully received, which is why PO-0003 is 'delivered' and why the newer
      // paracetamol batch exists at all.
      { n: 5, order: 'delivered', medicine: 'paracetamol', ordered: 1000, received: 1000 },
    ].map((line) => ({
      id: uid('b6', line.n),
      order_id: FIXTURE_ORDERS[line.order].id,
      medicine_id: medicineId(line.medicine),
      ordered_quantity: line.ordered,
      received_quantity: line.received,
    })))}`

    // -- stock that left for reasons other than a sale ---------------------
    await tx`insert into jmc.supplier_returns ${tx([{
      id: FIXTURE_RETURN.id,
      note_number: FIXTURE_RETURN.number,
      supplier_id: supplierId(FIXTURE_RETURN.supplier),
      batch_id: BATCH_PLAN.amoxicillinNearExpiry.id,
      medicine_id: medicineId('amoxicillin'),
      quantity: 100,
      // What was paid, which is what the supplier owes back — not what it
      // would have sold for.
      expected_credit: money(100 * BATCH_PLAN.amoxicillinNearExpiry.purchasePrice),
      status: FIXTURE_RETURN.status,
      settled_at: null,
      note: 'Inside the 180-day return window. Credit note not yet received.',
      actor_id: staffId('pharmacist'),
      created_at: clock.at(-12, '16:20'),
    }])}`

    await tx`insert into jmc.stock_writeoffs ${tx([
      { key: 'syrupDamage', batch: 'coughSyrup', medicine: 'coughSyrup', quantity: 6, daysAgo: 35, time: '18:40', by: 'pharmacist', note: 'Six bottles cracked in the delivery crate.' },
      { key: 'azithromycinLoss', batch: 'azithromycinExhausted', medicine: 'azithromycin', quantity: 30, daysAgo: 30, time: '18:05', by: 'manager', note: 'Whole batch soaked when the store room shelf gave way.' },
      { key: 'cetirizineExpiry', batch: 'cetirizineExpired', medicine: 'cetirizine', quantity: 40, daysAgo: 5, time: '19:10', by: 'pharmacist', note: 'Part written off at expiry; the rest is still on the shelf.' },
    ].map((entry) => ({
      id: FIXTURE_WRITEOFFS[entry.key].id,
      batch_id: BATCH_PLAN[entry.batch].id,
      medicine_id: medicineId(entry.medicine),
      quantity: entry.quantity,
      reason: FIXTURE_WRITEOFFS[entry.key].reason,
      cost_value: money(entry.quantity * BATCH_PLAN[entry.batch].purchasePrice),
      note: entry.note,
      actor_id: staffId(entry.by),
      created_at: clock.at(-entry.daysAgo, entry.time),
    })))}`

    // -- the last stock-take ----------------------------------------------
    //
    // Posted, not open: `stock_takes_one_open` allows exactly one in
    // 'counting' or 'submitted', and a fixture that occupies that slot means
    // no test can ever start one.
    await tx`insert into jmc.stock_takes ${tx([{
      id: FIXTURE_STOCK_TAKE.id,
      reference: FIXTURE_STOCK_TAKE.reference,
      scope: 'partial',
      scope_note: 'Tablets shelf, top two rows.',
      status: FIXTURE_STOCK_TAKE.status,
      recount_threshold: 500,
      started_at: clock.at(-6, '18:30'),
      started_by: staffId('pharmacist'),
      submitted_at: clock.at(-6, '19:10'),
      submitted_by: staffId('pharmacist'),
      posted_at: clock.at(-6, '19:30'),
      posted_by: staffId('doctor'),
      note: 'Counted after closing. One short line, inside the recount threshold.',
    }])}`

    await tx`insert into jmc.stock_take_lines ${tx([
      // Three missing at cost — well under the ₹500 recount threshold, so it
      // was allowed to post on a single count.
      { n: 1, batch: 'metformin', medicine: 'metformin', expected: 900, counted: 897 },
      // Counted and correct. A stock-take where every line moved is not a
      // stock-take, it is a correction run.
      { n: 2, batch: 'amlodipine', medicine: 'amlodipine', expected: 450, counted: 450 },
    ].map((line) => ({
      id: uid('c1', line.n),
      stock_take_id: FIXTURE_STOCK_TAKE.id,
      batch_id: BATCH_PLAN[line.batch].id,
      medicine_id: medicineId(line.medicine),
      expected_quantity: line.expected,
      counted_quantity: line.counted,
      variance: line.counted - line.expected,
      variance_value: money((line.counted - line.expected) * BATCH_PLAN[line.batch].purchasePrice),
      count_number: 1,
      counted_by: staffId('pharmacist'),
      counted_at: clock.at(-6, '18:50'),
    })))}`

    // -- the drawer --------------------------------------------------------
    //
    // Yesterday's close is a STORED statement about a moment: ₹1,500 float
    // plus the ₹2,540 cash sale, counted fifty short. Nothing recomputes it,
    // deliberately — that is the whole argument of the till migration.
    await tx`insert into jmc.till_sessions ${tx([
      {
        id: FIXTURE_TILLS.closedYesterday.id,
        opened_at: clock.at(-1, '08:45'),
        opened_by: staffId('pharmacist'),
        opening_float: 1500,
        closed_at: clock.at(-1, '20:15'),
        closed_by: staffId('manager'),
        counted_cash: money(1500 + saleTotals.yesterdayCash - 50),
        expected_cash: money(1500 + saleTotals.yesterdayCash),
        variance: -50,
        note: 'Fifty rupees short. Nobody could account for it.',
      },
      {
        id: FIXTURE_TILLS.openToday.id,
        opened_at: clock.at(0, '08:40'),
        opened_by: staffId('pharmacist'),
        opening_float: 1500,
        closed_at: null,
        closed_by: null,
        counted_cash: null,
        expected_cash: null,
        variance: null,
        note: '',
      },
    ])}`

    await tx`insert into jmc.cash_movements ${tx([
      { n: 1, direction: 'in', amount: 500, reason: 'Float top-up from the safe', time: '11:20', by: 'pharmacist' },
      { n: 2, direction: 'out', amount: 200, reason: 'Auto fare for the supplier pickup', time: '15:05', by: 'manager' },
    ].map((entry) => ({
      id: uid('c3', entry.n),
      till_id: FIXTURE_TILLS.openToday.id,
      direction: entry.direction,
      amount: money(entry.amount),
      reason: entry.reason,
      actor_id: staffId(entry.by),
      created_at: clock.at(0, entry.time),
    })))}`

    // -- the ledger --------------------------------------------------------
    //
    // Last, because every row here points at something above it. `movement_type`
    // and `reference_type` carry the same string for a dispense, a sale, a
    // write-off and a return, which is what `removeFromBatch` and
    // `allocateStock` actually write — a fixture that tidies that up would
    // hide the day somebody changes one and not the other.
    const movements = []
    let movementNumber = 0
    for (const batch of Object.values(BATCH_PLAN)) {
      for (const move of batch.movements) {
        movementNumber += 1
        movements.push({
          id: uid('b3', movementNumber),
          medicine_id: medicineId(batch.medicine),
          batch_id: batch.id,
          movement_type: move.type,
          quantity_delta: move.delta,
          reference_type: move.refType,
          reference_id: referenceId(batch, move.ref),
          actor_id: staffId(move.actor),
          created_at: clock.at(-move.daysAgo, move.time),
        })
      }
    }
    await tx`insert into jmc.stock_movements ${tx(movements)}`

    // -- what the clinic prints on paper -----------------------------------
    //
    // The row already exists — the migration creates it empty — so this fills
    // it in. Without a drug licence number the settings read `complete: false`
    // and every bill prints a warning instead of a receipt, which is a true
    // state but not a useful one to test the printing against.
    await tx`
      update jmc.clinic_settings set
        name = 'Jayamurugan Clinic',
        address = 'No. 7, Kamban Salai, Thiruvarangam Nagar, Chennai 600 087',
        phone = '+999700000001',
        email = 'clinic@jayamurugan.invalid',
        drug_licence_number = 'TN-CH-20B-FIXTURE-0001',
        doctor_registration_number = 'TNMC-FIXTURE-58421',
        gstin = '33ZZZZZ0000Z1Z0',
        consultation_fee = 200,
        footer_note = 'Medicines are exchanged only against this bill and within seven days. Clinic hours 9 am to 1 pm and 5 pm to 8 pm.',
        updated_at = ${clock.at(-30, '20:00')},
        updated_by = ${staffId('doctor')}
      where id = 1`

    // The tablets poll `snapshot?since=<revision>` and a revision of 0 against
    // a stored 0 answers "unchanged" forever — so a browser test would open a
    // fully seeded clinic and see an empty one. Moving it once is enough.
    await tx`
      update jmc.clinic_revision
         set revision = 1, changed_at = ${clock.at(0, '12:15')}
       where id = 1`

    await tx`insert into jmc.whatsapp_messages ${tx([
      {
        id: uid('c5', 1), direction: 'outbound', audience: 'supplier',
        phone: FIXTURE_SUPPLIERS.generics.whatsapp,
        body: `Hello ${FIXTURE_SUPPLIERS.generics.name},\n\nPlease place this order for Jayamurugan Clinic (${FIXTURE_ORDERS.awaitingDelivery.number}).`,
        external_message_id: 'wamid.fixture-po-0002', status: 'sent',
        related_type: 'purchase_order', related_id: FIXTURE_ORDERS.awaitingDelivery.id,
        created_at: clock.at(-3, '12:45'),
      },
      {
        id: uid('c5', 2), direction: 'outbound', audience: 'patient',
        phone: FIXTURE_PATIENTS.tamilScript.phone,
        body: 'Your prescription is ready at the pharmacy counter.',
        external_message_id: null, status: 'queued',
        related_type: 'patient', related_id: FIXTURE_PATIENTS.tamilScript.id,
        created_at: clock.at(0, '09:45'),
      },
    ])}`

    // -- who did what ------------------------------------------------------
    await tx`insert into jmc.audit_events ${tx([
      { n: 1, by: 'pharmacist', action: 'till.opened', type: 'till', id: FIXTURE_TILLS.openToday.id, summary: 'Opened the till with ₹1500.00 float', daysAgo: 0, time: '08:40' },
      { n: 2, by: 'nurse', action: 'appointment.created', type: 'appointment', id: FIXTURE_APPOINTMENTS.seenFirst.id, summary: 'Created appointment JMC-0001', daysAgo: 0, time: '08:50' },
      { n: 3, by: 'nurse', action: 'vitals.recorded', type: 'vitals', id: uid('b1', 1), summary: 'Recorded patient vitals', daysAgo: 0, time: '08:55' },
      { n: 4, by: 'doctor', action: 'encounter.completed', type: 'encounter', id: FIXTURE_ENCOUNTERS.fever.id, summary: `Consultation saved for ${FIXTURE_PATIENTS.tamilScript.id}`, daysAgo: 0, time: '09:05' },
      { n: 5, by: 'pharmacist', action: 'prescription.dispensed', type: 'prescription', id: FIXTURE_PRESCRIPTIONS.dispensedToday.id, summary: 'Dispensed 2 item(s)', daysAgo: 0, time: '09:40' },
      { n: 6, by: 'manager', action: 'bill.paid', type: 'bill', id: FIXTURE_BILLS.paidCashToday.id, summary: 'Payment collected by cash', daysAgo: 0, time: '09:35' },
      { n: 7, by: 'pharmacist', action: 'otc.sale', type: 'otc_sale', id: FIXTURE_SALES.todayCash.id, summary: `OTC-0002 collected ₹${saleTotals.todayCash.toFixed(2)}`, daysAgo: 0, time: '10:30' },
      { n: 8, by: 'relief', action: 'otc.sale', type: 'otc_sale', id: FIXTURE_SALES.todayUpi.id, summary: `OTC-0003 collected ₹${saleTotals.todayUpi.toFixed(2)}`, daysAgo: 0, time: '12:15' },
      { n: 9, by: 'pharmacist', action: 'stock.written_off', type: 'batch', id: BATCH_PLAN.cetirizineExpired.id, summary: 'Wrote off 40 from batch CTZ-2401F (expiry) at ₹440.00', daysAgo: 5, time: '19:10' },
      { n: 10, by: 'doctor', action: 'stocktake.posted', type: 'stock_take', id: FIXTURE_STOCK_TAKE.id, summary: 'Approved ST-0001 — 1 of 2 batches corrected', daysAgo: 6, time: '19:30' },
      { n: 11, by: 'pharmacist', action: 'stock.returned', type: 'batch', id: BATCH_PLAN.amoxicillinNearExpiry.id, summary: 'Returned 100 from batch AMX-2411C — credit ₹4100.00 expected', daysAgo: 12, time: '16:20' },
      { n: 12, by: 'pharmacist', action: 'order.sent', type: 'purchase_order', id: FIXTURE_ORDERS.awaitingDelivery.id, summary: 'Supplier order sent on WhatsApp', daysAgo: 3, time: '12:45' },
      { n: 13, by: 'manager', action: 'till.closed', type: 'till', id: FIXTURE_TILLS.closedYesterday.id, summary: 'Counted ₹3990.00 against ₹4040.00 expected — short by ₹50.00', daysAgo: 1, time: '20:15' },
    ].map((event) => ({
      id: uid('c4', event.n),
      actor_id: staffId(event.by),
      action: event.action,
      entity_type: event.type,
      entity_id: event.id,
      summary: event.summary,
      created_at: clock.at(-event.daysAgo, event.time),
    })))}`

    // -- wind the series past what was just inserted -----------------------
    //
    // Every document number above was written by hand, and the sequences that
    // mint the next one know nothing about them. Left alone, the first real
    // check-in of the test run issues JMC-0001 to somebody already holding it,
    // and the first counter sale dies on the unique index behind OTC-0001.
    // `setval(seq, n, false)` means "n is the next number out", so each is set
    // one past the highest already in its table — the same arithmetic
    // 20260909125224_document_numbers.sql performs on the live database, and
    // for the same reason.
    //
    // A sequence is not transactional, so these five survive a rollback of
    // everything above them. That is harmless here — `up.mjs` drops and
    // rebuilds the schema on every run — and it is worth knowing before
    // anybody reaches for this file against a database they want to keep.
    await tx.unsafe(`
      select setval('jmc.appointment_token_seq', ${Object.keys(FIXTURE_APPOINTMENTS).length + 1}, false),
             setval('jmc.otc_receipt_seq',       ${Object.keys(FIXTURE_SALES).length + 1}, false),
             setval('jmc.purchase_order_seq',    ${Object.keys(FIXTURE_ORDERS).length + 1}, false),
             setval('jmc.supplier_return_seq',   2, false),
             setval('jmc.stock_take_seq',        2, false),
             setval('jmc.prescription_number_seq', ${Object.keys(FIXTURE_PRESCRIPTIONS).length + 1}, false)`)

    if (verify) await assertConsistent(tx)
  })

  return summarise(await counts(sql))
}

// ---------------------------------------------------------------------------
// Checking our own work
// ---------------------------------------------------------------------------

/**
 * Everything that could be wrong here and would not raise an error on its own.
 *
 * Foreign keys, check constraints and unique indexes are Postgres's problem
 * and it has already refused anything that breaks them by the time this runs.
 * What is left is the damage the schema cannot see: a batch whose cached
 * quantity disagrees with its own ledger, a medicine id buried in a JSON
 * column that points at nothing, a sequence still standing behind a number
 * that is already printed. Each of those makes some later test pass for the
 * wrong reason, which is worse than a fixture that simply fails.
 *
 * It throws. A seed that reports a clinic it did not build is the one outcome
 * with no honest use.
 */
async function assertConsistent(tx) {
  const wrong = []

  // 1. The ledger is the truth and the batch figure is a cache over it.
  //    `INVENTORY.md` §1. A fixture where these disagree makes every
  //    reconciliation test meaningless.
  const drift = await tx`
    select b.batch_number,
           b.available_quantity::int as cached,
           coalesce(sum(m.quantity_delta), 0)::int as ledger,
           count(m.id)::int as movements
      from jmc.batches b
      left join jmc.stock_movements m on m.batch_id = b.id
     group by b.id, b.batch_number, b.available_quantity
     having coalesce(sum(m.quantity_delta), 0) <> b.available_quantity
         or count(m.id) = 0
     order by b.batch_number`
  for (const row of drift) {
    wrong.push(
      row.movements === 0
        ? `batch ${row.batch_number} has no stock movements at all`
        : `batch ${row.batch_number} holds ${row.cached} but its ledger sums to ${row.ledger}`,
    )
  }

  // 2. The references Postgres does NOT enforce, because they live inside
  //    text columns holding JSON.
  const orphanItems = await tx`
    select p.id, item->>'medicineId' as medicine_id
      from jmc.prescriptions p, json_array_elements(p.items_json::json) item
     where not exists (select 1 from jmc.medicines m where m.id = item->>'medicineId')`
  for (const row of orphanItems) {
    wrong.push(`prescription ${row.id} prescribes unknown medicine ${row.medicine_id}`)
  }

  const orphanLines = await tx`
    select s.receipt_number,
           line->>'medicineId' as medicine_id,
           alloc->>'batchId' as batch_id
      from jmc.otc_sales s,
           json_array_elements(s.lines_json::json) line,
           json_array_elements(line->'allocations') alloc
     where not exists (select 1 from jmc.medicines m where m.id = line->>'medicineId')
        or not exists (select 1 from jmc.batches b where b.id = alloc->>'batchId')`
  for (const row of orphanLines) {
    wrong.push(`sale ${row.receipt_number} names medicine ${row.medicine_id} / batch ${row.batch_id}, which do not exist`)
  }

  // 3. Money. Most of these carry a check constraint, which is exactly why
  //    they are cheap to re-assert; `variance` is deliberately absent because
  //    a till that is short is supposed to be negative.
  const negative = await tx`
    select 'bills.amount' as column_name, count(*)::int as bad from jmc.bills where amount < 0
    union all select 'batches.mrp', count(*)::int from jmc.batches where mrp < 0
    union all select 'batches.purchase_price', count(*)::int from jmc.batches where purchase_price < 0
    union all select 'batches.selling_price', count(*)::int from jmc.batches where selling_price < 0
    union all select 'batches.available_quantity', count(*)::int from jmc.batches where available_quantity < 0
    union all select 'otc_sales.total', count(*)::int from jmc.otc_sales where total < 0
    union all select 'supplier_returns.expected_credit', count(*)::int from jmc.supplier_returns where expected_credit < 0
    union all select 'stock_writeoffs.cost_value', count(*)::int from jmc.stock_writeoffs where cost_value < 0
    union all select 'till_sessions.opening_float', count(*)::int from jmc.till_sessions where opening_float < 0
    union all select 'till_sessions.counted_cash', count(*)::int from jmc.till_sessions where counted_cash < 0
    union all select 'till_sessions.expected_cash', count(*)::int from jmc.till_sessions where expected_cash < 0
    union all select 'cash_movements.amount', count(*)::int from jmc.cash_movements where amount <= 0
    union all select 'clinic_settings.consultation_fee', count(*)::int from jmc.clinic_settings where consultation_fee < 0`
  for (const row of negative) {
    if (row.bad > 0) wrong.push(`${row.bad} row(s) of ${row.column_name} are negative`)
  }

  // 4. Every series must be standing past the last number already printed.
  const series = [
    ['appointment_token_seq', 'appointments', 'token'],
    ['otc_receipt_seq', 'otc_sales', 'receipt_number'],
    ['purchase_order_seq', 'purchase_orders', 'order_number'],
    ['supplier_return_seq', 'supplier_returns', 'note_number'],
    ['stock_take_seq', 'stock_takes', 'reference'],
    ['prescription_number_seq', 'prescriptions', 'prescription_number'],
  ]
  for (const [sequence, table, column] of series) {
    const [row] = await tx.unsafe(`
      select (case when s.is_called then s.last_value + 1 else s.last_value end)::bigint as next_value,
             coalesce((select max(substring(${column} from '[0-9]+$')::bigint) from jmc.${table}), 0) as highest
        from jmc.${sequence} s`)
    if (BigInt(row.next_value) <= BigInt(row.highest)) {
      wrong.push(
        `${sequence} would next issue ${row.next_value}, but jmc.${table}.${column} already holds ${row.highest}`,
      )
    }
  }

  // 5. The counts the summary is about to claim.
  const present = await counts(tx)
  const expected = {
    staff: Object.keys(FIXTURE_STAFF).length,
    patients: Object.keys(FIXTURE_PATIENTS).length,
    suppliers: Object.keys(FIXTURE_SUPPLIERS).length,
    medicines: Object.keys(FIXTURE_MEDICINES).length,
    packages: Object.keys(FIXTURE_PACKAGES).length,
    batches: Object.keys(BATCH_PLAN).length,
    movements: Object.values(BATCH_PLAN).reduce((sum, b) => sum + b.movements.length, 0),
    appointments: Object.keys(FIXTURE_APPOINTMENTS).length,
    prescriptions: Object.keys(FIXTURE_PRESCRIPTIONS).length,
    bills: Object.keys(FIXTURE_BILLS).length,
  }
  for (const [name, count] of Object.entries(expected)) {
    if (present[name] !== count) {
      wrong.push(`expected ${count} ${name} but the database holds ${present[name]}`)
    }
  }

  if (wrong.length > 0) {
    throw new Error(`fixtures are inconsistent and were rolled back:\n  - ${wrong.join('\n  - ')}`)
  }
}

/** Counted from the database, never from the arrays above. */
async function counts(client) {
  const [row] = await client`
    select (select count(*) from jmc.staff)::int as staff,
           (select count(*) from jmc.patients)::int as patients,
           (select count(*) from jmc.suppliers)::int as suppliers,
           (select count(*) from jmc.medicines)::int as medicines,
           (select count(*) from jmc.package_versions)::int as packages,
           (select count(*) from jmc.batches)::int as batches,
           (select count(*) from jmc.stock_movements)::int as movements,
           (select count(*) from jmc.appointments)::int as appointments,
           (select count(*) from jmc.prescriptions)::int as prescriptions,
           (select count(*) from jmc.bills)::int as bills`
  return row
}

function summarise(row) {
  return (
    `${row.staff} staff, ${row.patients} patients, ${row.suppliers} suppliers, ` +
    `${row.medicines} medicines, ${row.packages} packages, ${row.batches} batches, ` +
    `${row.movements} stock movements, ` +
    `${row.appointments} appointments today, ${row.prescriptions} prescriptions, ${row.bills} bills`
  )
}
