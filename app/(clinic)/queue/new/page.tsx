'use client';

/**
 * Register a walk-in, and hand out a token.
 *
 * The numpad lives in the rail rather than in a popover: rule 5 forbids stacked
 * modals, and the rail is already the place where the fixed controls live. Tap
 * a numeric field and the pad appears there.
 *
 * Consent is a deliberate, recorded step (DPDP §15.1) — it is stored with a
 * timestamp and a source, and it is revocable. Not a pre-ticked box.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import { createPatient, searchPatients, type Patient } from '@/lib/db/patients';
import { bookAppointment } from '@/lib/transitions/clinic';

type NumericField = 'phone' | 'age' | null;

export default function RegisterWalkInPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState<'M' | 'F' | 'O' | ''>('');
  const [allergies, setAllergies] = useState('');
  const [address, setAddress] = useState('');
  const [consent, setConsent] = useState(false);

  const [active, setActive] = useState<NumericField>(null);
  const [matches, setMatches] = useState<Patient[]>([]);
  const [existing, setExisting] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canRegister = existing !== null || (name.trim().length > 1 && consent);

  const lookUp = (value: string) => {
    setPhone(value);
    if (value.length >= 6) {
      void searchPatients(value).then(setMatches).catch(() => setMatches([]));
    } else {
      setMatches([]);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const patient = existing ?? (await createPatient({
        name,
        phone: phone || undefined,
        age: age ? Number(age) : undefined,
        sex: sex || undefined,
        address: address || undefined,
        allergies: allergies || undefined,
      }));

      await bookAppointment({ patientId: patient.id, source: 'walkin' });
      router.push('/queue');
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const setActiveValue = (updater: (current: string) => string) => {
    if (active === 'phone') lookUp(updater(phone));
    if (active === 'age') setAge(updater(age).slice(0, 3));
  };

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Registering</h2>
          <p className="mt-1 text-lg">{existing?.name || name || 'New patient'}</p>

          {/* Families share one handset constantly, so a phone match is a
              chooser rather than an answer (PLAN.md §14). */}
          {matches.length > 0 && !existing ? (
            <div className="mt-6">
              <p className="text-sm text-muted">
                This number is already registered to {matches.length === 1 ? '' : 'these people'}:
              </p>
              <ul className="mt-3 space-y-2">
                {matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      onClick={() => setExisting(match)}
                      className="h-14 w-full rounded-xl border border-line bg-white px-3 text-left active:bg-line"
                    >
                      {match.name}
                      <span className="block text-sm text-muted">
                        {[match.age, match.sex].filter(Boolean).join(' · ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {existing ? (
            <button
              type="button"
              onClick={() => setExisting(null)}
              className="mt-4 h-11 rounded-lg border border-line px-4 text-sm text-muted"
            >
              Someone else on this number
            </button>
          ) : null}
        </div>
      }
      rail={
        active ? (
          <>
            <p className="text-sm text-muted">{active === 'phone' ? 'Phone' : 'Age'}</p>
            <Numpad
              onDigit={(digit) => setActiveValue((current) => current + digit)}
              onBackspace={() => setActiveValue((current) => current.slice(0, -1))}
            />
            <RailButton onClick={() => setActive(null)}>Done</RailButton>
          </>
        ) : (
          <>
            <RailButton tone="primary" disabled={!canRegister || busy} onClick={() => void submit()}>
              {busy ? 'Registering…' : 'Register & get token'}
            </RailButton>
            <RailButton onClick={() => router.push('/queue')}>Cancel</RailButton>
          </>
        )
      }
    >
      <h1 className="text-2xl font-semibold">Register walk-in</h1>

      {error ? <p className="mt-4 text-danger">{error}</p> : null}

      {existing ? (
        <p className="mt-6 text-muted">
          {existing.name} is already registered. Registering will give them today&apos;s next token.
        </p>
      ) : (
        <div className="mt-6 max-w-xl space-y-5">
          <Field label="Name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onFocus={() => setActive(null)}
              aria-label="Name"
              className="h-14 w-full rounded-xl border border-line bg-white px-4 text-lg"
            />
          </Field>

          <Field label="Phone">
            <button
              type="button"
              onClick={() => setActive('phone')}
              aria-label="Phone"
              className={`tabular h-14 w-full rounded-xl border bg-white px-4 text-left text-lg ${
                active === 'phone' ? 'border-ink' : 'border-line'
              }`}
            >
              {phone || <span className="text-muted">Tap to enter</span>}
            </button>
          </Field>

          <div className="flex gap-5">
            <Field label="Age">
              <button
                type="button"
                onClick={() => setActive('age')}
                aria-label="Age"
                className={`tabular h-14 w-32 rounded-xl border bg-white px-4 text-left text-lg ${
                  active === 'age' ? 'border-ink' : 'border-line'
                }`}
              >
                {age || <span className="text-muted">—</span>}
              </button>
            </Field>

            {/* A group of buttons is not a labelled control: wrapping them in a
                <label> makes the first button's accessible name swallow the
                other two. role="group" with a label is the correct shape, and
                screen-reader users get three distinct buttons. */}
            <div role="group" aria-label="Sex">
              <span className="mb-1 block text-sm text-muted">Sex</span>
              <div className="flex gap-2">
                {(['M', 'F', 'O'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    aria-pressed={sex === option}
                    onClick={() => setSex(option)}
                    className={`h-14 w-14 rounded-xl border text-lg ${
                      sex === option ? 'border-ink bg-ink text-white' : 'border-line bg-white'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* The Schedule H1 register legally requires the patient's address
              (PLAN.md §15.2), and a register with blanks in it is not one. It
              is optional here on purpose — holding up a queue for an address
              nobody needs is worse — and the register flags every row that ends
              up without one, so the gap is visible rather than discovered
              during an inspection. */}
          <Field label="Address">
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => setActive(null)}
              aria-label="Address"
              placeholder="Needed on the H1 register"
              className="h-14 w-full rounded-xl border border-line bg-white px-4 text-lg"
            />
          </Field>

          <Field label="Allergies">
            <input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              onFocus={() => setActive(null)}
              aria-label="Allergies"
              placeholder="None known"
              className="h-14 w-full rounded-xl border border-line bg-white px-4 text-lg"
            />
          </Field>

          <button
            type="button"
            onClick={() => setConsent((value) => !value)}
            aria-label="Consent"
            aria-pressed={consent}
            className="flex h-14 w-full items-center gap-3 rounded-xl border border-line bg-white px-4 text-left active:bg-line"
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded border ${
                consent ? 'border-ink bg-ink text-white' : 'border-line'
              }`}
            >
              {consent ? '✓' : ''}
            </span>
            <span className="text-base">
              Consent given to hold these details for treatment
            </span>
          </button>
        </div>
      )}
    </ThreePane>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}
