'use client';

/**
 * Counter sale — a walk-in with no prescription (PLAN.md §18 Q3).
 *
 * "Scan-driven basket, running total large enough to read from the customer's
 *  side, numpad for anything manual" (TABLET.md §7).
 *
 * The one rule that is not a preference: **Schedule H1 cannot leave on a
 * counter sale.** That is enforced in app.dispense, not here — this screen
 * shows the H1 badge so the pharmacist is not surprised, but the refusal comes
 * from the database, and it would come even if this screen forgot.
 *
 * Billing proper — the consult fee, the printed bill, the till and the cash
 * day-close — is M4. This screen moves stock and records what it was sold for;
 * it does not pretend to be a till.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { ScanField } from '@/components/ScanField';
import { QtyPad } from '@/components/QtyPad';
import { DrugSearch } from '@/components/DrugSearch';
import { getDrug, stockBadge, type DrugRow } from '@/lib/db/drugs';
import { lookupBarcode } from '@/lib/db/barcodes';
import { fefoPreview } from '@/lib/db/pharmacy';
import { runOrQueue } from '@/lib/offline/queue';
import { lineAmountPaise, paiseToRupees, rupeesToPaise } from '@/lib/units';

interface BasketLine {
  drug: DrugRow;
  qtyBase: number;
  amountPaise: number;
}

export default function CounterSalePage() {
  const router = useRouter();
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [pending, setPending] = useState<DrugRow | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [soldAt, setSoldAt] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [flash]);

  const onCode = useCallback(async (code: string) => {
    setError(null);
    try {
      const mapping = await lookupBarcode(code);
      if (!mapping) {
        setError('Unknown code. Search for the medicine instead.');
        return;
      }
      const drug = await getDrug(mapping.drug_id);
      if (!drug) return;
      setPending(drug);
      setFlash(`${drug.name} scanned`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  const addLine = async (drug: DrugRow, qtyBase: number) => {
    // The price the customer will be charged, priced off the batches FEFO will
    // actually take. The database recomputes it and is authoritative; this is
    // what lets the running total be right before the sale is committed.
    const allocation = await fefoPreview(drug.id, qtyBase);
    const amountPaise = allocation.reduce(
      (total, batch) =>
        total +
        lineAmountPaise(
          batch.qty_base,
          rupeesToPaise(batch.mrp),
          { unitsPerStrip: batch.units_in_pack, stripsPerBox: 1 },
          'strip',
        ),
      0,
    );

    setBasket((current) => [...current, { drug, qtyBase, amountPaise }]);
    setPending(null);
  };

  const totalPaise = basket.reduce((sum, line) => sum + line.amountPaise, 0);

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      // Through the queue, because this is the screen a dropped connection
      // actually interrupts. A refusal still throws and is shown; only a
      // request that never reached the database is kept on the tablet.
      const outcome = await runOrQueue('dispense', {
        is_counter_sale: true,
        lines: basket.map((line) => ({
          drug_id: line.drug.id,
          qty_base: line.qtyBase,
        })),
      });

      setQueued(outcome.queued);
      setSoldAt(new Date().toISOString());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (searching) {
    return (
      <DrugSearch
        onClose={() => setSearching(false)}
        onPick={(drug) => {
          setPending(drug);
          setSearching(false);
        }}
      />
    );
  }

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Counter sale</h2>
          <p className="mt-1 text-muted">Walk-in, no prescription.</p>
          <p className="mt-6 text-sm text-muted">
            Schedule H1 medicines cannot be sold here. The prescription is the
            only route, and the database refuses the rest.
          </p>
        </div>
      }
      rail={
        <>
          {!soldAt ? (
            <>
              <ScanField label="Scan the strip" onCode={(code) => void onCode(code)} />
              <RailButton onClick={() => setSearching(true)}>Search</RailButton>
            </>
          ) : null}

          <div className="rounded-xl border border-line bg-white p-3 text-center">
            <p className="text-sm text-muted">Total</p>
            {/* Large enough to read from the customer's side of the counter. */}
            <p className="tabular text-4xl font-medium" data-testid="sale-total">
              ₹{paiseToRupees(totalPaise)}
            </p>
          </div>

          <RailButton
            tone="primary"
            disabled={basket.length === 0 || busy || soldAt !== null}
            onClick={() => void complete()}
          >
            {soldAt ? (queued ? 'Saved' : 'Sold') : busy ? 'Selling…' : 'Complete sale'}
          </RailButton>

          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Counter sale</h1>

      {flash ? (
        <p role="status" className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          {flash}
        </p>
      ) : null}
      {error ? <p className="mt-4 rounded-lg bg-danger/15 p-3 text-danger">{error}</p> : null}
      {soldAt && !queued ? (
        <p className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          Sold. The ledger has been written and the stock is down.
        </p>
      ) : null}

      {/* Never "sold". The tablet has it; the ledger does not, and saying
          otherwise is a lie in the direction that costs money (rule 6). */}
      {soldAt && queued ? (
        <p className="mt-4 rounded-lg bg-ink/5 p-3">
          Saved on this tablet. The network is not there, so the ledger has not
          been written yet — it goes in on its own when the connection returns.
        </p>
      ) : null}

      {basket.length === 0 && !pending ? (
        <p className="mt-6 text-muted">Scan a strip, or search for the medicine.</p>
      ) : null}

      <ul className="mt-6 max-w-2xl">
        {basket.map((line, index) => (
          <li
            key={`${line.drug.id}-${index}`}
            className="flex items-center gap-4 border-b border-line py-3"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg">
                {line.drug.name}{' '}
                <span className="text-sm text-muted">{line.drug.strength}</span>
                {line.drug.schedule === 'H1' ? (
                  <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-xs text-danger">
                    H1 — needs a prescription
                  </span>
                ) : null}
              </span>
              <span className="tabular block text-sm text-muted">{line.qtyBase} units</span>
            </span>
            <span className="tabular shrink-0 text-lg">₹{paiseToRupees(line.amountPaise)}</span>
            {!soldAt ? (
              <button
                type="button"
                aria-label={`Remove ${line.drug.name}`}
                onClick={() => setBasket((c) => c.filter((_, i) => i !== index))}
                className="h-11 w-11 shrink-0 rounded-lg border border-line text-muted active:bg-line"
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {pending ? (
        <div className="mt-6 max-w-md">
          <p className="text-lg">
            {pending.name} <span className="text-sm text-muted">{pending.strength}</span>{' '}
            <span
              className={`tabular text-sm ${
                stockBadge(pending).out ? 'text-danger' : 'text-ok'
              }`}
            >
              {stockBadge(pending).label}
            </span>
          </p>
          <div className="mt-3">
            <QtyPad
              pack={{
                unitsPerStrip: pending.default_units_per_strip ?? 1,
                stripsPerBox: pending.default_strips_per_box ?? 1,
              }}
              baseUnitLabel={pending.base_unit === 'tablet' ? 'tablets' : pending.base_unit}
              onCommit={(qtyBase) => void addLine(pending, qtyBase)}
              onCancel={() => setPending(null)}
            />
          </div>
        </div>
      ) : null}
    </ThreePane>
  );
}
