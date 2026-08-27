'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import {
  openOwnerSession,
  sendEmailOtp,
  signOutEmailIdentity,
  verifyEmailOtp,
} from '@/lib/auth';
import { needsSetup } from '@/lib/db/settings';

export default function EmailAccessPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendEmailOtp(email);
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
      await verifyEmailOtp(email, code);
      const setup = await needsSetup();
      if (setup === true) {
        router.replace('/enroll');
        return;
      }
      if (setup === undefined) throw new Error('Cannot reach the clinic database.');

      await openOwnerSession();
      await signOutEmailIdentity();
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
        <h1 className="mt-1 text-2xl font-semibold">Sign in with email OTP</h1>
        <p className="mt-3 text-sm leading-6 text-ink-2">
          Email OTP is for clinic ownership, setup and administration. Doctors, nurses and pharmacy staff use their PIN from the main screen.
        </p>

        {!sent ? (
          <>
            <label className="mt-6 block">
              <span className="block text-sm text-ink-2">Administrator email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void send()}
                aria-label="Administrator email"
                placeholder="admin@example.com"
                className="blank mt-1 h-14 w-full px-3 text-lg"
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || !email.trim()}
              onClick={() => void send()}
              className="mt-5 w-full"
            >
              Send 6-digit code
            </Button>
          </>
        ) : (
          <div className="mt-6 rounded-box border border-rule bg-sheet p-5">
            <p className="text-sm text-ink-2">Code sent to</p>
            <p className="mt-1 break-all font-medium">{email}</p>
            <label className="mt-5 block">
              <span className="block text-sm text-ink-2">6-digit code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(event) => event.key === 'Enter' && void verify()}
                aria-label="6-digit email code"
                className="blank mt-1 h-16 w-full px-3 text-center text-3xl tracking-[0.35em]"
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || code.length !== 6}
              onClick={() => void verify()}
              className="mt-5 w-full"
            >
              Verify & continue
            </Button>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Button variant="ghost" disabled={busy} onClick={() => void send()}>
                Send again
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setSent(false); setCode(''); setError(null); }}>
                Change email
              </Button>
            </div>
          </div>
        )}

        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button variant="ghost" disabled={busy} onClick={() => router.replace('/')} className="mt-3 w-full">
          Back to staff sign in
        </Button>
      </div>
    </main>
  );
}
