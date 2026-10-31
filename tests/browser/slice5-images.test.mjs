/**
 * Slice 5 on the screen.
 *
 * The database suite proves the access rules. This proves the doctor can reach
 * them and that the screen says the right things while doing so: consent is
 * asked for first, a photograph reaches the record, and — the part only a
 * browser can check — nothing anywhere on the page is a durable URL pointing
 * at a clinical photograph.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE,
  clickButton,
  fillField,
  freshPage,
  goToStation,
  openDisclosure,
  setViewport,
  signIn,
  workShowing,
  workText,
} from './support/clinic-ui.mjs'

const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

const mainSays = (words) =>
  `document.querySelector('main').innerText.toLowerCase().includes(${JSON.stringify(String(words).toLowerCase())})`

/**
 * Open Consult on whichever patient the queue offers.
 *
 * Through `Call in` rather than by navigating to Consult, because Consult with
 * nobody selected is an empty screen — which is right, and is also why a test
 * that navigates straight there waits twenty seconds for a card that is not
 * going to be drawn.
 */
async function openConsultation() {
  if (await onConsultation()) return
  await goToStation('Today')
  await waitFor(mainSays('call in'), { what: 'the queue' })
  const called = evaluate(`(() => {
    const button = [...document.querySelectorAll('main button')]
      .find(b => /call in/i.test(b.innerText))
    if (!button) return 'none'
    button.click()
    return 'ok'
  })()`)
  if (!called.includes('ok')) throw new Error('nobody is waiting in the queue to call in')
  await waitFor(mainSays('clinical images'), { what: 'the consultation', timeout: 20_000 })
}

async function onConsultation() {
  return evaluate(`(document.querySelector('main')?.innerText ?? '').toLowerCase().includes('clinical images')`)
    .includes('true')
}

describe('clinical images on the doctor\'s screen', () => {
  test('consent is asked for before a photograph, in the doctor\'s own words', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openConsultation()

    assert.ok(
      workShowing('no photographs on this record'),
      `a patient with no images must say so — screen says:\n${workText().slice(-900)}`,
    )

    openDisclosure('Consent for photographs')
    await waitFor(mainSays('what the photographs are for'), { what: 'the consent form' })
    assert.ok(
      workShowing('a photograph cannot be taken without this'),
      'the screen must say consent comes first',
    )

    fillField('Who consented', 'The patient')
    fillField('What the photographs are for', 'Recording the dressing before and after')
    clickButton('Record consent')
    await waitFor(mainSays('consent recorded'), { what: 'the recorded consent', timeout: 20_000 })
  })

  test('a photograph reaches the record, and the record says who took it', async () => {
    setViewport(LANDSCAPE)
    await openConsultation()

    /*
     * A real file, put into the real picker.
     *
     * `DataTransfer` is how a test attaches one without a file dialog; the
     * bytes are a one-pixel PNG, so the checksum the server stores is a
     * checksum of something.
     */
    const attached = evaluate(`(() => {
      const input = [...document.querySelectorAll('main input[type=file]')][0]
      if (!input) return 'no-picker'
      const png = Uint8Array.from([
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
        0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
        0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
        0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
        0x42,0x60,0x82,
      ])
      const file = new File([png], 'wound.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(attached.includes('ok'), `the capture form must offer a picker — ${attached}`)

    // The consent recorded a moment ago is the one offered.
    const chose = evaluate(`(() => {
      const label = [...document.querySelectorAll('main label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('consent'))
      const select = label?.querySelector('select')
      const option = [...(select?.options ?? [])].find(o => o.value)
      if (!option) return 'no-consent-option'
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        .call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(chose.includes('ok'), `the capture form must offer the consent — ${chose}`)

    fillField('Body site', 'Left forearm')
    clickButton('Save to this patient')
    await waitFor(mainSays('photograph saved'), { what: 'the saved photograph', timeout: 25_000 })

    assert.ok(workShowing('left forearm'), 'the record shows where it was taken')
    assert.ok(workShowing(OWNER.name.split(' ').pop()), 'and who took it')
  })

  test('no clinical photograph is ever a durable URL', async () => {
    setViewport(LANDSCAPE)
    await openConsultation()
    await waitFor(mainSays('left forearm'), { what: 'the image record' })

    /*
     * The claim this test exists for.
     *
     * Every image on the page is drawn from a `blob:` URL created in this tab
     * and revoked when the panel unmounts. Nothing points at object storage,
     * nothing carries a session token in a query string, and nothing survives
     * the page — so a browser history, a referrer or a screenshot of the
     * address bar carries no photograph away.
     */
    const sources = JSON.parse(
      evaluate(`JSON.stringify([...document.images].map(i => i.currentSrc || i.src))`)
        .replace(/^"|"$/g, '').replace(/\\"/g, '"'),
    )
    // The page also draws its own icon, which is a static asset and not a
    // patient. What matters is that at least one photograph IS drawn, and that
    // nothing on the page points at the image endpoint.
    assert.ok(
      sources.some((source) => source.startsWith('blob:')),
      `a photograph must actually be drawn — sources are ${sources.join(', ')}`,
    )
    for (const source of sources) {
      assert.ok(
        !/imageId|ticket|images\?/i.test(source),
        `an image is drawn from ${source}, which outlives this page`,
      )
    }

    const url = evaluate('document.location.href').replace(/"/g, '')
    assert.ok(!/token|ticket|image/i.test(url), `the address bar carries ${url}`)
  })
})
