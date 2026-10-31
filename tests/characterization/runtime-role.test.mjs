/**
 * The database runtime boundary, tested as a role rather than asserted as a
 * paragraph.
 *
 * ── WHAT THIS EXISTS TO CATCH ──────────────────────────────────────────────
 *
 * Everything else in this suite connects as `postgres`, which in the staging
 * container is a superuser. A superuser bypasses row security, ignores grants
 * and never meets a permission error, so a green suite says nothing at all
 * about whether the application can actually reach its own tables once it is
 * deployed as something less privileged.
 *
 * That gap hid a real defect. Slice 2 put `force row level security` on its
 * thirteen new tables, and those tables have no policies. FORCE removes the
 * owner's exemption from row security, so an owner without the `BYPASSRLS`
 * attribute reads nothing and writes nothing — silently, with no error. The
 * clinic would have met that on the first release of Slice 2 as an empty
 * Consult screen. Slice 2.1 removes the FORCE; this file is what keeps it
 * removed.
 *
 * ── HOW IT WORKS ───────────────────────────────────────────────────────────
 *
 * It creates `jmc_runtime`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB,
 * NOCREATEROLE — and makes it own the `jmc` schema and everything in it, which
 * is how the migration-running role owns the schema in the deployed project.
 * Ownership is the whole grant: the role needs no `GRANT` of its own, and
 * nothing else is given anything.
 *
 * The application then runs in a child process against that role, because the
 * backend fixes its connection at import time and cannot be repointed inside a
 * running process. See tests/support/runtime-role-driver.mjs.
 *
 * Ownership is handed back in `finally`. If this file is killed mid-run,
 * staging is left owned by `jmc_runtime` — harmless, since `postgres` is a
 * superuser, and `npm run staging:up` rebuilds it anyway.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { STAGING_DB_URL } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar,
} from '../support/clinic.mjs'

after(async () => {
  // Ownership is handed back inside the test; this drops the login role itself
  // so a staging database is not left carrying a password-bearing account
  // between runs.
  try {
    await ownSchema('postgres')
    await rows(`drop role if exists ${RUNTIME_ROLE}`)
  } catch {
    // Already cleaned up, or the run never got far enough to create it.
  }
  await closeClinic()
})

const RUNTIME_ROLE = 'jmc_runtime'
const RUNTIME_PASSWORD = 'runtime-role-staging-only'

/** The same database, reached as the unprivileged runtime role. */
function runtimeUrl() {
  const url = new URL(STAGING_DB_URL)
  url.username = RUNTIME_ROLE
  url.password = RUNTIME_PASSWORD
  return url.toString()
}

async function createRuntimeRole() {
  await rows(`drop role if exists ${RUNTIME_ROLE}`)
  await rows(`create role ${RUNTIME_ROLE} login password '${RUNTIME_PASSWORD}'
    nosuperuser nobypassrls nocreatedb nocreaterole noinherit`)
}

/**
 * Hand `jmc` to the runtime role, or back to `postgres`.
 *
 * Ownership rather than grants: this mirrors a deployed project, where the
 * role that ran the migrations owns what they created, and it keeps the
 * privilege surface at exactly one role instead of a list of `GRANT`s that
 * drifts every time a migration adds a table.
 */
async function ownSchema(owner) {
  await rows(`
    do $$
    declare item record;
    begin
      execute format('alter schema jmc owner to %I', ${`'${owner}'`});
      for item in
        select c.relname, c.relkind from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'jmc' and c.relkind in ('r', 'v', 'S')
           -- A sequence that belongs to a column is not a thing you can hand
           -- to somebody on its own: PostgreSQL raises 0A000, "cannot change
           -- owner of sequence ... is linked to table". It does not need to
           -- be, either — ALTER TABLE ... OWNER TO carries its owned sequences
           -- with it, so skipping them here leaves them correctly owned.
           --
           -- This is filtered rather than tolerated because the alternative is
           -- an exception handler, and an exception handler here would also
           -- swallow the day a real table refuses to change hands. Slice 3A's
           -- communication_consents.sequence_no was the first identity column
           -- in jmc, and it broke this loop the moment it landed.
           and not (c.relkind = 'S' and exists (
             select 1 from pg_depend d
              where d.classid = 'pg_class'::regclass
                and d.objid = c.oid
                and d.refclassid = 'pg_class'::regclass
                and d.deptype in ('a', 'i')))
      loop
        execute format('alter %s jmc.%I owner to %I',
          case item.relkind when 'r' then 'table' when 'v' then 'view' else 'sequence' end,
          item.relname, ${`'${owner}'`});
      end loop;
      for item in
        select p.oid::regprocedure as signature from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'jmc'
      loop
        execute format('alter function %s owner to %I', item.signature, ${`'${owner}'`});
      end loop;
    end $$;
  `)
}

let staff
let medicineId

before(async () => {
  await resetClinic()
  await createRuntimeRole()

  const doctor = await makeStaff({
    name: 'Runtime Doctor', username: 'runtime-doctor', roles: ['doctor', 'admin'],
    canPublishClinicalTemplates: true,
  })
  const nurse = await makeStaff({ name: 'Runtime Nurse', username: 'runtime-nurse', roles: ['nurse'] })
  const pharmacy = await makeStaff({
    name: 'Runtime Pharmacist', username: 'runtime-pharmacy', roles: ['pharmacy'],
  })

  await as(doctor, 'add_medicine', {
    code: 'RUNTIME-PCM', name: 'Runtime Paracetamol', genericName: 'Paracetamol',
    strength: '500 mg', dosageForm: 'tablet', route: 'Oral', unit: 'tablet',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 10, targetStock: 100,
    initialQuantity: 100, batchNumber: 'RUNTIME-1', expiry: await clinicDate(400),
    mrp: 40, purchasePrice: 20, sellingPrice: 35,
  })
  medicineId = String(await scalar(`select id from jmc.medicines where code='RUNTIME-PCM'`))
  staff = { doctor, nurse, pharmacy }
})

