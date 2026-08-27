'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Numpad } from '@/components/Numpad';
import { Button, Notice } from '@/components/ui';
import { recoverAdminDevice } from '@/lib/transitions/admin';
import {
  registerDeviceLocally,
  writeStoredSession,
  type StaffSession,
} from '@/lib/auth';

const PIN_LENGTH = 6;

export default function RecoverTabletPage() {
  const router = useRouter();
  const [clinicName, setClinicName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [tabletName, setTabletName] = useState('Cabin tablet');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    clinicName.trim() !== '' &&
    adminName.trim() !== '' &&
    tabletName.trim() !== '' &&
    pin.length === PIN_LENGTH;

  const recover = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);

    try {
      const recovered = await recoverAdminDevice({
        clinicName,
        adminName,
        pin,
        deviceLabel: tabletName,
      });

      registerDeviceLocally(recovered.device_token);
      const session: StaffSession = {
        token: recovered.session_token,
        staffId: recovered.staff_id,
        staffName: recovered.staff_name,
        role: 'admin',
      };
      writeStoredSession(session);
      router.replace('/queue');
    } catch (cause) {
      setError((cause as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center p-8">
      <Image
        src="/logo-mark.png"
        alt="Jayamurugan Clinic"
        width={900}
        height={643}
        priority
        className="mb-6 h-24 w-auto"
      />

      <div className="w-full max-w-md">
        <p className="eyebrow">Emergency access</p>
        <h1 className="mt-1 text-2xl font-semibold">Recover the administrator tablet</h1>
        <p className="mt-3 text-sm text-ink-2">
          Use this only when no registered clinic tablet is available. Recovery
          replaces the old device trust; it does not create a second admin login.
        </p>

        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="block text-sm text-ink-2">Clinic name</span>
            <input
              value={clinicName}
              onChange={(event) => setClinicName(event.target.value)}
              aria-label="Clinic name"
              autoComplete="organization"
              className="blank mt-1 h-14 w-full px-3 text-lg"
            />
          </label>

          <label className="block">
            <span className="block text-sm text-ink-2">Administrator name</span>
            <input
              value={adminName}
              onChange={(event) => setAdminName(event.target.value)}
              aria-label="Administrator name"
              autoComplete="name"
              className="blank mt-1 h-14 w-full px-3 text-lg"
            />
          </label>

          <label className="block">
            <span className="block text-sm text-ink-2">This tablet</span>
            <input
              value={tabletName}
              onChange={(event) => setTabletName(event.target.value)}
              aria-label="This tablet"
              className="blank mt-1 h-14 w-full px-3 text-lg"
            />
          </label>
        </div>

        <p className="mt-6 text-sm text-ink-2">Administrator 6-digit PIN</p>
        <div className="mt-3 flex gap-3" aria-label="PIN entry" role="status">
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <span
              key={index}
              className={`h-4 w-4 rounded-full border border-rule ${
                index < pin.length ? 'bg-ink' : 'bg-transparent'
              }`}
            />
          ))}
        </div>

        <div className="mt-4 w-64">
          <Numpad
            disabled={busy}
            onDigit={(digit) =>
              setPin((current) =>
                current.length < PIN_LENGTH ? current + digit : current,
              )
            }
            onBackspace={() => setPin((current) => current.slice(0, -1))}
          />
        </div>

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button
          variant="primary"
          disabled={!ready || busy}
          onClick={() => void recover()}
          className="mt-6 w-full"
        >
          Recover this tablet
        </Button>

        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => router.replace('/')}
          className="mt-3 w-full"
        >
          Back to registration
        </Button>
      </div>
    </main>
  );
}
