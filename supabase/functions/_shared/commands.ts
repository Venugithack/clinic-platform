import { randomUUID } from 'node:crypto'
import type { PrescriptionItemView, Role, SessionView } from './types.ts'
import { deliveredOrderStatus } from './order-status.ts'
import { hasRole } from './auth.ts'
import { audit, db, isoNow, transaction } from './db.ts'
import { hashPassword } from './password.ts'
import { sendWhatsAppText } from './whatsapp.ts'

type Payload = Record<string, unknown>
type Line = { medicineId: string; quantity: number }

function value(payload: Payload, key: string) {
  const result = payload[key]
  if (result == null || String(result).trim() === '') throw new Error(`${key} is required.`)
  return String(result).trim()
}

function optional(payload: Payload, key: string) {
  return String(payload[key] ?? '').trim()
}

function numberValue(payload: Payload, key: string, minimum = 0) {
  const result = Number(payload[key])
  if (!Number.isFinite(result) || result < minimum) throw new Error(`${key} must be at least ${minimum}.`)
  return result
}

function booleanValue(payload: Payload, key: string) {
  return payload[key] === true || payload[key] === 1 || payload[key] === 'true'
}

/**
 * Six digits, and not a birthday-shaped run of one.
 *
 * The length is fixed rather than a minimum because the lock screen draws six
 * dots and submits on the sixth — a variable-length PIN would need a confirm
 * button, which is a tap every staff member pays hundreds of times a day.
 */
function requirePin(payload: Payload, key: string): string {
  const pin = String(payload[key] ?? '').trim()
  if (!/^\d{6}$/.test(pin)) throw new Error('A PIN is exactly six digits.')
  if (/^(\d)\1{5}$/.test(pin)) throw new Error('That PIN is the same digit six times. Choose another.')
  if ('012345678901234567890'.includes(pin) || '098765432109876543210'.includes(pin)) {
    throw new Error('That PIN is six digits in a row. Choose another.')
  }
  return pin
}

function requireRole(session: SessionView, ...roles: Role[]) {
  if (!hasRole(session, ...roles)) throw new Error('Your role cannot perform this action.')
}

function requireChoice<T extends string>(
  payload: Payload,
  key: string,
  choices: readonly T[],
  fallback?: T,
) {
  // A missing value takes the fallback where one is offered — a medicine added
  // before the schedule field existed should become 'unset', not fail to save.
  const raw = String(payload[key] ?? '').trim()
  if (!raw && fallback !== undefined) return fallback

  const result = value(payload, key) as T
  if (!choices.includes(result)) throw new Error(`${key} is not valid.`)
  return result
}

async function sequence(prefix: string, table: string) {
  const row = await db.prepare(`select count(*) as count from ${table}`).get() as { count: number }
  return `${prefix}-${String(Number(row.count) + 1).padStart(4, '0')}`
}

function parsedLines(payload: Payload): Line[] {
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) throw new Error('Add at least one medicine.')
  return payload.lines.map((entry) => {
    const row = entry as Payload
    const medicineId = value(row, 'medicineId')
    const quantity = Math.floor(numberValue(row, 'quantity', 1))
    return { medicineId, quantity }
  })
}

type Allocation = { batchId: string; batchNumber: string; quantity: number; unitPrice: number }

type BatchRow = {
  id: string
  medicine_id: string
  batch_number: string
  available_quantity: number
  purchase_price: number
  expiry: string
  received_from_supplier_id: string | null
}

/**
 * Remove a quantity from ONE named batch, through the ledger.
 *
 * allocateStock chooses batches by expiry, which is right for dispensing and
 * wrong here: a write-off and a return are always about the particular boxes
 * somebody is holding. The optimistic guard is the same one — the update
 * carries `available_quantity >= ?`, so two tablets acting on the same batch
 * cannot both succeed.
 */
async function removeFromBatch(
  batchId: string,
  quantity: number,
  actorId: string,
  referenceType: string,
  referenceId: string,
): Promise<BatchRow> {
  const batch = (await db
    .prepare(
      `select id,medicine_id,batch_number,available_quantity,purchase_price,expiry,
              received_from_supplier_id
         from batches where id=?`,
    )
    .get(batchId)) as BatchRow | undefined

  if (!batch) throw new Error('That batch was not found.')
  if (quantity > Number(batch.available_quantity)) {
    throw new Error(
      `Only ${batch.available_quantity} left in batch ${batch.batch_number}.`,
    )
  }

  const update = await db
    .prepare(
      `update batches set available_quantity=available_quantity-?,version=version+1
        where id=? and available_quantity>=?`,
    )
    .run(quantity, batchId, quantity)

  if (Number(update.changes) !== 1) {
    throw new Error('Stock changed on another tablet. Please retry.')
  }

  await db
    .prepare(
      `insert into stock_movements
        (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
        values (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      batch.medicine_id,
      batchId,
      referenceType,
      -quantity,
      referenceType,
      referenceId,
      actorId,
      isoNow(),
    )

  return batch
}

async function allocateStock(
  medicineId: string,
  quantity: number,
  actorId: string,
  referenceType: string,
  referenceId: string,
): Promise<Allocation[]> {
  const rows = await db.prepare(`select id,batch_number,available_quantity,selling_price from batches
    where medicine_id=? and available_quantity>0 and expiry::date>=current_date
    order by expiry,id`).all(medicineId) as Array<{
      id: string
      batch_number: string
      available_quantity: number
      selling_price: number
    }>
  const available = rows.reduce((sum, row) => sum + Number(row.available_quantity), 0)
  if (available < quantity) throw new Error(`Only ${available} unit(s) are available.`)

  let remaining = quantity
  const allocations: Allocation[] = []
  for (const row of rows) {
    if (remaining === 0) break
    const used = Math.min(Number(row.available_quantity), remaining)
    const update = await db.prepare(`update batches set available_quantity=available_quantity-?,version=version+1
      where id=? and available_quantity>=?`).run(used, row.id, used)
    if (Number(update.changes) !== 1) throw new Error('Stock changed on another tablet. Please retry.')
    await db.prepare(`insert into stock_movements
      (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
      values (?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), medicineId, row.id, referenceType, -used, referenceType, referenceId, actorId, isoNow(),
      )
    allocations.push({ batchId: row.id, batchNumber: row.batch_number, quantity: used, unitPrice: Number(row.selling_price) })
    remaining -= used
  }
  return allocations
}

