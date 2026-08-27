'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { emailIdentity, writeStoredSession } from '@/lib/auth';
import { needsSetup } from '@/lib/db/settings';
import { firstRunOwner } from '@/lib/transitions/admin';

export default function FirstRunPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const identity = await emailIdentity();
      const setup = await needsSetup();
      if (!identity) {
        router.replace('/access');
        return;
      }
      if (setup !== true) {
        router.replace('/');
        return;
      }
      setEmail(identity.email);
      setReady(true);
    })();
  }, [router]);

  const submit = async () => {
    if (busy || !ready) return;
    if (!adminName.trim()) {
      setError('Enter the administrator name.');
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError('Choose a 6-digit PIN.');
      return;
    }
    if (pin !== confirmPin) {
      setError('The two PIN entries do not match.');
      setPin('');
      setConfirmPin('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const owner = await firstRunOwner(adminName, pin);
      writeStoredSession({
        token: '',
        staffId: owner.staff_id,
        staffName: owner.staff_name,
        role: 'admin',
      });
      router.replace('/admin/home');
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
        <p className="eyebrow">First setup</p>
        <h1 className="mt-1 text-2xl font-semibold">Create the clinic administrator</h1>
        <p className="mt-3 text-sm leading-6 text-ink-2">
          Jayamurugan Clinic is fixed. This email becomes the owner of the control panel; staff you add later will use their own PINs from any browser.
        </p>

        <div className="mt-5 rounded-box border border-rule bg-paper-2 p-4">
          <span className="block text-xs uppercase tracking-wide text-ink-2">Owner email</span>
          <span className="mt-1 block break-all">{email || 'Checking…'}</span>
        </div>

        <label className="mt-5 block">
          <span className="block text-sm text-ink-2">Administrator name</span>
          <input value={adminName} onChange={(event) => setAdminName(event.target.value)} aria-label="Administrator name" className="blank mt-1 h-14 w-full px-3 text-lg" />
        </label>

        <label className="mt-4 block">
          <span className="block text-sm text-ink-2">Choose 6-digit PIN</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Choose PIN" className="blank mt-1 h-14 w-full px-3 text-center text-2xl tracking-[0.35em]" />
        </label>

        <label className="mt-4 block">
          <span className="block text-sm text-ink-2">Enter PIN again</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(event) => event.key === 'Enter' && void submit()} aria-label="Confirm PIN" className="blank mt-1 h-14 w-full px-3 text-center text-2xl tracking-[0.35em]" />
        </label>

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button variant="primary" disabled={busy || !ready || !adminName.trim() || pin.length !== 6 || confirmPin.length !== 6} onClick={() => void submit()} className="mt-6 w-full">
          Create clinic & open control panel
        </Button>
      </div>
    </main>
  );
}
