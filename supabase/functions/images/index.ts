/**
 * The only way image bytes move.
 *
 * Upload, list, and fetch — each one authorized on the request, each one
 * recorded. There is no signed URL, no public bucket and no durable link: a
 * photograph is reachable for sixty seconds by one person for one purpose, and
 * then it is not reachable at all.
 *
 *   POST   /images                      upload (multipart), from an open
 *                                       patient or encounter, against a live
 *                                       consent
 *   GET    /images?patientId=…          the metadata a screen draws
 *   GET    /images?imageId=…&ticket=…   the bytes
 *   GET    /images?action=ticket&imageId=…  a sixty-second ticket for one image
 *   POST   /images?action=export        the bytes, for a controlled download,
 *                                       recorded as an export
 *
 * ── WHY THE TICKET EXISTS ──────────────────────────────────────────────────
 *
 * An `<img src>` cannot carry an Authorization header, so the alternative is a
 * session token in a URL — which then lives in the browser's history, in the
 * referrer of anything the page links to, and in every screenshot of the
 * address bar. The ticket is an HMAC over one image id, one actor, one action
 * and an expiry sixty seconds out. It cannot be replayed against another
 * image, it cannot be used by anybody else, and it is stale before it can be
 * pasted anywhere useful.
 */
import { randomUUID } from 'node:crypto'
import { hasRole } from '../_shared/auth.ts'
import { audit, db, transaction } from '../_shared/db.ts'
import { cors, json, logFailure, preflight, sessionFrom } from '../_shared/http.ts'
import { mayAccessImage, recordImageAccess, type ImageRow } from '../_shared/images.ts'
import {
  checksumOf, getObject, issueTicket, newStorageKey, putObject, storageConfigured,
  ticketIsValid,
} from '../_shared/storage.ts'

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')
const num = (value: unknown) => Number(value ?? 0)

/** What a camera on a tablet produces, and nothing else. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_BYTES = 12 * 1024 * 1024

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  /*
   * The pharmacy is refused here, before anything else happens.
   *
   * Policy register 26 says the pharmacist has no access, and "no access" is
   * a property of the endpoint rather than of each query inside it. A role
   * check that lives only beside the SELECT is a role check somebody will
   * forget to write beside the next SELECT.
   */
  if (hasRole(session, 'pharmacy') && !hasRole(session, 'admin', 'doctor', 'nurse')) {
    return json({ ok: false, message: 'The pharmacy counter has no access to clinical images.' }, 403)
  }

  const url = new URL(request.url)

  try {
    // A ticket is a read that mints a sixty-second credential, so it answers
    // to GET as well as POST: an `<img>` needs one before it can ask for
    // anything, and making that a POST buys nothing.
    if (url.searchParams.get('action') === 'ticket') {
      return await issue(session, url)
    }
    if (request.method === 'POST' && url.searchParams.get('action') === 'export') {
      return await bytes(session, url, 'export')
    }
    if (request.method === 'POST') return await upload(session, request)
    if (url.searchParams.get('imageId')) return await bytes(session, url, 'view')
    return await list(session, url)
  } catch (error) {
    // The message is the staff member's, not the stack's. An upload that
    // failed must never look like one that worked.
    const message = error instanceof Error ? error.message : 'That could not be done.'
    logFailure('images', error)
    return json({ ok: false, message }, 400)
  }
})

/**
 * Capture.
 *
 * Refused unless there is an open patient (and, where there is one, an
 * encounter that belongs to that patient), a live consent for that patient,
 * and bytes that are actually an image. Every one of those is a guard against
 * the wrong-patient attachment, which is the failure this feature has to be
 * built around.
 */