describe('the database role the Edge Functions will actually connect as', () => {
  test('it has neither SUPERUSER nor BYPASSRLS', async () => {
    const [role] = await rows(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
         from pg_roles where rolname = $1`,
      [RUNTIME_ROLE],
    )
    assert.equal(role.rolsuper, false, 'a superuser would prove nothing: it ignores RLS entirely')
    assert.equal(role.rolbypassrls, false, 'BYPASSRLS is the attribute that hid this defect')
    assert.equal(role.rolcreatedb, false)
    assert.equal(role.rolcreaterole, false)
    assert.equal(role.rolcanlogin, true)
  })

  test('the whole clinic works through it — nurse arrival, consultation, signing, print', async () => {
    await ownSchema(RUNTIME_ROLE)
    let output
    try {
      output = execFileSync(
        process.execPath,
        ['--import', './tests/support/register.mjs', 'tests/support/runtime-role-driver.mjs'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            // The driver's own guard re-checks this; it is the same loopback
            // scratch database, reached as a different role.
            STAGING_DB_URL: runtimeUrl(),
            SUPABASE_DB_URL: runtimeUrl(),
            RUNTIME_ROLE_STAFF: JSON.stringify(staff),
            RUNTIME_ROLE_MEDICINE: medicineId,
          },
        },
      )
    } catch (error) {
      // The driver prints its JSON before exiting non-zero, so the reason for
      // a failure is in its stdout rather than in the exit code.
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    } finally {
      await ownSchema('postgres')
    }

    const line = output.split('\n').find((row) => row.startsWith('RUNTIME_ROLE_RESULT'))
    assert.ok(line, `the driver produced no result. Output was:\n${output}`)
    const result = JSON.parse(line.replace('RUNTIME_ROLE_RESULT ', ''))

    assert.equal(result.error, null, `the application failed as ${RUNTIME_ROLE}: ${result.error}`)
    assert.equal(result.ok, true)

    // The nurse's half.
    assert.ok(result.steps.nurseRegisteredPatient)
    assert.equal(result.steps.nurseAppointments, 1)
    assert.equal(result.steps.nurseVitals, 1)

    // The doctor's half, which is entirely tables Slice 2 had forced.
    assert.equal(result.steps.draftComplaint, 'Fever')
    assert.equal(result.steps.approvedPhrases, 80, 'the approved vocabulary must be readable')
    assert.equal(result.steps.templates, 1)
    assert.match(result.steps.prescriptionNumber, /^RX-[0-9]{6}$/)
    assert.equal(result.steps.signedLines, 1)
    assert.equal(result.steps.signedMedicineName, 'Runtime Paracetamol 500 mg')
    assert.equal(result.steps.followUps, 1)
    assert.equal(result.steps.printCopy, 1)
    assert.equal(result.steps.printCount, 1)
    assert.equal(result.steps.pharmacyPrescriptions, 1)
  })

  test('no table in jmc is forced, because no policy could restore a shared identity', async () => {
    // FORCE with no policy is the exact combination that returns zero rows to
    // a non-BYPASSRLS owner. Row security stays enabled everywhere; it is what
    // stops every role that is not the owner.
    assert.equal(
      await scalar(`select count(*)::int from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'jmc' and c.relforcerowsecurity`),
      0,
    )
    const [counts] = await rows(`select
        count(*) filter (where c.relrowsecurity)::int as enabled,
        count(*)::int as total
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'jmc' and c.relkind = 'r'`)
    assert.equal(counts.enabled, counts.total, 'every table keeps row security enabled')
  })

  test('the Data API roles still hold nothing at all in jmc', async () => {
    // `anon`, `authenticated` and `service_role` are how PostgREST reaches a
    // Supabase project. The clinic does not expose `jmc` through the Data API
    // and this is the assertion that says so out loud.
    for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
      assert.equal(
        await scalar(`select has_schema_privilege($1, 'jmc', 'usage')`, [role]),
        false,
        `${role} can see into the jmc schema`,
      )
    }

    const grants = await rows(
      `select table_name, grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'jmc' and grantee in ('anon','authenticated','service_role','PUBLIC')`,
    )
    assert.deepEqual(
      grants.map((row) => `${row.grantee} ${row.privilege_type} on ${row.table_name}`),
      [],
      'a Data API role holds a grant on a private clinical table',
    )

    // Spot-check the tables that carry the most sensitive rows, by privilege
    // rather than by grant listing, so an inherited privilege cannot hide.
    for (const table of [
      'patients', 'prescription_lines', 'consultation_drafts',
      'prescription_line_resolutions', 'audit_events', 'staff',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const privilege of ['select', 'insert', 'update', 'delete']) {
          assert.equal(
            await scalar(`select has_table_privilege($1, $2, $3)`, [role, `jmc.${table}`, privilege]),
            false,
            `${role} holds ${privilege} on jmc.${table}`,
          )
        }
      }
    }
  })
})
