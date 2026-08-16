/**
 * The counter-query transitions. PLAN.md §5.3 rule 2.
 *
 * Thin, like the rest of lib/transitions. In particular the equivalence rule —
 * same salt, same strength, same form — is NOT re-checked here. It lives in
 * app.raise_counter_query and app.answer_counter_query, on both ends of the
 * loop, because a second copy in TypeScript is a second opinion that will
 * eventually disagree with the one that actually decides.
 */
import { appSchema } from '@/lib/db';
import type { CounterQueryDecision, CounterQueryKind } from '@/lib/db/pharmacy';
import { toTransitionError } from './errors';

export interface CounterQuery {
  id: string;
  prescription_id: string;
  drug_id: string;
  kind: CounterQueryKind;
  status: 'open' | 'answered' | 'withdrawn';
}

/** The counter asks. It never decides. */
export async function raiseCounterQuery(input: {
  prescriptionId: string;
  drugId: string;
  kind: CounterQueryKind;
  proposedDrugId?: string;
  note?: string;
}): Promise<CounterQuery> {
  const { data, error } = await appSchema().rpc('raise_counter_query', {
    p_prescription_id: input.prescriptionId,
    p_drug_id: input.drugId,
    p_kind: input.kind,
    p_proposed_drug_id: input.proposedDrugId ?? null,
    p_note: input.note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as CounterQuery;
}

/**
 * The doctor decides, and only the prescribing one.
 *
 * `approved` on a substitution takes the drug the counter proposed; `amended`
 * names a different one; `rejected` leaves the original line standing.
 */
export async function answerCounterQuery(input: {
  queryId: string;
  decision: CounterQueryDecision;
  approvedDrugId?: string;
  note?: string;
}): Promise<CounterQuery> {
  const { data, error } = await appSchema().rpc('answer_counter_query', {
    p_query_id: input.queryId,
    p_decision: input.decision,
    p_approved_drug_id: input.approvedDrugId ?? null,
    p_note: input.note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as CounterQuery;
}

/** Found the box after all. Withdrawn, not deleted — the doctor may have read it. */
export async function withdrawCounterQuery(
  queryId: string,
  note?: string,
): Promise<CounterQuery> {
  const { data, error } = await appSchema().rpc('withdraw_counter_query', {
    p_query_id: queryId,
    p_note: note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as CounterQuery;
}
