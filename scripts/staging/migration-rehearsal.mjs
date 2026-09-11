/**
 * Rehearse the Slice 2 migrations against a clinic that already has history.
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
 * awkward history into it, applies the two Slice 2 migrations exactly the way
 * `apply-migrations.mjs` does — in a transaction — and then reads out what
 * happened to each row.
 *
 * Three of the cases here are not hypothetical shapes. They are what a
 * hand-maintained `items_json` column accumulates: an item pointing at a
 * medicine row somebody later removed, a prescription with no items at all,
 * and items written before quantity was captured as a number.
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

/** The migrations under rehearsal. Everything else builds the "before". */
const SLICE2 = [
  '20260911045325_slice2_doctor_nurse_workspaces.sql',
  '20260911120000_slice2_clinical_vocabulary.sql',
]

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
`

export async function rehearse({ url = stagingUrlFromEnv({ what: 'migration rehearsal' }) } = {}) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    // ── the clinic as it stands before Slice 2 ─────────────────────────────
    await sql.unsafe('drop schema if exists jmc cascade')
    await sql.unsafe('drop schema if exists app cascade')
    await sql.unsafe('drop schema if exists public cascade')
    await sql.unsafe('create schema public')

    await sql.begin((tx) => tx.unsafe(readFileSync(STUBS, 'utf8')))
    const earlier = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith('.sql') && !SLICE2.includes(file))
      .sort()
    for (const file of earlier) {
      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
    }
    console.log(`applied ${earlier.length} pre-Slice-2 migrations`)

    await sql.unsafe(LEGACY_CLINIC)
    await sql.unsafe(LEGACY_PRESCRIPTIONS)
    console.log('seeded 4 legacy prescriptions carrying 5 legacy items')

    // ── the migrations under rehearsal ─────────────────────────────────────
    for (const file of SLICE2) {
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
    const lines = await sql`select prescription_id,line_number,medicine_id,prescribed_quantity
      from jmc.prescription_lines order by prescription_id,line_number`
    assert.deepEqual(
      lines.map((row) => `${row.prescription_id}#${row.line_number} ${row.medicine_id} q=${row.prescribed_quantity}`),
      ['rx-1#1 m-1 q=10', 'rx-1#2 m-2 q=3', 'rx-4#1 m-1 q=1', 'rx-4#2 m-2 q=1'],
    )
    ok('a line was built for every item whose medicine still exists')

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

    // ── the vocabulary ─────────────────────────────────────────────────────
    const [{ count: phrases }] = await sql`select count(*)::int from jmc.clinical_phrases`
    const [{ count: releases }] = await sql`select count(*)::int from jmc.clinical_vocabulary_releases`
    assert.equal(phrases, 80)
    assert.equal(releases, 1)
    ok('the approved vocabulary release installed over an existing clinic')

    // ── re-application ─────────────────────────────────────────────────────
    // `supabase db push` applies each file once and wraps it in a transaction,
    // so this should never happen. docs/STAGING.md §3.1 is about what happens
    // when a migration is applied by some other route anyway.
    for (const file of SLICE2) {
      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
    }
    const [{ count: stillPhrases }] = await sql`select count(*)::int from jmc.clinical_phrases`
    const [{ count: stillLines }] = await sql`select count(*)::int from jmc.prescription_lines`
    assert.equal(stillPhrases, 80)
    assert.equal(stillLines, 4)
    ok('applying both migrations a second time changes nothing and raises nothing')

    // ── what an operator has to look at before running this for real ───────
    console.log('')
    console.log('  Reconciliation notes — check these against the clinic before deploying:')
    note('rx-2 pointed at a medicine row that no longer exists, so it got NO')
    note('     normalized line. Its items_json still holds the item. Count these')
    note('     first: select count(*) from jmc.prescriptions p, jsonb_array_elements(')
    note("     p.items_json::jsonb) i where not exists (select 1 from jmc.medicines m")
    note("     where m.id = i.value->>'medicineId');")
    note('rx-4 carried a missing quantity and a zero quantity. Both became 1,')
    note('     because prescribed_quantity is check (> 0). On a real prescription')
    note('     that is a clinical quantity the clinic did not write, and Slice 4')
    note('     will treat it as the cap on what pharmacy may hand over.')
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
