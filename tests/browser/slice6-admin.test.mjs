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
  EVERY_SHAPE,
  LANDSCAPE,
  PORTRAIT,
  allStations,
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

// ── the operational overview ───────────────────────────────────────────────

const OVERVIEW = '[data-testid="admin-overview"]'
const EXCEPTION = '[data-testid="overview-exception"]'

/**
 * Every exception the administrator is being shown, as the screen has it.
 *
 * Note `\\s` below. This string becomes page code and a single backslash is
 * eaten on the way — the same escape that ate a `\d` in `auth.ts` during Slice
 * 1 and refused every PIN in the clinic. Doubling it is what puts a real `\s`
 * in front of the browser.
 */
const exceptionRows = () =>
  listFrom(`JSON.stringify([...document.querySelectorAll('${EXCEPTION}')].map(row => ({
    id: row.getAttribute('data-exception'),
    count: (row.querySelector('[data-testid="exception-count"]')?.innerText || '').trim(),
    action: (row.querySelector('button')?.innerText || '').trim(),
    text: (row.innerText || '').replace(/\\s+/g, ' ').trim(),
  })))`)

/** Land on the administrator's first screen. The owner is a doctor too, so
    the tablet opens on the queue and Overview is one tap away on the rail. */
async function openOverview() {
  await goToStation('Overview')
  await waitFor(`!!document.querySelector('${OVERVIEW}')`, {
    what: 'the operational overview',
    timeout: 20_000,
  })
}

describe('the operational overview', () => {
  test('every exception carries a count, a word for it, and the station that settles it', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openOverview()

    const rows = exceptionRows()
    assert.ok(
      rows.length > 0,
      `the fixture clinic has people waiting, stock below its reorder level and bills owing, so the overview must list something — screen says:\n${workText().slice(0, 900)}`,
    )

    for (const row of rows) {
      // A figure on its own means nothing. Every row is a number AND the word
      // for what the number counts.
      assert.match(
        row.count,
        /^\d+$/,
        `exception "${row.id}" must show a count — it showed "${row.count}"`,
      )
      assert.ok(
        row.text.length > row.count.length + 8,
        `exception "${row.id}" must say what its count counts — it read "${row.text}"`,
      )
      // Severity is carried by a word as well as a colour, every time.
      assert.ok(
        row.text.includes('Act now') || row.text.includes('Watch'),
        `exception "${row.id}" states its urgency only in colour — it read "${row.text}"`,
      )
    }

    // At least one of them offers the control that resolves it. The plan's
    // requirement for this screen is "See operational exceptions and move
    // directly to the responsible control."
    const withStation = rows.filter((row) => row.action.toLowerCase().startsWith('open '))
    assert.ok(
      withStation.length > 0,
      `no exception offered a station to open — rows were ${rows.map((row) => `${row.id}:${row.action}`).join(', ')}`,
    )
  })

  test('a bill under financial review is on the overview, in the words the command refuses in', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openOverview()

    const review = exceptionRows().find((row) => row.id === 'financial-review')
    assert.ok(
      review,
      `the fixtures carry an over-refunded bill and a cancelled bill that is not at nothing; both belong on the administrator's first screen — rows were ${exceptionRows()
        .map((row) => row.id)
        .join(', ')}`,
    )

    // Policy register items 50 and 61 fix these words, and `counter.ts`
    // refuses a counter in them. The administrator meets the same sentence.
    assert.match(
      review.text,
      /financial correction required/i,
      `the review row must say what the command says — it read "${review.text}"`,
    )
    // Named, not merely counted: an administrator opening Billing needs to
    // know which bills. (`INV-` rather than a regex: a single backslash does
    // not survive the trip into the page.)
    assert.ok(
      review.text.includes('INV-'),
      `the review row must name the bills it is about — it read "${review.text}"`,
    )
    assert.ok(
      review.action.toLowerCase().includes('billing'),
      `a bill under review is settled from Billing — the row offered "${review.action}"`,
    )
  })

  test('opening an exception moves to its station and does not resolve it', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openOverview()

    const opened = evaluate(`(() => {
      const row = [...document.querySelectorAll('${EXCEPTION}')]
        .find(r => r.getAttribute('data-exception') === 'financial-review')
      if (!row) return 'no-row'
      const button = row.querySelector('button')
      if (!button) return 'no-button'
      button.click()
      return 'ok'
    })()`)
    assert.ok(opened.includes('ok'), 'the financial-review row must offer a way to Billing')

    await waitFor(mainSays('bill register'), { what: 'the bill register', timeout: 20_000 })

    // Back again. An exception is a fact about the clinic, not a notification:
    // it stays until the ledger says otherwise, not until somebody looks at it.
    await openOverview()
    assert.ok(
      exceptionRows().some((row) => row.id === 'financial-review'),
      'an exception must stay visible until it is resolved, not until it is opened',
    )
  })

  test('the overview holds at every shape the plan names', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await openOverview()

    for (const shape of EVERY_SHAPE) {
      setViewport(shape)
      await waitFor(`!!document.querySelector('${OVERVIEW}')`, {
        what: `the overview at ${shape.name}`,
      })
      assert.ok(
        sidewaysScroll() <= 1,
        `the overview scrolled sideways by ${sidewaysScroll()}px at ${shape.name}`,
      )
      // Nothing a thumb has to hit may be under the touch floor.
      const short = listFrom(`JSON.stringify([...document.querySelectorAll('${EXCEPTION} button')]
        .map(b => ({ label: (b.innerText || '').trim(), height: Math.round(b.getBoundingClientRect().height) }))
        .filter(b => b.height > 0 && b.height < 44))`)
      assert.deepEqual(
        short,
        [],
        `every control on the overview must clear 44px at ${shape.name} — ${JSON.stringify(short)}`,
      )
    }
  })
})

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
      // `today` is the queue. The redesign gave each station the name the
      // person using it actually says out loud, and the doctor says "today".
      'overview', 'reports', 'staff', 'patients', 'today', 'consult',
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

    // Reachable, not necessarily on the daily bar. Settling a legacy
    // prescription line is occasional work, so it lives under More — which the
    // plan allows explicitly, and which is why this asks the union rather than
    // the three stations a doctor works from all day.
    const doctorRail = (await allStations()).map((label) => label.toLowerCase())
    assert.ok(
      doctorRail.some((label) => label.startsWith('review')),
      `a doctor must be able to reach the review queue — reachable is ${doctorRail.join(', ')}`,
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
    // The union again, and here it is the stronger assertion: a station hidden
    // under More would still be a station a pharmacist could reach.
    const pharmacyRail = (await allStations()).map((label) => label.toLowerCase())
    assert.ok(
      !pharmacyRail.some((label) => label.startsWith('review')),
      `only a doctor may settle a signed line — a pharmacist can reach ${pharmacyRail.join(', ')}`,
    )
  })
})
