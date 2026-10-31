/**
 * The only way a result document moves.
 *
 * Upload and fetch, each authorized on the request, each recorded. There is no
 * signed URL, no public bucket and no durable link: a laboratory report is
 * reachable for sixty seconds by one person for one purpose, and then it is
 * not reachable at all.
 *
 *   POST /results                          attach a report to a result
 *                                          (multipart), from an open patient
 *   GET  /results?action=ticket&documentId=…  a sixty-second ticket
 *   GET  /results?documentId=…&ticket=…    the bytes
 *
 * ── WHY THIS IS NOT THE `images` ENDPOINT ──────────────────────────────────
 *
 * They look alike and they are governed by different owner items. A clinical
 * photograph is something this clinic DOES to a patient, under a consent
 * recorded before the shutter (items 26–29). A laboratory report is something
 * the clinic RECEIVES about a patient, under item 86. Serving both from one
 * endpoint would mean one consent check that has to be right for two meanings,
 * and the first time somebody relaxed it for reports it would relax for
 * photographs.
 *
 * What they share is the mechanism, deliberately: the same private object
 * store, the same sixty-second single-purpose HMAC ticket, the same
 * checksum-on-the-way-out. A second way of doing that would be a second way of
 * getting it wrong.
 *
 * ── THE ASYMMETRY, WHICH IS ON PURPOSE ─────────────────────────────────────
 *
 * An administrator may ATTACH a report and may not OPEN one. Owner item 86
 * says both halves — "nurses and administrators may attach, transcribe, and
 * operationally track results", and separately that an admin's access is
 * "operational/audit metadata ... not unrestricted result content" — and they
 * are not in tension. Filing a PDF that is already in your hand is not the
 * same capability as being able to open anybody's.
 */
import { randomUUID } from 'node:crypto'
import { hasRole } from '../_shared/auth.ts'
import { audit, db, transaction } from '../_shared/db.ts'
import { cors, json, logFailure, preflight, sessionFrom } from '../_shared/http.ts'
import { mayAccessResults } from '../_shared/diagnostics.ts'
import { isUniqueViolation, requestFingerprint } from '../_shared/idempotency.ts'
import {
  checksumOf, deleteObject, getObject, issueTicket, newDocumentStorageKey, putObject,
  storageConfigured, ticketIsValid,
} from '../_shared/storage.ts'

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')

/** What a laboratory emails, and what a front desk scans. Nothing else. */
const ACCEPTED = new Set(['application/pdf', 'image/jpeg', 'image/png'])
const MAX_BYTES = 20 * 1024 * 1024

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  /*
   * The pharmacy is refused here, before anything else happens.
   *
   * Owner item 86: "Pharmacy users must not see result content or invoke
   * result workflows." No access is a property of the endpoint rather than of
   * each query inside it — a role check that lives only beside the SELECT is a
   * role check somebody will forget to write beside the next SELECT.
   */
  if (hasRole(session, 'pharmacy') && !hasRole(session, 'admin', 'doctor', 'nurse')) {
    return json({ ok: false, message: 'The pharmacy counter has no access to results.' }, 403)
  }

  const url = new URL(request.url)

  try {
    if (url.searchParams.get('action') === 'ticket') return await issue(session, url)
    if (request.method === 'POST') return await upload(session, request)
    if (url.searchParams.get('documentId')) return await bytes(session, url)
    return json({ ok: false, message: 'Ask for a document.' }, 400)
  } catch (error) {
    // The message is the staff member's, not the stack's. An upload that
    // failed must never look like one that worked.
    const message = error instanceof Error ? error.message : 'That could not be done.'
    logFailure('results', error)
    return json({ ok: false, message }, 400)
  }
})

/**
 * Attach a report.
 *
 * The result decides the patient, and the patient decides the access. A
 * caller-supplied patient id is deliberately not accepted at all: the one on
 * the row comes out of `investigation_results`, and the composite foreign key
 * on `result_documents` then refuses anything that does not match. There is no
 * arrangement of form fields that files one patient's report against another
 * patient's result.
 */
