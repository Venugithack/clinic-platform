'use client';

/**
 * The pharmacy queue. Signed prescriptions arrive live from the consulting
 * room; this screen keeps the immediate dispensing work visually separate from
 * stock maintenance and purchasing tasks.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Badge, EmptyState, Notice, PageHeader, Token } from '@/components/ui';
import { pharmacyQueue, type PharmacyQueueEntry, type StockState } from '@/lib/db/pharmacy';
import { subscribe } from '@/lib/realtime';
import { currentSession, lock } from '@/lib/auth';

const STOCK_LABEL: Record<StockState, string> = {
  full: 'All in stock',
  partial: 'Partial stock',
  out: 'Out of stock',
};

const STOCK_TONE: Record<StockState, 'free' | 'attn' | 'stop'> = {
  full: 'free',
  partial: 'attn',
  out: 'stop',
};

export default function CounterPage() {
  const router = useRouter();
  const [queue, setQueue] = useState<PharmacyQueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    void pharmacyQueue()
      .then((rows) => {
        setQueue(rows);
        setAsOf(new Date());
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const subscription = subscribe(['prescriptions', 'counter_queries'], refresh);
    return () => subscription.unsubscribe();
  }, [refresh]);

  const session = currentSession();
  const ready = queue.filter((entry) => entry.stock_state === 'full' && entry.open_queries === 0).length;
  const attention = queue.filter(
    (entry) => entry.stock_state !== 'full' || entry.open_queries > 0,
  ).length;

  return (
    <ThreePane
      context={
        <div className="space-y-6">
          <div>
            <p className="eyebrow">Prescription queue</p>
            <p className="mt-1 text-lg font-medium">
              {queue.length} waiting to dispense
            </p>
            {asOf ? (
              <p className="tabular mt-2 text-sm text-ink-2">
                Live · updated {asOf.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
              </p>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-2">
            <div className="rounded-box border border-rule bg-sheet p-3">
              <dt className="eyebrow">Ready</dt>
              <dd className="tabular mt-1 font-mono text-2xl">{ready}</dd>
            </div>
            <div className="rounded-box border border-rule bg-sheet p-3">
              <dt className="eyebrow">Needs attention</dt>
              <dd className="tabular mt-1 font-mono text-2xl">{attention}</dd>
            </div>
          </dl>

          <p className="text-sm leading-6 text-ink-2">
            Open a prescription, verify each medicine against the pack, then dispense. Stock and purchasing tools are secondary work below the counter actions.
          </p>

          {session ? (
            <div>
              <p className="eyebrow">Signed in</p>
              <p className="mt-1 text-sm">{session.staffName}</p>
            </div>
          ) : null}
        </div>
      }
      rail={
        <>
          <p className="eyebrow px-1 pt-1">Counter</p>
          <RailButton tone="primary" onClick={() => router.push('/counter/sale')}>
            Counter sale
          </RailButton>
          <RailButton onClick={() => router.push('/billing')}>Billing</RailButton>
          <RailButton onClick={() => router.push('/inventory')}>Inventory</RailButton>

          <p className="eyebrow px-1 pt-3">Stock work</p>
          <RailButton onClick={() => router.push('/receiving')}>Receiving</RailButton>
          <RailButton onClick={() => router.push('/stock-take')}>Stock-take</RailButton>
          <RailButton onClick={() => router.push('/expiry')}>Expiry</RailButton>

          <p className="eyebrow px-1 pt-3">Purchasing</p>
          <RailButton onClick={() => router.push('/reorder')}>Low stock</RailButton>
          <RailButton onClick={() => router.push('/orders')}>Purchase orders</RailButton>

          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton
            onClick={() => {
              void lock().then(() => router.replace('/'));
            }}
          >
            Sign out
          </RailButton>
        </>
      }
    >
      <PageHeader
        eyebrow="Pharmacy"
        title="Counter"
        sub="Signed prescriptions appear here automatically"
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {queue.length === 0 && !error ? (
        <EmptyState
          title="No prescriptions waiting"
          direction="When the doctor signs a prescription it appears here automatically. You can still use Counter sale, Billing or Inventory from the action rail."
        />
      ) : null}

      <ul className="mt-2 rounded-box border border-rule bg-sheet">
        {queue.map((entry) => (
          <li key={entry.prescription_id} className="border-b border-rule last:border-b-0">
            <button
              type="button"
              onClick={() =>
                router.push(`/counter/dispense?prescription=${entry.prescription_id}` as Route)
              }
              aria-label={`${entry.patient_name}, token ${entry.token_no ?? 'unknown'}, ${STOCK_LABEL[entry.stock_state]}`}
              className="flex min-h-20 w-full items-center gap-4 px-3 py-3 text-left active:bg-paper-2"
            >
              <Token serial={entry.token_no ?? '—'} size="lg" />

              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg font-medium">{entry.patient_name}</span>
                <span className="tabular block truncate text-sm text-ink-2">
                  {entry.lines} item{entry.lines === 1 ? '' : 's'} · {entry.doctor_name}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2">
                {entry.allergies ? <Badge tone="stop">Allergy: {entry.allergies}</Badge> : null}
                {entry.open_queries > 0 ? <Badge tone="live">Waiting on doctor</Badge> : null}
                <Badge tone={STOCK_TONE[entry.stock_state]}>{STOCK_LABEL[entry.stock_state]}</Badge>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
