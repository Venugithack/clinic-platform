/**
 * Slice 3, driven through a real browser.
 *
 * The database suite proves the conversions, the ledger and the refusals. This
 * proves that a person can reach them: that the ladder builder shows the pack
 * back in words before it saves, that receiving previews the base-unit result
 * before it posts, and that the opening count is blind on the screen a
 * pharmacist actually looks at.
 *
 * That last one is the reason this file exists rather than being left to the
 * database tests. "The counter cannot see the expected figure" is a claim
 * about a screen, and the only way to check a screen is to look at it.
 *
 * Same browser and same database as the other journeys, so these run in
 * sequence after them and each starts from the lock screen.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closeBrowser, evaluate, launchBrowser, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE,
  PORTRAIT,
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

/** The owner: doctor and admin, so the whole rail is on his tablet. */
const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

/**
 * Choose a medicine from the formulary list.
 *
 * The list is a table whose rows carry the click, not a column of buttons —
 * which is why this looks for a `tr` and not for a `button`.
 */
function chooseMedicine(name) {
  const chosen = evaluate(`(() => {
    const row = [...document.querySelectorAll('main tbody tr')]
      .find(r => (r.innerText || '').includes(${JSON.stringify(name)}))
    if (!row) return 'no-medicine'
    row.click()
    return 'ok'
  })()`)
  if (chosen.includes('no-medicine')) throw new Error(`no medicine matching "${name}" in the list`)
}

/**
 * Waiting for words on the work surface.
 *
 * Lowercased on both sides, because the rail and every card header are
 * uppercased in CSS and Chrome's `innerText` returns what is PAINTED. A
 * condition written from the source — `includes('Find a medicine')` — waits
 * fifteen seconds for text that is on the screen in front of it.
 */
const mainSays = (words) =>
  `document.querySelector('main').innerText.toLowerCase().includes(${JSON.stringify(String(words).toLowerCase())})`

/**
 * Press a button inside the open dialog.
 *
 * `clickButton` takes the first enabled button on the PAGE whose words contain
 * the label, and the page behind a modal still has its own — the version card's
 * "Verify against the pack" sits above the modal's "Verify" in the DOM, so the
 * obvious call re-opens the dialog instead of confirming it. Everything the
 * clinic's Modal and ConfirmButton draw lives inside `role="dialog"`.
 */
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

/** The page is not allowed to scroll sideways at a tablet width. */
function horizontalOverflow() {
  return evaluate(
    'JSON.stringify({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
  )
}

