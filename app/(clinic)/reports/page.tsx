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
import { RailButton, ThreePane } from '@/components/ThreePane';
import {
  batchTrace,
  expiryWriteoffs,
  h1Register,
  purchaseRegister,
  salesRegister,
} from '@/lib/db/registers';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/reports/csv';
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

/** Local YYYY-MM-DD. The registers group by clinic day, not by UTC. */
function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function presets() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const yearStart = new Date(today.getFullYear(), 3, 1);
  if (yearStart > today) yearStart.setFullYear(yearStart.getFullYear() - 1);

  return [
    { label: 'Today', from: isoDay(today), to: isoDay(today) },
    { label: 'Last 7 days', from: isoDay(weekStart), to: isoDay(today) },
    { label: 'This month', from: isoDay(monthStart), to: isoDay(today) },
    { label: 'Last month', from: isoDay(lastMonthStart), to: isoDay(lastMonthEnd) },
    // The financial year, because that is the range the accountant asks for.
    { label: 'This financial year', from: isoDay(yearStart), to: isoDay(today) },
  ];
}

export default function ReportsPage() {
  const router = useRouter();
  const ranges = presets();
  const [tab, setTab] = useState<Tab>('h1');
  const [range, setRange] = useState(ranges[2] as { label: string; from: string; to: string });
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [batchNo, setBatchNo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const register = tab === 'recall' ? null : REGISTERS[tab];
  const columns = register?.columns ?? TRACE_COLUMNS;

  const load = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        if (tab === 'recall') {
          setRows(await batchTrace(batchNo));
        } else {
          setRows(await REGISTERS[tab].load(range.from, range.to));
        }
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [tab, range, batchNo]);

  useEffect(() => {
    if (tab !== 'recall') load();
  }, [tab, range, load]);

  const missingAddresses =
    tab === 'h1' ? rows.filter((row) => row.address_missing).length : 0;

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Registers</h2>

          {tab === 'recall' ? (
            <p className="mt-2 text-sm text-muted">
              A recall is not a date range. This searches every dispense of that
              batch, however long ago.
            </p>
          ) : (
            <>
              <p className="mt-1 text-lg">{range.label}</p>
              <p className="tabular text-sm text-muted">
                {range.from} to {range.to}
              </p>

              <div className="mt-4 flex flex-col gap-2">
                {ranges.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={range.label === preset.label}
                    onClick={() => setRange(preset)}
                    className={`h-11 rounded-lg border px-3 text-left text-sm ${
                      range.label === preset.label
                        ? 'border-ink bg-ink text-white'
                        : 'border-line'
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
            <p className="mt-3 rounded-lg bg-danger/15 p-3 text-sm text-danger">
              {missingAddresses} row{missingAddresses === 1 ? '' : 's'} with no
              patient address. The rule requires one — fix them before an
              inspection asks.
            </p>
          ) : null}

          <p className="mt-6 text-sm text-muted">
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
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">{register?.label ?? 'Recall — batch trace'}</h1>

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
            className={`h-11 rounded-lg border px-4 text-sm ${
              tab === key ? 'border-ink bg-ink text-white' : 'border-line'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}

      {tab === 'recall' ? (
        <div className="no-print mt-4 flex max-w-xl items-end gap-3">
          <label className="flex-1">
            <span className="mb-1 block text-sm text-muted">Batch number</span>
            <input
              value={batchNo}
              onChange={(event) => setBatchNo(event.target.value.toUpperCase())}
              className="tabular h-14 w-full rounded-xl border border-line px-3 text-lg"
            />
          </label>
          <button
            type="button"
            disabled={busy || batchNo.trim().length < 2}
            onClick={load}
            className="h-14 rounded-xl border border-ink bg-ink px-6 font-medium text-white disabled:opacity-40"
          >
            Trace
          </button>
        </div>
      ) : null}

      {rows.length === 0 && !busy ? (
        <p className="mt-6 text-muted">
          {tab === 'recall'
            ? 'Type a batch number to find everyone who was given it.'
            : 'Nothing in this range.'}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <table className="mt-4 w-full" data-testid="register">
          <thead>
            <tr className="border-b border-line text-left text-sm text-muted">
              {columns.map((column) => (
                <th key={column.key} className="py-2 pr-3">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={String(row.dispense_line_id ?? row.bill_id ?? row.grn_id ?? row.movement_id ?? index)}
                className={`border-b border-line ${
                  row.address_missing ? 'bg-danger/5' : ''
                }`}
              >
                {columns.map((column) => (
                  <td key={column.key} className="tabular py-2 pr-3 text-sm">
                    {row[column.key] === null || row[column.key] === undefined
                      ? '—'
                      : String(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </ThreePane>
  );
}
