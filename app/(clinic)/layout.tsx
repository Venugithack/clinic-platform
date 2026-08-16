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

  if (session === undefined) return null;
  if (session === null) return null;

  return <div className="h-full">{children}</div>;
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
