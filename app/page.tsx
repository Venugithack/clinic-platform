'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { Button, EmptyState, Notice } from '@/components/ui';
import { currentSession, deviceToken, unlock, type StaffSession } from '@/lib/auth';

interface StaffOption {
  id: string;
  name: string;
}

const PIN_LENGTH = 6;

export default function LockScreen() {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [selected, setSelected] = useState<StaffOption | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(true);
  const [virgin, setVirgin] = useState<boolean | undefined>(undefined);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setSession(currentSession());
    setRegistered(deviceToken() !== null);
  }, []);

  useEffect(() => {
    if (registered) return;
    setAsking(true);
    void (async () => {
      try {
        const { needsSetup } = await import('@/lib/db/settings');
        setVirgin(await needsSetup());
      } finally {
        setAsking(false);
      }
    })();
  }, [registered]);

  useEffect(() => {
    if (!registered) return;

    let settled = false;
    const giveUp = setTimeout(() => {
      if (!settled) setError('Cannot reach the clinic database.');
    }, 10_000);

    void (async () => {
      try {
        const { listActiveStaff } = await import('@/lib/db/staff');
        const rows = await listActiveStaff();
        settled = true;
        setStaff(rows);
        setError(null);
      } catch {
        settled = true;
        setError('Cannot reach the clinic database.');
      } finally {
        clearTimeout(giveUp);
      }
    })();

    return () => clearTimeout(giveUp);
  }, [registered]);

  useEffect(() => {
    if (pin.length !== PIN_LENGTH || !selected || busy) return;
    setBusy(true);
    setError(null);
    void unlock(selected.id, pin)
      .then(setSession)
      .catch((cause: Error) => {
        setError(cause.message);
        setPin('');
      })
      .finally(() => setBusy(false));
  }, [pin, selected, busy]);

  if (!registered && asking) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Just a moment</h1>
        <p className="mt-3 max-w-md text-center text-ink-2">Reaching the clinic database.</p>
      </Centered>
    );
  }

  if (!registered) {
    const first = virgin === true;
    return (
      <Centered>
        <div className="w-full max-w-md text-center">
          <p className="eyebrow">{first ? 'First setup' : 'New device'}</p>
          <h1 className="mt-1 text-2xl font-semibold">
            {first ? 'Set up Jayamurugan Clinic' : 'Trust this device'}
          </h1>
          <p className="mt-3 leading-6 text-ink-2">
            {first
              ? 'Sign in with the clinic owner email once, create the administrator, and choose a PIN.'
              : 'Sign in with an authorized administrator or doctor email once. After that, staff use their usual 6-digit PIN.'}
          </p>
          {virgin === undefined && !asking ? (
            <Notice tone="bad">Cannot confirm the clinic setup state. Check the connection and try again.</Notice>
          ) : null}
          <Button
            variant="primary"
            disabled={virgin === undefined}
            onClick={() => router.push('/access')}
            className="mt-7 w-full"
          >
            {first ? 'Start setup' : 'Continue with email'}
          </Button>
          <p className="mt-4 text-xs leading-5 text-ink-2">
            Email is the recovery key. Daily staff sign-in stays name + PIN.
          </p>
        </div>
      </Centered>
    );
  }

  if (session) {
    const goesToCounter = session.role === 'counter';
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Signed in as {session.staffName}</h1>
        <p className="mt-3 text-ink-2">{goesToCounter ? 'Pharmacy counter' : 'Clinic workspace'}</p>
        <Button
          variant="primary"
          onClick={() => router.replace(goesToCounter ? '/counter' : '/queue')}
          className="mt-8 px-8"
        >
          {goesToCounter ? 'Open the counter' : 'Open the queue'}
        </Button>
      </Centered>
    );
  }

  if (!selected) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Who is this?</h1>
        <p className="mt-2 text-sm text-ink-2">Choose your name, then enter your PIN.</p>

        {staff === null && !error ? <p className="mt-6 text-ink-2">Reading the staff list…</p> : null}

        {staff !== null && staff.length === 0 && !error ? (
          <div className="mt-6 w-full max-w-md">
            <EmptyState
              title="Nobody can sign in on this device yet"
              direction="An administrator adds staff under People and tablets. Device ownership is managed by authorized email access."
            />
          </div>
        ) : null}

        {staff !== null && staff.length > 0 ? (
          <ul className="mt-6 w-full max-w-md space-y-3">
            {staff.map((member) => (
              <li key={member.id}>
                <button
                  type="button"
                  onClick={() => setSelected(member)}
                  className="hoverable h-14 w-full rounded-box border border-ink bg-sheet px-5 text-left text-lg active:bg-paper-2"
                >
                  {member.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="text-2xl font-semibold">{selected.name}</h1>
      <p className="mt-2 text-ink-2">Enter your 6-digit PIN</p>
      <div className="mt-6 flex gap-3" aria-label="PIN entry" role="status">
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <span
            key={index}
            className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : 'bg-transparent'}`}
          />
        ))}
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="mt-8 w-64">
        <Numpad
          disabled={busy}
          onDigit={(digit) => setPin((current) => (current.length < PIN_LENGTH ? current + digit : current))}
          onBackspace={() => setPin((current) => current.slice(0, -1))}
        />
      </div>
      <Button
        variant="ghost"
        size="lg"
        onClick={() => {
          setSelected(null);
          setPin('');
          setError(null);
        }}
        className="mt-8 px-6"
      >
        Not me
      </Button>
      <Button
        variant="ghost"
        size="lg"
        onClick={() => router.push('/access')}
        className="mt-2 px-6"
      >
        Forgot PIN? Use owner email
      </Button>
      <p className="mt-3 max-w-sm text-center text-xs leading-5 text-ink-2">
        Owner email can recover access to this device without database changes.
      </p>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full flex-col items-center justify-center p-10">
      <img src="/logo-mark.png" alt="Jayamurugan Clinic" className="mb-8 h-28 w-auto" />
      {children}
    </main>
  );
}
