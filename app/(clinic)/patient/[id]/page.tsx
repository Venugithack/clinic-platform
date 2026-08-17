'use client';

/**
 * Correcting a patient's record. PLAN.md §15.2, DPDP §15.
 *
 * M8 gave the Schedule H1 register an `address_missing` flag, because the rule
 * requires the patient's address and a register with blanks in it is not one.
 * Then it offered no way to fill the blank in — so the pharmacist reading that
 * flag had to find a developer, which is a flag nobody acts on. This is the
 * other half of it, and the reports screen links straight here.
 *
 * Two things are deliberately not on this screen.
 *
 * **Consent.** Withdrawing it is its own act with its own timestamp, not a
 * checkbox on a correction form.
 *
 * **Delete.** There is no DELETE grant anywhere in this build, and a patient
 * least of all: their name is on prescriptions, dispenses and the H1 register,
 * and those are the legal record of what was given to whom.
 *
 * Every save here writes an audit row naming who changed what — a recorded
 * allergy that can change with nobody's name on it is the failure that made
 * the trigger worth adding.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import {
  getPatient,
  recentVisits,
  updatePatient,
  type Patient,
  type VisitSummary,
} from '@/lib/db/patients';

type NumericField = 'phone' | 'age' | null;

export default function PatientPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [patient, setPatient] = useState<Patient | null>(null);
  const [visits, setVisits] = useState<VisitSummary[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [address, setAddress] = useState('');
  const [allergies, setAllergies] = useState('');
  const [active, setActive] = useState<NumericField>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    // Cleared before the reads, never after them. A read landing is not
    // evidence that the last WRITE succeeded, and clearing on completion
    // erased a refusal somebody was in the middle of reading (M11e).
    setError(null);
    void (async () => {
      try {
        const row = await getPatient(id);
        if (!row) {
          setError('No such patient.');
          return;
        }
        setPatient(row);
        setName(row.name);
        setPhone(row.phone ?? '');
        setAge(row.age === null ? '' : String(row.age));
        setSex(row.sex ?? '');
        setAddress(row.address ?? '');
        setAllergies(row.allergies ?? '');
        setVisits(await recentVisits(id));
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [id]);

  useEffect(load, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const row = await updatePatient(id, {
        name,
        phone,
        age: age === '' ? undefined : Number(age),
        sex: (sex || undefined) as 'M' | 'F' | 'O' | undefined,
        address,
        allergies,
      });
      setPatient(row);
      setNotice('Saved. The change is recorded against your name.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Patient</h2>
          <p className="mt-1 text-lg">{patient?.name ?? '—'}</p>

          {patient?.phone_is_shared ? (
            <p className="mt-3 rounded-lg bg-ink/5 p-3 text-sm">
              This phone number belongs to more than one patient — families
              share a handset. Changing it here changes it for this person only.
            </p>
          ) : null}

          <p className="mt-6 text-sm text-muted">
            The Schedule H1 register legally requires an address. A row without
            one is what the reports screen flags, and this is where it gets
            fixed.
          </p>

          {visits.length > 0 ? (
            <>
              <h3 className="mt-8 text-sm uppercase tracking-wide text-muted">
                Recent visits
              </h3>
              <ul className="mt-2 space-y-2 text-sm text-muted">
                {visits.map((visit) => (
                  <li key={visit.id}>
                    {new Date(visit.created_at).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || name.trim() === '' || patient === null}
            onClick={() => void save()}
          >
            Save
          </RailButton>
          <RailButton disabled={busy} onClick={load}>
            Undo changes
          </RailButton>

          {active ? (
            <div className="mt-2">
              <Numpad
                onDigit={(digit) =>
                  active === 'phone'
                    ? setPhone((current) => current + digit)
                    : setAge((current) => (current + digit).slice(0, 3))
                }
                onBackspace={() =>
                  active === 'phone'
                    ? setPhone((current) => current.slice(0, -1))
                    : setAge((current) => current.slice(0, -1))
                }
              />
            </div>
          ) : null}

          <div className="flex-1" />
          <RailButton onClick={() => router.back()}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Patient record</h1>

      {error ? (
        <p className="mt-4 max-w-3xl rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p
          role="status"
          data-testid="patient-saved"
          className="mt-4 max-w-3xl rounded-lg bg-ok/10 p-3 text-ok"
        >
          {notice}
        </p>
      ) : null}

      <div className="mt-6 grid max-w-3xl grid-cols-2 gap-5">
        <label className="block">
          <span className="block text-sm text-muted">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Name"
            className="mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
          />
        </label>

        <label className="block">
          <span className="block text-sm text-muted">Phone</span>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            onFocus={() => setActive('phone')}
            aria-label="Phone"
            inputMode="none"
            className="tabular mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
          />
        </label>

        <label className="block">
          <span className="block text-sm text-muted">Age</span>
          <input
            value={age}
            onChange={(event) => setAge(event.target.value.replace(/\D/g, ''))}
            onFocus={() => setActive('age')}
            aria-label="Age"
            inputMode="none"
            className="tabular mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
          />
        </label>

        <div>
          <span className="block text-sm text-muted">Sex</span>
          <div className="mt-1 flex gap-2">
            {(['M', 'F', 'O'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={sex === option}
                onClick={() => setSex(sex === option ? '' : option)}
                className={`h-14 flex-1 rounded-xl border active:bg-line ${
                  sex === option ? 'border-ink bg-ink/5' : 'border-line bg-white'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="mt-5 block max-w-3xl">
        <span className="block text-sm text-muted">
          Address — required on the Schedule H1 register
        </span>
        <textarea
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => setActive(null)}
          aria-label="Address"
          className="mt-1 h-24 w-full rounded-xl border border-line bg-white p-3 text-lg"
        />
      </label>

      <label className="mt-5 block max-w-3xl">
        <span className="block text-sm text-muted">
          Allergies — shown to the doctor before the record opens
        </span>
        <input
          value={allergies}
          onChange={(event) => setAllergies(event.target.value)}
          onFocus={() => setActive(null)}
          aria-label="Allergies"
          className="mt-1 h-14 w-full rounded-xl border border-line bg-white px-3 text-lg"
        />
      </label>

      <p className="mt-6 max-w-3xl text-sm text-muted">
        Nothing here can be deleted. This record is named on prescriptions, on
        dispenses and on the Schedule H1 register, and those are the legal
        record of what was given to whom.
      </p>
    </ThreePane>
  );
}
