'use client';

import { useCallback, useEffect, useState } from 'react';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import { allStaff, type StaffAdminRow, type StaffRole } from '@/lib/db/admin';
import { addStaff, registerDevice, revokeDevice, setStaffPin, updateStaff } from '@/lib/transitions/admin';
import {
  clearClinicScreenToken,
  readClinicScreen,
  writeClinicScreen,
  type ClinicScreen,
} from '@/lib/db';
import type { PanelProps } from './types';

const ROLES: Array<{ value: StaffRole; label: string; hint: string }> = [
  { value: 'doctor', label: 'Doctor', hint: 'Queue, consultation and prescriptions' },
  { value: 'nurse', label: 'Nurse', hint: 'Patients, vitals and queue intake' },
  { value: 'counter', label: 'Pharmacy / Counter', hint: 'Dispensing, billing and stock' },
  { value: 'admin', label: 'Administrator', hint: 'Control panel and clinic configuration' },
];

function roleLabel(role: StaffRole): string {
  return ROLES.find((item) => item.value === role)?.label ?? role;
}

export function StaffPanel({ chrome }: PanelProps) {
  const session = typeof window === 'undefined' ? null : currentSession();
  const allowed = session?.role === 'admin';

  const [staff, setStaff] = useState<StaffAdminRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StaffAdminRow | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole | null>(null);
  const [phone, setPhone] = useState('');
  const [regNo, setRegNo] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

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

  /**
   * Whether THIS browser is marked as standing in the clinic.
   *
   * Read after mount, never during render: localStorage does not exist where
   * the export is prerendered, and reading it in render hydrates to different
   * markup than was shipped.
   */
  const [screen, setScreen] = useState<ClinicScreen | null>(null);
  const [screenLabel, setScreenLabel] = useState('');
  useEffect(() => setScreen(readClinicScreen()), []);

  const markScreen = () =>
    run(async () => {
      const label = screenLabel.trim() || 'Clinic screen';
      const device = await registerDevice(label, true);
      const marked = { id: device.id, label: device.label, token: device.device_token };
      writeClinicScreen(marked);
      setScreen(marked);
      setScreenLabel('');
      return `${device.label} is marked. Sign in again on this screen for it to take effect.`;
    });

  const unmarkScreen = () =>
    run(async () => {
      const current = screen;

      // The browser's marker goes first, and it is the part that matters: it is
      // read when a session is minted, so the next sign-in here carries no
      // device and presence is refused again.
      clearClinicScreenToken();
      setScreen(null);

      // Revoking the row as well is tidiness — a token nobody holds is already
      // inert, but a list of clinic screens that fills up with screens nobody
      // has is a list nobody reads.
      //
      // It is allowed to fail, and one failure is expected. app.revoke_device
      // raises CL027 against the device the caller is sitting on ("that is the
      // tablet you are using — revoke it from the other one"), which is right
      // for a tablet left in an auto-rickshaw and wrong here: unmarking the
      // screen you are standing at is the ordinary case. The marker is already
      // gone, so that refusal is not an error to show anybody.
      if (current) {
        try {
          await revokeDevice(current.id);
        } catch (cause) {
          if ((cause as { code?: string }).code !== 'WOULD_LOCK_OUT') throw cause;
        }
      }

      return 'This screen no longer counts as being in the clinic.';
    });

  const clearPin = () => {
    setPin('');
    setConfirmPin('');
  };

  const validPin = /^\d{6}$/.test(pin) && pin === confirmPin;
  const pinMismatch = /^\d{6}$/.test(pin) && confirmPin.length === 6 && pin !== confirmPin;

  const doAdd = () =>
    run(async () => {
      if (!name.trim()) throw new Error('Enter the staff member name.');
      if (!role) throw new Error('Choose what this person does.');
      if (!validPin) throw new Error('Enter the same 6-digit PIN twice.');
      const added = await addStaff({
        name: name.trim(),
        role,
        pin,
        phone: phone.trim() || undefined,
        regNo: regNo.trim() || undefined,
      });
      setAdding(false);
      setName('');
      setPhone('');
      setRegNo('');
      setRole(null);
      clearPin();
      return `${added.name} is ready to sign in from the clinic home page.`;
    });

  const doReset = () =>
    run(async () => {
      if (!resetting) throw new Error('Choose a staff member.');
      if (!validPin) throw new Error('Enter the same 6-digit PIN twice.');
      await setStaffPin(resetting.id, pin);
      const who = resetting.name;
      setResetting(null);
      clearPin();
      return `${who}'s PIN was changed and their old sessions were ended.`;
    });

  const pinFields = (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="block text-sm text-ink-2">6-digit PIN</span>
        <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="PIN" className="blank mt-1 h-14 w-full px-3 text-center text-xl tracking-[0.3em]" />
      </label>
      <label className="block">
        <span className="block text-sm text-ink-2">PIN again</span>
        <input type="password" inputMode="numeric" maxLength={6} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Confirm PIN" className="blank mt-1 h-14 w-full px-3 text-center text-xl tracking-[0.3em]" />
      </label>
      {/*
        Say why the button is dead. Both PIN boxes are masked, so a typo is
        invisible by design and the only feedback was a greyed-out "Add staff" —
        which reads as "this screen is broken", not "you mistyped". The message
        waits until the second box has six digits, so it does not accuse anyone
        mid-keystroke.
      */}
      {pinMismatch ? (
        <p role="status" className="text-sm text-stop sm:col-span-2">
          The two PINs do not match.
        </p>
      ) : null}
    </div>
  );

  return (
    <ThreePane tabs={chrome}
      context={
        <div>
          <h2 className="eyebrow">People</h2>
          <p className="tabular mt-1 text-lg">{staff.filter((row) => row.active).length} active staff</p>
          <p className="mt-6 text-sm leading-6 text-ink-2">
            Staff open the clinic URL on any browser, choose their name and use their PIN. Nothing has to be registered to sign in.
          </p>
          <p className="mt-4 text-sm leading-6 text-ink-2">
            The one exception is below: marking a screen as standing in the clinic, which decides nothing except whether the doctor can say he is here.
          </p>
          <p className="mt-4 text-sm leading-6 text-ink-2">
            The administrator email OTP is reserved for the control panel and recovery.
          </p>
        </div>
      }
      primary={{
        label: 'Add staff',
        onClick: () => { setAdding(true); setResetting(null); clearPin(); },
        disabled: !allowed || busy,
      }}
      rail={
        <>
          <RailButton tone="primary" disabled={!allowed || busy} onClick={() => { setAdding(true); setResetting(null); clearPin(); }}>
            Add staff
          </RailButton>
          <RailButton disabled={busy} onClick={refresh}>Refresh</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="Staff access" />

      {!allowed ? <Notice tone="bad">Only the administrator can change staff or PINs.</Notice> : null}
      {error ? <Notice tone="bad" className="max-w-3xl">{error}</Notice> : null}
      {notice ? <p role="status" className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free">{notice}</p> : null}

      {/*
        The one place a browser is still identified, and it decides exactly one
        thing. app.set_presence refuses "in clinic" from an unmarked screen, so
        that the doctor's laptop at home cannot tell a waiting room he is here.
        Signing in does not need this and never will — an unmarked screen is an
        ordinary screen that simply cannot make that one claim.
      */}
      {allowed ? (
        <section className="mt-6 max-w-3xl rounded-box border border-rule bg-sheet p-4">
          <h2 className="eyebrow">This screen</h2>
          {screen ? (
            <>
              <p className="mt-2 text-lg">{screen.label} — in the clinic</p>
              <p className="mt-1 text-sm leading-6 text-ink-2">
                The doctor can say he is present from this screen. Unmark it if it
                stops living in the clinic.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void unmarkScreen()}
                className="mt-4 h-14 rounded-box border border-stop px-5 text-stop disabled:opacity-40"
              >
                Unmark this screen
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm leading-6 text-ink-2">
                This screen is not in the clinic, so the doctor cannot say he is
                present from it. Mark the consulting-room and counter screens —
                a phone or a laptop at home should stay unmarked.
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="block text-sm text-ink-2">Name this screen</span>
                  <input
                    value={screenLabel}
                    onChange={(event) => setScreenLabel(event.target.value)}
                    placeholder="Consulting room"
                    aria-label="Screen name"
                    className="blank mt-1 h-14 w-64 px-3"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void markScreen()}
                  className="h-14 rounded-box border border-ink bg-ink px-5 font-medium text-paper disabled:opacity-40"
                >
                  This screen is in the clinic
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {adding ? (
        <section className="mt-6 max-w-2xl rounded-box border border-rule bg-sheet p-4">
          <h2 className="text-lg font-medium">Add staff member</h2>
          <label className="mt-4 block">
            <span className="block text-sm text-ink-2">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" className="blank mt-1 h-14 w-full px-3 text-lg" />
          </label>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {ROLES.map((option) => (
              <button key={option.value} type="button" aria-pressed={role === option.value} onClick={() => setRole(option.value)} className={`min-h-16 rounded-box border px-3 text-left ${role === option.value ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'}`}>
                <span className="block">{option.label}</span>
                <span className="block text-xs text-ink-2">{option.hint}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-sm text-ink-2">Phone (optional)</span>
              <input value={phone} onChange={(event) => setPhone(event.target.value)} aria-label="Phone" className="blank mt-1 h-14 w-full px-3" />
            </label>
            <label className="block">
              <span className="block text-sm text-ink-2">Registration no. (optional)</span>
              <input value={regNo} onChange={(event) => setRegNo(event.target.value)} aria-label="Registration number" className="blank mt-1 h-14 w-full px-3" />
            </label>
          </div>
          {pinFields}
          <div className="mt-5 flex gap-3">
            <button type="button" disabled={busy || !name.trim() || !role || !validPin} onClick={() => void doAdd()} className="h-14 rounded-box border border-ink bg-ink px-5 font-medium text-paper disabled:opacity-40">Add staff</button>
            <button type="button" disabled={busy} onClick={() => { setAdding(false); clearPin(); }} className="h-14 rounded-box border border-rule bg-sheet px-5">Cancel</button>
          </div>
        </section>
      ) : null}

      {resetting ? (
        <section className="mt-6 max-w-2xl rounded-box border border-rule bg-sheet p-4">
          <p className="eyebrow">Reset PIN</p>
          <h2 className="mt-1 text-lg font-medium">{resetting.name}</h2>
          <p className="mt-2 text-sm text-ink-2">The old PIN and any existing session stop working when you save.</p>
          {pinFields}
          <div className="mt-5 flex gap-3">
            <button type="button" disabled={busy || !validPin} onClick={() => void doReset()} className="h-14 rounded-box border border-ink bg-ink px-5 font-medium text-paper disabled:opacity-40">Set new PIN</button>
            <button type="button" disabled={busy} onClick={() => { setResetting(null); clearPin(); }} className="h-14 rounded-box border border-rule bg-sheet px-5">Cancel</button>
          </div>
        </section>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Clinic staff</h2>
      <ul className="mt-2 max-w-5xl">
        {staff.map((row) => (
          <li key={row.id} className={`flex items-center gap-3 border-b border-rule py-3 ${row.active ? '' : 'opacity-50'}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg">{row.name}</span>
              <span className="block text-sm text-ink-2">{roleLabel(row.role)}{row.active ? '' : ' · inactive'}</span>
            </span>
            <button type="button" disabled={!allowed || busy || !row.active} onClick={() => { setResetting(row); setAdding(false); clearPin(); }} className="h-14 rounded-box border border-rule bg-sheet px-4 disabled:opacity-40">Reset PIN</button>
            <button type="button" disabled={!allowed || busy} onClick={() => void run(async () => { await updateStaff(row.id, { active: !row.active }); return row.active ? `${row.name} can no longer sign in.` : `${row.name} is active again.`; })} className="h-14 w-32 rounded-box border border-rule bg-sheet px-4 disabled:opacity-40">
              {row.active ? 'Deactivate' : 'Activate'}
            </button>
          </li>
        ))}
      </ul>
    </ThreePane>
  );
}
