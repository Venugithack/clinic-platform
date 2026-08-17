/**
 * Loading the drug master. PLAN.md §16 go-live step 1.
 *
 * One call, two meanings, decided by `dryRun`:
 *
 *   true  — read the file, count what would happen, list every row that cannot
 *           be imported, write nothing;
 *   false — do it, or refuse the whole file (CL025).
 *
 * The screen always calls it with `true` first. That is not politeness: a drug
 * master is five hundred rows typed by a busy person over two weeks, and the
 * difference between "300 new, 12 rows to fix" and a wall of red is the
 * difference between a file he finishes and a file he abandons.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

/** One row of the file, after the CSV has been read and before the database has. */
export interface ImportRow {
  name?: string;
  generic?: string;
  salt_composition?: string;
  strength?: string;
  form?: string;
  base_unit?: string;
  units_per_strip?: number;
  strips_per_box?: number;
  schedule?: string;
  hsn?: string;
  supplier?: string;
  reorder_level_base?: number;
  reorder_qty_base?: number;
}

export interface ImportError {
  row: number;
  name?: string;
  message: string;
}

export interface ImportResult {
  dry_run: boolean;
  created: number;
  updated: number;
  suppliers_created: number;
  errors: ImportError[];
}

export async function importDrugs(
  rows: ImportRow[],
  dryRun = true,
): Promise<ImportResult> {
  const { data, error } = await appSchema().rpc('import_drugs', {
    p_rows: rows,
    p_dry_run: dryRun,
  });

  if (error) throw toTransitionError(error);
  return data as ImportResult;
}

/**
 * The columns this build understands, and the spellings a real spreadsheet
 * uses for them.
 *
 * Header matching is forgiving on purpose. The file arrives from a chemist's
 * billing software, or from the doctor's own typing, or from the distributor's
 * price list, and none of the three agree on whether it is "Salt", "Salt
 * Composition" or "Generic Name". Refusing a file over a header is the kind of
 * refusal that gets a build sent back.
 */
const SYNONYMS: Record<keyof ImportRow, string[]> = {
  name: ['name', 'drug_name', 'brand', 'brand_name', 'product', 'product_name', 'item'],
  generic: ['generic', 'generic_name'],
  salt_composition: ['salt_composition', 'salt', 'composition', 'molecule', 'content'],
  strength: ['strength', 'dosage', 'dose', 'mg'],
  form: ['form', 'dosage_form'],
  base_unit: ['base_unit', 'unit', 'uom'],
  units_per_strip: ['units_per_strip', 'tablets_per_strip', 'per_strip', 'strip_size'],
  strips_per_box: ['strips_per_box', 'strips_per_pack', 'per_box', 'box_size'],
  schedule: ['schedule', 'drug_schedule'],
  hsn: ['hsn', 'hsn_code', 'hsn_sac'],
  supplier: ['supplier', 'supplier_name', 'distributor', 'vendor'],
  reorder_level_base: ['reorder_level_base', 'reorder_level', 'min_stock', 'minimum'],
  reorder_qty_base: ['reorder_qty_base', 'reorder_qty', 'order_qty'],
};

// Deliberately NOT synonyms, and each omission cost somebody a bad import
// somewhere: "pack size" is `10 TAB`, not a strength; "category" in a price
// list is a therapeutic class, not a drug schedule; and "company" is the
// manufacturer, which is not who the clinic buys from. A column this build
// cannot read is ignored, which is recoverable. A column it reads wrongly is
// silent damage in a master nobody re-checks.

const NUMERIC = new Set<keyof ImportRow>([
  'units_per_strip',
  'strips_per_box',
  'reorder_level_base',
  'reorder_qty_base',
]);

/**
 * A parsed CSV row becomes an import row.
 *
 * An empty cell is dropped rather than sent as `""`, because the database reads
 * absence as "leave what is already there" and an empty string as a value. That
 * distinction is what lets somebody re-import a trimmed-down file without
 * wiping the reorder levels a screen set last week.
 */
export function toImportRow(cells: Record<string, string>): ImportRow {
  const row: Record<string, string | number> = {};

  for (const [field, spellings] of Object.entries(SYNONYMS) as Array<
    [keyof ImportRow, string[]]
  >) {
    const key = spellings.find((spelling) => (cells[spelling] ?? '') !== '');
    if (!key) continue;

    const value = (cells[key] as string).trim();
    if (value === '') continue;

    if (NUMERIC.has(field)) {
      const digits = Number(value.replace(/[^\d.-]/g, ''));
      if (Number.isFinite(digits)) row[field] = Math.round(digits);
      continue;
    }

    row[field] = value;
  }

  return row as ImportRow;
}
