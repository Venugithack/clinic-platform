import { randomUUID } from 'node:crypto'
import type { PrescriptionItemView, Role, SessionView } from './types.ts'
import { deliveredOrderStatus } from './order-status.ts'
import { audit, db, isoNow, transaction } from './db.ts'
import { hashPassword } from './password.ts'
import { sendWhatsAppText } from './whatsapp.ts'
import { cancelRecallForFollowUp } from './messaging.ts'
import {
  booleanValue, CommandRefusal, numberValue, optional, optionalDate,
  optionalPositiveInteger, requireChoice, requireRole, sequence, value,
  type Payload,
} from './command-input.ts'
import { runAppointmentCommand } from './appointments.ts'
import { addInvoiceLine, openInvoice } from './counter.ts'
import {
  ATTEMPT_LOCK_NAMESPACE, ATTEMPT_RESOLUTION_LOCK_NAMESPACE,
  isUniqueViolation, requestFingerprint,
} from './idempotency.ts'
import { money, parseMoney, rupees } from './money.ts'
import type { Ladder } from './packages.ts'
import { ladderRows } from './inventory.ts'
import { describeOrdered, orderLevelFor, packsToCover, supplierOrderMessage } from './supplier-order.ts'

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

type Row = Record<string, unknown>

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
  /**
   * What the follow-up should say. Distinct from `advice`, which is what the
   * patient is told today; this is the note the clinic reads when they come
   * back. `sign_consultation` falls back to the advice when it is empty.
   */
  followUpNote: string
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
    followUpNote: optional(payload, 'followUpNote'),
  }
}

/**
 * Four digits, and not a birthday-shaped run of one.
 *
 * ── WHY FOUR, AND WHAT HAS TO BE TRUE FOR THAT TO BE ALL RIGHT ─────────────
 *
 * The owner asked for four; six was slowing down a person who signs in dozens
 * of times a day. Four digits is ten thousand combinations, which is not a
 * password and was never treated as one. `docs/reference/TABLET.md` §5 lists what has to hold
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

/**
 * What makes two signings the same consultation, and what makes them different.
 *
 * Every field here reaches a durable record: the encounter, the signed
 * prescription and its lines, the follow-up, or the fee and the invoice line
 * behind it. If two calls carrying one idempotency key agree on all of it, the
 * second is a retry of the first and must be answered with the first's
 * outcome. If they disagree on any of it, the tablet has reused a key across
 * two different consultations, and answering that with the earlier encounter's
 * identity would file one patient's visit under another's.
 *
 * ── WHO AND WHICH VISIT ARE CHECKED SEPARATELY, AND BEFORE THIS ────────────
 *
 * The doctor, the patient and the visit are not in this hash. They are not
 * omitted — they are checked first, against the encounter the key already
 * names, by `bindingOf` below, and they produce their own refusal. The reason
 * is that they answer a different question. A sheet that differs means *this
 * consultation was already signed and you have changed it*; a visit that
 * differs means *this key belongs to somebody else's consultation entirely*,
 * and the second is both more serious and more recoverable. Hashing them
 * together would collapse the two into one message that is right about neither.
 *
 * An earlier version of this left the appointment out of the identity
 * altogether, reasoning that signing sets the visit to `done`, so a retry
 * after the fifteen-second poll would have nothing to send and fingerprinting
 * it would refuse the exact retry this exists for. The observation was correct
 * and the conclusion was wrong: leaving it out meant one patient's Monday and
 * Thursday were the same consultation as far as this key was concerned.
 *
 * The answer is not that the tablet should send a remembered visit either —
 * that was the second attempt at this, and for a walk-in the remembered value
 * is `null` forever, so a consultation could be signed while the visit it
 * belonged to stayed in the queue. The tablet sends what it has on screen and
 * `compareBinding` reads the four cases apart.
 *
 * The doctor's own snapshots of the medicine — name, generic name, strength,
 * dosage form, code — are copied onto the prescription line from the formulary
 * at signing. They are not the doctor's request, and an admin correcting a
 * shelf label between a lost reply and its retry must not turn that retry into
 * a refusal. `route` and `dosage` are kept despite falling back to formulary
 * values, because unlike those five they carry a decision the doctor can make
 * and often does.
 *
 * The clinic's default consultation fee is read inside the transaction. What
 * belongs to the request is the doctor's DECISION about the fee — charge the
 * clinic rate, override it, or waive it — not the number the clinic happened
 * to hold at the moment.
 *
 * The prescription validity fields are included only when there are lines to
 * carry them, which is exactly when they are written. A field the command
 * ignores cannot be a material difference.
 */
function consultationFingerprint(
  fields: ClinicalFields,
  items: StructuredLine[],
  payload: Payload,
): string {
  return requestFingerprint({
    fields,
    items: items.map((item) => ({
      medicineId: item.medicineId,
      doseAmount: item.doseAmount,
      doseUnit: item.doseUnit,
      frequency: item.frequency,
      timing: item.timing,
      route: item.route,
      durationValue: item.durationValue,
      durationUnit: item.durationUnit,
      dosage: item.dosage,
      instructions: item.instructions,
      quantity: item.quantity,
    })),
    fee: {
      waived: booleanValue(payload, 'feeWaived'),
      override: optional(payload, 'consultationFee'),
      reason: optional(payload, 'feeReason'),
    },
    ...(items.length > 0
      ? {
        validity: {
          validUntil: optionalDate(payload, 'validUntil'),
          supplyInParts: payload.supplyInParts === undefined
            ? true
            : booleanValue(payload, 'supplyInParts'),
          validityReason: optional(payload, 'validityReason'),
        },
      }
      : {}),
  })
}

type SignedConsultation = {
  encounter_id: string
  request_fingerprint: string | null
  created_at: string
  patient_id: string
  doctor_id: string
  appointment_id: string | null
  prescription_id: string | null
  prescription_number: string | null
}

/** The consultation an idempotency key already named, if it named one. */
async function signedConsultationFor(key: string): Promise<SignedConsultation | undefined> {
  return await db.prepare(
    `select e.id as encounter_id, e.request_fingerprint, e.created_at,
            e.patient_id, e.doctor_id, e.appointment_id,
            p.id as prescription_id, p.prescription_number
       from encounters e
       left join prescriptions p on p.encounter_id = e.id
      where e.idempotency_key = ?`,
  ).get(key) as SignedConsultation | undefined
}

/** Who a request says it is for, and which visit the tablet has open. */
/**
 * What a request says it is for: who, and which visit — in two senses.
 *
 * `openedVisitId` is the visit the attempt BEGAN against and never changes.
 * `liveVisitId` is the visit the tablet has on screen at the moment it asks.
 * They are different facts and the third acceptance review is what proved that
 * replacing either with the other throws information away.
 *
 * Sending only the live one loses the attempt's own identity: a consultation
 * opened on a visit, whose first request never committed, whose visit was then
 * cancelled, retried with nothing to send — and the clinic wrote a direct
 * consultation, bypassing the cancellation and charging ₹300 against no visit
 * at all. Reproduced on staging before this was changed. Sending only the
 * opened one loses the visit that appeared afterwards, which was the previous
 * correction.
 */
type AttemptBinding = {
  patientId: string
  doctorId: string
  openedVisitId: string | null
  liveVisitId: string | null
}

/**
 * How a request's binding relates to the consultation its key already named.
 *
 * The encounter IS the attempt record once a signing has committed: it carries
 * the key, and it carries the patient, the doctor and the visit the key was
 * spent on. Nothing separate has to be written down to bind them, and nothing
 * can drift out of step with the consultation it describes.
 *
 * This is checked before the sheet, because a key that names a different
 * patient is not a changed consultation — it is a key that does not belong to
 * this consultation at all, and the two need different words.
 *
 * ── WHY THE VISIT IS FOUR CASES AND NOT AN EQUALITY TEST ───────────────────
 *
 * The first version compared patient, doctor and visit as one hash, which made
 * every difference the same kind of difference. Two of the four are not.
 *
 * **When the tablet names a live visit, that is what it is asserting this
 * consultation is about**, and the stored value is read against it:
 *
 * - the same visit — compatible;
 * - the encounter has NO visit — `signed_without_this_visit`. A walk-in signed
 *   from the register, the reply lost, and the doctor then created today's
 *   visit, which policy item 3 explicitly allows. Almost certainly the same
 *   consultation, and emphatically not a licence to sign again: hashed in with
 *   the others it became `ATTEMPT_NAMES_ANOTHER_CONSULTATION`, which the tablet
 *   rotates on, which writes a second encounter and a second ₹300 fee;
 * - a different real visit — `another_consultation`. A second arrival under a
 *   new token, and the one case a fresh reference is right for.
 *
 * **When it names none, the attempt's own identity answers instead.** Signing
 * sets the appointment to `done` and the poll takes it out of the snapshot, so
 * the tablet legitimately has nothing live to offer — but it still knows what
 * it began against, and that is compared rather than treating the silence as a
 * direct consultation.
 */
/*
 * ── WHY 'another_visit' IS NOT 'another_consultation' (owner item 74) ──────
 *
 * Until Slice 2 these were one verdict, and the tablet ROTATED on it: a key
 * naming a different visit was treated as proof that the attempt in hand
 * belonged to somebody else's consultation, so a fresh reference was minted
 * and the next press signed.
 *
 * Owner item 74 says that is not proof:
 *
 *   > Reception creating B is not, by itself, proof of a second consultation.
 *
 * And the case it has in mind is the ordinary one. A signing on queued visit A
 * commits, the reply is lost, A goes `done` and drops out of the poll, and
 * reception — seeing the patient still standing there — arrives them again as
 * visit B. Two real visits, one attendance. Rotating there writes a second
 * encounter and a second fee, which is W1 reached by minting rather than by
 * retrying.
 *
 * A different PATIENT or DOCTOR is still proof, and still rotates: that key
 * cannot be a retry of this request whatever else is true, and holding it
 * would refuse a patient who has done nothing wrong, for ever.
 *
 * So the two are separated, and the visit disagreement gets a code the tablet
 * does not rotate on. What ends it is the doctor saying which it is —
 * `resolve_consultation_attempt` — rather than the software guessing.
 */
type BindingVerdict =
  | 'compatible'
  | 'another_consultation'
  | 'another_visit'
  | 'signed_without_this_visit'

function compareBinding(original: SignedConsultation, asked: AttemptBinding): BindingVerdict {
  if (original.patient_id !== asked.patientId) return 'another_consultation'
  if (original.doctor_id !== asked.doctorId) return 'another_consultation'

  const stored = original.appointment_id ?? null

  if (asked.liveVisitId !== null) {
    if (stored === asked.liveVisitId) return 'compatible'
    return stored === null ? 'signed_without_this_visit' : 'another_visit'
  }

  // Nothing live. The attempt's own identity is the next best thing it has,
  // and a caller that sends neither is the pre-correction shape: compatible,
  // because silence from a client that has nothing else to say is not a
  // disagreement.
  if (asked.openedVisitId === null) return 'compatible'
  if (stored === null) return 'compatible'
  return stored === asked.openedVisitId ? 'compatible' : 'another_visit'
}

/**
 * The attempt is settled, and this caller is not the one who settled it.
 *
 * Thrown from inside the transaction and carried out of it rather than
 * answered in place, because the answer — the original encounter, its
 * prescription number and its signing time — is read after the rollback,
 * exactly as the unique-index race below is. It is an internal signal and
 * never reaches a screen.
 */
