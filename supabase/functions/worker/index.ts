/**
 * The thing a scheduler calls, and the only endpoint in this application that
 * is not driven by a person.
 *
 *   POST /functions/v1/worker    one cycle: recover, prepare, dispatch
 *
 * ── NOTHING SCHEDULES THIS ─────────────────────────────────────────────────
 *
 * There is no `pg_cron` job, no `pg_net` call, no Vault secret, no Supabase
 * Queue and no external scheduler. No migration creates one and no deployment
 * step in this slice runs one. What exists is the endpoint and its contract;
 * the provisioning steps, their prerequisites and their rollback are written
 * out in `docs/operations/ROLLOUT.md` and deliberately not executed.
 *
 * Until `CLINIC_WORKER_TOKEN` is set this endpoint refuses every request, and
 * until the five `WHATSAPP_*` variables are set a cycle that did run would
 * suppress every due message into the admin's queue with
 * `channel_not_configured` against it. Both are true of this clinic today.
 *
 * ── WHY THE WORK IS CALLED DIRECTLY AND NOT FANNED OUT ─────────────────────
 *
 * `runDispatchCycle` is shared domain code on the same database connection.
 * This function could instead POST to `command`, or to itself once per
 * message, and it does not: every hop is another place a reply can be lost,
 * and a lost reply in this particular path is the one that leaves a patient's
 * message at `outcome_unknown`. The fewer boundaries between deciding to send
 * and having sent, the fewer of those there are.
 *
 * ── WHY IT IS SAFE TO CALL TWICE, LATE, OR NEVER ───────────────────────────
 *
 * **Twice, or twice at once.** Nothing here decides whether a patient is
 * contacted. Every such decision — consent, withdrawal, the schedule still
 * being live, the template still being approved, the attempt ceiling, the
 * retry window, quiet hours, the usefulness deadline — is asked again inside
 * `prepareOne` and `claimAttempt` while holding the message row. Two
 * concurrent cycles take that row with `for update ... skip locked`, so one
 * claims it and the other walks past: one attempt, not two.
 *
 * **Late.** Every rule is evaluated against the instant the cycle runs, in the
 * clinic's own timezone. A cycle that runs at 20:05 dispatches nothing,
 * because item 77's window closed at 20:00; a cycle that runs after a
 * message's usefulness deadline suppresses it with `past_useful_by` rather
 * than sending a reminder about an appointment that has already happened.
 * Being late is a case, not a fault.
 *
 * **Not at all.** Nothing is lost and nothing is sent. Messages accumulate at
 * `scheduled`, and the first cycle to run afterwards suppresses the ones whose
 * moment has passed rather than sending a morning's worth of stale reminders
 * at once. A scheduler that stops is a clinic that stops messaging, which is
 * the safe direction for a scheduler to fail in.
 */
import { json } from '../_shared/http.ts'
import { isInternalCaller } from '../_shared/internal-auth.ts'
import { runDispatchCycle } from '../_shared/messaging.ts'

Deno.serve(async (request) => {
  /*
   * No CORS, and no OPTIONS. This endpoint is not for a browser: the clinic's
   * tablets never call it and a page that could would be a page that can make
   * the clinic message its patients. Omitting the headers is not the security
   * boundary — the token below is — but advertising an endpoint to every
   * origin on the internet when nothing legitimate calls it from one is a
   * habit worth not having.
   */
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'This endpoint runs one dispatch cycle.' }, 405)
  }

  /*
   * A staff session is not a key to this door, and that is the point of using
   * a separate secret rather than `sessionFrom`. `isInternalCaller` compares
   * against `CLINIC_WORKER_TOKEN` and nothing else, so the most privileged
   * administrator's bearer token is refused here exactly as an anonymous one
   * is.
   */
  if (!isInternalCaller(request)) {
    return json({ ok: false, message: 'Not authorized.' }, 401)
  }

  try {
    const summary = await runDispatchCycle()
    /*
     * Counts, and no patient in any of them. This response is read by a
     * scheduler's log, which is the least controlled place anything this
     * application writes ends up; a name or a number in it would be a patient
     * identifier sitting in an operations console for ever.
     */
    return json({ ok: true, ...summary })
  } catch (error) {
    console.error('worker cycle failed:', error instanceof Error ? error.message : error)
    return json({ ok: false, message: 'The dispatch cycle failed.' }, 500)
  }
})
