import { appSchema } from '@/lib/db';
import type { AdminDrugRow } from '@/lib/db/drugs';
import { toTransitionError } from './errors';

export interface NewDrugInput {
  name: string;
  generic?: string;
  saltComposition: string;
  strength: string;
  form: string;
  baseUnit: 'tablet' | 'ml' | 'piece';
  unitsPerStrip: number;
  stripsPerBox: number;
  mrpBasis: 'unit' | 'strip' | 'box';
  schedule: 'OTC' | 'H' | 'H1' | 'X';
  hsn?: string;
  reorderLevelBase?: number;
  reorderQtyBase?: number;
}

export interface DrugSettingsInput {
  name?: string;
  generic?: string;
  unitsPerStrip?: number;
  stripsPerBox?: number;
  mrpBasis?: 'unit' | 'strip' | 'box';
  schedule?: 'OTC' | 'H' | 'H1' | 'X';
  hsn?: string;
  reorderLevelBase?: number;
  reorderQtyBase?: number;
  active?: boolean;
}

export async function addDrug(input: NewDrugInput): Promise<AdminDrugRow> {
  const { data, error } = await appSchema().rpc('add_drug', {
    p_name: input.name,
    p_salt_composition: input.saltComposition,
    p_strength: input.strength,
    p_form: input.form,
    p_base_unit: input.baseUnit,
    p_generic: input.generic ?? null,
    p_default_units_per_strip: input.unitsPerStrip,
    p_default_strips_per_box: input.stripsPerBox,
    p_default_mrp_basis: input.mrpBasis,
    p_schedule: input.schedule,
    p_hsn: input.hsn ?? null,
    p_reorder_level_base: input.reorderLevelBase ?? null,
    p_reorder_qty_base: input.reorderQtyBase ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as AdminDrugRow;
}

export async function updateDrug(
  drugId: string,
  changes: DrugSettingsInput,
): Promise<AdminDrugRow> {
  const { data, error } = await appSchema().rpc('update_drug', {
    p_drug_id: drugId,
    p_name: changes.name ?? null,
    p_generic: changes.generic ?? null,
    p_default_units_per_strip: changes.unitsPerStrip ?? null,
    p_default_strips_per_box: changes.stripsPerBox ?? null,
    p_default_mrp_basis: changes.mrpBasis ?? null,
    p_schedule: changes.schedule ?? null,
    p_hsn: changes.hsn ?? null,
    p_reorder_level_base: changes.reorderLevelBase ?? null,
    p_reorder_qty_base: changes.reorderQtyBase ?? null,
    p_active: changes.active ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as AdminDrugRow;
}
