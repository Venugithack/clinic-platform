import { randomUUID } from 'node:crypto'
import type { PrescriptionItemView, Role, SessionView } from './types.ts'
import { deliveredOrderStatus } from './order-status.ts'
import { hasRole } from './auth.ts'
import { audit, db, isoNow, transaction } from './db.ts'
import { hashPassword } from './password.ts'
import { sendWhatsAppText } from './whatsapp.ts'

/**
 * Today, in the clinic rather than in Greenwich.
 *
 * The server keeps UTC and runs five and a half hours behind the clinic, so
 * every expiry comparison below was deciding whether a batch was still fit to
 * dispense against yesterday's date until half past five each morning — and a
 * batch that expired last night stayed sellable through exactly the stretch
 * when the pharmacy is being opened up. `snapshot.ts` builds the same
 * expression for the shelf figure it puts on the screen; the number a dispense
 * is checked against has to be the number the screen showed.
 */
const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

type Payload = Record<string, unknown>
type Line = { medicineId: string; quantity: number }

type StructuredLine = PrescriptionItemView & {
  genericName: string
  strength: string
  dosageForm: string
  route: string
  medicineCode: string
  doseAmount: string
  doseUnit: string
  frequency: string
  timing: string
  durationValue?: number
  durationUnit?: 'day' | 'week' | 'month'
  quantityUnit: string
}

type ClinicalFields = {
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
}

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

function optionalPositiveInteger(payload: Payload, key: string): number | undefined {
  const raw = optional(payload, key)
  if (!raw) return undefined
  const result = Number(raw)
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${key} must be a whole number above zero.`)
  return result
}

function optionalDate(payload: Payload, key: string): string | undefined {
  const result = optional(payload, key)
  if (!result) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error(`${key} is not a valid date.`)
  }
  return result
}

function clinicalFields(payload: Payload, requireDiagnosis: boolean): ClinicalFields {
  const diagnosis = optional(payload, 'diagnosis')
  if (requireDiagnosis && !diagnosis) throw new Error('diagnosis is required.')
  const complaintDurationValue = optionalPositiveInteger(payload, 'complaintDurationValue')
  const complaintDurationUnit = optional(payload, 'complaintDurationUnit')
  if (complaintDurationValue && !['day', 'week', 'month'].includes(complaintDurationUnit)) {
    throw new Error('Choose whether the duration is in days, weeks, or months.')
  }
  return {
    complaint: optional(payload, 'complaint'),
    complaintDurationValue,
    complaintDurationUnit: complaintDurationValue
      ? (complaintDurationUnit as ClinicalFields['complaintDurationUnit'])
      : undefined,
    examination: optional(payload, 'examination'),
    diagnosis,
    diagnosisStatus: requireChoice(
      payload,
      'diagnosisStatus',
      ['provisional', 'differential', 'confirmed'] as const,
      'provisional',
    ),
    aetiology: optional(payload, 'aetiology'),
    aetiologyCertainty: requireChoice(
      payload,
      'aetiologyCertainty',
      ['not_stated', 'suspected', 'confirmed'] as const,
      'not_stated',
    ),
    notes: optional(payload, 'notes'),
    advice: optional(payload, 'advice'),
    followUpDate: optionalDate(payload, 'followUpDate'),
  }
}

/**
 * Four digits, and not a birthday-shaped run of one.
 *
 * ── WHY FOUR, AND WHAT HAS TO BE TRUE FOR THAT TO BE ALL RIGHT ─────────────
 *
 * The owner asked for four; six was slowing down a person who signs in dozens
 * of times a day. Four digits is ten thousand combinations, which is not a
 * password and was never treated as one. `TABLET.md` §5 lists what has to hold
 * for it to be acceptable, and every item on that list is already here and
 * must stay here: one PIN per staff member, wrong attempts throttled
 * server-side and charged to the caller, salted scrypt at Node's default cost,
 * a thirty-minute idle expiry, every session revoked on reset, an audit event
 * per write, and weak patterns refused. Four digits plus five attempts per
 * fifteen minutes is a different proposition from four digits alone.
 *
 * The length is fixed rather than a minimum because the lock screen draws the
 * dots and submits on the last one — a variable-length PIN needs a confirm
 * button, which is a tap every staff member pays hundreds of times a day.
 *
 * This is the rule for SETTING a PIN, so it is four and only four. Signing in
 * with an old six-digit PIN still works until that person is reset; that lives
 * in auth.ts, against the format recorded on their row.
 */
function requirePin(payload: Payload, key: string): string {
  const pin = String(payload[key] ?? '').trim()
  if (!/^\d{4}$/.test(pin)) throw new Error('A PIN is exactly four digits.')
  if (/^(\d)\1{3}$/.test(pin)) throw new Error('That PIN is the same digit four times. Choose another.')
  // The runs wrap deliberately, so 8901 and 1098 are refused too — they are
  // the same keypad gesture as 1234, and with only ten thousand combinations
  // there is no reason to leave the obvious ones available.
  if ('012345678901234567890'.includes(pin) || '098765432109876543210'.includes(pin)) {
    throw new Error('That PIN is four digits in a row. Choose another.')
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

/**
 * The next number in a printed series — OTC-0008, PO-0042, JMC-0004.
 *
 * This used to count the rows in the table and add one, which fails in two
 * different ways that both end at the same place. Two tablets ringing up a sale
 * in the same second read the same count and mint the same receipt number; the
 * second insert dies on the unique index and the counter is told "The request
 * could not be completed." for a sale that was perfectly good. And a deleted
 * row lowers the count, so the series walks backwards over numbers that are
 * already printed on paper and written in somebody's ledger.
 *
 * Queue tokens are the quiet half of the same bug. `appointments.token` carries
 * no unique index, so nothing objects at all: two waiting patients simply hold
 * the same number, and one of them is called in for the other's consultation.
 *
 * A Postgres sequence hands each number to exactly one caller no matter what
 * else is happening, and it does so OUTSIDE the transaction — a sale that rolls
 * back burns its number and leaves a gap in the receipts. That is the right way
 * round: a missing number is a question somebody asks, a repeated one is two
 * documents that cannot be told apart afterwards.
 */
const SERIES = {
  JMC: 'appointment_token_seq',
  OTC: 'otc_receipt_seq',
  PO: 'purchase_order_seq',
  RET: 'supplier_return_seq',
  ST: 'stock_take_seq',
  RX: 'prescription_number_seq',
} as const

async function sequence(prefix: keyof typeof SERIES) {
  // A bigint arrives as a string, and padStart wants one anyway. Four digits is
  // the floor rather than the width: the series is allowed to outgrow it, and
  // OTC-10000 is still readable where a wrapped number would not be.
  const row = (await db
    .prepare(`select nextval('jmc.${SERIES[prefix]}') as value`)
    .get()) as { value: string | number }
  return `${prefix}-${String(row.value).padStart(prefix === 'RX' ? 6 : 4, '0')}`
}

/**
 * One shape for a moment in time, whoever wrote it.
 *
 * `appointments.scheduled_at` is TEXT and the queue is `order by
 * scheduled_at`, so the ordering is a string comparison — which is fine while
 * every value has the same shape and silently wrong the moment two do not.
 *
 * Two do. The desk form is an `<input type="datetime-local">` and sends
 * `2026-09-11T10:30`, local and with no zone. Everything written in code
 * sends `new Date().toISOString()` — `2026-09-11T05:30:00.000Z`, UTC and five
 * and a half hours behind the clinic. Sorted as text, `2026-09-11T0…` beats
 * `2026-09-11T1…`, so an eleven o'clock walk-in booked from Consult comes out
 * ABOVE a quarter-past-nine appointment booked at the desk, and a patient is
 * called in out of turn. Nothing errors and the queue simply looks wrong.
 *
 * So both are normalised here, on the way in, to the ISO-UTC shape the rest
 * of the schema uses. A value carrying a zone is taken at its word; a naive
 * one is read as clinic time, because the person who typed it into a tablet
 * in Chennai meant Chennai.
 *
 * Postgres does the conversion rather than JavaScript: `Date` parses a naive
 * string as the RUNTIME's local zone, and the runtime here is UTC, so doing
 * it in JS would move every desk appointment five and a half hours.
 *
 * ── AND THE PARAMETER IS FORCED TO text FIRST ──────────────────────────────
 *
 * `?::timestamp` looks like it says the same thing as `(?::text)::timestamp`
 * and does not. Given the first, the driver decides the parameter is a
 * timestamp, parses the string in JavaScript and sends the result in UTC — so
 * '09:15' arrives already converted as 03:45, and the `at time zone` below
 * then shifts it a second time and books the patient for a quarter to four in
 * the morning. Measured, not guessed: the round trip returns 03:45 through
 * the first form and 09:15 through the second. Casting from text hands
 * Postgres the characters that were typed and nothing else.
 */
async function clinicInstant(raw: string): Promise<string> {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
  const row = (await db
    .prepare(
      hasZone
        // Already absolute. Re-rendered so the text shape matches everything else.
        ? `select to_char(((?::text)::timestamptz) at time zone 'utc',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`
        // Naive, and therefore clinic-local.
        : `select to_char((((?::text)::timestamp) at time zone 'Asia/Kolkata') at time zone 'utc',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
    )
    .get(raw)) as { at: string } | undefined

  if (!row?.at) throw new Error('scheduledAt is not a time.')
  return row.at
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

function normalizedPhrase(input: string): string {
  return input.trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ')
}

async function structuredPrescriptionItems(payload: Payload): Promise<StructuredLine[]> {
  if (!Array.isArray(payload.prescriptionItems)) return []

  const result: StructuredLine[] = []
  for (const entry of payload.prescriptionItems as Payload[]) {
    if (!optional(entry, 'medicineId')) continue
    const medicineId = value(entry, 'medicineId')
    const medicine = (await db
      .prepare(`select id,code,name,generic_name,strength,dosage_form,route,unit
          from medicines where id=? and active=1`)
      .get(medicineId)) as {
        id: string
        code: string
        name: string
        generic_name: string
        strength: string
        dosage_form: string
        route: string
        unit: string
      } | undefined
    if (!medicine) throw new Error('A selected medicine is inactive or no longer exists.')

    const durationValue = optionalPositiveInteger(entry, 'durationValue')
    const durationUnit = optional(entry, 'durationUnit')
    if (durationValue && !['day', 'week', 'month'].includes(durationUnit)) {
      throw new Error('Choose whether the medicine duration is in days, weeks, or months.')
    }
    const doseAmount = optional(entry, 'doseAmount')
    const doseUnit = optional(entry, 'doseUnit')
    const frequency = optional(entry, 'frequency')
    const timing = optional(entry, 'timing')
    const route = optional(entry, 'route') || medicine.route
    const dosage = optional(entry, 'dosage') || [doseAmount && `${doseAmount} ${doseUnit}`.trim(), frequency, timing]
      .filter(Boolean)
      .join(' · ')

    result.push({
      medicineId,
      medicineName: `${medicine.name} ${medicine.strength}`.trim(),
      genericName: medicine.generic_name,
      strength: medicine.strength,
      dosageForm: medicine.dosage_form,
      route,
      medicineCode: medicine.code,
      doseAmount,
      doseUnit,
      frequency,
      timing,
      durationValue,
      durationUnit: durationValue ? durationUnit as StructuredLine['durationUnit'] : undefined,
      dosage,
      instructions: optional(entry, 'instructions'),
      quantity: Math.floor(numberValue(entry, 'quantity', 1)),
      quantityUnit: medicine.unit || 'unit',
    })
  }
  return result
}

async function insertDraftLines(draftId: string, items: StructuredLine[]) {
  for (const [index, item] of items.entries()) {
    await db.prepare(`insert into consultation_draft_lines
      (id,draft_id,line_number,medicine_id,dose_amount,dose_unit,frequency,timing,route,
       duration_value,duration_unit,dosage_text,instructions,prescribed_quantity)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), draftId, index + 1, item.medicineId, item.doseAmount, item.doseUnit,
        item.frequency, item.timing, item.route, item.durationValue ?? null,
        item.durationUnit ?? null, item.dosage, item.instructions, item.quantity,
      )
  }
}

async function insertTemplateLines(templateId: string, items: StructuredLine[]) {
  for (const [index, item] of items.entries()) {
    await db.prepare(`insert into consultation_template_lines
      (id,template_version_id,line_number,medicine_id,dose_amount,dose_unit,frequency,timing,route,
       duration_value,duration_unit,dosage_text,instructions,prescribed_quantity)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), templateId, index + 1, item.medicineId, item.doseAmount, item.doseUnit,
        item.frequency, item.timing, item.route, item.durationValue ?? null,
        item.durationUnit ?? null, item.dosage, item.instructions, item.quantity,
      )
  }
}

