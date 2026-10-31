import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliveredOrderStatus } from '../supabase/functions/_shared/order-status.ts'

test('delivery state is derived from cumulative received quantity', () => {
  assert.equal(deliveredOrderStatus(100, 0), 'placed')
  assert.equal(deliveredOrderStatus(100, 40), 'partially_delivered')
  assert.equal(deliveredOrderStatus(100, 100), 'delivered')
})
