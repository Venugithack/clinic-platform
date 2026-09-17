/**
 * The attempt, through the real screen.
 *
 * ── WHY A BROWSER AND NOT ANOTHER UNIT TEST ────────────────────────────────
 *
 * `tests/attempt-key.test.ts` holds the rules — when to mint, when to reuse,
 * when to let go — and holds them without a browser, which is why they live in
 * `lib/consultation-attempt.ts` rather than inside a fifteen-hundred-line
 * panel. But the rules being right is not the same claim as the panel calling
 * them, and the two review defects in this wiring were both of the second
 * kind: a release on the wrong branch, and a release inside a callback that
 * does not run when the panel unmounts mid-request. Neither would have been
 * caught by testing the rules again.
 *
 * So this drives the actual Consult screen against a real database and
 * inspects what the tab is holding at each step. It reads `sessionStorage`
 * rather than a mock, because the storage IS the mechanism: an attempt that is
 * not in the tab's store does not survive the reload it exists for.
 *
 * ── WHY IT BRINGS ITS OWN PATIENTS ─────────────────────────────────────────
 *
 * Signing a consultation takes a patient out of the queue, and the browser
 * suite runs every file in turn against one staging database. The first
 * version of this file called in whoever the fixtures had put at the front,
 * signed them, and left `slice5-images.test.mjs` waiting fifteen seconds for a
 * `Call in` button that was no longer there — three failures in a file this
 * change had nothing to do with.
 *
 * So it seeds its own patients with their own tokens, works only on those, and
 * removes them afterwards. Nothing here touches the fixtures.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Nothing about layout, wording, icons or colour. This is the same screen it
 * was; what is being tested is a reference nobody can see.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import postgres from 'postgres'
import { closeBrowser, evaluate, launchBrowser, open, waitFor } from './support/harness.mjs'
import {
  LANDSCAPE, clickButton, fillField, freshPage, goToStation, setViewport, signIn,
} from './support/clinic-ui.mjs'

const DOCTOR = { name: 'Dr Kavitha Solo', pin: '3517' }
const PREFIX = 'jayamurugan_attempt:'

/** The eight patients this file brings with it, one per journey. */
const MINE = [
  { id: 'attempt-p1', name: 'Attempt Unknown', token: 'ATT-0001' },
  { id: 'attempt-p2', name: 'Attempt Confirmed', token: 'ATT-0002' },
  { id: 'attempt-p3', name: 'Attempt Discard', token: 'ATT-0003' },
  { id: 'attempt-p4', name: 'Attempt Unwatched', token: 'ATT-0004' },
  // The last three are opened from the register and get NO seeded appointment:
  // a direct consultation is one with no visit row, and seeding one would hide
  // the very case these journeys exist for. Their tokens are used later, when
  // the doctor creates the visit mid-attempt.
  { id: 'attempt-p5', name: 'Attempt Late Visit', token: 'ATT-0005', direct: true },
  { id: 'attempt-p6', name: 'Attempt Late Signed', token: 'ATT-0006', direct: true },
  { id: 'attempt-p7', name: 'Attempt Midnight', token: 'ATT-0007', direct: true },
  // Back to a seeded visit: the last journey is about one being taken away
  // mid-attempt, so there has to be one to take.
  { id: 'attempt-p8', name: 'Attempt Cancelled', token: 'ATT-0008' },
]

/** How many consultations this patient actually has. */
async function countEncountersFor(patientId) {
  const sql = scratchDb()
  try {
    const rows = await sql`select count(*)::int as n from jmc.encounters where patient_id = ${patientId}`
    return rows[0].n
  } finally {
    await sql.end()
  }
}

function scratchDb() {
  const url = process.env.STAGING_DB_URL
  if (!url) throw new Error('STAGING_DB_URL is not set; browser-gate.mjs sets it')
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} })
}

