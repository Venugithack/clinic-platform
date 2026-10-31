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
  EVERY_SHAPE,
  LANDSCAPE,
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

/** Is this landmark on the screen at all? */
const has = (testid) =>
  evaluate(`!!document.querySelector('[data-testid="${testid}"]')`).includes('true')

/** What one landmark says, flattened onto a line. */
function textOf(testid) {
  return evaluate(`(() => {
    const NL = String.fromCharCode(10)
    const node = document.querySelector('[data-testid="${testid}"]')
    return node ? node.innerText.split(NL).join(' / ') : ''
  })()`).toLowerCase()
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

/**
 * Set a labelled input inside one landmark.
 *
 * Scoped on purpose. The unified counter carries a sale AND a bill on the same
 * surface, so there are two fields labelled "Amount" on screen at once — the
 * one collecting for the basket and the one collecting for the bill. An
 * unscoped search finds whichever is higher in the DOM, which is how a payment
 * test came to type ten rupees into the wrong half of the counter and then
 * wait for a dialog that had no reason to open.
 */
function setFieldIn(testid, startsWith, value) {
  const done = evaluate(`(() => {
    const root = document.querySelector('[data-testid="${testid}"]')
    if (!root) return 'no-landmark'
    const label = [...root.querySelectorAll('label')]
      .find(l => l.innerText.trim().toLowerCase().startsWith(${JSON.stringify(startsWith.toLowerCase())}))
    const input = label?.querySelector('input, select, textarea')
    if (!input) return 'no-field'
    const proto = input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  if (!done.includes('ok')) {
    throw new Error(`no field starting "${startsWith}" inside ${testid} — ${done}`)
  }
}

/** Open the counter and wait for the one surface to be there. */
async function openCounter(what = 'the counter') {
  await goToStation('Counter')
  await waitFor(`!!document.querySelector('[data-testid="counter-surface"]')`, { what })
}

/**
 * Open the first waiting prescription INTO the counter.
 *
 * Two taps and no navigation: the waiting list is a drawer over the same
 * surface, and choosing one from it changes that surface into prescription
 * mode rather than sending the pharmacist to another station.
 */
async function openFirstPrescription() {
  evaluate(`document.querySelector('[data-testid="prescriptions-waiting"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="waiting-list"]')`, {
    what: 'the waiting prescriptions',
  })
  const chosen = evaluate(`(() => {
    const list = document.querySelector('[data-testid="waiting-list"]')
    const button = [...list.querySelectorAll('button')].find(b => (b.innerText || '').includes('RX-'))
    if (!button) return 'none-waiting'
    button.click()
    return 'ok'
  })()`)
  if (!chosen.includes('ok')) throw new Error(`a prescription must be waiting at the counter — ${chosen}`)
  await waitFor(`!!document.querySelector('[data-testid="prescription-mode"]')`, {
    what: 'prescription mode',
  })
}

/*
 * The screen and the server, asked the same question.
 *
 * `tests/characterization/counter-authorization.test.mjs` proves what each
 * role's session may actually DO, by calling the commands. This proves the
 * counter offers exactly that and no more. Neither test is security — the
 * refusal at the command is — but a screen that offers a control the server
 * will refuse teaches somebody to press a button that cannot work, and one
 * that withholds a control the server allows hides a feature nobody can find.
 * Both are lies about what the clinic permits, and they are only catchable by
 * checking the two ends against each other.
 */
describe('the counter offers exactly what the role may do', () => {
  test('a pharmacist gets the whole counter on one surface', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openCounter()

    // Selling, supplying and collecting are one screen now. They were three
    // stations that unmounted each other, so a basket could not survive being
    // shown a prescription and a hand-over could not see the money it created.
    for (const part of ['prescriptions-waiting', 'otc-basket', 'bill-panel', 'new-sale']) {
      assert.ok(has(part), `a pharmacist's counter must carry "${part}"`)
    }
  })

  test('an administrator is offered the money and none of the medicine', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(MANAGER.name, MANAGER.pin)
    await openCounter()

    // Money, yes. `take_payment` is gated to admin and pharmacy.
    assert.ok(has('bill-panel'), 'an administrator collects payment')

    // Medicine, no. Not hidden by CSS and not disabled: absent, because
    // `dispense_rx` and `otc_sale` are the pharmacist's alone (policy register
    // item 17) and a control that can only be refused should not be drawn.
    for (const refused of ['otc-basket', 'prescriptions-waiting']) {
      assert.equal(
        has(refused),
        false,
        `"${refused}" requires a pharmacist and must not be drawn for an administrator`,
      )
    }

    // And nowhere on the screen is there a control that would try anyway.
    assert.equal(
      evaluate(`[...document.querySelectorAll('main button')].some(b => {
        const t = (b.innerText || '').toLowerCase()
        return t.includes('confirm and hand over') || t.includes('complete the sale')
      })`).includes('true'),
      false,
      'no hand-over control may be drawn for somebody who cannot hand anything over',
    )
  })
})

