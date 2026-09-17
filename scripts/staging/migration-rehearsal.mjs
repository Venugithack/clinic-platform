/**
 * Rehearse every migration from Slice 2 onwards against a clinic that already
 * has history.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `npm run staging:up` applies every migration to an empty database and then
 * seeds fixtures. So the two backfills in
 * `20260911045325_slice2_doctor_nurse_workspaces.sql` — assigning a number to
 * every existing prescription, and building normalized lines out of the legacy
 * `items_json` — have only ever run over zero rows, and a backfill over zero
 * rows is not evidence of anything. In the clinic they will run over two years
 * of signed prescriptions, once, with no undo.
 *
 * This builds the schema as it stands *before* Slice 2, puts deliberately
 * awkward history into it, applies every migration from Slice 2 onwards
 * exactly the way `apply-migrations.mjs` does — in a transaction — and then
 * reads out what happened to each row.
 *
 * Three of the cases here are not hypothetical shapes. They are what a
 * hand-maintained `items_json` column accumulates: an item pointing at a
 * medicine row somebody later removed, a prescription with no items at all,
 * and items written before quantity was captured as a number.
 *
 * The first version of this script recorded what Slice 2 did with those: it
 * dropped the first and turned the third into quantity 1. Slice 2.1 replaced
 * both with an explicit unknown that a doctor must resolve, and the assertions
 * below now hold it to that.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────────
 *
 * It rebuilds the staging schema from scratch, so it destroys the fixtures the
 * same way `npm run test:db` does. Run `npm run staging:up` afterwards to get
 * them back. It refuses any database the guard does not recognize as local
 * scratch, like everything else here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { stagingUrlFromEnv } from './guard.mjs'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const STUBS = join(process.cwd(), 'scripts', 'staging', 'legacy-stubs.sql')

/**
 * Where the rehearsal starts. Everything before this builds the "before".
 *
 * Every slice from 2 onwards is rehearsed, because each one builds on the
 * last: Slice 3's package tables hang off `medicines`, and Slice 4's supply
 * view reads Slice 2.1's `prescription_lines_effective`. Applying them as part
 * of the "before" would mean rehearsing them against a schema that does not
 * yet exist.
 *
 * This is a boundary rather than a list, and that is the whole point. It used
 * to be a list of seven filenames, and three migrations written afterwards —
 * `20260915`, `20260916`, `20260917` — were not added to it. They did not
 * quietly go unrehearsed: they fell into the "before" set, where
 * `20260915_financial_edge_states.sql` builds a view over `jmc.invoices`, a
 * table Slice 4 creates and the rehearsal deliberately holds back. So the
 * whole script died on `relation "jmc.invoices" does not exist` and had been
 * dead since the day the first of those three was written. A boundary cannot
 * be forgotten by the next migration the way a list can.
 */
const REHEARSED_FROM = '20260911045325_slice2_doctor_nurse_workspaces.sql'

/**
 * The ones applied once, like a real deployment, rather than twice.
 *
 * Everything else under rehearsal is applied a second time, because a backfill
 * is the thing that can run twice by accident and do damage — see the note at
 * the re-application step. A migration lands here only when Postgres genuinely
 * refuses the second application, and the reason goes beside it.
 */
const APPLY_ONCE = new Map([
  [
    '20260912000000_slice3_identity_packages_stock.sql',
    'converts money columns from real to numeric and then builds views over ' +
    'two of them; the second application asks Postgres to alter a column a ' +
    'view already depends on, which it refuses even though the conversion ' +
    'itself would be a no-op.',
  ],
])

/**
 * Every view the rehearsed set defines more than once.
 *
 * `invoice_balances` and `patient_balances` are written three times across
 * Slices 4, 20260915 and 20260916, and `financial_review_queue` twice. Each
 * rewrite widens them — `patient_balances` ends up with three more columns
 * than Slice 4 gave it — so re-applying the earlier file asks Postgres to
 * replace a wide view with a narrow one, which is "cannot drop columns from
 * view". That is not a defect in either migration; it is what supersession
 * looks like when you run the set twice.
 *
 * So the second pass drops these three first and lets the same migrations
 * rebuild them. Nothing else is dropped: the tables, the rows and every
 * backfill's work stay exactly where they are, which is the only reason the
 * second pass is worth running at all.
 *
 * Read out of the files rather than listed, so the next migration to rewrite
 * one of these views is handled without anybody remembering to come here.
 */
function supersededViews(files) {
  const seen = new Map()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const [, name] of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(jmc\.\w+)/gi)) {
      seen.set(name, (seen.get(name) ?? 0) + 1)
    }
  }
  return [...seen].filter(([, count]) => count > 1).map(([name]) => name)
}

