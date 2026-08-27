'use client';

/**
 * Register a walk-in, and hand out a token.
 *
 * Registration is shared clinical intake in this clinic: doctors and nurses
 * can both create/find a patient and issue today's token. Vitals are a separate
 * shared action from the queue so either person can do them when the workflow
 * actually reaches that step.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Field, Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import { currentSession } from '@/lib/auth';
import { createPatient, searchPatients, type Patient } from '@/lib/db/patients';
import { bookAppointment } from '@/lib/transitions/clinic';

type NumericField = 'phone' | 'age' | null;

export default function RegisterWalkInPage() {
  const router = useRouter();
  const session = currentSession();
  const canIntake =
    session?.role === 'doctor' || session?.role === 'nurse' || session?.role === 'admin';

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

  const canRegister = canIntake && (existing !== null || (name.trim().length > 1 && consent));

  const lookUp = (value: string) => {
    setPhone(value);
    if (value.length >= 6) {
      void searchPatients(value).then(setMatches).catch(() => setMatches([]));
    } else {
      setMatches([]);
    }
  };

  const submit = async () => {
    if (!canIntake) return;
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

  if (!canIntake) {
    return (
      <ThreePane
        context={<div />}
        rail={<RailButton onClick={() => router.push('/counter')}>Back to counter</RailButton>}
      >
        <PageHeader eyebrow="Patient intake" title="Register walk-in" />
        <Notice tone="bad">Patient registration is available to doctors and nurses.</Notice>
      </ThreePane>
    );
  }

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Registering</h2>
          <p className="mt-1 text-lg">{existing?.name || name || 'New patient'}</p>

          {matches.length > 0 && !existing ? (
            <div className="mt-6">
              <p className="text-sm text-ink-2">
                This number is already registered to {matches.length === 1 ? '' : 'these people'}:
              </p>
              <ul className="mt-3 space-y-2">
                {matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      onClick={() => setExisting(match)}
                      className="h-14 w-full rounded-box border border-rule bg-sheet px-3 text-left active:bg-paper-2"
                    >
                      {match.name}
                      <span className="block text-sm text-ink-2">
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
              className="mt-4 h-11 rounded-box border border-rule px-4 text-sm text-ink-2"
            >
              Someone else on this number
            </button>
          ) : null}
        </div>
      }
      rail={
        active ? (
          <>
            <p className="text-sm text-ink-2">{active === 'phone' ? 'Phone' : 'Age'}</p>
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
      <PageHeader eyebrow="Patient intake" title="Register walk-in" sub={session?.staffName} />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {existing ? (
        <p className="mt-6 text-ink-2">
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
              className="blank h-14 w-full px-4 text-lg"
            />
          </Field>

          <Field label="Phone">
            <button
              type="button"
              onClick={() => setActive('phone')}
              aria-label="Phone"
              className={`blank tabular h-14 w-full px-4 text-left text-lg ${
                active === 'phone' ? 'border-active' : ''
              }`}
            >
              {phone || <span className="text-ink-2">Tap to enter</span>}
            </button>
          </Field>

          <div className="flex gap-5">
            <Field label="Age">
              <button
                type="button"
                onClick={() => setActive('age')}
                aria-label="Age"
                className={`blank tabular h-14 w-32 px-4 text-left text-lg ${
                  active === 'age' ? 'border-active' : ''
                }`}
              >
                {age || <span className="text-ink-2">—</span>}
              </button>
            </Field>

            <div role="group" aria-label="Sex">
              <span className="eyebrow mb-1 block">Sex</span>
              <div className="flex gap-2">
                {(['M', 'F', 'O'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    aria-pressed={sex === option}
                    onClick={() => setSex(option)}
                    className={`h-14 w-14 rounded-box border text-lg ${
                      sex === option ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Field label="Address">
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => setActive(null)}
              aria-label="Address"
              placeholder="Needed on the H1 register"
              className="blank h-14 w-full px-4 text-lg"
            />
          </Field>

          <Field label="Allergies">
            <input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              onFocus={() => setActive(null)}
              aria-label="Allergies"
              placeholder="None known"
              className="blank h-14 w-full px-4 text-lg"
            />
          </Field>

          <button
            type="button"
            onClick={() => setConsent((value) => !value)}
            aria-label="Consent"
            aria-pressed={consent}
            className="flex h-14 w-full items-center gap-3 rounded-box border border-rule bg-sheet px-4 text-left active:bg-paper-2"
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-box border ${
                consent ? 'border-ink bg-ink text-paper' : 'border-rule'
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
