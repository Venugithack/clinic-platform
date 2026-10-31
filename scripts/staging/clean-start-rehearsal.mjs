/**
 * Rehearse launch night's database half, start to finish, against scratch:
 * the clinic as it stands, the clean start, then the twenty-one migrations.
 *
 * `scripts/launch/clean-start.mjs` runs once, against the clinic, with no
 * undo but the backup. This is the only place it runs before that. It builds
 * exactly what the clinic has (the nine migrations it has applied, and the
 * migration ledger `supabase db push` keeps), puts a row in every one of the
 * 26 tables the script empties, then holds the script to its word:
 *
 *   - the dry run reports every row and changes none;
 *   - a commit with the wrong total is refused and changes none;
 *   - the commit empties all 26, keeps the two single-row tables and the
 *     beds (each made empty and available, since the app cannot create one),
 *     puts the numbering back to 1, and clears the two references a kept
 *     table holds into an emptied one;
 *   - the twenty-one migrations then apply over the empty clinic, their seeds
 *     arrive, every new document number starts at 1, the consultation fee
 *     becomes ₹300, and `staff` is empty, which is what lets the doctor
 *     create the first administrator on the lock screen;
 *   - once the ledger shows the update, the script refuses for good.
 *
 * It rebuilds the staging schema from scratch, like `npm run staging:rehearse`.
 * Run `npm run staging:up` afterwards to get the fixtures back. It refuses any
 * database the guard does not recognise as local scratch.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { stagingUrlFromEnv } from './guard.mjs'
import { assertSchemaLanded } from './apply-migrations.mjs'
import { CLEARED, LIVE_MIGRATIONS, Refused, SEQUENCES, cleanStart, describe } from '../launch/clean-start.mjs'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const STUBS = join(process.cwd(), 'scripts', 'staging', 'legacy-stubs.sql')

/** A row in every table the clean start empties, foreign keys and all, and two beds. */
const TEST_CLINIC = `
insert into jmc.staff (id,name,username,roles_json,pin_hash,pin_salt,active,created_at) values
  ('s-1','Test Doctor','testdoctor','["doctor","admin"]','x','y',1,'2026-09-10T04:00:00Z'),
  ('s-2','Test Nurse','testnurse','["nurse"]','x','y',1,'2026-09-10T04:00:00Z'),
  ('s-3','Test Pharmacy','testpharmacy','["pharmacy"]','x','y',1,'2026-09-10T04:00:00Z'),
  ('s-4','Test Admin','testadmin','["admin"]','x','y',1,'2026-09-10T04:00:00Z');
insert into jmc.pin_attempts (id,staff_id,caller,failed_at) values ('pa-1','s-2','tablet','2026-09-10T04:01:00Z');
insert into jmc.sessions (token_hash,staff_id,created_at,last_seen,expires_at)
  values ('h-1','s-1','2026-09-10T04:00:00Z','2026-09-10T04:00:00Z','2026-09-10T16:00:00Z');
insert into jmc.patients (id,name,age,sex,phone,created_at) values
  ('p-1','Test Patient One',40,'female','+999700000001','2026-09-10T04:00:00Z'),
  ('p-2','Test Patient Two',50,'male','+999700000002','2026-09-10T04:00:00Z');
insert into jmc.appointments (id,patient_id,token,reason,scheduled_at,status,created_at) values
  ('a-1','p-1','JMC-0001','Fever','2026-09-10T04:00:00Z','done','2026-09-10T04:00:00Z'),
  ('a-2','p-2','JMC-0002','Cough','2026-09-10T04:05:00Z','done','2026-09-10T04:05:00Z'),
  ('a-3','p-1','JMC-0003','Review','2026-09-10T04:10:00Z','cancelled','2026-09-10T04:10:00Z');
insert into jmc.vitals (id,patient_id,bp,temperature,pulse,spo2,weight,recorded_by,recorded_at)
  values ('v-1','p-1','120/80',98.6,80,98,60,'s-2','2026-09-10T04:02:00Z');
insert into jmc.encounters (id,patient_id,doctor_id,appointment_id,diagnosis,notes,advice,created_at) values
  ('e-1','p-1','s-1','a-1','Test','','','2026-09-10T04:03:00Z'),
  ('e-2','p-2','s-1','a-2','Test','','','2026-09-10T04:06:00Z');
insert into jmc.prescriptions (id,patient_id,encounter_id,doctor_id,items_json,signed_at) values
  ('rx-1','p-1','e-1','s-1','[{"medicineId":"m-1","quantity":"10"}]','2026-09-10T04:04:00Z'),
  ('rx-2','p-2','e-2','s-1','[{"medicineId":"m-2","quantity":"6"}]','2026-09-10T04:07:00Z');
insert into jmc.bills (id,patient_id,label,amount,status,created_at) values
  ('b-1','p-1','Consultation',300,'unpaid','2026-09-10T04:04:00Z'),
  ('b-2','p-2','Consultation',400,'unpaid','2026-09-10T04:07:00Z');
insert into jmc.beds (id,label,status,patient_id,admitted_at,notes) values
  ('bed_1','Bed 1','occupied','p-1','2026-09-10T04:08:00Z','Test observation'),
  ('bed_2','Bed 2','cleaning',null,null,'');
insert into jmc.suppliers (id,code,name,created_at) values ('sup-1','TST','Test Supplier','2026-09-10T04:00:00Z');
insert into jmc.medicines (id,code,name,unit,sale_class,reorder_level,target_stock,preferred_supplier_id,created_at,schedule) values
  ('m-1','PCM','Paracetamol','tablet','otc',10,100,'sup-1','2026-09-10T04:00:00Z','OTC'),
  ('m-2','CET','Cetirizine','tablet','otc',10,100,'sup-1','2026-09-10T04:00:00Z','OTC');
insert into jmc.supplier_medicines (supplier_id,medicine_id) values ('sup-1','m-1');
insert into jmc.batches (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,received_from_supplier_id,received_at) values
  ('bt-1','m-1','B1','2028-01-01',90,2,1,2,'sup-1','2026-09-10T04:00:00Z'),
  ('bt-2','m-2','B2','2028-01-01',44,3,1.5,3,'sup-1','2026-09-10T04:00:00Z');
insert into jmc.stock_movements (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at) values
  ('sm-1','m-1','bt-1','receipt',100,'manual','r-1','s-3','2026-09-10T04:00:00Z'),
  ('sm-2','m-1','bt-1','sale',-10,'otc_sale','o-1','s-3','2026-09-10T04:09:00Z');
insert into jmc.otc_sales (id,receipt_number,total,payment_method,lines_json,created_by,created_at)
  values ('o-1','OTC-000003',20,'cash','[]','s-3','2026-09-10T04:09:00Z');
insert into jmc.purchase_orders (id,order_number,supplier_id,status,requested_date,message_draft,created_by,created_at)
  values ('po-1','PO-0001','sup-1','pending','2026-09-11','','s-4','2026-09-10T04:00:00Z');
insert into jmc.purchase_order_lines (id,order_id,medicine_id,ordered_quantity) values ('pol-1','po-1','m-1',100);
insert into jmc.whatsapp_messages (id,direction,audience,phone,body,status,created_at)
  values ('w-1','outbound','supplier','+999700000009','Test','queued','2026-09-10T04:00:00Z');
insert into jmc.csv_imports (id,file_hash,row_count,actor_id,created_at) values ('c-1','hash',2,'s-4','2026-09-10T04:00:00Z');
insert into jmc.audit_events (id,actor_id,action,entity_type,entity_id,summary,created_at)
  values ('ae-1','s-4','staff.created','staff','s-2','Test','2026-09-10T04:00:00Z');
insert into jmc.stock_writeoffs (id,batch_id,medicine_id,quantity,reason,cost_value,actor_id,created_at)
  values ('wo-1','bt-2','m-2',1,'damage',1.5,'s-3','2026-09-10T04:00:00Z');
insert into jmc.supplier_returns (id,note_number,supplier_id,batch_id,medicine_id,quantity,expected_credit,status,actor_id,created_at)
  values ('sr-1','RET-0001','sup-1','bt-2','m-2',5,7.5,'sent','s-3','2026-09-10T04:00:00Z');
insert into jmc.till_sessions (id,opened_at,opened_by,opening_float) values ('t-1','2026-09-10T03:30:00Z','s-3',500);
insert into jmc.cash_movements (id,till_id,direction,amount,reason,actor_id,created_at)
  values ('cm-1','t-1','out',50,'Test','s-3','2026-09-10T04:00:00Z');
insert into jmc.stock_takes (id,reference,scope,status,started_at,started_by)
  values ('st-1','ST-0001','partial','counting','2026-09-10T04:00:00Z','s-3');
insert into jmc.stock_take_lines (id,stock_take_id,batch_id,medicine_id,expected_quantity,counted_quantity,variance,variance_value,counted_by,counted_at)
  values ('stl-1','st-1','bt-1','m-1',90,90,0,0,'s-3','2026-09-10T04:00:00Z');

-- The one foreign key from a kept table into an emptied one.
update jmc.clinic_settings set updated_by = 's-4', name = 'Jayamurugan Clinic' where id = 1;

-- Numbers the test period used, so the reset has something to undo.
select setval('jmc.appointment_token_seq', 3);
select setval('jmc.otc_receipt_seq', 3);
select setval('jmc.purchase_order_seq', 1);
select setval('jmc.supplier_return_seq', 1);
select setval('jmc.stock_take_seq', 1);
`