/*
 * A reconciliation written by the clinic BETWEEN `20260922000000` and
 * `20260923000000`, which is the only interval in which one can exist in the
 * shape `20260923000000` has to upgrade: `subject_visit_closed` true, no
 * disposition column yet, and a closure event with nothing pointing back at the
 * determination that wrote it.
 *
 * Seeded here because the first draft of that migration could not upgrade a
 * single one — both tables carry `before update` triggers that raise
 * unconditionally, so its backfill would have failed on any real clinic. The
 * rehearsal was green because it had no such rows. The fourth acceptance review
 * found it, and this is what stops it being found again.
 */
const LEGACY_RECONCILIATION = `
insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
values ('a-legacy','p-1','JMC-0006','Left over','2024-02-06T09:30:00Z','done','2024-02-06T09:30:00Z');

insert into jmc.consultation_attempt_resolutions
  (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
   encounter_id, subject_visit_id, subject_visit_closed, reason, request_fingerprint)
select 'car-legacy', 'k-legacy', 'p-1', 's-doc', 'same_attendance', 'committed',
       e.id, 'a-legacy', true, 'One attendance, recorded before the upgrade', 'legacy'
  from jmc.encounters e where e.patient_id = 'p-1' order by e.created_at limit 1;

insert into jmc.appointment_events
  (id, arrival_id, event, from_status, to_status, reason, detail, actor_id)
values ('ae-legacy','a-legacy','closed_on_reconciliation','waiting','done',
        'One attendance, recorded before the upgrade','Same attendance','s-doc');
`

/*
 * And a HOLLOW one: a determination that says it closed a visit, beside a visit
 * still standing in the queue. `20260920000000` could write this; nothing since
 * can, and `20260923000000` refuses to apply while one exists.
 *
 * Seeded because the review found the recovery path unusable and the rehearsal
 * unable to notice: it printed a call to a function the migration had not
 * created yet, and the only legacy row here was already valid, so the refusal
 * and its remedy were never exercised.
 */
const HOLLOW_RECONCILIATION = `
insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
values ('a-hollow','p-1','JMC-0008','Still waiting',now(),'waiting',now());

insert into jmc.consultation_attempt_resolutions
  (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
   encounter_id, subject_visit_id, subject_visit_closed, reason, request_fingerprint)
select 'car-hollow', 'k-hollow', 'p-1', 's-doc', 'same_attendance', 'committed',
       e.id, 'a-hollow', true, 'Closed, allegedly', 'hollow'
  from jmc.encounters e where e.patient_id = 'p-1' order by e.created_at limit 1;
`

/** Rows to seed immediately before a given migration is applied. */
const SEED_BEFORE = new Map([
  ['20260923000000_a_reconciled_visit_stays_reconciled.sql', LEGACY_RECONCILIATION],
])

/** The migration whose refusal and recovery path are walked end to end. */
const HOLLOW_AT = '20260923000000_a_reconciled_visit_stays_reconciled.sql'

const ok = (label) => console.log(`  ok   ${label}`)
const note = (label) => console.log(`  note ${label}`)

/**
 * Four prescriptions in the legacy shape, chosen for what they break.
 *
 *   rx-1  two ordinary lines — the case that must simply work
 *   rx-2  an item whose medicine row is gone; the join must not invent one
 *   rx-3  no items at all
 *   rx-4  one item with no quantity and one with quantity 0, both of which
 *         the new `check (prescribed_quantity > 0)` rejects as written
 */
const LEGACY_PRESCRIPTIONS = `
insert into jmc.prescriptions (id,patient_id,encounter_id,doctor_id,items_json,signed_at) values
('rx-1','p-1','e-1','s-doc','[{"medicineId":"m-1","medicineName":"Paracetamol 500 mg","dosage":"1 tablet three times a day","instructions":"After food","quantity":10},{"medicineId":"m-2","medicineName":"Azithromycin 500 mg","dosage":"1 tablet once a day","instructions":"Finish the course","quantity":3}]','2024-02-01T10:05:00Z'),
('rx-2','p-2','e-2','s-doc','[{"medicineId":"m-gone","medicineName":"Withdrawn brand","dosage":"1-0-1","instructions":"","quantity":6}]','2024-02-02T10:05:00Z'),
('rx-3','p-1','e-3','s-doc','[]','2024-02-03T10:05:00Z'),
('rx-4','p-2','e-4','s-doc','[{"medicineId":"m-1","medicineName":"Paracetamol 500 mg","dosage":"SOS","instructions":""},{"medicineId":"m-2","medicineName":"Azithromycin 500 mg","dosage":"1-0-1","instructions":"","quantity":0}]','2024-02-04T10:05:00Z');
`