async function upload(session: { staffId: string; roles: string[] }, request: Request): Promise<Response> {
  if (!hasRole(session as never, 'doctor', 'nurse')) {
    return json({ ok: false, message: 'Only a doctor or a nurse may take a clinical photograph.' }, 403)
  }
  if (!storageConfigured()) {
    return json({
      ok: false,
      message: 'Private image storage is not configured, so nothing was saved. Nothing was lost either — try again once it is.',
    }, 503)
  }

  const form = await request.formData()
  const patientId = String(form.get('patientId') ?? '').trim()
  const encounterId = String(form.get('encounterId') ?? '').trim()
  const consentId = String(form.get('consentId') ?? '').trim()
  const category = String(form.get('category') ?? '').trim()
  const file = form.get('file')

  if (!patientId) return json({ ok: false, message: 'A photograph is taken from an open patient.' }, 400)
  if (!['before', 'progress', 'after', 'other'].includes(category)) {
    return json({ ok: false, message: 'Say whether this is Before, Progress, After or Other.' }, 400)
  }
  if (!(file instanceof File)) return json({ ok: false, message: 'No image was attached.' }, 400)
  if (!ACCEPTED.has(file.type)) {
    return json({ ok: false, message: 'A clinical photograph is a JPEG, PNG or WebP.' }, 400)
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return json({ ok: false, message: `An image must be between one byte and ${MAX_BYTES / 1024 / 1024} MB.` }, 400)
  }

  const patient = await db.prepare('select id,name from patients where id=?')
    .get(patientId) as { id: string; name: string } | undefined
  if (!patient) return json({ ok: false, message: 'That patient was not found.' }, 404)

  /*
   * The encounter has to belong to the patient.
   *
   * Two tablets, one open Consult each, and a capture posted from the wrong
   * one attaches a photograph of this patient to that patient's visit. The
   * check costs one query and is the difference between a clinical error and
   * a refusal.
   */
  if (encounterId) {
    const encounter = await db.prepare('select id from encounters where id=? and patient_id=?')
      .get(encounterId, patientId)
    if (!encounter) {
      return json({
        ok: false,
        message: 'That visit belongs to a different patient. Open the patient you are photographing and try again.',
      }, 409)
    }
  }

  const consent = await db.prepare(
    `select id from image_consents
      where id=? and patient_id=? and withdrawn_at is null`,
  ).get(consentId, patientId)
  if (!consent) {
    return json({
      ok: false,
      message:
        'There is no live consent for photographs of this patient. Record consent — who agreed, how, and what for — before taking one.',
    }, 409)
  }

  // A nurse may capture only while involved in this patient's care.
  const decision = await mayAccessImage(session as never, { id: '', patient_id: patientId })
  if (!decision.allowed) return json({ ok: false, message: decision.message }, 403)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const key = newStorageKey(patientId, file.type)
  const stored = await putObject(key, bytes, file.type)

  // Only after the bytes are actually in storage. A row written first is a row
  // that says a photograph exists when it does not, and the screen would show
  // a broken image beside a patient's name for ever.
  const id = randomUUID()
  await transaction(async () => {
    await db.prepare(
      `insert into clinical_images
        (id,patient_id,encounter_id,consent_id,category,series_key,body_site,side,caption,
         storage_key,content_type,byte_size,checksum,status,captured_by,captured_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, now())`,
    ).run(
      id, patientId, encounterId || null, consentId, category,
      String(form.get('seriesKey') ?? '').trim(),
      String(form.get('bodySite') ?? '').trim(),
      String(form.get('side') ?? '').trim(),
      String(form.get('caption') ?? '').trim(),
      stored.key, stored.contentType, stored.byteSize, stored.checksum,
      session.staffId,
    )
    await audit(session.staffId, 'image.captured', 'patient', patientId,
      `${category} image captured for ${patient.name}`)
  })

  return json({ ok: true, imageId: id, checksum: stored.checksum, byteSize: stored.byteSize })
}

/** The metadata a screen draws. Admins get this; content is a separate question. */
async function list(session: { staffId: string; roles: string[] }, url: URL): Promise<Response> {
  const patientId = url.searchParams.get('patientId') ?? ''
  if (!patientId) return json({ ok: false, message: 'No patient asked for.' }, 400)

  const decision = await mayAccessImage(session as never, { id: '', patient_id: patientId }, { content: false })
  if (!decision.allowed) return json({ ok: false, message: decision.message }, 403)

  const images = await db.prepare(
    `select i.*, s.name as captured_by_name, e.name as error_by_name,
            c.purpose as consent_purpose, c.withdrawn_at as consent_withdrawn_at,
            (select count(*)::int from image_derivatives d where d.source_image_id = i.id) as derivative_count
       from clinical_images i
       join staff s on s.id = i.captured_by
       left join staff e on e.id = i.error_by
       join image_consents c on c.id = i.consent_id
      where i.patient_id = ?
      order by i.captured_at desc`,
  ).all(patientId) as Row[]

  // Whether this caller could actually fetch the bytes, so a screen can say
  // "record only" rather than drawing a broken image.
  const content = await mayAccessImage(session as never, { id: '', patient_id: patientId })

  return json({
    ok: true,
    canSeeContent: content.allowed,
    basis: content.allowed ? content.basis : decision.basis,
    images: images.map((row) => ({
      id: text(row.id),
      patientId: text(row.patient_id),
      encounterId: text(row.encounter_id),
      consentId: text(row.consent_id),
      category: text(row.category),
      seriesKey: text(row.series_key),
      bodySite: text(row.body_site),
      side: text(row.side),
      caption: text(row.caption),
      contentType: text(row.content_type),
      byteSize: num(row.byte_size),
      checksum: text(row.checksum),
      status: text(row.status),
      errorReason: text(row.error_reason),
      errorByName: text(row.error_by_name),
      capturedByName: text(row.captured_by_name),
      capturedAt: text(row.captured_at),
      consentPurpose: text(row.consent_purpose),
      consentWithdrawn: Boolean(row.consent_withdrawn_at),
      derivativeCount: num(row.derivative_count),
    })),
  })
}

