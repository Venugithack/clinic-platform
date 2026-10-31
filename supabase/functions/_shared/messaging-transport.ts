/**
 * The seam between what the clinic decided and what carried it.
 *
 * These three types were declared inside `messaging.ts` in Slice 3A, where
 * they were the only thing that needed them. Slice 3B adds a real adapter, and
 * an adapter that imports the state machine to reach a type — while the state
 * machine imports the adapter to reach its channel — is a cycle. So the
 * vocabulary moves down here, to a leaf module that imports nothing, and
 * `messaging.ts` re-exports every name it used to export. Nothing that
 * referred to them has to know.
 *
 * The rule this file exists to hold is the one in the Slice 3A commit message:
 * **accepting a message is not delivering one.** `TransportResult`'s success
 * case cannot say `delivered` — the strongest thing it can say is which of
 * Meta's three acceptance words came back — and only the statuses webhook,
 * through `applyProviderEvidence`, can produce delivery.
 */

/**
 * The categories a failed provider call can fall into.
 *
 * Deliberately the clinic's words rather than Meta's numbers: the same column
 * has to describe a transport that never connected and a provider that refused
 * politely, and a screen in the clinic has to say which. The mapping from
 * Meta's documented error codes lives in `whatsapp-cloud.ts`.
 */
export type TransportFailure =
  | 'rate_limited' | 'provider_unavailable' | 'invalid_recipient'
  | 'template_rejected' | 'not_authorized' | 'transport_error' | 'unknown'

export type TransportResult =
  | {
    ok: true
    providerReference: string
    acceptStatus: 'accepted' | 'held_for_quality_assessment' | 'paused'
  }
  | {
    ok: false
    category: TransportFailure
    detail: string
    terminal: boolean
    /**
     * The call may have reached Meta, and its answer did not reach us.
     *
     * This is not a third kind of failure — it is the admission that this is
     * not known to be a failure at all. A timeout, a dropped connection and a
     * 2xx with no message identifier are all of them a message that may be on
     * its way to a patient right now.
     *
     * The worker does not treat it as a failure for that reason: the message
     * stays `outcome_unknown` and no attempt is scheduled, because
     * `POST /messages` has **no documented idempotency mechanism** and asking
     * again is how one reminder becomes two. Only the statuses webhook, which
     * can find the message through the `biz_opaque_callback_data` the clinic
     * sent, is allowed to settle it.
     */
    ambiguous?: boolean
  }

/**
 * What the durable state machine is allowed to know about the thing that
 * carries a message.
 *
 * Four fields and two methods, and nothing Meta-shaped anywhere in it. That is
 * what lets every test in this repository run against a transport that cannot
 * leave the machine, and what would let the clinic change provider without
 * touching a single rule about consent, quiet hours or retries.
 */
export interface MessageChannel {
  /** Recorded on every attempt, so the evidence says what carried it. */
  readonly name: string
  /**
   * Whether the official channel is available and approved. Owner item 76:
   * when it is not, the send is suppressed into a staff queue rather than
   * attempted.
   */
  configured(): boolean
  send(request: ChannelSendRequest): Promise<TransportResult>
}

export type ChannelSendRequest = {
  to: string
  /**
   * The wording the clinic believes it is sending.
   *
   * Meta renders the patient's copy from the approved template and the
   * variables below, so this is not what goes on the wire — it is what the
   * clinic recorded at queue time and what a staff member is shown when they
   * ask what was sent. The two are the same sentence when the approved
   * template and the clinic's own body agree, and proving they agree is a
   * release gate rather than something this code can check.
   */
  body: string
  templateName: string
  templateLanguage: string
  /** Ordered as the placeholders appear in the approved body. */
  variables: { name: string; value: string }[]
  idempotencyKey: string
}
