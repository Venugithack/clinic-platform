/**
 * Slice 4 on the doctor's screen.
 *
 * The database suite proves the rules. What only a browser can say is whether
 * the screen tells the truth about them — and for this slice the truth is
 * unusually easy to lose, because four different facts all look like "done":
 *
 *   the laboratory signed the report
 *   a clinic doctor read it
 *   a doctor authorized a notice
 *   the patient actually heard
 *
 * A green tick that means the third one while reading as the fourth is worse
 * than no screen at all, so most of what follows is about words.
 *
 * ── HOW THE STATE GETS THERE ──────────────────────────────────────────────
 *
 * Through the real commands over HTTP, in `before`, and not by editing
 * `fixtures.mjs`. Two reasons. A result that arrived through
 * `order_investigation` and `record_result` is provably reachable, where a
 * hand-written row proves only that somebody can write a row; and the fixture
 * file is shared with sixty-six other journeys that have nothing to do with
 * this one.
 *
 * Nothing here contacts anything but the loopback functions server the gate
 * already started.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  FUNCTIONS_URL,
  closeBrowser,
  evaluate,
  launchBrowser,
  open,
  waitFor,
} from './support/harness.mjs'
import {
  EVERY_SHAPE,
  DESKTOP,
  NARROW,
  allStations,
  freshPage,
  goToStation,
  setViewport,
  signIn,
  workShowing,
  workText,
} from './support/clinic-ui.mjs'

/** Doctor and administrator both — the owner, which is the common case. */
const OWNER = { name: 'Dr. Anbarasan Kaliyaperumal', pin: '4819' }
/** Doctor alone, seeded by the gate. Used as the doctor the owner is NOT. */
const OTHER_DOCTOR = { name: 'Dr Kavitha Solo', pin: '3517' }
const NURSE = { name: 'Nirmaladevi Ponnusamy', pin: '7305' }
const MANAGER = { name: 'Hemalatha Manoharan', pin: '905283' }
const PHARMACIST = { name: 'Sathyaraj Vadivelan', pin: '268137' }

before(() => { launchBrowser() })
after(() => { closeBrowser() })

/* ─────────────────────────────────────────── arranging it over HTTP ── */

/**
 * A session, the way the lock screen gets one.
 *
 * `/staff` is deliberately unauthenticated and answers names and ids and
 * nothing else, which is exactly what the lock screen needs and exactly what
 * this needs. The wrong-PIN throttle is charged to the caller rather than the
 * account, and the caller is derived from a header — so each of these signs
 * in under a name of its own and one journey cannot throttle the next.
 */
async function signInApi(name, pin) {
  const roster = await (await fetch(`${FUNCTIONS_URL}/staff`)).json()
  const member = roster.staff?.find((candidate) => candidate.name === name)
  if (!member) throw new Error(`no staff member called ${name} on the lock screen`)

  const response = await fetch(`${FUNCTIONS_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ staffId: member.id, pin }),
  })
  const body = await response.json()
  if (!body.token) throw new Error(`could not sign in as ${name}: ${JSON.stringify(body)}`)
  return body.token
}

async function command(token, action, payload = {}) {
  const response = await fetch(`${FUNCTIONS_URL}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, payload }),
  })
  return response.json()
}

async function must(token, action, payload = {}) {
  const answer = await command(token, action, payload)
  if (!answer.ok) throw new Error(`${action} refused: ${answer.message}`)
  return answer
}

async function read(token, path) {
  const response = await fetch(`${FUNCTIONS_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.json()
}

const key = () => globalThis.crypto.randomUUID()

/** Everything the journeys below act on, arranged once. */
const state = {}

before(async () => {
  const owner = await signInApi(OWNER.name, OWNER.pin)
  const other = await signInApi(OTHER_DOCTOR.name, OTHER_DOCTOR.pin)
  state.ownerToken = owner
  state.otherToken = other

  // `/snapshot` answers { ok, revision, snapshot } — the clinic is inside.
  const snapshot = (await read(owner, 'snapshot')).snapshot
  const patientNamed = (fragment) => {
    const found = snapshot.patients.find((patient) => patient.name.includes(fragment))
    if (!found) throw new Error(`no fixture patient matching "${fragment}"`)
    return found
  }
  const otherDoctorId = snapshot.staff.find((member) => member.name === OTHER_DOCTOR.name)?.id
  if (!otherDoctorId) throw new Error('the doctor-only account is not in the snapshot')
  state.otherDoctorId = otherDoctorId
  state.ownerStaffId = snapshot.session.staffId
  state.ownerName = snapshot.staff.find((m) => m.id === snapshot.session.staffId)?.name ?? ''

  const catalogue = await must(owner, 'draft_investigation', {
    kind: 'investigation',
    displayName: 'Full blood count',
    category: 'haematology',
    specimen: 'EDTA whole blood',
  })
  await must(owner, 'approve_investigation', { catalogueId: catalogue.data.catalogueId })
  state.catalogueId = catalogue.data.catalogueId

  /** One request with one report on it, built through the real commands. */
  async function arrange(patientFragment, result, { orderedBy } = {}) {
    const patient = patientNamed(patientFragment)
    const order = await must(orderedBy ?? owner, 'order_investigation', {
      idempotencyKey: key(),
      patientId: patient.id,
      items: [state.catalogueId],
    })
    const recorded = await must(owner, 'record_result', {
      idempotencyKey: key(),
      orderItemId: order.data.items[0].itemId,
      source: 'external_laboratory',
      ...result,
    })
    return {
      patient,
      orderId: order.data.orderId,
      orderNumber: order.data.orderNumber,
      itemId: order.data.items[0].itemId,
      resultId: recorded.data.resultId,
    }
  }

  /*
   * One result per journey, and that is not tidiness.
   *
   * A reviewed result leaves the queue — correctly: the queue is what nobody
   * has read. So a journey that reviews one removes the row every later
   * journey was going to open, and they fail in a way that looks like the
   * screen is broken. Each mutating journey therefore gets its own report,
   * and the read-only ones share the two that are never touched.
   */
  const routine = {
    reportText: 'Haemoglobin 12.8 g/dL. Total count 7,400. Platelets 240.',
    externalValidatedBy: 'Dr S. Pathologist, City Pathology',
    externalSignatoryReference: 'Digitally signed, ref CP-2211',
  }
  const criticalReport = {
    reportText: 'Haemoglobin 5.9 g/dL. Marked CRITICAL by the laboratory.',
    sourceFlag: 'critical',
    sourceFlagOrigin: 'external_report',
    sourceFlagReference: 'Report CP-2214, page 1, marked CRITICAL',
  }

  // Read-only throughout, so every journey that only looks can share them.
  state.labEvidence = await arrange('Arulmozhi', routine)
  state.criticalRead = await arrange('Ilakkiya', criticalReport)

  // One each for the journeys that write.
  state.reviewFlow = await arrange('Devanathan', routine)
  state.notice = await arrange('Nithyakalyani', routine)
  state.consent = await arrange('Venkataramanujam', routine)
  state.alreadyReviewed = await arrange('கஸ்தூரி', routine)
  state.alreadyAuthorized = await arrange('Mohanraj', routine)
  state.criticalAck = await arrange('Raghuraman', criticalReport)
  state.criticalCall = await arrange('Jothimani', criticalReport)
  // The recovery journeys. Patients are reused — a patient may have several
  // requests, and these key on the request number rather than the name.
  state.lostReview = await arrange('Chandrakala', routine)
  state.lostAuthorize = await arrange('Chandrakala', routine)
  state.dismissUnknown = await arrange('Arulmozhi', routine)
  state.followUp = await arrange('Devanathan', routine)
  state.supersededRecovery = await arrange('Ilakkiya', routine)
  state.isolation = await arrange('Nithyakalyani', routine)
  state.signOut = await arrange('Raghuraman', criticalReport)
  state.storageProbe = await arrange('Arulmozhi', routine)

  state.corrected = await arrange('Yazhini', {
    reportText: 'Haemoglobin 9.1 g/dL — provisional.',
  })

  /*
   * Ordered by the OTHER doctor, so the owner has no standing on it.
   *
   * The first version had the owner place it with somebody else named
   * responsible — and the owner still had standing, because they ordered it.
   * `standingOn` counts the ordering doctor, which is right and is exactly
   * the thing that made the journey assert nothing.
   */
  state.notMine = await arrange(
    'Saravanaperumal',
    { reportText: 'Haemoglobin 13.4 g/dL. Within range.' },
    { orderedBy: other },
  )

  // A PDF on the routine result, filed through the real endpoint so the
  // viewer is opening something the backend actually stored.
  const form = new FormData()
  form.set('resultId', state.labEvidence.resultId)
  form.set('idempotencyKey', key())
  form.set('source', 'external_laboratory')
  form.set('sourceReference', 'CP-2211')
  form.set('file', new File(['%PDF-1.4 synthetic report'], 'report.pdf', { type: 'application/pdf' }))
  const upload = await fetch(`${FUNCTIONS_URL}/results`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner}` },
    body: form,
  })
  const uploaded = await upload.json()
  if (!uploaded.ok) throw new Error(`document upload refused: ${uploaded.message}`)
  state.documentId = uploaded.documentId
})