const LEGACY_CLINIC = `
insert into jmc.staff (id,name,username,roles_json,pin_hash,pin_salt,active,created_at)
values ('s-doc','Doctor','doctor','["doctor","admin"]','x','y',1,'2024-01-01T00:00:00Z');

insert into jmc.patients (id,name,age,sex,phone,created_at)
values ('p-1','Patient One',40,'female','+999700000001','2024-01-01T00:00:00Z'),
       ('p-2','Patient Two',50,'male','+999700000002','2024-01-01T00:00:00Z');

insert into jmc.medicines (id,code,name,strength,dosage_form,unit,sale_class,active,reorder_level,target_stock,created_at)
values ('m-1','PCM','Paracetamol','500 mg','tablet','tablet','otc',1,10,100,'2024-01-01T00:00:00Z'),
       ('m-2','AZI','Azithromycin','500 mg','tablet','tablet','prescription',1,10,100,'2024-01-01T00:00:00Z');

insert into jmc.encounters (id,patient_id,doctor_id,diagnosis,advice,notes,created_at)
values ('e-1','p-1','s-doc','Viral fever','Fluids','','2024-02-01T10:00:00Z'),
       ('e-2','p-2','s-doc','Chest infection','Rest','','2024-02-02T10:00:00Z'),
       ('e-3','p-1','s-doc','Review','','','2024-02-03T10:00:00Z'),
       ('e-4','p-2','s-doc','Follow up','','','2024-02-04T10:00:00Z');

-- ── the queue, as a clinic that has been open for months actually holds it ──
--
-- Slice 2 alters this table: five columns, and a unique index over the OPEN
-- rows' tokens. Applied to an empty table, every one of those is true of
-- nothing. In the clinic they run over two years of arrivals, once.
--
-- The last two share JMC-0004, which is exactly the damage migration
-- 20260909125224 declined to constrain the column for: "duplicate tokens are precisely what
-- such a database is likely to be holding". They are FINISHED, so the partial
-- unique index must tolerate them — which is the whole design claim, and it is
-- untrue of a plain unique index on the column.
insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
values ('a-1','p-1','JMC-0001','Fever','2024-02-01T09:30:00Z','done','2024-02-01T09:30:00Z'),
       ('a-2','p-2','JMC-0002','Cough','2024-02-02T09:30:00Z','done','2024-02-02T09:30:00Z'),
       ('a-3','p-1','JMC-0003','Review','2024-02-03T09:30:00Z','waiting','2024-02-03T09:30:00Z'),
       ('a-4','p-2','JMC-0004','Rash','2024-02-04T09:30:00Z','done','2024-02-04T09:30:00Z'),
       ('a-5','p-1','JMC-0004','Rash again','2024-02-05T09:30:00Z','cancelled','2024-02-05T09:30:00Z');
`

