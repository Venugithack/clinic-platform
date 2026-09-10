/**
 * Slice 1, driven through a real browser.
 *
 * Everything under tests/characterization/ exercises the clinic's code. This
 * file exercises the clinic's *screens* — the half that had no coverage at all
 * and where Slice 1 found two of its defects (a doctor-only account shown no
 * register button, and a rail with no Vitals station, both with working
 * backends behind them).
 *
 * It runs only against the guarded local staging environment. The static
 * export is checked before the server will serve it: if the bundle names the
 * live clinic project, the suite refuses to start rather than register real
 * patients in Chennai. See tests/browser/support/harness.mjs.
 *
 * Journeys are ordered as a clinic day, and they share one browser and one
 * database, so they run in sequence and each starts from the lock screen.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE,
  PORTRAIT,
  buttonExists,
  clickButton,
  chooseStaff,
  fillField,
  freshPage,
  goToStation,
  chooseVitalsPatient,
  enterReading,
  openDisclosure,
  padDots,
  padFilled,
  padLabel,
  railStations,
  setViewport,
  signIn,
  readingRows,
  tapKey,
  tapPin,
  workShowing,
  workText,
} from './support/clinic-ui.mjs'

/** Who the staging fixtures put on the lock screen. */
const DOCTOR_ADMIN = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }
const NURSE = { name: 'Nirmaladevi Ponnusamy', pin: '7305' }
/** Seeded by the runner, so a doctor-only rail can be seen as a doctor sees it. */
const DOCTOR_ONLY = { name: 'Dr Kavitha Solo', pin: '3517' }
/** A patient the fixtures already hold, for the duplicate suggestions. */
const EXISTING = { name: 'Chandrakala Sivagnanam', phone: '+999701000112' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

// ── sign-in ────────────────────────────────────────────────────────────────

describe('four-digit sign-in', () => {
  for (const shape of [LANDSCAPE, PORTRAIT]) {
    test(`the doctor signs in with four digits — ${shape.name}`, async () => {
      setViewport(shape)
      await freshPage()

      assert.ok(
        workShowing(DOCTOR_ADMIN.name) || evaluate('document.body.innerText').includes(DOCTOR_ADMIN.name),
        'the lock screen must list the clinic’s staff',
      )

      chooseStaff(DOCTOR_ADMIN.name)
      await waitFor(`document.body.innerText.includes('PIN')`, { what: 'the PIN pad' })

      // The pad is drawn from what the server said about THIS person, not from
      // a constant. Four dots for somebody who has been reset.
      assert.equal(padDots(), 4, 'a migrated account must be shown a four-dot pad')
      assert.match(padLabel(), /4-digit PIN entry/)
      assert.ok(
        evaluate('document.body.innerText').includes('four-digit'),
        'the prompt must say four digits',
      )

      tapPin(DOCTOR_ADMIN.pin)
      await waitFor(`!!document.querySelector('nav')`, { what: 'the workspace', timeout: 20_000 })
      assert.ok(evaluate('document.body.innerText').includes(DOCTOR_ADMIN.name))
    })
  }

  test('a wrong PIN is refused, and says nothing useful about why', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    chooseStaff(DOCTOR_ADMIN.name)
    await waitFor(`document.body.innerText.includes('PIN')`, { what: 'the PIN pad' })

    tapPin('9999')
    await waitFor(`document.body.innerText.includes('not right')`, { what: 'the refusal' })

    // Still on the pad, with nothing typed, and no clue about which half was
    // wrong. The message is the same one a nonexistent account would get.
    assert.equal(evaluate(`!!document.querySelector('nav')`).includes('true'), false)
    assert.equal(padFilled(), 0, 'the pad must clear itself for the next attempt')
  })

  test('Delete removes a digit rather than submitting a short PIN', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    chooseStaff(DOCTOR_ADMIN.name)
    await waitFor(`document.body.innerText.includes('PIN')`, { what: 'the PIN pad' })

    tapKey('4'); tapKey('8'); tapKey('1')
    assert.equal(padFilled(), 3)
    tapKey('Delete')
    assert.equal(padFilled(), 2)
    // Nothing was submitted on the way past three digits.
    assert.equal(evaluate(`!!document.querySelector('nav')`).includes('true'), false)
  })
})

// ── navigation ─────────────────────────────────────────────────────────────

