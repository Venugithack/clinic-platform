'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Numpad } from '@/components/Numpad';
import { Button, Notice } from '@/components/ui';
import {
  emailIdentity,
  registerDeviceLocally,
  signOutEmailIdentity,
  writeStoredSession,
  type StaffSession,
} from '@/lib/auth';
import { hasEmailOwner, needsSetup } from '@/lib/db/settings';
import {
  claimLegacyAdminByEmail,
  firstRunEmail,
  trustDeviceByEmail,
  type EmailTrustedDevice,
} from '@/lib/transitions/admin';

const PIN_LENGTH = 6;

type Mode = 'loading' | 'setup' | 'trust' | 'legacy' | 'no-email';

export default function EnrollDevicePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [email, setEmail] = useState('');
  const [clinicName, setClinicName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Cabin tablet');
  const [isClinicDevice, setIsClinicDevice] = useState(true);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const identity = await emailIdentity();
      if (!identity) {
        setMode('no-email');
        return;
      }
      setEmail(identity.email);

      const setup = await needsSetup();
      if (setup === true) {
        setMode('setup');
        return;
      }
      if (setup === undefined) {
        setError('Cannot reach the clinic database.');
        setMode('no-email');
        return;
      }

      const owner = await hasEmailOwner();
      setMode(owner === false ? 'legacy' : 'trust');
    })();
  }, []);

  const finish = async (trusted: EmailTrustedDevice) => {
    registerDeviceLocally(trusted.device_token);
    const session: StaffSession = {
      token: trusted.session_token,
      staffId: trusted.staff_id,
      staffName: trusted.staff_name,
      role: trusted.staff_role,
    };
    writeStoredSession(session);
    await signOutEmailIdentity();
    router.replace(trusted.staff_role === 'counter' ? '/counter' : '/queue');
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') {
        if (!clinicName.trim() || !adminName.trim() || pin.length !== PIN_LENGTH) return;
        await finish(
          await firstRunEmail({
            clinicName,
            staffName: adminName,
            pin,
            deviceLabel,
          }),
        );
      } else if (mode === 'legacy') {
        if (!clinicName.trim() || !adminName.trim() || pin.length !== PIN_LENGTH) return;
        await finish(
          await claimLegacyAdminByEmail({ clinicName, adminName, pin, deviceLabel }),
        );
      } else if (mode === 'trust') {
        await finish(await trustDeviceByEmail({ deviceLabel, isClinicDevice }));
      }
    } catch (cause) {
      setError((cause as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'loading') {
    return <Centered><h1 className="text-2xl font-semibold">Checking your email sign-in…</h1></Centered>;
  }

  if (mode === 'no-email') {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Open the link from your email</h1>
        <p className="mt-3 max-w-md text-center text-ink-2">
          This browser does not have a verified email session yet.
        </p>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button variant="primary" className="mt-6" onClick={() => router.replace('/access')}>
          Send another link
        </Button>
      </Centered>
    );
  }

  const needsPin = mode === 'setup' || mode === 'legacy';
  const ready =
    deviceLabel.trim() !== '' &&
    (!needsPin || (clinicName.trim() !== '' && adminName.trim() !== '' && pin.length === PIN_LENGTH));

  return (
    <Centered>
      <div className="w-full max-w-md">
        <p className="eyebrow">Verified email</p>
        <p className="mt-1 break-all text-sm text-ink-2">{email}</p>

        <h1 className="mt-4 text-2xl font-semibold">
          {mode === 'setup'
            ? 'Set up this clinic'
            : mode === 'legacy'
              ? 'Move this clinic to email access'
              : 'Trust this device'}
        </h1>

        <p className="mt-3 text-sm leading-6 text-ink-2">
          {mode === 'setup'
            ? 'This creates the first administrator and trusts this tablet. After this, staff use their PINs normally.'
            : mode === 'legacy'
              ? 'This clinic was created before email ownership. Confirm the existing administrator once; old device trust is replaced and this email becomes the owner.'
              : 'This email is already authorized. Name this device once; staff then use name + PIN as usual.'}
        </p>

        {needsPin ? (
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="block text-sm text-ink-2">Clinic name</span>
              <input value={clinicName} onChange={(event) => setClinicName(event.target.value)} aria-label="Clinic name" className="blank mt-1 h-14 w-full px-3 text-lg" />
            </label>
            <label className="block">
              <span className="block text-sm text-ink-2">Administrator name</span>
              <input value={adminName} onChange={(event) => setAdminName(event.target.value)} aria-label="Administrator name" className="blank mt-1 h-14 w-full px-3 text-lg" />
            </label>
          </div>
        ) : null}

        <label className="mt-4 block">
          <span className="block text-sm text-ink-2">This device</span>
          <input value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} aria-label="This device" className="blank mt-1 h-14 w-full px-3 text-lg" />
        </label>

        {mode === 'trust' ? (
          <button
            type="button"
            aria-pressed={isClinicDevice}
            onClick={() => setIsClinicDevice((value) => !value)}
            className={`mt-3 h-14 w-full rounded-box border px-4 text-left ${isClinicDevice ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'}`}
          >
            <span className="block">{isClinicDevice ? 'In the clinic' : 'Outside the clinic'}</span>
            <span className="block text-xs text-ink-2">{isClinicDevice ? '3-minute idle lock · can set presence' : '10-minute idle lock · no clinic presence'}</span>
          </button>
        ) : null}

        {needsPin ? (
          <>
            <p className="mt-6 text-sm text-ink-2">Existing/new administrator 6-digit PIN</p>
            <div className="mt-3 flex gap-3" aria-label="PIN entry" role="status">
              {Array.from({ length: PIN_LENGTH }, (_, index) => (
                <span key={index} className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : 'bg-transparent'}`} />
              ))}
            </div>
            <div className="mt-4 w-64">
              <Numpad
                disabled={busy}
                onDigit={(digit) => setPin((current) => (current.length < PIN_LENGTH ? current + digit : current))}
                onBackspace={() => setPin((current) => current.slice(0, -1))}
              />
            </div>
          </>
        ) : null}

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button variant="primary" disabled={!ready || busy} onClick={() => void run()} className="mt-6 w-full">
          {mode === 'setup' ? 'Create clinic & trust device' : mode === 'legacy' ? 'Claim email access' : 'Trust this device'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => router.replace('/access')} className="mt-3 w-full">
          Use another email
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
