/**
 * Realtime, behind one adapter. HOSTING.md §7.
 *
 * The doctor-to-counter link (PLAN.md §11) is the feature the clinic actually
 * bought, and it is a subscription rather than a poll. It is also the piece
 * most tied to Supabase, which is exactly why it sits behind this interface:
 * "free tiers get cut" is a risk register entry, and swapping Realtime for a
 * plain WebSocket server has to be this file and nothing else.
 *
 * Rule 6 lives here too: presence is never a promise. Every subscriber is
 * handed an `asOf` timestamp with its payload, because a screen that renders
 * live data without saying when it was live is how a patient drives 20 km to a
 * locked door.
 */
import { db } from '@/lib/db';

export type ChangeKind = 'INSERT' | 'UPDATE' | 'DELETE';

export interface Change<T> {
  kind: ChangeKind;
  row: T;
  asOf: Date;
}

export interface Subscription {
  unsubscribe: () => void;
}

export interface RealtimeAdapter {
  onTableChange<T>(
    table: string,
    handler: (change: Change<T>) => void,
    filter?: string,
  ): Subscription;
}

export const supabaseRealtime: RealtimeAdapter = {
  onTableChange<T>(
    table: string,
    handler: (change: Change<T>) => void,
    filter?: string,
  ): Subscription {
    const channel = db()
      .channel(`clinic:${table}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload) => {
          handler({
            kind: payload.eventType as ChangeKind,
            row: (payload.new ?? payload.old) as T,
            asOf: new Date(),
          });
        },
      )
      .subscribe();

    return {
      unsubscribe: () => {
        void db().removeChannel(channel);
      },
    };
  },
};

let adapter: RealtimeAdapter = supabaseRealtime;

/** The swap point. Tests install a fake; a migration installs a WS client. */
export function setRealtimeAdapter(next: RealtimeAdapter): void {
  adapter = next;
}

export function onTableChange<T>(
  table: string,
  handler: (change: Change<T>) => void,
  filter?: string,
): Subscription {
  return adapter.onTableChange(table, handler, filter);
}
