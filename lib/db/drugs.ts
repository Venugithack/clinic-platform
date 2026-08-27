/**
 * The drug catalogue, as the search overlay needs it (TABLET.md §4).
 *
 * Every row carries the live stock badge inline. PLAN.md §11.2 schedules that
 * for M2, but the numbers are real from M0 and the view already excludes
 * expired batches, so it costs nothing to surface now — and a composer that
 * shows what is on the shelf is the difference between prescribing and
 * guessing.
 */
import { db } from './index';

export interface DrugRow {
  id: string;
  name: string;
  generic: string | null;
  salt_composition: string;
  strength: string;
  form: string;
  base_unit: 'tablet' | 'ml' | 'piece';
  schedule: 'OTC' | 'H' | 'H1' | 'X';
  default_units_per_strip: number | null;
  default_strips_per_box: number | null;
  qty_base_available: number;
  earliest_expiry: string | null;
  batches: number;
}

export interface AdminDrugRow {
  id: string;
  name: string;
  generic: string | null;
  salt_composition: string;
  strength: string;
  form: string;
  base_unit: 'tablet' | 'ml' | 'piece';
  default_units_per_strip: number | null;
  default_strips_per_box: number | null;
  default_mrp_basis: 'unit' | 'strip' | 'box';
  schedule: 'OTC' | 'H' | 'H1' | 'X';
  hsn: string | null;
  default_supplier_id: string | null;
  reorder_level_base: number | null;
  reorder_qty_base: number | null;
  active: boolean;
}

/** Three characters is enough (TABLET.md §4). */
export const MIN_SEARCH_LENGTH = 3;

/**
 * Matches on brand, generic and salt — the three things a doctor might type.
 * Salt matters most: he thinks "amoxicillin" and the shelf says "Augmentin".
 */
export async function searchDrugs(query: string): Promise<DrugRow[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH) return [];

  const pattern = `%${trimmed}%`;
  const { data, error } = await db()
    .from('drug_availability')
    .select('*')
    .eq('active', true)
    .or(`name.ilike.${pattern},generic.ilike.${pattern},salt_composition.ilike.${pattern}`)
    .order('name')
    .limit(40);

  if (error) throw new Error(error.message);
  return (data ?? []) as DrugRow[];
}

/**
 * What to show before a single character is typed.
 *
 * The top 40 drugs are most of the prescriptions in a single-doctor general
 * practice, so this turns most searches into one tap. It counts what was
 * actually written — it does not suggest anything (rule 8).
 */
export async function frequentDrugs(limit = 12): Promise<DrugRow[]> {
  const { data: frequent, error } = await db()
    .from('drugs_frequently_prescribed')
    .select('id, times_prescribed')
    .order('times_prescribed', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const ids = (frequent ?? []).map((row) => row.id as string);
  if (ids.length === 0) return [];

  const { data, error: drugsError } = await db()
    .from('drug_availability')
    .select('*')
    .in('id', ids);

  if (drugsError) throw new Error(drugsError.message);

  const order = new Map(ids.map((id, index) => [id, index]));
  return ((data ?? []) as DrugRow[]).sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/**
 * What the counter may propose instead.
 *
 * INVENTORY.md §7: same salt + same strength + same dosage form = substitutable,
 * and nothing else is. Matching identical salts is a lookup, not a clinical
 * inference — no interaction checking, no therapeutic alternatives, no
 * "similar" drugs. The transition enforces the same rule on the way in, so this
 * query cannot widen it; it only decides what the pharmacist is shown.
 */
export async function equivalentDrugs(drug: DrugRow): Promise<DrugRow[]> {
  const { data, error } = await db()
    .from('drug_availability')
    .select('*')
    .eq('active', true)
    .eq('salt_composition', drug.salt_composition)
    .eq('strength', drug.strength)
    .eq('form', drug.form)
    .neq('id', drug.id)
    .order('name');

  if (error) throw new Error(error.message);

  // In stock first: an equivalent that is also out is not a proposal worth
  // sending to the doctor.
  return ((data ?? []) as DrugRow[]).sort(
    (a, b) => b.qty_base_available - a.qty_base_available,
  );
}

export async function drugsByIds(ids: string[]): Promise<Map<string, DrugRow>> {
  if (ids.length === 0) return new Map();

  const { data, error } = await db()
    .from('drug_availability')
    .select('*')
    .in('id', ids);

  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as DrugRow[]).map((drug) => [drug.id, drug]));
}

export async function getDrug(id: string): Promise<DrugRow | null> {
  const { data, error } = await db()
    .from('drug_availability')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as DrugRow) ?? null;
}

/** Admin master list includes inactive medicines and configuration fields. */
export async function adminDrugs(): Promise<AdminDrugRow[]> {
  const { data, error } = await db()
    .from('drugs')
    .select(
      'id,name,generic,salt_composition,strength,form,base_unit,default_units_per_strip,default_strips_per_box,default_mrp_basis,schedule,hsn,default_supplier_id,reorder_level_base,reorder_qty_base,active',
    )
    .order('active', { ascending: false })
    .order('name');

  if (error) throw new Error(error.message);
  return (data ?? []) as AdminDrugRow[];
}

/** "18 in stock · Mar 2027", or "OUT". Expiries read as printed on the strip. */
export function stockBadge(drug: DrugRow): { label: string; out: boolean } {
  if (drug.qty_base_available <= 0) return { label: 'OUT', out: true };

  const expiry = drug.earliest_expiry
    ? new Date(drug.earliest_expiry).toLocaleDateString('en-IN', {
        month: 'short',
        year: 'numeric',
      })
    : null;

  return {
    label: expiry
      ? `${drug.qty_base_available} in stock · ${expiry}`
      : `${drug.qty_base_available} in stock`,
    out: false,
  };
}
