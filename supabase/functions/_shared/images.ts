/**
 * Who may see a clinical photograph, and everything that is recorded when they do.
 *
 * The authorization rule lives here, in one function, because it is asked from
 * three places — the metadata list, the bytes endpoint and the export — and a
 * rule written three times is a rule that will differ in one of them.
 *
 * Policy register 26, in full:
 *
 *   DOCTOR       full clinical access.
 *   NURSE        capture and view only WHILE INVOLVED in that patient's care.
 *                Involvement is derived from work the nurse actually did —
 *                vitals taken, an observation entered, a visit booked — not
 *                from a box somebody ticked.
 *   PHARMACIST   none. Not narrowed: none.
 *   ADMIN        the metadata and the audit. Image content only through an
 *                explicit grant from a doctor, with a reason and an expiry.
 *
 * Every answer, including every refusal, is written to `image_access_events`.
 * A refusal nobody records is a refusal nobody can count, and the interesting
 * number in an access log is how often somebody was turned away.
 */
import { randomUUID } from 'node:crypto'
import { audit, db, transaction } from './db.ts'
import type { SessionView } from './types.ts'
import { hasRole } from './auth.ts'
import {
  booleanValue, optional, requireChoice, requireRole, value, type Payload,
} from './command-input.ts'
import { deleteObject } from './storage.ts'

export type ImageRow = {
  id: string
  patient_id: string
  encounter_id: string | null
  status: string
  storage_key: string
  content_type: string
  captured_by: string
}

export type AccessDecision =
  | { allowed: true; basis: string }
  | { allowed: false; basis: string; message: string }

/**
 * May this person see the content of this image?
 *
 * `content` false asks the weaker question — may they see that it exists, its
 * category, its body site and its audit trail — which is what an admin gets
 * and what a report is built from.
 */
export async function mayAccessImage(
  session: SessionView,
  image: Pick<ImageRow, 'id' | 'patient_id'>,
  { content = true }: { content?: boolean } = {},
): Promise<AccessDecision> {
  if (hasRole(session, 'pharmacy') && !hasRole(session, 'admin', 'doctor', 'nurse')) {
    return {
      allowed: false,
      basis: 'pharmacy',
      message: 'The pharmacy counter has no access to clinical images.',
    }
  }

  if (hasRole(session, 'doctor')) return { allowed: true, basis: 'doctor' }

  if (hasRole(session, 'nurse')) {
    const involved = await db.prepare(
      `select involvement from nurse_care_involvement
        where nurse_id=? and patient_id=? order by since desc limit 1`,
    ).get(session.staffId, image.patient_id) as { involvement: string } | undefined
    if (involved) return { allowed: true, basis: `nurse_care:${involved.involvement}` }
    return {
      allowed: false,
      basis: 'nurse_not_involved',
      message:
        'A nurse may see a patient\'s images only while involved in that patient\'s care. ' +
        'Record the vitals or the observation you are here for, or ask the doctor.',
    }
  }

  if (hasRole(session, 'admin')) {
    // Metadata and audit are the admin's ordinary access; the content is not.
    if (!content) return { allowed: true, basis: 'admin_metadata' }

    const grant = await db.prepare(
      `select id, reason from image_access_grants
        where staff_id=? and revoked_at is null and expires_at > now()
          and (image_id=? or patient_id=?)
        order by expires_at desc limit 1`,
    ).get(session.staffId, image.id, image.patient_id) as { id: string; reason: string } | undefined
    if (grant) return { allowed: true, basis: `grant:${grant.id}` }

    return {
      allowed: false,
      basis: 'admin_no_grant',
      message:
        'An admin sees image records and their audit trail, not the images themselves. ' +
        'A doctor can grant access for a named reason and a fixed time.',
    }
  }

  return { allowed: false, basis: 'no_role', message: 'Your role cannot see clinical images.' }
}

/** Every answer is recorded, including the refusals. */
export async function recordImageAccess(
  imageId: string,
  actorId: string,
  action: 'view' | 'thumbnail' | 'export' | 'print' | 'refused',
  basis: string,
): Promise<void> {
  await db.prepare(
    `insert into image_access_events (id,image_id,actor_id,action,basis,created_at)
     values (?,?,?,?,?,now())`,
  ).run(randomUUID(), imageId, actorId, action, basis)
}

// ═══════════════════════════════════════════════════════════════════════════

