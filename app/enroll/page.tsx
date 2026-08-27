'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { Button, Notice } from '@/components/ui';
import {
  emailIdentity,
  firstRunOwner,
  signOutEmailIdentity,
} from '@/lib/auth';
import { needsSetup } from '@/lib/db/settings';

const PIN_LENGTH = 6;

type Mode = 'loading' | 'setup' | 'invalid';

export default function FirstSetupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [email, setEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'pin' | 'confirm'>('pin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const identity = await emailIdentity();
      if (!identity) {
        setMode('invalid');
        return;
      }
      setEmail(identity.email);

      const setup = await needsSetup();
      if (setup === true) setMode('setup');
      else if (setup === false) router.replace('/access');
      else {
        setError('Cannot reach the clinic database.');
        setMode('invalid');
      }
    })();
  }, [router]);

  const activePin = step === 'pin' ? pin : confirmPin;
  const mismatch = confirmPin.length === PIN_LENGTH && confirmPin !== pin;
  const ready = adminName.trim() !== '' && pin.length === PIN_LENGTH && confirmPin === pin;

  const finish = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await firstRunOwner(adminName.trim(), pin);
      await signOutEmailIdentity();
      router.replace('/admin/home');
    } catch (cause) {
      setError((cause as Error).message);
      setPin('');
      setConfirmPin('');
      setStep('pin');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'loading') {
    return <Centered><h1 className="text-2xl font-semibold">Preparing clinic setup…</h1></Centered>;
  }

  if (mode === 'invalid') {
    return (
      <Centered>
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-semibold">Verify the owner email first</h1>
          <p className="mt-3 text-ink-2">Clinic setup starts with the 6-digit email OTP.</p>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button variant="primary" className="mt-6 w-full" onClick={() => router.replace('/access')}>
            Go to owner sign in
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-md">
        <p className="eyebrow">First setup</p>
        <h1 className="mt-1 text-2xl font-semibold">Jayamurugan Clinic</h1>
        <p className="mt-2 text-sm text-ink-2">Owner verified: {email}</p>
        <p className="mt-4 text-sm leading-6 text-ink-2">
          Create the first administrator. After this, use the control panel to add doctors, nurses and pharmacy staff with their own PINs.
        </p>

        <label className="mt-6 block">
          <span className="block text-sm text-ink-2">Administrator name</span>
          <input
            value={adminName}
            onChange={(event) => setAdminName(event.target.value)}
            aria-label="Administrator name"
            className="blank mt-1 h-14 w-full px-3 text-lg"
          />
        </label>

        <p className="mt-6 text-sm text-ink-2">
          {step === 'pin' ? 'Create a 6-digit PIN' : 'Enter the same PIN again'}
        </p>
        <div className="mt-3 flex gap-3" aria-label="PIN entry" role="status">
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <span key={index} className={`h-4 w-4 rounded-full border border-rule ${index < activePin.length ? 'bg-ink' : 'bg-transparent'}`} />
          ))}
        </div>
        <div className="mt-4 w-64">
          <Numpad
            disabled={busy}
            onDigit={(digit) => {
              if (step === 'pin') setPin((current) => (current + digit).slice(0, PIN_LENGTH));
              else setConfirmPin((current) => (current + digit).slice(0, PIN_LENGTH));
            }}
            onBackspace={() => {
              if (step === 'pin') setPin((current) => current.slice(0, -1));
              else setConfirmPin((current) => current.slice(0, -1));
            }}
          />
        </div>

        {step === 'pin' && pin.length === PIN_LENGTH ? (
          <Button variant="secondary" className="mt-4 w-full" onClick={() => { setConfirmPin(''); setStep('confirm'); }}>
            Confirm this PIN
          </Button>
        ) : null}

        {step === 'confirm' ? (
          <Button variant="ghost" className="mt-3 w-full" disabled={busy} onClick={() => { setPin(''); setConfirmPin(''); setStep('pin'); setError(null); }}>
            Choose a different PIN
          </Button>
        ) : null}

        {mismatch ? <Notice tone="bad">The two PINs do not match.</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button variant="primary" className="mt-6 w-full" disabled={!ready || busy} onClick={() => void finish()}>
          Create clinic & open control panel
        </Button>
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
