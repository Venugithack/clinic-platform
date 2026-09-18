/**
 * What a workspace opens with, and what it asks when somebody stops.
 *
 * The whole-clinic snapshot answers "what is the clinic", every fifteen
 * seconds, to every tablet. These are the questions it was never the right
 * shape for: find one patient among thousands, count what this role can
 * actually do something about, say where one visit has reached, say what is
 * unresolved before closing it, and say what a lost reply actually committed.
 *
 *   ?view=patients&q=…                 find a patient, bounded and ranked
 *   ?view=patient&patientId=…          the compact band, minimized per role
 *   ?view=workload                     every actionable count for this role
 *   ?view=list&list=list.today_queue    the rows behind one of those counts
 *   ?view=progress&patientId=…         arrival → vitals → consult → counter → payment → follow-up
 *   ?view=obligations&patientId=…      what is still open on this patient
 *   ?view=outcome&key=…                what one idempotency key committed
 *   ?view=equivalents&lineId=…         proven-equivalent products for a generic line
 *   ?view=calendar&from=…&to=…        who is expected, and the published hours
 *   ?view=appointments&patientId=…     one patient’s appointments and their history
 *   ?view=reconciliation&key=…         what one consultation attempt committed
 *   ?view=communication_due            reminders and recalls due now or shortly
 *   ?view=communication_failures       the delivery-failure queue, owner item 79
 *   ?view=communication_consent&patientId=…  what this patient agreed to receive
 *   ?view=communication_outcome&outboxId=…   what happened to one message
 *
 * Reads only, and GET only. Every write in this application is a command, and
 * a GET that writes is a GET that a retry, a prefetch or a browser's
 * speculative fetch turns into three.
 *
 * ── AUTHORIZATION IS NOT WRITTEN IN THIS FILE ──────────────────────────────
 *
 * Every view's roles come from `_shared/capabilities.ts` and are checked
 * through it. That is deliberate: `inventory` puts one `hasRole` above its
 * switch, which is right while all five of its views share an audience and
 * silently wrong the day one of them does not. Here the routing table and the
 * capability table are the same table, `workspace-authorization.test.mjs`
 * walks it and
 * tries every role against every entry, and a view added without an entry
 * cannot reach its handler — the default below refuses it.
 */
import { json, preflight, sessionFrom } from '../_shared/http.ts'
import { CAPABILITIES, mayUse, type CapabilityId } from '../_shared/capabilities.ts'
import {
  readCalendar, readEquivalents, readOutcome, readPatientAppointments,
  readPatientContext, readReconciliation, readSafeExit, readVisitProgress,
  readWorkList, readWorkload, searchPatients,
} from '../_shared/workspace.ts'
import {
  readCommunicationConsent, readCommunicationDue, readCommunicationFailures,
  readDeliveryOutcome,
} from '../_shared/messaging.ts'

