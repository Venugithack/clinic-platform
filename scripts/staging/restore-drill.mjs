/**
 * Rehearse the clinic's real backup and restore, against staging.
 *
 * Slice 0's gate says "backup restore is rehearsed". The scripts that do it —
 * scripts/db-backup.sh and scripts/db-restore-drill.sh — are the ones CI runs
 * nightly against the live database, and they are bash with a PostgreSQL 17
 * client. This machine is Windows and has neither.
 *
 * So it runs them unmodified inside a postgres:17 container with the repository
 * mounted. That matters: a Windows reimplementation of the drill would rehearse
 * the reimplementation. This rehearses the actual scripts, including the
 * three-schema selection (`--schema=public --schema=app --schema=jmc`) and the
 * assertion at the end that jmc came back, which is the part that was wrong
 * before and is the reason anyone checks.
 *
 * The source and target are both the staging container. Nothing here can reach
 * the clinic: the URL goes through the same guard as everything else, and the
 * drill's scratch database is named clinic_restore_drill, which the guard
 * allows and which nothing else uses.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { requireStagingUrl } from './guard.mjs'

const CONTAINER = process.env.STAGING_CONTAINER ?? 'jmc-staging'
const PORT = process.env.STAGING_PORT ?? '55432'
const PASSWORD = 'staging'

// Checked with the same guard as every other entry point, then rewritten to the
// container-network form the drill container will actually dial. Both are
// loopback-equivalent: `jmc-staging` resolves only inside Docker's bridge.
requireStagingUrl(`postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/clinic_staging`, {
  what: 'restore-drill',
})

const insideUrl = `postgresql://postgres:${PASSWORD}@${CONTAINER}:5432/clinic_staging`

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

const mount = `${repoRoot()}:/repo`

console.log('Rehearsing scripts/db-backup.sh and scripts/db-restore-drill.sh against staging')
console.log('')

const result = spawnSync(
  'docker',
  [
    'run', '--rm',
    '--network', 'bridge',
    '--link', `${CONTAINER}:${CONTAINER}`,
    '-v', mount,
    '-w', '/repo',
    '-e', `BACKUP_DB_URL=${insideUrl}`,
    '-e', `PGPASSWORD=${PASSWORD}`,
    '-e', `PGHOST=${CONTAINER}`,
    '-e', 'PGPORT=5432',
    '-e', 'PGUSER=postgres',
    '-e', 'PGDATABASE=clinic_staging',
    // The drill's own scratch database. The guard allows this name; nothing
    // else in the project uses it.
    '-e', 'SCRATCH_DB=clinic_restore_drill',
    'postgres:17',
    'bash', '-lc', 'set -euo pipefail; ./scripts/db-restore-drill.sh',
  ],
  { stdio: 'inherit' },
)

if (result.status !== 0) {
  console.error('\nRestore drill FAILED.\n')
  process.exit(result.status ?? 1)
}

console.log('')
console.log('Restore drill passed against staging.')