class AttemptSettledElsewhere extends Error {
  constructor() {
    // Carries a message only because the unreachable fallback below rethrows
    // it, and an error with no words is the worst thing to find in a log.
    super('This consultation was signed by another request holding the same reference.')
    this.name = 'AttemptSettledElsewhere'
  }
}

/**
 * The advisory-lock namespace one consultation attempt serializes in.
 *
 * ── WHY A LOCK, WHEN THERE IS ALREADY A UNIQUE INDEX ───────────────────────
 *
 * The index serializes two SIGNINGS. It cannot serialize a signing against a
 * RESOLUTION, because the two write different tables and neither collides with
 * the other — and that pair is the one owner item 73 fails closed on:
 *
 *   > If the outcome cannot be established, fail closed.
 *
 * Without this, a doctor resolving an attempt reads "no encounter carries this
 * key", concludes nothing committed, records **New attendance**, releases the
 * attempt — and the signing that was in flight the whole time commits a
 * moment later. The next press then writes a second encounter and a second
 * ₹300 fee, which is exactly the harm the resolution existed to avoid.
 *
 * So both sides take this lock on the key, first, before anything else in
 * their transaction. A signing waits for a resolution, briefly. A resolution
 * does NOT wait for a signing: it uses `pg_try_advisory_xact_lock` and refuses
 * with `ATTEMPT_OUTCOME_NOT_ESTABLISHED`, because "somebody is signing under
 * this key right now" is precisely the state in which the prior outcome cannot
 * be established, and waiting for it would be answering a question that has
 * not been decided yet.
 *
 * Taken before any row lock, in both, so the ordering is the same in both and
 * neither can deadlock against the other. The number itself is in
 * `idempotency.ts`, because `workspace.ts` tests the same lock to answer
 * whether a signing is in flight, and two copies of an agreed number are one
 * copy too many.
 */

/** Hold this attempt for the length of the transaction. Signing waits; it does not refuse. */
async function holdAttempt(idempotencyKey: string): Promise<void> {
  await db.prepare(
    `select pg_advisory_xact_lock(${ATTEMPT_LOCK_NAMESPACE}, hashtext(?))`,
  ).get(idempotencyKey)
}

/** The doctor's determination about this attempt, if one has been recorded. */
async function resolutionFor(idempotencyKey: string): Promise<Row | undefined> {
  return await db.prepare(
    `select r.id, r.resolution, r.prior_outcome, r.encounter_id, r.subject_visit_id,
            r.subject_visit_closed, r.subject_visit_disposition,
            r.reason, r.request_fingerprint, r.resolved_by, r.resolved_at,
            r.patient_id,
            s.name as resolved_by_name
       from consultation_attempt_resolutions r
       join staff s on s.id = r.resolved_by
      where r.idempotency_key = ?`,
  ).get(idempotencyKey) as Row | undefined
}

/**
 * This attempt was settled by a person, and nothing was written under it.
 *
 * Owner item 73: only an audited resolution or an already-confirmed replay may
 * release an attempt. The other half of that promise is that the release has
 * to STICK — a tablet still holding the settled reference, offline in somebody
 * pocket for an hour, must not be able to sign under it when it reconnects.
 *
 * Reached only where the key carries no encounter. Where it carries one, the
 * replay path answers first and answers better: it hands back the consultation
 * that exists.
 */
function refuseSettledAttempt(resolution: Row, visitNamed: string | null = null): never {
  const determination = String(resolution.resolution ?? '')
  const who = String(resolution.resolved_by_name ?? 'a doctor')
  const closed = String(resolution.subject_visit_id ?? '')
  const didClose = String(resolution.subject_visit_disposition ?? '') === 'closed_now'

  /*
   * Same attendance is the one determination a fresh reference must NOT
   * follow, and it is the reason this branches at all.
   *
   * The doctor has said the visit and the consultation are one attendance and
   * the visit has been closed. Rotating there would leave the tablet with no
   * live visit to name, so the next press would write a DIRECT consultation
   * and a second fee for the attendance that was just reconciled — W1 arriving
   * through the door built to close it.
   */
  if (determination === 'same_attendance') {
    /*
     * And only if it is THIS visit that was closed.
     *
     * The first version said "and closed it" unconditionally, which is false
     * whenever the determination named no visit or a different one — and worse
     * than false, because the code it carries does not rotate, so a doctor who
     * resolved without naming a visit could not sign the one still in front of
     * them, and the reference's single resolution was already spent. The
     * independent review walked it end to end.
     *
     * A visit the determination did not speak to is a separate matter, and the
     * reference is settled, so it takes the code the tablet DOES rotate on and
     * the next press signs it in the ordinary way.
     */
    /*
     * The DISPOSITION, and not the id, and not the boolean either.
     *
     * The third review's finding was that this said "and closed it" about a
     * determination that had closed nothing. The owner decision of 16
     * September 2026 makes that distinction a real one rather than a defect to
     * be designed out: a doctor may link retrospectively to a visit that was
     * already finished, and what is recorded is which of the two happened.
     *
     * So there are two sentences here, both true, and the row says which one
     * to use. `already_done` is exactly the case the earlier version would
     * have described as a closure the doctor performed.
     */
    if (visitNamed !== null && closed !== '' && closed === visitNamed) {
      if (didClose) {
        throw new CommandRefusal(
          `${who} has already recorded that visit as the same attendance as a consultation signed under ` +
          'this reference, and closed it. Nothing was recorded twice and nothing was charged. Open the ' +
          'patient’s record to see what was signed.',
          'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE',
        )
      }
      throw new CommandRefusal(
        `${who} has already recorded that visit as the same attendance as a consultation signed under ` +
        'this reference. The visit was already finished, so nothing about it was changed, nothing was ' +
        'recorded twice and nothing was charged. Open the patient’s record to see what was signed.',
        'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE',
      )
    }
    if (visitNamed === null) {
      throw new CommandRefusal(
        `${who} has already recorded the consultation signed under this reference as one attendance. ` +
        'Nothing was recorded twice and nothing was charged. Open the patient’s record to see what ' +
        'was signed.',
        'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE',
      )
    }
    throw new CommandRefusal(
      `${who} has already closed this reference as one attendance, and that determination did not name ` +
      'the visit you have open. Nothing was recorded twice and nothing was charged. Sign again and the ' +
      'tablet will use a fresh reference.',
      'ATTEMPT_SETTLED_BY_RECONCILIATION',
    )
  }

  /*
   * New attendance and an abandoned attempt both settle the reference, and
   * owner item 73 names exactly this as a release: "Only that audited
   * resolution, or an already-confirmed successful replay, may release the
   * attempt." So this code is one the tablet DOES rotate on — the doctor has
   * said, on the record, that the next consultation is a different one.
   */
  throw new CommandRefusal(
    `This reference was closed by ${who} as ` +
    `${determination === 'new_attendance' ? 'a new attendance' : 'an abandoned attempt'}, ` +
    'and nothing was recorded under it. Nothing has been changed or charged now either. ' +
    'Sign again and the tablet will use a fresh reference.',
    'ATTEMPT_SETTLED_BY_RECONCILIATION',
  )
}

/**
 * Before repeating that a visit cannot be signed: did WE sign it?
 *
 * Asked only where a visit has turned out not to be signable, and that is
 * precisely where it matters. The row lock this transaction has just finished
 * waiting on was held by whoever closed the visit — and when that whoever is
 * the other half of this same attempt, two tablets pressing Finish on one
 * queued patient, the loser is not looking at a visit it may not sign. It is
 * looking at its own consultation, a millisecond old.
 *
 * Without this, that loser was told "That visit is already finished or does
 * not belong to this patient." Both halves of that sentence are false, the
 * consultation it asked for exists, and the doctor holding the second tablet
 * has no way to tell this apart from a real conflict. Reproduced on staging by
 * the concurrency test that finally exercised the lock — the older one used a
 * patient with no visit at all, so it never reached this code.
 */
async function settledElsewhere(idempotencyKey: string): Promise<void> {
  if (await signedConsultationFor(idempotencyKey)) throw new AttemptSettledElsewhere()
}

/**
/**
 * Which visit a first signing attaches itself to, and when it must refuse.
 *
 * ── THE CASE THIS GOT WRONG, AND WHAT IT COST ────────────────────────
 *
 * Slice 2 let the live visit win unconditionally: "the tablet is looking at
 * it". The acceptance review reproduced what that means when the attempt was
 * opened against a DIFFERENT visit and nothing has committed under it — the
 * consultation is signed against B, an encounter and a ₹300 fee are written,
 * and A is left standing in the queue, having been stepped around without
 * anybody deciding anything.
 *
 * Owner item 74 covers exactly this: "If A did not commit, the doctor
 * explicitly chooses which active attendance continues; the abandoned path is
 * preserved in audit." Two live visits and one attempt is not a question the
 * software may answer. It fails closed, before any clinical or financial
 * write, and a doctor resolves it.
 *
 * ── THE FIVE SHAPES, AND WHY ONLY ONE OF THEM REFUSES ─────────────────
 *
 *   opened  live   what it is
 *   ------  ----   --------------------------------------------------------
 *   none    none   a patient opened from the register. A direct consultation.
 *   none    B      a walk-in that acquired a visit mid-attempt. Policy item 3
 *                  allows creating it, and it is the same consultation: sign
 *                  against B rather than leave it waiting and unlinked.
 *   A       none   the ordinary retry. Signing takes the visit out of the
 *                  snapshot, so having nothing live to send is the SHAPE of a
 *                  retry rather than a claim that no visit exists.
 *   A       A      agreement. Sign it.
 *   A       B      TWO real visits and one attempt that has committed
 *                  nothing. Refused.
 *
 * Every refusal here is preceded by `settledElsewhere`, because each is
 * reached only after a lock wait, and a lock wait is exactly when the question
 * "has this attempt already been signed?" changes its answer.
 */
/**
 * A visit already recorded as the same attendance as a signed consultation.
 *
 * Owner item 72 closes it and charges nothing again; signing it would do both
 * of the things that determination exists to prevent. The fourth acceptance
 * review reached this by reopening the visit through the queue.
 */
async function refuseAReconciledVisit(visitId: string, idempotencyKey: string): Promise<void> {
  const determined = await db.prepare(
    `select r.id, a.token
       from consultation_attempt_resolutions r
       join appointments a on a.id = r.subject_visit_id
      where r.subject_visit_id = ? and r.resolution = 'same_attendance'
      limit 1`,
  ).get(visitId) as Row | undefined
  if (!determined) return

  await settledElsewhere(idempotencyKey)
  throw new CommandRefusal(
    `${String(determined.token ?? 'That visit')} was already recorded as the same attendance as a ` +
    'consultation signed for this patient, so it has been seen and paid for. Nothing was recorded and ' +
    'nothing was charged. If the patient is here again, arrive them afresh and consult that visit.',
    'VISIT_RECONCILED_AND_CLOSED',
  )
}

