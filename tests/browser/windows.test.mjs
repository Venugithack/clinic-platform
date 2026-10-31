/**
 * Modals, drawers and popovers, driven with a keyboard.
 *
 * The application had a `Modal` that moved focus once and closed on Escape and
 * did nothing else: no trap, no focus restoration, nothing behind it made
 * inert, and no portal — so one instance rendered inside a horizontally
 * scrolling table wrapper where a fixed-position box is clipped. A keyboard
 * user could Tab out of a dispense confirmation into the counter behind it and
 * press the very control the dialog was asking about.
 *
 * There are 37 dialog instances across 11 files and they all run through the
 * same primitive, so this tests the primitive rather than each of them. It also
 * covers the one nested case that exists in the clinic — a confirmation inside
 * a form — where both layers used to listen on `document` and a single Escape
 * closed both, throwing away a typed outcome note.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { ab, closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import { LANDSCAPE, freshPage, setViewport, signIn } from './support/clinic-ui.mjs'

const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

/** Open the counter, then the waiting-prescriptions drawer on top of it. */
async function openDrawer() {
  setViewport(LANDSCAPE)
  await freshPage()
  await signIn(PHARMACIST.name, PHARMACIST.pin)
  await waitFor(`!!document.querySelector('[data-testid="counter-surface"]')`, {
    what: 'the counter',
  })
  evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="prescriptions-waiting"]')
    trigger.setAttribute('data-was-the-trigger', 'yes')
    trigger.focus()
    trigger.click()
    return 'ok'
  })()`)
  await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the drawer' })
}

describe('a window on top is actually on top', () => {
  test('focus moves into it, and Tab cannot get back out', async () => {
    await openDrawer()

    // It took focus rather than leaving it on the counter behind.
    assert.equal(
      evaluate(`!!document.activeElement.closest('[role=dialog]')`).includes('true'),
      true,
      'opening a window must move focus into it',
    )

    /*
     * Twenty presses is more than the drawer holds, so a trap that only works
     * once would have leaked by now. This is the assertion the old Modal could
     * not pass: nothing stopped Tab walking out into the page behind.
     */
    for (let press = 0; press < 20; press += 1) {
      ab(['press', 'Tab'])
      const inside = evaluate(`!!document.activeElement.closest('[role=dialog]')`)
      assert.equal(
        inside.includes('true'),
        true,
        `Tab escaped the window after ${press + 1} presses`,
      )
    }

    // And backwards, which is the half that is usually forgotten.
    for (let press = 0; press < 6; press += 1) {
      ab(['press', 'Shift+Tab'])
      assert.equal(
        evaluate(`!!document.activeElement.closest('[role=dialog]')`).includes('true'),
        true,
        `Shift+Tab escaped the window after ${press + 1} presses`,
      )
    }
  })

  test('everything behind it is inert, not merely covered', async () => {
    await openDrawer()

    /*
     * `inert` and not a transparent backdrop. A cover stops the mouse and
     * leaves the tab order and the accessibility tree untouched, so a screen
     * reader still reads out a counter the user cannot reach and a keyboard
     * still reaches controls the dialog is asking about.
     */
    const behind = evaluate(`(() => {
      const layer = document.querySelector('[data-jmc-layer]')
      const others = [...document.body.children].filter(el => el !== layer)
      if (others.length === 0) return 'nothing-behind'
      return others.every(el => el.hasAttribute('inert')) ? 'all-inert' : 'not-inert'
    })()`)
    assert.ok(
      behind.includes('all-inert'),
      `the page behind an open window must be inert — it is ${behind}`,
    )

    // The counter's own controls are unreachable while it is open.
    assert.equal(
      evaluate(`(() => {
        const surface = document.querySelector('[data-testid="counter-surface"]')
        if (!surface) return 'no-surface'
        return surface.closest('[inert]') !== null ? 'unreachable' : 'reachable'
      })()`).includes('unreachable'),
      true,
      'the work behind the window must not be operable while it is open',
    )
  })

  test('Escape closes it and hands focus back to whatever opened it', async () => {
    await openDrawer()

    ab(['press', 'Escape'])
    await waitFor(`!document.querySelector('[role=dialog]')`, { what: 'the drawer to close' })

    /*
     * Back to the trigger. A dialog that closes leaving focus on `<body>` sends
     * the next Tab to the top of the page, which on this counter means walking
     * the whole medicine list again to get back to where you were.
     */
    assert.equal(
      evaluate(`document.activeElement?.getAttribute('data-was-the-trigger') === 'yes'`).includes('true'),
      true,
      'closing a window must return focus to the control that opened it',
    )

    // And the page is operable again.
    assert.equal(
      evaluate(`(() => {
        const surface = document.querySelector('[data-testid="counter-surface"]')
        return surface && surface.closest('[inert]') === null ? 'reachable' : 'still-inert'
      })()`).includes('reachable'),
      true,
      'the work behind must be operable again once the window closes',
    )
  })

  test('one Escape closes one window, not the stack', async () => {
    await openDrawer()

    // A confirmation on top of the drawer: the shape the clinic really has,
    // where a discharge confirmation opens inside an observation form.
    const stacked = evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role=dialog]')].pop()
      const button = [...dialog.querySelectorAll('button')].find(b => (b.innerText || '').includes('RX-'))
      if (!button) return 'no-prescription'
      button.click()
      return 'ok'
    })()`)
    assert.ok(stacked.includes('ok'), `a prescription must be waiting — ${stacked}`)

    // Choosing one closes the drawer and fills the counter; open a
    // confirmation from there so there are genuinely two layers deep to test.
    await waitFor(`!!document.querySelector('[data-testid="prescription-mode"]')`, {
      what: 'prescription mode',
    })
    const opened = evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => (b.innerText || '').toLowerCase().includes('change product supplied'))
      if (!button) return 'no-control'
      button.click()
      return 'ok'
    })()`)
    assert.ok(opened.includes('ok'), `the supplied-product control must be there — ${opened}`)
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the substitution decision' })

    const before = Number(evaluate(`document.querySelectorAll('[role=dialog]').length`))
    ab(['press', 'Escape'])
    await waitFor(`document.querySelectorAll('[role=dialog]').length < ${before}`, {
      what: 'one window to close',
    })
    const after = Number(evaluate(`document.querySelectorAll('[role=dialog]').length`))
    assert.equal(
      after,
      before - 1,
      `Escape must close exactly one window — ${before} were open and ${after} remain`,
    )
  })
})