/* ────────────────────────────────────────────────────────── helpers ── */

const REVIEW = 'Review'

async function openReview(who = OWNER) {
  await freshPage()
  await signIn(who.name, who.pin)
  await goToStation(REVIEW)
  await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
}

const mainSays = (words) =>
  `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(` +
  `${JSON.stringify(String(words).toLowerCase())})`

/**
 * Is this request number on the work surface?
 *
 * `Token` draws `REQ-000001` as two boxes — the prefix and the serial are two
 * different facts and it says so visually — so `innerText` carries them on
 * two lines and a plain substring match for the hyphenated form finds
 * nothing. Both sides lose their separators before comparing, which is what
 * a person reading the screen does anyway.
 */
/** `evaluate` answers with a JSON-quoted string; this is the value inside. */
const unquote = (value) => String(value).trim().replace(/^"|"$/g, '')

const flatten = (value) => String(value).replace(/[\s-]+/g, '').toLowerCase()

/*
 * Compared inside the page, not out here, and that is not a style choice.
 * `evaluate` hands back the text escaped — a newline arrives as the two
 * characters `\` and `n` — so stripping whitespace on this side leaves the
 * backslash behind and nothing ever matches. Every other helper in
 * `clinic-ui.mjs` does its `includes` in the browser for the same reason.
 */
const showsRequest = (orderNumber) =>
  evaluate(
    `(document.querySelector('main')?.innerText ?? '')` +
      `.replace(/[\\s-]+/g, '').toLowerCase()` +
      `.includes(${JSON.stringify(flatten(orderNumber))})`,
  ).includes('true')

/** Open one result by the request number printed on its row. */
async function openResult(orderNumber) {
  /*
   * `\\s` and not `\s`. Inside a template literal JavaScript reads `\s` as a
   * plain `s`, so the regex quietly becomes `/[s-]+/` — it strips the letter
   * s, leaves every newline in place, and the row is never found. It costs
   * one backslash and about forty minutes to notice.
   */
  const clicked = evaluate(`(() => {
    const wanted = ${JSON.stringify(orderNumber)}.replace(/[\\s-]+/g, '').toLowerCase()
    const row = [...document.querySelectorAll('main tbody tr')]
      .find(tr => (tr.innerText || '').replace(/[\\s-]+/g, '').toLowerCase().includes(wanted))
    if (!row) return 'no-row'
    row.click()
    return 'ok'
  })()`)
  if (clicked.includes('no-row')) {
    throw new Error(`no queue row for ${orderNumber}. Screen says: ${workText().slice(0, 600)}`)
  }
  await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
  await waitFor(`!${drawerSays('reading the request')}`, { what: 'the request to load' })
}

const drawerSays = (words) =>
  `(document.querySelector('[role=dialog]')?.innerText ?? '').toLowerCase().includes(` +
  `${JSON.stringify(String(words).toLowerCase())})`

const drawerText = () =>
  evaluate(`(document.querySelector('[role=dialog]')?.innerText ?? '')`)

const drawerShowing = (words) => evaluate(drawerSays(words)).includes('true')

/**
 * Press a button inside the open drawer, by what a screen reader would call
 * it.
 *
 * `aria-label` first and the visible text second, because the drawer's own
 * Close and the document viewer's Close both read "Close" and matching on
 * visible text alone silently pressed the wrong one — closing the whole
 * record instead of the preview.
 */
function drawerButton(label) {
  const pressed = evaluate(`(() => {
    const wanted = ${JSON.stringify(label.toLowerCase())}
    const named = (el) =>
      ((el.getAttribute('aria-label') || el.innerText || '').trim().toLowerCase())
    const buttons = [...document.querySelectorAll('[role=dialog] button')]
    const button = buttons.find(el => named(el) === wanted)
      ?? buttons.find(el => named(el).startsWith(wanted))
    if (!button) return 'no-button'
    if (button.disabled) return 'disabled'
    button.click()
    return 'ok'
  })()`)
  if (pressed.includes('no-button')) {
    throw new Error(`no "${label}" button in the drawer. It says: ${drawerText().slice(0, 700)}`)
  }
  if (pressed.includes('disabled')) throw new Error(`"${label}" is disabled`)
}

