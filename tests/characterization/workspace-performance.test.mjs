/**
 * The read models, against a register big enough for the plan to matter.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * The first version of Slice 1 reported query plans taken on "a staging table
 * bulked to 20,001 patients by hand". That is evidence of a sort, and it has
 * three problems: nobody else can reproduce it, nothing re-runs it when an
 * index is dropped or a query is rewritten, and the numbers it produced were
 * milliseconds — which say as much about the machine and the cache as about
 * the query. A measurement that cannot fail is not a gate.
 *
 * This builds the same volume from a generator, asserts what can actually be
 * asserted about it, and takes it away again.
 *
 * ── WHY PLANS AND CAPS, AND NOT MILLISECONDS ───────────────────────────────
 *
 * "Under 50 ms" passes on a fast laptop with a warm cache and fails in CI for
 * reasons that have nothing to do with the query, so it gets a bigger number
 * until it stops failing, and then it is asserting nothing. What actually
 * matters is structural and does not drift: that the indexed search reaches
 * the register through an index rather than reading all of it, that the
 * fallback is the sequential scan it is documented to be rather than an
 * accident, and that no answer grows with the size of the clinic.
 *
 * The one thing timing is used for is a ratio between two plans measured in
 * the same run on the same machine, which is a comparison rather than a
 * threshold — and even that is generous enough to be about the shape of the
 * work rather than the speed of the disk.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { db } from '../support/backend.mjs'
import {
  as, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor,
} from '../support/clinic.mjs'
import { edgeGet } from '../support/backend.mjs'
import {
  PATIENT_READS, searchRankedShell, searchStatements,
} from '../../supabase/functions/_shared/workspace.ts'

after(async () => { await closeClinic() })

/** How many patients the register is filled to. */
const VOLUME = 20_000

/**
 * A register of the stated size, built by one statement and removed by one.
 *
 * `generate_series` rather than twenty thousand inserts: the whole thing takes
 * a second or so, and it is deterministic — the same names, the same phone
 * numbers, the same ids on every run, so a plan that changes did so because
 * the query changed.
 *
 * The names are deliberately dull and uniform. A generator that made a
 * plausible-looking clinic would also make a skewed one, and then the plan
 * would depend on which surname happened to be popular. Everything here is
 * `Bulk Patient <n>` so that selectivity is a property of the prefix asked
 * for and nothing else.
 */
async function fillRegister() {
  await db.db.prepare(`
    insert into patients (id, name, phone, age, sex, created_at)
    select 'bulk-' || lpad(n::text, 6, '0'),
           'Bulk Patient ' || n,
           '+9198' || lpad(n::text, 8, '0'),
           20 + (n % 60),
           case when n % 2 = 0 then 'male' else 'female' end,
           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      from generate_series(1, ${VOLUME}) as n
    on conflict (id) do nothing`).run()

  /*
   * Arrivals, because an empty table has no plan worth asserting.
   *
   * The token branch's assertion below reads `appointments`, and with nothing
   * in it Postgres scans — correctly, four pages being cheaper than an index
   * lookup — so the assertion would have been measuring the fixture rather
   * than the query. Two thousand open arrivals is unrealistic for one clinic
   * day and exactly right for making the planner choose.
   */
  await db.db.prepare(`
    insert into appointments (id, patient_id, token, reason, status, scheduled_at, created_at)
    select 'bulk-a-' || lpad(n::text, 6, '0'), 'bulk-' || lpad(n::text, 6, '0'),
           'JMC-' || lpad(n::text, 6, '0'), 'Fever', 'waiting',
           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      from generate_series(1, ${VOLUME}, 10) as n
    on conflict (id) do nothing`).run()

  /*
   * History for the per-patient reads, and not as an afterthought.
   *
   * The plan assertions below cover `vitals`, `encounters` and
   * `consultation_drafts`, and against empty tables every one of them passes
   * whatever the query says — Postgres reads no rows either way, so
   * "does not scan" is true of a table with nothing in it. One row per
   * thousand patients is enough for the planner to have a choice to make and
   * cheap enough to build in the same statement.
   */
  await db.db.prepare(`
    insert into vitals (id, patient_id, pulse, recorded_by, recorded_at, not_measured_note)
    select 'bulk-v-' || lpad(n::text, 6, '0'), 'bulk-' || lpad(n::text, 6, '0'),
           70 + (n % 30), '${staff.id}',
           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''
      from generate_series(1, ${VOLUME}, 10) as n
    on conflict (id) do nothing`).run()

  await db.db.prepare(`
    insert into encounters
      (id, patient_id, doctor_id, diagnosis, notes, advice, created_at)
    select 'bulk-e-' || lpad(n::text, 6, '0'), 'bulk-' || lpad(n::text, 6, '0'),
           '${staff.id}', 'Viral fever', '', '',
           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      from generate_series(1, ${VOLUME}, 10) as n
    on conflict (id) do nothing`).run()

  await db.db.prepare(`
    insert into consultation_drafts (id, patient_id, doctor_id, diagnosis, updated_at)
    select 'bulk-d-' || lpad(n::text, 6, '0'), 'bulk-' || lpad(n::text, 6, '0'),
           '${staff.id}', 'Draft', now()
      from generate_series(1, ${VOLUME}, 10) as n
    on conflict do nothing`).run()

  // Without this the planner is working from the statistics of an empty table
  // and will choose a sequential scan for everything, which would make these
  // assertions pass or fail for the wrong reason.
  for (const table of ['patients', 'appointments', 'vitals', 'encounters', 'consultation_drafts']) {
    await db.db.prepare(`analyze ${table}`).run()
  }
}

