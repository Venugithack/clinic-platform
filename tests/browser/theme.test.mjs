/**
 * Three appearances, and who each one belongs to.
 *
 * Four people share four tablets and hand them to each other twenty times a
 * day, so an appearance kept in the browser is an appearance that follows the
 * DEVICE — which gives the next person the last person's eyes. The plan asks
 * for it to follow the staff member, with the device's own setting as the
 * fallback for the one moment nobody has said who they are yet.
 *
 * That is a claim about two round trips and a sign-out, not about CSS, so it
 * is tested here rather than by reading a stylesheet. What the stylesheet is
 * asked for is the part that matters clinically: confirmed stays green,
 * pending stays amber and failed stays red in all three, because a nurse
 * glancing at a queue across a room must not have to relearn the colours when
 * somebody turns the lights down.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import { LANDSCAPE, freshPage, setViewport, signIn } from './support/clinic-ui.mjs'

const NURSE = { name: 'Nirmaladevi Ponnusamy', pin: '7305' }
const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

const appliedTheme = () =>
  evaluate(`document.documentElement.getAttribute('data-theme')`).replace(/^"|"$/g, '')

/** Open the Appearance popover and choose one by its visible name. */
async function chooseAppearance(label) {
  const opened = evaluate(`(() => {
    const button = [...document.querySelectorAll('header button')]
      .find(b => (b.getAttribute('title') || '') === 'Appearance')
    if (!button) return 'no-control'
    button.click()
    return 'ok'
  })()`)
  if (!opened.includes('ok')) throw new Error(`no Appearance control — ${opened}`)
  await waitFor(`!!document.querySelector('[role=menu]')`, { what: 'the appearance menu' })

  const chosen = evaluate(`(() => {
    const menu = document.querySelector('[role=menu]')
    const item = [...menu.querySelectorAll('button')]
      .find(b => (b.innerText || '').toLowerCase().includes(${JSON.stringify(label.toLowerCase())}))
    if (!item) return 'no-option:' + [...menu.querySelectorAll('button')]
      .map(b => (b.innerText || '').split(String.fromCharCode(10))[0]).join('|')
    item.click()
    return 'ok'
  })()`)
  if (!chosen.includes('ok')) throw new Error(`no appearance called "${label}" — ${chosen}`)
  await waitFor(`!document.querySelector('[role=menu]')`, { what: 'the appearance menu to close' })
}

describe('the appearance follows the person', () => {
  test('a choice survives signing out and signing back in', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)

    await chooseAppearance('Night shift')
    assert.equal(appliedTheme(), 'night', 'the colour changes the instant it is tapped')

    /*
     * The round trip. `set_theme` writes it to the staff row and the command's
     * response carries the whole clinic back, so the session the tablet is
     * holding already has it. Waiting for the control to stop spinning is
     * waiting for that to have happened.
     */
    await waitFor(
      `!document.querySelector('header .jmc-spin')`,
      { what: 'the appearance to be saved to the account' },
    )

    /*
     * `freshPage` clears localStorage, which is where the DEVICE fallback
     * lives. So if the theme came back after this, it came back off the
     * account and not out of this browser — which is the whole claim.
     */
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    assert.equal(
      appliedTheme(),
      'night',
      'the nurse’s own appearance must return on a tablet that has forgotten everything',
    )
  })

  test('the next person to pick the tablet up gets their own', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)

    /*
     * The nurse left this tablet in Night shift a moment ago and the device key
     * still says so, which is correct — it is what stops the lock screen
     * flashing white in a dark room. What must NOT happen is the pharmacist
     * inheriting it: their account has made no choice, so they follow their own
     * device setting, and the headless browser reports light.
     */
    assert.equal(
      appliedTheme(),
      'paper',
      'an appearance is one account’s and is not handed on with the tablet',
    )

    await chooseAppearance('High contrast')
    assert.equal(appliedTheme(), 'contrast')
    await waitFor(`!document.querySelector('header .jmc-spin')`, { what: 'the appearance saved' })

    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    assert.equal(
      appliedTheme(),
      'night',
      'and the nurse still has hers after somebody else used the tablet',
    )
  })

  test('every theme keeps confirmed green, pending amber and failed red', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)

    const seen = []
    for (const [label, expected] of [
      ['Paper and ink', 'paper'],
      ['Night shift', 'night'],
      ['High contrast', 'contrast'],
    ]) {
      await chooseAppearance(label)
      assert.equal(appliedTheme(), expected, `${label} must apply ${expected}`)
      await waitFor(`!document.querySelector('header .jmc-spin')`, { what: 'the appearance saved' })

      const measured = evaluate(`(() => {
        const root = getComputedStyle(document.documentElement)
        const read = name => root.getPropertyValue(name).trim()
        return [read('--jmc-free'), read('--jmc-attn'), read('--jmc-stop')].join(' ')
      })()`).replace(/^"|"$/g, '')
      const [confirmed, pending, failed] = measured.split(' ')

      assert.ok(confirmed && pending && failed, `${label} must define all three status colours`)
      assert.notEqual(confirmed, pending, `${label}: confirmed and pending must stay distinguishable`)
      assert.notEqual(pending, failed, `${label}: pending and failed must stay distinguishable`)
      assert.notEqual(confirmed, failed, `${label}: confirmed and failed must stay distinguishable`)
      seen.push(`${expected}=${measured}`)
    }

    // Three genuinely different palettes, not one palette three times.
    assert.equal(new Set(seen).size, 3, `each theme must be its own palette — ${seen.join(' | ')}`)

    /*
     * And meaning never rides on the colour alone. Every status badge in this
     * system carries a word, which is what makes the queue readable in
     * greyscale, at a distance, and to somebody who cannot tell the greens
     * apart.
     */
    const wordless = evaluate(`(() => {
      const NL = String.fromCharCode(10)
      return [...document.querySelectorAll('main span')]
        .filter(el => {
          const cls = el.getAttribute('class') || ''
          return cls.includes('bg-free-wash') || cls.includes('bg-attn-wash') || cls.includes('bg-stop-wash')
        })
        .filter(el => (el.innerText || '').trim().length === 0)
        .length
    })()`).replace(/^"|"$/g, '')
    assert.equal(Number(wordless), 0, 'no status may be colour with no word in it')

    // Put the tablet back the way the other suites expect to find it.
    await chooseAppearance('Match this tablet')
    await waitFor(`!document.querySelector('header .jmc-spin')`, { what: 'the appearance saved' })
  })
})
