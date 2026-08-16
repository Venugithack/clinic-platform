/**
 * Inventory transitions. PLAN.md §5.3 rule 2 — thin wrappers, no logic.
 *
 * Note what is not converted here. Quantities go to the database in PACKS,
 * because that is what the invoice says and what the box in the pharmacist's
 * hands is; app.receive_goods converts them to base units once, at that
 * boundary. Doing the arithmetic here as well would put the conversion in two
 * places, and INVENTORY.md §1 is explicit that it belongs in one.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export interface GoodsReceiptLine {
  drugId: string;
  batchNo: string;
  /** As printed on the strip; normalised to month-end by the transition. */
  expiry: string;
  unitsPerStrip?: number;
  stripsPerBox?: number;
  mrp: number;
  mrpBasis?: 'unit' | 'strip' | 'box';
  costPerBaseUnit: number;
  qtyPacks: number;
  packBasis?: 'unit' | 'strip' | 'box';
  freePacks?: number;
}

export interface GoodsReceiptInput {
  lines: GoodsReceiptLine[];
  supplierId?: string;
  invoiceNo?: string;
  invoiceDate?: string;
  /** The quick-GRN at the counter: real stock now, paperwork owed. */
  awaitingInvoice?: boolean;
  note?: string;
}

export interface GoodsReceipt {
  id: string;
  total: number;
  awaiting_invoice: boolean;
}

export async function receiveGoods(input: GoodsReceiptInput): Promise<GoodsReceipt> {
  const { data, error } = await appSchema().rpc('receive_goods', {
    p_lines: input.lines.map((line) => ({
      drug_id: line.drugId,
      batch_no: line.batchNo,
      expiry: line.expiry,
      units_per_strip: line.unitsPerStrip ?? null,
      strips_per_box: line.stripsPerBox ?? null,
      mrp: line.mrp,
      mrp_basis: line.mrpBasis ?? null,
      cost_per_base_unit: line.costPerBaseUnit,
      qty_packs: line.qtyPacks,
      pack_basis: line.packBasis ?? 'strip',
      free_packs: line.freePacks ?? 0,
    })),
    p_supplier_id: input.supplierId ?? null,
    p_invoice_no: input.invoiceNo ?? null,
    p_invoice_date: input.invoiceDate ?? null,
    p_awaiting_invoice: input.awaitingInvoice ?? false,
    p_note: input.note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as GoodsReceipt;
}

/** "Which drug is this?", answered once and remembered. */
export async function learnBarcode(
  code: string,
  drugId: string,
  batchId?: string,
): Promise<void> {
  const { error } = await appSchema().rpc('learn_barcode', {
    p_code: code,
    p_drug_id: drugId,
    p_batch_id: batchId ?? null,
  });

  if (error) throw toTransitionError(error);
}
