/**
 * Slice 3's exit gate: medicine identity, packages, receiving and stock.
 *
 * The list this file works through is `archive/docs/current-programme/SLICE3_CLINIC_APPROVAL_PACK.md`
 * §10 — the acceptance checks the owner's answers added — plus the invariants
 * the brief's §7 requires of every migration that touches stock.
 *
 * Everything is built through the real commands against the real schema. No
 * fixture is leaned on and no row is inserted by hand except where the point
 * of the test is that a direct write is refused.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { snapshot } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  const admin = await makeStaff({ name: 'Owner', username: 's3-admin', roles: ['admin'], pin: '4829' })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 's3-pharm', roles: ['pharmacy'], pin: '7048' })
  const doctor = await makeStaff({ name: 'Doctor', username: 's3-doc', roles: ['doctor'], pin: '5731' })
  await as(admin, 'add_supplier', {
    code: 'SUP1', name: 'Chennai Distributors', whatsapp: '+919000000001', phone: '+919000000001',
  })
  const supplierId = String(await scalar(`select id from jmc.suppliers where code='SUP1'`))
  return { admin, pharmacy, doctor, supplierId }
}

/** A product with no package yet. */
async function product(staff, { code, name, unit, saleClass = 'prescription', schedule = 'H' }) {
  await as(staff, 'add_medicine', {
    code, name, genericName: name, strength: '500 mg', dosageForm: unit, route: 'Oral',
    unit, baseUnit: unit, saleClass, schedule, reorderLevel: 10, targetStock: 1000,
  })
  return String(await scalar(`select id from jmc.medicines where code=$1`, [code]))
}

/** Build a ladder and verify it, which is what makes it receivable. */
async function verifiedPackage(staff, medicineId, baseUnit, levels, note = '') {
  const saved = await as(staff, 'save_package_version', { medicineId, baseUnit, levels, note })
  await as(staff, 'verify_package_version', {
    packageVersionId: saved.data.packageVersionId,
    verificationSource: 'physical_pack',
  })
  return saved.data
}

const TABLET_LADDER = [
  { levelName: 'tablet', levelType: 'tablet', sellable: true },
  { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
  { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
  { levelName: 'case', levelType: 'case', contains: 'box', containsCount: 20 },
]

/**
 * A jsonb column, whichever way the driver hands it over.
 *
 * `postgres` parses jsonb into an object on most paths and returns the raw
 * text on others; a test that assumes one of those is a test that passes on
 * one machine.
 */
const asJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value)

async function receive(staff, supplierId, lines, extra = {}) {
  return as(staff, 'post_goods_receipt', {
    idempotencyKey: randomUUID(), supplierId, lines, ...extra,
  })
}

// ═══════════════════════════════════════════════════════════════════════════

describe('the package ladder', () => {
  test('tablet → strip → box → case, with every conversion exact', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })

    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'tablet', levels: TABLET_LADDER,
    })
    assert.match(saved.data.summary, /1 case = 20 boxes = 200 strips = 3000 tablets/)

    const levels = await rows(
      `select level_name, depth, base_factor, child_count from jmc.package_levels
        where package_version_id=$1 order by depth`,
      [saved.data.packageVersionId],
    )
    assert.deepEqual(
      levels.map((row) => `${row.level_name}@${row.depth}=${row.base_factor}`),
      ['tablet@0=1', 'strip@1=15', 'box@2=150', 'case@3=3000'],
    )
  })

  test('a custom package type needs no database change', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'DRESS', name: 'Wound dressing', unit: 'piece' })

    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'piece',
      levels: [
        { levelName: 'piece', levelType: 'piece', sellable: true },
        { levelName: 'blister card', levelType: 'blister card', contains: 'piece', containsCount: 6, sellable: true },
        { levelName: 'dispenser', levelType: 'dispenser', contains: 'blister card', containsCount: 4 },
      ],
    })
    assert.match(saved.data.summary, /1 dispenser = 4 blister cards = 24 pieces/)
  })

  test('a bottle is a whole unit, and there is no way to configure millilitres out of it', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'SYR', name: 'Cough syrup', unit: 'bottle' })

    // The clinic answered "no" to dividing an opened container, so the base is
    // the bottle and the bottle is not breakable.
    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'bottle',
      levels: [
        { levelName: 'bottle', levelType: 'bottle', sellable: true, breakable: false, mrpBasis: true },
        { levelName: 'carton', levelType: 'carton', contains: 'bottle', containsCount: 12 },
      ],
    })
    const bottle = (await rows(
      `select breakable, base_factor from jmc.package_levels
        where package_version_id=$1 and level_name='bottle'`,
      [saved.data.packageVersionId],
    ))[0]
    assert.equal(bottle.breakable, false)
    assert.equal(Number(bottle.base_factor), 1)

    // A level counting 100 mL inside one bottle is a fraction dressed up as a
    // count, and a fractional count cannot be stored at all.
    await assert.rejects(
      as(pharmacy, 'save_package_version', {
        medicineId, baseUnit: 'millilitre',
        levels: [
          { levelName: 'millilitre', levelType: 'millilitre' },
          { levelName: 'bottle', levelType: 'bottle', contains: 'millilitre', containsCount: 0.5 },
        ],
      }),
      /whole number above zero/,
    )
  })

  test('an ampoule cannot be fractional either, at any level', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'AMP', name: 'Adrenaline', unit: 'ampoule' })
    const { packageVersionId } = await verifiedPackage(pharmacy, medicineId, 'ampoule', [
      { levelName: 'ampoule', levelType: 'ampoule', sellable: true, breakable: false, mrpBasis: true },
      { levelName: 'tray', levelType: 'tray', contains: 'ampoule', containsCount: 5 },
      { levelName: 'carton', levelType: 'carton', contains: 'tray', containsCount: 10 },
    ])

    const factors = await rows(
      `select level_name, base_factor from jmc.package_levels where package_version_id=$1 order by depth`,
      [packageVersionId],
    )
    assert.deepEqual(factors.map((row) => Number(row.base_factor)), [1, 5, 50])

    // And the column itself refuses one, whatever the command layer does.
    const levelId = String(await scalar(
      `select id from jmc.package_levels where package_version_id=$1 and level_name='ampoule'`,
      [packageVersionId],
    ))
    await assert.rejects(
      rows(
        `insert into jmc.package_levels
           (id,package_version_id,level_name,level_type,child_level_id,child_count,base_factor,depth)
         values ('half','${packageVersionId}','half ampoule','ampoule',$1,1,0.5,1)`,
        [levelId],
      ),
      /invalid input syntax|no longer a draft|numeric/i,
    )
  })
})

