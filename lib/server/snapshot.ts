import 'server-only'

import type { SQLInputValue } from 'node:sqlite'
import type {
  AppointmentView,
  AuditView,
  BatchView,
  BedView,
  BillView,
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
} from '@/lib/types'
import { db } from './db'
import { doctorLoggedIn } from './auth'
import { whatsappStatus } from './whatsapp'

type Row = Record<string, unknown>
const all = async (sql: string, ...params: SQLInputValue[]) =>
  (await db.prepare(sql).all(...params)) as Row[]
const text = (value: unknown) => String(value ?? '')
const optional = (value: unknown) => (value == null ? undefined : String(value))
const num = (value: unknown) => Number(value ?? 0)
const flag = (value: unknown) => Boolean(Number(value ?? 0))

export async function readSnapshot(session: SessionView): Promise<ClinicSnapshot> {
  const staff: StaffView[] = (await all(`select id,name,username,phone,roles_json,active,last_login from staff order by name`)).map((r) => ({
    id: text(r.id), name: text(r.name), username: text(r.username), phone: text(r.phone),
    roles: JSON.parse(text(r.roles_json)) as Role[], active: flag(r.active), lastLogin: optional(r.last_login),
  }))

  const patients: PatientView[] = (await all(`select * from patients order by created_at desc`)).map((r) => ({
    id: text(r.id), name: text(r.name), age: num(r.age), sex: text(r.sex) as PatientView['sex'],
    phone: text(r.phone), address: text(r.address), whatsappConsent: flag(r.whatsapp_consent), createdAt: text(r.created_at),
  }))

  const appointments: AppointmentView[] = (await all(`select a.*,p.name patient_name from appointments a
    join patients p on p.id=a.patient_id order by a.scheduled_at`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), token: text(r.token),
      reason: text(r.reason), scheduledAt: text(r.scheduled_at), status: text(r.status) as AppointmentView['status'],
    }))

  const vitals: VitalView[] = (await all(`select v.*,s.name recorded_by_name from vitals v
    join staff s on s.id=v.recorded_by order by v.recorded_at desc`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), bp: text(r.bp), temperature: num(r.temperature), pulse: num(r.pulse),
      spo2: num(r.spo2), weight: num(r.weight), recordedBy: text(r.recorded_by_name), recordedAt: text(r.recorded_at),
    }))

  const encounters: EncounterView[] = (await all(`select e.*,p.name patient_name,s.name doctor_name from encounters e
    join patients p on p.id=e.patient_id join staff s on s.id=e.doctor_id order by e.created_at desc`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), doctorName: text(r.doctor_name),
      diagnosis: text(r.diagnosis), notes: text(r.notes), advice: text(r.advice), createdAt: text(r.created_at),
    }))

  const prescriptions: PrescriptionView[] = (await all(`select rx.*,p.name patient_name,s.name doctor_name from prescriptions rx
    join patients p on p.id=rx.patient_id join staff s on s.id=rx.doctor_id order by rx.signed_at desc`)).map((r) => ({
      id: text(r.id), patientId: text(r.patient_id), patientName: text(r.patient_name), doctorName: text(r.doctor_name),
      items: JSON.parse(text(r.items_json)) as PrescriptionItemView[], signedAt: text(r.signed_at), dispensedAt: optional(r.dispensed_at),
    }))

  const bills: BillView[] = (await all(`select b.*,p.name patient_name from bills b join patients p on p.id=b.patient_id
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
      coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=current_date),0) total_available
    from medicines m left join suppliers s on s.id=m.preferred_supplier_id order by m.name`)).map((r) => ({
      id: text(r.id), code: text(r.code), name: text(r.name), strength: text(r.strength), dosageForm: text(r.dosage_form),
      unit: text(r.unit), barcode: text(r.barcode), saleClass: text(r.sale_class) as MedicineView['saleClass'],
      reorderLevel: num(r.reorder_level), targetStock: num(r.target_stock), preferredSupplierId: optional(r.preferred_supplier_id),
      preferredSupplierName: optional(r.preferred_supplier_name), totalAvailable: num(r.total_available), active: flag(r.active),
    }))

  const batches: BatchView[] = (await all(`select b.*,m.name medicine_name,s.name received_from_supplier_name from batches b
    join medicines m on m.id=b.medicine_id left join suppliers s on s.id=b.received_from_supplier_id
    order by m.name,b.expiry`)).map((r) => ({
      id: text(r.id), medicineId: text(r.medicine_id), medicineName: text(r.medicine_name), batchNumber: text(r.batch_number),
      expiry: text(r.expiry), availableQuantity: num(r.available_quantity), mrp: num(r.mrp), purchasePrice: num(r.purchase_price),
      sellingPrice: num(r.selling_price), receivedFromSupplierId: optional(r.received_from_supplier_id),
      receivedFromSupplierName: optional(r.received_from_supplier_name), receivedAt: text(r.received_at),
    }))

  const supplierLinks = await all(
    `select supplier_id, medicine_id from supplier_medicines where active=1`,
  )
  const medicineIdsBySupplier = new Map<string, string[]>()
  for (const link of supplierLinks) {
    const key = text(link.supplier_id)
    const list = medicineIdsBySupplier.get(key)
    if (list) list.push(text(link.medicine_id))
    else medicineIdsBySupplier.set(key, [text(link.medicine_id)])
  }

  const suppliers: SupplierView[] = (await all(`select * from suppliers order by name`)).map((r) => ({
    id: text(r.id), code: text(r.code), name: text(r.name), contactPerson: text(r.contact_person), whatsapp: text(r.whatsapp),
    phone: text(r.phone), email: text(r.email), address: text(r.address), gstin: text(r.gstin), active: flag(r.active),
    medicineIds: medicineIdsBySupplier.get(text(r.id)) ?? [],
  }))

  const allOrderLines = await all(
    `select pol.*, m.name medicine_name from purchase_order_lines pol
       join medicines m on m.id=pol.medicine_id order by m.name`,
  )
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

  const orders: PurchaseOrderView[] = (await all(`select po.*,s.name supplier_name from purchase_orders po
    join suppliers s on s.id=po.supplier_id order by po.created_at desc`)).map((r) => ({
      id: text(r.id), orderNumber: text(r.order_number), supplierId: text(r.supplier_id), supplierName: text(r.supplier_name),
      status: text(r.status) as PurchaseOrderView['status'], requestedDate: text(r.requested_date), messageDraft: text(r.message_draft),
      messageStatus: optional(r.message_status) as PurchaseOrderView['messageStatus'], createdAt: text(r.created_at), placedAt: optional(r.placed_at),
      lines: linesByOrder.get(text(r.id)) ?? [],
    }))

  const otcSales: OtcSaleView[] = (await all(`select id,receipt_number,total,payment_method,created_at,
      json_array_length(lines_json::json) line_count from otc_sales order by created_at desc limit 100`)).map((r) => ({
        id: text(r.id), receiptNumber: text(r.receipt_number), total: num(r.total),
        paymentMethod: text(r.payment_method) as OtcSaleView['paymentMethod'], createdAt: text(r.created_at), lineCount: num(r.line_count),
      }))

  const audits: AuditView[] = session.roles.includes('admin')
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
    doctorPresent: await doctorLoggedIn(),
    whatsapp: whatsappStatus(),
  }
}
