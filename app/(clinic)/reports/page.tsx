'use client';

/**
 * Registers and reports. PLAN.md §15.2, §8 M8.
 *
 * The gate for this milestone is "the H1 register exports for a date range in a
 * form an inspector accepts", and the two halves of that sentence pull in
 * different directions. An inspector wants paper or a spreadsheet, in a fixed
 * shape, for a range they name. A pharmacist wants to answer a recall question
 * in ten seconds with a box in their hand. So this screen does both: a range
 * and a table for the registers, and an unbounded batch lookup for the recall.
 *
 * The recall tab is deliberately NOT date-bounded. A recall covers a batch for
 * as long as it has been leaving the shelf, and a date range is exactly how
 * somebody misses the first three people who got it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import {
  batchTrace,
  expiryWriteoffs,
  h1Register,
  purchaseRegister,
  salesRegister,
} from '@/lib/db/registers';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/reports/csv';
import {
  CLINIC_TIMEZONE,
  addDays,
  clinicToday,
  endOfPreviousMonth,
  isoDay,
  startOfFinancialYear,
  startOfMonth,
  startOfPreviousMonth,
} from '@/lib/clinic/day';
import { clinicRow } from '@/lib/db/settings';
import './reports.css';

type Tab = 'h1' | 'sales' | 'purchases' | 'writeoffs' | 'recall';

interface Register {
  label: string;
  /** The filename an inspector receives, so it says what it is. */
  file: string;
  columns: Array<CsvColumn<Record<string, unknown>>>;
  load: (from: string, to: string) => Promise<Array<Record<string, unknown>>>;
}