describe('a ladder that is not a ladder', () => {
  test('a cycle, a fork, two bases and a missing level are each refused by name', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'X1', name: 'Test', unit: 'tablet' })
    const save = (levels) => as(pharmacy, 'save_package_version', { medicineId, baseUnit: 'tablet', levels })

    await assert.rejects(save([
      { levelName: 'strip', levelType: 'strip', contains: 'box', containsCount: 10 },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10 },
    ]), /no smallest unit|one level must be the base/i)

    await assert.rejects(save([
      { levelName: 'tablet', levelType: 'tablet' },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15 },
      { levelName: 'blister', levelType: 'blister', contains: 'tablet', containsCount: 10 },
    ]), /ladder, not a fork/)

    await assert.rejects(save([
      { levelName: 'tablet', levelType: 'tablet' },
      { levelName: 'capsule', levelType: 'capsule' },
    ]), /one base unit/)

    await assert.rejects(save([
      { levelName: 'tablet', levelType: 'tablet' },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10 },
    ]), /which is not one of the levels/)

    await assert.rejects(save([
      { levelName: 'tablet', levelType: 'tablet' },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 0 },
    ]), /whole number above zero/)

    assert.equal(await scalar(`select count(*)::int from jmc.package_versions`), 0)
  })

  test('and the database refuses a wrong factor even when nothing goes through the command', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'X2', name: 'Test', unit: 'tablet' })
    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'tablet',
      levels: [{ levelName: 'tablet', levelType: 'tablet' }],
    })
    const tabletId = String(await scalar(
      `select id from jmc.package_levels where package_version_id=$1`, [saved.data.packageVersionId],
    ))

    // 10 strips of 15 is 150 tablets. 200 is somebody's typo, and it would
    // silently multiply every receipt and sale of this product.
    await assert.rejects(
      rows(
        `insert into jmc.package_levels
           (id,package_version_id,level_name,level_type,child_level_id,child_count,base_factor,depth)
         values ($1,$2,'strip','strip',$3,15,200,1)`,
        [randomUUID(), saved.data.packageVersionId, tabletId],
      ),
      /would hold 200 base units, but 15 x 1 is 15|15 x 1/,
    )
  })
})

