/**
 * Suppliers, as the receiving and purchasing screens need them.
 */
import { db } from './index';

export interface SupplierRow {
  id: string;
  name: string;
  lead_time_days: number | null;
  return_window_days: number | null;
}

export async function activeSuppliers(): Promise<SupplierRow[]> {
  const { data, error } = await db()
    .from('suppliers')
    .select('id, name, lead_time_days, return_window_days')
    .eq('active', true)
    .order('name');

  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierRow[];
}
