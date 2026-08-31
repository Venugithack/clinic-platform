import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { doctorLoggedIn } from '@/lib/server/auth'
import { db, isoNow } from '@/lib/server/db'
import { sendWhatsAppText, verifyWebhookSignature, webhookVerifyToken } from '@/lib/server/whatsapp'

type Incoming = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id?: string; from?: string; text?: { body?: string } }>
        statuses?: Array<{ id?: string; status?: string }>
      }
    }>
  }>
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === webhookVerifyToken()) {
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
  }
  return new Response('Verification failed', { status: 403 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!verifyWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 })
  }
  const payload = JSON.parse(rawBody) as Incoming
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (status.id && status.status) {
          await db.prepare(`update whatsapp_messages set status=? where external_message_id=?`).run(status.status, status.id)
          await db.prepare(`update purchase_orders set message_status=? where external_message_id=?`).run(status.status, status.id)
        }
      }
      for (const message of change.value?.messages ?? []) {
        const from = message.from ?? ''
        const body = message.text?.body ?? ''
        if (!from || !body) continue
        await db.prepare(`insert into whatsapp_messages
          (id,direction,audience,phone,body,external_message_id,status,created_at)
          values (?,'inbound','patient',?,?,?,'received',?)`).run(randomUUID(), from, body, message.id ?? null, isoNow())
        const normalized = body.toLowerCase()
        const isPresenceQuestion = normalized.includes('doctor') && ['in', 'there', 'available', 'present'].some((word) => normalized.includes(word))
        if (isPresenceQuestion) {
          const reply = (await doctorLoggedIn())
            ? 'Yes, the doctor is currently signed in at Jayamurugan Clinic.'
            : 'The doctor is not currently signed in at Jayamurugan Clinic. Please contact the clinic before travelling.'
          const result = await sendWhatsAppText(from, reply)
          await db.prepare(`insert into whatsapp_messages
            (id,direction,audience,phone,body,external_message_id,status,created_at)
            values (?,'outbound','patient',?,?,?,?,?)`).run(
              randomUUID(), from, reply, result.ok ? result.messageId : null, result.ok ? 'sent' : 'failed', isoNow(),
            )
        }
      }
    }
  }
  return NextResponse.json({ received: true })
}
