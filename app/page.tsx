'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { Button, EmptyState, Notice } from '@/components/ui';
import { currentSession, unlock, type StaffSession } from '@/lib/auth';

interface StaffOption {
  id: string;
  name: string;
}

const PIN_LENGTH = 6;

function destination(role: StaffSession['role']): '/admin/home' | '/counter' | '/queue' {
  if (role === 'admin') return '/admin/home';
  if (role === 'counter') return '/counter';
  return '/queue';
}

export default function SignInPage() {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [selected, setSelected] = useState<StaffOption | null>(null);
  const [pin, setPin] = useState('');
  const [needsFirstSetup, setNeedsFirstSetup] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(currentSession());
    void (async () => {
      try {
        const { needsSetup } = await import('@/lib/db/settings');
        const setup = await needsSetup();
        setNeedsFirstSetup(setup);
        if (setup !== false) return;

        const { listActiveStaff } = await import('@/lib/db/staff');
        setStaff(await listActiveStaff());
      } catch {
        setNeedsFirstSetup(undefined);
        setError('Cannot reach the clinic database.');
      }
    })();
  }, []);

  useEffect(() => {
    if (pin.length !== PIN_LENGTH || !selected || busy) return;
    setBusy(true);
    setError(null);
    void unlock(selected.id, pin)
      .then((signedIn) => {
        setSession(signedIn);
        router.replace(destination(signedIn.role));
      })
      .catch((cause: Error) => {
        setError(cause.message);
        setPin('');
      })
      .finally(() => setBusy(false));
  }, [pin, selected, busy, router]);

  if (needsFirstSetup === true) {
    return (
      <Centered>
        <div className="w-full max-w-md text-center">
          <p className="eyebrow">First setup</p>
          <h1 className="mt-1 text-3xl font-semibold">Jayamurugan Clinic</h1>
          <p className="mt-4 leading-6 text-ink-2">
            Sign in once with the clinic owner email OTP. Then add doctors, nurses and pharmacy staff from the control panel.
          </p>
          <Button variant="primary" className="mt-7 w-full" onClick={() => router.push('/access')}>
            Set up clinic
          </Button>
        </div>
      </Centered>
    );
  }

  if (session) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Signed in as {session.staffName}</h1>
        <p className="mt-3 text-ink-2 capitalize">{session.role}</p>
        <Button variant="primary" onClick={() => router.replace(destination(session.role))} className="mt-8 px-8">
          Open workspace
        </Button>
      </Centered>
    );
  }

  if (!selected) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <div className="text-center">
            <p className="eyebrow">Jayamurugan Clinic</p>
            <h1 className="mt-1 text-3xl font-semibold">Who is signing in?</h1>
            <p className="mt-3 text-sm text-ink-2">Choose your name. Your PIN opens only the workspace allowed for your role.</p>
          </div>

          {staff === null && !error ? <p className="mt-7 text-center text-ink-2">Loading staff…</p> : null}

          {staff !== null && staff.length === 0 && !error ? (
            <div className="mt-7">
              <EmptyState
                title="No staff configured"
                direction="Sign in as administrator with email OTP and add the clinic team from the control panel."
              />
            </div>
          ) : null}

          {staff !== null && staff.length > 0 ? (
            <ul className="mt-7 space-y-3">
              {staff.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => { setSelected(member); setPin(''); setError(null); }}
                    className="hoverable h-16 w-full rounded-box border border-ink bg-sheet px-5 text-left text-lg active:bg-paper-2"
                  >
                    {member.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button variant="ghost" className="mt-6 w-full" onClick={() => router.push('/access')}>
            Administrator email OTP
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-md text-center">
        <p className="eyebrow">Staff PIN</p>
        <h1 className="mt-1 text-3xl font-semibold">{selected.name}</h1>
        <p className="mt-3 text-ink-2">Enter your 6-digit PIN</p>
        <div className="mt-6 flex justify-center gap-3" aria-label="PIN entry" role="status">
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <span key={index} className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : 'bg-transparent'}`} />
          ))}
        </div>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="mx-auto mt-7 w-64 text-left">
          <Numpad
            disabled={busy}
            onDigit={(digit) => setPin((current) => (current + digit).slice(0, PIN_LENGTH))}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
          />
        </div>
        <Button variant="ghost" className="mt-7 w-full" onClick={() => { setSelected(null); setPin(''); setError(null); }}>
          Choose another person
        </Button>
        <Button variant="ghost" className="mt-2 w-full" onClick={() => router.push('/access')}>
          Administrator recovery / control panel
        </Button>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <img src="/logo-mark.png" alt="Jayamurugan Clinic" className="mb-8 h-28 w-auto" />
      {children}
    </main>
  );
}
