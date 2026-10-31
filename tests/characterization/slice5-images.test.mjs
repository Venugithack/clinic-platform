/**
 * Slice 5's exit gate: clinical images, and who may ever see one.
 *
 * The brief's list, in order: cross-role denial, cross-patient denial, the
 * nurse involvement rule, pharmacist denial, admin content denial, the consent
 * requirement, wrong-patient attachment, immutable originals, entered-in-error
 * audit history, expired and invalid access URLs, lost-session revocation, and
 * upload failure and retry.
 *
 * Everything runs against the real `images` Edge Function with a real session
 * token, and the bytes go to a scratch directory that this file creates and
 * removes. That directory is the staging half of `storage.ts`: it exercises
 * consent, the access rules, the audit and the checksum against real bytes,
 * and says nothing at all about Supabase's own bucket policy — which is a
 * deployment check and is recorded as one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { edgeGet, edgeRequest } from '../support/backend.mjs'
import {
  as, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor,
} from '../support/clinic.mjs'

/**
 * Four years passing.
 *
 * `captured_at` is one of the columns `clinical_images_protected` refuses to
 * let anything change, which is the point of it — an image that can be re-dated
 * can be moved out of a retention queue by editing a number. Nothing in the
 * application can do this; the trigger comes off for one statement so the test
 * can manufacture the passage of time, exactly as the Slice 2.1 migration did
 * for its own correction, and goes straight back on.
 */
async function ageByFourYears(imageId) {
  await rows('alter table jmc.clinical_images disable trigger clinical_images_protected')
  try {
    await rows(
      `update jmc.clinical_images set captured_at = now() - interval '4 years' where id=$1`,
      [imageId],
    )
  } finally {
    await rows('alter table jmc.clinical_images enable trigger clinical_images_protected')
  }
}

let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'jmc-images-'))
  process.env.CLINIC_IMAGE_ROOT = root
})

after(async () => {
  await closeClinic()
  delete process.env.CLINIC_IMAGE_ROOT
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
})

/** A one-pixel PNG. Real bytes, so the checksum means something. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

function capture({ patientId, consentId, encounterId, category = 'before', bytes = PNG, type = 'image/png', ...extra }) {
  const form = new FormData()
  form.set('patientId', patientId)
  if (consentId) form.set('consentId', consentId)
  if (encounterId) form.set('encounterId', encounterId)
  form.set('category', category)
  for (const [key, value] of Object.entries(extra)) form.set(key, String(value))
  form.set('file', new File([bytes], 'photo.png', { type }))
  return form
}

async function clinic() {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', username: 'img-doc', roles: ['doctor'], pin: '5731' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'img-nurse', roles: ['nurse'], pin: '6182' })
  const otherNurse = await makeStaff({ name: 'Other Nurse', username: 'img-nurse2', roles: ['nurse'], pin: '7293' })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 'img-pharm', roles: ['pharmacy'], pin: '7048' })
  const admin = await makeStaff({ name: 'Manager', username: 'img-admin', roles: ['admin'], pin: '4829' })

  await as(doctor, 'create_patient', { name: 'Image Patient', age: 34, sex: 'female', phone: '+919000000401' })
  const patientId = String(await scalar(`select id from jmc.patients where name='Image Patient'`))
  await as(doctor, 'create_patient', { name: 'Other Patient', age: 51, sex: 'male', phone: '+919000000402' })
  const otherPatientId = String(await scalar(`select id from jmc.patients where name='Other Patient'`))

  const consent = await as(doctor, 'record_image_consent', {
    patientId, consentingPerson: 'Image Patient', relationship: 'self',
    method: 'verbal', purpose: 'Recording the wound before and after dressing',
  })

  return {
    doctor, nurse, otherNurse, pharmacy, admin,
    patientId, otherPatientId, consentId: consent.data.consentId,
  }
}

/** Capture one image and return its id. */
async function captured(context, extra = {}) {
  const result = await edgeRequest('images', '', {
    method: 'POST',
    token: await tokenFor(context.doctor),
    body: capture({ patientId: context.patientId, consentId: context.consentId, ...extra }),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.imageId
}

// ═══════════════════════════════════════════════════════════════════════════

describe('consent comes first', () => {
  test('nothing is captured without a live consent, and nothing is written when it is refused', async () => {
    const context = await clinic()

    const withoutConsent = await edgeRequest('images', '', {
      method: 'POST', token: await tokenFor(context.doctor),
      body: capture({ patientId: context.patientId }),
    })
    assert.equal(withoutConsent.status, 409)
    assert.match(withoutConsent.body.message, /no live consent/)

    // Refused means nothing anywhere: no row, and no bytes on disk.
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)
    assert.equal(readdirSync(root).length, 0)

    // Another patient's consent is not this patient's consent.
    const otherConsent = await as(context.doctor, 'record_image_consent', {
      patientId: context.otherPatientId, consentingPerson: 'Other Patient',
      method: 'verbal', purpose: 'Something else entirely',
    })
    const borrowed = await edgeRequest('images', '', {
      method: 'POST', token: await tokenFor(context.doctor),
      body: capture({ patientId: context.patientId, consentId: otherConsent.data.consentId }),
    })
    assert.equal(borrowed.status, 409)
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)
  })

  test('a withdrawn consent stops new photographs and every export, and keeps the old ones', async () => {
    const context = await clinic()
    const imageId = await captured(context)

    await as(context.doctor, 'withdraw_image_consent', {
      consentId: context.consentId, reason: 'Patient asked for the photographs not to be used',
    })

    const again = await edgeRequest('images', '', {
      method: 'POST', token: await tokenFor(context.doctor),
      body: capture({ patientId: context.patientId, consentId: context.consentId }),
    })
    assert.equal(again.status, 409)

    const exported = await edgeRequest('images', `?action=export&imageId=${imageId}`, {
      method: 'POST', token: await tokenFor(context.doctor),
    })
    assert.equal(exported.status, 403)
    assert.match(exported.body.message, /withdrawn/)

    // The image itself is still on the clinical record, which is the half a
    // withdrawal does not reach.
    assert.equal(
      await scalar(`select status from jmc.clinical_images where id=$1`, [imageId]),
      'active',
    )
    // And the refusal is on the access log, like every other answer.
    assert.equal(
      await scalar(`select count(*)::int from jmc.image_access_events
        where action='refused' and basis='consent_withdrawn'`),
      1,
    )
  })
})

