'use client';

/**
 * The pharmacy queue. TABLET.md §7: newest prescription at the top, arriving
 * live, colour-coded fully in stock / partial / out.
 *
 * This is one half of the feature the clinic actually bought (PLAN.md §11).
 * The other half is the consult screen answering back. Neither polls — both
 * subscribe, through lib/realtime.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { pharmacyQueue, type PharmacyQueueEntry, type StockState } from '@/lib/db/pharmacy';
import { subscribe } from '@/lib/realtime';
import { currentSession, lock } from '@/lib/auth';

const STOCK_LABEL: Record<StockState, string> = {
  full: 'All in stock',
  partial: 'Partial',
  out: 'Out',
};

const STOCK_STYLE: Record<StockState, string> = {
  full: 'text-ok',
  partial: 'text-ink',
  out: 'text-danger',
};

export default function CounterPage() {
  const router = useRouter();
  const [queue, setQueue] = useState<PharmacyQueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    void pharmacyQueue()
      .then((rows) => {
        setQueue(rows);
        setAsOf(new Date());
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    // A prescription signed in the cabin lands here in under a second. The
    // subscription carries an id, not a row — the re-read goes through lib/db
    // so RLS still shapes what the counter sees.
    const subscription = subscribe(['prescriptions', 'counter_queries'], refresh);
    return () => subscription.unsubscribe();
  }, [refresh]);

  const session = currentSession();

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Pharmacy</h2>
          <p className="mt-1 text-lg">
            {queue.length} waiting to dispense
          </p>

          {/* Rule 6, applied to a live list: it is rendered with an "as of",
              because a screen that has quietly stopped receiving looks exactly
              like a quiet afternoon. */}
          {asOf ? (
            <p className="tabular mt-2 text-sm text-muted">
              live · as of {asOf.toLocaleTimeString('en-IN')}
            </p>
          ) : null}

          {session ? (
            <p className="mt-8 text-sm text-muted">Signed in as {session.staffName}</p>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton tone="primary" onClick={() => router.push('/counter/sale')}>
            Counter sale
          </RailButton>
          <RailButton onClick={() => router.push('/billing')}>Billing</RailButton>
          <RailButton onClick={() => router.push('/receiving')}>Receiving</RailButton>
          <RailButton onClick={() => router.push('/stock-take')}>Stock-take</RailButton>
          <RailButton onClick={() => router.push('/expiry')}>Expiry</RailButton>
          <RailButton onClick={() => router.push('/reorder')}>Reorder</RailButton>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton
            onClick={() => {
              void lock().then(() => router.replace('/'));
            }}
          >
            Lock
          </RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Counter</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      {queue.length === 0 && !error ? (
        <p className="mt-6 text-muted">
          Nothing to dispense. Signed prescriptions appear here as the doctor
          signs them.
        </p>
      ) : null}

      <ul className="mt-4">
        {queue.map((entry) => (
          <li key={entry.prescription_id}>
            <button
              type="button"
              onClick={() =>
                router.push(`/counter/${entry.prescription_id}` as Route)
              }
              className="flex h-20 w-full items-center gap-5 border-b border-line px-3 text-left active:bg-line"
            >
              <span className="tabular w-14 shrink-0 text-3xl font-medium">
                {entry.token_no ?? '—'}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{entry.patient_name}</span>
                <span className="tabular block truncate text-sm text-muted">
                  {entry.lines} item{entry.lines === 1 ? '' : 's'} · {entry.doctor_name}
                </span>
              </span>

              {entry.allergies ? (
                <span className="shrink-0 rounded bg-danger/10 px-2 py-1 text-sm text-danger">
                  {entry.allergies}
                </span>
              ) : null}

              {entry.open_queries > 0 ? (
                <span className="shrink-0 rounded bg-ink px-2 py-1 text-sm text-white">
                  waiting on doctor
                </span>
              ) : null}

              <span
                className={`w-28 shrink-0 text-right text-sm ${STOCK_STYLE[entry.stock_state]}`}
              >
                {STOCK_LABEL[entry.stock_state]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