export async function rehearse({ url = stagingUrlFromEnv({ what: 'migration rehearsal' }) } = {}) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    // ── the clinic as it stands before Slice 2 ─────────────────────────────
    await sql.unsafe('drop schema if exists jmc cascade')
    await sql.unsafe('drop schema if exists app cascade')
    await sql.unsafe('drop schema if exists public cascade')
    await sql.unsafe('create schema public')

    const all = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort()
    const earlier = all.filter((file) => file < REHEARSED_FROM)
    const rehearsed = all.filter((file) => file >= REHEARSED_FROM)
    if (rehearsed[0] !== REHEARSED_FROM) {
      throw new Error(`${REHEARSED_FROM} is not in supabase/migrations — the boundary has moved.`)
    }

    await sql.begin((tx) => tx.unsafe(readFileSync(STUBS, 'utf8')))
    for (const file of earlier) {
      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
    }
    console.log(`applied ${earlier.length} pre-Slice-2 migrations`)

    await sql.unsafe(LEGACY_CLINIC)
    await sql.unsafe(LEGACY_PRESCRIPTIONS)
    console.log('seeded 4 legacy prescriptions carrying 5 legacy items, and 5 legacy arrivals')

    // ── the migrations under rehearsal ─────────────────────────────────────
    for (const file of rehearsed) {
      const seed = SEED_BEFORE.get(file)
      if (seed) {
        await sql.unsafe(seed)
        console.log(`seeded the rows ${file} has to upgrade`)
      }

      if (file === HOLLOW_AT) {
        /*
         * The refusal and its remedy, walked end to end.
         *
         * A hollow row is seeded, the migration is expected to REFUSE, the SQL
         * it prints is run exactly as printed, and the migration is applied
         * again and expected to succeed. That is the whole of the recovery
         * path, and nothing in it may reference an object this migration has
         * not created yet.
         */
        await sql.unsafe(HOLLOW_RECONCILIATION)
        let refused = ''
        await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
          .then(
            () => { throw new Error(`${file} applied over a hollow reconciliation; it must refuse.`) },
            (error) => { refused = String(error.message) },
          )
        assert.match(refused, /record a closure that the queue does not show/)

        /*
         * Cut out of the refusal, not copied beside it.
         *
         * The first version ran a duplicated constant and matched one phrase of
         * the message, so the printed text and the tested text could drift
         * apart without anything noticing — which is the whole failure this
         * check exists to prevent. What runs below is the characters the
         * migration actually printed.
         */
        const marker = 'using only what exists before this migration:'
        const from = refused.indexOf(marker)
        const to = refused.indexOf('Then apply this migration again')
        assert.ok(from > -1 && to > from, 'the refusal must print the statement that repairs it')
        const printed = refused.slice(from + marker.length, to).trim()
        assert.match(printed, /^with target as \(/, 'and it must be a statement, not prose')

        await sql.unsafe(printed)
        const [repaired] = await sql`
          select status from jmc.appointments where id = 'a-hollow'`
        assert.equal(repaired?.status, 'done', 'the printed recovery closes the visit')
        console.log('refused a hollow reconciliation, then accepted the printed recovery')
      }

      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
      console.log(`applied ${file}`)
    }
    console.log('')

    // ── numbering ──────────────────────────────────────────────────────────
    const numbers = await sql`select id,prescription_number from jmc.prescriptions order by id`
    assert.deepEqual(
      numbers.map((row) => `${row.id}=${row.prescription_number}`),
      ['rx-1=RX-000001', 'rx-2=RX-000002', 'rx-3=RX-000003', 'rx-4=RX-000004'],
    )
    ok('every prescription already in the clinic got a number, in signing order')

    const [{ count: duplicates }] = await sql`
      select count(*)::int from (
        select prescription_number from jmc.prescriptions
         group by prescription_number having count(*) > 1) d`
    assert.equal(duplicates, 0)
    ok('no two prescriptions got the same number')

    // Decision 24: sequential and never reused. A sequence left behind the
    // backfill would hand the next patient a number already on a printed slip.
    await sql.unsafe(`insert into jmc.prescriptions
      (id,patient_id,encounter_id,doctor_id,items_json,signed_at)
      values ('rx-5','p-1','e-1','s-doc','[]','2026-09-11T10:00:00Z')`)
    const [next] = await sql`select prescription_number from jmc.prescriptions where id='rx-5'`
    assert.equal(next.prescription_number, 'RX-000005')
    ok('the next prescription signed after the migration continues the run')

    // ── normalized lines ───────────────────────────────────────────────────
    // Every item gets a line now, including the one whose medicine row is gone
    // and the two the clinic never gave a quantity. Nothing is dropped and
    // nothing is defaulted.
    const lines = await sql`select prescription_id,line_number,medicine_id,prescribed_quantity,
      medicine_state,quantity_state,medicine_name_snapshot
      from jmc.prescription_lines order by prescription_id,line_number`
    assert.deepEqual(
      lines.map((row) => `${row.prescription_id}#${row.line_number} ${row.medicine_id ?? 'UNRESOLVED'}`
        + ` q=${row.prescribed_quantity ?? 'UNKNOWN'}`),
      [
        'rx-1#1 m-1 q=10',
        'rx-1#2 m-2 q=3',
        'rx-2#1 UNRESOLVED q=6',
        'rx-4#1 m-1 q=UNKNOWN',
        'rx-4#2 m-2 q=UNKNOWN',
      ],
    )
    ok('every legacy item produced a line — none was dropped')

    const [gone] = await sql`select * from jmc.prescription_lines where prescription_id='rx-2'`
    assert.equal(gone.medicine_state, 'unresolved_legacy')
    assert.equal(gone.medicine_id, null)
    // The name the prescription carried is kept, and so is its quantity: only
    // the identity is unknown.
    assert.equal(gone.medicine_name_snapshot, 'Withdrawn brand')
    assert.equal(Number(gone.prescribed_quantity), 6)
    assert.equal(gone.dosage_text, '1-0-1')
    ok('the item whose medicine is gone kept its name, directions and quantity')

    const unknowns = await sql`select quantity_state,prescribed_quantity from jmc.prescription_lines
      where prescription_id='rx-4' order by line_number`
    assert.deepEqual(unknowns.map((row) => row.quantity_state), ['unknown_legacy', 'unknown_legacy'])
    assert.deepEqual(unknowns.map((row) => row.prescribed_quantity), [null, null])
    ok('a missing quantity and a zero quantity are both Unknown, not 1')

    // The whole point: none of these may be handed over until a doctor says
    // what they were.
    const blocked = await sql`select line_number,dispensable,needs_review
      from jmc.prescription_lines_effective
      where prescription_id in ('rx-2','rx-4') order by prescription_id,line_number`
    assert.equal(blocked.every((row) => row.dispensable === false), true)
    assert.equal(blocked.every((row) => row.needs_review === true), true)
    ok('and every unresolved line is blocked from dispensing until a doctor resolves it')

    const [{ strength_snapshot: strength }] = await sql`
      select strength_snapshot from jmc.prescription_lines
       where prescription_id='rx-1' and line_number=1`
    assert.equal(strength, '500 mg')
    ok('strength and form were taken from the formulary, not parsed out of a name')

    await sql.unsafe(`update jmc.medicines set name='Renamed',strength='999 mg' where id='m-1'`)
    const [after] = await sql`select medicine_name_snapshot,strength_snapshot
      from jmc.prescription_lines where prescription_id='rx-1' and line_number=1`
    // Backfilled history keeps the name the original prescription carried,
    // which is what was printed and handed over. A newly signed line takes its
    // name from the formulary instead — the Slice 2 gate proves the browser
    // cannot supply it. Both are immune to a later rename.
    assert.equal(after.medicine_name_snapshot, 'Paracetamol 500 mg')
    assert.equal(after.strength_snapshot, '500 mg')
    ok('and renaming the medicine afterwards does not reach back into history')

    // ── the scope of a resolution ──────────────────────────────────────────
    //
    // Slice 2.1.1's trigger, over the same history. rx-1#1 is an ordinary line
    // — it named a medicine and a quantity — so nothing may be recorded
    // against it however the write arrives. rx-2#1 lost only its medicine and
    // rx-4#1 only its quantity, so each may be told the one thing it does not
    // know and not the other.
    const lineId = async (prescription, number) => {
      const [row] = await sql`select id from jmc.prescription_lines
        where prescription_id=${prescription} and line_number=${number}`
      return row.id
    }
    const resolve = (line, { medicine = null, quantity = null, action = 'amend' } = {}) =>
      sql.unsafe(
        `insert into jmc.prescription_line_resolutions
           (id,prescription_line_id,action,medicine_id,prescribed_quantity,reason,resolved_by)
         values ($1,$2,$3,$4,$5,'Rehearsal','s-doc')`,
        [`res-${Math.random().toString(36).slice(2)}`, line, action, medicine, quantity],
      )

    await assert.rejects(resolve(await lineId('rx-1', 1), { medicine: 'm-2' }), /records both/)
    await assert.rejects(resolve(await lineId('rx-1', 1), { action: 'cancel' }), /records both/)
    ok('an ordinary signed line refuses every resolution, straight at the table')

    await assert.rejects(resolve(await lineId('rx-2', 1), { quantity: 30 }), /already records the quantity/)
    await assert.rejects(resolve(await lineId('rx-4', 1), { medicine: 'm-2' }), /already records which medicine/)
    ok('and a resolution may only answer the part the line failed to record')

    await resolve(await lineId('rx-2', 1), { medicine: 'm-1' })
    const [resolved] = await sql`select effective_medicine_id,effective_quantity,dispensable
      from jmc.prescription_lines_effective where prescription_id='rx-2'`
    assert.equal(resolved.effective_medicine_id, 'm-1')
    assert.equal(Number(resolved.effective_quantity), 6)
    assert.equal(resolved.dispensable, true)
    ok('a doctor resolving the unknown part unblocks the line and keeps the signed quantity')

    await resolve(await lineId('rx-4', 2), { action: 'cancel' })
    await assert.rejects(resolve(await lineId('rx-4', 2), { quantity: 5 }), /Cancellation is final/)
    ok('nothing may follow a cancellation')

    // ── the queue Slice 2 alters ───────────────────────────────────────────
    //
    // Five columns added to a table that already has arrivals in it, and a
    // unique index over the open rows' tokens created while two FINISHED rows
    // share JMC-0004. The partial predicate is the whole reason that is
    // survivable; a plain unique index on the column would have failed here,
    // on a clinic that has been open for months, which is precisely what
    // `20260909125224` refused to risk.
    // The five that were in the queue BEFORE Slice 2 ran, which is what this
    // claim is about. `a-6` is seeded later, between `20260922000000` and
    // `20260923000000`, under a schema that already has these columns.
    const arrivals = await sql`
      select id, token, status, urgent, urgent_reason, booking_id
        from jmc.appointments where id not in ('a-legacy','a-leftover','a-hollow') order by id`
    assert.equal(arrivals.length, 5)
    assert.deepEqual(
      arrivals.map((row) => [row.urgent, row.urgent_reason, row.booking_id]),
      Array.from({ length: 5 }, () => [false, '', null]),
      'every arrival already recorded takes the default and nothing is backfilled',
    )
    ok('the queue gained its columns over arrivals that were already there')

    const [{ count: openTokenIndexes }] = await sql`
      select count(*)::int from pg_indexes
       where schemaname = 'jmc' and indexname = 'appointments_open_token_unique'`
    assert.equal(openTokenIndexes, 1)
    const [{ count: staleTokenIndexes }] = await sql`
      select count(*)::int from pg_indexes
       where schemaname = 'jmc' and indexname = 'appointments_token_idx'`
    assert.equal(staleTokenIndexes, 0)
    const [{ count: sharedToken }] = await sql`
      select count(*)::int from jmc.appointments where token = 'JMC-0004'`
    assert.equal(sharedToken, 2)
    ok('two finished visits may still share a token, and the open rows may not')

    // The other half of that claim, proved rather than argued.
    await assert.rejects(
      sql`insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
          values ('a-6','p-2','JMC-0003','Fever','2024-02-06T09:30:00Z','waiting','2024-02-06T09:30:00Z')`,
      /appointments_open_token_unique/,
    )
    ok('and a second waiting patient cannot be given a token somebody is already holding')

    // ── the Slice 2 acceptance correction ──────────────────────────────────
    //
    // `20260921000000` adds an invariant the first migration documented and
    // did not enforce, and two the command checked and the schema did not. All
    // three are asserted against a clinic that already has rows in it, because
    // that is the only version of them that matters.
    const [{ count: receiptTables }] = await sql`
      select count(*)::int from information_schema.tables
       where table_schema = 'jmc' and table_name = 'appointment_command_receipts'`
    assert.equal(receiptTables, 1)
    const [{ relrowsecurity: receiptsSecured }] = await sql`
      select relrowsecurity from pg_class
       where relnamespace = 'jmc'::regnamespace and relname = 'appointment_command_receipts'`
    assert.equal(receiptsSecured, true)
    const receiptGrants = await sql`
      select grantee from information_schema.role_table_grants
       where table_schema = 'jmc' and table_name = 'appointment_command_receipts'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`
    assert.equal(receiptGrants.length, 0)
    ok('the command receipt table landed, with row security and no Data API grant')

    await sql`
      insert into jmc.appointment_bookings
        (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by)
      values ('ab-1','p-1','s-doc', now() + interval '1 day', 15, 'Review', 'booked', 's-doc')`

    // Either flag needs a sentence.
    await assert.rejects(
      sql`update jmc.appointment_bookings set outside_availability = true where id = 'ab-1'`,
      /override_is_explained/,
    )
    await assert.rejects(
      sql`update jmc.appointment_bookings set overbooked = true where id = 'ab-1'`,
      /override_is_explained/,
    )
    // And a sentence with neither flag is refused too, so a reschedule into a
    // clear slot cannot clear the flags and leave the old reason standing.
    await assert.rejects(
      sql`update jmc.appointment_bookings set overbooked_reason = 'left over' where id = 'ab-1'`,
      /override_is_explained/,
    )
    await sql`
      update jmc.appointment_bookings
         set overbooked = true, overbooked_reason = 'Seeing both together'
       where id = 'ab-1'`
    ok('an override needs a reason whichever kind it is, and a reason needs an override')

    // A visit belongs to one patient, and the schema says so rather than
    // trusting the command to remember.
    await sql`
      insert into jmc.consultation_attempt_resolutions
        (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
         subject_visit_id, reason, request_fingerprint)
      values ('car-1','k-1','p-1','s-doc','new_attendance','not_committed','a-3','By hand','x')`
    await assert.rejects(
      sql`
        insert into jmc.consultation_attempt_resolutions
          (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
           subject_visit_id, reason, request_fingerprint)
        values ('car-2','k-2','p-2','s-doc','new_attendance','not_committed','a-3','By hand','x')`,
      /is_this_patients/,
    )
    ok('a reconciliation cannot name a visit that belongs to somebody else')

    // Owner item 72: a same attendance says what it did with the visit it
    // names, and the schema reads the visit rather than the writer's word.
    // `20260922000000`, corrected by `20260923000000`.
    await assert.rejects(
      sql`
        insert into jmc.consultation_attempt_resolutions
          (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
           encounter_id, subject_visit_id, subject_visit_closed, reason, request_fingerprint)
        values ('car-3','k-3','p-1','s-doc','same_attendance','committed',
                (select id from jmc.encounters order by created_at limit 1),
                'a-3', false, 'By hand', 'x')`,
      /closes_its_visit|disposition_follows_the_determination/,
    )
    await assert.rejects(
      sql`
        insert into jmc.consultation_attempt_resolutions
          (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
           subject_visit_id, subject_visit_closed, reason, request_fingerprint)
        values ('car-4','k-4','p-1','s-doc','new_attendance','not_committed',
                'a-3', true, 'By hand', 'x')`,
      /closes_its_visit|closed_flag_follows_disposition|consultation_attempt_resolutions_check/,
    )
    ok('a same attendance closes the visit it names, and nothing else closes one')

    // A closure is the visit being closed and an event saying who closed it,
    // not a boolean somebody set. `a-3` is `waiting`, so this claim is false
    // and the deferred trigger says so at COMMIT. `20260923000000`.
    await assert.rejects(
      sql`
        insert into jmc.consultation_attempt_resolutions
          (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
           encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
           reason, request_fingerprint)
        values ('car-5','k-5','p-1','s-doc','same_attendance','committed',
                (select id from jmc.encounters order by created_at limit 1),
                'a-3', true, 'closed_now', 'By hand', 'x')`,
      /rather than done/,
    )
    ok('a closure claimed over a visit still in the queue is refused at the table')

    // The reconciliation seeded before this migration was applied, upgraded in
    // place over append-only history. Without the scoped trigger disable in
    // section 3 the migration cannot get this far at all.
    const [legacy] = await sql`
      select subject_visit_disposition, subject_visit_closed
        from jmc.consultation_attempt_resolutions where id = 'car-legacy'`
    assert.equal(legacy?.subject_visit_disposition, 'closed_now')
    assert.equal(legacy?.subject_visit_closed, true)
    const [legacyEvent] = await sql`
      select resolution_id from jmc.appointment_events where id = 'ae-legacy'`
    assert.equal(legacyEvent?.resolution_id, 'car-legacy',
      'the closure event now names the determination that wrote it')
    const [repairedRow] = await sql`
      select subject_visit_disposition from jmc.consultation_attempt_resolutions
       where id = 'car-hollow'`
    assert.equal(repairedRow?.subject_visit_disposition, 'closed_now')
    const [repairedEvent] = await sql`
      select resolution_id from jmc.appointment_events
       where arrival_id = 'a-hollow' and event = 'closed_on_reconciliation'`
    assert.equal(repairedEvent?.resolution_id, 'car-hollow',
      'and the event the recovery wrote is matched to its determination by the backfill')
    ok('a reconciliation written before this migration is upgraded in place')

    /*
     * And owner item 72's closure survives the queue: a visit reconciled as
     * the same attendance cannot come back to be consulted and charged again.
     *
     * Written through `jmc.close_visit_for_reconciliation`, because that is now
     * the only thing that may close a visit this way or write the event saying
     * so. Nothing here forges a closure, because nothing can.
     */
    await sql.unsafe(`
      insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at)
      values ('a-leftover','p-2','JMC-0007','Left over',now(),'waiting',now());

      insert into jmc.consultation_attempt_resolutions
        (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
         encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
         reason, request_fingerprint)
      select 'car-6','k-6','p-2','s-doc','same_attendance','committed',
             e.id, 'a-leftover', true, 'closed_now', 'One attendance', 'x'
        from jmc.encounters e where e.patient_id = 'p-2' order by e.created_at limit 1;

      select jmc.close_visit_for_reconciliation('car-6');
    `)
    const [closed] = await sql`
      select a.status, e.from_status, e.to_status, e.resolution_id
        from jmc.appointments a
        join jmc.appointment_events e on e.arrival_id = a.id and e.event = 'closed_on_reconciliation'
       where a.id = 'a-leftover'`
    assert.deepEqual(
      [closed?.status, closed?.from_status, closed?.to_status, closed?.resolution_id],
      ['done', 'waiting', 'done', 'car-6'],
      'the function performed the transition and recorded the one that happened',
    )
    await assert.rejects(
      sql`update jmc.appointments set status='waiting' where id='a-leftover'`,
      /recorded as the same attendance/,
    )
    await assert.rejects(
      sql`update jmc.appointments set status='cancelled' where id='a-leftover'`,
      /stays closed/,
    )
    ok('a reconciled visit cannot be put back into the queue')

    // ── the vocabulary ─────────────────────────────────────────────────────
    const [{ count: phrases }] = await sql`select count(*)::int from jmc.clinical_phrases`
    const [{ count: releases }] = await sql`select count(*)::int from jmc.clinical_vocabulary_releases`
    assert.equal(phrases, 80)
    assert.equal(releases, 1)
    ok('the approved vocabulary release installed over an existing clinic')

    /*
     * ── re-application ─────────────────────────────────────────────────────
     *
     * `supabase db push` applies each file once and wraps it in a transaction,
     * so this should never happen. docs/operations/STAGING.md §3.1 is about what happens
     * when a migration is applied by some other route anyway.
     *
     * What is re-applied is everything under rehearsal except the files named
     * in APPLY_ONCE, which is what this rehearsal is for: every backfill must
     * be safe to run twice over rows it has already processed.
     *
     * The exclusion is deliberate and worth stating rather than leaving as an
     * omission. Slice 3 converts every money column from `real` to `numeric`
     * and then, later in the same file, creates views over two of those
     * columns. Re-applying it asks Postgres to alter a column a view already
     * depends on, which it refuses — "cannot alter type of a column used by a
     * view or rule" — even though the conversion itself would be a no-op.
     * Slice 4 likewise empties `jmc.bills` rather than dropping it precisely so
     * that Slice 3's conversion is not left naming a relation that has gone.
     *
     * So: a migration that changes a column type and then builds on it is
     * applied once, like every migration in a real deployment. Everything else
     * is applied twice here, because a backfill is the thing that can run twice
     * by accident and do damage — and because defaulting to "twice" is what
     * stops a new migration from being left out of this step by silence.
     */
    const superseded = supersededViews(rehearsed)
    for (const view of superseded) {
      await sql.unsafe(`drop view if exists ${view} cascade`)
    }
    const reapplied = rehearsed.filter((file) => !APPLY_ONCE.has(file))
    for (const file of reapplied) {
      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
    }
    /*
     * Rebuilt, and rebuilt to the LAST definition rather than the first.
     *
     * Existence alone would pass if the second pass had stopped at Slice 4's
     * narrower view, which is the failure this whole step risks introducing.
     * `void_with_balance_invoices` exists only in 20260916's `patient_balances`
     * (owner policy item 61), so asking for it by name is asking whether the
     * set converged. And `drop view` takes the view's grants with it, so the
     * revoke that keeps the private schema out of the Data API is checked too:
     * a rehearsal that silently left three views readable by `anon` would be
     * worse than no rehearsal.
     */
    for (const view of superseded) {
      const [{ count: present }] = await sql`
        select count(*)::int from pg_views
         where schemaname = 'jmc' and viewname = ${view.replace('jmc.', '')}`
      assert.equal(present, 1, `${view} was not rebuilt by the second application`)

      const [{ count: exposed }] = await sql`
        select count(*)::int from information_schema.role_table_grants
         where table_schema = 'jmc' and table_name = ${view.replace('jmc.', '')}
           and grantee in ('public', 'anon', 'authenticated', 'service_role')`
      assert.equal(exposed, 0, `${view} came back with grants the harden migration revokes`)
    }
    const [{ count: convergedColumns }] = await sql`
      select count(*)::int from information_schema.columns
       where table_schema = 'jmc' and table_name = 'patient_balances'
         and column_name = 'void_with_balance_invoices'`
    assert.equal(convergedColumns, 1,
      'the rebuilt patient_balances is Slice 4’s, not 20260916’s — the set did not converge')
    const [{ count: stillPhrases }] = await sql`select count(*)::int from jmc.clinical_phrases`
    const [{ count: stillLines }] = await sql`select count(*)::int from jmc.prescription_lines`
    const [{ count: stillResolutions }] =
      await sql`select count(*)::int from jmc.prescription_line_resolutions`
    assert.equal(stillPhrases, 80)
    assert.equal(stillLines, 5)
    // Slice 2.1.1 ends with an assertion that no existing resolution falls
    // outside the scope it enforces. Re-applying it over the two just written
    // is what proves that assertion passes on real rows rather than on none.
    assert.equal(stillResolutions, 2)
    ok('applying the migrations a second time changes nothing and raises nothing')

    // ── what an operator has to look at before running this for real ───────
    //
    // These are no longer defects to warn about — Slice 2.1 records both cases
    // honestly — but they are still work the clinic has to do, and it is work
    // only a doctor can do. Counting it before deploying is how the clinic
    // learns whether that is an afternoon or a fortnight.
    const [{ count: unresolvedMedicines }] = await sql`
      select count(*)::int from jmc.prescription_lines where medicine_state = 'unresolved_legacy'`
    const [{ count: unknownQuantities }] = await sql`
      select count(*)::int from jmc.prescription_lines where quantity_state = 'unknown_legacy'`

    console.log('')
    console.log('  Doctor review queue this migration would create:')
    note(`${unresolvedMedicines} line(s) name a medicine that is not in the formulary.`)
    note(`${unknownQuantities} line(s) have no recorded quantity.`)
    note('Both are blocked from dispensing until a doctor records a resolution.')
    note('Count them against the real clinic rows before deploying:')
    note('  select medicine_state, quantity_state, count(*) from jmc.prescription_lines')
    note('   group by 1,2;')
    console.log('')
    console.log('rehearsal complete — run "npm run staging:up" to restore the fixtures')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1]?.endsWith('migration-rehearsal.mjs')) {
  rehearse().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
