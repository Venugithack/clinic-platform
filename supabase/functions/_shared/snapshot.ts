import type {
  AppointmentView,
  PatientBalanceView,
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
  ClinicSettingsView,
  ClinicSnapshot,
  ClinicalPhraseKind,
  ConsultationDraftView,
  ConsultationTemplateView,
  EncounterView,
  FollowUpView,
  InvoiceLineView,
  InvoiceView,
  MedicineBarcodeView,
  MedicineView,
  OpeningCountView,
  OtcSaleLineView,
  OtcSaleView,
  PackageLevelView,
  PackageVersionView,
  PatientView,
  PaymentView,
  PrescriptionItemView,
  PrescriptionView,
  PurchaseOrderView,
  Role,
  SessionView,
  StaffView,
  SupplierView,
  UnmappedBarcodeView,
  VitalView,
} from './types.ts'
import { db } from './db.ts'
import { decompose, describeEntry, describeLadder, ladderFromRows } from './packages.ts'
import { doctorLoggedIn, hasRole, legacyPinCount } from './auth.ts'
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
 * A number that might not have been measured.
 *
 * `num` reads null as 0, which is right for a count and catastrophic for a
 * reading: a SpO2 nobody took would arrive at the tablet as 0 and read as a
 * patient who is not breathing. Absence has to survive the trip.
 */
const maybeNum = (value: unknown) => (value == null ? undefined : Number(value))
/** As above, for a reading that is text — blood pressure is "120/80". */
const maybeText = (value: unknown) => {
  if (value == null) return undefined
  const asText = String(value)
  return asText === '' ? undefined : asText
}

const jsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function prescriptionItems(value: unknown, legacy: unknown): PrescriptionItemView[] {
  const normalized = jsonArray(value)
  return (normalized.length > 0 ? normalized : jsonArray(legacy)) as PrescriptionItemView[]
}

// Reads the effective view, not the bare table: a line the Slice 2.1 migration
// marked unreadable must reach the tablet saying so, and a line a doctor has
// since resolved must reach it resolved.
const LINE_JSON = `jsonb_build_object(
  'medicineId', l.effective_medicine_id,
  'medicineName', l.medicine_name_snapshot,
  'genericName', l.generic_name_snapshot,
  'strength', l.strength_snapshot,
  'dosageForm', l.dosage_form_snapshot,
  'route', l.route_snapshot,
  'medicineCode', l.medicine_code_snapshot,
  'doseAmount', l.dose_amount,
  'doseUnit', l.dose_unit,
  'frequency', l.frequency,
  'timing', l.timing,
  'durationValue', l.duration_value,
  'durationUnit', l.duration_unit,
  'dosage', l.dosage_text,
  'instructions', l.instructions,
  'quantity', l.effective_quantity,
  'quantityUnit', l.quantity_unit,
  'medicineState', l.medicine_state,
  'quantityState', l.quantity_state,
  'cancelled', l.cancelled,
  'needsReview', l.needs_review,
  -- Slice 4. The counter needs prescribed, supplied, remaining and available on
  -- the same row, because "give now" is arithmetic over all four and a
  -- pharmacist should not have to do it in their head.
  'prescriptionLineId', l.id,
  'supplied', sup.supplied,
  'remaining', sup.remaining,
  'supplyState', sup.supply_state,
  'outcomeReason', sup.outcome_reason,
  'available', coalesce((
    select sum(a.available_quantity) from jmc.batch_availability a
     where a.medicine_id = l.effective_medicine_id and a.pickable
  ), 0)
)`

const DRAFT_LINE_JSON = `jsonb_build_object(
  'medicineId', l.medicine_id,
  'medicineName', trim(concat(m.name, ' ', m.strength)),
  'genericName', m.generic_name,
  'strength', m.strength,
  'dosageForm', m.dosage_form,
  'route', coalesce(nullif(l.route, ''), m.route),
  'medicineCode', m.code,
  'doseAmount', l.dose_amount,
  'doseUnit', l.dose_unit,
  'frequency', l.frequency,
  'timing', l.timing,
  'durationValue', l.duration_value,
  'durationUnit', l.duration_unit,
  'dosage', l.dosage_text,
  'instructions', l.instructions,
  'quantity', l.prescribed_quantity,
  'quantityUnit', m.unit
)`

function encounterView(r: Row): EncounterView {
  return {
    id: text(r.id),
    patientId: text(r.patient_id),
    patientName: text(r.patient_name),
    doctorName: text(r.doctor_name),
    diagnosis: text(r.diagnosis),
    complaint: text(r.complaint),
    complaintDurationValue: maybeNum(r.complaint_duration_value),
    complaintDurationUnit: optional(r.complaint_duration_unit) as EncounterView['complaintDurationUnit'],
    examination: text(r.examination),
    diagnosisStatus: text(r.diagnosis_status) as EncounterView['diagnosisStatus'],
    aetiology: text(r.aetiology),
    aetiologyCertainty: text(r.aetiology_certainty) as EncounterView['aetiologyCertainty'],
    notes: text(r.notes),
    advice: text(r.advice),
    followUpDate: optional(r.follow_up_date),
    createdAt: text(r.created_at),
  }
}