/** Press a button by its visible text inside one container. */
/**
 * Choose an option in a drawer select, the way React insists on.
 *
 * Setting `.value` alone never reaches a controlled component: the setter
 * has to be the native one and the event has to bubble.
 */
function chooseInDrawer(labelText, optionText) {
  const answer = unquote(evaluate(`(() => {
    const fields = [...document.querySelectorAll('[role=dialog] select')]
    const box = fields.find(el => (el.closest('label, div')?.innerText ?? '')
      .toLowerCase().includes(${JSON.stringify(labelText.toLowerCase())}))
    if (!box) return 'no-select'
    const option = [...box.options].find(
      o => (o.textContent || '').trim() === ${JSON.stringify(optionText)})
    if (!option) return 'no-option'
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, 'value').set
    setter.call(box, option.value)
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`))
  if (answer !== 'ok') {
    throw new Error(`could not choose "${optionText}" for "${labelText}": ${answer}`)
  }
}

function clickIn(selector, label) {
  const pressed = evaluate(`(() => {
    const scope = document.querySelector(${JSON.stringify(selector)})
    if (!scope) return 'no-scope'
    const button = [...scope.querySelectorAll('button')]
      .find(el => (el.innerText || '').trim().toLowerCase().startsWith(
        ${JSON.stringify(label.toLowerCase())}))
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  if (!pressed.includes('ok')) {
    throw new Error(`no "${label}" in ${selector} — ${workText().slice(0, 500)}`)
  }
}

/** Press a button anywhere on the page, rail included. */
function clickAnywhere(label) {
  const pressed = evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(el => (el.innerText || '').trim().toLowerCase().startsWith(
        ${JSON.stringify(label.toLowerCase())}) && !el.disabled)
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  if (!pressed.includes('ok')) throw new Error(`no "${label}" anywhere on the page`)
}

const drawerHasButton = (label) =>
  evaluate(`[...document.querySelectorAll('[role=dialog] button')]
    .some(el => ((el.getAttribute('aria-label') || el.innerText || '')
      .trim().toLowerCase()).startsWith(${JSON.stringify(label.toLowerCase())}))`).includes('true')

/* ══════════════════════════════════════════════════ 1. who sees it ══ */

describe('the doctor’s result station is offered to a doctor and to nobody else', () => {
  test('a doctor opens Review and sees their unreviewed results', async () => {
    await openReview()
    assert.ok(workShowing('Results to review'), 'the primary section is results')
    assert.ok(showsRequest(state.labEvidence.orderNumber), 'the routine result is listed')
    assert.ok(workShowing('Arulmozhi'), 'the patient is named')
  })

  test('the owner’s doctor and admin roles are unioned, not narrowed', async () => {
    await openReview()
    // The clinical half: a doctor sees the flag column.
    assert.ok(workShowing('Flag'), 'the clinical column is present')
    // The operational half: the admin chase list includes another doctor's
    // request, which a doctor-only session would not be shown.
    assert.ok(
      showsRequest(state.notMine.orderNumber),
      'holding admin means the whole outstanding list',
    )
  })

  test('a doctor-only session sees only their own', async () => {
    await freshPage()
    await signIn(OTHER_DOCTOR.name, OTHER_DOCTOR.pin)
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    assert.ok(showsRequest(state.notMine.orderNumber), 'their own request is there')
    assert.ok(
      !showsRequest(state.labEvidence.orderNumber),
      'somebody else’s is not, because this session holds no admin role',
    )
  })

  test('admin-only, nurse-only and pharmacy-only never reach the station', async () => {
    for (const who of [MANAGER, NURSE, PHARMACIST]) {
      await freshPage()
      await signIn(who.name, who.pin)
      const stations = (await allStations()).map((name) => name.toLowerCase())
      assert.ok(
        !stations.includes('review'),
        `${who.name} must not be offered Review — rail is ${stations.join(', ')}`,
      )
    }
  })
})

/* ═══════════════════════════════ 2. the four facts stay four facts ══ */

describe('what the screen will not confuse', () => {
  test('laboratory validation is visibly not the clinic doctor’s review', async () => {
    await openReview()
    await openResult(state.labEvidence.orderNumber)

    assert.ok(drawerShowing('Dr S. Pathologist'), 'the laboratory’s sign-off is shown')
    assert.ok(
      drawerShowing('Laboratory validation is not the clinic doctor’s review'),
      'and it is labelled as not being a review',
    )
    assert.ok(drawerShowing('Nobody has reviewed this yet'), 'the clinic review is separately absent')
  })

  test('the report is shown exactly as it came, with both flags kept apart', async () => {
    await openReview()
    await openResult(state.criticalRead.orderNumber)

    assert.ok(drawerShowing('Haemoglobin 5.9'), 'the report text is verbatim')
    assert.ok(drawerShowing('The report said'), 'the source flag has its own line')
    assert.ok(drawerShowing('A doctor said'), 'the doctor flag has its own line')
    assert.ok(drawerShowing('CP-2214'), 'the flag’s provenance is shown')
  })

  test('a routine result is reviewed, and authorizing is a separate act', async () => {
    await openReview()
    await openResult(state.reviewFlow.orderNumber)

    // Before the review, there is no authorization control at all.
    assert.ok(
      drawerShowing('can only be authorized after the result has been reviewed'),
      'authorization is gated on the review',
    )
    assert.ok(!drawerHasButton('Authorize'), 'and the control is not offered')

    drawerButton('Record review')
    await waitFor(drawerSays('reviewed this'), { what: 'the recorded review' })

    assert.ok(drawerShowing('Nobody has reviewed this yet') === false)
    assert.ok(drawerHasButton('Authorize'), 'now the separate authorization is offered')
  })

  /*
   * One session, because that is how a doctor meets it.
   *
   * A reviewed result leaves the queue — the queue is what nobody has read —
   * so the review, the wording, the authorization and what actually happened
   * are one visit to one drawer. Splitting them into separate journeys would
   * need a report each and would test a sequence nobody performs.
   */
  test('the sentence is shown, authorized, and never reported as sent', async () => {
    await openReview()
    await openResult(state.notice.orderNumber)

    drawerButton('Record review')
    await waitFor(drawerSays('reviewed this'), { what: 'the recorded review' })

    assert.ok(
      drawerShowing('Your investigation result has been reviewed and is ready. Please contact the clinic.'),
      'the doctor sees the whole message before authorizing it',
    )
    assert.ok(
      drawerShowing('No value, no abnormal status, no diagnosis'),
      'and what it does not carry',
    )

    drawerButton('Authorize')
    await waitFor(drawerSays('authorized the notice'), { what: 'the authorization' })

    const text = drawerText().toLowerCase()
    assert.ok(!text.includes('patient notified'), 'never claims the patient was notified')
    assert.ok(!text.includes('message was delivered'), 'never claims delivery')
    assert.ok(
      text.includes('has not been told') || text.includes('nothing was sent'),
      `it says plainly that the patient has not been told — drawer says: ${drawerText().slice(0, 900)}`,
    )
  })

  test('a patient who never consented gets a truthful unsent state', async () => {
    /*
     * The consent table starts empty, so this patient has agreed to nothing.
     * The authorization stands and the notice does not go — owner item 76's
     * staff queue rather than a failure — and the server's own sentence about
     * that is what the overlay carries.
     */
    await openReview()
    await openResult(state.consent.orderNumber)
    drawerButton('Record review')
    await waitFor(drawerSays('reviewed this'), { what: 'the recorded review' })
    drawerButton('Authorize')
    await waitFor(drawerSays('authorized the notice'), { what: 'the authorization' })

    assert.ok(
      drawerShowing('has not been told') || drawerShowing('nothing was sent'),
      `the screen says the patient has not been told — ${drawerText().slice(0, 700)}`,
    )

    /*
     * The part this test is named for, asserted where the answer actually
     * lives. Consent is decided when a message is DISPATCHED, not when it is
     * authorized, so at this moment the result's own notification row says
     * `scheduled` with no suppression reason and looks exactly like a
     * consented patient's. The consent read is what distinguishes them, and
     * the assertion that matters is that authorizing did not turn "nobody
     * has ever asked this patient" into a message.
     */
    const consent = await read(
      state.ownerToken,
      `workspace?view=communication_consent&patientId=${state.consent.patient.id}`,
    )
    const resultReady = consent.consent.purposes.find((p) => p.purpose === 'result_ready')
    assert.ok(resultReady, 'the result-ready purpose is reported for this patient')
    assert.equal(resultReady.state, 'none', 'this patient has agreed to nothing')
    assert.equal(resultReady.suppressed, true, 'so nothing may be sent to them')
    assert.match(resultReady.reason, /No opt-in has been recorded/)

    const order = await read(
      state.ownerToken,
      `workspace?view=investigation_order&orderId=${state.consent.orderId}`,
    )
    const notification = order.order.items[0].results[0].notification
    assert.ok(notification, 'an intention was recorded')
    assert.equal(
      notification.providerSaidDelivered,
      false,
      'and it is an intention, not a delivery',
    )
    assert.equal(notification.deliveryStatus, 'none', 'nothing has been handed to a provider')
  })
})

/* ════════════════════════════════════════ 3. the critical workflow ══ */

describe('a critical result is a telephone call, not a message', () => {
  test('it can be acknowledged, and acknowledging is not reviewing', async () => {
    await openReview()
    await openResult(state.criticalAck.orderNumber)

    assert.ok(drawerShowing('This result is critical'))
    assert.ok(
      drawerShowing('Acknowledging is not reviewing'),
      'the screen says so before the button is pressed',
    )

    drawerButton('Acknowledge this critical result')
    await waitFor(drawerSays('Acknowledged by'), { what: 'the acknowledgement' })

    assert.ok(drawerShowing('Acknowledging is not reviewing'), 'and again afterwards')
    assert.ok(
      drawerShowing('Nobody has reviewed this yet'),
      'the review is still owed',
    )
  })

  test('it is never offered the automated notice, and is offered a call instead', async () => {
    await openReview()
    await openResult(state.criticalRead.orderNumber)

    assert.ok(!drawerHasButton('Authorize'), 'the automated path is absent')
    assert.ok(
      drawerShowing('not something a patient learns from an automated message'),
      'and the screen says why',
    )
    assert.ok(drawerHasButton('Record this contact'), 'the clinician-led path is offered')
  })

  test('a recorded call names the method, the person and the time', async () => {
    await openReview()
    await openResult(state.criticalCall.orderNumber)

    evaluate(`(() => {
      const box = [...document.querySelectorAll('[role=dialog] textarea')].pop()
      if (!box) return 'no-box'
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(box, 'Telephoned the patient and asked her to come in today.')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)

    drawerButton('Record this contact')
    await waitFor(drawerSays('contacted the patient'), { what: 'the recorded contact' })

    /*
     * Against the record rather than the screen's prose: "Dr. Anbarasan"
     * appears in the order header and "telephone" in the critical banner, so
     * both passed with the contact line deleted.
     */
    const order = await read(
      state.ownerToken,
      `workspace?view=investigation_order&orderId=${state.criticalCall.orderId}`,
    )
    const recorded = order.order.items[0].results[0]
    assert.equal(recorded.patientContactMethod, 'telephone', 'how')
    assert.equal(recorded.patientContactedBy, state.ownerName, 'who')
    assert.ok(recorded.patientContactedAt, 'when')

    // And the screen shows the record, not merely words that happen to match.
    // `patientContactedAt` is rendered as "DD Mon HH24:MI" in clinic time;
    // the day-and-month prefix is enough to prove the record reached the
    // screen rather than the banner being matched by accident.
    assert.ok(
      drawerShowing(recorded.patientContactedAt.slice(0, 6)),
      `the recorded time is on the screen — ${drawerText().slice(0, 700)}`,
    )
  })
})

