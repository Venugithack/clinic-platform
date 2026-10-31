/**
 * Supplier orders, sent from the pharmacist's own WhatsApp.
 *
 * Owner decision, 26 October 2026 — row 1 of the ladder in
 * docs/reference/WHATSAPP.md §9. The clinic drafts the order and opens the
 * pharmacist's WhatsApp with the message filled in; the clinic's business
 * number sends nothing to a supplier. That decision closes four faults the
 * audit found in the old `send_order`, and each is held here:
 *
 *   1. It sent a free-typed message, which Meta delivers only inside a 24-hour
 *      window the supplier opens — so most orders would not have arrived.
 *   2. It marked the order placed before anybody knew, and a later failure
 *      report had nowhere to land.
 *   3. It sent first and wrote second, with no lock: a double tap, a lost reply
 *      or two people at once could order twice. Drafting had the same fault
 *      one step earlier — a medicine ordered yesterday is still short on the
 *      shelf today, and the next draft ordered it again.
 *   4. It said "Paracetamol — 137" and meant tablets.
 *
 * No test here contacts WhatsApp: there is no path left that could.
 */
import assert from 'node:assert/strict'
import { after, beforeEach, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** 15 tablets a strip, 10 strips a box, 20 boxes a case. */
const TABLET_LADDER = [
  { levelName: 'tablet', levelType: 'tablet', sellable: true },
  { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
  { levelName: 'box', levelType: 'box', contains: 'strip', containsCount: 10, sellable: true },
  { levelName: 'case', levelType: 'case', contains: 'box', containsCount: 20 },
]

let admin
let pharmacy
let nurse
let supplierId
let otherSupplierId

beforeEach(async () => {
  await resetClinic()
  admin = await makeStaff({ name: 'Owner', username: 'so-admin', roles: ['admin'], pin: '4829' })
  pharmacy = await makeStaff({ name: 'Priya', username: 'so-pharm', roles: ['pharmacy'], pin: '7048' })
  nurse = await makeStaff({ name: 'Nurse', username: 'so-nurse', roles: ['nurse'], pin: '5731' })
  await as(admin, 'add_supplier', {
    code: 'SUP1', name: 'Chennai Distributors', whatsapp: '098765 43210', phone: '9876543210',
  })
  // `add_supplier` requires a WhatsApp entry, so the way a supplier ends up
  // with no usable number is somebody typing something that is not one.
  await as(admin, 'add_supplier', {
    code: 'SUP2', name: 'Madurai Medicals', whatsapp: 'ask at counter', phone: '9876500000',
  })
  supplierId = String(await scalar(`select id from jmc.suppliers where code='SUP1'`))
  otherSupplierId = String(await scalar(`select id from jmc.suppliers where code='SUP2'`))
})

/** A medicine with nothing on the shelf, reorder at 10, target 1000, linked to the supplier. */
async function lowMedicine(code, { packaged = true, suppliers = [supplierId] } = {}) {
  await as(pharmacy, 'add_medicine', {
    code, name: `Medicine ${code}`, genericName: `Medicine ${code}`, strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 10, targetStock: 1000,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code=$1`, [code]))
  if (packaged) {
    const saved = await as(pharmacy, 'save_package_version', {
      medicineId, baseUnit: 'tablet', levels: TABLET_LADDER, note: '',
    })
    await as(pharmacy, 'verify_package_version', {
      packageVersionId: saved.data.packageVersionId, verificationSource: 'physical_pack',
    })
  }
  for (const id of suppliers) {
    const linked = (await rows(
      `select medicine_id from jmc.supplier_medicines where supplier_id=$1 and active=1`, [id],
    )).map((row) => row.medicine_id)
    await as(pharmacy, 'set_supplier_medicines', { supplierId: id, medicineIds: [...linked, medicineId] })
  }
  return medicineId
}

async function draft(staff = pharmacy, supplier = supplierId) {
  const created = await as(staff, 'create_order', { supplierId: supplier })
  return created.data.orderId
}

describe('the draft says packs, and means them', () => {
  test('a shortfall is rounded up to whole strips and recorded in them', async () => {
    const medicineId = await lowMedicine('PCM')
    const orderId = await draft()

    // 1000 short, in strips of 15: 67 strips, which is 1005 tablets.
    const [line] = await rows(
      `select ordered_quantity, order_level_name, order_level_count, package_version_id
         from jmc.purchase_order_lines where order_id=$1`, [orderId])
    assert.equal(line.ordered_quantity, 1005)
    assert.equal(line.order_level_name, 'strip')
    assert.equal(line.order_level_count, 67)
    assert.equal(line.package_version_id, String(await scalar(
      `select id from jmc.package_versions where medicine_id=$1 and status='verified'`, [medicineId])))

    const message = String(await scalar(`select message_draft from jmc.purchase_orders where id=$1`, [orderId]))
    assert.match(message, /Medicine PCM 500 mg — 6 boxes and 7 strips \(1005 tablets\)/)
  })

  test('a medicine with no verified package is ordered in tablets, and says so', async () => {
    await lowMedicine('RAW', { packaged: false })
    const orderId = await draft()
    const [line] = await rows(
      `select ordered_quantity, order_level_name, order_level_count, package_version_id
         from jmc.purchase_order_lines where order_id=$1`, [orderId])
    assert.equal(line.ordered_quantity, 1000)
    assert.equal(line.order_level_name, 'tablet')
    assert.equal(line.order_level_count, 1000)
    assert.equal(line.package_version_id, null)
    assert.match(
      String(await scalar(`select message_draft from jmc.purchase_orders where id=$1`, [orderId])),
      /Medicine RAW 500 mg — 1000 tablets/,
    )
  })

  test('the order card reads the same packs, and the supplier number as WhatsApp dials it', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    const seen = await snapshot.readSnapshot(sessionFor(pharmacy))
    const order = seen.orders.find((candidate) => candidate.id === orderId)
    assert.equal(order.lines[0].orderedDescription, '6 boxes and 7 strips (1005 tablets)')
    assert.equal(order.lines[0].baseUnit, 'tablet')
    // "098765 43210" — a trunk zero and a space, as it is printed on a card.
    assert.equal(order.supplierWhatsApp, '919876543210')
    assert.equal(order.supplierWhatsAppProblem, undefined)
  })

  test('a supplier with no usable WhatsApp number says so instead of offering a link', async () => {
    await lowMedicine('PCM', { suppliers: [otherSupplierId] })
    const orderId = await draft(pharmacy, otherSupplierId)
    const seen = await snapshot.readSnapshot(sessionFor(pharmacy))
    const order = seen.orders.find((candidate) => candidate.id === orderId)
    assert.equal(order.supplierWhatsApp, undefined)
    assert.match(order.supplierWhatsAppProblem, /ask at counter — cannot be dialled/)

    // And the order can still be sent another way and recorded.
    await as(pharmacy, 'mark_order_sent', { orderId })
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [orderId]), 'placed')
  })
})

describe('nothing is ordered twice by drafting', () => {
  test('what is already on order is not drafted again, sent or not', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()

    await assert.rejects(() => draft(), /not already on an order/)
    await as(pharmacy, 'mark_order_sent', { orderId })
    await assert.rejects(() => draft(), /not already on an order/)
  })

  test('discarding a draft puts its medicines back on the list', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    await as(pharmacy, 'cancel_order', { orderId })
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [orderId]), 'cancelled')
    const again = await draft()
    assert.notEqual(again, orderId)
  })

  test('two drafts at once for two suppliers of one medicine order it once', async () => {
    const medicineId = await lowMedicine('PCM', { suppliers: [supplierId, otherSupplierId] })
    const both = await Promise.allSettled([
      as(pharmacy, 'create_order', { supplierId }),
      as(admin, 'create_order', { supplierId: otherSupplierId }),
    ])
    assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1,
      `exactly one draft may take it, got ${JSON.stringify(both.map((result) => result.status))}`)
    const lines = Number(await scalar(
      `select count(*) from jmc.purchase_order_lines where medicine_id=$1`, [medicineId]))
    assert.equal(lines, 1)
  })
})

describe('marking an order sent', () => {
  test('places the order once, keeps the message as sent, and contacts nobody', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    const edited = 'Hello Chennai Distributors,\n\n1. Medicine PCM 500 mg — 67 strips\n\nThank you.'

    const result = await as(pharmacy, 'mark_order_sent', { orderId, messageDraft: edited })
    assert.match(result.message, /waiting for delivery/)

    const [order] = await rows(
      `select status, message_draft, placed_at, external_message_id, message_status
         from jmc.purchase_orders where id=$1`, [orderId])
    assert.equal(order.status, 'placed')
    assert.equal(order.message_draft, edited)
    assert.ok(order.placed_at)
    // The business API was never called: no provider reference, no delivery
    // status pretending to know whether the supplier read it.
    assert.equal(order.external_message_id, null)
    assert.equal(order.message_status, null)
    assert.equal(Number(await scalar('select count(*) from jmc.whatsapp_messages')), 0)
    assert.equal(Number(await scalar('select count(*) from jmc.message_outbox')), 0)

    assert.equal(await scalar(
      `select action from jmc.audit_events where entity_id=$1 order by created_at desc limit 1`, [orderId]),
    'order.marked_sent')
  })

  test('a second mark is refused, and names who sent it', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    await as(pharmacy, 'mark_order_sent', { orderId })
    await assert.rejects(
      () => as(admin, 'mark_order_sent', { orderId }),
      /Priya already marked this order sent/,
    )
  })

  test('two people marking at once place it once', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    const both = await Promise.allSettled([
      as(pharmacy, 'mark_order_sent', { orderId }),
      as(admin, 'mark_order_sent', { orderId }),
    ])
    assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(Number(await scalar(
      `select count(*) from jmc.audit_events where entity_id=$1 and action='order.marked_sent'`, [orderId])), 1)
  })

  test('a sent order cannot be discarded, and a discarded one cannot be sent', async () => {
    await lowMedicine('PCM')
    const sent = await draft()
    await as(pharmacy, 'mark_order_sent', { orderId: sent })
    await assert.rejects(() => as(pharmacy, 'cancel_order', { orderId: sent }), /not been sent can be discarded/)

    await lowMedicine('IBU')
    const discarded = await draft()
    await as(pharmacy, 'cancel_order', { orderId: discarded })
    await assert.rejects(() => as(pharmacy, 'mark_order_sent', { orderId: discarded }), /discarded/)
  })

  test('the old send command is gone, so nothing can reach the business number', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    await assert.rejects(() => as(pharmacy, 'send_order', { orderId }))
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [orderId]), 'pending')
  })

  test('only pharmacy and admin can mark an order sent or discard one', async () => {
    await lowMedicine('PCM')
    const orderId = await draft()
    await assert.rejects(() => as(nurse, 'mark_order_sent', { orderId }))
    await assert.rejects(() => as(nurse, 'cancel_order', { orderId }))
    assert.equal(await scalar(`select status from jmc.purchase_orders where id=$1`, [orderId]), 'pending')
  })
})