describe('the formulary', () => {
  test('a package reads back as a sentence before anybody saves it', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)
    await goToStation('Formulary')

    // A product the fixtures already carry a verified ladder for.
    try {
      await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('find a medicine')`, {
        what: 'the formulary list',
      })
    } catch (error) {
      const rail = evaluate(`JSON.stringify([...document.querySelectorAll('nav button, nav a')].map(e => e.innerText))`)
      throw new Error(`${error.message}
--- rail ---
${rail}
--- main ---
${workText().slice(0, 1200)}`)
    }
    chooseMedicine('Paracetamol')
    try {
      await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('packages')`, {
        what: 'the package card',
      })
    } catch (error) {
      throw new Error(`${error.message}
--- screen ---
${workText().slice(0, 2000)}`)
    }
    assert.ok(
      workShowing('1 case = 20 boxes = 200 strips = 3000 tablets'),
      `the ladder must be shown in full — screen says:\n${workText().slice(0, 900)}`,
    )
    assert.ok(workShowing('Verified'), 'a verified pack must say so in a word, not only a colour')

    // And one that has none. Cyanocobalamin arrived through a CSV import with
    // no classification and no package, which is how a real drug master gets
    // holes in it.
    chooseMedicine('Cyanocobalamin')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('no package has been built')`, {
      what: 'the empty package state',
    })

    clickButton('Build a package')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('base unit')`, {
      what: 'the ladder builder',
    })

    fillField('Base unit', 'tablet')
    fillField('Level 1 name', 'tablet')
    fillField('Kind of package', 'tablet')
    clickButton('Add a level')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('level 2 name')`, {
      what: 'the second level',
    })

    /*
     * The second level, filled inside its own card.
     *
     * Not by label position: every level card carries the same four labels, so
     * "the first Contains" is whichever level the builder happens to render
     * first — and a `Contains` select only offers the OTHER levels, so writing
     * a name it does not offer is silently ignored. The empty card is the one
     * that was just added, whichever end of the list it is at.
     */
    const filled = evaluate(`(() => {
      const cards = [...document.querySelectorAll('main div.bg-sheet')]
        .filter(card => /level \\d+ name/i.test(card.innerText))
      const nameOf = (card) => [...card.querySelectorAll('label')]
        .find(l => /^level \\d+ name/i.test(l.innerText.trim()))
        ?.querySelector('input')
      const target = cards.find(card => !(nameOf(card)?.value ?? '').trim())
      if (!target) return 'no-empty-card:' + cards.length
      const set = (starts, value) => {
        const label = [...target.querySelectorAll('label')]
          .find(l => l.innerText.trim().toLowerCase().startsWith(starts))
        const input = label?.querySelector('input, select')
        if (!input) return false
        const proto = input instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return input.value === value
      }
      if (!set('level', 'strip')) return 'no-name'
      if (!set('kind of package', 'strip')) return 'no-kind'
      return JSON.stringify({ named: true })
    })()`)
    assert.ok(filled.includes('named'), `the builder must offer a name and a kind — got ${filled}`)

    // `Contains` is filled after the name lands, because the select offers the
    // other levels by name and the base only became "tablet" a moment ago.
    const chained = evaluate(`(() => {
      const cards = [...document.querySelectorAll('main div.bg-sheet')]
        .filter(card => /level \\d+ name/i.test(card.innerText))
      const target = cards.find(card => {
        const input = [...card.querySelectorAll('label')]
          .find(l => /^level \\d+ name/i.test(l.innerText.trim()))?.querySelector('input')
        return (input?.value ?? '').trim() === 'strip'
      })
      if (!target) return 'no-strip-card'
      const labelled = (starts) => [...target.querySelectorAll('label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith(starts))
      const select = labelled('contains')?.querySelector('select')
      const option = [...(select?.options ?? [])].find(o => o.value === 'tablet')
      if (!option) return 'no-tablet-option'
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        .call(select, 'tablet')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(chained.includes('ok'), `the second level must be able to contain the base — got ${chained}`)

    const counted = evaluate(`(() => {
      const cards = [...document.querySelectorAll('main div.bg-sheet')]
        .filter(card => /level \\d+ name/i.test(card.innerText))
      const target = cards.find(card => {
        const input = [...card.querySelectorAll('label')]
          .find(l => /^level \\d+ name/i.test(l.innerText.trim()))?.querySelector('input')
        return (input?.value ?? '').trim() === 'strip'
      })
      const input = [...target.querySelectorAll('label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('how many'))?.querySelector('input')
      if (!input || input.disabled) return 'count-disabled'
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '10')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(counted.includes('ok'), `the count must open once a level contains another — got ${counted}`)

    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('1 strip = 10 tablets')`, {
      what: 'the expanded sentence',
    })

    clickButton('Save the draft')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('draft — not yet checked')`, {
      what: 'the saved draft',
      timeout: 20_000,
    })
    assert.ok(
      workShowing('cannot receive stock until somebody checks it against the physical pack'),
      'a draft must say why it cannot receive stock',
    )
  })

  test('verifying against the pack is what lets stock be received against it', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Formulary')
    chooseMedicine('Cyanocobalamin')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('verify against the pack')`, {
      what: 'the draft version',
    })

    clickButton('Verify against the pack')
    await waitFor(`document.body.innerText.toLowerCase().includes('what was checked')`, { what: 'the verify dialog' })

    // The dialog opens with nothing chosen, deliberately: "verified against
    // something unspecified" is what the source column exists to prevent.
    const source = evaluate(`(() => {
      const label = [...document.querySelectorAll('label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('what was checked'))
      const select = label?.querySelector('select')
      const option = [...(select?.options ?? [])]
        .find(o => o.textContent.toLowerCase().includes('pack') && o.value)
      if (!option) return 'no-source-option'
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        .call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(source.includes('ok'), `the dialog must ask what was checked — got ${source}`)

    clickInDialog('Verify')
    try {
      await waitFor(
        `document.querySelector('main').innerText.toLowerCase().includes('receiving against this')`,
        { what: 'the verified version', timeout: 20_000 },
      )
    } catch (error) {
      throw new Error(`${error.message}
--- screen ---
${workText().slice(0, 1500)}`)
    }
    assert.ok(workShowing('Verified versions are read-only'))
  })

  test('neither orientation scrolls sideways', async () => {
    for (const shape of [LANDSCAPE, PORTRAIT]) {
      setViewport(shape)
      await goToStation('Formulary')
      chooseMedicine('Paracetamol')
      await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('packages')`, {
        what: `the formulary at ${shape.name}`,
      })
      const { scroll, client } = JSON.parse(
        horizontalOverflow().replace(/^"|"$/g, '').replace(/\\"/g, '"'),
      )
      assert.ok(
        scroll <= client + 1,
        `the formulary scrolls sideways at ${shape.name}: ${scroll} > ${client}`,
      )
    }
  })
})

