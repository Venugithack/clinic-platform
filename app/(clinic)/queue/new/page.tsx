'use client';

/**
 * Register a walk-in, and hand out a token.
 *
 * The fastest safe path is lookup first: returning patients should not be
 * re-entered as new records just because the registration form opens with a
 * blank name field. Phone therefore leads the flow, while the new-patient
 * details stay available immediately underneath when there is no match.
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
  const [reason, setReason] = useState('');
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
    setExisting(null);
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
      const patient =
        existing ??
        (await createPatient({
          name,
          phone: phone || undefined,
          age: age ? Number(age) : undefined,
          sex: sex || undefined,
          address: address || undefined,
          allergies: allergies || undefined,
        }));

      await bookAppointment({
        patientId: patient.id,
        source: 'walkin',
        reason: reason.trim() || undefined,
      });
      router.push('/queue');
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const setActiveValue = (updater: (current: string) => string) => {
    if (active === 'phone') lookUp(updater(phone).slice(0, 15));
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
        <div className="space-y-6">
          <div>
            <p className="eyebrow">Patient</p>
            <p className="mt-1 text-lg font-medium">{existing?.name || name || 'New walk-in'}</p>
            <p className="mt-1 text-sm leading-6 text-ink-2">
              {existing
                ? 'Existing record selected. Give today’s token without creating a duplicate patient.'
                : phone.length >= 6
                  ? matches.length > 0
                    ? 'Choose the matching patient, or continue below only if this is someone else.'
                    : 'No matching patient found. Continue with the new-patient details.'
                  : 'Start with the phone number to find returning patients.'}
            </p>
          </div>

          {reason.trim() ? (
            <div>
              <p className="eyebrow">Today’s reason</p>
              <p className="mt-1 text-sm leading-6">{reason.trim()}</p>
            </div>
          ) : null}

          {matches.length > 0 && !existing ? (
            <div>
              <p className="eyebrow">Matches</p>
              <ul className="mt-2 space-y-2">
                {matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      onClick={() => setExisting(match)}
                      className="min-h-16 w-full rounded-box border border-rule bg-sheet px-4 py-3 text-left active:bg-paper-2"
                    >
                      <span className="block text-base font-medium">{match.name}</span>
                      <span className="block text-sm text-ink-2">
                        {[match.phone, match.age ? `${match.age} yrs` : null, match.sex]
                          .filter(Boolean)
                          .join(' · ')}
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
              className="h-12 w-full rounded-box border border-rule px-4 text-sm text-ink-2 active:bg-paper-2"
            >
              This is someone else
            </button>
          ) : null}
        </div>
      }
      primary={
        active
          ? { label: 'Done', onClick: () => setActive(null) }
          : {
              label: busy
                ? 'Registering…'
                : existing
                  ? 'Give today’s token'
                  : 'Register & get token',
              onClick: () => void submit(),
              disabled: !canRegister || busy,
            }
      }
      rail={
        active ? (
          <>
            <p className="text-sm text-ink-2">{active === 'phone' ? 'Phone number' : 'Age'}</p>
            <Numpad
              onDigit={(digit) => setActiveValue((current) => current + digit)}
              onBackspace={() => setActiveValue((current) => current.slice(0, -1))}
            />
            <RailButton tone="primary" onClick={() => setActive(null)}>
              Done
            </RailButton>
          </>
        ) : (
          <>
            <RailButton tone="primary" disabled={!canRegister || busy} onClick={() => void submit()}>
              {busy ? 'Registering…' : existing ? 'Give today’s token' : 'Register & get token'}
            </RailButton>
            <RailButton onClick={() => router.push('/queue')}>Back to queue</RailButton>
          </>
        )
      }
    >
      <PageHeader
        eyebrow="Patient intake"
        title="Register walk-in"
        sub="Find returning patients before creating a new record"
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="mt-6 max-w-xl space-y-6">
        <section aria-labelledby="find-patient-heading">
          <div className="mb-3">
            <h2 id="find-patient-heading" className="text-lg font-medium">
              1 · Find the patient
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              Enter a phone number first. Matching records appear on the left.
            </p>
          </div>

          <Field label="Phone">
            <button
              type="button"
              onClick={() => setActive('phone')}
              aria-label="Phone"
              className={`blank tabular h-14 w-full px-4 text-left text-lg ${
                active === 'phone' ? 'border-active' : ''
              }`}
            >
              {phone || <span className="text-ink-2">Tap to enter phone number</span>}
            </button>
          </Field>
        </section>

        {existing ? (
          <Notice tone="good">
            {existing.name} is selected. Their permanent details stay unchanged.
          </Notice>
        ) : (
          <section aria-labelledby="new-patient-heading" className="border-t border-rule pt-5">
            <div className="mb-4">
              <h2 id="new-patient-heading" className="text-lg font-medium">
                2 · New patient details
              </h2>
              <p className="mt-1 text-sm text-ink-2">
                Use this section only when the patient is not already registered.
              </p>
            </div>

            <div className="space-y-5">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onFocus={() => setActive(null)}
                  aria-label="Name"
                  autoComplete="name"
                  className="blank h-14 w-full px-4 text-lg"
                />
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

              <Field label="Address">
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  onFocus={() => setActive(null)}
                  aria-label="Address"
                  placeholder="Required when Schedule H1 details are needed"
                  className="blank h-14 w-full px-4 text-lg"
                />
              </Field>

              <button
                type="button"
                onClick={() => setConsent((value) => !value)}
                aria-label="Consent"
                aria-pressed={consent}
                className="flex min-h-14 w-full items-center gap-3 rounded-box border border-rule bg-sheet px-4 py-3 text-left active:bg-paper-2"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-box border ${
                    consent ? 'border-ink bg-ink text-paper' : 'border-rule'
                  }`}
                >
                  {consent ? '✓' : ''}
                </span>
                <span className="text-base">Consent given to keep these details for treatment</span>
              </button>
            </div>
          </section>
        )}

        <section aria-labelledby="visit-heading" className="border-t border-rule pt-5">
          <div className="mb-3">
            <h2 id="visit-heading" className="text-lg font-medium">
              {existing ? '2' : '3'} · Today’s visit
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              A short reason helps the doctor scan the queue before opening the consultation.
            </p>
          </div>
          <Field label="Reason for visit">
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value.slice(0, 120))}
              onFocus={() => setActive(null)}
              aria-label="Reason for visit"
              placeholder="e.g. fever since yesterday"
              className="blank h-14 w-full px-4 text-lg"
            />
          </Field>
        </section>
      </div>
    </ThreePane>
  );
}
