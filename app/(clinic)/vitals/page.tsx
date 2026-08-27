'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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

  const save = async () => {
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
      router.push('/queue');
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

  return (
    <ThreePane
      context={
        <div className="space-y-6">
          <div>
            <p className="eyebrow">Patient</p>
            <p className="mt-1 text-lg">{entry?.patient_name ?? 'Loading…'}</p>
            {entry ? (
              <p className="mt-1 text-sm text-ink-2">
                Token {entry.token_no} · {[entry.age, entry.sex].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
          {previous ? (
            <div>
              <p className="eyebrow">Latest recorded vitals</p>
              <p className="mt-2 text-sm text-ink-2">
                {[
                  previous.bp && `BP ${previous.bp}`,
                  previous.pulse && `Pulse ${previous.pulse}`,
                  previous.temp && `Temp ${previous.temp}`,
                  previous.spo2 && `SpO₂ ${previous.spo2}%`,
                  previous.weight && `Wt ${previous.weight} kg`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={!entry || !hasAnyValue || busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save vitals'}
          </RailButton>
          <RailButton onClick={() => router.push('/queue')}>Skip / back to queue</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Patient intake" title="Vitals" sub={session?.staffName} />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="mt-6 grid max-w-2xl grid-cols-2 gap-5">
        <Field label="Blood pressure">
          <input value={bp} onChange={(e) => setBp(e.target.value)} placeholder="120/80" aria-label="Blood pressure" className="blank h-14 w-full px-4 text-lg" />
        </Field>
        <Field label="Pulse (bpm)">
          <input inputMode="numeric" value={pulse} onChange={(e) => setPulse(e.target.value)} aria-label="Pulse" className="blank h-14 w-full px-4 text-lg" />
        </Field>
        <Field label="Temperature (°F)">
          <input inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} aria-label="Temperature" className="blank h-14 w-full px-4 text-lg" />
        </Field>
        <Field label="SpO₂ (%)">
          <input inputMode="numeric" value={spo2} onChange={(e) => setSpo2(e.target.value)} aria-label="SpO2" className="blank h-14 w-full px-4 text-lg" />
        </Field>
        <Field label="Weight (kg)">
          <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} aria-label="Weight" className="blank h-14 w-full px-4 text-lg" />
        </Field>
        <Field label="Height (cm)">
          <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} aria-label="Height" className="blank h-14 w-full px-4 text-lg" />
        </Field>
      </div>
    </ThreePane>
  );
}
