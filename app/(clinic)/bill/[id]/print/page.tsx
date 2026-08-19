'use client';

/**
 * The printed bill. A4 and 80mm (PLAN.md §8 M4).
 *
 * Both sizes carry the same content, including the batch number and expiry of
 * every medicine line. That is not thoroughness for its own sake: §15.2 makes
 * batch traceability the mechanism by which a recall reaches the person holding
 * the strip, and a receipt without it is the one document in the chain that
 * breaks it. On the roll they wrap under the description rather than disappear.
 *
 * A cancelled bill still prints, stamped. It keeps its number — the series has
 * to be unbroken — so it has to be explainable on paper too.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  clinicSettings,
  getBill,
  type Bill,
  type ClinicSettings,
} from '@/lib/db/billing';
import './bill-print.css';

export default function PrintBillPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [bill, setBill] = useState<Bill | null>(null);
  const [clinic, setClinic] = useState<ClinicSettings | null>(null);
  const [roll, setRoll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const found = await getBill(params.id);
        if (!found) setError('No bill with that number.');
        setBill(found);
        setClinic(await clinicSettings());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [params.id]);

  if (error) return <p className="p-8 text-stop">{error}</p>;
  if (!bill) return <p className="p-8 text-ink-2">Loading…</p>;

  const money = (value: number | string) => `₹${Number(value).toFixed(2)}`;
  const dated = new Date(bill.created_at);

  return (
    <div className="bill-screen">
      <div className="no-print flex gap-3 border-b border-rule bg-sheet p-4">
        <button
          type="button"
          onClick={() => window.print()}
          className="h-14 rounded-box border border-ink bg-ink px-6 font-medium text-paper"
        >
          Print
        </button>
        <button
          type="button"
          aria-pressed={roll}
          onClick={() => setRoll((current) => !current)}
          className="h-14 rounded-box border border-rule bg-sheet px-6"
        >
          {roll ? 'A4' : '80mm roll'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="h-14 rounded-box border border-rule bg-sheet px-6 text-ink-2"
        >
          Back
        </button>
      </div>

      <div className={`bill-sheet ${roll ? 'roll' : 'a4'}`}>
        {bill.status === 'cancelled' ? (
          <p className="bill-void">CANCELLED — {bill.void_reason}</p>
        ) : null}

        <div className="bill-head">
          <p className="bill-clinic">{clinic?.name ?? 'Clinic'}</p>
          <p className="bill-small">
            {clinic?.address}
            {clinic?.phone ? ` · ${clinic.phone}` : ''}
          </p>
          <p className="bill-small">
            {clinic?.drug_licence_no ? `DL ${clinic.drug_licence_no}` : ''}
            {clinic?.gstin ? ` · GSTIN ${clinic.gstin}` : ''}
          </p>
        </div>

        <div className="bill-meta">
          <div>
            <p>
              <strong>{bill.patient_name ?? 'Counter sale'}</strong>
            </p>
            <p className="bill-small">
              {dated.toLocaleDateString('en-IN')}{' '}
              {dated.toLocaleTimeString('en-IN')}
            </p>
          </div>
          <div className="bill-num">
            <p>
              <strong>{bill.bill_no}</strong>
            </p>
            <p className="bill-small">
              {bill.status === 'paid' ? `Paid · ${bill.method}` : bill.status}
            </p>
          </div>
        </div>

        <table className="bill-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="bill-hide-roll">Batch</th>
              <th className="bill-hide-roll">Expiry</th>
              <th className="bill-num">Qty</th>
              <th className="bill-num">Rate</th>
              <th className="bill-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  {line.description}
                  {line.batch_no ? (
                    <span className="bill-batch">
                      <br />
                      {line.batch_no}
                      {line.expiry
                        ? ` · exp ${new Date(line.expiry).toLocaleDateString('en-IN', {
                            month: 'short',
                            year: 'numeric',
                          })}`
                        : ''}
                    </span>
                  ) : null}
                </td>
                <td className="bill-hide-roll">{line.batch_no ?? '—'}</td>
                <td className="bill-hide-roll">
                  {line.expiry
                    ? new Date(line.expiry).toLocaleDateString('en-IN', {
                        month: 'short',
                        year: 'numeric',
                      })
                    : '—'}
                </td>
                <td className="bill-num">{line.qty_base ?? '—'}</td>
                <td className="bill-num">
                  {line.unit_price ? Number(line.unit_price).toFixed(2) : '—'}
                </td>
                <td className="bill-num">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="bill-totals">
          {Number(bill.consult_fee) > 0 ? (
            <div>
              <span>Consultation</span>
              <span className="bill-num">{money(bill.consult_fee)}</span>
            </div>
          ) : null}
          <div>
            <span>Medicines</span>
            <span className="bill-num">{money(bill.medicines_total)}</span>
          </div>
          {Number(bill.discount) > 0 ? (
            <div>
              <span>Discount</span>
              <span className="bill-num">− {money(bill.discount)}</span>
            </div>
          ) : null}
          {Number(bill.round_off) !== 0 ? (
            <div>
              <span>Round off</span>
              <span className="bill-num">{Number(bill.round_off).toFixed(2)}</span>
            </div>
          ) : null}
          <div className="bill-total-line">
            <span>Total</span>
            <span className="bill-num" data-testid="bill-total">
              {money(bill.total)}
            </span>
          </div>
        </div>

        <div className="bill-foot">
          {/* Q4 deferred GST billing. Saying so on the bill is not decoration —
              a customer who expects a tax invoice should be able to see at a
              glance that this is not one. */}
          {clinic?.gstin ? null : <p>Not a tax invoice. GST is not charged.</p>}
          <p>Medicines once sold are not returnable, except as required by law.</p>
          <p className="bill-small">
            Batch and expiry are printed against every medicine for traceability.
          </p>
        </div>
      </div>
    </div>
  );
}
