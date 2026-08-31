import { readPatientRecord } from '../_shared/snapshot.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'

/** One patient's history, fetched when somebody opens that patient. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  // Everyone who can open a patient can read that patient's record; the
  // pharmacy counter needs the prescription and reception needs the bill.
  const patientId = new URL(request.url).searchParams.get('patientId') ?? ''
  if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)

  try {
    return json({ ok: true, record: await readPatientRecord(patientId) })
  } catch (error) {
    console.error('patient record failed:', error)
    return json({ ok: false, message: 'That record could not be read.' }, 500)
  }
})