function buildOrderDraft(supplierName: string, orderNumber: string, lines: Array<{ name: string; quantity: number }>) {
  const items = lines.map((line, index) => `${index + 1}. ${line.name} — ${line.quantity}`).join('\n')
  return `Hello ${supplierName},\n\nPlease place this order for Jayamurugan Clinic (${orderNumber}):\n${items}\n\nPlease confirm availability and expected delivery. Thank you.`
}

export async function runCommand(session: SessionView, action: string, payload: Payload) {
  switch (action) {
    case 'create_patient': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const id = randomUUID()
      await transaction(async () => {
        await db.prepare(`insert into patients (id,name,age,sex,phone,address,whatsapp_consent,created_at)
          values (?,?,?,?,?,?,?,?)`).run(
            id,
            value(payload, 'name'),
            Math.floor(numberValue(payload, 'age')),
            requireChoice(payload, 'sex', ['female', 'male', 'other'] as const),
            value(payload, 'phone'),
            optional(payload, 'address'),
            booleanValue(payload, 'whatsappConsent') ? 1 : 0,
            isoNow(),
          )
        await audit(session.staffId, 'patient.created', 'patient', id, `Added patient ${value(payload, 'name')}`)
      })
      return { message: 'Patient added.' }
    }

    case 'create_appointment': {
      requireRole(session, 'admin', 'nurse')
      const id = randomUUID()
      await transaction(async () => {
        const token = await sequence('JMC', 'appointments')
        await db.prepare(`insert into appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
          values (?,?,?,?,?,'waiting',?)`).run(
            id, value(payload, 'patientId'), token, value(payload, 'reason'), value(payload, 'scheduledAt'), isoNow(),
          )
        await audit(session.staffId, 'appointment.created', 'appointment', id, `Created appointment ${token}`)
      })
      return { message: 'Appointment added to the queue.' }
    }

    case 'set_appointment_status': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const appointmentId = value(payload, 'appointmentId')
      const status = requireChoice(payload, 'status', ['waiting', 'in_consult', 'done', 'cancelled'] as const)
      await transaction(async () => {
        await db.prepare('update appointments set status=? where id=?').run(status, appointmentId)
        await audit(session.staffId, 'appointment.status', 'appointment', appointmentId, `Appointment marked ${status}`)
      })
      return { message: 'Queue updated.' }
    }

    case 'add_vitals': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const id = randomUUID()
      await transaction(async () => {
        await db.prepare(`insert into vitals
          (id,patient_id,bp,temperature,pulse,spo2,weight,recorded_by,recorded_at)
          values (?,?,?,?,?,?,?,?,?)`).run(
            id, value(payload, 'patientId'), value(payload, 'bp'), numberValue(payload, 'temperature', 30),
            Math.floor(numberValue(payload, 'pulse', 1)), Math.floor(numberValue(payload, 'spo2', 1)),
            numberValue(payload, 'weight', 1), session.staffId, isoNow(),
          )
        await audit(session.staffId, 'vitals.recorded', 'vitals', id, 'Recorded patient vitals')
      })
      return { message: 'Vitals saved.' }
    }

    case 'save_consultation': {
      requireRole(session, 'doctor')
      const encounterId = randomUUID()
      const patientId = value(payload, 'patientId')
      const prescriptionItems = Array.isArray(payload.prescriptionItems)
        ? (payload.prescriptionItems as Payload[]).filter((item) => optional(item, 'medicineId')).map((item) => ({
            medicineId: value(item, 'medicineId'),
            medicineName: value(item, 'medicineName'),
            dosage: value(item, 'dosage'),
            instructions: optional(item, 'instructions'),
            quantity: Math.floor(numberValue(item, 'quantity', 1)),
          })) satisfies PrescriptionItemView[]
        : []
      await transaction(async () => {
        await db.prepare(`insert into encounters
          (id,patient_id,doctor_id,appointment_id,diagnosis,notes,advice,created_at)
          values (?,?,?,?,?,?,?,?)`).run(
            encounterId, patientId, session.staffId, optional(payload, 'appointmentId') || null,
            value(payload, 'diagnosis'), optional(payload, 'notes'), optional(payload, 'advice'), isoNow(),
          )
        if (prescriptionItems.length > 0) {
          const prescriptionId = randomUUID()
          await db.prepare(`insert into prescriptions (id,patient_id,encounter_id,doctor_id,items_json,signed_at)
            values (?,?,?,?,?,?)`).run(
              prescriptionId, patientId, encounterId, session.staffId, JSON.stringify(prescriptionItems), isoNow(),
            )
        }
        if (optional(payload, 'appointmentId')) {
          await db.prepare(`update appointments set status='done' where id=?`).run(optional(payload, 'appointmentId'))
        }
        const fee = Number(payload.consultationFee ?? 0)
        if (fee > 0) {
          await db.prepare(`insert into bills (id,patient_id,label,amount,status,created_at)
            values (?,?,?,?, 'unpaid',?)`).run(randomUUID(), patientId, 'Consultation', fee, isoNow())
        }
        await audit(session.staffId, 'encounter.completed', 'encounter', encounterId, `Consultation saved for ${patientId}`)
      })
      return { message: 'Consultation and prescription saved.' }
    }

    case 'pay_bill': {
      requireRole(session, 'admin', 'nurse', 'pharmacy')
      const billId = value(payload, 'billId')
      const paymentMethod = requireChoice(payload, 'paymentMethod', ['cash', 'upi', 'card'] as const)
      await transaction(async () => {
        const result = await db.prepare(`update bills set status='paid',payment_method=?,paid_at=?
          where id=? and status='unpaid'`).run(paymentMethod, isoNow(), billId)
        if (Number(result.changes) !== 1) throw new Error('This bill is already paid or no longer exists.')
        await audit(session.staffId, 'bill.paid', 'bill', billId, `Payment collected by ${paymentMethod}`)
      })
      return { message: 'Payment recorded.' }
    }

    case 'update_bed': {
      requireRole(session, 'admin', 'nurse')
      const bedId = value(payload, 'bedId')
      const status = requireChoice(payload, 'status', ['available', 'occupied', 'cleaning', 'out_of_service'] as const)
      const patientId = status === 'occupied' ? value(payload, 'patientId') : null
      await transaction(async () => {
        await db.prepare(`update beds set status=?,patient_id=?,admitted_at=?,notes=? where id=?`).run(
          status, patientId, status === 'occupied' ? isoNow() : null, optional(payload, 'notes'), bedId,
        )
        await audit(session.staffId, 'bed.updated', 'bed', bedId, `Bed marked ${status}`)
      })
      return { message: 'Bed board updated.' }
    }

    case 'create_staff': {
      requireRole(session, 'admin')
      const id = randomUUID()
      const roles = Array.isArray(payload.roles)
        ? payload.roles.filter((role): role is Role => ['admin', 'doctor', 'nurse', 'pharmacy'].includes(String(role)))
        : []
      if (roles.length === 0) throw new Error('Choose at least one role.')
      const secret = await hashPassword(requirePin(payload, 'pin'))
      await transaction(async () => {
        await db.prepare(`insert into staff
          (id,name,username,phone,roles_json,pin_hash,pin_salt,active,created_at)
          values (?,?,?,?,?,?,?,1,?)`).run(
            id, value(payload, 'name'), value(payload, 'username').toLowerCase(), optional(payload, 'phone'),
            JSON.stringify(roles), secret.hash, secret.salt, isoNow(),
          )
        await audit(session.staffId, 'staff.created', 'staff', id, `Added ${value(payload, 'name')} as ${roles.join(', ')}`)
      })
      return { message: 'Staff account created.' }
    }

    case 'set_staff_pin': {
      requireRole(session, 'admin')
      const staffId = value(payload, 'staffId')
      const secret = await hashPassword(requirePin(payload, 'pin'))
      await transaction(async () => {
        const changed = await db
          .prepare('update staff set pin_hash=?,pin_salt=? where id=? and active=1')
          .run(secret.hash, secret.salt, staffId)
        if (changed.changes !== 1) throw new Error('That staff member was not found.')

        // Their existing sessions die with the old PIN. Changing a PIN is what
        // somebody does when they think it is known, and leaving a signed-in
        // tablet open would defeat the point of changing it.
        await db.prepare('delete from sessions where staff_id=?').run(staffId)
        await db.prepare('delete from pin_attempts where staff_id=?').run(staffId)
        await audit(session.staffId, 'staff.pin_set', 'staff', staffId, 'Set a new sign-in PIN')
      })
      return { message: 'New PIN saved. They will be asked for it next time.' }
    }

    case 'update_clinic_settings': {
      requireRole(session, 'admin')

      const fee = Number(payload.consultationFee ?? 0)
      if (!Number.isFinite(fee) || fee < 0) throw new Error('The consultation fee cannot be negative.')

      await transaction(async () => {
        await db
          .prepare(
            `update clinic_settings set
               name = ?, address = ?, phone = ?, email = ?,
               drug_licence_number = ?, doctor_registration_number = ?, gstin = ?,
               consultation_fee = ?, footer_note = ?,
               updated_at = ?, updated_by = ?
             where id = 1`,
          )
          .run(
            value(payload, 'name'),
            optional(payload, 'address') ?? '',
            optional(payload, 'phone') ?? '',
            optional(payload, 'email') ?? '',
            optional(payload, 'drugLicenceNumber') ?? '',
            optional(payload, 'doctorRegistrationNumber') ?? '',
            optional(payload, 'gstin') ?? '',
            fee,
            optional(payload, 'footerNote') ?? '',
            isoNow(),
            session.staffId,
          )

        await audit(
          session.staffId,
          'clinic.settings_updated',
          'clinic',
          'settings',
          'Updated the details that print on bills and prescriptions',
        )
      })

      return { message: 'Clinic details saved. They print on bills from now on.' }
    }

    case 'write_off_stock': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const quantity = Math.floor(numberValue(payload, 'quantity', 1))
      const reason = requireChoice(payload, 'reason', ['expiry', 'damage', 'loss'] as const)
      const writeOffId = randomUUID()

      await transaction(async () => {
        const batch = await removeFromBatch(
          batchId,
          quantity,
          session.staffId,
          'writeoff_' + reason,
          writeOffId,
        )

        // The loss is recorded at what the stock cost, not what it would have
        // sold for. Writing off at selling price flatters nothing and overstates
        // the loss to the accountant.
        const costValue = quantity * Number(batch.purchase_price)

        await db
          .prepare(
            `insert into stock_writeoffs
              (id,batch_id,medicine_id,quantity,reason,cost_value,note,actor_id,created_at)
              values (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            writeOffId, batchId, batch.medicine_id, quantity, reason, costValue,
            optional(payload, 'note') ?? '', session.staffId, isoNow(),
          )

        await audit(
          session.staffId,
          'stock.written_off',
          'batch',
          batchId,
          `Wrote off ${quantity} from batch ${batch.batch_number} (${reason}) at ₹${costValue.toFixed(2)}`,
        )
      })

      return { message: 'Written off. The shelf and the ledger agree again.' }
    }

    case 'return_to_supplier': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const quantity = Math.floor(numberValue(payload, 'quantity', 1))
      const returnId = randomUUID()
      let noteNumber = ''

      await transaction(async () => {
        noteNumber = await sequence('RET', 'supplier_returns')

        const batch = await removeFromBatch(
          batchId,
          quantity,
          session.staffId,
          'return_supplier',
          returnId,
        )

        const supplierId = optional(payload, 'supplierId') || batch.received_from_supplier_id
        if (!supplierId) {
          throw new Error('This batch has no supplier recorded, so there is nobody to return it to.')
        }

        // The credit is what was paid, which is what the supplier owes back.
        const expectedCredit = quantity * Number(batch.purchase_price)

        await db
          .prepare(
            `insert into supplier_returns
              (id,note_number,supplier_id,batch_id,medicine_id,quantity,expected_credit,status,note,actor_id,created_at)
              values (?,?,?,?,?,?,?,'sent',?,?,?)`,
          )
          .run(
            returnId, noteNumber, supplierId, batchId, batch.medicine_id, quantity,
            expectedCredit, optional(payload, 'note') ?? '', session.staffId, isoNow(),
          )

        await audit(
          session.staffId,
          'stock.returned',
          'batch',
          batchId,
          `Returned ${quantity} from batch ${batch.batch_number} — credit ₹${expectedCredit.toFixed(2)} expected`,
        )
      })

      return {
        message: `Return note ${noteNumber} raised. The credit stays open until the supplier settles it.`,
        data: { noteNumber },
      }
    }

    case 'settle_return': {
      requireRole(session, 'admin', 'pharmacy')
      const returnId = value(payload, 'returnId')
      const status = requireChoice(payload, 'status', ['credited', 'rejected'] as const)

      await transaction(async () => {
        const changed = await db
          .prepare(`update supplier_returns set status=?, settled_at=? where id=? and status='sent'`)
          .run(status, isoNow(), returnId)

        if (Number(changed.changes) !== 1) {
          throw new Error('That return is not open, or was already settled.')
        }

        await audit(
          session.staffId,
          'stock.return_settled',
          'supplier_return',
          returnId,
          `Return marked ${status}`,
        )
      })

      return { message: status === 'credited' ? 'Credit received.' : 'Return marked rejected.' }
    }

    case 'start_stock_take': {
      requireRole(session, 'admin', 'pharmacy')
      const scope = requireChoice(payload, 'scope', ['full', 'partial'] as const)
      // Optional, because a missing threshold must not fail with a complaint
      // about the threshold when the real answer is "one is already open".
      const threshold =
        (optional(payload, 'recountThreshold') ?? '') === ''
          ? 500
          : numberValue(payload, 'recountThreshold', 0)
      const id = randomUUID()
      let reference = ''

      await transaction(async () => {
        const open = await db
          .prepare("select id from stock_takes where status in ('counting','submitted')")
          .get()
        if (open) throw new Error('A stock-take is already open. Finish or abandon it first.')

        reference = await sequence('ST', 'stock_takes')
        await db
          .prepare(
            `insert into stock_takes
               (id,reference,scope,scope_note,status,recount_threshold,started_at,started_by)
               values (?,?,?,?,'counting',?,?,?)`,
          )
          .run(id, reference, scope, optional(payload, 'scopeNote') ?? '', threshold, isoNow(), session.staffId)

        await audit(session.staffId, 'stocktake.started', 'stock_take', id, `Started ${reference} (${scope})`)
      })

      return { message: `${reference} open. Count the shelf, then submit it.`, data: { id, reference } }
    }

    case 'count_batch': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const counted = Math.floor(numberValue(payload, 'countedQuantity', 0))
      let countNumber = 1

      await transaction(async () => {
        const take = (await db
          .prepare("select id, status from stock_takes where status = 'counting'")
          .get()) as { id: string } | undefined
        if (!take) throw new Error('No stock-take is open for counting.')

        const batch = (await db
          .prepare(
            'select id, medicine_id, available_quantity, purchase_price from batches where id = ?',
          )
          .get(batchId)) as
          | { id: string; medicine_id: string; available_quantity: number; purchase_price: number }
          | undefined
        if (!batch) throw new Error('That batch was not found.')

        // Expected is snapshotted HERE, at the moment of counting, and is never
        // read again. Posting applies (counted - expected) as a delta, so a
        // dispense made between the count and the approval survives instead of
        // being silently erased by a figure that was true an hour ago.
        const expected = Number(batch.available_quantity)
        const variance = counted - expected
        const varianceValue = variance * Number(batch.purchase_price)

        const existing = (await db
          .prepare('select id, count_number from stock_take_lines where stock_take_id = ? and batch_id = ?')
          .get(take.id, batchId)) as { id: string; count_number: number } | undefined

        countNumber = existing ? Number(existing.count_number) + 1 : 1

        if (existing) {
          await db
            .prepare(
              `update stock_take_lines
                  set expected_quantity = ?, counted_quantity = ?, variance = ?,
                      variance_value = ?, count_number = ?, counted_by = ?, counted_at = ?
                where id = ?`,
            )
            .run(expected, counted, variance, varianceValue, countNumber, session.staffId, isoNow(), existing.id)
        } else {
          await db
            .prepare(
              `insert into stock_take_lines
                 (id,stock_take_id,batch_id,medicine_id,expected_quantity,counted_quantity,
                  variance,variance_value,count_number,counted_by,counted_at)
                 values (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              randomUUID(), take.id, batchId, batch.medicine_id, expected, counted,
              variance, varianceValue, 1, session.staffId, isoNow(),
            )
        }
      })

      // Deliberately silent about the variance. Telling the counter they are
      // "3 short" while they are still counting is the anchoring this whole
      // feature exists to avoid.
      return { message: countNumber > 1 ? 'Recount saved.' : 'Counted.' }
    }

    case 'submit_stock_take': {
      requireRole(session, 'admin', 'pharmacy')
      let counted = 0

      await transaction(async () => {
        const take = (await db
          .prepare("select id, reference from stock_takes where status = 'counting'")
          .get()) as { id: string; reference: string } | undefined
        if (!take) throw new Error('No stock-take is open for counting.')

        const [lines] = (await db
          .prepare('select count(*) as count from stock_take_lines where stock_take_id = ?')
          .all(take.id)) as Array<{ count: number }>
        counted = Number(lines.count)
        if (counted === 0) throw new Error('Nothing has been counted yet.')

        await db
          .prepare("update stock_takes set status = 'submitted', submitted_at = ?, submitted_by = ? where id = ?")
          .run(isoNow(), session.staffId, take.id)

        await audit(
          session.staffId, 'stocktake.submitted', 'stock_take', take.id,
          `Submitted ${take.reference} with ${counted} batches counted`,
        )
      })

      return {
        message: `Submitted. ${counted} ${
          counted === 1 ? 'batch' : 'batches'
        } counted — the variance is now visible for approval.`,
      }
    }

    case 'post_stock_take': {
      // The doctor or the owner approves. The person who counted should not be
      // the only person who ever sees the number they are correcting.
      requireRole(session, 'admin', 'doctor')
      let adjusted = 0
      let reference = ''

      await transaction(async () => {
        const take = (await db
          .prepare(
            "select id, reference, recount_threshold from stock_takes where status = 'submitted'",
          )
          .get()) as { id: string; reference: string; recount_threshold: number } | undefined
        if (!take) throw new Error('There is no submitted stock-take to approve.')
        reference = String(take.reference)

        const lines = (await db
          .prepare(
            `select l.*, b.available_quantity, b.batch_number, m.name as medicine_name
               from stock_take_lines l
               join batches b on b.id = l.batch_id
               join medicines m on m.id = l.medicine_id
              where l.stock_take_id = ?`,
          )
          .all(take.id)) as Array<Record<string, unknown>>

        // A big discrepancy is far more often a miscount than a real loss, and
        // posting it destroys the very number you would check it against.
        const owed = lines.filter(
          (l) =>
            Math.abs(Number(l.variance_value)) > Number(take.recount_threshold) &&
            Number(l.count_number) < 2,
        )
        if (owed.length > 0) {
          throw new Error(
            `${owed.length} ${owed.length === 1 ? 'batch needs' : 'batches need'} a second count before this can post: ${owed
              .map((l) => String(l.medicine_name))
              .join(', ')}.`,
          )
        }

        const now = isoNow()
        for (const line of lines) {
          const variance = Number(line.variance)
          if (variance === 0) continue

          // The correction is a DELTA against whatever the batch holds now, not
          // an overwrite with the counted figure. Clamped at zero because a
          // batch cannot hold less than nothing, and the movement records what
          // was actually applied so the ledger still sums to the quantity.
          const current = Number(line.available_quantity)
          const delta = Math.max(variance, -current)
          if (delta === 0) continue

          await db
            .prepare(
              'update batches set available_quantity = available_quantity + ?, version = version + 1 where id = ?',
            )
            .run(delta, String(line.batch_id))

          await db
            .prepare(
              `insert into stock_movements
                (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
                values (?,?,?,'adjust',?,'stock_take',?,?,?)`,
            )
            .run(randomUUID(), String(line.medicine_id), String(line.batch_id), delta, take.id, session.staffId, now)

          adjusted += 1
        }

        await db
          .prepare("update stock_takes set status = 'posted', posted_at = ?, posted_by = ? where id = ?")
          .run(now, session.staffId, take.id)

        await audit(
          session.staffId, 'stocktake.posted', 'stock_take', take.id,
          `Approved ${take.reference} — ${adjusted} of ${lines.length} batches corrected`,
        )
      })

      return {
        message:
          adjusted === 0
            ? `${reference} approved. Every batch counted matched the record.`
            : `${reference} approved. ${adjusted} ${adjusted === 1 ? 'batch' : 'batches'} corrected on the shelf record.`,
      }
    }

    case 'reopen_stock_take': {
      // Sending a sheet back for a second count returns it to 'counting', which
      // hides the variance again. The recount is blind for the same reason the
      // first count was: a counter told they are 40 short will find 40.
      requireRole(session, 'admin', 'doctor', 'pharmacy')
      await transaction(async () => {
        const take = (await db
          .prepare("select id, reference from stock_takes where status = 'submitted'")
          .get()) as { id: string; reference: string } | undefined
        if (!take) throw new Error('There is no submitted stock-take to send back.')

        await db
          .prepare(
            "update stock_takes set status = 'counting', submitted_at = null, submitted_by = null where id = ?",
          )
          .run(take.id)

        await audit(
          session.staffId, 'stocktake.reopened', 'stock_take', take.id,
          `Sent ${take.reference} back for recounting`,
        )
      })

      return { message: 'Sent back for recounting. The variance is hidden again until it is submitted.' }
    }

    case 'abandon_stock_take': {
      requireRole(session, 'admin')
      await transaction(async () => {
        const take = (await db
          .prepare("select id, reference from stock_takes where status in ('counting','submitted')")
          .get()) as { id: string; reference: string } | undefined
        if (!take) throw new Error('There is no open stock-take.')

        await db.prepare("update stock_takes set status = 'abandoned' where id = ?").run(take.id)
        await audit(
          session.staffId, 'stocktake.abandoned', 'stock_take', take.id,
          `Abandoned ${take.reference} — nothing was posted`,
        )
      })

      return { message: 'Abandoned. Nothing was posted, and the shelf record is unchanged.' }
    }

    case 'open_till': {
      requireRole(session, 'admin', 'pharmacy')
      const float = numberValue(payload, 'openingFloat', 0)
      const id = randomUUID()

      await transaction(async () => {
        const open = await db
          .prepare('select id from till_sessions where closed_at is null')
          .get()
        if (open) throw new Error('The till is already open. Close it before opening another.')

        await db
          .prepare(
            `insert into till_sessions (id, opened_at, opened_by, opening_float)
              values (?,?,?,?)`,
          )
          .run(id, isoNow(), session.staffId, float)

        await audit(
          session.staffId,
          'till.opened',
          'till',
          id,
          `Opened the till with ₹${float.toFixed(2)} float`,
        )
      })

      return { message: 'Till open.' }
    }

    case 'record_cash': {
      requireRole(session, 'admin', 'pharmacy')
      const direction = requireChoice(payload, 'direction', ['in', 'out'] as const)
      const amount = numberValue(payload, 'amount', 0.01)
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const till = (await db
          .prepare('select id from till_sessions where closed_at is null')
          .get()) as { id: string } | undefined
        if (!till) throw new Error('The till is not open.')

        await db
          .prepare(
            `insert into cash_movements (id, till_id, direction, amount, reason, actor_id, created_at)
              values (?,?,?,?,?,?,?)`,
          )
          .run(randomUUID(), till.id, direction, amount, reason, session.staffId, isoNow())

        await audit(
          session.staffId,
          'till.cash_' + direction,
          'till',
          till.id,
          `₹${amount.toFixed(2)} ${direction}: ${reason}`,
        )
      })

      return { message: 'Recorded.' }
    }

    case 'close_till': {
      requireRole(session, 'admin', 'pharmacy')
      const counted = numberValue(payload, 'countedCash', 0)
      let variance = 0
      let expected = 0

      await transaction(async () => {
        const till = (await db
          .prepare(
            'select id, opened_at, opening_float from till_sessions where closed_at is null',
          )
          .get()) as { id: string; opened_at: string; opening_float: number } | undefined
        if (!till) throw new Error('The till is not open.')

        const since = String(till.opened_at)
        const now = isoNow()

        // What the drawer should hold: the float, plus every rupee of CASH
        // taken since it opened, plus and minus anything moved by hand. Card
        // and UPI are deliberately excluded — they never touch the drawer, and
        // counting them is how a till appears to be hundreds short every day.
        const [bills] = (await db
          .prepare(
            `select coalesce(sum(amount), 0) as total from bills
               where status = 'paid' and payment_method = 'cash'
                 and paid_at >= ? and paid_at <= ?`,
          )
          .all(since, now)) as Array<{ total: number }>

        const [sales] = (await db
          .prepare(
            `select coalesce(sum(total), 0) as total from otc_sales
               where payment_method = 'cash' and created_at >= ? and created_at <= ?`,
          )
          .all(since, now)) as Array<{ total: number }>

        const [moved] = (await db
          .prepare(
            `select
               coalesce(sum(case when direction = 'in'  then amount else 0 end), 0) as cash_in,
               coalesce(sum(case when direction = 'out' then amount else 0 end), 0) as cash_out
             from cash_movements where till_id = ?`,
          )
          .all(till.id)) as Array<{ cash_in: number; cash_out: number }>

        expected =
          Number(till.opening_float) +
          Number(bills.total) +
          Number(sales.total) +
          Number(moved.cash_in) -
          Number(moved.cash_out)

        variance = counted - expected

        await db
          .prepare(
            `update till_sessions
                set closed_at = ?, closed_by = ?, counted_cash = ?, expected_cash = ?,
                    variance = ?, note = ?
              where id = ?`,
          )
          .run(now, session.staffId, counted, expected, variance, optional(payload, 'note') ?? '', till.id)

        await audit(
          session.staffId,
          'till.closed',
          'till',
          till.id,
          `Counted ₹${counted.toFixed(2)} against ₹${expected.toFixed(2)} expected — ${
            variance === 0 ? 'exact' : (variance > 0 ? 'over' : 'short') + ' by ₹' + Math.abs(variance).toFixed(2)
          }`,
        )
      })

      return {
        message:
          variance === 0
            ? `Till closed. ₹${counted.toFixed(2)} counted, and it balances exactly.`
            : `Till closed. ₹${counted.toFixed(2)} counted against ₹${expected.toFixed(2)} expected — ${
                variance > 0 ? 'over' : 'short'
              } by ₹${Math.abs(variance).toFixed(2)}.`,
        data: { expected, counted, variance },
      }
    }

    case 'toggle_staff': {
      requireRole(session, 'admin')
      const staffId = value(payload, 'staffId')
      if (staffId === session.staffId) throw new Error('You cannot disable your own signed-in account.')
      await transaction(async () => {
        await db.prepare('update staff set active=case active when 1 then 0 else 1 end where id=?').run(staffId)
        await db.prepare('delete from sessions where staff_id=?').run(staffId)
        await audit(session.staffId, 'staff.toggled', 'staff', staffId, 'Changed staff access')
      })
      return { message: 'Staff access updated.' }
    }

    case 'add_supplier': {
      requireRole(session, 'admin', 'pharmacy')
      const id = randomUUID()
      await transaction(async () => {
        await db.prepare(`insert into suppliers
          (id,code,name,contact_person,whatsapp,phone,email,address,gstin,return_window_days,active,created_at)
          values (?,?,?,?,?,?,?,?,?,?,1,?)`).run(
            id, value(payload, 'code').toUpperCase(), value(payload, 'name'), optional(payload, 'contactPerson'),
            value(payload, 'whatsapp'), optional(payload, 'phone'), optional(payload, 'email'),
            optional(payload, 'address'), optional(payload, 'gstin'),
            // 0 means this supplier takes nothing back, which is the safe default:
            // it puts their stock at the top of the write-off list rather than
            // quietly promising a return that will be refused.
            Math.max(0, Math.floor(Number(payload.returnWindowDays ?? 0))),
            isoNow(),
          )
        await audit(session.staffId, 'supplier.created', 'supplier', id, `Added supplier ${value(payload, 'name')}`)
      })
      return { message: 'Supplier added.' }
    }

    case 'set_supplier_medicines': {
      requireRole(session, 'admin', 'pharmacy')
      const supplierId = value(payload, 'supplierId')
      const medicineIds = Array.isArray(payload.medicineIds) ? [...new Set(payload.medicineIds.map(String))] : []
      await transaction(async () => {
        await db.prepare('delete from supplier_medicines where supplier_id=?').run(supplierId)
        const insert = await db.prepare(`insert into supplier_medicines (supplier_id,medicine_id,active) values (?,?,1)`)
        for (const medicineId of medicineIds) {
          insert.run(supplierId, medicineId)
          await db.prepare(`update medicines set preferred_supplier_id=coalesce(preferred_supplier_id,?) where id=?`)
            .run(supplierId, medicineId)
        }
        await audit(session.staffId, 'supplier.medicines', 'supplier', supplierId, `Linked ${medicineIds.length} medicine(s)`)
      })
      return { message: 'Supplier medicine links saved.' }
    }

    case 'add_medicine': {
      requireRole(session, 'admin', 'pharmacy')
      const id = randomUUID()
      const supplierId = optional(payload, 'preferredSupplierId') || null
      const initialQuantity = Math.floor(Number(payload.initialQuantity ?? 0))
      const reorderLevel = Math.floor(numberValue(payload, 'reorderLevel'))
      const targetStock = Math.floor(numberValue(payload, 'targetStock'))
      if (targetStock < reorderLevel) throw new Error('Target stock must be at least the reorder level.')
      await transaction(async () => {
        await db.prepare(`insert into medicines
          (id,code,name,strength,dosage_form,unit,barcode,sale_class,schedule,reorder_level,target_stock,preferred_supplier_id,active,created_at)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, value(payload, 'code').toUpperCase(), value(payload, 'name'), optional(payload, 'strength'),
            optional(payload, 'dosageForm'), value(payload, 'unit'), optional(payload, 'barcode'),
            requireChoice(payload, 'saleClass', ['otc', 'prescription', 'restricted', 'unknown'] as const),
            // Defaults to 'unset' rather than guessing from saleClass. The
            // register would rather report a gap than invent a classification.
            requireChoice(payload, 'schedule', ['unset', 'OTC', 'H', 'H1', 'X'] as const, 'unset'),
            reorderLevel, targetStock,
            supplierId, 1, isoNow(),
          )
        if (supplierId) {
          await db.prepare(`insert into supplier_medicines (supplier_id,medicine_id,active) values (?,?,1)
            on conflict (supplier_id,medicine_id) do update set active=1`)
            .run(supplierId, id)
        }
        if (initialQuantity > 0) {
          const batchId = randomUUID()
          await db.prepare(`insert into batches
            (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,received_from_supplier_id,received_at)
            values (?,?,?,?,?,?,?,?,?,?)`).run(
              batchId, id, value(payload, 'batchNumber'), value(payload, 'expiry'), initialQuantity,
              numberValue(payload, 'mrp'), numberValue(payload, 'purchasePrice'), numberValue(payload, 'sellingPrice'),
              supplierId, isoNow(),
            )
          await db.prepare(`insert into stock_movements
            (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
            values (?,?,?,?,?,?,?,?,?)`).run(
              randomUUID(), id, batchId, 'opening_stock', initialQuantity, 'medicine', id, session.staffId, isoNow(),
            )
        }
        await audit(session.staffId, 'medicine.created', 'medicine', id, `Added ${value(payload, 'name')}`)
      })
      return { message: 'Medicine added to inventory.' }
    }

    case 'otc_sale': {
      requireRole(session, 'admin', 'pharmacy')
      const lines = parsedLines(payload)
      const paymentMethod = requireChoice(payload, 'paymentMethod', ['cash', 'upi', 'card'] as const)
      const saleId = randomUUID()
      let total = 0
      let receiptNumber = ''
      await transaction(async () => {
        receiptNumber = await sequence('OTC', 'otc_sales')
        const saleLines: Array<Line & { name: string; allocations: Allocation[]; lineTotal: number }> = []
        for (const line of lines) {
          const medicine = (await db
            .prepare(`select name,strength,sale_class from medicines where id=? and active=1`)
            .get(line.medicineId)) as { name: string; strength: string; sale_class: string } | undefined
          if (!medicine || medicine.sale_class !== 'otc') throw new Error('Only medicines marked OTC can be sold here.')
          const allocations = await allocateStock(line.medicineId, line.quantity, session.staffId, 'otc_sale', saleId)
          const lineTotal = allocations.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
          total += lineTotal
          saleLines.push({ ...line, name: `${medicine.name} ${medicine.strength}`.trim(), allocations, lineTotal })
        }
        await db.prepare(`insert into otc_sales
          (id,receipt_number,total,payment_method,lines_json,created_by,created_at) values (?,?,?,?,?,?,?)`).run(
            saleId, receiptNumber, total, paymentMethod, JSON.stringify(saleLines), session.staffId, isoNow(),
          )
        await audit(session.staffId, 'otc.sale', 'otc_sale', saleId, `${receiptNumber} collected ₹${total.toFixed(2)}`)
      })
      return { message: 'Anonymous OTC sale completed.', data: { saleId, receiptNumber, total } }
    }

    case 'dispense_rx': {
      requireRole(session, 'admin', 'pharmacy')
      const prescriptionId = value(payload, 'prescriptionId')
      await transaction(async () => {
        const prescription = await db.prepare(`select items_json,dispensed_at from prescriptions where id=?`)
          .get(prescriptionId) as { items_json: string; dispensed_at: string | null } | undefined
        if (!prescription) throw new Error('Prescription was not found.')
        if (prescription.dispensed_at) throw new Error('This prescription is already dispensed.')
        const items = JSON.parse(prescription.items_json) as PrescriptionItemView[]
        for (const item of items) {
          allocateStock(item.medicineId, item.quantity, session.staffId, 'prescription', prescriptionId)
        }
        await db.prepare('update prescriptions set dispensed_at=? where id=? and dispensed_at is null').run(isoNow(), prescriptionId)
        await audit(session.staffId, 'prescription.dispensed', 'prescription', prescriptionId, `Dispensed ${items.length} item(s)`)
      })
      return { message: 'Prescription dispensed using earliest-expiry stock.' }
    }

    case 'create_order': {
      requireRole(session, 'admin', 'pharmacy')
      const supplierId = value(payload, 'supplierId')
      const suppliedLines = Array.isArray(payload.lines) ? parsedLines(payload) : []
      const orderId = randomUUID()
      let orderNumber = ''
      await transaction(async () => {
        const supplier = await db.prepare('select name from suppliers where id=? and active=1').get(supplierId) as { name: string } | undefined
        if (!supplier) throw new Error('Choose an active supplier.')
        const lines = suppliedLines.length > 0 ? suppliedLines : (await db.prepare(`select m.id medicineId,m.name,
          greatest(m.target_stock-coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=current_date),0),1) quantity
          from medicines m join supplier_medicines sm on sm.medicine_id=m.id and sm.supplier_id=? and sm.active=1
          where m.active=1 and coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=current_date),0)<=m.reorder_level
          group by m.id`).all(supplierId) as Array<{ medicineId: string; quantity: number }>)
        if (lines.length === 0) throw new Error('No low-stock medicines are linked to this supplier.')
        const namedLines: Array<{ medicineId: string; quantity: number; name: string }> = []
        for (const line of lines) {
          const medicine = (await db
            .prepare('select name,strength from medicines where id=?')
            .get(line.medicineId)) as { name: string; strength: string } | undefined
          if (!medicine) throw new Error('An order medicine was not found.')
          namedLines.push({ ...line, name: `${medicine.name} ${medicine.strength}`.trim() })
        }
        orderNumber = await sequence('PO', 'purchase_orders')
        const draft = buildOrderDraft(supplier.name, orderNumber, namedLines)
        await db.prepare(`insert into purchase_orders
          (id,order_number,supplier_id,status,requested_date,message_draft,created_by,created_at)
          values (?,?,?,'pending',?,?,?,?)`).run(
            orderId, orderNumber, supplierId, isoNow().slice(0, 10), draft, session.staffId, isoNow(),
          )
        const insert = await db.prepare(`insert into purchase_order_lines
          (id,order_id,medicine_id,ordered_quantity,received_quantity) values (?,?,?,?,0)`)
        for (const line of namedLines) insert.run(randomUUID(), orderId, line.medicineId, line.quantity)
        await audit(session.staffId, 'order.created', 'purchase_order', orderId, `Drafted ${orderNumber} for ${supplier.name}`)
      })
      return { message: 'Reorder draft created.', data: { orderId, orderNumber } }
    }

    case 'send_order': {
      requireRole(session, 'admin', 'pharmacy')
      const orderId = value(payload, 'orderId')
      const order = await db.prepare(`select po.message_draft,s.whatsapp from purchase_orders po
        join suppliers s on s.id=po.supplier_id where po.id=? and po.status='pending'`).get(orderId) as
        | { message_draft: string; whatsapp: string }
        | undefined
      if (!order) throw new Error('Only a pending order can be sent.')
      const messageDraft = optional(payload, 'messageDraft') || order.message_draft
      const result = await sendWhatsAppText(order.whatsapp, messageDraft)
      if (!result.ok) throw new Error(result.error)
      await transaction(async () => {
        await db.prepare(`update purchase_orders set status='placed',message_draft=?,external_message_id=?,message_status='sent',placed_at=? where id=?`)
          .run(messageDraft, result.messageId, isoNow(), orderId)
        await db.prepare(`insert into whatsapp_messages
          (id,direction,audience,phone,body,external_message_id,status,related_type,related_id,created_at)
          values (?,'outbound','supplier',?,?,?,'sent','purchase_order',?,?)`).run(
            randomUUID(), order.whatsapp, messageDraft, result.messageId, orderId, isoNow(),
          )
        await audit(session.staffId, 'order.sent', 'purchase_order', orderId, 'Supplier order sent on WhatsApp')
      })
      return { message: 'Order sent and marked placed.' }
    }

    case 'update_order_draft': {
      requireRole(session, 'admin', 'pharmacy')
      const orderId = value(payload, 'orderId')
      const messageDraft = value(payload, 'messageDraft')
      await transaction(async () => {
        const result = await db.prepare(`update purchase_orders set message_draft=? where id=? and status='pending'`)
          .run(messageDraft, orderId)
        if (Number(result.changes) !== 1) throw new Error('Only a pending order draft can be edited.')
        await audit(session.staffId, 'order.draft_updated', 'purchase_order', orderId, 'Updated supplier message draft')
      })
      return { message: 'Order message draft saved.' }
    }

    case 'receive_order': {
      requireRole(session, 'admin', 'pharmacy')
      const orderId = value(payload, 'orderId')
      if (!Array.isArray(payload.receipts) || payload.receipts.length === 0) throw new Error('Enter at least one received line.')
      await transaction(async () => {
        const order = await db.prepare(`select supplier_id,status from purchase_orders where id=?`).get(orderId) as
          | { supplier_id: string; status: string }
          | undefined
        if (!order || !['placed', 'partially_delivered'].includes(order.status)) throw new Error('This order is not awaiting delivery.')
        for (const entry of payload.receipts as Payload[]) {
          const lineId = value(entry, 'lineId')
          const quantity = Math.floor(numberValue(entry, 'quantity', 1))
          const line = await db.prepare(`select medicine_id,ordered_quantity,received_quantity from purchase_order_lines
            where id=? and order_id=?`).get(lineId, orderId) as
            | { medicine_id: string; ordered_quantity: number; received_quantity: number }
            | undefined
          if (!line || Number(line.received_quantity) + quantity > Number(line.ordered_quantity)) {
            throw new Error('Received quantity exceeds the remaining order quantity.')
          }
          const batchId = randomUUID()
          await db.prepare(`insert into batches
            (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,received_from_supplier_id,received_at)
            values (?,?,?,?,?,?,?,?,?,?)`).run(
              batchId, line.medicine_id, value(entry, 'batchNumber'), value(entry, 'expiry'), quantity,
              numberValue(entry, 'mrp'), numberValue(entry, 'purchasePrice'), numberValue(entry, 'sellingPrice'),
              order.supplier_id, isoNow(),
            )
          await db.prepare('update purchase_order_lines set received_quantity=received_quantity+? where id=?').run(quantity, lineId)
          await db.prepare(`insert into stock_movements
            (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
            values (?,?,?,?,?,?,?,?,?)`).run(
              randomUUID(), line.medicine_id, batchId, 'purchase_receipt', quantity, 'purchase_order', orderId, session.staffId, isoNow(),
            )
        }
        const totals = await db.prepare(`select sum(ordered_quantity) ordered,sum(received_quantity) received
          from purchase_order_lines where order_id=?`).get(orderId) as { ordered: number; received: number }
        const status = deliveredOrderStatus(Number(totals.ordered), Number(totals.received))
        await db.prepare('update purchase_orders set status=? where id=?').run(status, orderId)
        await audit(session.staffId, 'order.received', 'purchase_order', orderId, `Order marked ${status}`)
      })
      return { message: 'Delivery received and stock updated.' }
    }

    case 'send_patient_whatsapp': {
      requireRole(session, 'admin', 'doctor', 'nurse', 'pharmacy')
      const patientId = value(payload, 'patientId')
      const patient = await db.prepare('select name,phone,whatsapp_consent from patients where id=?').get(patientId) as
        | { name: string; phone: string; whatsapp_consent: number }
        | undefined
      if (!patient) throw new Error('Patient was not found.')
      if (!patient.whatsapp_consent) throw new Error('WhatsApp consent is not recorded for this patient.')
      const body = value(payload, 'body')
      const result = await sendWhatsAppText(patient.phone, body)
      if (!result.ok) throw new Error(result.error)
      await db.prepare(`insert into whatsapp_messages
        (id,direction,audience,phone,body,external_message_id,status,related_type,related_id,created_at)
        values (?,'outbound','patient',?,?,?,'sent','patient',?,?)`).run(
          randomUUID(), patient.phone, body, result.messageId, patientId, isoNow(),
        )
      await audit(session.staffId, 'patient.whatsapp', 'patient', patientId, `Sent WhatsApp message to ${patient.name}`)
      return { message: 'Patient message sent.' }
    }

    default:
      throw new Error('Unknown action.')
  }
}
