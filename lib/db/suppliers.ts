/**
 * Supplier reads for receiving, purchasing and the admin supplier screen.
 */
import { db } from './index';

export interface SupplierRow {
  id: string;
  name: string;
  lead_time_days: number | null;
  return_window_days: number | null;
}

export interface SupplierAdminRow extends SupplierRow {
  contact_name: string | null;
  whatsapp_number: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  payment_terms: string | null;
  active: boolean;
}

export interface SupplierDrugRow {
  drug_id: string;
  supplier_id: string;
  supplier_drug_name: string | null;
  supplier_sku: string | null;
  is_preferred: boolean;
  active: boolean;
}

export interface SupplierMedicineRow {
  id: string;
  name: string;
  strength: string;
  form: string;
  default_supplier_id: string | null;
  reorder_level_base: number | null;
  reorder_qty_base: number | null;
  active: boolean;
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

export async function allSuppliers(): Promise<SupplierAdminRow[]> {
  const { data, error } = await db()
    .from('suppliers')
    .select(
      'id, name, contact_name, whatsapp_number, phone, email, gstin, lead_time_days, return_window_days, payment_terms, active',
    )
    .order('active', { ascending: false })
    .order('name');

  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierAdminRow[];
}

export async function allSupplierDrugLinks(): Promise<SupplierDrugRow[]> {
  const { data, error } = await db()
    .from('drug_suppliers')
    .select('drug_id, supplier_id, supplier_drug_name, supplier_sku, is_preferred, active')
    .order('is_preferred', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierDrugRow[];
}

export async function supplierMedicines(): Promise<SupplierMedicineRow[]> {
  const { data, error } = await db()
    .from('drugs')
    .select(
      'id, name, strength, form, default_supplier_id, reorder_level_base, reorder_qty_base, active',
    )
    .eq('active', true)
    .order('name');

  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierMedicineRow[];
}