async function upload(
  session: { staffId: string; roles: string[]; canPublishClinicalTemplates: boolean },
  request: Request,
): Promise<Response> {
  if (!storageConfigured('documents')) {
    return json({
      ok: false,
      message:
        'Private document storage is not configured, so nothing was saved. Nothing was lost ' +
        'either — try again once it is.',
    }, 503)
  }

  const form = await request.formData()
  const resultId = String(form.get('resultId') ?? '').trim()
  const key = String(form.get('idempotencyKey') ?? '').trim()
  const source = String(form.get('source') ?? '').trim()
  const sourceReference = String(form.get('sourceReference') ?? '').trim()
  const supersedesDocumentId = String(form.get('supersedesDocumentId') ?? '').trim()
  const file = form.get('file')

  if (!resultId) return json({ ok: false, message: 'A report is attached to a result.' }, 400)
  if (!key) {
    return json({
      ok: false,
      message:
        'Send this upload under a reference of its own (idempotencyKey), so that a reply lost on ' +
        'the way back cannot file the same report twice.',
    }, 400)
  }
  if (!['external_laboratory', 'external_facility', 'clinic_scanned', 'imported_structured_feed'].includes(source)) {
    return json({ ok: false, message: 'Say where this document came from.' }, 400)
  }
  if (!(file instanceof File)) return json({ ok: false, message: 'No document was attached.' }, 400)
  if (!ACCEPTED.has(file.type)) {
    return json({ ok: false, message: 'A report is a PDF, a JPEG or a PNG.' }, 400)
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return json({
      ok: false,
      message: `A document must be between one byte and ${MAX_BYTES / 1024 / 1024} MB.`,
    }, 400)
  }

  const result = await db.prepare(
    `select r.id, r.patient_id, r.superseded_at, i.item_name
       from investigation_results r
       join investigation_order_items i on i.id = r.order_item_id
      where r.id = ?`,
  ).get(resultId) as Row | undefined
  if (!result) return json({ ok: false, message: 'That result was not found.' }, 404)

  const access = await mayAccessResults(session as never, text(result.patient_id))
  if (!access.allowed) return json({ ok: false, message: access.message }, 403)

  if (result.superseded_at) {
    return json({
      ok: false,
      message:
        'That report has been corrected. Attach the document to the corrected report, so that what ' +
        'is current and what is history stay apart.',
    }, 409)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const checksum = await checksumOf(bytes)
  const fingerprint = requestFingerprint({
    command: 'attach_result_document',
    actor: session.staffId,
    resultId, source, sourceReference, supersedesDocumentId, checksum,
    contentType: file.type,
  })

  /*
   * The courteous path, before a single byte is written.
   *
   * Two ways the same document arrives twice: the same reference retried after
   * a lost reply, and somebody pressing Attach again with the same file. Both
   * are answered from what is already on the record, and the two unique
   * indexes behind them — on the reference, and on `(result_id, checksum)` —
   * are the guarantee rather than the check.
   */
  const already = await existingDocument(resultId, key, checksum, fingerprint)
  if (already) return json({ ok: true, ...already, duplicate: true })

  const storageKey = newDocumentStorageKey(text(result.patient_id), file.type)
  const stored = await putObject(storageKey, bytes, file.type, 'documents')

  // Only after the bytes are actually in storage. A row written first is a row
  // that says a report exists when it does not, and a screen would offer a
  // clinician a document that cannot be opened.
  const id = randomUUID()
  try {
    await transaction(async () => {
      if (supersedesDocumentId) {
        const previous = await db.prepare(
          `select id, result_id, superseded_at from result_documents where id = ? for update`,
        ).get(supersedesDocumentId) as Row | undefined
        if (!previous) throw new Error('The document being replaced was not found.')
        if (text(previous.result_id) !== resultId) {
          throw new Error('That document belongs to a different result.')
        }
        if (previous.superseded_at) throw new Error('That document has already been replaced.')
        await db.prepare(
          `update result_documents set status = 'superseded', superseded_at = now() where id = ?`,
        ).run(supersedesDocumentId)
      }

      await db.prepare(
        `insert into result_documents
           (id, result_id, patient_id, storage_key, content_type, byte_size, checksum,
            source, source_reference, original_filename, uploaded_by,
            supersedes_document_id, idempotency_key, request_fingerprint)
         values (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?)`,
      ).run(
        id, resultId, text(result.patient_id), stored.key, stored.contentType,
        stored.byteSize, stored.checksum, source, sourceReference,
        String(form.get('originalFilename') ?? '').trim().slice(0, 200),
        session.staffId, supersedesDocumentId || null, key, fingerprint,
      )

      if (supersedesDocumentId) {
        await db.prepare(
          `update result_documents set superseded_by_document_id = ? where id = ?`,
        ).run(id, supersedesDocumentId)
      }

      await audit(
        session.staffId, 'investigation.document_attached', 'investigation_result', resultId,
        `Report attached to ${text(result.item_name)} (${stored.contentType}, ${stored.byteSize} bytes)`,
      )
    })
  } catch (error) {
    /*
     * The row was refused after the bytes were written, so the bytes are an
     * orphan and are removed. The alternative — leaving them — is a storage
     * bucket that slowly fills with patients' reports that no row points at,
     * which is the worst of both: retained and unfindable.
     */
    if (
      isUniqueViolation(error, 'result_documents_idempotency')
      || isUniqueViolation(error, 'result_documents_one_copy')
      || isUniqueViolation(error, 'result_documents_storage_key_key')
    ) {
      await deleteObject(stored.key, 'documents').catch(() => {})
      const winner = await existingDocument(resultId, key, checksum, fingerprint)
      if (winner) return json({ ok: true, ...winner, duplicate: true })
    }
    await deleteObject(stored.key, 'documents').catch(() => {})
    throw error
  }

  return json({
    ok: true,
    documentId: id,
    checksum: stored.checksum,
    byteSize: stored.byteSize,
  })
}

/**
 * The document this reference, or these bytes, already produced.
 *
 * A reference reused for a materially different upload is refused rather than
 * answered with somebody else's document — the same rule every other
 * idempotent command in this application follows, and for the same reason.
 */
async function existingDocument(
  resultId: string,
  key: string,
  checksum: string,
  fingerprint: string,
): Promise<{ documentId: string; checksum: string; byteSize: number } | null> {
  const byKey = await db.prepare(
    `select id, checksum, byte_size, request_fingerprint from result_documents
      where idempotency_key = ?`,
  ).get(key) as Row | undefined

  if (byKey) {
    if (text(byKey.request_fingerprint) !== fingerprint) {
      throw new Error(
        'That reference was already used for a different upload. Nothing was changed. Attach this ' +
        'one under a reference of its own.',
      )
    }
    return {
      documentId: text(byKey.id),
      checksum: text(byKey.checksum),
      byteSize: Number(byKey.byte_size),
    }
  }

  const byBytes = await db.prepare(
    `select id, checksum, byte_size from result_documents
      where result_id = ? and checksum = ?`,
  ).get(resultId, checksum) as Row | undefined
  if (!byBytes) return null

  return {
    documentId: text(byBytes.id),
    checksum: text(byBytes.checksum),
    byteSize: Number(byBytes.byte_size),
  }
}

/** A sixty-second ticket for one document and one reader. */
async function issue(
  session: { staffId: string; roles: string[]; canPublishClinicalTemplates: boolean },
  url: URL,
): Promise<Response> {
  const documentId = url.searchParams.get('documentId') ?? ''
  if (!documentId) return json({ ok: false, message: 'No document asked for.' }, 400)

  const document = await db.prepare(
    `select id, patient_id from result_documents where id = ?`,
  ).get(documentId) as Row | undefined
  if (!document) return json({ ok: false, message: 'That document was not found.' }, 404)

  const access = await mayAccessResults(session as never, text(document.patient_id))
  if (!access.allowed) return json({ ok: false, message: access.message }, 403)
  if (!access.content) {
    return json({
      ok: false,
      message:
        'An administrator sees that a report exists and its audit trail, not the report itself. ' +
        'Owner policy item 86.',
    }, 403)
  }

  return json({
    ok: true,
    ticket: await issueTicket(documentId, session.staffId, 'result_document'),
    expiresInSeconds: 60,
  })
}

/**
 * The bytes.
 *
 * Authorized twice: the session says who this is, and the ticket says they
 * were allowed this document for this purpose within the last minute. Either
 * one failing is a refusal.
 */
async function bytes(
  session: { staffId: string; roles: string[]; canPublishClinicalTemplates: boolean },
  url: URL,
): Promise<Response> {
  const documentId = url.searchParams.get('documentId') ?? ''
  const document = await db.prepare(
    `select id, patient_id, storage_key, content_type, checksum from result_documents where id = ?`,
  ).get(documentId) as Row | undefined
  if (!document) return json({ ok: false, message: 'That document was not found.' }, 404)

  const access = await mayAccessResults(session as never, text(document.patient_id))
  if (!access.allowed) return json({ ok: false, message: access.message }, 403)
  if (!access.content) {
    return json({
      ok: false,
      message:
        'An administrator sees that a report exists and its audit trail, not the report itself. ' +
        'Owner policy item 86.',
    }, 403)
  }

  const ticket = url.searchParams.get('ticket') ?? ''
  if (!await ticketIsValid(ticket, documentId, session.staffId, 'result_document')) {
    return json({ ok: false, message: 'That document link has expired. Open the report again.' }, 403)
  }

  const data = await getObject(text(document.storage_key), 'documents')

  // Verified on the way out. An object that no longer hashes to what was
  // stored is not the report that was filed, and showing it as one would be
  // worse than showing nothing.
  if (await checksumOf(data) !== text(document.checksum)) {
    return json({
      ok: false,
      message: 'This document no longer matches what was stored and is not being shown. Report it.',
    }, 409)
  }

  await audit(
    session.staffId, 'investigation.document_opened', 'result_document', documentId,
    `Report opened (${access.basis})`,
  )

  return new Response(data as unknown as BodyInit, {
    headers: {
      ...cors,
      'Content-Type': text(document.content_type),
      // Never cached anywhere. A patient's laboratory report in a shared
      // tablet's disk cache outlives the session that fetched it.
      'Cache-Control': 'no-store, private',
    },
  })
}
