/**
 * Who may read what, written down once.
 *
 * ── WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO ─────────────
 *
 * Authorization in this application is code, and there is nothing behind it.
 * The `jmc` schema is granted to nobody and has no row-level policy, so an
 * Edge Function that forgets its role check is a hole with no second line
 * (`docs/SCHEMA_AND_TYPES.md` §7.3). That posture is deliberate. What grew up
 * underneath it is not: role decisions are made in four independent places —
 * eighty-odd inline `requireRole` calls, a hand-written `hasRole` at the top of
 * each GET endpoint, the `REPORTS` table's `roles` field, and seven booleans in
 * `snapshot.ts` — and nothing derives any of them from any other. A capability
 * added to one and forgotten in another fails silently in the direction that
 * shows a screen data it should not have.
 *
 * This file is the one reviewable source for the capabilities Slice 1 ADDS. It
 * is used by the endpoint that enforces them and by the tests that prove every
 * role was tried against every one of them. It is not a rewrite of the four
 * mechanisms above: the backend programme's Slice 1 says in as many words not
 * to refactor eighty-five working operations for neatness, and a half-migrated
 * authorization layer is worse than a consistent old one. The drift is
 * recorded in `docs/reference/BACKEND_PROGRAMME_REGISTER.md` as its own
 * hardening decision, for somebody to take deliberately.
 *
 * ── THE RULE EVERY ENTRY HERE FOLLOWS ──────────────────────────────────────
 *
 * A new read model may not hand a role anything that role could not already
 * obtain. Every `roles` list below is copied from the gate that already
 * governs the same facts — `snapshot.ts`'s seven booleans, the `record`
 * endpoint's doctor-only clinical record, the `REPORTS` matrix, policy
 * register item 17's counter table — and the comment on each entry says which.
 * Where a role is absent, that is the existing boundary being preserved, not
 * an opinion formed here. Widening one is a policy change and belongs to the
 * owner, not to a slice that was asked for a faster way to read.
 */
import { hasRole } from './auth.ts'
import type { Role, SessionView } from './types.ts'

export type Capability = {
  /** The roles that may use it, and the existing gate that decided them. */
  readonly roles: readonly Role[]
  /** What it answers, in one line. */
  readonly purpose: string
  /** Which existing gate this list was copied from. */
  readonly mirrors: string
}

/**
 * Every capability Slice 1 adds, keyed by the name the endpoint routes on.
 *
 * `view.*` entries are the endpoint's own views. `list.*` entries are the
 * actionable work lists: each one is a count on the workload summary AND the
 * drill-down behind that count, which is why they hold one capability rather
 * than two — a count somebody may see and a list they may not is a count that
 * tells them something they cannot act on.
 */
