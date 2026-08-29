'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  GROUP_LABEL,
  destinationsFor,
  groupsFor,
  type Destination,
} from '@/lib/nav';
import { lock, type StaffSession } from '@/lib/auth';

/**
 * The one navigation in the app, and the reason no screen can be a dead end.
 *
 * It renders from lib/nav.ts rather than from anything the calling screen
 * passes in, which is the whole point: a screen cannot forget to offer a way
 * out, because a screen is not asked. /stock-take had no exit at all under the
 * old arrangement — not a bad one, none — and that was not a mistake anybody
 * made, it was what happens when twenty-six files each own their own doors.
 *
 * ── LINKS, NOT router.push ──────────────────────────────────────────────────
 *
 * Every destination is a real <Link>. Next prefetches a static route when the
 * link enters the viewport; `router.push` on a <button>, which is what all
 * twenty-six rails used, gets none of that. On a clinic's connection the
 * difference between a prefetched transition and a cold one is most of what
 * "slow to move around" actually was.
 *
 * ── ONE MODEL AT EVERY WIDTH ────────────────────────────────────────────────
 *
 * The same sheet on a phone, a portrait tablet and a 1366px landscape stand.
 * A second navigation that only appears on wide screens would mean the doctor's
 * phone and the counter tablet disagree about where things live, and the staff
 * member carrying both has to hold two maps.
 */
export function AppNav({
  open,
  onClose,
  session,
}: {
  open: boolean;
  onClose: () => void;
  session: StaffSession | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  // Same ref treatment as ui/Drawer: the handler is read at keystroke time, so
  // a parent re-render between opening and Escape cannot leave a stale close.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latestClose.current();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Moving to another screen closes the sheet. Without this the nav stays open
  // over the destination and the first thing you do on arriving is dismiss it.
  useEffect(() => {
    latestClose.current();
  }, [pathname]);

  if (!open) return null;

  const groups = groupsFor(session?.role);
  const doors = destinationsFor(session?.role);

  return (
    <div className="fixed inset-0 z-50 flex bg-ink/40" data-print="hide">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        tabIndex={-1}
        data-focus-ring="none"
        className="flex h-full w-[min(22rem,88vw)] flex-col border-r-2 border-ink bg-sheet"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">Go to</p>
            {session ? (
              <p className="mt-1 truncate text-sm text-ink-2">
                {session.staffName} · {ROLE_WORD[session.role]}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-11 shrink-0 rounded-box border border-ink px-3 text-xs font-semibold uppercase tracking-[0.08em] active:opacity-80"
          >
            Close
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {groups.map((group) => (
            <section key={group} className="mb-5 last:mb-0">
              <h2 className="eyebrow px-1">{GROUP_LABEL[group]}</h2>
              <ul className="mt-2">
                {doors
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <li key={entry.href}>
                      <NavLink entry={entry} pathname={pathname} />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>

        {/*
          Signing out was reachable from three screens out of twenty-six — the
          counter, the queue and the control panel. Anywhere else, a pharmacist
          finishing a shift on the expiry desk had to navigate back to a screen
          that happened to carry the button before they could hand the tablet
          over. On a device that is shared by four people and identified only by
          a PIN, "leave" belongs wherever "go" does.
        */}
        {session ? (
          <div className="border-t-2 border-ink p-3">
            <button
              type="button"
              onClick={() => {
                void lock().then(() => router.replace('/'));
              }}
              className="h-14 w-full rounded-box border border-ink px-4 text-xs font-semibold uppercase tracking-[0.08em] active:bg-paper-2"
            >
              Sign out
            </button>
          </div>
        ) : null}
      </div>

      {/* Tapping the darkened rest of the screen closes it. Labelled, because
          without a name this is an unreachable control to a screen reader. */}
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="h-full flex-1"
      />
    </div>
  );
}

const ROLE_WORD: Record<StaffSession['role'], string> = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  counter: 'Pharmacy',
  admin: 'Administrator',
};

/**
 * Where you already are is marked and stays tappable rather than being
 * disabled — on a shared screen the commonest reason to tap the current
 * destination is to get back to the top of it after somebody else scrolled.
 */
function NavLink({ entry, pathname }: { entry: Destination; pathname: string }) {
  const here = pathname === entry.href;

  return (
    <Link
      href={entry.href}
      aria-current={here ? 'page' : undefined}
      className={`block min-h-14 rounded-box border px-3 py-2 active:bg-paper-2 ${
        here ? 'border-ink bg-paper-2' : 'border-transparent'
      }`}
    >
      <span className="block text-lg leading-6">{entry.label}</span>
      <span className="mt-0.5 block text-sm leading-5 text-ink-2">{entry.hint}</span>
    </Link>
  );
}
