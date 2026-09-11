export type Role = 'admin' | 'doctor' | 'nurse' | 'pharmacy'

export interface SessionView {
  staffId: string
  name: string
  roles: Role[]
  username: string
  lastSeen: string
  /** Clinical authority, distinct from operational admin access. */
  canPublishClinicalTemplates: boolean
}

/**
 * Which length of PIN a staff member currently holds.
 *
 * `legacy_six` is the old six-digit PIN, still accepted until that person is
 * reset. `four` is the new one. A stored scrypt hash cannot be converted, so
 * the only way from one to the other is an admin resetting the person in front
 * of them — and the only way to know how far the clinic has got is to count
 * the rows still on `legacy_six`.
 */
export type PinFormat = 'legacy_six' | 'four'

/** How many digits that format is, which is what the lock screen's pad needs. */
export const PIN_LENGTH: Record<PinFormat, 4 | 6> = { legacy_six: 6, four: 4 }

export interface StaffView {
  id: string
  name: string
  username: string
  phone: string
  roles: Role[]
  active: boolean
  lastLogin?: string
  /** Admin-only view. Drives the reset queue during the PIN migration. */
  pinFormat: PinFormat
  /** May approve a doctor-authored template for the whole clinic. */
  canPublishClinicalTemplates: boolean
}

/**
 * One name on the lock screen.
 *
 * Deliberately thin, and deliberately unauthenticated: this list is served to
 * anybody who can reach the clinic's URL, so everything on it is public.
 *
 * `pinLength` is the one thing here that is not simply a label. The pad
 * submits on the last digit rather than making every staff member tap a
 * confirm button hundreds of times a day, so it has to know whether this
 * person's PIN is four digits or six. That does tell a stranger which accounts
 * have been migrated, which is a real if small disclosure — the alternative is
 * a confirm button for everyone, or a pad that guesses and locks people out of
 * their own clinic by submitting early. It is also information an attacker
 * obtains in one attempt anyway.
 */
