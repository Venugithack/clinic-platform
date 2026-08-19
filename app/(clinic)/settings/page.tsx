'use client';

/**
 * Clinic settings. PLAN.md §16, §18 Q10.
 *
 * Everything on this screen was, until M11b, a developer with `psql` — on a row
 * that appears on every printed bill and decides whether the public status page
 * says the clinic is open.
 *
 * Two decisions about the shape of it.
 *
 * **One text box per day for the hours**, not a grid of time pickers. It is how
 * the doctor says it out loud — "mornings and evenings, half day Saturday" —
 * and a picker costs four taps per boundary, fourteen boundaries in a week. The
 * box does no repair of what he typed: anything the database cannot read comes
 * back named, by day and by window. A screen that quietly drops what it does
 * not understand turns a typo into a clinic that is shut on Mondays.
 *
 * **Nothing is saved field by field.** One Save, one transition, one audit row
 * with the before and the after — because "since when has the fee been ₹400?"
 * is a question somebody asks three months later.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import { clinicRow, type ClinicRow } from '@/lib/db/settings';
import {
  formatWindows,
  parseWindows,
  updateClinic,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type OpenHours,
} from '@/lib/transitions/settings';

interface Form {
  name: string;
  address: string;
  phone: string;
  doctorRegNo: string;
  drugLicenceNo: string;
  gstin: string;
  consultFee: string;
  followUpFreeDays: string;
  roundToRupee: boolean;
  hours: Record<string, string>;
}

const EMPTY: Form = {
  name: '',
  address: '',
  phone: '',
  doctorRegNo: '',
  drugLicenceNo: '',
  gstin: '',
  consultFee: '0',
  followUpFreeDays: '',
  roundToRupee: true,
  hours: Object.fromEntries(WEEKDAYS.map((day) => [day, ''])),
};

function toForm(row: ClinicRow): Form {
  return {
    name: row.name,
    address: row.address ?? '',
    phone: row.phone ?? '',
    doctorRegNo: row.doctor_reg_no ?? '',
    drugLicenceNo: row.drug_licence_no ?? '',
    gstin: row.gstin ?? '',
    consultFee: String(Number(row.consult_fee)),
    followUpFreeDays:
      row.follow_up_free_days === null ? '' : String(row.follow_up_free_days),
    roundToRupee: row.round_to_rupee,
    hours: Object.fromEntries(
      WEEKDAYS.map((day) => [day, formatWindows(row.open_hours?.[day])]),
    ),
  };
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm text-ink-2">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="blank mt-1 h-14 w-full px-3 text-lg"
      />
      {hint ? <span className="mt-1 block text-sm text-ink-2">{hint}</span> : null}
    </label>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const session = typeof window === 'undefined' ? null : currentSession();
  const allowed = session?.role === 'doctor' || session?.role === 'admin';

  const [form, setForm] = useState<Form | null>(null);
  const [exists, setExists] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    // Cleared before the reads, never after them. A read landing is not
    // evidence that the last WRITE succeeded, and clearing on completion
    // erased a refusal somebody was in the middle of reading (M11e).
    setError(null);
    void (async () => {
      try {
        const row = await clinicRow();
        setExists(row !== null);
        setForm(row ? toForm(row) : EMPTY);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const setDay = (day: string, value: string) =>
    setForm((current) =>
      current ? { ...current, hours: { ...current.hours, [day]: value } } : current,
    );

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const openHours: OpenHours = Object.fromEntries(
      WEEKDAYS.map((day) => [day, parseWindows(form.hours[day] ?? '')]),
    );

    try {
      const row = await updateClinic({
        name: form.name,
        address: form.address,
        phone: form.phone,
        doctorRegNo: form.doctorRegNo,
        drugLicenceNo: form.drugLicenceNo,
        gstin: form.gstin,
        consultFee: Number(form.consultFee || '0'),
        // -1 is how "no free follow-up window at all" is said, because an
        // empty box has to mean something and it cannot mean zero days.
        followUpFreeDays:
          form.followUpFreeDays === '' ? -1 : Number(form.followUpFreeDays),
        roundToRupee: form.roundToRupee,
        openHours,
      });

      setForm(toForm(row));
      setExists(true);
      setNotice('Saved. Bills printed from now on carry these details.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!form) {
    return (
      <ThreePane rail={<RailButton onClick={() => router.push('/queue')}>Back</RailButton>}>
        <PageHeader eyebrow="Administration" title="Settings" />
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </ThreePane>
    );
  }

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Settings</h2>
          <p className="mt-1 text-lg">{exists ? form.name : 'No clinic yet'}</p>

          {!exists ? (
            <p className="mt-6 rounded-box bg-paper-2 p-3 text-sm">
              This database has no clinic record. Fill this in and save — it is
              the first thing go-live does, and nothing else needs a developer.
            </p>
          ) : null}

          <p className="mt-6 text-sm text-ink-2">
            <strong className="text-ink">The licence numbers and the GSTIN are
            printed on every bill.</strong>{' '}
            A bill is a legal document and it cannot be un-printed, so they are
            checked before they are saved.
          </p>

          <p className="mt-4 text-sm text-ink-2">
            <strong className="text-ink">The hours drive the public page.</strong>{' '}
            A day left empty means closed all day — which is the safe direction
            for a page a patient drives to the clinic on.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || !allowed || form.name.trim() === ''}
            onClick={() => void save()}
          >
            Save
          </RailButton>
          <RailButton disabled={busy} onClick={refresh}>
            Undo changes
          </RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/queue')}>Back</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="Settings" />

      {!allowed ? (
        <p className="mt-4 max-w-2xl rounded-box bg-paper-2 p-3 text-ink-2">
          Settings are changed by the doctor or an administrator — the fee and
          the licence numbers appear on every bill.
        </p>
      ) : null}

      {error ? (
        <Notice tone="bad" className="max-w-3xl">{error}</Notice>
      ) : null}
      {notice ? (
        <p
          role="status"
          data-testid="settings-saved"
          className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free"
        >
          {notice}
        </p>
      ) : null}

      <div className="mt-6 grid max-w-4xl grid-cols-2 gap-5">
        <Field label="Clinic name" value={form.name} onChange={(v) => set('name', v)} />
        <Field label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
        <Field
          label="Address"
          value={form.address}
          onChange={(v) => set('address', v)}
        />
        <Field
          label="Doctor registration number"
          value={form.doctorRegNo}
          onChange={(v) => set('doctorRegNo', v)}
          placeholder="APMC-44321"
        />
        <Field
          label="Drug licence number"
          hint="The pharmacy's, not the doctor's — it is what the H1 register is kept under"
          value={form.drugLicenceNo}
          onChange={(v) => set('drugLicenceNo', v)}
          placeholder="AP/KDP/20B/1234"
        />
        <Field
          label="GSTIN"
          hint="Leave empty if the clinic is not registered"
          value={form.gstin}
          onChange={(v) => set('gstin', v)}
          placeholder="37ABCDE1234F1Z5"
        />
      </div>

      <h2 className="mt-8 text-lg font-medium">Money</h2>
      <div className="mt-2 grid max-w-4xl grid-cols-2 gap-5">
        <Field
          label="Consultation fee (₹)"
          value={form.consultFee}
          onChange={(v) => set('consultFee', v.replace(/[^\d.]/g, ''))}
        />
        <Field
          label="Follow-up free for (days)"
          hint="Empty means every visit is charged"
          value={form.followUpFreeDays}
          onChange={(v) => set('followUpFreeDays', v.replace(/\D/g, ''))}
          placeholder="7"
        />
      </div>

      {/* Same control as the consent tick on the walk-in screen: a real 56px
          button rather than a 24px box with a label beside it. */}
      <button
        type="button"
        onClick={() => set('roundToRupee', !form.roundToRupee)}
        aria-label="Round bills down to the rupee"
        aria-pressed={form.roundToRupee}
        className="mt-4 flex h-14 w-full max-w-md items-center gap-3 rounded-box border border-rule bg-sheet px-4 text-left active:bg-paper-2"
      >
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-box border ${
            form.roundToRupee ? 'border-ink bg-ink text-paper' : 'border-rule'
          }`}
        >
          {form.roundToRupee ? '✓' : ''}
        </span>
        <span>
          Round bills down to the rupee
          <span className="block text-sm text-ink-2">
            The rounding is always in the patient&apos;s favour
          </span>
        </span>
      </button>

      <h2 className="mt-8 text-lg font-medium">Opening hours</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-2">
        One line per day. Two sittings is two windows:{' '}
        <span className="tabular">09:30-13:00, 17:00-20:30</span>. An empty line
        is a day off.
      </p>

      <div className="mt-3 max-w-2xl">
        {WEEKDAYS.map((day) => (
          <label key={day} className="flex items-center gap-4 border-b border-rule py-2">
            <span className="w-28 shrink-0 text-ink-2">{WEEKDAY_NAMES[day]}</span>
            <input
              aria-label={WEEKDAY_NAMES[day]}
              value={form.hours[day] ?? ''}
              onChange={(event) => setDay(day, event.target.value)}
              placeholder="closed"
              className="tabular h-14 flex-1 rounded-box border border-rule bg-sheet px-3 text-lg"
            />
          </label>
        ))}
      </div>
    </ThreePane>
  );
}