describe('what each role is given to work with', () => {
  test('a doctor-only rail carries Consult and Vitals, and no counter or staff admin', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ONLY.name, DOCTOR_ONLY.pin)

    const rail = railStations().map((label) => label.toUpperCase())

    // Vitals is the one Slice 1 added. Without it `Record vitals` rendered for
    // nobody, on a day when the doctor is the only person in the building.
    for (const station of ['OVERVIEW', 'QUEUE', 'CONSULT', 'VITALS', 'PATIENTS', 'RECORDS']) {
      assert.ok(rail.includes(station), `a doctor needs ${station}; rail is ${rail.join(', ')}`)
    }
    for (const forbidden of ['COUNTER', 'STAFF', 'SUPPLIERS', 'ORDERS']) {
      assert.equal(rail.includes(forbidden), false, `${forbidden} is not a doctor's station`)
    }
  })

  test('a nurse rail carries Vitals and Beds, and not Consult', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)

    const rail = railStations().map((label) => label.toUpperCase())
    for (const station of ['OVERVIEW', 'QUEUE', 'VITALS', 'PATIENTS', 'BEDS']) {
      assert.ok(rail.includes(station), `a nurse needs ${station}; rail is ${rail.join(', ')}`)
    }
    // Signing a consultation is the doctor's, and the rail says so.
    assert.equal(rail.includes('CONSULT'), false)
    assert.equal(rail.includes('STAFF'), false)
  })

  test('holding two roles gets both rails, not the smaller one', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ADMIN.name, DOCTOR_ADMIN.pin)

    const rail = railStations().map((label) => label.toUpperCase())
    assert.ok(rail.includes('CONSULT'), 'the doctor half')
    assert.ok(rail.includes('STAFF'), 'the admin half')
  })
})

// ── registration, duplicates, token, vitals, consult ───────────────────────