export interface LockScreenStaffView {
  id: string
  name: string
  roles: Role[]
  pinLength: 4 | 6
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

/**
 * One set of readings, with the ones nobody took left out.
 *
 * Every field except the identifiers is optional, and an absent field means
 * NOT MEASURED — never zero. The clinic runs days without a nurse, and the
 * alternative to a blank is a doctor typing a plausible number for a reading
 * he did not take, which is worse than a gap because nothing downstream can
 * tell it from a real one.
 *
 * At least one reading is always present; the database refuses a row of
 * nothing.
 */
export interface VitalView {
  id: string
  patientId: string
  bp?: string
  temperature?: number
  pulse?: number
  spo2?: number
  weight?: number
  /** Why something is missing, in the recorder's own words. Optional. */
  notMeasuredNote: string
  recordedBy: string
  recordedAt: string
}

export interface EncounterView {
  id: string
  patientId: string
  patientName: string
  doctorName: string
  diagnosis: string
  complaint: string
  complaintDurationValue?: number
  complaintDurationUnit?: 'day' | 'week' | 'month'
  examination: string
  diagnosisStatus: 'unspecified' | 'provisional' | 'differential' | 'confirmed'
  aetiology: string
  aetiologyCertainty: 'not_stated' | 'suspected' | 'confirmed'
  notes: string
  advice: string
  followUpDate?: string
  createdAt: string
}

export interface PrescriptionItemView {
  medicineId: string
  medicineName: string
  genericName?: string
  strength?: string
  dosageForm?: string
  route?: string
  medicineCode?: string
  doseAmount?: string
  doseUnit?: string
  frequency?: string
  timing?: string
  durationValue?: number
  durationUnit?: 'day' | 'week' | 'month'
  dosage: string
  instructions: string
  /**
   * Absent when this line came from before the current system and the clinic's
   * record does not say what quantity was authorized. It is never defaulted to
   * a number: see the Slice 2.1 migration.
   */
  quantity?: number
  quantityUnit?: string
  /** `unresolved_legacy` when the medicine this line names is not in the formulary. */
  medicineState?: 'resolved' | 'unresolved_legacy'
  /** `unknown_legacy` when no usable quantity was ever recorded. */
  quantityState?: 'recorded' | 'unknown_legacy'
  /** A doctor withdrew this line after signing. */
  cancelled?: boolean
  /** True when a doctor must resolve the line before pharmacy may supply it. */
  needsReview?: boolean
}

export interface PrescriptionView {
  id: string
  patientId: string
  patientName: string
  doctorName: string
  prescriptionNumber: string
  items: PrescriptionItemView[]
  signedAt: string
  dispensedAt?: string
  printCount: number
}

export type ClinicalPhraseKind =
  | 'complaint'
  | 'examination'
  | 'diagnosis'
  | 'instruction'
  | 'advice'

export interface ClinicalPhraseView {
  id: string
  kind: ClinicalPhraseKind
  text: string
  source: string
}

export interface ClinicalPhrasePreferenceView {
  kind: ClinicalPhraseKind
  text: string
  favourite: boolean
  useCount: number
  lastUsedAt?: string
}

export interface ConsultationDraftView {
  id: string
  patientId: string
  appointmentId?: string
  complaint: string
  complaintDurationValue?: number
  complaintDurationUnit?: 'day' | 'week' | 'month'
  examination: string
  diagnosis: string
  diagnosisStatus: 'provisional' | 'differential' | 'confirmed'
  aetiology: string
  aetiologyCertainty: 'not_stated' | 'suspected' | 'confirmed'
  notes: string
  advice: string
  followUpDate?: string
  items: PrescriptionItemView[]
  createdAt: string
  updatedAt: string
  stale: boolean
}

export interface ConsultationTemplateView {
  id: string
  seriesId: string
  version: number
  scope: 'personal' | 'clinic'
  ownerDoctorId: string
  ownerDoctorName: string
  title: string
  complaint: string
  complaintDurationValue?: number
  complaintDurationUnit?: 'day' | 'week' | 'month'
  examination: string
  diagnosis: string
  diagnosisStatus: 'provisional' | 'differential' | 'confirmed'
  aetiology: string
  aetiologyCertainty: 'not_stated' | 'suspected' | 'confirmed'
  notes: string
  advice: string
  followUpAfterDays?: number
  items: PrescriptionItemView[]
  createdAt: string
}

export interface FollowUpView {
  id: string
  patientId: string
  patientName: string
  encounterId: string
  doctorId: string
  doctorName: string
  dueDate: string
  note: string
  status: 'open' | 'completed' | 'cancelled'
  createdAt: string
}

export interface PatientClinicalProfileView {
  allergyStatus: 'not_recorded' | 'no_known' | 'known'
  allergyNotes: string
  clinicalFlags: string
  updatedAt?: string
}

export interface VitalReviewRuleView {
  id: string
  metric: 'systolic' | 'diastolic' | 'temperature' | 'pulse' | 'spo2' | 'weight'
  minimumValue?: number
  maximumValue?: number
  minimumAge: number
  maximumAge?: number
  prompt: string
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
  nextCheckAt?: string
  doctorInstructions?: string
  handoffRequestedAt?: string
  handoffRequestedBy?: string
  handoffResolvedAt?: string
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
/**
 * What a medicine legally IS, under the Drugs and Cosmetics Rules.
 *
 * `unset` is Unknown / pharmacist review required, and it is refused from the
 * anonymous counter path. It is never inferred from `saleClass`, which is a
 * selling rule: `restricted` could be H1 or X, and a register that guesses is
 * one an inspector can fault in both directions.
 *
 * Slice 3 widened this. `classify_medicine` had always accepted G, C, C1 and
 * `other` — Indian practice uses all of them — while this union still listed
 * five, so a medicine classified `G` came back through the snapshot as a value
 * the type said could not exist. Nothing failed; a switch on it simply fell
 * through to whatever the last branch was.
 */
export type DrugSchedule = 'unset' | 'OTC' | 'H' | 'H1' | 'X' | 'G' | 'C' | 'C1' | 'other'

export interface MedicineView {
  id: string
  code: string
  name: string
  genericName: string
  strength: string
  dosageForm: string
  route: string
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

  // ── Slice 3 ──────────────────────────────────────────────────────────────
  /** The smallest countable item the clinic stocks. What `totalAvailable` counts. */
  baseUnit: string
  brandName: string
  manufacturer: string
  /** Empty until a pharmacist links it. Never guessed from the shelf label. */
  clinicalDrugId?: string
  clinicalDrugName?: string
  /**
   * A classification is a fact somebody checked, not a colour. Unverified means
   * the anonymous counter path refuses it, whatever `schedule` says.
   */
  scheduleVerified: boolean
  scheduleSource: string
  /** The newest verified package. Absent means stock cannot be received yet. */
  activePackageVersionId?: string
  /** "1 box = 10 strips = 150 tablets", for the screen. */
  packageSummary: string
  /** Quantities that exist but cannot be sold, so a shelf figure is never a surprise. */
  quarantinedQuantity: number
  blockedQuantity: number
}

export interface BatchView {
  id: string
  medicineId: string
  medicineName: string
  batchNumber: string
  expiry: string
  availableQuantity: number
  /** The printed figure. `mrpBasisLevel`/`mrpBasisFactor` say what it is FOR. */
  mrp: number
  /** Per base unit. */
  purchasePrice: number
  /** Per base unit. */
  sellingPrice: number
  receivedFromSupplierId?: string
  receivedFromSupplierName?: string
  receivedAt: string

