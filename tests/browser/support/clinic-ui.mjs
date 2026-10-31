/**
 * Driving the clinic's screens the way a person does.
 *
 * Selectors live here rather than in the journeys, so a screen that moves
 * breaks one line instead of ten, and so a journey reads as what somebody did
 * rather than as a list of CSS.
 */
import { ab, evaluate, open, viewport, waitFor } from './harness.mjs'

/** 1024x768 is the stand in the cabin; 768x1024 is the same tablet turned. */
export const LANDSCAPE = { width: 1024, height: 768, name: 'landscape 1024x768' }
export const PORTRAIT = { width: 768, height: 1024, name: 'portrait 768x1024' }

/**
 * The other three the plan names, and why each one is in the list.
 *
 * The suite ran at 1024 and 768 only, which is how a 288px number pad inside a
 * 248px card sat on the clinic's very first screen without anybody noticing.
 *
 *   DESKTOP  the width the two-column consultation needs, and the only one
 *            where the doctor's history column has ever been drawn
 *   PHONE    a phone in a pocket, which is what somebody covering a shift
 *            actually has in their hand
 *   NARROW   the smallest screen the plan asks for, and the one that finds
 *            every fixed width
 */
export const DESKTOP = { width: 1280, height: 800, name: 'desktop 1280x800' }
export const PHONE = { width: 390, height: 844, name: 'phone 390px' }
export const NARROW = { width: 320, height: 568, name: 'narrow 320px' }

/** Every viewport the plan's acceptance gate names, in order. */
export const EVERY_SHAPE = [DESKTOP, LANDSCAPE, PORTRAIT, PHONE, NARROW]

export function setViewport({ width, height }) {
  viewport(width, height)
}

/** Reload to the lock screen, clearing whoever was signed in. */
export async function freshPage() {
  // localStorage carries the session token; a journey that starts signed in as
  // the last journey's user is a journey that passes for the wrong reason.
  ab(['storage', 'local', 'clear'], { allowFailure: true })
  // sessionStorage carries the consultation attempt key and the result
  // station's follow-up note. A journey that finds one left by the journey
  // before it can pass without the behaviour it names ever running.
  ab(['storage', 'session', 'clear'], { allowFailure: true })
  open('/')
  await waitFor(
    `!!document.querySelector('button') && document.body.innerText.includes('Jayamurugan')`,
    { what: 'the lock screen' },
  )
}

const PAD = "[aria-label='Number pad'] button"

/**
 * One key on the pad.
 *
 * The grid is nine digit buttons, an `aria-hidden` spacer, then 0 and Delete —
 * so `nth-of-type` counts buttons only and 0 is the tenth. Verified in the
 * browser rather than read off the source, because the spacer is exactly the
 * kind of thing that makes `nth-child` quietly point one key to the left.
 */
export function tapKey(key) {
  const index = key === '0' ? 10 : key === 'Delete' ? 11 : Number(key)
  ab(['click', `${PAD}:nth-of-type(${index})`])
}

export function tapPin(pin) {
  for (const digit of String(pin)) tapKey(digit)
}

/** How many dots the pad is drawing, and how many are filled. */
export const padDots = () => Number(evaluate(`document.querySelectorAll('[role=status] span').length`))
export const padFilled = () =>
  Number(evaluate(`document.querySelectorAll('[role=status] span.bg-ink').length`))
