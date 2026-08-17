'use client';

/**
 * The queue — the default screen on both tablets (TABLET.md §7).
 *
 * Big rows, token number dominant, one tap to open. Twelve rows at a tappable
 * height is the right density; if the list needs more it needs a filter, not
 * smaller rows.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
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

export default function QueuePage() {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void todaysQueue()
      .then((rows) => {
        setQueue(rows);
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  const open = async (entry: QueueEntry) => {
    if (busy) return;
    setBusy(true);
    try {
      // Only move the state machine forward when there is somewhere to go.
      // Re-opening a finished consult must not reopen the appointment.
      if (entry.status === 'waiting' || entry.status === 'booked') {
        await setAppointmentStatus(entry.appointment_id, 'in_consult');
      }
      router.push(`/consult/${entry.appointment_id}` as Route);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const waiting = queue.filter((entry) => entry.status === 'waiting').length;
  const done = queue.filter((entry) => entry.status === 'done').length;
  const session = currentSession();

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Today</h2>
          <p className="mt-1 text-lg">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>

          <dl className="mt-6 space-y-3">
            <div className="flex justify-between">
              <dt className="text-muted">Waiting</dt>
              <dd className="tabular text-lg">{waiting}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Seen</dt>
              <dd className="tabular text-lg">{done}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Tokens issued</dt>
              <dd className="tabular text-lg">{queue.length}</dd>
            </div>
          </dl>

          {session ? (
            <p className="mt-8 text-sm text-muted">
              Signed in as {session.staffName}
            </p>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton tone="primary" onClick={() => router.push('/queue/new')}>
            Register walk-in
          </RailButton>
          <RailButton onClick={() => router.push('/presence')}>Presence</RailButton>
          <RailButton onClick={() => router.push('/reports')}>Reports</RailButton>
          {/* Doctor and admin only — it is where the drug master comes from,
              and the counter has no business rewriting what a strip is. */}
          {session?.role === 'doctor' || session?.role === 'admin' ? (
            <>
              <RailButton onClick={() => router.push('/import')}>Import</RailButton>
              <RailButton onClick={() => router.push('/settings')}>Settings</RailButton>
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
      <h1 className="text-2xl font-semibold">Queue</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      {queue.length === 0 && !error ? (
        <p className="mt-6 text-muted">
          Nobody has been given a token today. Register a walk-in to start.
        </p>
      ) : null}

      <ul className="mt-4">
        {queue.map((entry) => (
          <li key={entry.appointment_id}>
            <button
              type="button"
              onClick={() => void open(entry)}
              disabled={busy}
              className="flex h-20 w-full items-center gap-5 border-b border-line px-3 text-left active:bg-line disabled:opacity-50"
            >
              <span className="tabular w-16 shrink-0 text-3xl font-medium">
                {entry.token_no}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{entry.patient_name}</span>
                <span className="block truncate text-sm text-muted">
                  {[entry.age ? `${entry.age}` : null, entry.sex, entry.reason]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>

              {/* Allergies are the one thing that must be visible before the
                  doctor opens the record, not inside it. */}
              {entry.allergies ? (
                <span className="shrink-0 rounded bg-danger/10 px-2 py-1 text-sm text-danger">
                  {entry.allergies}
                </span>
              ) : null}

              <span className="w-28 shrink-0 text-right text-sm text-muted">
                {STATUS_LABEL[entry.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
