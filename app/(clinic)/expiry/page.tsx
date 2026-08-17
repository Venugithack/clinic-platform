'use client';

/**
 * The expiry desk. INVENTORY.md §6.
 *
 * Three things happen here, and the order they are presented in is the whole
 * argument of the section:
 *
 *   1. stock that can still go back to the supplier, soonest deadline first —
 *      and the deadline is not the expiry date, it is months before it;
 *   2. stock that has expired, which no other screen in the build can see,
 *      because availability excludes it by design;
 *   3. credits the supplier owes and has not yet paid, ageing, so they are
 *      netted off an invoice instead of quietly forgotten.
 *
 * The screen labels which batches are past their return window. It does not
 * enforce it: the button is live either way and the refusal comes from the
 * database, so the pharmacist is told the actual reason and the date it passed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import {
  expiredStock,
  expiringSoon,
  invoicesForSupplier,
  openCredits,
  type ExpiredBatch,
  type ExpiringBatch,
  type OpenCredit,
  type SupplierInvoice,
} from '@/lib/db/expiry';
import { returnToSupplier, settleCredit, writeOffExpired } from '@/lib/transitions/expiry';

/** "Mar 2027" — as printed on the strip (PLAN.md §12.3). */
function asPrinted(date: string): string {
  return new Date(date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function asDay(date: string): string {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function rupees(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}

export default function ExpiryPage() {
  const router = useRouter();
  const [expiring, setExpiring] = useState<ExpiringBatch[]>([]);
  const [expired, setExpired] = useState<ExpiredBatch[]>([]);
  const [credits, setCredits] = useState<OpenCredit[]>([]);
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const [credit, setCredit] = useState<OpenCredit | null>(null);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null);
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
        const soon = await expiringSoon();
        const gone = await expiredStock();
        setExpiring(soon);
        setExpired(gone);
        setCredits(await openCredits());

        // Prune the selection rather than clearing it. Three fetches land after
        // the screen is already usable, and a blanket reset silently discards a
        // tap made while they were in flight — which on a tablet looks exactly
        // like the button not working. Batches that have gone (returned, written
        // off) drop out; everything else the pharmacist chose survives.
        const alive = new Set([
          ...soon.map((row) => row.batch_id),
          ...gone.map((row) => row.batch_id),
        ]);
        setSelected((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([batchId]) => alive.has(batchId)),
          ),
        );
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const batchIds = Object.keys(selected);
  const suppliers = new Set(Object.values(selected));
  // One return note goes to one supplier. That is a property of the paperwork,
  // not a rule of the business, so the screen resolves it rather than the
  // database refusing it later.
  const oneSupplier = suppliers.size === 1 && !suppliers.has(null);
  const supplierId = oneSupplier ? (Object.values(selected)[0] as string) : null;
  const supplierName =
    [...expiring, ...expired].find((row) => row.supplier_id === supplierId)?.supplier_name ??
    'supplier';

  const toggle = (batchId: string, supplier: string | null) =>
    setSelected((current) => {
      const next = { ...current };
      if (batchId in next) delete next[batchId];
      else next[batchId] = supplier;
      return next;
    });

  const selectedValue = [...expiring, ...expired]
    .filter((row) => row.batch_id in selected)
    .reduce((sum, row) => sum + Number(row.value_at_cost), 0);

  const doReturn = async () => {
    if (!supplierId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const note = await returnToSupplier(
        batchIds.map((batchId) => ({ batchId })),
        supplierId,
      );
      setNotice(
        `Returned to ${supplierName}. ${rupees(Number(note.total_at_cost))} credit opened — it is on the list below until an invoice nets it off.`,
      );
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doWriteOff = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const value = await writeOffExpired(batchIds.map((batchId) => ({ batchId })));
      setNotice(`Written off. ${rupees(value)} at cost — the loss is recorded, not hidden.`);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openCreditPanel = async (row: OpenCredit) => {
    setCredit(row);
    setInvoice(null);
    setDigits(String(Math.floor(Number(row.outstanding))));
    setInvoices(await invoicesForSupplier(row.supplier_id));
  };

  const doSettle = async () => {
    if (!credit || !invoice) return;
    setBusy(true);
    setError(null);
    try {
      await settleCredit(credit.credit_id, invoice.id, Number(digits || '0'));
      setNotice(`${rupees(Number(digits || '0'))} netted off ${invoice.invoice_no ?? 'that invoice'}.`);
      setCredit(null);
      setInvoice(null);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const atRisk = expiring.reduce((sum, row) => sum + Number(row.value_at_cost), 0);
  const lost = expired.reduce((sum, row) => sum + Number(row.value_at_cost), 0);

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Expiry</h2>
          <p className="tabular mt-1 text-lg">{rupees(atRisk)} at risk</p>
          <p className="tabular mt-1 text-sm text-muted">
            {rupees(lost)} already expired
          </p>

          <p className="mt-6 text-sm text-muted">
            Suppliers want stock back months before it expires, and the window
            differs per supplier. This list is ordered by whose window closes
            first — not by expiry date, which is always too late.
          </p>

          {batchIds.length > 0 ? (
            <p className="tabular mt-6 rounded-lg bg-ink/5 p-3 text-sm">
              {batchIds.length} batch{batchIds.length === 1 ? '' : 'es'} selected ·{' '}
              {rupees(selectedValue)}
            </p>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || batchIds.length === 0 || !oneSupplier}
            onClick={() => void doReturn()}
          >
            {oneSupplier ? `Return to ${supplierName}` : 'Return to supplier'}
          </RailButton>

          <RailButton
            tone="danger"
            disabled={busy || batchIds.length === 0}
            onClick={() => void doWriteOff()}
          >
            Write off
          </RailButton>

          {batchIds.length > 0 && !oneSupplier ? (
            <p className="text-sm text-muted">
              One supplier per return note. Deselect the others.
            </p>
          ) : null}

          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Expiry</h1>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          {notice}
        </p>
      ) : null}

      {/* 1 — what can still go back, soonest deadline first. */}
      <h2 className="mt-6 text-lg font-medium">Closing first</h2>
      {expiring.length === 0 ? (
        <p className="mt-2 text-muted">Nothing is near a return deadline.</p>
      ) : null}

      <ul className="mt-2 max-w-4xl">
        {expiring.map((row) => (
          <li key={row.batch_id}>
            <button
              type="button"
              aria-pressed={row.batch_id in selected}
              onClick={() => toggle(row.batch_id, row.supplier_id)}
              className={`flex h-20 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line ${
                row.batch_id in selected ? 'bg-ink/5' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{row.drug_name}</span>
                <span className="tabular block text-sm text-muted">
                  {row.batch_no} · exp {asPrinted(row.expiry)} · {row.qty_base_on_hand} units
                </span>
              </span>

              <span className="w-44 shrink-0 text-sm">
                {row.returnable ? (
                  <>
                    <span className="block text-ok">
                      Return by {asDay(row.return_by as string)}
                    </span>
                    <span className="tabular block text-muted">
                      {row.days_to_return_by} days left · {row.supplier_name}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block text-danger">Window closed</span>
                    <span className="block text-muted">
                      {row.return_by ? asDay(row.return_by) : 'no window recorded'}
                    </span>
                  </>
                )}
              </span>

              <span className="tabular w-24 shrink-0 text-right text-lg">
                {rupees(Number(row.value_at_cost))}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* 2 — the stock no other screen can see. */}
      <h2 className="mt-8 text-lg font-medium">Expired</h2>
      <p className="mt-1 text-sm text-muted">
        Excluded from availability, so this is the only screen it appears on.
      </p>
      {expired.length === 0 ? (
        <p className="mt-2 text-muted">Nothing expired on the shelf.</p>
      ) : null}

      <ul className="mt-2 max-w-4xl">
        {expired.map((row) => (
          <li key={row.batch_id}>
            <button
              type="button"
              aria-pressed={row.batch_id in selected}
              onClick={() => toggle(row.batch_id, row.supplier_id)}
              className={`flex h-20 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line ${
                row.batch_id in selected ? 'bg-ink/5' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{row.drug_name}</span>
                <span className="tabular block text-sm text-muted">
                  {row.batch_no} · expired {asPrinted(row.expiry)} · {row.qty_base_on_hand} units
                </span>
              </span>
              <span className="tabular w-24 shrink-0 text-right text-lg text-danger">
                {rupees(Number(row.value_at_cost))}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* 3 — money the supplier owes. */}
      <h2 className="mt-8 text-lg font-medium">Credits owed to the clinic</h2>
      {credits.length === 0 ? (
        <p className="mt-2 text-muted">Nothing outstanding.</p>
      ) : null}

      <ul className="mt-2 max-w-4xl">
        {credits.map((row) => (
          <li key={row.credit_id}>
            <button
              type="button"
              onClick={() => void openCreditPanel(row)}
              className="flex h-16 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line"
            >
              <span className="flex-1 truncate text-lg">{row.supplier_name}</span>
              <span className="tabular shrink-0 text-sm text-muted">
                {row.days_open} days old
              </span>
              <span className="tabular w-28 shrink-0 text-right text-lg">
                {rupees(Number(row.outstanding))}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {credit ? (
        <div className="mt-6 max-w-xl rounded-xl border border-line bg-white p-4">
          <p className="text-lg">
            {credit.supplier_name} ·{' '}
            <span className="tabular">{rupees(Number(credit.outstanding))}</span> outstanding
          </p>
          <p className="mt-1 text-sm text-muted">
            Net it off one of their invoices. Part of it is fine — the rest stays
            on the list.
          </p>

          <ul className="mt-3">
            {invoices.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-pressed={invoice?.id === row.id}
                  onClick={() => setInvoice(row)}
                  className={`flex h-14 w-full items-center gap-3 border-b border-line px-2 text-left active:bg-line ${
                    invoice?.id === row.id ? 'bg-ink/5' : ''
                  }`}
                >
                  <span className="flex-1 truncate">
                    {row.invoice_no ?? 'awaiting invoice'}
                  </span>
                  <span className="tabular text-sm text-muted">
                    {rupees(Number(row.total))}
                  </span>
                </button>
              </li>
            ))}
            {invoices.length === 0 ? (
              <li className="py-3 text-muted">
                No receipts from this supplier yet — the credit waits.
              </li>
            ) : null}
          </ul>

          {invoice ? (
            <>
              <p className="tabular mt-4 text-3xl font-medium">₹{digits || '0'}</p>
              <div className="mt-3 w-64">
                <Numpad
                  onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 7))}
                  onBackspace={() => setDigits((c) => c.slice(0, -1))}
                />
              </div>
              <button
                type="button"
                disabled={busy || digits === ''}
                onClick={() => void doSettle()}
                className="mt-4 h-14 w-full rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
              >
                Settle
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </ThreePane>
  );
}
