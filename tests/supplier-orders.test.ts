/**
 * Supplier orders: the packs a shortfall is ordered in, the words the supplier
 * reads, what is already on its way, and the link that hands the message to
 * the pharmacist's own WhatsApp.
 *
 * The database half — the draft, the lock, marking sent — is in
 * tests/characterization/supplier-orders.test.mjs.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildLadder } from '../supabase/functions/_shared/packages.ts'
import {
  describeOrdered, orderLevel, orderLevelFor, packsToCover, supplierOrderMessage,
} from '../supabase/functions/_shared/supplier-order.ts'
import { onOrderByMedicine, reorderRows, whatsAppLink } from '../lib/supplier-orders.ts'
import type { MedicineView, PurchaseOrderView } from '../lib/types.ts'

/** 10 tablets a strip, 10 strips a box. */
const tablets = buildLadder('tablet', [
  { levelName: 'tablet', levelType: 'tablet' },
  { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 10, mrpBasis: true },
  { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10 },
])

/** A bottle is its own base unit and the only thing a supplier sends. */
const bottles = buildLadder('bottle', [{ levelName: 'bottle', levelType: 'bottle', mrpBasis: true }])

describe('the packs an order is counted in', () => {
  test('a shortfall is rounded up to whole strips, never loose tablets', () => {
    assert.equal(orderLevel(tablets).levelName, 'strip')
    assert.deepEqual(packsToCover(tablets, 137), { levelName: 'strip', count: 14, baseQuantity: 140 })
    assert.deepEqual(packsToCover(tablets, 140), { levelName: 'strip', count: 14, baseQuantity: 140 })
    assert.deepEqual(packsToCover(tablets, 1), { levelName: 'strip', count: 1, baseQuantity: 10 })
  })

  test('a product with only a base unit is ordered in that', () => {
    assert.equal(orderLevel(bottles).levelName, 'bottle')
    assert.deepEqual(packsToCover(bottles, 3), { levelName: 'bottle', count: 3, baseQuantity: 3 })
  })

  test('a quantity typed by hand is recorded as typed, in packs only when it divides', () => {
    assert.deepEqual(orderLevelFor(tablets, 200), { levelName: 'strip', count: 20 })
    assert.deepEqual(orderLevelFor(tablets, 205), { levelName: 'tablet', count: 205 })
  })

  test('a shortfall of nothing is refused rather than ordered as one pack', () => {
    assert.throws(() => packsToCover(tablets, 0))
    assert.throws(() => packsToCover(tablets, 2.5))
  })
})

describe('what the supplier reads', () => {
  test('packs first, with the tablet total beside them', () => {
    assert.equal(describeOrdered(tablets, 'tablet', 140), '1 box and 4 strips (140 tablets)')
    assert.equal(describeOrdered(tablets, 'tablet', 100), '1 box (100 tablets)')
  })

  test('a number is never sent bare, even with no package to count packs in', () => {
    assert.equal(describeOrdered(null, 'tablet', 137), '137 tablets')
    assert.equal(describeOrdered(null, 'tube', 1), '1 tube')
    assert.equal(describeOrdered(bottles, 'bottle', 3), '3 bottles')
  })

  test('loose tablets are not described twice', () => {
    assert.equal(describeOrdered(tablets, 'tablet', 7), '7 tablets')
  })

  test('the message names the clinic, the order number and every line', () => {
    const message = supplierOrderMessage('Chennai Distributors', 'PO-0001', [
      { name: 'Paracetamol 500 mg', quantity: '1 box and 4 strips (140 tablets)' },
      { name: 'Cough syrup 100 ml', quantity: '3 bottles' },
    ])
    assert.match(message, /^Hello Chennai Distributors,/)
    assert.match(message, /Jayamurugan Clinic \(PO-0001\)/)
    assert.match(message, /1\. Paracetamol 500 mg — 1 box and 4 strips \(140 tablets\)/)
    assert.match(message, /2\. Cough syrup 100 ml — 3 bottles/)
  })
})

function medicine(id: string, totalAvailable: number, reorderLevel = 50): MedicineView {
  return {
    id, totalAvailable, reorderLevel, active: true, targetStock: 200, baseUnit: 'tablet',
  } as MedicineView
}

function order(
  status: PurchaseOrderView['status'],
  lines: Array<{ medicineId: string; ordered: number; received?: number }>,
): PurchaseOrderView {
  return {
    status,
    lines: lines.map((line) => ({
      medicineId: line.medicineId, orderedQuantity: line.ordered, receivedQuantity: line.received ?? 0,
    })),
  } as PurchaseOrderView
}

describe('what is already on its way', () => {
  test('counts what is outstanding on drafts, sent and part-delivered orders', () => {
    const onOrder = onOrderByMedicine([
      order('pending', [{ medicineId: 'a', ordered: 100 }]),
      order('placed', [{ medicineId: 'a', ordered: 50 }]),
      order('partially_delivered', [{ medicineId: 'b', ordered: 100, received: 60 }]),
    ])
    assert.equal(onOrder.get('a'), 150)
    assert.equal(onOrder.get('b'), 40)
  })

  test('a delivered or discarded order is no longer coming', () => {
    const onOrder = onOrderByMedicine([
      order('delivered', [{ medicineId: 'a', ordered: 100, received: 100 }]),
      order('cancelled', [{ medicineId: 'a', ordered: 100 }]),
    ])
    assert.equal(onOrder.get('a'), undefined)
  })

  test('a medicine covered by an order is low but does not need another', () => {
    const rows = reorderRows(
      [medicine('a', 10), medicine('b', 10), medicine('c', 500)],
      [order('placed', [{ medicineId: 'a', ordered: 140 }])],
    )
    assert.deepEqual(rows.map((row) => [row.medicine.id, row.onOrder, row.needsOrder]), [
      ['a', 140, false],
      ['b', 0, true],
    ])
  })

  test('an order too small to lift it above the reorder level still leaves it needing one', () => {
    const [row] = reorderRows([medicine('a', 10)], [order('placed', [{ medicineId: 'a', ordered: 20 }])])
    assert.equal(row.needsOrder, true)
  })
})

describe('the link to the pharmacist’s own WhatsApp', () => {
  test('dials the number and carries the whole message, encoded', () => {
    const link = whatsAppLink('919876543210', 'Hello Chennai,\n\n1. Paracetamol — 1 box & 4 strips?')
    assert.equal(
      link,
      'https://wa.me/919876543210?text=Hello%20Chennai%2C%0A%0A1.%20Paracetamol%20%E2%80%94%201%20box%20%26%204%20strips%3F',
    )
    assert.equal(new URL(link).searchParams.get('text'), 'Hello Chennai,\n\n1. Paracetamol — 1 box & 4 strips?')
  })
})