async function insertSignedLines(prescriptionId: string, items: StructuredLine[]) {
  for (const [index, item] of items.entries()) {
    await db.prepare(`insert into prescription_lines
      (id,prescription_id,line_number,medicine_id,medicine_name_snapshot,generic_name_snapshot,
       strength_snapshot,dosage_form_snapshot,route_snapshot,medicine_code_snapshot,
       dose_amount,dose_unit,frequency,timing,duration_value,duration_unit,dosage_text,
       instructions,prescribed_quantity,quantity_unit)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), prescriptionId, index + 1, item.medicineId, item.medicineName,
        item.genericName, item.strength, item.dosageForm, item.route, item.medicineCode,
        item.doseAmount, item.doseUnit, item.frequency, item.timing,
        item.durationValue ?? null, item.durationUnit ?? null, item.dosage,
        item.instructions, item.quantity, item.quantityUnit,
      )
  }
}

async function rememberClinicalPhrases(doctorId: string, fields: ClinicalFields, items: StructuredLine[]) {
  const phrases: Array<{ kind: string; text: string }> = [
    { kind: 'complaint', text: fields.complaint },
    { kind: 'examination', text: fields.examination },
    { kind: 'diagnosis', text: fields.diagnosis },
    { kind: 'advice', text: fields.advice },
    ...items.map((item) => ({ kind: 'instruction', text: item.instructions })),
  ].filter((item) => item.text.trim().length > 0)

  for (const phrase of phrases) {
    await db.prepare(`insert into clinical_phrase_preferences
      (doctor_id,kind,display_text,normalized_text,favourite,use_count,last_used_at)
      values (?,?,?,?,0,1,now())
      on conflict (doctor_id,kind,normalized_text) do update
      set display_text=excluded.display_text,
          use_count=clinical_phrase_preferences.use_count+1,
          last_used_at=excluded.last_used_at`).run(
        doctorId, phrase.kind, phrase.text, normalizedPhrase(phrase.text),
      )
  }
}

async function requireActiveAppointment(patientId: string, appointmentId: string) {
  if (!appointmentId) return
  const appointment = await db.prepare(`select id from appointments
    where id=? and patient_id=? and status in ('waiting','in_consult') for update`)
    .get(appointmentId, patientId)
  if (!appointment) {
    throw new Error('That visit is already finished or does not belong to this patient.')
  }
}

async function completeConsultation(session: SessionView, payload: Payload) {
  const encounterId = randomUUID()
  const signedAt = isoNow()
  const patientId = value(payload, 'patientId')
  const fields = clinicalFields(payload, true)
  const prescriptionItems = await structuredPrescriptionItems(payload)
  let prescriptionId: string | undefined
  let prescriptionNumber: string | undefined

  await transaction(async () => {
    const appointmentId = optional(payload, 'appointmentId')
    await requireActiveAppointment(patientId, appointmentId)
    await db.prepare(`insert into encounters
      (id,patient_id,doctor_id,appointment_id,diagnosis,notes,advice,created_at,
       complaint,complaint_duration_value,complaint_duration_unit,examination,
       diagnosis_status,aetiology,aetiology_certainty,follow_up_date)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        encounterId, patientId, session.staffId, optional(payload, 'appointmentId') || null,
        fields.diagnosis, fields.notes, fields.advice, signedAt, fields.complaint,
        fields.complaintDurationValue ?? null, fields.complaintDurationUnit ?? null,
        fields.examination, fields.diagnosisStatus, fields.aetiology,
        fields.aetiologyCertainty, fields.followUpDate ?? null,
      )

    if (prescriptionItems.length > 0) {
      prescriptionId = randomUUID()
      prescriptionNumber = await sequence('RX')
      await db.prepare(`insert into prescriptions
        (id,patient_id,encounter_id,doctor_id,items_json,signed_at,prescription_number)
        values (?,?,?,?,?,?,?)`).run(
          prescriptionId, patientId, encounterId, session.staffId,
          JSON.stringify(prescriptionItems), signedAt, prescriptionNumber,
        )
      await insertSignedLines(prescriptionId, prescriptionItems)
    }

    if (appointmentId) {
      await db.prepare(`update appointments set status='done' where id=?`).run(appointmentId)
    }

    if (fields.followUpDate) {
      await db.prepare(`insert into follow_ups
        (id,patient_id,encounter_id,doctor_id,due_date,note,status,created_at)
        values (?,?,?,?,?,?,'open',now())`).run(
          randomUUID(), patientId, encounterId, session.staffId, fields.followUpDate,
          optional(payload, 'followUpNote') || fields.advice,
        )
    }

    // Slice 4 replaces this client-provided fee with the configured fee
    // snapshot and waiver rules. Slice 2 preserves current billing behaviour.
    const fee = Number(payload.consultationFee ?? 0)
    if (fee > 0) {
      await db.prepare(`insert into bills (id,patient_id,label,amount,status,created_at)
        values (?,?,?,?, 'unpaid',?)`).run(randomUUID(), patientId, 'Consultation', fee, signedAt)
    }

    await rememberClinicalPhrases(session.staffId, fields, prescriptionItems)
    await db.prepare('delete from consultation_drafts where patient_id=? and doctor_id=?')
      .run(patientId, session.staffId)
    await audit(
      session.staffId,
      'encounter.completed',
      'encounter',
      encounterId,
      `Signed consultation for ${patientId}${prescriptionNumber ? ` as ${prescriptionNumber}` : ''}`,
    )
  })

  return {
    message: prescriptionId ? 'Consultation and prescription signed.' : 'Consultation signed.',
    data: { encounterId, prescriptionId, prescriptionNumber, signedAt },
  }
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
    where medicine_id=? and available_quantity>0 and expiry::date>=${CLINIC_TODAY}
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
    /**
     * Who might this already be?
     *
     * Asked before a patient is created, never instead of creating one. It
     * returns candidates and takes no action: the plan is explicit that the
     * clinic never merges patient records automatically, and a duplicate that
     * a person decided to create is a smaller problem than two histories
     * silently joined into one.
     *
     * A read, so it is outside `transaction()` and bumps no revision.
     */
    case 'find_possible_duplicates': {
      requireRole(session, 'admin', 'doctor', 'nurse')
      const name = optional(payload, 'name')
      // Last ten digits. The same person is '+91 98765 43210' to the nurse,
      // '9876543210' to the doctor and '098765 43210' on the referral slip,
      // and matching those as strings finds nothing.
      const digits = optional(payload, 'phone').replace(/\D/g, '').slice(-10)
      const age = Number(payload.age)

      if (name.length < 2 && digits.length < 6) return { message: 'Nothing to match on.', data: { matches: [] } }

      const matches = await db
        .prepare(
          `select id, name, age, sex, phone, created_at,
                  case
                    when ?::text <> '' and right(regexp_replace(phone, '\\D', '', 'g'), 10) = ?::text then 'phone'
                    else 'name'
                  end as matched_on
             from patients
            where (?::text <> '' and right(regexp_replace(phone, '\\D', '', 'g'), 10) = ?::text)
               or (?::text <> ''
                    and lower(regexp_replace(name, '\\s+', ' ', 'g'))
                      = lower(regexp_replace(?::text, '\\s+', ' ', 'g')))
            order by created_at desc
            limit 5`,
        )
        .all(
          digits.length >= 6 ? digits : '', digits.length >= 6 ? digits : '',
          digits.length >= 6 ? digits : '', digits.length >= 6 ? digits : '',
          name.length >= 2 ? name.trim() : '', name.length >= 2 ? name.trim() : '',
        )

      return {
        // Nothing changed, so /command must not answer with a whole new
        // snapshot. This runs debounced while somebody types a name, and a
        // full clinic download per keystroke on clinic wifi is the difference
        // between a type-ahead and a type-and-wait.
        unchanged: true,
        message: matches.length === 0 ? 'No existing patient matches.' : `${matches.length} possible match(es).`,
        data: {
          matches: matches.map((row) => ({
            id: String(row.id),
            name: String(row.name),
            age: Number(row.age),
            sex: String(row.sex),
            phone: String(row.phone),
            createdAt: String(row.created_at),
            matchedOn: String(row.matched_on),
            // Shown next to a candidate so the nurse can tell "same name,
            // different person" from "same person" without opening the record.
            ageMatches: Number.isFinite(age) ? Math.abs(Number(row.age) - age) <= 2 : undefined,
          })),
        },
      }
    }

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
      // The doctor is here because of the nurse's day off.
      //
      // He could already register a patient and record their vitals; the one
      // thing he could not do was put them in the queue, which meant that on
      // a day without a nurse the clinic's own doctor had to borrow somebody
      // else's account to see a patient — and every write for the rest of
      // that visit was then attributed to whoever's account it was. A
      // capability gap that is worked around with a shared login is worse
      // than the capability.
      //
      // Signing the consultation stays doctor-only, and an admin who is not
      // also a doctor still cannot sign one. Authority follows the clinical
      // role; this is about who may start the visit, not who may treat.
      requireRole(session, 'admin', 'doctor', 'nurse')
      const id = randomUUID()
      // Normalised before the transaction opens: it is a read, it cannot fail
      // in a way the transaction should roll back, and a bad time should be
      // refused before a token number is burnt on it.
      const scheduledAt = await clinicInstant(value(payload, 'scheduledAt'))
      await transaction(async () => {
        const token = await sequence('JMC')
        await db.prepare(`insert into appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
          values (?,?,?,?,?,'waiting',?)`).run(
            id, value(payload, 'patientId'), token, value(payload, 'reason'), scheduledAt, isoNow(),
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

      /**
       * A reading that was taken, or nothing.
       *
       * Every one of these was required until now, so a doctor working alone
       * with no pulse oximeter to hand could save all five or none. What
       * happens then is not that he goes and finds an oximeter: he types 98,
       * because it usually is, and the record acquires a measurement nobody
       * took. A missing reading is a gap somebody can fill in later; an
       * invented one is indistinguishable from a real one forever.
       *
       * So absent means NOT MEASURED and is stored as NULL. An out-of-range
       * value is still refused — the point is to allow a blank, not to stop
       * checking the numbers that are there.
       */
      const reading = (key: string, minimum: number, whole = false) => {
        const raw = payload[key]
        if (raw == null || String(raw).trim() === '') return null
        const measured = numberValue(payload, key, minimum)
        return whole ? Math.floor(measured) : measured
      }
      const bp = optional(payload, 'bp') || null
      const temperature = reading('temperature', 30)
      const pulse = reading('pulse', 1, true)
      const spo2 = reading('spo2', 1, true)
      const weight = reading('weight', 1)

      // The database enforces this too. It is repeated here so the tablet is
      // told what to do about it rather than shown a constraint violation.
      if (bp === null && temperature === null && pulse === null && spo2 === null && weight === null) {
        throw new Error('Record at least one reading.')
      }

      await transaction(async () => {
        await db.prepare(`insert into vitals
          (id,patient_id,bp,temperature,pulse,spo2,weight,not_measured_note,recorded_by,recorded_at)
          values (?,?,?,?,?,?,?,?,?,?)`).run(
            id, value(payload, 'patientId'), bp, temperature, pulse, spo2, weight,
            optional(payload, 'notMeasuredNote'), session.staffId, isoNow(),
          )
        const missing = (
          [['BP', bp], ['temperature', temperature], ['pulse', pulse], ['SpO2', spo2], ['weight', weight]] as const
        ).filter(([, taken]) => taken === null).map(([label]) => label)
        await audit(
          session.staffId,
          'vitals.recorded',
          'vitals',
          id,
          missing.length === 0
            ? 'Recorded patient vitals'
            : `Recorded patient vitals; not measured: ${missing.join(', ')}`,
        )
      })
      return { message: 'Vitals saved.' }
    }

    case 'save_consultation_draft': {
      requireRole(session, 'doctor')
      const patientId = value(payload, 'patientId')
      const fields = clinicalFields(payload, false)
      const items = await structuredPrescriptionItems(payload)
      let draftId = optional(payload, 'draftId') || randomUUID()

      await transaction(async () => {
        await requireActiveAppointment(patientId, optional(payload, 'appointmentId'))
        const existing = (await db.prepare(`select id from consultation_drafts
          where patient_id=? and doctor_id=? for update`).get(
            patientId, session.staffId,
          )) as { id: string } | undefined
        if (existing) draftId = String(existing.id)

        if (existing) {
          await db.prepare(`update consultation_drafts set
            appointment_id=?,complaint=?,complaint_duration_value=?,complaint_duration_unit=?,
            examination=?,diagnosis=?,diagnosis_status=?,aetiology=?,aetiology_certainty=?,
            notes=?,advice=?,follow_up_date=?,updated_at=now()
            where id=? and doctor_id=?`).run(
              optional(payload, 'appointmentId') || null, fields.complaint,
              fields.complaintDurationValue ?? null, fields.complaintDurationUnit ?? null,
              fields.examination, fields.diagnosis, fields.diagnosisStatus, fields.aetiology,
              fields.aetiologyCertainty, fields.notes, fields.advice,
              fields.followUpDate ?? null, draftId, session.staffId,
            )
        } else {
          await db.prepare(`insert into consultation_drafts
            (id,patient_id,doctor_id,appointment_id,complaint,complaint_duration_value,
             complaint_duration_unit,examination,diagnosis,diagnosis_status,aetiology,
             aetiology_certainty,notes,advice,follow_up_date,created_at,updated_at)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now(),now())`).run(
              draftId, patientId, session.staffId, optional(payload, 'appointmentId') || null,
              fields.complaint, fields.complaintDurationValue ?? null,
              fields.complaintDurationUnit ?? null, fields.examination, fields.diagnosis,
              fields.diagnosisStatus, fields.aetiology, fields.aetiologyCertainty,
              fields.notes, fields.advice, fields.followUpDate ?? null,
            )
        }
        await db.prepare('delete from consultation_draft_lines where draft_id=?').run(draftId)
        await insertDraftLines(draftId, items)
        await audit(session.staffId, 'consultation.draft_saved', 'consultation_draft', draftId, `Saved draft for ${patientId}`)
      })
      return { message: 'Draft saved for you.', data: { draftId } }
    }

    case 'discard_consultation_draft': {
      requireRole(session, 'doctor')
      const draftId = value(payload, 'draftId')
      await transaction(async () => {
        const removed = await db.prepare(`delete from consultation_drafts
          where id=? and doctor_id=?`).run(draftId, session.staffId)
        if (removed.changes !== 1) throw new Error('That draft is no longer available.')
        await audit(session.staffId, 'consultation.draft_discarded', 'consultation_draft', draftId, 'Discarded own consultation draft')
      })
      return { message: 'Draft discarded.' }
    }

    case 'set_clinical_phrase_favourite': {
      requireRole(session, 'doctor')
      const kind = requireChoice(
        payload,
        'kind',
        ['complaint', 'examination', 'diagnosis', 'instruction', 'advice'] as const,
      )
      const displayText = value(payload, 'text')
      const favourite = booleanValue(payload, 'favourite')
      await transaction(async () => {
        await db.prepare(`insert into clinical_phrase_preferences
          (doctor_id,kind,display_text,normalized_text,favourite,use_count,last_used_at)
          values (?,?,?,?,?,0,null)
          on conflict (doctor_id,kind,normalized_text) do update
          set display_text=excluded.display_text,favourite=excluded.favourite`).run(
            session.staffId, kind, displayText, normalizedPhrase(displayText), favourite ? 1 : 0,
          )
        await audit(session.staffId, 'clinical_phrase.favourite', 'clinical_phrase', `${kind}:${normalizedPhrase(displayText)}`, `${favourite ? 'Favourited' : 'Unfavourited'} ${kind} phrase`)
      })
      return { message: favourite ? 'Added to favourites.' : 'Removed from favourites.' }
    }

    /*
     * The clinic-wide vocabulary has to stay extensible — the clinic is a mixed
     * practice and OWNER_POLICY_REGISTER.md F.36 says so explicitly — but
     * extending it is clinical content, not access metadata. A.5 draws the line
     * the other way round from what a role check would suggest: any doctor may
     * add their own favourites, and nobody changes the clinic-wide approved list
     * except the doctor the owner authorized. That is the same authority A.6
     * grants over clinic templates, so it is the same flag; splitting it would
     * invent a distinction the owner never made.
     */
    case 'publish_clinical_phrase': {
      requireRole(session, 'doctor')
      if (!session.canPublishClinicalTemplates) {
        throw new Error('You are not authorized to change the clinic-wide clinical vocabulary.')
      }
      const kind = requireChoice(
        payload,
        'kind',
        ['complaint', 'examination', 'diagnosis', 'instruction', 'advice'] as const,
      )
      const displayText = value(payload, 'text')
      const normalized = normalizedPhrase(displayText)
      if (!normalized) throw new Error('A clinical phrase needs some wording.')
      let restored = false

      await transaction(async () => {
        const existing = (await db.prepare(`select id,display_text,active from clinical_phrases
          where kind=? and normalized_text=? for update`).get(kind, normalized)) as {
            id: string; display_text: string; active: number
          } | undefined

        if (existing && Number(existing.active) === 1) {
          throw new Error(`"${existing.display_text}" is already in the clinic list.`)
        }
        if (existing) {
          // Approved wording is immutable, so a withdrawn phrase comes back as
          // itself rather than as this doctor's re-typing of it.
          restored = true
          await db.prepare('update clinical_phrases set active=1,retired_at=null where id=?')
            .run(existing.id)
          await audit(session.staffId, 'clinical_phrase.restored', 'clinical_phrase', existing.id, `Restored ${kind} phrase ${existing.display_text}`)
          return
        }

        const id = randomUUID()
        await db.prepare(`insert into clinical_phrases
          (id,kind,display_text,normalized_text,source,active,approved_by,approved_at)
          values (?,?,?,?,'clinic',1,?,now())`).run(
            id, kind, displayText.trim(), normalized, session.staffId,
          )
        await audit(session.staffId, 'clinical_phrase.published', 'clinical_phrase', id, `Published ${kind} phrase ${displayText.trim()}`)
      })

      return {
        message: restored
          ? 'That wording is back in the clinic list.'
          : 'Added to the clinic list.',
      }
    }

    case 'retire_clinical_phrase': {
      requireRole(session, 'doctor')
      if (!session.canPublishClinicalTemplates) {
        throw new Error('You are not authorized to change the clinic-wide clinical vocabulary.')
      }
      const kind = requireChoice(
        payload,
        'kind',
        ['complaint', 'examination', 'diagnosis', 'instruction', 'advice'] as const,
      )
      const normalized = normalizedPhrase(value(payload, 'text'))

      await transaction(async () => {
        const existing = (await db.prepare(`select id,display_text from clinical_phrases
          where kind=? and normalized_text=? and active=1 for update`).get(kind, normalized)) as {
            id: string; display_text: string
          } | undefined
        if (!existing) throw new Error('That phrase is already withdrawn or is not in the clinic list.')
        await db.prepare('update clinical_phrases set active=0,retired_at=now() where id=?')
          .run(existing.id)
        await audit(session.staffId, 'clinical_phrase.retired', 'clinical_phrase', existing.id, `Withdrew ${kind} phrase ${existing.display_text}`)
      })

      return { message: 'Withdrawn from the clinic list. Visits that used it are unchanged.' }
    }

    case 'save_clinical_template': {
      requireRole(session, 'doctor')
      const scope = requireChoice(payload, 'scope', ['personal', 'clinic'] as const, 'personal')
      if (scope === 'clinic' && !session.canPublishClinicalTemplates) {
        throw new Error('You are not authorized to publish clinic-wide clinical templates.')
      }
      const title = value(payload, 'title')
      const fields = clinicalFields(payload, false)
      const items = await structuredPrescriptionItems(payload)
      const previousId = optional(payload, 'templateId')
      const followUpRaw = optional(payload, 'followUpAfterDays')
      const followUpAfterDays = followUpRaw === '' ? undefined : Number(followUpRaw)
      if (followUpAfterDays !== undefined && (!Number.isInteger(followUpAfterDays) || followUpAfterDays < 0)) {
        throw new Error('followUpAfterDays must be a whole number of days.')
      }
      let templateId = randomUUID()

      await transaction(async () => {
        let seriesId: string = randomUUID()
        let version = 1
        let previous: { id: string; series_id: string; version: number; scope: string; owner_doctor_id: string } | undefined
        if (previousId) {
          previous = (await db.prepare(`select id,series_id,version,scope,owner_doctor_id
            from consultation_templates where id=? and retired_at is null for update`).get(previousId)) as typeof previous
          if (!previous) throw new Error('That template version is no longer current.')
          const mayEdit = previous.owner_doctor_id === session.staffId ||
            (previous.scope === 'clinic' && session.canPublishClinicalTemplates)
          if (!mayEdit) throw new Error('Only the owning doctor may edit this personal template.')
          seriesId = previous.series_id
          version = Number(previous.version) + 1
          await db.prepare('update consultation_templates set retired_at=now() where id=?').run(previous.id)
        }

        templateId = randomUUID()
        await db.prepare(`insert into consultation_templates
          (id,series_id,version,scope,owner_doctor_id,title,complaint,
           complaint_duration_value,complaint_duration_unit,examination,diagnosis,
           diagnosis_status,aetiology,aetiology_certainty,notes,advice,
           follow_up_after_days,created_by,approved_by,created_at,supersedes_id)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now(),?)`).run(
            templateId, seriesId, version, scope, session.staffId, title, fields.complaint,
            fields.complaintDurationValue ?? null, fields.complaintDurationUnit ?? null,
            fields.examination, fields.diagnosis, fields.diagnosisStatus, fields.aetiology,
            fields.aetiologyCertainty, fields.notes, fields.advice,
            followUpAfterDays ?? null, session.staffId,
            scope === 'clinic' ? session.staffId : null, previous?.id ?? null,
          )
        await insertTemplateLines(templateId, items)
        await audit(session.staffId, 'clinical_template.saved', 'consultation_template', templateId, `${scope === 'clinic' ? 'Published clinic' : 'Saved personal'} template ${title} v${version}`)
      })
      return { message: scope === 'clinic' ? 'Clinic template published.' : 'Personal template saved.', data: { templateId } }
    }

    case 'retire_clinical_template': {
      requireRole(session, 'doctor')
      const templateId = value(payload, 'templateId')
      await transaction(async () => {
        const template = (await db.prepare(`select id,scope,owner_doctor_id,title
          from consultation_templates where id=? and retired_at is null for update`).get(templateId)) as {
            id: string; scope: string; owner_doctor_id: string; title: string
          } | undefined
        if (!template) throw new Error('That template is already retired or does not exist.')
        const mayRetire = template.owner_doctor_id === session.staffId ||
          (template.scope === 'clinic' && session.canPublishClinicalTemplates)
        if (!mayRetire) throw new Error('Only the owning doctor may retire this personal template.')
        await db.prepare('update consultation_templates set retired_at=now() where id=?').run(templateId)
        await audit(session.staffId, 'clinical_template.retired', 'consultation_template', templateId, `Retired template ${template.title}`)
      })
      return { message: 'Template retired. Its history is kept.' }
    }

    case 'save_patient_clinical_profile': {
      requireRole(session, 'doctor')
      const patientId = value(payload, 'patientId')
      const allergyStatus = requireChoice(
        payload,
        'allergyStatus',
        ['not_recorded', 'no_known', 'known'] as const,
        'not_recorded',
      )
      const allergyNotes = optional(payload, 'allergyNotes')
      if (allergyStatus === 'known' && !allergyNotes) {
        throw new Error('Record the known allergy before saving.')
      }
      await transaction(async () => {
        await db.prepare(`insert into patient_clinical_profiles
          (patient_id,allergy_status,allergy_notes,clinical_flags,updated_by,updated_at)
          values (?,?,?,?,?,now())
          on conflict (patient_id) do update
          set allergy_status=excluded.allergy_status,
              allergy_notes=excluded.allergy_notes,
              clinical_flags=excluded.clinical_flags,
              updated_by=excluded.updated_by,
              updated_at=excluded.updated_at`).run(
            patientId, allergyStatus, allergyNotes, optional(payload, 'clinicalFlags'), session.staffId,
          )
        await audit(session.staffId, 'patient.clinical_profile', 'patient', patientId, 'Updated allergy and clinical flags')
      })
      return { message: 'Patient alerts updated.' }
    }

    case 'sign_consultation':
    case 'save_consultation': {
      requireRole(session, 'doctor')
      return completeConsultation(session, payload)
    }

    /*
     * Resolving a line the Slice 2.1 migration marked unreadable.
     *
     * The line itself is never touched — it is a signed record and its trigger
     * refuses updates. What this writes is a separate event beside it, so the
     * prescription always shows both what was signed and what the doctor later
     * determined. Only a doctor may do it: identifying which medicine an old
     * order meant, or what quantity it authorized, is a clinical judgement, and
     * OWNER_POLICY_REGISTER.md 21 is explicit that changing a prescribed
     * clinical drug or quantity needs doctor authorization.
     *
     * It resolves ONLY what the line was signed without. Slice 2.1 read
     * `medicine_state` and `quantity_state` here and then did not test them,
     * which left a doctor calling this command able to write a resolution
     * against an ordinary line signed minutes earlier — and because
     * `prescription_lines_effective` coalesces the newest resolution over the
     * line, the counter would hand over the amendment while the signed row and
     * `items_json` still said something else. Changing a prescribed medicine or
     * quantity is a new or replacement order, not an edit to this one.
     *
     * These four refusals are friendly restatements of
     * `jmc.enforce_resolution_scope()`, which is the enforcement. The trigger
     * also covers the psql session and the repair script that never reach this
     * function; what is here exists so a doctor meets a sentence rather than a
     * constraint name.
     *
     * `action: 'cancel'` here is a DOCTOR cancelling an unreadable legacy line
     * — the doctor cannot determine what it authorized and withdraws it. A
     * patient who chooses not to collect a supplyable line is Patient Declined,
     * which is a dispensing outcome and not a clinical determination about the
     * order. OWNER_POLICY_REGISTER.md 20 keeps the two apart, and this command
     * can only ever record the first.
     */
    case 'resolve_prescription_line': {
      requireRole(session, 'doctor')
      const lineId = value(payload, 'prescriptionLineId')
      const action = requireChoice(payload, 'action', ['amend', 'cancel'] as const, 'amend')
      const reason = value(payload, 'reason')
      const medicineId = optional(payload, 'medicineId')
      const quantity = optionalPositiveInteger(payload, 'quantity')

      if (action === 'cancel' && (medicineId || quantity !== undefined)) {
        throw new Error('A cancelled line carries no replacement medicine or quantity.')
      }
      if (action === 'amend' && !medicineId && quantity === undefined) {
        throw new Error('Say which medicine or what quantity this line authorized.')
      }

      const resolutionId = randomUUID()
      await transaction(async () => {
        const line = await db.prepare(`select id,line_number,medicine_state,quantity_state,medicine_name_snapshot
          from prescription_lines where id=? for update`).get(lineId) as {
            id: string
            line_number: number
            medicine_state: string
            quantity_state: string
            medicine_name_snapshot: string
          } | undefined
        if (!line) throw new Error('That prescription line was not found.')

        const where = `Line ${line.line_number} (${line.medicine_name_snapshot})`
        const medicineUnreadable = line.medicine_state === 'unresolved_legacy'
        const quantityUnreadable = line.quantity_state === 'unknown_legacy'

        // Cancellation is final, so it is the first thing tested and the first
        // thing said. Read inside the transaction, after the `for update`
        // above, so two doctors resolving the same line queue rather than race.
        const cancellation = await db.prepare(`select
            to_char(resolved_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as resolved_on
          from prescription_line_resolutions
          where prescription_line_id=? and action='cancel' order by resolved_at limit 1`)
          .get(lineId) as { resolved_on: string } | undefined
        if (cancellation) {
          throw new Error(
            `${where} was cancelled by a doctor on ${cancellation.resolved_on}. ` +
            'Cancellation is final; supplying it now needs a new prescription.',
          )
        }

        if (!medicineUnreadable && !quantityUnreadable) {
          throw new Error(
            `${where} records both its medicine and its quantity, so there is nothing to resolve. ` +
            'A signed prescription is not amended — write a new prescription instead.',
          )
        }
        if (medicineId && !medicineUnreadable) {
          throw new Error(
            `${where} already records which medicine was prescribed. Only its quantity may be determined.`,
          )
        }
        if (quantity !== undefined && !quantityUnreadable) {
          throw new Error(
            `${where} already records the quantity prescribed. Only its medicine may be determined.`,
          )
        }

        if (medicineId) {
          const medicine = await db.prepare('select id from medicines where id=? and active=1').get(medicineId)
          if (!medicine) throw new Error('That medicine is not in the active formulary.')
        }

        await db.prepare(`insert into prescription_line_resolutions
          (id,prescription_line_id,action,medicine_id,prescribed_quantity,reason,resolved_by,resolved_at)
          values (?,?,?,?,?,?,?,now())`).run(
            resolutionId, lineId, action, medicineId || null, quantity ?? null,
            reason, session.staffId,
          )
        await audit(
          session.staffId,
          action === 'cancel' ? 'prescription_line.cancelled' : 'prescription_line.resolved',
          'prescription_line',
          lineId,
          `${action === 'cancel' ? 'Cancelled' : 'Resolved'} legacy line ${line.medicine_name_snapshot}: ${reason}`,
        )
      })
      return {
        message: action === 'cancel'
          ? 'Line cancelled. The signed prescription is unchanged.'
          : 'Line resolved. The signed prescription is unchanged.',
        data: { resolutionId },
      }
    }

    case 'record_prescription_print': {
      requireRole(session, 'doctor')
      const prescriptionId = value(payload, 'prescriptionId')
      let copyNumber = 0
      await transaction(async () => {
        const rx = await db.prepare('select id,prescription_number from prescriptions where id=? for update')
          .get(prescriptionId) as { id: string; prescription_number: string } | undefined
        if (!rx) throw new Error('That signed prescription was not found.')
        const count = await db.prepare('select count(*)::int as count from prescription_prints where prescription_id=?')
          .get(prescriptionId) as { count: number } | undefined
        copyNumber = Number(count?.count ?? 0) + 1
        await db.prepare(`insert into prescription_prints
          (id,prescription_id,printed_by,printed_at,copy_number) values (?,?,?,now(),?)`).run(
            randomUUID(), prescriptionId, session.staffId, copyNumber,
          )
        await audit(session.staffId, 'prescription.printed', 'prescription', prescriptionId, `${copyNumber === 1 ? 'Printed' : 'Reprinted'} ${rx.prescription_number}, copy ${copyNumber}`)
      })
      return { message: copyNumber === 1 ? 'Prescription ready to print.' : `Reprint copy ${copyNumber} recorded.`, data: { copyNumber } }
    }

    case 'complete_follow_up': {
      requireRole(session, 'doctor')
      const followUpId = value(payload, 'followUpId')
      const status = requireChoice(payload, 'status', ['completed', 'cancelled'] as const)
      await transaction(async () => {
        const result = status === 'completed'
          ? await db.prepare(`update follow_ups set status='completed',completed_at=now(),completed_by=?
              where id=? and doctor_id=? and status='open'`).run(session.staffId, followUpId, session.staffId)
          : await db.prepare(`update follow_ups set status='cancelled',cancelled_at=now(),cancelled_by=?
              where id=? and doctor_id=? and status='open'`).run(session.staffId, followUpId, session.staffId)
        if (result.changes !== 1) throw new Error('That follow-up is already closed or belongs to another doctor.')
        await audit(session.staffId, `follow_up.${status}`, 'follow_up', followUpId, `${status} follow-up`)
      })
      return { message: status === 'completed' ? 'Follow-up completed.' : 'Follow-up cancelled.' }
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
      const nextCheckAt = optional(payload, 'nextCheckAt')
        ? await clinicInstant(value(payload, 'nextCheckAt'))
        : null
      await transaction(async () => {
        const before = await db.prepare(`select status,patient_id,admitted_at from beds where id=? for update`)
          .get(bedId) as { status: string; patient_id: string | null; admitted_at: string | null } | undefined
        if (!before) throw new Error('That observation bed was not found.')
        const newAdmission = status === 'occupied' &&
          (before.status !== 'occupied' || before.patient_id !== patientId)
        if (before.status === 'occupied' && status !== 'occupied' && !booleanValue(payload, 'confirmed')) {
          throw new Error('Confirm discharge or transfer before clearing an occupied bed.')
        }
        await db.prepare(`update beds set status=?,patient_id=?,admitted_at=?,notes=?,next_check_at=?,
          doctor_instructions=case when ? then '' else doctor_instructions end,
          handoff_requested_at=case when ? then null else handoff_requested_at end,
          handoff_requested_by=case when ? then null else handoff_requested_by end,
          handoff_resolved_at=case when ? then null else handoff_resolved_at end,
          handoff_resolved_by=case when ? then null else handoff_resolved_by end
          where id=?`).run(
            status, patientId,
            status === 'occupied' ? (newAdmission ? isoNow() : before.admitted_at) : null,
            optional(payload, 'notes'), status === 'occupied' ? nextCheckAt : null,
            newAdmission, newAdmission, newAdmission, newAdmission, newAdmission, bedId,
          )
        if (newAdmission) {
          await db.prepare(`insert into observation_events
            (id,bed_id,patient_id,event_type,note,next_check_at,actor_id,created_at)
            values (?,?,?,'admitted',?,?,?,now())`).run(
              randomUUID(), bedId, patientId, optional(payload, 'notes'), nextCheckAt,
              session.staffId,
            )
        }
        await audit(session.staffId, 'bed.updated', 'bed', bedId, `Bed marked ${status}`)
      })
      return { message: 'Bed board updated.' }
    }

    case 'record_observation': {
      requireRole(session, 'admin', 'nurse')
      const bedId = value(payload, 'bedId')
      const note = optional(payload, 'note')
      const nextCheckAt = optional(payload, 'nextCheckAt')
        ? await clinicInstant(value(payload, 'nextCheckAt'))
        : null
      if (!note && !nextCheckAt) throw new Error('Add an observation note or a next check time.')
      await transaction(async () => {
        const bed = await db.prepare(`select patient_id from beds
          where id=? and status='occupied' for update`).get(bedId) as { patient_id: string } | undefined
        if (!bed) throw new Error('That bed is not occupied.')
        await db.prepare(`update beds set notes=case when ?='' then notes else ? end,
          next_check_at=coalesce(?,next_check_at) where id=?`).run(note, note, nextCheckAt, bedId)
        await db.prepare(`insert into observation_events
          (id,bed_id,patient_id,event_type,note,next_check_at,actor_id,created_at)
          values (?,?,?,?,?,?,?,now())`).run(
            randomUUID(), bedId, bed.patient_id, nextCheckAt && !note ? 'check_due' : 'note',
            note, nextCheckAt, session.staffId,
          )
        await audit(session.staffId, 'observation.recorded', 'bed', bedId, 'Recorded observation and next check')
      })
      return { message: 'Observation saved.' }
    }

    case 'set_observation_instructions': {
      requireRole(session, 'doctor')
      const bedId = value(payload, 'bedId')
      const instructions = value(payload, 'instructions')
      await transaction(async () => {
        const bed = await db.prepare(`select patient_id from beds
          where id=? and status='occupied' for update`).get(bedId) as { patient_id: string } | undefined
        if (!bed) throw new Error('That bed is not occupied.')
        await db.prepare('update beds set doctor_instructions=? where id=?').run(instructions, bedId)
        await db.prepare(`insert into observation_events
          (id,bed_id,patient_id,event_type,note,actor_id,created_at)
          values (?,?,?,'doctor_instruction',?,?,now())`).run(
            randomUUID(), bedId, bed.patient_id, instructions, session.staffId,
          )
        await audit(session.staffId, 'observation.instructions', 'bed', bedId, 'Updated doctor instructions')
      })
      return { message: 'Doctor instructions saved.' }
    }

    case 'request_observation_handoff': {
      requireRole(session, 'admin', 'nurse')
      const bedId = value(payload, 'bedId')
      const note = optional(payload, 'note')
      await transaction(async () => {
        const bed = await db.prepare(`select patient_id from beds
          where id=? and status='occupied' for update`).get(bedId) as { patient_id: string } | undefined
        if (!bed) throw new Error('That bed is not occupied.')
        const now = isoNow()
        await db.prepare(`update beds set handoff_requested_at=?,handoff_requested_by=?,
          handoff_resolved_at=null,handoff_resolved_by=null where id=?`).run(
            now, session.staffId, bedId,
          )
        await db.prepare(`insert into observation_events
          (id,bed_id,patient_id,event_type,note,actor_id,created_at)
          values (?,?,?,'handoff_requested',?,?,now())`).run(
            randomUUID(), bedId, bed.patient_id, note, session.staffId,
          )
        await audit(session.staffId, 'observation.handoff_requested', 'bed', bedId, 'Requested doctor handoff')
      })
      return { message: 'Doctor handoff requested.' }
    }

    case 'resolve_observation_handoff': {
      requireRole(session, 'doctor')
      const bedId = value(payload, 'bedId')
      await transaction(async () => {
        const bed = await db.prepare(`select patient_id from beds
          where id=? and status='occupied' and handoff_requested_at is not null
            and handoff_resolved_at is null for update`).get(bedId) as { patient_id: string } | undefined
        if (!bed) throw new Error('There is no open handoff for that bed.')
        await db.prepare(`update beds set handoff_resolved_at=now(),handoff_resolved_by=?
          where id=?`).run(session.staffId, bedId)
        await db.prepare(`insert into observation_events
          (id,bed_id,patient_id,event_type,note,actor_id,created_at)
          values (?,?,?,'handoff_resolved',?,?,now())`).run(
            randomUUID(), bedId, bed.patient_id, optional(payload, 'note'), session.staffId,
          )
        await audit(session.staffId, 'observation.handoff_resolved', 'bed', bedId, 'Doctor accepted observation handoff')
      })
      return { message: 'Handoff acknowledged.' }
    }

    case 'close_observation': {
      requireRole(session, 'admin', 'nurse')
      if (!booleanValue(payload, 'confirmed')) throw new Error('Confirm before closing observation.')
      const bedId = value(payload, 'bedId')
      const outcome = requireChoice(payload, 'outcome', ['discharged', 'transferred'] as const)
      const note = value(payload, 'note')
      await transaction(async () => {
        const bed = await db.prepare(`select patient_id from beds
          where id=? and status='occupied' for update`).get(bedId) as { patient_id: string } | undefined
        if (!bed) throw new Error('That bed is not occupied.')
        await db.prepare(`insert into observation_events
          (id,bed_id,patient_id,event_type,note,actor_id,created_at)
          values (?,?,?,?,?,?,now())`).run(
            randomUUID(), bedId, bed.patient_id, outcome, note, session.staffId,
          )
        await db.prepare(`update beds set status='cleaning',patient_id=null,admitted_at=null,
          notes='',next_check_at=null,doctor_instructions='',handoff_requested_at=null,
          handoff_requested_by=null,handoff_resolved_at=null,handoff_resolved_by=null
          where id=?`).run(bedId)
        await audit(session.staffId, `observation.${outcome}`, 'bed', bedId, `${outcome} patient after confirmation`)
      })
      return { message: outcome === 'discharged' ? 'Patient discharged; bed marked for cleaning.' : 'Transfer recorded; bed marked for cleaning.' }
    }

    case 'create_staff': {
      requireRole(session, 'admin')
      const id = randomUUID()
      const roles = Array.isArray(payload.roles)
        ? payload.roles.filter((role): role is Role => ['admin', 'doctor', 'nurse', 'pharmacy'].includes(String(role)))
        : []
      if (roles.length === 0) throw new Error('Choose at least one role.')
      const canPublishClinicalTemplates = roles.includes('doctor') &&
        booleanValue(payload, 'canPublishClinicalTemplates')
      const secret = await hashPassword(requirePin(payload, 'pin'))
      await transaction(async () => {
        // pin_format is named rather than left to the column default. The
        // default is 'four' and would be right, but a PIN written by one
        // statement and its length recorded by another is exactly the pair
        // that drifts — and drifting here means somebody cannot sign in.
        await db.prepare(`insert into staff
          (id,name,username,phone,roles_json,pin_hash,pin_salt,pin_format,
           can_publish_clinical_templates,active,created_at)
          values (?,?,?,?,?,?,?,'four',?,1,?)`).run(
            id, value(payload, 'name'), value(payload, 'username').toLowerCase(), optional(payload, 'phone'),
            JSON.stringify(roles), secret.hash, secret.salt, canPublishClinicalTemplates ? 1 : 0, isoNow(),
          )
        await audit(session.staffId, 'staff.created', 'staff', id, `Added ${value(payload, 'name')} as ${roles.join(', ')}`)
      })
      return { message: 'Staff account created.' }
    }

    case 'set_staff_pin': {
      requireRole(session, 'admin')
      const staffId = value(payload, 'staffId')
      const secret = await hashPassword(requirePin(payload, 'pin'))
      const resettingSelf = staffId === session.staffId
      await transaction(async () => {
        // pin_format moves to 'four' in the same statement that writes the
        // hash. Two statements would leave a window in which the stored hash
        // is four digits and the row still says six, and everything about
        // signing in during the migration is decided by that column.
        const changed = await db
          .prepare(`update staff set pin_hash=?,pin_salt=?,pin_format='four' where id=? and active=1`)
          .run(secret.hash, secret.salt, staffId)
        if (changed.changes !== 1) throw new Error('That staff member was not found.')

        // Their existing sessions die with the old PIN. Changing a PIN is what
        // somebody does when they think it is known, and leaving a signed-in
        // tablet open would defeat the point of changing it.
        //
        // That includes the administrator's own sessions when they reset
        // themselves, which is not an oversight: it is the last step of the
        // clinic's reset runbook. The admin resets everyone else, resets
        // themselves last, is signed out by this line, and signs in again on
        // the spot to prove the new PIN works before leaving the building.
        await db.prepare('delete from sessions where staff_id=?').run(staffId)
        await db.prepare('delete from pin_attempts where staff_id=?').run(staffId)
        await audit(
          session.staffId,
          'staff.pin_set',
          'staff',
          staffId,
          resettingSelf ? 'Reset their own sign-in PIN' : 'Set a new sign-in PIN',
        )
      })
      return {
        message: resettingSelf
          ? 'New PIN saved. You have been signed out — sign in again now to check it works.'
          : 'New PIN saved. They will be asked for it next time.',
      }
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
            optional(payload, 'address'),
            optional(payload, 'phone'),
            optional(payload, 'email'),
            optional(payload, 'drugLicenceNumber'),
            optional(payload, 'doctorRegistrationNumber'),
            optional(payload, 'gstin'),
            fee,
            optional(payload, 'footerNote'),
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
            optional(payload, 'note'), session.staffId, isoNow(),
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
        noteNumber = await sequence('RET')

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
            expectedCredit, optional(payload, 'note'), session.staffId, isoNow(),
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
        optional(payload, 'recountThreshold') === ''
          ? 500
          : numberValue(payload, 'recountThreshold', 0)
      const id = randomUUID()
      let reference = ''

      await transaction(async () => {
        const open = await db
          .prepare("select id from stock_takes where status in ('counting','submitted')")
          .get()
        if (open) throw new Error('A stock-take is already open. Finish or abandon it first.')

        reference = await sequence('ST')
        await db
          .prepare(
            `insert into stock_takes
               (id,reference,scope,scope_note,status,recount_threshold,started_at,started_by)
               values (?,?,?,?,'counting',?,?,?)`,
          )
          .run(id, reference, scope, optional(payload, 'scopeNote'), threshold, isoNow(), session.staffId)

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
          .run(now, session.staffId, counted, expected, variance, optional(payload, 'note'), till.id)

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

    case 'update_staff': {
      requireRole(session, 'admin')
      const staffId = value(payload, 'staffId')
      const roles = Array.isArray(payload.roles)
        ? payload.roles.filter((role): role is Role =>
            ['admin', 'doctor', 'nurse', 'pharmacy'].includes(String(role)),
          )
        : []
      if (roles.length === 0) throw new Error('Choose at least one role.')
      let canPublishClinicalTemplates = false

      // The clinic must keep somebody who can add staff, reset a PIN and edit
      // the settings. Signing that away from your own account is a locked door
      // with the key on the inside.
      if (staffId === session.staffId && !roles.includes('admin')) {
        throw new Error('You cannot remove your own admin role. Give it to someone else first.')
      }

      const username = value(payload, 'username').toLowerCase()
      const name = value(payload, 'name')
      let rolesChanged = false

      await transaction(async () => {
        const current = (await db
          .prepare('select roles_json,can_publish_clinical_templates from staff where id=?')
          .get(staffId)) as { roles_json: string; can_publish_clinical_templates: number } | undefined
        if (!current) throw new Error('That staff member was not found.')

        // Older clients do not send this Slice 2 capability yet. Preserve an
        // existing authorization unless the field was deliberately supplied;
        // removing the doctor role still revokes it.
        canPublishClinicalTemplates = roles.includes('doctor') &&
          (payload.canPublishClinicalTemplates === undefined
            ? Boolean(Number(current.can_publish_clinical_templates))
            : booleanValue(payload, 'canPublishClinicalTemplates'))

        const clash = await db
          .prepare('select id from staff where username=? and id<>?')
          .get(username, staffId)
        if (clash) throw new Error(`The username @${username} is already taken.`)

        const before = (JSON.parse(String(current.roles_json)) as string[]).slice().sort().join(',')
        rolesChanged = before !== roles.slice().sort().join(',') ||
          Boolean(Number(current.can_publish_clinical_templates)) !== canPublishClinicalTemplates

        await db
          .prepare(`update staff set name=?,username=?,phone=?,roles_json=?,
            can_publish_clinical_templates=? where id=?`)
          .run(
            name, username, optional(payload, 'phone'), JSON.stringify(roles),
            canPublishClinicalTemplates ? 1 : 0, staffId,
          )

        // A session carries what the person may do. Correcting a phone number
        // should not sign anyone out, but a demotion that leaves them holding
        // their old powers until they happen to sign out is not a demotion.
        if (rolesChanged) await db.prepare('delete from sessions where staff_id=?').run(staffId)

        await audit(
          session.staffId, 'staff.updated', 'staff', staffId,
          `Updated ${name} (${roles.join(', ')})`,
        )
      })

      return {
        message: rolesChanged
          ? 'Saved. Their roles changed, so they will be asked to sign in again.'
          : 'Saved.',
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
          await insert.run(supplierId, medicineId)
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
          (id,code,name,generic_name,strength,dosage_form,route,unit,barcode,sale_class,schedule,
           reorder_level,target_stock,preferred_supplier_id,active,created_at)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, value(payload, 'code').toUpperCase(), value(payload, 'name'), optional(payload, 'genericName'),
            optional(payload, 'strength'), optional(payload, 'dosageForm'), optional(payload, 'route'),
            value(payload, 'unit'), optional(payload, 'barcode'),
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
        receiptNumber = await sequence('OTC')
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
        /**
         * `for update` — and it has to be here, before a single unit moves.
         *
         * Without the lock this read is the whole bug. Two counters submitting
         * the same prescription in the same second both saw `dispensed_at`
         * null, both walked the items, and both allocated: a prescription for
         * ten tablets took twenty off the shelf. The `dispensed_at is null`
         * guard on the UPDATE below looks like it prevents that and does not —
         * it runs after the stock has already gone, and its result was never
         * examined, so the second transaction wrote nothing, said nothing and
         * committed its allocations anyway.
         *
         * A sequential retry was always refused, which is why this survived:
         * reproducing it needs two people at the counter at the same moment,
         * and by the time the shelf disagrees with the ledger nobody can say
         * which sale it was.
         *
         * The lock makes the second transaction wait here rather than race
         * past. Postgres is READ COMMITTED, so when the first commits, the
         * second acquires the lock and re-reads the row as it now stands —
         * `dispensed_at` set — and refuses before allocating anything.
         *
         * Lock order is prescription, then batches by (expiry, id) inside
         * allocateStock. Every path that touches both takes them in that
         * order, which is what keeps two dispenses from deadlocking; an OTC
         * sale takes only batches, in the same (expiry, id) order, so it
         * cannot close a cycle either.
         */
        const prescription = await db.prepare(`select items_json,dispensed_at from prescriptions where id=? for update`)
          .get(prescriptionId) as { items_json: string; dispensed_at: string | null } | undefined
        if (!prescription) throw new Error('Prescription was not found.')
        if (prescription.dispensed_at) throw new Error('This prescription is already dispensed.')

        /**
         * The normalized lines, not `items_json`.
         *
         * Slice 2 built the lines and left dispensing reading the legacy JSON,
         * which was harmless while the two always agreed. Slice 2.1 makes them
         * disagree on purpose: a line whose medicine row is gone, or whose
         * quantity the clinic never wrote, is marked unknown instead of being
         * dropped or defaulted to 1. Reading the JSON here would hand over
         * against exactly the values that were found to be untrustworthy.
         *
         * `prescription_lines_effective` folds in the doctor's resolutions, so
         * a line an unrelated doctor amended this morning dispenses with what
         * they determined, and a cancelled line is not supplied at all.
         */
        const lines = await db.prepare(`select id,line_number,medicine_name_snapshot,
            effective_medicine_id,effective_quantity,cancelled,dispensable,needs_review
          from prescription_lines_effective
          where prescription_id=? order by line_number`).all(prescriptionId) as Array<{
            id: string
            line_number: number
            medicine_name_snapshot: string
            effective_medicine_id: string | null
            effective_quantity: number | null
            cancelled: boolean
            dispensable: boolean
            needs_review: boolean
          }>

        const unreadable = lines.filter((line) => line.needs_review)
        if (unreadable.length > 0) {
          // Named, because "this prescription cannot be dispensed" sends the
          // pharmacist back to the doctor without saying what to ask about.
          const first = unreadable[0]
          const missing = first.effective_medicine_id === null
            ? 'which medicine it was'
            : 'what quantity it authorized'
          throw new Error(
            `Line ${first.line_number} (${first.medicine_name_snapshot}) is from before this ` +
            `system and does not record ${missing}. A doctor must resolve it before anything ` +
            `is handed over.`,
          )
        }

        for (const line of lines) {
          if (!line.dispensable) continue // cancelled by a doctor; nothing to supply
          await allocateStock(
            String(line.effective_medicine_id), Number(line.effective_quantity),
            session.staffId, 'prescription', prescriptionId,
          )
        }
        const items = lines.filter((line) => line.dispensable)
        // Belt and braces, and cheap. The lock above should make this
        // unreachable; a guarded UPDATE whose row count nobody reads is
        // exactly how the original defect stayed invisible, so this one is
        // read. If it ever fires, the transaction rolls back and the stock
        // allocated moments ago goes back with it.
        const completed = await db.prepare('update prescriptions set dispensed_at=? where id=? and dispensed_at is null')
          .run(isoNow(), prescriptionId)
        if (Number(completed.changes) !== 1) throw new Error('This prescription is already dispensed.')
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
          greatest(m.target_stock-coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=${CLINIC_TODAY}),0),1) quantity
          from medicines m join supplier_medicines sm on sm.medicine_id=m.id and sm.supplier_id=? and sm.active=1
          where m.active=1 and coalesce((select sum(b.available_quantity) from batches b where b.medicine_id=m.id and b.expiry::date>=${CLINIC_TODAY}),0)<=m.reorder_level
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
        orderNumber = await sequence('PO')
        const draft = buildOrderDraft(supplier.name, orderNumber, namedLines)
        await db.prepare(`insert into purchase_orders
          (id,order_number,supplier_id,status,requested_date,message_draft,created_by,created_at)
          values (?,?,?,'pending',?,?,?,?)`).run(
            orderId, orderNumber, supplierId, isoNow().slice(0, 10), draft, session.staffId, isoNow(),
          )
        const insert = await db.prepare(`insert into purchase_order_lines
          (id,order_id,medicine_id,ordered_quantity,received_quantity) values (?,?,?,?,0)`)
        for (const line of namedLines) await insert.run(randomUUID(), orderId, line.medicineId, line.quantity)
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
      const result = await sendWhatsAppText(order.whatsapp, messageDraft, 'this supplier')
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
      // These are the roles with a Patients workspace and its message composer.
      requireRole(session, 'admin', 'doctor', 'nurse')
      const patientId = value(payload, 'patientId')
      const patient = await db.prepare('select name,phone,whatsapp_consent from patients where id=?').get(patientId) as
        | { name: string; phone: string; whatsapp_consent: number }
        | undefined
      if (!patient) throw new Error('Patient was not found.')
      if (!patient.whatsapp_consent) throw new Error('WhatsApp consent is not recorded for this patient.')
      const body = value(payload, 'body')
      const result = await sendWhatsAppText(patient.phone, body, patient.name)
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
