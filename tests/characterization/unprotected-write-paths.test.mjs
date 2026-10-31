/**
 * The writes that can happen twice, and the stock that arrives without papers.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `docs/AGENT_IMPLEMENTATION_BRIEF.md` §7 names five operations that must
 * carry an idempotency or unique source key, because every one of them can be
 * retried by a tablet that never heard the answer: encounter completion,
 * dispensing, goods receipt, billing, and payment. Dispensing, OTC sale,
 * payment and `post_goods_receipt` each take a key from the browser and back
 * it with a unique index, and `tests/characterization/concurrency.test.mjs`
 * holds them to it.
 *
 * Encounter completion was the fifth and had nothing. It does now — W1 of the
 * backend programme gave `sign_consultation` a key, a request fingerprint and
 * a unique index, and `consultation-idempotency.test.mjs` is where that is
 * held to account. What remains here are the two older paths that can put
 * stock on the shelf with no papers behind them. This file is the record of
 * what they do instead.
 *
 * ── WHAT IT IS AND IS NOT ──────────────────────────────────────────────────
 *
 * These tests pass. That is the point of a characterization test: it pins down
 * what the code does today so that a later slice changing it has to say so out
 * loud, in a diff, rather than discovering it in a clinic. Several of the
 * behaviours pinned here are wrong — a patient charged twice for one
 * consultation is wrong, eighty tablets on the shelf when forty arrived is
 * wrong — and each one says so where it is asserted.
 *
 * Nothing here is a fix. The fixes are contract changes — one receipt engine
 * behind every path that moves stock — and they belong to the slice that owns
 * that contract (W12 and W13, Slice 8). The work register in
 * `docs/reference/BACKEND_PROGRAMME_REGISTER.md` carries them with the
 * evidence below.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** A pharmacist who is also an administrator, one medicine, one supplier. */
async function counter() {
  await resetClinic()
  const staff = await makeStaff({
    name: 'Pharmacist', roles: ['pharmacy', 'admin'], username: 'ph', pin: '5731',
  })
  await as(staff, 'add_supplier', {
    name: 'Kumar Distributors', phone: '+919000000001', code: 'KUM', whatsapp: '+919000000001',
  })
  const supplierId = String(await scalar('select id from jmc.suppliers limit 1'))
  return { staff, supplierId }
}

async function addMedicine(staff, extra = {}) {
  await as(staff, 'add_medicine', {
    code: 'PARA500', name: 'Paracetamol 500', unit: 'tablet', saleClass: 'otc',
    reorderLevel: '10', targetStock: '100', initialQuantity: '0', ...extra,
  })
  return String(await scalar(`select id from jmc.medicines where code='PARA500'`))
}

describe('stock that arrives without a goods receipt', () => {
  test('adding a medicine can put stock on the shelf with no package and no papers', async () => {
    const { staff } = await counter()
    await addMedicine(staff, {
      initialQuantity: '250', batchNumber: 'B-1', expiry: '2099-12-31',
      mrp: '20', purchasePrice: '12', sellingPrice: '20',
    })

    const [batch] = await rows(
      `select available_quantity, package_version_id, package_snapshot
         from jmc.batches where batch_number = 'B-1'`)
    assert.equal(batch.available_quantity, 250)

    /*
     * `post_goods_receipt` refuses a medicine with no verified package version
     * (supabase/functions/_shared/inventory.ts:851-869) because the package is
     * what turns "two boxes" into a number of tablets. This path never asks,
     * so the batch carries neither the version nor the receipt-time snapshot
     * that every batch received the proper way carries, and nothing can later
     * say how many strips 250 tablets is.
     */
    assert.equal(batch.package_version_id, null)
    assert.equal(batch.package_snapshot, null)
    assert.equal(await scalar('select count(*)::int from jmc.goods_receipts'), 0,
      'no goods receipt, so no supplier, no invoice, and nothing to reconcile against')

    const movements = (await rows('select movement_type, quantity_delta, bucket from jmc.stock_movements'))
      .map((row) => ({ ...row }))
    assert.deepEqual(movements, [
      { movement_type: 'opening_stock', quantity_delta: 250, bucket: 'available' },
    ], 'the ledger is honest about the quantity; it is the evidence behind it that is missing')
  })

  test('and it accepts a batch that expired years ago', async () => {
    const { staff } = await counter()
    await addMedicine(staff, {
      initialQuantity: '100', batchNumber: 'OLD', expiry: '2020-01-01',
      mrp: '10', purchasePrice: '5', sellingPrice: '10',
    })

    /*
     * `post_goods_receipt` catches a mistyped year at the door
     * (inventory.ts:911-914). This path has no such check, so 100 tablets four
     * years out of date are on the shelf. They are excluded from `pickable`
     * by `batch_availability`, so they cannot be dispensed — the refusal that
     * matters clinically holds — but they are counted, valued, and have to be
     * written off by somebody who first has to notice them.
     */
    const [batch] = await rows(
      `select b.expiry::text as expiry, b.available_quantity, a.pickable
         from jmc.batches b
         join jmc.batch_availability a on a.id = b.id
        where b.batch_number = 'OLD'`)
    assert.equal(batch.expiry, '2020-01-01')
    assert.equal(batch.available_quantity, 100)
    assert.equal(batch.pickable, false)
  })
})

