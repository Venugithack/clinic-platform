/**
 * The two questions the result station answers about the authoritative record.
 *
 * They are here, in a file with no React in it, for one reason: they are the
 * clinical decisions in the cutover — whether a patient is still owed
 * something, and whether an act that got no reply actually committed — and a
 * decision like that should be walkable by a unit test rather than only
 * reachable by driving a browser for seven minutes. Both defects an
 * independent review found in this cutover were in these twenty lines.
 *
 * Pure. No storage, no fetch, no component. Given a freshly read
 * `view.investigation_order`, they say what it means.
 */
import type { InvestigationOrderView, ResultView } from '@/lib/types'
import type { RecoveryAction } from '@/lib/result-recovery'

/** One result in a freshly read order, for the settle checks below. */
export function resultIn(order: InvestigationOrderView, resultId: string): ResultView | null {
  for (const item of order.items) {
    const found = item.results.find((candidate) => candidate.resultId === resultId)
    if (found) return found
  }
  return null
}

/**
 * Is there unfinished follow-up on this result?
 *
 * Asked of the authoritative read and of nothing else. Two shapes count:
 *
 *   the doctor concluded the patient should be informed, and neither a notice
 *   nor a call has been recorded;
 *
 *   the result is critical, which owner item 88 says is a telephone call, and
 *   no call has been recorded.
 *
 * Everything else is finished as far as this station is concerned. A result
 * whose review closed the line owes nobody anything, and a corrected report
 * owes its successor rather than itself.
 */
export function resultFollowUpOwed(result: ResultView | null | undefined): boolean {
  if (!result || !result.current) return false
  if (!result.review) return false
  if (result.patientContactedAt) return false

  if ((result.flag ?? 'none') === 'critical') return true
  if (result.review.conclusion !== 'patient_to_be_informed') return false
  return result.notificationAuthorizedAt === ''
}

/**
 * What the authoritative read says about one act that may or may not have
 * landed.
 *
 * The evidence is the act's own: a review row, a flag, an acknowledgement, a
 * delegation, an authorization stamp, a recorded call. `null` when the result
 * has gone from the order entirely, which a correction does.
 */
export function recoveryCommitted(
  order: InvestigationOrderView,
  resultId: string,
  action: RecoveryAction,
  /**
   * For `delegate` only: the NAME of the doctor the attempt named.
   *
   * A name because that is all the contract gives: `view.investigation_order`
   * returns `delegatedDoctor` as a display name with no staff id beside it,
   * so a client cannot prove which doctor a delegation landed on. Recorded as
   * a read-contract defect in `SLICE4_FRONTEND_CONTRACT.md` §10 rather than
   * fixed by widening the view, which this cutover may not do.
   */
  targetName?: string,
): boolean | null {
  const result = resultIn(order, resultId)
  /*
   * A corrected report does NOT leave the order — `readResultsForItem` has no
   * superseded filter and returns every result on the item, newest first — so
   * "gone" has to be asked as "no longer the current one". Reading it as
   * absence left this branch unreachable and told a doctor holding an
   * unsettled attempt on a superseded report that they could do it again.
   */
  if (!result || !result.current) return null
  switch (action) {
    case 'acknowledge':
      return result.criticalAcknowledgedAt !== ''
    case 'flag':
      return (result.doctorFlag ?? 'none') !== 'none'
    case 'delegate':
      /*
       * Delegation is the one act whose field may already be full before the
       * attempt: an order delegated to Dr A and then re-delegated to Dr C.
       * "Somebody is delegated" would say the second one landed when it did
       * not, so the evidence is the doctor this attempt actually named.
       */
      return targetName
        ? order.delegatedDoctor === targetName
        : order.delegatedDoctor !== ''
    case 'review':
      return result.review !== null
    case 'authorize':
      return result.notificationAuthorizedAt !== ''
    case 'contact':
      return result.patientContactedAt !== ''
  }
}
