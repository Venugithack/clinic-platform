import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliveredOrderStatus, reorderQuantity } from '../lib/order-status.ts'

test('delivery state is derived from cumulative received quantity', () => {
  assert.equal(deliveredOrderStatus(100, 0), 'placed')
  assert.equal(deliveredOrderStatus(100, 40), 'partially_delivered')
  assert.equal(deliveredOrderStatus(100, 100), 'delivered')
})

test('reorder quantity fills to target and never creates a zero line', () => {
  assert.equal(reorderQuantity(18, 100), 82)
  assert.equal(reorderQuantity(100, 100), 1)
})
