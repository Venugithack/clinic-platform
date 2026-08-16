/**
 * The one seam. PLAN.md §5.3 rule 1.
 *
 * This is the ONLY module in the codebase permitted to import from
 * `@supabase/*`. Everything else goes through here or through
 * `lib/transitions`. A component that reaches for the Supabase client directly
 * runs a query with no RLS context, no audit trail and no transaction — and by
 * the time anyone notices, it is in production.
 *
 * The rule is enforced by ESLint (see eslint.config.mjs), not by memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function db(): SupabaseClient {
  if (client) return client;

  client = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      auth: {
        // The device holds a long-lived session; the PIN holds the identity
        // (TABLET.md §5). Persisting is the point — staff never type a password.
        persistSession: true,
        autoRefreshToken: true,
      },
    },
  );

  return client;
}

/** Test seam: drop the memoised client so a test can install its own. */
export function resetDb(): void {
  client = null;
}

export type { SupabaseClient };
