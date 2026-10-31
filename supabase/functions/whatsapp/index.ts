/**
 * Meta's statuses webhook: the only thing in this application allowed to say a
 * patient received a message.
 *
 *   GET  /functions/v1/whatsapp   Meta's subscription challenge
 *   POST /functions/v1/whatsapp   signed status events
 *
 * ── WHY THIS ENDPOINT EXISTS AT ALL ────────────────────────────────────────
 *
 * `POST /messages` answers `accepted`, `held_for_quality_assessment` or
 * `paused`. None of those is delivery — a message held for quality assessment
 * has demonstrably reached nobody — so the clinic records `sent_to_provider`
 * and stops. Delivery is a separate fact that arrives here, later, or never.
 * Without this endpoint the clinic would have to either lie about delivery or
 * never claim it; with it, `delivered` means Meta said so.
 *
 * ── THE SIGNATURE IS CHECKED BEFORE ANYTHING IS PARSED ─────────────────────
 *
 * This is a public URL. Anybody can POST to it, and what it does on success is
 * write delivery evidence about named patients. So the order is fixed and it
 * is not an ordering anybody may tidy:
 *
 *   1. read the RAW BYTES of the body
 *   2. HMAC-SHA256 them with the app secret, compare in constant time
 *   3. only then parse
 *
 * Reading the body as text and re-encoding it, or parsing the JSON and
 * re-serializing it to check the signature, verifies a document Meta did not
 * sign. It usually happens to be byte-identical, and stops being so at the
 * first non-ASCII character — a patient's name — or the first difference in
 * key order or whitespace. `verifyWebhookSignature` takes bytes for that
 * reason and this handler never gives it anything else.
 *
 * A missing, malformed or wrong signature changes nothing. Not a row, not a
 * counter, not an audit entry — the request is refused before the body is
 * even read as JSON.
 *
 * ── WHY IT ANSWERS 200 TO THINGS IT DID NOTHING ABOUT ──────────────────────
 *
 * Meta retries a webhook "with decreasing frequency until the request
 * succeeds, for up to 7 days". So a non-200 means the same event arrives again
 * and again, and an endpoint that answered 404 for an unrecognised message id
 * would turn a stranger's probe into a week of retries — while also confirming
 * to anyone who can guess an id whether this clinic has a message by that
 * name. A correctly signed request therefore gets 200 and the same body
 * whether it moved something or nothing at all.
 *
 * The one exception is a request that FAILED to record what it was given — the
 * database unreachable, a statement broken. That gets a 500, because Meta
 * coming back is exactly what is wanted when a delivery receipt has not been
 * written anywhere. Nothing a correctly signed caller can put in a payload
 * produces one, so the difference tells a stranger nothing.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It handles delivery STATUSES. Inbound patient messages arrive on the same
 * webhook and are ignored here: replying to a patient is a conversation
 * feature with its own consent, window and staffing questions, and owner item
 * 82's rule that a patient-initiated conversation is not standing consent is
 * exactly the sort of thing that gets lost if an endpoint quietly starts
 * processing inbound text because it was already receiving it.
 *
 * It exposes no read and no administrative path. There is no way to ask this
 * endpoint about a patient, a message or a number, in any direction.
 */
import { applyProviderStatusEvent, type ProviderStatus } from '../_shared/messaging.ts'
import { verifyTokenMatches, verifyWebhookSignature } from '../_shared/whatsapp.ts'

const STATUSES: ProviderStatus[] = ['sent', 'delivered', 'read', 'played', 'failed']

/** Meta's own words, and nothing this application invented. */
function isProviderStatus(value: unknown): value is ProviderStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value)
}

type StatusEvent = {
  id?: unknown
  status?: unknown
  timestamp?: unknown
  biz_opaque_callback_data?: unknown
  errors?: { code?: unknown; title?: unknown; message?: unknown }[]
}