describe('receiving a delivery', () => {
  test('the base-unit result is shown before anything is posted', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Receiving')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('receive boxes')`, {
      what: 'the receiving screen',
    })

    clickButton('Add the first line')
    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('line 1')`, {
      what: 'the first line',
    })

    // The supplier, then the medicine, then the quantity in the packages it
    // arrived in.
    // By the words in the option, not by `fillField`: a Select's value is an
    // id, and setting it to the name a person reads is silently ignored.
    const supplier = evaluate(`(() => {
      const label = [...document.querySelectorAll('main label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('supplier'))
      const select = label?.querySelector('select')
      const option = [...(select?.options ?? [])]
        .find(o => o.textContent.includes('Kovai'))
      if (!option) return 'no-supplier'
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        .call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(supplier.includes('ok'), `the delivery must name a supplier — got ${supplier}`)
    const picked = evaluate(`(() => {
      const select = [...document.querySelectorAll('main select')]
        .find(s => [...s.options].some(o => o.textContent.includes('Paracetamol')))
      if (!select) return 'no-medicine-select'
      const option = [...select.options].find(o => o.textContent.includes('Paracetamol'))
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        .call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    assert.ok(picked.includes('ok'), 'the line must offer a medicine with a verified package')

    await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('boxes')`, {
      what: 'the package-level count fields',
    })

    fillField('boxes', '2')
    fillField('strips', '3')
    fillField('tablets', '4')

    // The approval pack's own example: 2 boxes + 3 strips + 4 tablets = 349.
    await waitFor(
      `document.querySelector('main').innerText.toLowerCase().includes('349 tablets')`,
      { what: 'the base-unit preview' },
    )
    assert.ok(
      workShowing('2 boxes + 3 strips + 4 tablets'),
      `the preview must repeat what was typed as well as what it converts to:\n${workText().slice(0, 800)}`,
    )

    fillField('Batch number', 'BROWSER-1')
    const expiry = evaluate(`(() => {
      const date = new Date(Date.now() + 400 * 86400000)
      return date.toISOString().slice(0, 10)
    })()`).replace(/"/g, '')
    fillField('Expiry', expiry)
    fillField('Printed MRP', '30')
    fillField('Purchase price', '18')

    // Both prices need the package level they apply to. "₹30" alone is the
    // ambiguity Slice 3 removed.
    const bases = evaluate(`(() => {
      let done = 0
      for (const label of [...document.querySelectorAll('main label')]) {
        if (!label.innerText.trim().toLowerCase().startsWith('that ')) continue
        const select = label.querySelector('select')
        const option = [...(select?.options ?? [])]
          .find(o => o.textContent.toLowerCase().includes('strip'))
        if (!option) continue
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
          .call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        done += 1
      }
      return String(done)
    })()`)
    assert.ok(Number(bases.replace(/"/g, '')) >= 2, 'both prices must carry a package basis')

    try {
      clickButton('Receive boxes')
    } catch (error) {
      throw new Error(`${error.message}\n--- screen ---\n${workText().slice(-1800)}`)
    }
    await waitFor(`document.body.innerText.toLowerCase().includes('will be added to the shelf')`, {
      what: 'the confirmation',
    })
    clickInDialog('Receive boxes')
    try {
      await waitFor(`document.querySelector('main').innerText.toLowerCase().includes('received.')`, {
        what: 'the posted delivery',
        timeout: 25_000,
      })
    } catch (error) {
      throw new Error(`${error.message}
--- screen ---
${workText().slice(0, 1200)}`)
    }
    assert.ok(workShowing('349 tablets'), 'the receipt must say what went onto the shelf')
  })
})

describe('the blind opening count', () => {
  test('the counting screen shows no expected figure and no shelf quantity at all', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Opening count')

    /*
     * The start screen and the count sheet share a title — "Count the shelf" —
     * and both carry the sentence about expected figures staying hidden. So
     * "is the sheet open" has to be asked of something only the sheet has, or
     * this test passes against a screen that shows no figures because it shows
     * nothing at all. The Counted zero control is on the sheet and nowhere
     * else.
     */
    await waitFor(mainSays('start an opening count'), { what: 'the opening-count screen' })
    clickButton('Start opening count')
    await waitFor(mainSays('counted zero'), { what: 'the count sheet', timeout: 20_000 })
    assert.match(
      workText(),
      /OC-\d{4}/,
      'the sheet must carry the count reference, so this is a real count and not the start screen',
    )

    assert.ok(
      workShowing('The expected figures stay hidden until you submit'),
      'the screen must say the count is blind',
    )

    /*
     * The strongest form of the claim, and it has to be about a NUMBER rather
     * than about the word "expected": the sheet says "None on the shelf is
     * Counted zero", which is instruction, not disclosure.
     *
     * So: 349 tablets of BROWSER-1 went onto the shelf earlier in this
     * journey. If any expected figure leaked onto the counting screen, that
     * exact number would be on it. It is not, and neither is the word variance,
     * which cannot exist before a count is submitted.
     */
    const leaked = evaluate(`(() => {
      const text = document.querySelector('main').innerText
        .replace(/the expected figures stay hidden[^.]*\./ig, '')
      return JSON.stringify({
        shelfFigure: text.includes('349'),
        variance: /variance/i.test(text),
        expectedColumn: /expected\s+(quantity|on the record|figure)/i.test(text),
      })
    })()`)
    const flags = JSON.parse(leaked.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
    assert.equal(flags.shelfFigure, false, 'the expected quantity of a counted batch leaked onto the sheet')
    assert.equal(flags.variance, false, 'a variance cannot exist before the count is submitted')
    assert.equal(flags.expectedColumn, false, 'no expected column may be drawn while counting')
  })

  test('a count is entered, submitted, and only then shows what it differs from', async () => {
    setViewport(LANDSCAPE)
    await goToStation('Opening count')
    await waitFor(mainSays('counted zero'), { what: 'the count sheet' })

    // The shelf list comes from the polled snapshot, so the batch this journey
    // received a moment ago may be one poll away.
    await waitFor(`document.querySelector('main').innerText.includes('BROWSER-1')`, {
      what: 'the batch just received',
      timeout: 25_000,
    })

    // 349 tablets went on, so a count of 340 is a variance of nine.
    const entered = evaluate(`(() => {
      const card = [...document.querySelectorAll('main div.bg-sheet')]
        .find(d => (d.innerText || '').includes('BROWSER-1'))
      if (!card) return 'no-card'
      const flat = [...card.querySelectorAll('label')]
        .find(l => l.innerText.trim().toLowerCase().startsWith('or straight in'))
        ?.querySelector('input')
      if (!flat) return 'no-input'
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(flat, '340')
      flat.dispatchEvent(new Event('input', { bubbles: true }))
      const save = [...card.querySelectorAll('button')]
        .find(b => !b.disabled && /save this count/i.test(b.innerText))
      if (!save) return 'save-disabled'
      save.click()
      return 'ok'
    })()`)
    assert.ok(entered.includes('ok'), `the count sheet must let a batch be counted — got ${entered}`)

    // The badge is uppercased in CSS, so this is asked case-insensitively.
    await waitFor(mainSays('counted 340'), { what: 'the recorded count', timeout: 20_000 })

    clickButton('Submit the count')
    await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the submit confirmation' })
    clickInDialog('Submit the count')
    await waitFor(mainSays('what the count found'), {
      what: 'the variance review', timeout: 25_000,
    })

    assert.ok(workShowing('340'), 'the review must show what was counted')
    assert.ok(
      workShowing('349'),
      `and what the record expected — screen says:\n${workText().slice(0, 900)}`,
    )
  })
})
