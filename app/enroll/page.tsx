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
const CLINIC_NAME = 'Jayamurugan Clinic';

type Mode = 'loading' | 'setup' | 'trust' | 'legacy' | 'no-email';

export default function EnrollDevicePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [email, setEmail] = useState('');
  const [clinicName, setClinicName] = useState(CLINIC_NAME);
  const [adminName, setAdminName] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Cabin tablet');
  const [isClinicDevice, setIsClinicDevice] = useState(true);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [confirmingPin, setConfirmingPin] = useState(false);
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
        if (!adminName.trim() || pin.length !== PIN_LENGTH || confirmPin !== pin) return;
        await finish(
          await firstRunEmail({
            clinicName: CLINIC_NAME,
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
      setConfirmPin('');
      setConfirmingPin(false);
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

  const setupPinReady = pin.length === PIN_LENGTH && confirmPin === pin;
  const needsPin = mode === 'setup' || mode === 'legacy';
  const ready =
    deviceLabel.trim() !== '' &&
    (mode === 'setup'
      ? adminName.trim() !== '' && setupPinReady
      : !needsPin || (clinicName.trim() !== '' && adminName.trim() !== '' && pin.length === PIN_LENGTH));

  const activePin = mode === 'setup' && confirmingPin ? confirmPin : pin;
  const pinMismatch = mode === 'setup' && confirmPin.length === PIN_LENGTH && confirmPin !== pin;

  return (
    <Centered>
      <div className="w-full max-w-md">
        <p className="eyebrow">Verified email</p>
        <p className="mt-1 break-all text-sm text-ink-2">{email}</p>

        <h1 className="mt-4 text-2xl font-semibold">
          {mode === 'setup'
            ? 'Set up Jayamurugan Clinic'
            : mode === 'legacy'
              ? 'Move this clinic to email access'
              : 'Trust this device'}
        </h1>

        <p className="mt-3 text-sm leading-6 text-ink-2">
          {mode === 'setup'
            ? 'Create the first administrator and choose a 6-digit PIN. You will enter the PIN twice so it cannot be saved by mistake.'
            : mode === 'legacy'
              ? 'Confirm the existing administrator once; old device trust is replaced and this email becomes the owner.'
              : 'This email is authorized. Name this device once; staff then use name + PIN as usual.'}
        </p>

        {mode === 'setup' ? (
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="block text-sm text-ink-2">Administrator name</span>
              <input value={adminName} onChange={(event) => setAdminName(event.target.value)} aria-label="Administrator name" className="blank mt-1 h-14 w-full px-3 text-lg" />
            </label>
          </div>
        ) : null}

        {mode === 'legacy' ? (
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
            <p className="mt-6 text-sm text-ink-2">
              {mode === 'setup'
                ? confirmingPin
                  ? 'Enter the same 6-digit PIN again'
                  : 'Create administrator 6-digit PIN'
                : 'Existing administrator 6-digit PIN'}
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
                  if (mode === 'setup' && confirmingPin) {
                    setConfirmPin((current) => (current.length < PIN_LENGTH ? current + digit : current));
                  } else {
                    setPin((current) => (current.length < PIN_LENGTH ? current + digit : current));
                  }
                }}
                onBackspace={() => {
                  if (mode === 'setup' && confirmingPin) {
                    setConfirmPin((current) => current.slice(0, -1));
                  } else {
                    setPin((current) => current.slice(0, -1));
                  }
                }}
              />
            </div>

            {mode === 'setup' && !confirmingPin && pin.length === PIN_LENGTH ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmPin('');
                  setConfirmingPin(true);
                }}
                className="mt-4 w-full"
              >
                Re-enter PIN to confirm
              </Button>
            ) : null}

            {mode === 'setup' && confirmingPin ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPin('');
                  setConfirmPin('');
                  setConfirmingPin(false);
                  setError(null);
                }}
                className="mt-3 w-full"
              >
                Choose a different PIN
              </Button>
            ) : null}

            {pinMismatch ? <Notice tone="bad">Those PINs do not match. Choose a different PIN and enter it twice.</Notice> : null}
          </>
        ) : null}

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button variant="primary" disabled={!ready || busy} onClick={() => void run()} className="mt-6 w-full">
          {mode === 'setup' ? 'Finish clinic setup' : mode === 'legacy' ? 'Claim email access' : 'Trust this device'}
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
