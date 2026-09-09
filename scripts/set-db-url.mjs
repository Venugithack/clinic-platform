#!/usr/bin/env node
/**
 * Put the Supabase connection string into .env.local without it passing
 * through a chat window, an editor that might not save, or a shell whose
 * quoting rules depend on which shell it is.
 *
 *   node jayamurugan-clinic/scripts/set-db-url.mjs
 *
 * Reads the URI from the clipboard. To pass it directly instead:
 *
 *   node jayamurugan-clinic/scripts/set-db-url.mjs "postgresql://..."
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')

function fromClipboard() {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-Clipboard'],
      { encoding: 'utf8' },
    )
  } catch {
    return ''
  }
}

const raw = (process.argv[2] ?? fromClipboard()).trim()

if (!raw) {
  console.error('Nothing found. Copy the connection URI, then run this again.')
  console.error('Or pass it directly:  node scripts/set-db-url.mjs "postgresql://..."')
  process.exit(1)
}

let url
try {
  url = new URL(raw)
} catch {
  console.error(`That is not a URL:\n  ${raw.slice(0, 60)}…`)
  process.exit(1)
}

if (!url.protocol.startsWith('postgres')) {
  console.error(`Expected a postgresql:// URI, got ${url.protocol}//`)
  process.exit(1)
}
if (!url.password) {
  console.error('That URI has no password in it. Use the URI tab, not the parameters tab —')
  console.error('and if it still shows [YOUR-PASSWORD], reset the database password first.')
  process.exit(1)
}

// The placeholder is easier to paste than the real thing, because it is the one
// written in the instructions.
const PLACEHOLDERS = ['yourpassword', 'your-password', '[your-password]', 'password', 'changeme']
if (PLACEHOLDERS.includes(decodeURIComponent(url.password).toLowerCase())) {
  console.error(`The password in that URI is the placeholder "${url.password}", not a real one.`)
  console.error('Replace it with the actual database password and run this again.')
  process.exit(1)
}

const before = readFileSync(envPath, 'utf8')
const after = before.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${raw}`)

if (after === before) {
  console.error('Could not find a DATABASE_URL line to replace in .env.local')
  process.exit(1)
}

writeFileSync(envPath, after)

console.log('Saved to .env.local')
console.log(`  host    : ${url.hostname}`)
console.log(`  port    : ${url.port}${url.port === '5432' ? ' (session pooler)' : url.port === '6543' ? ' (transaction pooler)' : ''}`)
console.log(`  user    : ${url.username}`)
console.log(`  database: ${url.pathname.slice(1)}`)
console.log('  password: present')
