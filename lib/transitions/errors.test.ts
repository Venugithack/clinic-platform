import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toTransitionError } from './errors';

/**
 * The SQLSTATE map must not fall behind the migrations.
 *
 * Every CLxxx code is raised by a plpgsql transition and caught here, and the
 * two halves live in different languages in different directories — so the only
 * thing keeping them in step is that somebody remembers. CL027 proved that is
 * not enough: it was raised by app.update_staff and app.revoke_device, asserted
 * by pgTAP, and absent from this map for as long as it had existed.
 *
 * An unmapped code still surfaces its database message, so the counter is not
 * left staring at a stack trace. What it loses is the code — and the offline
 * queue reads exactly that to decide whether the database REFUSED a write or
 * never saw it. A code that goes missing is a refusal that risks being treated
 * as an outage and retried.
 */
const MIGRATIONS = join(import.meta.dirname, '../../supabase/migrations');

function codesRaisedInSql(): string[] {
  const found = new Set<string>();

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // Only an actual raise binds a code to a transition. A CLxxx mentioned in
    // a comment is documentation, and documentation is not a contract.
    for (const match of sql.matchAll(/errcode\s*=\s*'(CL\d{3})'/g)) {
      const code = match[1];
      if (code) found.add(code);
    }
  }

  return [...found].sort();
}

describe('every SQLSTATE the database raises is mapped', () => {
  it('finds the codes in the migrations at all', () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below vacuously true.
    expect(codesRaisedInSql().length).toBeGreaterThan(20);
  });

  it.each(codesRaisedInSql())('%s is not UNKNOWN', (sqlstate) => {
    expect(toTransitionError({ code: sqlstate, message: 'x' }).code).not.toBe('UNKNOWN');
  });
});
