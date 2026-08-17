'use client';

/**
 * People and tablets. PLAN.md §16, TABLET.md §5.
 *
 * The two events this screen exists for are both ordinary and both used to
 * need a developer: *the new pharmacist starts on Monday*, and *the counter
 * tablet was left in an auto-rickshaw*.
 *
 * Three things on it are deliberate.
 *
 * **A new staff member gets a PIN in the same step.** Somebody created without
 * one appears on the lock screen and cannot pass it, which reads as a broken
 * tablet rather than as half-finished setup.
 *
 * **Leaving is "not here any more", never delete.** Every prescription,
 * dispense and H1 register line names a person, and those names are the legal
 * record of who did it.
 *
 * **A registration code is shown exactly once.** It is the only credential a
 * tablet holds. There is no read path back to it anywhere in this build, so
 * the admin carries it to the new tablet while it is on screen — a code that
 * can be re-displayed forever is a code that gets photographed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import { currentSession } from '@/lib/auth';
import {
  allDevices,
  allStaff,
  type DeviceRow,
  type StaffAdminRow,
  type StaffRole,
} from '@/lib/db/admin';
import {
  addStaff,
  registerDevice,
  revokeDevice,
  setStaffPin,
  updateStaff,
  type RegisteredDevice,
} from '@/lib/transitions/admin';

const ROLES: Array<{ value: StaffRole; label: string; hint: string }> = [
  { value: 'doctor', label: 'Doctor', hint: 'Consults, signs prescriptions' },
  { value: 'counter', label: 'Counter', hint: 'Dispenses, sells, takes cash' },
  { value: 'admin', label: 'Admin', hint: 'All of that, plus this screen' },
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
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Adding somebody.
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('counter');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');

  // Resetting a PIN.
  const [resetting, setResetting] = useState<StaffAdminRow | null>(null);

  // Registering a tablet.
  const [label, setLabel] = useState('');
  const [isClinicDevice, setIsClinicDevice] = useState(true);
  const [issued, setIssued] = useState<RegisteredDevice | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        setStaff(await allStaff());
        setDevices(await allDevices());
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
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
      return `${added.name} can sign in now.`;
    });

  const doResetPin = () =>
    run(async () => {
      const who = resetting as StaffAdminRow;
      await setStaffPin(who.id, pin);
      setResetting(null);
      setPin('');
      return `${who.name}'s PIN is set. Tell them the six digits, not this screen.`;
    });

  const doRegister = () =>
    run(async () => {
      const device = await registerDevice(label, isClinicDevice);
      setIssued(device);
      setLabel('');
      return `${device.label} is registered. The code below is shown once.`;
    });

  const pinPad = (onDone: () => void, label: string) => (
    <div className="mt-4 max-w-xs">
      <p className="text-sm text-muted">Six-digit PIN</p>
      <div className="mt-2 flex gap-3" role="status" aria-label="PIN entry">
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className={`h-4 w-4 rounded-full border border-line ${
              index < pin.length ? 'bg-ink' : ''
            }`}
          />
        ))}
      </div>
      <div className="mt-3 w-64">
        <Numpad
          onDigit={(digit) => setPin((current) => (current + digit).slice(0, 6))}
          onBackspace={() => setPin((current) => current.slice(0, -1))}
        />
      </div>
      <button
        type="button"
        disabled={busy || pin.length !== 6}
        onClick={onDone}
        className="mt-4 h-14 w-64 rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
      >
        {label}
      </button>
    </div>
  );

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">People and tablets</h2>
          <p className="tabular mt-1 text-lg">
            {staff.filter((row) => row.active).length} working ·{' '}
            {devices.filter((row) => row.revoked_at === null).length} tablets
          </p>

          <p className="mt-6 text-sm text-muted">
            Nobody is ever deleted here. Every prescription, dispense and
            register line names a person, and that name is the record of who
            did it — so somebody who leaves is marked as gone.
          </p>

          <p className="mt-4 text-sm text-muted">
            <strong className="text-ink">Lost a tablet?</strong> Revoke it. The
            session running on it ends immediately, not when it next idles out.
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
            Add someone
          </RailButton>
          <RailButton disabled={busy} onClick={refresh}>
            Refresh
          </RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/queue')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">People and tablets</h1>

      {!allowed ? (
        <p className="mt-4 max-w-2xl rounded-lg bg-ink/5 p-3 text-muted">
          Only an administrator can add staff or register a tablet — the person
          who can reset a PIN can sign in as anybody.
        </p>
      ) : null}

      {error ? (
        <p className="mt-4 max-w-3xl rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p
          role="status"
          data-testid="admin-notice"
          className="mt-4 max-w-3xl rounded-lg bg-ok/10 p-3 text-ok"
        >
          {notice}
        </p>
      ) : null}

      {adding ? (
        <div className="mt-6 max-w-2xl rounded-xl border border-line bg-white p-4">
          <h2 className="text-lg font-medium">Someone new</h2>

          <label className="mt-3 block">
            <span className="block text-sm text-muted">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Name"
              className="mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
            />
          </label>

          <label className="mt-3 block">
            <span className="block text-sm text-muted">Phone</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              aria-label="Phone"
              className="mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
            />
          </label>

          <div className="mt-4 flex gap-3">
            {ROLES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={role === option.value}
                onClick={() => setRole(option.value)}
                className={`h-14 flex-1 rounded-xl border px-3 text-left active:bg-line ${
                  role === option.value ? 'border-ink bg-ink/5' : 'border-line bg-white'
                }`}
              >
                <span className="block">{option.label}</span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </button>
            ))}
          </div>

          {/* The PIN is part of creating somebody, not a second errand. */}
          {pinPad(() => void doAdd(), 'Add them')}
        </div>
      ) : null}

      {resetting ? (
        <div className="mt-6 max-w-2xl rounded-xl border border-line bg-white p-4">
          <h2 className="text-lg font-medium">New PIN for {resetting.name}</h2>
          <p className="mt-1 text-sm text-muted">
            Their old PIN stops working immediately.
          </p>
          {pinPad(() => void doResetPin(), 'Set it')}
        </div>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">People</h2>
      <ul className="mt-2 max-w-4xl">
        {staff.map((row) => (
          <li
            key={row.id}
            className={`flex items-center gap-4 border-b border-line py-3 ${
              row.active ? '' : 'opacity-50'
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg">{row.name}</span>
              <span className="block text-sm text-muted">
                {row.role} · PIN set {asDay(row.pin_set_at)}
                {row.active ? '' : ' · not here any more'}
              </span>
            </span>

            <button
              type="button"
              disabled={!allowed || busy || !row.active}
              onClick={() => {
                setResetting(row);
                setAdding(false);
                setPin('');
              }}
              className="h-14 rounded-xl border border-line bg-white px-4 active:bg-line disabled:opacity-40"
            >
              New PIN
            </button>

            <button
              type="button"
              disabled={!allowed || busy}
              aria-label={
                row.active ? `Mark ${row.name} as left` : `Bring ${row.name} back`
              }
              onClick={() =>
                void run(async () => {
                  await updateStaff(row.id, { active: !row.active });
                  return row.active
                    ? `${row.name} is marked as no longer here. Nothing they did has changed.`
                    : `${row.name} is back.`;
                })
              }
              className="h-14 w-36 rounded-xl border border-line bg-white px-4 active:bg-line disabled:opacity-40"
            >
              {row.active ? 'Mark as left' : 'Bring back'}
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-lg font-medium">Tablets</h2>

      {issued ? (
        <div
          data-testid="registration-code"
          className="mt-2 max-w-3xl rounded-xl border border-ink bg-ink/5 p-4"
        >
          <p className="font-medium">{issued.label} — type this on the new tablet</p>
          <p className="tabular mt-2 break-all font-mono text-lg">
            {issued.device_token}
          </p>
          <p className="mt-2 text-sm text-muted">
            Shown once. Nothing in this system can display it again, so if it is
            lost, register the tablet a second time and revoke this one.
          </p>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="mt-3 h-14 rounded-xl border border-line bg-white px-5 active:bg-line"
          >
            Done — it is on the tablet
          </button>
        </div>
      ) : null}

      <div className="mt-3 flex max-w-3xl items-end gap-3">
        <label className="flex-1">
          <span className="block text-sm text-muted">Register another tablet</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="Tablet name"
            placeholder="Counter tablet"
            className="mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
          />
        </label>

        <button
          type="button"
          aria-pressed={isClinicDevice}
          onClick={() => setIsClinicDevice((value) => !value)}
          className={`h-14 w-56 rounded-xl border px-3 text-left active:bg-line ${
            isClinicDevice ? 'border-ink bg-ink/5' : 'border-line bg-white'
          }`}
        >
          <span className="block text-sm">
            {isClinicDevice ? 'In the clinic' : 'Outside the clinic'}
          </span>
          <span className="block text-xs text-muted">
            {isClinicDevice
              ? 'Locks in 3 minutes; can set presence'
              : 'Locks in 10 minutes; cannot say he is here'}
          </span>
        </button>

        <button
          type="button"
          disabled={!allowed || busy || label.trim() === ''}
          onClick={() => void doRegister()}
          className="h-14 rounded-xl border border-ink bg-ink px-5 font-medium text-white disabled:opacity-40"
        >
          Register
        </button>
      </div>

      <ul className="mt-4 max-w-4xl">
        {devices.map((row) => (
          <li
            key={row.id}
            className={`flex items-center gap-4 border-b border-line py-3 ${
              row.revoked_at ? 'opacity-50' : ''
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg">{row.label}</span>
              <span className="block text-sm text-muted">
                {row.is_clinic_device ? 'in the clinic' : 'outside the clinic'} ·
                locks after {Math.round(row.idle_timeout_seconds / 60)} min · last
                used {asDay(row.last_seen_at)}
                {row.revoked_at ? ' · revoked' : ''}
              </span>
            </span>

            <button
              type="button"
              disabled={!allowed || busy || row.revoked_at !== null}
              aria-label={`Revoke ${row.label}`}
              onClick={() =>
                void run(async () => {
                  const ended = await revokeDevice(row.id);
                  return ended > 0
                    ? `${row.label} is revoked, and the session running on it ended.`
                    : `${row.label} is revoked. Nobody was signed in on it.`;
                })
              }
              className="h-14 w-36 rounded-xl border border-danger bg-white px-4 text-danger active:bg-line disabled:opacity-40"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
