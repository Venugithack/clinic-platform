/**
 * Stop the staging database, or remove it entirely with --destroy.
 *
 * Stopping keeps the volume, so `staging:up` comes back in a second with the
 * same data. `--destroy` removes the container and everything in it, which is
 * the right move when a migration has half-applied and the fastest cure is a
 * database that never saw it.
 */
import { execFileSync } from 'node:child_process'

const CONTAINER = process.env.STAGING_CONTAINER ?? 'jmc-staging'
const destroy = process.argv.includes('--destroy')

function docker(args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return { failed: true, error }
  }
}

const state = (() => {
  const out = docker(['inspect', '-f', '{{.State.Status}}', CONTAINER])
  return typeof out === 'string' ? out.trim() : 'absent'
})()

if (state === 'absent') {
  console.log(`${CONTAINER} does not exist. Nothing to do.`)
} else if (destroy) {
  docker(['rm', '-f', CONTAINER])
  console.log(`${CONTAINER} removed.`)
} else {
  docker(['stop', CONTAINER])
  console.log(`${CONTAINER} stopped. "npm run staging:up" brings it back.`)
}
