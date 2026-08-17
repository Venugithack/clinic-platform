/**
 * Opening stock. PLAN.md §16 go-live step 1, INVENTORY.md §1 and §4.
 *
 * The shelf on go-live morning already holds four hundred batches nobody
 * entered. This is the file that puts them in — and it goes through
 * `app.receive_goods` in the database, so the ledger and the on-hand cache
 * agree by construction rather than by care (PLAN.md §5.3 rule 3).
 *
 * Nothing here converts anything. Packs, bases and rounding are the database's
 * job, at the one boundary that already does them; this module's whole
 * responsibility is reading what a person typed into the shape the transition
 * expects, and reading it *wrong* is exactly the failure the DECLARED bases
 * exist to prevent.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export type PackBasis = 'unit' | 'strip' | 'box';

export interface StockRow {
  name?: string;
  strength?: string;
  batch_no?: string;
  expiry?: string;
  qty?: number;
  qty_basis?: PackBasis;
  cost?: number;
  cost_basis?: PackBasis;
  mrp?: number;
  mrp_basis?: PackBasis;
  units_per_strip?: number;
  strips_per_box?: number;
  supplier?: string;
  invoice_no?: string;
  invoice_date?: string;
}

export interface StockImportError {
  row: number;
  name?: string;
  message: string;
}

export interface StockImportResult {
  dry_run: boolean;
  batches: number;
  /** Base units — tablets, ml, pieces. Never packs (INVENTORY.md §1). */
  units: number;
  /** At cost, and the number worth reading twice before committing. */
  value: number;
  errors: StockImportError[];
}

export async function importOpeningStock(
  rows: StockRow[],
  dryRun = true,
): Promise<StockImportResult> {
  const { data, error } = await appSchema().rpc('import_opening_stock', {
    p_rows: rows,
    p_dry_run: dryRun,
  });

  if (error) throw toTransitionError(error);
  return data as StockImportResult;
}

const SYNONYMS: Record<keyof StockRow, string[]> = {
  name: ['name', 'drug_name', 'brand', 'brand_name', 'product', 'product_name', 'item'],
  strength: ['strength', 'dosage', 'dose', 'mg'],
  batch_no: ['batch_no', 'batch', 'batch_number', 'lot', 'lot_no'],
  expiry: ['expiry', 'exp', 'expiry_date', 'exp_date', 'expires'],
  qty: ['qty', 'quantity', 'stock', 'opening_stock', 'on_hand', 'count'],
  qty_basis: ['qty_basis', 'qty_unit', 'quantity_unit', 'unit', 'uom', 'pack'],
  cost: ['cost', 'rate', 'purchase_rate', 'ptr', 'buy_rate', 'cost_price'],
  cost_basis: ['cost_basis', 'cost_unit', 'rate_basis', 'rate_unit'],
  mrp: ['mrp', 'sale_price', 'selling_price', 'retail_price'],
  mrp_basis: ['mrp_basis', 'mrp_unit'],
  units_per_strip: ['units_per_strip', 'tablets_per_strip', 'per_strip', 'strip_size'],
  strips_per_box: ['strips_per_box', 'strips_per_pack', 'per_box', 'box_size'],
  supplier: ['supplier', 'supplier_name', 'distributor', 'vendor'],
  invoice_no: ['invoice_no', 'invoice', 'bill_no', 'invoice_number'],
  invoice_date: ['invoice_date', 'bill_date', 'purchase_date'],
};

const NUMERIC = new Set<keyof StockRow>([
  'qty',
  'cost',
  'mrp',
  'units_per_strip',
  'strips_per_box',
]);

const BASIS = new Set<keyof StockRow>(['qty_basis', 'cost_basis', 'mrp_basis']);

/**
 * `strips`, `STRIP`, `Strips of 15`, `tab`, `pcs` → the three the database
 * knows.
 *
 * Anything it cannot place is passed through untouched so the database refuses
 * it by name. Quietly defaulting an unrecognised unit to `strip` would turn a
 * typo into a 15× error in the shelf, which is the single most expensive thing
 * this file could do.
 */
function basis(value: string): string {
  const text = value.trim().toLowerCase();
  if (/^box|^ctn|carton|pack of/.test(text)) return 'box';
  if (/^strip|^str\b|blister/.test(text)) return 'strip';
  if (/^unit|^tab|^cap|^pc|^piece|^nos|^ml|loose/.test(text)) return 'unit';
  return value.trim();
}

/**
 * A parsed CSV row becomes a stock row.
 *
 * Empty cells are dropped rather than sent as `""` — the database reads absence
 * as "use the drug's default", which is how a file that leaves the pack columns
 * blank still gets 15 tablets to a strip.
 */
export function toStockRow(cells: Record<string, string>): StockRow {
  const row: Record<string, string | number> = {};

  for (const [field, spellings] of Object.entries(SYNONYMS) as Array<
    [keyof StockRow, string[]]
  >) {
    const key = spellings.find((spelling) => (cells[spelling] ?? '') !== '');
    if (!key) continue;

    const value = (cells[key] as string).trim();
    if (value === '') continue;

    if (NUMERIC.has(field)) {
      // ₹1,234.50 → 1234.5. Indian digit grouping and a currency symbol are
      // both normal in a file exported from billing software.
      const number = Number(value.replace(/[₹,\s]/g, ''));
      if (Number.isFinite(number)) row[field] = number;
      continue;
    }

    row[field] = BASIS.has(field) ? basis(value) : value;
  }

  return row as StockRow;
}
