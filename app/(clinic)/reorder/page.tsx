'use client';

import { GoToDesk } from '@/components/GoToDesk';
import { RunningOutPanel } from '@/components/panels/RunningOut';

/**
 * What is running out moved onto a desk. This is the forwarding address.
 *
 * Kept rather than deleted because this URL is in the E2E suite and in whatever
 * staff pinned to a home screen — an installed PWA reopens where it was closed,
 * so deleting the route means somebody's tablet opens on a 404 the morning
 * after a deploy.
 *
 * The screen is passed through for the reader this job does not belong to: they
 * are shown it, and it refuses in a sentence, rather than being redirected
 * somewhere else without explanation. See components/GoToDesk.tsx.
 */
export default function Moved() {
  return (
    <GoToDesk job="low-stock">
      <RunningOutPanel />
    </GoToDesk>
  );
}