export async function runImageCommand(session: SessionView, action: string, payload: Payload) {
  switch (action) {
    /*
     * Consent, recorded before anything is photographed.
     *
     * Policy register 27. The consenting person is named because it is not
     * always the patient — a child's parent, an adult's guardian — and the
     * purpose is narrow because "for the clinic's use" is not a consent to
     * anything in particular.
     */
    case 'record_image_consent': {
      requireRole(session, 'doctor', 'nurse')
      const patientId = value(payload, 'patientId')
      const id = randomUUID()

      await transaction(async () => {
        const patient = await db.prepare('select id,name from patients where id=?')
          .get(patientId) as { id: string; name: string } | undefined
        if (!patient) throw new Error('That patient was not found.')

        await db.prepare(
          `insert into image_consents
            (id,patient_id,consenting_person,relationship,method,purpose,recorded_by,recorded_at)
           values (?,?,?,?,?,?,?,now())`,
        ).run(
          id, patientId,
          value(payload, 'consentingPerson'),
          requireChoice(payload, 'relationship', ['self', 'parent', 'guardian', 'spouse', 'other'] as const, 'self'),
          requireChoice(payload, 'method', ['verbal', 'written', 'digital'] as const),
          value(payload, 'purpose'),
          session.staffId,
        )
        await audit(session.staffId, 'image.consent_recorded', 'patient', patientId,
          `Consent for clinical photographs from ${value(payload, 'consentingPerson')}: ${value(payload, 'purpose')}`)
      })
      return { message: 'Consent recorded. Photographs may now be taken for this purpose.', data: { consentId: id } }
    }

    case 'withdraw_image_consent': {
      requireRole(session, 'doctor', 'nurse')
      const consentId = value(payload, 'consentId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const consent = await db.prepare(
          'select id,patient_id,withdrawn_at from image_consents where id=? for update',
        ).get(consentId) as { id: string; patient_id: string; withdrawn_at: string | null } | undefined
        if (!consent) throw new Error('That consent record was not found.')
        if (consent.withdrawn_at) throw new Error('That consent is already withdrawn.')

        await db.prepare(
          `update image_consents set withdrawn_at=now(), withdrawn_by=?, withdrawal_reason=? where id=?`,
        ).run(session.staffId, reason, consentId)
        await audit(session.staffId, 'image.consent_withdrawn', 'patient', consent.patient_id,
          `Consent for clinical photographs withdrawn: ${reason}`)
      })
      return {
        message:
          'Consent withdrawn. No further photographs may be taken under it, and nothing may be exported. ' +
          'Images already captured stay on the clinical record.',
      }
    }

    /*
     * The wrong photograph.
     *
     * Policy register 29: never silently altered or deleted. It is marked
     * Captured in error with an actor, a time and a reason, and it stays —
     * because a photograph that vanishes from a record is indistinguishable
     * from one that was never taken, and the fact that a mistake was made is
     * itself clinical information.
     */
    case 'mark_image_entered_in_error': {
      requireRole(session, 'doctor', 'nurse')
      const imageId = value(payload, 'imageId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const image = await db.prepare(
          'select id,patient_id,status,category from clinical_images where id=? for update',
        ).get(imageId) as ImageRow & { category: string } | undefined
        if (!image) throw new Error('That image was not found.')
        if (image.status === 'entered_in_error') throw new Error('That image is already marked as captured in error.')

        const decision = await mayAccessImage(session, image)
        if (!decision.allowed) {
          await recordImageAccess(imageId, session.staffId, 'refused', decision.basis)
          throw new Error(decision.message)
        }

        await db.prepare(
          `update clinical_images set status='entered_in_error', error_reason=?, error_by=?, error_at=now()
            where id=?`,
        ).run(reason, session.staffId, imageId)
        await audit(session.staffId, 'image.entered_in_error', 'clinical_image', imageId,
          `${image.category} image marked captured in error: ${reason}`)
      })
      return {
        message: 'Marked as captured in error. It stays on the record, and no longer counts as a clinical image.',
      }
    }

    /*
     * A doctor letting an admin see one.
     *
     * Narrow by construction: one image or one patient, a reason, and an
     * expiry that arrives on its own rather than depending on somebody
     * remembering to revoke it.
     */
    case 'grant_image_access': {
      requireRole(session, 'doctor')
      const staffId = value(payload, 'staffId')
      const reason = value(payload, 'reason')
      const imageId = optional(payload, 'imageId')
      const patientId = optional(payload, 'patientId')
      const hours = Number(payload.hours ?? 24)

      if ((imageId === '') === (patientId === '')) {
        throw new Error('Grant access to one image or to one patient, not to both and not to neither.')
      }
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) {
        throw new Error('A grant lasts between one hour and a fortnight.')
      }

      const id = randomUUID()
      await transaction(async () => {
        const staff = await db.prepare('select id,name,roles_json from staff where id=? and active=1')
          .get(staffId) as { id: string; name: string; roles_json: string } | undefined
        if (!staff) throw new Error('That staff member was not found.')
        if (staff.roles_json.includes('"pharmacy"') && !staff.roles_json.includes('"admin"')) {
          throw new Error('The pharmacy counter has no access to clinical images, and cannot be granted any.')
        }

        await db.prepare(
          `insert into image_access_grants
            (id,image_id,patient_id,staff_id,reason,granted_by,granted_at,expires_at)
           values (?,?,?,?,?,?,now(), now() + (? || ' hours')::interval)`,
        ).run(id, imageId || null, patientId || null, staffId, reason, session.staffId, String(hours))

        await audit(session.staffId, 'image.access_granted', 'staff', staffId,
          `${staff.name} may see ${imageId ? 'one image' : 'this patient\'s images'} for ${hours} hour(s): ${reason}`)
      })
      return { message: `Access granted for ${hours} hour(s). It expires on its own.`, data: { grantId: id } }
    }

    case 'revoke_image_access': {
      requireRole(session, 'admin', 'doctor')
      const grantId = value(payload, 'grantId')
      await transaction(async () => {
        const result = await db.prepare(
          `update image_access_grants set revoked_at=now(), revoked_by=? where id=? and revoked_at is null`,
        ).run(session.staffId, grantId)
        if (Number(result.changes) !== 1) throw new Error('That grant is already revoked or does not exist.')
        await audit(session.staffId, 'image.access_revoked', 'image_access_grant', grantId, 'Image access revoked')
      })
      return { message: 'Access revoked.' }
    }

    /*
     * A crop or an annotation, beside the original.
     *
     * The parameters are stored as data so the derivative can be regenerated
     * from the original rather than being the only copy of somebody's reading
     * of it — and so that nothing anybody draws can ever be mistaken for what
     * the camera saw.
     */
    case 'save_image_derivative': {
      requireRole(session, 'doctor', 'nurse')
      const sourceImageId = value(payload, 'sourceImageId')
      const kind = requireChoice(payload, 'kind', ['crop', 'annotation', 'rotation'] as const)
      const parameters = payload.parameters
      if (!parameters || typeof parameters !== 'object') {
        throw new Error('A derivative records what was done to the image.')
      }

      const id = randomUUID()
      await transaction(async () => {
        const image = await db.prepare('select id,patient_id,status from clinical_images where id=?')
          .get(sourceImageId) as ImageRow | undefined
        if (!image) throw new Error('That image was not found.')
        if (image.status !== 'active') throw new Error('That image is marked captured in error.')

        const decision = await mayAccessImage(session, image)
        if (!decision.allowed) {
          await recordImageAccess(sourceImageId, session.staffId, 'refused', decision.basis)
          throw new Error(decision.message)
        }

        await db.prepare(
          `insert into image_derivatives (id,source_image_id,kind,parameters,created_by,created_at)
           values (?,?,?,?::text::jsonb,?,now())`,
        ).run(id, sourceImageId, kind, JSON.stringify(parameters), session.staffId)
        await audit(session.staffId, 'image.derivative_saved', 'clinical_image', sourceImageId,
          `${kind} saved beside the original`)
      })
      return { message: 'Saved beside the original. The original is untouched.', data: { derivativeId: id } }
    }

    /*
     * The retention boundary, reviewed rather than reached.
     *
     * Policy register 29: at three years an admin review queue appears and
     * nothing is purged automatically. A deletion here is a tombstone — the
     * row stays, the bytes go, and `purged_at` says when.
     */
    case 'record_image_retention_decision': {
      requireRole(session, 'admin')
      const imageId = value(payload, 'imageId')
      const decision = requireChoice(payload, 'decision', ['keep', 'delete', 'legal_hold'] as const)
      const reason = value(payload, 'reason')
      const confirmed = booleanValue(payload, 'confirmed')

      if (decision === 'delete' && !confirmed) {
        throw new Error(
          'Deleting the image removes the bytes for good. Confirm it, and the record of the image stays either way.',
        )
      }

      let storageKey = ''
      await transaction(async () => {
        const image = await db.prepare(
          'select id,patient_id,storage_key,status from clinical_images where id=? for update',
        ).get(imageId) as ImageRow | undefined
        if (!image) throw new Error('That image was not found.')
        storageKey = image.storage_key

        await db.prepare(
          `insert into image_retention_decisions
            (id,image_id,decision,reason,decided_by,decided_at,review_due_at)
           values (?,?,?,?,?,now(), case when ? then now() + interval '1 year' else null end)`,
        ).run(randomUUID(), imageId, decision, reason, session.staffId, decision !== 'delete')

        if (decision === 'delete') {
          await db.prepare(
            `update clinical_images set status='entered_in_error',
               error_reason=?, error_by=?, error_at=now()
             where id=? and status='active'`,
          ).run(`Retention: ${reason}`, session.staffId, imageId)
        }

        await audit(session.staffId, `image.retention_${decision}`, 'clinical_image', imageId,
          `Retention decision: ${decision} — ${reason}`)
      })

      if (decision === 'delete') {
        // Outside the transaction on purpose. Storage has no rollback, so the
        // record of the decision is committed first; a failed purge leaves a
        // decision with no `purged_at`, which is a queue entry rather than a
        // silent loss.
        await deleteObject(storageKey)
        await db.prepare(
          `update image_retention_decisions set purged_at=now()
            where image_id=? and decision='delete' and purged_at is null`,
        ).run(imageId)
      }

      return {
        message: decision === 'delete'
          ? 'Bytes removed. The record of the image, and this decision, stay.'
          : decision === 'legal_hold'
            ? 'Held. It will not appear in the retention queue again.'
            : 'Kept, and due for review again in a year.',
      }
    }

    default:
      throw new Error('Unknown action.')
  }
}
