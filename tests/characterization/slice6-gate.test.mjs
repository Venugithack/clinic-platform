/**
 * Slice 6's exit gate: the reports, and the security posture underneath them.
 *
 * Two halves, and the second is the one that matters most.
 *
 * The reports have to be DERIVED. Not one of them may read a cached total or a
 * status column, because a report that agrees with the screen only because both
 * read the same stale number cannot be used to check the screen. So each is run
 * against a clinic whose history this file builds through the real commands,
 * and the figures are compared with what actually happened.
 *
 * The hardening has to be MEASURED rather than described. `docs/SCHEMA_AND_TYPES.md`
 * §7 says plainly that staff authorization lives in the Edge Function boundary
 * and that grants and RLS are what stop everybody else. This file holds that to
 * it: no Data API role reaches `jmc`, no view silently bypasses the caller's
 * own privileges, every foreign key has an index, and the runtime role needs no
 * DDL to run a clinic day.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { edgeGet } from '../support/backend.mjs'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** A clinic with a day of real history behind it. */
let clinic

before(async () => {
  await resetClinic()

  const admin = await makeStaff({ name: 'Owner', username: 's6-admin', roles: ['admin'], pin: '4829' })
  const doctor = await makeStaff({ name: 'Doctor', username: 's6-doc', roles: ['doctor'], pin: '5731' })
  const nurse = await makeStaff({ name: 'Nurse', username: 's6-nurse', roles: ['nurse'], pin: '6182' })
  const pharmacy = await makeStaff({ name: 'Pharmacist', username: 's6-pharm', roles: ['pharmacy'], pin: '7048' })

  await as(admin, 'add_supplier', {
    code: 'SUP1', name: 'Chennai Distributors', whatsapp: '+919000000001', phone: '+919000000001',
  })
  const supplierId = String(await scalar(`select id from jmc.suppliers where code='SUP1'`))

  await as(pharmacy, 'add_medicine', {
    code: 'PCM500', name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 1000,
    initialQuantity: 300, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='PCM500'`))

  // A package, verified, so the package audit has something to audit.
  const pack = await as(pharmacy, 'save_package_version', {
    medicineId, baseUnit: 'tablet',
    levels: [
      { levelName: 'tablet', levelType: 'tablet', sellable: true },
      { levelName: 'strip', levelType: 'strip', contains: 'tablet', containsCount: 15, sellable: true, mrpBasis: true },
    ],
  })
  await as(pharmacy, 'verify_package_version', {
    packageVersionId: pack.data.packageVersionId, verificationSource: 'physical_pack',
  })

  // A delivery.
  await as(pharmacy, 'post_goods_receipt', {
    idempotencyKey: randomUUID(), supplierId, supplierInvoiceNumber: 'INV-2026-1',
    lines: [{
      medicineId, entry: [{ levelName: 'strip', count: 4 }],
      batchNumber: 'PCM-B', expiry: await clinicDate(500),
      mrp: 30, mrpBasisLevel: 'strip', purchasePrice: 18, purchaseBasisLevel: 'strip',
    }],
  })

  // A visit: fee, prescription, partial hand-over, part payment.
  await as(doctor, 'create_patient', { name: 'Report Patient', age: 40, sex: 'female', phone: '+919000000501' })
  const patientId = String(await scalar(`select id from jmc.patients where name='Report Patient'`))
  await as(doctor, 'sign_consultation', {
    patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
    diagnosisStatus: 'provisional', followUpDate: await clinicDate(7),
    prescriptionItems: [{ medicineId, instructions: 'After food', quantity: 20 }],
  })
  const prescriptionId = String(await scalar('select id from jmc.prescriptions limit 1'))
  const lineId = String(await scalar('select id from jmc.prescription_lines limit 1'))

  await as(pharmacy, 'dispense_rx', {
    prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 8 }],
  })
  const invoiceId = String(await scalar('select id from jmc.invoices limit 1'))
  await as(pharmacy, 'take_payment', {
    invoiceId, parts: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 100 }],
  })

  // An anonymous counter sale, fully paid.
  await as(pharmacy, 'otc_sale', {
    lines: [{ medicineId, quantity: 5 }], parts: [{ method: 'card', amount: 150 }],
  })

  clinic = { admin, doctor, nurse, pharmacy, patientId, medicineId, invoiceId, supplierId }
})

const read = async (staff, report, days) =>
  edgeGet('reports', `?report=${report}${days === undefined ? '' : `&days=${days}`}`, await tokenFor(staff))

// ═══════════════════════════════════════════════════════════════════════════

describe('the reports say what actually happened', () => {
  test('stock on hand is the ledger, not a remembered number', async () => {
    const { body } = await read(clinic.admin, 'stock_on_hand')
    const [row] = body.rows
    assert.equal(row.code, 'PCM500')

    // 300 opening + 60 received - 8 dispensed - 5 sold.
    assert.equal(Number(row.sellable_base_quantity), 347)
    assert.equal(
      Number(row.sellable_base_quantity),
      Number(await scalar('select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements')),
      'the report and the ledger are the same arithmetic',
    )
    assert.equal(row.base_unit, 'tablet')

    /*
     * Two batches at two different costs, which is the point.
     *
     * The opening batch was priced per tablet: 287 left at ₹18 is ₹5,166. The
     * delivery was invoiced at ₹18 per STRIP of fifteen, which is ₹1.20 a
     * tablet: 60 at ₹1.20 is ₹72. A valuation that ignored the price basis
     * would read ₹1,080 for that batch and be out by an order of magnitude —
     * which is exactly the ambiguity Slice 3 removed by storing a price with
     * the package it applies to.
     */
    assert.equal(row.cost_value, '5238.00')
  })

  test('every movement is on the movement report, with who did it', async () => {
    const { body } = await read(clinic.pharmacy, 'stock_movements', 30)
    const types = body.rows.map((row) => row.movement_type)
    assert.ok(types.includes('opening_stock'))
    assert.ok(types.includes('goods_receipt'))
    assert.ok(types.includes('prescription'))
    assert.ok(types.includes('otc_sale'))
    assert.ok(body.rows.every((row) => typeof row.actor === 'string' && row.actor.length > 0))
  })

  test('the money reports reconcile with the bills and with each other', async () => {
    const sales = await read(clinic.admin, 'sales', 30)
    const byLine = Object.fromEntries(sales.body.byLine.map((row) => [row.source, row.amount]))
    assert.equal(byLine.consultation_fee, '300.00')
    assert.equal(byLine.prescription, '240.00', '8 tablets at ₹30')
    assert.equal(byLine.otc, '150.00', '5 tablets at ₹30')

    const payments = await read(clinic.admin, 'payments', 30)
    const byMethod = Object.fromEntries(
      payments.body.byMethod.map((row) => [`${row.method}:${row.kind}`, row.amount]),
    )
    assert.equal(byMethod['cash:payment'], '200.00')
    assert.equal(byMethod['upi:payment'], '100.00')
    assert.equal(byMethod['card:payment'], '150.00')

    // A split is reported as a split, which is what the day book has to
    // reconcile against.
    assert.equal(payments.body.splits.length, 1)
    assert.equal(payments.body.splits[0].used.split(' + ').length, 2)

    const billed = Number(byLine.consultation_fee) + Number(byLine.prescription) + Number(byLine.otc)
    const taken = Object.values(byMethod).reduce((total, amount) => total + Number(amount), 0)
    const dues = await read(clinic.admin, 'patient_dues')
    const owed = dues.body.rows.reduce((total, row) => total + Number(row.outstanding), 0)
    assert.equal(billed - taken, owed, 'billed minus taken is exactly what is owed')
  })

  test('an outstanding prescription is reported with what is left of it', async () => {
    const { body } = await read(clinic.doctor, 'outstanding_prescriptions')
    assert.equal(body.rows.length, 1)
    assert.equal(Number(body.rows[0].prescribed), 20)
    assert.equal(Number(body.rows[0].supplied), 8)
    assert.equal(Number(body.rows[0].remaining), 12)
    assert.equal(body.rows[0].supply_state, 'part_supplied')
    assert.equal(body.rows[0].expired, false)
  })

  test('the package audit names what has not been done yet', async () => {
    const { body } = await read(clinic.pharmacy, 'package_audit')
    assert.equal(body.rows[0].verification_source, 'physical_pack')
    assert.equal(body.rows[0].ladder, 'tablet=1, strip=15')
    assert.equal(Number(body.rows[0].batches), 1, 'the delivery arrived under it')

    // The setup work the clinic still owes: this product is classified and
    // packaged, so the queues are empty and the report says so rather than
    // being absent.
    assert.deepEqual(body.unclassified, [])
    assert.deepEqual(body.unpackaged, [])
    assert.equal(body.unlinked.length, 1, 'nothing is linked to a clinical drug yet')
  })

  test('purchasing reconciles the order against what arrived', async () => {
    const { body } = await read(clinic.pharmacy, 'purchasing')
    assert.equal(body.receipts.length, 1)
    assert.equal(Number(body.receipts[0].base_units), 60)
    assert.equal(body.receipts[0].supplier_invoice_number, 'INV-2026-1')
  })

  test('the follow-up report is the doctor’s Monday morning', async () => {
    const { body } = await read(clinic.doctor, 'follow_ups')
    assert.equal(body.rows.length, 1)
    assert.equal(body.rows[0].patient, 'Report Patient')
    assert.equal(body.rows[0].overdue, false)
  })
})

describe('who may read which report', () => {
  test('money reports are for the desks that handle money, which is two of them', async () => {
    // Policy register item 17. The doctor never collected; the nurse did, and
    // stopped on 12 September 2026. A report that showed more than
    // `take_payment` allows would be a way to read the day's takings from a
    // desk that cannot touch them.
    for (const staff of [clinic.doctor, clinic.nurse]) {
      for (const report of ['payments', 'patient_dues']) {
        const refused = await read(staff, report, 7)
        assert.equal(refused.status, 403, `${report} must be refused`)
        assert.match(refused.body.message, /cannot read that report/)
      }
    }

    for (const staff of [clinic.admin, clinic.pharmacy]) {
      for (const report of ['payments', 'patient_dues']) {
        assert.equal((await read(staff, report, 7)).status, 200)
      }
    }
  })

  test('the image access audit is the admin’s alone', async () => {
    for (const staff of [clinic.doctor, clinic.nurse, clinic.pharmacy]) {
      assert.equal(
        (await read(staff, 'image_access', 7)).status,
        403,
        'an audit of who saw a photograph is not a reason for more people to see one',
      )
    }
    assert.equal((await read(clinic.admin, 'image_access', 7)).status, 200)
  })

  test('the index offers each role only what it may open', async () => {
    const admin = await read(clinic.admin, 'index')
    const pharmacy = await read(clinic.pharmacy, 'index')
    const doctor = await read(clinic.doctor, 'index')

    const nurse = await read(clinic.nurse, 'index')

    assert.ok(admin.body.reports.includes('image_access'))
    assert.ok(!pharmacy.body.reports.includes('image_access'))
    assert.ok(!doctor.body.reports.includes('payments'))
    assert.ok(doctor.body.reports.includes('follow_ups'))

    // The nurse keeps a reason to open the screen and loses the money.
    assert.ok(!nurse.body.reports.includes('payments'))
    assert.ok(!nurse.body.reports.includes('patient_dues'))
    assert.ok(nurse.body.reports.includes('follow_ups'))

    // And an unsigned request gets nothing at all.
    assert.equal((await edgeGet('reports', '?report=index')).status, 401)
  })

  test('an unknown report is refused rather than answered with nothing', async () => {
    const result = await read(clinic.admin, 'everything')
    assert.equal(result.status, 400)
    assert.match(result.body.message, /Unknown report/)
  })

  test('a range is bounded, so one screen cannot ask for the whole history', async () => {
    const huge = await read(clinic.admin, 'stock_movements', 100000)
    assert.equal(huge.body.days, 400)
    const negative = await read(clinic.admin, 'stock_movements', -5)
    assert.equal(negative.body.days, 0)
  })
})

describe('the security posture, measured rather than described', () => {
  test('no Data API role can reach the clinic schema, by grant or by inheritance', async () => {
    /*
     * Two questions, because they fail differently.
     *
     * `role_table_grants` shows grants written against the role itself. A role
     * that is a MEMBER of another role inherits its privileges without any row
     * appearing there, which is exactly how a permission arrives that nobody
     * granted — so `has_table_privilege` is asked as well, and it is the one
     * that would catch it.
     */
    const granted = await rows(`
      select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'jmc' and grantee in ('anon','authenticated','service_role','PUBLIC')`)
    assert.deepEqual(granted.map((row) => `${row.grantee}:${row.table_name}`), [])

    const roles = await rows(
      `select rolname from pg_roles where rolname in ('anon','authenticated','service_role')`,
    )
    for (const role of roles.map((row) => row.rolname)) {
      const reachable = await rows(`
        select c.relname
          from pg_class c
         where c.relnamespace = 'jmc'::regnamespace and c.relkind in ('r','v')
           and (has_table_privilege($1, c.oid, 'SELECT')
             or has_table_privilege($1, c.oid, 'INSERT')
             or has_table_privilege($1, c.oid, 'UPDATE')
             or has_table_privilege($1, c.oid, 'DELETE'))`, [role])
      assert.deepEqual(
        reachable.map((row) => row.relname), [],
        `${role} can reach ${reachable.length} object(s) in jmc`,
      )
      assert.equal(
        await scalar('select has_schema_privilege($1, $2, $3)', [role, 'jmc', 'USAGE']),
        false,
        `${role} holds USAGE on jmc`,
      )
    }
  })

  test('every view is security_invoker, so none is a way around the caller’s own privileges', async () => {
    const leaky = await rows(`
      select c.relname from pg_class c
       where c.relnamespace = 'jmc'::regnamespace and c.relkind = 'v'
         and coalesce((select option_value from pg_options_to_table(c.reloptions)
                        where option_name = 'security_invoker'), 'false') <> 'true'`)
    assert.deepEqual(leaky.map((row) => row.relname), [])
  })

  test('row security is on everywhere and forced nowhere', async () => {
    const unprotected = await rows(`
      select relname from pg_class
       where relnamespace = 'jmc'::regnamespace and relkind = 'r' and not relrowsecurity`)
    assert.deepEqual(unprotected.map((row) => row.relname), [])

    /*
     * FORCE is the one that broke Slice 2, and it is worth re-asserting here
     * rather than trusting the earlier test to keep running. It removes the
     * table owner's normal exemption from row security, and these tables have
     * no policies — so an owner without BYPASSRLS reads nothing and writes
     * nothing, with no error at either end.
     */
    const forced = await rows(`
      select relname from pg_class
       where relnamespace = 'jmc'::regnamespace and relkind = 'r' and relforcerowsecurity`)
    assert.deepEqual(forced.map((row) => row.relname), [])
  })

  test('no SECURITY DEFINER function is hiding in the schema', async () => {
    /*
     * The brief is explicit: a privileged function must not be added merely to
     * bypass a permission problem. Every function here is a trigger or a pure
     * helper and runs as the caller; the day one needs to run as the owner, it
     * should have to change this assertion on purpose.
     */
    const definers = await rows(`
      select p.proname from pg_proc p
       where p.pronamespace = 'jmc'::regnamespace and p.prosecdef`)
    assert.deepEqual(definers.map((row) => row.proname), [])
  })

  test('every function pins its search_path, so none resolves through public', async () => {
    /*
     * The retired application's 74 tables live in `public` and eight of the
     * names collide exactly. A function that resolves `staff` through a
     * caller-controlled search_path is a function that can be pointed at the
     * wrong table.
     */
    const unpinned = await rows(`
      select p.proname from pg_proc p
       where p.pronamespace = 'jmc'::regnamespace
         and p.prokind = 'f'
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
            where c like 'search_path=%')`)
    assert.deepEqual(unpinned.map((row) => row.proname), [])
  })

  test('every foreign key has an index that supports it', async () => {
    const missing = await rows(`
      select c.conrelid::regclass::text as child, c.conname
        from pg_constraint c
       where c.contype = 'f' and c.connamespace = 'jmc'::regnamespace
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] = c.conkey)
       order by 1, 2`)
    assert.deepEqual(missing.map((row) => `${row.child}.${row.conname}`), [])
  })

  test('history is append-only where it has to be', async () => {
    /*
     * Named rather than counted. A table added later that should have been on
     * this list fails here by absence of its trigger, which is the failure
     * worth having.
     */
    const guarded = [
      'prescription_lines', 'prescription_line_resolutions', 'prescription_line_outcomes',
      'stock_movements', 'invoice_lines', 'payment_allocations',
      'clinical_images', 'image_access_events', 'image_consents',
      // Slice 3A. Consent evidence is append-only outright; a delivery attempt
      // is written once and settled once, which is the same guarantee about
      // the thing that matters — nothing is ever rewritten.
      'communication_consents', 'message_attempts',
    ]
    const triggers = await rows(`
      select c.relname, count(*)::int as triggers
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'jmc'::regnamespace and not t.tgisinternal
         and (t.tgtype & 28) <> 0
       group by c.relname`)
    const byTable = Object.fromEntries(triggers.map((row) => [row.relname, Number(row.triggers)]))
    for (const table of guarded) {
      assert.ok(byTable[table] > 0, `${table} has no trigger guarding its history`)
    }
  })

  test('no money column is a float, anywhere in the schema', async () => {
    const floats = await rows(`
      select table_name || '.' || column_name as column
        from information_schema.columns
       where table_schema = 'jmc' and data_type in ('real','double precision')
         and column_name not in ('temperature','weight')
       order by 1`)
    assert.deepEqual(floats.map((row) => row.column), [])
  })

  test('every stock quantity reconciles to the ledger after a full day', async () => {
    const drift = await rows(`
      select batch_id from jmc.batch_ledger_reconciliation
       where available_drift <> 0 or quarantine_drift <> 0 or blocked_drift <> 0`)
    assert.deepEqual(drift.map((row) => row.batch_id), [])
  })

  test('nothing was ever dispensed beyond what was prescribed', async () => {
    const over = await rows(`
      select l.id from jmc.prescription_line_supply l where l.supplied > coalesce(l.effective_quantity, 0)`)
    assert.deepEqual(over.map((row) => row.id), [])
  })

  test('no encounter carries two consultation fees', async () => {
    const doubled = await rows(`
      select encounter_id from jmc.invoice_lines
       where source = 'consultation_fee'
       group by encounter_id having count(*) > 1`)
    assert.deepEqual(doubled.map((row) => row.encounter_id), [])
  })

  test('no document number is issued twice', async () => {
    for (const [table, column] of [
      ['prescriptions', 'prescription_number'],
      ['invoices', 'invoice_number'],
      ['payments', 'receipt_number'],
      ['dispenses', 'dispense_number'],
      ['otc_sales', 'receipt_number'],
      ['goods_receipts', 'grn_number'],
    ]) {
      const duplicates = await rows(
        `select ${column} from jmc.${table} group by ${column} having count(*) > 1`,
      )
      assert.deepEqual(
        duplicates.map((row) => row[column]), [],
        `${table}.${column} was issued twice`,
      )
    }
  })
})
