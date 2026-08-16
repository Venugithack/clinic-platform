'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { currentSession, deviceToken, unlock, type StaffSession } from '@/lib/auth';

/**
 * The lock screen. TABLET.md §5.
 *
 * Email-and-password on a shared tablet, several times a day, will be defeated
 * by the staff within a week — they will pick a short password or never log
 * out. So the device holds the session and a six-digit PIN holds the identity.
 * Every write then carries the staff id from the PIN, which is what lets the
 * audit log and the Schedule H1 register name a person rather than a tablet.
 */

interface StaffOption {
  id: string;
  name: string;
}

const PIN_LENGTH = 6;

export default function LockScreen() {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selected, setSelected] = useState<StaffOption | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(true);

  useEffect(() => {
    setSession(currentSession());
    setRegistered(deviceToken() !== null);
  }, []);

  useEffect(() => {
    if (!registered) return;
    void (async () => {
      try {
        // Read through the seam; lib/db is the only module that knows Supabase.
        const { listActiveStaff } = await import('@/lib/db/staff');
        setStaff(await listActiveStaff());
        setError(null);
      } catch {
        setError('Cannot reach the clinic database.');
      }
    })();
  }, [registered]);

  useEffect(() => {
    if (pin.length !== PIN_LENGTH || !selected || busy) return;

    setBusy(true);
    setError(null);

    void unlock(selected.id, pin)
      .then(setSession)
      .catch((cause: Error) => {
        // Undifferentiated by design: a lock screen that tells you which half
        // you got right is a lock screen that helps.
        setError(cause.message);
        setPin('');
      })
      .finally(() => setBusy(false));
  }, [pin, selected, busy]);

  if (!registered) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">This tablet is not registered</h1>
        <p className="mt-3 max-w-md text-muted">
          Ask the administrator to register it before signing in. A PIN alone is
          useless on an unregistered device.
        </p>
      </Centered>
    );
  }

  if (session) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Signed in as {session.staffName}</h1>
        <p className="mt-3 text-muted">
          {session.role === 'doctor' ? 'Consulting room' : 'Pharmacy counter'}
        </p>
        <button
          type="button"
          onClick={() => router.replace('/queue')}
          className="mt-8 h-14 rounded-xl border border-ink bg-ink px-8 text-lg font-medium text-white"
        >
          Open the queue
        </button>
      </Centered>
    );
  }

  if (!selected) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Who is this?</h1>
        <ul className="mt-6 w-full max-w-md space-y-3">
          {staff.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => setSelected(member)}
                className="hoverable h-14 w-full rounded-xl border border-line bg-white px-5 text-left text-lg active:bg-line"
              >
                {member.name}
              </button>
            </li>
          ))}
        </ul>
        {error ? <p className="mt-6 text-danger">{error}</p> : null}
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="text-2xl font-semibold">{selected.name}</h1>
      <p className="mt-2 text-muted">Enter your 6-digit PIN</p>

      <div className="mt-6 flex gap-3" aria-label="PIN entry" role="status">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border border-line ${
              i < pin.length ? 'bg-ink' : 'bg-transparent'
            }`}
          />
        ))}
      </div>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      <div className="mt-8 w-64">
        <Numpad
          disabled={busy}
          onDigit={(d) => setPin((p) => (p.length < PIN_LENGTH ? p + d : p))}
          onBackspace={() => setPin((p) => p.slice(0, -1))}
        />
      </div>

      <button
        type="button"
        onClick={() => {
          setSelected(null);
          setPin('');
          setError(null);
        }}
        className="mt-8 h-14 rounded-xl px-6 text-muted active:bg-line"
      >
        Not me
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full flex-col items-center justify-center p-10">
      {children}
    </main>
  );
}