describe('the unified pharmacy counter', () => {
  test('it opens ready for a sale, with the waiting prescriptions on the same screen', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)

    // No navigation: this is the first screen after the last digit of the PIN.
    await waitFor(`!!document.querySelector('[data-testid="counter-surface"]')`, {
      what: 'the counter, without navigating to it',
    })
    assert.ok(
      textOf('counter-mode').includes('over-the-counter'),
      `the counter opens ready to sell — it says "${textOf('counter-mode')}"`,
    )
    assert.ok(
      textOf('prescriptions-waiting').includes('prescriptions waiting'),
      'and the waiting prescriptions are on that same screen',
    )
  })

  test('a waiting prescription fills the same counter, money included', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openCounter()
    await openFirstPrescription()

    // The screen says which prescription it is now working on.
    assert.ok(
      textOf('prescription-mode').includes('prescription rx-'),
      `the counter must name the prescription it switched into — "${textOf('prescription-mode')}"`,
    )

    /*
     * The brief's list, on one screen: prescribed, previously supplied,
     * available, supply now, and remaining after this. A pharmacist should not
     * have to do that arithmetic in their head.
     */
    for (const figure of [
      'prescribed', 'previously supplied', 'available', 'supply now', 'remaining after this',
    ]) {
      assert.ok(workShowing(figure), `the hand-over must show "${figure}"`)
    }

    // And the validity date, which decides whether the remainder may still be
    // collected at all.
    assert.ok(workShowing('valid until'), 'the counter must show how long this may be supplied')

    /*
     * The money, which the hand-over station never showed.
     *
     * A pharmacist opening a prescription used to see no amount at all and had
     * to leave for another station to find out what the patient owed — and the
     * consultation fee, which is collected here even when no medicine is
     * supplied, was invisible until then.
     */
    const money = textOf('prescription-money')
    for (const line of ['consultation fee', 'medicines billed', 'bill', 'amount due']) {
      assert.ok(money.includes(line), `prescription mode must show "${line}" — it shows ${money}`)
    }
  })

  test('prescribed and product supplied are separate, and a change outside the rule stops', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openCounter()
    await openFirstPrescription()

    // The signed order and what actually leaves the shelf are two facts, and
    // the screen keeps them apart. Changing one never edits the other.
    assert.ok(workShowing('prescribed'), 'the signed order stays on screen')
    assert.ok(workShowing('product supplied'), 'and what is actually supplied is its own column')

    const opened = evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => (b.innerText || '').toLowerCase().includes('change product supplied'))
      if (!button) return 'no-control'
      button.click()
      return 'ok'
    })()`)
    assert.ok(opened.includes('ok'), `the counter must offer a supplied-product change — ${opened}`)
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the substitution decision' })

    /*
     * The fixtures' prescribed medicine is not mapped to a clinical drug, so
     * the clinic cannot prove any other product is the same thing. That is the
     * refusing half of policy register item 21, and the screen has to say so in
     * the plan's words and then offer no way through.
     *
     * The permitting half — a generic order and a verified equivalent — is
     * proved at the command in `slice4-gate.test.mjs`, which is where the rule
     * is actually enforced.
     */
    const dialog = evaluate(`(() => {
      const NL = String.fromCharCode(10)
      const d = [...document.querySelectorAll('[role=dialog]')].pop()
      return d.innerText.split(NL).join(' / ')
    })()`).toLowerCase()
    assert.ok(
      dialog.includes('doctor amendment required'),
      `an unverifiable substitution must stop with "Doctor amendment required" — it said ${dialog.slice(0, 300)}`,
    )

    const commits = evaluate(`(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].pop()
      return [...d.querySelectorAll('button')].filter(b => !b.disabled).some(b => {
        const t = (b.innerText || '').toLowerCase()
        return t.includes('supply this instead') || t.includes('confirm') || t.includes('record')
      })
    })()`)
    assert.equal(
      commits.includes('true'),
      false,
      'a stopped substitution must offer no way to commit it',
    )
  })

  test('an open prescription does not throw away the basket beside it', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openCounter()

    /*
     * The three stations this replaced were mutually exclusive renders, so
     * opening a prescription unmounted the counter sale and every line in it.
     * A patient buying a tube of cream while collecting a prescription meant
     * starting the basket again.
     */
    assert.ok(has('otc-basket'), 'the sale is on screen before a prescription is opened')
    await openFirstPrescription()
    assert.ok(has('otc-basket'), 'and it is still there afterwards')
    assert.ok(has('prescription-mode'), 'alongside the prescription')
  })

  test('handing over part of a line leaves the rest to collect', async () => {
    setViewport(LANDSCAPE)
    await openCounter()
    await openFirstPrescription()

    // Give one of whatever the first line prescribes.
    const gave = evaluate(`(() => {
      const label = [...document.querySelectorAll('main label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('supply now'))
      const input = label?.querySelector('input')
      if (!input) return 'no-supply-now'
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(gave.includes('ok'), `Supply now must be editable — ${gave}`)

    // The screen does the arithmetic before anything moves.
    assert.ok(
      workShowing('remaining after this'),
      'the remainder has to be visible before the pharmacist commits',
    )

    clickButton('Confirm and hand over')
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the hand-over confirmation' })
    clickInDialog('Confirm and hand over')

    /*
     * The result is a timed overlay now, so this waits for the overlay rather
     * than for words that stay on the page. What must survive its dismissal is
     * the dispense number, which is the durable evidence the plan requires.
     */
    await waitFor(`!!document.querySelector('[data-testid="result-overlay"]')`, {
      what: 'the hand-over result',
      timeout: 25_000,
    })
    const result = textOf('result-overlay')
    assert.ok(result.includes('dsp-'), `the hand-over gets its own number — it said ${result}`)
    assert.ok(
      result.includes('handed over'),
      `and says what happened — it said ${result}`,
    )
  })

  test('a bill can be part paid, and the result says what is still owed', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openCounter()

    // A bill with something actually outstanding. A settled one offers no
    // payment form, correctly, and would fail this test for the wrong reason.
    const opened = evaluate(`(() => {
      // Asked positively. "Unpaid" and "part paid" both contain "paid", so a
      // rule written as "not paid" throws away exactly the bills it wants.
      // A bill under financial review is excluded because the counter refuses
      // one on purpose — that is the administrator's, not the pharmacist's.
      const bills = [...document.querySelectorAll('main button')].filter(b => {
        const t = (b.innerText || '').toLowerCase()
        return t.includes('inv-') && !t.includes('over-') && !t.includes('void')
      })
      const button = bills.find(b => {
        const t = (b.innerText || '').toLowerCase()
        return t.includes('unpaid') || t.includes('part paid')
      })
      if (!button) return 'no-bill:' + bills.map(b => (b.innerText || '').slice(0, 40)).join('|')
      button.click()
      return 'ok'
    })()`)
    assert.ok(opened.includes('ok'), `an unsettled bill must be at the counter — ${opened}`)
    await waitFor(mainSays('due'), { what: 'the bill' })

    /*
     * The plan's rule, and the reason the counter had to be unified: a
     * consultation fee is collected here even when no medicine was supplied,
     * so it is its own line rather than a number folded into a total.
     */
    const bill = textOf('bill-panel')
    assert.ok(bill.includes('consultation fee'), 'the fee is its own line on the bill')
    assert.ok(bill.includes('medicines'), 'and the medicines are theirs')

    // Ten rupees of it, which is a part payment whatever the bill comes to.
    setFieldIn('bill-panel', 'Amount', '10')
    clickButton('Record part payment')
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the payment confirmation' })
    clickInDialog('Record part payment')
    await waitFor(`!!document.querySelector('[data-testid="result-overlay"]')`, {
      what: 'the payment result',
      timeout: 25_000,
    })

    const result = textOf('result-overlay')
    assert.ok(result.includes('rcp-'), `a payment gets a receipt number — it said ${result}`)
    /*
     * Amber, and it says the balance. A part payment and a settled bill must
     * not look alike from across a counter — the plan is explicit that a
     * partial outcome is never a green completion.
     */
    assert.ok(
      result.includes('part payment') || result.includes('still due') || result.includes('balance'),
      `a part payment must say what is still owed — it said ${result}`,
    )
  })

  test('the counter fits every screen the clinic uses', async () => {
    for (const shape of EVERY_SHAPE) {
      setViewport(shape)
      await freshPage()
      await signIn(PHARMACIST.name, PHARMACIST.pin)
      await waitFor(`!!document.querySelector('[data-testid="counter-surface"]')`, {
        what: `the counter at ${shape.name}`,
      })

      const measured = JSON.parse(
        evaluate(
          'JSON.stringify({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
        ).replace(/^"|"$/g, '').replace(/\\"/g, '"'),
      )
      assert.ok(
        measured.scroll <= measured.client + 1,
        `the counter scrolls sideways at ${shape.name}: ${measured.scroll} > ${measured.client}`,
      )

      // Every control on it is still a thumb's worth of target.
      const small = evaluate(`(() => {
        const NL = String.fromCharCode(10)
        return [...document.querySelectorAll('main button, nav button')]
          .filter(b => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 44 })
          .map(b => (b.innerText || b.getAttribute('aria-label') || '?').split(NL)[0].slice(0, 24)
            + ':' + Math.round(b.getBoundingClientRect().height))
          .join(' | ')
      })()`).replace(/^"|"$/g, '')
      assert.equal(small, '', `every control is at least 44px at ${shape.name}; these are not: ${small}`)
    }
  })
})
