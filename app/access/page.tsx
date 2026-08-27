'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { sendEmailAccessLink } from '@/lib/auth';

export default function EmailAccessPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendEmailAccessLink(email);
      setSent(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <img src="/logo-mark.png" alt="Jayamurugan Clinic" className="mb-7 h-24 w-auto" />
      <div className="w-full max-w-md">
        <p className="eyebrow">Clinic access</p>
        <h1 className="mt-1 text-2xl font-semibold">Continue with email</h1>
        <p className="mt-3 text-sm leading-6 text-ink-2">
          Administrators and doctors use email only to trust a new device or recover access.
          Once this device is trusted, daily clinic use goes back to name + 6-digit PIN.
        </p>

        {sent ? (
          <div className="mt-6 rounded-box border border-rule bg-sheet p-5">
            <h2 className="text-lg font-medium">Check your email</h2>
            <p className="mt-2 text-sm leading-6 text-ink-2">
              Open the sign-in link on this device. It will return here and finish device setup.
            </p>
            <Button variant="ghost" className="mt-5 w-full" onClick={() => setSent(false)}>
              Use a different email
            </Button>
          </div>
        ) : (
          <>
            <label className="mt-6 block">
              <span className="block text-sm text-ink-2">Administrator or doctor email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void send()}
                aria-label="Email"
                placeholder="doctor@example.com"
                className="blank mt-1 h-14 w-full px-3 text-lg"
              />
            </label>
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Button
              variant="primary"
              disabled={busy || !email.trim()}
              onClick={() => void send()}
              className="mt-5 w-full"
            >
              Email me a sign-in link
            </Button>
          </>
        )}

        <Button variant="ghost" disabled={busy} onClick={() => router.replace('/')} className="mt-3 w-full">
          Back
        </Button>
      </div>
    </main>
  );
}