/* ══════════════════════════════════ 4. standing, and the way through ══ */

describe('the server decides who may review, and the screen offers the way through', () => {
  test('a doctor without standing is refused and offered delegation', async () => {
    await openReview()
    await openResult(state.notMine.orderNumber)

    // The control is NOT hidden: the client cannot prove standing, so it asks.
    assert.ok(drawerHasButton('Record review'), 'the control is offered rather than guessed at')

    drawerButton('Record review')
    await waitFor(drawerSays('Only the doctor responsible'), { what: 'the server’s refusal' })

    assert.ok(
      drawerShowing('Hand this over to a doctor'),
      'and the audited delegation is offered',
    )
    assert.ok(drawerShowing('recorded with your name and the reason'))
  })
})

/* ══════════════════════ 4b. a reply that was lost, and a second press ══ */

describe('work that already committed is discovered, not written twice', () => {
  /*
   * A lost reply is indistinguishable from a request that never arrived, so
   * the honest recovery is a READ. These two journeys stand in for it: the
   * write is committed out of band — exactly what a lost reply leaves behind
   * — and then the doctor presses the control again, which is what a person
   * does when the tablet said nothing. The server refuses, the screen
   * re-reads, and what is on the record is what it shows.
   */
  test('a review that already committed is shown, not overwritten', async () => {
    await must(state.ownerToken, 'review_result', {
      resultId: state.alreadyReviewed.resultId,
      conclusion: 'clinical_action_taken',
      note: 'Recorded before the tablet heard back.',
    })

    await openReview()
    /*
     * It has left the queue, because the queue is what nobody has read —
     * which is itself the answer a doctor needs after a lost reply, and is
     * asserted here rather than worked around.
     */
    assert.ok(
      !showsRequest(state.alreadyReviewed.orderNumber),
      'a reviewed result is no longer waiting for a doctor',
    )

    // And the screen says so when it is reached the only way it can be — the
    // note a tablet leaves itself. Without this the test asserted only that
    // nothing rendered, which is also what deleting the station would do.
    await reloadOntoNote({
      orderId: state.alreadyReviewed.orderId,
      resultId: state.alreadyReviewed.resultId,
      action: 'review',
      phase: 'outcome_unknown',
    })
    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    await waitFor(drawerSays('recorded after all'), { what: 'the settled outcome' })

    assert.ok(drawerShowing('already reviewed this'), 'the existing review is shown')
    assert.ok(drawerShowing('written once'), 'and it says why it cannot be redone')
    assert.ok(!drawerHasButton('Record review'), 'there is nothing to press that would overwrite it')

    const reviews = await read(state.ownerToken, `workspace?view=investigation_order&orderId=${state.alreadyReviewed.orderId}`)
    const result = reviews.order.items[0].results[0]
    assert.equal(result.review.conclusion, 'clinical_action_taken', 'one review, and it is the first')
    assert.equal(
      reviews.order.items[0].results.filter((r) => r.review).length,
      1,
      'and still exactly one',
    )
  })

  test('an authorization that already committed does not create a second notice', async () => {
    await must(state.ownerToken, 'review_result', {
      resultId: state.alreadyAuthorized.resultId,
      conclusion: 'patient_to_be_informed',
    })
    await must(state.ownerToken, 'authorize_result_notification', {
      resultId: state.alreadyAuthorized.resultId,
    })

    // Pressing again from a second tab, against a record that already has it.
    const again = await command(state.ownerToken, 'authorize_result_notification', {
      resultId: state.alreadyAuthorized.resultId,
    })
    assert.ok(again.ok, 'the second press is answered rather than refused outright')
    assert.equal(again.data.duplicate, true, 'and it is reported as the same authorization')

    const order = await read(
      state.ownerToken,
      `workspace?view=investigation_order&orderId=${state.alreadyAuthorized.orderId}`,
    )
    const result = order.order.items[0].results[0]
    assert.ok(result.notificationAuthorizedAt, 'the authorization is on the record')
    assert.ok(
      !result.notification?.providerSaidDelivered,
      'and it is still not a delivery',
    )

    // The screen, on the same record. It offers no second authorization and
    // never claims the patient heard anything.
    await reloadOntoNote({
      orderId: state.alreadyAuthorized.orderId,
      resultId: state.alreadyAuthorized.resultId,
      action: 'authorize',
      phase: 'outcome_unknown',
    })
    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    await waitFor(drawerSays('recorded after all'), { what: 'the settled outcome' })

    assert.ok(!drawerHasButton('Authorize'), 'no second authorization is offered')
    assert.ok(
      drawerShowing('has not been told') || drawerShowing('nothing was sent'),
      'and nothing says the patient heard',
    )
  })
})

