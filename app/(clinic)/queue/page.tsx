'use client';

/**
 * The queue — the default screen on both clinic tablets.
 *
 * The queue is intentionally role-shaped rather than a shared menu. Nurses
 * should see intake work, doctors should see consultation work, pharmacy staff
 * should be sent to the counter, and administrators should get the back-office
 * entry point. The row itself stays the common hand-off object between roles.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Badge, EmptyState, Notice, PageHeader, Token } from '@/components/ui';
import { todaysQueue, type QueueEntry } from '@/lib/db/queue';
import { setAppointmentStatus } from '@/lib/transitions/clinic';
import { currentSession } from '@/lib/auth';

const STATUS_LABEL: Record<QueueEntry['status'], string> = {
  booked: 'Booked',
  waiting: 'Waiting',
  in_consult: 'In consult',
  done: 'Done',
  no_show: 'No show',
};

const STATUS_TONE: Record<
  QueueEntry['status'],
  'none' | 'attn' | 'live' | 'free' | 'stop'
> = {
  booked: 'none',
  waiting: 'attn',
  in_consult: 'live',
  done: 'free',
  no_show: 'stop',
};

export default function QueuePage() {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = currentSession();
  const role = session?.role;
  const isNurse = role === 'nurse';
  const isDoctor = role === 'doctor';
  const isAdmin = role === 'admin';
  const isCounter = role === 'counter';
  const canIntake = isDoctor || isNurse || isAdmin;
  const canConsult = isDoctor || isAdmin;

  const refresh = useCallback(() => {
    setError(null);
    void todaysQueue()
      .then(setQueue)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  const open = async (entry: QueueEntry) => {
    if (busy) return;

    // On the nurse tablet the entire patient row is the intake action. Keeping
    // a second "Vitals" button beside every row made the same task appear twice.
    if (isNurse) {
      router.push(`/vitals?appointment=${entry.appointment_id}` as Route);
      return;
    }

    if (isCounter) {
      router.push('/counter');
      return;
    }

    if (!canConsult) return;

    setBusy(true);
    try {
      if (entry.status === 'waiting' || entry.status === 'booked') {
        await setAppointmentStatus(entry.appointment_id, 'in_consult');
      }
      router.push(`/consult?appointment=${entry.appointment_id}` as Route);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const waiting = queue.filter((entry) => entry.status === 'waiting').length;
  const inConsult = queue.filter((entry) => entry.status === 'in_consult').length;
  const done = queue.filter((entry) => entry.status === 'done').length;

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const workHint = isNurse
    ? 'Tap a patient to record or update vitals.'
    : isDoctor || isAdmin
      ? 'Tap a patient to open the consultation.'
      : 'Prescription hand-offs appear at the pharmacy counter.';

  return (
    <ThreePane
      context={
        <div className="flex flex-col gap-6">
          <div>
            <p className="eyebrow">Today</p>
            <p className="mt-1 text-lg">{today}</p>
          </div>

          <dl className="flex flex-col">
            {[
              ['Waiting', waiting],
              ['In consult', inConsult],
              ['Seen', done],
              ['Tokens issued', queue.length],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between border-b border-rule py-2 last:border-b-0"
              >
                <dt className="eyebrow">{label}</dt>
                <dd className="tabular font-mono text-lg">{value}</dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="eyebrow">Your next action</p>
            <p className="mt-1 text-sm leading-6 text-ink-2">{workHint}</p>
          </div>

          {session ? (
            <div>
              <p className="eyebrow">Signed in</p>
              <p className="mt-1 text-sm">{session.staffName}</p>
            </div>
          ) : null}
        </div>
      }
      primary={
        canIntake
          ? { label: 'Register walk-in', onClick: () => router.push('/queue/new') }
          : undefined
      }
      rail={
        <>
          {canIntake ? (
            <RailButton tone="primary" onClick={() => router.push('/queue/new')}>
              Register walk-in
            </RailButton>
          ) : null}
          <RailButton onClick={refresh}>Refresh</RailButton>
        </>
      }
    >
      <PageHeader
        eyebrow={
          isNurse
            ? 'Patient intake'
            : isCounter
              ? 'Pharmacy'
              : isAdmin
                ? 'Clinic administration'
                : 'Consulting room'
        }
        title="Today’s queue"
        sub={workHint}
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {queue.length === 0 && !error ? (
        <EmptyState
          title="Nobody is waiting yet"
          direction={
            canIntake
              ? 'Register a walk-in. Their token appears immediately on every clinic screen.'
              : 'New prescriptions appear at the pharmacy counter after the doctor signs them.'
          }
        />
      ) : null}

      {queue.length > 0 ? (
        <ul className="rounded-box border border-rule bg-sheet">
          {queue.map((entry) => (
            <li
              key={entry.appointment_id}
              className={`flex items-stretch border-b border-rule last:border-b-0 ${
                entry.status === 'in_consult' ? 'bg-active-wash' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => void open(entry)}
                disabled={busy}
                aria-label={`${entry.patient_name}, token ${entry.token_no}, ${STATUS_LABEL[entry.status]}`}
                className="hoverable flex h-20 min-w-0 flex-1 items-center gap-4 px-3 text-left active:bg-paper-2 disabled:opacity-50"
              >
                <Token
                  serial={entry.token_no}
                  size="lg"
                  active={entry.status === 'in_consult'}
                />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-medium">{entry.patient_name}</span>
                  <span className="block truncate text-sm text-ink-2">
                    {[entry.age ? `${entry.age} yrs` : null, entry.sex, entry.reason]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>

                {entry.allergies ? <Badge tone="stop">Allergy: {entry.allergies}</Badge> : null}

                <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>
              </button>

              {canConsult ? (
                <button
                  type="button"
                  aria-label="Vitals"
                  onClick={() =>
                    router.push(`/vitals?appointment=${entry.appointment_id}` as Route)
                  }
                  className="hoverable my-3 mr-3 min-w-24 rounded-box border border-rule bg-sheet px-4 text-sm font-medium active:bg-paper-2"
                >
                  Vitals
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </ThreePane>
  );
}