Deno.serve(async (request) => {
  /* ── Meta's subscription challenge ─────────────────────────────────────── */
  if (request.method === 'GET') {
    const query = new URL(request.url).searchParams
    const mode = query.get('hub.mode') ?? ''
    const token = query.get('hub.verify_token') ?? ''
    const challenge = query.get('hub.challenge') ?? ''

    /*
     * All three, and the token compared in constant time against
     * `WHATSAPP_VERIFY_TOKEN`. `verifyTokenMatches` returns false when the
     * variable is unset, so an unconfigured clinic cannot be subscribed to by
     * anybody — including by somebody who guessed that it was unset and sent
     * an empty token.
     */
    if (mode !== 'subscribe' || !verifyTokenMatches(token) || challenge === '') {
      return new Response('Forbidden', { status: 403 })
    }

    // Meta wants the challenge back verbatim, as the whole body.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  /* ── The signature, over the bytes that actually arrived ───────────────── */
  const raw = new Uint8Array(await request.arrayBuffer())
  if (!verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'))) {
    return new Response('Forbidden', { status: 403 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    // Signed by Meta and not JSON. Nothing to apply, and retrying it for seven
    // days would not make it parse.
    return new Response('EVENT_RECEIVED', { status: 200 })
  }

  const body = (payload ?? {}) as {
    entry?: { changes?: { field?: unknown; value?: { statuses?: StatusEvent[] } }[] }[]
  }

  /*
   * Whether anything failed for a reason a retry could fix.
   *
   * `unknown_reference` and `duplicate` are not failures — they are correct
   * answers — and both get the ordinary 200. A thrown error is different: the
   * database was unreachable, or a statement broke, and the evidence in this
   * request has not been recorded anywhere. Meta retries a non-200 with
   * decreasing frequency for up to seven days, which is exactly the behaviour
   * wanted there: answering 200 to a request that failed to record anything
   * loses a delivery receipt permanently to save one log line.
   *
   * A stranger cannot use the difference to learn anything. Reaching this code
   * at all requires a valid signature, and nothing a correctly signed caller
   * can put in a payload produces a 500.
   */
  let failed = false

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const event of change.value?.statuses ?? []) {
        const reference = typeof event.id === 'string' ? event.id : ''
        if (reference === '' || !isProviderStatus(event.status)) continue

        const callback = typeof event.biz_opaque_callback_data === 'string'
          ? event.biz_opaque_callback_data
          : ''

        // Meta's timestamp is seconds since the epoch, as a string.
        const seconds = Number(event.timestamp)
        const occurredAt = Number.isFinite(seconds) && seconds > 0
          ? new Date(seconds * 1000).toISOString()
          : undefined

        const failure = event.errors?.[0]
        const code = Number(failure?.code)

        try {
          await applyProviderStatusEvent({
            providerReference: reference,
            status: event.status,
            callbackData: callback,
            occurredAt,
            errorCode: Number.isFinite(code) && code > 0 ? code : undefined,
            errorDetail: [failure?.title, failure?.message]
              .filter((part) => typeof part === 'string' && part.length > 0)
              .join(' — '),
          })
        } catch (error) {
          /*
           * One event failing does not abandon the rest of the batch, and the
           * log carries the message that failed rather than the payload: a
           * webhook body holds the patient's own telephone number in
           * `recipient_id`, and this is the one place in this application
           * where a whole provider payload could casually end up in a console.
           */
          failed = true
          console.error(
            'provider status event failed:',
            error instanceof Error ? error.message : error,
          )
        }
      }
    }
  }

  if (failed) {
    // Nothing about which event, or whose. Meta needs only to be told to come
    // back.
    return new Response('RETRY', { status: 500 })
  }

  /*
   * The same answer either way: applied, ignored, duplicated, or about a
   * message this clinic has never heard of. Meta wants a 200 so it stops
   * retrying, and a stranger learns nothing about who this clinic messages.
   */
  return new Response('EVENT_RECEIVED', { status: 200 })
})
