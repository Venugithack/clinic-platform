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
import { Notice, PageHeader } from '@/components/ui';
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
  voidBill,
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

  const [voiding, setVoiding] = useState<Bill | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const [pad, setPad] = useState<'discount' | 'float' | 'count' | null>(null);
  const [cash, setCash] = useState('');
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
        setSettings(await clinicSettings());
        setTill(await readOpenTill());
        setUnbilled(await unbilledDispenses());
        setBills(await billsToday());
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

  /**
   * Cancelling a bill.
   *
   * The screen does not decide who may do this or whether the drawer is open —
   * `app.void_bill` refuses a paid bill from the counter (that is a refund) and
   * refuses a cash refund with no till open (it has to come out of a drawer
   * somebody is counting). Both refusals arrive as sentences, which is the only
   * way the pharmacist learns the real reason rather than the screen's guess.
   */
  const doVoid = async () => {
    if (!voiding) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cancelled = await voidBill(voiding.id, voidReason.trim());
      setVoiding(null);
      setVoidReason('');
      setNotice(
        `${cancelled.bill_no} is cancelled. The medicines on it are billable again; the stock is not back on the shelf.`,
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
          <h2 className="eyebrow">Till</h2>

          {till ? (
            <>
              <p className="tabular mt-1 text-2xl">
                ₹{Number(till.expected_cash).toFixed(2)}
              </p>
              <p className="text-sm text-ink-2">expected in the drawer</p>
              <p className="tabular mt-3 text-sm text-ink-2">
                opened {new Date(till.opened_at).toLocaleTimeString('en-IN')} with ₹
                {Number(till.opening_float).toFixed(2)}
                {till.opened_by_name ? ` by ${till.opened_by_name}` : ''}
              </p>
              <p className="tabular mt-1 text-sm text-ink-2">
                ₹{Number(till.cash_sales).toFixed(2)} taken
                {Number(till.pay_outs) !== 0
                  ? ` · ₹${Math.abs(Number(till.pay_outs)).toFixed(2)} paid out`
                  : ''}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg">Closed</p>
              <p className="mt-1 text-sm text-ink-2">
                Cash cannot be taken until a drawer is open to put it in. Card and
                UPI are unaffected.
              </p>
            </>
          )}

          <h2 className="eyebrow mt-8">Today</h2>
          <p className="tabular mt-1 text-lg">
            {bills.filter((bill) => bill.status !== 'cancelled').length} bill
            {bills.filter((bill) => bill.status !== 'cancelled').length === 1 ? '' : 's'}
          </p>
          <p className="tabular font-mono text-sm text-ink-2">
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
      <PageHeader eyebrow="Counter" title="Billing" />

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {/* The till pad: opening float, or the closing count. */}
      {pad === 'float' || pad === 'count' ? (
        <div className="mt-4 max-w-md rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">
            {pad === 'float' ? 'Cash in the drawer to start with' : 'Count the drawer'}
          </p>
          {pad === 'count' && till ? (
            <p className="mt-1 text-sm text-ink-2">
              Count it before you look: the expectation is on the left, and a
              drawer counted to match it proves nothing.
            </p>
          ) : null}
          <p className="tabular font-mono mt-3 text-4xl font-medium">₹{paiseToRupees(Number(cash || '0'))}</p>
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
              className="h-14 flex-1 rounded-box border border-ink bg-ink px-4 font-medium text-paper disabled:opacity-40"
            >
              {/* Not "Open till" again: the rail button is already called that,
                  and two controls with one name is the accessibility bug this
                  build has now made twice. */}
              {pad === 'float' ? 'Open with this float' : 'Close and record'}
            </button>
            <button
              type="button"
              onClick={() => setPad(null)}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* The bill just raised, and its payment. */}
      {raised ? (
        <div className="mt-6 max-w-xl rounded-box border border-ink bg-sheet p-4">
          <div className="flex items-baseline justify-between">
            <p className="tabular text-lg">{raised.bill_no}</p>
            <p className="tabular font-mono text-3xl font-medium">
              ₹{Number(raised.total).toFixed(2)}
            </p>
          </div>

          <ul className="mt-3">
            {raised.lines.map((line) => (
              <li key={line.id} className="flex gap-3 border-b border-rule py-2 text-sm">
                <span className="flex-1">{line.description}</span>
                {line.qty_base ? (
                  <span className="tabular text-ink-2">{line.qty_base}</span>
                ) : null}
                <span className="tabular w-20 text-right">
                  ₹{Number(line.amount).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          {Number(raised.round_off) !== 0 ? (
            <p className="tabular mt-2 text-sm text-ink-2">
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
                  className="h-14 flex-1 rounded-box border border-ink bg-ink font-medium text-paper disabled:opacity-40"
                >
                  {method === 'upi' ? 'UPI' : method[0]?.toUpperCase() + method.slice(1)}
                </button>
              ))}
            </div>
          ) : (
            <Notice tone="good">Paid by {raised.method}.</Notice>
          )}

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => router.push(`/bill/print?bill=${raised.id}` as Route)}
              className="h-14 flex-1 rounded-box border border-rule px-4 active:bg-paper-2"
            >
              Print
            </button>
            <button
              type="button"
              onClick={() => setRaised(null)}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* The worklist: medicine that has left with no bill against it. */}
      <h2 className="mt-8 text-lg font-medium">Not yet billed</h2>
      {unbilled.length === 0 ? (
        <p className="mt-2 text-ink-2">
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
              className={`flex h-16 w-full items-center gap-4 border-b border-rule px-3 text-left active:bg-paper-2 ${
                picked?.id === row.id ? 'bg-paper-2' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{row.patient_name}</span>
                <span className="tabular block text-sm text-ink-2">
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
        <div className="mt-6 max-w-xl rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">{picked.patient_name}</p>
          <p className="tabular text-sm text-ink-2">
            ₹{picked.amount.toFixed(2)} of medicines
          </p>

          <button
            type="button"
            aria-pressed={withConsult}
            onClick={() => setWithConsult((current) => !current)}
            className={`mt-3 h-14 w-full rounded-box border px-3 text-left ${
              withConsult ? 'border-ink bg-paper-2' : 'border-rule'
            }`}
          >
            Add the consultation
            <span className="tabular block text-sm text-ink-2">
              ₹{Number(settings?.consult_fee ?? 0).toFixed(2)}
              {settings?.follow_up_free_days
                ? ` · free within ${settings.follow_up_free_days} days of the last paid visit`
                : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setPad(pad === 'discount' ? null : 'discount')}
            className="mt-3 h-14 w-full rounded-box border border-rule px-3 text-left"
          >
            Discount
            <span className="tabular block text-sm text-ink-2">
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
            className="mt-4 h-14 w-full rounded-box border border-ink bg-ink font-medium text-paper disabled:opacity-40"
          >
            Raise bill
          </button>
        </div>
      ) : null}

      {/* The day's bills, for finding one again — and for cancelling one.
          `app.void_bill` was written and tested in M4 and no screen called it
          for two milestones, which is a feature the clinic did not have. */}
      <h2 className="mt-8 text-lg font-medium">Today&rsquo;s bills</h2>
      {bills.length === 0 ? <p className="mt-2 text-ink-2">None yet.</p> : null}

      <ul className="mt-2 max-w-3xl">
        {bills.map((bill) => (
          <li key={bill.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/bill/print?bill=${bill.id}` as Route)}
              className="flex h-14 min-w-0 flex-1 items-center gap-4 border-b border-rule px-3 text-left active:bg-paper-2"
            >
              <span className="tabular w-32 shrink-0 text-sm text-ink-2">
                {bill.bill_no}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {bill.patient_name ?? 'Counter sale'}
              </span>
              <span
                className={`shrink-0 text-sm ${
                  bill.status === 'paid'
                    ? 'text-free'
                    : bill.status === 'cancelled'
                      ? 'text-ink-2 line-through'
                      : 'text-stop'
                }`}
              >
                {bill.status === 'paid' ? bill.method : bill.status}
              </span>
              <span className="tabular font-mono w-24 shrink-0 text-right">
                ₹{Number(bill.total).toFixed(2)}
              </span>
            </button>

            {bill.status === 'cancelled' ? null : (
              <button
                type="button"
                aria-label={`Cancel bill ${bill.bill_no}`}
                onClick={() => {
                  setVoiding(voiding?.id === bill.id ? null : bill);
                  setVoidReason('');
                }}
                className="h-14 shrink-0 rounded-box border border-stop bg-sheet px-4 text-sm text-stop active:bg-paper-2"
              >
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>

      {voiding ? (
        <div className="mt-4 max-w-3xl rounded-box border border-stop bg-sheet p-4">
          <h3 className="text-lg font-medium">Cancel {voiding.bill_no}?</h3>

          <p className="mt-1 text-sm text-ink-2">
            {voiding.status === 'paid'
              ? `₹${Number(voiding.total).toFixed(2)} has been paid${
                  voiding.method === 'cash'
                    ? ' in cash — cancelling it is a refund out of the open drawer, and only the doctor can do that'
                    : ' — cancelling it is a refund'
                }.`
              : 'Nothing has been paid on it yet.'}{' '}
            The medicines do <strong>not</strong> come back into stock: what left
            the counter returns through the ledger or not at all.
          </p>

          <label className="mt-3 block">
            <span className="block text-sm text-ink-2">
              Why — it goes on the record
            </span>
            <input
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              aria-label="Reason"
              placeholder="billed to the wrong patient"
              className="blank mt-1 h-14 w-full px-3 text-lg"
            />
          </label>

          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy || voidReason.trim() === ''}
              onClick={() => void doVoid()}
              className="h-14 flex-1 rounded-box border border-stop bg-stop font-medium text-paper disabled:opacity-40"
            >
              Cancel this bill
            </button>
            <button
              type="button"
              onClick={() => setVoiding(null)}
              className="h-14 flex-1 rounded-box border border-rule bg-sheet active:bg-paper-2"
            >
              Leave it alone
            </button>
          </div>
        </div>
      ) : null}
    </ThreePane>
  );
}