async function visitToSignAgainst(
  patientId: string,
  binding: AttemptBinding,
  idempotencyKey: string,
): Promise<string> {
  /*
   * Asked first, before either visit is read, because the answer does not
   * depend on their status and because nothing may be written while it is
   * true. A visit that has since been cancelled does not make this safe: the
   * attempt still began somewhere else, and which attendance continues is
   * still the doctor's to say.
   */
  if (
    binding.openedVisitId && binding.liveVisitId
    && binding.openedVisitId !== binding.liveVisitId
  ) {
    await settledElsewhere(idempotencyKey)
    throw new CommandRefusal(
      'This consultation was started against a different visit for this patient, and nothing has been ' +
      'recorded under it yet. Nothing was changed and nothing was charged. If the patient never left ' +
      'and reception arrived them twice, close it as the same attendance; if they have genuinely come ' +
      'back, record a new attendance — and the clinic will not decide which it was on its own.',
      'ATTEMPT_NEEDS_RECONCILIATION',
    )
  }

  if (binding.liveVisitId) {
    /*
     * The same lock and the same refusal as `requireActiveAppointment`, read
     * out here rather than called, for one reason: `settledElsewhere` runs a
     * query, and a query on an ABORTED transaction raises 25P02 instead of
     * answering. Wrapping the call in try/catch meant that a deadlock or a
     * statement timeout inside it — a Postgres error, not "the visit is not
     * active" — left the transaction aborted, and the probe's own failure
     * became the error the doctor read. Asking only after a SELECT that
     * succeeded cannot do that.
     */
    const live = await db.prepare(
      `select status from appointments where id=? and patient_id=? for update`,
    ).get(binding.liveVisitId, patientId) as { status: string } | undefined

    /*
     * Before the status is even looked at, because the answer does not depend
     * on it and because a reconciled visit that has somehow been reopened is
     * the one case where "waiting" is not permission to sign.
     *
     * Unreachable while the trigger holds — a same-attendance subject cannot
     * return to the queue — and here anyway, because the review's finding was
     * that one guarantee written in one place is a guarantee waiting to be
     * walked around, and because a doctor meeting this deserves the reason
     * rather than a constraint name.
     */
    await refuseAReconciledVisit(binding.liveVisitId, idempotencyKey)

    if (live && (live.status === 'waiting' || live.status === 'in_consult')) {
      return binding.liveVisitId
    }
    await settledElsewhere(idempotencyKey)
    throw new Error('That visit is already finished or does not belong to this patient.')
  }
  if (!binding.openedVisitId) return ''

  const opened = await db.prepare(
    `select status from appointments where id=? and patient_id=? for update`,
  ).get(binding.openedVisitId, patientId) as { status: string } | undefined

  if (!opened) {
    await settledElsewhere(idempotencyKey)
    // Two facts share this branch, because the query asks about both at once:
    // the visit is gone, or it belongs to somebody else. Saying only the first
    // would be a confident sentence that is sometimes false, and the answer —
    // refuse, write nothing — is the same either way.
    throw new CommandRefusal(
      'This consultation was started against a visit that is no longer in the clinic’s records, ' +
      'or that belongs to a different patient. Nothing was recorded. Create today’s visit for ' +
      'this patient and sign again.',
      'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
    )
  }

  if (opened.status === 'waiting' || opened.status === 'in_consult') {
    // The tablet's snapshot was simply behind. The visit is open; sign against
    // it rather than quietly making this a consultation with no visit at all.
    return binding.openedVisitId
  }

  /*
   * Cancelled, or finished by somebody else, and nothing was ever recorded
   * under this reference.
   *
   * Signing now would have to become a direct consultation, and that is the
   * bypass: a cancelled visit would be stepped around, an encounter written
   * against nothing, and ₹300 charged for an attendance the clinic had been
   * told did not happen. It refuses instead, and it does NOT carry the code
   * the tablet rotates on — a fresh reference here writes exactly the
   * unlinked consultation this refusal exists to prevent.
   *
   * The way forward is a clinic act rather than a retry: create today’s visit,
   * which mints a new attempt through the ordinary rule and signs against it.
   *
   * Unless the attempt itself is what closed the visit, which is the twin
   * above arriving by this door: a second tablet whose `openedVisitId` names
   * the visit the first tablet has just signed and set to `done`.
   */
  await settledElsewhere(idempotencyKey)
  throw new CommandRefusal(
    `This consultation was started against a visit that has since been ${opened.status === 'cancelled' ? 'cancelled' : 'closed'}. ` +
    'Nothing was recorded and nothing was charged. Create today’s visit for this patient and ' +
    'sign again, so the consultation is attached to the visit it belongs to.',
    'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
  )
}

/**
 * Answer a retry with what the clinic actually recorded the first time.
 *
 * Not with a fresh success. The prescription number, the encounter and the
 * signing time all have to be the ORIGINAL ones, because the screen behind
 * this prints them, and a second set of numbers for one visit is the same
 * fault as a second bill for it.
 *
 * Two refusals stand between a caller and that replay, and they are separate
 * on purpose.
 *
 * `ATTEMPT_NAMES_ANOTHER_CONSULTATION` — the key is bound to a different
 * patient, doctor or visit. This request is provably not a retry of what the
 * key named, so replaying would file one visit's consultation under another's.
 * It is safe for the tablet to rotate the reference and try again, because
 * whatever the key named is settled and this is not it.
 *
 * `CONSULTATION_ALREADY_SIGNED` — same patient, same doctor, same visit, and a
 * different sheet. This IS the consultation the key named; it committed, and
 * what has changed is what the doctor is now asking to record. Signing is
 * immutable, so the answer is no, and the answer must NOT invite a rotation:
 * a fresh key here writes a second encounter and a second fee for one visit,
 * which is the whole of W1 arriving by another road. The recorded consultation
 * is named so the doctor can go and look at it.
 */
function replayConsultation(
  original: SignedConsultation,
  binding: AttemptBinding,
  fingerprint: string,
  resolution?: Row,
) {
  const verdict = compareBinding(original, binding)

  /*
   * A doctor has already answered the question this refusal would ask.
   *
   * Both of the verdicts below — a different visit, and a visit where the
   * encounter has none — end in "somebody has to decide which of two things
   * is true". Once somebody has, repeating the question is the worst possible
   * answer: the doctor reads the identical refusal they read before
   * resolving, with no hint that their decision was recorded, and there is no
   * way forward from the screen at all.
   *
   * Found by the independent acceptance review, which walked it as a loop with
   * no exit. The resolution is looked up beside the encounter and answered
   * from here instead.
   */
  if (resolution && (verdict === 'another_visit' || verdict === 'signed_without_this_visit')) {
    refuseSettledAttempt(resolution, binding.liveVisitId)
  }

  if (verdict === 'another_consultation') {
    throw new CommandRefusal(
      'That reference belongs to a different consultation — another patient or another doctor. ' +
      'Nothing was changed. Sign again and the tablet will use a fresh reference.',
      'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
    )
  }

  /*
   * One attendance or two, and the clinic cannot tell.
   *
   * The key named a real visit and the request names a different real visit.
   * That is either a patient who came back — in which case a second
   * consultation is right — or a patient who never left, whose first visit was
   * closed by the signing this key already did and who was then arrived again
   * by reception while they stood at the desk.
   *
   * Owner item 74 decides which way to fail: "Do not automatically mint a new
   * attempt. First establish the old key's outcome... Reception creating B is
   * not, by itself, proof of a second consultation." So this refusal carries a
   * code the tablet does NOT rotate on, nothing is written, nothing is
   * charged, and the way forward is `resolve_consultation_attempt` — a doctor
   * saying **Same attendance** or **New attendance**, on the record.
   */
  if (verdict === 'another_visit') {
    const named = original.prescription_number ? ` as ${original.prescription_number}` : ''
    throw new CommandRefusal(
      `This reference already signed a consultation${named}, against a different visit for this patient. ` +
      'Nothing was recorded twice and nothing was charged. If that was this same attendance, close it as ' +
      'the same attendance; if the patient has genuinely come back, record a new attendance — and the ' +
      'clinic will not decide which it was on its own.',
      'ATTEMPT_NEEDS_RECONCILIATION',
    )
  }

  /*
   * Signed already, and not against the visit now open.
   *
   * The consultation committed when the tablet could not hear it, and a visit
   * row has appeared since. Three things are true at once and all three have
   * to be said: nothing was recorded twice, the consultation exists and is
   * named, and the visit on screen is still waiting and is attached to
   * nothing.
   *
   * What this deliberately does NOT do is decide what happens to that visit.
   * Linking it to a consultation that is already signed edits a signed record;
   * cancelling it decides a visit the doctor deliberately created did not
   * happen. Both are clinic policy and neither is a read model's to choose, so
   * the clinic is told exactly what it is holding and a person decides. The
   * alternatives are written out in the programme register.
   *
   * It carries a code, and that code is NOT one the tablet rotates on: a fresh
   * reference here signs the same consultation a second time, which is the
   * whole of W1 arriving by the one road still open to it.
   */
  if (verdict === 'signed_without_this_visit') {
    const named = original.prescription_number ? ` as ${original.prescription_number}` : ''
    throw new CommandRefusal(
      `This consultation was already signed${named}, before the visit you have open was created, ` +
      'so it is not attached to that visit. Nothing was recorded twice and nothing was changed. ' +
      'The visit is still waiting — close it from the queue, or open the patient’s record to see ' +
      'what was signed.',
      'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT',
    )
  }

  if (original.request_fingerprint !== fingerprint) {
    const named = original.prescription_number
      ? ` as ${original.prescription_number}`
      : ''
    throw new CommandRefusal(
      `This visit was already signed${named}, and what you have just sent differs from what was ` +
      'recorded. Nothing was changed and nothing was recorded twice. A signed consultation ' +
      'cannot be edited — open the patient’s record to see what was signed.',
      'CONSULTATION_ALREADY_SIGNED',
    )
  }

  return {
    message: original.prescription_number
      ? `This consultation was already signed as ${original.prescription_number}. Nothing was recorded twice.`
      : 'This consultation was already signed. Nothing was recorded twice.',
    data: {
      encounterId: original.encounter_id,
      prescriptionId: original.prescription_id ?? undefined,
      prescriptionNumber: original.prescription_number ?? undefined,
      signedAt: original.created_at,
      duplicate: true,
    },
  }
}

/**
 * A visit named in a reconciliation belongs to the patient being reconciled.
 *
 * Every one of the three determinations may carry an `openedVisitId` and a
 * `subjectVisitId`, and until the acceptance correction only the encounter was
 * checked against the patient. So a doctor could record that one patient's
 * queue row was the same attendance as another patient's consultation, and the
 * row was accepted, stored, and would have closed the wrong person's visit.
 *
 * Read `for update`, because the answer decides whether a visit is about to be
 * closed and the row must not move underneath that decision.
 *
 * The database refuses it too — `20260921000000` adds composite foreign keys
 * on `(visit, patient)` — and both are wanted. The constraint is the guarantee
 * and cannot be forgotten; this is the sentence a doctor reads, which a
 * constraint violation is not.
 */
async function visitOfThisPatient(
  visitId: string,
  patientId: string,
  whichOne: string,
): Promise<Row> {
  const visit = await db.prepare(
    `select id, token, status from appointments where id=? and patient_id=? for update`,
  ).get(visitId, patientId) as Row | undefined
  if (!visit) {
    throw new CommandRefusal(
      `The ${whichOne} was not found, or belongs to a different patient. Nothing was changed.`,
      'VISIT_NOT_THIS_PATIENTS',
    )
  }
  return visit
}

