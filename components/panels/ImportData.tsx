'use client';

/**
 * Loading the clinic's starting data. PLAN.md §16 go-live step 1, BUILD.md §3.
 *
 *   "Load drug master, suppliers, opening stock (clinic closed, one day)."
 *
 * Two files, in that order, on one screen — because the order is not a
 * preference. Opening stock names drugs, so a stock file loaded first is a
 * file where every row is an error.
 *
 * Both halves obey the same rule, and it is the shape of the whole screen:
 * **you always see what will happen before it happens.** Paste or choose the
 * file, the tablet reads it and says what it found, and only then does the
 * commit button light up — and only when the file is clean, because a file
 * with a bad row in it is refused whole by the database anyway.
 *
 * The alternative — import the good rows, list the bad ones — is worse than it
 * sounds. A half-loaded drug master looks exactly like a drug the clinic does
 * not stock, and the way that surfaces is a prescription that cannot be
 * dispensed with the patient standing there. A half-loaded shelf is worse
 * still: it is wrong in a way that only a stock-take finds.
 */
import { useMemo, useState } from 'react';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import { downloadCsv, parseCsvObjects, toCsv } from '@/lib/reports/csv';
import {
  importDrugs,
  toImportRow,
  type ImportResult,
  type ImportRow,
} from '@/lib/transitions/import';
import {
  importOpeningStock,
  toStockRow,
  type StockImportResult,
  type StockRow,
} from '@/lib/transitions/opening-stock';
import type { PanelProps } from './types';

type Tab = 'drugs' | 'stock';

/**
 * The templates, filled in with real rows rather than empty headers.
 *
 * An empty template gets guessed at; a filled one gets copied. The rows are
 * chosen to answer the questions somebody always asks: what goes in "schedule"
 * (a word, not a number), what happens to a syrup (ml, not tablets), and —
 * the expensive one — that a quantity in boxes and a rate per strip can live
 * on the same line as long as each says so.
 */
