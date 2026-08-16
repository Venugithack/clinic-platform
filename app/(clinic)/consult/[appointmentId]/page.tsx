'use client';

/**
 * The consult. TABLET.md §7: context pane = patient history, work pane = the
 * form, rail = Sign Rx. Sections collapse; nothing is more than one scroll.
 *
 * Everything on this screen is typed by the doctor. Nothing is suggested,
 * completed, computed or flagged — PLAN.md §15.3 and rule 8. There is no
 * diagnosis autocomplete here and there must never be one: suggesting a
 * diagnosis from symptoms engages CDSCO software-as-a-medical-device rules and
 * clinical liability, and it is the kind of thing that arrives by accident as
 * an "autocomplete improvement".
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { DrugSearch } from '@/components/DrugSearch';
import { QtyPad } from '@/components/QtyPad';
import { queueEntry, type QueueEntry } from '@/lib/db/queue';
import { recentVisits, type VisitSummary } from '@/lib/db/patients';
import {
  draftPrescription,
  prescriptionForEncounter,
  saveEncounter,
  startEncounter,
  type Encounter,
  type PrescriptionItem,
} from '@/lib/db/encounters';
import type { DrugRow } from '@/lib/db/drugs';
import { currentSession } from '@/lib/auth';
import { setAppointmentStatus, signPrescription } from '@/lib/transitions/clinic';

const DAY_CHIPS = [3, 5, 7, 10, 15];

export default function ConsultPage() {
  const router = useRouter();
  const params = useParams<{ appointmentId: string }>();
  const appointmentId = params.appointmentId;

  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [visits, setVisits] = useState<VisitSummary[]>([]);

  const [diagnosis, setDiagnosis] = useState('');
  const [diagnoses, setDiagnoses] = useState<string[]>([]);
  const [advice, setAdvice] = useState('');
  const [followUp, setFollowUp] = useState('');

  const [items, setItems] = useState<PrescriptionItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<DrugRow | null>(null);
  const [dose, setDose] = useState('1');
  const [freq, setFreq] = useState('1-0-1');
  const [days, setDays] = useState(5);
  const [food, setFood] = useState<'before' | 'after' | 'with' | null>('after');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedAt, setSignedAt] = useState<string | null>(null);
  const [prescriptionId, setPrescriptionId] = useState<string | null>(null);

  useEffect(() => {
    const session = currentSession();
    if (!session) return;

    void (async () => {
      try {
        const found = await queueEntry(appointmentId);
        if (!found) {
          setError('That appointment is not on today’s list.');
          return;
        }
        setEntry(found);

        const started = await startEncounter(found.patient_id, session.staffId, appointmentId);
        setEncounter(started);
        setDiagnoses(started.diagnoses ?? []);
        setAdvice(started.advice ?? '');
        setFollowUp(started.follow_up_date ?? '');

        const existing = await prescriptionForEncounter(started.id);
        if (existing) {
          setItems(existing.items ?? []);
          setPrescriptionId(existing.id);
          setSignedAt(existing.signed_at);
        }

        setVisits(await recentVisits(found.patient_id));
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [appointmentId]);

  const save = useCallback(async () => {
    if (!encounter) return;
    await saveEncounter(encounter.id, {
      diagnoses,
      advice: advice || null,
      follow_up_date: followUp || null,
    });
    if (items.length > 0) {
      const rx = await draftPrescription(encounter, items);
      setPrescriptionId(rx.id);
    }
  }, [encounter, diagnoses, advice, followUp, items]);

  const sign = async () => {
    if (!encounter || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await saveEncounter(encounter.id, {
        diagnoses,
        advice: advice || null,
        follow_up_date: followUp || null,
      });
      const rx = await draftPrescription(encounter, items);
      const signed = await signPrescription(rx.id);
      setPrescriptionId(rx.id);
      setSignedAt(signed.signed_at);
      router.push(`/rx/${rx.id}/print` as Route);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const addLine = (qtyBase: number) => {
    if (!pending) return;
    setItems((current) => [
      ...current,
      {
        drug_id: pending.id,
        name: pending.name,
        strength: pending.strength,
        dose,
        freq,
        days,
        food,
        qty_base: qtyBase,
      },
    ]);
    setPending(null);
  };

  if (error && !entry) {
    return (
      <ThreePane rail={<RailButton onClick={() => router.push('/queue')}>Back</RailButton>}>
        <p className="text-danger">{error}</p>
      </ThreePane>
    );
  }

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
          <h2 className="text-xl font-semibold">{entry?.patient_name ?? '…'}</h2>
          <p className="mt-1 text-muted">
            {[entry?.age, entry?.sex, entry?.phone].filter(Boolean).join(' · ')}
          </p>

          {/* The one thing that must be impossible to miss. */}
          {entry?.allergies ? (
            <p className="mt-4 rounded-lg bg-danger/10 p-3 text-danger">
              Allergies: {entry.allergies}
            </p>
          ) : null}

          <h3 className="mt-8 text-sm uppercase tracking-wide text-muted">Previous visits</h3>
          {visits.length === 0 ? (
            <p className="mt-2 text-muted">First visit.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {visits.map((visit) => (
                <li key={visit.id} className="border-b border-line pb-3">
                  <p className="tabular text-sm text-muted">
                    {new Date(visit.created_at).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                  <p>{(visit.diagnoses as string[])?.join(', ') || '—'}</p>
                  {visit.advice ? (
                    <p className="text-sm text-muted">{visit.advice}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      rail={
        <>
          <div className="rounded-xl border border-line bg-white p-3 text-center">
            <p className="text-sm text-muted">Token</p>
            <p className="tabular text-3xl font-medium">{entry?.token_no ?? '—'}</p>
          </div>

          <RailButton
            tone="primary"
            disabled={items.length === 0 || busy || signedAt !== null}
            onClick={() => void sign()}
          >
            {signedAt ? 'Signed' : busy ? 'Signing…' : 'Sign Rx'}
          </RailButton>

          <RailButton disabled={busy} onClick={() => void save()}>
            Save
          </RailButton>

          {signedAt && prescriptionId ? (
            <RailButton onClick={() => router.push(`/rx/${prescriptionId}/print` as Route)}>
              Print
            </RailButton>
          ) : null}

          <div className="flex-1" />

          <RailButton
            onClick={() => {
              void (async () => {
                try {
                  if (entry?.status === 'in_consult') {
                    await setAppointmentStatus(appointmentId, 'done');
                  }
                } finally {
                  router.push('/queue');
                }
              })();
            }}
          >
            Finish
          </RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Consult</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      {signedAt ? (
        <p className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          Signed at {new Date(signedAt).toLocaleTimeString('en-IN')}. A signed prescription
          cannot be edited.
        </p>
      ) : null}

      <section className="mt-6 max-w-2xl">
        <h2 className="text-sm uppercase tracking-wide text-muted">Diagnosis</h2>
        <div className="mt-2 flex gap-3">
          <input
            value={diagnosis}
            onChange={(event) => setDiagnosis(event.target.value)}
            aria-label="Diagnosis"
            placeholder="As you would write it"
            className="h-14 flex-1 rounded-xl border border-line bg-white px-4 text-lg"
          />
          <button
            type="button"
            onClick={() => {
              if (!diagnosis.trim()) return;
              setDiagnoses((current) => [...current, diagnosis.trim()]);
              setDiagnosis('');
            }}
            className="h-14 rounded-xl border border-line bg-white px-5 active:bg-line"
          >
            Add diagnosis
          </button>
        </div>
        <ul className="mt-3 flex flex-wrap gap-2">
          {diagnoses.map((entryText, index) => (
            <li key={`${entryText}-${index}`}>
              <button
                type="button"
                onClick={() => setDiagnoses((current) => current.filter((_, i) => i !== index))}
                className="h-11 rounded-lg border border-line bg-white px-4 text-sm active:bg-line"
              >
                {entryText} ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-wide text-muted">Medicines</h2>
          {!signedAt ? (
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="h-11 rounded-lg border border-line bg-white px-4 text-sm active:bg-line"
            >
              + Add medicine
            </button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="mt-3 text-muted">Nothing prescribed yet.</p>
        ) : (
          <ul className="mt-3">
            {items.map((item, index) => (
              <li
                key={`${item.drug_id}-${index}`}
                className="flex items-center gap-4 border-b border-line py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg">
                    {item.name} <span className="text-sm text-muted">{item.strength}</span>
                  </span>
                  <span className="tabular block text-sm text-muted">
                    {item.dose} · {item.freq} · {item.days} days
                    {item.food ? ` · ${item.food} food` : ''}
                  </span>
                </span>
                <span className="tabular shrink-0">{item.qty_base}</span>
                {!signedAt ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                    className="h-11 w-11 shrink-0 rounded-lg border border-line text-muted active:bg-line"
                  >
                    ✕
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {pending ? (
          <div className="mt-5">
            <p className="text-lg">
              {pending.name} <span className="text-sm text-muted">{pending.strength}</span>
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="mb-1 block text-sm text-muted">Dose</span>
                <input
                  value={dose}
                  onChange={(event) => setDose(event.target.value)}
                  aria-label="Dose"
                  className="h-14 w-24 rounded-xl border border-line bg-white px-3 text-lg"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm text-muted">Frequency</span>
                <input
                  value={freq}
                  onChange={(event) => setFreq(event.target.value)}
                  aria-label="Frequency"
                  className="tabular h-14 w-32 rounded-xl border border-line bg-white px-3 text-lg"
                />
              </label>

              <div>
                <span className="mb-1 block text-sm text-muted">Days</span>
                <div className="flex gap-2">
                  {DAY_CHIPS.map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setDays(count)}
                      className={`tabular h-14 w-14 rounded-xl border text-lg ${
                        days === count ? 'border-ink bg-ink text-white' : 'border-line bg-white'
                      }`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="mb-1 block text-sm text-muted">Food</span>
                <div className="flex gap-2">
                  {(['before', 'after', 'with'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setFood(option)}
                      className={`h-14 rounded-xl border px-4 ${
                        food === option ? 'border-ink bg-ink text-white' : 'border-line bg-white'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5 max-w-md">
              <QtyPad
                pack={{
                  unitsPerStrip: pending.default_units_per_strip ?? 1,
                  stripsPerBox: pending.default_strips_per_box ?? 1,
                }}
                baseUnitLabel={pending.base_unit === 'tablet' ? 'tablets' : pending.base_unit}
                onCommit={addLine}
                onCancel={() => setPending(null)}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-8 max-w-2xl">
        <h2 className="text-sm uppercase tracking-wide text-muted">Advice</h2>
        <textarea
          value={advice}
          onChange={(event) => setAdvice(event.target.value)}
          aria-label="Advice"
          rows={3}
          className="mt-2 w-full rounded-xl border border-line bg-white p-4 text-lg"
        />

        <label className="mt-4 block">
          <span className="mb-1 block text-sm uppercase tracking-wide text-muted">
            Follow-up
          </span>
          <input
            type="date"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            aria-label="Follow-up date"
            className="tabular h-14 rounded-xl border border-line bg-white px-4 text-lg"
          />
        </label>
      </section>
    </ThreePane>
  );
}
