/**
 * Supplier orders, through the real screen.
 *
 * Owner decision, 26 October 2026: an order goes from the pharmacist's own
 * WhatsApp, not the clinic's business number (docs/reference/WHATSAPP.md §9,
 * row 1). The database suite holds the rules — packs, nothing ordered twice,
 * marked sent once. This proves a pharmacist can reach them: that the order
 * card hands over a link to WhatsApp and never claims to have sent anything,
 * that the Counter says when something needs ordering, and that the order
 * becomes placed only when the person says it went.
 *
 * ── WHAT IT TOUCHES, AND PUTS BACK ─────────────────────────────────────────
 *
 * The fixtures carry PO-0001, a draft for Ondansetron and Diazepam from Kovai
 * Wholesale. This journey discards it, drafts a new one, and marks that sent.
 * Every journey file shares one staging database, so afterwards PO-0001 is a
 * draft again and the order made here is gone. The audit rows stay: they are
 * append-only, and nothing else counts them.
 *
 * No journey here presses "Open in WhatsApp". It would leave the clinic for
 * wa.me, and the link is checked by reading it instead.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE, PHONE, buttonExists, clickButton, fillField, freshPage, goToStation, setViewport, signIn,
} from './support/clinic-ui.mjs'

const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }
const KOVAI = 'a3000000-0000-4000-8000-000000000001'
/** Kovai's number as the fixtures type it, "+999 703 000 001", as WhatsApp dials it. */
const KOVAI_DIALS = '999703000001'

async function query(text, params = []) {
  const url = process.env.STAGING_DB_URL
  if (!url) throw new Error('STAGING_DB_URL is not set; browser-gate.mjs sets it')
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    return await sql.unsafe(text, params)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** A value the page computed, back as a value. The eval output is JSON of a JSON string. */
function readJson(js) {
  let value = JSON.parse(evaluate(js).trim())
  if (typeof value === 'string') value = JSON.parse(value)
  return value
}

const mainSays = (words) =>
  `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(${JSON.stringify(String(words).toLowerCase())})`

/** Press a button inside the open dialog — the page behind it has buttons with the same words. */
function clickInDialog(label) {
  const clicked = evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].pop()
    if (!dialog) return 'no-dialog'
    const button = [...dialog.querySelectorAll('button')]
      .filter(b => !b.disabled)
      .find(b => (b.innerText || '').trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}))
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  if (!clicked.includes('ok')) throw new Error(`could not press "${label}" in the dialog — ${clicked}`)
}

