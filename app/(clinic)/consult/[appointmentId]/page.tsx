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
import { Notice, PageHeader } from '@/components/ui';
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
        <p className="text-stop">{error}</p>
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
          <p className="mt-1 text-ink-2">
            {[entry?.age, entry?.sex, entry?.phone].filter(Boolean).join(' · ')}
          </p>

          {/* The one thing that must be impossible to miss. */}
          {entry?.allergies ? (
            <Notice tone="bad">
              Allergies: {entry.allergies}
            </Notice>
          ) : null}

          <h3 className="eyebrow mt-8">Previous visits</h3>
          {visits.length === 0 ? (
            <p className="mt-2 text-ink-2">First visit.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {visits.map((visit) => (
                <li key={visit.id} className="border-b border-rule pb-3">
                  <p className="tabular text-sm text-ink-2">
                    {new Date(visit.created_at).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                  <p>{(visit.diagnoses as string[])?.join(', ') || '—'}</p>
                  {visit.advice ? (
                    <p className="text-sm text-ink-2">{visit.advice}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      rail={
        <>
          <div className="rounded-box border border-rule bg-sheet p-3 text-center">
            <p className="text-sm text-ink-2">Token</p>
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
      <PageHeader eyebrow="Consulting room" title="Consult" />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {signedAt ? (
        <Notice tone="good">
          Signed at {new Date(signedAt).toLocaleTimeString('en-IN')}. A signed prescription
          cannot be edited.
        </Notice>
      ) : null}

      <section className="mt-6 max-w-2xl">
        <h2 className="eyebrow">Diagnosis</h2>
        <div className="mt-2 flex gap-3">
          <input
            value={diagnosis}
            onChange={(event) => setDiagnosis(event.target.value)}
            aria-label="Diagnosis"
            placeholder="As you would write it"
            className="h-14 flex-1 rounded-box border border-rule bg-sheet px-4 text-lg"
          />
          <button
            type="button"
            onClick={() => {
              if (!diagnosis.trim()) return;
              setDiagnoses((current) => [...current, diagnosis.trim()]);
              setDiagnosis('');
            }}
            className="h-14 rounded-box border border-rule bg-sheet px-5 active:bg-paper-2"
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
                className="h-11 rounded-box border border-rule bg-sheet px-4 text-sm active:bg-paper-2"
              >
                {entryText} ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Medicines</h2>
          {!signedAt ? (
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="h-11 rounded-box border border-rule bg-sheet px-4 text-sm active:bg-paper-2"
            >
              + Add medicine
            </button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="mt-3 text-ink-2">Nothing prescribed yet.</p>
        ) : (
          <ul className="mt-3">
            {items.map((item, index) => (
              <li
                key={`${item.drug_id}-${index}`}
                className="flex items-center gap-4 border-b border-rule py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg">
                    {item.name} <span className="text-sm text-ink-2">{item.strength}</span>
                  </span>
                  <span className="tabular block text-sm text-ink-2">
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
                    className="h-11 w-11 shrink-0 rounded-box border border-rule text-ink-2 active:bg-paper-2"
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
              {pending.name} <span className="text-sm text-ink-2">{pending.strength}</span>
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="mb-1 block text-sm text-ink-2">Dose</span>
                <input
                  value={dose}
                  onChange={(event) => setDose(event.target.value)}
                  aria-label="Dose"
                  className="blank h-14 w-24 px-3 text-lg"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm text-ink-2">Frequency</span>
                <input
                  value={freq}
                  onChange={(event) => setFreq(event.target.value)}
                  aria-label="Frequency"
                  className="blank tabular h-14 w-32 px-3 text-lg"
                />
              </label>

              <div>
                <span className="mb-1 block text-sm text-ink-2">Days</span>
                <div className="flex gap-2">
                  {DAY_CHIPS.map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setDays(count)}
                      className={`tabular h-14 w-14 rounded-box border text-lg ${
                        days === count ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'
                      }`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="mb-1 block text-sm text-ink-2">Food</span>
                <div className="flex gap-2">
                  {(['before', 'after', 'with'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setFood(option)}
                      className={`h-14 rounded-box border px-4 ${
                        food === option ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'
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
        <h2 className="eyebrow">Advice</h2>
        <textarea
          value={advice}
          onChange={(event) => setAdvice(event.target.value)}
          aria-label="Advice"
          rows={3}
          className="mt-2 w-full rounded-box border border-rule bg-sheet p-4 text-lg"
        />

        <label className="mt-4 block">
          <span className="eyebrow mb-1 block">
            Follow-up
          </span>
          <input
            type="date"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            aria-label="Follow-up date"
            className="tabular h-14 rounded-box border border-rule bg-sheet px-4 text-lg"
          />
        </label>
      </section>
    </ThreePane>
  );
}