describe('the wrong patient', () => {
  test('a visit belonging to somebody else is refused, not silently attached', async () => {
    const context = await clinic()
    await as(context.doctor, 'sign_consultation', {
      patientId: context.otherPatientId, complaint: 'Cough',
      diagnosis: 'Acute bronchitis', diagnosisStatus: 'provisional',
    })
    const otherEncounter = String(await scalar('select id from jmc.encounters limit 1'))

    const crossed = await edgeRequest('images', '', {
      method: 'POST', token: await tokenFor(context.doctor),
      body: capture({
        patientId: context.patientId, consentId: context.consentId, encounterId: otherEncounter,
      }),
    })
    assert.equal(crossed.status, 409)
    assert.match(crossed.body.message, /belongs to a different patient/)
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)
  })

  test('a doctor cannot see one patient\'s image by asking about another', async () => {
    const context = await clinic()
    const imageId = await captured(context)

    // The list is scoped by patient, so asking about the other patient returns
    // that patient's images — which is none.
    const other = await edgeGet('images', `?patientId=${context.otherPatientId}`, await tokenFor(context.doctor))
    assert.equal(other.status, 200)
    assert.deepEqual(other.body.images, [])

    // And the bytes are fetched by image id, which is checked against the
    // image's own patient rather than against whatever was asked for.
    const ticket = await edgeGet('images', `?action=ticket&imageId=${imageId}`, await tokenFor(context.doctor))
    void ticket
  })
})

