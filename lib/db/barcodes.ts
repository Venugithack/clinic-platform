/**
 * Barcode lookup. INVENTORY.md §2.
 */
import { db } from './index';

export interface BarcodeMapping {
  code: string;
  drug_id: string;
  batch_id: string | null;
}

/** Null means "never seen this code" — the caller asks which drug it is. */
export async function lookupBarcode(code: string): Promise<BarcodeMapping | null> {
  const { data, error } = await db()
    .from('drug_barcodes')
    .select('code, drug_id, batch_id')
    .eq('code', code.trim())
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as BarcodeMapping) ?? null;
}