/** The three determinations, in the words the audit trail carries. */
const RESOLUTION_WORDS: Record<string, string> = {
  same_attendance: 'Same attendance',
  new_attendance: 'New attendance',
  abandoned_attempt: 'Abandoned attempt',
}

/**
 * What the clinic says back, and what it deliberately does not say.
 *
 * None of these says "completed". Nothing clinical or financial happened here
 * — no encounter, no fee, no prescription — and a sentence that reads like a
 * confirmation of work done is the one thing this must not be mistaken for.
 * What each one confirms is a decision having been recorded and a reference
 * having been let go.
 */
/**
 * What the clinic says back, by what actually happened.
 *
 * The disposition rather than a boolean, because owner item 75 made three
 * outcomes out of two and a boolean collapsed two of them into one sentence:
 * a retrospective link to a visit already finished read exactly like a
 * determination that named no visit at all. The independent review found it.
 */
type Disposition = 'closed_now' | 'already_done' | 'not_applicable'

const RESOLUTION_MESSAGES: Record<string, (disposition: Disposition) => string> = {
  same_attendance: (disposition) =>
    disposition === 'closed_now'
      ? 'Recorded as one attendance. The consultation already signed stands unchanged, the visit is closed, ' +
        'and nothing was charged again.'
      : disposition === 'already_done'
      ? 'Recorded as one attendance. That visit was already finished, so nothing about it changed; the ' +
        'consultation already signed stands unchanged and nothing was charged again.'
      : 'Recorded as one attendance. The consultation already signed stands unchanged and nothing was charged again.',
  new_attendance: () =>
    'Recorded as a new attendance. The earlier reference is closed and nothing was charged; the visit is ' +
    'still open and can be consulted and signed in the ordinary way.',
  abandoned_attempt: () =>
    'Recorded as abandoned. Nothing was ever written under that reference and nothing was charged.',
}

/**
 * Answer a repeat with the determination that was actually recorded.
 *
 * The same shape as `replayConsultation`, and it is here for the same reason:
 * a doctor whose reply was lost presses again, and a second row would be a
 * second determination about one attempt — which, where the first closed a
 * visit, would be a second attempt to close a visit that is already closed.
 *
 * A REPEAT is answered. A DIFFERENT determination under the same reference is
 * refused rather than answered with the first one's words: changing one's mind
 * about whether a patient attended once or twice is a real thing to do, and
 * the way to do it is to look at what was recorded, not to have this command
 * quietly tell you it agrees with you.
 */
