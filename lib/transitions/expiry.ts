/**
 * Expiry transitions. INVENTORY.md §6.
 *
 * Note that none of these three decide anything. Whether a batch may go back to
 * the supplier is a date arithmetic problem the database owns, because the
 * answer changes every night and a screen that cached it would eventually send
 * a van out for stock nobody will accept.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export interface ReturnLine {
  batchId: string;
  /** Omitted means the whole batch, which is the ordinary case. */
  qtyBase?: number;
}

export interface SupplierReturn {
  id: string;
  supplier_id: string;
  total_at_cost: number;
  returned_at: string;
}

export async function returnToSupplier(
  lines: ReturnLine[],
  supplierId: string,
  note?: string,
): Promise<SupplierReturn> {
  const { data, error } = await appSchema().rpc('return_to_supplier', {
    p_lines: lines.map((line) => ({
      batch_id: line.batchId,
      qty_base: line.qtyBase ?? null,
    })),
    p_supplier_id: supplierId,
    p_note: note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as SupplierReturn;
}

/** Returns the value written off, at cost — the number worth reporting. */
export async function writeOffExpired(
  lines: ReturnLine[],
  reason?: string,
): Promise<number> {
  const { data, error } = await appSchema().rpc('write_off_expired', {
    p_lines: lines.map((line) => ({
      batch_id: line.batchId,
      qty_base: line.qtyBase ?? null,
    })),
    p_reason: reason ?? null,
  });

  if (error) throw toTransitionError(error);
  return Number(data);
}

export interface SupplierCredit {
  id: string;
  amount_expected: number;
  amount_settled: number;
  status: 'open' | 'settled' | 'written_off';
}

export async function settleCredit(
  creditId: string,
  grnId: string,
  amount: number,
): Promise<SupplierCredit> {
  const { data, error } = await appSchema().rpc('settle_credit', {
    p_credit_id: creditId,
    p_grn_id: grnId,
    p_amount: amount,
  });

  if (error) throw toTransitionError(error);
  return data as SupplierCredit;
}