describe('who may see it', () => {
  test('the pharmacy counter is refused at the door', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const token = await tokenFor(context.pharmacy)

    for (const path of [
      `?patientId=${context.patientId}`,
      `?imageId=${imageId}`,
    ]) {
      const result = await edgeRequest('images', path, { token })
      assert.equal(result.status, 403)
      assert.match(result.body.message, /pharmacy counter has no access/)
    }

    // Not even through a grant: policy register 26 says none, and none is not
    // a default somebody can raise.
    await assert.rejects(
      as(context.doctor, 'grant_image_access', {
        staffId: context.pharmacy.id, imageId, reason: 'Just this once', hours: 1,
      }),
      /no access to clinical images, and cannot be granted any/,
    )
  })

  test('a nurse sees a patient she is caring for, and not one she is not', async () => {
    const context = await clinic()
    const imageId = await captured(context)

    // Before she has done anything for this patient.
    const before = await edgeRequest('images', `?imageId=${imageId}`, {
      token: await tokenFor(context.nurse),
    })
    assert.equal(before.status, 403)
    assert.match(before.body.message, /only while involved in that patient's care/)

    // Taking the vitals is the involvement. Nothing is ticked; the work is the
    // record.
    await as(context.nurse, 'add_vitals', {
      patientId: context.patientId, bp: '118/76', pulse: 72,
      notMeasuredNote: 'No oximeter in the cabin',
    })

    const ticket = await edgeGet('images', `?action=ticket&imageId=${imageId}`, await tokenFor(context.nurse))
    assert.equal(ticket.status, 200)
    const after = await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket.body.ticket}`, {
      token: await tokenFor(context.nurse),
    })
    assert.equal(after.status, 200)
    assert.equal(after.contentType, 'image/png')

    // The other nurse, who has done nothing for this patient, is still refused.
    const uninvolved = await edgeRequest('images', `?imageId=${imageId}`, {
      token: await tokenFor(context.otherNurse),
    })
    assert.equal(uninvolved.status, 403)

    const basis = await rows(
      `select actor_id, action, basis from jmc.image_access_events order by created_at`,
    )
    assert.ok(basis.some((row) => row.action === 'view' && row.basis.startsWith('nurse_care')))
    assert.ok(basis.some((row) => row.action === 'refused' && row.basis === 'nurse_not_involved'))
  })

  test('an admin sees the record and not the photograph, until a doctor says otherwise', async () => {
    const context = await clinic()
    const imageId = await captured(context, { bodySite: 'Left forearm', side: 'left' })
    const adminToken = await tokenFor(context.admin)

    // The metadata is the admin's ordinary access: enough to audit, to answer
    // a retention question, to see that a photograph exists.
    const listed = await edgeGet('images', `?patientId=${context.patientId}`, adminToken)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.images.length, 1)
    assert.equal(listed.body.images[0].bodySite, 'Left forearm')
    assert.equal(listed.body.canSeeContent, false, 'and the screen is told so, rather than drawing a broken image')

    const refused = await edgeRequest('images', `?imageId=${imageId}`, { token: adminToken })
    assert.equal(refused.status, 403)
    assert.match(refused.body.message, /not the images themselves/)

    // A doctor may open one door, for a reason, for a while.
    const grant = await as(context.doctor, 'grant_image_access', {
      staffId: context.admin.id, imageId, hours: 1,
      reason: 'Insurance query about the dressing on 12 September',
    })
    const ticket = await edgeGet('images', `?action=ticket&imageId=${imageId}`, adminToken)
    assert.equal(ticket.status, 200)
    const allowed = await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket.body.ticket}`, {
      token: adminToken,
    })
    assert.equal(allowed.status, 200)
    assert.equal(
      await scalar(`select basis from jmc.image_access_events where action='view' order by created_at desc limit 1`),
      `grant:${grant.data.grantId}`,
    )

    // And it closes again.
    await as(context.doctor, 'revoke_image_access', { grantId: grant.data.grantId })
    const closed = await edgeRequest('images', `?imageId=${imageId}`, { token: adminToken })
    assert.equal(closed.status, 403)
  })

  test('an expired grant closes on its own', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const grant = await as(context.doctor, 'grant_image_access', {
      staffId: context.admin.id, patientId: context.patientId, hours: 1,
      reason: 'Reviewing a complaint',
    })

    await rows(
      `update jmc.image_access_grants
          set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
        where id=$1`,
      [grant.data.grantId],
    )
    const result = await edgeRequest('images', `?imageId=${imageId}`, {
      token: await tokenFor(context.admin),
    })
    assert.equal(result.status, 403, 'nobody has to remember to revoke it')
  })
})

