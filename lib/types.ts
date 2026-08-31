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

export interface MedicineView {
  id: string
  code: string
  name: string
  strength: string
  dosageForm: string
  unit: string
  barcode: string
  saleClass: SaleClass
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
  medicineIds: string[]
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
