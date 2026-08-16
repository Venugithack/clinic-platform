/**
 * Stock-take transitions. INVENTORY.md §5.
 *
 * `countBatch` returns nothing, deliberately. The counter must learn nothing
 * about whether the number they entered agreed with the system — that is what
 * blind means, and a wrapper that helpfully returned the variance would undo
 * the column grants that enforce it.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export interface StockTake {
  id: string;
  status: 'counting' | 'review' | 'approved' | 'cancelled';
  scope_note: string | null;
  recount_threshold_value: number;
  started_at: string;
}

export async function startStockTake(
  scopeNote?: string,
  recountThresholdValue?: number,
): Promise<StockTake> {
  const { data, error } = await appSchema().rpc('start_stock_take', {
    p_scope_note: scopeNote ?? null,
    p_recount_threshold_value: recountThresholdValue ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as StockTake;
}

export async function countBatch(
  takeId: string,
  batchId: string,
  countedQtyBase: number,
): Promise<void> {
  const { error } = await appSchema().rpc('count_batch', {
    p_take_id: takeId,
    p_batch_id: batchId,
    p_counted_qty_base: countedQtyBase,
  });

  if (error) throw toTransitionError(error);
}

export async function submitStockTake(takeId: string): Promise<StockTake> {
  const { data, error } = await appSchema().rpc('submit_stock_take', {
    p_take_id: takeId,
  });

  if (error) throw toTransitionError(error);
  return data as StockTake;
}

/** Returns how many batches were adjusted. The doctor approves; only then. */
export async function approveStockTake(takeId: string): Promise<number> {
  const { data, error } = await appSchema().rpc('approve_stock_take', {
    p_take_id: takeId,
  });

  if (error) throw toTransitionError(error);
  return data as number;
}