/** And taken away again, so no other file inherits a register of this size. */
async function emptyRegister() {
  // Children before parents: every one of these points a foreign key at
  // `patients`, so the register cannot go first.
  await db.db.prepare(`delete from consultation_drafts where patient_id like 'bulk-%'`).run()
  await db.db.prepare(`delete from encounters where patient_id like 'bulk-%'`).run()
  await db.db.prepare(`delete from vitals where patient_id like 'bulk-%'`).run()
  await db.db.prepare(`delete from appointments where patient_id like 'bulk-%'`).run()
  await db.db.prepare(`delete from patients where id like 'bulk-%'`).run()
  for (const table of ['patients', 'appointments', 'vitals', 'encounters', 'consultation_drafts']) {
    await db.db.prepare(`analyze ${table}`).run()
  }
}

/** `EXPLAIN ANALYZE`, as one string, for a statement with `?` placeholders. */
async function planOf(sql, params) {
  let index = 0
  const positional = sql.replace(/\?/g, () => `$${(index += 1)}`)
  const lines = await rows(`explain (analyze, buffers, format text) ${positional}`, params)
  return lines.map((line) => line['QUERY PLAN']).join('\n')
}

let staff

before(async () => {
  await resetClinic()
  staff = await makeStaff({
    name: 'Owner', roles: ['admin', 'doctor', 'nurse', 'pharmacy'], username: 'owner', pin: '5731',
  })
  staff.token = await tokenFor(staff)
  await fillRegister()
})

after(async () => { await emptyRegister() })

const read = (path) => edgeGet('workspace', `?view=${path}`, staff.token)

describe(`a register of ${VOLUME.toLocaleString('en-IN')} patients`, () => {
  test('the generator built what it said it would, and it is deterministic', async () => {
    assert.equal(Number(await scalar(`select count(*)::int from jmc.patients where id like 'bulk-%'`)),
      VOLUME)
    assert.equal(String(await scalar(`select name from jmc.patients where id = 'bulk-000001'`)),
      'Bulk Patient 1', 'the same row on every run, so a changed plan means a changed query')
  })
})

