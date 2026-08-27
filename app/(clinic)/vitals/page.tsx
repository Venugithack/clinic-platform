'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Field, Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import { queueEntry, type QueueEntry } from '@/lib/db/queue';
import { latestVitals, recordVitals, type VitalRecord } from '@/lib/db/vitals';

export default function VitalsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const appointmentId = params.get('appointment');
  const session = currentSession();
  const allowed =
    session?.role === 'doctor' || session?.role === 'nurse' || session?.role === 'admin';
  const canConsult = session?.role === 'doctor' || session?.role === 'admin';

  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [previous, setPrevious] = useState<VitalRecord | null>(null);
  const [bp, setBp] = useState('');
  const [pulse, setPulse] = useState('');
  const [temp, setTemp] = useState('');
  const [spo2, setSpo2] = useState('');
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!appointmentId || !allowed) return;
    void queueEntry(appointmentId)
      .then(async (found) => {
        setEntry(found);
        if (found) setPrevious(await latestVitals(found.patient_id));
      })
      .catch((cause: Error) => setError(cause.message));
  }, [appointmentId, allowed]);

  const hasAnyValue = useMemo(
    () => [bp, pulse, temp, spo2, weight, height].some((value) => value.trim() !== ''),
    [bp, pulse, temp, spo2, weight, height],
  );

  const numberOrUndefined = (value: string) =>
    value.trim() === '' ? undefined : Number(value);

  const save = async (next: 'queue' | 'consult') => {
    if (!entry || !appointmentId || !session || !allowed || !hasAnyValue) return;
    setBusy(true);
    setError(null);
    try {
      await recordVitals({
        patientId: entry.patient_id,
        appointmentId,
        recordedBy: session.staffId,
        bp: bp || undefined,
        pulse: numberOrUndefined(pulse),
        temp: numberOrUndefined(temp),
        spo2: numberOrUndefined(spo2),
        weight: numberOrUndefined(weight),
        height: numberOrUndefined(height),
      });

      if (next === 'consult' && canConsult) {
        router.push(`/consult?appointment=${appointmentId}` as Route);
      } else {
        router.push('/queue');
      }
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <ThreePane
        context={<div />}
        rail={<RailButton onClick={() => router.push('/queue')}>Back</RailButton>}
      >
        <PageHeader eyebrow="Patient intake" title="Vitals" />
        <Notice tone="bad">Only clinical staff can record vitals.</Notice>
      </ThreePane>
    );
  }

  const previousItems = previous
    ? [
        previous.bp && ['BP', previous.bp],
        previous.pulse && ['Pulse', `${previous.pulse} bpm`],
        previous.temp && ['Temp', `${previous.temp} °F`],
        previous.spo2 && ['SpO₂', `${previous.spo2}%`],
        previous.weight && ['Weight', `${previous.weight} kg`],
        previous.height && ['Height', `${previous.height} cm`],
      ].filter(Boolean) as [string, string][]
    : [];

  return (
    <ThreePane
      context={
        <div className="space-y-6">
          <div>
            <p className="eyebrow">Patient</p>
            <p className="mt-1 text-lg font-medium">{entry?.patient_name ?? 'Loading…'}</p>
            {entry ? (
              <p className="mt-1 text-sm text-ink-2">
                Token {entry.token_no} · {[entry.age ? `${entry.age} yrs` : null, entry.sex]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
          </div>

          {entry?.reason ? (
            <div>
              <p className="eyebrow">Reason for visit</p>
              <p className="mt-1 text-sm leading-6">{entry.reason}</p>
            </div>
          ) : null}

          {previousItems.length > 0 ? (
            <div>
              <p className="eyebrow">Previous measurement</p>
              <p className="mt-1 text-xs text-ink-2">
                {previous
                  ? new Date(previous.recorded_at).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : null}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                {previousItems.map(([label, value]) => (
                  <div key={label} className="rounded-box border border-rule bg-sheet p-2">
                    <dt className="eyebrow">{label}</dt>
                    <dd className="tabular mt-1 text-sm font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="text-sm text-ink-2">No previous vitals are recorded for this patient.</p>
          )}
        </div>
      }
      rail={
        <>
          {canConsult ? (
            <RailButton
              tone="primary"
              disabled={!entry || !hasAnyValue || busy}
              onClick={() => void save('consult')}
            >
              {busy ? 'Saving…' : 'Save & consult'}
            </RailButton>
          ) : (
            <RailButton
              tone="primary"
              disabled={!entry || !hasAnyValue || busy}
              onClick={() => void save('queue')}
            >
              {busy ? 'Saving…' : 'Save vitals'}
            </RailButton>
          )}

          {canConsult ? (
            <RailButton
              disabled={!entry || !hasAnyValue || busy}
              onClick={() => void save('queue')}
            >
              Save vitals
            </RailButton>
          ) : null}

          <RailButton onClick={() => router.push('/queue')}>Back without saving</RailButton>
        </>
      }
    >
      <PageHeader
        eyebrow="Patient intake"
        title="Record vitals"
        sub={canConsult ? 'Save and continue directly into consultation' : 'Record what was measured, then return to the queue'}
      />
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="mt-6 grid max-w-2xl grid-cols-2 gap-5">
        <Field label="Blood pressure">
          <input
            value={bp}
            onChange={(e) => setBp(e.target.value.slice(0, 9))}
            placeholder="120/80"
            aria-label="Blood pressure"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
        <Field label="Pulse (bpm)">
          <input
            inputMode="numeric"
            value={pulse}
            onChange={(e) => setPulse(e.target.value.slice(0, 3))}
            aria-label="Pulse"
            placeholder="72"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
        <Field label="Temperature (°F)">
          <input
            inputMode="decimal"
            value={temp}
            onChange={(e) => setTemp(e.target.value.slice(0, 5))}
            aria-label="Temperature"
            placeholder="98.6"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
        <Field label="SpO₂ (%)">
          <input
            inputMode="numeric"
            value={spo2}
            onChange={(e) => setSpo2(e.target.value.slice(0, 3))}
            aria-label="SpO2"
            placeholder="99"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
        <Field label="Weight (kg)">
          <input
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value.slice(0, 6))}
            aria-label="Weight"
            placeholder="65"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
        <Field label="Height (cm)">
          <input
            inputMode="decimal"
            value={height}
            onChange={(e) => setHeight(e.target.value.slice(0, 6))}
            aria-label="Height"
            placeholder="170"
            className="blank h-14 w-full px-4 text-lg"
          />
        </Field>
      </div>
    </ThreePane>
  );
}
