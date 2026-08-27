'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import { currentSession } from '@/lib/auth';
import { allStaff, type StaffAdminRow, type StaffRole } from '@/lib/db/admin';
import { addStaff, setStaffPin, updateStaff } from '@/lib/transitions/admin';

const ROLES: Array<{ value: StaffRole; label: string; hint: string }> = [
  { value: 'doctor', label: 'Doctor', hint: 'Consult, diagnose and prescribe' },
  { value: 'nurse', label: 'Nurse', hint: 'Registration, vitals and intake' },
  { value: 'counter', label: 'Pharmacy', hint: 'Dispense, billing and stock' },
  { value: 'admin', label: 'Admin', hint: 'Control panel and clinic configuration' },
];

function asDay(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function AdminPage() {
  const router = useRouter();
  const session = typeof window === 'undefined' ? null : currentSession();
  const allowed = session?.role === 'admin';

  const [staff, setStaff] = useState<StaffAdminRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('counter');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [resetting, setResetting] = useState<StaffAdminRow | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    void allStaff().then(setStaff).catch((cause) => setError((cause as Error).message));
  }, []);

  useEffect(refresh, [refresh]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doAdd = () =>
    run(async () => {
      const added = await addStaff({ name, role, pin, phone: phone || undefined });
      setAdding(false);
      setName('');
      setPhone('');
      setPin('');
      setRole('counter');
      return `${added.name} can sign in from any browser with their PIN.`;
    });

  const doResetPin = () =>
    run(async () => {
      const who = resetting as StaffAdminRow;
      await setStaffPin(who.id, pin);
      setResetting(null);
      setPin('');
      return `${who.name}'s new PIN is active.`;
    });

  const pinPad = (onDone: () => void, label: string) => (
    <div className="mt-4 max-w-xs">
      <p className="eyebrow">Six-digit PIN</p>
      <div className="mt-2 flex gap-3" role="status" aria-label="PIN entry">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : ''}`} />
        ))}
      </div>
      <div className="mt-3 w-64">
        <Numpad
          disabled={busy}
          onDigit={(digit) => setPin((current) => (current + digit).slice(0, 6))}
          onBackspace={() => setPin((current) => current.slice(0, -1))}
        />
      </div>
      <button
        type="button"
        disabled={busy || pin.length !== 6}
        onClick={onDone}
        className="mt-4 h-14 w-64 rounded-box border border-ink bg-ink font-medium text-paper disabled:opacity-40"
      >
        {label}
      </button>
    </div>
  );

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">People & access</h2>
          <p className="tabular mt-1 text-lg">{staff.filter((row) => row.active).length} active staff</p>
          <p className="mt-6 text-sm leading-6 text-ink-2">
            Anyone can open the clinic website. Staff identity is their name + PIN; their role decides which workspace opens.
          </p>
          <p className="mt-4 text-sm leading-6 text-ink-2">
            Five wrong PIN attempts temporarily lock that staff login for ten minutes.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={!allowed || busy}
            onClick={() => {
              setAdding((value) => !value);
              setResetting(null);
              setPin('');
            }}
          >
            Add staff
          </RailButton>
          <RailButton disabled={busy} onClick={refresh}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/admin/home')}>Control panel</RailButton>
          <RailButton onClick={() => router.push('/')}>Staff sign in</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="People & access" />

      {!allowed ? <Notice tone="bad">Only an administrator can change staff and PINs.</Notice> : null}
      {error ? <Notice tone="bad" className="max-w-3xl">{error}</Notice> : null}
      {notice ? <p role="status" data-testid="admin-notice" className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free">{notice}</p> : null}

      {adding ? (
        <section className="mt-6 max-w-2xl rounded-box border border-rule bg-sheet p-4">
          <h2 className="text-lg font-medium">Add staff member</h2>
          <label className="mt-3 block">
            <span className="block text-sm text-ink-2">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" className="blank mt-1 h-14 w-full px-3 text-lg" />
          </label>
          <label className="mt-3 block">
            <span className="block text-sm text-ink-2">Phone <span className="text-xs">(optional)</span></span>
            <input value={phone} onChange={(event) => setPhone(event.target.value)} aria-label="Phone" className="blank mt-1 h-14 w-full px-3 text-lg" />
          </label>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {ROLES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={role === option.value}
                onClick={() => setRole(option.value)}
                className={`min-h-16 rounded-box border px-3 text-left active:bg-paper-2 ${role === option.value ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'}`}
              >
                <span className="block">{option.label}</span>
                <span className="block text-xs text-ink-2">{option.hint}</span>
              </button>
            ))}
          </div>
          {pinPad(() => void doAdd(), 'Add staff')}
        </section>
      ) : null}

      {resetting ? (
        <section className="mt-6 max-w-2xl rounded-box border border-rule bg-sheet p-4">
          <h2 className="text-lg font-medium">New PIN for {resetting.name}</h2>
          <p className="mt-1 text-sm text-ink-2">The old PIN stops working immediately.</p>
          {pinPad(() => void doResetPin(), 'Set new PIN')}
        </section>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Clinic team</h2>
      <ul className="mt-2 max-w-5xl">
        {staff.map((row) => (
          <li key={row.id} className={`flex items-center gap-3 border-b border-rule py-3 ${row.active ? '' : 'opacity-50'}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg">{row.name}</span>
              <span className="block text-sm text-ink-2 capitalize">
                {row.role === 'counter' ? 'pharmacy' : row.role} · PIN set {asDay(row.pin_set_at)}{row.active ? '' : ' · inactive'}
              </span>
            </span>
            <button
              type="button"
              aria-label={`New PIN for ${row.name}`}
              disabled={!allowed || busy || !row.active}
              onClick={() => { setResetting(row); setAdding(false); setPin(''); }}
              className="h-14 rounded-box border border-rule bg-sheet px-4 disabled:opacity-40"
            >
              Reset PIN
            </button>
            <button
              type="button"
              disabled={!allowed || busy}
              aria-label={row.active ? `Deactivate ${row.name}` : `Reactivate ${row.name}`}
              onClick={() => void run(async () => {
                await updateStaff(row.id, { active: !row.active });
                return row.active ? `${row.name} can no longer sign in.` : `${row.name} can sign in again.`;
              })}
              className="h-14 w-32 rounded-box border border-rule bg-sheet px-4 disabled:opacity-40"
            >
              {row.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </li>
        ))}
      </ul>

      <section className="mt-9 max-w-4xl rounded-box border border-rule bg-paper-2 p-4">
        <p className="eyebrow">No device setup</p>
        <h2 className="mt-1 text-lg font-medium">The clinic URL works everywhere</h2>
        <p className="mt-2 text-sm leading-6 text-ink-2">
          Open app.jayamuruganclinic.online on any tablet, laptop or phone. Choose a staff name and enter that person's PIN. Nothing has to be registered first.
        </p>
      </section>
    </ThreePane>
  );
}
