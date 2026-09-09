import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
const appSecret = Deno.env.get('WHATSAPP_APP_SECRET')
const verifyToken = Deno.env.get('WHATSAPP_VERIFY_TOKEN')
const apiVersion = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v23.0'

export function whatsappStatus() {
  const configured = Boolean(accessToken && phoneNumberId && appSecret && verifyToken)
  return {
    configured,
    businessNumberConfigured: Boolean(phoneNumberId),
    note: configured
      ? 'Official Meta connection is configured.'
      : 'Drafting works now. Connect the clinic Meta account to enable real send and inbound replies.',
  }
}

export function verifyWebhookSignature(rawBody: string, signature: string | null) {
  if (!appSecret || !signature?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const supplied = signature.slice('sha256='.length)
  const expectedBytes = Buffer.from(expected, 'hex')
  const suppliedBytes = Buffer.from(supplied, 'hex')
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

export function webhookVerifyToken() {
  return verifyToken
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
function dialable(raw: string): { ok: true; to: string } | { ok: false; reason: 'missing' | 'unusable' } {
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
  if (!whatsappStatus().configured) {
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

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: number.to, type: 'text', text: { body } }),
    cache: 'no-store',
  })
  const payload = (await response.json()) as { messages?: { id: string }[]; error?: { message?: string } }
  if (!response.ok || !payload.messages?.[0]?.id) {
    return { ok: false as const, error: payload.error?.message ?? 'Meta did not accept the message.' }
  }
  return { ok: true as const, messageId: payload.messages[0].id }
}
