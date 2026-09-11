/**
 * The formulary, the packages, the deliveries and the shelf.
 *
 * Slice 3. Everything here sits below the clinical line: a doctor prescribes a
 * clinical drug or a product, and nothing in this file can change what was
 * prescribed. What it can do is say precisely what a product IS, what it
 * arrives in, and how many base units are on the shelf — and it does all three
 * without ever inventing a number the clinic did not supply.
 *
 * Two rules run through the whole file.
 *
 *   THE LEDGER IS THE TRUTH. `batches.available_quantity` is a cache of
 *   `stock_movements`, and every change to it goes through `moveStock`, which
 *   writes both halves in the same statement pair inside one transaction.
 *   `jmc.batch_ledger_reconciliation` reads zero because nothing here has any
 *   other way to change a quantity.
 *
 *   WHAT ARRIVED IS FROZEN. A batch keeps the package ladder, the base unit
 *   and the price bases it was received under. A supplier who changes fifteen
 *   tablets per strip to ten gets a new package version and a new batch; the
 *   old batch keeps counting in fifteens, for ever, because that is what is
 *   physically on the shelf.
 */
import { randomUUID } from 'node:crypto'
import { audit, db, isoNow, transaction } from './db.ts'
import type { SessionView } from './types.ts'
import {
  booleanValue, numberValue, optional, optionalDate, optionalPositiveInteger,
  requireChoice, requireRole, sequence, value, type Payload,
} from './command-input.ts'
import { money, parseMoney, proRata, rupees, sum as sumMoney, times } from './money.ts'
import { runCounterCommand } from './counter.ts'
import {
  baseQuantityOf, buildLadder, decompose, describeEntry, describeLadder,
  ladderFromRows, levelNamed, plural, type Ladder, type Level, type LevelInput, type PackageEntry,
} from './packages.ts'

/** Today in the clinic, not in Greenwich. Same expression `commands.ts` uses. */
const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

export type Bucket = 'available' | 'quarantine' | 'blocked'

const BUCKET_COLUMN: Record<Bucket, string> = {
  available: 'available_quantity',
  quarantine: 'quarantined_quantity',
  blocked: 'blocked_quantity',
}

// ═══════════════════════════════════════════════════════════════════════════
// shared reads
// ═══════════════════════════════════════════════════════════════════════════

type PackageVersionRow = {
  id: string
  medicine_id: string
  version: number
  base_unit: string
  status: string
}

async function packageVersion(id: string): Promise<PackageVersionRow> {
  const row = await db.prepare(
    'select id,medicine_id,version,base_unit,status from package_versions where id=?',
  ).get(id) as PackageVersionRow | undefined
  if (!row) throw new Error('That package was not found.')
  return row
}

async function ladderOf(packageVersionId: string): Promise<Ladder> {
  const version = await packageVersion(packageVersionId)
  return ladderRows(version.base_unit, packageVersionId)
}

export async function ladderRows(baseUnit: string, packageVersionId: string): Promise<Ladder> {
  const rows = await db.prepare(
    `select level_name,level_type,child_count,base_factor,depth,receivable,sellable,breakable,
            minimum_sale_multiple,mrp_basis,barcode_hint,
            (select l2.level_name from package_levels l2 where l2.id = l.child_level_id) as contains
       from package_levels l where l.package_version_id=? order by depth`,
  ).all(packageVersionId) as Array<Record<string, unknown>>

  if (rows.length === 0) throw new Error('That package has no levels yet.')

  return ladderFromRows(baseUnit, rows.map((row): Level => ({
    levelName: String(row.level_name),
    levelType: String(row.level_type),
    contains: row.contains === null || row.contains === undefined ? null : String(row.contains),
    containsCount: row.child_count === null ? null : Number(row.child_count),
    depth: Number(row.depth),
    baseFactor: Number(row.base_factor),
    receivable: row.receivable === true,
    sellable: row.sellable === true,
    breakable: row.breakable === true,
    minimumSaleMultiple: Number(row.minimum_sale_multiple),
    mrpBasis: row.mrp_basis === true,
    barcodeHint: String(row.barcode_hint ?? ''),
  })))
}

/**
 * The ladder a BATCH was received under, from its own frozen snapshot.
 *
 * Not from `package_versions`, even though the batch names one: the version
 * can be retired, and a report printed in 2030 has to be able to say what a
 * strip of this lot held without the row that defined it still being current.
 * The snapshot is the record; the foreign key is the cross-reference.
 */
export function ladderOfBatch(batch: { package_snapshot: unknown; base_unit: string }): Ladder | null {
  const snapshot = batch.package_snapshot
  if (!snapshot) return null
  const parsed = (typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot) as {
    baseUnit: string
    levels: Level[]
  }
  if (!parsed?.levels?.length) return null
  return ladderFromRows(parsed.baseUnit || batch.base_unit, parsed.levels)
}

/**
 * Move stock, and write the ledger row that explains it, in one place.
 *
 * The `where` clause carries the arithmetic — `set x = x - ?  where x >= ?` —
 * so two transactions racing for the last tablet cannot both win: the second
 * changes zero rows and is refused. The column's own `check (>= 0)` is the
 * backstop underneath that, and neither is decorative.
 */
/*
 * ── A NOTE ON WRITING JSON, BECAUSE IT IS NOT WHAT IT LOOKS LIKE ───────────
 *
 * Every JSON column below is written with `?::text::jsonb`, and the `::text`
 * is load-bearing. `postgres` sends a JavaScript string to a `json` parameter
 * slot, so `$1::jsonb` casts a JSON *string value* — the snapshot comes back
 * as the jsonb scalar `"{\"levels\":[...]}"` rather than as an object, and
 * `package_snapshot->'levels'` is then NULL. Nothing errors; the column looks
 * full and every query through it reads nothing.
 *
 * Measured on this schema:
 *
 *   select jsonb_typeof($1::jsonb)        -- 'string'
 *   select jsonb_typeof($1::text::jsonb)  -- 'object'
 *
 * Forcing the parameter to text first hands Postgres the characters and lets
 * it parse them, which is what was meant.
 */
export async function moveStock(options: {
  batchId: string
  medicineId: string
  bucket: Bucket
  delta: number
  movementType: string
  referenceType: string
  referenceId: string
  actorId: string
  reason?: string
  approvedBy?: string | null
  packageEntry?: PackageEntry[] | null
  reverses?: string | null
}): Promise<string> {
  const { batchId, bucket, delta } = options
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new Error('A stock movement moves a whole number of base units.')
  }
  const column = BUCKET_COLUMN[bucket]

  const result = delta > 0
    ? await db.prepare(
      `update batches set ${column}=${column}+?, version=version+1 where id=?`,
    ).run(delta, batchId)
    : await db.prepare(
      `update batches set ${column}=${column}-?, version=version+1 where id=? and ${column}>=?`,
    ).run(-delta, batchId, -delta)

  if (Number(result.changes) !== 1) {
    throw new Error(
      bucket === 'available'
        ? 'Stock changed on another tablet. Check the shelf figure and try again.'
        : `There is not that much ${bucket} stock in this batch.`,
    )
  }

  const movementId = randomUUID()
  await db.prepare(
    `insert into stock_movements
      (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,
       actor_id,created_at,bucket,package_entry,reason,approved_by,reverses_movement_id)
     values (?,?,?,?,?,?,?,?,?,?,?::text::jsonb,?,?,?)`,
  ).run(
    movementId, options.medicineId, batchId, options.movementType, delta,
    options.referenceType, options.referenceId, options.actorId, isoNow(),
    bucket,
    options.packageEntry ? JSON.stringify(options.packageEntry) : null,
    options.reason ?? '', options.approvedBy ?? null, options.reverses ?? null,
  )
  return movementId
}

export function packageEntries(raw: unknown, label: string): PackageEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const row = item as Payload
    const levelName = optional(row, 'levelName')
    if (!levelName) throw new Error(`Each ${label} line names a package level.`)
    const count = Number(row.count ?? 0)
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`The number of ${levelName} in the ${label} must be a whole number.`)
    }
    return { levelName, count }
  })
}

