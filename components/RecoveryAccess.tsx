'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { deviceToken } from '@/lib/auth';

/**
 * Emergency entry point only. The recovery page still has to satisfy the
 * database-side clinic/admin/PIN and recent-device checks before it can mint a
 * replacement device token.
 */
export function RecoveryAccess() {
  const pathname = usePathname();
  const [unregistered, setUnregistered] = useState(false);

  useEffect(() => {
    setUnregistered(deviceToken() === null);
  }, []);

  if (pathname !== '/' || !unregistered) return null;

  return (
    <a
      href="/recover"
      className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-box border border-rule bg-sheet px-4 py-3 text-sm text-ink-2 shadow-sm active:bg-paper-2"
    >
      No registered admin tablet available? Recover access
    </a>
  );
}