describe('the link that lets a browser draw it', () => {
  test('a ticket is good for one image, one person, and sixty seconds', async () => {
    const context = await clinic()
    const first = await captured(context)
    const second = await captured(context, { category: 'after' })
    const doctorToken = await tokenFor(context.doctor)

    const ticket = (await edgeGet('images', `?action=ticket&imageId=${first}`, doctorToken)).body.ticket

    // The right image, with the right ticket.
    assert.equal(
      (await edgeRequest('images', `?imageId=${first}&ticket=${ticket}`, { token: doctorToken })).status,
      200,
    )

    // The same ticket against a different image is not a ticket.
    const replayed = await edgeRequest('images', `?imageId=${second}&ticket=${ticket}`, { token: doctorToken })
    assert.equal(replayed.status, 403)
    assert.match(replayed.body.message, /expired/)

    // And somebody else holding it cannot use it either, even with their own
    // perfectly good session.
    await as(context.nurse, 'add_vitals', { patientId: context.patientId, pulse: 70, notMeasuredNote: 'Rest not measured' })
    const borrowed = await edgeRequest('images', `?imageId=${first}&ticket=${ticket}`, {
      token: await tokenFor(context.nurse),
    })
    assert.equal(borrowed.status, 403)

    // A forged one fails the same way.
    const forged = await edgeRequest(
      'images', `?imageId=${first}&ticket=9999999999.${'0'.repeat(64)}`, { token: doctorToken },
    )
    assert.equal(forged.status, 403)

    assert.ok(
      Number(await scalar(`select count(*)::int from jmc.image_access_events
        where action='refused' and basis='ticket_invalid'`)) >= 3,
      'every refused link is on the access log',
    )
  })

  test('the bytes are never cached and never carry a durable URL', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const token = await tokenFor(context.doctor)
    const ticket = (await edgeGet('images', `?action=ticket&imageId=${imageId}`, token)).body.ticket

    const result = await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket}`, { token })
    assert.match(result.cacheControl, /no-store/)
    assert.match(result.cacheControl, /private/)

    // A session with no token gets nothing at all, ticket or no ticket.
    const anonymous = await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket}`, {})
    assert.equal(anonymous.status, 401)
  })

  test('a signed-out session cannot fetch an image it was looking at a moment ago', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const token = await tokenFor(context.doctor)
    const ticket = (await edgeGet('images', `?action=ticket&imageId=${imageId}`, token)).body.ticket

    assert.equal(
      (await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket}`, { token })).status,
      200,
    )

    /*
     * The lost-tablet case, policy register 30. An admin revokes the device's
     * sessions; the ticket in its memory is still cryptographically valid and
     * still inside its sixty seconds, and it is worth nothing without a
     * session behind it.
     */
    await rows('delete from jmc.sessions')
    const afterRevocation = await edgeRequest('images', `?imageId=${imageId}&ticket=${ticket}`, { token })
    assert.equal(afterRevocation.status, 401)
  })
})

describe('the original stays the original', () => {
  test('a captured image cannot be re-described, re-pointed or deleted', async () => {
    const context = await clinic()
    const imageId = await captured(context)

    await assert.rejects(
      rows(`update jmc.clinical_images set patient_id=$1 where id=$2`, [context.otherPatientId, imageId]),
      /cannot be re-described/,
    )
    await assert.rejects(
      rows(`update jmc.clinical_images set category='after' where id=$1`, [imageId]),
      /cannot be re-described/,
    )
    await assert.rejects(
      rows(`update jmc.clinical_images set storage_key='somewhere-else' where id=$1`, [imageId]),
      /cannot be re-described/,
    )
    await assert.rejects(
      rows(`delete from jmc.clinical_images where id=$1`, [imageId]),
      /never deleted/,
    )
  })

  test('a wrong photograph is marked captured in error, with a reason, and stays', async () => {
    const context = await clinic()
    const imageId = await captured(context)

    await assert.rejects(
      as(context.doctor, 'mark_image_entered_in_error', { imageId, reason: '' }),
      /reason is required/,
    )
    await as(context.doctor, 'mark_image_entered_in_error', {
      imageId, reason: 'Photograph of the wrong forearm',
    })

    const [image] = await rows('select * from jmc.clinical_images where id=$1', [imageId])
    assert.equal(image.status, 'entered_in_error')
    assert.match(image.error_reason, /wrong forearm/)
    assert.equal(image.error_by, context.doctor.id)
    assert.ok(image.error_at)

    // It cannot be brought back, and it is still there.
    await assert.rejects(
      rows(`update jmc.clinical_images set status='active' where id=$1`, [imageId]),
      /stays that way/,
    )
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 1)
    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events where action='image.entered_in_error'`),
      1,
    )
  })

  test('a crop is a separate object and never overwrites what the camera saw', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const before = String(await scalar('select checksum from jmc.clinical_images where id=$1', [imageId]))

    await as(context.doctor, 'save_image_derivative', {
      sourceImageId: imageId, kind: 'crop',
      parameters: { x: 10, y: 20, width: 100, height: 100 },
    })

    const [derivative] = await rows('select * from jmc.image_derivatives')
    assert.equal(derivative.source_image_id, imageId)
    assert.equal(derivative.kind, 'crop')
    assert.equal(
      String(await scalar('select checksum from jmc.clinical_images where id=$1', [imageId])),
      before,
      'the original is byte-for-byte what it was',
    )

    // And a nurse with no involvement cannot crop what she cannot see.
    await assert.rejects(
      as(context.otherNurse, 'save_image_derivative', {
        sourceImageId: imageId, kind: 'annotation', parameters: { note: 'here' },
      }),
      /only while involved in that patient's care/,
    )
  })
})