/** Seed them directly, the same way the gate seeds its doctor-only account. */
async function seedPatients() {
  const sql = scratchDb()
  try {
    for (const who of MINE) {
      await sql`
        insert into jmc.patients (id, name, phone, age, sex, created_at)
        values (${who.id}, ${who.name}, ${'+9199000' + who.token.slice(-4)}, 44, 'male',
                to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        on conflict (id) do nothing`
      if (who.direct) continue
      await sql`
        insert into jmc.appointments
          (id, patient_id, token, reason, status, scheduled_at, created_at)
        values (${'appt-' + who.id}, ${who.id}, ${who.token}, 'Fever', 'waiting',
                to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        on conflict (id) do update set status = 'waiting'`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** And removed, so the next file finds the clinic as the fixtures left it. */
async function removePatients() {
  const sql = scratchDb()
  try {
    const ids = MINE.map((who) => who.id)
    /*
     * `invoice_lines` is append-only by trigger — "Financial history is
     * append-only. Add a compensating line, payment or reversal instead of
     * changing invoice_lines" — and that trigger is doing its job: nothing in
     * the clinic may delete a charge. But these rows belong to four patients
     * this file invented and is now taking away, and leaving them would leave
     * invoices pointing at patients that no longer exist.
     *
     * So the trigger is suspended for exactly this cleanup and put back
     * immediately, on a disposable scratch database that `guard.mjs` refuses
     * to let be anything else. It is the one place in the suite that does
     * this, and it is a fixture removing its own litter rather than the clinic
     * editing its ledger.
     */
    await sql`alter table jmc.invoice_lines disable trigger invoice_lines_immutable`
    try {
      await sql`delete from jmc.invoice_lines where invoice_id in (
                  select id from jmc.invoices where patient_id = any(${ids}))`
    } finally {
      await sql`alter table jmc.invoice_lines enable trigger invoice_lines_immutable`
    }
    await sql`delete from jmc.invoices where patient_id = any(${ids})`
    // Prescriptions and follow-ups before encounters: none of these journeys
    // writes one today, and the day one of them prescribes something this
    // teardown would fail on a foreign key instead of saying why.
    await sql`delete from jmc.prescription_lines where prescription_id in (
                select id from jmc.prescriptions where patient_id = any(${ids}))`
    await sql`delete from jmc.prescriptions where patient_id = any(${ids})`
    await sql`delete from jmc.follow_ups where patient_id = any(${ids})`
    await sql`delete from jmc.encounters where patient_id = any(${ids})`
    await sql`delete from jmc.consultation_drafts where patient_id = any(${ids})`
    await sql`delete from jmc.appointments where patient_id = any(${ids})`
    await sql`delete from jmc.patients where id = any(${ids})`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

before(async () => {
  await seedPatients()
  launchBrowser()
})
after(async () => {
  closeBrowser()
  await removePatients()
})

/** Unwrap whatever the browser bridge hands back as a JSON string. */
function unwrap(raw) {
  const trimmed = String(raw).trim()
  if (!trimmed || trimmed === 'null' || trimmed === '""') return null
  try {
    // The bridge returns the value JSON-encoded, so one parse yields the string
    // the page produced; anything else is already plain.
    const once = JSON.parse(trimmed)
    return typeof once === 'string' ? once : JSON.stringify(once)
  } catch {
    return trimmed.replace(/^"|"$/g, '')
  }
}

/**
 * Every consultation attempt the tab is holding, parsed inside the page.
 *
 * Parsed there rather than here on purpose: a JSON string inside a JSON string
 * inside the bridge's own encoding is three levels of quoting to get right,
 * and getting it wrong was the first thing this file did.
 */
function heldAttempts() {
  const raw = evaluate(`(() => {
    const out = []
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const name = window.sessionStorage.key(i)
      if (name && name.indexOf(${JSON.stringify(PREFIX)}) === 0) {
        let parsed = null
        try { parsed = JSON.parse(window.sessionStorage.getItem(name)) } catch (e) { parsed = null }
        out.push({
          scope: name,
          key: parsed && parsed.key ? parsed.key : '',
          day: parsed && parsed.day ? parsed.day : '',
          hasVisitField: !!parsed && Object.prototype.hasOwnProperty.call(parsed, 'visitId'),
        })
      }
    }
    return JSON.stringify(out)
  })()`)
  const text = unwrap(raw)
  return text ? JSON.parse(text) : []
}

/**
 * Empty the tab of attempts left by an earlier test.
 *
 * `sessionStorage` is per origin and per tab, and these tests share both — so
 * the attempt test one deliberately leaves unresolved is still sitting there
 * when test two asserts that a confirmed signing left nothing behind. That is
 * the mechanism working exactly as designed and a test reading it as a
 * failure; the tab, not the rule, is what needs resetting between scenarios.
 */
function clearHeldAttempts() {
  evaluate(`(() => {
    const names = []
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const name = window.sessionStorage.key(i)
      if (name && name.indexOf(${JSON.stringify(PREFIX)}) === 0) names.push(name)
    }
    for (const name of names) window.sessionStorage.removeItem(name)
    return String(names.length)
  })()`)
}

/**
 * Call in one of this file's own patients, found by name.
 *
 * By name rather than by token: the queue row renders the patient, and the
 * first version of this matched on the token, waited fifteen seconds for text
 * that is not on the screen, and failed three tests while the rows were
 * sitting in the database exactly as seeded.
 */
async function callInMine(who) {
  await goToStation('Today')
  await waitFor(
    `document.querySelector('main') && document.querySelector('main').innerText.indexOf(${JSON.stringify(who.name)}) !== -1`,
    { what: `${who.name} in the queue` },
  )
  /*
   * The row is the SMALLEST thing that holds both the name and one Call in.
   *
   * The first version of this walked up from each button until it found an
   * ancestor whose text contained the name — and every button has such an
   * ancestor, because the queue is one container holding every waiting
   * patient. So it clicked the FIRST Call in on the screen whoever it asked
   * for. Tests one to three never noticed, because none of them checks which
   * patient it ended up with; the fourth did, and only because it counts that
   * patient's encounters.
   *
   * Climbing only while the element does NOT yet contain exactly one Call in
   * stops at the row. The name is then checked against that row rather than
   * against the page.
   */
  const clicked = evaluate(`(() => {
    const calls = [...document.querySelectorAll('main button')]
      .filter(b => /call in/i.test(b.innerText))
    const countIn = (el) =>
      [...el.querySelectorAll('button')].filter(b => /call in/i.test(b.innerText)).length
    for (const button of calls) {
      let row = button.parentElement
      while (row && row !== document.body && countIn(row) === 1
             && row.innerText.indexOf(${JSON.stringify(who.name)}) === -1) {
        row = row.parentElement
      }
      if (row && countIn(row) === 1 && row.innerText.indexOf(${JSON.stringify(who.name)}) !== -1) {
        button.click()
        return 'ok'
      }
    }
    return 'none:' + document.querySelector('main').innerText.slice(0, 400)
  })()`)
  // Anchored, because the failure branch returns the first 400 characters of
  // the queue — which contain the word "token", so a bare /ok/ matched the
  // failure as happily as the success and the guard could not fail.
  assert.match(clicked, /^"?ok"?$/, `${who.name} must have a Call in beside them: ${clicked}`)
  await waitFor(`!!document.querySelector('textarea')`, { what: 'the consultation sheet' })

  // And it is the patient that was asked for. Without this the whole file can
  // pass while working on somebody else.
  await waitFor(
    `document.querySelector('main').innerText.indexOf(${JSON.stringify(who.name)}) !== -1`,
    { what: `${who.name} to be the patient on the consultation screen` },
  )
}

/** Write the least a consultation can be signed with. */
function writeSheet(diagnosis) {
  fillField('Complaint', 'Fever for two days')
  fillField('Diagnosis', diagnosis)
}

/**
 * Review, then sign.
 *
 * `Review & sign` opens the review sheet and `Sign & finish` inside it is what
 * signs — the workflow as the plan specifies it, a review before an
 * irreversible act, rather than a shortcut around it. Both buttons are
 * disabled until there is a diagnosis, which is why `writeSheet` fills one.
 */
async function sign() {
  clickButton('Review & sign')
  await waitFor(`!!document.querySelector('[role=dialog]')`, { what: 'the review sheet' })
  const signed = evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]')
    const button = [...dialog.querySelectorAll('button')]
      .find(b => /sign/i.test(b.innerText) && !/cancel|back|close/i.test(b.innerText))
    if (!button) return 'none:' + [...dialog.querySelectorAll('button')].map(b => b.innerText).join('|')
    if (button.disabled) return 'disabled:' + (button.getAttribute('title') || '')
    button.click()
    return 'ok'
  })()`)
  assert.match(signed, /ok/, 'the review sheet must offer a way to sign')
}

/** Make every command fail the way a dropped connection does: with no answer. */
function cutTheLine() {
  evaluate(`(() => {
    window.__realFetch = window.__realFetch || window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/command') !== -1) return Promise.reject(new TypeError('Failed to fetch'))
      return window.__realFetch(input, init)
    }
    return 'ok'
  })()`)
}

/**
 * Make every command take its time, without failing.
 *
 * The dropped-connection helper above proves the attempt is HELD when nobody
 * knows. This proves the other half: that a signing which succeeds while the
 * doctor has walked away from the screen still releases the attempt. `useTask`
 * returns early without running its `confirmed` callback once the panel has
 * unmounted, so a release written inside that callback never happens — which
 * is one of the two defects this file exists to catch, and the one nothing was
 * catching.
 */
function slowTheLine(ms) {
  evaluate(`(() => {
    window.__realFetch = window.__realFetch || window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/command') === -1) return window.__realFetch(input, init)
      return new Promise((resolve, reject) => {
        setTimeout(
          () => window.__realFetch(input, init).then(resolve, reject),
          ${Number(ms)},
        )
      })
    }
    return 'ok'
  })()`)
}

function restoreTheLine() {
  evaluate(`(() => {
    if (window.__realFetch) window.fetch = window.__realFetch
    return 'ok'
  })()`)
}

/**
 * Open a patient who has no visit row at all.
 *
 * The Consult empty state offers a select of every patient, which is the path
 * a doctor takes for somebody already in front of them who was never put in
 * the queue. It is the only way to reach a consultation with no appointment
 * id, and that is the shape both branches below are about.
 */
async function openFromRegister(who) {
  await goToStation('Consult')
  await waitFor(
    `[...document.querySelectorAll('select option')].some(o => o.textContent.indexOf(${JSON.stringify(who.name)}) !== -1)`,
    { what: `${who.name} in the Open a patient list` },
  )
  const chosen = evaluate(`(() => {
    const select = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.textContent.indexOf(${JSON.stringify(who.name)}) !== -1))
    if (!select) return 'none'
    const option = [...select.options].find(o => o.textContent.indexOf(${JSON.stringify(who.name)}) !== -1)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  assert.match(chosen, /^"?ok"?$/, `${who.name} must be selectable from the register: ${chosen}`)
  await waitFor(`!!document.querySelector('textarea')`, { what: 'the consultation sheet' })
}

