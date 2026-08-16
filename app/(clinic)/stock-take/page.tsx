'use client';

/**
 * Stock-take. INVENTORY.md §5.
 *
 * Optimised for someone standing at a shelf holding the tablet: scan, count,
 * next (TABLET.md §7). The expected quantity is nowhere on this screen, and it
 * is nowhere in the data the screen can fetch either — the counting role has no
 * privilege on that column. A count that shows you the answer finds nothing.
 *
 * A stock-take in progress does not block the counter. Sales carry on, and each
 * line's variance is measured against the shelf as it was at the moment that
 * line was counted.
 */
import { useCallback, useEffect, useState } from 'react';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import { ScanField } from '@/components/ScanField';
import {
  countableBatches,
  countedLines,
  currentStockTake,
  variance,
  type CountableBatch,
  type CountedLine,
  type OpenStockTake,
  type VarianceLine,
} from '@/lib/db/stocktake';
import { lookupBarcode } from '@/lib/db/barcodes';
import {
  approveStockTake,
  countBatch,
  startStockTake,
  submitStockTake,
} from '@/lib/transitions/stocktake';
import { currentSession } from '@/lib/auth';

export default function StockTakePage() {
  const [take, setTake] = useState<OpenStockTake | null>(null);
  const [batches, setBatches] = useState<CountableBatch[]>([]);
  const [counted, setCounted] = useState<CountedLine[]>([]);
  const [rows, setRows] = useState<VarianceLine[]>([]);
  const [selected, setSelected] = useState<CountableBatch | null>(null);
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = currentSession();
  const canApprove = session?.role === 'doctor' || session?.role === 'admin';

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const open = await currentStockTake();
        setTake(open);
        setBatches(await countableBatches());
        if (open) {
          setCounted(await countedLines(open.id));
          setRows(open.status === 'review' ? await variance(open.id) : []);
        } else {
          setCounted([]);
          setRows([]);
        }
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const countedFor = (batchId: string) => counted.find((line) => line.batch_id === batchId);

  const submitCount = async () => {
    if (!take || !selected) return;
    setBusy(true);
    try {
      await countBatch(take.id, selected.batch_id, Number(digits || '0'));
      // No feedback about whether that was right, because there is none to give.
      setNotice(`${selected.drug_name} ${selected.batch_no} counted`);
      setSelected(null);
      setDigits('');
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onCode = async (code: string) => {
    try {
      const mapping = await lookupBarcode(code);
      if (!mapping) {
        setNotice('Unknown code — pick the batch from the list.');
        return;
      }
      const match = batches.find((batch) => batch.drug_id === mapping.drug_id);
      if (!match) {
        setNotice('Nothing on the shelf for that code.');
        return;
      }
      setSelected(match);
      setDigits('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Stock-take</h2>
          {take ? (
            <>
              <p className="mt-1 text-lg">{take.scope_note || 'Full count'}</p>
              <p className="tabular mt-1 text-sm text-muted">
                {counted.length} of {batches.length} batches counted
              </p>
              <p className="mt-6 text-sm text-muted">
                The expected quantity is not shown, and not fetched. Count what
                is actually on the shelf.
              </p>
            </>
          ) : (
            <p className="mt-1 text-muted">Nothing in progress.</p>
          )}
        </div>
      }
      rail={
        <>
          {!take ? (
            <RailButton
              tone="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void startStockTake('Full count')
                  .then(refresh)
                  .catch((cause: Error) => setError(cause.message))
                  .finally(() => setBusy(false));
              }}
            >
              Start a count
            </RailButton>
          ) : null}

          {take?.status === 'counting' ? (
            <>
              <ScanField label="Scan a strip" onCode={(code) => void onCode(code)} />
              <RailButton
                disabled={busy || counted.length === 0}
                onClick={() => {
                  setBusy(true);
                  void submitStockTake(take.id)
                    .then(refresh)
                    .catch((cause: Error) => setError(cause.message))
                    .finally(() => setBusy(false));
                }}
              >
                Finish counting
              </RailButton>
            </>
          ) : null}

          {take?.status === 'review' && canApprove ? (
            <RailButton
              tone="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void approveStockTake(take.id)
                  .then((n) => {
                    setNotice(`Approved. ${n} batch${n === 1 ? '' : 'es'} adjusted.`);
                    refresh();
                  })
                  .catch((cause: Error) => setError(cause.message))
                  .finally(() => setBusy(false));
              }}
            >
              Approve and post
            </RailButton>
          ) : null}
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Stock-take</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          {notice}
        </p>
      ) : null}

      {!take ? (
        <p className="mt-6 text-muted">
          A count can be partial — one shelf, one rack, one drug group. Partial
          counts are what actually happen.
        </p>
      ) : null}

      {/* Step 2: blind counting. */}
      {take?.status === 'counting' ? (
        selected ? (
          <div className="mt-6 max-w-md rounded-xl border border-line bg-white p-4">
            <p className="text-lg">
              {selected.drug_name}{' '}
              <span className="tabular text-sm text-muted">{selected.batch_no}</span>
            </p>
            <p className="tabular mt-3 text-4xl font-medium">{digits || '0'}</p>
            <div className="mt-4 w-64">
              <Numpad
                onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 6))}
                onBackspace={() => setDigits((c) => c.slice(0, -1))}
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={busy || digits === ''}
                onClick={() => void submitCount()}
                className="h-14 flex-1 rounded-xl border border-ink bg-ink px-4 font-medium text-white disabled:opacity-40"
              >
                Record count
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="h-14 rounded-xl border border-line px-5 text-muted active:bg-line"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ul className="mt-6 max-w-2xl">
            {batches.map((batch) => {
              const line = countedFor(batch.batch_id);
              return (
                <li key={batch.batch_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(batch);
                      setDigits('');
                    }}
                    className="flex h-16 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-lg">{batch.drug_name}</span>
                      <span className="tabular block text-sm text-muted">
                        {batch.batch_no}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-sm text-muted">
                      {line ? `counted ${line.counted_qty_base}` : 'not counted'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {/* Step 3: variance, by rupee value. */}
      {take?.status === 'review' ? (
        <>
          <p className="mt-6 text-muted">
            Sorted by the value of the discrepancy, not its size. Anything over
            ₹{take.recount_threshold_value} goes back for a second count before
            it can post.
          </p>
          <table className="mt-4 w-full max-w-3xl">
            <thead>
              <tr className="border-b border-line text-left text-sm text-muted">
                <th className="py-2">Drug</th>
                <th>Batch</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Counted</th>
                <th className="text-right">Variance</th>
                <th className="text-right">Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.batch_id} className="border-b border-line">
                  <td className="py-3">{row.drug_name}</td>
                  <td className="tabular text-sm text-muted">{row.batch_no}</td>
                  <td className="tabular text-right">{row.system_qty_base}</td>
                  <td className="tabular text-right">{row.counted_qty_base}</td>
                  <td
                    className={`tabular text-right ${
                      row.variance_base === 0 ? 'text-muted' : 'text-danger'
                    }`}
                  >
                    {row.variance_base > 0 ? '+' : ''}
                    {row.variance_base}
                  </td>
                  <td className="tabular text-right">₹{row.variance_value}</td>
                  <td className="py-3 pl-3 text-right">
                    {row.needs_recount ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSelected({
                            batch_id: row.batch_id,
                            drug_id: row.drug_id,
                            drug_name: row.drug_name,
                            batch_no: row.batch_no,
                            expiry: '',
                          });
                          setDigits('');
                        }}
                        className="h-11 rounded-lg border border-danger px-3 text-sm text-danger active:bg-line"
                      >
                        Recount
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected ? (
            <div className="mt-6 max-w-md rounded-xl border border-danger bg-white p-4">
              <p className="text-lg">
                Second count — {selected.drug_name}{' '}
                <span className="tabular text-sm text-muted">{selected.batch_no}</span>
              </p>
              <p className="tabular mt-3 text-4xl font-medium">{digits || '0'}</p>
              <div className="mt-4 w-64">
                <Numpad
                  onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 6))}
                  onBackspace={() => setDigits((c) => c.slice(0, -1))}
                />
              </div>
              <button
                type="button"
                disabled={busy || digits === ''}
                onClick={() => void submitCount()}
                className="mt-4 h-14 w-full rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
              >
                Record second count
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </ThreePane>
  );
}
