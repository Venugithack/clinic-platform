'use client';

/**
 * Goods receipt. TABLET.md §7, INVENTORY.md §1 and §2.
 *
 * "The heaviest data-entry screen — scan first, keyboard second. Batch, expiry,
 *  MRP, cost per line."
 *
 * Four decisions, each of them about the same thing — this screen is used with
 * a box in one hand:
 *
 *   scan first          typing drug names off an invoice is the slowest and
 *                       most error-prone act in the pharmacy (INVENTORY.md §2)
 *   one numpad          the OS keyboard would cover the line being typed, so
 *                       numbers go through the app's own pad and the keyboard
 *                       appears for exactly one field: the batch number
 *   expiry as buttons   a month and a year, tapped, because the strip prints
 *                       "MAR 2027" and a date picker asks for a day nobody has
 *   packs, not units    the invoice says "10 strips"; the conversion to base
 *                       units happens once, inside app.receive_goods
 *
 * Cost is entered as the RATE ON THE INVOICE — per strip or per box — because
 * that is the number printed in front of the person typing. It is divided down
 * to a per-unit cost in lib/units, which is the one place packs are allowed to
 * become base units.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { Numpad } from '@/components/Numpad';
import { ScanField } from '@/components/ScanField';
import { DrugSearch } from '@/components/DrugSearch';
import { getDrug, type DrugRow } from '@/lib/db/drugs';
import { lookupBarcode } from '@/lib/db/barcodes';
import { activeSuppliers, type SupplierRow } from '@/lib/db/suppliers';
import { openOrders, orderLines, type OpenOrder, type OrderLine } from '@/lib/db/purchasing';
import {
  learnBarcode,
  receiveAgainstPo,
  receiveGoods,
  type GoodsReceiptInput,
} from '@/lib/transitions/inventory';
import { packCostToBaseUnitCost, paiseToRupees, unitsInPack } from '@/lib/units';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

type Field = 'qty' | 'free' | 'mrp' | 'cost';

interface DraftLine {
  drug: DrugRow;
  batchNo: string;
  /** 1–12 and a four-digit year: exactly what is printed on the strip. */
  month: number;
  year: number;
  qtyPacks: number;
  freePacks: number;
  mrpPaise: number;
  /** The rate on the invoice, for one strip. */
  ratePaise: number;
  unitsPerStrip: number;
  stripsPerBox: number;
}

/**
 * Suspense, because useSearchParams needs it: the `?po=` that arrives from the
 * orders screen is what turns this into "receive against that order".
 */
export default function ReceivingPage() {
  return (
    <Suspense fallback={null}>
      <Receiving />
    </Suspense>
  );
}