function prescriptionView(r: Row): PrescriptionView {
  return {
    id: text(r.id),
    patientId: text(r.patient_id),
    patientName: text(r.patient_name),
    doctorName: text(r.doctor_name),
    prescriptionNumber: text(r.prescription_number),
    items: prescriptionItems(r.normalized_items, r.items_json),
    signedAt: text(r.signed_at),
    dispensedAt: optional(r.dispensed_at),
    printCount: num(r.print_count),
    validUntil: optional(r.valid_until),
    supplyInParts: r.supply_in_parts !== false,
    expired: flag(r.expired),
  }
}

/**
 * Counter sales, with their lines.
 *
 * Two things here were wrong until Slice 4 finished moving OTC out of a JSON
 * blob. `lineCount` read `json_array_length(lines_json)`, which the new sale
 * writes as `'[]'` and never updates — so every sale showed zero lines. And
 * `payment_method` was a column on the sale, which can say only one thing:
 * after split payment existed, a sale paid half in cash and half by UPI said
 * "cash", and a sale not yet paid said whatever was last there.
 *
 * Both now come from the rows that actually record them — `otc_lines` and the
 * payments allocated to the sale's invoice. `split` is a real answer and so is
 * nothing at all.
 */
async function readOtcSales(): Promise<OtcSaleView[]> {
  const sales = await all(
    `select s.id, s.receipt_number, s.total, s.created_at, s.status,
            s.patient_id, s.invoice_id,
            st.name as created_by_name, p.name as patient_name,
            (select count(*)::int from otc_lines l where l.otc_sale_id = s.id) as line_count,
            (select string_agg(distinct y.method, ',')
               from payment_allocations a
               join payments y on y.id = a.payment_id
              where a.invoice_id = s.invoice_id and y.status = 'received' and y.kind = 'payment'
            ) as methods
       from otc_sales s
       join staff st on st.id = s.created_by
       left join patients p on p.id = s.patient_id
      order by s.created_at desc limit 100`,
  )
  if (sales.length === 0) return []

  const lines = await all(
    `select l.*, m.name as medicine_name,
            coalesce((select sum(r.quantity) from otc_returns r where r.otc_line_id = l.id), 0) as returned
       from otc_lines l join medicines m on m.id = l.medicine_id
      where l.otc_sale_id = any(?::text[])
      order by l.otc_sale_id, l.line_number`,
    sales.map((row) => text(row.id)),
  )

  const linesBy = new Map<string, OtcSaleLineView[]>()
  for (const row of lines) {
    const list = linesBy.get(text(row.otc_sale_id)) ?? []
    list.push({
      id: text(row.id),
      medicineId: text(row.medicine_id),
      medicineName: text(row.medicine_name),
      packageLevelName: text(row.package_level_name),
      quantity: num(row.quantity),
      unitAmount: num(row.unit_amount),
      amount: num(row.amount),
      returned: num(row.returned),
    })
    linesBy.set(text(row.otc_sale_id), list)
  }

  return sales.map((row) => {
    const methods = text(row.methods).split(',').filter(Boolean)
    return {
      id: text(row.id),
      receiptNumber: text(row.receipt_number),
      total: num(row.total),
      paymentMethod: (methods.length > 1 ? 'split' : methods[0] ?? '') as OtcSaleView['paymentMethod'],
      createdAt: text(row.created_at),
      createdByName: text(row.created_by_name),
      patientId: optional(row.patient_id),
      patientName: optional(row.patient_name),
      invoiceId: optional(row.invoice_id),
      status: text(row.status) as OtcSaleView['status'],
      lineCount: num(row.line_count),
      lines: linesBy.get(text(row.id)) ?? [],
    }
  })
}

/**
 * The bills, their lines and the money taken against them.
 *
 * Three reads rather than one query with two joins, because an invoice with
 * four lines and three payments would otherwise come back as twelve rows and
 * be de-duplicated in JavaScript — which is where a payment gets counted twice
 * and a bill looks settled that is not.
 */