function normalized(text: string): string {
  return text.trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ')
}

// ═══════════════════════════════════════════════════════════════════════════

export async function runInventoryCommand(session: SessionView, action: string, payload: Payload) {
  switch (action) {
    // ───────────────────────────────────────────────────────────────────────
    // 1. CLINICAL IDENTITY
    // ───────────────────────────────────────────────────────────────────────

    /*
     * A substance. Paracetamol, not Calpol.
     *
     * Deduplicated on a normalized name rather than trusted to be typed the
     * same way twice, because two Paracetamols is two clinical drugs is two
     * products the pharmacist cannot see are the same medicine.
     *
     * `source` defaults to 'clinic', meaning "a person here typed it". Nothing
     * is imported from a licensed terminology: the brief forbids redistributing
     * one without confirming the applicable terms, and the columns are here so
     * that mapping to one later is an update rather than a migration.
     */
    case 'save_substance': {
      requireRole(session, 'admin', 'pharmacy')
      const name = value(payload, 'name')
      const key = normalized(name)
      const id = randomUUID()

      let substanceId: string = id
      let created = false
      await transaction(async () => {
        const existing = await db.prepare('select id,name from substances where normalized_name=?')
          .get(key) as { id: string; name: string } | undefined
        if (existing) {
          // The name is NOT overwritten. "paracetamol" typed in a hurry is the
          // same substance as "Paracetamol", and the second typing is a match,
          // not a rename — every clinical drug built on this row displays that
          // name, and a casing change would quietly restate all of them.
          substanceId = existing.id
          await db.prepare(`update substances set source=?, source_code=?, source_version=?, active=true
            where id=?`).run(
            requireChoice(payload, 'source', ['clinic', 'who_atc', 'snomed', 'cdsco', 'other'] as const, 'clinic'),
            optional(payload, 'sourceCode'), optional(payload, 'sourceVersion'), existing.id,
          )
          return
        }
        created = true
        await db.prepare(`insert into substances
          (id,name,normalized_name,source,source_code,source_version,active,created_by,created_at)
          values (?,?,?,?,?,?,true,?,now())`).run(
          id, name, key,
          requireChoice(payload, 'source', ['clinic', 'who_atc', 'snomed', 'cdsco', 'other'] as const, 'clinic'),
          optional(payload, 'sourceCode'), optional(payload, 'sourceVersion'), session.staffId,
        )
        await audit(session.staffId, 'substance.created', 'substance', id, `Added ${name}`)
      })
      return {
        message: created ? `${name} added to the formulary.` : `${name} was already in the formulary.`,
        data: { substanceId, created },
      }
    }

    /*
     * A clinical drug: ingredient(s) + strength + dose form + route/release.
     *
     * This is what a generic prescription names and what policy register 21
     * makes a pharmacist match exactly before offering an in-stock brand. The
     * identity key is built here rather than left to the caller so that
     * "Paracetamol 500 mg tablet" typed by two different people on two
     * different days is one row — and so that 500 mg and 650 mg never become
     * one, whatever the display name says.
     */
    case 'save_clinical_drug': {
      requireRole(session, 'admin', 'pharmacy')
      const dosageForm = value(payload, 'dosageForm')
      const route = optional(payload, 'route')
      const releaseType = optional(payload, 'releaseType')

      const rawIngredients = Array.isArray(payload.ingredients) ? payload.ingredients as Payload[] : []
      if (rawIngredients.length === 0) throw new Error('A clinical drug needs at least one ingredient.')

      const ingredients = rawIngredients.map((row, index) => {
        const strengthValue = Number(row.strengthValue)
        if (!Number.isFinite(strengthValue) || strengthValue <= 0) {
          throw new Error(`Ingredient ${index + 1} needs a strength above zero.`)
        }
        const perValueRaw = optional(row, 'perValue')
        const perValue = perValueRaw ? Number(perValueRaw) : null
        if (perValueRaw && (!Number.isFinite(Number(perValue)) || Number(perValue) <= 0)) {
          throw new Error(`Ingredient ${index + 1} has a "per" amount that is not a number.`)
        }
        const perUnit = optional(row, 'perUnit')
        if ((perValue === null) !== (perUnit === '')) {
          throw new Error(`Ingredient ${index + 1} needs both a "per" amount and its unit, or neither.`)
        }
        return {
          substanceId: value(row, 'substanceId'),
          strengthValue,
          strengthUnit: value(row, 'strengthUnit'),
          perValue,
          perUnit,
        }
      })

      const id = randomUUID()
      let clinicalDrugId: string = id
      let created = false
      let displayName = optional(payload, 'displayName')

      await transaction(async () => {
        const named: Array<typeof ingredients[number] & { name: string }> = []
        for (const ingredient of ingredients) {
          const substance = await db.prepare('select id,name,normalized_name from substances where id=? and active')
            .get(ingredient.substanceId) as { id: string; name: string; normalized_name: string } | undefined
          if (!substance) throw new Error('One of those ingredients is not in the formulary.')
          named.push({ ...ingredient, name: substance.name })
        }

        // Sorted, so the order ingredients were typed in cannot make two rows.
        const identityKey = [
          ...named
            .map((item) => `${normalized(item.name)}|${item.strengthValue}|${normalized(item.strengthUnit)}`
              + `|${item.perValue ?? ''}|${normalized(item.perUnit)}`)
            .sort(),
          normalized(dosageForm), normalized(route), normalized(releaseType),
        ].join('~')

        if (!displayName) {
          const strengths = named
            .map((item) => `${item.strengthValue} ${item.strengthUnit}`
              + (item.perValue ? ` per ${item.perValue} ${item.perUnit}` : ''))
            .join(' + ')
          displayName = [named.map((item) => item.name).join(' + '), strengths, dosageForm]
            .filter(Boolean).join(' ')
        }

        const existing = await db.prepare('select id from clinical_drugs where identity_key=?')
          .get(identityKey) as { id: string } | undefined
        if (existing) {
          clinicalDrugId = existing.id
          await db.prepare('update clinical_drugs set display_name=?, active=true where id=?')
            .run(displayName, existing.id)
          await audit(session.staffId, 'clinical_drug.updated', 'clinical_drug', existing.id, `Updated ${displayName}`)
          return
        }

        created = true
        await db.prepare(`insert into clinical_drugs
          (id,display_name,dosage_form,route,release_type,identity_key,source,source_code,source_version,
           active,created_by,created_at)
          values (?,?,?,?,?,?,?,?,?,true,?,now())`).run(
          id, displayName, dosageForm, route, releaseType, identityKey,
          requireChoice(payload, 'source', ['clinic', 'who_atc', 'snomed', 'cdsco', 'other'] as const, 'clinic'),
          optional(payload, 'sourceCode'), optional(payload, 'sourceVersion'), session.staffId,
        )
        const insert = await db.prepare(`insert into clinical_drug_ingredients
          (clinical_drug_id,ordinal,substance_id,strength_value,strength_unit,per_value,per_unit)
          values (?,?,?,?,?,?,?)`)
        let ordinal = 0
        for (const ingredient of named) {
          ordinal += 1
          await insert.run(
            id, ordinal, ingredient.substanceId, ingredient.strengthValue, ingredient.strengthUnit,
            ingredient.perValue, ingredient.perUnit,
          )
        }
        await audit(session.staffId, 'clinical_drug.created', 'clinical_drug', id, `Added ${displayName}`)
      })

      return {
        message: created ? `${displayName} added.` : `${displayName} was already in the formulary.`,
        data: { clinicalDrugId, created },
      }
    }

    /*
     * Attach a shelf product to the clinical drug it actually is.
     *
     * Separate from `add_medicine` on purpose: every medicine already in the
     * clinic is unlinked, and guessing which clinical drug a two-year-old
     * shelf label means is precisely the invention the brief forbids. A
     * pharmacist does this during setup, one product at a time, and the Slice 3
     * report counts what is left.
     */
    case 'link_medicine_identity': {
      requireRole(session, 'admin', 'pharmacy')
      const medicineId = value(payload, 'medicineId')
      const clinicalDrugId = optional(payload, 'clinicalDrugId')
      const baseUnit = optional(payload, 'baseUnit')
      // An omitted field leaves what is there; `clear` says the link itself was
      // wrong. Without it every field was `coalesce(nullif(?, ''), existing)`
      // and a product linked to the wrong clinical drug could be relinked but
      // never unlinked — which matters most for exactly the mistake somebody
      // most wants to undo.
      const clear = Array.isArray(payload.clear)
        ? (payload.clear as unknown[]).map((item) => String(item))
        : []
      for (const field of clear) {
        if (!['clinicalDrugId', 'brandName', 'manufacturer'].includes(field)) {
          throw new Error(`${field} cannot be cleared.`)
        }
      }
      if (clear.includes('clinicalDrugId') && clinicalDrugId) {
        throw new Error('Choose whether to link a clinical drug or to clear the link, not both.')
      }

      await transaction(async () => {
        const medicine = await db.prepare('select id,name,base_unit from medicines where id=?')
          .get(medicineId) as { id: string; name: string; base_unit: string } | undefined
        if (!medicine) throw new Error('That medicine was not found.')

        if (clinicalDrugId) {
          const drug = await db.prepare('select id,display_name from clinical_drugs where id=? and active')
            .get(clinicalDrugId) as { id: string; display_name: string } | undefined
          if (!drug) throw new Error('That clinical drug is not in the formulary.')
        }

        // The base unit is what every batch of this product is counted in.
        // Changing it once stock exists would silently restate the shelf.
        if (baseUnit && baseUnit !== medicine.base_unit) {
          const held = await db.prepare(
            `select coalesce(sum(available_quantity + quarantined_quantity + blocked_quantity),0)::int as held
               from batches where medicine_id=?`,
          ).get(medicineId) as { held: number }
          if (Number(held.held) > 0) {
            throw new Error(
              `${medicine.name} has stock counted in ${medicine.base_unit}. The base unit cannot change while any is on the shelf.`,
            )
          }
        }

        await db.prepare(`update medicines set
            clinical_drug_id = case when ? then null else coalesce(nullif(?, ''), clinical_drug_id) end,
            brand_name = case when ? then '' else coalesce(nullif(?, ''), brand_name) end,
            manufacturer = case when ? then '' else coalesce(nullif(?, ''), manufacturer) end,
            base_unit = coalesce(nullif(?, ''), base_unit)
          where id=?`).run(
          clear.includes('clinicalDrugId'), clinicalDrugId,
          clear.includes('brandName'), optional(payload, 'brandName'),
          clear.includes('manufacturer'), optional(payload, 'manufacturer'),
          baseUnit, medicineId,
        )
        await audit(session.staffId, 'medicine.identity_linked', 'medicine', medicineId,
          `Linked ${medicine.name} to its clinical identity`)
      })
      return { message: 'Medicine identity saved.' }
    }

    /*
     * The regulatory class, and who says so.
     *
     * Policy register 42: the pharmacist selects a supported class when
     * creating or editing a medicine, and existing items are classified during
     * setup. Until that happens the class stays `unset` — Unknown / pharmacist
     * review required — and Slice 4 refuses it from the anonymous OTC path.
     * It is never inferred from `sale_class`: `restricted` could be H1 or X,
     * and a register an inspector can fault is worse than admitting it is
     * incomplete.
     */
    case 'classify_medicine': {
      requireRole(session, 'admin', 'pharmacy')
      const medicineId = value(payload, 'medicineId')
      const schedule = requireChoice(
        payload, 'schedule',
        ['unset', 'OTC', 'H', 'H1', 'X', 'G', 'C', 'C1', 'other'] as const,
      )
      const source = optional(payload, 'source')
      const verified = booleanValue(payload, 'verified')

      if (schedule !== 'unset' && !source) {
        throw new Error('Say where this classification comes from — the pack, the schedule, or a named source.')
      }
      if (schedule === 'other' && !optional(payload, 'note') && !source) {
        throw new Error('An "other" classification has to say what it actually is.')
      }
      if (verified && schedule === 'unset') {
        throw new Error('An unknown classification cannot be verified. Choose the class first.')
      }

      await transaction(async () => {
        const medicine = await db.prepare('select id,name from medicines where id=?')
          .get(medicineId) as { id: string; name: string } | undefined
        if (!medicine) throw new Error('That medicine was not found.')

        await db.prepare(`update medicines set schedule=?, schedule_source=?, schedule_version=?,
            schedule_effective_on=?, schedule_verified_by=?, schedule_verified_at=?
          where id=?`).run(
          schedule, source, optional(payload, 'sourceVersion'), optionalDate(payload, 'effectiveOn') ?? null,
          verified ? session.staffId : null, verified ? isoNow() : null, medicineId,
        )
        await audit(session.staffId, 'medicine.classified', 'medicine', medicineId,
          `${medicine.name} classified ${schedule}${verified ? ', verified' : ', pending verification'}`)
      })
      return {
        message: verified
          ? 'Classification recorded and verified.'
          : 'Classification recorded. A pharmacist must verify it before this medicine can be sold over the counter.',
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 2. PACKAGES
    // ───────────────────────────────────────────────────────────────────────

    /*
     * Build, or rebuild, a package version as a DRAFT.
     *
     * Never an edit of a verified one. Approval pack §6: when fifteen tablets
     * per strip becomes ten, the old version stays for old batches and a new
     * version is created for new stock. Editing in place would restate what
     * every existing batch is understood to contain, and the database refuses
     * it whatever this function does.
     */
    case 'save_package_version': {
      requireRole(session, 'admin', 'pharmacy')
      const medicineId = value(payload, 'medicineId')
      const baseUnit = value(payload, 'baseUnit')
      const draftId = optional(payload, 'packageVersionId')

      const levels = (Array.isArray(payload.levels) ? payload.levels as Payload[] : []).map((row): LevelInput => ({
        levelName: optional(row, 'levelName'),
        levelType: optional(row, 'levelType') || optional(row, 'levelName'),
        contains: optional(row, 'contains') || undefined,
        containsCount: optional(row, 'containsCount') ? Number(row.containsCount) : undefined,
        receivable: row.receivable === undefined ? undefined : booleanValue(row, 'receivable'),
        sellable: row.sellable === undefined ? undefined : booleanValue(row, 'sellable'),
        breakable: row.breakable === undefined ? undefined : booleanValue(row, 'breakable'),
        minimumSaleMultiple: optional(row, 'minimumSaleMultiple')
          ? Number(row.minimumSaleMultiple) : undefined,
        mrpBasis: row.mrpBasis === undefined ? undefined : booleanValue(row, 'mrpBasis'),
        barcodeHint: optional(row, 'barcodeHint'),
      }))

      // Validated before a transaction opens, so a bad ladder costs nothing.
      const ladder = buildLadder(baseUnit, levels)

      const id = draftId || randomUUID()
      let versionNumber = 0
      await transaction(async () => {
        const medicine = await db.prepare('select id,name,base_unit from medicines where id=?')
          .get(medicineId) as { id: string; name: string; base_unit: string } | undefined
        if (!medicine) throw new Error('That medicine was not found.')

        if (draftId) {
          const existing = await packageVersion(draftId)
          if (existing.status !== 'draft') {
            throw new Error('That package version is verified. Create a new version instead of editing it.')
          }
          if (existing.medicine_id !== medicineId) {
            throw new Error('That package version belongs to a different medicine.')
          }
          await db.prepare('delete from package_levels where package_version_id=?').run(draftId)
          await db.prepare('update package_versions set base_unit=?, note=? where id=?')
            .run(ladder.baseUnit, optional(payload, 'note'), draftId)
          const row = await db.prepare('select version from package_versions where id=?')
            .get(draftId) as { version: number }
          versionNumber = Number(row.version)
        } else {
          const highest = await db.prepare(
            'select coalesce(max(version),0)::int as version from package_versions where medicine_id=?',
          ).get(medicineId) as { version: number }
          versionNumber = Number(highest.version) + 1
          await db.prepare(`insert into package_versions
            (id,medicine_id,version,base_unit,status,entered_by,entered_at,note)
            values (?,?,?,?, 'draft', ?, now(), ?)`).run(
            id, medicineId, versionNumber, ladder.baseUnit, session.staffId, optional(payload, 'note'),
          )
        }

        // Base first, so each level's child already exists when the trigger
        // checks the arithmetic.
        const ids = new Map<string, string>()
        const insert = await db.prepare(`insert into package_levels
          (id,package_version_id,level_name,level_type,child_level_id,child_count,base_factor,depth,
           receivable,sellable,breakable,minimum_sale_multiple,mrp_basis,barcode_hint)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        for (const level of ladder.levels) {
          const levelId = randomUUID()
          await insert.run(
            levelId, id, level.levelName, level.levelType,
            level.contains ? ids.get(level.contains.toLowerCase()) ?? null : null,
            level.containsCount, level.baseFactor, level.depth,
            level.receivable, level.sellable, level.breakable,
            level.minimumSaleMultiple, level.mrpBasis, level.barcodeHint,
          )
          ids.set(level.levelName.toLowerCase(), levelId)
        }

        // A product with no base unit yet takes this one. A product that has
        // one keeps it: see link_medicine_identity for why.
        if (!medicine.base_unit) {
          await db.prepare('update medicines set base_unit=? where id=?').run(ladder.baseUnit, medicineId)
        } else if (medicine.base_unit !== ladder.baseUnit) {
          throw new Error(
            `${medicine.name} is counted in ${plural(medicine.base_unit, 2)}. A package version for it must use the same base unit.`,
          )
        }

        await audit(session.staffId, 'package.drafted', 'package_version', id,
          `${medicine.name} package v${versionNumber}: ${describeLadder(ladder)}`)
      })

      return {
        message: `Draft saved: ${describeLadder(ladder)}. Verify it against the physical pack before receiving stock.`,
        data: { packageVersionId: id, version: versionNumber, summary: describeLadder(ladder) },
      }
    }

    /*
     * Verify a draft against the pack in front of you.
     *
     * Approval pack §4 step D. Both a pharmacist and an admin may write a
     * package, so permission is not the control here — the control is that a
     * conversion cannot receive stock until somebody confirms it against the
     * physical pack, the supplier's invoice, or a named manufacturer source.
     * A clinic that can configure a stricter rule later configures it on top
     * of this; nothing here can be skipped.
     */
    case 'verify_package_version': {
      requireRole(session, 'admin', 'pharmacy')
      const packageVersionId = value(payload, 'packageVersionId')
      const source = requireChoice(
        payload, 'verificationSource',
        ['physical_pack', 'supplier_invoice', 'manufacturer_data', 'other'] as const,
      )
      const note = optional(payload, 'verificationNote')
      if (source === 'other' && !note) throw new Error('Say what was checked.')

      let summary = ''
      await transaction(async () => {
        const version = await packageVersion(packageVersionId)
        if (version.status === 'retired') throw new Error('That package version is retired.')
        if (version.status === 'verified') throw new Error('That package version is already verified.')

        const ladder = await ladderRows(version.base_unit, packageVersionId)
        summary = describeLadder(ladder)

        await db.prepare(`update package_versions
          set status='verified', verified_by=?, verified_at=now(), verification_source=?, verification_note=?
          where id=? and status='draft'`).run(session.staffId, source, note, packageVersionId)

        const medicine = await db.prepare('select name from medicines where id=?')
          .get(version.medicine_id) as { name: string }
        await audit(session.staffId, 'package.verified', 'package_version', packageVersionId,
          `${medicine.name} package v${version.version} verified against ${source.replace(/_/g, ' ')}: ${summary}`)
      })
      return { message: `Verified: ${summary}. Stock can now be received against it.`, data: { summary } }
    }

    case 'retire_package_version': {
      requireRole(session, 'admin', 'pharmacy')
      const packageVersionId = value(payload, 'packageVersionId')
      const reason = value(payload, 'reason')
      await transaction(async () => {
        const version = await packageVersion(packageVersionId)
        if (version.status === 'retired') throw new Error('That package version is already retired.')
        await db.prepare(`update package_versions
          set status='retired', retired_by=?, retired_at=now(), note=?
          where id=?`).run(session.staffId, reason, packageVersionId)
        await audit(session.staffId, 'package.retired', 'package_version', packageVersionId,
          `Package v${version.version} retired: ${reason}`)
      })
      return { message: 'Package version retired. Existing batches keep the conversion they arrived with.' }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 3. BARCODES
    // ───────────────────────────────────────────────────────────────────────

    /*
     * Map a scanned code to a package level.
     *
     * `carriesBatch` defaults to false and that default is the important part.
     * A plain GTIN identifies a trade item, not a lot: batch and expiry live in
     * GS1 application identifiers (10) and (17), which only a GS1-128 or
     * DataMatrix payload carries. Treating an EAN-13 as if it named a batch is
     * how a pharmacy dispenses from the wrong lot and cannot tell afterwards.
     */
    case 'map_barcode': {
      requireRole(session, 'admin', 'pharmacy')
      const medicineId = value(payload, 'medicineId')
      const code = value(payload, 'code')
      const levelName = value(payload, 'levelName')
      const symbology = requireChoice(
        payload, 'symbology',
        ['unknown', 'ean13', 'ean8', 'upca', 'upce', 'itf14', 'gs1_128',
          'gs1_datamatrix', 'qr', 'code128', 'other'] as const,
        'unknown',
      )
      const carriesBatch = booleanValue(payload, 'carriesBatch')
      if (carriesBatch && !['gs1_128', 'gs1_datamatrix', 'qr'].includes(symbology)) {
        throw new Error(
          'Only a GS1-128, DataMatrix or QR payload can carry a batch and expiry. A plain barcode identifies the pack.',
        )
      }

      const id = randomUUID()
      await transaction(async () => {
        const medicine = await db.prepare('select id,name from medicines where id=?')
          .get(medicineId) as { id: string; name: string } | undefined
        if (!medicine) throw new Error('That medicine was not found.')

        const active = await db.prepare(
          'select package_version_id,base_unit from medicine_active_package where medicine_id=?',
        ).get(medicineId) as { package_version_id: string; base_unit: string } | undefined
        if (!active) throw new Error('Verify a package for this medicine before mapping a code to one of its levels.')
        const ladder = await ladderRows(active.base_unit, active.package_version_id)
        const level = levelNamed(ladder, levelName)

        const clash = await db.prepare(
          'select medicine_id from medicine_barcodes where code=? and medicine_id<>?',
        ).get(code, medicineId) as { medicine_id: string } | undefined
        if (clash) {
          const other = await db.prepare('select name from medicines where id=?')
            .get(clash.medicine_id) as { name: string }
          throw new Error(`That code is already mapped to ${other.name}. A scan must mean one thing.`)
        }

        await db.prepare(`insert into medicine_barcodes
          (id,medicine_id,level_name,code,symbology,carries_batch,verified_by,verified_at,created_by,created_at)
          values (?,?,?,?,?,?,?,now(),?,now())
          on conflict (code) do update set
            level_name=excluded.level_name, symbology=excluded.symbology,
            carries_batch=excluded.carries_batch,
            verified_by=excluded.verified_by, verified_at=excluded.verified_at`).run(
          id, medicineId, level.levelName, code, symbology, carriesBatch, session.staffId, session.staffId,
        )
        await db.prepare('update unmapped_barcodes set resolved_at=now(), resolved_by=? where code=? and resolved_at is null')
          .run(session.staffId, code)
        await audit(session.staffId, 'barcode.mapped', 'medicine', medicineId,
          `${code} maps to one ${level.levelName} of ${medicine.name}`)
      })
      return { message: `Code mapped to one ${levelName}.` }
    }

    /*
     * A scan nobody has mapped.
     *
     * Recorded rather than swallowed. The pharmacist at the counter cannot stop
     * to map it and must fall back to searching by name; the admin who can map
     * it needs to know it happened and how often.
     */
    case 'record_unknown_barcode': {
      requireRole(session, 'admin', 'pharmacy', 'nurse')
      const code = value(payload, 'code')
      await transaction(async () => {
        await db.prepare(`insert into unmapped_barcodes (code,symbology,first_seen_by)
          values (?,?,?)
          on conflict (code) do update set
            seen_count = unmapped_barcodes.seen_count + 1,
            last_seen_at = now()`).run(code, optional(payload, 'symbology') || 'unknown', session.staffId)
      })
      return {
        message: 'That code is not mapped to any medicine yet. Search by name, and ask an admin to map it.',
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 4. RECEIVING
    // ───────────────────────────────────────────────────────────────────────

    /*
     * A goods receipt. THIS is what adds stock; a purchase order does not.
     *
     * One transaction, one idempotency key, and the physical entry preserved
     * beside the base-unit total it converts to. Partial deliveries, free
     * quantity, quarantine and outright rejection are all ordinary cases here
     * rather than exceptions, because on a real invoice they are.
     */
    case 'post_goods_receipt': {
      requireRole(session, 'admin', 'pharmacy')
      const idempotencyKey = value(payload, 'idempotencyKey')
      const supplierId = value(payload, 'supplierId')
      const purchaseOrderId = optional(payload, 'purchaseOrderId')
      const rawLines = Array.isArray(payload.lines) ? payload.lines as Payload[] : []
      if (rawLines.length === 0) throw new Error('Enter at least one delivered line.')

      // The retry path, checked before anything is written and again inside
      // the transaction by the unique index — a check without the constraint
      // is a race, and a constraint without the check is an ugly error.
      const already = await db.prepare(
        'select id,grn_number from goods_receipts where idempotency_key=?',
      ).get(idempotencyKey) as { id: string; grn_number: string } | undefined
      if (already) {
        return {
          message: `Delivery ${already.grn_number} was already received. Nothing was added twice.`,
          data: { goodsReceiptId: already.id, grnNumber: already.grn_number, duplicate: true },
        }
      }

      const receiptId = randomUUID()
      let grnNumber = ''
      let totalBase = 0
      const summaries: string[] = []

      await transaction(async () => {
        const supplier = await db.prepare('select id,name from suppliers where id=? and active=1')
          .get(supplierId) as { id: string; name: string } | undefined
        if (!supplier) throw new Error('Choose an active supplier.')

        if (purchaseOrderId) {
          const order = await db.prepare('select id,status,supplier_id from purchase_orders where id=? for update')
            .get(purchaseOrderId) as { id: string; status: string; supplier_id: string } | undefined
          if (!order) throw new Error('That purchase order was not found.')
          if (order.supplier_id !== supplierId) {
            throw new Error('That purchase order was raised with a different supplier.')
          }
          if (!['placed', 'partially_delivered'].includes(order.status)) {
            throw new Error('That order is not awaiting delivery.')
          }
        }

        grnNumber = await sequence('GRN')
        await db.prepare(`insert into goods_receipts
          (id,grn_number,supplier_id,purchase_order_id,supplier_invoice_number,supplier_invoice_date,
           status,idempotency_key,subtotal,tax_total,total,note,received_by,received_at)
          values (?,?,?,?,?,?, 'posted', ?, 0, 0, 0, ?, ?, now())`).run(
          receiptId, grnNumber, supplierId, purchaseOrderId || null,
          optional(payload, 'supplierInvoiceNumber'), optionalDate(payload, 'supplierInvoiceDate') ?? null,
          idempotencyKey, optional(payload, 'note'), session.staffId,
        )

        let subtotal = 0
        let taxTotal = 0
        let lineNumber = 0

        for (const raw of rawLines) {
          lineNumber += 1
          const medicineId = value(raw, 'medicineId')
          const medicine = await db.prepare('select id,name,base_unit,unit from medicines where id=? and active=1')
            .get(medicineId) as { id: string; name: string; base_unit: string; unit: string } | undefined
          if (!medicine) throw new Error(`Line ${lineNumber}: that medicine is not in the active formulary.`)

          // The package version, and the rule that makes verification matter.
          const requestedVersion = optional(raw, 'packageVersionId')
          const version = requestedVersion
            ? await packageVersion(requestedVersion)
            : await db.prepare(
              'select id,medicine_id,version,base_unit,\'verified\' as status from medicine_active_package where medicine_id=?',
            ).get(medicineId) as PackageVersionRow | undefined
          if (!version) {
            throw new Error(
              `Line ${lineNumber}: ${medicine.name} has no verified package. Build one and verify it against the pack before receiving stock.`,
            )
          }
          if (version.medicine_id !== medicineId) {
            throw new Error(`Line ${lineNumber}: that package belongs to a different medicine.`)
          }
          if (requestedVersion) {
            const status = await db.prepare('select status from package_versions where id=?')
              .get(version.id) as { status: string }
            if (status.status !== 'verified') {
              throw new Error(
                `Line ${lineNumber}: that package version is a ${status.status}. A conversion must be verified against the physical pack before it can receive stock.`,
              )
            }
          }
          const ladder = await ladderRows(version.base_unit, version.id)

          const accepted = packageEntries(raw.entry, 'delivered quantity')
          const free = packageEntries(raw.free, 'free quantity')
          const quarantined = packageEntries(raw.quarantined, 'quarantined quantity')
          const rejected = packageEntries(raw.rejected, 'rejected quantity')

          const acceptedBase = accepted.length ? baseQuantityOf(ladder, accepted) : 0
          const freeBase = free.length ? baseQuantityOf(ladder, free) : 0
          const quarantinedBase = quarantined.length ? baseQuantityOf(ladder, quarantined) : 0
          const rejectedBase = rejected.length ? baseQuantityOf(ladder, rejected) : 0
          const rejectionReason = optional(raw, 'rejectionReason')
          if (rejectedBase > 0 && !rejectionReason) {
            throw new Error(`Line ${lineNumber}: say why the rejected quantity was refused.`)
          }
          if (acceptedBase + freeBase + quarantinedBase + rejectedBase === 0) {
            throw new Error(`Line ${lineNumber}: nothing was delivered on this line.`)
          }

          // The preview the tablet showed, checked against the figure this
          // function computed. They can only differ if the package version
          // changed between the two, and posting the tablet's number then
          // would post a conversion nobody verified.
          const previewed = optionalPositiveInteger(raw, 'previewBaseQuantity')
          if (previewed !== undefined && previewed !== acceptedBase + freeBase) {
            throw new Error(
              `Line ${lineNumber}: the screen showed ${previewed} ${plural(ladder.baseUnit, previewed)} but this package converts to ${acceptedBase + freeBase}. Reload and check the package before posting.`,
            )
          }

          const expiry = optionalDate(raw, 'expiry')
          if (!expiry) throw new Error(`Line ${lineNumber}: enter the expiry date.`)
          const past = await db.prepare(`select (?::date < ${CLINIC_TODAY}) as expired`)
            .get(expiry) as { expired: boolean }
          if (past.expired) {
            throw new Error(`Line ${lineNumber}: that batch expired on ${expiry}. Expired stock is not received onto the shelf.`)
          }

          const mrpBasisLevel = levelNamed(ladder, value(raw, 'mrpBasisLevel'))
          const purchaseBasisLevel = levelNamed(ladder, value(raw, 'purchaseBasisLevel'))
          const mrpPaise = parseMoney(raw.mrp, `Line ${lineNumber} MRP`)
          const purchasePaise = parseMoney(raw.purchasePrice, `Line ${lineNumber} purchase price`)
          const taxRate = raw.taxRate === undefined || optional(raw, 'taxRate') === ''
            ? 0 : numberValue(raw, 'taxRate')
          if (taxRate < 0 || taxRate > 100) throw new Error(`Line ${lineNumber}: the tax rate is a percentage.`)

          const batchNumber = value(raw, 'batchNumber')

          // Chargeable quantity is what was accepted and quarantined; free
          // quantity is free and rejected quantity is not ours.
          const chargeableBase = acceptedBase + quarantinedBase
          const lineNet = proRata(purchasePaise, chargeableBase, purchaseBasisLevel.baseFactor)
          const lineTax = Math.round((lineNet * taxRate) / 100)
          subtotal += lineNet
          taxTotal += lineTax

          // The batch. One row per (medicine, batch number); a second delivery
          // of the same lot adds to it, and must agree about what it is.
          let batch = await db.prepare(
            `select id,expiry,package_version_id,base_unit,mrp_basis_factor
               from batches where medicine_id=? and batch_number=? for update`,
          ).get(medicineId, batchNumber) as {
            id: string
            expiry: string
            package_version_id: string | null
            base_unit: string
            mrp_basis_factor: number | null
          } | undefined

          if (batch) {
            if (String(batch.expiry).slice(0, 10) !== expiry) {
              throw new Error(
                `Line ${lineNumber}: batch ${batchNumber} of ${medicine.name} is already on the shelf expiring ${String(batch.expiry).slice(0, 10)}. Two expiries cannot share one batch number.`,
              )
            }
            if (batch.package_version_id && batch.package_version_id !== version.id) {
              throw new Error(
                `Line ${lineNumber}: batch ${batchNumber} arrived under a different package version. A changed pack is a new batch.`,
              )
            }
          } else {
            const batchId = randomUUID()
            /*
             * `mrp` is the printed figure — "₹30", with `mrp_basis_level` =
             * strip and `mrp_basis_factor` = 15 saying what the ₹30 is FOR.
             * `selling_price` and `purchase_price` stay per base unit,
             * because that is what every existing reader means by them: the
             * day book, the OTC line total, the write-off cost and the
             * stock-take variance all multiply them by a base quantity.
             *
             * A batch received before Slice 3 has a null basis factor, which
             * reads as 1 — its `mrp` was already per base unit — so the two
             * generations of row agree without either being rewritten.
             */
            await db.prepare(`insert into batches
              (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,
               received_from_supplier_id,received_at,package_version_id,package_snapshot,base_unit,
               mrp_basis_level,mrp_basis_factor,purchase_basis_level,purchase_basis_factor,status)
              values (?,?,?,?,0,?,?,?,?,?,?,?::text::jsonb,?,?,?,?,?,'active')`).run(
              batchId, medicineId, batchNumber, expiry,
              money(mrpPaise),
              money(proRata(purchasePaise, 1, purchaseBasisLevel.baseFactor)),
              money(proRata(mrpPaise, 1, mrpBasisLevel.baseFactor)),
              supplierId, isoNow(), version.id,
              JSON.stringify({ baseUnit: ladder.baseUnit, levels: ladder.levels }),
              ladder.baseUnit,
              mrpBasisLevel.levelName, mrpBasisLevel.baseFactor,
              purchaseBasisLevel.levelName, purchaseBasisLevel.baseFactor,
            )
            batch = {
              id: batchId, expiry, package_version_id: version.id,
              base_unit: ladder.baseUnit, mrp_basis_factor: mrpBasisLevel.baseFactor,
            }
          }

          const onShelf = acceptedBase + freeBase
          if (onShelf > 0) {
            await moveStock({
              batchId: batch.id, medicineId, bucket: 'available', delta: onShelf,
              movementType: 'goods_receipt', referenceType: 'goods_receipt', referenceId: receiptId,
              actorId: session.staffId,
              reason: free.length ? `${describeEntry(accepted)} received, ${describeEntry(free)} free` : '',
              packageEntry: [...accepted, ...free],
            })
          }
          if (quarantinedBase > 0) {
            await moveStock({
              batchId: batch.id, medicineId, bucket: 'quarantine', delta: quarantinedBase,
              movementType: 'goods_receipt_quarantine', referenceType: 'goods_receipt', referenceId: receiptId,
              actorId: session.staffId, reason: optional(raw, 'quarantineReason') || 'Held on arrival',
              packageEntry: quarantined,
            })
          }

          const orderLineId = optional(raw, 'purchaseOrderLineId')
          if (orderLineId) {
            const line = await db.prepare(
              `select id,order_id,medicine_id,ordered_quantity,received_quantity
                 from purchase_order_lines where id=? for update`,
            ).get(orderLineId) as {
              id: string; order_id: string; medicine_id: string
              ordered_quantity: number; received_quantity: number
            } | undefined
            if (!line) throw new Error(`Line ${lineNumber}: that order line was not found.`)
            if (purchaseOrderId && line.order_id !== purchaseOrderId) {
              throw new Error(`Line ${lineNumber}: that order line belongs to a different order.`)
            }
            if (line.medicine_id !== medicineId) {
              throw new Error(`Line ${lineNumber}: that order line is for a different medicine.`)
            }
            // Over-delivery is refused rather than absorbed: a supplier who
            // sent more than was ordered is a conversation, not a silent
            // adjustment to an order the clinic will be invoiced against.
            if (Number(line.received_quantity) + onShelf > Number(line.ordered_quantity)) {
              throw new Error(
                `Line ${lineNumber}: ${onShelf} would take the delivery past the ${line.ordered_quantity} ordered.`,
              )
            }
            await db.prepare('update purchase_order_lines set received_quantity=received_quantity+? where id=?')
              .run(onShelf, orderLineId)
          }

          await db.prepare(`insert into goods_receipt_lines
            (id,goods_receipt_id,line_number,purchase_order_line_id,medicine_id,package_version_id,
             entry_json,accepted_base_quantity,free_base_quantity,quarantined_base_quantity,
             rejected_base_quantity,rejection_reason,batch_number,expiry,
             mrp_amount,mrp_basis_level,mrp_basis_factor,
             purchase_amount,purchase_basis_level,purchase_basis_factor,
             tax_rate,tax_amount,line_total,batch_id)
            values (?,?,?,?,?,?, ?::text::jsonb, ?,?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?)`).run(
            randomUUID(), receiptId, lineNumber, orderLineId || null, medicineId, version.id,
            JSON.stringify({ accepted, free, quarantined, rejected }),
            acceptedBase, freeBase, quarantinedBase, rejectedBase, rejectionReason,
            batchNumber, expiry,
            money(mrpPaise), mrpBasisLevel.levelName, mrpBasisLevel.baseFactor,
            money(purchasePaise), purchaseBasisLevel.levelName, purchaseBasisLevel.baseFactor,
            taxRate, money(lineTax), money(lineNet + lineTax), batch.id,
          )

          totalBase += onShelf
          summaries.push(
            `${medicine.name} ${batchNumber}: ${describeEntry([...accepted, ...free])}`
            + ` = ${onShelf} ${plural(ladder.baseUnit, onShelf)}`
            + (quarantinedBase ? `, ${quarantinedBase} quarantined` : '')
            + (rejectedBase ? `, ${rejectedBase} rejected` : ''),
          )
        }

        await db.prepare('update goods_receipts set subtotal=?, tax_total=?, total=? where id=?')
          .run(money(subtotal), money(taxTotal), money(subtotal + taxTotal), receiptId)

        if (purchaseOrderId) {
          const totals = await db.prepare(
            `select coalesce(sum(ordered_quantity),0)::int ordered, coalesce(sum(received_quantity),0)::int received
               from purchase_order_lines where order_id=?`,
          ).get(purchaseOrderId) as { ordered: number; received: number }
          const status = Number(totals.received) >= Number(totals.ordered)
            ? 'delivered'
            : 'partially_delivered'
          await db.prepare('update purchase_orders set status=? where id=?').run(status, purchaseOrderId)
        }

        await audit(session.staffId, 'goods_receipt.posted', 'goods_receipt', receiptId,
          `${grnNumber} from ${supplier.name}: ${summaries.join('; ')}`)
      })

      return {
        message: `${grnNumber} received. ${totalBase} unit(s) added to the shelf.`,
        data: { goodsReceiptId: receiptId, grnNumber, baseQuantity: totalBase, lines: summaries },
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 5. STOCK THAT MOVES FOR A REASON OTHER THAN A SALE
    // ───────────────────────────────────────────────────────────────────────

    /*
     * One command for every quantity change that is not a receipt or a sale:
     * releasing quarantine, holding stock back, correcting a count, reversing
     * a movement somebody posted wrongly.
     *
     * It is a MOVE between named pools rather than a "set the quantity to".
     * Setting a quantity erases whatever happened between the count and the
     * save; moving a delta does not, and the ledger keeps both halves.
     *
     * Anything that puts stock back on the sellable shelf needs an admin. A
     * pharmacist can quarantine, hold and write down without approval —
     * refusing that would make an honest correction slower than saying
     * nothing — but only an admin can decide that held stock is fit to sell.
     */
    case 'adjust_stock': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const from = requireChoice(payload, 'from', ['available', 'quarantine', 'blocked', 'none'] as const)
      const to = requireChoice(payload, 'to', ['available', 'quarantine', 'blocked', 'none'] as const)
      const reason = value(payload, 'reason')
      const quantity = Math.floor(numberValue(payload, 'quantity', 1))
      const reverses = optional(payload, 'reversesMovementId')

      if (from === to) throw new Error('Choose two different places for the stock to move between.')
      if (from === 'none' && to === 'none') throw new Error('Choose where the stock is moving.')
      if (to === 'available') {
        requireRole(session, 'admin')
      }
      if (from === 'none') {
        // Stock appearing from nowhere is a count correction, and only an
        // admin approves one — it is indistinguishable, in the ledger, from
        // stock that was never received.
        requireRole(session, 'admin')
      }

      let summary = ''
      await transaction(async () => {
        const batch = await db.prepare(
          `select b.id,b.medicine_id,b.batch_number,b.status,b.base_unit,m.name
             from batches b join medicines m on m.id=b.medicine_id where b.id=? for update`,
        ).get(batchId) as {
          id: string; medicine_id: string; batch_number: string
          status: string; base_unit: string; name: string
        } | undefined
        if (!batch) throw new Error('That batch was not found.')

        if (to === 'available' && batch.status !== 'active') {
          throw new Error(`Batch ${batch.batch_number} is ${batch.status}. It cannot go back on the sellable shelf.`)
        }

        if (reverses) {
          const original = await db.prepare('select id,batch_id from stock_movements where id=?')
            .get(reverses) as { id: string; batch_id: string } | undefined
          if (!original) throw new Error('The movement being reversed was not found.')
          if (original.batch_id !== batchId) throw new Error('That movement belongs to a different batch.')
        }

        // The admin who authorized this is recorded on the movement itself
        // whenever the move is one only an admin may make, so a report can
        // answer "who let this back onto the shelf" without joining audit.
        const approvedBy = to === 'available' || from === 'none' ? session.staffId : null

        if (from !== 'none') {
          await moveStock({
            batchId, medicineId: batch.medicine_id, bucket: from, delta: -quantity,
            movementType: `adjust_out_${from}`, referenceType: 'adjustment', referenceId: batchId,
            actorId: session.staffId, reason, approvedBy, reverses: reverses || null,
          })
        }
        if (to !== 'none') {
          await moveStock({
            batchId, medicineId: batch.medicine_id, bucket: to, delta: quantity,
            movementType: `adjust_in_${to}`, referenceType: 'adjustment', referenceId: batchId,
            actorId: session.staffId, reason, approvedBy, reverses: reverses || null,
          })
        }

        summary = `${quantity} ${plural(batch.base_unit || 'unit', quantity)} of ${batch.name} ${batch.batch_number}`
          + ` moved ${from === 'none' ? 'in to' : `from ${from} to`} ${to === 'none' ? 'out of stock' : to}: ${reason}`
        await audit(session.staffId, 'stock.adjusted', 'batch', batchId, summary)
      })
      return { message: 'Stock adjustment recorded.', data: { summary } }
    }

    /*
     * A recall, a block, or lifting one.
     *
     * A batch flag rather than a quantity move: a recalled lot is still
     * physically present and still has to be counted, it simply may not be
     * picked. Moving its quantity somewhere would make the shelf and the
     * ledger disagree with the boxes on the shelf.
     */
    case 'set_batch_status': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const status = requireChoice(payload, 'status', ['active', 'recalled', 'blocked'] as const)
      const reason = value(payload, 'reason')
      if (status === 'active') requireRole(session, 'admin')

      await transaction(async () => {
        const batch = await db.prepare(
          `select b.id,b.batch_number,b.status,m.name from batches b
             join medicines m on m.id=b.medicine_id where b.id=? for update`,
        ).get(batchId) as { id: string; batch_number: string; status: string; name: string } | undefined
        if (!batch) throw new Error('That batch was not found.')
        if (batch.status === status) throw new Error(`That batch is already ${status}.`)

        await db.prepare(
          'update batches set status=?, status_reason=?, status_changed_by=?, status_changed_at=now() where id=?',
        ).run(status, reason, session.staffId, batchId)
        await audit(session.staffId, `batch.${status}`, 'batch', batchId,
          `${batch.name} ${batch.batch_number} marked ${status}: ${reason}`)
      })
      return {
        message: status === 'active'
          ? 'Batch released for dispensing.'
          : `Batch marked ${status}. It can no longer be picked.`,
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 6. THE BLIND OPENING COUNT
    // ───────────────────────────────────────────────────────────────────────

    case 'start_opening_count': {
      requireRole(session, 'admin', 'pharmacy')
      const id = randomUUID()
      let reference = ''
      await transaction(async () => {
        reference = await sequence('OC')
        await db.prepare(`insert into opening_counts
          (id,reference,status,cutoff_at,note,started_by,started_at)
          values (?,?, 'counting', now(), ?, ?, now())`).run(
          id, reference, optional(payload, 'note'), session.staffId,
        )
        await audit(session.staffId, 'opening_count.started', 'opening_count', id,
          `Opening count ${reference} started`)
      })
      return {
        message: `Opening count ${reference} started. Count the shelf; the expected figures stay hidden until you submit.`,
        data: { openingCountId: id, reference },
      }
    }

    /*
     * One counted batch.
     *
     * Nothing in the response, the snapshot or this table tells the counter
     * what the software expected. That is not a UI decision that could be
     * undone by a later screen: `expected_base_quantity` is NULL until the
     * count is submitted, so the number does not exist to be leaked.
     */
    case 'record_opening_count': {
      requireRole(session, 'admin', 'pharmacy')
      const batchId = value(payload, 'batchId')
      const entries = packageEntries(payload.entry, 'count')
      const flat = optionalPositiveInteger(payload, 'baseQuantity')
      const zeroed = booleanValue(payload, 'countedZero')

      let counted = 0
      let describe = ''
      await transaction(async () => {
        const count = await db.prepare(
          `select id,reference,status from opening_counts
            where status in ('counting','recount') order by started_at desc limit 1 for update`,
        ).get() as { id: string; reference: string; status: string } | undefined
        if (!count) throw new Error('No opening count is open. Start one first.')

        const batch = await db.prepare(
          `select b.id,b.medicine_id,b.base_unit,b.batch_number,b.package_snapshot,m.name
             from batches b join medicines m on m.id=b.medicine_id where b.id=?`,
        ).get(batchId) as {
          id: string; medicine_id: string; base_unit: string; batch_number: string
          package_snapshot: unknown; name: string
        } | undefined
        if (!batch) throw new Error('That batch was not found.')

        if (entries.length > 0) {
          const ladder = ladderOfBatch(batch)
          if (!ladder) {
            throw new Error(
              `${batch.name} ${batch.batch_number} has no recorded package, so it can only be counted in ${plural(batch.base_unit || 'unit', 2)}.`,
            )
          }
          counted = baseQuantityOf(ladder, entries, { require: 'any' })
          describe = describeEntry(entries)
        } else if (flat !== undefined) {
          counted = flat
          describe = `${flat} ${plural(batch.base_unit || 'unit', flat)}`
        } else if (zeroed) {
          // "Counted zero" and "not counted" are different facts, and the more
          // important of the two is the one a partial count would otherwise
          // lose. It has to be said explicitly.
          counted = 0
          describe = 'none on the shelf'
        } else {
          throw new Error('Enter what you counted, or mark the batch as counted zero.')
        }

        const previous = await db.prepare(
          'select coalesce(max(attempt),0)::int as attempt from opening_count_entries where opening_count_id=? and batch_id=?',
        ).get(count.id, batchId) as { attempt: number }
        const attempt = count.status === 'recount' ? Number(previous.attempt) + 1 : Math.max(1, Number(previous.attempt))

        await db.prepare(`insert into opening_count_entries
          (id,opening_count_id,batch_id,medicine_id,attempt,entry_json,counted_base_quantity,counted_by,counted_at)
          values (?,?,?,?,?,?::text::jsonb,?,?,now())
          on conflict (opening_count_id,batch_id,attempt) do update set
            entry_json=excluded.entry_json,
            counted_base_quantity=excluded.counted_base_quantity,
            counted_by=excluded.counted_by,
            counted_at=excluded.counted_at`).run(
          randomUUID(), count.id, batchId, batch.medicine_id, attempt,
          JSON.stringify({ entries, describe }), counted, session.staffId,
        )
      })
      return { message: `Counted ${describe}.`, data: { countedBaseQuantity: counted } }
    }

    /*
     * Submit the count. This is the moment the expected figures are written —
     * and therefore the first moment anybody could see them.
     */
    case 'submit_opening_count': {
      requireRole(session, 'admin', 'pharmacy')
      let reference = ''
      let counted = 0
      let variances = 0
      await transaction(async () => {
        const count = await db.prepare(
          `select id,reference,status from opening_counts where status in ('counting','recount')
            order by started_at desc limit 1 for update`,
        ).get() as { id: string; reference: string; status: string } | undefined
        if (!count) throw new Error('No opening count is open.')
        reference = count.reference

        const entries = await db.prepare(
          `select e.id,e.batch_id,e.counted_base_quantity,e.attempt,
                  b.available_quantity,b.purchase_price
             from opening_count_entries e join batches b on b.id=e.batch_id
            where e.opening_count_id=? and e.expected_base_quantity is null`,
        ).all(count.id) as Array<{
          id: string; batch_id: string; counted_base_quantity: number
          attempt: number; available_quantity: number; purchase_price: string
        }>
        if (entries.length === 0) throw new Error('Nothing has been counted yet.')

        for (const entry of entries) {
          const expected = Number(entry.available_quantity)
          const variance = Number(entry.counted_base_quantity) - expected
          const cost = parseMoney(entry.purchase_price, 'cost')
          await db.prepare(`update opening_count_entries
            set expected_base_quantity=?, variance=?, variance_value=?
            where id=?`).run(expected, variance, money(times(cost, Math.abs(variance))), entry.id)
          counted += 1
          if (variance !== 0) variances += 1
        }

        await db.prepare(
          `update opening_counts set status='submitted', submitted_by=?, submitted_at=now() where id=?`,
        ).run(session.staffId, count.id)
        await audit(session.staffId, 'opening_count.submitted', 'opening_count', count.id,
          `${reference}: ${counted} batch(es) counted, ${variances} variance(s)`)
      })
      return {
        message: `${reference} submitted. ${variances} of ${counted} counted batches differ from the record.`,
        data: { counted, variances },
      }
    }

    /*
     * The admin's decision on one variance.
     *
     * Approving does NOT post the adjustment. Posting happens once, when the
     * whole count is approved, so a half-reviewed count cannot leave the shelf
     * half-corrected.
     */
    case 'review_opening_count_entry': {
      requireRole(session, 'admin')
      const entryId = value(payload, 'entryId')
      const decision = requireChoice(payload, 'decision', ['approve', 'recount', 'reject'] as const)
      const note = optional(payload, 'note')
      if (decision !== 'approve' && !note) throw new Error('Say why, so the pharmacist knows what to look at.')

      await transaction(async () => {
        const entry = await db.prepare(
          `select e.id,e.opening_count_id,e.variance,c.status
             from opening_count_entries e join opening_counts c on c.id=e.opening_count_id
            where e.id=? for update`,
        ).get(entryId) as { id: string; opening_count_id: string; variance: number; status: string } | undefined
        if (!entry) throw new Error('That counted line was not found.')
        if (entry.status !== 'submitted') throw new Error('That count is not waiting for review.')

        await db.prepare(`update opening_count_entries
          set resolution=?, reviewed_by=?, reviewed_at=now(), review_note=? where id=?`).run(
          decision === 'recount' ? 'recount_requested' : decision === 'reject' ? 'rejected' : 'approved',
          session.staffId, note, entryId,
        )
        if (decision === 'recount') {
          await db.prepare(`update opening_counts set status='recount' where id=?`).run(entry.opening_count_id)
        }
        await audit(session.staffId, `opening_count.${decision}`, 'opening_count_entry', entryId,
          `Variance ${entry.variance} ${decision}${note ? `: ${note}` : ''}`)
      })
      return {
        message: decision === 'recount'
          ? 'Recount requested. The pharmacist counts that batch again.'
          : decision === 'reject'
            ? 'Line rejected. The record is left as it stands.'
            : 'Variance approved. It posts when the whole count is approved.',
      }
    }

    case 'approve_opening_count': {
      requireRole(session, 'admin')
      let reference = ''
      let posted = 0
      await transaction(async () => {
        const count = await db.prepare(
          `select id,reference,status from opening_counts where status='submitted'
            order by started_at desc limit 1 for update`,
        ).get() as { id: string; reference: string; status: string } | undefined
        if (!count) throw new Error('No submitted opening count is waiting for approval.')
        reference = count.reference

        const pending = await db.prepare(
          `select count(*)::int as count from opening_count_entries
            where opening_count_id=? and resolution='pending' and variance <> 0`,
        ).get(count.id) as { count: number }
        if (Number(pending.count) > 0) {
          throw new Error(`${pending.count} variance(s) have not been reviewed yet.`)
        }

        // Only the newest attempt for each batch counts: a recounted batch has
        // two rows and the earlier one is the reason there is a second.
        const approved = await db.prepare(
          `select distinct on (e.batch_id) e.id,e.batch_id,e.medicine_id,e.variance,e.counted_base_quantity
             from opening_count_entries e
            where e.opening_count_id=? and e.resolution='approved' and e.variance <> 0
            order by e.batch_id, e.attempt desc`,
        ).all(count.id) as Array<{
          id: string; batch_id: string; medicine_id: string
          variance: number; counted_base_quantity: number
        }>

        for (const entry of approved) {
          const variance = Number(entry.variance)
          await moveStock({
            batchId: entry.batch_id, medicineId: entry.medicine_id, bucket: 'available',
            delta: variance,
            movementType: 'opening_count', referenceType: 'opening_count', referenceId: count.id,
            actorId: session.staffId, approvedBy: session.staffId,
            reason: `Opening count ${reference}: counted ${entry.counted_base_quantity}`,
          })
          posted += 1
        }

        await db.prepare(
          `update opening_counts set status='approved', approved_by=?, approved_at=now() where id=?`,
        ).run(session.staffId, count.id)
        await audit(session.staffId, 'opening_count.approved', 'opening_count', count.id,
          `${reference} approved; ${posted} adjustment(s) posted`)
      })
      return {
        message: `${reference} approved. ${posted} opening adjustment(s) posted to the ledger.`,
        data: { posted },
      }
    }

    case 'abandon_opening_count': {
      requireRole(session, 'admin')
      const reason = value(payload, 'reason')
      await transaction(async () => {
        const count = await db.prepare(
          `select id,reference from opening_counts where status in ('counting','submitted','recount')
            order by started_at desc limit 1 for update`,
        ).get() as { id: string; reference: string } | undefined
        if (!count) throw new Error('No opening count is open.')
        await db.prepare(
          `update opening_counts set status='abandoned', abandoned_by=?, abandoned_at=now(), note=? where id=?`,
        ).run(session.staffId, reason, count.id)
        await audit(session.staffId, 'opening_count.abandoned', 'opening_count', count.id,
          `${count.reference} abandoned: ${reason}`)
      })
      return { message: 'Opening count abandoned. Nothing was posted; the counts are kept.' }
    }

    /*
     * The counter's own commands — dispensing, OTC, billing and payment — live
     * in counter.ts for the same reason these live here: they are a third of
     * the command surface, they share almost nothing with the formulary, and a
     * file every slice edits is a file every slice conflicts in.
     */
    default:
      return runCounterCommand(session, action, payload)
  }
}

/** Re-exported so the on-demand inventory endpoint can decompose a batch. */
export { decompose, describeEntry, describeLadder, ladderFromRows, rupees, sumMoney }