export const padLabel = () =>
  evaluate(`document.querySelector('[role=status]')?.getAttribute('aria-label') ?? ''`).replace(/"/g, '')

/** Choose a name on the lock screen. */
export function chooseStaff(name) {
  ab(['find', 'text', name, 'click'])
}

/** Choose a name, type a PIN, and wait for the workspace to appear. */
export async function signIn(name, pin) {
  chooseStaff(name)
  await waitFor(`document.body.innerText.includes('PIN')`, { what: 'the PIN pad' })
  tapPin(pin)
  await waitFor(`!!document.querySelector('nav')`, { what: 'the workspace rail', timeout: 20_000 })
}

/** The stations on the rail, in order, as a signed-in person sees them. */
/**
 * The rail, and only the rail.
 *
 * `nav button` used to be enough. It is not any more: Slice 6's Reports screen
 * puts its own `<nav aria-label="Reports">` inside `<main>`, so an unscoped
 * selector reads fourteen report names as if they were stations the moment
 * that screen is open. The rail names itself, so ask for it by name.
 */
const RAIL = 'nav[aria-label="Clinic stations"]'

export function railStations() {
  const raw = evaluate(
    `JSON.stringify([...document.querySelectorAll('${RAIL} button, ${RAIL} a')]
       .map(el => (el.innerText || '').split('\\n')[0].trim())
       .filter(Boolean))`,
  )
  let items = []
  try {
    items = JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
  // The rail also carries the menu close button and Sign out, which are chrome
  // rather than stations and would otherwise show up in every assertion.
  // Matched case-insensitively: labels are sentence case now, and a filter
  // written against the old tracked capitals silently stops filtering.
  const chrome = new Set(['×', 'close', 'sign out'])
  return items.filter((label) => label && !chrome.has(label.trim().toLowerCase()))
}

/**
 * Everything this session can actually reach, bar and More together.
 *
 * A doctor, nurse or pharmacist now works from a three-station bar with
 * everything else one tap away under **More**, so the primary nav is no longer
 * the whole of what somebody is authorized for. The plan is explicit that this
 * is an arrangement and never a reduction — "Do not remove capabilities or
 * change permissions to make navigation look simpler" — and the only honest way
 * to test that is to count the union.
 *
 * An administrator has no More: that role keeps the full grouped rail, so this
 * is just `railStations()` there.
 */
export async function allStations() {
  const bar = railStations()
  if (!bar.some((label) => label.toLowerCase() === 'more')) return bar

  const opened = evaluate(`(() => {
    const more = [...document.querySelectorAll('${RAIL} button')]
      .find(el => (el.innerText || '').trim().toLowerCase() === 'more')
    if (!more) return 'no-more'
    more.click()
    return 'ok'
  })()`)
  if (opened.includes('no-more')) return bar

  await waitFor(`document.querySelector('[data-jmc-layer] [role=dialog]') !== null`, {
    what: 'the More drawer',
  })
  const raw = evaluate(
    `JSON.stringify([...document.querySelectorAll('[data-jmc-layer] [role=dialog] button')]
       .map(el => (el.innerText || '').split('\\n')[0].trim())
       .filter(Boolean))`,
  )
  let extra = []
  try {
    extra = JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    extra = []
  }
  evaluate(`(() => {
    const close = [...document.querySelectorAll('[data-jmc-layer] [role=dialog] button')]
      .find(el => (el.getAttribute('aria-label') || '') === 'Close')
    if (close) close.click()
    return 'ok'
  })()`)
  await waitFor(`document.querySelector('[data-jmc-layer] [role=dialog]') === null`, {
    what: 'the More drawer to close',
  })

  const chrome = new Set(['close', 'sign out', 'more'])
  const seen = new Set()
  return [...bar, ...extra]
    .filter((label) => label && !chrome.has(label.trim().toLowerCase()))
    .filter((label) => (seen.has(label) ? false : seen.add(label)))
}

/**
 * Move to a station by its label.
 *
 * Looks on the bar first, then inside **More** — which is where most of a
 * clinical role's stations now live. Matched case-insensitively and by prefix,
 * because a bar entry renders its icon and its label as one element and a
 * drawer entry carries the station's one-line description underneath it.
 */
export async function goToStation(label) {
  const wanted = JSON.stringify(label.toLowerCase())
  const onBar = evaluate(`(() => {
    const item = [...document.querySelectorAll('${RAIL} button, ${RAIL} a')]
      .find(el => (el.innerText || '').split('\\n')[0].trim().toLowerCase()
        .startsWith(${wanted}))
    if (!item) return 'no-station'
    item.click()
    return 'ok'
  })()`)

  if (onBar.includes('no-station')) {
    const opened = evaluate(`(() => {
      const more = [...document.querySelectorAll('${RAIL} button')]
        .find(el => (el.innerText || '').trim().toLowerCase() === 'more')
      if (!more) return 'no-more'
      more.click()
      return 'ok'
    })()`)
    if (opened.includes('no-more')) {
      throw new Error(
        `no station called "${label}" on this rail and no More menu — rail is ${railStations().join(', ')}`,
      )
    }
    await waitFor(`document.querySelector('[data-jmc-layer] [role=dialog]') !== null`, {
      what: 'the More drawer',
    })
    const inDrawer = evaluate(`(() => {
      const item = [...document.querySelectorAll('[data-jmc-layer] [role=dialog] button')]
        .find(el => (el.innerText || '').split('\\n')[0].trim().toLowerCase()
          .startsWith(${wanted}))
      if (!item) return 'no-station'
      item.click()
      return 'ok'
    })()`)
    if (inDrawer.includes('no-station')) {
      const all = await allStations()
      throw new Error(`no station called "${label}" — this session can reach ${all.join(', ')}`)
    }
    await waitFor(`document.querySelector('[data-jmc-layer] [role=dialog]') === null`, {
      what: 'the More drawer to close',
    })
  }

  await waitFor(`(document.querySelector('main')?.innerText ?? '').length > 0`, {
    what: `the ${label} station`,
  })
}

/** Everything the page is currently showing, as one string. */
export const visibleText = () => evaluate(`document.body.innerText`)

/**
 * Just the work surface.
 *
 * `document.body.innerText` includes the navigation rail, which names every
 * station in the clinic — so "is the word Vitals on this screen" is true on
 * every screen and asserts nothing.
 */
export const workText = () =>
  evaluate(`(document.querySelector('main')?.innerText ?? document.body.innerText)`)

export const workShowing = (needle) =>
  evaluate(
    `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(` +
      `${JSON.stringify(String(needle).toLowerCase())})`,
  ).includes('true')

/** Whether some words are on the screen right now. */
export const showing = (needle) =>
  evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(String(needle).toLowerCase())})`)
    .includes('true')

/** Fill a labelled field. Labels are what a person reads, so tests use them. */
export function fillField(label, value) {
  const filled = evaluate(`(() => {
    const field = [...document.querySelectorAll('label')]
      .find(l => l.innerText.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}))
    const input = field?.querySelector('input, textarea, select')
      ?? (field?.htmlFor ? document.getElementById(field.htmlFor) : null)
      ?? field?.parentElement?.querySelector('input, textarea, select')
    if (!input) return 'no-field'
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  if (filled.includes('no-field')) throw new Error(`no field labelled "${label}" on this screen`)
}