function replayResolution(existing: Row, fingerprint: string) {
  const determination = String(existing.resolution ?? '')

  if (String(existing.request_fingerprint ?? '') !== fingerprint) {
    throw new CommandRefusal(
      `This reference was already closed by ${String(existing.resolved_by_name ?? 'a doctor')} as ` +
      `${RESOLUTION_WORDS[determination]?.toLowerCase() ?? determination}, and what you have just sent ` +
      'differs from that. Nothing was changed. Open the patient’s record to see what was recorded.',
      'RECONCILIATION_ALREADY_RESOLVED',
    )
  }

  return {
    message: `${RESOLUTION_WORDS[determination] ?? determination} was already recorded for this reference. ` +
      'Nothing was recorded twice.',
    data: {
      resolutionId: String(existing.id ?? ''),
      resolution: determination,
      priorOutcome: String(existing.prior_outcome ?? ''),
      attemptReleased: true,
      encounterId: existing.encounter_id ? String(existing.encounter_id) : undefined,
      subjectVisitId: existing.subject_visit_id ? String(existing.subject_visit_id) : undefined,
      subjectVisitClosed: existing.subject_visit_closed === true,
      subjectVisitDisposition: String(existing.subject_visit_disposition ?? 'not_applicable'),
      resolvedAt: String(existing.resolved_at ?? ''),
      duplicate: true,
    },
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

  /*
   * The key, and the two things it is not.
   *
   * It is not required, because a tablet running the build that is deployed
   * today does not send one and must keep working until it is replaced. A
   * caller that sends nothing gets a key of its own here, which protects it
   * from nothing — that is the honest position and the remaining exposure is
   * written down in `docs/reference/BACKEND_PROGRAMME_REGISTER.md`. It keeps
   * the column uniform so that every encounter signed from now on can be found
   * by the reference it was signed under.
   *
   * And it is not the whole guard. `visitToSignAgainst` still refuses a second
   * signature on a visit that came from the queue, on facts rather than on the
   * caller's word. The key covers the case that check cannot see — a patient
   * opened from the register with no visit row open — which is precisely the
   * case that was charging twice.
   */
  const idempotencyKey = optional(payload, 'idempotencyKey') || `consultation:${randomUUID()}`
  const fingerprint = consultationFingerprint(fields, prescriptionItems, payload)

  /*
   * What this attempt says it is for, in both senses of "which visit".
   *
   * `appointmentId` is what the tablet has on screen now. `openedVisitId` is
   * what the attempt began against and never changes, and it is additive: a
   * caller that does not send it behaves exactly as before, which is what
   * keeps the deployed build working.
   *
   * Neither replaces the other, because each answers a question the other
   * cannot. The live one attaches the consultation to the visit in front of
   * the doctor — without it, a visit created mid-attempt stayed `waiting` and
   * unlinked. The opened one says which consultation this is when the live one
   * has gone — without it, a visit that was cancelled between the lost reply
   * and the retry was bypassed entirely and ₹300 was charged against nothing.
   * Both were reproduced on staging.
   */
  const binding: AttemptBinding = {
    patientId,
    doctorId: session.staffId,
    openedVisitId: optional(payload, 'openedVisitId') || null,
    liveVisitId: optional(payload, 'appointmentId') || null,
  }

  // The courteous path, checked before anything is written; the lock and the
  // unique index below are the guarantees, and they are what hold when two
  // tablets submit the same key in the same breath.
  const already = await signedConsultationFor(idempotencyKey)
  const settledEarly = await resolutionFor(idempotencyKey)
  if (already) return replayConsultation(already, binding, fingerprint, settledEarly)
  if (settledEarly) refuseSettledAttempt(settledEarly)

  const raced = await transaction(async () => {
    /*
     * First statement in the transaction, before any row lock and before the
     * first write.
     *
     * It settles this attempt against the two things that can be happening to
     * it at the same moment: another tablet signing under the same reference,
     * and a doctor resolving the reference through
     * `resolve_consultation_attempt`. Both take the same lock in the same
     * order, so neither can read a half-finished version of the other, and
     * neither can deadlock against it.
     */
    await holdAttempt(idempotencyKey)

    /*
     * Re-asked under the lock, and the answers are different facts.
     *
     * A consultation that appeared here since the pre-check means the other
     * tablet won; `AttemptSettledElsewhere` carries that out of the
     * transaction to the same replay the unique index used to be the only
     * route to — which is what makes the concurrent case deterministic rather
     * than a race between two correct branches.
     *
     * A resolution that appeared here means a doctor closed the reference
     * while this request was on its way. Owner item 73: that release must
     * stick.
     */
    const winner = await signedConsultationFor(idempotencyKey)
    if (winner) throw new AttemptSettledElsewhere()
    const settled = await resolutionFor(idempotencyKey)
    if (settled) refuseSettledAttempt(settled)

    // Resolved inside the transaction, because it takes a row lock: the same
    // `for update` that makes two tablets signing one queued visit wait for
    // each other rather than both succeeding.
    const appointmentId = await visitToSignAgainst(patientId, binding, idempotencyKey)
    /*
     * The first write in the transaction, and deliberately so.
     *
     * `idempotency_key` is uniquely indexed, so if another tablet is signing
     * this same attempt the collision happens HERE — before a prescription
     * number is spent, before an invoice is opened, before a phrase count is
     * incremented. Everything still rolls back either way; putting the
     * serialization point first simply means the losing caller waits on a
     * shorter transaction and burns less.
     */
    await db.prepare(`insert into encounters
      (id,patient_id,doctor_id,appointment_id,diagnosis,notes,advice,created_at,
       complaint,complaint_duration_value,complaint_duration_unit,examination,
       diagnosis_status,aetiology,aetiology_certainty,follow_up_date,
       idempotency_key,request_fingerprint)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        encounterId, patientId, session.staffId, appointmentId || null,
        fields.diagnosis, fields.notes, fields.advice, signedAt, fields.complaint,
        fields.complaintDurationValue ?? null, fields.complaintDurationUnit ?? null,
        fields.examination, fields.diagnosisStatus, fields.aetiology,
        fields.aetiologyCertainty, fields.followUpDate ?? null,
        idempotencyKey, fingerprint,
      )

    if (prescriptionItems.length > 0) {
      prescriptionId = randomUUID()
      prescriptionNumber = await sequence('RX')
      /*
       * How long the remainder may be collected against.
       *
       * Policy register 18: seven calendar days from signing is the clinic
       * default, and the doctor may shorten or extend it for one prescription.
       * It is written at signing rather than computed on read, because the
       * default may change and this prescription's direction must not.
       */
      const validUntil = optionalDate(payload, 'validUntil')
      await db.prepare(`insert into prescriptions
        (id,patient_id,encounter_id,doctor_id,items_json,signed_at,prescription_number,
         valid_until,supply_in_parts,validity_set_by,validity_reason)
        values (?,?,?,?,?,?,?,
                coalesce(?::date, ${CLINIC_TODAY} + 7),
                ?,?,?)`).run(
          prescriptionId, patientId, encounterId, session.staffId,
          JSON.stringify(prescriptionItems), signedAt, prescriptionNumber,
          validUntil ?? null,
          payload.supplyInParts === undefined ? true : booleanValue(payload, 'supplyInParts'),
          validUntil ? session.staffId : null,
          validUntil ? optional(payload, 'validityReason') : '',
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
          fields.followUpNote || fields.advice,
        )
    }

    /*
     * The consultation fee.
     *
     * It comes from the clinic's settings, not from the browser. Until Slice 4
     * it came from a literal 300 in the doctor's form, so an admin who changed
     * the fee on the Clinic screen changed nothing that was ever billed — and
     * the figure charged was whatever the tablet happened to send.
     *
     * Policy register 15 and 16: the admin sets the default, the doctor may
     * override, discount or waive it for ONE consultation with a reason, and a
     * later change to the default never rewrites an old visit. So the amount
     * charged is snapshotted onto the encounter, and the default in force at
     * the time is snapshotted beside it — otherwise "was this a discount?" is
     * unanswerable a month later.
     *
     * A waived visit is an explicit ₹0 line with a reason and an actor, not an
     * absent one (policy register 33). A missing line cannot say who decided.
     *
     * At most one fee line per ENCOUNTER, and that is not a promise made here:
     * `invoice_lines.source_key` is uniquely indexed clinic-wide and this key
     * is `consultation:${encounterId}`.
     *
     * Read that carefully, because this comment used to say the index meant "a
     * retry cannot produce a second one even on a second invoice" and that was
     * never true. One fee per encounter is a different promise from one fee per
     * VISIT, and the gap between them is the whole of W1: `encounterId` was a
     * fresh uuid on every call, so two signings of one sheet held two keys that
     * could never collide, and the patient was handed a ₹600 bill for a ₹300
     * consultation. What closes that is the idempotency key on the encounter
     * above — not this index, which is doing a smaller job correctly.
     */
    const settings = await db.prepare('select consultation_fee from clinic_settings where id=1')
      .get() as { consultation_fee: string } | undefined
    const defaultFeePaise = parseMoney(settings?.consultation_fee ?? '0', 'The clinic consultation fee')

    const waived = booleanValue(payload, 'feeWaived')
    const overridden = optional(payload, 'consultationFee') !== ''
    const feePaise = waived ? 0 : (overridden
      ? parseMoney(payload.consultationFee, 'The consultation fee')
      : defaultFeePaise)
    const feeReason = optional(payload, 'feeReason')

    if (waived && !feeReason) {
      throw new Error('Say why this consultation is being waived. A free visit is recorded, not omitted.')
    }
    if (!waived && overridden && feePaise !== defaultFeePaise && !feeReason) {
      throw new Error(
        `The clinic fee is ${rupees(defaultFeePaise)}. Say why this visit is being charged ` +
        `${rupees(feePaise)}.`,
      )
    }

    await db.prepare(`update encounters set
        consultation_fee=?, consultation_fee_default=?, fee_waived=?, fee_reason=?,
        fee_set_by=?, fee_set_at=now()
      where id=?`).run(
        money(feePaise), money(defaultFeePaise), waived, feeReason, session.staffId, encounterId,
      )

    {
      const invoiceId = await openInvoice({ patientId, encounterId, actorId: session.staffId })
      await addInvoiceLine(invoiceId, {
        source: 'consultation_fee',
        sourceKey: `consultation:${encounterId}`,
        description: waived ? 'Consultation (waived)' : 'Consultation',
        quantity: 1,
        unitAmountPaise: feePaise,
        amountPaise: feePaise,
        encounterId,
      })
      if (waived || (overridden && feePaise !== defaultFeePaise)) {
        await audit(session.staffId, 'consultation.fee_overridden', 'encounter', encounterId,
          `${waived ? 'Waived' : `Charged ${rupees(feePaise)} instead of ${rupees(defaultFeePaise)}`}: ${feeReason}`)
      }
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
  }).then(() => null, (error: unknown) => {
    /*
     * The race, arriving as a constraint.
     *
     * Two tablets holding one key both found nothing above and both opened a
     * transaction. The second one's insert waited on the first and then met
     * the unique index. Everything it had written rolled back with it — so the
     * clinic holds exactly one consultation, and the caller standing in front
     * of the second tablet should be told what that consultation IS rather
     * than shown the name of an index.
     *
     * The same event has a second door when the patient is IN THE QUEUE, and
     * that door is the appointment's row lock rather than the index. The loser
     * waits on the lock, the winner commits and sets the visit to `done`, and
     * the loser wakes to a visit it may no longer sign — having written
     * nothing, so the index never speaks. `AttemptSettledElsewhere` is that
     * caller arriving here anyway, because the recovery is identical: roll
     * back, look up what the key names, and answer with it.
     *
     * Caught here rather than around the whole call so that the transaction
     * body above keeps its own indentation and stays reviewable as itself.
     * Any other failure is re-thrown untouched: a refused fee reason and a
     * missing diagnosis are the clinic talking, and they must reach the screen
     * in their own words.
     */
    if (error instanceof AttemptSettledElsewhere) return error
    if (isUniqueViolation(error, 'encounters_idempotency_key')) return error
    throw error
  })

  if (raced) {
    const winner = await signedConsultationFor(idempotencyKey)
    if (winner) {
      return replayConsultation(winner, binding, fingerprint, await resolutionFor(idempotencyKey))
    }
    // The index refused this key and yet no encounter carries it. That should
    // be unreachable; if it ever happens, the original error is the only
    // truthful thing to report.
    throw raced
  }

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
  /*
   * `status='active'` joined the eligibility rule in Slice 3, and it is not
   * cosmetic. Before it, a batch the pharmacist had just marked RECALLED was
   * still the earliest-expiring row with stock, so FEFO picked it first — the
   * recall changed a column nobody read. Expired, recalled and held stock are
   * now one question asked in one place: `jmc.batch_availability.pickable`.
   */
  const rows = await db.prepare(`select id,batch_number,available_quantity,selling_price
    from batch_availability
    where medicine_id=? and pickable
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

/**
 * One order draft at a time, clinic-wide. A draft subtracts what is already on
 * order before it decides what is short, so two drafts worked out at the same
 * moment would each see the same shortfall and order it twice.
 */
const ORDER_DRAFT_LOCK = 517_301

/**
 * One change to the list of observation beds at a time. A bed's name is
 * unique however it is capitalised, and the table's own constraint only knows
 * the exact spelling, so "Bed 5" and "bed 5" added at the same moment would
 * both pass a check that ran before either was written.
 */
const BED_LIST_LOCK = 517_302

/** Longest bed name the board's card has room for. */
const BED_LABEL_LIMIT = 40

/** A bed's name as it is written on the bed: trimmed, single-spaced, short. */
function bedLabel(payload: Payload): string {
  const label = value(payload, 'label').replace(/\s+/g, ' ')
  if (label.length > BED_LABEL_LIMIT) {
    throw new Error(`A bed name can be at most ${BED_LABEL_LIMIT} characters.`)
  }
  return label
}

/** Order statuses whose outstanding quantity is still on its way to the shelf. */
const OPEN_ORDER_STATUSES = `('pending','placed','partially_delivered')`

/** The newest verified package, which is what a new order is counted in. */
async function orderPackage(medicineId: string): Promise<{ id: string; ladder: Ladder } | null> {
  const row = (await db.prepare(
    `select id, base_unit from package_versions
      where medicine_id=? and status='verified' order by version desc limit 1`,
  ).get(medicineId)) as { id: string; base_unit: string } | undefined
  if (!row) return null
  return { id: row.id, ladder: await ladderRows(row.base_unit, row.id) }
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
        /*
         * A visit recorded as the same attendance stays closed.
         *
         * This command moves any visit to any status, and the fourth
         * acceptance review walked straight through it: close a leftover visit
         * as the same attendance, put it back to `waiting` while tidying the
         * queue, sign it under a fresh reference — two encounters and two ₹300
         * fees for one attendance, through the door built to prevent that.
         * Reproduced: 2 encounters, ₹600.
         *
         * The independent review of this correction found the other half: the
         * first draft blocked `waiting` and `in_consult` and let `cancelled`
         * through, which cannot take money but leaves the determination saying
         * the patient was seen at that visit and the queue saying the visit
         * never happened. `done` is the only status left — and it must be
         * left, because the determination's own closure is an update this
         * check sees, with the resolution row already written.
         *
         * `appointments_reconciled_visits_stay_closed` is the guarantee and
         * covers every other way a status moves. This is the sentence a nurse
         * reads, which a trigger's exception is not, and it names what to do
         * instead.
         */
        if (status !== 'done') {
          const reconciled = await db.prepare(
            `select r.id, a.token, a.status
               from appointments a
               left join consultation_attempt_resolutions r
                 on r.subject_visit_id = a.id and r.resolution = 'same_attendance'
              where a.id = ? for update of a`,
          ).get(appointmentId) as Row | undefined
          if (reconciled?.id && String(reconciled.status) !== status) {
            throw new CommandRefusal(
              `${String(reconciled.token ?? 'That visit')} was recorded as the same attendance as a ` +
              'consultation that is already signed, so it stays closed. Putting it back into the queue ' +
              'would let it be consulted and charged a second time for one attendance; cancelling it ' +
              'would say the attendance never happened. Nothing was changed. If the patient is here ' +
              'again, arrive them afresh.',
              'VISIT_RECONCILED_AND_CLOSED',
            )
          }
        }

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
            notes=?,advice=?,follow_up_date=?,follow_up_note=?,updated_at=now()
            where id=? and doctor_id=?`).run(
              optional(payload, 'appointmentId') || null, fields.complaint,
              fields.complaintDurationValue ?? null, fields.complaintDurationUnit ?? null,
              fields.examination, fields.diagnosis, fields.diagnosisStatus, fields.aetiology,
              fields.aetiologyCertainty, fields.notes, fields.advice,
              fields.followUpDate ?? null, fields.followUpNote, draftId, session.staffId,
            )
        } else {
          await db.prepare(`insert into consultation_drafts
            (id,patient_id,doctor_id,appointment_id,complaint,complaint_duration_value,
             complaint_duration_unit,examination,diagnosis,diagnosis_status,aetiology,
             aetiology_certainty,notes,advice,follow_up_date,follow_up_note,created_at,updated_at)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now(),now())`).run(
              draftId, patientId, session.staffId, optional(payload, 'appointmentId') || null,
              fields.complaint, fields.complaintDurationValue ?? null,
              fields.complaintDurationUnit ?? null, fields.examination, fields.diagnosis,
              fields.diagnosisStatus, fields.aetiology, fields.aetiologyCertainty,
              fields.notes, fields.advice, fields.followUpDate ?? null, fields.followUpNote,
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
     * ── OWNER ITEMS 72, 73 AND 74: SAYING WHICH OF THE TWO THINGS IS TRUE ───
     *
     * A doctor pressed Finish, the consultation committed in Chennai, and the
     * reply was lost on the way home. The tablet says "Outcome not confirmed",
     * and the clinic is now holding either one attendance recorded twice over,
     * or two attendances one of which has not been recorded at all — and
     * nothing the software can read tells the two apart. `appointments` has no
     * column for "this is the same person who was standing here a minute ago",
     * and reception arriving them again is the ordinary way a busy desk
     * behaves rather than a statement about clinical work.
     *
     * Slice 1 made every ending of that story honest and none of them
     * finishable: the second signing is refused, the leftover visit is carried
     * as an obligation, and the attempt is held — held for ever, because
     * releasing it on a refusal reopens the second ₹300 fee. This is the
     * missing half. A doctor looks at what is in front of them and says which
     * it is, and that sentence is what releases the attempt.
     *
     * ── WHAT IT WILL NOT DO, AND WHY EACH ONE MATTERS ──────────────────────
     *
     * It will not edit the signed encounter. **Same attendance** links the
     * visit to the consultation in `consultation_attempt_resolutions`, and
     * `encounters.appointment_id` stays exactly as the doctor signed it. Owner
     * item 72's first clause, and the reason the link is a row of its own
     * rather than an update.
     *
     * It will not write a second encounter, invoice, fee line, prescription,
     * follow-up or phrase count. Nothing in this case reaches any of them.
     *
     * It will not guess at the outcome. `pg_try_advisory_xact_lock` is taken
     * first, and a signing in flight under the same reference means the
     * outcome is genuinely undecided — so it refuses with
     * `ATTEMPT_OUTCOME_NOT_ESTABLISHED` rather than reading an answer that is
     * about to change. Owner item 73's last sentence: fail closed.
     *
     * And only a doctor may do it. Same attendance or new attendance is a
     * statement about whether a patient was treated once or twice, which is
     * exactly the kind of judgement reception, a nurse, a pharmacist and an
     * administrator who is not also a doctor are not the people to make. The
     * programme's acceptance criterion says so in those words.
     */
    case 'resolve_consultation_attempt': {
      requireRole(session, 'doctor')
      const patientId = value(payload, 'patientId')
      const idempotencyKey = value(payload, 'idempotencyKey')
      const resolution = requireChoice(payload, 'resolution',
        ['same_attendance', 'new_attendance', 'abandoned_attempt'] as const)
      const reason = value(payload, 'reason')
      const subjectVisitId = optional(payload, 'subjectVisitId')
      const openedVisitId = optional(payload, 'openedVisitId')

      const fingerprint = requestFingerprint({
        patientId, resolution, reason, subjectVisitId, openedVisitId,
      })

      // The courteous path. The unique index on `idempotency_key` is the
      // guarantee, and it is what holds when two people resolve at once.
      const alreadyResolved = await resolutionFor(idempotencyKey)
      if (alreadyResolved) return replayResolution(alreadyResolved, fingerprint)

      const resolutionId = randomUUID()
      let outcome: 'committed' | 'not_committed' = 'not_committed'
      let signed: SignedConsultation | undefined
      let closedVisit = false
      /** Owner decision: which of the three things this determination did. */
      let disposition: Disposition = 'not_applicable'
      let subjectStatusBefore = ''

      const raced = await transaction(async () => {
        /*
         * TWO locks, and they answer two different questions. Sharing one
         * conflated them, and the concurrency test is what found it.
         *
         * The first is blocking and serializes RESOLUTIONS against each other.
         * Two doctors pressing at the same moment is not an unsettled outcome
         * — it is one of them settling it — and the loser has to wait long
         * enough to be told what was recorded rather than to be told nobody
         * knows.
         */
        await db.prepare(
          `select pg_advisory_xact_lock(${ATTEMPT_RESOLUTION_LOCK_NAMESPACE}, hashtext(?))`,
        ).get(idempotencyKey)

        // Which is the whole point of waiting: the other doctor's
        // determination has committed and is visible now.
        const winner = await resolutionFor(idempotencyKey)
        if (winner) throw new AttemptSettledElsewhere()

        /*
         * The second is a TRY, and it is the fail-closed half. `holdAttempt`
         * would WAIT here, and a resolution that waited would wake up after
         * the signing committed and cheerfully record a determination about an
         * outcome that changed underneath the doctor while they were reading
         * the screen. "Somebody is signing under this reference right now" is
         * the definition of an outcome that cannot be established, and owner
         * item 73 says to fail closed on exactly that.
         */
        const held = await db.prepare(
          `select pg_try_advisory_xact_lock(${ATTEMPT_LOCK_NAMESPACE}, hashtext(?)) as held`,
        ).get(idempotencyKey) as Row | undefined

        if (held?.held !== true) {
          throw new CommandRefusal(
            'This consultation is being signed right now, so what it recorded is not settled yet. ' +
            'Nothing was changed. Wait a moment and look again.',
            'ATTEMPT_OUTCOME_NOT_ESTABLISHED',
          )
        }

        signed = await signedConsultationFor(idempotencyKey)
        outcome = signed ? 'committed' : 'not_committed'

        if (signed && signed.patient_id !== patientId) {
          throw new CommandRefusal(
            'That reference signed a consultation for a different patient. Nothing was changed.',
            'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
          )
        }

        /*
         * Owner item 72 defines Same attendance as creating the link AND
         * closing the leftover visit. With a visit open and none named, the
         * command used to record a determination that closed nothing, spend
         * the reference's one resolution, and leave the doctor holding a visit
         * they could no longer sign — found by the independent review.
         *
         * If there is genuinely no queue row, no visit is needed and none is
         * asked for: that is the ordinary shape for a patient opened from the
         * register, and the determination is simply that the consultation
         * stands.
         */
        /*
         * BOTH determinations that speak about a visit must say which visit.
         *
         * Same attendance asked already; new attendance did not, and the
         * fourth acceptance review recorded one against a patient with a visit
         * standing in the queue and no subject named. Owner item 74 is that
         * the doctor says which attendance continues — a determination that
         * names nobody has not said it, and the visit it was about is left
         * unlinked while the reference is spent.
         */
        if ((resolution === 'same_attendance' || resolution === 'new_attendance') && !subjectVisitId) {
          const open = await db.prepare(
            `select token from appointments
              where patient_id = ? and status in ('waiting', 'in_consult')
              order by scheduled_at`,
          ).all(patientId) as Row[]
          if (open.length > 0) {
            const tokens = open.map((row) => String(row.token)).join(' and ')
            const plural = open.length === 1 ? 'is' : 'are'
            throw new CommandRefusal(
              resolution === 'same_attendance'
                ? `Say which visit this is the same attendance as. ${tokens} ${plural} still in the ` +
                  'queue, and same attendance closes the visit it names — recording it without one ' +
                  'would settle the reference and leave the visit open with no way back.'
                : `Say which visit the patient has come back for. ${tokens} ${plural} still in the ` +
                  'queue, and a new attendance is the determination that one of them is the ' +
                  'consultation still to be done — recording it without naming one settles the ' +
                  'reference and says nothing about which.',
              'SUBJECT_VISIT_REQUIRED',
            )
          }
        }

        if (resolution === 'same_attendance' && outcome !== 'committed') {
          throw new CommandRefusal(
            'Nothing was recorded under this reference, so there is no consultation for this visit to be ' +
            'the same attendance as. The visit is still open — sign it.',
            'ATTEMPT_NOT_COMMITTED',
          )
        }

        if (resolution === 'abandoned_attempt') {
          if (outcome === 'committed') {
            throw new CommandRefusal(
              'A consultation WAS signed under this reference, so the attempt was not abandoned. Record it ' +
              'as the same attendance, or as a new one.',
              'ATTEMPT_ALREADY_COMMITTED',
            )
          }
          if (subjectVisitId) {
            throw new Error(
              'An abandoned attempt closes nothing. Leave the visit out, or record a new attendance instead.',
            )
          }
          /*
           * Owner item 73 defines this determination BY the opened visit —
           * "an abandoned attempt whose opened visit is no longer active" —
           * so the visit is part of the determination rather than a hint the
           * caller may withhold.
           *
           * It used to be optional, and an absent field skipped the check
           * entirely: a doctor could record an attempt as abandoned while the
           * visit it was opened against was still standing in the queue, which
           * is the one state item 73 says it is not. Found by the independent
           * review.
           */
          if (!openedVisitId) {
            throw new Error(
              'Say which visit this consultation was started against. An attempt is abandoned because the ' +
              'visit it belonged to is no longer open, so the clinic has to be told which visit that was.',
            )
          }
          const opened = await visitOfThisPatient(
            openedVisitId, patientId, 'visit this consultation was started against')
          const stillOpen = String(opened.status) === 'waiting'
            || String(opened.status) === 'in_consult'
          if (stillOpen) {
            throw new CommandRefusal(
              'The visit this consultation was started against is still open in the queue, so the attempt has ' +
              'not been abandoned. Sign it, or cancel the visit first.',
              'ATTEMPT_VISIT_STILL_ACTIVE',
            )
          }
        }

        /*
         * Every visit this row will name has to be this patient's, on all three
         * determinations, and the check happens before anything is written.
         *
         * `abandoned_attempt` checks its own above, because there the visit's
         * STATUS is part of the determination. The other two only ever record
         * it, and recording another patient's visit id is exactly the
         * cross-patient relationship the acceptance review reproduced.
         */
        if (openedVisitId && resolution !== 'abandoned_attempt') {
          await visitOfThisPatient(
            openedVisitId, patientId, 'visit this consultation was started against')
        }

        if (subjectVisitId) {
          const visit = await visitOfThisPatient(subjectVisitId, patientId, 'visit')
          const open = String(visit.status) === 'waiting' || String(visit.status) === 'in_consult'
          subjectStatusBefore = String(visit.status)

          /*
           * ── WHAT EACH DETERMINATION NEEDS OF THE VISIT IT NAMES ─────────
           *
           * **Same attendance.** Owner decision, 16 September 2026: a doctor
           * may link retrospectively to a visit already marked `done`, and
           * what is recorded is whether this determination closed it now or
           * found it already closed. Never a claim to have performed a
           * closure it did not perform — which is what the third review's
           * `subject_visit_closed` was being made to say, and why the
           * disposition is its own field rather than an overloaded boolean.
           *
           * A **cancelled** visit stays ineligible. It was not attended; a
           * consultation cannot be the same attendance as an attendance that
           * did not happen, and the cancellation is its own correction to
           * make first.
           *
           * **New attendance.** Owner item 74: it "keeps the visit available
           * for a fresh consultation". A finished or cancelled visit is not
           * available, so recording one says something false about which
           * patient is still to be seen. The fourth acceptance review
           * recorded a cancelled visit as the attendance that continues.
           *
           * Both refuse before anything is written, so the reference is
           * unspent and the doctor can say what they actually meant.
           */
          /*
           * Owner item 75 links retrospectively to a visit that was ALREADY
           * FINISHED — not to one that has a consultation of its own.
           *
           * The race the fourth review described: a signing under a FRESH
           * reference wins the visit lock, writes its own encounter and its own
           * fee, and leaves the visit `done`. The reconciliation then wakes,
           * sees `done`, and records that visit as the same attendance as the
           * earlier consultation. It did not cause the duplicate — but it
           * writes a false determination over it and hides the exact condition
           * reconciliation exists to expose.
           *
           * The encounter this determination is ABOUT is excluded: a
           * consultation signed against its own visit is the ordinary shape.
           */
          if (resolution === 'same_attendance' && !open) {
            const consulted = await db.prepare(
              `select e.id, coalesce(rx.prescription_number, e.id) as named
                 from encounters e
                 left join prescriptions rx on rx.encounter_id = e.id
                where e.appointment_id = ? and (? = '' or e.id <> ?)
                limit 1`,
            ).get(subjectVisitId, signed?.encounter_id ?? '', signed?.encounter_id ?? '') as Row | undefined
            if (consulted) {
              throw new CommandRefusal(
                `${String(visit.token ?? 'That visit')} has a consultation of its own (${
                  String(consulted.named)
                }), so it was not simply left finished — it was seen. Recording it as the same attendance ` +
                'as a different consultation would hide a second consultation and a second fee rather ' +
                'than resolve them. Nothing was changed. This patient has been charged twice and the ' +
                'duplicate needs correcting on its own.',
                'SUBJECT_VISIT_ALREADY_CONSULTED',
              )
            }
          }

          if (resolution === 'same_attendance' && String(visit.status) === 'cancelled') {
            throw new CommandRefusal(
              `${String(visit.token ?? 'That visit')} was cancelled, so it is not an attendance for a ` +
              'consultation to be the same as. Nothing was changed. If the cancellation was the ' +
              'mistake, correct that first; otherwise name the visit the patient was actually seen ' +
              'at, or name none.',
              'SUBJECT_VISIT_NOT_OPEN',
            )
          }
          if (resolution === 'new_attendance' && !open) {
            throw new CommandRefusal(
              `${String(visit.token ?? 'That visit')} is already ${
                String(visit.status) === 'cancelled' ? 'cancelled' : 'finished'
              }, so it is not a consultation still to be done. Nothing was changed. Name the visit ` +
              'the patient is waiting at, or arrive them afresh and name that one.',
              'SUBJECT_VISIT_NOT_OPEN',
            )
          }

          /*
           * Owner item 72, both branches of it, and the difference is one
           * statement.
           *
           * **Same attendance** — "creates an append-only audited
           * reconciliation link and closes the leftover visit without another
           * encounter or fee". The visit goes `done`, which is what it is: a
           * visit that has been seen. Why it stopped waiting is in its own
           * timeline rather than being left as a `done` with nobody's name on
           * it.
           *
           * **New attendance** — "keeps the visit available for a fresh
           * consultation". So nothing is written to it at all, and the doctor
           * signs it in the ordinary way afterwards, under a reference of its
           * own.
           */
          if (resolution === 'same_attendance') {
            // What this expects to happen. `close_visit_for_reconciliation`
            // decides it again under the row lock and is the one that counts —
            // see below.
            disposition = open ? 'closed_now' : 'already_done'
            closedVisit = open
          }
        }

        /*
         * The determination first, then what it did.
         *
         * The reverse of the order this used to be written in, and the reason
         * is `appointment_events.resolution_id`: the closure event points back
         * at the determination that performed it, so the schema can tell a
         * closure THIS resolution made from one some earlier reconciliation
         * made about the same visit. Without that, "a closure happened" is a
         * claim again, which is the fourth review's finding.
         *
         * `resolutions_subject_is_what_it_claims` is DEFERRED for the same
         * reason: at COMMIT all three rows exist and the question has an
         * answer in the rows rather than in what the writer said.
         */
        await db.prepare(
          `insert into consultation_attempt_resolutions
             (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
              encounter_id, opened_visit_id, subject_visit_id, subject_visit_closed,
              subject_visit_disposition, reason, request_fingerprint)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          resolutionId, idempotencyKey, patientId, session.staffId, resolution, outcome,
          signed?.encounter_id ?? null, openedVisitId || null, subjectVisitId || null,
          closedVisit, disposition, reason, fingerprint,
        )

        /*
         * The database performs the closure, and this asks it to — with the
         * determination's id and NOTHING else.
         *
         * Which visit, which doctor, in what words: all of it is read from the
         * determination under its own lock. The fifth review closed a doctor's
         * determination through this function with a nurse's id, because the
         * function took an actor from its caller and believed it. A command
         * that already knows the answer is still the wrong place to get it
         * from, and `session.staffId` is the same value by a longer route that
         * can be wrong.
         *
         * It returns what it actually did. If that is not what was recorded a
         * few lines above, the determination is wrong about the clinic and the
         * transaction ends rather than committing a sentence nobody can trust.
         */
        if (subjectVisitId && resolution === 'same_attendance') {
          const performed = await db.prepare(
            'select close_visit_for_reconciliation(?) as disposition',
          ).get(resolutionId) as Row | undefined

          if (String(performed?.disposition ?? '') !== disposition) {
            throw new Error(
              'That visit changed while this determination was being recorded. Nothing was changed. ' +
              'Look again and say what is true now.',
            )
          }
        }

        await audit(
          session.staffId, 'consultation_attempt.resolved', 'consultation_attempt', resolutionId,
          `${RESOLUTION_WORDS[resolution]} for ${patientId}; the reference had ` +
          `${outcome === 'committed' ? `signed ${signed?.prescription_number ?? signed?.encounter_id}` : 'recorded nothing'}` +
          `${
            disposition === 'closed_now'
              ? '; the open visit was closed'
              : disposition === 'already_done'
              ? '; the visit it names was already finished and was linked retrospectively'
              : ''
          }: ${reason}`,
        )
      }).then(() => null, (error: unknown) => {
        if (error instanceof AttemptSettledElsewhere) return error
        if (isUniqueViolation(error, 'consultation_attempt_resolutions_key')) return error
        throw error
      })

      if (raced) {
        const winner = await resolutionFor(idempotencyKey)
        if (winner) return replayResolution(winner, fingerprint)
        throw raced
      }

      return {
        message: RESOLUTION_MESSAGES[resolution](disposition),
        data: {
          resolutionId,
          resolution,
          priorOutcome: outcome,
          attemptReleased: true,
          encounterId: signed?.encounter_id,
          prescriptionNumber: signed?.prescription_number ?? undefined,
          signedAt: signed?.created_at,
          subjectVisitId: subjectVisitId || undefined,
          subjectVisitClosed: closedVisit,
          subjectVisitDisposition: disposition,
        },
      }
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
        /*
         * A REQUEST, in the words as well as in the table.
         *
         * This used to record "Printed RX-000123, copy 2", which is a claim
         * about paper. A browser cannot make that claim: `window.print()` opens
         * the operating system's dialogue and never says whether the operator
         * pressed Print or Cancel, whether the tray was empty, or whether the
         * clinic printer was even awake. The row is written before the dialogue
         * opens — it has to be, so a copy taken during a crash is still on the
         * record — so the honest thing for it to say is that a copy was asked
         * for.
         *
         * The action key stays `prescription.printed`: it is a stable
         * identifier that history and reports already use, and changing it
         * would split one thing into two names. Only the sentence changes.
         */
        await audit(session.staffId, 'prescription.printed', 'prescription', prescriptionId, `${copyNumber === 1 ? 'Print' : 'Reprint'} requested for ${rx.prescription_number}, copy ${copyNumber}`)
      })
      return {
        message: copyNumber === 1
          ? 'Print requested. Copy 1 recorded.'
          : `Reprint requested. Copy ${copyNumber} recorded.`,
        data: { copyNumber },
      }
    }

    /*
     * Somebody's own appearance, on their own account.
     *
     * No `requireRole`: every signed-in person may choose how their own
     * screen looks, and there is nothing here anybody could want to do to
     * somebody else — the update is keyed by the caller's own staff id and
     * takes no id from the payload.
     *
     * Not audited, deliberately. The audit trail is what the clinic did to
     * patients, stock and money; a nurse turning the lights down twice a shift
     * is neither, and burying real events under that noise makes the record
     * worse rather than better.
     *
     * The response carries the whole clinic as usual, so the session it
     * returns already holds the new value and the tablet does not have to be
     * told twice.
     */
    case 'set_theme': {
      const theme = requireChoice(
        payload,
        'theme',
        ['system', 'paper', 'night', 'contrast'] as const,
        'system',
      )
      await db.prepare('update staff set theme=? where id=?').run(theme, session.staffId)

      /*
       * Correct the session this request is holding.
       *
       * `command/index.ts` resolves the session once, BEFORE running anything,
       * and then builds the snapshot it returns from that same object. Every
       * other command changes rows the snapshot re-reads, so nobody has needed
       * this — but this one changes the signed-in person's own staff row, and
       * without the line below the tablet gets its answer back still carrying
       * the appearance it had a moment ago. The screen then has a choice it
       * applied and an account that disagrees with it until the next poll
       * fifteen seconds later, which is exactly long enough to look broken.
       */
      session.theme = theme
      return { message: 'Appearance saved for your account.', data: { theme } }
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

        /*
         * Owner item 83: "Completing, cancelling, or superseding that
         * instruction removes eligibility before release."
         *
         * A recall released against this follow-up is stopped here rather than
         * being left for the worker to notice, because the worker's own check
         * happens at the due date and the instruction stopped being true now.
         * No row is deleted; the schedule records why it stopped.
         */
        await cancelRecallForFollowUp({
          actorId: session.staffId,
          followUpId,
          reason: status === 'completed'
            ? 'The follow-up was completed, so there is nothing to recall the patient for.'
            : 'The doctor cancelled the follow-up.',
        })

        await audit(session.staffId, `follow_up.${status}`, 'follow_up', followUpId, `${status} follow-up`)
      })
      return { message: status === 'completed' ? 'Follow-up completed.' : 'Follow-up cancelled.' }
    }

    /*
     * `pay_bill` is gone.
     *
     * It flipped one row from unpaid to paid and wrote the method onto the
     * bill, which is the shape that cannot express a part payment, a split
     * across cash and UPI, a pay-later balance, a refund or a reversal. Money
     * is `take_payment` now — see counter.ts — which writes payments as their
     * own records and allocates them against an invoice.
     */

    /*
     * The list of observation beds is the clinic's own furniture, and before
     * these two commands nothing in this application could change it: the
     * four beds came from the retired application's seed, and a clinic with
     * five had no way to say so.
     *
     * Adding and removing beds is admin work, like the clinic details that
     * print. A nurse moves patients in and out of beds (`update_bed`) and
     * cannot change how many beds there are.
     *
     * A bed can be removed only while it is empty and has never had a
     * patient in it, which is the case of a bed added by mistake or a clinic
     * with fewer beds than the four it was given. Once a patient has been in
     * a bed, the observation timeline points at it, and that history stays.
     * Such a bed is marked out of service instead.
     */
    case 'add_bed': {
      requireRole(session, 'admin')
      const label = bedLabel(payload)
      const id = randomUUID()
      await transaction(async () => {
        await db.prepare(`select pg_advisory_xact_lock(${BED_LIST_LOCK})`).get()
        const clash = await db.prepare('select label from beds where lower(label)=lower(?)')
          .get(label) as { label: string } | undefined
        if (clash) throw new Error(`There is already a bed called "${clash.label}".`)
        await db.prepare(`insert into beds (id,label,status,notes) values (?,?,'available','')`).run(id, label)
        await audit(session.staffId, 'bed.created', 'bed', id, `Added observation bed ${label}`)
      })
      return { message: `${label} is on the bed board.` }
    }

    case 'remove_bed': {
      requireRole(session, 'admin')
      const bedId = value(payload, 'bedId')
      let label = ''
      await transaction(async () => {
        await db.prepare(`select pg_advisory_xact_lock(${BED_LIST_LOCK})`).get()
        const bed = await db.prepare('select label,status,patient_id from beds where id=? for update')
          .get(bedId) as { label: string; status: string; patient_id: string | null } | undefined
        if (!bed) throw new Error('That observation bed was not found.')
        label = bed.label
        if (bed.status === 'occupied' || bed.patient_id) {
          throw new Error(`${bed.label} has a patient in it. Discharge or transfer the patient first.`)
        }
        const history = await db.prepare('select 1 from observation_events where bed_id=? limit 1').get(bedId)
        if (history) {
          throw new Error(
            `${bed.label} has had a patient in it, and its observation history stays. ` +
              'Mark it out of service instead.',
          )
        }
        await db.prepare('delete from beds where id=?').run(bedId)
        await audit(session.staffId, 'bed.removed', 'bed', bedId, `Removed observation bed ${bed.label}`)
      })
      return { message: `${label} is off the bed board.` }
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

        /*
         * Every rupee of CASH that arrived since the drawer opened.
         *
         * One query now, where there were two. A bill's cash and a counter
         * sale's cash used to be counted from two different tables with two
         * different shapes — `bills.payment_method` and `otc_sales.payment_method`
         * — and anything paid in a way neither table described was simply
         * missing from the drawer figure. A payment is a payment; where the
         * charge came from is the invoice's business, not the till's.
         *
         * Reversed payments are excluded and refunds are subtracted, because
         * both left the drawer in the opposite direction from the one they went
         * in. Card and UPI are still excluded entirely: they never touch the
         * drawer, and counting them is how a till appears to be hundreds short
         * every single day until staff stop reading the number.
         */
        const [cash] = (await db
          .prepare(
            `select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) as total
               from payments
              where method = 'cash' and status = 'received'
                and received_at >= ?::timestamptz and received_at <= ?::timestamptz`,
          )
          .all(since, now)) as Array<{ total: string }>
        const bills = { total: Number(cash.total) }
        const sales = { total: 0 }

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
        // The base unit is what `available_quantity` counts. It defaults to
        // `unit`, which is what that column has always meant here, so an
        // existing caller keeps working and the shelf figure keeps its name.
        const baseUnit = optional(payload, 'baseUnit') || value(payload, 'unit')

        /*
         * A class stated when the medicine is created is a class somebody
         * chose, so it counts as reviewed.
         *
         * Policy register 42 wants a pharmacist-verified classification before
         * sale, and `unset` — Unknown / pharmacist review required — is what
         * the EXISTING formulary starts at, because nobody has looked at those.
         * A pharmacist typing "Schedule H1" into the form that creates the
         * medicine has looked at it. Making them then open a second screen to
         * verify their own answer is friction that buys nothing, and the
         * provenance is recorded either way.
         */
        const schedule = requireChoice(
          payload, 'schedule',
          ['unset', 'OTC', 'H', 'H1', 'X', 'G', 'C', 'C1', 'other'] as const, 'unset',
        )
        const classified = schedule !== 'unset'
        await db.prepare(`insert into medicines
          (id,code,name,generic_name,strength,dosage_form,route,unit,barcode,sale_class,schedule,
           reorder_level,target_stock,preferred_supplier_id,active,created_at,
           base_unit,brand_name,manufacturer,
           schedule_source,schedule_verified_by,schedule_verified_at)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, value(payload, 'code').toUpperCase(), value(payload, 'name'), optional(payload, 'genericName'),
            optional(payload, 'strength'), optional(payload, 'dosageForm'), optional(payload, 'route'),
            value(payload, 'unit'), optional(payload, 'barcode'),
            requireChoice(payload, 'saleClass', ['otc', 'prescription', 'restricted', 'unknown'] as const),
            // Defaults to 'unset' rather than guessing from saleClass. The
            // register would rather report a gap than invent a classification.
            schedule,
            reorderLevel, targetStock,
            supplierId, 1, isoNow(),
            baseUnit, optional(payload, 'brandName'), optional(payload, 'manufacturer'),
            classified ? (optional(payload, 'scheduleSource') || 'Stated when the medicine was added') : '',
            classified ? session.staffId : null,
            classified ? isoNow() : null,
          )
        if (supplierId) {
          await db.prepare(`insert into supplier_medicines (supplier_id,medicine_id,active) values (?,?,1)
            on conflict (supplier_id,medicine_id) do update set active=1`)
            .run(supplierId, id)
        }
        if (initialQuantity > 0) {
          const batchId = randomUUID()
          await db.prepare(`insert into batches
            (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,
             received_from_supplier_id,received_at,base_unit)
            values (?,?,?,?,?,?,?,?,?,?,?)`).run(
              batchId, id, value(payload, 'batchNumber'), value(payload, 'expiry'), initialQuantity,
              numberValue(payload, 'mrp'), numberValue(payload, 'purchasePrice'), numberValue(payload, 'sellingPrice'),
              supplierId, isoNow(), baseUnit,
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

    /*
     * `otc_sale` moved to counter.ts, where it writes lines and allocations
     * rather than a JSON blob, and where the payment it takes is a payment
     * record rather than a column.
     */

    /*
     * `dispense_rx` moved to counter.ts.
     *
     * The version that lived here handed over the whole prescription or none
     * of it, because `prescriptions.dispensed_at` is one timestamp and there
     * was nowhere to record "six of ten, four on Friday". It also moved stock
     * and charged for nothing. Both are the point of Slice 4.
     */

    case 'create_order': {
      requireRole(session, 'admin', 'pharmacy')
      const supplierId = value(payload, 'supplierId')
      const suppliedLines = Array.isArray(payload.lines) ? parsedLines(payload) : []
      const orderId = randomUUID()
      let orderNumber = ''
      await transaction(async () => {
        await db.prepare(`select pg_advisory_xact_lock(${ORDER_DRAFT_LOCK})`).get()
        const supplier = await db.prepare('select name from suppliers where id=? and active=1').get(supplierId) as { name: string } | undefined
        if (!supplier) throw new Error('Choose an active supplier.')

        // What is low counts what is already on its way: a medicine ordered
        // yesterday is still short on the shelf today, and ordering it again
        // because the delivery has not arrived is how a clinic gets two.
        let lines: Line[] = suppliedLines
        if (suppliedLines.length === 0) {
          const positions = (await db.prepare(`select m.id medicine_id, m.reorder_level, m.target_stock,
              coalesce((select sum(b.available_quantity) from batch_availability b
                where b.medicine_id=m.id and b.pickable),0) on_shelf,
              coalesce((select sum(greatest(l.ordered_quantity-l.received_quantity,0))
                from purchase_order_lines l join purchase_orders o on o.id=l.order_id
                where l.medicine_id=m.id and o.status in ${OPEN_ORDER_STATUSES}),0) on_order
            from medicines m join supplier_medicines sm on sm.medicine_id=m.id and sm.supplier_id=? and sm.active=1
            where m.active=1
            group by m.id
            order by m.name`).all(supplierId)) as Row[]
          lines = positions
            .map((row) => ({
              medicineId: String(row.medicine_id),
              position: Number(row.on_shelf) + Number(row.on_order),
              reorderLevel: Number(row.reorder_level),
              targetStock: Number(row.target_stock),
            }))
            .filter((row) => row.position <= row.reorderLevel)
            .map((row) => ({ medicineId: row.medicineId, quantity: Math.max(row.targetStock - row.position, 1) }))
        }
        if (lines.length === 0) {
          throw new Error('Nothing linked to this supplier is low and not already on an order.')
        }

        const ordered: Array<{
          medicineId: string; name: string; quantity: number; description: string
          levelName: string; levelCount: number; packageVersionId: string | null
        }> = []
        for (const line of lines) {
          const medicine = (await db
            .prepare(`select name,strength,coalesce(nullif(base_unit,''),unit) base_unit from medicines where id=?`)
            .get(line.medicineId)) as { name: string; strength: string; base_unit: string } | undefined
          if (!medicine) throw new Error('An order medicine was not found.')
          const pack = await orderPackage(line.medicineId)

          // A computed shortfall is rounded up to whole packs. A quantity
          // somebody typed is recorded exactly as typed.
          let quantity = line.quantity
          let level = { levelName: medicine.base_unit, count: quantity }
          if (pack && suppliedLines.length === 0) {
            const packs = packsToCover(pack.ladder, quantity)
            quantity = packs.baseQuantity
            level = { levelName: packs.levelName, count: packs.count }
          } else if (pack) {
            level = orderLevelFor(pack.ladder, quantity)
          }

          ordered.push({
            medicineId: line.medicineId,
            name: `${medicine.name} ${medicine.strength}`.trim(),
            quantity,
            description: describeOrdered(pack?.ladder ?? null, medicine.base_unit, quantity),
            levelName: level.levelName,
            levelCount: level.count,
            packageVersionId: pack?.id ?? null,
          })
        }

        orderNumber = await sequence('PO')
        const draft = supplierOrderMessage(
          supplier.name, orderNumber, ordered.map((line) => ({ name: line.name, quantity: line.description })),
        )
        await db.prepare(`insert into purchase_orders
          (id,order_number,supplier_id,status,requested_date,message_draft,created_by,created_at)
          values (?,?,?,'pending',?,?,?,?)`).run(
            orderId, orderNumber, supplierId, isoNow().slice(0, 10), draft, session.staffId, isoNow(),
          )
        const insert = await db.prepare(`insert into purchase_order_lines
          (id,order_id,medicine_id,ordered_quantity,received_quantity,order_level_name,order_level_count,package_version_id)
          values (?,?,?,?,0,?,?,?)`)
        for (const line of ordered) {
          await insert.run(
            randomUUID(), orderId, line.medicineId, line.quantity, line.levelName, line.levelCount, line.packageVersionId,
          )
        }
        await audit(session.staffId, 'order.created', 'purchase_order', orderId, `Drafted ${orderNumber} for ${supplier.name}`)
      })
      return { message: 'Reorder draft created.', data: { orderId, orderNumber } }
    }

    /*
     * The order goes from the pharmacist's own WhatsApp, not from the clinic's
     * business number — owner decision, 26 October 2026, row 1 of the ladder in
     * docs/reference/WHATSAPP.md §9. The page opens WhatsApp with the message
     * filled in; this records that the person who sent it says it went.
     *
     * So the server sends nothing, and this is the only way an order becomes
     * placed — which also covers an order phoned in or handed over on paper.
     * The row is locked and the status checked under it, so a double tap, or
     * two people pressing at once, places the order once and tells the second
     * person who already did.
     */
    case 'mark_order_sent': {
      requireRole(session, 'admin', 'pharmacy')
      const orderId = value(payload, 'orderId')
      const messageDraft = optional(payload, 'messageDraft')
      await transaction(async () => {
        const order = (await db.prepare(
          'select status,message_draft from purchase_orders where id=? for update',
        ).get(orderId)) as { status: string; message_draft: string } | undefined
        if (!order) throw new Error('That order was not found.')
        if (order.status === 'cancelled') throw new Error('This draft was discarded, so it cannot be marked sent.')
        if (order.status !== 'pending') {
          const by = (await db.prepare(`select s.name from audit_events a join staff s on s.id=a.actor_id
              where a.entity_type='purchase_order' and a.entity_id=? and a.action in ('order.sent','order.marked_sent')
              order by a.created_at desc limit 1`).get(orderId)) as { name: string } | undefined
          throw new Error(
            `${by?.name ?? 'Someone'} already marked this order sent. If the supplier received it twice, ask them to supply it once.`,
          )
        }
        await db.prepare(`update purchase_orders set status='placed',message_draft=?,placed_at=? where id=?`)
          .run(messageDraft || order.message_draft, isoNow(), orderId)
        await audit(session.staffId, 'order.marked_sent', 'purchase_order', orderId,
          'Supplier order sent from staff WhatsApp, phone or paper, and marked placed')
      })
      return { message: 'Order marked sent. It is now waiting for delivery.' }
    }

    /** A draft that is wrong is discarded, so what it holds is no longer counted as on order. */
    case 'cancel_order': {
      requireRole(session, 'admin', 'pharmacy')
      const orderId = value(payload, 'orderId')
      await transaction(async () => {
        const result = await db.prepare(`update purchase_orders set status='cancelled' where id=? and status='pending'`)
          .run(orderId)
        if (Number(result.changes) !== 1) throw new Error('Only a draft that has not been sent can be discarded.')
        await audit(session.staffId, 'order.discarded', 'purchase_order', orderId, 'Discarded an unsent order draft')
      })
      return { message: 'Draft discarded.' }
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
            (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,
             received_from_supplier_id,received_at,base_unit)
            values (?,?,?,?,?,?,?,?,?,?,
              (select coalesce(nullif(base_unit,''), unit) from medicines where id=?))`).run(
              batchId, line.medicine_id, value(entry, 'batchNumber'), value(entry, 'expiry'), quantity,
              numberValue(entry, 'mrp'), numberValue(entry, 'purchasePrice'), numberValue(entry, 'sellingPrice'),
              order.supplier_id, isoNow(), line.medicine_id,
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

    /*
     * Slice 2's appointment book — types, availability, booking, check-in and
     * queue priority — lives in appointments.ts, and passes anything it does
     * not recognise on to inventory.ts, which passes it to counter.ts, which
     * passes it to images.ts. Each of those is a third of the command surface
     * sharing almost nothing with the clinical half above; keeping them here
     * would have made this file the place everybody edits at once, which the
     * brief names as the hotspot to avoid.
     *
     * The end of that chain throws 'Unknown action.' for anything nobody
     * recognises, so the contract at this boundary is unchanged.
     */
    default:
      return runAppointmentCommand(session, action, payload)
  }
}
