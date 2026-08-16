'use client';

/**
 * The counter, asking. PLAN.md §11.1.
 *
 *   "Counter: Amoxicillin 500 out of stock. Substitute?"
 *   doctor approves / edits / rejects ──► counter continues
 *
 * The spec says the doctor answers "without leaving the consult screen". This
 * goes one better and rides above every clinic screen, because the doctor is
 * not reliably on the consult screen when the pharmacist reaches the shelf —
 * they may be three patients further on.
 *
 * A strip, not a modal (TABLET.md §2 rule 5). It pushes the screen down rather
 * than covering it: a dialog over a consult is a dead end on a tablet, and this
 * has to be answerable in the two seconds between patients.
 *
 * Nothing here is automatic. INVENTORY.md §7 puts the decision with the doctor,
 * and an amendment is still checked for equivalence by the transition.
 */
import { useCallback, useEffect, useState } from 'react';
import { openQueriesForDoctor, type OpenCounterQuery } from '@/lib/db/pharmacy';
import { equivalentDrugs, getDrug, stockBadge, type DrugRow } from '@/lib/db/drugs';
import { answerCounterQuery } from '@/lib/transitions/counter';
import { subscribe } from '@/lib/realtime';
import { currentSession } from '@/lib/auth';

export function CounterQueries() {
  const [queries, setQueries] = useState<OpenCounterQuery[]>([]);
  const [amending, setAmending] = useState<string | null>(null);
  const [options, setOptions] = useState<DrugRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = currentSession();
  const doctorId = session?.role === 'doctor' ? session.staffId : null;

  const refresh = useCallback(() => {
    if (!doctorId) return;
    void openQueriesForDoctor(doctorId)
      .then((rows) => {
        setQueries(rows);
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [doctorId]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!doctorId) return;
    const subscription = subscribe(['counter_queries'], refresh);
    return () => subscription.unsubscribe();
  }, [doctorId, refresh]);

  if (!doctorId || queries.length === 0) return null;

  const answer = async (
    queryId: string,
    decision: 'approved' | 'rejected' | 'amended',
    approvedDrugId?: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await answerCounterQuery({ queryId, decision, approvedDrugId });
      setAmending(null);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startAmending = async (query: OpenCounterQuery) => {
    setAmending(query.id);
    const drug = await getDrug(query.drug_id);
    setOptions(drug ? await equivalentDrugs(drug) : []);
  };

  return (
    <section
      aria-label="Questions from the counter"
      className="border-b-2 border-ink bg-ink/5 px-6 py-4"
    >
      {error ? <p className="mb-3 text-danger">{error}</p> : null}

      <ul className="space-y-4">
        {queries.map((query) => (
          <li key={query.id}>
            <div className="flex flex-wrap items-center gap-4">
              <p className="min-w-0 flex-1 text-lg">
                <span className="text-muted">Counter · {query.raised_by_name} · </span>
                {query.patient_name}:{' '}
                <strong>
                  {query.drug_name} {query.drug_strength}
                </strong>{' '}
                {query.kind === 'substitution' && query.proposed_name ? (
                  <>
                    out of stock — substitute{' '}
                    <strong>{query.proposed_name}</strong>?
                  </>
                ) : query.kind === 'out_of_stock' ? (
                  <>— not enough on the shelf.</>
                ) : (
                  <>— {query.note}</>
                )}
              </p>

              <div className="flex shrink-0 gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void answer(query.id, 'approved')}
                  className="h-14 rounded-xl border border-ink bg-ink px-5 font-medium text-white disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startAmending(query)}
                  className="h-14 rounded-xl border border-line bg-white px-5 disabled:opacity-40"
                >
                  Something else
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void answer(query.id, 'rejected')}
                  className="h-14 rounded-xl border border-danger bg-white px-5 text-danger disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            </div>

            {amending === query.id ? (
              <div className="mt-3 rounded-xl border border-line bg-white p-4">
                <p className="text-sm text-muted">
                  Equivalents — same salt, same strength, same form. Nothing else
                  is offered, and nothing else would be accepted.
                </p>
                {options.length === 0 ? (
                  <p className="mt-2 text-muted">None in the catalogue.</p>
                ) : (
                  <ul className="mt-2 flex flex-wrap gap-3">
                    {options.map((option) => {
                      const badge = stockBadge(option);
                      return (
                        <li key={option.id}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void answer(query.id, 'amended', option.id)}
                            className="h-14 rounded-xl border border-line px-5 text-left active:bg-line disabled:opacity-40"
                          >
                            {option.name}
                            <span
                              className={`tabular ml-3 text-sm ${
                                badge.out ? 'text-danger' : 'text-ok'
                              }`}
                            >
                              {badge.label}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => setAmending(null)}
                  className="mt-3 h-11 rounded-lg px-4 text-sm text-muted active:bg-line"
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
