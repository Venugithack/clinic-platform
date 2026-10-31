/**
 * The bed board's own list of beds, on the screen.
 *
 * bed-board.test.mjs proves the two commands: admin only, one name however it
 * is capitalised, and a bed with a history stays. What only a browser can say
 * is whether the board offers those controls to the right person and on the
 * right beds — Add bed to an administrator and not to a nurse, Remove only on
 * an empty bed that never had a patient — and whether each answer arrives as
 * the result overlay over a board that already shows the change.
 *
 * The fixtures' beds: Bed 1 occupied, Bed 2 free, Bed 3 cleaning, and the Day
 * care couch out of service. None has an observation history.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE,
  NARROW,
  buttonExists,
  clickButton,
  fillField,
  freshPage,
  goToStation,
  setViewport,
  signIn,
  workShowing,
} from './support/clinic-ui.mjs'

/** Doctor and administrator both — the owner, which is the common case. */
const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }
const NURSE = { name: 'Nirmaladevi Ponnusamy', pin: '7305' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

const DIALOG = '[data-jmc-layer] [role=dialog]'

const dialogSays = (words) =>
  `(document.querySelector('${DIALOG}')?.innerText ?? '').toLowerCase().includes(` +
  `${JSON.stringify(words.toLowerCase())})`

const resultSays = (words) =>
  `(document.querySelector('[data-testid=admin-result]')?.innerText ?? '').toLowerCase().includes(` +
  `${JSON.stringify(words.toLowerCase())})`

/** The bed names on the board, in the order they are drawn. */
function boardLabels() {
  const raw = evaluate(`JSON.stringify([...document.querySelectorAll('main p.font-semibold')]
    .map(p => p.innerText.trim()).filter(t => /^(bed |day care)/i.test(t)))`)
  try {
    return JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
}

/**
 * Press a button inside the open dialog.
 *
 * Not `clickButton`: the header's Add bed comes first in the document and is
 * still enabled behind the inert background, so a page-wide search would
 * press it instead of the one in the window.
 */
function clickInDialog(label) {
  const clicked = evaluate(`(() => {
    const button = [...document.querySelectorAll('${DIALOG} button')]
      .filter(b => !b.disabled)
      .find(b => (b.innerText || '').trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())})
    if (!button) return 'no-button'
    if (button.getAttribute('aria-disabled') === 'true') return 'refused'
    button.click()
    return 'ok'
  })()`)
  return clicked.includes('ok') ? 'ok' : clicked.includes('refused') ? 'refused' : 'no-button'
}

/** The buttons on one bed's card, by the bed's name. */
function cardButtons(label) {
  const raw = evaluate(`(() => {
    let node = [...document.querySelectorAll('main p')].find(p => p.innerText.trim() === ${JSON.stringify(label)})
    while (node && !node.querySelector('button')) node = node.parentElement
    return JSON.stringify(node ? [...node.querySelectorAll('button')].map(b => b.innerText.trim()) : null)
  })()`)
  try {
    return JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return null
  }
}

function pressOnCard(label, button) {
  const pressed = evaluate(`(() => {
    let node = [...document.querySelectorAll('main p')].find(p => p.innerText.trim() === ${JSON.stringify(label)})
    while (node && !node.querySelector('button')) node = node.parentElement
    const target = node && [...node.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(button)})
    if (!target) return 'no-button'
    target.click()
    return 'ok'
  })()`)
  if (!pressed.includes('ok')) throw new Error(`no "${button}" on the ${label} card`)
}

describe('the list of beds', () => {
  test('an administrator adds a bed, is stopped on a name already in use, and removes it again', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await goToStation('Beds')
    await waitFor(`(document.querySelector('main')?.innerText ?? '').includes('Bed board')`, { what: 'the bed board' })
    assert.deepEqual(boardLabels(), ['Bed 1', 'Bed 2', 'Bed 3', 'Day care couch'])

    // Remove is on the empty beds with no history, and not on the one in use.
    assert.ok(!cardButtons('Bed 1')?.includes('Remove bed'), 'an occupied bed offers no Remove')
    assert.ok(cardButtons('Bed 2')?.includes('Remove bed'), 'an empty bed with no history offers Remove')

    clickButton('Add bed')
    await waitFor(dialogSays('bed name'), { what: 'the Add bed window' })

    // A name already on the board, in other capitals: said on the screen, and
    // the window's button refuses rather than sending it.
    fillField('Bed name', 'bed 2')
    await waitFor(dialogSays('already a bed called'), { what: 'the clash to be named' })
    assert.equal(clickInDialog('Add bed'), 'refused')

    fillField('Bed name', 'Bed 10')
    await waitFor(`!(${dialogSays('already a bed called')})`, { what: 'the clash notice to go' })
    assert.equal(clickInDialog('Add bed'), 'ok')
    await waitFor(resultSays('bed added'), { what: 'the Bed added result' })
    assert.ok(evaluate(resultSays('bed 10')).includes('true'), 'the result names the bed')
    assert.equal(evaluate(`document.querySelector('${DIALOG} input') === null`).includes('true'), true,
      'the Add bed window has closed')

    // The board already shows it, in order, and offers Remove on it.
    await waitFor(`[...document.querySelectorAll('main p')].some(p => p.innerText.trim() === 'Bed 10')`, {
      what: 'Bed 10 on the board',
    })
    assert.deepEqual(boardLabels(), ['Bed 1', 'Bed 2', 'Bed 3', 'Bed 10', 'Day care couch'])
    assert.ok(workShowing('5 beds'))
    // A routine result goes by itself and the board it left behind is the evidence.
    await waitFor(`document.querySelector('[data-testid=admin-result]') === null`, {
      what: 'the Bed added result to dismiss itself', timeout: 10_000,
    })

    // Removing asks first, in words, and then answers.
    pressOnCard('Bed 10', 'Remove bed')
    await waitFor(dialogSays('take bed 10 off the bed board'), { what: 'the Remove bed review' })
    assert.equal(clickInDialog('Remove bed'), 'ok')
    await waitFor(resultSays('bed removed'), { what: 'the Bed removed result' })
    await waitFor(`![...document.querySelectorAll('main p')].some(p => p.innerText.trim() === 'Bed 10')`, {
      what: 'Bed 10 to leave the board',
    })
    assert.deepEqual(boardLabels(), ['Bed 1', 'Bed 2', 'Bed 3', 'Day care couch'])
  })

  test('the board with its Add bed control does not push a 320px screen sideways', async () => {
    setViewport(NARROW)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await goToStation('Beds')
    await waitFor(`(document.querySelector('main')?.innerText ?? '').includes('Bed board')`, { what: 'the bed board' })
    assert.ok(buttonExists('Add bed'))
    assert.ok(
      evaluate('document.documentElement.scrollWidth <= window.innerWidth').includes('true'),
      'no sideways scroll at 320px',
    )
    setViewport(LANDSCAPE)
  })

  test('a nurse moves patients through the beds and is not offered to change them', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    await goToStation('Observation')
    await waitFor(`(document.querySelector('main')?.innerText ?? '').includes('Bed board')`, { what: 'the bed board' })

    assert.ok(buttonExists('Update bed'), 'the nurse still updates beds')
    assert.ok(!buttonExists('Add bed'), 'no Add bed for a nurse')
    assert.ok(!buttonExists('Remove bed'), 'no Remove bed for a nurse')
  })
})
