/**
 * Turning a Postgres error into something a pharmacist can act on.
 *
 * The transitions raise distinct SQLSTATEs precisely so this mapping can exist:
 * "insufficient stock" and "that batch has expired" need different responses at
 * the counter, and neither of them is a stack trace.
 */

export type TransitionErrorCode =
  | 'INSUFFICIENT_STOCK'
  | 'NO_USABLE_BATCH'
  | 'SCHEDULE_H1_REFUSED'
  | 'MRP_EXCEEDED'
  | 'NOT_SIGNED_IN'
  | 'BAD_REQUEST'
  | 'INVALID_STATE_CHANGE'
  | 'ALREADY_SIGNED'
  | 'NOT_EQUIVALENT'
  | 'QUERY_ALREADY_OPEN'
  | 'EXPIRY_IN_PAST'
  | 'EXPIRY_BEFORE_DISPENSED'
  | 'BARCODE_TAKEN'
  | 'STOCK_TAKE_IN_PROGRESS'
  | 'RECOUNT_REQUIRED'
  | 'RETURN_WINDOW_CLOSED'
  | 'NOT_EXPIRED'
  | 'CREDIT_EXCEEDED'
  | 'TILL_ALREADY_OPEN'
  | 'NO_TILL_OPEN'
  | 'PAYMENT_MISMATCH'
  | 'UNKNOWN';

const BY_SQLSTATE: Record<string, TransitionErrorCode> = {
  CL001: 'INSUFFICIENT_STOCK',
  CL002: 'NO_USABLE_BATCH',
  CL003: 'SCHEDULE_H1_REFUSED',
  CL004: 'MRP_EXCEEDED',
  CL005: 'NOT_SIGNED_IN',
  CL006: 'BAD_REQUEST',
  CL007: 'INVALID_STATE_CHANGE',
  CL008: 'ALREADY_SIGNED',
  CL009: 'NOT_EQUIVALENT',
  CL010: 'QUERY_ALREADY_OPEN',
  CL011: 'EXPIRY_IN_PAST',
  CL012: 'EXPIRY_BEFORE_DISPENSED',
  CL013: 'BARCODE_TAKEN',
  CL014: 'STOCK_TAKE_IN_PROGRESS',
  CL015: 'RECOUNT_REQUIRED',
  CL016: 'RETURN_WINDOW_CLOSED',
  CL017: 'NOT_EXPIRED',
  CL018: 'CREDIT_EXCEEDED',
  CL019: 'TILL_ALREADY_OPEN',
  CL020: 'NO_TILL_OPEN',
  CL021: 'PAYMENT_MISMATCH',
};

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  readonly sqlstate: string | undefined;

  constructor(code: TransitionErrorCode, message: string, sqlstate?: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function toTransitionError(error: PostgrestLikeError): TransitionError {
  const sqlstate = error.code;
  const code: TransitionErrorCode = sqlstate
    ? (BY_SQLSTATE[sqlstate] ?? 'UNKNOWN')
    : 'UNKNOWN';

  // The database messages are already written to be read by a human at the
  // counter — they name the drug and the shortfall — so they are passed
  // through rather than replaced with something vaguer.
  return new TransitionError(
    code,
    error.message ?? 'the transition was refused',
    sqlstate,
  );
}

/**
 * Whether the counter can fix this itself.
 *
 * A short dispense has a route out — the inline quick-GRN in INVENTORY.md §3,
 * for stock that is physically on the shelf but not yet entered. An H1 refusal
 * does not; that one is legal and the answer is a prescription.
 */
export function isRecoverableAtCounter(error: TransitionError): boolean {
  return error.code === 'INSUFFICIENT_STOCK' || error.code === 'NO_USABLE_BATCH';
}