const DRUG_TEMPLATE = [
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

const STOCK_TEMPLATE = [
  {
    name: 'Dolo 650',
    strength: '650mg',
    batch_no: 'DL2411A',
    expiry: '03/2027',
    qty: 20,
    qty_basis: 'strip',
    cost: 18.0,
    cost_basis: 'strip',
    mrp: 34.5,
    supplier: 'Kumar Distributors',
    invoice_no: '',
  },
  {
    name: 'Dolo 650',
    strength: '650mg',
    batch_no: 'DL2503B',
    expiry: '12/2026',
    qty: 2,
    qty_basis: 'box',
    cost: 170.0,
    cost_basis: 'box',
    mrp: 24.0,
    supplier: 'Kumar Distributors',
    invoice_no: '',
  },
  {
    name: 'Ascoril LS',
    strength: '100ml',
    batch_no: 'AS2502C',
    expiry: '09/2027',
    qty: 600,
    qty_basis: 'unit',
    cost: 0.55,
    cost_basis: 'unit',
    mrp: 118.0,
    supplier: 'Reddy Pharma',
    invoice_no: '',
  },
];

/** Header row from the first template row, so the two never drift apart. */
function columnsOf<T extends Record<string, unknown>>(rows: T[]) {
  return (Object.keys(rows[0] as T) as Array<keyof T & string>).map((key) => ({
    key,
    label: key,
  }));
}

const rupees = (value: number) =>
  `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export function ImportDataPanel({ chrome }: PanelProps) {
  const session = typeof window === 'undefined' ? null : currentSession();
  // The database refuses anybody else (CL005). This just means the counter
  // sees a sentence instead of a screen it cannot use.
  const allowed = session?.role === 'doctor' || session?.role === 'admin';

  const [tab, setTab] = useState<Tab>('drugs');
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [stockChecked, setStockChecked] = useState<StockImportResult | null>(null);
  const [stockDone, setStockDone] = useState<StockImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setChecked(null);
    setDone(null);
    setStockChecked(null);
    setStockDone(null);
    setError(null);
  };

  // Parsing is local and instant, so the row count appears as soon as the file
  // lands — before any round trip, and before any decision.
  const parsed: Array<Record<string, string>> = useMemo(() => {
    if (text.trim() === '') return [];
    try {
      return parseCsvObjects(text);
    } catch {
      return [];
    }
  }, [text]);

  const rows: ImportRow[] = useMemo(() => parsed.map(toImportRow), [parsed]);
  const stockRows: StockRow[] = useMemo(() => parsed.map(toStockRow), [parsed]);
  const count = tab === 'drugs' ? rows.length : stockRows.length;

  const onFile = async (file: File | null | undefined) => {
    if (!file) return;
    reset();
    setText(await file.text());
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setStockDone(null);
    try {
      if (tab === 'drugs') setChecked(await importDrugs(rows, true));
      else setStockChecked(await importOpeningStock(stockRows, true));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === 'drugs') {
        setDone(await importDrugs(rows, false));
        setChecked(null);
      } else {
        setStockDone(await importOpeningStock(stockRows, false));
        setStockChecked(null);
      }
      setText('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const drugsClean = checked !== null && checked.errors.length === 0;
  const stockClean = stockChecked !== null && stockChecked.errors.length === 0;
  const clean = tab === 'drugs' ? drugsClean : stockClean;
  const errors = tab === 'drugs' ? (checked?.errors ?? []) : (stockChecked?.errors ?? []);
  const showCheck = tab === 'drugs' ? checked !== null : stockChecked !== null;

  return (
    <ThreePane tabs={chrome}
      context={
        <div>
          <h2 className="eyebrow">
            {tab === 'drugs' ? 'Drug master' : 'Opening stock'}
          </h2>
          <p className="tabular mt-1 text-lg">
            {count === 0 ? 'no file yet' : `${count} rows read`}
          </p>

          <p className="mt-6 text-sm text-ink-2">
            Three things are true of both these files, and they are worth
            knowing before you start.
          </p>
          <ol className="mt-3 list-decimal space-y-3 pl-4 text-sm text-ink-2">
            <li>
              Nothing is written until you have seen what it will do. Check the
              file as often as you like.
            </li>
            <li>
              One row that cannot be read stops the whole file. A half-loaded
              master looks exactly like a shelf that is missing stock.
            </li>
            <li>
              {tab === 'drugs'
                ? 'Running the same file twice updates — it does not duplicate. Fix three rows and load it again.'
                : 'Opening stock loads once. A batch already on the shelf is refused by name, because otherwise the shelf silently doubles.'}
            </li>
          </ol>

          {tab === 'drugs' ? (
            <>
              <p className="mt-6 text-sm text-ink-2">
                <strong className="text-ink">Needed on every row:</strong> name,
                strength, salt composition, form. Everything else is optional
                and an empty cell keeps whatever is already there.
              </p>
              <p className="mt-3 text-sm text-ink-2">
                Suppliers are created from the supplier column, by name. Their
                WhatsApp number and return window are set on the supplier, not
                here.
              </p>
            </>
          ) : (
            <>
              <p className="mt-6 text-sm text-ink-2">
                <strong className="text-ink">Load the drug master first.</strong>{' '}
                Every stock row names a drug, and one the master has never heard
                of is refused rather than invented.
              </p>
              <p className="mt-3 text-sm text-ink-2">
                <strong className="text-ink">Say what the numbers mean.</strong>{' '}
                A quantity and a rate can be in different units on the same row —
                boxes counted, rate per strip. Both default to strips, and
                getting one wrong is a 10× or 150× error.
              </p>
            </>
          )}
        </div>
      }
      primary={{
        label: 'Check the file',
        onClick: () => void check(),
        disabled: busy || count === 0 || !allowed,
      }}
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={busy || count === 0 || !allowed}
            onClick={() => void check()}
          >
            Check the file
          </RailButton>

          <RailButton
            tone={clean ? 'primary' : 'default'}
            disabled={busy || !clean || !allowed}
            onClick={() => void commit()}
          >
            {tab === 'drugs'
              ? drugsClean
                ? `Import ${(checked?.created ?? 0) + (checked?.updated ?? 0)} rows`
                : 'Import'
              : stockClean
                ? `Load ${stockChecked?.batches ?? 0} batches`
                : 'Load the shelf'}
          </RailButton>

          <RailButton
            onClick={() =>
              tab === 'drugs'
                ? downloadCsv(
                    'drug-master-template.csv',
                    toCsv(DRUG_TEMPLATE, columnsOf(DRUG_TEMPLATE)),
                  )
                : downloadCsv(
                    'opening-stock-template.csv',
                    toCsv(STOCK_TEMPLATE, columnsOf(STOCK_TEMPLATE)),
                  )
            }
          >
            Template
          </RailButton>

          <RailButton
            disabled={busy || text === ''}
            onClick={() => {
              setText('');
              reset();
            }}
          >
            Clear
          </RailButton>

          <div className="flex-1" />
        </>
      }
    >
      <PageHeader
        eyebrow="Administration"
        title={tab === 'drugs' ? 'Import the drug master' : 'Load the opening stock'}
      />

      {/* The order is not a preference: stock names drugs. */}
      <div className="mt-4 flex gap-3">
        {(
          [
            ['drugs', '1 · Drug master'],
            ['stock', '2 · Opening stock'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
              reset();
            }}
            className={`h-14 rounded-box border px-5 text-base font-medium active:bg-paper-2 ${
              tab === value ? 'border-ink bg-ink text-paper' : 'border-rule bg-sheet'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {!allowed ? (
        <p className="mt-4 max-w-2xl rounded-box bg-paper-2 p-3 text-ink-2">
          {tab === 'drugs'
            ? 'The drug master is loaded by the doctor or an administrator — it decides what can be prescribed and what a strip is worth.'
            : 'Opening stock is loaded by the doctor or an administrator — it is the whole value of the shelf.'}
        </p>
      ) : null}

      {error ? (
        <Notice tone="bad" className="max-w-3xl">{error}</Notice>
      ) : null}

      {done ? (
        <p
          role="status"
          data-testid="import-done"
          className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free"
        >
          Loaded. {done.created} new, {done.updated} updated
          {done.suppliers_created > 0
            ? `, ${done.suppliers_created} supplier${done.suppliers_created === 1 ? '' : 's'} created`
            : ''}
          . The counter can dispense these now.
        </p>
      ) : null}

      {stockDone ? (
        <p
          role="status"
          data-testid="stock-done"
          className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free"
        >
          The shelf is loaded. {stockDone.batches} batches, {stockDone.units} units,{' '}
          {rupees(stockDone.value)} at cost. Every one of them went through goods
          receipt, so the ledger says the same.
        </p>
      ) : null}

      <div className="mt-6 flex items-center gap-4">
        <label className="flex h-14 cursor-pointer items-center rounded-box border border-rule bg-sheet px-5 text-base font-medium active:opacity-80">
          Choose a CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </label>
        <span className="text-sm text-ink-2">or paste it below</span>
      </div>

      <textarea
        aria-label="Paste the CSV"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setChecked(null);
          setStockChecked(null);
          setDone(null);
          setStockDone(null);
        }}
        spellCheck={false}
        placeholder={
          tab === 'drugs'
            ? 'name,strength,salt_composition,form,schedule,supplier\nDolo 650,650mg,Paracetamol,tablet,OTC,Kumar Distributors'
            : 'name,strength,batch_no,expiry,qty,qty_basis,cost,cost_basis,mrp\nDolo 650,650mg,DL2411A,03/2027,20,strip,18.00,strip,34.50'
        }
        className="blank tabular mt-4 h-56 w-full max-w-4xl p-3 font-mono text-sm"
      />

      {/* What the tablet read, before the database has been asked anything.
          Wrong columns show up here as blank cells, which is the fastest way
          to catch a header this build does not know. */}
      {count > 0 ? (
        <>
          <h2 className="mt-6 text-lg font-medium">The first few rows, as read</h2>
          <div className="mt-2 min-w-0 max-w-4xl overflow-x-auto rounded-box border border-rule bg-sheet">
            {tab === 'drugs' ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-ink-2">
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
                    <tr key={index} className="border-b border-rule last:border-0">
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
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-ink-2">
                    <th className="p-2 font-medium">Name</th>
                    <th className="p-2 font-medium">Batch</th>
                    <th className="p-2 font-medium">Expiry</th>
                    <th className="p-2 font-medium">Quantity</th>
                    <th className="p-2 font-medium">Cost</th>
                    <th className="p-2 font-medium">MRP</th>
                    <th className="p-2 font-medium">Supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.slice(0, 8).map((row, index) => (
                    <tr key={index} className="border-b border-rule last:border-0">
                      <td className="p-2">{row.name ?? '—'}</td>
                      <td className="p-2">{row.batch_no ?? '—'}</td>
                      <td className="p-2">{row.expiry ?? '—'}</td>
                      {/* The unit is shown beside the number, every row,
                          because it is the thing that goes wrong. */}
                      <td className="tabular p-2">
                        {row.qty ?? '—'} {row.qty_basis ?? 'strip'}
                        {row.qty === 1 ? '' : 's'}
                      </td>
                      <td className="tabular p-2">
                        {row.cost ?? '—'} / {row.cost_basis ?? 'strip'}
                      </td>
                      <td className="tabular p-2">{row.mrp ?? '—'}</td>
                      <td className="p-2">{row.supplier ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {count > 8 ? (
            <p className="mt-2 text-sm text-ink-2">and {count - 8} more.</p>
          ) : null}
        </>
      ) : null}

      {showCheck ? (
        <div
          data-testid={tab === 'drugs' ? 'import-check' : 'stock-check'}
          className="mt-6 max-w-4xl rounded-box border border-rule bg-sheet p-4"
        >
          <h2 className="text-lg font-medium">
            {clean ? 'The file reads cleanly' : 'Some rows cannot be imported'}
          </h2>

          {tab === 'drugs' ? (
            <p className="tabular mt-2 text-base">
              <span data-testid="check-created">{checked?.created ?? 0}</span> new ·{' '}
              <span data-testid="check-updated">{checked?.updated ?? 0}</span>{' '}
              updating something that exists ·{' '}
              <span data-testid="check-errors">{checked?.errors.length ?? 0}</span> to
              fix
            </p>
          ) : (
            <>
              <p className="tabular mt-2 text-base">
                <span data-testid="stock-batches">{stockChecked?.batches ?? 0}</span>{' '}
                batches · <span data-testid="stock-units">{stockChecked?.units ?? 0}</span>{' '}
                units ·{' '}
                <span data-testid="stock-errors">
                  {stockChecked?.errors.length ?? 0}
                </span>{' '}
                to fix
              </p>
              {/* The number worth reading twice. A doctor who knows his shelf
                  is worth about four lakh spots a misdeclared cost basis at
                  forty lakh instantly — faster than any per-row check. */}
              <p className="tabular mt-3 text-2xl font-medium" data-testid="stock-value">
                {rupees(stockChecked?.value ?? 0)}
              </p>
              <p className="text-sm text-ink-2">
                the whole shelf, at cost. If that is not roughly the number you
                expect, a quantity or a rate is in the wrong unit.
              </p>
            </>
          )}

          {clean ? (
            <p className="mt-2 text-sm text-ink-2">
              Nothing has been written yet.{' '}
              {tab === 'drugs' ? 'Import writes it.' : 'Loading writes it.'}
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-2">
                Nothing has been written. Fix these rows in the file and check it
                again — the whole file goes in together or not at all.
              </p>
              <ul className="mt-3">
                {errors.map((row) => (
                  <li
                    key={row.row}
                    className="flex gap-3 border-b border-rule py-2 last:border-0"
                  >
                    <span className="tabular w-20 shrink-0 text-ink-2">
                      row {row.row}
                    </span>
                    <span className="w-48 shrink-0 truncate">{row.name ?? '—'}</span>
                    <span className="flex-1 text-stop">{row.message}</span>
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
