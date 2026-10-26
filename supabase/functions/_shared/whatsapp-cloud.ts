/**
 * The clinic's one way of speaking to Meta.
 *
 * This is the only way the OUTBOX reaches Meta, and it exists so that the
 * durable state machine in `messaging.ts` never builds a request itself. That
 * separation is the point: the state machine decides whether a patient may be
 * contacted, and this file decides how the provider is addressed and what its
 * answer means. A test replaces this and changes nothing about the first
 * question.
 *
 * It is **not** the only file in the repository that can call Meta.
 * `whatsapp.ts`'s `sendWhatsAppText` — the staff message composer behind
 * `send_patient_whatsapp` — has its own direct call and predates all of this.
 * (`send_order` used it too until 26 October 2026, when supplier orders moved
 * to the pharmacist's own WhatsApp and the clinic stopped sending them.) The two do not share a path, a consent rule or a
 * record: that one is a member of staff typing a sentence and pressing send,
 * and it writes to `whatsapp_messages`. Moving it onto per-purpose consent is
 * deferred work, named in `docs/SCHEMA_AND_TYPES.md` §16.8, and until it
 * happens "the clinic's automated messaging goes through here" is the accurate
 * claim and "nothing else can call Meta" is not.
 *
 * ── WHAT THIS FILE IS ALLOWED TO DECIDE, AND WHAT IT IS NOT ────────────────
 *
 * It decides the payload shape, the endpoint, and how one of Meta's answers
 * maps onto `TransportResult`. It decides nothing about consent, quiet hours,
 * retries or whether a message is worth sending; by the time `send` is called
 * all of that has already been settled under a row lock by the worker.
 *
 * ── WHAT IS VERIFIED AND WHAT IS PROVISIONAL ───────────────────────────────
 *
 * Verified against Meta's own current documentation, and cited at each use:
 *
 *   - `POST /{phone-number-id}/messages` answers
 *     `messages[].message_status` with exactly `accepted`,
 *     `held_for_quality_assessment` or `paused`. None of the three is
 *     delivery, and the type in `messaging.ts` is those three words.
 *   - There is NO documented idempotency mechanism on that endpoint. That
 *     absence is load-bearing: it is the whole reason a lost reply may not be
 *     retried, and it is recorded here rather than assumed.
 *   - `biz_opaque_callback_data` is a business-assigned string echoed back in
 *     the status webhook. It is what lets a message whose reply was lost be
 *     reconciled later, and the clinic puts its idempotency key in it —
 *     the one string in this schema designed to be repeated outside the
 *     database, carrying no patient, contact or clinical data.
 *   - The documented error codes and whether Meta calls each one temporary.
 *
 * **Provisional, and marked as such because no live provider has ever
 * answered this code:** the send-side shape of a NAMED body parameter. Meta
 * documents named parameters as `{{lower_snake_case}}` at template creation —
 * which is exactly the syntax the clinic's own template bodies already use and
 * the schema's six-name whitelist already enforces — and the send-side field
 * appears as `parameter_name`. The positional alternative is one constant
 * away; see `BODY_PARAMETER_FORMAT`. Nothing here may be treated as validated
 * until a real template has been approved and a real message accepted, which
 * is a named release gate and not this slice's work.
 */
import type { TransportFailure, TransportResult } from './messaging-transport.ts'
import { whatsappConfig } from './whatsapp.ts'

/**
 * How a body variable is named on the wire.
 *
 * `named` matches the clinic's template bodies, which are written with
 * `{{patient_given_name}}` and friends and constrained by the schema to that
 * six-name whitelist. `positional` is Meta's older form, in which the Nth
 * parameter fills `{{N}}` and the order is the order the placeholders appear
 * in the approved body.
 *
 * This is the one constant that changes if provider validation says the
 * clinic's approved templates were registered positionally. It is a constant
 * and not a column because the answer is a property of how the clinic
 * registered its templates with Meta, which is one decision for the whole
 * account rather than one per wording.
 */
export const BODY_PARAMETER_FORMAT: 'named' | 'positional' = 'named'

/** Meta's documented answers to a successful POST. None of them is delivery. */
const ACCEPT_STATUSES = ['accepted', 'held_for_quality_assessment', 'paused'] as const
type AcceptStatus = typeof ACCEPT_STATUSES[number]

/**
 * How long to wait for Meta before calling the answer lost.
 *
 * **Not an owner decision and not a documented provider value.** It is an
 * implementation bound, and it is deliberately well inside the two hours item
 * 79 allows for the whole retry sequence: a call still open after thirty
 * seconds has already cost a scheduled run, and the honest state for it is
 * `outcome_unknown` rather than a worker held open indefinitely.
 */