/* ══════════════════════════ 4c. the reply that never came, and a reload ══ */

/**
 * Send the next command, let it commit, and throw away the answer.
 *
 * This is the real condition and not a mock of it: the request reaches the
 * clinic and the reply never gets home, which is what a dropped connection
 * on clinic wifi produces and what `NoAnswer` in `lib/api.ts` exists for.
 * Arming it for one call only means the reload afterwards behaves normally.
 */
function loseTheNextReply() {
  evaluate(`(() => {
    const real = window.fetch
    window.fetch = async (...args) => {
      const target = String(args[0] ?? '')
      if (target.includes('/command')) {
        window.fetch = real
        try { await real(...args) } catch { /* it still committed, or it did not */ }
        throw new TypeError('the connection went away')
      }
      return real(...args)
    }
    return 'armed'
  })()`)
}

/**
 * A reload of the same tab.
 *
 * Which is what keeps `sessionStorage` — and, because the session token is in
 * `localStorage`, also what keeps the doctor signed in. That is the real
 * scenario: a tablet that stopped responding is reloaded and the person is
 * still who they were. Signing in again here would be testing a different
 * day.
 */
async function reloadTablet() {
  evaluate(`location.reload()`)
  await waitFor(`!!document.querySelector('nav[aria-label="Clinic stations"]')`, {
    what: 'the tablet to come back signed in',
    timeout: 25_000,
  })
}

/**
 * The note, as its JSON text.
 *
 * `evaluate` hands back a JSON-encoded string, so the stored JSON arrives
 * escaped inside it and one `JSON.parse` is what gets to the text the page
 * actually holds.
 */
/**
 * Leave a recovery note the way an interrupted attempt would, and reload.
 *
 * The station's own way back to a result that has left the queue. Used by the
 * journeys about work that committed while nobody was listening: without it
 * there is no screen that can reach such a result, and a test that only reads
 * the database is a backend test wearing a browser.
 */
async function reloadOntoNote({ orderId, resultId, action, phase }) {
  const note = JSON.stringify({
    staffId: state.ownerStaffId,
    orderId,
    resultId,
    action,
    phase,
    reference: 'seeded-attempt',
    at: Date.now(),
  })
  evaluate(
    `window.sessionStorage.setItem('jayamurugan_result_followup', ` +
      `${JSON.stringify(note)})`,
  )
  await reloadTablet()
  await goToStation(REVIEW)
  await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
}

const noteInStorage = () => {
  const raw = evaluate(`window.sessionStorage.getItem('jayamurugan_result_followup') ?? ''`).trim()
  try {
    const inner = JSON.parse(raw)
    return typeof inner === 'string' ? inner : raw
  } catch {
    return unquote(raw)
  }
}

