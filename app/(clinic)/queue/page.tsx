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
    // Cleared before the read, never after it. A read landing is not evidence
    // that the last WRITE succeeded, and clearing on completion erased a
    // refusal somebody was in the middle of reading (M11e).
    setError(null);
    void todaysQueue()
      .then(setQueue)
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
  // The state between the two ends, which the summary used to skip. With it
  // missing the rail could read "Waiting 0 · Seen 0" over a list of people who
  // were all mid-consult — true of both numbers, and wrong about the room.
  const inConsult = queue.filter((entry) => entry.status === 'in_consult').length;
  const done = queue.filter((entry) => entry.status === 'done').length;
  const session = currentSession();

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
              {session.role === 'admin' ? (
                <RailButton onClick={() => router.push('/admin')}>People</RailButton>
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
      {/* No action here: "Register walk-in" already lives in the rail, and two
          buttons with one name is an ambiguous target for a finger and for the
          e2e suite alike. The rail is this app's action surface. */}
      <PageHeader eyebrow="Consulting room" title="Queue" sub={today} />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {queue.length === 0 && !error ? (
        <EmptyState
          title="Nobody has a token yet"
          direction="Register a walk-in from the rail on the right. The token appears here and on the counter's tablet at the same moment."
        />
      ) : null}

      {queue.length > 0 ? (
        <ul className="rounded-box border border-rule bg-sheet">
          {queue.map((entry) => (
            <li key={entry.appointment_id} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                onClick={() => void open(entry)}
                disabled={busy}
                className={`hoverable flex h-20 w-full items-center gap-4 px-3 text-left active:bg-paper-2 disabled:opacity-50 ${
                  entry.status === 'in_consult' ? 'bg-active-wash' : ''
                }`}
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

                {/* Allergies are the one thing that must be visible before the
                    doctor opens the record, not inside it. */}
                {entry.allergies ? (
                  <Badge tone="stop">{entry.allergies}</Badge>
                ) : null}

                <Badge tone={STATUS_TONE[entry.status]}>
                  {STATUS_LABEL[entry.status]}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </ThreePane>
  );
}