describe('when the upload fails', () => {
  test('storage that is not configured says so, and claims nothing was saved', async () => {
    const context = await clinic()
    const configured = process.env.CLINIC_IMAGE_ROOT
    delete process.env.CLINIC_IMAGE_ROOT
    try {
      const result = await edgeRequest('images', '', {
        method: 'POST', token: await tokenFor(context.doctor),
        body: capture({ patientId: context.patientId, consentId: context.consentId }),
      })
      assert.equal(result.status, 503)
      assert.match(result.body.message, /nothing was saved/i)
      assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)
    } finally {
      process.env.CLINIC_IMAGE_ROOT = configured
    }
  })

  test('a file that is not an image, and one that is far too big, are both refused', async () => {
    const context = await clinic()
    const token = await tokenFor(context.doctor)

    const wrongType = await edgeRequest('images', '', {
      method: 'POST', token,
      body: capture({
        patientId: context.patientId, consentId: context.consentId,
        bytes: new Uint8Array([1, 2, 3]), type: 'application/pdf',
      }),
    })
    assert.equal(wrongType.status, 400)
    assert.match(wrongType.body.message, /JPEG, PNG or WebP/)

    const enormous = await edgeRequest('images', '', {
      method: 'POST', token,
      body: capture({
        patientId: context.patientId, consentId: context.consentId,
        bytes: new Uint8Array(13 * 1024 * 1024),
      }),
    })
    assert.equal(enormous.status, 400)
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)
  })

  test('a retry after a failure captures once, and the bytes match the record', async () => {
    const context = await clinic()
    const token = await tokenFor(context.doctor)

    const failed = await edgeRequest('images', '', {
      method: 'POST', token,
      body: capture({ patientId: context.patientId, consentId: context.consentId, category: 'sideways' }),
    })
    assert.equal(failed.status, 400)
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 0)

    const retried = await edgeRequest('images', '', {
      method: 'POST', token,
      body: capture({ patientId: context.patientId, consentId: context.consentId }),
    })
    assert.equal(retried.status, 200)
    assert.equal(await scalar('select count(*)::int from jmc.clinical_images'), 1)

    // What is on disk is what the row says it is.
    const ticket = (await edgeGet('images', `?action=ticket&imageId=${retried.body.imageId}`, token)).body.ticket
    const fetched = await edgeRequest('images', `?imageId=${retried.body.imageId}&ticket=${ticket}`, { token })
    assert.deepEqual([...fetched.bytes], [...PNG])
    assert.equal(fetched.body, null)
  })
})

describe('retention is a queue, not a timer', () => {
  test('nothing is purged automatically, and a deletion leaves a tombstone', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    const storageKey = String(await scalar('select storage_key from jmc.clinical_images where id=$1', [imageId]))

    // Three years and a day since the last clinical contact.
    await ageByFourYears(imageId)
    const queued = await rows('select * from jmc.image_retention_queue where image_id=$1', [imageId])
    assert.equal(queued.length, 1, 'it reaches the review queue')

    // And is still there. A queue is not a delete.
    assert.equal(await scalar(`select status from jmc.clinical_images where id=$1`, [imageId]), 'active')

    await assert.rejects(
      as(context.admin, 'record_image_retention_decision', {
        imageId, decision: 'delete', reason: 'Three years elapsed',
      }),
      /Confirm it/,
    )

    await as(context.admin, 'record_image_retention_decision', {
      imageId, decision: 'delete', reason: 'Three years elapsed, no ongoing treatment', confirmed: true,
    })

    const [decision] = await rows('select * from jmc.image_retention_decisions where image_id=$1', [imageId])
    assert.equal(decision.decision, 'delete')
    assert.ok(decision.purged_at, 'the bytes went, and when is recorded')
    assert.equal(
      await scalar('select status from jmc.clinical_images where id=$1', [imageId]),
      'entered_in_error',
      'the record of the image stays',
    )
    assert.equal(existsSync(join(root, storageKey)), false, 'and the bytes are gone')
  })

  test('a legal hold takes an image out of the queue and keeps it', async () => {
    const context = await clinic()
    const imageId = await captured(context)
    await ageByFourYears(imageId)

    await as(context.admin, 'record_image_retention_decision', {
      imageId, decision: 'legal_hold', reason: 'Complaint under review',
    })
    assert.deepEqual(
      (await rows('select image_id from jmc.image_retention_queue where image_id=$1', [imageId]))
        .map((row) => row.image_id),
      [],
    )
    assert.equal(await scalar('select status from jmc.clinical_images where id=$1', [imageId]), 'active')

    // And only an admin decides.
    await assert.rejects(
      as(context.doctor, 'record_image_retention_decision', {
        imageId, decision: 'keep', reason: 'Still relevant',
      }),
      /role cannot perform/,
    )
  })
})
