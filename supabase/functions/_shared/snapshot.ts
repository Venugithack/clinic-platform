import type {
  AppointmentView,
  PatientRecordView,
  StockTakeHistoryView,
  StockTakeLineView,
  StockTakeView,
  TillCloseView,
  TillView,
  StockWriteoffView,
  SupplierReturnView,
  AuditView,
  BatchView,
  BedView,
  BillView,
  ClinicSettingsView,
  ClinicSnapshot,
  EncounterView,
  MedicineView,
  OtcSaleView,
  PatientView,
  PrescriptionItemView,
  PrescriptionView,
  PurchaseOrderView,
  Role,
  SessionView,
  StaffView,
  SupplierView,
  VitalView,
} from './types.ts'
import { db } from './db.ts'
import { doctorLoggedIn, hasRole } from './auth.ts'
import { whatsappStatus } from './whatsapp.ts'

type Row = Record<string, unknown>

/**
 * Midnight in the clinic, as the ISO string the text timestamp columns hold.
 *
 * Not `current_date`: the server thinks in UTC and the clinic thinks in IST,
 * and between midnight and 05:30 the two disagree about which day it is. A
 * queue that empties itself at midnight because the database changed its mind
 * about the date is the kind of bug nobody reports and everybody works around.
 */
const CLINIC_DAY_START = `to_char(
  (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
    at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

/**
 * Today's date as the clinic would write it on a box.
 *
 * The same disagreement as above, in the form that decides whether a strip of
 * tablets is on the shelf or in the bin. `current_date` is the server's date,
 * and for the five and a half hours after midnight in Chennai the server is
 * still on yesterday — so a batch that expired last night keeps counting
 * towards `total_available` right through the early morning, and the first
 * person to open the pharmacy is told there is stock to dispense that there is
 * a legal duty not to dispense. Expiry is a calendar fact about the clinic's
 * calendar, not the server's.
 */
const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

const all = async (sql: string, ...params: unknown[]) =>
  (await db.prepare(sql).all(...params)) as Row[]
const text = (value: unknown) => String(value ?? '')
const optional = (value: unknown) => (value == null ? undefined : String(value))
const num = (value: unknown) => Number(value ?? 0)
const flag = (value: unknown) => Boolean(Number(value ?? 0))

/**
 * The one row, or sensible blanks if the migration has run but nobody has
 * filled it in yet.
 */
async function readSettings(): Promise<ClinicSettingsView> {
  const row = (await db
    .prepare(
      `select name,address,phone,email,drug_licence_number,doctor_registration_number,
              gstin,consultation_fee,footer_note,updated_at
         from clinic_settings where id = 1`,
    )
    .get()) as Row | undefined

  const drugLicenceNumber = text(row?.drug_licence_number)
  const doctorRegistrationNumber = text(row?.doctor_registration_number)

  return {
    name: text(row?.name) || 'Jayamurugan Clinic',
    address: text(row?.address),
    phone: text(row?.phone),
    email: text(row?.email),
    drugLicenceNumber,
    doctorRegistrationNumber,
    gstin: text(row?.gstin),
    consultationFee: num(row?.consultation_fee),
    footerNote: text(row?.footer_note),
    updatedAt: text(row?.updated_at),
    // A bill without the drug licence and a prescription without the
    // prescriber's registration are not documents. This is what the screens
    // warn on.
    complete: Boolean(drugLicenceNumber && doctorRegistrationNumber),
  }
}

/**
 * The drawer as it stands, or null if nobody has opened it.
 *
 * Card and UPI are deliberately absent from the expected figure. They never
 * reach the drawer, and including them is how a till appears to be hundreds
 * short every single day until staff stop reading the number.
 */
async function readTill(): Promise<TillView | null> {
  const till = (await db
    .prepare(
      'select id, opened_at, opening_float, opened_by from till_sessions where closed_at is null',
    )
    .get()) as Row | undefined

  if (!till) return null

  const since = text(till.opened_at)

  const [bills] = await all(
    `select coalesce(sum(amount), 0) as total from bills
      where status = 'paid' and payment_method = 'cash' and paid_at >= ?`,
    since,
  )
  const [sales] = await all(
    `select coalesce(sum(total), 0) as total from otc_sales
      where payment_method = 'cash' and created_at >= ?`,
    since,
  )
  const [moved] = await all(
    `select
       coalesce(sum(case when direction = 'in'  then amount else 0 end), 0) as cash_in,
       coalesce(sum(case when direction = 'out' then amount else 0 end), 0) as cash_out
     from cash_movements where till_id = ?`,
    text(till.id),
  )
  const [openedBy] = await all('select name from staff where id = ?', text(till.opened_by))

  const movements = await all(
    `select m.*, s.name actor_name from cash_movements m
       join staff s on s.id = m.actor_id
      where m.till_id = ? order by m.created_at desc`,
    text(till.id),
  )

  const openingFloat = num(till.opening_float)
  const cashFromBills = num(bills?.total)
  const cashFromSales = num(sales?.total)
  const cashIn = num(moved?.cash_in)
  const cashOut = num(moved?.cash_out)

  return {
    id: text(till.id),
    openedAt: since,
    openedBy: text(openedBy?.name),
    openingFloat,
    cashFromBills,
    cashFromSales,
    cashIn,
    cashOut,
    expectedCash: openingFloat + cashFromBills + cashFromSales + cashIn - cashOut,
    movements: movements.map((m) => ({
      id: text(m.id),
      direction: text(m.direction) as 'in' | 'out',
      amount: num(m.amount),
      reason: text(m.reason),
      at: text(m.created_at),
      actorName: text(m.actor_name),
    })),
  }
}

/**
 * The stock-take in progress, or null.
 *
 * THE BLIND RULE IS ENFORCED HERE, not in the panel. While the status is
 * 'counting' the expected quantity and the variance are never put on the wire,
 * so there is nothing for the screen to leak and nothing for a curious counter
 * to read out of the network tab. They appear the moment the sheet is
 * submitted, which is also the moment the counts stop being editable.
 */
async function readStockTake(): Promise<StockTakeView | null> {
  const take = (await db
    .prepare(
      `select t.*, s.name as started_by_name, u.name as submitted_by_name
         from stock_takes t
         join staff s on s.id = t.started_by
         left join staff u on u.id = t.submitted_by
        where t.status in ('counting','submitted')`,
    )
    .get()) as Row | undefined

  if (!take) return null

  const status = text(take.status) as 'counting' | 'submitted'
  const varianceVisible = status === 'submitted'
  const threshold = num(take.recount_threshold)

  const rows = await all(
    `select l.*, m.name as medicine_name, b.batch_number, c.name as counted_by_name
       from stock_take_lines l
       join medicines m on m.id = l.medicine_id
       join batches b on b.id = l.batch_id
       join staff c on c.id = l.counted_by
      where l.stock_take_id = ?
      order by abs(l.variance_value) desc, m.name`,
    text(take.id),
  )

  const lines: StockTakeLineView[] = rows.map((r) => {
    const line: StockTakeLineView = {
      id: text(r.id),
      batchId: text(r.batch_id),
      medicineName: text(r.medicine_name),
      batchNumber: text(r.batch_number),
      countedQuantity: num(r.counted_quantity),
      countNumber: num(r.count_number),
      countedBy: text(r.counted_by_name),
      countedAt: text(r.counted_at),
    }

    if (varianceVisible) {
      line.expectedQuantity = num(r.expected_quantity)
      line.variance = num(r.variance)
      line.varianceValue = num(r.variance_value)
      line.needsRecount = Math.abs(num(r.variance_value)) > threshold && num(r.count_number) < 2
    }

    return line
  })

  return {
    id: text(take.id),
    reference: text(take.reference),
    scope: text(take.scope) as 'full' | 'partial',
    scopeNote: text(take.scope_note),
    status,
    recountThreshold: threshold,
    startedAt: text(take.started_at),
    startedBy: text(take.started_by_name),
    submittedAt: take.submitted_at ? text(take.submitted_at) : undefined,
    submittedBy: take.submitted_by_name ? text(take.submitted_by_name) : undefined,
    lines,
    varianceVisible,
  }
}

export async function readSnapshot(
  session: SessionView,
  knownDoctorPresence?: boolean,
): Promise<ClinicSnapshot> {
  // ── WHAT THIS TABLET IS ALLOWED TO BE SENT ──────────────────────────────────
  //
  // The stations a person can actually open are listed in `NAV` in
  // components/ClinicApp.tsx, one list per role, and that list — not a feeling
  // about who ought to be trusted with what — is what decides the gates below.
  // They are named after the screens rather than after the people, because the
  // rule they encode is "no screen this session can open reads this list", and
  // the next person to add a station will get the answer right only if the gate
  // says which station it belongs to. A role holding two jobs passes the gate
  // for either, the same way the rail merges two roles' stations into one list.
  //
  // The failure mode being closed is not a leak through the interface. It is a
  // leak through the wire. Every fifteen seconds, on a counter tablet that four
  // people share and the waiting room can see, a pharmacy assistant was being
  // sent the whole patient register — names, ages, phone numbers, home
  // addresses — every colleague's mobile number and last sign-in, and the last
  // hundred consultations with their diagnoses and the doctor's notes. Not one
  // of those has a screen on that tablet. Nothing was ever displayed, so nobody
  // ever noticed, and the only way to see it was to open the network tab.
  const staffAdmin = hasRole(session, 'admin') // Staff, Activity
  const careRegister = hasRole(session, 'admin', 'doctor', 'nurse') // Patients, Queue, Vitals, Consult, Beds
  const clinicalRecord = hasRole(session, 'doctor') // Records
  const pharmacyCounter = hasRole(session, 'pharmacy') // Counter
  const shelf = hasRole(session, 'admin', 'doctor', 'pharmacy') // Inventory, Expiring, Stock-take
  const supplyNetwork = hasRole(session, 'admin', 'pharmacy') // Suppliers, Orders, Expiring
  const cashDrawer = hasRole(session, 'admin', 'nurse', 'pharmacy') // Day book, Counter

  // Only the Staff station reads this list, and only an admin has one. The
  // mobile number and the last sign-in are the two columns that made this worth
  // gating: a roster of names and roles is already served unauthenticated to
  // the lock screen, because you cannot ask someone to say who they are and
  // also require them to have said it first — but nobody's phone number is on
  // that screen, and a record of who was last at the tablet and when is exactly
  // the sort of thing a colleague should have to be an admin to read.
  const staff: StaffView[] = staffAdmin
    ? (await all(`select id,name,username,phone,roles_json,active,last_login from staff order by name`)).map((r) => ({
        id: text(r.id), name: text(r.name), username: text(r.username), phone: text(r.phone),
        roles: JSON.parse(text(r.roles_json)) as Role[], active: flag(r.active), lastLogin: optional(r.last_login),
      }))
    : []

  // The patient register, which was `select *` and is now two queries.
  //
  // `address` is gone for everybody, not just for the pharmacy: no panel in the
  // application has ever rendered a patient's home address. The one document
  // that is legally required to carry it — the Schedule H1 register — reads it
  // straight out of the database in supabase/functions/register/index.ts and
  // never touches the snapshot, so nothing is lost by not putting every
  // patient's home on every tablet. If a screen ever does need it, add the
  // column back here rather than wondering why it arrives empty.
  //
  // The pharmacy counter is the harder half. It has no Patients station and no
  // panel that names a patient — prescriptions carry the name they were signed
  // with — but Overview prints "N patients on the register" at every station,
  // so the rows themselves still have to travel. What travels for a counter
  // tablet is a list of bare ids: enough to count, nothing to read. The blanks
  // the mapper fills in below are not defaults, they are the absence of the
  // column, and the only code that would notice is code that must not exist.
  const patients: PatientView[] = (await all(
    careRegister
      ? `select id,name,age,sex,phone,whatsapp_consent,created_at from patients order by created_at desc`
      : `select id from patients order by created_at desc`,
  )).map((r) => ({
    id: text(r.id), name: text(r.name), age: num(r.age), sex: text(r.sex) as PatientView['sex'],
    phone: text(r.phone), address: '', whatsappConsent: flag(r.whatsapp_consent), createdAt: text(r.created_at),
  }))

  // Anything still waiting or in consult, whatever day it was booked — a
  // patient sitting in the corridor must never drop off the queue because the
  // date rolled over — plus everything else from today, so the day reads back.
  const appointments: AppointmentView[] = (await all(`select a.*,p.name patient_name from appointments a
    join patients p on p.id=a.patient_id
    where a.status in ('waiting','in_consult') or a.scheduled_at >= ${CLINIC_DAY_START}
    order by a.scheduled_at`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), token: text(r.token),
      reason: text(r.reason), scheduledAt: text(r.scheduled_at), status: text(r.status) as AppointmentView['status'],
    }))

  // Enough for the queue to show each waiting patient their latest reading.
  // A patient's full run of readings comes with their record.
  const vitals: VitalView[] = careRegister
    ? (await all(`select v.*,s.name recorded_by_name from vitals v
        join staff s on s.id=v.recorded_by order by v.recorded_at desc limit 200`)).map((r) => ({
        id: text(r.id), patientId: text(r.patient_id), bp: text(r.bp), temperature: num(r.temperature), pulse: num(r.pulse),
        spo2: num(r.spo2), weight: num(r.weight), recordedBy: text(r.recorded_by_name), recordedAt: text(r.recorded_at),
      }))
    : []

  // The Records station is the only screen that reads these, and only a doctor
  // has one — an admin does not, which is deliberate and is why this is gated
  // on the station and not on seniority. A hundred diagnoses and a hundred sets
  // of clinical notes are the most sensitive rows in the building, and they had
  // been going to every tablet in it.
  const encounters: EncounterView[] = clinicalRecord
    ? (await all(`select e.*,p.name patient_name,s.name doctor_name from encounters e
        join patients p on p.id=e.patient_id join staff s on s.id=e.doctor_id
        order by e.created_at desc limit 100`)).map((r) => ({
        id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), doctorName: text(r.doctor_name),
        diagnosis: text(r.diagnosis), notes: text(r.notes), advice: text(r.advice), createdAt: text(r.created_at),
      }))
    : []

  // Every prescription still waiting to be dispensed, however old, plus a
  // recent tail. The pharmacy queue is the one list that must be complete:
  // a prescription that scrolls off it is a patient who never got their
  // medicine. It is also the only list the Counter draws, and the Counter is
  // the only station that draws it.
  const prescriptions: PrescriptionView[] = pharmacyCounter
    ? (await all(`select rx.*,p.name patient_name,s.name doctor_name from prescriptions rx
        join patients p on p.id=rx.patient_id join staff s on s.id=rx.doctor_id
        where rx.dispensed_at is null or rx.signed_at >= ${CLINIC_DAY_START}
        order by rx.signed_at desc`)).map((r) => ({
        id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), doctorName: text(r.doctor_name),
        items: JSON.parse(text(r.items_json)) as PrescriptionItemView[], signedAt: text(r.signed_at), dispensedAt: optional(r.dispensed_at),
      }))
    : []

  // Same rule, same reason: an unpaid bill is money owed to the clinic and
  // must never age out of the list. Paid ones are today's, for the day book.
  const bills: BillView[] = (await all(`select b.*,p.name patient_name from bills b join patients p on p.id=b.patient_id
    where b.status = 'unpaid' or b.created_at >= ${CLINIC_DAY_START}
    order by b.created_at desc`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), label: text(r.label), amount: num(r.amount),
      status: text(r.status) as BillView['status'], paymentMethod: optional(r.payment_method) as BillView['paymentMethod'],
      createdAt: text(r.created_at), paidAt: optional(r.paid_at),
    }))

  const beds: BedView[] = (await all(`select b.*,p.name patient_name from beds b left join patients p on p.id=b.patient_id
    order by b.label`)).map((r) => ({
      id: text(r.id), label: text(r.label), status: text(r.status) as BedView['status'], patientId: optional(r.patient_id),
      patientName: optional(r.patient_name), admittedAt: optional(r.admitted_at), notes: optional(r.notes),
    }))

  const medicines: MedicineView[] = (await all(`select m.*,s.name preferred_supplier_name,
      coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=${CLINIC_TODAY}),0) total_available
    from medicines m left join suppliers s on s.id=m.preferred_supplier_id order by m.name`)).map((r) => ({
      id: text(r.id), code: text(r.code), name: text(r.name), strength: text(r.strength), dosageForm: text(r.dosage_form),
      unit: text(r.unit), barcode: text(r.barcode), saleClass: text(r.sale_class) as MedicineView['saleClass'],
      schedule: text(r.schedule) as MedicineView['schedule'],
      reorderLevel: num(r.reorder_level), targetStock: num(r.target_stock), preferredSupplierId: optional(r.preferred_supplier_id),
      preferredSupplierName: optional(r.preferred_supplier_name), totalAvailable: num(r.total_available), active: flag(r.active),
    }))

  // Every batch in the building, which is a per-strip list and the longest
  // thing here. Only the three shelf stations spend it: Inventory, Expiring and
  // Stock-take. A nurse has none of them and was carrying all of it.
  const batches: BatchView[] = shelf
    ? (await all(`select b.*,m.name medicine_name,s.name received_from_supplier_name from batches b
        join medicines m on m.id=b.medicine_id left join suppliers s on s.id=b.received_from_supplier_id
        order by m.name,b.expiry`)).map((r) => ({
        id: text(r.id), medicineId: text(r.medicine_id), medicineName: text(r.medicine_name), batchNumber: text(r.batch_number),
        expiry: text(r.expiry), availableQuantity: num(r.available_quantity), mrp: num(r.mrp), purchasePrice: num(r.purchase_price),
        sellingPrice: num(r.selling_price), receivedFromSupplierId: optional(r.received_from_supplier_id),
        receivedFromSupplierName: optional(r.received_from_supplier_name), receivedAt: text(r.received_at),
      }))
    : []

  // Suppliers and the orders placed with them are the buying side of the
  // clinic, and the two stations that show them — Suppliers and Orders, plus
  // the credit note that Expiring raises — belong to the admin and the pharmacy
  // alone. The link table and the order lines are only fetched to be folded
  // into those two lists, so they are behind the same gate rather than being
  // read and then thrown away.
  const supplierLinks = supplyNetwork
    ? await all(`select supplier_id, medicine_id from supplier_medicines where active=1`)
    : []
  const medicineIdsBySupplier = new Map<string, string[]>()
  for (const link of supplierLinks) {
    const key = text(link.supplier_id)
    const list = medicineIdsBySupplier.get(key)
    if (list) list.push(text(link.medicine_id))
    else medicineIdsBySupplier.set(key, [text(link.medicine_id)])
  }

  const suppliers: SupplierView[] = supplyNetwork
    ? (await all(`select * from suppliers order by name`)).map((r) => ({
        id: text(r.id), code: text(r.code), name: text(r.name), contactPerson: text(r.contact_person), whatsapp: text(r.whatsapp),
        phone: text(r.phone), email: text(r.email), address: text(r.address), gstin: text(r.gstin), active: flag(r.active),
        returnWindowDays: num(r.return_window_days),
        medicineIds: medicineIdsBySupplier.get(text(r.id)) ?? [],
      }))
    : []

  const allOrderLines = supplyNetwork
    ? await all(
        `select pol.*, m.name medicine_name from purchase_order_lines pol
           join medicines m on m.id=pol.medicine_id order by m.name`,
      )
    : []
  const linesByOrder = new Map<string, PurchaseOrderView['lines']>()
  for (const line of allOrderLines) {
    const key = text(line.order_id)
    const view = {
      id: text(line.id), medicineId: text(line.medicine_id), medicineName: text(line.medicine_name),
      orderedQuantity: num(line.ordered_quantity), receivedQuantity: num(line.received_quantity),
    }
    const list = linesByOrder.get(key)
    if (list) list.push(view)
    else linesByOrder.set(key, [view])
  }

  const orders: PurchaseOrderView[] = supplyNetwork
    ? (await all(`select po.*,s.name supplier_name from purchase_orders po
        join suppliers s on s.id=po.supplier_id order by po.created_at desc`)).map((r) => ({
        id: text(r.id), orderNumber: text(r.order_number), supplierId: text(r.supplier_id), supplierName: text(r.supplier_name),
        status: text(r.status) as PurchaseOrderView['status'], requestedDate: text(r.requested_date), messageDraft: text(r.message_draft),
        messageStatus: optional(r.message_status) as PurchaseOrderView['messageStatus'], createdAt: text(r.created_at), placedAt: optional(r.placed_at),
        lines: linesByOrder.get(text(r.id)) ?? [],
      }))
    : []

  // Counter receipts. The Counter raises them and the Day book reconciles them,
  // and a doctor stands at neither.
  const otcSales: OtcSaleView[] = cashDrawer
    ? (await all(`select id,receipt_number,total,payment_method,created_at,
        json_array_length(lines_json::json) line_count from otc_sales order by created_at desc limit 100`)).map((r) => ({
          id: text(r.id), receiptNumber: text(r.receipt_number), total: num(r.total),
          paymentMethod: text(r.payment_method) as OtcSaleView['paymentMethod'], createdAt: text(r.created_at), lineCount: num(r.line_count),
        }))
    : []

  const audits: AuditView[] = staffAdmin
    ? (await all(`select a.*,s.name actor_name from audit_events a join staff s on s.id=a.actor_id
        order by a.created_at desc limit 100`)).map((r) => ({
          id: text(r.id), actorName: text(r.actor_name), action: text(r.action), entityType: text(r.entity_type),
          summary: text(r.summary), createdAt: text(r.created_at),
        }))
    : []

  return {
    session,
    staff,
    patients,
    appointments,
    vitals,
    encounters,
    prescriptions,
    bills,
    beds,
    medicines,
    batches,
    suppliers,
    orders,
    otcSales,
    audits,
    // The drawer and its closes belong to the Day book, which the doctor has no
    // station for. A null till is already the shape the screen handles for
    // "nobody has opened it", so nothing downstream has to learn a new one.
    till: cashDrawer ? await readTill() : null,
    tillHistory: cashDrawer
      ? (await all(`select t.*, s.name closed_by_name from till_sessions t
        left join staff s on s.id = t.closed_by
        where t.closed_at is not null order by t.closed_at desc limit 30`)).map((r) => ({
          id: text(r.id), openedAt: text(r.opened_at), closedAt: text(r.closed_at),
          closedBy: text(r.closed_by_name), openingFloat: num(r.opening_float),
          countedCash: num(r.counted_cash), expectedCash: num(r.expected_cash),
          variance: num(r.variance), note: text(r.note),
        })) as TillCloseView[]
      : [],
    stockTake: shelf ? await readStockTake() : null,
    stockTakeHistory: shelf
      ? (await all(`select t.*, s.name as finished_by_name,
          (select count(*) from stock_take_lines l where l.stock_take_id = t.id) as counted,
          (select count(*) from stock_take_lines l where l.stock_take_id = t.id and l.variance <> 0) as corrected,
          (select coalesce(sum(l.variance_value), 0) from stock_take_lines l where l.stock_take_id = t.id) as net_value
         from stock_takes t
         left join staff s on s.id = coalesce(t.posted_by, t.submitted_by, t.started_by)
        where t.status in ('posted','abandoned')
        order by coalesce(t.posted_at, t.started_at) desc limit 20`)).map((r) => ({
          id: text(r.id), reference: text(r.reference), scope: text(r.scope) as 'full' | 'partial',
          status: text(r.status) as 'posted' | 'abandoned', startedAt: text(r.started_at),
          finishedAt: text(r.posted_at ?? r.started_at), finishedBy: text(r.finished_by_name),
          batchesCounted: num(r.counted),
          // An abandoned count corrected nothing and was worth nothing, whatever
          // its lines happen to say. Reporting the discarded figures invites
          // someone to read a loss into a stock-take that never posted.
          batchesCorrected: text(r.status) === 'abandoned' ? 0 : num(r.corrected),
          netValue: text(r.status) === 'abandoned' ? 0 : num(r.net_value),
        })) as StockTakeHistoryView[]
      : [],
    // Both of these are drawn by Expiring and nowhere else, so they follow the
    // buying side rather than the shelf: what was thrown away and what went
    // back to the supplier for credit.
    writeoffs: supplyNetwork
      ? (await all(`select w.*, m.name medicine_name, b.batch_number, s.name actor_name
        from stock_writeoffs w
        join medicines m on m.id = w.medicine_id
        join batches b on b.id = w.batch_id
        join staff s on s.id = w.actor_id
        order by w.created_at desc limit 100`)).map((r) => ({
          id: text(r.id), date: text(r.created_at).slice(0, 10), medicineName: text(r.medicine_name),
          batchNumber: text(r.batch_number), quantity: num(r.quantity),
          reason: text(r.reason) as StockWriteoffView['reason'],
          costValue: num(r.cost_value), note: text(r.note), actorName: text(r.actor_name),
        }))
      : [],
    supplierReturns: supplyNetwork
      ? (await all(`select r.*, sup.name supplier_name, m.name medicine_name, b.batch_number
        from supplier_returns r
        join suppliers sup on sup.id = r.supplier_id
        join medicines m on m.id = r.medicine_id
        join batches b on b.id = r.batch_id
        order by r.created_at desc limit 100`)).map((r) => ({
          id: text(r.id), noteNumber: text(r.note_number), date: text(r.created_at).slice(0, 10),
          supplierName: text(r.supplier_name), medicineName: text(r.medicine_name),
          batchNumber: text(r.batch_number), quantity: num(r.quantity),
          expectedCredit: num(r.expected_credit),
          status: text(r.status) as SupplierReturnView['status'],
        }))
      : [],
    settings: await readSettings(),
    doctorPresent: knownDoctorPresence ?? await doctorLoggedIn(),
    whatsapp: whatsappStatus(),
  }
}

/**
 * One patient's whole history, read only when somebody opens that patient.
 *
 * These four lists grow at several rows per visit and never shrink, which is
 * why they are no longer in the snapshot. Fetched here they are bounded by one
 * person's lifetime of care rather than by the whole clinic's.
 */
export async function readPatientRecord(patientId: string): Promise<PatientRecordView> {
  const [encounters, prescriptions, vitals, bills] = await Promise.all([
    all(
      `select e.*,p.name patient_name,s.name doctor_name from encounters e
         join patients p on p.id=e.patient_id join staff s on s.id=e.doctor_id
        where e.patient_id=? order by e.created_at desc`,
      patientId,
    ),
    all(
      `select rx.*,p.name patient_name,s.name doctor_name from prescriptions rx
         join patients p on p.id=rx.patient_id join staff s on s.id=rx.doctor_id
        where rx.patient_id=? order by rx.signed_at desc`,
      patientId,
    ),
    all(
      `select v.*,s.name recorded_by_name from vitals v join staff s on s.id=v.recorded_by
        where v.patient_id=? order by v.recorded_at desc`,
      patientId,
    ),
    all(
      `select b.*,p.name patient_name from bills b join patients p on p.id=b.patient_id
        where b.patient_id=? order by b.created_at desc`,
      patientId,
    ),
  ])

  return {
    patientId,
    encounters: encounters.map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name),
      doctorName: text(r.doctor_name), diagnosis: text(r.diagnosis), notes: text(r.notes),
      advice: text(r.advice), createdAt: text(r.created_at),
    })),
    prescriptions: prescriptions.map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name),
      doctorName: text(r.doctor_name), items: JSON.parse(text(r.items_json)),
      signedAt: text(r.signed_at), dispensedAt: optional(r.dispensed_at),
    })),
    vitals: vitals.map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), bp: text(r.bp), temperature: num(r.temperature),
      pulse: num(r.pulse), spo2: num(r.spo2), weight: num(r.weight),
      recordedBy: text(r.recorded_by_name), recordedAt: text(r.recorded_at),
    })),
    bills: bills.map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name),
      label: text(r.label), amount: num(r.amount), status: text(r.status) as 'unpaid' | 'paid',
      paymentMethod: optional(r.payment_method) as 'cash' | 'upi' | 'card' | undefined,
      createdAt: text(r.created_at), paidAt: optional(r.paid_at),
    })),
  }
}