/**
 * Give the patient today's visit, the way a doctor tidying up does.
 *
 * Written straight to the database rather than driven through the arrival
 * screen: the arrival flow has its own journeys, and what these tests are
 * about is what the consultation does once a visit exists. The tablet finds it
 * through its ordinary fifteen-second poll, which is what
 * `waitForTheVisitOnScreen` waits for.
 */
async function giveThemAVisit(who) {
  const sql = scratchDb()
  try {
    const id = `appt-late-${who.id}`
    await sql`
      insert into jmc.appointments
        (id, patient_id, token, reason, status, scheduled_at, created_at)
      values (${id}, ${who.id}, ${who.token}, 'Fever', 'waiting',
              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      on conflict (id) do update set status = 'waiting'`

    /*
     * And bump the revision, which is the part that makes the tablet look.
     *
     * `snapshot?since=<revision>` answers `{ unchanged: true }` unless one row
     * in `clinic_revision` has moved, and every real command moves it inside
     * its own transaction. A row written straight to the table moves nothing,
     * so the poll kept answering "nothing has happened" and the visit never
     * reached the screen — the first version of this waited thirty seconds for
     * a token that was sitting in the database the whole time.
     */
    await sql`update jmc.clinic_revision
                 set revision = revision + 1,
                     changed_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
               where id = 1`
    return id
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Take the visit away under the doctor, the way the front desk does.
 *
 * Straight to the database and then a revision bump, for the same reason
 * `giveThemAVisit` does it: the poll answers `{ unchanged: true }` until one
 * row in `clinic_revision` moves, so a row written by hand reaches nobody.
 */
async function cancelTheirVisit(who) {
  const sql = scratchDb()
  try {
    await sql`update jmc.appointments set status = 'cancelled' where patient_id = ${who.id}`
    await sql`update jmc.clinic_revision
                 set revision = revision + 1,
                     changed_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
               where id = 1`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Wait for the poll to take the cancelled visit off the screen. */
async function waitForTheVisitToLeaveTheScreen(who) {
  try {
    await waitFor(
      `document.body.innerText.indexOf(${JSON.stringify(who.token)}) === -1`,
      { what: `${who.token} to leave the screen on the next poll`, timeout: 30_000 },
    )
  } catch (error) {
    const seen = unwrap(evaluate(`document.body.innerText.slice(0, 600)`))
    throw new Error(`${error.message}
--- what the screen actually said ---
${seen}`)
  }
}

/** Wait for the poll to bring the new visit onto the consultation band. */
async function waitForTheVisitOnScreen(who) {
  // The whole document, not `main`: the patient band is drawn in the page
  // header, which is outside it.
  try {
    await waitFor(
      `document.body.innerText.indexOf(${JSON.stringify(who.token)}) !== -1`,
      { what: `${who.token} to reach the screen on the next poll`, timeout: 30_000 },
    )
  } catch (error) {
    const seen = unwrap(evaluate(`document.body.innerText.slice(0, 600)`))
    throw new Error(`${error.message}
--- what the screen actually said ---
${seen}`)
  }
}

/** Everything the two branches disagree about, read from the clinic. */
async function visitStateFor(patientId) {
  const sql = scratchDb()
  try {
    const [counts] = await sql`
      select count(*)::int as encounters,
             max(appointment_id) as linked_to
        from jmc.encounters where patient_id = ${patientId}`
    const [money] = await sql`
      select coalesce(sum(il.amount), 0)::text as charged
        from jmc.invoice_lines il
        join jmc.invoices i on i.id = il.invoice_id
       where i.patient_id = ${patientId} and il.source = 'consultation_fee'`
    const [visit] = await sql`
      select status from jmc.appointments
       where patient_id = ${patientId} order by created_at desc limit 1`
    return {
      encounters: counts.encounters,
      linkedTo: counts.linked_to,
      charged: money.charged,
      appointmentStatus: visit ? visit.status : null,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** What the clinic says is still outstanding for this patient. */
async function obligationsFor(patientId) {
  const token = evaluate(`window.localStorage.getItem('jayamurugan_token')`)
  const bearer = unwrap(token)
  const response = await fetch(
    `http://127.0.0.1:54321/functions/v1/workspace?view=obligations&patientId=${patientId}`,
    { headers: { authorization: `Bearer ${bearer}` } },
  )
  const body = await response.json()
  return body.obligations ?? []
}

/**
 * Let the command reach the clinic and throw the answer away.
 *
 * `cutTheLine` rejects before the request leaves, so nothing commits. This one
 * is the other half of the same problem and the harder half to think about:
 * the write lands, the clinic is changed, and the tablet is told nothing. It
 * is the only way to reach the branch where a consultation exists and the
 * doctor does not know it.
 */
function swallowTheReply() {
  evaluate(`(() => {
    window.__realFetch = window.__realFetch || window.fetch
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/command') === -1) return window.__realFetch(input, init)
      try { await window.__realFetch(input, init) } catch (e) { /* it still happened */ }
      throw new TypeError('Failed to fetch')
    }
    return 'ok'
  })()`)
}

describe('the reference a consultation is signed under', () => {
  test('is held while the outcome is unknown, and survives an unmount and a reload', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    assert.deepEqual(heldAttempts(), [], 'nothing is held before a signing is attempted')

    await callInMine(MINE[0])
    writeSheet('Upper respiratory infection')

    /*
     * The clinic goes away mid-signing. `fetch` rejects the way a dropped
     * connection does — not an error the server sent, an absence — so the
     * panel shows `Outcome not confirmed` and, this being the point, keeps the
     * reference, because nobody knows whether the consultation committed.
     */
    cutTheLine()
    await sign()
    await waitFor(
      `(() => {
        for (let i = 0; i < window.sessionStorage.length; i += 1) {
          const k = window.sessionStorage.key(i)
          if (k && k.indexOf(${JSON.stringify(PREFIX)}) === 0) return true
        }
        return false
      })()`,
      { what: 'the attempt to be recorded' },
    )

    const [held] = heldAttempts()
    assert.ok(held, 'an outcome nobody knows must keep the reference')
    assert.ok(held.key, 'and it is a key')
    assert.ok(held.day, 'carrying the clinic day it belongs to')
    assert.ok(held.hasVisitField,
      'and the visit it was opened against, so the retry need not ask the snapshot again')

    restoreTheLine()

    // An unmount and a remount. This is where component state would have gone.
    await goToStation('Today')
    await goToStation('Consult')
    assert.equal(heldAttempts()[0]?.key, held.key,
      'the same reference after leaving the station and coming back')

    // And a reload of the whole tablet, which is where a module-level variable
    // would have gone too.
    await open('/')
    await waitFor(`document.readyState === 'complete'`, { what: 'the reload' })
    assert.equal(heldAttempts()[0]?.key, held.key,
      'a tablet reloaded mid-consultation comes back holding the same reference')
  })

  test('is released when the clinic confirms the signing, and not before', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    await callInMine(MINE[1])
    writeSheet('Viral fever')
    await sign()

    await waitFor(
      `!document.querySelector('[role=dialog]')`,
      { what: 'the signing to settle', timeout: 20_000 },
    )

    /*
     * Released, and that is the whole rule: confirmed by the clinic ends the
     * attempt and nothing else does. Held one moment longer and this patient's
     * next consultation is refused as a mismatched replay; released one moment
     * earlier and a lost reply writes a second encounter and a second fee.
     */
    assert.deepEqual(heldAttempts(), [], 'a confirmed signing ends the attempt')
  })

  test('is not released by discarding a draft', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()
    await callInMine(MINE[2])

    /*
     * An attempt left over from a signing whose reply never came, written
     * directly so this test is about the discard and not about arranging a
     * second network failure.
     */
    evaluate(`(() => {
      window.sessionStorage.setItem(
        ${JSON.stringify(PREFIX + 'consultation:' + MINE[2].id)},
        JSON.stringify({ key: 'left-over-attempt', visitId: null, day: '2999-01-01' }))
      return 'ok'
    })()`)
    assert.equal(heldAttempts().length, 1, 'an attempt to leave alone')

    writeSheet('Headache')

    /*
     * Save the draft FIRST, and that is not housekeeping.
     *
     * `Discard draft` is rendered only when the server holds a draft row for
     * this patient. The first version of this test never saved one, so the
     * button was absent, the click returned 'none', and the final assertion
     * passed because nothing at all had happened — reverting the production
     * line it exists to protect would not have failed it. A test that cannot
     * fail is not evidence.
     */
    clickButton('Save draft')
    await waitFor(
      `[...document.querySelectorAll('button')].some(b => /discard/i.test(b.innerText))`,
      { what: 'the draft to be saved, so there is something to discard' },
    )

    const discarded = evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(b => /discard/i.test(b.innerText))
      if (!button) return 'none'
      button.click()
      return 'ok'
    })()`)
    // `evaluate` hands back JSON, so the string arrives quoted. Every other
    // assertion in this file matches rather than compares for that reason.
    assert.match(discarded, /ok/, 'the discard must actually have been pressed')

    /*
     * Discarding a draft proves a draft row was deleted. It proves nothing
     * about whether a signing committed, and the sequence that matters is
     * exactly the one where it did: Finish, reply lost, Outcome not confirmed,
     * Save draft, Discard. Releasing here lets the next Finish mint a fresh
     * reference and write a second encounter, a second invoice and a second
     * fee — the ₹600 bill this mechanism exists to prevent.
     */
    await waitFor(
      `[...document.querySelectorAll('button')].every(b => !/discard/i.test(b.innerText))`,
      { what: 'the discard to settle' },
    )
    assert.equal(heldAttempts()[0]?.key, 'left-over-attempt',
      'discarding a draft says nothing about whether a signing committed')
  })

  /**
   * The other review defect, and the one nothing was holding.
   *
   * `settleConsultationAttempt` was moved out of `useTask`'s `confirmed`
   * callback because that callback does not run when the panel has unmounted
   * mid-request. Put it back and every test in the repository still passed:
   * the unmount case was only ever tested in the HELD direction, where an
   * in-callback release would look identical.
   *
   * So this signs slowly, walks away from the screen while the request is in
   * flight, and comes back. The consultation commits. The attempt must be
   * gone — because it is settled, and because the patient's next genuine
   * consultation would otherwise be refused as a mismatched replay.
   */
  test('is released by a signing that confirms after the panel has gone', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    await callInMine(MINE[3])
    writeSheet('Tonsillitis')

    slowTheLine(2500)
    await sign()

    /*
     * The attempt has to be THERE before its absence can mean anything.
     *
     * Waiting for "no attempt in storage" is trivially satisfied by a signing
     * that never started, which is the same vacuum the discard test above fell
     * into. So this waits for it to appear first, and only then for it to go.
     */
    /*
     * The attempt has to be THERE, and be THIS patient's, before its absence
     * can mean anything.
     *
     * Waiting for "no attempt in storage" is trivially satisfied by a signing
     * that never started — the same vacuum the discard test above fell into —
     * and checking only that SOME attempt went would be satisfied by a
     * consultation signed for somebody else entirely. The scope carries the
     * patient id, so it is the thing to wait on.
     */
    const scope = PREFIX + 'consultation:' + MINE[3].id
    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(scope)}) !== null`,
      { what: `the attempt for ${MINE[3].name} to be opened by the signing` },
    )

    // Away from Consult while the signing is still open. This is where the
    // panel unmounts and where `confirmed` stops being called.
    await goToStation('Today')

    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(scope)}) === null`,
      { what: 'the attempt to be released by the confirmed signing', timeout: 25_000 },
    )

    restoreTheLine()
    assert.deepEqual(heldAttempts(), [],
      'a signing the clinic confirmed ends the attempt, whether or not anybody was watching')

    const signedRows = await countEncountersFor(MINE[3].id)
    assert.equal(signedRows, 1,
      `and it committed exactly once, for ${MINE[3].name} and not for whoever the queue offered first`)
  })
})

/**
 * The walk-in that acquires a visit, and the retry that crosses midnight.
 *
 * These three are the second acceptance correction, driven through the real
 * screen because the defect they cover is not in the store and not in the
 * command — it is in what the panel SENDS. A storage test cannot see it and a
 * database test cannot either: both were green while a consultation succeeded
 * and the visit it belonged to sat in the queue, attached to nothing.
 *
 * Each one opens its patient from the register — the `Open a patient` select on
 * the Consult empty state — because that is the path with no visit row, which
 * is the whole point.
 */
describe('a direct consultation that acquires a visit', () => {
  test('when nothing had committed, the signing attaches itself to the new visit', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    const who = MINE[4]
    await openFromRegister(who)
    writeSheet('Sinusitis')

    // The first press never reaches the clinic. The attempt is held, and it is
    // held against no visit, because there is no visit.
    cutTheLine()
    await sign()
    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(PREFIX + 'consultation:' + MINE[4].id)}) !== null`,
      { what: 'the attempt to be held by the lost reply' },
    )
    restoreTheLine()
    assert.equal(await countEncountersFor(who.id), 0, 'nothing committed, which is this branch')

    // The doctor now creates today's visit — policy item 3 allows it, and it is
    // the tidy thing to do — and presses Finish again.
    const appointmentId = await giveThemAVisit(who)
    await waitForTheVisitOnScreen(who)
    await sign()
    await waitFor(`!document.querySelector('[role=dialog]')`, { what: 'the signing to settle' })

    const state = await visitStateFor(who.id)
    assert.equal(state.encounters, 1, 'one consultation')
    assert.equal(state.charged, '300.00', 'charged once')
    assert.equal(state.linkedTo, appointmentId,
      'and attached to the visit the doctor created, rather than to nothing')
    assert.equal(state.appointmentStatus, 'done',
      'so the patient leaves the queue instead of waiting for somebody who is not coming')
    assert.deepEqual(heldAttempts(), [], 'and the attempt is over')
  })

  test('when it HAD committed, the retry is refused and the leftover visit is reported', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    const who = MINE[5]
    await openFromRegister(who)
    writeSheet('Otitis media')

    // Committed, and the reply thrown away on the way home. This is the branch
    // the tablet cannot tell from the one above.
    swallowTheReply()
    await sign()
    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(PREFIX + 'consultation:' + MINE[5].id)}) !== null`,
      { what: 'the attempt to be held by the swallowed reply' },
    )
    restoreTheLine()
    assert.equal(await countEncountersFor(who.id), 1, 'it did commit, which is this branch')

    const appointmentId = await giveThemAVisit(who)
    await waitForTheVisitOnScreen(who)
    await sign()

    // The refusal reaches the screen in the clinic's own words.
    await waitFor(
      `document.body.innerText.indexOf('already signed') !== -1`,
      { what: 'the clinic to say the consultation was already signed' },
    )
    assert.match(
      evaluate(`document.body.innerText`), /still waiting/,
      'and to say the visit is still open, which is the half a refusal usually leaves out')

    const state = await visitStateFor(who.id)
    assert.equal(state.encounters, 1, 'nothing was recorded twice')
    assert.equal(state.charged, '300.00', 'and nothing was charged twice')
    assert.equal(state.appointmentStatus, 'waiting',
      'the visit is still there — the clinic reports it rather than deciding it')
    assert.ok(appointmentId)

    // And it is not left to a message nobody re-reads.
    const obligations = await obligationsFor(who.id)
    assert.ok(obligations.some((item) => item.kind === 'unlinked_consultation'),
      'the leftover visit is carried as an obligation on the patient')
  })

  test('a retry that crosses midnight replays instead of signing again', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    const who = MINE[6]
    await openFromRegister(who)
    writeSheet('Gastritis')

    swallowTheReply()
    await sign()
    const scope = PREFIX + 'consultation:' + who.id
    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(scope)}) !== null`,
      { what: 'the attempt to be held' },
    )
    restoreTheLine()
    assert.equal(await countEncountersFor(who.id), 1, 'the consultation committed; the reply did not')

    /*
     * Midnight passes. The attempt is stamped with the day it was opened on,
     * so the rollover is that field changing and nothing else — which is the
     * point: elapsed time is not evidence about what committed. This used to
     * mint a fresh reference, and a fresh reference writes a second encounter
     * and a second ₹300 fee for one consultation.
     */
    evaluate(`(() => {
      const raw = window.sessionStorage.getItem(${JSON.stringify(scope)})
      const held = JSON.parse(raw)
      held.day = '2020-01-01'
      window.sessionStorage.setItem(${JSON.stringify(scope)}, JSON.stringify(held))
      return 'ok'
    })()`)

    await sign()
    await waitFor(`!document.querySelector('[role=dialog]')`, { what: 'the retry to settle' })

    const state = await visitStateFor(who.id)
    assert.equal(state.encounters, 1, 'one consultation, however many midnights it is retried across')
    assert.equal(state.charged, '300.00', 'and one fee')
    assert.deepEqual(heldAttempts(), [],
      'the replay is a success, so the attempt is over and the next consultation starts fresh')
  })
})

