import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

/**
 * The clinic's Meta connection, read when it is asked for rather than when
 * this file is first imported.
 *
 * It used to be five module-level `const`s. That is the same five values in
 * the clinic — an Edge Function's environment is fixed for the life of the
 * isolate — but it made the configured path untestable: the test harness
 * imports the backend through one bridge, and by the time any test could set
 * a variable the module had already decided the answer was "not configured".
 * A guard whose passing case has never been executed is a guard nobody has.
 *
 * Nothing about what is read, or what `whatsappStatus()` answers, changed.
 */
function env(name: string): string {
  return Deno.env.get(name) ?? ''
}

export type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  appSecret: string
  verifyToken: string
  apiVersion: string
}

/**
 * All five, or nothing.
 *
 * There is deliberately no fallback, no development default and no partial
 * mode. Owner item 76 says an unavailable official channel suppresses the send
 * into a staff queue, and a half-configured adapter that reaches Meta with a
 * missing phone number id is not a channel — it is an outage that reports
 * itself as a delivery failure against the patient's number.
 */
export function whatsappConfig(): WhatsAppConfig | null {
  const config = {
    accessToken: env('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    apiVersion: env('WHATSAPP_API_VERSION') || 'v23.0',
  }
  if (!config.accessToken || !config.phoneNumberId || !config.appSecret || !config.verifyToken) {
    return null
  }
  return config
}

export function whatsappStatus() {
  const configured = whatsappConfig() !== null
  return {
    configured,
    businessNumberConfigured: Boolean(env('WHATSAPP_PHONE_NUMBER_ID')),
    note: configured
      ? 'Official Meta connection is configured.'
      : 'Drafting works now. Connect the clinic Meta account to enable real send and inbound replies.',
  }
}

/**
 * Meta's `X-Hub-Signature-256`, checked against the bytes that arrived.
 *
 * ── WHY THIS TAKES BYTES AND NOT A STRING ──────────────────────────────────
 *
 * The signature is an HMAC over the request body exactly as Meta serialized
 * it. Anything that re-encodes it first — parsing the JSON and stringifying it
 * again, or reading it as text and re-encoding — is signing a different
 * document that usually happens to be byte-identical, and stops being so the
 * first time Meta emits a non-ASCII character, a different key order or
 * different whitespace. A patient named with a character outside ASCII is not
 * an edge case in this clinic.
 *
 * So the caller passes the raw bytes it read off the request and never the
 * parsed object. The string overload is kept because `sendWhatsAppText`'s
 * callers and the older tests use it, and a string is encoded here once, in
 * one place, rather than at each call site.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null,
): boolean {
  const secret = env('WHATSAPP_APP_SECRET')
  if (!secret || !signature?.startsWith('sha256=')) return false

  const bytes = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody
  const expected = createHmac('sha256', secret).update(Buffer.from(bytes)).digest('hex')
  const supplied = signature.slice('sha256='.length)

  // Hex of a fixed-width digest, so a length difference is a malformed header
  // rather than a near miss; `timingSafeEqual` throws on unequal lengths, so
  // the check has to come first either way.
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(supplied.toLowerCase(), 'hex'),
  )
}

/**
 * Meta's verification challenge token, compared without leaking its length or
 * its matching prefix through timing.
 *
 * A plain `===` on a secret is the textbook side channel, and this one is
 * reachable by anybody on the internet who knows the endpoint's URL.
 */
export function verifyTokenMatches(supplied: string): boolean {
  const expected = env('WHATSAPP_VERIFY_TOKEN')
  if (!expected || !supplied) return false
  const a = new TextEncoder().encode(expected)
  const b = new TextEncoder().encode(supplied)
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function webhookVerifyToken() {
  const token = env('WHATSAPP_VERIFY_TOKEN')
  return token === '' ? undefined : token
}

/**
 * The number Meta will route, from the number somebody typed on a tablet.
 *
 * The Graph API takes a destination in international form — digits only, with
 * the country code, no punctuation. What is actually stored against a supplier
 * or a patient is whatever fitted in the box: "98765 43210", "+91-98765-43210",
 * "(0) 98765 43210". Handed over as typed, the bare ten-digit form is the
 * dangerous one — Meta either refuses it or reads it as somebody else's number
 * in a country nobody chose, and the clinic sees a delivery failure it cannot
 * explain against a number that looks perfectly correct on the screen.
 *
 * Ten bare digits therefore mean India, because ten digits is the whole of an
 * Indian national number and India is the whole of this clinic's world. A
 * number that already carries a country code is left exactly as it is: a
 * supplier across a border is rare, and guessing at one would be worse than
 * refusing to send.
 *
 * A slash is deliberately NOT stripped. "9876543210 / 9876543211" in one field
 * is how a second number gets recorded here, and joining the two would produce
 * a twenty-digit number that either fails or reaches a stranger. It stops here
 * instead, where somebody at the desk can read why and fix the record.
 */
export function dialable(raw: string): { ok: true; to: string } | { ok: false; reason: 'missing' | 'unusable' } {
  // Spaces, dots, dashes and brackets are how a number is written down, not
  // part of it; a leading + or 00 is the international prefix spelled two ways.
  const digits = raw.replace(/[\s().-]/g, '').replace(/^(?:\+|00)/, '')
  if (digits === '') return { ok: false, reason: 'missing' }
  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'unusable' }

  // A zero in front of the ten digits is the national trunk prefix — how the
  // number is printed on the van and on the visiting card. It is never part of
  // the number, and it arrives in both of the places people write it: on its
  // own, and tucked inside an otherwise complete "+91 (0) 98765 43210".
  const national = digits.replace(/^(91)?0(\d{10})$/, '$1$2')

  if (national.length === 10) return { ok: true, to: `91${national}` }

  // Eleven digits is the shortest thing that can plausibly carry a country code
  // and a subscriber number; fifteen is the most E.164 allows. Ten is spoken
  // for above, which is the one ambiguity this accepts on purpose.
  if (national.length >= 11 && national.length <= 15) return { ok: true, to: national }

  return { ok: false, reason: 'unusable' }
}

export async function sendWhatsAppText(to: string, body: string, savedFor = 'this contact') {
  const config = whatsappConfig()
  if (!config) {
    return { ok: false as const, error: 'WhatsApp is not connected yet.' }
  }

  const number = dialable(to)
  if (!number.ok) {
    return {
      ok: false as const,
      error:
        number.reason === 'missing'
          ? `No WhatsApp number is saved for ${savedFor}. Add one to the record, then send again.`
          : `The WhatsApp number saved for ${savedFor} — ${to.trim()} — cannot be sent to. Open the record and save one number on its own, either ten digits or the full number with its country code.`,
    }
  }

  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: number.to, type: 'text', text: { body },
      }),
      cache: 'no-store',
    },
  )
  const payload = (await response.json()) as { messages?: { id: string }[]; error?: { message?: string } }
  if (!response.ok || !payload.messages?.[0]?.id) {
    return { ok: false as const, error: payload.error?.message ?? 'Meta did not accept the message.' }
  }
  return { ok: true as const, messageId: payload.messages[0].id }
}
