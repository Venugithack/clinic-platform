#!/usr/bin/env node

import { URL } from 'node:url';

/**
 * Production app-environment preflight.
 *
 * Backup credentials intentionally are not checked here: they belong to
 * GitHub Actions secrets, not to the public web deployment environment.
 */
const problems = [];
const notes = [];

const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? '';
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
const realtime = process.env.NEXT_PUBLIC_REALTIME_WS_URL?.trim() ?? '';

if (!urlValue) {
  problems.push('NEXT_PUBLIC_SUPABASE_URL is missing.');
} else {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:') problems.push('NEXT_PUBLIC_SUPABASE_URL must use HTTPS in production.');
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      problems.push('NEXT_PUBLIC_SUPABASE_URL still points at a local development database.');
    }
  } catch {
    problems.push('NEXT_PUBLIC_SUPABASE_URL is not a valid URL.');
  }
}

if (!key) {
  problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY / publishable key is missing.');
} else if (key.length < 20) {
  problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a placeholder rather than a real publishable key.');
}

if (realtime) {
  problems.push('NEXT_PUBLIC_REALTIME_WS_URL must be unset in production; hosted Supabase Realtime is used there.');
}

notes.push('GitHub Actions secrets still required for backups: BACKUP_DB_URL, BACKUP_AGE_RECIPIENT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT.');
notes.push('Printer setup is intentionally deferred until real clinic hardware exists.');

console.log('Clinic production preflight');
for (const note of notes) console.log(`• ${note}`);

if (problems.length > 0) {
  console.error('\nNot ready:');
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

console.log('\n✓ App environment looks production-shaped.');
