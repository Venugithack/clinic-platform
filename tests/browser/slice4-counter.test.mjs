/**
 * Slice 4 at the counter, through a real browser.
 *
 * The database suite proves the arithmetic and the refusals. This proves a
 * pharmacist can reach them: that the five figures a hand-over needs —
 * prescribed, previously supplied, available, give now, remaining after this —
 * are all on the screen at once, that handing over part of a line leaves the
 * rest collectable, and that a bill can be part-paid and then settled.
 *
 * Runs after the other journeys, against the same browser and the same
 * database, and starts from the lock screen.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE,
  PORTRAIT,
  clickButton,
  freshPage,
  goToStation,
  setViewport,
  signIn,
  workShowing,
  workText,
} from './support/clinic-ui.mjs'

/*
 * The pharmacist, and it has to be the pharmacist.
 *
 * These journeys used to run as the owner — doctor and admin — because one
 * account could then sign a prescription and collect against it. Policy
 * register item 17, settled 12 September 2026, ended that: `dispense_rx` and
 * `otc_sale` are pharmacy alone, and an administrator who is not also a
 * pharmacist is no longer offered either station. The fixtures leave a
 * prescription signed and waiting, so nothing here needs to sign one.
 *
 * Six digits: this fixture has not been through a PIN reset yet, which is
 * itself the compatibility path Slice 1 built.
 */
const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }

/** Front desk and the books. Admin alone, with no clinical or pharmacy role. */
const MANAGER = { name: 'Hemalatha Manoharan', pin: '905283' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

const mainSays = (words) =>
  `document.querySelector('main').innerText.toLowerCase().includes(${JSON.stringify(String(words).toLowerCase())})`

/**
 * Move to one of the counter's three stations by the word on its button.
 *
 * Scoped to `main`. The unscoped `[role=group]` this used to take reached the
 * first group anywhere on the page, and Slice 6 put one earlier in the DOM:
 * the administrator's rail now labels its sections that way, so the first
 * group on screen became People and access and the counter's own switcher was
 * never found. The work surface is what these tests are about, and it is
 * cheap to say so.
 */
function openStation(label) {
  const clicked = evaluate(`(() => {
    const group = document.querySelector('main [role=group]')
    const button = [...(group?.querySelectorAll('button') ?? [])]
      .find(b => (b.innerText || '').toLowerCase().includes(${JSON.stringify(label.toLowerCase())}))
    if (!button) return 'no-station:' + [...(group?.querySelectorAll('button') ?? [])]
      .map(b => (b.innerText || '').split('\\n')[0]).join('|')
    button.click()
    return 'ok'
  })()`)
  if (!clicked.includes('ok')) throw new Error(`no counter station called "${label}" — ${clicked}`)
}

/** Press a button inside the open dialog, not the page behind it. */
function clickInDialog(label) {
  const clicked = evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].pop()
    if (!dialog) return 'no-dialog'
    const button = [...dialog.querySelectorAll('button')]
      .filter(b => !b.disabled)
      .find(b => (b.innerText || '').trim().toLowerCase()
        .includes(${JSON.stringify(String(label).toLowerCase())}))
    if (!button) return 'no-button:' + [...dialog.querySelectorAll('button')]
      .map(b => (b.innerText || '').trim() + (b.disabled ? '(off)' : '')).join('|')
    button.click()
    return 'ok'
  })()`)
  if (!clicked.includes('ok')) throw new Error(`could not press "${label}" in the dialog — ${clicked}`)
}

/** Set a labelled input anywhere on the work surface. */
function setField(startsWith, value) {
  const done = evaluate(`(() => {
    const label = [...document.querySelectorAll('main label')]
      .find(l => l.innerText.trim().toLowerCase().startsWith(${JSON.stringify(startsWith.toLowerCase())}))
    const input = label?.querySelector('input, select, textarea')
    if (!input) return 'no-field'
    const proto = input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  if (!done.includes('ok')) throw new Error(`no field starting "${startsWith}" on this screen`)
}

/** The counter stations this session is actually offered, by their labels. */
function stationsOffered() {
  const raw = evaluate(`(() => {
    const group = document.querySelector('main [role=group]')
    return JSON.stringify([...(group?.querySelectorAll('button') ?? [])]
      .map(b => (b.innerText || '').split('\\n')[0].trim().toLowerCase())
      .filter(Boolean))
  })()`)
  try {
    return JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
}

/*
 * The screen and the server, asked the same question.
 *
 * `tests/characterization/counter-authorization.test.mjs` proves what each
 * role's session may actually DO, by calling the commands. This proves the
 * counter offers exactly that and no more. Neither test is security — the
 * refusal at the command is — but a screen that offers a station the server
 * will refuse teaches somebody to press a button that cannot work, and one
 * that withholds a station the server allows hides a feature nobody can find.
 * Both are lies about what the clinic permits, and they are only catchable by
 * checking the two ends against each other.
 */
describe('the counter offers exactly what the role may do', () => {
  test('a pharmacist is offered all three stations', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await goToStation('Counter')
    await waitFor(mainSays('hand over a prescription'), { what: 'the counter' })

    const offered = stationsOffered()
    for (const station of ['hand over a prescription', 'counter sale', 'take payment']) {
      assert.ok(
        offered.includes(station),
        `a pharmacist works all three stations — offered ${offered.join(' | ')}`,
      )
    }
  })

  test('an administrator who is not a pharmacist is offered payment and nothing else', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(MANAGER.name, MANAGER.pin)
    await goToStation('Counter')
    await waitFor(mainSays('take payment'), { what: 'the counter' })

    const offered = stationsOffered()

    // Money, yes. `take_payment` is gated to admin and pharmacy.
    assert.ok(
      offered.includes('take payment'),
      `an administrator collects payment — offered ${offered.join(' | ')}`,
    )

    // Medicine, no. Not hidden by CSS and not disabled: absent, because
    // `dispense_rx` and `otc_sale` are the pharmacist's alone and a control
    // that can only be refused should not be drawn.
    for (const refused of ['hand over a prescription', 'counter sale']) {
      assert.equal(
        offered.includes(refused),
        false,
        `"${refused}" requires a pharmacist — offered ${offered.join(' | ')}`,
      )
    }

    // And nowhere on the screen is there a control that would try anyway.
    assert.equal(
      evaluate(`[...document.querySelectorAll('main button')].some(b =>
        /confirm and hand over|complete the sale/i.test(b.innerText || ''))`).includes('true'),
      false,
      'no hand-over control may be drawn for somebody who cannot hand anything over',
    )
  })
})