  // ── Slice 3 ──────────────────────────────────────────────────────────────
  status: 'active' | 'recalled' | 'blocked'
  statusReason: string
  quarantinedQuantity: number
  blockedQuantity: number
  baseUnit: string
  /** False for expired, recalled or blocked stock. One question, one answer. */
  pickable: boolean
  expired: boolean
  mrpBasisLevel: string
  mrpBasisFactor: number
  purchaseBasisLevel: string
  purchaseBasisFactor: number
  packageVersionId?: string
  /**
   * "1 box, 3 strips and 4 tablets", using THIS batch's frozen conversion.
   * Per batch and never per medicine: a shelf holding strips of fifteen and
   * strips of ten has no single correct decomposition.
   */
  packageBreakdown: string
}

/** One rung of a package ladder. */
export interface PackageLevelView {
  levelName: string
  levelType: string
  contains?: string
  containsCount?: number
  depth: number
  baseFactor: number
  receivable: boolean
  sellable: boolean
  breakable: boolean
  minimumSaleMultiple: number
  mrpBasis: boolean
  /** The code printed on this level, if the builder recorded one. */
  barcodeHint: string
}

/** A code mapped to one package level of one product. */
export interface MedicineBarcodeView {
  code: string
  medicineId: string
  levelName: string
  symbology: string
  /**
   * False for an ordinary GTIN, which identifies the trade item and NOT the
   * lot. Only a GS1-128, DataMatrix or QR payload carrying application
   * identifiers (10) and (17) says otherwise.
   */
  carriesBatch: boolean
  verifiedByName?: string
}

/**
 * A package SKU as it stood at one point in time.
 *
 * Versioned rather than edited: when a strip goes from fifteen tablets to ten,
 * the old version stays for the batches that arrived under it and a new one is
 * created for new stock.
 */
export interface PackageVersionView {
  id: string
  medicineId: string
  version: number
  baseUnit: string
  status: 'draft' | 'verified' | 'retired'
  summary: string
  verificationSource: string
  verifiedByName?: string
  verifiedAt?: string
  levels: PackageLevelView[]
}

/** A scanned code nobody has mapped yet — a queue for the admin, not an error. */
export interface UnmappedBarcodeView {
  code: string
  symbology: string
  seenCount: number
  lastSeenAt: string
}

export interface OpeningCountEntryView {
  id: string
  batchId: string
  medicineId: string
  medicineName: string
  batchNumber: string
  attempt: number
  countedBaseQuantity: number
  countedByName: string
  countedAt: string
  /**
   * Null while counting. That is the blind count: the figure is not withheld
   * by the screen, it has not been written yet.
   */
  expectedBaseQuantity: number | null
  variance: number | null
  varianceValue: number | null
  resolution: 'pending' | 'approved' | 'recount_requested' | 'rejected'
  reviewNote: string
}

export interface OpeningCountView {
  id: string
  reference: string
  status: 'counting' | 'submitted' | 'recount' | 'approved' | 'abandoned'
  startedByName: string
  startedAt: string
  note: string
  entries: OpeningCountEntryView[]
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

/**
 * One patient's whole history, fetched when somebody opens that patient.
 *
 * This does not travel in the snapshot. Consultations, prescriptions, vitals
 * and bills accumulate at several rows per visit and never stop, so shipping
 * all of them to every tablet on every tap made the clinic slower every month
 * it stayed open.
 */
export interface PatientRecordView {
  patientId: string
  encounters: EncounterView[]
  prescriptions: PrescriptionView[]
  vitals: VitalView[]
  bills: BillView[]
  draft?: ConsultationDraftView
  templates: ConsultationTemplateView[]
  phrases: ClinicalPhraseView[]
  phrasePreferences: ClinicalPhrasePreferenceView[]
  followUps: FollowUpView[]
  clinicalProfile: PatientClinicalProfileView
  imageSeriesStatus: 'not_enabled' | 'none' | 'available'
}

export interface ClinicSnapshot {
  session: SessionView
  staff: StaffView[]
  patients: PatientView[]
  appointments: AppointmentView[]
  vitals: VitalView[]
  vitalReviewRules: VitalReviewRuleView[]
  encounters: EncounterView[]
  prescriptions: PrescriptionView[]
  bills: BillView[]
  beds: BedView[]
  medicines: MedicineView[]
  batches: BatchView[]
  /** Package ladders for every product that has one. Shelf roles only. */
  packages: PackageVersionView[]
  /** What each mapped code means, so a screen can show it and spot a clash. */
  medicineBarcodes: MedicineBarcodeView[]
  unmappedBarcodes: UnmappedBarcodeView[]
  openingCount: OpeningCountView | null
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
  followUps: FollowUpView[]
  settings: ClinicSettingsView
  doctorPresent: boolean
  /**
   * Active staff still holding a six-digit PIN. Zero is the PIN migration's
   * exit gate — six-digit compatibility comes out of the code when this
   * reaches it, and not before. Admin sees the number; everybody else gets 0,
   * because it is a rollout figure and not their business.
   */
  legacyPinCount: number
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
