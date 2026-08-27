import { appSchema } from '@/lib/db';
import type { SupplierAdminRow, SupplierDrugRow } from '@/lib/db/suppliers';
import { toTransitionError } from './errors';

export interface SupplierInput {
  name: string;
  contactName?: string;
  whatsappNumber?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  leadTimeDays?: number;
  returnWindowDays?: number;
  paymentTerms?: string;
}

export async function addSupplier(input: SupplierInput): Promise<SupplierAdminRow> {
  const { data, error } = await appSchema().rpc('add_supplier', {
    p_name: input.name,
    p_contact_name: input.contactName ?? null,
    p_whatsapp_number: input.whatsappNumber ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
    p_gstin: input.gstin ?? null,
    p_lead_time_days: input.leadTimeDays ?? null,
    p_return_window_days: input.returnWindowDays ?? null,
    p_payment_terms: input.paymentTerms ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as SupplierAdminRow;
}

export async function updateSupplier(
  supplierId: string,
  changes: Partial<SupplierInput> & { active?: boolean },
): Promise<SupplierAdminRow> {
  const { data, error } = await appSchema().rpc('update_supplier', {
    p_supplier_id: supplierId,
    p_name: changes.name ?? null,
    p_contact_name: changes.contactName ?? null,
    p_whatsapp_number: changes.whatsappNumber ?? null,
    p_phone: changes.phone ?? null,
    p_email: changes.email ?? null,
    p_gstin: changes.gstin ?? null,
    p_lead_time_days: changes.leadTimeDays ?? null,
    p_return_window_days: changes.returnWindowDays ?? null,
    p_payment_terms: changes.paymentTerms ?? null,
    p_active: changes.active ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as SupplierAdminRow;
}

export async function setDrugSupplier(input: {
  drugId: string;
  supplierId: string;
  preferred?: boolean;
  supplierDrugName?: string;
  supplierSku?: string;
  active?: boolean;
}): Promise<SupplierDrugRow> {
  const { data, error } = await appSchema().rpc('set_drug_supplier', {
    p_drug_id: input.drugId,
    p_supplier_id: input.supplierId,
    p_is_preferred: input.preferred ?? false,
    p_supplier_drug_name: input.supplierDrugName ?? null,
    p_supplier_sku: input.supplierSku ?? null,
    p_active: input.active ?? true,
  });

  if (error) throw toTransitionError(error);
  return data as SupplierDrugRow;
}