describe('verification is what makes a conversion receivable', () => {
  test('a draft package cannot receive stock', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'tablet', levels: TABLET_LADDER,
    })

    await assert.rejects(
      receive(pharmacy, supplierId, [{
        medicineId, packageVersionId: saved.data.packageVersionId,
        entry: [{ levelName: 'box', count: 1 }],
        batchNumber: 'B1', expiry: await clinicDate(365),
        mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
      }]),
      /must be verified against the physical pack/,
    )

    // And with no verified package at all, receiving says what to do.
    await assert.rejects(
      receive(pharmacy, supplierId, [{
        medicineId, entry: [{ levelName: 'box', count: 1 }],
        batchNumber: 'B1', expiry: await clinicDate(365),
        mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
      }]),
      /no verified package/,
    )

    assert.equal(await scalar(`select count(*)::int from jmc.batches`), 0)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements`), 0)
  })

  test('a verified package is frozen — editing it is refused, in the command and at the table', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    const { packageVersionId } = await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await assert.rejects(
      as(pharmacy, 'save_package_version', {
        packageVersionId, medicineId, baseUnit: 'tablet',
        levels: [{ levelName: 'tablet', levelType: 'tablet' }],
      }),
      /Create a new version/,
    )
    await assert.rejects(
      rows(`update jmc.package_levels set child_count=10 where package_version_id=$1 and level_name='strip'`,
        [packageVersionId]),
      /no longer a draft/,
    )
    await assert.rejects(
      rows(`update jmc.package_versions set base_unit='capsule' where id=$1`, [packageVersionId]),
      /frozen/,
    )
  })
})

describe('receiving', () => {
  test('mixed package levels convert exactly, and the ledger and the shelf agree', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    // The approval pack's own example: 2 boxes + 3 strips + 4 tablets = 349.
    const result = await receive(pharmacy, supplierId, [{
      medicineId,
      entry: [
        { levelName: 'box', count: 2 },
        { levelName: 'strip', count: 3 },
        { levelName: 'tablet', count: 4 },
      ],
      previewBaseQuantity: 349,
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])

    assert.equal(result.data.baseQuantity, 349)
    assert.equal(
      Number(await scalar(`select available_quantity from jmc.batches where batch_number='PCM-A'`)),
      349,
    )
    assert.equal(
      Number(await scalar(
        `select sum(quantity_delta)::int from jmc.stock_movements where bucket='available'`,
      )),
      349,
    )
    const drift = await rows(`select batch_id from jmc.batch_ledger_reconciliation
      where available_drift <> 0 or quarantine_drift <> 0 or blocked_drift <> 0`)
    assert.deepEqual(drift.map((row) => row.batch_id), [])

    // The physical entry is kept beside the base-unit total, so a year later
    // somebody can see that it arrived as boxes rather than as 349 loose.
    const entry = asJson((await rows(`select entry_json from jmc.goods_receipt_lines`))[0].entry_json)
    assert.deepEqual(entry.accepted, [
      { levelName: 'box', count: 2 }, { levelName: 'strip', count: 3 }, { levelName: 'tablet', count: 4 },
    ])
  })

  test('a preview that disagrees with the package is refused rather than posted', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await assert.rejects(
      receive(pharmacy, supplierId, [{
        medicineId, entry: [{ levelName: 'box', count: 2 }],
        previewBaseQuantity: 200,
        batchNumber: 'PCM-A', expiry: await clinicDate(400),
        mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
      }]),
      /the screen showed 200 tablets but this package converts to 300/,
    )
    assert.equal(await scalar(`select count(*)::int from jmc.batches`), 0)
  })

  test('MRP and purchase price are stored with the package each applies to', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      // ₹30 per strip of 15, and ₹2,400 per box of 150 bought.
      mrp: 30, mrpBasisLevel: 'strip',
      purchasePrice: 2400, purchaseBasisLevel: 'box',
    }])

    const line = (await rows(`select * from jmc.goods_receipt_lines`))[0]
    assert.equal(line.mrp_amount, '30.00')
    assert.equal(line.mrp_basis_level, 'strip')
    assert.equal(Number(line.mrp_basis_factor), 15)
    assert.equal(line.purchase_amount, '2400.00')
    assert.equal(line.purchase_basis_level, 'box')
    assert.equal(Number(line.purchase_basis_factor), 150)

    // Per base unit on the batch, exactly, because that is what every reader
    // of `selling_price` and `purchase_price` already multiplies by a count.
    const batch = (await rows(`select * from jmc.batches where batch_number='PCM-A'`))[0]
    assert.equal(batch.mrp, '30.00', 'the printed figure, not a derived one')
    assert.equal(batch.mrp_basis_level, 'strip')
    assert.equal(batch.selling_price, '2.00', '₹30 per strip of 15 is ₹2 a tablet')
    assert.equal(batch.purchase_price, '16.00', '₹2400 per box of 150 is ₹16 a tablet')
    assert.equal(line.line_total, '2400.00')
  })

  test('free quantity goes on the shelf and is not charged for', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await receive(pharmacy, supplierId, [{
      medicineId,
      entry: [{ levelName: 'box', count: 1 }],
      free: [{ levelName: 'strip', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])

    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 165)
    const line = (await rows(`select * from jmc.goods_receipt_lines`))[0]
    assert.equal(Number(line.accepted_base_quantity), 150)
    assert.equal(Number(line.free_base_quantity), 15)
    // 150 tablets at ₹18 per strip of 15 = ₹180. The free strip adds nothing.
    assert.equal(line.line_total, '180.00')
  })

  test('quarantined and rejected quantities are separated from the sellable shelf', async () => {
    const { admin, pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await receive(pharmacy, supplierId, [{
      medicineId,
      entry: [{ levelName: 'box', count: 1 }],
      quarantined: [{ levelName: 'strip', count: 2 }],
      quarantineReason: 'Strips crushed in transit',
      rejected: [{ levelName: 'strip', count: 1 }],
      rejectionReason: 'Torn foil, refused at the door',
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])

    const stock = (await rows(`select * from jmc.medicine_stock where medicine_id=$1`, [medicineId]))[0]
    assert.equal(Number(stock.sellable_base_quantity), 150)
    assert.equal(Number(stock.quarantined_base_quantity), 30)

    // Rejected stock never entered: no batch quantity, no ledger row.
    assert.equal(Number(await scalar(
      `select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements where movement_type like 'reject%'`,
    )), 0)
    assert.equal(Number((await rows(`select * from jmc.goods_receipt_lines`))[0].rejected_base_quantity), 15)

    // A pharmacist may not put quarantined stock back on the shelf alone.
    const batchId = String(await scalar(`select id from jmc.batches`))
    await assert.rejects(
      as(pharmacy, 'adjust_stock', {
        batchId, from: 'quarantine', to: 'available', quantity: 30, reason: 'Looks fine to me',
      }),
      /role cannot perform/,
    )
    await as(admin, 'adjust_stock', {
      batchId, from: 'quarantine', to: 'available', quantity: 30,
      reason: 'Supplier confirmed the crushing was to the outer carton only',
    })
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 180)
    assert.equal(Number(await scalar(`select quarantined_quantity from jmc.batches`)), 0)
    assert.equal(
      await scalar(`select approved_by from jmc.stock_movements where movement_type='adjust_in_available'`),
      admin.id,
    )
  })

  test('a rejection with no reason, and an expired batch, are both refused', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    const line = async (extra) => ({
      medicineId, entry: [{ levelName: 'strip', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip', ...extra,
    })

    await assert.rejects(
      receive(pharmacy, supplierId, [await line({ rejected: [{ levelName: 'strip', count: 1 }] })]),
      /say why the rejected quantity was refused/,
    )
    await assert.rejects(
      receive(pharmacy, supplierId, [await line({ expiry: await clinicDate(-1) })]),
      /Expired stock is not received/,
    )
    assert.equal(await scalar(`select count(*)::int from jmc.batches`), 0)
  })

  test('a retried receipt adds the delivery once', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    const key = randomUUID()
    const line = {
      medicineId, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }
    const first = await as(pharmacy, 'post_goods_receipt', { idempotencyKey: key, supplierId, lines: [line] })
    const again = await as(pharmacy, 'post_goods_receipt', { idempotencyKey: key, supplierId, lines: [line] })

    assert.equal(again.data.duplicate, true)
    assert.equal(again.data.grnNumber, first.data.grnNumber)
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 150)
    assert.equal(await scalar(`select count(*)::int from jmc.goods_receipts`), 1)
  })

  test('a purchase order adds no stock; the receipt against it does, in parts', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    const order = await as(pharmacy, 'create_order', {
      supplierId, lines: [{ medicineId, quantity: 300 }],
    })
    assert.equal(Number(await scalar(`select coalesce(sum(available_quantity),0)::int from jmc.batches`)), 0)

    // Sending the order is a WhatsApp call, which staging has no credentials
    // for and must not make. The status it would set is what receiving checks,
    // so it is set here directly; the send path itself is covered by the
    // supplier-order tests.
    await rows(`update jmc.purchase_orders set status='placed', placed_at=now()::text where id=$1`,
      [order.data.orderId])
    const orderLineId = String(await scalar(
      `select id from jmc.purchase_order_lines where order_id=$1`, [order.data.orderId],
    ))

    const common = {
      medicineId, purchaseOrderLineId: orderLineId,
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }
    await receive(pharmacy, supplierId, [{
      ...common, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
    }], { purchaseOrderId: order.data.orderId })
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [order.data.orderId]),
      'partially_delivered')

    await receive(pharmacy, supplierId, [{
      ...common, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-B', expiry: await clinicDate(500),
    }], { purchaseOrderId: order.data.orderId })
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [order.data.orderId]),
      'delivered')

    // And one more box would be past what was ordered.
    await assert.rejects(
      receive(pharmacy, supplierId, [{
        ...common, entry: [{ levelName: 'box', count: 1 }],
        batchNumber: 'PCM-C', expiry: await clinicDate(500),
      }], { purchaseOrderId: order.data.orderId }),
      /not awaiting delivery|past the 300 ordered/,
    )
  })
})

describe('a pack size that changes', () => {
  test('a new version is created, and both batches keep counting the way they arrived', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 2 }],
      batchNumber: 'OLD-15', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches where batch_number='OLD-15'`)), 30)

    // The manufacturer moves to ten tablets a strip.
    const v2 = await verifiedPackage(pharmacy, medicineId, 'tablet', [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 10, sellable: true, mrpBasis: true },
      { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
    ], 'Manufacturer reduced the strip to ten')
    assert.equal(v2.version, 2)

    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 2 }],
      batchNumber: 'NEW-10', expiry: await clinicDate(500),
      mrp: 22, mrpBasisLevel: 'strip', purchasePrice: 13, purchaseBasisLevel: 'strip',
    }])
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches where batch_number='NEW-10'`)), 20)

    // Both coexist. The old batch still says a strip is fifteen, for ever.
    const snapshots = await rows(
      `select batch_number,
              (package_snapshot->'levels') as levels
         from jmc.batches order by batch_number`,
    )
    const stripFactor = (row) => asJson(row.levels).find((level) => level.levelName === 'strip').baseFactor
    assert.equal(stripFactor(snapshots.find((row) => row.batch_number === 'NEW-10')), 10)
    assert.equal(stripFactor(snapshots.find((row) => row.batch_number === 'OLD-15')), 15)

    // 50 tablets combined, and no attempt is made to express that as strips.
    const stock = (await rows(`select * from jmc.medicine_stock where medicine_id=$1`, [medicineId]))[0]
    assert.equal(Number(stock.sellable_base_quantity), 50)
    assert.equal(stock.base_unit, 'tablet')

    // History did not move: the earlier receipt still reads 30 tablets.
    assert.equal(
      Number(await scalar(
        `select sum(quantity_delta)::int from jmc.stock_movements m
           join jmc.batches b on b.id=m.batch_id where b.batch_number='OLD-15'`,
      )),
      30,
    )
  })
})

describe('barcodes', () => {
  test('each package level gets its own code, and a plain barcode never names a batch', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    await as(pharmacy, 'map_barcode', {
      medicineId, levelName: 'strip', code: '8901234567890', symbology: 'ean13',
    })
    await as(pharmacy, 'map_barcode', {
      medicineId, levelName: 'box', code: '18901234567897', symbology: 'itf14',
    })

    const mapped = await rows(`select code, level_name, carries_batch from jmc.medicine_barcodes order by level_name`)
    assert.deepEqual(mapped.map((row) => `${row.level_name}:${row.code}:${row.carries_batch}`), [
      'box:18901234567897:false', 'strip:8901234567890:false',
    ])

    // Claiming an EAN-13 carries a batch is refused: batch and expiry live in
    // GS1 AIs (10) and (17), which only a GS1-128, DataMatrix or QR carries.
    await assert.rejects(
      as(pharmacy, 'map_barcode', {
        medicineId, levelName: 'strip', code: '8901234567777', symbology: 'ean13', carriesBatch: true,
      }),
      /Only a GS1-128, DataMatrix or QR payload can carry a batch/,
    )
    await as(pharmacy, 'map_barcode', {
      medicineId, levelName: 'strip', code: '0108901234567890172609301012345',
      symbology: 'gs1_datamatrix', carriesBatch: true,
    })
    assert.equal(await scalar(
      `select carries_batch from jmc.medicine_barcodes where symbology='gs1_datamatrix'`), true)
  })

  test('one code cannot mean two medicines', async () => {
    const { pharmacy } = await clinic()
    const first = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    const second = await product(pharmacy, { code: 'AZI', name: 'Azithromycin', unit: 'tablet' })
    await verifiedPackage(pharmacy, first, 'tablet', TABLET_LADDER)
    await verifiedPackage(pharmacy, second, 'tablet', TABLET_LADDER)

    await as(pharmacy, 'map_barcode', { medicineId: first, levelName: 'strip', code: '8901111111111' })
    await assert.rejects(
      as(pharmacy, 'map_barcode', { medicineId: second, levelName: 'strip', code: '8901111111111' }),
      /already mapped to Paracetamol/,
    )
  })

  test('an unknown scan becomes a queue rather than an error nobody sees', async () => {
    const { admin, pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)

    const result = await as(pharmacy, 'record_unknown_barcode', { code: '5099999999999' })
    assert.match(result.message, /Search by name/)
    await as(pharmacy, 'record_unknown_barcode', { code: '5099999999999' })

    const queued = (await rows(`select * from jmc.unmapped_barcodes`))[0]
    assert.equal(Number(queued.seen_count), 2)
    assert.equal(queued.resolved_at, null)

    await as(admin, 'map_barcode', { medicineId, levelName: 'strip', code: '5099999999999' })
    assert.notEqual(await scalar(`select resolved_at from jmc.unmapped_barcodes`), null)
  })
})

describe('regulatory classification', () => {
  test('an existing medicine stays Unknown until a pharmacist classifies and verifies it', async () => {
    const { pharmacy } = await clinic()
    await as(pharmacy, 'add_medicine', {
      code: 'OLD1', name: 'Something old', unit: 'tablet', saleClass: 'otc',
      reorderLevel: 1, targetStock: 10,
    })
    const medicineId = String(await scalar(`select id from jmc.medicines where code='OLD1'`))
    assert.equal(await scalar(`select schedule from jmc.medicines where id=$1`, [medicineId]), 'unset')

    await assert.rejects(
      as(pharmacy, 'classify_medicine', { medicineId, schedule: 'H1' }),
      /Say where this classification comes from/,
    )
    await assert.rejects(
      as(pharmacy, 'classify_medicine', { medicineId, schedule: 'unset', verified: true }),
      /cannot be verified/,
    )

    const pending = await as(pharmacy, 'classify_medicine', {
      medicineId, schedule: 'H1', source: 'Schedule H1 list on the pack',
    })
    assert.match(pending.message, /must verify it/)
    assert.equal(await scalar(`select schedule_verified_at from jmc.medicines where id=$1`, [medicineId]), null)

    await as(pharmacy, 'classify_medicine', {
      medicineId, schedule: 'H1', source: 'Schedule H1 list on the pack', verified: true,
    })
    const row = (await rows(`select * from jmc.medicines where id=$1`, [medicineId]))[0]
    assert.equal(row.schedule, 'H1')
    assert.equal(row.schedule_verified_by, pharmacy.id)
    assert.notEqual(row.schedule_verified_at, null)
  })

  test('the classification is never inferred from the selling rule', async () => {
    const { pharmacy } = await clinic()
    await as(pharmacy, 'add_medicine', {
      code: 'R1', name: 'Restricted thing', unit: 'tablet', saleClass: 'restricted',
      reorderLevel: 1, targetStock: 10,
    })
    // `restricted` could be H1 or X, and a register that guesses is a register
    // an inspector can fault in both directions.
    assert.equal(await scalar(`select schedule from jmc.medicines where code='R1'`), 'unset')
  })
})

describe('the blind opening count', () => {
  async function countable() {
    const context = await clinic()
    const medicineId = await product(context.pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(context.pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(context.pharmacy, context.supplierId, [{
      medicineId, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches where batch_number='PCM-A'`))
    return { ...context, medicineId, batchId }
  }

  test('the counter cannot see what the software expects — the number is not written yet', async () => {
    const { pharmacy, batchId } = await countable()
    await as(pharmacy, 'start_opening_count', { note: 'After closing' })

    await as(pharmacy, 'record_opening_count', {
      batchId, entry: [{ levelName: 'strip', count: 9 }, { levelName: 'tablet', count: 7 }],
    })

    const entry = (await rows(`select * from jmc.opening_count_entries`))[0]
    assert.equal(Number(entry.counted_base_quantity), 142)
    assert.equal(entry.expected_base_quantity, null, 'blind is structural, not a UI promise')
    assert.equal(entry.variance, null)
  })

  test('submitting writes the expected figures; only then is there a variance to review', async () => {
    const { admin, pharmacy, batchId } = await countable()
    await as(pharmacy, 'start_opening_count', {})
    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 142 })

    const submitted = await as(pharmacy, 'submit_opening_count', {})
    assert.equal(submitted.data.counted, 1)
    assert.equal(submitted.data.variances, 1)

    const entry = (await rows(`select * from jmc.opening_count_entries`))[0]
    assert.equal(Number(entry.expected_base_quantity), 150)
    assert.equal(Number(entry.variance), -8)
    // ₹18 per strip of 15 is ₹1.20 a tablet, so eight missing tablets is ₹9.60.
    // The value is what the variance COST, which is why it uses the purchase
    // price and its basis rather than the MRP.
    assert.equal(entry.variance_value, '9.60')

    // Nothing has moved yet: reviewing is not posting.
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 150)

    await assert.rejects(as(admin, 'approve_opening_count', {}), /have not been reviewed/)
    await as(admin, 'review_opening_count_entry', {
      entryId: entry.id, decision: 'approve', note: 'Counted twice, shelf agrees',
    })
    const approved = await as(admin, 'approve_opening_count', {})
    assert.equal(approved.data.posted, 1)

    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 142)
    const movement = (await rows(
      `select * from jmc.stock_movements where movement_type='opening_count'`,
    ))[0]
    assert.equal(Number(movement.quantity_delta), -8)
    assert.equal(movement.approved_by, admin.id)
    const drift = await rows(`select batch_id from jmc.batch_ledger_reconciliation where available_drift <> 0`)
    assert.deepEqual(drift.map((row) => row.batch_id), [])
  })

  test('a recount replaces the earlier attempt without erasing it', async () => {
    const { admin, pharmacy, batchId } = await countable()
    await as(pharmacy, 'start_opening_count', {})
    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 100 })
    await as(pharmacy, 'submit_opening_count', {})

    const first = (await rows(`select * from jmc.opening_count_entries`))[0]
    await as(admin, 'review_opening_count_entry', {
      entryId: first.id, decision: 'recount', note: 'Fifty tablets missing — count it again',
    })
    assert.equal(await scalar(`select status from jmc.opening_counts`), 'recount')

    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 149 })
    await as(pharmacy, 'submit_opening_count', {})
    const attempts = await rows(`select attempt, counted_base_quantity from jmc.opening_count_entries order by attempt`)
    assert.deepEqual(attempts.map((row) => `${row.attempt}:${row.counted_base_quantity}`), ['1:100', '2:149'])

    const second = (await rows(`select * from jmc.opening_count_entries where attempt=2`))[0]
    await as(admin, 'review_opening_count_entry', { entryId: second.id, decision: 'approve' })
    await as(admin, 'approve_opening_count', {})

    // The newest attempt is what posts; the first is still on the record.
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 149)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements where movement_type='opening_count'`), 1)
  })

  test('"counted zero" and "not counted" are different facts', async () => {
    const { pharmacy, batchId } = await countable()
    await as(pharmacy, 'start_opening_count', {})

    await assert.rejects(
      as(pharmacy, 'record_opening_count', { batchId }),
      /Enter what you counted, or mark the batch as counted zero/,
    )
    assert.equal(await scalar(`select count(*)::int from jmc.opening_count_entries`), 0)

    await as(pharmacy, 'record_opening_count', { batchId, countedZero: true })
    assert.equal(Number(await scalar(`select counted_base_quantity from jmc.opening_count_entries`)), 0)
  })

  test('only an admin reviews and approves, and an abandoned count posts nothing', async () => {
    const { admin, pharmacy, batchId } = await countable()
    await as(pharmacy, 'start_opening_count', {})
    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 120 })
    await as(pharmacy, 'submit_opening_count', {})
    const entry = (await rows(`select * from jmc.opening_count_entries`))[0]

    await assert.rejects(
      as(pharmacy, 'review_opening_count_entry', { entryId: entry.id, decision: 'approve' }),
      /role cannot perform/,
    )
    await assert.rejects(as(pharmacy, 'approve_opening_count', {}), /role cannot perform/)

    await as(admin, 'abandon_opening_count', { reason: 'Counted during trading hours by mistake' })
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 150)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements where movement_type='opening_count'`), 0)
    assert.equal(await scalar(`select count(*)::int from jmc.opening_count_entries`), 1,
      'the physical count is kept even when it is not posted')
  })
})

