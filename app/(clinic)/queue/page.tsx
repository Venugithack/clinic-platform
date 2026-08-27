'use client';

/**
 * The queue — the default screen on both tablets (TABLET.md §7).
 *
 * Big rows, token dominant, one tap to open. Twelve rows at a tappable height
 * is the right density; if the list needs more it needs a filter, not smaller
 * rows.
 *
 * The token box is the signature object of the system and this is where it is
 * seen most: the number the patient is holding, the number called out, and the
 * number the doctor opens. The row that is in consult is the one place on this
 * screen that carries the accent, and there is at most one of them.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import {
  Badge,
  EmptyState,
  Notice,
  PageHeader,
  Token,
} from '@/components/ui';
import { todaysQueue, type QueueEntry } from '@/lib/db/queue';
import { setAppointmentStatus } from '@/lib/transitions/clinic';
import { currentSession, lock } from '@/lib/auth';

const STATUS_LABEL: Record<QueueEntry['status'], string> = {
  booked: 'Booked',
  waiting: 'Waiting',
  in_consult: 'In consult',
  done: 'Done',
  no_show: 'No show',
};

/** Law 2: the tone is the meaning, and the word is always there beside it. */
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

  const refresh = useCallback(() => {
    setError(null);
    void todaysQueue()
      .then(setQueue)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  const open = async (entry: QueueEntry) => {
    if (busy) return;

    const role = currentSession()?.role;

    // A nurse's primary queue action is intake, never consultation.
    if (role === 'nurse') {
      router.push(`/vitals?appointment=${entry.appointment_id}` as Route);
      return;
    }

    // The pharmacy still sees the queue, but cannot move clinical state.
    if (role === 'counter') {
      router.push('/counter');
      return;
    }

    // Doctor and the first-run admin use the consultation side of the clinic.
    if (role !== 'doctor' && role !== 'admin') return;

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
  const session = currentSession();
  const canIntake =
    session?.role === 'doctor' || session?.role === 'nurse' || session?.role === 'admin';

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

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

          {session ? (
            <div>
              <p className="eyebrow">Signed in</p>
              <p className="mt-1 text-sm">{session.staffName}</p>
            </div>
          ) : null}
        </div>
      }
      rail={
        <>
          {canIntake ? (
            <RailButton tone="primary" onClick={() => router.push('/queue/new')}>
              Register walk-in
            </RailButton>
          ) : null}
          {session?.role === 'counter' ? (
            <RailButton onClick={() => router.push('/counter')}>Counter</RailButton>
          ) : null}
          <RailButton onClick={() => router.push('/presence')}>Presence</RailButton>
          <RailButton onClick={() => router.push('/reports')}>Reports</RailButton>
          {session?.role === 'doctor' || session?.role === 'admin' ? (
            <>
              <RailButton onClick={() => router.push('/import')}>Import</RailButton>
              <RailButton onClick={() => router.push('/settings')}>Settings</RailButton>
              {session.role === 'admin' ? (
                <RailButton onClick={() => router.push('/admin/home')}>Admin</RailButton>
              ) : null}
            </>
          ) : null}
          <RailButton onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton
            onClick={() => {
              void lock().then(() => router.replace('/'));
            }}
          >
            Lock
          </RailButton>
        </>
      }
    >
      <PageHeader
        eyebrow={
          session?.role === 'nurse'
            ? 'Patient intake'
            : session?.role === 'counter'
              ? 'Pharmacy'
              : 'Consulting room'
        }
        title="Queue"
        sub={today}
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {queue.length === 0 && !error ? (
        <EmptyState
          title="Nobody has a token yet"
          direction={
            canIntake
              ? 'Register a walk-in from the rail on the right. The token appears here and on the counter tablet at the same moment.'
              : 'New patients appear here when the clinical team gives them a token.'
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
                className="hoverable flex h-20 min-w-0 flex-1 items-center gap-4 px-3 text-left active:bg-paper-2 disabled:opacity-50"
              >
                <Token
                  serial={entry.token_no}
                  size="lg"
                  active={entry.status === 'in_consult'}
                />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg">{entry.patient_name}</span>
                  <span className="block truncate text-sm text-ink-2">
                    {[entry.age ? `${entry.age}` : null, entry.sex, entry.reason]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>

                {entry.allergies ? (
                  <Badge tone="stop">{entry.allergies}</Badge>
                ) : null}

                <Badge tone={STATUS_TONE[entry.status]}>
                  {STATUS_LABEL[entry.status]}
                </Badge>
              </button>

              {canIntake ? (
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