describe('a reply that never came back, and the reload after it', () => {
  test('a lost review is discovered on reload and is not written twice', async () => {
    await openReview()
    await openResult(state.lostReview.orderNumber)

    loseTheNextReply()
    drawerButton('Record review')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })

    // The note is down before the reload, and carries no clinical content.
    const note = noteInStorage()
    assert.ok(note.includes('outcome_unknown'), `a note was left: ${note}`)
    assert.ok(!note.includes('Haemoglobin'), 'and it carries no report text')

    await reloadTablet()
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })

    // The result has left the queue, so the note is the only way back.
    assert.ok(
      !showsRequest(state.lostReview.orderNumber),
      'a reviewed result is no longer waiting for a doctor',
    )
    assert.ok(workShowing('Continue result follow-up'), 'and the way back is offered')

    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    await waitFor(drawerSays('recorded after all'), { what: 'the settled outcome' })

    // One review, and it is the first one.
    const order = await read(
      state.ownerToken,
      `workspace?view=investigation_order&orderId=${state.lostReview.orderId}`,
    )
    assert.ok(order.order.items[0].results[0].review, 'the review is on the record')
    assert.ok(
      !drawerHasButton('Record review'),
      'and the screen does not offer to write it again',
    )
  })

  test('a lost authorization is discovered on reload and makes no second notice', async () => {
    await openReview()
    await openResult(state.lostAuthorize.orderNumber)

    // Reviewed on the screen, which is what leaves the follow-up note and
    // takes the result out of the queue — the same two things a real session
    // does before it gets to the authorization.
    drawerButton('Record review')
    await waitFor(drawerSays('reviewed this'), { what: 'the recorded review' })

    loseTheNextReply()
    drawerButton('Authorize')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })

    await reloadTablet()
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    assert.ok(workShowing('Continue result follow-up'))

    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    await waitFor(drawerSays('authorized the notice'), { what: 'the existing authorization' })

    assert.ok(!drawerHasButton('Authorize'), 'no second authorization is offered')

    // And exactly one intention exists behind it.
    const schedules = await read(
      state.ownerToken,
      `workspace?view=investigation_order&orderId=${state.lostAuthorize.orderId}`,
    )
    const result = schedules.order.items[0].results[0]
    assert.ok(result.notificationAuthorizedAt, 'one authorization')
    assert.ok(!result.notification?.providerSaidDelivered, 'and still not a delivery')
  })

  test('dismissing the drawer while the outcome is unknown keeps the note', async () => {
    await openReview()
    await openResult(state.dismissUnknown.orderNumber)

    loseTheNextReply()
    drawerButton('Record review')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })
    const attempt = JSON.parse(noteInStorage() || '{}').reference
    assert.ok(attempt, 'the attempt is named')

    // Walking away does not settle anything. Only the record does.
    drawerButton('Close')
    await waitFor(`document.querySelector('[role=dialog]') === null`, { what: 'the drawer to close' })
    assert.ok(noteInStorage().includes('outcome_unknown'), 'the note survives the dismissal')

    await goToStation('Today')
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    assert.ok(workShowing('Continue result follow-up'), 'and survives leaving the station')
    assert.equal(
      JSON.parse(noteInStorage() || '{}').reference,
      attempt,
      'and it is still the same attempt: a remount must not mint a second one',
    )
  })

  test('a reviewed result closed before follow-up stays reachable', async () => {
    await openReview()
    await openResult(state.followUp.orderNumber)

    // The conclusion is what owes the follow-up: the default concludes nothing
    // needs doing, and nothing needing doing owes no note.
    chooseInDrawer('What you concluded', 'Patient to be informed')
    drawerButton('Record review')
    await waitFor(drawerSays('reviewed this'), { what: 'the recorded review' })
    // The doctor is interrupted and closes it before authorizing.
    drawerButton('Close')
    await waitFor(`document.querySelector('[role=dialog]') === null`, { what: 'the drawer to close' })

    await goToStation('Today')
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })

    assert.ok(
      !showsRequest(state.followUp.orderNumber),
      'it has left the queue, which is why the note matters',
    )
    assert.ok(workShowing('Continue result follow-up'))
    assert.ok(
      workShowing('still has to be followed up'),
      'and it says the patient has not been told rather than that something failed',
    )

    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    assert.ok(drawerHasButton('Authorize'), 'the follow-up is there to finish')
  })

  test('pressing twice reuses one reference and writes one review', async () => {
    await openReview()
    await openResult(state.supersededRecovery.orderNumber)

    // A conclusion that owes follow-up, so settling has somewhere to put the
    // attempt rather than simply dropping it.
    chooseInDrawer('What you concluded', 'Patient to be informed')
    loseTheNextReply()
    drawerButton('Record review')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })
    const firstRaw = noteInStorage()
    assert.ok(firstRaw, 'the attempt left a note to reuse')
    const first = JSON.parse(firstRaw)
    assert.ok(first.reference, 'and the note names the attempt')

    // A second press while the outcome is unknown is refused by the screen:
    // the control is closed until the record has been read.
    assert.ok(
      !drawerHasButton('Record review') ||
        evaluate(`[...document.querySelectorAll('[role=dialog] button')]
          .filter(el => (el.innerText||'').trim().toLowerCase().startsWith('record review'))
          .every(el => el.disabled)`).includes('true'),
      'the control is closed while nobody knows',
    )

    drawerButton('Check again')
    await waitFor(drawerSays('recorded after all'), { what: 'the settled outcome' })

    // Settling does not drop the attempt: the review landed and the patient
    // still has to hear, so the note changes its meaning and keeps its name.
    const after = JSON.parse(noteInStorage() || '{}')
    assert.equal(after.reference, first.reference, 'one attempt, one reference')
    assert.equal(after.phase, 'follow_up', 'and it is owed follow-up, not an unknown outcome')
    assert.equal(
      Number(
        (await read(
          state.ownerToken,
          `workspace?view=investigation_order&orderId=${state.supersededRecovery.orderId}`,
        )).order.items[0].results.filter((r) => r.review).length,
      ),
      1,
      'one review row',
    )
  })

  test('a note about a corrected report resolves safely and goes away', async () => {
    await openReview()
    await openResult(state.isolation.orderNumber)

    loseTheNextReply()
    drawerButton('Record review')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })
    drawerButton('Close')

    // The laboratory re-issues while the note is outstanding.
    await must(state.ownerToken, 'record_result', {
      idempotencyKey: key(),
      orderItemId: state.isolation.itemId,
      source: 'external_laboratory',
      reportText: 'Corrected: Haemoglobin 11.9 g/dL.',
      correctsResultId: state.isolation.resultId,
      correctionReason: 'Laboratory re-issued',
    })

    await reloadTablet()
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    clickIn('main', 'Open the result')
    await waitFor(`document.querySelector('[role=dialog]') !== null`, { what: 'the result drawer' })
    await waitFor(drawerSays('has been corrected'), { what: 'the safe resolution' })

    assert.ok(
      drawerShowing('nothing left to finish') || drawerShowing('nothing can be recorded against it'),
      'it points at the corrected report rather than offering a dead control',
    )
  })

  test('signing out takes the note with it, and the next person sees none', async () => {
    await openReview()
    await openResult(state.signOut.orderNumber)
    loseTheNextReply()
    drawerButton('Acknowledge this critical result')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })
    assert.ok(noteInStorage(), 'there is a note to lose')

    // Out through the real control, which is also the idle lock's path.
    clickAnywhere('Sign out')
    await waitFor(`document.body.innerText.includes('Jayamurugan') && !document.querySelector('nav')`, {
      what: 'the lock screen',
      timeout: 20_000,
    })
    assert.equal(noteInStorage(), '', 'the note went with the session')

    await signIn(OTHER_DOCTOR.name, OTHER_DOCTOR.pin)
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    assert.ok(
      !workShowing('Continue result follow-up'),
      'and the next person is not handed somebody else’s unfinished work',
    )
  })

  test('nothing clinical is ever written to session storage', async () => {
    await openReview()

    // A note has to exist or this proves nothing about what a note holds. It
    // is left on a result of its own: recording a review takes one out of the
    // queue, and the document and width journeys below still need theirs.
    await openResult(state.storageProbe.orderNumber)
    loseTheNextReply()
    drawerButton('Record review')
    await waitFor(drawerSays('Outcome not confirmed'), { what: 'the honest unknown' })
    assert.ok(noteInStorage(), 'there is a note to inspect')

    const everything = unquote(evaluate(`JSON.stringify(
      Object.fromEntries(Object.keys(window.sessionStorage).map(k => [k, window.sessionStorage.getItem(k)]))
    )`))
    for (const clinical of [
      'Haemoglobin', 'Arulmozhi', 'Pathologist', 'Full blood count', 'blob:', 'critical',
    ]) {
      assert.ok(
        !everything.includes(clinical),
        `"${clinical}" reached sessionStorage: ${everything.slice(0, 400)}`,
      )
    }

    // Deliberately left unfinished above; cleared here so the journeys after
    // this one start from the same place as the ones before it.
    evaluate(`window.sessionStorage.removeItem('jayamurugan_result_followup')`)
  })
})

