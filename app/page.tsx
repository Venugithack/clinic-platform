'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { Button, Notice } from '@/components/ui';
import { currentSession, lock, unlock, type StaffSession } from '@/lib/auth';
import { needsSetup } from '@/lib/db/settings';
import { listActiveStaff, type StaffMember } from '@/lib/db/staff';

const ROLE_LABEL: Record<StaffMember['role'], string> = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  counter: 'Pharmacy / Counter',
  admin: 'Administrator',
};

function routeFor(role: StaffSession['role']): string {
  if (role === 'admin') return '/admin/home';
  if (role === 'counter') return '/counter';
  return '/queue';
}

function openLabel(role: StaffSession['role']): string {
  if (role === 'admin') return 'Open the control panel';
  if (role === 'counter') return 'Open the counter';
  return 'Open the queue';
}

export default function SignInPage() {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(currentSession());
    void (async () => {
      try {
        const setup = await needsSetup();
        setFirstRun(setup === true);
        if (setup === false) setStaff(await listActiveStaff());
        else setStaff([]);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    if (pin.length !== 6 || !selected || busy) return;
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

  if (session) {
    return (
      <Centered>
        <div className="w-full max-w-md text-center">
          <p className="eyebrow">{ROLE_LABEL[session.role]}</p>
          <h1 className="mt-1 text-2xl font-semibold">Signed in as {session.staffName}</h1>
          <Button variant="primary" className="mt-7 w-full" onClick={() => router.replace(routeFor(session.role))}>
            {openLabel(session.role)}
          </Button>
          <Button
            variant="ghost"
            className="mt-3 w-full"
            onClick={() => void lock().then(() => { setSession(null); setSelected(null); setPin(''); })}
          >
            Sign out
          </Button>
        </div>
      </Centered>
    );
  }

  if (firstRun === null && !error) {
    return <Centered><p className="text-ink-2">Opening clinic sign-in…</p></Centered>;
  }

  if (firstRun) {
    return (
      <Centered>
        <div className="w-full max-w-md text-center">
          <p className="eyebrow">First setup</p>
          <h1 className="mt-1 text-2xl font-semibold">Jayamurugan Clinic</h1>
          <p className="mt-3 leading-6 text-ink-2">
            Verify the administrator email with a 6-digit one-time code, then configure doctors, nurses and pharmacy staff in the control panel.
          </p>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button variant="primary" className="mt-7 w-full" onClick={() => router.push('/access')}>
            Set up as administrator
          </Button>
        </div>
      </Centered>
    );
  }

  if (selected) {
    return (
      <Centered>
        <div className="w-full max-w-sm text-center">
          <p className="eyebrow">{ROLE_LABEL[selected.role]}</p>
          <h1 className="mt-1 text-2xl font-semibold">{selected.name}</h1>
          <p className="mt-2 text-ink-2">Enter your 6-digit PIN</p>
          <div className="mt-6 flex justify-center gap-3" aria-label="PIN entry" role="status">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : ''}`} />
            ))}
          </div>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="mx-auto mt-6 w-64">
            <Numpad
              disabled={busy}
              onDigit={(digit) => setPin((current) => (current + digit).slice(0, 6))}
              onBackspace={() => setPin((current) => current.slice(0, -1))}
            />
          </div>
          <Button variant="ghost" className="mt-6 w-full" onClick={() => { setSelected(null); setPin(''); setError(null); }}>
            Choose another person
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-lg">
        <div className="text-center">
          <p className="eyebrow">Jayamurugan Clinic</p>
          <h1 className="mt-1 text-2xl font-semibold">Who are you?</h1>
          <p className="mt-2 text-sm text-ink-2">Choose your name and enter your PIN.</p>
        </div>

        {error ? <Notice tone="bad">{error}</Notice> : null}
        {staff === null && !error ? <p className="mt-6 text-center text-ink-2">Reading staff…</p> : null}
        {staff?.length === 0 && !error ? (
          <p className="mt-6 rounded-box border border-rule bg-paper-2 p-4 text-center text-ink-2">
            No staff have been configured yet. Sign in as administrator to add them.
          </p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {staff?.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => { setSelected(member); setError(null); }}
                className="hoverable flex min-h-16 w-full items-center justify-between rounded-box border border-ink bg-sheet px-5 text-left active:bg-paper-2"
              >
                <span className="text-lg">{member.name}</span>
                <span className="text-sm text-ink-2">{ROLE_LABEL[member.role]}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-8 border-t border-rule pt-5 text-center">
          <p className="text-sm text-ink-2">Clinic owner or administrator?</p>
          <Button variant="ghost" className="mt-2 w-full" onClick={() => router.push('/access')}>
            Administrator email OTP
          </Button>
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <img src="/logo-mark.png" alt="Jayamurugan Clinic" className="mb-7 h-24 w-auto" />
      {children}
    </main>
  );
}