/** A sixty-second ticket for one image and one action. */
async function issue(session: { staffId: string; roles: string[] }, url: URL): Promise<Response> {
  const imageId = url.searchParams.get('imageId') ?? ''
  if (!imageId) return json({ ok: false, message: 'No image asked for.' }, 400)

  const image = await db.prepare('select id,patient_id,status from clinical_images where id=?')
    .get(imageId) as ImageRow | undefined
  if (!image) return json({ ok: false, message: 'That image was not found.' }, 404)

  const decision = await mayAccessImage(session as never, image)
  if (!decision.allowed) {
    await recordImageAccess(imageId, session.staffId, 'refused', decision.basis)
    return json({ ok: false, message: decision.message }, 403)
  }

  return json({
    ok: true,
    ticket: await issueTicket(imageId, session.staffId, 'view'),
    expiresInSeconds: 60,
  })
}

/**
 * The bytes.
 *
 * Authorized twice: the session says who this is, and the ticket says they
 * were allowed this image for this purpose within the last minute. Either one
 * failing is a refusal, and the refusal is recorded.
 */
async function bytes(
  session: { staffId: string; roles: string[] },
  url: URL,
  action: 'view' | 'export',
): Promise<Response> {
  const imageId = url.searchParams.get('imageId') ?? ''
  if (!imageId) return json({ ok: false, message: 'No image asked for.' }, 400)

  const image = await db.prepare(
    'select id,patient_id,status,storage_key,content_type from clinical_images where id=?',
  ).get(imageId) as ImageRow | undefined
  if (!image) return json({ ok: false, message: 'That image was not found.' }, 404)

  const decision = await mayAccessImage(session as never, image)
  if (!decision.allowed) {
    await recordImageAccess(imageId, session.staffId, 'refused', decision.basis)
    return json({ ok: false, message: decision.message }, 403)
  }

  if (action === 'view') {
    const ticket = url.searchParams.get('ticket') ?? ''
    if (!await ticketIsValid(ticket, imageId, session.staffId, 'view')) {
      await recordImageAccess(imageId, session.staffId, 'refused', 'ticket_invalid')
      return json({
        ok: false,
        message: 'That image link has expired. Open the image again.',
      }, 403)
    }
  }

  if (action === 'export') {
    // Policy register 28: a patient may have their images, through a controlled
    // download. Not while consent stands withdrawn.
    const consent = await db.prepare(
      `select c.withdrawn_at from clinical_images i
         join image_consents c on c.id = i.consent_id where i.id=?`,
    ).get(imageId) as { withdrawn_at: string | null }
    if (consent?.withdrawn_at) {
      await recordImageAccess(imageId, session.staffId, 'refused', 'consent_withdrawn')
      return json({ ok: false, message: 'Consent for this patient\'s photographs has been withdrawn. Nothing may be exported.' }, 403)
    }
  }

  const data = await getObject(image.storage_key)

  // Verified on the way out. An object that no longer hashes to what was
  // stored is not the original, and showing it as one would be worse than
  // showing nothing.
  const expected = await db.prepare('select checksum from clinical_images where id=?')
    .get(imageId) as { checksum: string }
  if (await checksumOf(data) !== expected.checksum) {
    await recordImageAccess(imageId, session.staffId, 'refused', 'checksum_mismatch')
    return json({
      ok: false,
      message: 'This image no longer matches what was stored and is not being shown. Report it.',
    }, 409)
  }

  await recordImageAccess(imageId, session.staffId, action, decision.basis)

  return new Response(data as unknown as BodyInit, {
    headers: {
      ...cors,
      'Content-Type': image.content_type,
      // Never cached anywhere. A clinical photograph in a shared tablet's disk
      // cache outlives the session that fetched it.
      'Cache-Control': 'no-store, private',
      ...(action === 'export'
        ? { 'Content-Disposition': `attachment; filename="clinical-image-${imageId.slice(0, 8)}.jpg"` }
        : {}),
    },
  })
}
