/**
 * The inventory reads that are deliberately not in the poll.
 *
 * `docs/CLAUDE_IMPLEMENTATION_BRIEF.md` §3 keeps stock ledgers and receipt
 * history out of the whole-clinic snapshot, so they live behind
 * `supabase/functions/inventory/index.ts`. That is an Edge Function rather
 * than a shared module, and until now nothing in the database suite could
 * reach one — which meant the on-demand half of the application was covered by
 * a browser journey or by nothing.
 *
 * `edgeGet` loads the real handler and calls it with a real session token, so
 * what is exercised here is the real authorization check and the real SQL.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { edgeGet } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, scalar, tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

const LADDER = [
  { levelName: 'tablet', levelType: 'tablet', sellable: true },
  { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
  { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
]

/** A clinic with one product, one verified package and one delivery. */
async function stockedClinic() {
  await resetClinic()
  const admin = await makeStaff({ name: 'Owner', username: 'inv-admin', roles: ['admin'], pin: '4829' })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 'inv-pharm', roles: ['pharmacy'], pin: '7048' })
  const nurse = await makeStaff({ name: 'Nurse', username: 'inv-nurse', roles: ['nurse'], pin: '6182' })

  await as(admin, 'add_supplier', {
    code: 'SUP1', name: 'Chennai Distributors',
    whatsapp: '+919000000001', phone: '+919000000001',
  })
  const supplierId = String(await scalar(`select id from jmc.suppliers where code='SUP1'`))

  await as(pharmacy, 'add_medicine', {
    code: 'PCM', name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 1000,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='PCM'`))

  const pack = await as(pharmacy, 'save_package_version', {
    medicineId, baseUnit: 'tablet', levels: LADDER,
  })
  await as(pharmacy, 'verify_package_version', {
    packageVersionId: pack.data.packageVersionId, verificationSource: 'physical_pack',
  })

  await as(pharmacy, 'post_goods_receipt', {
    idempotencyKey: randomUUID(), supplierId,
    supplierInvoiceNumber: 'INV-2026-4471', supplierInvoiceDate: await clinicDate(-2),
    lines: [{
      medicineId,
      entry: [{ levelName: 'box', count: 2 }, { levelName: 'strip', count: 3 }, { levelName: 'tablet', count: 4 }],
      batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
      taxRate: 12,
    }],
  })

  const batchId = String(await scalar(`select id from jmc.batches where batch_number='PCM-A'`))
  return { admin, pharmacy, nurse, supplierId, medicineId, batchId }
}

describe('who may read the stock ledger', () => {
  test('a nurse is refused, and an unsigned request is refused before anything is read', async () => {
    const { pharmacy, nurse, batchId } = await stockedClinic()

    assert.equal((await edgeGet('inventory', `?view=ledger&batchId=${batchId}`)).status, 401)

    const asNurse = await edgeGet('inventory', `?view=ledger&batchId=${batchId}`, await tokenFor(nurse))
    assert.equal(asNurse.status, 403)
    assert.match(asNurse.body.message, /cannot read the stock ledger/)

    const asPharmacist = await edgeGet('inventory', `?view=ledger&batchId=${batchId}`, await tokenFor(pharmacy))
    assert.equal(asPharmacist.status, 200)
  })

  test('an unknown view is a refusal rather than an empty answer', async () => {
    const { pharmacy } = await stockedClinic()
    const result = await edgeGet('inventory', '?view=everything', await tokenFor(pharmacy))
    assert.equal(result.status, 400)
    assert.match(result.body.message, /Unknown inventory view/)
  })
})

describe('one batch and its movements', () => {
  test('the ledger says what happened, who did it, and what is left in each pool', async () => {
    const { admin, pharmacy, batchId } = await stockedClinic()

    await as(admin, 'adjust_stock', {
      batchId, from: 'available', to: 'blocked', quantity: 30,
      reason: 'Set aside for the supplier query on the crushed outer',
    })

    const { body } = await edgeGet('inventory', `?view=ledger&batchId=${batchId}`, await tokenFor(pharmacy))
    assert.equal(body.ok, true)
    assert.equal(body.batch.batchNumber, 'PCM-A')
    assert.equal(body.batch.availableQuantity, 319)
    assert.equal(body.batch.blockedQuantity, 30)
    assert.equal(body.batch.pickable, true)
    // The printed figure with its basis, never a naked number.
    assert.equal(body.batch.mrp, 30)
    assert.equal(body.batch.mrpBasisLevel, 'strip')
    assert.equal(body.batch.mrpBasisFactor, 15)
    // Decomposed with this batch's own frozen ladder: 319 = 2 boxes, 1 strip, 4.
    assert.equal(body.batch.packageBreakdown, '2 boxes, 1 strip and 4 tablets')

    assert.equal(body.movements.length, 3)
    const [newest] = body.movements
    assert.equal(newest.movementType, 'adjust_in_blocked')
    assert.equal(newest.quantityDelta, 30)
    assert.equal(newest.bucket, 'blocked')
    assert.equal(newest.actorName, 'Owner')
    assert.match(newest.reason, /crushed outer/)

    const receipt = body.movements.find((row) => row.movementType === 'goods_receipt')
    assert.equal(receipt.quantityDelta, 349)
    assert.equal(receipt.bucket, 'available')
  })

  test('a batch that does not exist is a 404, not an empty ledger', async () => {
    const { pharmacy } = await stockedClinic()
    const result = await edgeGet('inventory', '?view=ledger&batchId=nope', await tokenFor(pharmacy))
    assert.equal(result.status, 404)
  })
})

describe('the deliveries', () => {
  test('the list carries the supplier paperwork, and one receipt carries what was typed', async () => {
    const { pharmacy } = await stockedClinic()
    const token = await tokenFor(pharmacy)

    const list = await edgeGet('inventory', '?view=receipts', token)
    assert.equal(list.body.receipts.length, 1)
    const [header] = list.body.receipts
    assert.match(header.grnNumber, /^GRN-\d{4}$/)
    assert.equal(header.supplierName, 'Chennai Distributors')
    assert.equal(header.supplierInvoiceNumber, 'INV-2026-4471')
    assert.equal(header.lineCount, 1)
    // 349 tablets at ₹18 per strip of 15 is ₹418.80, plus 12% tax.
    assert.equal(header.subtotal, 418.8)
    assert.equal(header.taxTotal, 50.26)
    assert.equal(header.total, 469.06)

    const one = await edgeGet('inventory', `?view=receipt&id=${header.id}`, token)
    assert.equal(one.body.lines.length, 1)
    const [line] = one.body.lines
    assert.equal(line.acceptedBaseQuantity, 349)
    assert.equal(line.mrpBasisLevel, 'strip')
    assert.equal(line.mrpBasisFactor, 15)
    assert.equal(line.purchaseBasisLevel, 'strip')
    assert.equal(line.taxRate, 12)

    // What the person actually typed, kept beside the converted total.
    assert.deepEqual(line.entry.accepted, [
      { levelName: 'box', count: 2 }, { levelName: 'strip', count: 3 }, { levelName: 'tablet', count: 4 },
    ])
  })
})

describe('a scan', () => {
  test('a mapped code names the pack, and says it does not name a batch', async () => {
    const { pharmacy, medicineId } = await stockedClinic()
    await as(pharmacy, 'map_barcode', {
      medicineId, levelName: 'strip', code: '8901234567890', symbology: 'ean13',
    })

    const { body } = await edgeGet('inventory', '?view=barcode&code=8901234567890', await tokenFor(pharmacy))
    assert.equal(body.known, true)
    assert.equal(body.medicineName, 'Paracetamol')
    assert.equal(body.levelName, 'strip')
    assert.equal(body.baseFactor, 15)
    assert.equal(body.sellable, true)
    assert.equal(body.carriesBatch, false, 'a GTIN identifies the pack, never the lot')
  })

  test('an unmapped code says so, says how often it has been seen, and reads nothing', async () => {
    const { pharmacy } = await stockedClinic()
    const token = await tokenFor(pharmacy)

    const first = await edgeGet('inventory', '?view=barcode&code=5060337028134', token)
    assert.equal(first.status, 200)
    assert.equal(first.body.known, false)
    assert.equal(first.body.seenCount, 0)
    assert.match(first.body.message, /Search by name/)

    // The GET does not write. Recording the miss is a command, so a retry, a
    // prefetch or a speculative fetch cannot turn one scan into three.
    assert.equal(await scalar(`select count(*)::int from jmc.unmapped_barcodes`), 0)

    await as(pharmacy, 'record_unknown_barcode', { code: '5060337028134' })
    await as(pharmacy, 'record_unknown_barcode', { code: '5060337028134' })
    const again = await edgeGet('inventory', '?view=barcode&code=5060337028134', token)
    assert.equal(again.body.seenCount, 2)
  })
})

describe('the formulary a pharmacist links a product to', () => {
  test('substances and clinical drugs come back with their ingredients spelled out', async () => {
    const { pharmacy } = await stockedClinic()
    const amox = await as(pharmacy, 'save_substance', { name: 'Amoxicillin' })
    const clav = await as(pharmacy, 'save_substance', { name: 'Clavulanic acid' })
    await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [
        { substanceId: amox.data.substanceId, strengthValue: 500, strengthUnit: 'mg' },
        { substanceId: clav.data.substanceId, strengthValue: 125, strengthUnit: 'mg' },
      ],
    })

    const { body } = await edgeGet('inventory', '?view=formulary', await tokenFor(pharmacy))
    assert.deepEqual(body.substances.map((row) => row.name), ['Amoxicillin', 'Clavulanic acid'])
    assert.equal(body.clinicalDrugs.length, 1)
    assert.equal(
      body.clinicalDrugs[0].ingredients,
      'Amoxicillin 500.000000 mg + Clavulanic acid 125.000000 mg',
    )
  })
})
