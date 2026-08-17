'use client';

/**
 * The authenticated clinic shell.
 *
 * The guard here is not the security boundary — RLS and the transitions are,
 * and they would refuse a request from an unidentified caller anyway. This just
 * means the staff see the lock screen instead of a screen full of errors.
 *
 * Pages compose their own panes with <ThreePane>, so this stays a wrapper.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentSession, touch, type StaffSession } from '@/lib/auth';
import { presencePing } from '@/lib/transitions/presence';
import { CounterQueries } from '@/components/CounterQueries';
import { WriteQueue } from '@/components/WriteQueue';

export default function ClinicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);

  useEffect(() => {
    const existing = currentSession();
    setSession(existing);
    if (!existing) router.replace('/');
  }, [router]);

  // The idle lock is extended by activity, not by a timer (TABLET.md §5). A
  // tablet left on the counter locks itself; one being used does not.
  useEffect(() => {
    if (!session) return;

    const onActivity = () => {
      void touch().then((alive) => {
        if (!alive) router.replace('/');
      });
    };

    const throttled = throttle(onActivity, 30_000);
    window.addEventListener('pointerdown', throttled);
    return () => window.removeEventListener('pointerdown', throttled);
  }, [session, router]);

  // The heartbeat (PLAN.md §13.2). Every 30 seconds while a session is live;
  // five minutes of silence and the public page stops claiming he is here. A
  // failed ping is deliberately not surfaced — the consequence of missing one
  // is an older "as of" on that page, which is the honest reading anyway.
  useEffect(() => {
    if (!session) return;

    const ping = () => void presencePing().catch(() => {});
    ping();
    const timer = setInterval(ping, 30_000);
    return () => clearInterval(timer);
  }, [session]);

  if (session === undefined) return null;
  if (session === null) return null;

  return (
    <div className="flex h-full flex-col">
      {/* The counter's questions ride above every clinic screen, because the
          doctor is not reliably sitting on the consult screen when the
          pharmacist reaches the shelf (PLAN.md §11.1). */}
      {/* Anything this tablet is holding because the network was not there.
          Absent when there is nothing waiting — a permanent "0 waiting" badge
          teaches people to stop reading it (PLAN.md §16). */}
      <WriteQueue />
      <CounterQueries />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function throttle(fn: () => void, ms: number): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    }
  };
}
