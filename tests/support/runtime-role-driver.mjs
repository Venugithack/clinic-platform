/**
 * The clinic's own backend, run as the database role production will use.
 *
 * This is a separate process on purpose. `supabase/functions/_shared/db.ts`
 * opens its pool at module scope from `SUPABASE_DB_URL`, and
 * `tests/support/backend.mjs` sets that from `STAGING_DB_URL` before importing
 * it — so the connecting role is fixed for the lifetime of a process and there
 * is no way to change it from inside one. The parent test spawns this with
 * `STAGING_DB_URL` pointing at the runtime role instead of at `postgres`, and
 * the guard in `backend.mjs` still applies: this will not connect to anything
 * that is not a loopback scratch database.
 *
 * It performs a representative day's work — a nurse arriving a patient and
 * recording vitals, a doctor drafting, signing and printing — and prints one
 * JSON object. Every statement it runs goes through the real command layer, so
 * a privilege or row-security problem surfaces exactly where the clinic would
 * meet it rather than in a hand-written `select`.
 */
import { commands, snapshot } from './backend.mjs'

const staff = JSON.parse(process.env.RUNTIME_ROLE_STAFF ?? '{}')
const medicineId = process.env.RUNTIME_ROLE_MEDICINE ?? ''

const sessionFor = (person) => ({
  token: `runtime-${person.id}`,
  staffId: person.id,
  name: person.name,
  username: person.username,
  roles: person.roles,
  lastSeen: new Date().toISOString(),
  canPublishClinicalTemplates: Boolean(person.canPublishClinicalTemplates),
})

const run = (person, command, payload) =>
  commands.runCommand(sessionFor(person), command, payload)

const result = { ok: false, steps: {}, role: null, error: null }

try {
  result.role = (await snapshot.readSnapshot(sessionFor(staff.doctor))) ? 'connected' : 'connected'

  // ── the nurse: a patient arrives ─────────────────────────────────────────
  await run(staff.nurse, 'create_patient', {
    name: 'Runtime Role Patient', age: 33, sex: 'male', phone: '+999700000777',
  })
  const nurseView = await snapshot.readSnapshot(sessionFor(staff.nurse))
  const patient = nurseView.patients.find((row) => row.name === 'Runtime Role Patient')
  if (!patient) throw new Error('the nurse could not read back the patient she just registered')
  result.steps.nurseRegisteredPatient = patient.id

  await run(staff.nurse, 'create_appointment', {
    patientId: patient.id, reason: 'Runtime role check', scheduledAt: new Date().toISOString(),
  })
  await run(staff.nurse, 'add_vitals', {
    patientId: patient.id, pulse: 78, spo2: 98, notMeasuredNote: 'Weight not measured',
  })
  const afterVitals = await snapshot.readSnapshot(sessionFor(staff.nurse))
  result.steps.nurseAppointments = afterVitals.appointments.length
  result.steps.nurseVitals = afterVitals.vitals.length

  // ── the doctor: the tables Slice 2 had forced ────────────────────────────
  //
  // consultation_drafts, clinical_phrases, consultation_templates,
  // prescription_lines, follow_ups and prescription_prints are the tables that
  // returned zero rows to a non-BYPASSRLS owner while FORCE was on. Each one
  // is written and read back here.
  const clinical = {
    patientId: patient.id,
    complaint: 'Fever',
    examination: 'Chest clear',
    diagnosis: 'Acute viral febrile illness',
    diagnosisStatus: 'provisional',
    advice: 'Drink adequate fluids',
    prescriptionItems: [{
      medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
      timing: 'after_food', durationValue: 3, durationUnit: 'day',
      instructions: 'After food', quantity: 6,
    }],
    consultationFee: 0,
  }

  await run(staff.doctor, 'save_consultation_draft', clinical)
  const withDraft = await snapshot.readPatientRecord(patient.id, staff.doctor.id)
  if (!withDraft.draft) throw new Error('the doctor could not read back his own draft')
  result.steps.draftComplaint = withDraft.draft.complaint
  result.steps.approvedPhrases = withDraft.phrases.length

  await run(staff.doctor, 'save_clinical_template', {
    ...clinical, title: 'Runtime role template', scope: 'personal',
  })
  result.steps.templates = (await snapshot.readPatientRecord(patient.id, staff.doctor.id)).templates.length

  const signed = await run(staff.doctor, 'sign_consultation', {
    ...clinical,
    followUpDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    followUpNote: 'Runtime role follow-up',
  })
  result.steps.prescriptionNumber = signed.data.prescriptionNumber

  const printed = await run(staff.doctor, 'record_prescription_print', {
    prescriptionId: signed.data.prescriptionId,
  })
  result.steps.printCopy = printed.data.copyNumber

  const record = await snapshot.readPatientRecord(patient.id, staff.doctor.id)
  result.steps.signedLines = record.prescriptions[0]?.items.length ?? 0
  result.steps.signedMedicineName = record.prescriptions[0]?.items[0]?.medicineName ?? ''
  result.steps.followUps = record.followUps.length
  result.steps.printCount = record.prescriptions[0]?.printCount ?? 0

  // ── the pharmacist reads the queue the counter works from ────────────────
  const counter = await snapshot.readSnapshot(sessionFor(staff.pharmacy))
  result.steps.pharmacyPrescriptions = counter.prescriptions.length

  result.ok = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
}

process.stdout.write(`RUNTIME_ROLE_RESULT ${JSON.stringify(result)}\n`)
process.exit(result.ok ? 0 : 1)