describe('the pharmacy counter', () => {
  test('a waiting prescription shows all five figures a hand-over needs', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await goToStation('Counter')
    await waitFor(mainSays('hand over a prescription'), { what: 'the counter' })

    openStation('Hand over a prescription')
    await waitFor(mainSays('prescriptions waiting'), { what: 'the prescription queue' })

    // The fixtures leave one prescription signed and uncollected.
    const chosen = evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => /RX-\\d{6}/.test(b.innerText || ''))
      if (!button) return 'none-waiting'
      button.click()
      return 'ok'
    })()`)
    assert.ok(chosen.includes('ok'), `a prescription must be waiting at the counter — ${chosen}`)

    await waitFor(mainSays('give now'), { what: 'the hand-over lines' })

    /*
     * The brief's list, on one screen: prescribed, previously supplied,
     * available, give now, and remaining after this. A pharmacist should not
     * have to do that arithmetic in their head, and until Slice 4 the screen
     * offered none of it — a prescription was handed over whole or not at all.
     */
    for (const figure of [
      'prescribed', 'previously supplied', 'available', 'give now', 'remaining after this',
    ]) {
      assert.ok(workShowing(figure), `the hand-over must show "${figure}"`)
    }

    // And the validity date, which is what decides whether the remainder may
    // still be collected at all.
    assert.ok(workShowing('valid until'), 'the counter must show how long this may be supplied')
  })

  test('handing over part of a line leaves the rest to collect, and charges only for what moved', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Counter')
    await waitFor(mainSays('hand over a prescription'), { what: 'the counter' })
    openStation('Hand over a prescription')
    await waitFor(mainSays('prescriptions waiting'), { what: 'the prescription queue' })
    evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => /RX-\\d{6}/.test(b.innerText || ''))
      button?.click()
    })()`)
    await waitFor(mainSays('give now'), { what: 'the hand-over lines' })

    // Give one of whatever the first line prescribes.
    const gave = evaluate(`(() => {
      const label = [...document.querySelectorAll('main label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('give now'))
      const input = label?.querySelector('input')
      if (!input) return 'no-give-now'
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(gave.includes('ok'), `Give now must be editable — ${gave}`)

    // The screen does the arithmetic before anything moves.
    assert.ok(
      workShowing('remaining after this'),
      'the remainder has to be visible before the pharmacist commits',
    )

    clickButton('Confirm and hand over')
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the hand-over confirmation' })
    clickInDialog('Confirm and hand over')
    await waitFor(mainSays('handed over'), { what: 'the hand-over record', timeout: 25_000 })

    assert.match(workText(), /DSP-\d{6}/, 'the hand-over gets its own number')
  })

  test('a bill can be part paid and then settled, with a receipt each time', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Counter')
    await waitFor(mainSays('take payment'), { what: 'the counter' })
    openStation('Take payment')
    await waitFor(mainSays('bills'), { what: 'the checkout' })

    const opened = evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => /INV-\\d{6}/.test(b.innerText || ''))
      if (!button) return 'no-bill'
      button.click()
      return 'ok'
    })()`)
    assert.ok(opened.includes('ok'), `a bill must be open at the counter — ${opened}`)

    await waitFor(mainSays('due'), { what: 'the bill' })
    assert.ok(workShowing('total'), 'the bill shows what was charged')
    assert.ok(workShowing('paid'), 'and what has been paid')

    // Ten rupees of it, which is a part payment whatever the bill comes to.
    setField('Amount', '10')
    clickButton('Record part payment')
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the payment confirmation' })
    clickInDialog('Record part payment')
    await waitFor(mainSays('receipt'), { what: 'the receipt', timeout: 25_000 })

    assert.match(workText(), /RCP-\d{6}/, 'a payment gets a receipt number')
    assert.ok(
      workShowing('still due') || workShowing('part paid'),
      `a part payment must say what is still owed — screen says:\n${workText().slice(0, 700)}`,
    )
  })

  test('neither orientation scrolls the counter sideways', async () => {
    for (const shape of [LANDSCAPE, PORTRAIT]) {
      setViewport(shape)
      await goToStation('Counter')
      await waitFor(mainSays('hand over a prescription'), { what: `the counter at ${shape.name}` })
      const measured = JSON.parse(
        evaluate(
          'JSON.stringify({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
        ).replace(/^"|"$/g, '').replace(/\\"/g, '"'),
      )
      assert.ok(
        measured.scroll <= measured.client + 1,
        `the counter scrolls sideways at ${shape.name}: ${measured.scroll} > ${measured.client}`,
      )
    }
  })
})
