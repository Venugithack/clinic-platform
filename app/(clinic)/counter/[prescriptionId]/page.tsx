'use client';

/**
 * Dispensing one prescription.
 *
 * Two things happen on this screen and they are separable. The counter can ask
 * the doctor about a line it cannot fill (PLAN.md §11.1's return leg), and it
 * can dispense — which is the M3 gate:
 *
 *   "Two batches, different expiries, different MRPs, different strip sizes —
 *    dispensing takes the earlier, charges the right MRP, and the ledger
 *    reconciles. An expired batch is refused. A barcode scan at dispense stops
 *    the wrong box."
 *
 * Scan-to-verify is the safety feature worth naming to the doctor
 * (INVENTORY.md §2). A pharmacist reaching for the wrong box is the error that
 * actually harms someone, and this catches it while the strip is still in their
 * hand. Wrong drug is a red flash and a stop — the only place in the app that
 * uses that treatment (TABLET.md §4).
 *
 * A line with no barcode yet can still be dispensed, but only through a
 * deliberate second gesture (rule 8). Blocking the counter because a strip is
 * unlabelled would teach everyone to distrust the check.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { ScanField } from '@/components/ScanField';
import {
  fefoPreview,
  pharmacyQueueEntry,
  queriesForPrescription,
  type AnsweredQuery,
  type FefoBatch,
  type PharmacyQueueEntry,
} from '@/lib/db/pharmacy';
import { prescriptionForPrint, type PrescriptionItem } from '@/lib/db/encounters';
import { drugsByIds, equivalentDrugs, stockBadge, type DrugRow } from '@/lib/db/drugs';
import { lookupBarcode } from '@/lib/db/barcodes';
import { raiseCounterQuery, withdrawCounterQuery } from '@/lib/transitions/counter';
import { dispense } from '@/lib/transitions/dispense';
import { subscribe } from '@/lib/realtime';

type Verification = 'scanned' | 'confirmed';

export default function CounterPrescriptionPage() {
  const router = useRouter();
  const { prescriptionId } = useParams<{ prescriptionId: string }>();

  const [entry, setEntry] = useState<PharmacyQueueEntry | null>(null);
  const [items, setItems] = useState<PrescriptionItem[]>([]);
  const [drugs, setDrugs] = useState<Map<string, DrugRow>>(new Map());
  const [queries, setQueries] = useState<AnsweredQuery[]>([]);
  const [allocation, setAllocation] = useState<Map<string, FefoBatch[]>>(new Map());

  const [verified, setVerified] = useState<Map<string, Verification>>(new Map());
  const [flash, setFlash] = useState<{ kind: 'ok' | 'wrong'; message: string } | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);

  const [asking, setAsking] = useState<PrescriptionItem | null>(null);
  const [options, setOptions] = useState<DrugRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dispensedAt, setDispensedAt] = useState<string | null>(null);

  /** After an approved substitution the counter dispenses the substitute. */
  const answerFor = useCallback(
    (drugId: string) =>
      queries.filter((q) => q.drug_id === drugId && q.status === 'answered').at(-1),
    [queries],
  );

  const effectiveDrugId = useCallback(
    (item: PrescriptionItem) => answerFor(item.drug_id)?.approved_drug_id ?? item.drug_id,
    [answerFor],
  );

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
          setDispensedAt(rx.status === 'dispensed' ? (rx.signed_at ?? null) : null);

          // The approved substitute is not on the prescription — that is the
          // point of it — so it is fetched alongside, or the counter is told to
          // "dispense the approved drug" without being told which one.
          const ids = new Set(rx.items.map((item) => item.drug_id));
          for (const query of qs) {
            if (query.approved_drug_id) ids.add(query.approved_drug_id);
          }
          setDrugs(await drugsByIds([...ids]));

          const plan = new Map<string, FefoBatch[]>();
          for (const item of rx.items) {
            const target =
              qs.filter((q) => q.drug_id === item.drug_id && q.status === 'answered').at(-1)
                ?.approved_drug_id ?? item.drug_id;
            plan.set(item.drug_id, await fefoPreview(target, item.qty_base));
          }
          setAllocation(plan);
        }
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [prescriptionId]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const subscription = subscribe(['counter_queries', 'prescriptions'], refresh);
    return () => subscription.unsubscribe();
  }, [refresh]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(timer);
  }, [flash]);

  // -------------------------------------------------------------------------
  // Scan-to-verify.
  // -------------------------------------------------------------------------
  const onCode = useCallback(
    async (code: string) => {
      setError(null);
      try {
        const mapping = await lookupBarcode(code);

        if (!mapping) {
          // First sight of a code: ask which drug it is, once, and remember.
          setUnknownCode(code);
          setFlash({ kind: 'wrong', message: 'Unknown code — which drug is this?' });
          return;
        }

        const line = items.find((item) => effectiveDrugId(item) === mapping.drug_id);

        if (!line) {
          // The stop. Everything else on this screen is ordinary UI; this is
          // the one that keeps a patient from being handed the wrong box.
          const name = drugs.get(mapping.drug_id)?.name ?? 'That pack';
          setFlash({ kind: 'wrong', message: `${name} is not on this prescription. Stop.` });
          return;
        }

        setVerified((current) => new Map(current).set(line.drug_id, 'scanned'));
        setFlash({ kind: 'ok', message: `${line.name} verified` });
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [items, drugs, effectiveDrugId],
  );

  const allVerified =
    items.length > 0 && items.every((item) => verified.has(item.drug_id));

  const doDispense = async () => {
    setBusy(true);
    setError(null);
    try {
      await dispense({
        prescriptionId,
        patientId: entry?.patient_id,
        lines: items.map((item) => {
          const answer = answerFor(item.drug_id);
          const substituted =
            answer?.approved_drug_id != null && answer.approved_drug_id !== item.drug_id;
          return {
            drugId: effectiveDrugId(item),
            qtyBase: item.qty_base,
            // Both sides recorded: what was prescribed, what left the shelf,
            // and who approved the difference (INVENTORY.md §7).
            prescribedDrugId: substituted ? item.drug_id : undefined,
            substitutionApprovedBy: substituted ? (answer?.answered_by ?? undefined) : undefined,
          };
        }),
      });
      setDispensedAt(new Date().toISOString());
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

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

  const openQuery = (drugId: string) =>
    queries.find((q) => q.drug_id === drugId && q.status === 'open');

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

          {unknownCode ? (
            <div className="mt-6 rounded-xl border border-line bg-white p-3">
              <p className="text-sm text-muted">
                Code {unknownCode} is not known. Tap the line it belongs to.
              </p>
              <button
                type="button"
                onClick={() => setUnknownCode(null)}
                className="mt-2 h-11 rounded-lg px-3 text-sm text-muted active:bg-line"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      }
      rail={
        <>
          {!dispensedAt ? (
            <ScanField label="Scan each strip" onCode={(code) => void onCode(code)} />
          ) : null}

          <RailButton
            tone="primary"
            disabled={!allVerified || busy || dispensedAt !== null}
            onClick={() => void doDispense()}
          >
            {dispensedAt ? 'Dispensed' : busy ? 'Dispensing…' : 'Dispense'}
          </RailButton>

          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Dispense</h1>

      {/* A colour flash, not a dialog: the pharmacist is looking at the strip. */}
      {flash ? (
        <p
          role="status"
          className={`mt-4 rounded-lg p-3 text-lg ${
            flash.kind === 'ok' ? 'bg-ok/10 text-ok' : 'bg-danger/15 text-danger'
          }`}
        >
          {flash.message}
        </p>
      ) : null}

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      {dispensedAt ? (
        <p className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          Dispensed. The ledger has been written and the stock is down.
        </p>
      ) : null}

      <ul className="mt-6 max-w-3xl">
        {items.map((item) => {
          const target = effectiveDrugId(item);
          const drug = drugs.get(target);
          const badge = drug ? stockBadge(drug) : null;
          const short = drug ? drug.qty_base_available < item.qty_base : false;
          const open = openQuery(item.drug_id);
          const answered = answerFor(item.drug_id);
          const substituted = target !== item.drug_id;
          const state = verified.get(item.drug_id);
          const batches = allocation.get(item.drug_id) ?? [];

          return (
            <li key={item.drug_id} className="border-b border-line py-4">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 shrink-0 rounded-full ${
                    state ? 'bg-ok' : 'bg-line'
                  }`}
                />

                <div className="min-w-0 flex-1">
                  <p className="text-lg">
                    {substituted ? (drug?.name ?? '…') : item.name}{' '}
                    <span className="text-sm text-muted">{item.strength}</span>
                    {substituted ? (
                      <span className="ml-2 rounded bg-ok/10 px-1.5 py-0.5 text-xs text-ok">
                        substituted for {item.name}
                      </span>
                    ) : null}
                  </p>
                  <p className="tabular text-sm text-muted">
                    {item.dose} · {item.freq} · {item.days} days · need {item.qty_base}
                  </p>

                  {/* Which box to reach for. FEFO, first expiry first out. */}
                  {batches.length > 0 && !dispensedAt ? (
                    <p className="tabular mt-1 text-sm text-muted">
                      take{' '}
                      {batches
                        .map(
                          (batch) =>
                            `${batch.qty_base} from ${batch.batch_no} (exp ${new Date(
                              batch.expiry,
                            ).toLocaleDateString('en-IN', {
                              month: 'short',
                              year: 'numeric',
                            })})`,
                        )
                        .join(' + ')}
                    </p>
                  ) : null}
                </div>

                <span className={`tabular shrink-0 text-sm ${short ? 'text-danger' : 'text-ok'}`}>
                  {badge?.label ?? '—'}
                </span>

                {dispensedAt ? null : unknownCode ? (
                  <button
                    type="button"
                    onClick={() => {
                      void import('@/lib/transitions/inventory').then(({ learnBarcode }) =>
                        learnBarcode(unknownCode, target)
                          .then(() => {
                            setUnknownCode(null);
                            setVerified((c) => new Map(c).set(item.drug_id, 'scanned'));
                            setFlash({ kind: 'ok', message: `${item.name} learned and verified` });
                          })
                          .catch((cause: Error) => setError(cause.message)),
                      );
                    }}
                    className="h-11 shrink-0 rounded-lg border border-ink px-4 text-sm active:bg-line"
                  >
                    This one
                  </button>
                ) : state ? (
                  <span className="shrink-0 text-sm text-ok">
                    {state === 'scanned' ? 'scanned' : 'confirmed'}
                  </span>
                ) : (
                  <button
                    type="button"
                    // Rule 8: a deliberate second gesture, because this is the
                    // one place the scan check is being set aside.
                    onClick={() => {
                      if (
                        window.confirm(
                          `No barcode scanned for ${item.name}. Confirm by name that this is the right pack?`,
                        )
                      ) {
                        setVerified((c) => new Map(c).set(item.drug_id, 'confirmed'));
                      }
                    }}
                    className="h-11 shrink-0 rounded-lg border border-line px-4 text-sm active:bg-line"
                  >
                    No barcode
                  </button>
                )}

                {dispensedAt ? null : open ? (
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
                  <p className="text-sm text-muted">Ask the doctor about {item.name}</p>

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
