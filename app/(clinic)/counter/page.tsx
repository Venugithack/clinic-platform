'use client';

import { Desk } from '@/components/Desk';

/**
 * The pharmacy desk.
 *
 * Everything this person does is here, on tabs, rather than behind the "Go to"
 * drawer that used to hold twenty destinations. Which panel is showing is
 * `?tab=` and `?section=`; see lib/workspaces.ts for why, and
 * components/Desk.tsx for how.
 */
export default function PharmacyDesk() {
  return <Desk id="pharmacy" />;
}