function Receiving() {
  const router = useRouter();
  const now = new Date();
  const poId = useSearchParams().get('po');

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [supplier, setSupplier] = useState<SupplierRow | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [awaitingInvoice, setAwaitingInvoice] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);

  const [drug, setDrug] = useState<DrugRow | null>(null);
  const [batchNo, setBatchNo] = useState('');
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear() + 1);
  const [field, setField] = useState<Field>('qty');
  const [values, setValues] = useState<Record<Field, string>>({
    qty: '',
    free: '',
    mrp: '',
    cost: '',
  });

  const [po, setPo] = useState<OpenOrder | null>(null);
  const [poLines, setPoLines] = useState<OrderLine[]>([]);
  const [searching, setSearching] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);

  useEffect(() => {
    void activeSuppliers()
      .then(setSuppliers)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  // Receiving against an order prefills everything the order already knows: the
  // supplier, the drugs, and how much of each is still outstanding. Typing that
  // twice is how a receipt ends up disagreeing with the order it answers.
  useEffect(() => {
    if (!poId) return;
    void (async () => {
      try {
        const found = (await openOrders()).find((row) => row.po_id === poId) ?? null;
        setPo(found);
        setPoLines(await orderLines(poId));
        if (found) {
          setSuppliers((current) => {
            const match = current.find((row) => row.id === found.supplier_id);
            if (match) setSupplier(match);
            return current;
          });
        }
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [poId]);

  const fromOrder = async (line: OrderLine) => {
    const found = await getDrug(line.drug_id);
    if (!found) return;
    const ups = line.default_units_per_strip ?? 1;
    setDrug(found);
    setField('qty');
    setValues({
      qty: ups > 0 ? String(Math.ceil(line.outstanding_qty_base / ups)) : '',
      free: '',
      mrp: '',
      // The expected cost from the order, in paise per strip — a starting point
      // the invoice can correct, not a number anybody has to accept.
      cost: line.expected_cost_per_base_unit
        ? String(Math.round(Number(line.expected_cost_per_base_unit) * ups * 100))
        : '',
    });
  };

  const resetLine = useCallback(() => {
    setDrug(null);
    setBatchNo('');
    setField('qty');
    setValues({ qty: '', free: '', mrp: '', cost: '' });
  }, []);

  const onCode = async (code: string) => {
    setError(null);
    try {
      const mapping = await lookupBarcode(code);
      if (!mapping) {
        // The first scan of an unknown code asks which drug it is, once, and
        // remembers. On this screen the box is already in the pharmacist's
        // hand, which makes it the cheapest place in the build to answer.
        setUnknownCode(code);
        setSearching(true);
        return;
      }
      const found = await getDrug(mapping.drug_id);
      if (found) {
        setDrug(found);
        setNotice(`${found.name} scanned`);
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const pick = async (picked: DrugRow) => {
    setSearching(false);
    setDrug(picked);
    setValues({ qty: '', free: '', mrp: '', cost: '' });

    if (unknownCode) {
      try {
        await learnBarcode(unknownCode, picked.id);
        setNotice(`${picked.name} learned — that code will be recognised next time.`);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setUnknownCode(null);
      }
    }
  };

  const pack = {
    unitsPerStrip: drug?.default_units_per_strip ?? 1,
    stripsPerBox: drug?.default_strips_per_box ?? 1,
  };

  const addLine = () => {
    if (!drug) return;
    setLines((current) => [
      ...current,
      {
        drug,
        batchNo: batchNo.trim(),
        month,
        year,
        qtyPacks: Number(values.qty || '0'),
        freePacks: Number(values.free || '0'),
        mrpPaise: Number(values.mrp || '0'),
        ratePaise: Number(values.cost || '0'),
        unitsPerStrip: pack.unitsPerStrip,
        stripsPerBox: pack.stripsPerBox,
      },
    ]);
    resetLine();
  };

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: GoodsReceiptInput = {
        supplierId: supplier?.id,
        invoiceNo: invoiceNo.trim() || undefined,
        invoiceDate: new Date().toISOString().slice(0, 10),
        awaitingInvoice,
        lines: lines.map((line) => ({
          drugId: line.drug.id,
          batchNo: line.batchNo,
          // The first of the month; app.receive_goods normalises it to the last
          // usable day, because a strip printed "MAR 2027" is good all March.
          expiry: `${line.year}-${String(line.month).padStart(2, '0')}-01`,
          unitsPerStrip: line.unitsPerStrip,
          stripsPerBox: line.stripsPerBox,
          mrp: line.mrpPaise / 100,
          costPerBaseUnit: packCostToBaseUnitCost(
            line.ratePaise,
            { unitsPerStrip: line.unitsPerStrip, stripsPerBox: line.stripsPerBox },
            'strip',
          ),
          qtyPacks: line.qtyPacks,
          packBasis: 'strip',
          freePacks: line.freePacks,
        })),
      };

      const receipt = poId
        ? await receiveAgainstPo(poId, input)
        : await receiveGoods(input);

      setPosted(true);
      setNotice(
        `Received. ${lines.length} batch${lines.length === 1 ? '' : 'es'} on the shelf, ₹${Number(
          receipt.total,
        ).toFixed(2)} at cost${
          receipt.awaiting_invoice ? ' — flagged for the invoice to be attached.' : '.'
        }`,
      );
      setLines([]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (searching) {
    return (
      <DrugSearch
        onClose={() => {
          setSearching(false);
          setUnknownCode(null);
        }}
        onPick={(picked) => void pick(picked)}
      />
    );
  }

  const lineValue = (line: DraftLine) =>
    (line.ratePaise * line.qtyPacks) / 100;
  const total = lines.reduce((sum, line) => sum + lineValue(line), 0);

  const fieldButton = (key: Field, label: string, money: boolean) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => setField(key)}
      className={`h-14 flex-1 rounded-box border px-3 text-left ${
        field === key ? 'border-ink bg-paper-2' : 'border-rule'
      }`}
    >
      <span className="block text-xs text-ink-2">{label}</span>
      <span className="tabular block text-lg">
        {money
          ? `₹${paiseToRupees(Number(values[key] || '0'))}`
          : values[key] || '0'}
      </span>
    </button>
  );

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Goods receipt</h2>

          {po ? (
            <p className="mt-2 rounded-box bg-paper-2 p-3 text-sm">
              Against {po.po_no ?? 'a draft order'} · {po.supplier_name}
              <span className="tabular block text-ink-2">
                {po.outstanding_qty_base} units still outstanding
              </span>
            </p>
          ) : null}

          <p className="eyebrow mt-3">Supplier</p>
          <div className="mt-1 flex flex-col gap-2" role="group" aria-label="Supplier">
            {suppliers.map((row) => (
              <button
                key={row.id}
                type="button"
                aria-pressed={supplier?.id === row.id}
                onClick={() => setSupplier(row)}
                className={`h-14 rounded-box border px-3 text-left ${
                  supplier?.id === row.id ? 'border-ink bg-ink text-paper' : 'border-rule'
                }`}
              >
                {row.name}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-sm text-ink-2" htmlFor="invoice">
            Invoice number
          </label>
          <input
            id="invoice"
            value={invoiceNo}
            onChange={(event) => setInvoiceNo(event.target.value)}
            className="blank mt-1 h-14 w-full px-3 text-lg"
          />

          {/* INVENTORY.md §3: stock on the shelf with the paperwork still in the
              van is a daily occurrence. It posts as a real receipt and joins a
              work queue, which is the alternative to a negative shelf. */}
          <button
            type="button"
            aria-pressed={awaitingInvoice}
            onClick={() => setAwaitingInvoice((current) => !current)}
            className={`mt-3 h-14 w-full rounded-box border px-3 text-left ${
              awaitingInvoice ? 'border-ink bg-ink text-paper' : 'border-rule'
            }`}
          >
            Invoice to follow
          </button>

          <p className="tabular mt-6 text-lg">₹{total.toFixed(2)}</p>
          <p className="text-sm text-ink-2">
            {lines.length} line{lines.length === 1 ? '' : 's'} at cost
          </p>
        </div>
      }
      rail={
        <>
          <ScanField label="Scan the box" onCode={(code) => void onCode(code)} />
          <RailButton onClick={() => setSearching(true)}>Search</RailButton>
          <RailButton
            tone="primary"
            disabled={busy || lines.length === 0}
            onClick={() => void post()}
          >
            {busy ? 'Posting…' : 'Post receipt'}
          </RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Pharmacy" title="Goods receipt" />

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}
      {posted && lines.length === 0 ? (
        <p className="mt-4 text-ink-2">Scan the next box to start another receipt.</p>
      ) : null}

      {lines.length > 0 ? (
        <ul className="mt-4 max-w-3xl">
          {lines.map((line, index) => (
            <li
              key={`${line.drug.id}-${line.batchNo}-${index}`}
              className="flex items-center gap-4 border-b border-rule py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{line.drug.name}</span>
                <span className="tabular block text-sm text-ink-2">
                  {line.batchNo} · exp {MONTHS[line.month - 1]} {line.year} ·{' '}
                  {line.qtyPacks} strip{line.qtyPacks === 1 ? '' : 's'}
                  {line.freePacks > 0 ? ` + ${line.freePacks} free` : ''} ·{' '}
                  {line.qtyPacks * line.unitsPerStrip +
                    line.freePacks * line.unitsPerStrip}{' '}
                  {line.drug.base_unit === 'tablet' ? 'tablets' : line.drug.base_unit}
                </span>
              </span>
              <span className="tabular shrink-0 text-lg">
                ₹{lineValue(line).toFixed(2)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${line.drug.name}`}
                onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                className="h-11 w-11 shrink-0 rounded-box border border-rule text-ink-2 active:bg-paper-2"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* What the order is still waiting for. Tapping a line starts it with the
          quantity and the expected rate already filled in — the invoice
          corrects both, and nothing here is binding. */}
      {po && !drug ? (
        <>
          <h2 className="mt-6 text-lg font-medium">Still outstanding on this order</h2>
          <ul className="mt-2 max-w-3xl">
            {poLines
              .filter((line) => line.outstanding_qty_base > 0)
              .map((line) => (
                <li key={line.po_line_id}>
                  <button
                    type="button"
                    onClick={() => void fromOrder(line)}
                    className="flex h-16 w-full items-center gap-4 border-b border-rule px-3 text-left active:bg-paper-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-lg">
                      {line.drug_name}{' '}
                      <span className="text-sm text-ink-2">{line.strength}</span>
                    </span>
                    <span className="tabular shrink-0 text-sm text-ink-2">
                      {line.received_qty_base} of {line.ordered_qty_base} in
                    </span>
                    <span className="tabular w-20 shrink-0 text-right text-stop">
                      {line.outstanding_qty_base}
                    </span>
                  </button>
                </li>
              ))}
            {poLines.every((line) => line.outstanding_qty_base === 0) ? (
              <li className="py-3 text-ink-2">
                Everything ordered has arrived.
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {!drug ? (
        <p className="mt-6 text-ink-2">
          Scan a box, or search for it. Everything else on this screen is about
          that one box: its batch, its expiry, its MRP and what it cost.
        </p>
      ) : (
        <div className="mt-6 max-w-3xl rounded-box border border-rule bg-sheet p-4">
          <p className="text-lg">
            {drug.name} <span className="text-sm text-ink-2">{drug.strength}</span>
          </p>
          <p className="text-sm text-ink-2">
            {pack.unitsPerStrip} to a strip, {pack.stripsPerBox} strips to a box —
            the drug&rsquo;s default. What arrived is what gets recorded.
          </p>

          <label className="mt-4 block text-sm text-ink-2" htmlFor="batch">
            Batch number
          </label>
          <input
            id="batch"
            value={batchNo}
            onChange={(event) => setBatchNo(event.target.value.toUpperCase())}
            className="blank tabular mt-1 h-14 w-64 px-3 text-lg"
          />

          <p className="eyebrow mt-4">Expiry, as printed on the strip</p>
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Expiry month">
            {MONTHS.map((label, index) => (
              <button
                key={label}
                type="button"
                aria-pressed={month === index + 1}
                onClick={() => setMonth(index + 1)}
                className={`h-11 w-16 rounded-box border text-sm ${
                  month === index + 1 ? 'border-ink bg-ink text-paper' : 'border-rule'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Last year is on this row on purpose. The typo this screen exists
              to catch is a mistyped expiry year, and a form that only offers
              valid years does not catch it — it makes the pharmacist pick a
              plausible one instead, and the wrong date is then indistinguishable
              from a right one. Let it be entered; app.receive_goods refuses it
              by name and date (INVENTORY.md §3). */}
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Expiry year">
            {[-1, 0, 1, 2, 3, 4].map((offset) => {
              const value = now.getFullYear() + offset;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={year === value}
                  onClick={() => setYear(value)}
                  className={`tabular h-11 w-20 rounded-box border text-sm ${
                    year === value ? 'border-ink bg-ink text-paper' : 'border-rule'
                  }`}
                >
                  {value}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex gap-3">
            {fieldButton('qty', 'Strips', false)}
            {fieldButton('free', 'Free strips', false)}
            {fieldButton('mrp', 'MRP per strip', true)}
            {fieldButton('cost', 'Rate per strip', true)}
          </div>

          <p className="mt-2 text-sm text-ink-2">
            {Number(values.qty || '0') * pack.unitsPerStrip +
              Number(values.free || '0') * pack.unitsPerStrip}{' '}
            base units in · ₹
            {packCostToBaseUnitCost(Number(values.cost || '0'), pack, 'strip').toFixed(4)}{' '}
            each
            {Number(values.free || '0') > 0
              ? ' before the free strips dilute it'
              : ''}
          </p>

          <div className="mt-4 w-64">
            <Numpad
              onDigit={(digit) =>
                setValues((current) => ({
                  ...current,
                  [field]: (current[field] + digit).slice(0, 7),
                }))
              }
              onBackspace={() =>
                setValues((current) => ({
                  ...current,
                  [field]: current[field].slice(0, -1),
                }))
              }
            />
          </div>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={
                batchNo.trim() === '' ||
                Number(values.qty || '0') + Number(values.free || '0') <= 0 ||
                values.cost === ''
              }
              onClick={addLine}
              className="h-14 flex-1 rounded-box border border-ink bg-ink px-4 font-medium text-paper disabled:opacity-40"
            >
              Add to receipt
            </button>
            <button
              type="button"
              onClick={resetLine}
              className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-sm text-ink-2">
            One strip is {unitsInPack(pack, 'strip')} and one box is{' '}
            {unitsInPack(pack, 'box')}. The ledger only ever stores the base units.
          </p>
        </div>
      )}
    </ThreePane>
  );
}
