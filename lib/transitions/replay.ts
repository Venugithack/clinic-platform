/**
 * Replaying a queued write. PLAN.md §16.
 *
 * The key is generated on the tablet BEFORE the first attempt, which is what
 * makes it the same key across a failure the tablet never saw the answer to.
 * `app.replay` applies the operation at most once and hands back what it
 * produced, so asking twice is safe and asking after a success is how the
 * tablet learns the answer it missed.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export type ReplayableFn = 'dispense' | 'raise_bill' | 'take_payment';

export async function replay(
  key: string,
  fn: ReplayableFn,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await appSchema().rpc('replay', {
    p_key: key,
    p_fn: fn,
    p_args: args,
  });

  if (error) throw toTransitionError(error);
  return (data ?? {}) as Record<string, unknown>;
}