export const CAPABILITIES = {
  'view.patient_search': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'Find a patient by name, phone, patient id or today’s token.',
    mirrors: 'snapshot.ts patients — careRegister and pharmacyCounter both already receive the register; what each is given back here is narrower.',
  },
  'view.patient_context': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'The compact band above a patient: who they are, where they are, what is outstanding.',
    mirrors: 'assembled section by section from the existing gates; see PATIENT_CONTEXT_SECTIONS.',
  },
  'view.workload': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'The actionable counts for the signed-in role, and nothing outside it.',
    mirrors: 'the union of the list.* entries the caller holds; an empty set is a valid answer.',
  },
  'view.visit_progress': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'Where one patient’s visit has reached, who owns the open stage, and how old it is.',
    mirrors: 'per-stage, the same gates as the facts behind each stage; a stage the caller may not read is withheld rather than omitted.',
  },
  'view.safe_exit': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'What is still unresolved before leaving this patient.',
    mirrors: 'the same per-stage gates as view.visit_progress.',
  },
  'view.outcome': {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'What committed under one idempotency key, for a tablet that lost the answer.',
    mirrors: 'the command that owns the key — a consultation key resolves only for a doctor, a counter key only for admin or pharmacy. It is NOT scoped to the staff member who sent it: any doctor can resolve any doctor\'s consultation key. Keys are random uuids so this is not fishable, and a role that may run the command may already read its result through the snapshot or a report.',
  },
  'view.eligible_equivalents': {
    roles: ['admin', 'pharmacy'],
    purpose: 'The in-stock products the backend can prove are the same clinical drug as a prescribed generic.',
    mirrors: 'dispense_rx is pharmacy-only, but an admin reviewing a refusal needs the same list; snapshot.ts pharmacyCounter.',
  },

  /*
   * Slice 2. Two calendar reads and one reconciliation read.
   *
   * The calendar pair mirrors `create_appointment`'s gate exactly — admin,
   * doctor, nurse — because a booking is the same fact as a queue row one day
   * earlier, and a role that may put somebody in today's queue is a role that
   * may see who is expected tomorrow. Pharmacy is absent for the reason
   * `PATIENT_CONTEXT_SECTIONS.arrival` gives: the counter has no queue station
   * and identifies a patient by name and prescription rather than by token.
   *
   * The reconciliation read is doctor-only and not by inheritance. It carries
   * what a consultation attempt signed, which is the clinical record, and the
   * decision it exists to inform — same attendance or new attendance — is
   * doctor-only in `resolve_consultation_attempt` for the same reason. A read
   * wider than the write it prepares would tell a nurse a consultation is
   * unresolved and give them nothing to do about it.
   */
  'view.appointment_calendar': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Who is expected on a day or a range, and the hours the doctor has published.',
    mirrors: "create_appointment gates on requireRole(admin, doctor, nurse) — a booking is a queue row a day early.",
  },
  'view.patient_appointments': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: "One patient’s appointments, with the append-only history of each.",
    mirrors: "the same gate as view.appointment_calendar; the bookings of one patient are no wider than the whole day.",
  },
  'view.consultation_reconciliation': {
    roles: ['doctor'],
    purpose: 'What one consultation attempt committed, which visits are open, and which resolutions are available.',
    mirrors: 'resolve_consultation_attempt is doctor-only (owner items 72-74), and this read carries the signed consultation it names.',
  },

  'list.today_queue': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Patients arrived and not yet finished.',
    mirrors: 'snapshot.ts careRegister — Queue.',
  },
  'list.vitals_missing': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Waiting patients with no reading recorded today.',
    mirrors: 'snapshot.ts careRegister — Vitals.',
  },
  'list.observation_due': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Occupied beds whose next check is due or overdue.',
    mirrors: 'snapshot.ts careRegister — Beds.',
  },
  'list.observation_handoff': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Beds where a nurse has asked for the doctor and nobody has answered.',
    mirrors: 'snapshot.ts careRegister — Beds. Resolving one is doctor-only (request_observation_handoff/resolve_observation_handoff); seeing one is not.',
  },
  'list.prescriptions_needs_review': {
    roles: ['admin', 'doctor'],
    purpose: 'Signed lines from before this system that do not record what they authorized.',
    mirrors: 'resolve_prescription_line is doctor-only; reports outstanding_prescriptions admits admin.',
  },
  'list.follow_ups_due': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Follow-ups open and due on or before today.',
    mirrors: 'reports/index.ts follow_ups — admin, doctor, nurse.',
  },
  'list.counter_waiting': {
    roles: ['admin', 'pharmacy'],
    purpose: 'Signed prescriptions with something still supplyable.',
    mirrors: 'snapshot.ts pharmacyCounter — Counter.',
  },
  'list.payments_due': {
    roles: ['admin', 'pharmacy'],
    purpose: 'Open bills with money still owed.',
    mirrors: 'snapshot.ts cashDrawer and policy register 17 — payment is admin and pharmacy.',
  },
  'list.financial_review': {
    roles: ['admin'],
    purpose: 'Bills that are over-refunded, or cancelled and not at zero.',
    mirrors: 'reports/index.ts financial_review — admin alone.',
  },
  'list.expiring_soon': {
    roles: ['admin', 'doctor', 'pharmacy'],
    purpose: 'Pickable stock inside the supplier’s return window, or already past it.',
    mirrors: 'snapshot.ts shelf — Inventory, Expiring.',
  },
  'list.stock_count_open': {
    roles: ['admin', 'pharmacy'],
    purpose: 'A count started and not yet approved or posted.',
    mirrors: 'snapshot.ts shelf/supplyNetwork — Stock-take and Opening count.',
  },

  /*
   * Slice 2. The two lists deliberately overlap: a booking thirty minutes past
   * its time is on both, because there are two things to do about it and they
   * belong to different moments. Check them in if they have walked in;
   * confirm the no-show if they have not. A list that removed the late ones
   * from `appointments_today` would take a patient who is merely late off the
   * screen of the person about to check them in.
   */
  'list.appointments_today': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Patients expected today who have not checked in, been cancelled, or been marked absent.',
    mirrors: "create_appointment gates on requireRole(admin, doctor, nurse); same audience as view.appointment_calendar.",
  },
  'list.no_show_review': {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Bookings past the half hour owner item 69 allows before a no-show may be confirmed.',
    mirrors: "mark_no_show gates on requireRole(admin, doctor, nurse) — owner item 69 names those three.",
  },
} as const satisfies Record<string, Capability>

export type CapabilityId = keyof typeof CAPABILITIES

/**
 * The sections a patient context is assembled from, each with its own gate.
 *
 * This is the field-level minimization, declared rather than implied. The
 * context endpoint builds only the sections the caller holds, and the
 * authorization test walks this table rather than a list somebody typed out a
 * second time beside it.
 */
