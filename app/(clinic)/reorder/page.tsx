'use client';

/**
 * Reordering. INVENTORY.md §8.
 *
 * The screen is a proposal, and it is built to be argued with. Every row shows
 * the working — how fast the drug moves, how long the shelf lasts, how long the
 * supplier actually takes and whether that number was measured or merely
 * claimed — because the failure mode of a purchasing suggestion is not being
 * slightly wrong, it is being trusted.
 *
 * The quantity is editable and the row can be dropped. What leaves this screen
 * is a DRAFT order per supplier; nothing here can send anything to anybody
 * (PLAN.md §5.3 rule 4). Sending is M5 and starts with a human's tap.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import {
  priceHistory,
  reorderSuggestions,
  type PurchasePrice,
  type ReorderSuggestion,
} from '@/lib/db/reorder';
import { draftPurchaseOrders } from '@/lib/transitions/purchasing';
import { formatQty } from '@/lib/units';

const SOURCE_NOTE: Record<ReorderSuggestion['lead_time_source'], string> = {
  measured: 'measured from deliveries',
  claimed: 'the supplier’s own claim',
  assumed: 'assumed — no data yet',
};

export default function ReorderPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ReorderSuggestion[]>([]);
  const [prices, setPrices] = useState<Map<string, PurchasePrice[]>>(new Map());
  const [qty, setQty] = useState<Record<string, number>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ReorderSuggestion | null>(null);
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    // Cleared before the reads, never after them. A read landing is not
    // evidence that the last WRITE succeeded, and clearing on completion
    // erased a refusal somebody was in the middle of reading (M11e).
    setError(null);
    void (async () => {
      try {
        const suggestions = await reorderSuggestions();
        setRows(suggestions);
        setPrices(await priceHistory(suggestions.map((row) => row.drug_id)));
        setQty(
          Object.fromEntries(
            suggestions.map((row) => [row.drug_id, row.suggested_qty_base]),
          ),
        );
        setDropped(new Set());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const included = rows.filter(
    (row) => !dropped.has(row.drug_id) && (qty[row.drug_id] ?? 0) > 0,
  );
  const orderable = included.filter((row) => row.default_supplier_id);
  const suppliers = new Set(orderable.map((row) => row.default_supplier_id));

  const lastPrice = (drugId: string): number | undefined =>
    prices.get(drugId)?.[0]?.cost_per_base_unit;

  const estimated = orderable.reduce(
    (sum, row) => sum + (lastPrice(row.drug_id) ?? 0) * (qty[row.drug_id] ?? 0),
    0,
  );

  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const orders = await draftPurchaseOrders(
        orderable.map((row) => ({
          drugId: row.drug_id,
          supplierId: row.default_supplier_id as string,
          qtyBase: qty[row.drug_id] as number,
          suggestedQtyBase: row.suggested_qty_base,
          expectedCostPerBaseUnit: lastPrice(row.drug_id),
        })),
      );
      setNotice(
        `${orders} draft order${orders === 1 ? '' : 's'} saved — one per supplier. Nothing has been sent: sending a purchase order is a separate, deliberate act and it is not built yet.`,
      );
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
          <h2 className="eyebrow">Reorder</h2>
          <p className="mt-1 text-lg">{rows.length} suggested</p>
          <p className="tabular mt-1 text-sm text-ink-2">
            about ₹{estimated.toFixed(2)} at the last prices paid
          </p>

          <p className="mt-6 text-sm text-ink-2">
            Every number here is a proposal. Change the quantity, drop the line,
            or ignore the screen entirely — nothing orders itself, and nothing on
            this screen reaches a supplier.
          </p>

          {suppliers.size > 0 ? (
            <p className="mt-6 text-sm text-ink-2">
              {suppliers.size} supplier{suppliers.size === 1 ? '' : 's'}, so{' '}
              {suppliers.size} draft order{suppliers.size === 1 ? '' : 's'}.
            </p>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || orderable.length === 0}
            onClick={() => void draft()}
          >
            Draft {suppliers.size || ''} order{suppliers.size === 1 ? '' : 's'}
          </RailButton>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Purchasing" title="Reorder" />

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {rows.length === 0 && !error ? (
        <p className="mt-6 text-ink-2">
          Nothing is below its reorder level, and nothing is running out sooner
          than the supplier can deliver.
        </p>
      ) : null}

      <ul className="mt-4 max-w-4xl">
        {rows.map((row) => {
          const isDropped = dropped.has(row.drug_id);
          const history = prices.get(row.drug_id) ?? [];
          const pack = {
            unitsPerStrip: row.default_units_per_strip ?? 1,
            stripsPerBox: row.default_strips_per_box ?? 1,
          };

          return (
            <li
              key={row.drug_id}
              className={`border-b border-rule py-3 ${isDropped ? 'opacity-40' : ''}`}
              data-testid={`reorder-${row.drug_name}`}
            >
              <div className="flex items-center gap-4">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg">{row.drug_name}</span>
                  <span className="tabular block text-sm text-ink-2">
                    {row.qty_base_available} on hand ·{' '}
                    {row.days_of_cover_left === null
                      ? 'no movement recorded'
                      : `${row.days_of_cover_left} days of cover`}
                    {row.times_at_zero > 0
                      ? ` · ran out ${row.times_at_zero}× in 180 days`
                      : ''}
                  </span>
                  <span className="block text-sm text-ink-2">
                    {row.supplier_name ?? 'no default supplier'} · {row.lead_days} day
                    lead ({SOURCE_NOTE[row.lead_time_source]})
                    {row.buffer_days > 0 ? ` + ${row.buffer_days} buffer` : ''}
                  </span>
                </span>

                {/* Named after the drug AND carrying the number, like the Drop
                    button below it. Without the drug the accessible name is a
                    bare quantity, and suggested quantities repeat across the
                    list — four rows offering 450 gave four buttons all called
                    "450", which tells a screen reader nothing about which
                    medicine is being ordered.

                    The quantity stays in the name rather than being replaced by
                    it, because the number is the thing being announced and the
                    thing being changed: m3-purchasing.spec.ts finds this button
                    by the value and then asserts the value again after editing
                    it. Dropping the digits would have made that assertion
                    unwritable — a label is not allowed to hide the value it
                    labels. */}
                <button
                  type="button"
                  aria-label={`Order quantity for ${row.drug_name}: ${qty[row.drug_id] ?? 0}`}
                  onClick={() => {
                    setEditing(row);
                    setDigits('');
                  }}
                  className="tabular font-mono h-14 w-32 shrink-0 rounded-box border border-rule px-3 text-right text-xl active:bg-paper-2"
                >
                  {qty[row.drug_id] ?? 0}
                </button>

                <button
                  type="button"
                  aria-label={`Drop ${row.drug_name}`}
                  onClick={() =>
                    setDropped((current) => {
                      const next = new Set(current);
                      if (next.has(row.drug_id)) next.delete(row.drug_id);
                      else next.add(row.drug_id);
                      return next;
                    })
                  }
                  className="h-11 w-11 shrink-0 rounded-box border border-rule text-ink-2 active:bg-paper-2"
                >
                  {isDropped ? '↺' : '✕'}
                </button>
              </div>

              <p className="mt-1 text-sm text-ink-2">
                {formatQty(qty[row.drug_id] ?? 0, pack, row.base_unit, { boxes: true })} ·{' '}
                {row.basis}
              </p>

              {/* The price he paid last time, and to whom. Small to build, and
                  visible exactly when he can act on it. */}
              {history.length > 0 ? (
                <p className="tabular mt-1 text-sm">
                  {history.slice(0, 3).map((price, index) => (
                    <span key={`${price.supplier_id}-${price.purchase_no}`}>
                      {index > 0 ? ' · ' : ''}₹{Number(price.cost_per_base_unit).toFixed(2)}{' '}
                      {price.supplier_name ?? 'unknown'}{' '}
                      <span className="text-ink-2">
                        {new Date(price.received_at).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="mt-1 text-sm text-ink-2">No purchase history yet.</p>
              )}
            </li>
          );
        })}
      </ul>

      {editing ? (
        <div className="mt-6 max-w-md rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">{editing.drug_name}</p>
          <p className="text-sm text-ink-2">
            Suggested {editing.suggested_qty_base} · {editing.basis}
          </p>
          <p className="tabular font-mono mt-3 text-4xl font-medium">{digits || '0'}</p>
          <div className="mt-4 w-64">
            <Numpad
              onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 6))}
              onBackspace={() => setDigits((c) => c.slice(0, -1))}
            />
          </div>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => {
                setQty((current) => ({
                  ...current,
                  [editing.drug_id]: Number(digits || '0'),
                }));
                setEditing(null);
              }}
              className="h-14 flex-1 rounded-box border border-ink bg-ink px-4 font-medium text-paper"
            >
              Set quantity
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </ThreePane>
  );
}