/**
 * The tables the twenty-one migrations fill by themselves, over an empty
 * clinic. Everything else must arrive empty. Discovered by running this, and
 * written down so a migration that starts seeding something new is noticed.
 */
const SEEDED_BY_MIGRATIONS = new Set([
  // Kept by the clean start, not seeded: but they are rows, and they are expected.
  'beds',
  'clinic_revision',
  'clinic_settings',
  // The owner-approved starter phrases, release en-2026.09
  // (20260911120000_slice2_clinical_vocabulary.sql). Wanted in a new clinic.
  'clinical_phrases',
  'clinical_vocabulary_releases',
])

/** Where each document number stands, read without moving it. */
async function numbering(sql) {
  const out = {}
  for (const name of SEQUENCES) {
    const [row] = await sql.unsafe(`select last_value::int as last_value, is_called from jmc.${name}`)
    out[name] = `${row.last_value}/${row.is_called}`
  }
  return out
}

async function counts(sql, tables) {
  const out = {}
  for (const table of tables) {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from jmc.${table}`)
    out[table] = Number(n)
  }
  return out
}

export async function rehearseCleanStart({ url = stagingUrlFromEnv({ what: 'clean-start rehearsal' }) } = {}) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    // ── the clinic as it stands on 31 October 2026 ────────────────────────
    for (const schema of ['jmc', 'app', 'public', 'supabase_migrations']) {
      await sql.unsafe(`drop schema if exists ${schema} cascade`)
    }
    await sql.unsafe('create schema public')

    const all = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort()
    const live = all.filter((file) => LIVE_MIGRATIONS.includes(file.slice(0, 14)))
    const pending = all.filter((file) => file.slice(0, 14) > LIVE_MIGRATIONS.at(-1))
    assert.equal(live.length, 9, 'the nine live migrations are all in supabase/migrations')
    assert.equal(live.length + pending.length, all.length, 'no migration sits between the live nine')

    await sql.begin((tx) => tx.unsafe(readFileSync(STUBS, 'utf8')))
    for (const file of live) await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))

    // What `supabase db push` keeps. The real one has more columns; the
    // script reads only `version`.
    await sql.unsafe(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, name text)`)
    for (const file of live) {
      await sql`insert into supabase_migrations.schema_migrations (version, name)
                values (${file.slice(0, 14)}, ${file.slice(15, -4)})`
    }

    await sql.begin((tx) => tx.unsafe(TEST_CLINIC))
    const before = await counts(sql, CLEARED)
    const empty = CLEARED.filter((table) => before[table] === 0)
    assert.deepEqual(empty, [], 'the test clinic has a row in every table the clean start empties')
    const total = Object.values(before).reduce((sum, n) => sum + n, 0)
    const numbersBefore = await numbering(sql)
    const [{ revision: revisionBefore }] = await sql`select revision::int from jmc.clinic_revision where id = 1`
    console.log(`built the clinic's nine migrations and ${total} test rows across all ${CLEARED.length} tables`)

    // ── the dry run ───────────────────────────────────────────────────────
    // "Changed nothing" covers the numbering too. Sequences are the one place
    // a rollback does not reach by default (setval and nextval survive it),
    // and the first draft of the script reset them on every dry run.
    const unchanged = async (what) => {
      assert.deepEqual(await counts(sql, CLEARED), before, `${what}: no row changed`)
      assert.deepEqual(await numbering(sql), numbersBefore, `${what}: the numbering did not move`)
      const [{ revision }] = await sql`select revision::int from jmc.clinic_revision where id = 1`
      assert.equal(revision, revisionBefore, `${what}: the revision did not move`)
    }
    const dry = await cleanStart(sql)
    assert.equal(dry.committed, false)
    assert.equal(dry.total, total, 'the dry run counts every row')
    assert.deepEqual(dry.removed, before)
    assert.equal(dry.sequences.otc_receipt_seq, 3, 'the dry run reports the last receipt number used')
    await unchanged('the dry run')
    console.log('dry run: reported every row, changed no row, number or revision')

    // ── the wrong total ───────────────────────────────────────────────────
    await assert.rejects(cleanStart(sql, { commit: String(total - 1) }), Refused)
    await unchanged('a refused commit')
    console.log('commit with the wrong total: refused, changed nothing')

    // ── a clinic in use ───────────────────────────────────────────────────
    await sql.begin(async (tx) => {
      for (let i = 0; i < 20; i++) {
        await tx`insert into jmc.patients (id,name,age,sex,phone,created_at)
                 values (${`p-busy-${i}`}, 'Busy', 30, 'other', '+999700000100', '2026-10-01T04:00:00Z')`
      }
    })
    await assert.rejects(cleanStart(sql, { commit: String(total + 20) }), /clinic in use/)
    await sql`delete from jmc.patients where id like 'p-busy-%'`
    console.log('more than 20 patients: refused')

    // ── the clean start ───────────────────────────────────────────────────
    const done = await cleanStart(sql, { commit: String(total) })
    assert.equal(done.committed, true)
    console.log('\n' + describe(done).split('\n').map((line) => `  | ${line}`).join('\n') + '\n')

    const after = await counts(sql, CLEARED)
    assert.ok(Object.values(after).every((n) => n === 0), 'every one of the 26 tables is empty')
    const beds = await sql`select id, status, patient_id, admitted_at, notes from jmc.beds order by id`
    assert.deepEqual(
      beds.map((b) => [b.id, b.status, b.patient_id, b.admitted_at, b.notes]),
      [['bed_1', 'available', null, null, ''], ['bed_2', 'available', null, null, '']],
      'both beds are kept, empty and available',
    )
    assert.deepEqual(done.beds, ['Bed 1', 'Bed 2'], 'the report names the beds it kept')
    const [settings] = await sql`select name, updated_by from jmc.clinic_settings where id = 1`
    assert.equal(settings.name, 'Jayamurugan Clinic', 'the clinic details are kept')
    assert.equal(settings.updated_by, null)
    const [{ revision }] = await sql`select revision::int from jmc.clinic_revision where id = 1`
    assert.ok(revision > 0, 'the revision moved forward, so an open tablet refetches')
    for (const name of SEQUENCES) {
      const [{ n }] = await sql.unsafe(`select nextval('jmc.${name}')::int as n`)
      assert.equal(n, 1, `${name} hands out 1 next`)
      await sql.unsafe(`select setval('jmc.${name}', 1, false)`)
    }
    console.log('clean start: 26 tables empty, details and beds kept, numbering at 1')

    // ── the update, over the empty clinic ─────────────────────────────────
    for (const file of pending) {
      await sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')))
      await sql`insert into supabase_migrations.schema_migrations (version, name)
                values (${file.slice(0, 14)}, ${file.slice(15, -4)})`
    }
    await assertSchemaLanded(sql)
    console.log(`applied the ${pending.length} pending migrations over the empty clinic`)

    const tables = (await sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'jmc' and c.relkind in ('r', 'p') order by 1`).map((row) => row.relname)
    const filled = Object.entries(await counts(sql, tables)).filter(([, n]) => n > 0).map(([t]) => t)
    const unexpected = filled.filter((t) => !SEEDED_BY_MIGRATIONS.has(t))
    console.log(`  tables holding rows after the update: ${filled.join(', ')}`)
    assert.deepEqual(unexpected, [], 'nothing but the migrations\' own seeds arrives in an empty clinic')

    const [{ n: staff }] = await sql`select count(*)::int as n from jmc.staff`
    assert.equal(staff, 0, 'staff is empty, so the lock screen offers to create the first administrator')
    const [{ fee }] = await sql`select consultation_fee::text as fee from jmc.clinic_settings where id = 1`
    assert.equal(Number(fee), 300, 'the consultation fee arrives at ₹300 where none was set')

    const sequences = (await sql`
      select sequencename from pg_sequences where schemaname = 'jmc' order by 1`).map((row) => row.sequencename)
    for (const name of sequences) {
      const [{ n }] = await sql.unsafe(`select nextval('jmc.${name}')::bigint::int as n`)
      assert.equal(n, 1, `jmc.${name} starts at 1 in the clinic's first day`)
    }
    console.log(`every one of the ${sequences.length} jmc sequences starts at 1`)

    // ── and never again ───────────────────────────────────────────────────
    await assert.rejects(cleanStart(sql), /only runs before the update/)
    console.log('after the update: the clean start refuses')

    console.log('\nclean-start rehearsal passed. Run "npm run staging:up" to get the fixtures back.')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1]?.endsWith('clean-start-rehearsal.mjs')) {
  rehearseCleanStart().catch((error) => {
    console.error(`\n${error.stack ?? error.message}\n`)
    process.exit(1)
  })
}