describe('a doctor working alone, end to end', () => {
  /** A name nobody else in this suite uses, so a rerun cannot collide. */
  const walkIn = `Walkin ${Date.now().toString().slice(-6)}`

  test('duplicate suggestions appear before the patient is created', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ONLY.name, DOCTOR_ONLY.pin)
    await goToStation('Patients')

    // The button the doctor-only account was not shown before Slice 1.
    assert.ok(buttonExists('Register a new patient') || workShowing('register a new patient'))

    openDisclosure('Register a new patient')
    fillField('Full name', EXISTING.name)
    fillField('Mobile number', EXISTING.phone)

    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes('already')
        || (document.querySelector('main')?.innerText ?? '').toLowerCase().includes('same mobile')
        || (document.querySelector('main')?.innerText ?? '').toLowerCase().includes('same name')`,
      { what: 'a duplicate suggestion', timeout: 12_000 },
    )

    const shown = workText().toLowerCase()
    assert.ok(shown.includes('same mobile') || shown.includes('same name'), 'the screen must say WHY it is asking')
    assert.ok(shown.includes(EXISTING.name.toLowerCase()), 'and name the person it thinks this might be')

    // It suggests. It does not decide: creating is still offered.
    assert.ok(buttonExists('Save patient'), 'a suggestion must never block registration')
  })

  test('the doctor registers a walk-in, is given a token, and records partial vitals', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ONLY.name, DOCTOR_ONLY.pin)
    await goToStation('Patients')

    openDisclosure('Register a new patient')
    fillField('Full name', walkIn)
    fillField('Age', '41')
    fillField('Mobile number', '+999701000901')
    clickButton('Save patient')

    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').includes(${JSON.stringify(walkIn)})`,
      { what: 'the new patient in the register', timeout: 15_000 },
    )

    // ── the token ──────────────────────────────────────────────────────────
    openDisclosure("Add to today's queue")
    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes('reason')`,
      { what: 'the queue form' },
    )
    fillField('Reason', 'Chest pain')
    clickButton('Add to')

    await goToStation('Queue')
    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').includes(${JSON.stringify(walkIn)})`,
      { what: 'the walk-in on the queue', timeout: 15_000 },
    )
    assert.match(workText(), /JMC[\s\S]{0,12}\d{4}/, 'the patient must be holding a token number')

    // ── vitals, with the ones he could not take left out ───────────────────
    await goToStation('Vitals')
    await waitFor(`!!document.querySelector('main select')`, { what: 'the vitals patient picker' })
    chooseVitalsPatient(walkIn)
    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes('blood pressure')`,
      { what: 'the reading rows' },
    )

    // Two readings out of five. No oximeter, no scales, and no invented
    // numbers — which is the whole of what Slice 1 changed on this screen.
    enterReading('Blood pressure', '138/86')
    enterReading('Pulse', '92')
    fillField('Why a reading is missing', 'No oximeter or scales in the cabin')

    // Before saving, the untouched rows already say what they are.
    const beforeSaving = readingRows().join(' | ').toLowerCase()
    assert.match(beforeSaving, /spo[^|]*not measured/, `the SpO2 row should read not measured: ${beforeSaving}`)

    clickButton('Save vitals')
    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').includes('138/86')`,
      { what: 'the saved reading', timeout: 15_000 },
    )

    const afterSaving = workText()
    assert.match(afterSaving, /138\/86/, 'the readings that were taken must be shown')
    assert.match(afterSaving, /92/, 'including the pulse')
    assert.match(afterSaving.toLowerCase(), /not measured/, 'and the ones that were not must say so')
    assert.equal(
      /\b0\s*%/.test(afterSaving),
      false,
      'a reading nobody took must never render as zero — that reads as a patient who is not breathing',
    )
    assert.match(afterSaving, /No oximeter or scales/, 'and the reason must survive with the record')
  })

  test('Call in opens the consultation on the same patient, without choosing again', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR_ADMIN.name, DOCTOR_ADMIN.pin)
    await goToStation('Queue')

    // Find the CALL IN button, then walk UP to whatever element is acting as
    // that patient's row. The queue is built from divs rather than a table, so
    // a `tr, li, article` selector finds nothing and the test fails claiming
    // the queue is empty when it is full.
    const waiting = evaluate(`(() => {
      const button = [...document.querySelectorAll('main button')]
        .find(b => /call in/i.test(b.innerText))
      if (!button) return 'none'
      let row = button
      while (row && !/JMC/.test(row.innerText)) row = row.parentElement
      // String.fromCharCode(10) rather than a newline escape, and a character
      // class rather than \\d. This whole block is a string that becomes page
      // code, and one backslash is eaten on the way — the same escape has now
      // silently broken a regex twice in this project, once in auth.ts where
      // it refused every PIN in the clinic. Writing it without backslashes
      // means there is nothing left to get wrong.
      const newline = String.fromCharCode(10)
      const skip = ['waiting', 'call in', 'vitals', 'mark done', 'open consult', 'in consult', 'done']
      const name = (row ? row.innerText.split(newline) : [])
        .map(line => line.trim())
        .find(line => line.length > 3
          && line.slice(0, 3) !== 'JMC'
          && !/^[0-9]+$/.test(line)
          && !skip.includes(line.toLowerCase()))
      button.click()
      return name || 'unnamed'
    })()`).replace(/^"|"$/g, '')

    assert.notEqual(waiting, 'none', 'the queue must have somebody waiting to call in')

    await waitFor(
      `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes('consult')`,
      { what: 'the consultation workspace', timeout: 15_000 },
    )

    // The patient came with. This is the whole point of the shared selection:
    // before Slice 1 the doctor arrived at Consult and picked the same person
    // out of an all-patient dropdown for the second time in one visit.
    assert.ok(
      workText().includes(waiting.split(' ')[0]),
      `Consult should have opened on ${waiting}; it shows ${workText().slice(0, 160)}`,
    )
  })
})

// ── the tablet, both ways up ───────────────────────────────────────────────

describe('the same tablet, turned', () => {
  for (const shape of [LANDSCAPE, PORTRAIT]) {
    test(`the queue is usable and does not scroll sideways — ${shape.name}`, async () => {
      setViewport(shape)
      await freshPage()
      await signIn(NURSE.name, NURSE.pin)
      await goToStation('Queue')

      const overflow = Number(evaluate(
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
      ))
      assert.ok(
        overflow <= 1,
        `${shape.name} scrolls sideways by ${overflow}px — TABLET.md §3 targets 390-1366px either way up`,
      )

      // Every control still reachable and big enough for a finger in a hurry.
      const tooSmall = evaluate(`(() => {
        const small = [...document.querySelectorAll('main button, nav button')]
          .filter(b => b.offsetParent !== null)
          .map(b => ({ label: (b.innerText || b.getAttribute('aria-label') || '?').trim().slice(0, 24),
                       h: Math.round(b.getBoundingClientRect().height) }))
          .filter(b => b.h > 0 && b.h < 44)
        return JSON.stringify(small.slice(0, 6))
      })()`)
      assert.equal(
        tooSmall.includes('[]'),
        true,
        `controls under the 44px minimum in ${shape.name}: ${tooSmall}`,
      )
    })
  }
})

// ── focus, names, loading, errors ──────────────────────────────────────────

