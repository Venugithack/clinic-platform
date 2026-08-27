'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { ownerSession, sendAdminOtp, verifyAdminOtp } from '@/lib/auth';
import { needsSetup } from '@/lib/db/settings';

export default function AdminOtpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void needsSetup().then((value) => setFirstRun(value === true));
  }, []);

  const send = async () => {
    if (!email.trim() || busy || firstRun === null) return;
    setBusy(true);
    setError(null);
    try {
      await sendAdminOtp(email, firstRun);
      setSent(true);
      setCode('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyAdminOtp(email, code);
      const setup = await needsSetup();
      if (setup === true) {
        router.replace('/enroll');
        return;
      }
      const owner = await ownerSession();
      if (!owner) throw new Error('This email is not the clinic administrator.');
      router.replace('/admin/home');
    } catch (cause) {
      setError((cause as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <img src="/logo-mark.png" alt="Jayamurugan Clinic" className="mb-7 h-24 w-auto" />
      <div className="w-full max-w-md">
        <p className="eyebrow">Administrator</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {firstRun ? 'Set up Jayamurugan Clinic' : 'Open the control panel'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-ink-2">
          Enter the administrator email. We will send a 6-digit one-time code. No password or device registration is required.
        </p>

        <label className="mt-6 block">
          <span className="block text-sm text-ink-2">Administrator email</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            disabled={sent || busy}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="Administrator email"
            placeholder="admin@example.com"
            className="blank mt-1 h-14 w-full px-3 text-lg"
          />
        </label>

        {sent ? (
          <>
            <label className="mt-5 block">
              <span className="block text-sm text-ink-2">6-digit code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(event) => event.key === 'Enter' && void verify()}
                aria-label="One-time code"
                className="blank mt-1 h-14 w-full px-3 text-center text-2xl tracking-[0.35em]"
              />
            </label>
            <Button variant="primary" disabled={busy || code.length !== 6} onClick={() => void verify()} className="mt-5 w-full">
              Verify code
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setSent(false); setCode(''); setError(null); }} className="mt-2 w-full">
              Change email
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={busy || !email.trim() || firstRun === null} onClick={() => void send()} className="mt-5 w-full">
            Send 6-digit code
          </Button>
        )}

        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button variant="ghost" disabled={busy} onClick={() => router.replace('/')} className="mt-3 w-full">
          Back to staff sign-in
        </Button>
      </div>
    </main>
  );
}
