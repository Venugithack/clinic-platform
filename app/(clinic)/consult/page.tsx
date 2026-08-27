'use client';

/**
 * Doctor consultation workspace.
 *
 * Clinical content remains entirely doctor-authored: no diagnosis suggestions,
 * no inferred treatment and no automated prescribing. This pass only improves
 * workflow hierarchy and makes leaving the visit save what the doctor entered.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Badge, Notice, PageHeader, Token } from '@/components/ui';
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
import { latestVitalsForAppointment, type VitalRecord } from '@/lib/db/vitals';
import { setAppointmentStatus, signPrescription } from '@/lib/transitions/clinic';

const DAY_CHIPS = [3, 5, 7, 10, 15];

function ConsultScreen() {
  const router = useRouter();
  const appointmentId = useSearchParams().get('appointment') ?? '';

  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [visits, setVisits] = useState<VisitSummary[]>([]);
  const [visitVitals, setVisitVitals] = useState<VitalRecord | null>(null);

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
  const [notice, setNotice] = useState<string | null>(null);
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
        setVisitVitals(await latestVitalsForAppointment(appointmentId));

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

        setVisits(await recentVisits(found.patient_id, 5, started.id));
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [appointmentId]);

  const persist = useCallback(async () => {
    if (!encounter) return;
    await saveEncounter(encounter.id, {
      diagnoses,
      advice: advice.trim() || null,
      follow_up_date: followUp || null,
    });
    if (items.length > 0 && !signedAt) {
      const rx = await draftPrescription(encounter, items);
      setPrescriptionId(rx.id);
    }
  }, [encounter, diagnoses, advice, followUp, items, signedAt]);

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await persist();
      setNotice('Draft saved. You can continue this visit or return to the queue.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishVisit = async () => {
    if (!encounter || !entry) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Saving is part of Finish, not a separate prerequisite. A doctor must
      // never lose a diagnosis/advice because they chose the obvious final action.
      await persist();
      if (entry.status === 'in_consult') {
        await setAppointmentStatus(appointmentId, 'done');
      }
      router.push('/queue');
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const sign = async () => {
    if (!encounter || !entry || items.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveEncounter(encounter.id, {
        diagnoses,
        advice: advice.trim() || null,
        follow_up_date: followUp || null,
      });
      const rx = await draftPrescription(encounter, items);
      const signed = await signPrescription(rx.id);
      setPrescriptionId(rx.id);
      setSignedAt(signed.signed_at);

      // A signed prescription is the end of the doctor's visit. Completing the
      // queue state here prevents the patient remaining "in consult" while the
      // prescription is already waiting at pharmacy.
      if (entry.status === 'in_consult') {
        await setAppointmentStatus(appointmentId, 'done');
      }
      router.push(`/rx/print?rx=${rx.id}` as Route);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const dosesPerDay = freq
    .split('-')
    .map(Number)
    .reduce((sum, part) => sum + part, 0);
  const doseUnits = Number(dose);
  const expectedQtyBase =
    Number.isFinite(dosesPerDay) &&
    Number.isFinite(doseUnits) &&
    dosesPerDay > 0 &&
    doseUnits > 0 &&
    days > 0
      ? Math.round(doseUnits * dosesPerDay * days)
      : undefined;

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
      <ThreePane rail={<RailButton onClick={() => router.push('/queue')}>Back to queue</RailButton>}>
        <PageHeader eyebrow="Consulting room" title="This consult will not open" />
        <Notice tone="bad">
          The patient record could not be opened. Return to the queue and try again; if it keeps happening, this appointment needs checking before the consultation continues.
        </Notice>
        <p className="font-mono text-xs text-ink-2">{error}</p>
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

  const hasUnsignedMedicines = items.length > 0 && !signedAt;

  return (
    <ThreePane
      context={
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">{entry?.patient_name ?? '…'}</h2>
            <p className="mt-1 text-ink-2">
              {[entry?.age ? `${entry.age} yrs` : null, entry?.sex, entry?.phone]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          {entry?.allergies ? <Notice tone="bad">Allergies: {entry.allergies}</Notice> : null}

          {entry?.reason ? (
            <div>
              <p className="eyebrow">Reason for visit</p>
              <p className="mt-1 text-sm leading-6">{entry.reason}</p>
            </div>
          ) : null}

          <div>
            <h3 className="eyebrow">Vitals this visit</h3>
            {visitVitals ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  visitVitals.bp && ['BP', visitVitals.bp],
                  visitVitals.pulse && ['Pulse', `${visitVitals.pulse}`],
                  visitVitals.temp && ['Temp', `${visitVitals.temp} °F`],
                  visitVitals.spo2 && ['SpO₂', `${visitVitals.spo2}%`],
                  visitVitals.weight && ['Weight', `${visitVitals.weight} kg`],
                  visitVitals.height && ['Height', `${visitVitals.height} cm`],
                ]
                  .filter(Boolean)
                  .map((value) => value as [string, string])
                  .map(([label, value]) => (
                    <div key={label} className="rounded-box border border-rule bg-sheet p-2">
                      <p className="eyebrow">{label}</p>
                      <p className="tabular mt-1 text-sm font-medium">{value}</p>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-2">No vitals recorded for this visit.</p>
            )}
          </div>

          <div>
            <h3 className="eyebrow">Previous visits</h3>
            {visits.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">First visit.</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {visits.map((visit) => (
                  <li key={visit.id} className="border-b border-rule pb-3">
                    <p className="tabular text-xs text-ink-2">
                      {new Date(visit.created_at).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {(visit.diagnoses as string[])?.join(', ') || 'No diagnosis recorded'}
                    </p>
                    {visit.advice ? <p className="mt-1 text-sm text-ink-2">{visit.advice}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      }
      rail={
        <>
          <div className="flex justify-center pb-1">
            <Token prefix="Token" serial={entry?.token_no ?? '—'} size="lg" />
          </div>

          {signedAt ? (
            <RailButton
              tone="primary"
              onClick={() => prescriptionId && router.push(`/rx/print?rx=${prescriptionId}` as Route)}
            >
              Open signed Rx
            </RailButton>
          ) : hasUnsignedMedicines ? (
            <RailButton tone="primary" disabled={busy} onClick={() => void sign()}>
              {busy ? 'Signing…' : 'Sign Rx & finish'}
            </RailButton>
          ) : (
            <RailButton tone="primary" disabled={!encounter || busy} onClick={() => void finishVisit()}>
              {busy ? 'Finishing…' : 'Finish visit'}
            </RailButton>
          )}

          {!signedAt ? (
            <RailButton disabled={!encounter || busy} onClick={() => void saveDraft()}>
              Save draft
            </RailButton>
          ) : null}

          {!signedAt && !hasUnsignedMedicines ? (
            <RailButton onClick={() => router.push('/queue')}>Back to queue</RailButton>
          ) : null}

          {hasUnsignedMedicines ? (
            <p className="px-1 pt-2 text-xs leading-5 text-ink-2">
              Medicines are not sent to pharmacy until the prescription is signed.
            </p>
          ) : null}

          <div className="flex-1" />
        </>
      }
    >
      <PageHeader
        eyebrow="Consulting room"
        title="Consult"
        sub={entry?.reason || 'Record the visit, prescribe if needed, then finish'}
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? <Notice tone="good">{notice}</Notice> : null}

      {signedAt ? (
        <Notice tone="good">
          Prescription signed at {new Date(signedAt).toLocaleTimeString('en-IN')}. The visit is complete and the prescription cannot be edited.
        </Notice>
      ) : null}

      <section className="mt-2 max-w-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Diagnosis</h2>
            <p className="mt-1 text-sm text-ink-2">Doctor-entered clinical assessment.</p>
          </div>
          {diagnoses.length > 0 ? <Badge>{diagnoses.length} recorded</Badge> : null}
        </div>

        <div className="mt-3 flex gap-3">
          <input
            value={diagnosis}
            onChange={(event) => setDiagnosis(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !diagnosis.trim()) return;
              event.preventDefault();
              setDiagnoses((current) => [...current, diagnosis.trim()]);
              setDiagnosis('');
            }}
            disabled={signedAt !== null}
            aria-label="Diagnosis"
            placeholder="Type diagnosis and press Enter"
            className="blank h-14 min-w-0 flex-1 px-4 text-lg disabled:opacity-50"
          />
          <button
            type="button"
            disabled={signedAt !== null || !diagnosis.trim()}
            onClick={() => {
              if (!diagnosis.trim()) return;
              setDiagnoses((current) => [...current, diagnosis.trim()]);
              setDiagnosis('');
            }}
            className="h-14 rounded-box border border-ink px-5 text-xs font-semibold uppercase tracking-[0.08em] disabled:opacity-40"
          >
            Add diagnosis
          </button>
        </div>

        <ul className="mt-3 flex flex-wrap gap-2">
          {diagnoses.map((entryText, index) => (
            <li key={`${entryText}-${index}`}>
              <button
                type="button"
                disabled={signedAt !== null}
                onClick={() => setDiagnoses((current) => current.filter((_, i) => i !== index))}
                className="min-h-11 rounded-box border border-ink px-4 text-sm disabled:opacity-50"
              >
                {entryText} {!signedAt ? '×' : ''}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 max-w-2xl border-t border-rule pt-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Prescription</h2>
            <p className="mt-1 text-sm text-ink-2">
              {items.length === 0 ? 'No medicines added.' : `${items.length} medicine${items.length === 1 ? '' : 's'} added.`}
            </p>
          </div>
          {!signedAt ? (
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="h-11 rounded-box border border-ink px-4 text-xs font-semibold uppercase tracking-[0.08em]"
            >
              + Add medicine
            </button>
          ) : null}
        </div>

        {items.length > 0 ? (
          <ul className="mt-3 rounded-box border border-rule bg-sheet">
            {items.map((item, index) => (
              <li key={`${item.drug_id}-${index}`} className="flex items-center gap-4 border-b border-rule p-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-medium">
                    {item.name} <span className="text-sm font-normal text-ink-2">{item.strength}</span>
                  </span>
                  <span className="tabular block text-sm text-ink-2">
                    {item.dose} · {item.freq} · {item.days} days{item.food ? ` · ${item.food} food` : ''}
                  </span>
                </span>
                <span className="tabular shrink-0 text-sm">Qty {item.qty_base}</span>
                {!signedAt ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                    className="h-11 w-11 shrink-0 rounded-box border border-rule text-ink-2 active:bg-paper-2"
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {pending ? (
          <div className="mt-5 rounded-box border border-rule bg-sheet p-4">
            <p className="text-lg font-medium">
              {pending.name} <span className="text-sm font-normal text-ink-2">{pending.strength}</span>
            </p>

            <div className="mt-4 flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="eyebrow mb-1 block">Dose</span>
                <input value={dose} onChange={(event) => setDose(event.target.value)} aria-label="Dose" className="blank h-14 w-24 px-3 text-lg" />
              </label>

              <label className="block">
                <span className="eyebrow mb-1 block">Frequency</span>
                <input value={freq} onChange={(event) => setFreq(event.target.value)} aria-label="Frequency" className="blank tabular h-14 w-32 px-3 text-lg" />
              </label>

              <div>
                <span className="eyebrow mb-1 block">Days</span>
                <div className="flex gap-2">
                  {DAY_CHIPS.map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setDays(count)}
                      className={`tabular h-14 w-14 rounded-box border text-lg ${days === count ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'}`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="eyebrow mb-1 block">Food</span>
                <div className="flex gap-2">
                  {(['before', 'after', 'with'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setFood(option)}
                      className={`h-14 rounded-box border px-4 ${food === option ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'}`}
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
                expected={expectedQtyBase}
                onCommit={addLine}
                onCancel={() => setPending(null)}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-6 max-w-2xl border-t border-rule pt-5">
        <h2 className="text-lg font-medium">Advice & follow-up</h2>
        <textarea
          value={advice}
          onChange={(event) => setAdvice(event.target.value)}
          disabled={signedAt !== null}
          aria-label="Advice"
          placeholder="Advice to the patient"
          rows={3}
          className="blank mt-3 w-full p-4 text-lg disabled:opacity-50"
        />

        <label className="mt-4 block">
          <span className="eyebrow mb-1 block">Follow-up date</span>
          <input
            type="date"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            disabled={signedAt !== null}
            aria-label="Follow-up date"
            className="blank tabular h-14 px-4 text-lg disabled:opacity-50"
          />
        </label>
      </section>
    </ThreePane>
  );
}

export default function ConsultPage() {
  return (
    <Suspense fallback={<p className="p-8 text-ink-2">Loading…</p>}>
      <ConsultScreen />
    </Suspense>
  );
}
