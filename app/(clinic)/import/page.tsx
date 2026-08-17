'use client';

/**
 * Loading the drug master. PLAN.md §16 go-live step 1, BUILD.md §3.
 *
 * This screen exists because that step was, until now, "a developer runs psql".
 * Which makes the doctor's two weeks of typing into a document he emails
 * somebody and waits on — and it is the single longest pole in the schedule.
 *
 * The shape of the screen is the shape of the rule: **you always see what will
 * happen before it happens.** Paste or choose the file, the tablet reads it and
 * says "312 new, 18 that update something, 4 rows I cannot read, and here they
 * are with their row numbers". Only then does the Import button light up, and
 * it only lights up when the file is clean, because a file with a bad row in it
 * is refused whole by the database anyway (CL025).
 *
 * The alternative — import the good rows, list the bad ones — is worse than it
 * sounds. The missing rows look exactly like drugs the clinic does not stock,
 * and the way that surfaces is a prescription that cannot be dispensed with the
 * patient standing at the counter.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { currentSession } from '@/lib/auth';
import { downloadCsv, parseCsvObjects, toCsv } from '@/lib/reports/csv';
import {
  importDrugs,
  toImportRow,
  type ImportResult,
  type ImportRow,
} from '@/lib/transitions/import';

/**
 * The template, filled in with three real rows rather than empty headers.
 *
 * An empty template gets guessed at; a filled one gets copied. The three rows
 * are chosen to answer the three questions somebody always asks: what goes in
 * "schedule" (a word, not a number), what happens to a syrup (ml, not tablets),
 * and whether the supplier column wants a name (it does).
 */
const TEMPLATE = [
  {
    name: 'Dolo 650',
    generic: 'Paracetamol',
    salt_composition: 'Paracetamol',
    strength: '650mg',
    form: 'tablet',
    base_unit: 'tablet',
    units_per_strip: 15,
    strips_per_box: 10,
    schedule: 'OTC',
    hsn: '30049099',
    supplier: 'Kumar Distributors',
    reorder_level_base: 300,
    reorder_qty_base: 900,
  },
  {
    name: 'Alprax 0.25',
    generic: 'Alprazolam',
    salt_composition: 'Alprazolam',
    strength: '0.25mg',
    form: 'tablet',
    base_unit: 'tablet',
    units_per_strip: 15,
    strips_per_box: 10,
    schedule: 'H1',
    hsn: '30049099',
    supplier: 'Kumar Distributors',
    reorder_level_base: 60,
    reorder_qty_base: 150,
  },
  {
    name: 'Ascoril LS',
    generic: 'Levosalbutamol + Ambroxol',
    salt_composition: 'Levosalbutamol + Ambroxol + Guaiphenesin',
    strength: '100ml',
    form: 'syrup',
    base_unit: 'ml',
    units_per_strip: 100,
    strips_per_box: 1,
    schedule: 'H',
    hsn: '30049099',
    supplier: 'Reddy Pharma',
    reorder_level_base: 500,
    reorder_qty_base: 1000,
  },
];

const TEMPLATE_COLUMNS = (
  Object.keys(TEMPLATE[0] as Record<string, unknown>) as Array<
    keyof (typeof TEMPLATE)[number]
  >
).map((key) => ({ key, label: key }));

