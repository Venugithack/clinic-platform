'use client';

/**
 * Billing, at the counter. PLAN.md §8 M4, TABLET.md §7.
 *
 * The screen is built around the one thing that actually goes wrong at a
 * pharmacy counter: **medicine leaves and no money arrives.** So the first list
 * is not today's bills, it is dispenses with no bill against them — a worklist
 * that empties, rather than a log that grows.
 *
 * The till sits in the context pane, permanently, for the same reason. Whether
 * a drawer is open decides whether cash can be taken at all, and the refusal
 * comes from the database — this screen shows the state so nobody is surprised
 * by it, and does not enforce it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import {
  billsToday,
  clinicSettings,
  getBill,
  openTill as readOpenTill,
  unbilledDispenses,
  type Bill,
  type ClinicSettings,
  type TillReconciliation,
  type UnbilledDispense,
} from '@/lib/db/billing';
import {
  closeTill,
  openTill as startTill,
  raiseBill,
  takePayment,
} from '@/lib/transitions/billing';
import { paiseToRupees } from '@/lib/units';

const METHODS = ['cash', 'upi', 'card'] as const;

/** Money is typed the way a till is typed: digits fill in from the paise. */
function rupees(paise: string): number {
  return Number(paise || '0') / 100;
}

export default function BillingPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [till, setTill] = useState<TillReconciliation | null>(null);
  const [unbilled, setUnbilled] = useState<UnbilledDispense[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);

  const [picked, setPicked] = useState<UnbilledDispense | null>(null);
  const [withConsult, setWithConsult] = useState(false);
  const [discount, setDiscount] = useState('');
  const [raised, setRaised] = useState<Bill | null>(null);

  const [pad, setPad] = useState<'discount' | 'float' | 'count' | null>(null);
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        setSettings(await clinicSettings());
        setTill(await readOpenTill());
        setUnbilled(await unbilledDispenses());
        setBills(await billsToday());
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const raise = async () => {
    setBusy(true);
    setError(null);
    try {
      const bill = await raiseBill({
        patientId: picked?.patient_id ?? undefined,
        encounterId: picked?.encounter_id ?? undefined,
        dispenseIds: picked ? [picked.id] : [],
        // Against a visit, the fee is left to clinic policy — that is what lets
        // a free follow-up apply. Without one there is no visit to apply policy
        // to, so ticking the box means the standard fee, deliberately, by a
        // person. Unticked means no consultation on this bill at all.
        consultFee: withConsult
          ? picked?.encounter_id
            ? undefined
            : Number(settings?.consult_fee ?? 0)
          : 0,
        discount: rupees(discount),
      });
      // The transition hands back the bill row. Its lines are a read.
      setRaised(await getBill(bill.id));
      setPicked(null);
      setDiscount('');
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pay = async (method: (typeof METHODS)[number]) => {
    if (!raised) return;
    setBusy(true);
    setError(null);
    try {
      const paid = await takePayment(raised.id, method, Number(raised.total));
      setRaised(await getBill(paid.id));
      setNotice(`${paid.bill_no} settled — ₹${Number(paid.total).toFixed(2)} by ${method}.`);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doTill = async (action: 'open' | 'close') => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'open') {
        await startTill(rupees(cash));
        setNotice('Till open. Cash can be taken.');
      } else if (till) {
        const closed = await closeTill(till.till_id, rupees(cash));
        const variance = Number(closed.variance);
        setNotice(
          variance === 0
            ? 'Till closed and square.'
            : `Till closed ₹${Math.abs(variance).toFixed(2)} ${
                variance < 0 ? 'short' : 'over'
              } — recorded as it stands.`,
        );
      }
      setCash('');
      setPad(null);
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
          <h2 className="text-sm uppercase tracking-wide text-muted">Till</h2>

          {till ? (
            <>
              <p className="tabular mt-1 text-2xl">
                ₹{Number(till.expected_cash).toFixed(2)}
              </p>
              <p className="text-sm text-muted">expected in the drawer</p>
              <p className="tabular mt-3 text-sm text-muted">
                opened {new Date(till.opened_at).toLocaleTimeString('en-IN')} with ₹
                {Number(till.opening_float).toFixed(2)}
                {till.opened_by_name ? ` by ${till.opened_by_name}` : ''}
              </p>
              <p className="tabular mt-1 text-sm text-muted">
                ₹{Number(till.cash_sales).toFixed(2)} taken
                {Number(till.pay_outs) !== 0
                  ? ` · ₹${Math.abs(Number(till.pay_outs)).toFixed(2)} paid out`
                  : ''}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg">Closed</p>
              <p className="mt-1 text-sm text-muted">
                Cash cannot be taken until a drawer is open to put it in. Card and
                UPI are unaffected.
              </p>
            </>
          )}

          <h2 className="mt-8 text-sm uppercase tracking-wide text-muted">Today</h2>
          <p className="tabular mt-1 text-lg">
            {bills.filter((bill) => bill.status !== 'cancelled').length} bill
            {bills.filter((bill) => bill.status !== 'cancelled').length === 1 ? '' : 's'}
          </p>
          <p className="tabular text-sm text-muted">
            ₹
            {bills
              .filter((bill) => bill.status !== 'cancelled')
              .reduce((sum, bill) => sum + Number(bill.total), 0)
              .toFixed(2)}
          </p>
        </div>
      }
      rail={
        <>
          {!till ? (
            <RailButton
              tone="primary"
              disabled={busy}
              onClick={() => {
                setPad('float');
                setCash('');
              }}
            >
              Open till
            </RailButton>
          ) : (
            <RailButton
              disabled={busy}
              onClick={() => {
                setPad('count');
                setCash('');
              }}
            >
              Close till
            </RailButton>
          )}
          <RailButton onClick={() => router.push('/day-book')}>Day-book</RailButton>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Billing</h1>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          {notice}
        </p>
      ) : null}

      {/* The till pad: opening float, or the closing count. */}
      {pad === 'float' || pad === 'count' ? (
        <div className="mt-4 max-w-md rounded-xl border border-line bg-white p-4">
          <p className="text-lg">
            {pad === 'float' ? 'Cash in the drawer to start with' : 'Count the drawer'}
          </p>
          {pad === 'count' && till ? (
            <p className="mt-1 text-sm text-muted">
              Count it before you look: the expectation is on the left, and a
              drawer counted to match it proves nothing.
            </p>
          ) : null}
          <p className="tabular mt-3 text-4xl font-medium">₹{paiseToRupees(Number(cash || '0'))}</p>
          <div className="mt-4 w-64">
            <Numpad
              onDigit={(digit) => setCash((c) => (c + digit).slice(0, 8))}
              onBackspace={() => setCash((c) => c.slice(0, -1))}
            />
          </div>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={busy || cash === ''}
              onClick={() => void doTill(pad === 'float' ? 'open' : 'close')}
              className="h-14 flex-1 rounded-xl border border-ink bg-ink px-4 font-medium text-white disabled:opacity-40"
            >
              {/* Not "Open till" again: the rail button is already called that,
                  and two controls with one name is the accessibility bug this
                  build has now made twice. */}
              {pad === 'float' ? 'Open with this float' : 'Close and record'}
            </button>
            <button
              type="button"
              onClick={() => setPad(null)}
              className="h-14 rounded-xl border border-line px-5 text-muted active:bg-line"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* The bill just raised, and its payment. */}
      {raised ? (
        <div className="mt-6 max-w-xl rounded-xl border border-ink bg-white p-4">
          <div className="flex items-baseline justify-between">
            <p className="tabular text-lg">{raised.bill_no}</p>
            <p className="tabular text-3xl font-medium">
              ₹{Number(raised.total).toFixed(2)}
            </p>
          </div>

          <ul className="mt-3">
            {raised.lines.map((line) => (
              <li key={line.id} className="flex gap-3 border-b border-line py-2 text-sm">
                <span className="flex-1">{line.description}</span>
                {line.qty_base ? (
                  <span className="tabular text-muted">{line.qty_base}</span>
                ) : null}
                <span className="tabular w-20 text-right">
                  ₹{Number(line.amount).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          {Number(raised.round_off) !== 0 ? (
            <p className="tabular mt-2 text-sm text-muted">
              rounded down ₹{Math.abs(Number(raised.round_off)).toFixed(2)}
            </p>
          ) : null}

          {raised.status === 'unpaid' ? (
            <div className="mt-4 flex gap-3">
              {METHODS.map((method) => (
                <button
                  key={method}
                  type="button"
                  disabled={busy}
                  onClick={() => void pay(method)}
                  className="h-14 flex-1 rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
                >
                  {method === 'upi' ? 'UPI' : method[0]?.toUpperCase() + method.slice(1)}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-ok">Paid by {raised.method}.</p>
          )}

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => router.push(`/bill/${raised.id}/print` as Route)}
              className="h-14 flex-1 rounded-xl border border-line px-4 active:bg-line"
            >
              Print
            </button>
            <button
              type="button"
              onClick={() => setRaised(null)}
              className="h-14 rounded-xl border border-line px-5 text-muted active:bg-line"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* The worklist: medicine that has left with no bill against it. */}
      <h2 className="mt-8 text-lg font-medium">Not yet billed</h2>
      {unbilled.length === 0 ? (
        <p className="mt-2 text-muted">
          Everything dispensed has a bill against it.
        </p>
      ) : null}

      <ul className="mt-2 max-w-3xl">
        {unbilled.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              aria-pressed={picked?.id === row.id}
              onClick={() => {
                setPicked(row);
                setRaised(null);
                setWithConsult(!row.is_counter_sale);
              }}
              className={`flex h-16 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line ${
                picked?.id === row.id ? 'bg-ink/5' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{row.patient_name}</span>
                <span className="tabular block text-sm text-muted">
                  {row.lines} item{row.lines === 1 ? '' : 's'} ·{' '}
                  {new Date(row.at).toLocaleTimeString('en-IN')}
                  {row.is_counter_sale ? ' · counter sale' : ''}
                </span>
              </span>
              <span className="tabular shrink-0 text-lg">
                ₹{row.amount.toFixed(2)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {picked ? (
        <div className="mt-6 max-w-xl rounded-xl border border-line bg-white p-4">
          <p className="text-lg">{picked.patient_name}</p>
          <p className="tabular text-sm text-muted">
            ₹{picked.amount.toFixed(2)} of medicines
          </p>

          <button
            type="button"
            aria-pressed={withConsult}
            onClick={() => setWithConsult((current) => !current)}
            className={`mt-3 h-14 w-full rounded-xl border px-3 text-left ${
              withConsult ? 'border-ink bg-ink/5' : 'border-line'
            }`}
          >
            Add the consultation
            <span className="tabular block text-sm text-muted">
              ₹{Number(settings?.consult_fee ?? 0).toFixed(2)}
              {settings?.follow_up_free_days
                ? ` · free within ${settings.follow_up_free_days} days of the last paid visit`
                : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setPad(pad === 'discount' ? null : 'discount')}
            className="mt-3 h-14 w-full rounded-xl border border-line px-3 text-left"
          >
            Discount
            <span className="tabular block text-sm text-muted">
              ₹{paiseToRupees(Number(discount || '0'))}
            </span>
          </button>

          {pad === 'discount' ? (
            <div className="mt-3 w-64">
              <Numpad
                onDigit={(digit) => setDiscount((c) => (c + digit).slice(0, 7))}
                onBackspace={() => setDiscount((c) => c.slice(0, -1))}
              />
            </div>
          ) : null}

          <button
            type="button"
            disabled={busy}
            onClick={() => void raise()}
            className="mt-4 h-14 w-full rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
          >
            Raise bill
          </button>
        </div>
      ) : null}

      {/* The day's bills, for finding one again. */}
      <h2 className="mt-8 text-lg font-medium">Today&rsquo;s bills</h2>
      {bills.length === 0 ? <p className="mt-2 text-muted">None yet.</p> : null}

      <ul className="mt-2 max-w-3xl">
        {bills.map((bill) => (
          <li key={bill.id}>
            <button
              type="button"
              onClick={() => router.push(`/bill/${bill.id}/print` as Route)}
              className="flex h-14 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line"
            >
              <span className="tabular w-32 shrink-0 text-sm text-muted">
                {bill.bill_no}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {bill.patient_name ?? 'Counter sale'}
              </span>
              <span
                className={`shrink-0 text-sm ${
                  bill.status === 'paid'
                    ? 'text-ok'
                    : bill.status === 'cancelled'
                      ? 'text-muted line-through'
                      : 'text-danger'
                }`}
              >
                {bill.status === 'paid' ? bill.method : bill.status}
              </span>
              <span className="tabular w-24 shrink-0 text-right">
                ₹{Number(bill.total).toFixed(2)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
