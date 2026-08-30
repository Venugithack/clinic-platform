'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { currentSession, type StaffSession } from '@/lib/auth';
import { findJob } from '@/lib/workspaces';

/**
 * What is left at the twenty routes the desks replaced.
 *
 * ── WHY NOT JUST DELETE THEM ────────────────────────────────────────────────
 *
 * `/receiving` and the rest were real URLs for months. They are in the E2E
 * suite, in whatever a staff member pinned to a home screen, and in the PWA's
 * saved state — an installed PWA reopens where it was closed, so deleting the
 * route means a pharmacist's tablet opens on a 404 the morning after a deploy
 * and nobody can tell them why.
 *
 * ── WHY THE DESTINATION IS COMPUTED ─────────────────────────────────────────
 *
 * The same job is in different places for different people: suppliers sits
 * under Buying for the pharmacist and under Catalogue for the owner. So a stub
 * names the JOB and `findJob` resolves it against the reader's own desks,
 * rather than every stub hard-coding a URL that is right for one role and wrong
 * for the other — which is the mistake the old rails made eleven times over
 * with `router.push('/counter')`.
 *
 * ── AND WHY A JOB THAT IS NOT YOURS STILL SHOWS YOU THE SCREEN ──────────────
 *
 * The first draft forwarded everybody: a pharmacist opening `/import` was
 * quietly deposited back on the counter. That threw away something this app is
 * deliberate about — /import, /settings, /medicines and /suppliers each REFUSE
 * in a sentence, and the E2E suite says why: "the database would refuse it too
 * (CL005); this is so the pharmacist is told that in a sentence rather than by
 * a failure."
 *
 * A silent redirect is exactly the failure that sentence exists to prevent. So
 * when the job is on one of your desks you are taken there, and when it is not
 * you are shown the screen, which explains itself.
 *
 * ── THE QUERY SURVIVES ──────────────────────────────────────────────────────
 *
 * `/receiving?po=…` is "receive against that order", and a redirect that kept
 * the destination and dropped the `po` would land the pharmacist on an empty
 * Add stock with no way to tell which order they were answering.
 */
export function GoToDesk({ job, children }: { job: string; children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Forward job={job}>{children}</Forward>
    </Suspense>
  );
}

function Forward({ job, children }: { job: string; children: React.ReactNode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [read, setRead] = useState(false);

  // After mount, never during render — this route is prerendered at build time
  // where there is no storage to read. Same rule as ThreePane and Desk.
  useEffect(() => {
    setSession(currentSession());
    setRead(true);
  }, []);

  const target = read ? findJob(session?.role, job) : null;

  useEffect(() => {
    if (!read || !target) return;

    const carried = new URLSearchParams(params);
    carried.delete('tab');
    carried.delete('section');

    const query = carried.toString();
    const joiner = target.includes('?') ? '&' : '?';
    router.replace((query ? `${target}${joiner}${query}` : target) as Route);
  }, [read, target, params, router]);

  // Nothing until the session is read, then either a redirect in flight (null)
  // or the screen itself, to say in a sentence why this is not your job.
  if (!read || target) return null;
  return <>{children}</>;
}
