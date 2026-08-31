export type Role = 'admin' | 'doctor' | 'nurse' | 'pharmacy'

export interface SessionView {
  staffId: string
  name: string
  roles: Role[]
  username: string
  lastSeen: string
}

export interface StaffView {
  id: string
  name: string
  username: string
  phone: string
  roles: Role[]
  active: boolean
  lastLogin?: string
}

export interface PatientView {
  id: string
  name: string
  age: number
  sex: 'female' | 'male' | 'other'
  phone: string
  address: string
  whatsappConsent: boolean
  createdAt: string
}

export interface AppointmentView {
  id: string
  patientId: string
  patientName: string
  token: string
  reason: string
  scheduledAt: string
  status: 'waiting' | 'in_consult' | 'done' | 'cancelled'
}

export interface VitalView {
  id: string
  patientId: string
  bp: string
  temperature: number
  pulse: number
  spo2: number
  weight: number
  recordedBy: string
  recordedAt: string
}

export interface EncounterView {
  id: string
  patientId: string
  patientName: string
  doctorName: string
  diagnosis: string
  notes: string
  advice: string
  createdAt: string
}

export interface PrescriptionItemView {
  medicineId: string
  medicineName: string
  dosage: string
  instructions: string
  quantity: number
}

export interface PrescriptionView {
  id: string
  patientId: string
  patientName: string
  doctorName: string
  items: PrescriptionItemView[]
  signedAt: string
  dispensedAt?: string
}

export interface BillView {
  id: string
  patientId: string
  patientName: string
  label: string
  amount: number
  status: 'unpaid' | 'paid'
  paymentMethod?: 'cash' | 'upi' | 'card'
  createdAt: string
  paidAt?: string
}

export interface BedView {
  id: string
  label: string
  status: 'available' | 'occupied' | 'cleaning' | 'out_of_service'
  patientId?: string
  patientName?: string
  admittedAt?: string
  notes?: string
}

export type SaleClass = 'otc' | 'prescription' | 'restricted' | 'unknown'

/**
 * What a medicine legally IS, under the Drugs and Cosmetics Rules.
 *
 * Distinct from SaleClass, which is a selling rule. The Schedule H1 register
 * depends on this and cannot be derived from the other: 'restricted' could be
 * H1 or X, and a Schedule H1 antibiotic could be sitting as 'prescription'.
 *
 * 'unset' is the honest default for a medicine nobody has classified yet. The
 * register counts them and refuses to call itself complete while any remain.
 */
export type DrugSchedule = 'unset' | 'OTC' | 'H' | 'H1' | 'X'

export interface MedicineView {
  id: string
  code: string
  name: string
  strength: string
  dosageForm: string
  unit: string
  barcode: string
  saleClass: SaleClass
  schedule: DrugSchedule
  reorderLevel: number
  targetStock: number
  preferredSupplierId?: string
  preferredSupplierName?: string
  totalAvailable: number
  active: boolean
}

export interface BatchView {
  id: string
  medicineId: string
  medicineName: string
  batchNumber: string
  expiry: string
  availableQuantity: number
  mrp: number
  purchasePrice: number
  sellingPrice: number
  receivedFromSupplierId?: string
  receivedFromSupplierName?: string
  receivedAt: string
}

export interface SupplierView {
  id: string
  code: string
  name: string
  contactPerson: string
  whatsapp: string
  phone: string
  email: string
  address: string
  gstin: string
  active: boolean
  /**
   * Days before expiry this supplier accepts returns. 0 means none, which is
   * why their stock sorts to the top of the write-off list rather than sitting
   * there looking returnable.
   */
  returnWindowDays: number
  medicineIds: string[]
}

/**
 * The cash drawer as it stands. Null when nobody has opened it.
 *
 * `expectedCash` is computed live while the till is open — it is what the
 * drawer should hold right now. Once closed, the figure stored on the session
 * is the one that counts, and it does not move afterwards.
 */
export interface TillView {
  id: string
  openedAt: string
  openedBy: string
  openingFloat: number
  cashFromBills: number
  cashFromSales: number
  cashIn: number
  cashOut: number
  expectedCash: number
  movements: Array<{
    id: string
    direction: 'in' | 'out'
    amount: number
    reason: string
    at: string
    actorName: string
  }>
}

