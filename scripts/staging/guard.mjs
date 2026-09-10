/**
 * The thing standing between a test run and the clinic's live database.
 *
 * This repository's `.env.local` points NEXT_PUBLIC_FUNCTIONS_URL and
 * DATABASE_URL at the deployed project — the one four tablets in Chennai are
 * using right now. `docs/README.md` §3 says so plainly and then says there is
 * no guard against it in the code. This is that guard.
 *
 * It is deliberately an allowlist, not a blocklist. A blocklist of "not
 * supabase.co" is one new hostname away from being wrong, and the failure mode
 * is registering a real patient or taking a real batch off a real shelf. So a
 * connection is refused unless it is positively, boringly local: a loopback
 * host, and a database whose name says out loud that it is scratch.
 *
 * Every entry point that can write to a database imports this. It throws
 * rather than warning, because a warning in a test log is a warning nobody
 * reads until the morning after.
 */

/** Loopback only. A staging database on another machine is not this tool's job. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/**
 * The database must be named as scratch. `clinic_staging` and
 * `clinic_restore_drill` are the two this repository creates; the suffix rule
 * lets a developer keep several without editing this file.
 */
const NAME_PATTERN = /^(clinic_staging|clinic_restore_drill|clinic_test)(_[a-z0-9_]+)?$/

export class NotStaging extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotStaging'
  }
}

/**
 * Returns the URL if it is unambiguously a local scratch database, throws
 * otherwise. Never logs the URL: it carries a password.
 */
export function requireStagingUrl(raw, { what = 'This command' } = {}) {
  if (!raw || !String(raw).trim()) {
    throw new NotStaging(
      `${what} needs STAGING_DB_URL. Run "npm run staging:up" first; it prints the value to export.`,
    )
  }

  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new NotStaging(`${what} was given a STAGING_DB_URL that is not a URL.`)
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new NotStaging(`${what} expects a postgres:// URL; got ${url.protocol}//`)
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new NotStaging(
      `REFUSED: ${what} may only touch a database on this machine, and the host is ` +
        `"${url.hostname}". The clinic's live database is reachable from here — ` +
        `see docs/README.md §3 — and nothing in a test run is worth finding that out.`,
    )
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!NAME_PATTERN.test(database)) {
    throw new NotStaging(
      `REFUSED: ${what} may only touch a database named clinic_staging, ` +
        `clinic_test or clinic_restore_drill (an optional _suffix is allowed). ` +
        `Got "${database}".`,
    )
  }

  return String(raw).trim()
}

/** The same check, reading the environment. */
export function stagingUrlFromEnv(options) {
  return requireStagingUrl(process.env.STAGING_DB_URL, options)
}
