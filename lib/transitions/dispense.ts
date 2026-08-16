/**
 * Thin typed wrapper over app.dispense(). PLAN.md §5.3 rule 2.
 *
 * "Thin" is the whole specification. There is no business logic in this file
 * and there must never be any: FEFO allocation, the expiry exclusion, the
 * Schedule H1 refusal, the MRP ceiling and the never-negative invariant all
 * live in the plpgsql function, inside one transaction, next to the audit row
 * they produce. Anything reimplemented here is a second opinion that will
 * eventually disagree with the database — and the database is the one holding
 * the stock.
 *
 * This is the pattern the other eleven transitions copy (BUILD.md §1.5).
 */
import { appSchema } from '@/lib/db';
import { toTransitionError, TransitionError } from './errors';

export interface DispenseLine {
  drugId: string;
  /** Base units. Always. The UI converts strips and boxes via lib/units. */
  qtyBase: number;
  /**
   * Set only when substituting. Both sides are recorded — what was prescribed
   * and what left the shelf — along with the doctor who approved it
   * (INVENTORY.md §7). Substitution is never automatic.
   */
  prescribedDrugId?: string;
  substitutionApprovedBy?: string;
}

export interface DispenseInput {
  lines: DispenseLine[];
  prescriptionId?: string;
  patientId?: string;
  /** A walk-in buying without a prescription. Schedule H1 cannot leave on one. */
  isCounterSale?: boolean;
}

export async function dispense(input: DispenseInput): Promise<string> {
  const { data, error } = await appSchema().rpc('dispense', {
    p_lines: input.lines.map((line) => ({
      drug_id: line.drugId,
      qty_base: line.qtyBase,
      prescribed_drug_id: line.prescribedDrugId ?? null,
      substitution_approved_by: line.substitutionApprovedBy ?? null,
    })),
    p_prescription_id: input.prescriptionId ?? null,
    p_patient_id: input.patientId ?? null,
    p_is_counter_sale: input.isCounterSale ?? false,
  });

  if (error) throw toTransitionError(error);

  if (typeof data !== 'string') {
    throw new TransitionError('UNKNOWN', 'dispense returned no id');
  }

  return data;
}
