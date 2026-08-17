/**
 * The offline write queue. PLAN.md §16, HOSTING.md §6.
 *
 * The clinic's Wi-Fi drops. There is a concrete wall, a router at the wrong end
 * of the building and a 4G backup that takes half a minute to take over. The
 * counter cannot stop for any of that, so the write waits on the tablet.
 *
 * THE LINE THIS MODULE DRAWS, and it is the whole design:
 *
 *   **If the database answered, it decided. If it never answered, we queue.**
 *
 * A Schedule H1 refusal, a short dispense, a bill that does not settle — those
 * are answers. Queuing one would mean retrying it every thirty seconds forever
 * and, worse, telling the pharmacist it is "waiting for the network" when in
 * fact it is never going to happen. So anything carrying a SQLSTATE is rethrown
 * immediately and never enters the queue. Only a request that got no answer at
 * all — no network, DNS gone, the 12-second timeout in lib/db — is queued.
 *
 * WHAT THE COUNTER IS TOLD. Never "done". A queued sale is "saved on this
 * tablet, not yet in the ledger", with a count, because rule 6 applies to our
 * own writes as much as to the doctor's presence: a screen that reports success
 * it has not observed is lying in the direction that costs money.
 */
import { TransitionError } from '@/lib/transitions/errors';
import { replay, type ReplayableFn } from '@/lib/transitions/replay';

const STORAGE_KEY = 'clinic.writeQueue';

export interface QueuedWrite {
  /** Generated before the first attempt. That is what makes a retry safe. */
  key: string;
  fn: ReplayableFn;
  args: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /** Set when the database eventually REFUSED it. Needs a person, not a retry. */
  refusal?: string;
}

function read(): QueuedWrite[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as QueuedWrite[];
  } catch {
    return [];
  }
}

function write(queue: QueuedWrite[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new CustomEvent('clinic:queue'));
}

export function pending(): QueuedWrite[] {
  return read().filter((item) => !item.refusal);
}

export function refused(): QueuedWrite[] {
  return read().filter((item) => item.refusal);
}

export function forget(key: string): void {
  write(read().filter((item) => item.key !== key));
}

export interface RunResult {
  /** What the database returned, when it answered. */
  result?: Record<string, unknown>;
  /** True when nothing reached the database and the write is on this tablet. */
  queued: boolean;
}

/**
 * Try it now; keep it if the network is not there.
 *
 * Returns rather than throws for the offline case, because "the network is
 * down" is not the caller's error to handle — it is a state the screen reports.
 * A refusal still throws, because that IS the caller's to handle.
 */
export async function runOrQueue(
  fn: ReplayableFn,
  args: Record<string, unknown>,
): Promise<RunResult> {
  const key = crypto.randomUUID();

  try {
    return { result: await replay(key, fn, args), queued: false };
  } catch (cause) {
    // The database answered and said no. That is a decision, not an outage.
    if (cause instanceof TransitionError && cause.sqlstate) throw cause;

    write([
      ...read(),
      { key, fn, args, queuedAt: new Date().toISOString(), attempts: 1 },
    ]);
    return { queued: true };
  }
}

/**
 * Push whatever is waiting.
 *
 * Each item goes in under the key it was given when it was first attempted, so
 * an item that actually did land before the connection dropped is recognised
 * rather than applied a second time.
 */
export async function flush(): Promise<{ sent: number; refused: number }> {
  const queue = read();
  let sent = 0;
  let stopped = 0;

  for (const item of queue) {
    if (item.refusal) continue;

    try {
      await replay(item.key, item.fn, item.args);
      sent += 1;
      write(read().filter((row) => row.key !== item.key));
    } catch (cause) {
      if (cause instanceof TransitionError && cause.sqlstate) {
        // It reached the database and was refused — most often because the
        // stock went while this tablet was offline. Retrying forever would
        // hide it, so it stops here and waits for a person.
        stopped += 1;
        write(
          read().map((row) =>
            row.key === item.key ? { ...row, refusal: cause.message } : row,
          ),
        );
      } else {
        // Still no network. Leave it exactly where it is.
        write(
          read().map((row) =>
            row.key === item.key ? { ...row, attempts: row.attempts + 1 } : row,
          ),
        );
        break;
      }
    }
  }

  return { sent, refused: stopped };
}
