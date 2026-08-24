'use client';

/**
 * The printed prescription. A4.
 *
 * Assumption A7: the doctor accepts a printed prescription signed by hand as
 * the legal document, and the app's copy is a convenience. That single sentence
 * decides this whole page — it is why there is a signature block with real
 * space in it, why the doctor's registration number is printed rather than
 * implied, and why nothing here depends on colour or on a screen.
 *
 * §15.2 wants the prescriber named against every Schedule H1 line, so the
 * schedule is shown per line and the prescriber is in the footer of every page.
 *
 * The physical test on the clinic's own printer is still outstanding, and it
 * has to happen before go-live (TABLET.md §8). Note also that a tablet cannot
 * print over USB at all — if the clinic's A4 is USB-only it needs a print
 * server, and that is a purchase decision, not a go-live discovery
 * (TABLET.md §1).
 */
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { prescriptionForPrint, type PrescriptionForPrint } from '@/lib/db/encounters';
import './print.css';

function PrintPrescription() {
  const router = useRouter();
  const rxId = useSearchParams().get('rx') ?? '';
  const [rx, setRx] = useState<PrescriptionForPrint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rxId) {
      setError('No prescription number in the link.');
      return;
    }
    void prescriptionForPrint(rxId)
      .then((found) => {
        if (!found) setError('No prescription with that number.');
        setRx(found);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [rxId]);

  if (error) return <p className="p-8 text-stop">{error}</p>;
  if (!rx) return <p className="p-8 text-ink-2">Loading…</p>;

  const dated = rx.signed_at ? new Date(rx.signed_at) : new Date();

  return (
    <div className="rx-screen">
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
          onClick={() => router.back()}
          className="h-14 rounded-box border border-rule bg-sheet px-6 text-ink-2"
        >
          Back
        </button>
        {!rx.signed_at ? (
          <p className="self-center px-4 text-stop">
            This prescription is not signed. A draft is not a prescription.
          </p>
        ) : null}
      </div>

      <article className="rx-sheet">
        <header className="rx-header">
          <div>
            <h1 className="rx-clinic">{rx.clinic?.name}</h1>
            {rx.clinic?.address ? <p>{rx.clinic.address}</p> : null}
            {rx.clinic?.phone ? <p>{rx.clinic.phone}</p> : null}
            {rx.clinic?.drug_licence_no ? (
              <p className="rx-small">Drug licence: {rx.clinic.drug_licence_no}</p>
            ) : null}
          </div>
          <div className="rx-prescriber">
            <p className="rx-doctor">{rx.doctor?.name}</p>
            {rx.doctor?.reg_no ? <p className="rx-small">Reg. no. {rx.doctor.reg_no}</p> : null}
          </div>
        </header>

        <section className="rx-patient">
          <div>
            <span className="rx-label">Patient</span>
            <span className="rx-value">{rx.patient?.name}</span>
          </div>
          <div>
            <span className="rx-label">Age / Sex</span>
            <span className="rx-value tabular">
              {[rx.patient?.age, rx.patient?.sex].filter(Boolean).join(' / ') || '—'}
            </span>
          </div>
          <div>
            <span className="rx-label">Date</span>
            <span className="rx-value tabular">
              {dated.toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </div>
        </section>

        {rx.encounter?.diagnoses?.length ? (
          <section className="rx-block">
            <h2 className="rx-label">Diagnosis</h2>
            <p>{(rx.encounter.diagnoses as string[]).join(', ')}</p>
          </section>
        ) : null}

        <section className="rx-block">
          <h2 className="rx-rx">℞</h2>
          <table className="rx-table">
            <thead>
              <tr>
                <th className="rx-col-num">#</th>
                <th>Medicine</th>
                <th>Dosage</th>
                <th className="rx-col-qty">Qty</th>
              </tr>
            </thead>
            <tbody>
              {rx.items.map((item, index) => (
                <tr key={`${item.drug_id}-${index}`}>
                  <td className="rx-col-num tabular">{index + 1}</td>
                  <td>
                    <strong>{item.name}</strong> {item.strength}
                  </td>
                  <td className="tabular">
                    {item.dose} · {item.freq} · {item.days} days
                    {item.food ? ` · ${item.food} food` : ''}
                  </td>
                  <td className="rx-col-qty tabular">{item.qty_base}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {rx.encounter?.advice ? (
          <section className="rx-block">
            <h2 className="rx-label">Advice</h2>
            <p>{rx.encounter.advice}</p>
          </section>
        ) : null}

        {rx.encounter?.follow_up_date ? (
          <section className="rx-block">
            <h2 className="rx-label">Follow-up</h2>
            <p className="tabular">
              {new Date(rx.encounter.follow_up_date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </p>
          </section>
        ) : null}

        {/* A7: this is the part that makes the sheet the legal document. */}
        <footer className="rx-footer">
          <div className="rx-signature">
            <div className="rx-signature-line" />
            <p>{rx.doctor?.name}</p>
            {rx.doctor?.reg_no ? <p className="rx-small">Reg. no. {rx.doctor.reg_no}</p> : null}
          </div>
        </footer>
      </article>
    </div>
  );
}

/**
 * The screen reads its id from the query string, not from a path segment.
 *
 * A path segment would make this a dynamic route, and Next refuses to static-
 * export a dynamic route without generateStaticParams() — which cannot exist
 * here, because the ids are rows in a database that has not been written yet.
 * HOSTING.md §3: the static export is what keeps the whole app off a Worker's
 * 10 ms CPU budget and 3 MB bundle ceiling, so the query string is the cheaper
 * side of the trade.
 *
 * useSearchParams() forces everything up to the nearest Suspense boundary to be
 * client-rendered, and the build errors without one.
 */
export default function PrintPrescriptionPage() {
  return (
    <Suspense fallback={<p className="p-8 text-ink-2">Loading…</p>}>
      <PrintPrescription />
    </Suspense>
  );
}