describe('receiving a delivery against a purchase order', () => {
  /** The order, placed — by the same command a pharmacist uses. */
  async function placedOrder(staff, supplierId) {
    const medicineId = await addMedicine(staff)
    await as(staff, 'set_supplier_medicines', { supplierId, medicineIds: [medicineId] })
    await as(staff, 'create_order', { supplierId, lines: [{ medicineId, quantity: 100 }] })
    const orderId = String(await scalar('select id from jmc.purchase_orders limit 1'))
    await as(staff, 'mark_order_sent', { orderId })
    const lineId = String(await scalar('select id from jmc.purchase_order_lines limit 1'))
    return { orderId, lineId, medicineId }
  }

  test('an order telephoned or handed over can be placed without WhatsApp connected', async () => {
    const { staff, supplierId } = await counter()
    const medicineId = await addMedicine(staff)
    await as(staff, 'set_supplier_medicines', { supplierId, medicineIds: [medicineId] })
    await as(staff, 'create_order', { supplierId, lines: [{ medicineId, quantity: 100 }] })
    const orderId = String(await scalar('select id from jmc.purchase_orders limit 1'))

    /*
     * This used to be impossible: `send_order` was the only transition from
     * `pending` to `placed` and refused without the four WHATSAPP_* variables,
     * so an order phoned in or printed could never be received against.
     * Since 26 October 2026 the order goes from the pharmacist's own WhatsApp
     * (or the phone, or paper) and `mark_order_sent` records that it went.
     */
    await as(staff, 'mark_order_sent', { orderId })
    assert.equal(await scalar('select status from jmc.purchase_orders where id=$1', [orderId]), 'placed')
  })

  test('a typed quantity is recorded as typed, with the unit it counts beside it', async () => {
    const { staff, supplierId } = await counter()
    await placedOrder(staff, supplierId)

    /*
     * Slice 3 added `order_level_name`, `order_level_count` and
     * `package_version_id` to this table
     * (supabase/migrations/20260912000000_slice3_identity_packages_stock.sql:717-719),
     * and until 26 October 2026 nothing wrote them, so "100" left the clinic
     * meaning tablets while everyone reading it thought in boxes. `create_order`
     * now fills them. This medicine has no verified package, so the order is
     * counted in its base unit, and says so.
     */
    const [line] = await rows(
      `select ordered_quantity, order_level_name, order_level_count, package_version_id
         from jmc.purchase_order_lines limit 1`)
    assert.equal(line.ordered_quantity, 100)
    assert.equal(line.order_level_name, 'tablet')
    assert.equal(line.order_level_count, 100)
    assert.equal(line.package_version_id, null)
  })

  test('the delivery is taken without a receipt, without a package, and without an expiry check', async () => {
    const { staff, supplierId } = await counter()
    const { orderId, lineId } = await placedOrder(staff, supplierId)

    await as(staff, 'receive_order', {
      orderId,
      receipts: [{
        lineId, quantity: 100, batchNumber: 'RO-1', expiry: '2020-06-30',
        mrp: '20', purchasePrice: '12', sellingPrice: '20',
      }],
    })

    const [batch] = await rows(
      `select b.expiry::text as expiry, b.available_quantity, b.package_version_id, b.package_snapshot,
              a.pickable
         from jmc.batches b
         join jmc.batch_availability a on a.id = b.id
        where b.batch_number = 'RO-1'`)
    assert.equal(batch.expiry, '2020-06-30', 'six years past, and accepted')
    assert.equal(batch.available_quantity, 100)
    assert.equal(batch.package_version_id, null)
    assert.equal(batch.package_snapshot, null)
    assert.equal(batch.pickable, false)
    assert.equal(await scalar('select count(*)::int from jmc.goods_receipts'), 0,
      'the same stock through Receiving would have a numbered GRN and the supplier invoice on it')
  })

  test('a duplicate submit is caught by a unique index, and says so in Postgres words', async () => {
    const { staff, supplierId } = await counter()
    const { orderId, lineId } = await placedOrder(staff, supplierId)
    const delivery = {
      lineId, quantity: 40, batchNumber: 'RO-1', expiry: '2027-06-30',
      mrp: '20', purchasePrice: '12', sellingPrice: '20',
    }

    await as(staff, 'receive_order', { orderId, receipts: [delivery] })
    assert.equal(await scalar('select received_quantity from jmc.purchase_order_lines limit 1'), 40)

    /*
     * There is no idempotency key on this command, so nothing recognises the
     * second submission as the first one arriving again. What stops it is
     * `batches_medicine_id_batch_number_key`, and the pharmacist is shown the
     * constraint's own words. Every other refusal in this application is a
     * sentence written for the person reading it; this one is not, because
     * nobody wrote it — it is a collision, caught late.
     */
    await assert.rejects(
      () => as(staff, 'receive_order', { orderId, receipts: [delivery] }),
      /duplicate key value violates unique constraint/,
    )
  })

  test('and retyping the batch number defeats it: forty tablets arrive, eighty are on the shelf', async () => {
    const { staff, supplierId } = await counter()
    const { orderId, lineId } = await placedOrder(staff, supplierId)
    const delivery = {
      lineId, quantity: 40, batchNumber: 'RO-1', expiry: '2027-06-30',
      mrp: '20', purchasePrice: '12', sellingPrice: '20',
    }

    await as(staff, 'receive_order', { orderId, receipts: [delivery] })
    // The same delivery, entered again with the batch number typed slightly
    // differently. The index above sees two different batches, because it is
    // an index on a string and not a record of what happened.
    await as(staff, 'receive_order', { orderId, receipts: [{ ...delivery, batchNumber: 'RO1' }] })

    assert.equal(await scalar('select received_quantity from jmc.purchase_order_lines limit 1'), 80,
      'the order believes eighty arrived against a hundred ordered')
    assert.equal(await scalar('select count(*)::int from jmc.batches'), 2)
    assert.equal(await scalar('select coalesce(sum(available_quantity),0)::int from jmc.batches'), 80,
      'and there are eighty tablets on a shelf that only ever received forty')
  })
})