/* ═══════════════════════════════════════════ 5. corrections are final ══ */

describe('a corrected report makes the old one unusable', () => {
  test('an open stale result loses its controls and points at the current one', async () => {
    await openReview()
    await openResult(state.corrected.orderNumber)
    assert.ok(drawerHasButton('Record review'), 'it is actionable while it is current')

    // The laboratory re-issues while the doctor is reading.
    await must(state.ownerToken, 'record_result', {
      idempotencyKey: key(),
      orderItemId: state.corrected.itemId,
      source: 'external_laboratory',
      reportText: 'Corrected: Haemoglobin 11.4 g/dL.',
      correctsResultId: state.corrected.resultId,
      correctionReason: 'Laboratory re-issued with a corrected haemoglobin',
    })

    // Anything the doctor now presses is refused, and the screen re-reads and
    // says so rather than leaving a live control on history.
    drawerButton('Record review')
    await waitFor(drawerSays('has been corrected'), { what: 'the superseded notice' })

    assert.ok(
      drawerShowing('nothing can be recorded against it'),
      'the stale report is explicitly not actionable',
    )
    assert.ok(!drawerHasButton('Record review'), 'and the control is gone')
  })
})

/* ════════════════════════════════════════════════════ 6. documents ══ */

describe('a report document opens through short-lived authorized access', () => {
  test('a PDF opens, and no token reaches the URL, the DOM or storage', async () => {
    await openReview()
    await openResult(state.labEvidence.orderNumber)

    assert.ok(drawerShowing('Attached reports'), 'the document is listed')
    drawerButton('Open')
    await waitFor(`document.querySelector('[role=dialog] object, [role=dialog] img') !== null`, {
      what: 'the document preview',
    })

    // `evaluate` hands values back JSON-quoted, so the quotes come off before
    // anything is matched against them.
    const src = unquote(evaluate(
      `(document.querySelector('[role=dialog] object')?.getAttribute('data') ?? '')`,
    ))
    assert.match(src, /^blob:/, 'the bytes are a blob URL in this tab, never a durable link')

    const token = unquote(evaluate(`window.localStorage.getItem('jayamurugan_token') ?? ''`))
    assert.ok(token.length > 10, 'there is a token to look for')
    assert.ok(!src.includes(token), 'it is not in the document URL')
    assert.ok(
      !evaluate(`document.documentElement.outerHTML`).includes(token),
      'nor anywhere in the DOM',
    )
    assert.ok(
      !evaluate(`JSON.stringify(window.sessionStorage)`).includes('blob:'),
      'no blob URL is persisted',
    )
    assert.ok(
      !evaluate(`Object.keys(window.localStorage).join(',')`).toLowerCase().includes('result'),
      'nothing about a result is written to local storage',
    )
  })

  test('closing the document revokes the object URL', async () => {
    await openReview()
    await openResult(state.labEvidence.orderNumber)
    drawerButton('Open')
    await waitFor(`document.querySelector('[role=dialog] object') !== null`, {
      what: 'the document preview',
    })
    const src = unquote(
      evaluate(`(document.querySelector('[role=dialog] object')?.getAttribute('data') ?? '')`),
    )

    drawerButton('Close the report')
    await waitFor(`document.querySelector('[role=dialog] object') === null`, {
      what: 'the preview to close',
    })

    /*
     * A revoked blob URL cannot be fetched again; if it could, the bytes
     * would outlive the screen that showed them. `evaluate` is synchronous
     * and would hand back a stringified Promise, so the answer is parked on
     * the page and read once it lands.
     */
    evaluate(`(() => {
      window.__blobProbe = 'pending'
      fetch(${JSON.stringify(src)})
        .then((response) => { window.__blobProbe = response.ok ? 'still-live' : 'revoked' })
        .catch(() => { window.__blobProbe = 'revoked' })
      return 'started'
    })()`)
    await waitFor(`window.__blobProbe !== 'pending'`, { what: 'the blob URL probe' })
    assert.equal(
      unquote(evaluate(`window.__blobProbe`)),
      'revoked',
      'the object URL no longer resolves',
    )
  })
  test('leaving the workspace revokes the document and drops the clinical detail', async () => {
    await openReview()
    await openResult(state.labEvidence.orderNumber)
    drawerButton('Open')
    await waitFor(`document.querySelector('[role=dialog] object') !== null`, {
      what: 'the document preview',
    })
    const src = unquote(
      evaluate(`(document.querySelector('[role=dialog] object')?.getAttribute('data') ?? '')`),
    )

    // Away to another station. The drawer unmounts with the workspace, and
    // the viewer's cleanup runs with it.
    await goToStation('Today')
    await waitFor(`document.querySelector('[role=dialog]') === null`, { what: 'the drawer to go' })

    evaluate(`(() => {
      window.__awayProbe = 'pending'
      fetch(${JSON.stringify(src)})
        .then((response) => { window.__awayProbe = response.ok ? 'still-live' : 'revoked' })
        .catch(() => { window.__awayProbe = 'revoked' })
      return 'started'
    })()`)
    await waitFor(`window.__awayProbe !== 'pending'`, { what: 'the blob URL probe' })
    assert.equal(unquote(evaluate(`window.__awayProbe`)), 'revoked')

    // And the report text has gone with it.
    assert.ok(
      !workShowing('Haemoglobin 12.8'),
      'no clinical detail is left on the screen behind',
    )
  })
})