export default function ImportPage() {
  const router = useRouter();
  const session = typeof window === 'undefined' ? null : currentSession();
  // The database refuses anybody else (CL005). This just means the counter
  // sees a sentence instead of a screen it cannot use.
  const allowed = session?.role === 'doctor' || session?.role === 'admin';

  const [text, setText] = useState('');
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parsing is local and instant, so the row count appears as soon as the file
  // lands — before any round trip, and before any decision.
  const rows: ImportRow[] = useMemo(() => {
    if (text.trim() === '') return [];
    try {
      return parseCsvObjects(text).map(toImportRow);
    } catch {
      return [];
    }
  }, [text]);

  const onFile = async (file: File | null | undefined) => {
    if (!file) return;
    setChecked(null);
    setDone(null);
    setError(null);
    setText(await file.text());
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setChecked(await importDrugs(rows, true));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await importDrugs(rows, false);
      setDone(result);
      setChecked(null);
      setText('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clean = checked !== null && checked.errors.length === 0;

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Drug master</h2>
          <p className="tabular mt-1 text-lg">
            {rows.length === 0 ? 'no file yet' : `${rows.length} rows read`}
          </p>

          <p className="mt-6 text-sm text-muted">
            Three things are true of this import, and they are worth knowing
            before you start.
          </p>
          <ol className="mt-3 list-decimal space-y-3 pl-4 text-sm text-muted">
            <li>
              Nothing is written until you have seen what it will do. Check the
              file as often as you like.
            </li>
            <li>
              One row that cannot be read stops the whole file. A half-loaded
              master looks exactly like a shelf that is missing stock.
            </li>
            <li>
              Running the same file twice updates — it does not duplicate. Fix
              three rows and load it again.
            </li>
          </ol>

          <p className="mt-6 text-sm text-muted">
            <strong className="text-ink">Needed on every row:</strong> name,
            strength, salt composition, form. Everything else is optional and an
            empty cell keeps whatever is already there.
          </p>
          <p className="mt-3 text-sm text-muted">
            Suppliers are created from the supplier column, by name. Their
            WhatsApp number and return window are set on the supplier, not here.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || rows.length === 0 || !allowed}
            onClick={() => void check()}
          >
            Check the file
          </RailButton>

          <RailButton
            tone={clean ? 'primary' : 'default'}
            disabled={busy || !clean || !allowed}
            onClick={() => void doImport()}
          >
            {clean
              ? `Import ${(checked?.created ?? 0) + (checked?.updated ?? 0)} rows`
              : 'Import'}
          </RailButton>

          <RailButton
            onClick={() => downloadCsv('drug-master-template.csv', toCsv(TEMPLATE, TEMPLATE_COLUMNS))}
          >
            Template
          </RailButton>

          <RailButton
            disabled={busy || text === ''}
            onClick={() => {
              setText('');
              setChecked(null);
              setDone(null);
              setError(null);
            }}
          >
            Clear
          </RailButton>

          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Import the drug master</h1>

      {!allowed ? (
        <p className="mt-4 max-w-2xl rounded-lg bg-ink/5 p-3 text-muted">
          The drug master is loaded by the doctor or an administrator — it
          decides what can be prescribed and what a strip is worth.
        </p>
      ) : null}

      {error ? (
        <p className="mt-4 max-w-3xl rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}

      {done ? (
        <p
          role="status"
          data-testid="import-done"
          className="mt-4 max-w-3xl rounded-lg bg-ok/10 p-3 text-ok"
        >
          Loaded. {done.created} new, {done.updated} updated
          {done.suppliers_created > 0
            ? `, ${done.suppliers_created} supplier${done.suppliers_created === 1 ? '' : 's'} created`
            : ''}
          . The counter can dispense these now.
        </p>
      ) : null}

      <div className="mt-6 flex items-center gap-4">
        <label className="flex h-14 cursor-pointer items-center rounded-xl border border-line bg-white px-5 text-base font-medium active:opacity-80">
          Choose a CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </label>
        <span className="text-sm text-muted">or paste it below</span>
      </div>

      <textarea
        aria-label="Paste the CSV"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setChecked(null);
          setDone(null);
        }}
        spellCheck={false}
        placeholder="name,strength,salt_composition,form,schedule,supplier&#10;Dolo 650,650mg,Paracetamol,tablet,OTC,Kumar Distributors"
        className="tabular mt-4 h-56 w-full max-w-4xl rounded-xl border border-line bg-white p-3 font-mono text-sm"
      />

      {/* What the tablet read, before the database has been asked anything.
          Wrong columns show up here as blank cells, which is the fastest way
          to catch a header this build does not know. */}
      {rows.length > 0 ? (
        <>
          <h2 className="mt-6 text-lg font-medium">The first few rows, as read</h2>
          <div className="mt-2 max-w-4xl overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Strength</th>
                  <th className="p-2 font-medium">Salt</th>
                  <th className="p-2 font-medium">Form</th>
                  <th className="p-2 font-medium">Sch.</th>
                  <th className="p-2 font-medium">Pack</th>
                  <th className="p-2 font-medium">Supplier</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((row, index) => (
                  <tr key={index} className="border-b border-line last:border-0">
                    <td className="p-2">{row.name ?? '—'}</td>
                    <td className="p-2">{row.strength ?? '—'}</td>
                    <td className="p-2">{row.salt_composition ?? '—'}</td>
                    <td className="p-2">{row.form ?? '—'}</td>
                    <td className="p-2">{row.schedule ?? 'OTC'}</td>
                    <td className="tabular p-2">
                      {row.units_per_strip ?? 1} × {row.strips_per_box ?? 1}
                    </td>
                    <td className="p-2">{row.supplier ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 8 ? (
            <p className="mt-2 text-sm text-muted">
              and {rows.length - 8} more.
            </p>
          ) : null}
        </>
      ) : null}

      {checked ? (
        <div
          data-testid="import-check"
          className="mt-6 max-w-4xl rounded-xl border border-line bg-white p-4"
        >
          <h2 className="text-lg font-medium">
            {clean ? 'The file reads cleanly' : 'Some rows cannot be imported'}
          </h2>

          <p className="tabular mt-2 text-base">
            <span data-testid="check-created">{checked.created}</span> new ·{' '}
            <span data-testid="check-updated">{checked.updated}</span> updating
            something that exists ·{' '}
            <span data-testid="check-errors">{checked.errors.length}</span> to fix
          </p>

          {clean ? (
            <p className="mt-2 text-sm text-muted">
              Nothing has been written yet. Import writes it.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted">
                Nothing has been written. Fix these rows in the file and check it
                again — the whole file goes in together or not at all.
              </p>
              <ul className="mt-3">
                {checked.errors.map((row) => (
                  <li
                    key={row.row}
                    className="flex gap-3 border-b border-line py-2 last:border-0"
                  >
                    <span className="tabular w-20 shrink-0 text-muted">
                      row {row.row}
                    </span>
                    <span className="w-48 shrink-0 truncate">{row.name ?? '—'}</span>
                    <span className="flex-1 text-danger">{row.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </ThreePane>
  );
}