describe('the indexed search reaches the register through an index', () => {
  /*
   * Each branch is asserted on its own, because the UNION's whole purpose is
   * that one unindexable branch cannot drag the others into a scan. A test of
   * the combined statement alone would pass with three good branches and one
   * bad one.
   */
  test('an exact phone is an index scan and reads almost nothing', async () => {
    const terms = { digits: '9812345678', trimmed: '9812345678', likeName: '9812345678' }
    const { indexed } = searchStatements(searchRankedShell(), terms)
    const plan = await planOf(indexed.sql, indexed.params)

    assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/,
      'the phone branch must use patients_phone_digits')
    assert.doesNotMatch(plan, /Seq Scan on patients/,
      'no branch of the indexed pass may read the whole register')
  })

  test('a name prefix is an index scan on the expression index', async () => {
    const terms = { digits: '', trimmed: 'Bulk Patient 1234', likeName: 'bulk patient 1234' }
    const { indexed } = searchStatements(searchRankedShell(), terms)
    const plan = await planOf(indexed.sql, indexed.params)

    assert.match(plan, /patients_normalized_name/,
      'the prefix branch must qualify for the expression index, which means the expression in the '
      + 'query has to match the one in the migration character for character')
    assert.doesNotMatch(plan, /Seq Scan on patients/)
  })

  /*
   * This asserted only that the REGISTER was not scanned, which is true
   * whatever happens to `appointments` — so it passed while the token branch
   * read every appointment in the clinic. The branch had been written
   * `upper(x.token) = upper(?)`, and a btree on the bare column cannot serve a
   * predicate on `upper(column)`: `appointments_token_idx` was maintained on
   * every insert and used by nothing. Tokens are generated uppercase, so only
   * the caller's input needs folding, and the index is reachable again.
   *
   * The index it names changed in Slice 2, and this assertion's own logic is
   * what changed it. `appointments_open_token_unique` is the partial unique
   * index owner item 70's queue needs — two waiting patients may no longer
   * share one token — and it is partial on exactly the rows this query filters
   * to, so it serves the search strictly better than the full index did. That
   * left `appointments_token_idx` maintained on every arrival in order to
   * answer nothing, which is the condition this test exists to catch, so
   * `20260920000000` drops it.
   */
  test('a token goes to the appointment index and not to the register', async () => {
    const terms = { digits: '', trimmed: 'JMC-0001', likeName: 'jmc-0001' }
    const { indexed } = searchStatements(searchRankedShell(), terms)
    const plan = await planOf(indexed.sql, indexed.params)

    assert.doesNotMatch(plan, /Seq Scan on patients/)
    assert.doesNotMatch(plan, /Seq Scan on appointments/,
      `the token branch must reach appointments through an index\n${plan}`)
    assert.match(plan, /appointments_open_token_unique/,
      `and through that index specifically, or the migration is maintaining it for nothing\n${plan}`)
    assert.doesNotMatch(plan, /appointments_token_idx/,
      'and the index it replaced is gone, rather than costing a write on every arrival')
  })

  test('and a token typed in lower case finds the same arrival', async () => {
    const [{ token, patient_id: patientId }] = await rows(
      `select token, patient_id from jmc.appointments
        where status in ('waiting', 'in_consult') limit 1`)
    const { body } = await read(`patients&q=${encodeURIComponent(String(token).toLowerCase())}`)
    assert.equal(body.patients[0]?.patientId, patientId,
      'a slip is read off paper and typed in whatever case the person types in')
    assert.equal(body.patients[0].matchedOn, 'token')
  })
})

describe('the fallback is the sequential scan it is documented to be', () => {
  test('a surname in the middle of a name reads the register, and says so in the plan', async () => {
    const terms = { digits: '', trimmed: 'atient 4242', likeName: 'atient 4242' }
    const { fallback } = searchStatements(searchRankedShell(), terms)
    const plan = await planOf(fallback.sql, fallback.params)

    /*
     * This assertion is the right way round on purpose. The fallback IS a scan
     * — no btree can serve a match in the middle of a string and `pg_trgm` is
     * not installed — so the honest thing to hold is that it stays the fallback
     * rather than quietly becoming the normal path. If somebody installs the
     * extension and this starts failing, that is good news arriving as a red
     * test, and the fix is to delete this assertion and say why.
     */
    assert.match(plan, /Seq Scan on patients/,
      'if this is no longer a scan, the documentation in §11 of the frontend contract is now wrong')
  })

  test('and it is still bounded, so a scan cannot return a register', async () => {
    const { body } = await read('patients&q=atient')
    assert.ok(body.patients.length <= 25,
      `a middle-of-name match against ${VOLUME} patients came back with ${body.patients.length}`)
  })

  test('the indexed pass is the one that runs when it can', async () => {
    // A prefix that exists, so the indexed pass finds something and the
    // fallback is never reached. This is what makes the scan above a cost paid
    // only by the searches that need it.
    const { body } = await read('patients&q=Bulk Patient 4242')
    assert.ok(body.patients.length >= 1)
    assert.equal(body.patients[0].matchedOn, 'name')
  })
})

describe('no answer grows with the size of the clinic', () => {
  test('a search is capped however many patients match', async () => {
    const { body } = await read('patients&q=Bulk')
    assert.equal(body.patients.length, 25,
      'twenty thousand patients match this prefix; twenty-five come back')
  })

  test('the workload counts are counts and do not carry the rows', async () => {
    const { status, body } = await read('workload')
    assert.equal(status, 200)
    const serialized = JSON.stringify(body)
    assert.ok(serialized.length < 8_000,
      `the workload summary is ${serialized.length} bytes; it must stay a summary`)
    assert.ok(!serialized.includes('bulk-'),
      'and it must not name a single one of the twenty thousand')
  })

  /*
   * The generator's two thousand open arrivals are the material here, and they
   * are more than the cap on purpose: the assertion worth making is not that a
   * hundred rows come back when a hundred exist, it is that the count stays
   * exact when the page cannot.
   */
  test('every work list is capped, and the count is the true size', async () => {
    const open = Number(await scalar(
      `select count(*)::int from jmc.appointments where status in ('waiting', 'in_consult')`))
    assert.ok(open > 200, `the fixture must exceed the cap to test it; it has ${open}`)

    const { body } = await read('list&list=list.today_queue')
    assert.equal(body.list.rows.length, 200, 'a work list is capped at 200')
    assert.equal(body.list.count, open, 'and the count is the whole set, not the page')
    assert.equal(body.list.truncated, true, 'and it says so rather than letting a screen guess')
  })

  test('a list that fits reports that it fits', async () => {
    const { body } = await read('list&list=list.follow_ups_due')
    assert.ok(body.list.rows.length <= 200)
    assert.equal(body.list.count, body.list.rows.length)
    assert.equal(body.list.truncated, false)
  })
})

