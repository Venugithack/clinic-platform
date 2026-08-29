'use client';

/**
 * The doctor's presence control. PLAN.md §13.2.
 *
 * Four buttons, big, in his window: In clinic · With a patient · Back by HH:MM ·
 * Done for the day. One tap on the way out, which is the whole ask.
 *
 * The panel underneath is the part that earns trust. It shows **what a patient
 * is being told right now**, which is not always what he last said — a tablet
 * that has not pinged for six minutes reads `away` however firmly he tapped "in
 * clinic" at nine. Showing both, side by side, is how he learns to believe the
 * page rather than argue with it.
 */
import { useCallback, useEffect, useState } from 'react';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import { clinicNow, presenceDetail, type ClinicNow, type PresenceDetail } from '@/lib/db/presence';
import {
  closeClinicToday,
  reopenClinicToday,
  setPresence,
  type PresenceStatus,
} from '@/lib/transitions/presence';
import { currentSession } from '@/lib/auth';

const WORDING: Record<string, string> = {
  in_clinic: 'in the clinic',
  in_consult: 'with a patient',
  break: 'stepped out',
  away: 'not in the clinic',
  closed: 'the clinic is closed',
};

function asOf(at: string | null): string {
  if (!at) return 'never';
  const minutes = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export default function PresencePage() {
  const [now, setNow] = useState<ClinicNow | null>(null);
  const [rows, setRows] = useState<PresenceDetail[]>([]);
  const [backBy, setBackBy] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = currentSession();
  const isDoctor = session?.role === 'doctor' || session?.role === 'admin';

  const refresh = useCallback(() => {
    // Cleared before the reads, never after them. A read landing is not
    // evidence that the last WRITE succeeded, and clearing on completion
    // erased a refusal somebody was in the middle of reading (M11e).
    setError(null);
    void (async () => {
      try {
        setNow(await clinicNow());
        setRows(await presenceDetail());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    // The reading ages while he looks at it, so it is re-read rather than left
    // to go quietly stale on screen.
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const set = async (status: PresenceStatus, until?: Date) => {
    setBusy(true);
    setError(null);
    try {
      await setPresence(status, until);
      setNotice(`Patients now see: ${WORDING[status]}.`);
      setBackBy(null);
      setDigits('');
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const backAt = () => {
    // HHMM, tapped. A time picker on a tablet is four taps and a scroll.
    const hh = Number(digits.slice(0, 2));
    const mm = Number(digits.slice(2, 4));
    const until = new Date();
    until.setHours(hh, mm, 0, 0);
    if (until.getTime() < Date.now()) until.setDate(until.getDate() + 1);
    void set('break', until);
  };

  const mine = rows.find((row) => row.staff_id === session?.staffId);

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">
            What patients see
          </h2>

          {now ? (
            <>
              <p className="mt-2 text-2xl">
                {now.doctor_name} is {WORDING[now.status] ?? now.status}
              </p>
              {/* Never "available". A stale reading must not read as a promise. */}
              <p className="tabular mt-1 text-sm text-ink-2">
                as of {asOf(now.as_of)}
              </p>
              {now.break_until && now.status === 'break' ? (
                <p className="mt-1 text-sm text-ink-2">
                  back by{' '}
                  {new Date(now.break_until).toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              ) : null}
              {!now.clinic_open ? (
                <p className="mt-3 rounded-box bg-paper-2 p-3 text-sm">
                  The clinic is closed right now, so the page says closed
                  whatever this tablet is doing.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-ink-2">Loading…</p>
          )}

          {mine ? (
            <p className="mt-6 text-sm text-ink-2">
              You last said: {WORDING[mine.declared_status]} ·{' '}
              {mine.device_label ?? 'unknown device'}
              {mine.is_clinic_device === false ? ' (not a clinic device)' : ''}
            </p>
          ) : null}
        </div>
      }
      primary={
        isDoctor
          ? { label: 'In clinic', onClick: () => void set('in_clinic'), disabled: busy }
          : undefined
      }
      rail={
        <>
          {isDoctor ? (
            <>
              <RailButton tone="primary" disabled={busy} onClick={() => void set('in_clinic')}>
                In clinic
              </RailButton>
              <RailButton disabled={busy} onClick={() => void set('in_consult')}>
                With a patient
              </RailButton>
              <RailButton
                disabled={busy}
                onClick={() => {
                  setBackBy('open');
                  setDigits('');
                }}
              >
                Back by…
              </RailButton>
              <RailButton disabled={busy} onClick={() => void set('away')}>
                Done for the day
              </RailButton>
            </>
          ) : (
            <p className="text-sm text-ink-2">
              The doctor sets his own status. This screen shows what patients are
              being told.
            </p>
          )}

          <RailButton onClick={refresh}>Refresh</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Clinic" title="Presence" />

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {backBy ? (
        <div className="mt-4 max-w-md rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">Back by</p>
          <p className="tabular mt-2 text-4xl font-medium">
            {digits.padEnd(4, '–').replace(/(.{2})(.{2})/, '$1:$2')}
          </p>
          <div className="mt-4 w-64">
            <Numpad
              onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 4))}
              onBackspace={() => setDigits((c) => c.slice(0, -1))}
            />
          </div>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={busy || digits.length < 4}
              onClick={backAt}
              className="h-14 flex-1 rounded-box border border-ink bg-ink px-4 font-medium text-paper disabled:opacity-40"
            >
              Tell patients
            </button>
            <button
              type="button"
              onClick={() => setBackBy(null)}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* The unexpected closure — the one thing §13.3 says is worth a push. */}
      {isDoctor ? (
        <>
          <h2 className="mt-8 text-lg font-medium">The whole day</h2>
          {now && !now.clinic_open ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void reopenClinicToday()
                  .then(() => {
                    setNotice('Open again.');
                    refresh();
                  })
                  .catch((cause: Error) => setError(cause.message))
                  .finally(() => setBusy(false));
              }}
              className="mt-2 h-14 rounded-box border border-ink px-6 font-medium active:bg-paper-2"
            >
              Open the clinic again
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setClosing(true)}
              className="mt-2 h-14 rounded-box border border-stop px-6 font-medium text-stop active:bg-paper-2"
            >
              Close the clinic today
            </button>
          )}

          {closing ? (
            <div className="mt-4 max-w-xl rounded-box border border-stop bg-sheet p-4">
              <label className="block text-sm text-ink-2" htmlFor="reason">
                Why? Patients will be told this.
              </label>
              <input
                id="reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="blank mt-1 h-14 w-full px-3 text-lg"
              />
              <button
                type="button"
                disabled={busy || reason.trim() === ''}
                onClick={() => {
                  setBusy(true);
                  void closeClinicToday(reason)
                    .then((affected) => {
                      setNotice(
                        affected === 0
                          ? 'Closed. Nobody had an appointment today.'
                          : `Closed. ${affected} patient${
                              affected === 1 ? '' : 's'
                            } already had an appointment today — they are the ones worth a message.`,
                      );
                      setClosing(false);
                      setReason('');
                      refresh();
                    })
                    .catch((cause: Error) => setError(cause.message))
                    .finally(() => setBusy(false));
                }}
                className="mt-3 h-14 w-full rounded-box border border-stop bg-stop font-medium text-paper disabled:opacity-40"
              >
                Close today
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Everyone</h2>
      <div className="min-w-0 overflow-x-auto">
        <table className="mt-2 w-full max-w-3xl">
        <thead>
          <tr className="border-b border-rule text-left text-sm text-ink-2">
            <th className="py-2">Who</th>
            <th>Said</th>
            <th>Patients are told</th>
            <th>Last heard</th>
            <th>Device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.staff_id} className="border-b border-rule">
              <td className="py-3">{row.staff_name}</td>
              <td className="text-ink-2">{WORDING[row.declared_status]}</td>
              <td
                className={
                  row.declared_status !== row.effective_status ? 'text-stop' : ''
                }
              >
                {WORDING[row.effective_status]}
              </td>
              <td className="tabular text-sm text-ink-2">
                {asOf(row.last_heartbeat_at)}
              </td>
              <td className="text-sm text-ink-2">
                {row.device_label ?? '—'}
                {row.is_clinic_device === false ? ' · not in the clinic' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </ThreePane>
  );
}