describe('the ledger is the truth', () => {
  test('stock cannot go negative, and a movement cannot be edited or deleted', async () => {
    const { admin, pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches`))

    await assert.rejects(
      as(admin, 'adjust_stock', { batchId, from: 'available', to: 'none', quantity: 16, reason: 'Damaged' }),
      /Stock changed on another tablet|not that much/,
    )
    assert.equal(Number(await scalar(`select available_quantity from jmc.batches`)), 15)

    await assert.rejects(
      rows(`update jmc.stock_movements set quantity_delta = 999`),
      /append-only/,
    )
    await assert.rejects(rows(`delete from jmc.stock_movements`), /append-only/)
    await assert.rejects(
      rows(`update jmc.batches set available_quantity = -1 where id=$1`, [batchId]),
      /violates check constraint/,
    )
  })

  test('what arrived on a batch cannot be rewritten afterwards', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches`))

    await assert.rejects(
      rows(`update jmc.batches set expiry='2099-01-01' where id=$1`, [batchId]),
      /what arrived/,
    )
    await assert.rejects(
      rows(`update jmc.batches set package_snapshot='{"baseUnit":"tablet","levels":[]}'::jsonb where id=$1`, [batchId]),
      /cannot be rewritten/,
    )
    await assert.rejects(
      rows(`update jmc.batches set mrp_basis_factor=1 where id=$1`, [batchId]),
      /printed MRP applies to/,
    )
    await assert.rejects(rows(`delete from jmc.batches where id=$1`, [batchId]), /cannot be deleted/)
  })

  test('a recalled batch stays on the shelf to be counted, and is refused to the counter', async () => {
    const { admin, pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 2 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches`))

    await as(pharmacy, 'set_batch_status', {
      batchId, status: 'recalled', reason: 'Manufacturer recall notice 2026/114',
    })

    const availability = (await rows(`select * from jmc.batch_availability where id=$1`, [batchId]))[0]
    assert.equal(availability.pickable, false)
    assert.equal(Number(availability.available_quantity), 30, 'the boxes are still physically there')

    const stock = (await rows(`select * from jmc.medicine_stock where medicine_id=$1`, [medicineId]))[0]
    assert.equal(Number(stock.sellable_base_quantity), 0)
    assert.equal(Number(stock.unavailable_base_quantity), 30)

    // Only an admin lifts it.
    await assert.rejects(
      as(pharmacy, 'set_batch_status', { batchId, status: 'active', reason: 'Looks fine' }),
      /role cannot perform/,
    )
    await as(admin, 'set_batch_status', {
      batchId, status: 'active', reason: 'Recall withdrawn — different lot range',
    })
    assert.equal(
      (await rows(`select pickable from jmc.batch_availability where id=$1`, [batchId]))[0].pickable,
      true,
    )
  })

  test('every batch reconciles to the ledger after a full day of movements', async () => {
    const { admin, pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'box', count: 1 }],
      quarantined: [{ levelName: 'strip', count: 1 }],
      quarantineReason: 'Held for inspection',
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches`))

    await as(admin, 'adjust_stock', { batchId, from: 'quarantine', to: 'available', quantity: 10, reason: 'Cleared' })
    await as(pharmacy, 'adjust_stock', { batchId, from: 'available', to: 'blocked', quantity: 20, reason: 'Set aside for the recall audit' })
    await as(pharmacy, 'adjust_stock', { batchId, from: 'quarantine', to: 'none', quantity: 5, reason: 'Destroyed, foil torn' })

    const row = (await rows(`select * from jmc.batch_ledger_reconciliation where batch_id=$1`, [batchId]))[0]
    assert.equal(Number(row.available_drift), 0)
    assert.equal(Number(row.quarantine_drift), 0)
    assert.equal(Number(row.blocked_drift), 0)
    assert.equal(Number(row.available_quantity), 140)
    assert.equal(Number(row.quarantined_quantity), 0)
    assert.equal(Number(row.blocked_quantity), 20)
  })
})