export const PROVIDER_TIMEOUT_MS = 30_000

/**
 * Meta's error codes, and whether Meta itself calls the condition temporary.
 *
 * Every entry is from the official Cloud API error reference, and the
 * distinction is Meta's own recommended action rather than a guess: "try again
 * later" is retryable, "verify the request" or "create a new template" is not.
 * A code nobody has listed is treated as terminal, which is the safe direction
 * — a retry the provider never invited is how one reminder becomes two.
 */
const ERROR_CODES: Record<number, { category: TransportFailure; terminal: boolean }> = {
  // Rate and throughput limits. Meta's documented action is to wait.
  4: { category: 'rate_limited', terminal: false },
  80007: { category: 'rate_limited', terminal: false },
  130429: { category: 'rate_limited', terminal: false },
  131056: { category: 'rate_limited', terminal: false },
  133016: { category: 'rate_limited', terminal: false },

  // Meta's own availability. "Check the platform status page before trying
  // again" is an invitation to retry.
  2: { category: 'provider_unavailable', terminal: false },
  131016: { category: 'provider_unavailable', terminal: false },
  131000: { category: 'provider_unavailable', terminal: false },

  /*
   * Marketing limit: Meta's documented action is "wait at least 24 hours
   * before resending", which is longer than the entire two-hour ceiling item
   * 79 allows. Retryable in Meta's sense and terminal in this clinic's, and
   * the clinic's is the one that governs: there is no legal slot left for it.
   */
  131049: { category: 'rate_limited', terminal: true },

  // The request, the account or the recipient is wrong, and repeating it
  // unchanged would be wrong in exactly the same way.
  1: { category: 'unknown', terminal: true },
  368: { category: 'not_authorized', terminal: true },
  131005: { category: 'not_authorized', terminal: true },
  131008: { category: 'unknown', terminal: true },
  131009: { category: 'unknown', terminal: true },
  131021: { category: 'invalid_recipient', terminal: true },
  131026: { category: 'invalid_recipient', terminal: true },
  131047: { category: 'template_rejected', terminal: true },
  131051: { category: 'unknown', terminal: true },
  190: { category: 'not_authorized', terminal: true },
  200: { category: 'not_authorized', terminal: true },
  10: { category: 'not_authorized', terminal: true },
  299: { category: 'not_authorized', terminal: true },

  // The template itself. None of these is fixed by sending it again.
  132000: { category: 'template_rejected', terminal: true },
  132001: { category: 'template_rejected', terminal: true },
  132005: { category: 'template_rejected', terminal: true },
  132007: { category: 'template_rejected', terminal: true },
  132012: { category: 'template_rejected', terminal: true },
  132015: { category: 'template_rejected', terminal: true },
  132016: { category: 'template_rejected', terminal: true },
  132068: { category: 'template_rejected', terminal: true },
  132069: { category: 'template_rejected', terminal: true },
}

/**
 * An HTTP status, for the case where Meta answered without a code this file
 * knows. 5xx and 429 are the two the whole web agrees are worth repeating.
 */
function fromHttpStatus(status: number): { category: TransportFailure; terminal: boolean } {
  if (status === 429) return { category: 'rate_limited', terminal: false }
  if (status >= 500) return { category: 'provider_unavailable', terminal: false }
  if (status === 401 || status === 403) return { category: 'not_authorized', terminal: true }
  return { category: 'unknown', terminal: true }
}

export type TemplateSendRequest = {
  to: string
  templateName: string
  templateLanguage: string
  /** Ordered as the placeholders appear in the approved body. */
  variables: { name: string; value: string }[]
  idempotencyKey: string
}

/**
 * The request body Meta is given, built in one place so a test can read it.
 *
 * Exported and pure on purpose: requirement four of this slice is that the
 * payload can never carry a diagnosis, a medicine, a balance or an
 * uncontrolled string, and the way to hold that is a test that inspects the
 * exact bytes rather than a promise in a comment. Every value in it comes from
 * `variables`, which the schema's whitelist has already limited to six names.
 */