export const PATIENT_CONTEXT_SECTIONS = {
  identity: {
    roles: ['admin', 'doctor', 'nurse', 'pharmacy'],
    purpose: 'Name, and the masked phone that tells two of the same name apart.',
    mirrors: 'snapshot.ts patients — every role that receives the register at all.',
  },
  demographics: {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Age and sex.',
    mirrors: 'snapshot.ts patients — careRegister gets age and sex; pharmacyCounter does not.',
  },
  arrival: {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'Today’s token, arrival time and queue status.',
    mirrors: 'the Queue workspace, which snapshot.ts gates with careRegister. Note that `appointments` is the one snapshot collection with NO boolean in front of it, so this is narrower than what the snapshot actually sends — deliberately, because a pharmacist has no queue station and the counter identifies a patient by name and prescription rather than by token.',
  },
  vitals: {
    roles: ['admin', 'doctor', 'nurse'],
    purpose: 'The latest reading and what was not measured.',
    mirrors: 'snapshot.ts vitals — careRegister.',
  },
  clinical_alerts: {
    roles: ['doctor'],
    purpose: 'Recorded allergy status, allergy notes and clinical flags.',
    mirrors: 'the record endpoint — doctor alone reads the clinical record, and this is part of it. A nurse does not receive it today; widening that is an owner decision, not this slice’s.',
  },
  /*
   * Deliberately its own entry, holding exactly the roles `clinical_alerts`
   * holds, and that is the point rather than a duplication to be tidied away.
   *
   * These are two different questions about a patient. "Is this person
   * allergic to penicillin?" is a clinical fact a nurse has a plain reason to
   * want, and the owner may one day decide they should have it. "Is there an
   * unsigned consultation draft, and was an encounter signed today?" is the
   * state of the doctor's own work, and nothing about widening the first
   * implies widening the second.
   *
   * The first version of the read models gated both on `clinical_alerts`,
   * because today the two lists are identical and one lookup was less code. It
   * would have worked exactly until somebody granted a nurse allergy access —
   * a small, reasonable, well-motivated change — and discovered afterwards
   * that it had also handed every nurse the doctor's draft status. A
   * capability named after the fact it protects cannot fail that way; one
   * borrowed from a neighbour can only fail that way silently.
   */
  consultation_progress: {
    roles: ['doctor'],
    purpose: 'Whether a consultation is drafted or signed for this patient today, and how old it is.',
    mirrors: 'snapshot.ts clinicalRecord and the record endpoint — `encounters` and `consultation_drafts` reach a screen for a doctor and for nobody else. Identical to clinical_alerts today and independent of it on purpose.',
  },
  supply: {
    roles: ['admin', 'pharmacy'],
    purpose: 'Whether a signed prescription is still waiting at the counter.',
    mirrors: 'snapshot.ts pharmacyCounter — prescriptions.',
  },
  money: {
    roles: ['admin', 'pharmacy'],
    purpose: 'What this patient owes.',
    mirrors: 'snapshot.ts cashDrawer and policy register 17 — a doctor does not collect and a nurse does not touch money.',
  },
} as const satisfies Record<string, Capability>

export type PatientContextSection = keyof typeof PATIENT_CONTEXT_SECTIONS

/**
 * Whether this session holds a capability.
 *
 * The `hasOwn` guard is not defensive tidiness. Callers reach this with an id
 * taken from a query string, and `CAPABILITIES['constructor']` resolves to
 * something inherited from Object.prototype rather than to undefined — so
 * without it, a typed word becomes `undefined.roles` and a refusal becomes a
 * crash. An id nobody declared is not held by anybody.
 */
export function mayUse(session: SessionView, id: CapabilityId): boolean {
  if (!Object.hasOwn(CAPABILITIES, id)) return false
  return hasRole(session, ...CAPABILITIES[id].roles)
}

/** Whether this session may read one section of a patient context. */
export function maySee(session: SessionView, section: PatientContextSection): boolean {
  // Guarded like `mayUse` above, and for the same reason rather than for
  // symmetry: every caller passes a literal today, and the day one of them
  // passes a name that came from a request, `PATIENT_CONTEXT_SECTIONS['toString']`
  // is a function rather than undefined and the guard is what stands between
  // that and a crash. A section nobody declared is held by nobody.
  if (!Object.hasOwn(PATIENT_CONTEXT_SECTIONS, section)) return false
  return hasRole(session, ...PATIENT_CONTEXT_SECTIONS[section].roles)
}

/** Every work list this session may both count and open. */
export function listsFor(session: SessionView): CapabilityId[] {
  return (Object.keys(CAPABILITIES) as CapabilityId[])
    .filter((id) => id.startsWith('list.') && mayUse(session, id))
}
