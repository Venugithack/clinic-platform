'use client';

/**
 * One prescription at the counter.
 *
 * This screen is where PLAN.md §11.1's return leg starts: the pharmacist sees
 * each line against live stock and, when a line cannot be filled, asks the
 * doctor — without leaving the counter, and without either of them picking up a
 * phone.
 *
 * What it deliberately does NOT do is dispense. FEFO allocation, the ledger and
 * the batch picking are M3, and app.dispense already refuses anything else. A
 * button here that looked like dispensing would be a lie about what the system
 * has recorded.
 *
 * INVENTORY.md §7 governs the substitution flow: the counter may only propose
 * an equivalent — same salt, same strength, same form — and the doctor decides.
 * The list of proposals is filtered to equivalents, and the transition refuses
 * anything else even if this screen were wrong.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import {
  pharmacyQueueEntry,
  queriesForPrescription,
  type AnsweredQuery,
  type PharmacyQueueEntry,
} from '@/lib/db/pharmacy';
import { prescriptionForPrint, type PrescriptionItem } from '@/lib/db/encounters';
import { drugsByIds, equivalentDrugs, stockBadge, type DrugRow } from '@/lib/db/drugs';
import { raiseCounterQuery, withdrawCounterQuery } from '@/lib/transitions/counter';
import { subscribe } from '@/lib/realtime';

export default function CounterPrescriptionPage() {
  const router = useRouter();
  const { prescriptionId } = useParams<{ prescriptionId: string }>();

  const [entry, setEntry] = useState<PharmacyQueueEntry | null>(null);
  const [items, setItems] = useState<PrescriptionItem[]>([]);
  const [drugs, setDrugs] = useState<Map<string, DrugRow>>(new Map());
  const [queries, setQueries] = useState<AnsweredQuery[]>([]);
  const [asking, setAsking] = useState<PrescriptionItem | null>(null);
  const [options, setOptions] = useState<DrugRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const [queueEntry, rx, qs] = await Promise.all([
          pharmacyQueueEntry(prescriptionId),
          prescriptionForPrint(prescriptionId),
          queriesForPrescription(prescriptionId),
        ]);
        setEntry(queueEntry);
        setQueries(qs);
        if (rx) {
          setItems(rx.items);
          // The approved substitute is not on the prescription — that is the
          // whole point of it — so it has to be fetched alongside, or the
          // counter is told to "dispense the approved drug" without being told
          // which one.
          const ids = new Set(rx.items.map((item) => item.drug_id));
          for (const query of qs) {
            if (query.approved_drug_id) ids.add(query.approved_drug_id);
          }
          setDrugs(await drugsByIds([...ids]));
        }
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [prescriptionId]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    // The doctor's answer lands here without the pharmacist doing anything.
    const subscription = subscribe(['counter_queries', 'prescriptions'], refresh);
    return () => subscription.unsubscribe();
  }, [refresh]);

  const openQuery = (drugId: string) =>
    queries.find((q) => q.drug_id === drugId && q.status === 'open');
  const lastAnswer = (drugId: string) =>
    queries.filter((q) => q.drug_id === drugId && q.status === 'answered').at(-1);

  const startAsking = async (item: PrescriptionItem) => {
    setAsking(item);
    setError(null);
    const drug = drugs.get(item.drug_id);
    setOptions(drug ? await equivalentDrugs(drug) : []);
  };

  const ask = async (kind: 'out_of_stock' | 'clarification', proposedDrugId?: string) => {
    if (!asking) return;
    setBusy(true);
    try {
      await raiseCounterQuery({
        prescriptionId,
        drugId: asking.drug_id,
        kind: proposedDrugId ? 'substitution' : kind,
        proposedDrugId,
        note: proposedDrugId ? undefined : 'Not enough on the shelf',
      });
      setAsking(null);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-xl font-semibold">{entry?.patient_name ?? '…'}</h2>
          <p className="tabular mt-1 text-muted">
            Token {entry?.token_no ?? '—'} · {entry?.doctor_name}
          </p>

          {entry?.allergies ? (
            <p className="mt-4 rounded-lg bg-danger/10 p-3 text-danger">
              Allergies: {entry.allergies}
            </p>
          ) : null}

          <p className="mt-8 text-sm text-muted">
            Dispensing, FEFO batch picking and the ledger arrive in M3. This
            screen reviews the prescription against live stock and asks the
            doctor when a line cannot be filled.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Dispense</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      <ul className="mt-6 max-w-3xl">
        {items.map((item) => {
          const drug = drugs.get(item.drug_id);
          const badge = drug ? stockBadge(drug) : null;
          const short = drug ? drug.qty_base_available < item.qty_base : false;
          const open = openQuery(item.drug_id);
          const answered = lastAnswer(item.drug_id);

          return (
            <li key={item.drug_id} className="border-b border-line py-4">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-lg">
                    {item.name} <span className="text-sm text-muted">{item.strength}</span>
                  </p>
                  <p className="tabular text-sm text-muted">
                    {item.dose} · {item.freq} · {item.days} days · need {item.qty_base}
                  </p>
                </div>

                <span
                  className={`tabular shrink-0 text-sm ${
                    short ? 'text-danger' : 'text-ok'
                  }`}
                >
                  {badge?.label ?? '—'}
                </span>

                {open ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void withdrawCounterQuery(open.id, 'Found another box')
                        .then(refresh)
                        .catch((cause: Error) => setError(cause.message))
                        .finally(() => setBusy(false));
                    }}
                    className="h-11 shrink-0 rounded-lg border border-line px-4 text-sm active:bg-line"
                  >
                    Waiting on doctor · withdraw
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void startAsking(item)}
                    className="h-11 shrink-0 rounded-lg border border-line px-4 text-sm active:bg-line"
                  >
                    Ask doctor
                  </button>
                )}
              </div>

              {answered ? (
                <p
                  className={`mt-2 rounded-lg p-2 text-sm ${
                    answered.decision === 'rejected'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-ok/10 text-ok'
                  }`}
                >
                  Doctor {answered.decision}
                  {answered.approved_drug_id
                    ? ` — dispense ${drugs.get(answered.approved_drug_id)?.name ?? 'the approved drug'}`
                    : ''}
                  {answered.answer_note ? `: ${answered.answer_note}` : ''}
                </p>
              ) : null}

              {asking?.drug_id === item.drug_id ? (
                <div className="mt-3 rounded-xl border border-line bg-white p-4">
                  <p className="text-sm text-muted">
                    Ask the doctor about {item.name}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void ask('out_of_stock')}
                      className="h-14 rounded-xl border border-line px-5 active:bg-line"
                    >
                      Not enough on the shelf
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void ask('clarification')}
                      className="h-14 rounded-xl border border-line px-5 active:bg-line"
                    >
                      Something else
                    </button>
                    <button
                      type="button"
                      onClick={() => setAsking(null)}
                      className="h-14 rounded-xl px-5 text-muted active:bg-line"
                    >
                      Cancel
                    </button>
                  </div>

                  {options.length > 0 ? (
                    <>
                      <p className="mt-5 text-sm text-muted">
                        Or propose an equivalent — same salt, same strength, same
                        form. The doctor decides.
                      </p>
                      <ul className="mt-2 space-y-2">
                        {options.map((option) => {
                          const optionBadge = stockBadge(option);
                          return (
                            <li key={option.id}>
                              <button
                                type="button"
                                disabled={busy || optionBadge.out}
                                onClick={() => void ask('out_of_stock', option.id)}
                                className="flex h-14 w-full items-center justify-between rounded-xl border border-line px-4 text-left active:bg-line disabled:opacity-40"
                              >
                                <span>{option.name}</span>
                                <span
                                  className={`tabular text-sm ${
                                    optionBadge.out ? 'text-danger' : 'text-ok'
                                  }`}
                                >
                                  {optionBadge.label}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-5 text-sm text-muted">
                      No equivalent in the catalogue. Same salt, same strength,
                      same form — or nothing.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreePane>
  );
}
