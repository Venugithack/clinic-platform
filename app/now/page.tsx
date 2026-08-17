'use client';

/**
 * The public status page. PLAN.md §13.3.
 *
 * Pull, not push. A permanent link that is always current, costs nothing to
 * send, and can be pinned in the WhatsApp business profile, printed on the card
 * and stuck on the door as a QR code. It replaces the "doctor has arrived"
 * broadcast the clinic asked for — which is marketing-category WhatsApp traffic
 * and gets a number reported (PLAN.md §18.2).
 *
 * Phone-first and three seconds on 3G: this is the one screen in the build that
 * is not a tablet screen (TABLET.md §7).
 *
 * The wording is the feature. **Never "available".** Every reading is a
 * sentence plus the time it was true, because a patient who drives twenty
 * kilometres to a locked door blames the app, and is right to (rule 6). If the
 * heartbeat is old the page says so in its own words rather than quietly
 * showing a stale green light.
 *
 * It reads one anon-selectable view carrying the clinic's name, the doctor's
 * name and a status. No patient, no appointment, no token — nothing about
 * anybody who has ever walked in.
 */
import { useCallback, useEffect, useState } from 'react';
import { clinicNow, type ClinicNow } from '@/lib/db/presence';

const SENTENCE: Record<string, string> = {
  in_clinic: 'is in the clinic',
  in_consult: 'is in the clinic, with a patient',
  break: 'has stepped out',
  away: 'is not in the clinic',
  closed: 'is closed right now',
};

function asOf(at: string | null): string {
  if (!at) return 'we have not heard from the clinic today';
  const minutes = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'as of just now';
  if (minutes === 1) return 'as of 1 minute ago';
  if (minutes < 60) return `as of ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'as of 1 hour ago' : `as of ${hours} hours ago`;
}

export default function NowPage() {
  const [now, setNow] = useState<ClinicNow | null>(null);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    void clinicNow()
      .then((row) => {
        setNow(row);
        setChecked(new Date());
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    // A page left open on a phone in a waiting room should not go stale.
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (failed) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold">We cannot check right now</h1>
        <p className="mt-2 text-muted">
          Please call the clinic. This page will work again shortly.
        </p>
      </main>
    );
  }

  if (!now) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p className="text-muted">Checking…</p>
      </main>
    );
  }

  const closed = now.status === 'closed';
  const here = now.status === 'in_clinic' || now.status === 'in_consult';

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-lg text-muted">{now.clinic_name}</h1>

      <p
        className={`mt-4 text-3xl font-medium ${
          here ? 'text-ok' : closed ? 'text-ink' : 'text-danger'
        }`}
        data-testid="status"
      >
        {closed
          ? `${now.clinic_name} ${SENTENCE.closed}`
          : `${now.doctor_name ?? 'The doctor'} ${SENTENCE[now.status] ?? ''}`}
      </p>

      {/* The half of the sentence that stops it being a promise. */}
      <p className="tabular mt-2 text-muted" data-testid="as-of">
        {closed ? 'Opening hours are on the door.' : asOf(now.as_of)}
      </p>

      {now.status === 'break' && now.break_until ? (
        <p className="mt-2 text-lg">
          Back by{' '}
          {new Date(now.break_until).toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      ) : null}

      {now.status === 'away' && !closed ? (
        <p className="mt-4 text-muted">
          The clinic is open, but we have not heard from the doctor&rsquo;s
          tablet recently. Please call before travelling.
        </p>
      ) : null}

      <p className="mt-10 text-sm text-muted">
        This page is live. Refresh it any time — it is always the current
        answer, and it is never a booking.
      </p>

      {checked ? (
        <p className="tabular mt-1 text-xs text-muted">
          checked {checked.toLocaleTimeString('en-IN')}
        </p>
      ) : null}
    </main>
  );
}