/* ════════════════════════════════════════ 7. shape and accessibility ══ */

describe('the station works on every tablet the clinic owns', () => {
  test('no horizontal overflow and the primary action is reachable at every width', async () => {
    await openReview()
    for (const shape of EVERY_SHAPE) {
      setViewport(shape)
      await waitFor(`${mainSays('results to review')}`, { what: `the station at ${shape.name}` })
      const overflow = evaluate(
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
      )
      assert.ok(
        Number(overflow) <= 1,
        `${shape.name} scrolls sideways by ${overflow}px`,
      )

      // And when the table is wider than the phone, it is the table that
      // scrolls, not the page — the pattern `Table` is built on.
      assert.ok(
        evaluate(`(() => {
          const table = document.querySelector('main table')
          if (!table) return 'no-table'
          const box = table.closest('div')
          return getComputedStyle(box).overflowX
        })()`).includes('auto'),
        `the table is not the thing that scrolls at ${shape.name}`,
      )

      /*
       * The half the name promised and the test did not check. The way into
       * a result is the queue ROW, not a button — `TR` takes the click, and
       * takes `tabIndex={0}` and Enter/Space with it — so that is what has
       * to be present, reachable from the keyboard, on the screen, and tall
       * enough for a thumb at every width.
       */
      const open = evaluate(`(() => {
        const row = document.querySelector('main tbody tr')
        if (!row) return JSON.stringify({ found: false })
        const box = row.getBoundingClientRect()
        const viewport = document.documentElement.clientWidth
        return JSON.stringify({
          found: true,
          tabIndex: row.tabIndex,
          says: (row.innerText || '').toLowerCase().includes('open'),
          height: Math.round(box.height),
          // How much of the row a thumb can actually land on without
          // scrolling anything: seven columns are wider than a phone, and
          // the table scrolls inside itself rather than taking the page
          // with it. The whole row is the control, so the visible part is
          // the target.
          reachable: Math.round(Math.min(box.right, viewport) - Math.max(box.left, 0)),
        })
      })()`)
      const seen = JSON.parse(JSON.parse(open))
      assert.ok(seen.found, `no way to open a result at ${shape.name}`)
      assert.equal(seen.tabIndex, 0, `the row is not keyboard-reachable at ${shape.name}`)
      assert.ok(seen.says, `the row does not offer to open at ${shape.name}`)
      assert.ok(seen.height >= 44, `the row is ${seen.height}px tall at ${shape.name}`)
      assert.ok(
        seen.reachable >= 44,
        `only ${seen.reachable}px of the row is on screen at ${shape.name}`,
      )
    }
    setViewport(DESKTOP)
  })

  test('the detail is a drawer that traps focus and Escape closes it', async () => {
    await openReview()
    await openResult(state.labEvidence.orderNumber)

    assert.ok(
      evaluate(`document.querySelector('[role=dialog]')?.getAttribute('aria-modal')`).includes('true'),
      'the detail is a modal surface',
    )
    assert.ok(
      evaluate(`document.querySelector('[role=dialog]')?.contains(document.activeElement)`)
        .includes('true'),
      'focus moved into it',
    )

    /*
     * Tab from the last focusable thing in the drawer. A trap sends it back
     * to the first; without one it lands on the queue behind. The old test
     * asserted neither and passed with the trap deleted.
     */
    const trapped = evaluate(`(() => {
      const panel = document.querySelector('[role=dialog]')
      if (!panel) return 'no-panel'
      const focusable = [...panel.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(el => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length < 2) return 'too-few'
      const last = focusable[focusable.length - 1]
      last.focus()
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      return panel.contains(document.activeElement) ? 'inside' : 'escaped'
    })()`)
    assert.equal(unquote(trapped), 'inside', 'Tab from the last control stays in the drawer')

    evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(`document.querySelector('[role=dialog]') === null`, { what: 'the drawer to close' })
  })

  test('at 320px the drawer is the whole screen and still usable', async () => {
    setViewport(NARROW)
    await openReview()
    await openResult(state.labEvidence.orderNumber)
    const shape = JSON.parse(JSON.parse(evaluate(`(() => {
      const panel = document.querySelector('[role=dialog]')
      const box = panel.getBoundingClientRect()
      const buttons = [...panel.querySelectorAll('button')].filter(el => el.offsetParent !== null)
      return JSON.stringify({
        width: Math.round(box.width),
        viewport: document.documentElement.clientWidth,
        overflow: panel.scrollWidth - panel.clientWidth,
        shortest: buttons.length
          ? Math.round(Math.min(...buttons.map(el => el.getBoundingClientRect().height)))
          : 0,
      })
    })()`)))

    assert.equal(shape.width, shape.viewport, 'the drawer is the whole screen, not most of it')
    assert.ok(shape.overflow <= 1, `the drawer scrolls sideways by ${shape.overflow}px`)
    assert.ok(shape.shortest >= 44, `its shortest control is ${shape.shortest}px tall`)
    assert.ok(drawerShowing('The report'), 'and the report is still there')
    setViewport(DESKTOP)
  })
})

/* ═══════════════════════════════════════ 8. nothing else moved ══ */

describe('the rest of the clinic is untouched', () => {
  test('the legacy prescription review is still on the same station, unchanged', async () => {
    await openReview()
    assert.ok(
      workShowing('Prescription lines from the old records'),
      'the legacy backlog has its own heading',
    )
    assert.ok(
      workShowing('separate determination kept beside the signed line'),
      'and its own unchanged explanation',
    )
  })

  test('a doctor can still reach the consultation and the queue', async () => {
    await freshPage()
    await signIn(OWNER.name, OWNER.pin)

    // `continue` on a missing station used to make this pass by skipping:
    // delete Today and Consult from the rail and nothing was asserted at
    // all. A station that has gone is the failure this test is for.
    const stations = (await allStations()).map((name) => name.toLowerCase())
    for (const station of ['Today', 'Consult']) {
      assert.ok(
        stations.some((name) => name.startsWith(station.toLowerCase())),
        `${station} is missing from the doctor's rail — it was there before the results went in`,
      )
      await goToStation(station)
      assert.ok(workText().length > 0, `${station} still opens`)
    }

    // And the results did not take the station's own heading with them.
    await goToStation(REVIEW)
    await waitFor(`!${mainSays('reading the results waiting')}`, { what: 'the result queue' })
    assert.ok(workShowing('Review'), 'Review is still Review')
  })
})
