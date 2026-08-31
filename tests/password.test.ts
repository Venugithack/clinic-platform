import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, verifyPassword } from '../lib/server/password.ts'

test('staff passwords are salted and verifiable', () => {
  const first = hashPassword('clinic-password')
  const second = hashPassword('clinic-password')

  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
  assert.equal(verifyPassword('clinic-password', first.salt, first.hash), true)
  assert.equal(verifyPassword('wrong-password', first.salt, first.hash), false)
})
