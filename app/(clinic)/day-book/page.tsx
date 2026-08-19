'use client';

/**
 * The day-book and the cash day-close. PLAN.md §8 M4.
 *
 * Two numbers on this screen look similar and are not:
 *
 *   the day's total    derived from the bills. It cannot disagree with them,
 *                      and if it ever did the bug would be in a view
 *   the variance       counted cash minus expected cash. It CAN disagree, it
 *                      is supposed to be able to, and it is the only thing a
 *                      till tells you that you did not already know
 *
 * So the variance is never hidden, never rounded away and never "corrected".
 * A drawer that is fifty rupees short every Tuesday is a fact about a Tuesday.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import {
  dayBook,
  openTill as readOpenTill,
  recentTills,
  type DayBookRow,
  type TillReconciliation,
} from '@/lib/db/billing';
import { recordCash } from '@/lib/transitions/billing';
import { paiseToRupees } from '@/lib/units';

const money = (value: number | string) => `₹${Number(value).toFixed(2)}`;

export default function DayBookPage() {
  const router = useRouter();
  const [days, setDays] = useState<DayBookRow[]>([]);
  const [tills, setTills] = useState<TillReconciliation[]>([]);
  const [open, setOpen] = useState<TillReconciliation | null>(null);
  const [kind, setKind] = useState<'payin' | 'payout' | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
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
        setDays(await dayBook());
        setTills(await recentTills());
        setOpen(await readOpenTill());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const today = days[0];

  const submitCash = async () => {
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      await recordCash(kind, Number(amount || '0') / 100, reason);
      setNotice(
        `${kind === 'payin' ? 'Added to' : 'Taken from'} the drawer: ₹${paiseToRupees(
          Number(amount || '0'),
        )} — ${reason}`,
      );
      setKind(null);
      setAmount('');
      setReason('');
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
          <h2 className="eyebrow">Today</h2>
          {today ? (
            <>
              <p className="tabular mt-1 text-3xl font-medium" data-testid="day-total">
                {money(today.net_total)}
              </p>
              <p className="tabular text-sm text-ink-2">
                {today.bills} bill{today.bills === 1 ? '' : 's'}
                {today.cancelled > 0 ? ` · ${today.cancelled} cancelled` : ''}
              </p>
              <dl className="tabular mt-6 text-sm">
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">Consultations</dt>
                  <dd>{money(today.consult_total)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">Medicines</dt>
                  <dd>{money(today.medicines_total)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">Discount</dt>
                  <dd>− {money(today.discount)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">Round off</dt>
                  <dd>{Number(today.round_off).toFixed(2)}</dd>
                </div>
                <div className="mt-2 flex justify-between border-t border-rule py-1">
                  <dt className="text-ink-2">Cash</dt>
                  <dd>{money(today.cash)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">UPI</dt>
                  <dd>{money(today.upi)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-2">Card</dt>
                  <dd>{money(today.card)}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-stop">Unpaid</dt>
                  <dd className="text-stop">{money(today.unpaid)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="mt-1 text-ink-2">Nothing billed today yet.</p>
          )}
        </div>
      }
      rail={
        <>
          <RailButton
            disabled={!open || busy}
            onClick={() => {
              setKind('payin');
              setAmount('');
              setReason('');
            }}
          >
            Cash in
          </RailButton>
          <RailButton
            disabled={!open || busy}
            onClick={() => {
              setKind('payout');
              setAmount('');
              setReason('');
            }}
          >
            Cash out
          </RailButton>
          <RailButton onClick={() => router.push('/billing')}>Billing</RailButton>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Counter" title="Day-book" />

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {kind ? (
        <div className="mt-4 max-w-md rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">
            {kind === 'payin' ? 'Cash into the drawer' : 'Cash out of the drawer'}
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Petty cash left unrecorded looks exactly like a shortfall at closing
            time, which is why the reason is not optional.
          </p>
          <p className="tabular mt-3 text-3xl font-medium">
            ₹{paiseToRupees(Number(amount || '0'))}
          </p>
          <div className="mt-3 w-64">
            <Numpad
              onDigit={(digit) => setAmount((c) => (c + digit).slice(0, 7))}
              onBackspace={() => setAmount((c) => c.slice(0, -1))}
            />
          </div>
          <label className="mt-4 block text-sm text-ink-2" htmlFor="reason">
            Reason
          </label>
          <input
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="blank mt-1 h-14 w-full px-3 text-lg"
          />
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={busy || amount === '' || reason.trim() === ''}
              onClick={() => void submitCash()}
              className="h-14 flex-1 rounded-box border border-ink bg-ink font-medium text-paper disabled:opacity-40"
            >
              Record
            </button>
            <button
              type="button"
              onClick={() => setKind(null)}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Tills</h2>
      <div className="min-w-0 overflow-x-auto">
        <table className="mt-2 w-full max-w-3xl">
        <thead>
          <tr className="border-b border-rule text-left text-sm text-ink-2">
            <th className="py-2">Opened</th>
            <th>By</th>
            <th className="text-right">Float</th>
            <th className="text-right">Taken</th>
            <th className="text-right">Expected</th>
            <th className="text-right">Counted</th>
            <th className="text-right">Variance</th>
          </tr>
        </thead>
        <tbody>
          {tills.map((till) => (
            <tr key={till.till_id} className="border-b border-rule">
              <td className="tabular py-3 text-sm">
                {new Date(till.opened_at).toLocaleDateString('en-IN')}{' '}
                {new Date(till.opened_at).toLocaleTimeString('en-IN')}
              </td>
              <td className="text-sm">{till.opened_by_name ?? '—'}</td>
              <td className="tabular text-right">{money(till.opening_float)}</td>
              <td className="tabular text-right">{money(till.cash_sales)}</td>
              <td className="tabular text-right">{money(till.expected_cash)}</td>
              <td className="tabular text-right">
                {till.counted_cash === null ? (
                  <span className="text-ink-2">open</span>
                ) : (
                  money(till.counted_cash)
                )}
              </td>
              <td
                className={`tabular text-right ${
                  till.variance === null
                    ? 'text-ink-2'
                    : Number(till.variance) === 0
                      ? 'text-free'
                      : 'text-stop'
                }`}
                data-testid={`variance-${till.till_id}`}
              >
                {till.variance === null ? '—' : money(till.variance)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2 className="mt-8 text-lg font-medium">The last fortnight</h2>
      <div className="min-w-0 overflow-x-auto">
        <table className="mt-2 w-full max-w-3xl">
        <thead>
          <tr className="border-b border-rule text-left text-sm text-ink-2">
            <th className="py-2">Day</th>
            <th className="text-right">Bills</th>
            <th className="text-right">Consults</th>
            <th className="text-right">Medicines</th>
            <th className="text-right">Discount</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day} className="border-b border-rule">
              <td className="tabular py-3">
                {new Date(day.day).toLocaleDateString('en-IN')}
              </td>
              <td className="tabular text-right">{day.bills}</td>
              <td className="tabular text-right">{money(day.consult_total)}</td>
              <td className="tabular text-right">{money(day.medicines_total)}</td>
              <td className="tabular text-right">{money(day.discount)}</td>
              <td className="tabular text-right">{money(day.net_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </ThreePane>
  );
}