async function readInvoices(where: string, params: unknown[] = []): Promise<InvoiceView[]> {
  const headers = await all(
    `select b.*, p.name as patient_name, i.void_reason
       from invoice_balances b
       join invoices i on i.id = b.id
       left join patients p on p.id = b.patient_id
      where ${where}
      order by b.created_at desc`,
    ...params,
  )
  if (headers.length === 0) return []

  const ids = headers.map((row) => text(row.id))
  const lines = await all(
    `select * from invoice_lines where invoice_id = any(?::text[]) order by invoice_id, line_number`,
    ids,
  )
  const payments = await all(
    `select a.invoice_id, a.amount as allocated, y.*, s.name as received_by_name
       from payment_allocations a
       join payments y on y.id = a.payment_id
       join staff s on s.id = y.received_by
      where a.invoice_id = any(?::text[])
      order by y.received_at`,
    ids,
  )

  const linesBy = new Map<string, InvoiceLineView[]>()
  for (const row of lines) {
    const list = linesBy.get(text(row.invoice_id)) ?? []
    list.push({
      id: text(row.id),
      lineNumber: num(row.line_number),
      source: text(row.source) as InvoiceLineView['source'],
      description: text(row.description),
      quantity: num(row.quantity),
      unitAmount: num(row.unit_amount),
      amount: num(row.amount),
      medicineId: optional(row.medicine_id),
      dispenseLineId: optional(row.dispense_line_id),
      otcLineId: optional(row.otc_line_id),
    })
    linesBy.set(text(row.invoice_id), list)
  }

  const paymentsBy = new Map<string, PaymentView[]>()
  for (const row of payments) {
    const list = paymentsBy.get(text(row.invoice_id)) ?? []
    list.push({
      id: text(row.id),
      receiptNumber: text(row.receipt_number),
      kind: text(row.kind) as PaymentView['kind'],
      method: text(row.method) as PaymentView['method'],
      reference: text(row.reference),
      // What was allocated to THIS bill, which is not always the whole payment.
      amount: num(row.allocated),
      status: text(row.status) as PaymentView['status'],
      receivedAt: text(row.received_at),
      receivedByName: text(row.received_by_name),
      reversalReason: optional(row.reversal_reason),
    })
    paymentsBy.set(text(row.invoice_id), list)
  }

  return headers.map((row) => ({
    id: text(row.id),
    invoiceNumber: text(row.invoice_number),
    patientId: optional(row.patient_id),
    patientName: optional(row.patient_name),
    encounterId: optional(row.encounter_id),
    status: text(row.status) as InvoiceView['status'],
    voidReason: optional(row.void_reason),
    createdAt: text(row.created_at),
    total: num(row.total),
    paid: num(row.paid),
    due: num(row.due),
    paymentState: text(row.payment_state) as InvoiceView['paymentState'],
    lines: linesBy.get(text(row.id)) ?? [],
    payments: paymentsBy.get(text(row.id)) ?? [],
  }))
}

function followUpView(r: Row): FollowUpView {
  return {
    id: text(r.id),
    patientId: text(r.patient_id),
    patientName: text(r.patient_name),
    encounterId: text(r.encounter_id),
    doctorId: text(r.doctor_id),
    doctorName: text(r.doctor_name),
    dueDate: text(r.due_date),
    note: text(r.note),
    status: text(r.status) as FollowUpView['status'],
    createdAt: text(r.created_at),
  }
}

/** A PackageLevelView back into the shape `packages.ts` computes with. */
function toLadderLevel(level: PackageLevelView) {
  return {
    levelName: level.levelName,
    levelType: level.levelType,
    contains: level.contains ?? null,
    containsCount: level.containsCount ?? null,
    depth: level.depth,
    baseFactor: level.baseFactor,
    receivable: level.receivable,
    sellable: level.sellable,
    breakable: level.breakable,
    minimumSaleMultiple: level.minimumSaleMultiple,
    mrpBasis: level.mrpBasis,
    barcodeHint: level.barcodeHint,
  }
}

/**
 * "1 box, 3 strips and 4 tablets" for one batch, from that batch's own frozen
 * snapshot.
 *
 * Never from the product's current package: a batch received when a strip held
 * fifteen must keep reading in fifteens after the manufacturer moves to ten,
 * or the figure on the screen is one the pharmacist cannot find on the shelf.
 * A batch that predates Slice 3 has no snapshot and gets no breakdown, which
 * is the honest answer rather than a decomposition using somebody else's pack.
 */
function batchBreakdown(row: Row): string {
  const raw = row.package_snapshot
  if (!raw) return ''
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      baseUnit: string
      levels: PackageLevelView[]
    }
    if (!parsed?.levels?.length) return ''
    const ladder = ladderFromRows(parsed.baseUnit, parsed.levels.map(toLadderLevel))
    return describeEntry(decompose(ladder, num(row.available_quantity)))
  } catch {
    return ''
  }
}

/**
 * The open opening count, with its entries.
 *
 * `expected_base_quantity` is NULL until the count is submitted, so while a
 * pharmacist is counting this carries no expected figure to leak. That is not
 * a filter applied here — there is nothing to filter.
 */