const REGISTERS: Record<Exclude<Tab, 'recall'>, Register> = {
  h1: {
    label: 'Schedule H1 register',
    file: 'h1-register',
    columns: [
      { key: 'dispensed_on', label: 'Date' },
      { key: 'patient_name', label: 'Patient' },
      { key: 'patient_address', label: 'Address' },
      { key: 'drug_name', label: 'Drug' },
      { key: 'strength', label: 'Strength' },
      { key: 'qty_base', label: 'Quantity' },
      { key: 'batch_no', label: 'Batch' },
      { key: 'expiry', label: 'Expiry' },
      { key: 'prescriber_name', label: 'Prescriber' },
      { key: 'prescriber_reg_no', label: 'Reg. no' },
      { key: 'dispensed_by', label: 'Dispensed by' },
    ],
    load: h1Register,
  },
  sales: {
    label: 'Sales register',
    file: 'sales-register',
    columns: [
      { key: 'billed_on', label: 'Date' },
      { key: 'bill_no', label: 'Bill' },
      { key: 'patient_name', label: 'Patient' },
      { key: 'consult_fee', label: 'Consultation' },
      { key: 'medicines_total', label: 'Medicines' },
      { key: 'discount', label: 'Discount' },
      { key: 'round_off', label: 'Round off' },
      { key: 'total', label: 'Total' },
      { key: 'status', label: 'Status' },
      { key: 'method', label: 'Paid by' },
    ],
    load: salesRegister,
  },
  purchases: {
    label: 'Purchase register',
    file: 'purchase-register',
    columns: [
      { key: 'received_on', label: 'Received' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Invoice date' },
      { key: 'supplier_name', label: 'Supplier' },
      { key: 'supplier_gstin', label: 'GSTIN' },
      { key: 'po_no', label: 'Order' },
      { key: 'lines', label: 'Lines' },
      { key: 'qty_base', label: 'Units' },
      { key: 'total', label: 'Value' },
      { key: 'received_by', label: 'Received by' },
    ],
    load: purchaseRegister,
  },
  writeoffs: {
    label: 'Expiry write-offs',
    file: 'expiry-writeoffs',
    columns: [
      { key: 'written_off_on', label: 'Date' },
      { key: 'drug_name', label: 'Drug' },
      { key: 'batch_no', label: 'Batch' },
      { key: 'expiry', label: 'Expiry' },
      { key: 'qty_base_written_off', label: 'Destroyed' },
      { key: 'value_at_cost', label: 'Value at cost' },
      { key: 'reason', label: 'Reason' },
      { key: 'written_off_by', label: 'By' },
    ],
    load: expiryWriteoffs,
  },
};

const TRACE_COLUMNS: Array<CsvColumn<Record<string, unknown>>> = [
  { key: 'dispensed_at', label: 'Dispensed' },
  { key: 'drug_name', label: 'Drug' },
  { key: 'batch_no', label: 'Batch' },
  { key: 'patient_name', label: 'Patient' },
  { key: 'patient_phone', label: 'Phone' },
  { key: 'qty_base', label: 'Quantity' },
  { key: 'dispensed_by', label: 'Dispensed by' },
];

interface Range {
  label: string;
  from: string;
  to: string;
}

/**
 * The preset ranges, on the CLINIC's calendar rather than the browser's.
 *
 * These are compared against `dispensed_on` / `billed_on` / `received_on`, and
 * every one of those is `app.clinic_day(...)` — a local date. Building them out
 * of a bare `new Date()` asked in whatever timezone the device happens to be
 * set to, which is right on a clinic tablet and wrong on everything else. See
 * lib/clinic/day.ts.
 *
 * A fixed-length tuple, so `ranges[DEFAULT_RANGE_INDEX]` is a `Range` rather
 * than `Range | undefined`.
 */
function presets(timeZone: string): [Range, Range, Range, Range, Range] {
  const today = clinicToday(timeZone);

  return [
    { label: 'Today', from: isoDay(today), to: isoDay(today) },
    { label: 'Last 7 days', from: isoDay(addDays(today, -6)), to: isoDay(today) },
    { label: 'This month', from: isoDay(startOfMonth(today)), to: isoDay(today) },
    {
      label: 'Last month',
      from: isoDay(startOfPreviousMonth(today)),
      to: isoDay(endOfPreviousMonth(today)),
    },
    // The financial year, because that is the range the accountant asks for.
    { label: 'This financial year', from: isoDay(startOfFinancialYear(today)), to: isoDay(today) },
  ];
}

const DEFAULT_RANGE_INDEX = 2;

export default function ReportsPage() {
  const router = useRouter();
  /**
   * The clinic's timezone, once the clinic row has been read.
   *
   * Until then the ranges use the same default the column does — `clinic.timezone`
   * is `not null default 'Asia/Kolkata'` — so the first render is already right
   * for this clinic and merely provisional for a clinic that has changed it.
   */
  const [timeZone, setTimeZone] = useState(CLINIC_TIMEZONE);
  const [tab, setTab] = useState<Tab>('h1');

  const ranges = presets(timeZone);
  /**
   * The SELECTION is the label, not the range object. The dates behind a label
   * move — at midnight, and when the clinic timezone arrives — and a stored
   * object would hold yesterday's while the buttons showed today's.
   */
  const [rangeLabel, setRangeLabel] = useState(ranges[DEFAULT_RANGE_INDEX].label);
  const range =
    ranges.find((preset) => preset.label === rangeLabel) ?? ranges[DEFAULT_RANGE_INDEX];
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [batchNo, setBatchNo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const register = tab === 'recall' ? null : REGISTERS[tab];
  const columns = register?.columns ?? TRACE_COLUMNS;

  const load = useCallback(() => {
    // Cleared before the reads, never after them. A read landing is not
    // evidence that the last WRITE succeeded, and clearing on completion
    // erased a refusal somebody was in the middle of reading (M11e).
    setError(null);
    void (async () => {
      setBusy(true);
      try {
        if (tab === 'recall') {
          setRows(await batchTrace(batchNo));
        } else {
          setRows(await REGISTERS[tab].load(range.from, range.to));
        }
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
    })();
    // `range` is derived, so it is a new object on every render. These two
    // strings are what the read actually depends on; the object identity would
    // re-run this effect forever.
  }, [tab, range.from, range.to, batchNo]);

  useEffect(() => {
    if (tab !== 'recall') load();
  }, [tab, load]);

  /**
   * Ask the database which timezone it is grouping the registers by.
   *
   * A failure is deliberately silent: the fallback above is this column's own
   * default, and a clinic that has never changed it — which is this one — is
   * already being shown the right dates. An error banner over a correct range
   * would be noise on the screen an inspector is standing at.
   */
  useEffect(() => {
    void (async () => {
      try {
        const clinic = await clinicRow();
        if (clinic?.timezone) setTimeZone(clinic.timezone);
      } catch {
        /* keep CLINIC_TIMEZONE */
      }
    })();
  }, []);

  const missingAddresses =
    tab === 'h1' ? rows.filter((row) => row.address_missing).length : 0;

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Registers</h2>

          {tab === 'recall' ? (
            <p className="mt-2 text-sm text-ink-2">
              A recall is not a date range. This searches every dispense of that
              batch, however long ago.
            </p>
          ) : (
            <>
              <p className="mt-1 text-lg">{range.label}</p>
              <p className="tabular text-sm text-ink-2">
                {range.from} to {range.to}
              </p>

              <div className="mt-4 flex flex-col gap-2">
                {ranges.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={range.label === preset.label}
                    onClick={() => setRangeLabel(preset.label)}
                    className={`h-11 rounded-box border px-3 text-left text-sm ${
                      range.label === preset.label
                        ? 'border-ink bg-ink text-paper'
                        : 'border-rule'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="tabular mt-6 text-lg">{rows.length} rows</p>

          {missingAddresses > 0 ? (
            <Notice tone="bad">
              {missingAddresses} row{missingAddresses === 1 ? '' : 's'} with no
              patient address. The rule requires one — fix them before an
              inspection asks.
            </Notice>
          ) : null}

          <p className="mt-6 text-sm text-ink-2">
            The Schedule H1 register is retained three years (§15.2).
          </p>
        </div>
      }
      rail={
        <>
          <RailButton
            tone="primary"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(
                `${register?.file ?? 'batch-trace'}-${
                  tab === 'recall' ? batchNo.trim() : `${range.from}-to-${range.to}`
                }.csv`,
                toCsv(rows, columns),
              )
            }
          >
            Download CSV
          </RailButton>
          <RailButton disabled={rows.length === 0} onClick={() => window.print()}>
            Print
          </RailButton>
          <RailButton onClick={load}>Refresh</RailButton>
          <div className="flex-1" />
        </>
      }
    >
      <PageHeader
        eyebrow="Registers"
        title={register?.label ?? 'Recall — batch trace'}
      />

      {/* Only on paper: what was asked for, so it can be checked. */}
      <div className="report-print-head">
        <p style={{ fontWeight: 700 }}>{register?.label ?? 'Batch trace'}</p>
        <p>
          {tab === 'recall'
            ? `Batch ${batchNo}`
            : `${range.from} to ${range.to} · ${rows.length} rows`}
        </p>
      </div>

      <div className="no-print mt-4 flex flex-wrap gap-2">
        {(
          [
            ['h1', 'Schedule H1'],
            ['sales', 'Sales'],
            ['purchases', 'Purchases'],
            ['writeoffs', 'Write-offs'],
            ['recall', 'Recall'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setRows([]);
            }}
            className={`h-11 rounded-box border px-4 text-sm ${
              tab === key ? 'border-ink bg-ink text-paper' : 'border-rule'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}

      {tab === 'recall' ? (
        <div className="no-print mt-4 flex max-w-xl items-end gap-3">
          <label className="flex-1">
            <span className="mb-1 block text-sm text-ink-2">Batch number</span>
            <input
              value={batchNo}
              onChange={(event) => setBatchNo(event.target.value.toUpperCase())}
              className="blank tabular h-14 w-full px-3 text-lg"
            />
          </label>
          <button
            type="button"
            disabled={busy || batchNo.trim().length < 2}
            onClick={load}
            className="h-14 rounded-box border border-ink bg-ink px-6 font-medium text-paper disabled:opacity-40"
          >
            Trace
          </button>
        </div>
      ) : null}

      {rows.length === 0 && !busy ? (
        <p className="mt-6 text-ink-2">
          {tab === 'recall'
            ? 'Type a batch number to find everyone who was given it.'
            : 'Nothing in this range.'}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <table className="mt-4 w-full" data-testid="register">
          <thead>
            <tr className="border-b border-rule text-left text-sm text-ink-2">
              {columns.map((column) => (
                <th key={column.key} className="py-2 pr-3">
                  {column.label}
                </th>
              ))}
              {tab === 'h1' ? <th className="py-2 print:hidden" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={String(row.dispense_line_id ?? row.bill_id ?? row.grn_id ?? row.movement_id ?? index)}
                className={`border-b border-rule ${
                  row.address_missing ? 'bg-stop-wash' : ''
                }`}
              >
                {columns.map((column) => (
                  <td key={column.key} className="tabular py-2 pr-3 text-sm">
                    {row[column.key] === null || row[column.key] === undefined
                      ? '—'
                      : String(row[column.key])}
                  </td>
                ))}

                {/* The other half of the flag. M8 marked these rows red and
                    left the pharmacist nowhere to go; this is the way to the
                    record that is missing the address (M11d). It is not
                    exported — the CSV takes the named columns only. */}
                {tab === 'h1' ? (
                  <td className="py-2 print:hidden">
                    {row.address_missing && row.patient_id ? (
                      <button
                        type="button"
                        onClick={() => router.push(`/patient?patient=${String(row.patient_id)}` as Route)}
                        className="h-11 rounded-box border border-stop px-3 text-sm text-stop active:bg-paper-2"
                      >
                        Add address
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
    </ThreePane>
  );
}
