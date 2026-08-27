'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { currentSession, ownerSession, touch, type StaffSession } from '@/lib/auth';
import { presencePing } from '@/lib/transitions/presence';
import { CounterQueries } from '@/components/CounterQueries';
import { WriteQueue } from '@/components/WriteQueue';

const ADMIN_FORBIDDEN_OPERATIONAL_ROUTES = ['/queue', '/counter'] as const;

export default function ClinicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);

  useEffect(() => {
    const existing = currentSession();
    if (existing) {
      setSession(existing);
      return;
    }

    // A verified administrator OTP may survive a page refresh even when the
    // lightweight sessionStorage UI marker does not. Rebuild it from the bound
    // Supabase identity before sending the owner back to the sign-in screen.
    void ownerSession().then((owner) => {
      setSession(owner);
      if (!owner) router.replace('/');
    });
  }, [router]);

  useEffect(() => {
    if (!session || session.role !== 'admin') return;
    const sentToOperationalScreen = ADMIN_FORBIDDEN_OPERATIONAL_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    );
    if (sentToOperationalScreen) router.replace('/admin/home');
  }, [pathname, router, session]);

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

  useEffect(() => {
    if (!session || session.role === 'admin') return;
    const ping = () => void presencePing().catch(() => {});
    ping();
    const timer = setInterval(ping, 30_000);
    return () => clearInterval(timer);
  }, [session]);

  if (session === undefined || session === null) return null;

  return (
    <div className="flex h-full flex-col">
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