export interface TillCloseView {
  id: string
  openedAt: string
  closedAt: string
  closedBy: string
  openingFloat: number
  countedCash: number
  expectedCash: number
  variance: number
  note: string
}

/**
 * One batch, counted.
 *
 * The variance fields are OPTIONAL on purpose, and the server omits them while
 * the stock-take is still being counted. A counter who can see "you are 3
 * short" will find three, and the count stops being evidence of anything. The
 * figures appear only once the sheet is submitted and can no longer be edited.
 */
export interface StockTakeLineView {
  id: string
  batchId: string
  medicineName: string
  batchNumber: string
  countedQuantity: number
  countNumber: number
  countedBy: string
  countedAt: string
  expectedQuantity?: number
  variance?: number
  varianceValue?: number
  needsRecount?: boolean
}

export interface StockTakeView {
  id: string
  reference: string
  scope: 'full' | 'partial'
  scopeNote: string
  status: 'counting' | 'submitted'
  /** Variance above this rupee value must be counted twice before it can post. */
  recountThreshold: number
  startedAt: string
  startedBy: string
  submittedAt?: string
  submittedBy?: string
  lines: StockTakeLineView[]
  /** False while counting. The screens use this rather than guessing from status. */
  varianceVisible: boolean
}

export interface StockTakeHistoryView {
  id: string
  reference: string
  scope: 'full' | 'partial'
  status: 'posted' | 'abandoned'
  startedAt: string
  finishedAt: string
  finishedBy: string
  batchesCounted: number
  batchesCorrected: number
  netValue: number
}

export interface StockWriteoffView {
  id: string
  date: string
  medicineName: string
  batchNumber: string
  quantity: number
  reason: 'expiry' | 'damage' | 'loss'
  costValue: number
  note: string
  actorName: string
}

export interface SupplierReturnView {
  id: string
  noteNumber: string
  date: string
  supplierName: string
  medicineName: string
  batchNumber: string
  quantity: number
  expectedCredit: number
  status: 'sent' | 'credited' | 'rejected'
}

export interface OrderLineView {
  id: string
  medicineId: string
  medicineName: string
  orderedQuantity: number
  receivedQuantity: number
}

export interface PurchaseOrderView {
  id: string
  orderNumber: string
  supplierId: string
  supplierName: string
  status: 'pending' | 'placed' | 'partially_delivered' | 'delivered' | 'cancelled'
  requestedDate: string
  messageDraft: string
  messageStatus?: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  createdAt: string
  placedAt?: string
  lines: OrderLineView[]
}

export interface OtcSaleView {
  id: string
  receiptNumber: string
  total: number
  paymentMethod: 'cash' | 'upi' | 'card'
  createdAt: string
  lineCount: number
}

export interface AuditView {
  id: string
  actorName: string
  action: string
  entityType: string
  summary: string
  createdAt: string
}

/**
 * The details that turn a printed sheet into a document.
 *
 * `complete` is derived, not stored: a bill missing the drug licence number is
 * not a valid receipt, and the screens say so rather than printing a blank
 * where a licence number should be.
 */
export interface ClinicSettingsView {
  name: string
  address: string
  phone: string
  email: string
  drugLicenceNumber: string
  doctorRegistrationNumber: string
  gstin: string
  consultationFee: number
  footerNote: string
  updatedAt: string
  complete: boolean
}

export interface ClinicSnapshot {
  session: SessionView
  staff: StaffView[]
  patients: PatientView[]
  appointments: AppointmentView[]
  vitals: VitalView[]
  encounters: EncounterView[]
  prescriptions: PrescriptionView[]
  bills: BillView[]
  beds: BedView[]
  medicines: MedicineView[]
  batches: BatchView[]
  suppliers: SupplierView[]
  orders: PurchaseOrderView[]
  otcSales: OtcSaleView[]
  audits: AuditView[]
  till: TillView | null
  tillHistory: TillCloseView[]
  stockTake: StockTakeView | null
  stockTakeHistory: StockTakeHistoryView[]
  writeoffs: StockWriteoffView[]
  supplierReturns: SupplierReturnView[]
  settings: ClinicSettingsView
  doctorPresent: boolean
  whatsapp: {
    configured: boolean
    businessNumberConfigured: boolean
    note: string
  }
}

export interface CommandResponse {
  ok: boolean
  message: string
  data?: unknown
}