describe('clinical identity stays above the inventory line', () => {
  test('a substance is deduplicated, and a clinical drug is keyed on what it actually is', async () => {
    const { pharmacy } = await clinic()

    const first = await as(pharmacy, 'save_substance', { name: 'Paracetamol' })
    const again = await as(pharmacy, 'save_substance', { name: '  paracetamol  ' })
    assert.equal(again.data.substanceId, first.data.substanceId)
    assert.equal(again.data.created, false)
    assert.equal(await scalar(`select count(*)::int from jmc.substances`), 1)

    const drug = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral', releaseType: 'immediate',
      ingredients: [{ substanceId: first.data.substanceId, strengthValue: 500, strengthUnit: 'mg' }],
    })
    assert.equal(await scalar(`select display_name from jmc.clinical_drugs`), 'Paracetamol 500 mg tablet')

    // Same drug typed again is one row...
    const repeat = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'oral', releaseType: 'Immediate',
      ingredients: [{ substanceId: first.data.substanceId, strengthValue: 500, strengthUnit: 'MG' }],
    })
    assert.equal(repeat.data.clinicalDrugId, drug.data.clinicalDrugId)

    // ...and a different strength is never the same row.
    const stronger = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral', releaseType: 'immediate',
      ingredients: [{ substanceId: first.data.substanceId, strengthValue: 650, strengthUnit: 'mg' }],
    })
    assert.notEqual(stronger.data.clinicalDrugId, drug.data.clinicalDrugId)
    assert.equal(await scalar(`select count(*)::int from jmc.clinical_drugs`), 2)
  })

  test('a combination product keeps both strengths, and the order they were typed does not matter', async () => {
    const { pharmacy } = await clinic()
    const amox = await as(pharmacy, 'save_substance', { name: 'Amoxicillin' })
    const clav = await as(pharmacy, 'save_substance', { name: 'Clavulanic acid' })

    const one = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [
        { substanceId: amox.data.substanceId, strengthValue: 500, strengthUnit: 'mg' },
        { substanceId: clav.data.substanceId, strengthValue: 125, strengthUnit: 'mg' },
      ],
    })
    const other = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [
        { substanceId: clav.data.substanceId, strengthValue: 125, strengthUnit: 'mg' },
        { substanceId: amox.data.substanceId, strengthValue: 500, strengthUnit: 'mg' },
      ],
    })
    assert.equal(other.data.clinicalDrugId, one.data.clinicalDrugId)
    assert.equal(await scalar(`select count(*)::int from jmc.clinical_drug_ingredients`), 2)
  })

  test('a suspension keeps its concentration as a numerator and a denominator, not a string', async () => {
    const { pharmacy } = await clinic()
    const substance = await as(pharmacy, 'save_substance', { name: 'Amoxicillin' })
    await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'oral suspension', route: 'Oral',
      ingredients: [{
        substanceId: substance.data.substanceId,
        strengthValue: 125, strengthUnit: 'mg', perValue: 5, perUnit: 'mL',
      }],
    })
    const row = (await rows(`select * from jmc.clinical_drug_ingredients`))[0]
    assert.equal(Number(row.strength_value), 125)
    assert.equal(row.strength_unit, 'mg')
    assert.equal(Number(row.per_value), 5)
    assert.equal(row.per_unit, 'mL')

    // Half a "per" is not a concentration.
    await assert.rejects(
      as(pharmacy, 'save_clinical_drug', {
        dosageForm: 'oral suspension',
        ingredients: [{
          substanceId: substance.data.substanceId, strengthValue: 125, strengthUnit: 'mg', perValue: 5,
        }],
      }),
      /both a "per" amount and its unit/,
    )
  })

  test('a product is linked to its clinical drug rather than guessed into one', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'CAL', name: 'Calpol', unit: 'tablet' })
    assert.equal(await scalar(`select clinical_drug_id from jmc.medicines where id=$1`, [medicineId]), null)

    const substance = await as(pharmacy, 'save_substance', { name: 'Paracetamol' })
    const drug = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [{ substanceId: substance.data.substanceId, strengthValue: 500, strengthUnit: 'mg' }],
    })
    await as(pharmacy, 'link_medicine_identity', {
      medicineId, clinicalDrugId: drug.data.clinicalDrugId,
      brandName: 'Calpol', manufacturer: 'GSK',
    })
    const row = (await rows(`select * from jmc.medicines where id=$1`, [medicineId]))[0]
    assert.equal(row.clinical_drug_id, drug.data.clinicalDrugId)
    assert.equal(row.brand_name, 'Calpol')
    assert.equal(row.manufacturer, 'GSK')
  })

  test('the base unit cannot change while stock is counted in the old one', async () => {
    const { pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'strip', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])

    await assert.rejects(
      as(pharmacy, 'link_medicine_identity', { medicineId, baseUnit: 'capsule' }),
      /cannot change while any is on the shelf/,
    )
    await assert.rejects(
      as(pharmacy, 'save_package_version', {
        medicineId, baseUnit: 'capsule', levels: [{ levelName: 'capsule', levelType: 'capsule' }],
      }),
      /must use the same base unit/,
    )
  })
})