async function readOpeningCount(): Promise<OpeningCountView | null> {
  const count = (await db.prepare(
    `select c.id, c.reference, c.status, c.note, c.started_at, s.name as started_by_name
       from opening_counts c join staff s on s.id = c.started_by
      where c.status in ('counting','submitted','recount')
      order by c.started_at desc limit 1`,
  ).get()) as Row | undefined
  if (!count) return null

  /*
   * While counting, no entry carries an expected figure — not even one from an
   * earlier attempt that was already reviewed.
   *
   * A first-round entry keeps its expected quantity and variance for the
   * record, and a count sent back for recount returns to `counting`-like
   * status with those rows still present. Sending them and trusting the screen
   * not to draw them would make the blind count a property of a React
   * component: one refactor, one debug panel, one CSV export away from the
   * counter seeing what the software expects before they count it.
   *
   * So it is enforced here. The numbers stay in the table, where the audit
   * needs them, and simply do not leave the database until the count is
   * submitted.
   *
   * An already-reviewed entry does not leave either. Its expected figure is
   * hidden by the same rule, but the pharmacist's OWN earlier count is just as
   * anchoring — being shown "you said 120 last time" is not a recount, it is
   * an invitation to agree with yourself. `resolution = 'pending'` is exactly
   * "this round"; everything the admin has ruled on belongs to the last one.
   */
  const blind = text(count.status) !== 'submitted'

  const entries = await all(
    `select e.id, e.batch_id, e.medicine_id, e.attempt, e.counted_base_quantity,
            case when ? then null else e.expected_base_quantity end as expected_base_quantity,
            case when ? then null else e.variance end as variance,
            case when ? then null else e.variance_value end as variance_value,
            e.resolution, e.review_note,
            e.counted_at, s.name as counted_by_name, m.name as medicine_name, b.batch_number
       from opening_count_entries e
       join staff s on s.id = e.counted_by
       join medicines m on m.id = e.medicine_id
       join batches b on b.id = e.batch_id
      where e.opening_count_id = ?
        and (? = false or e.resolution = 'pending')
      order by m.name, b.expiry, e.attempt`,
    blind, blind, blind, text(count.id), blind,
  )

  return {
    id: text(count.id),
    reference: text(count.reference),
    status: text(count.status) as OpeningCountView['status'],
    startedByName: text(count.started_by_name),
    startedAt: text(count.started_at),
    note: text(count.note),
    entries: entries.map((r) => ({
      id: text(r.id),
      batchId: text(r.batch_id),
      medicineId: text(r.medicine_id),
      medicineName: text(r.medicine_name),
      batchNumber: text(r.batch_number),
      attempt: num(r.attempt),
      countedBaseQuantity: num(r.counted_base_quantity),
      countedByName: text(r.counted_by_name),
      countedAt: text(r.counted_at),
      expectedBaseQuantity: r.expected_base_quantity === null ? null : num(r.expected_base_quantity),
      variance: r.variance === null ? null : num(r.variance),
      varianceValue: r.variance_value === null ? null : num(r.variance_value),
      resolution: text(r.resolution) as OpeningCountView['entries'][number]['resolution'],
      reviewNote: text(r.review_note),
    })),
  }
}

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

  // The same single question `close_till` asks: cash in, minus cash refunded,
  // ignoring anything reversed. See the note there.
  const [cash] = await all(
    `select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) as total
       from payments
      where method = 'cash' and status = 'received' and received_at >= ?::timestamptz`,
    since,
  )
  const bills = { total: num(cash.total) }
  const sales = { total: 0 }
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
  /*
   * The counter, and it is `admin` as well as `pharmacy`.
   *
   * `dispense_rx`, `otc_sale` and `take_payment` all authorize admin, and the
   * owner runs this clinic — so an admin opening Counter was shown an empty
   * queue by a screen whose backend would have accepted every command on it.
   * The rail offered the station; only the data did not arrive.
   */
  const pharmacyCounter = hasRole(session, 'admin', 'pharmacy') // Counter
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
    ? (await all(`select id,name,username,phone,roles_json,active,last_login,pin_format,
        can_publish_clinical_templates from staff order by name`)).map((r) => ({
        id: text(r.id), name: text(r.name), username: text(r.username), phone: text(r.phone),
        roles: JSON.parse(text(r.roles_json)) as Role[], active: flag(r.active), lastLogin: optional(r.last_login),
        // The reset queue. An admin working through the PIN migration needs to
        // see who is still on six digits without asking them one at a time.
        pinFormat: text(r.pin_format) === 'legacy_six' ? 'legacy_six' : 'four',
        canPublishClinicalTemplates: flag(r.can_publish_clinical_templates),
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
  /*
   * Slice 4 widened this by exactly one desk.
   *
   * The counter attaches a patient to a pay-later sale and to a bill, and a
   * list of bare ids cannot do that — a first-time walk-in with no prior bill
   * was simply unattachable, which is the one case pay-later is for. So the
   * counter now receives name and phone: what is needed to find the right
   * person and no more. Age, sex and consent stay behind the care register,
   * and the clinical record was never here at all.
   */
  const patients: PatientView[] = (await all(
    careRegister
      ? `select id,name,age,sex,phone,whatsapp_consent,created_at from patients order by created_at desc`
      : pharmacyCounter
        ? `select id,name,phone,created_at from patients order by created_at desc`
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
        id: text(r.id), patientId: text(r.patient_id), bp: maybeText(r.bp),
        temperature: maybeNum(r.temperature), pulse: maybeNum(r.pulse),
        spo2: maybeNum(r.spo2), weight: maybeNum(r.weight),
        notMeasuredNote: text(r.not_measured_note),
        recordedBy: text(r.recorded_by_name), recordedAt: text(r.recorded_at),
      }))
    : []

  // No built-in clinical thresholds: a rule is sent only after a doctor has
  // approved and recorded it. An empty list produces no warning.
  const vitalReviewRules = careRegister
    ? (await all(`select id,metric,minimum_value,maximum_value,minimum_age,maximum_age,prompt
        from vital_review_rules where active=1 order by metric,minimum_age`)).map((r) => ({
        id: text(r.id),
        metric: text(r.metric) as ClinicSnapshot['vitalReviewRules'][number]['metric'],
        minimumValue: maybeNum(r.minimum_value),
        maximumValue: maybeNum(r.maximum_value),
        minimumAge: num(r.minimum_age),
        maximumAge: maybeNum(r.maximum_age),
        prompt: text(r.prompt) || 'Review this reading',
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
        order by e.created_at desc limit 100`)).map(encounterView)
    : []

  // Every prescription still waiting to be dispensed, however old, plus a
  // recent tail. The pharmacy queue is the one list that must be complete:
  // a prescription that scrolls off it is a patient who never got their
  // medicine. It is also the only list the Counter draws, and the Counter is
  // the only station that draws it.
  const prescriptions: PrescriptionView[] = pharmacyCounter
    ? (await all(`select rx.*,p.name patient_name,s.name doctor_name,
          coalesce((select jsonb_agg(${LINE_JSON} order by l.line_number)
                      from prescription_lines_effective l
                      join prescription_line_supply sup on sup.id = l.id
                     where l.prescription_id=rx.id), '[]'::jsonb) normalized_items,
          (select count(*)::int from prescription_prints pp where pp.prescription_id=rx.id) print_count
        from prescriptions rx
        join patients p on p.id=rx.patient_id join staff s on s.id=rx.doctor_id
        where rx.dispensed_at is null or rx.signed_at >= ${CLINIC_DAY_START}
        order by rx.signed_at desc`)).map(prescriptionView)
    : []

  // Same rule, same reason: money owed to the clinic must never age out of the
  // list. Settled ones are today's, for the day book. `due > 0` rather than a
  // status column — a part-paid bill from last Tuesday is still owed.
  /*
   * Bills, for the desks that handle money.
   *
   * Ungated, this shipped every open bill in the clinic — patient names and
   * full payment history — to a doctor-only session that has no billing
   * station to show it on. `patientBalances` right beside it was gated
   * correctly, which is how the omission stood out.
   *
   * The third clause is the day book's. A bill raised last week and settled
   * this morning has `due = 0` and an old `created_at`, so the first two
   * clauses drop it — and today's takings lose a payment that the till's own
   * server-side figure still counts. The two then disagree by exactly that
   * amount, every time somebody settles an old balance.
   */
  const invoices: InvoiceView[] = cashDrawer
    ? await readInvoices(
      `(b.due > 0 and b.status <> 'void')
       or b.created_at >= ${CLINIC_DAY_START}::timestamptz
       or exists (
         select 1 from payment_allocations pa
           join payments py on py.id = pa.payment_id
          where pa.invoice_id = b.id and py.received_at >= ${CLINIC_DAY_START}::timestamptz
       )`,
    )
    : []

  const patientBalances: PatientBalanceView[] = cashDrawer
    ? (await all(
      `select * from patient_balances where outstanding <> 0 order by outstanding desc`,
    )).map((row) => ({
      patientId: text(row.patient_id),
      patientName: text(row.name),
      billed: num(row.billed),
      paid: num(row.paid),
      outstanding: num(row.outstanding),
      openInvoices: num(row.open_invoices),
      oldestDueAt: optional(row.oldest_due_at),
    }))
    : []

  const beds: BedView[] = careRegister
    ? (await all(`select b.*,p.name patient_name,hr.name handoff_requested_by_name
        from beds b left join patients p on p.id=b.patient_id
        left join staff hr on hr.id=b.handoff_requested_by
        order by b.label`)).map((r) => ({
        id: text(r.id), label: text(r.label), status: text(r.status) as BedView['status'], patientId: optional(r.patient_id),
        patientName: optional(r.patient_name), admittedAt: optional(r.admitted_at), notes: optional(r.notes),
        nextCheckAt: optional(r.next_check_at), doctorInstructions: optional(r.doctor_instructions),
        handoffRequestedAt: optional(r.handoff_requested_at),
        handoffRequestedBy: optional(r.handoff_requested_by_name),
        handoffResolvedAt: optional(r.handoff_resolved_at),
      }))
    : []

  /*
   * Package ladders, read before the medicines that quote them.
   *
   * Small — a handful of rows per product — so it belongs in the polled
   * snapshot rather than behind an on-demand fetch: the counter needs the
   * sellable levels to draw its buttons, and a round trip per medicine would
   * make the tablet feel broken. The ledgers, receipt history and count sheets
   * that are NOT small stay out, as the brief requires.
   */
  const packageLevelRows = shelf
    ? await all(`select l.package_version_id, l.level_name, l.level_type, l.child_count,
          l.base_factor, l.depth, l.receivable, l.sellable, l.breakable,
          l.minimum_sale_multiple, l.mrp_basis, l.barcode_hint,
          (select c.level_name from package_levels c where c.id = l.child_level_id) as contains
        from package_levels l order by l.package_version_id, l.depth`)
    : []

  const levelsByVersion = new Map<string, PackageLevelView[]>()
  for (const row of packageLevelRows) {
    const list = levelsByVersion.get(text(row.package_version_id)) ?? []
    list.push({
      levelName: text(row.level_name),
      levelType: text(row.level_type),
      contains: optional(row.contains),
      containsCount: row.child_count === null ? undefined : num(row.child_count),
      depth: num(row.depth),
      baseFactor: num(row.base_factor),
      receivable: flag(row.receivable),
      sellable: flag(row.sellable),
      breakable: flag(row.breakable),
      minimumSaleMultiple: num(row.minimum_sale_multiple),
      mrpBasis: flag(row.mrp_basis),
      barcodeHint: text(row.barcode_hint),
    })
    levelsByVersion.set(text(row.package_version_id), list)
  }

  const packages: PackageVersionView[] = shelf
    ? (await all(`select p.id, p.medicine_id, p.version, p.base_unit, p.status,
          p.verification_source, p.verified_at, s.name as verified_by_name
        from package_versions p left join staff s on s.id = p.verified_by
        order by p.medicine_id, p.version desc`)).map((r) => {
        const levels = levelsByVersion.get(text(r.id)) ?? []
        return {
          id: text(r.id),
          medicineId: text(r.medicine_id),
          version: num(r.version),
          baseUnit: text(r.base_unit),
          status: text(r.status) as PackageVersionView['status'],
          summary: levels.length
            ? describeLadder(ladderFromRows(text(r.base_unit), levels.map(toLadderLevel)))
            : `1 ${text(r.base_unit)}`,
          verificationSource: text(r.verification_source),
          verifiedByName: optional(r.verified_by_name),
          verifiedAt: optional(r.verified_at),
          levels,
        }
      })
    : []

  // Retired versions are carried rather than filtered out. A pharmacist who
  // retires a package and then sees it simply vanish cannot tell that from
  // having deleted it, and the batches that arrived under it still exist.
  const activePackage = new Map<string, PackageVersionView>()
  for (const version of packages) {
    if (version.status === 'verified' && !activePackage.has(version.medicineId)) {
      activePackage.set(version.medicineId, version)
    }
  }

  const medicines: MedicineView[] = (await all(`select m.*,s.name preferred_supplier_name,
      d.display_name as clinical_drug_name,
      coalesce((select sum(b.available_quantity) from batch_availability b where b.medicine_id=m.id and b.pickable),0) total_available,
      coalesce((select sum(b.quarantined_quantity) from batches b where b.medicine_id=m.id),0) quarantined_quantity,
      coalesce((select sum(b.blocked_quantity) from batches b where b.medicine_id=m.id),0) blocked_quantity
    from medicines m
    left join suppliers s on s.id=m.preferred_supplier_id
    left join clinical_drugs d on d.id=m.clinical_drug_id
    order by m.name`)).map((r) => {
      const pack = activePackage.get(text(r.id))
      return {
        id: text(r.id), code: text(r.code), name: text(r.name), genericName: text(r.generic_name),
        strength: text(r.strength), dosageForm: text(r.dosage_form), route: text(r.route),
        unit: text(r.unit), barcode: text(r.barcode), saleClass: text(r.sale_class) as MedicineView['saleClass'],
        schedule: text(r.schedule) as MedicineView['schedule'],
        reorderLevel: num(r.reorder_level), targetStock: num(r.target_stock),
        preferredSupplierId: optional(r.preferred_supplier_id),
        preferredSupplierName: optional(r.preferred_supplier_name),
        totalAvailable: num(r.total_available), active: flag(r.active),
        baseUnit: text(r.base_unit) || text(r.unit),
        brandName: text(r.brand_name),
        manufacturer: text(r.manufacturer),
        clinicalDrugId: optional(r.clinical_drug_id),
        clinicalDrugName: optional(r.clinical_drug_name),
        scheduleVerified: Boolean(r.schedule_verified_at),
        scheduleSource: text(r.schedule_source),
        activePackageVersionId: pack?.id,
        packageSummary: pack?.summary ?? '',
        quarantinedQuantity: num(r.quarantined_quantity),
        blockedQuantity: num(r.blocked_quantity),
      }
    })

  // Every batch in the building, which is a per-strip list and the longest
  // thing here. Only the three shelf stations spend it: Inventory, Expiring and
  // Stock-take. A nurse has none of them and was carrying all of it.
  const batches: BatchView[] = shelf
    ? (await all(`select b.*, a.pickable, a.expired,
          m.name medicine_name, s.name received_from_supplier_name
        from batches b
        join batch_availability a on a.id = b.id
        join medicines m on m.id=b.medicine_id
        left join suppliers s on s.id=b.received_from_supplier_id
        order by m.name,b.expiry`)).map((r) => ({
        id: text(r.id), medicineId: text(r.medicine_id), medicineName: text(r.medicine_name), batchNumber: text(r.batch_number),
        expiry: text(r.expiry), availableQuantity: num(r.available_quantity), mrp: num(r.mrp), purchasePrice: num(r.purchase_price),
        sellingPrice: num(r.selling_price), receivedFromSupplierId: optional(r.received_from_supplier_id),
        receivedFromSupplierName: optional(r.received_from_supplier_name), receivedAt: text(r.received_at),
        status: text(r.status) as BatchView['status'],
        statusReason: text(r.status_reason),
        quarantinedQuantity: num(r.quarantined_quantity),
        blockedQuantity: num(r.blocked_quantity),
        baseUnit: text(r.base_unit),
        pickable: flag(r.pickable),
        expired: flag(r.expired),
        mrpBasisLevel: text(r.mrp_basis_level),
        mrpBasisFactor: num(r.mrp_basis_factor) || 1,
        purchaseBasisLevel: text(r.purchase_basis_level),
        purchaseBasisFactor: num(r.purchase_basis_factor) || 1,
        packageVersionId: optional(r.package_version_id),
        packageBreakdown: batchBreakdown(r),
      }))
    : []

  const medicineBarcodes: MedicineBarcodeView[] = shelf
    ? (await all(`select c.code, c.medicine_id, c.level_name, c.symbology, c.carries_batch,
          v.name as verified_by_name
        from medicine_barcodes c left join staff v on v.id = c.verified_by
        order by c.medicine_id, c.level_name`)).map((r) => ({
        code: text(r.code), medicineId: text(r.medicine_id), levelName: text(r.level_name),
        symbology: text(r.symbology), carriesBatch: flag(r.carries_batch),
        verifiedByName: optional(r.verified_by_name),
      }))
    : []

  const unmappedBarcodes: UnmappedBarcodeView[] = supplyNetwork
    ? (await all(`select code, symbology, seen_count, last_seen_at from unmapped_barcodes
        where resolved_at is null order by last_seen_at desc limit 50`)).map((r) => ({
        code: text(r.code), symbology: text(r.symbology),
        seenCount: num(r.seen_count), lastSeenAt: text(r.last_seen_at),
      }))
    : []

  const openingCount: OpeningCountView | null = shelf ? await readOpeningCount() : null

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
    ? await readOtcSales()
    : []

  const audits: AuditView[] = staffAdmin
    ? (await all(`select a.*,s.name actor_name from audit_events a join staff s on s.id=a.actor_id
        order by a.created_at desc limit 100`)).map((r) => ({
          id: text(r.id), actorName: text(r.actor_name), action: text(r.action), entityType: text(r.entity_type),
          summary: text(r.summary), createdAt: text(r.created_at),
        }))
    : []

  // The doctor's Today queue: open follow-ups only, bounded and ordered by
  // what needs attention first. It contains no notes from the encounter.
  const followUps: FollowUpView[] = clinicalRecord
    ? (await all(`select f.*,p.name patient_name,s.name doctor_name
        from follow_ups f
        join patients p on p.id=f.patient_id
        join staff s on s.id=f.doctor_id
        where f.doctor_id=? and f.status='open'
        order by f.due_date limit 100`, session.staffId)).map(followUpView)
    : []

  return {
    session,
    staff,
    patients,
    appointments,
    vitals,
    vitalReviewRules,
    encounters,
    prescriptions,
    invoices,
    beds,
    medicines,
    batches,
    patientBalances,
    packages,
    medicineBarcodes,
    unmappedBarcodes,
    openingCount,
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
    followUps,
    settings: await readSettings(),
    doctorPresent: knownDoctorPresence ?? await doctorLoggedIn(),
    // Zero is the PIN migration's exit gate. Only an admin is told the figure;
    // for anybody else it is a rollout number and none of their business, and
    // 0 is the honest answer to "how many resets are waiting for you".
    legacyPinCount: staffAdmin ? await legacyPinCount() : 0,
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
export async function readPatientRecord(
  patientId: string,
  responsibleDoctorId?: string,
): Promise<PatientRecordView> {
  const [
    encounters,
    prescriptions,
    vitals,
    bills,
    followUps,
    profiles,
    phrases,
    preferences,
    drafts,
    templates,
  ] = await Promise.all([
    all(
      `select e.*,p.name patient_name,s.name doctor_name from encounters e
         join patients p on p.id=e.patient_id join staff s on s.id=e.doctor_id
        where e.patient_id=? order by e.created_at desc`,
      patientId,
    ),
    all(
      `select rx.*,p.name patient_name,s.name doctor_name,
          coalesce((select jsonb_agg(${LINE_JSON} order by l.line_number)
                      from prescription_lines_effective l
                      join prescription_line_supply sup on sup.id = l.id
                     where l.prescription_id=rx.id), '[]'::jsonb) normalized_items,
          (select count(*)::int from prescription_prints pp where pp.prescription_id=rx.id) print_count
         from prescriptions rx
         join patients p on p.id=rx.patient_id join staff s on s.id=rx.doctor_id
        where rx.patient_id=? order by rx.signed_at desc`,
      patientId,
    ),
    all(
      `select v.*,s.name recorded_by_name from vitals v join staff s on s.id=v.recorded_by
        where v.patient_id=? order by v.recorded_at desc`,
      patientId,
    ),
    // One patient's bills, in full: every line and every payment against them.
    readInvoices('b.patient_id = ?', [patientId]),
    all(
      `select f.*,p.name patient_name,s.name doctor_name from follow_ups f
         join patients p on p.id=f.patient_id join staff s on s.id=f.doctor_id
        where f.patient_id=? order by f.due_date desc`,
      patientId,
    ),
    all(
      `select allergy_status,allergy_notes,clinical_flags,updated_at
         from patient_clinical_profiles where patient_id=?`,
      patientId,
    ),
    responsibleDoctorId
      // A withdrawn phrase, and every phrase belonging to a superseded
      // vocabulary release, drops out of the suggestions offered for new work.
      // Neither disappears from a visit that already used the wording: signed
      // encounters keep their own text.
      ? all(`select p.id,p.kind,p.display_text,p.source from clinical_phrases p
          left join clinical_vocabulary_releases r on r.id=p.release_id
          where p.active=1 and (p.release_id is null or r.retired_at is null)
          order by p.kind,p.display_text`)
      : Promise.resolve([]),
    responsibleDoctorId
      ? all(`select kind,display_text,favourite,use_count,last_used_at
          from clinical_phrase_preferences where doctor_id=?
          order by favourite desc,last_used_at desc nulls last limit 120`, responsibleDoctorId)
      : Promise.resolve([]),
    responsibleDoctorId
      ? all(
          `select d.*,
              coalesce((select jsonb_agg(${DRAFT_LINE_JSON} order by l.line_number)
                          from consultation_draft_lines l
                          join medicines m on m.id=l.medicine_id
                         where l.draft_id=d.id), '[]'::jsonb) draft_items
             from consultation_drafts d
            where d.patient_id=? and d.doctor_id=?`,
          patientId,
          responsibleDoctorId,
        )
      : Promise.resolve([]),
    responsibleDoctorId
      ? all(
          `select t.*,s.name owner_doctor_name,
              coalesce((select jsonb_agg(${DRAFT_LINE_JSON} order by l.line_number)
                          from consultation_template_lines l
                          join medicines m on m.id=l.medicine_id
                         where l.template_version_id=t.id), '[]'::jsonb) template_items
             from consultation_templates t
             join staff s on s.id=t.owner_doctor_id
            where t.retired_at is null
              and (t.scope='clinic' or t.owner_doctor_id=?)
            order by t.scope,t.title`,
          responsibleDoctorId,
        )
      : Promise.resolve([]),
  ])

  const draftRow = drafts[0]
  const draft: ConsultationDraftView | undefined = draftRow
    ? {
        id: text(draftRow.id),
        patientId: text(draftRow.patient_id),
        appointmentId: optional(draftRow.appointment_id),
        complaint: text(draftRow.complaint),
        complaintDurationValue: maybeNum(draftRow.complaint_duration_value),
        complaintDurationUnit: optional(draftRow.complaint_duration_unit) as ConsultationDraftView['complaintDurationUnit'],
        examination: text(draftRow.examination),
        diagnosis: text(draftRow.diagnosis),
        diagnosisStatus: text(draftRow.diagnosis_status) as ConsultationDraftView['diagnosisStatus'],
        aetiology: text(draftRow.aetiology),
        aetiologyCertainty: text(draftRow.aetiology_certainty) as ConsultationDraftView['aetiologyCertainty'],
        notes: text(draftRow.notes),
        advice: text(draftRow.advice),
        followUpDate: optional(draftRow.follow_up_date),
        items: jsonArray(draftRow.draft_items) as PrescriptionItemView[],
        createdAt: text(draftRow.created_at),
        updatedAt: text(draftRow.updated_at),
        stale: Date.now() - new Date(text(draftRow.updated_at)).getTime() >= 7 * 24 * 60 * 60 * 1000,
      }
    : undefined

  const templateViews: ConsultationTemplateView[] = templates.map((r) => ({
    id: text(r.id),
    seriesId: text(r.series_id),
    version: num(r.version),
    scope: text(r.scope) as ConsultationTemplateView['scope'],
    ownerDoctorId: text(r.owner_doctor_id),
    ownerDoctorName: text(r.owner_doctor_name),
    title: text(r.title),
    complaint: text(r.complaint),
    complaintDurationValue: maybeNum(r.complaint_duration_value),
    complaintDurationUnit: optional(r.complaint_duration_unit) as ConsultationTemplateView['complaintDurationUnit'],
    examination: text(r.examination),
    diagnosis: text(r.diagnosis),
    diagnosisStatus: text(r.diagnosis_status) as ConsultationTemplateView['diagnosisStatus'],
    aetiology: text(r.aetiology),
    aetiologyCertainty: text(r.aetiology_certainty) as ConsultationTemplateView['aetiologyCertainty'],
    notes: text(r.notes),
    advice: text(r.advice),
    followUpAfterDays: maybeNum(r.follow_up_after_days),
    items: jsonArray(r.template_items) as PrescriptionItemView[],
    createdAt: text(r.created_at),
  }))

  const profile = profiles[0]
  return {
    patientId,
    encounters: encounters.map(encounterView),
    prescriptions: prescriptions.map(prescriptionView),
    vitals: vitals.map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), bp: maybeText(r.bp),
      temperature: maybeNum(r.temperature), pulse: maybeNum(r.pulse),
      spo2: maybeNum(r.spo2), weight: maybeNum(r.weight),
      notMeasuredNote: text(r.not_measured_note),
      recordedBy: text(r.recorded_by_name), recordedAt: text(r.recorded_at),
    })),
    invoices: bills,
    draft,
    templates: templateViews,
    phrases: phrases.map((r) => ({
      id: text(r.id), kind: text(r.kind) as ClinicalPhraseKind,
      text: text(r.display_text), source: text(r.source),
    })),
    phrasePreferences: preferences.map((r) => ({
      kind: text(r.kind) as ClinicalPhraseKind,
      text: text(r.display_text), favourite: flag(r.favourite),
      useCount: num(r.use_count), lastUsedAt: optional(r.last_used_at),
    })),
    followUps: followUps.map(followUpView),
    clinicalProfile: profile
      ? {
          allergyStatus: text(profile.allergy_status) as PatientRecordView['clinicalProfile']['allergyStatus'],
          allergyNotes: text(profile.allergy_notes),
          clinicalFlags: text(profile.clinical_flags),
          updatedAt: optional(profile.updated_at),
        }
      : { allergyStatus: 'not_recorded', allergyNotes: '', clinicalFlags: '' },
    // Slice 5 owns private image storage and access. Saying it is not enabled
    // is truthful patient context; pretending an empty array means "none" is not.
    imageSeriesStatus: 'not_enabled',
  }
}
