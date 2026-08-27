'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { currentSession } from '@/lib/auth';

/**
 * The root lock screen historically sent every non-doctor to /counter.
 * Nurses are clinical-intake staff, not pharmacy staff, so keep that old
 * fallback harmless until the root landing screen is refactored separately.
 */
export default function CounterLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const role = currentSession()?.role;

  useEffect(() => {
    if (role === 'nurse') router.replace('/queue');
  }, [role, router]);

  if (role === 'nurse') return null;
  return children;
}
