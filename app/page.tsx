'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Numpad } from '@/components/Numpad';
import { Button, Notice } from '@/components/ui';
import { firstRun } from '@/lib/transitions/admin';
import {
  currentSession,
  deviceToken,
  registerDeviceLocally,
  unlock,
  writeStoredSession,
  type StaffSession,
} from '@/lib/auth';

/**
 * The lock screen. TABLET.md §5.
 *
 * Email-and-password on a shared tablet, several times a day, will be defeated
 * by the staff within a week — they will pick a short password or never log
 * out. So the device holds the session and a six-digit PIN holds the identity.
 * Every write then carries the staff id from the PIN, which is what lets the
 * audit log and the Schedule H1 register name a person rather than a tablet.
 */

interface StaffOption {
  id: string;
  name: string;
}

const PIN_LENGTH = 6;

export default function LockScreen() {
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selected, setSelected] = useState<StaffOption | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(true);
  const [code, setCode] = useState('');

  // Whether this database has ever been set up. `undefined` means we have not
  // been able to ask — which is not the same as "empty", and the difference
  // decides whether a stranger is offered the setup form.
  const [virgin, setVirgin] = useState<boolean | undefined>(undefined);
  const [clinicName, setClinicName] = useState('');
  const [myName, setMyName] = useState('');
  const [tabletName, setTabletName] = useState('');

  useEffect(() => {
    setSession(currentSession());
    setRegistered(deviceToken() !== null);
  }, []);

  // Which of two situations an unregistered tablet is in: a clinic that exists
  // and has not been told about this device, or a database nobody has set up.
  //
  // It cannot be answered from the staff list. That list is behind RLS which
  // needs a resolved staff member, so it comes back empty on a fresh database
  // AND on a live one seen from a tablet nobody has signed in on — the same
  // answer for opposite reasons. `clinic_setup_state` is one boolean that
  // means what it says.
  useEffect(() => {
    if (registered) return;
    void (async () => {
      const { needsSetup } = await import('@/lib/db/settings');
      setVirgin(await needsSetup());
    })();
  }, [registered]);

  useEffect(() => {
    if (!registered) return;
    void (async () => {
      try {
        // Read through the seam; lib/db is the only module that knows Supabase.
        const { listActiveStaff } = await import('@/lib/db/staff');
        setStaff(await listActiveStaff());
        setError(null);
      } catch {
        setError('Cannot reach the clinic database.');
      }
    })();
  }, [registered]);

  useEffect(() => {
    if (pin.length !== PIN_LENGTH || !selected || busy) return;

    setBusy(true);
    setError(null);

    void unlock(selected.id, pin)
      .then(setSession)
      .catch((cause: Error) => {
        // Undifferentiated by design: a lock screen that tells you which half
        // you got right is a lock screen that helps.
        setError(cause.message);
        setPin('');
      })
      .finally(() => setBusy(false));
  }, [pin, selected, busy]);

  const setUpTheClinic = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await firstRun({
        clinicName,
        staffName: myName,
        pin,
        deviceLabel: tabletName,
      });
      // The device token comes back exactly once. Writing it here is what turns
      // this browser into a registered tablet.
      registerDeviceLocally(started.device_token);
      // And the session it also handed back signs him in on it, so the PIN he
      // chose four seconds ago is not asked for again.
      const opened: StaffSession = {
        token: started.session_token,
        staffId: started.staff_id,
        staffName: started.staff_name,
        role: 'admin',
      };
      writeStoredSession(opened);
      setPin('');
      setRegistered(true);
      setVirgin(false);
      setSession(opened);
    } catch (cause) {
      setError((cause as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  // A database nobody has set up yet, on a tablet nobody has registered.
  //
  // This is the state production starts in and development never sees, and
  // until M11f there was no way out of it: registering a tablet needed an
  // admin, and an admin needed a tablet to sign in on. It is offered only when
  // the staff list came back and came back EMPTY — a failed read leaves
  // `virgin` undefined and this screen unoffered, because a network blip on a
  // working tablet must never show a stranger a form that mints an admin.
  if (!registered && virgin === true) {
    const ready =
      clinicName.trim() !== '' && myName.trim() !== '' && pin.length === PIN_LENGTH;

    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Set this clinic up</h1>
        <p className="mt-3 max-w-md text-center text-ink-2">
          There is nothing in this system yet. This creates the clinic, makes
          you its administrator and registers this tablet — once, and then
          never again.
        </p>

        <div className="mt-8 w-full max-w-md space-y-4">
          <label className="block">
            <span className="eyebrow block">Clinic name</span>
            <input
              value={clinicName}
              onChange={(event) => setClinicName(event.target.value)}
              aria-label="Clinic name"
              className="blank mt-1 h-14 px-3 text-lg"
            />
          </label>

          <label className="block">
            <span className="eyebrow block">Your name</span>
            <input
              value={myName}
              onChange={(event) => setMyName(event.target.value)}
              aria-label="Your name"
              className="blank mt-1 h-14 px-3 text-lg"
            />
          </label>

          <label className="block">
            <span className="eyebrow block">
              This tablet — &ldquo;cabin&rdquo;, &ldquo;counter&rdquo;
            </span>
            <input
              value={tabletName}
              onChange={(event) => setTabletName(event.target.value)}
              aria-label="This tablet"
              placeholder="Cabin tablet"
              className="blank mt-1 h-14 px-3 text-lg"
            />
          </label>
        </div>

        <p className="mt-6 text-sm text-ink-2">Choose your 6-digit PIN</p>
        <div className="mt-3 flex gap-3" aria-label="PIN entry" role="status">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full border border-rule ${
                i < pin.length ? 'bg-ink' : 'bg-transparent'
              }`}
            />
          ))}
        </div>

        <div className="mt-4 w-64">
          <Numpad
            disabled={busy}
            onDigit={(d) => setPin((p) => (p.length < PIN_LENGTH ? p + d : p))}
            onBackspace={() => setPin((p) => p.slice(0, -1))}
          />
        </div>

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void setUpTheClinic()}
          className="mt-6 w-full max-w-md"
        >
          Set up
        </Button>
      </Centered>
    );
  }

  if (!registered) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">This tablet is not registered</h1>
        <p className="mt-3 max-w-md text-ink-2">
          Ask the administrator to register it before signing in. A PIN alone is
          useless on an unregistered device.
        </p>

        {/* The other half of the admin screen's "register a tablet". The code
            is shown there once and typed here once, and after that this screen
            is never seen again on this device. It is not verified on the way
            in: a wrong code fails at the first unlock, saying exactly that. */}
        <label className="mt-8 w-full max-w-md">
          <span className="eyebrow block">
            Registration code, from the administrator
          </span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            aria-label="Registration code"
            spellCheck={false}
            className="blank tabular mt-1 h-14 px-3 font-mono"
          />
        </label>

        <Button
          variant="primary"
          disabled={code.length < 16}
          onClick={() => {
            registerDeviceLocally(code);
            setRegistered(true);
          }}
          className="mt-4 w-full max-w-md"
        >
          Register this tablet
        </Button>
      </Centered>
    );
  }

  if (session) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Signed in as {session.staffName}</h1>
        <p className="mt-3 text-ink-2">
          {session.role === 'doctor' ? 'Consulting room' : 'Pharmacy counter'}
        </p>
        <Button
          variant="primary"
          onClick={() => router.replace('/queue')}
          className="mt-8 px-8"
        >
          Open the queue
        </Button>
      </Centered>
    );
  }

  if (!selected) {
    return (
      <Centered>
        <h1 className="text-2xl font-semibold">Who is this?</h1>
        <ul className="mt-6 w-full max-w-md space-y-3">
          {staff.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => setSelected(member)}
                className="hoverable h-14 w-full rounded-box border border-ink bg-sheet px-5 text-left text-lg active:bg-paper-2"
              >
                {member.name}
              </button>
            </li>
          ))}
        </ul>
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="text-2xl font-semibold">{selected.name}</h1>
      <p className="mt-2 text-ink-2">Enter your 6-digit PIN</p>

      <div className="mt-6 flex gap-3" aria-label="PIN entry" role="status">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border border-rule ${
              i < pin.length ? 'bg-ink' : 'bg-transparent'
            }`}
          />
        ))}
      </div>

      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="mt-8 w-64">
        <Numpad
          disabled={busy}
          onDigit={(d) => setPin((p) => (p.length < PIN_LENGTH ? p + d : p))}
          onBackspace={() => setPin((p) => p.slice(0, -1))}
        />
      </div>

      <Button
        variant="ghost"
        size="lg"
        onClick={() => {
          setSelected(null);
          setPin('');
          setError(null);
        }}
        className="mt-8 px-6"
      >
        Not me
      </Button>
    </Centered>
  );
}

/**
 * The lock screen runs bare — no panes, no rail. You are not yet anyone, so
 * there is no identity to display except the clinic's own, and this is the one
 * screen in the product with room to show it properly.
 *
 * The mark here is the full logo rather than the monogram in the shell rail:
 * this is the screen a pharmacist starting on Monday matches against the board
 * outside before typing a PIN into a tablet they have never seen before.
 */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full flex-col items-center justify-center p-10">
      {/* logo-mark.png rather than logo.png: the supplied artwork is on a white
          ground, and a white rectangle on the paper ground reads as a sticker
          stuck to the screen. The mark is the same file cropped to its content
          with the white knocked out to alpha, so it sits ON the paper. */}
      <Image
        src="/logo-mark.png"
        alt="Jayamurugan Clinic"
        width={900}
        height={643}
        priority
        className="mb-8 h-28 w-auto"
      />
      {children}
    </main>
  );
}
