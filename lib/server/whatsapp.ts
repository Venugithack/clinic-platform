import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
const appSecret = process.env.WHATSAPP_APP_SECRET
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN
const apiVersion = process.env.WHATSAPP_API_VERSION ?? 'v23.0'

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

export async function sendWhatsAppText(to: string, body: string) {
  if (!whatsappStatus().configured) {
    return { ok: false as const, error: 'WhatsApp is not connected yet.' }
  }

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    cache: 'no-store',
  })
  const payload = (await response.json()) as { messages?: { id: string }[]; error?: { message?: string } }
  if (!response.ok || !payload.messages?.[0]?.id) {
    return { ok: false as const, error: payload.error?.message ?? 'Meta did not accept the message.' }
  }
  return { ok: true as const, messageId: payload.messages[0].id }
}