/** Which capability each view spends. The routing table IS the gate. */
const VIEWS: Record<string, CapabilityId> = {
  patients: 'view.patient_search',
  patient: 'view.patient_context',
  workload: 'view.workload',
  list: 'view.workload',
  progress: 'view.visit_progress',
  obligations: 'view.safe_exit',
  outcome: 'view.outcome',
  equivalents: 'view.eligible_equivalents',
  // Slice 2.
  calendar: 'view.appointment_calendar',
  appointments: 'view.patient_appointments',
  reconciliation: 'view.consultation_reconciliation',
  // Slice 3A.
  communication_due: 'view.communication_due',
  communication_failures: 'view.communication_failures',
  communication_consent: 'view.communication_consent',
  communication_outcome: 'view.communication_outcome',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'GET') {
    return json({ ok: false, message: 'This endpoint only reads.' }, 405)
  }

  // touch: false, like every other read. A tablet left open on a patient band
  // must still reach its idle lock; only doing something keeps a session alive.
  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  const url = new URL(request.url)
  const view = url.searchParams.get('view') ?? ''
  /*
   * `Object.hasOwn` and not `in`, and not a bare truthiness check on the
   * lookup.
   *
   * `view` comes off the query string, so `?view=constructor` reaches this
   * line. `VIEWS['constructor']` is not undefined — it is inherited from
   * Object.prototype — so a truthy check lets it past, and everything after
   * this point then works with a capability id that names a function. The
   * damage is a 500 rather than a leak, because the capability table has no
   * such entry and the SQL it would have selected does not exist. It is still
   * a refusal wearing the wrong clothes, and one line closes it.
   */
  const capability = Object.hasOwn(VIEWS, view) ? VIEWS[view] : undefined
  if (!capability) return json({ ok: false, message: 'Unknown workspace view.' }, 400)
  if (!mayUse(session, capability)) {
    return json({ ok: false, message: `Your role cannot read ${CAPABILITIES[capability].purpose.toLowerCase()}` }, 403)
  }

  const param = (name: string) => (url.searchParams.get(name) ?? '').trim()

  try {
    switch (view) {
      case 'patients':
        return json({ ok: true, patients: await searchPatients(session, param('q')) })

      case 'patient': {
        const patientId = param('patientId')
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const context = await readPatientContext(session, patientId)
        if (!context) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, context })
      }

      case 'workload':
        return json({ ok: true, counts: await readWorkload(session) })

      case 'list': {
        const id = param('list') as CapabilityId
        if (!id) return json({ ok: false, message: 'No list asked for.' }, 400)
        // Same reason as the view lookup above: `in` walks the prototype and
        // `?list=constructor` is a string somebody can type.
        if (!Object.hasOwn(CAPABILITIES, id)) {
          return json({ ok: false, message: 'Unknown list.' }, 400)
        }
        const page = await readWorkList(session, id)
        // Null is either "not a work list" or "not yours". Both answer the
        // same way on purpose: a distinct refusal tells somebody which lists
        // exist, which is the one thing a refusal should not teach.
        if (!page) return json({ ok: false, message: 'Your role cannot read that list.' }, 403)
        return json({ ok: true, list: page })
      }

      case 'progress': {
        const patientId = param('patientId')
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const stages = await readVisitProgress(session, patientId)
        if (!stages) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, stages })
      }

      case 'obligations': {
        const patientId = param('patientId')
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const obligations = await readSafeExit(session, patientId)
        if (!obligations) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, obligations })
      }

      case 'outcome': {
        const key = param('key')
        if (!key) return json({ ok: false, message: 'No reference asked about.' }, 400)
        return json({ ok: true, outcome: await readOutcome(session, key) })
      }

      case 'equivalents': {
        const lineId = param('lineId')
        if (!lineId) return json({ ok: false, message: 'No prescription line asked for.' }, 400)
        const equivalents = await readEquivalents(session, lineId)
        if (!equivalents) return json({ ok: false, message: 'That prescription line was not found.' }, 404)
        return json({ ok: true, equivalents })
      }

      case 'calendar': {
        const from = param('from')
        const to = param('to') || from
        if (!from) return json({ ok: false, message: 'No day asked about.' }, 400)
        const calendar = await readCalendar(session, from, to, param('doctorId'))
        // One refusal for a malformed date, a reversed range and a range wider
        // than the clinic books into, because all three are the caller asking
        // for something the calendar does not answer, and separating them
        // would only tell somebody what shape of range exists.
        if (!calendar) {
          return json({
            ok: false,
            message: 'Ask for a day, or a range of up to ninety days, as YYYY-MM-DD.',
          }, 400)
        }
        return json({ ok: true, calendar })
      }

      case 'appointments': {
        const patientId = param('patientId')
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const appointments = await readPatientAppointments(session, patientId)
        if (!appointments) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, appointments })
      }

      case 'reconciliation': {
        const key = param('key')
        const patientId = param('patientId')
        if (!key) return json({ ok: false, message: 'No reference asked about.' }, 400)
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const reconciliation = await readReconciliation(
          session, key, patientId, param('openedVisitId'))
        if (!reconciliation) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, reconciliation })
      }

      case 'communication_due': {
        const hours = Number(param('withinHours') || '24')
        return json({
          ok: true,
          due: await readCommunicationDue(session, {
            withinHours: Number.isFinite(hours) ? hours : 24,
          }),
        })
      }

      case 'communication_failures':
        return json({ ok: true, failures: await readCommunicationFailures(session) })

      case 'communication_consent': {
        const patientId = param('patientId')
        if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)
        const consent = await readCommunicationConsent(session, patientId)
        if (!consent) return json({ ok: false, message: 'That patient was not found.' }, 404)
        return json({ ok: true, consent })
      }

      case 'communication_outcome': {
        const outboxId = param('outboxId')
        if (!outboxId) return json({ ok: false, message: 'No message asked about.' }, 400)
        const outcome = await readDeliveryOutcome(session, outboxId)
        if (!outcome) return json({ ok: false, message: 'That message was not found.' }, 404)
        return json({ ok: true, outcome })
      }

      default:
        return json({ ok: false, message: 'Unknown workspace view.' }, 400)
    }
  } catch (error) {
    console.error('workspace read failed:', error)
    return json({ ok: false, message: 'That could not be read.' }, 500)
  }
})
