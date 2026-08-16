/**
 * Realtime, behind one adapter. HOSTING.md §7.
 *
 * The doctor-to-counter link (PLAN.md §11) is the feature the clinic actually
 * bought, and it is a subscription rather than a poll. It is also the piece
 * most tied to Supabase, which is exactly why it sits behind this interface:
 * "free tiers get cut" is a risk register entry, and swapping Realtime for a
 * plain WebSocket server has to be this file and nothing else.
 *
 * Two adapters ship. Supabase Realtime is the production one. The WebSocket
 * adapter consumes Postgres LISTEN/NOTIFY (see the 160200 migration) and is
 * what local development and the E2E suite run against — which means the
 * swappability claim is exercised on every test run rather than asserted in a
 * document.
 *
 * A change carries an id, never a row. The realtime payload does not pass
 * through RLS, so handing it to a screen would hand over fields the reader's
 * policies might not allow. Screens are told THAT something changed and re-read
 * it through lib/db, which is the only path with policies on it.
 *
 * Rule 6 lives here too: presence is never a promise. Every change carries an
 * `asOf`, because a screen that renders live data without saying when it was
 * live is how a patient drives 20 km to a locked door.
 */
import { db } from '@/lib/db';

export type ChangeKind = 'INSERT' | 'UPDATE' | 'DELETE';

export interface Change {
  table: string;
  kind: ChangeKind;
  id: string;
  asOf: Date;
}

export interface Subscription {
  unsubscribe: () => void;
}

export interface RealtimeAdapter {
  /** Subscribe to changes on the given tables. */
  subscribe(tables: string[], handler: (change: Change) => void): Subscription;
}

// ---------------------------------------------------------------------------
// Supabase Realtime — production.
// ---------------------------------------------------------------------------
export const supabaseRealtime: RealtimeAdapter = {
  subscribe(tables, handler) {
    const channel = db().channel(`clinic:${tables.join('+')}`);

    for (const table of tables) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          const row = (payload.new ?? payload.old) as { id?: string } | null;
          if (!row?.id) return;
          handler({
            table,
            kind: payload.eventType as ChangeKind,
            id: row.id,
            asOf: new Date(),
          });
        },
      );
    }

    channel.subscribe();

    return {
      unsubscribe: () => {
        void db().removeChannel(channel);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// WebSocket over LISTEN/NOTIFY — local development, and HOSTING.md §7's escape
// hatch if Supabase Realtime ever has to go.
// ---------------------------------------------------------------------------
export function websocketRealtime(url: string): RealtimeAdapter {
  return {
    subscribe(tables, handler) {
      let socket: WebSocket | null = null;
      let closed = false;
      let retry = 0;

      const connect = () => {
        if (closed) return;
        socket = new WebSocket(url);

        socket.onopen = () => {
          retry = 0;
        };

        socket.onmessage = (event) => {
          try {
            const change = JSON.parse(event.data as string) as {
              table: string;
              op: ChangeKind;
              id: string;
            };
            if (!tables.includes(change.table)) return;
            handler({
              table: change.table,
              kind: change.op,
              id: change.id,
              asOf: new Date(),
            });
          } catch {
            // A malformed frame is not worth taking the counter screen down for.
          }
        };

        // The clinic's link drops (PLAN.md §5.2). Reconnect with a backoff
        // rather than silently going deaf — a counter screen that has stopped
        // receiving prescriptions looks identical to a quiet afternoon.
        socket.onclose = () => {
          if (closed) return;
          retry = Math.min(retry + 1, 6);
          setTimeout(connect, Math.min(1000 * 2 ** (retry - 1), 30_000));
        };
      };

      connect();

      return {
        unsubscribe: () => {
          closed = true;
          socket?.close();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection. One place, read once.
// ---------------------------------------------------------------------------
const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_WS_URL;

let adapter: RealtimeAdapter | null = null;

function currentAdapter(): RealtimeAdapter {
  if (!adapter) {
    adapter = REALTIME_URL ? websocketRealtime(REALTIME_URL) : supabaseRealtime;
  }
  return adapter;
}

/** The swap point. Tests install a fake; a migration installs a WS client. */
export function setRealtimeAdapter(next: RealtimeAdapter): void {
  adapter = next;
}

export function subscribe(
  tables: string[],
  handler: (change: Change) => void,
): Subscription {
  return currentAdapter().subscribe(tables, handler);
}