describe('who may touch the catalogue', () => {
  test('pharmacist and admin may; a doctor and a nurse may not', async () => {
    const { admin, pharmacy, doctor } = await clinic()
    const nurse = await makeStaff({ name: 'Nurse', username: 's3-nurse', roles: ['nurse'], pin: '6182' })

    for (const staff of [doctor, nurse]) {
      await assert.rejects(as(staff, 'save_substance', { name: 'Paracetamol' }), /role cannot perform/)
      await assert.rejects(
        as(staff, 'save_package_version', {
          medicineId: 'x', baseUnit: 'tablet', levels: [{ levelName: 'tablet', levelType: 'tablet' }],
        }),
        /role cannot perform/,
      )
      await assert.rejects(as(staff, 'classify_medicine', { medicineId: 'x', schedule: 'H' }), /role cannot perform/)
      await assert.rejects(
        as(staff, 'post_goods_receipt', { idempotencyKey: 'k', supplierId: 's', lines: [{}] }),
        /role cannot perform/,
      )
    }

    // And both of the roles that may, do.
    for (const staff of [admin, pharmacy]) {
      const result = await as(staff, 'save_substance', { name: `Substance ${staff.id}` })
      assert.ok(result.data.substanceId)
    }
  })
})

describe('the shape of the schema Slice 4 will build on', () => {
  test('every foreign key has an index that supports it', async () => {
    await resetClinic()
    const missing = await rows(`
      select c.conrelid::regclass::text as child, c.conname
        from pg_constraint c
       where c.contype = 'f'
         and c.connamespace = 'jmc'::regnamespace
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] = c.conkey
         )
       order by 1, 2`)
    assert.deepEqual(missing.map((row) => `${row.child}.${row.conname}`), [])
  })

  test('the new tables carry row security, unforced, and no Data API role can reach them', async () => {
    await resetClinic()
    const forced = await rows(`
      select relname from pg_class
       where relnamespace = 'jmc'::regnamespace and relkind = 'r' and relrowsecurity and relforcerowsecurity`)
    assert.deepEqual(forced.map((row) => row.relname), [])

    const unprotected = await rows(`
      select relname from pg_class
       where relnamespace = 'jmc'::regnamespace and relkind = 'r' and not relrowsecurity`)
    assert.deepEqual(unprotected.map((row) => row.relname), [])

    const granted = await rows(`
      select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_schema='jmc' and grantee in ('anon','authenticated','service_role','PUBLIC')`)
    assert.deepEqual(granted.map((row) => `${row.table_name}.${row.privilege_type} to ${row.grantee}`), [])
  })

  test('every view over protected data is security_invoker', async () => {
    await resetClinic()
    const leaky = await rows(`
      select c.relname from pg_class c
       where c.relnamespace = 'jmc'::regnamespace and c.relkind = 'v'
         and coalesce((select option_value from pg_options_to_table(c.reloptions)
                        where option_name = 'security_invoker'), 'false') <> 'true'`)
    assert.deepEqual(leaky.map((row) => row.relname), [])
  })
})

