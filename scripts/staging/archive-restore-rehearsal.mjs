/**
 * Rehearse the R2 archive restore proof, locally, against nothing.
 *
 * `npm run staging:drill` proves the dump-and-restore path: it takes a fresh
 * dump and puts it back. What nobody has ever proved is that the object
 * sitting in R2 — encrypted, uploaded, pruned around, never opened — can be
 * fetched and read. That is W9, and `docs/README.md` §6 calls it the gap worth
 * closing first.
 *
 * `scripts/db-restore-archive.sh` is the path that closes it. This file is the
 * rehearsal of that script with the network taken out: the bucket is a
 * directory rclone addresses as a local remote, the age identity is generated
 * for the run and thrown away with it, and the objects in the bucket are built
 * from the synthetic staging fixtures by the same `scripts/db-backup.sh` the
 * clinic's nightly backup runs.
 *
 * It rehearses the real script rather than a Windows reimplementation, for the
 * same reason restore-drill.mjs does: a rehearsal of a reimplementation
 * rehearses the reimplementation. So it runs in a container — one built from
 * postgres:17 plus `age` and `rclone`, which is the same three tools
 * .github/workflows/archive-restore.yml installs on its runner.
 *
 * What this does NOT do, and cannot: touch R2. There is no credential here, no
 * endpoint and no bucket name. The real proof is a separately authorized
 * manual run of the workflow; `docs/operations/ROLLOUT.md` §8.1 is the
 * procedure and W9 stays open until it has been done once.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireStagingUrl } from './guard.mjs'

const CONTAINER = process.env.STAGING_CONTAINER ?? 'jmc-staging'
const PORT = process.env.STAGING_PORT ?? '55432'
const PASSWORD = 'staging'
const IMAGE = 'jmc-archive-restore:1'

// Checked with the same guard as every other entry point, then rewritten to
// the container-network form the rehearsal container will actually dial. Both
// are loopback-equivalent: `jmc-staging` resolves only inside Docker's bridge.
requireStagingUrl(`postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/clinic_staging`, {
  what: 'archive-restore-rehearsal',
})

const insideUrl = `postgresql://postgres:${PASSWORD}@${CONTAINER}:5432/clinic_staging`

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

const root = repoRoot()
const dockerfile = join(root, 'scripts', 'staging', 'archive-restore.Dockerfile')
if (!existsSync(dockerfile)) {
  console.error(`Missing ${dockerfile}`)
  process.exit(1)
}

function imageExists() {
  return spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0
}

if (!imageExists()) {
  console.log(`Building ${IMAGE} (postgres:17 plus age and rclone). This happens once.`)
  const built = spawnSync(
    'docker',
    ['build', '-f', dockerfile, '-t', IMAGE, join(root, 'scripts', 'staging')],
    { stdio: 'inherit' },
  )
  if (built.status !== 0) {
    console.error(
      '\nCould not build the rehearsal image. It needs the network once, to install\n' +
        'age and rclone from Debian. Nothing after that step goes near a network.\n',
    )
    process.exit(built.status ?? 1)
  }
}

console.log('Rehearsing scripts/db-restore-archive.sh against a local directory acting as the bucket')
console.log('')

const result = spawnSync(
  'docker',
  [
    'run', '--rm',
    '--network', 'bridge',
    '--link', `${CONTAINER}:${CONTAINER}`,
    '-v', `${root}:/repo`,
    '-w', '/repo',
    // The source of the synthetic dump the stored objects are built from. The
    // script under test never sees this: it is handed to scripts/db-backup.sh
    // by the case harness during setup, and db-restore-archive.sh refuses to
    // start if BACKUP_DB_URL is in its environment at all.
    '-e', `REHEARSAL_SOURCE_URL=${insideUrl}`,
    '-e', `PGPASSWORD=${PASSWORD}`,
    IMAGE,
    'bash', '-lc', 'set -uo pipefail; ./scripts/staging/archive-restore-cases.sh',
  ],
  { stdio: 'inherit' },
)

if (result.status !== 0) {
  console.error('\nArchive restore rehearsal FAILED.\n')
  process.exit(result.status ?? 1)
}

console.log('')
console.log('Archive restore rehearsal passed.')
console.log('This proves the tooling. It does not prove the clinic archive: no object in R2')
console.log('has been fetched. See docs/operations/ROLLOUT.md §8.1 for the authorized run.')