export function buildTemplatePayload(request: TemplateSendRequest): Record<string, unknown> {
  const parameters = request.variables.map((variable) =>
    BODY_PARAMETER_FORMAT === 'named'
      ? { type: 'text', parameter_name: variable.name, text: variable.value }
      : { type: 'text', text: variable.value }
  )

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: request.to,
    type: 'template',
    template: {
      name: request.templateName,
      language: { code: request.templateLanguage },
      // A template with no variables takes no body component at all. An empty
      // `parameters` array is a different thing to Meta and is refused.
      ...(parameters.length > 0
        ? { components: [{ type: 'body', parameters }] }
        : {}),
    },
    /*
     * Echoed back in the status webhook, and the only way a message whose POST
     * reply was lost can ever be reconciled: the clinic never learned the
     * wamid, so the wamid cannot be the link. The idempotency key is
     * `<schedule uuid>:<generation>` and carries no patient id, name, number,
     * purpose or clinical word — §15.6 of the schema contract requires exactly
     * that of this string, because this is where it leaves the building.
     */
    biz_opaque_callback_data: request.idempotencyKey,
  }
}

/**
 * Meta's answer, turned into the clinic's vocabulary.
 *
 * Exported separately from the call so the mapping is testable without a
 * transport at all: given Meta's documented response bodies, this returns what
 * the state machine will record.
 */
export function normalizeResponse(
  status: number,
  payload: unknown,
): TransportResult {
  const body = (payload ?? {}) as {
    messages?: { id?: string; message_status?: string }[]
    error?: { code?: number; message?: string; error_data?: { details?: string } }
  }

  if (status >= 200 && status < 300) {
    const first = body.messages?.[0]
    const id = typeof first?.id === 'string' ? first.id : ''
    if (!id) {
      /*
       * A 2xx with no message id. Nothing here can be called accepted and
       * nothing can be called refused, so it is neither: the caller turns an
       * ambiguous answer into `outcome_unknown` rather than guessing, because
       * a message Meta took and this clinic recorded as failed is the one that
       * goes out twice.
       */
      return {
        ok: false,
        category: 'unknown',
        detail: 'Meta answered without a message identifier.',
        terminal: false,
        ambiguous: true,
      }
    }

    /*
     * `message_status` absent means `accepted` — the field was added after the
     * endpoint and Meta omits it in the plain case. `held_for_quality_
     * assessment` and `paused` are recorded as themselves and are NOT
     * delivery; the outbox moves to `sent_to_provider` for all three and only
     * the statuses webhook can take it further.
     */
    const declared = first?.message_status
    const acceptStatus: AcceptStatus =
      typeof declared === 'string' && (ACCEPT_STATUSES as readonly string[]).includes(declared)
        ? declared as AcceptStatus
        : 'accepted'

    return { ok: true, providerReference: id, acceptStatus }
  }

  const code = Number(body.error?.code ?? 0)
  const mapped = ERROR_CODES[code] ?? fromHttpStatus(status)
  const detail = [body.error?.message, body.error?.error_data?.details]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' — ')

  return {
    ok: false,
    category: mapped.category,
    detail: detail || `Meta refused the message with HTTP ${status}.`,
    terminal: mapped.terminal,
  }
}

/**
 * Call Meta, once.
 *
 * No retry loop lives here. Retrying is item 79's business and the worker's,
 * because only the worker knows how many attempts this message has already
 * had, whether the clinic is still open and whether the message is still worth
 * sending. A transport that retries by itself is a transport that can put the
 * clinic past a ceiling the database is enforcing.
 */
export async function sendTemplateMessage(
  request: TemplateSendRequest,
): Promise<TransportResult> {
  const config = whatsappConfig()
  if (!config) {
    /*
     * Unreachable through the worker, which asks `configured()` first and
     * suppresses the whole message into the admin's queue with
     * `channel_not_configured` against it. Kept as a refusal rather than a
     * throw so that a caller which ignored that still cannot reach the
     * network, and terminal so it can never be mistaken for a wait-and-see.
     */
    return {
      ok: false,
      category: 'not_authorized',
      detail: 'The clinic Meta connection is not configured.',
      terminal: true,
    }
  }

  const url =
    `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROVIDER_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTemplatePayload(request)),
      cache: 'no-store',
      signal: abort.signal,
    })

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return normalizeResponse(response.status, payload)
  } catch (error) {
    /*
     * The answer never arrived. This is the case the whole two-transaction
     * shape in `messaging.ts` exists for: the attempt row is already
     * committed, Meta may well have taken the message, and there is no
     * idempotency key on `POST /messages` that would make asking again safe.
     * `ambiguous` carries that up, and the message stays `outcome_unknown`
     * until the statuses webhook says otherwise.
     */
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      category: aborted ? 'provider_unavailable' : 'transport_error',
      detail: aborted
        ? `Meta did not answer within ${Math.round(PROVIDER_TIMEOUT_MS / 1000)} seconds.`
        : error instanceof Error ? error.message : 'The request to Meta failed.',
      terminal: false,
      ambiguous: true,
    }
  } finally {
    clearTimeout(timer)
  }
}
