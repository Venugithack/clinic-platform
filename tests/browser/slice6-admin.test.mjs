/**
 * Slice 6 on the screen.
 *
 * The database suite proves the role matrix and the arithmetic. What only a
 * browser can say is whether the administrator's twenty stations read as a
 * building rather than a list, whether a report the server refuses is actually
 * absent from the screen rather than merely disabled on it, and whether the
 * doctor's review queue is offered to a doctor and to nobody else.
 *
 * The middle one is the one worth having. `hasRole` refusing a pharmacist the
 * consultation-fee report is a test in slice6-gate.test.mjs; that the
 * pharmacist's screen never offers it in the first place is a different claim,
 * and the two have to agree or one of them is decoration.
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
  railStations,
  setViewport,
  signIn,
  workShowing,
  workText,
} from './support/clinic-ui.mjs'

/** Doctor and administrator both — the owner, which is the common case. */
const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }
/** Pharmacy alone. Six digits: this fixture has not been reset yet. */
const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }
/** Seeded by the gate, because the fixtures' doctor also holds admin. */
const DOCTOR_ONLY = { name: 'Dr Kavitha Solo', pin: '3517' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

const RAIL = 'nav[aria-label="Clinic stations"]'
const REPORT_LIST = 'nav[aria-label="Reports"]'
const RANGE = '[aria-label="How far back this report reaches"]'

const mainSays = (words) =>
  `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(` +
  `${JSON.stringify(String(words).toLowerCase())})`

/** Read a JSON array back out of the page. */
function listFrom(js) {
  const raw = evaluate(js)
  try {
    return JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
}

/**
 * The section labels on the rail, in the order they are drawn.
 *
 * The sections are `role="group"` with `aria-labelledby`, not headings. That
 * is deliberate: a rail of four `<h2>`s in front of every screen's own `<h1>`
 * would put the furniture above the work in the heading outline a screen
 * reader navigates by. So the label is read the way assistive technology reads
 * it — through the group's accessible name.
 */
const railHeadings = () =>
  listFrom(
    `JSON.stringify([...document.querySelectorAll('${RAIL} [role=group]')]` +
      `.map(g => (document.getElementById(g.getAttribute('aria-labelledby'))?.innerText || '').trim())` +
      `.filter(Boolean))`,
  )

/** The reports this session is offered, by the first line of each button. */
const reportsOffered = () =>
  listFrom(
    `JSON.stringify([...document.querySelectorAll('${REPORT_LIST} button')]` +
      `.map(b => (b.innerText || '').split('\\n')[0].trim()).filter(Boolean))`,
  )

async function openReports() {
  await goToStation('Reports')
  await waitFor(`document.querySelectorAll('${REPORT_LIST} button').length > 0`, {
    what: 'the report list',
    timeout: 20_000,
  })
}

/** Whether the page can be scrolled sideways. It must never be. */
const sidewaysScroll = () =>
  Number(evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'))

describe('the administrator\'s rail', () => {
  test('twenty stations are divided into five sections, and none is lost', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)

    const headings = railHeadings().map((word) => word.toLowerCase())
    assert.deepEqual(
      headings,
      ['people and access', 'clinic operations', 'inventory', 'finance', 'settings'],
      `the rail must carry the five sections the brief names — it carries ${headings.join(', ') || 'none'}`,
    )

    // Grouping is a rearrangement, not a filter. Every station this session
    // had before is still reachable, including the ones Slices 3 to 6 added.
    const stations = railStations().map((label) => label.toLowerCase())
    for (const station of [
      'overview', 'reports', 'staff', 'patients', 'queue', 'consult',
      'formulary', 'receiving', 'counter', 'day book', 'clinic',
    ]) {
      assert.ok(
        stations.some((label) => label.startsWith(station)),
        `"${station}" fell off the grouped rail — rail is ${stations.join(', ')}`,
      )
    }

    // Overview and Reports belong to no division, so they sit above the first
    // heading rather than being filed under the wrong one four fifths of the
    // time.
    const ungrouped = listFrom(`(() => {
      const rail = document.querySelector('${RAIL}')
      // Every container that directly holds station buttons, grouped or not.
      const holders = [...rail.querySelectorAll('div')]
        .filter(d => !!d.querySelector(':scope > button'))
      const firstGroup = holders.findIndex(d => d.getAttribute('role') === 'group')
      return JSON.stringify(holders.slice(0, firstGroup < 0 ? 0 : firstGroup)
        .flatMap(d => [...d.querySelectorAll(':scope > button')]
          .map(b => (b.innerText || '').trim().toLowerCase())))
    })()`)
    // The rail's own chrome — the drawer's close button, Sign out — sits in
    // the same column and is not a station.
    const stationsAbove = ungrouped.filter((label) => label && label !== '×' && label !== 'sign out')
    assert.deepEqual(
      stationsAbove,
      ['overview', 'reports'],
      `only Overview and Reports belong above the first heading — found ${stationsAbove.join(', ') || 'nothing'}`,
    )
  })
})

describe('reports', () => {
  test('a dated report offers a range and a report about now does not', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openReports()

    clickButton('Stock on hand')
    await waitFor(mainSays('every active medicine'), { what: 'stock on hand', timeout: 20_000 })
    assert.ok(
      workShowing('amlodipine'),
      `stock on hand must name the clinic's own medicines — screen says:\n${workText().slice(0, 900)}`,
    )
    // Stock on hand is a question about now. A range control over it would
    // invite the reader to believe a number that never moved.
    assert.equal(
      evaluate(`!!document.querySelector('${RANGE}')`).includes('true'),
      false,
      'a report about now must not offer a range',
    )

    clickButton('Payments')
    await waitFor(`!!document.querySelector('${RANGE}')`, {
      what: 'the range control',
      timeout: 20_000,
    })

    // A uuid is for this screen to act on, not for anybody to read. The review
    // queue needs the line id; a reader of a report does not.
    assert.equal(
      evaluate(
        `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(` +
          `document.querySelector('main')?.innerText ?? '')`,
      ).includes('true'),
      false,
      'no report may print a raw identifier at the reader',
    )
  })

  test('a pharmacist is offered only the reports a pharmacist may read', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    await openReports()

    const offered = reportsOffered().map((title) => title.toLowerCase())
    assert.ok(offered.length > 0, 'the pharmacist must be offered something')

    for (const allowed of ['stock on hand', 'purchasing', 'dispensing']) {
      assert.ok(
        offered.includes(allowed),
        `the pharmacy desk needs "${allowed}" — it was offered ${offered.join(', ')}`,
      )
    }

    // Not hidden by CSS and not disabled: absent, because the server never
    // listed them for this session.
    for (const refused of ['consultation fees', 'image access', 'reversals']) {
      assert.ok(
        !offered.includes(refused),
        `"${refused}" is not the pharmacy's to read, and it was offered ${offered.join(', ')}`,
      )
    }
  })

  test('the widest table this clinic draws does not push the page sideways', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openReports()
    clickButton('Stock on hand')
    await waitFor(mainSays('every active medicine'), { what: 'stock on hand', timeout: 20_000 })

    assert.ok(
      sidewaysScroll() <= 1,
      `the page scrolled sideways by ${sidewaysScroll()}px at ${LANDSCAPE.name} — a table must scroll inside its own box`,
    )

    setViewport(PORTRAIT)
    await waitFor(mainSays('every active medicine'), { what: 'stock on hand in portrait' })
    assert.ok(
      sidewaysScroll() <= 1,
      `the page scrolled sideways by ${sidewaysScroll()}px at ${PORTRAIT.name}`,
    )
  })
})

describe('the doctor review queue', () => {
  test('a doctor is offered the station and a pharmacist is not', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ONLY.name, DOCTOR_ONLY.pin)

    const doctorRail = railStations().map((label) => label.toLowerCase())
    assert.ok(
      doctorRail.some((label) => label.startsWith('review')),
      `a doctor must be offered the review queue — rail is ${doctorRail.join(', ')}`,
    )

    await goToStation('Review')
    // Either there are lines to settle or there are none, and the screen has
    // to say which. What it must not do is sit blank.
    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').trim().length > 40`,
      { what: 'the review queue', timeout: 20_000 },
    )

    await freshPage()
    await signIn(PHARMACIST.name, PHARMACIST.pin)
    const pharmacyRail = railStations().map((label) => label.toLowerCase())
    assert.ok(
      !pharmacyRail.some((label) => label.startsWith('review')),
      `only a doctor may settle a signed line — the pharmacy rail is ${pharmacyRail.join(', ')}`,
    )
  })
})