describe('using it without a mouse, and when things go wrong', () => {
  test('Tab moves focus somewhere visible, and the ring is drawn', async () => {
    setViewport(LANDSCAPE)
    await freshPage()

    // A real Tab, pressed by the browser, rather than a scripted .focus().
    // What is being tested is that the tab ORDER reaches the controls at all,
    // and calling focus() by hand would pass even if nothing were reachable.
    const { ab } = await import('./support/harness.mjs')
    ab(['press', 'Tab'])

    const focused = evaluate(`(() => {
      const active = document.activeElement
      if (!active || active === document.body) return JSON.stringify({ tag: 'BODY' })
      const style = getComputedStyle(active)
      const box = active.getBoundingClientRect()
      return JSON.stringify({
        tag: active.tagName,
        name: (active.innerText || active.getAttribute('aria-label') || '').trim().slice(0, 40),
        visible: box.width > 0 && box.height > 0,
        marked: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      })
    })()`)

    const seen = JSON.parse(focused.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
    assert.notEqual(seen.tag, 'BODY', 'Tab must move focus off the body')
    assert.ok(
      ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(seen.tag),
      `Tab landed on a ${seen.tag}, which is not something anybody can operate`,
    )
    assert.ok(seen.name, `the focused control needs a name a screen reader can announce: ${focused}`)
    assert.ok(seen.visible, 'focus must not be parked on something invisible')
    assert.ok(
      seen.marked,
      'the focused control must be visibly marked — somebody tabbing needs to see where they are',
    )
  })

  test('every control has an accessible name', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    await goToStation('Queue')

    const nameless = evaluate(`(() => {
      const unnamed = [...document.querySelectorAll('button, a[href], input, select, textarea')]
        .filter(el => el.offsetParent !== null)
        .filter(el => !(el.innerText || '').trim()
          && !el.getAttribute('aria-label')
          && !el.getAttribute('title')
          && !(el.labels && el.labels.length)
          && !el.getAttribute('aria-labelledby'))
        .map(el => el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''))
      return JSON.stringify([...new Set(unnamed)].slice(0, 8))
    })()`)

    assert.ok(nameless.includes('[]'), `controls with no accessible name: ${nameless}`)
  })

  test('a command in flight says so, and nothing can be tapped twice', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    await goToStation('Patients')

    openDisclosure('Register a new patient')
    fillField('Full name', `Loading ${Date.now().toString().slice(-5)}`)
    fillField('Age', '30')
    fillField('Mobile number', '+999701000902')

    // Slow the command down so the busy state is observable at all — four
    // tablets share one clinic and a second tap during the first request is a
    // duplicate patient.
    const sawBusy = evaluate(`(() => {
      const save = [...document.querySelectorAll('main button')]
        .find(b => /save patient/i.test(b.innerText))
      if (!save) return 'no-save-button'
      save.click()
      // Read on the next frame, while the request is still open.
      return new Promise(resolve => requestAnimationFrame(() => {
        const disabled = [...document.querySelectorAll('main button')].filter(b => b.disabled).length
        resolve(JSON.stringify({ disabled, label: save.innerText.trim().slice(0, 30) }))
      }))
    })()`)

    assert.equal(sawBusy.includes('no-save-button'), false, 'the register form must have a save button')
    const busy = JSON.parse(sawBusy.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
    assert.ok(
      busy.disabled > 0 || /saving|working|…/i.test(busy.label),
      `nothing showed a busy state while the command was in flight: ${sawBusy}`,
    )
  })

  test('a backend that cannot be reached is reported, not swallowed', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(NURSE.name, NURSE.pin)
    await goToStation('Patients')

    // Cut the clinic off mid-visit, which on a tablet in a corridor is a
    // wifi drop rather than a hypothetical.
    const { ab } = await import('./support/harness.mjs')
    ab(['network', 'route', '**/functions/v1/command', '--abort'], { allowFailure: true })

    try {
      openDisclosure('Register a new patient')
      fillField('Full name', `Offline ${Date.now().toString().slice(-5)}`)
      fillField('Age', '33')
      fillField('Mobile number', '+999701000903')
      clickButton('Save patient')

      await waitFor(
        `/not reachable|could not|failed|try again/i.test(document.body.innerText)`,
        { what: 'an error the staff can read', timeout: 15_000 },
      )

      const message = evaluate('document.body.innerText')
      assert.match(
        message,
        /not reachable|could not|failed|try again/i,
        'a dropped connection must reach the screen as words, not as a button that did nothing',
      )
    } finally {
      ab(['network', 'unroute'], { allowFailure: true })
    }
  })
})