async function waitForDb(text, params, expected, what) {
  const deadline = Date.now() + 15_000
  let last
  while (Date.now() < deadline) {
    const [row] = await query(text, params)
    last = row ? Object.values(row)[0] : undefined
    if (String(last) === String(expected)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${what}: last saw ${last}`)
}

let fixtureOrders = []

before(async () => {
  launchBrowser()
  fixtureOrders = (await query(`select id from jmc.purchase_orders`)).map((row) => row.id)
  const [ondansetron] = await query(
    `select m.reorder_level, coalesce((select sum(b.available_quantity) from jmc.batch_availability b
        where b.medicine_id=m.id and b.pickable),0)::int on_shelf
       from jmc.medicines m where m.name='Ondansetron'`)
  assert.ok(ondansetron && ondansetron.on_shelf <= ondansetron.reorder_level,
    'the fixtures must leave Ondansetron at or below its reorder level for this journey')
})

after(async () => {
  closeBrowser()
  const mine = (await query(`select id from jmc.purchase_orders`))
    .map((row) => row.id)
    .filter((id) => !fixtureOrders.includes(id))
  if (mine.length > 0) {
    await query(`delete from jmc.purchase_order_lines where order_id = any($1)`, [mine])
    await query(`delete from jmc.purchase_orders where id = any($1)`, [mine])
  }
  await query(`update jmc.purchase_orders set status='pending', placed_at=null where order_number='PO-0001'`)
})

describe('a supplier order goes from the pharmacist’s own WhatsApp', () => {
  test('the order card hands the message to WhatsApp, and only the person marks it sent', async () => {
    // The fixtures carry a message log of their own; nothing here may add to it.
    const loggedBefore = Number((await query(`select count(*)::int n from jmc.whatsapp_messages`))[0].n)

    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)

    // Ondansetron is low, but PO-0001 already covers it: no reminder.
    await waitFor(`!!document.querySelector('[data-testid=counter-surface]')`, { what: 'the counter' })
    assert.equal(evaluate(`!!document.querySelector('[data-testid=reorder-reminder]')`).trim(), 'false')

    await goToStation('Orders')
    await waitFor(mainSays('PO-0001'), { what: 'the seeded draft' })

    // The link opens the pharmacist's WhatsApp, to the supplier, with the order in it.
    const links = readJson(`JSON.stringify([...document.querySelectorAll('[data-testid=open-order-in-whatsapp]')]
      .map(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })))`)
    assert.equal(links.length, 1, `one draft, one link: ${JSON.stringify(links)}`)
    const [link] = links
    assert.ok(link.href.startsWith(`https://wa.me/${KOVAI_DIALS}?text=`), link.href)
    assert.ok(new URL(link.href).searchParams.get('text').includes('PO-0001'), 'the message names the order')
    assert.equal(link.target, '_blank')
    assert.ok(link.rel.includes('noopener'))

    // Every quantity carries its unit, and nothing offers to send from the clinic.
    assert.ok(evaluate(mainSays('40 vials')).includes('true'), 'the ordered column names its unit')
    assert.equal(buttonExists('Send & place'), false)

    // Discard the seeded draft: Ondansetron is no longer covered.
    clickButton('Discard draft')
    clickInDialog('Discard draft')
    await waitForDb(`select status from jmc.purchase_orders where order_number='PO-0001'`, [], 'cancelled',
      'PO-0001 to be discarded')

    // The Counter says so, and leads to the orders.
    await goToStation('Counter')
    await waitFor(`!!document.querySelector('[data-testid=reorder-reminder]')`, { what: 'the reorder reminder' })
    assert.ok(evaluate(`document.querySelector('[data-testid=reorder-reminder]').innerText`)
      .includes('1 medicine is at or below the reorder level'))
    evaluate(`document.querySelector('[data-testid=reorder-reminder] button').click()`)
    await waitFor(mainSays('Draft an order'), { what: 'the orders station' })

    // Draft it again: rounded up to whole trays, and said in trays.
    fillField('Supplier', KOVAI)
    clickButton('Create draft order')
    await waitFor(mainSays('8 trays (40 vials)'), { what: 'the new draft, in packs' })
    const [draft] = await query(`select id, order_number, message_draft from jmc.purchase_orders
      where status='pending' and supplier_id=$1`, [KOVAI])
    assert.match(draft.message_draft, /Ondansetron .* — 8 trays \(40 vials\)/)

    // Marking it sent is a confirmation, and the only thing that places it.
    clickButton('Mark as sent')
    clickInDialog('Yes, it has gone')
    await waitForDb(`select status from jmc.purchase_orders where id=$1`, [draft.id], 'placed',
      `${draft.order_number} to be placed`)
    const [order] = await query(
      `select external_message_id, message_status from jmc.purchase_orders where id=$1`, [draft.id])
    assert.equal(order.external_message_id, null, 'the clinic sent nothing itself')
    assert.equal(order.message_status, null)
    assert.equal(Number((await query(`select count(*)::int n from jmc.whatsapp_messages`))[0].n), loggedBefore)

    // Covered again, so the Counter stops asking.
    await goToStation('Counter')
    await waitFor(`!!document.querySelector('[data-testid=counter-surface]')`, { what: 'the counter' })
    assert.equal(evaluate(`!!document.querySelector('[data-testid=reorder-reminder]')`).trim(), 'false')
  })

  test('the orders station does not scroll sideways on a phone', async () => {
    setViewport(PHONE)
    await goToStation('Orders')
    await waitFor(mainSays('Supplier orders'), { what: 'the orders station on a phone' })
    const { scroll, client } = readJson(
      `JSON.stringify({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`)
    assert.ok(scroll <= client + 1, `the orders station scrolls sideways on a phone: ${scroll} > ${client}`)
    setViewport(LANDSCAPE)
  })
})
