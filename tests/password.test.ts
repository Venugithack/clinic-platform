import assert from 'node:assert/strict'
import { test } from 'node:test'
// The functions own this now. It uses only node:crypto, so Node can still
// run the test against the same file Deno deploys.
import { hashPassword, verifyPassword } from '../supabase/functions/_shared/password.ts'

test('staff PINs are salted and verifiable', async () => {
  const first = await hashPassword('483920')
  const second = await hashPassword('483920')

  // Same PIN, different salt, therefore different hash — otherwise two staff
  // members who pick the same six digits are visibly the same in the table.
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)

  assert.equal(await verifyPassword('483920', first.salt, first.hash), true)
  assert.equal(await verifyPassword('483921', first.salt, first.hash), false)
})

test('hashing does not block the event loop', async () => {
  // The reason this is asynchronous at all: scryptSync held the loop for tens
  // of milliseconds, and Cloudflare's runtime cancelled the request as hung —
  // about one sign-in in ten. If this ever goes back to a sync implementation,
  // the timer below stops firing during the hash and this fails.
  let ticked = false
  const timer = setTimeout(() => { ticked = true }, 1)

  await hashPassword('483920')

  clearTimeout(timer)
  assert.equal(ticked, true, 'the event loop was blocked while hashing')
})