describe('one patient is read by their own id, not by reading the register', () => {
  test('the patient band does not scan the register', async () => {
    const plan = await planOf(PATIENT_READS.patientRow, ['bulk-004242'])
    assert.doesNotMatch(plan, /Seq Scan on patients/,
      'the band is fetched by primary key')
  })

  /*
   * The statements come from the module, not from this file.
   *
   * They were restated here, and the copies had already drifted: the real
   * vitals lookup behind the visit stage carries a clinic-day predicate the
   * paraphrase did not, and an extra expression in a WHERE is exactly the kind
   * of thing that changes a plan. A test that EXPLAINs its own paraphrase
   * proves the paraphrase is fast.
   */
  test('the visit stages read this patient’s rows through their indexes', async () => {
    for (const [table, sql] of [
      ['vitals', PATIENT_READS.latestVitals],
      ['vitals', PATIENT_READS.vitalsToday],
      ['encounters', PATIENT_READS.encounterToday],
      ['consultation_drafts', PATIENT_READS.latestDraft],
      ['consultation_drafts', PATIENT_READS.draftExists],
      ['encounters', PATIENT_READS.encounterTodayExists],
      /*
       * The obligation query, added after the independent review pointed out
       * it had been changed and never measured. It is the only two-table join
       * in this set and it carries an expression predicate on BOTH sides —
       * `(scheduled_at at time zone 'Asia/Kolkata')::date` on the appointment
       * and the same on the encounter — so neither `appointments_open_idx` nor
       * anything else on those columns can serve it.
       *
       * What keeps it cheap is that it is patient-scoped at both ends, and
       * both tables are indexed on `patient_id`. That is the claim, and it is
       * the claim being asserted rather than assumed: the expressions run over
       * one patient's handful of rows, never over the table.
       */
      ['appointments', PATIENT_READS.unlinkedConsultationWithOpenVisit],
    ]) {
      const plan = await planOf(sql, ['bulk-004242'])
      assert.doesNotMatch(plan, new RegExp(`Seq Scan on ${table}`),
        `${table}: a per-patient lookup must not read every row
${plan}`)
    }
  })

  test('and those tables are not empty, or the assertion above holds nothing', async () => {
    for (const table of ['vitals', 'encounters', 'consultation_drafts']) {
      const n = Number(await scalar(
        `select count(*)::int from jmc.${table} where patient_id like 'bulk-%'`))
      assert.ok(n > 100, `${table} has ${n} rows; a plan over an empty table proves nothing`)
    }
  })

  test('the band and the progress answer in a bounded number of bytes', async () => {
    const patientId = 'bulk-004242'
    for (const view of [`patient&patientId=${patientId}`, `progress&patientId=${patientId}`]) {
      const { status, body } = await read(view)
      assert.equal(status, 200, view)
      assert.ok(JSON.stringify(body).length < 4_000, `${view} must stay compact`)
    }
  })
})

describe('the indexed pass is cheaper than the scan it avoids', () => {
  /*
   * A ratio, measured in one run on one machine, rather than a threshold.
   *
   * Both plans are produced back to back against the same table with the same
   * cache, so the comparison is about how much work each one does rather than
   * how fast the disk is. Ten times is far looser than the difference actually
   * observed and is chosen to be about the shape of the work: an index lookup
   * that has become a scan cannot pass it, and a slow machine cannot fail it.
   */
  test('an indexed prefix does an order of magnitude less work than the fallback', async () => {
    const terms = { digits: '', trimmed: 'Bulk Patient 4242', likeName: 'bulk patient 4242' }
    const statements = searchStatements(searchRankedShell(), terms)

    const cost = async (statement) => {
      const plan = await planOf(statement.sql, statement.params)
      const match = plan.match(/Execution Time: ([\d.]+) ms/)
      assert.ok(match, 'EXPLAIN ANALYZE must report an execution time')
      return Number(match[1])
    }

    const indexed = await cost(statements.indexed)
    const scanned = await cost(statements.fallback)
    assert.ok(scanned > indexed * 10,
      `the indexed pass took ${indexed} ms and the scan ${scanned} ms; the index is not being used`)
  })
})