/**
 * The gaps the Slice 3 UI review found in this contract.
 *
 * Each was a place where the screen was the only thing standing between a
 * staff member and something they should not see, or a fact the database held
 * and the application could not say. A rule the UI enforces alone is a rule
 * one refactor away from not existing.
 */
describe('what the snapshot is allowed to say', () => {
  test('a count still being counted carries no expected figure, whatever the screen does', async () => {
    const { admin, pharmacy, supplierId } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await receive(pharmacy, supplierId, [{
      medicineId, entry: [{ levelName: 'box', count: 1 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }])
    const batchId = String(await scalar(`select id from jmc.batches`))

    await as(pharmacy, 'start_opening_count', {})
    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 120 })

    const counting = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.equal(counting.openingCount.status, 'counting')
    assert.equal(counting.openingCount.entries[0].expectedBaseQuantity, null)
    assert.equal(counting.openingCount.entries[0].variance, null)

    await as(pharmacy, 'submit_opening_count', {})
    const submitted = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.equal(Number(submitted.openingCount.entries[0].expectedBaseQuantity), 150)
    assert.equal(Number(submitted.openingCount.entries[0].variance), -30)

    // Sent back for a recount, and the figure goes away again — including on
    // the attempt that was already reviewed. Otherwise the second count is
    // taken with the first count's variance on the screen, which is not a
    // recount, it is a confirmation.
    const entryId = submitted.openingCount.entries[0].id
    await as(admin, 'review_opening_count_entry', {
      entryId, decision: 'recount', note: 'Thirty tablets is two strips; count it again',
    })
    const recount = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.equal(recount.openingCount.status, 'recount')
    // The reviewed row does not come back at all. Its expected figure would be
    // hidden anyway, but the pharmacist's own earlier count is just as
    // anchoring — "you said 120 last time" is an invitation to agree with
    // yourself rather than to count.
    assert.deepEqual(recount.openingCount.entries, [])

    // The second attempt appears as it is entered, and still says nothing
    // about what the software expects.
    await as(pharmacy, 'record_opening_count', { batchId, baseQuantity: 149 })
    const counting2 = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.equal(counting2.openingCount.entries.length, 1)
    assert.equal(Number(counting2.openingCount.entries[0].countedBaseQuantity), 149)
    assert.equal(counting2.openingCount.entries[0].expectedBaseQuantity, null)

    // And every figure is still in the table, because the audit needs them.
    assert.deepEqual(
      (await rows(`select attempt, counted_base_quantity,
                          coalesce(expected_base_quantity::text, 'not yet') as expected
                     from jmc.opening_count_entries order by attempt`))
        .map((row) => `${row.attempt}:${row.counted_base_quantity}:${row.expected}`),
      ['1:120:150', '2:149:not yet'],
    )
  })

  test('a mapped code reaches the screen, so a clash can be seen before it is refused', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await as(pharmacy, 'map_barcode', {
      medicineId, levelName: 'strip', code: '8901234567890', symbology: 'ean13',
    })

    const shelf = await snapshot.readSnapshot(sessionFor(pharmacy))
    assert.deepEqual(
      shelf.medicineBarcodes.map((row) => `${row.code}:${row.levelName}:${row.carriesBatch}`),
      ['8901234567890:strip:false'],
    )

    // A nurse has no shelf station and is given none of it.
    const nurse = await makeStaff({ name: 'Nurse', username: 's3-nurse-2', roles: ['nurse'], pin: '6182' })
    const atTheDesk = await snapshot.readSnapshot(sessionFor(nurse))
    assert.deepEqual(atTheDesk.medicineBarcodes, [])
  })

  test('a retired package version is shown as retired rather than simply gone', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'PCM', name: 'Paracetamol', unit: 'tablet' })
    const { packageVersionId } = await verifiedPackage(pharmacy, medicineId, 'tablet', TABLET_LADDER)
    await as(pharmacy, 'retire_package_version', {
      packageVersionId, reason: 'Manufacturer discontinued this pack',
    })

    const shelf = await snapshot.readSnapshot(sessionFor(pharmacy))
    const version = shelf.packages.find((row) => row.id === packageVersionId)
    assert.ok(version, 'a retired version is still part of the record')
    assert.equal(version.status, 'retired')

    // And nothing can be received against it any more.
    const medicine = shelf.medicines.find((row) => row.id === medicineId)
    assert.equal(medicine.activePackageVersionId, undefined)
  })

  test('a wrong identity link can be cleared, not only replaced', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'CAL', name: 'Calpol', unit: 'tablet' })
    const substance = await as(pharmacy, 'save_substance', { name: 'Paracetamol' })
    const drug = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [{ substanceId: substance.data.substanceId, strengthValue: 500, strengthUnit: 'mg' }],
    })

    await as(pharmacy, 'link_medicine_identity', {
      medicineId, clinicalDrugId: drug.data.clinicalDrugId, brandName: 'Calpol', manufacturer: 'GSK',
    })
    await assert.rejects(
      as(pharmacy, 'link_medicine_identity', {
        medicineId, clinicalDrugId: drug.data.clinicalDrugId, clear: ['clinicalDrugId'],
      }),
      /not both/,
    )
    await assert.rejects(
      as(pharmacy, 'link_medicine_identity', { medicineId, clear: ['baseUnit'] }),
      /cannot be cleared/,
    )

    await as(pharmacy, 'link_medicine_identity', {
      medicineId, clear: ['clinicalDrugId', 'manufacturer'],
    })
    const row = (await rows(`select * from jmc.medicines where id=$1`, [medicineId]))[0]
    assert.equal(row.clinical_drug_id, null)
    assert.equal(row.manufacturer, '')
    assert.equal(row.brand_name, 'Calpol', 'what was not cleared is untouched')
  })

  test('a classification the command accepts is a classification the type allows', async () => {
    const { pharmacy } = await clinic()
    const medicineId = await product(pharmacy, { code: 'G1', name: 'Something Schedule G', unit: 'tablet' })
    await as(pharmacy, 'classify_medicine', {
      medicineId, schedule: 'G', source: 'Schedule G warning printed on the carton', verified: true,
    })
    const shelf = await snapshot.readSnapshot(sessionFor(pharmacy))
    const medicine = shelf.medicines.find((row) => row.id === medicineId)
    assert.equal(medicine.schedule, 'G')
    assert.equal(medicine.scheduleVerified, true)
  })
})