describe('a consultation whose visit is taken away', () => {
  /**
   * And the same lost reply where the visit is taken away instead of created.
   *
   * This is the third acceptance correction, and it is here rather than only
   * in the database suite because the defect was in what the panel SENDS. The
   * attempt was opened against a queued visit; the first press never reached
   * the clinic; the front desk then cancelled the visit, and the poll took it
   * out of the snapshot — so the tablet had no live visit left to name.
   *
   * Sending only the live value, that second press looked exactly like a
   * direct consultation, and the clinic wrote one: the cancellation stepped
   * around, the encounter attached to nothing, ₹300 charged for an attendance
   * somebody had said did not happen. The attempt's own `openedVisitId` is
   * what the panel still has, and sending it is what turns a silent bypass
   * into a refusal a person can act on.
   */
  test('a visit cancelled under the attempt is refused, not signed around', async () => {
    setViewport(LANDSCAPE)
    await freshPage()
    await signIn(DOCTOR.name, DOCTOR.pin)
    clearHeldAttempts()

    const who = MINE[7]
    await callInMine(who)
    writeSheet('Pharyngitis')

    cutTheLine()
    await sign()
    const scope = PREFIX + 'consultation:' + who.id
    await waitFor(
      `window.sessionStorage.getItem(${JSON.stringify(scope)}) !== null`,
      { what: 'the attempt to be held by the lost reply' },
    )
    restoreTheLine()
    assert.equal(await countEncountersFor(who.id), 0, 'nothing committed, which is this branch')

    // The front desk cancels the visit, and the tablet loses it.
    await cancelTheirVisit(who)
    await waitForTheVisitToLeaveTheScreen(who)

    await sign()
    await waitFor(
      `document.body.innerText.indexOf('cancelled') !== -1`,
      { what: 'the clinic to say the visit was cancelled', timeout: 20_000 },
    )
    assert.match(
      evaluate(`document.body.innerText`), /nothing was charged/i,
      'and to say so, because the reflex on reading a refusal is to assume something happened')

    const state = await visitStateFor(who.id)
    assert.equal(state.encounters, 0, 'no consultation was written against a cancelled visit')
    assert.equal(state.charged, '0', 'and nobody was charged ₹300 for it')
    assert.equal(state.appointmentStatus, 'cancelled', 'the cancellation stands')

    /*
     * And the attempt is HELD. `ATTEMPT_VISIT_NO_LONGER_ACTIVE` is not a code
     * the tablet rotates on: a fresh reference here writes exactly the
     * unlinked consultation the refusal just prevented. The way forward is a
     * clinic act — create today's visit, which mints a new attempt through the
     * ordinary rule — and that is what the next assertion is protecting.
     */
    assert.equal(heldAttempts().length, 1, 'a refusal about the visit does not release the attempt')
  })
})
