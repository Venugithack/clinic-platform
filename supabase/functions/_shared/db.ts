import postgres from 'npm:postgres@3.4.5'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * The clinic's database, from an Edge Function.
 *
 * ── WHAT IS DIFFERENT FROM THE NEXT VERSION THIS REPLACES ───────────────────
 *
 * The connection string is injected by the platform, so there is none to keep.
 * `search_path` is set on the connection and stays set, because this talks to
 * Postgres directly rather than through Hyperdrive — which dropped it, and sent
 * the app reading the previous application's tables in `public`.
 *
 * And there is no schema creation here. The Next version built the schema on
 * first use, which was reasonable when one server owned the database and is not
 * when six functions cold-start independently and race each other to run the
 * same DDL. The schema is a migration now; this only uses it.
 */

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  // Edge Functions are small and short-lived; a large pool per instance would
  // multiply across instances and exhaust the project's connection limit.
  max: 2,
  idle_timeout: 20,
  connect_timeout: 15,
  connection: { search_path: 'jmc' },
})

const openTransaction = new AsyncLocalStorage<postgres.TransactionSql>()
const conn = () => openTransaction.getStore() ?? sql

/**
 * SQLite counted placeholders by position and wrote them all `?`; Postgres
 * numbers them. Question marks inside string literals are left alone.
 */
function positional(text: string): string {
  let out = ''
  let quoted = false
  let n = 0

  for (const c of text) {
    if (c === "'") {
      quoted = !quoted
      out += c
    } else if (c === '?' && !quoted) {
      n += 1
      out += `$${n}`
    } else {
      out += c
    }
  }

  return out
}

type Row = Record<string, unknown>

export const db = {
  async exec(text: string): Promise<void> {
    await conn().unsafe(text).simple()
  },
  prepare(text: string) {
    const query = positional(text)
    return {
      async run(...params: unknown[]): Promise<{ changes: number }> {
        const result = await conn().unsafe(query, params as never[])
        return { changes: result.count ?? 0 }
      },
      async get(...params: unknown[]): Promise<Row | undefined> {
        const rows = (await conn().unsafe(query, params as never[])) as unknown as Row[]
        return rows[0]
      },
      async all(...params: unknown[]): Promise<Row[]> {
        return (await conn().unsafe(query, params as never[])) as unknown as Row[]
      },
    }
  },
}

/**
 * One connection, committed or rolled back together, and the revision bumped
 * with it — so the counter can never claim a write that rolled back, and a
 * command added later cannot forget to bump it.
 */
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  return sql.begin((t) =>
    openTransaction.run(t, async () => {
      const value = await work()
      await t`update clinic_revision
              set revision = revision + 1, changed_at = ${isoNow()}
              where id = 1`
      return value
    }),
  ) as Promise<T>
}

/** What the tablets poll. One row, one column, no joins. */
export async function currentRevision(): Promise<number> {
  const row = (await db
    .prepare('select revision from clinic_revision where id = 1')
    .get()) as { revision: string | number } | undefined
  return Number(row?.revision ?? 0)
}

export function isoNow(): string {
  return new Date().toISOString()
}

export async function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await db
    .prepare(
      `insert into audit_events
        (id,actor_id,action,entity_type,entity_id,summary,created_at)
        values (?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), actorId, action, entityType, entityId, summary, isoNow())
}