/** Click a button by the words on it. */
export function clickButton(label) {
  const clicked = evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .filter(b => !b.disabled)
      .find(b => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase()
        .includes(${JSON.stringify(label.toLowerCase())}))
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  if (clicked.includes('no-button')) {
    throw new Error(`no enabled button reading "${label}" on this screen`)
  }
}

/**
 * Open a `Disclosure` by the words in its summary.
 *
 * Not `clickButton('Open')`: the register table has an `OPEN` action on every
 * row, so matching the word alone opens a patient record instead of the form
 * and the test then fails somewhere else entirely.
 */
export function openDisclosure(title) {
  const opened = evaluate(`(() => {
    const wanted = ${JSON.stringify(title.toLowerCase())}
    const summary = [...document.querySelectorAll('summary, [role=button], button')]
      .find(el => (el.innerText || '').trim().toLowerCase().includes(wanted))
    if (!summary) return 'no-disclosure'
    const details = summary.closest('details')
    if (details) { details.open = true; return 'ok' }
    summary.click()
    return 'ok'
  })()`)
  if (opened.includes('no-disclosure')) throw new Error(`no disclosure reading "${title}" on this screen`)
}

export function buttonExists(label) {
  return evaluate(`[...document.querySelectorAll('button')].some(b =>
    (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase()
      .includes(${JSON.stringify(label.toLowerCase())}))`).includes('true')
}

// ── vitals ─────────────────────────────────────────────────────────────────
//
// The vitals screen is not a form of text boxes. It is five reading rows and
// one on-screen pad: tap a row to start entering it, tap digits, tap the next
// row. That is deliberate — docs/reference/TABLET.md rule 3 keeps the OS keyboard off a 10"
// screen, where it covers exactly the field being filled in — and it means a
// test drives it by tapping too, rather than by setting input values.

/** Choose whose readings these are, from the empty state's picker. */
export function chooseVitalsPatient(nameFragment) {
  const chosen = evaluate(`(() => {
    const select = document.querySelector('main select')
    if (!select) return 'no-picker'
    const option = [...select.options].find(o => o.textContent.includes(${JSON.stringify(nameFragment)}))
    if (!option) return 'no-patient'
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  if (chosen.includes('no-picker')) throw new Error('the vitals screen has no patient picker')
  if (chosen.includes('no-patient')) throw new Error(`no patient matching "${nameFragment}" to choose`)
}

/** Start entering one reading — Blood pressure, Pulse, SpO2, Temperature, Weight. */
export function startReading(rowLabel) {
  const tapped = evaluate(`(() => {
    const row = [...document.querySelectorAll('main button')]
      .find(b => (b.innerText || '').trim().toLowerCase()
        .startsWith(${JSON.stringify(rowLabel.toLowerCase())}))
    if (!row) return 'no-row'
    row.click()
    return 'ok'
  })()`)
  if (tapped.includes('no-row')) throw new Error(`no reading row called "${rowLabel}"`)
}

/**
 * One key on the vitals pad.
 *
 * Matched by the character on the key rather than by position: this pad
 * carries `/` for blood pressure and `.` for a decimal, so the numpad's
 * nth-of-type arithmetic does not transfer.
 */
export function tapVitalsKey(character) {
  const tapped = evaluate(`(() => {
    const key = [...document.querySelectorAll('main button')]
      .find(b => (b.innerText || '').trim() === ${JSON.stringify(character)})
    if (!key) return 'no-key'
    key.click()
    return 'ok'
  })()`)
  if (tapped.includes('no-key')) throw new Error(`no "${character}" key on the vitals pad`)
}

/** Tap a whole reading in: startReading, then every character of it. */
export function enterReading(rowLabel, value) {
  startReading(rowLabel)
  for (const character of String(value)) tapVitalsKey(character)
}

/**
 * What each row currently reads — the screen's own summary of the record.
 *
 * Note the `\s` in the regex below. This string is a template literal that
 * becomes page code, so a single backslash is eaten on the way: `\s` arrives
 * as plain `s`, the pattern becomes /s+/g, and every lowercase s on the
 * screen is replaced with a space. It reads as "Not mea ured" and looks like
 * a typo in the product rather than a bug in the test. The same escape ate a
 * `\d` in auth.ts during Slice 1 and refused every PIN in the clinic.
 */
export function readingRows() {
  const raw = evaluate(`JSON.stringify([...document.querySelectorAll('main button')]
    .map(b => (b.innerText || '').trim())
    .filter(t => /^(blood pressure|temperature|pulse|spo|weight)/i.test(t))
    .map(t => t.replace(/\\s+/g, ' ')))`)
  try {
    return JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw)
  } catch {
    return []
  }
}
