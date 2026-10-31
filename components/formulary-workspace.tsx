'use client'

import { useMemo, useState, type FormEvent } from 'react'
import type {
  BatchView,
  ClinicSnapshot,
  MedicineView,
  PackageLevelView,
  PackageVersionView,
} from '@/lib/types'
import { useBusy, useSelectedPatient, type ActionRunner } from './clinic-context'
import { Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckRow,
  ConfirmButton,
  DWELL_MAJOR,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  Input,
  Modal,
  Notice,
  PageHeader,
  SectionHeader,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TaskFailure,
  TaskResult,
  Textarea,
  formatDate,
  formatExpiry,
  money,
  useTask,
  words,
} from '@/components/ui'

/**
 * Slice 3's three shelf screens: what a medicine IS, what it arrives in, and
 * counting what is actually there.
 *
 * Everything here is a view over commands that already exist and already
 * refuse. Nothing on this page is an authorization boundary — the server
 * decides — so where a role cannot act the control is not offered, and where
 * it is offered and the server still refuses, the refusal is shown in the
 * server's own words rather than translated into a shrug.
 *
 * The arithmetic is the one thing worth being careful about. A package ladder
 * is validated twice: once here, so Save is dark before a pharmacist can post
 * a fork or a cycle, and once on the server, which is the copy that counts.
 * The base-unit preview is computed here from the level factors the snapshot
 * already carries and sent WITH the receipt, so that if the package changed
 * between the preview and the post the server notices and refuses rather than
 * quietly posting a conversion nobody verified.
 */

/* ------------------------------------------------------------------ shared */

/** One `box`, two `boxes`. The same little rule the server prints with. */
export function plural(name: string, count: number): string {
  if (!name) return ''
  if (count === 1) return name
  return /(s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`
}

type Entry = { levelName: string; count: number }

/** Biggest package first — a box reads before a strip before a tablet. */
function topDown(levels: PackageLevelView[]): PackageLevelView[] {
  return [...levels].sort((a, b) => b.depth - a.depth)
}

function levelNamed(levels: PackageLevelView[], name: string): PackageLevelView | undefined {
  return levels.find((level) => level.levelName.toLowerCase() === name.trim().toLowerCase())
}

/** What a typed row of counts comes to in base units. */
function baseUnitsOf(levels: PackageLevelView[], entry: Entry[]): number {
  let total = 0
  for (const row of entry) {
    const level = levelNamed(levels, row.levelName)
    if (!level) continue
    total += level.baseFactor * row.count
  }
  return total
}

/** "2 boxes + 3 strips + 4 tablets". */
function describeEntry(entry: Entry[]): string {
  const parts = entry
    .filter((row) => row.count > 0)
    .map((row) => `${row.count} ${plural(row.levelName, row.count)}`)
  return parts.length === 0 ? 'nothing' : parts.join(' + ')
}

/** A typed `{ box: "2", strip: "3" }` into the shape a command takes. */
function entriesOf(counts: Record<string, string>): Entry[] {
  return Object.entries(counts)
    .map(([levelName, raw]) => ({ levelName, count: Number(raw) }))
    .filter((row) => Number.isInteger(row.count) && row.count > 0)
}

const SCHEDULE_OPTIONS = ['unset', 'OTC', 'H', 'H1', 'X', 'G', 'C', 'C1', 'other'] as const

const SYMBOLOGY_OPTIONS = [
  'unknown',
  'ean13',
  'ean8',
  'upca',
  'upce',
  'itf14',
  'gs1_128',
  'gs1_datamatrix',
  'qr',
  'code128',
  'other',
] as const

/** Only these payloads can actually carry a lot number and an expiry. */
const BATCH_CARRYING = ['gs1_128', 'gs1_datamatrix', 'qr']

/**
 * A classification nobody has made is Unknown, in words, every time it is
 * printed. An amber dot on its own tells a locum nothing, and a medicine whose
 * legal class the clinic has not established must not read as a colour.
 */
function scheduleLabel(schedule: string): string {
  switch (schedule) {
    case 'unset':
      return 'Unknown — pharmacist review required'
    case 'OTC':
      return 'OTC'
    case 'other':
      return 'Other — see the note'
    default:
      return `Schedule ${schedule}`
  }
}

function ScheduleBadge({ medicine }: { medicine: MedicineView }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={medicine.schedule === 'unset' ? 'attn' : 'plain'}>
        {scheduleLabel(medicine.schedule)}
      </Badge>
      {medicine.scheduleVerified ? <Badge tone="free">Verified</Badge> : null}
    </span>
  )
}

function medicineTitle(medicine: MedicineView): string {
  return `${medicine.brandName || medicine.name} ${medicine.strength}`.trim()
}

function medicineDetailLine(medicine: MedicineView): string {
  return [
    medicine.code,
    medicine.genericName || medicine.clinicalDrugName,
    medicine.dosageForm,
    medicine.route,
  ]
    .filter(Boolean)
    .join(' · ')
}

function packagesFor(data: ClinicSnapshot, medicineId: string): PackageVersionView[] {
  return data.packages
    .filter((version) => version.medicineId === medicineId)
    .sort((a, b) => b.version - a.version)
}

function activePackageOf(
  data: ClinicSnapshot,
  medicine: MedicineView,
): PackageVersionView | undefined {
  return data.packages.find((version) => version.id === medicine.activePackageVersionId)
}

/** How much exists in any pool at all — the base unit is frozen once it does. */
function heldOf(data: ClinicSnapshot, medicineId: string): number {
  return data.batches
    .filter((batch) => batch.medicineId === medicineId)
    .reduce(
      (total, batch) =>
        total + batch.availableQuantity + batch.quarantinedQuantity + batch.blockedQuantity,
      0,
    )
}

/** "₹30 per strip of 15" — never a naked number. Approval pack §5, price rule. */
export function mrpWithBasis(batch: BatchView): string {
  if (batch.mrpBasisFactor > 1) {
    return `${money(batch.mrp)} per ${batch.mrpBasisLevel || 'pack'} of ${batch.mrpBasisFactor}`
  }
  return `${money(batch.mrp)} per ${batch.mrpBasisLevel || batch.baseUnit || 'unit'}`
}

/* ------------------------------------------------------ the ladder, checked */

type DraftLevel = {
  key: string
  levelName: string
  levelType: string
  contains: string
  containsCount: string
  receivable: boolean
  sellable: boolean
  breakable: boolean
  minimumSaleMultiple: string
  mrpBasis: boolean
}

const MAX_LEVELS = 8
const MAX_FACTOR = 100_000_000

/**
 * The same refusals `supabase/functions/_shared/packages.ts` makes, made here
 * so that Save is dark before the tap rather than after it.
 *
 * A deliberate second copy rather than a shared import: the server's copy is
 * the one that decides, and when the two disagree the screen shows what the
 * server said, word for word. A builder that could only find out by posting
 * would teach a pharmacist to post and see.
 */
function checkLadder(baseUnit: string, rows: DraftLevel[]): { summary: string; problem?: string } {
  const unit = baseUnit.trim()
  if (!unit) return { summary: '', problem: 'Choose the unit this medicine is counted in.' }
  if (rows.length === 0) return { summary: '', problem: 'A package needs at least the base level.' }
  if (rows.length > MAX_LEVELS) {
    return { summary: '', problem: `A package may have at most ${MAX_LEVELS} levels.` }
  }

  const byName = new Map<string, DraftLevel>()
  for (const row of rows) {
    const name = row.levelName.trim()
    if (!name) return { summary: '', problem: 'Every package level needs a name.' }
    if (!row.levelType.trim()) {
      return { summary: '', problem: `Say what kind of package "${name}" is.` }
    }
    if (byName.has(name.toLowerCase())) {
      return { summary: '', problem: `"${name}" is listed twice. Each level appears once.` }
    }
    const multiple = Number(row.minimumSaleMultiple || '1')
    if (!Number.isInteger(multiple) || multiple <= 0) {
      return { summary: '', problem: `The smallest sale of "${name}" is a whole number above zero.` }
    }
    byName.set(name.toLowerCase(), { ...row, levelName: name })
  }

  const claimed = new Map<string, string>()
  for (const row of byName.values()) {
    const contains = row.contains.trim()
    if (!contains) continue
    const key = contains.toLowerCase()
    if (!byName.has(key)) {
      return {
        summary: '',
        problem: `"${row.levelName}" contains "${contains}", which is not one of the levels.`,
      }
    }
    if (key === row.levelName.toLowerCase()) {
      return { summary: '', problem: `"${row.levelName}" cannot contain itself.` }
    }
    const already = claimed.get(key)
    if (already) {
      return {
        summary: '',
        problem: `Both "${already}" and "${row.levelName}" contain "${contains}". A package is a ladder, not a fork.`,
      }
    }
    claimed.set(key, row.levelName)
    const count = Number(row.containsCount)
    if (!Number.isInteger(count) || count <= 0) {
      return {
        summary: '',
        problem: `Say how many ${contains} are in one ${row.levelName}, as a whole number above zero.`,
      }
    }
  }

  const bases = [...byName.values()].filter((row) => !row.contains.trim())
  if (bases.length === 0) {
    return {
      summary: '',
      problem:
        'Every level contains another one, so there is no smallest unit. One level must be the base.',
    }
  }
  if (bases.length > 1) {
    return {
      summary: '',
      problem: `"${bases[0].levelName}" and "${bases[1].levelName}" both contain nothing. A package has one base unit.`,
    }
  }
  if ([...byName.values()].filter((row) => row.mrpBasis).length > 1) {
    return {
      summary: '',
      problem: 'The printed MRP applies to one package level. Choose which one.',
    }
  }

  const chain: Array<{ name: string; factor: number }> = []
  let current: DraftLevel | undefined = bases[0]
  let factor = 1
  while (current) {
    chain.push({ name: current.levelName, factor })
    const parentName: string | undefined = claimed.get(current.levelName.toLowerCase())
    const parent: DraftLevel | undefined = parentName
      ? byName.get(parentName.toLowerCase())
      : undefined
    if (!parent) break
    factor *= Number(parent.containsCount)
    if (factor > MAX_FACTOR) {
      return {
        summary: '',
        problem: `One ${parent.levelName} would be ${factor} ${plural(unit, factor)}. Check the counts.`,
      }
    }
    current = parent
  }

  if (chain.length !== byName.size) {
    const reached = new Set(chain.map((row) => row.name.toLowerCase()))
    const orphan = [...byName.values()].find((row) => !reached.has(row.levelName.toLowerCase()))
    return {
      summary: '',
      problem: `"${orphan?.levelName}" does not sit above the base unit. The levels must form one chain.`,
    }
  }

  const ordered = [...chain].reverse()
  const top = ordered[0]
  if (ordered.length === 1) return { summary: `1 ${unit}` }
  const parts = [`1 ${top.name}`]
  for (const level of ordered.slice(1)) {
    const count = top.factor / level.factor
    parts.push(`${count} ${plural(level.name, count)}`)
  }
  return { summary: parts.join(' = ') }
}

function blankLevel(name = '', type = ''): DraftLevel {
  return {
    key: crypto.randomUUID(),
    levelName: name,
    levelType: type || name,
    contains: '',
    containsCount: '',
    receivable: true,
    sellable: false,
    breakable: false,
    minimumSaleMultiple: '1',
    mrpBasis: false,
  }
}

/** A saved version, opened as the starting point for the next one. */
function seedFrom(version: PackageVersionView): DraftLevel[] {
  return topDown(version.levels).map((level) => ({
    key: crypto.randomUUID(),
    levelName: level.levelName,
    levelType: level.levelType,
    contains: level.contains ?? '',
    containsCount: level.containsCount ? String(level.containsCount) : '',
    receivable: level.receivable,
    sellable: level.sellable,
    breakable: level.breakable,
    minimumSaleMultiple: String(level.minimumSaleMultiple || 1),
    mrpBasis: level.mrpBasis,
  }))
}

/* ═══════════════════════════════════════════════════════ 1. the formulary ══ */

export function FormularyPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return data.medicines
    return data.medicines.filter((medicine) =>
      `${medicine.code} ${medicine.name} ${medicine.brandName} ${medicine.genericName} ${medicine.clinicalDrugName ?? ''} ${medicine.strength} ${medicine.manufacturer}`
        .toLowerCase()
        .includes(term),
    )
  }, [data.medicines, query])

  const selected = data.medicines.find((medicine) => medicine.id === selectedId)
  const unclassified = data.medicines.filter((medicine) => medicine.schedule === 'unset').length
  const unpackaged = data.medicines.filter(
    (medicine) => medicine.active && !medicine.activePackageVersionId,
  ).length

  return (
    <Stack>
      <PageHeader
        eyebrow="Formulary"
        title="Medicines & packages"
        sub={`${data.medicines.length} medicines · ${unpackaged} without a verified package · ${unclassified} unclassified`}
      />

      {unpackaged > 0 ? (
        <Notice tone="info">
          {unpackaged} active {unpackaged === 1 ? 'medicine has' : 'medicines have'} no verified
          package, so no delivery can be received against{' '}
          {unpackaged === 1 ? 'it' : 'them'} yet. Build the ladder, then verify it against the pack
          in your hand.
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="The shelf"
            sub={`${shown.length} of ${data.medicines.length} shown`}
          />
          <CardBody className="space-y-3">
            <Field label="Find a medicine">
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Brand, generic, code or maker"
              />
            </Field>

            {shown.length === 0 ? (
              <EmptyState
                title="Nothing matches that search"
                direction="Clear the search box to see the whole formulary again."
                action={<Button onClick={() => setQuery('')}>Clear search</Button>}
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Medicine</TH>
                    <TH>Class</TH>
                    <TH num>On the shelf</TH>
                  </TR>
                </THead>
                <TBody>
                  {shown.map((medicine) => (
                    <TR
                      key={medicine.id}
                      muted={!medicine.active}
                      active={medicine.id === selectedId}
                      onClick={() => setSelectedId(medicine.id)}
                    >
                      <TD>
                        <span className="block font-semibold">{medicineTitle(medicine)}</span>
                        <span className="mt-0.5 block font-mono text-[12px] text-ink-2">
                          {medicineDetailLine(medicine)}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-ink-2">
                          {medicine.packageSummary || 'No verified package yet'}
                        </span>
                      </TD>
                      <TD>
                        <ScheduleBadge medicine={medicine} />
                      </TD>
                      <TD num>
                        <span className="font-semibold">{medicine.totalAvailable}</span>{' '}
                        <span className="text-[11px] text-ink-2">
                          {plural(medicine.baseUnit || medicine.unit, medicine.totalAvailable)}
                        </span>
                        {medicine.quarantinedQuantity > 0 ? (
                          <span className="mt-0.5 block text-[11px] text-attn">
                            {medicine.quarantinedQuantity} quarantined
                          </span>
                        ) : null}
                        {medicine.blockedQuantity > 0 ? (
                          <span className="mt-0.5 block text-[11px] text-stop">
                            {medicine.blockedQuantity} blocked
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>

        {selected ? (
          <MedicineDetail
            key={selected.id}
            data={data}
            medicine={selected}
            run={run}
            onClose={() => setSelectedId('')}
          />
        ) : (
          <Card>
            <CardBody>
              <EmptyState
                title="Choose a medicine"
                direction="Pick one from the list to set what it is, build the package it arrives in, and map the codes on the pack."
              />
            </CardBody>
          </Card>
        )}
      </div>

      <UnmappedBarcodes data={data} run={run} />
    </Stack>
  )
}

/* ------------------------------------------------------------ one medicine */

function MedicineDetail({
  data,
  medicine,
  run,
  onClose,
}: {
  data: ClinicSnapshot
  medicine: MedicineView
  run: ActionRunner
  onClose: () => void
}) {
  return (
    <div className="space-y-4">
      <Card variant="record">
        <CardHeader
          title={medicineTitle(medicine)}
          sub={medicineDetailLine(medicine)}
          action={
            <Button variant="ghost" onClick={onClose}>
              Back to the list
            </Button>
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScheduleBadge medicine={medicine} />
            <Badge tone={medicine.activePackageVersionId ? 'free' : 'attn'}>
              {medicine.activePackageVersionId ? 'Package verified' : 'No verified package'}
            </Badge>
            <Badge tone={medicine.active ? 'plain' : 'stop'}>
              {medicine.active ? 'On the formulary' : 'Withdrawn'}
            </Badge>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
            <Fact label="Counted in" value={plural(medicine.baseUnit || medicine.unit, 2)} />
            <Fact label="Clinical drug" value={medicine.clinicalDrugName ?? 'Not linked'} />
            <Fact label="Maker" value={medicine.manufacturer || 'Not recorded'} />
            <Fact label="Package" value={medicine.packageSummary || 'Not built yet'} />
            <Fact
              label="Classified from"
              value={medicine.scheduleSource || 'No source recorded'}
            />
            <Fact
              label="On the shelf"
              value={`${medicine.totalAvailable} ${plural(medicine.baseUnit || medicine.unit, medicine.totalAvailable)}`}
            />
          </dl>
        </CardBody>
      </Card>

      <IdentityForm data={data} medicine={medicine} run={run} />
      <ClassificationForm medicine={medicine} run={run} />
      <PackageVersions data={data} medicine={medicine} run={run} />
      <BarcodeForm data={data} medicine={medicine} run={run} />
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------- step A: identity */

function IdentityForm({
  data,
  medicine,
  run,
}: {
  data: ClinicSnapshot
  medicine: MedicineView
  run: ActionRunner
}) {
  const busy = useBusy()
  const [brandName, setBrandName] = useState(medicine.brandName)
  const [manufacturer, setManufacturer] = useState(medicine.manufacturer)
  const [baseUnit, setBaseUnit] = useState(medicine.baseUnit || medicine.unit)
  const [clinicalDrugId, setClinicalDrugId] = useState(medicine.clinicalDrugId ?? '')
  const [problem, setProblem] = useState('')

  const held = heldOf(data, medicine.id)

  /**
   * Every clinical drug the snapshot mentions.
   *
   * There is no catalogue endpoint — the snapshot carries a clinical drug only
   * where a product already points at one — so this list is what the clinic
   * has linked so far plus whatever is described below. Said plainly rather
   * than presented as the whole formulary.
   */
  const knownDrugs = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of data.medicines) {
      if (item.clinicalDrugId && item.clinicalDrugName) {
        map.set(item.clinicalDrugId, item.clinicalDrugName)
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [data.medicines])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProblem('')
    const result = await run('link_medicine_identity', {
      medicineId: medicine.id,
      clinicalDrugId,
      brandName,
      manufacturer,
      baseUnit,
    })
    if (!result.ok) setProblem(result.message)
  }

  return (
    <Disclosure
      label="Identity"
      hint={`${medicine.brandName || 'No brand recorded'} · ${medicine.clinicalDrugName ?? 'no clinical drug linked'} · counted in ${plural(medicine.baseUnit || medicine.unit, 2)}`}
    >
      <div className="space-y-5">
        <form onSubmit={save} className="space-y-4">
          <SectionHeader
            title="What this product is"
            sub="Clinical identity stays separate from the pack it comes in."
          />
          <FieldRow cols={2}>
            <Field label="Brand name" hint="Leave empty for an unbranded generic.">
              <Input value={brandName} onChange={(event) => setBrandName(event.target.value)} />
            </Field>
            <Field label="Manufacturer">
              <Input
                value={manufacturer}
                onChange={(event) => setManufacturer(event.target.value)}
              />
            </Field>
            <Field
              label="Stock base unit"
              hint={
                held > 0
                  ? `${held} ${plural(medicine.baseUnit || medicine.unit, held)} exist in some pool, so the base unit is fixed until the shelf is empty.`
                  : 'The smallest safe countable item: tablet, capsule, bottle, tube, ampoule, inhaler, piece.'
              }
            >
              <Input
                value={baseUnit}
                disabled={held > 0}
                onChange={(event) => setBaseUnit(event.target.value)}
              />
            </Field>
            <Field
              label="Clinical drug"
              hint="Only drugs already linked somewhere in the clinic are listed. Describe a new one below."
            >
              <Select
                value={clinicalDrugId}
                onChange={(event) => setClinicalDrugId(event.target.value)}
              >
                <option value="">Not linked</option>
                {knownDrugs.map(([id, name]) => (
                  <option value={id} key={id}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldRow>

          {problem ? (
            <Notice tone="bad" onDismiss={() => setProblem('')}>
              {problem}
            </Notice>
          ) : null}

          <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
            Save identity
          </ActionButton>
        </form>

        <ClinicalDrugBuilder medicine={medicine} run={run} />
      </div>
    </Disclosure>
  )
}

type IngredientDraft = {
  key: string
  name: string
  strengthValue: string
  strengthUnit: string
  perValue: string
  perUnit: string
}

function blankIngredient(): IngredientDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    strengthValue: '',
    strengthUnit: 'mg',
    perValue: '',
    perUnit: '',
  }
}

/**
 * Describe a clinical drug and attach this product to it.
 *
 * Three commands in a row, because the formulary has three layers and each is
 * its own row: the substance, the clinical drug built from it, and the link
 * from this shelf product to that drug. `save_substance` matches on a
 * normalized name, so typing Paracetamol twice is a match rather than a
 * second row — which is what makes running these in sequence safe to repeat
 * after a failure partway through.
 */
function ClinicalDrugBuilder({
  medicine,
  run,
}: {
  medicine: MedicineView
  run: ActionRunner
}) {
  const busy = useBusy()
  const [displayName, setDisplayName] = useState('')
  const [dosageForm, setDosageForm] = useState(medicine.dosageForm)
  const [route, setRoute] = useState(medicine.route)
  const [releaseType, setReleaseType] = useState('')
  const [ingredients, setIngredients] = useState<IngredientDraft[]>([blankIngredient()])
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')

  function update(key: string, patch: Partial<IngredientDraft>) {
    setIngredients((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const ready =
    dosageForm.trim() !== '' &&
    ingredients.length > 0 &&
    ingredients.every(
      (row) => row.name.trim() !== '' && Number(row.strengthValue) > 0 && row.strengthUnit.trim(),
    )

  async function save() {
    setProblem('')
    setDone('')

    const resolved: Array<Record<string, unknown>> = []
    for (const row of ingredients) {
      const substance = await run('save_substance', { name: row.name.trim() })
      if (!substance.ok) {
        setProblem(substance.message)
        return
      }
      const { substanceId } = substance.data as { substanceId: string }
      resolved.push({
        substanceId,
        strengthValue: Number(row.strengthValue),
        strengthUnit: row.strengthUnit.trim(),
        perValue: row.perValue.trim(),
        perUnit: row.perUnit.trim(),
      })
    }

    const drug = await run('save_clinical_drug', {
      displayName: displayName.trim(),
      dosageForm: dosageForm.trim(),
      route: route.trim(),
      releaseType: releaseType.trim(),
      ingredients: resolved,
    })
    if (!drug.ok) {
      setProblem(drug.message)
      return
    }
    const { clinicalDrugId } = drug.data as { clinicalDrugId: string }

    const link = await run('link_medicine_identity', {
      medicineId: medicine.id,
      clinicalDrugId,
    })
    if (!link.ok) {
      setProblem(link.message)
      return
    }
    setDone(`${medicineTitle(medicine)} is now linked to its clinical drug.`)
  }

  return (
    <Disclosure
      label="Describe a new clinical drug"
      hint="Ingredient, strength, dose form and route — the thing a generic prescription names"
    >
      <div className="space-y-4">
        <FieldRow cols={2}>
          <Field label="Dose form" required hint="Tablet, capsule, syrup, cream, ampoule.">
            <Input value={dosageForm} onChange={(event) => setDosageForm(event.target.value)} />
          </Field>
          <Field label="Route" hint="Oral, topical, inhaled — when it is clinically relevant.">
            <Input value={route} onChange={(event) => setRoute(event.target.value)} />
          </Field>
          <Field label="Release type" hint="Modified release, enteric coated, and so on.">
            <Input
              value={releaseType}
              onChange={(event) => setReleaseType(event.target.value)}
            />
          </Field>
          <Field
            label="Display name"
            hint="Left empty, the clinic builds one from the ingredients."
          >
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
        </FieldRow>

        <SectionHeader title="Ingredients" sub="One row per active ingredient." />
        <div className="space-y-3">
          {ingredients.map((row, index) => (
            <div key={row.key} className="border-l-2 border-ink bg-paper/40 p-3">
              <FieldRow cols={3}>
                <Field label={`Ingredient ${index + 1}`} required>
                  <Input
                    value={row.name}
                    placeholder="Paracetamol"
                    onChange={(event) => update(row.key, { name: event.target.value })}
                  />
                </Field>
                <Field label="Strength" required>
                  <Input
                    inputMode="decimal"
                    value={row.strengthValue}
                    onChange={(event) => update(row.key, { strengthValue: event.target.value })}
                  />
                </Field>
                <Field label="Strength unit" required>
                  <Input
                    value={row.strengthUnit}
                    onChange={(event) => update(row.key, { strengthUnit: event.target.value })}
                  />
                </Field>
              </FieldRow>
              <FieldRow cols={3} className="mt-3">
                <Field label="Per amount" hint="For a liquid: 125 mg per 5 mL.">
                  <Input
                    inputMode="decimal"
                    value={row.perValue}
                    onChange={(event) => update(row.key, { perValue: event.target.value })}
                  />
                </Field>
                <Field label="Per unit">
                  <Input
                    value={row.perUnit}
                    placeholder="mL"
                    onChange={(event) => update(row.key, { perUnit: event.target.value })}
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    variant="danger"
                    disabled={busy || ingredients.length === 1}
                    aria-label={`Remove ingredient ${index + 1}`}
                    onClick={() =>
                      setIngredients((rows) => rows.filter((item) => item.key !== row.key))
                    }
                  >
                    Remove
                  </Button>
                </div>
              </FieldRow>
            </div>
          ))}
          <Button
            disabled={busy}
            onClick={() => setIngredients((rows) => [...rows, blankIngredient()])}
          >
            Add another ingredient
          </Button>
        </div>

        {problem ? (
          <Notice tone="bad" onDismiss={() => setProblem('')}>
            {problem}
          </Notice>
        ) : null}
        {done ? (
          <Notice tone="good" onDismiss={() => setDone('')}>
            {done}
          </Notice>
        ) : null}

        <ActionButton
          busy={busy}
          busyLabel="Saving…"
          disabled={!ready}
          disabledReason="Every ingredient needs a name, a strength above zero and a unit, and the drug needs a dose form."
          onClick={save}
        >
          Save and link this drug
        </ActionButton>
      </div>
    </Disclosure>
  )
}

/* ------------------------------------------------- classification (schedule) */

function ClassificationForm({ medicine, run }: { medicine: MedicineView; run: ActionRunner }) {
  const busy = useBusy()
  const [schedule, setSchedule] = useState<string>(medicine.schedule)
  const [source, setSource] = useState(medicine.scheduleSource)
  const [sourceVersion, setSourceVersion] = useState('')
  const [effectiveOn, setEffectiveOn] = useState('')
  const [verified, setVerified] = useState(false)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProblem('')
    const result = await run('classify_medicine', {
      medicineId: medicine.id,
      schedule,
      source,
      sourceVersion,
      effectiveOn,
      verified,
      note,
    })
    if (!result.ok) setProblem(result.message)
  }

  return (
    <Disclosure
      label="Classification"
      hint={`${scheduleLabel(medicine.schedule)}${medicine.scheduleVerified ? ' · verified' : ' · not verified'}`}
    >
      <form onSubmit={save} className="space-y-4">
        <Notice tone="info">
          What the medicine legally is, and who says so. It is never worked out from the sale
          class: a restricted item could be Schedule H1 or Schedule X, and a register an inspector
          can fault is worse than one that admits it is incomplete.
        </Notice>

        <FieldRow cols={2}>
          <Field label="Class" required>
            <Select value={schedule} onChange={(event) => setSchedule(event.target.value)}>
              {SCHEDULE_OPTIONS.map((option) => (
                <option value={option} key={option}>
                  {scheduleLabel(option)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Where this comes from"
            required={schedule !== 'unset'}
            hint="The pack, the schedule itself, or a named reference."
          >
            <Input value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <Field label="Source version">
            <Input
              value={sourceVersion}
              onChange={(event) => setSourceVersion(event.target.value)}
            />
          </Field>
          <Field label="Effective from">
            <Input
              type="date"
              value={effectiveOn}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
          </Field>
        </FieldRow>

        <Field label="Note" hint="Required when the class is Other — say what it actually is.">
          <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        <CheckRow
          checked={verified}
          onChange={(event) => setVerified(event.target.checked)}
          label="I have checked this against the source named above"
          hint="Until somebody verifies it, the counter refuses the medicine on the anonymous over-the-counter path."
        />

        {problem ? (
          <Notice tone="bad" onDismiss={() => setProblem('')}>
            {problem}
          </Notice>
        ) : null}

        <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
          Save classification
        </ActionButton>
      </form>
    </Disclosure>
  )
}

/* ------------------------------------------- step C/D: packages and the pack */

function PackageVersions({
  data,
  medicine,
  run,
}: {
  data: ClinicSnapshot
  medicine: MedicineView
  run: ActionRunner
}) {
  const busy = useBusy()
  const versions = packagesFor(data, medicine.id)
  const [builder, setBuilder] = useState<{
    packageVersionId?: string
    baseUnit: string
    levels: DraftLevel[]
    title: string
  } | null>(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')
  const [saved, setSaved] = useState('')
  const [acting, setActing] = useState<{
    kind: 'verify' | 'retire'
    version: PackageVersionView
  } | null>(null)

  const check = builder
    ? checkLadder(builder.baseUnit, builder.levels)
    : { summary: '', problem: undefined as string | undefined }

  function startNew() {
    setProblem('')
    setSaved('')
    setNote('')
    setBuilder({
      baseUnit: medicine.baseUnit || medicine.unit,
      levels: [blankLevel(medicine.baseUnit || medicine.unit || 'unit', 'base')],
      title: 'Build the package',
    })
  }

  function startFrom(version: PackageVersionView, editing: boolean) {
    setProblem('')
    setSaved('')
    setNote('')
    setBuilder({
      packageVersionId: editing ? version.id : undefined,
      baseUnit: version.baseUnit,
      levels: seedFrom(version),
      title: editing ? `Edit draft v${version.version}` : `New version from v${version.version}`,
    })
  }

  function patch(key: string, change: Partial<DraftLevel>) {
    setBuilder((current) =>
      current
        ? {
            ...current,
            levels: current.levels.map((level) =>
              level.key === key ? { ...level, ...change } : level,
            ),
          }
        : current,
    )
  }

  async function save() {
    if (!builder) return
    setProblem('')
    setSaved('')
    const result = await run('save_package_version', {
      medicineId: medicine.id,
      baseUnit: builder.baseUnit,
      packageVersionId: builder.packageVersionId ?? '',
      note,
      levels: builder.levels.map((level) => ({
        levelName: level.levelName.trim(),
        levelType: level.levelType.trim(),
        contains: level.contains.trim(),
        containsCount: level.contains.trim() ? level.containsCount : '',
        receivable: level.receivable,
        sellable: level.sellable,
        breakable: level.breakable,
        minimumSaleMultiple: level.minimumSaleMultiple || '1',
        mrpBasis: level.mrpBasis,
      })),
    })
    if (!result.ok) {
      // The server's sentence, unedited. It knows things this screen does not —
      // that the medicine already counts in tablets, that the version being
      // edited stopped being a draft while this was open.
      setProblem(result.message)
      return
    }
    const info = result.data as { packageVersionId: string; version: number; summary: string }
    setSaved(info.summary)
    setBuilder((current) =>
      current ? { ...current, packageVersionId: info.packageVersionId } : current,
    )
  }

  return (
    <Card>
      <CardHeader
        title="Packages"
        sub={medicine.packageSummary || 'No verified package yet'}
        action={
          builder ? null : (
            <Button variant="primary" disabled={busy} onClick={startNew}>
              Build a package
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        {versions.length === 0 && !builder ? (
          <EmptyState
            title="No package has been built"
            direction="Say what one box holds, verify it against the pack in your hand, and this medicine can then receive stock."
            action={
              <Button variant="primary" disabled={busy} onClick={startNew}>
                Build a package
              </Button>
            }
          />
        ) : null}

        {versions.map((version) => {
          const isActive = version.id === medicine.activePackageVersionId
          return (
            <div key={version.id} className="border-l-2 border-ink bg-paper/40 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">Version {version.version}</p>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={version.status === 'verified' ? 'free' : 'attn'}>
                    {version.status === 'verified' ? 'Verified' : 'Draft — not yet checked'}
                  </Badge>
                  {isActive ? <Badge tone="live">Receiving against this</Badge> : null}
                </span>
              </div>
              <p className="mt-1 font-mono text-[13px]">{version.summary}</p>
              <p className="mt-1 text-[12px] text-ink-2">
                {version.status === 'verified'
                  ? `Checked against ${words(version.verificationSource) || 'a named source'} by ${version.verifiedByName ?? 'unknown'}${version.verifiedAt ? ` on ${formatDate(version.verifiedAt)}` : ''}. Verified versions are read-only.`
                  : 'A draft cannot receive stock until somebody checks it against the physical pack.'}
              </p>

              <LadderTable levels={version.levels} />

              <div className="mt-3 flex flex-wrap gap-2">
                {version.status === 'draft' ? (
                  <>
                    <Button disabled={busy} onClick={() => startFrom(version, true)}>
                      Edit the ladder
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => setActing({ kind: 'verify', version })}
                    >
                      Verify against the pack
                    </Button>
                  </>
                ) : (
                  <Button disabled={busy} onClick={() => startFrom(version, false)}>
                    Create a new version
                  </Button>
                )}
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => setActing({ kind: 'retire', version })}
                >
                  Retire
                </Button>
              </div>
            </div>
          )
        })}

        {builder ? (
          <div className="space-y-4 border-2 border-ink p-3">
            <SectionHeader
              title={builder.title}
              sub="Each level names the level directly inside it and how many of them it holds."
              action={
                <Button variant="ghost" onClick={() => setBuilder(null)}>
                  Cancel
                </Button>
              }
            />

            <Field
              label="Base unit"
              required
              hint="The smallest safe countable item. Everything the ledger moves is counted in this."
            >
              <Input
                value={builder.baseUnit}
                onChange={(event) =>
                  setBuilder((current) =>
                    current ? { ...current, baseUnit: event.target.value } : current,
                  )
                }
              />
            </Field>

            <div className="space-y-3">
              {builder.levels.map((level, index) => {
                const others = builder.levels.filter((row) => row.key !== level.key)
                const flags = [
                  level.receivable ? 'Receive' : null,
                  level.sellable ? 'Sell' : null,
                  level.breakable ? 'May be opened' : null,
                  level.mrpBasis ? 'MRP basis' : null,
                  `smallest sale ${level.minimumSaleMultiple || '1'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <div key={level.key} className="border border-rule bg-sheet p-3">
                    <FieldRow cols={2}>
                      <Field label={`Level ${index + 1} name`} required>
                        <Input
                          value={level.levelName}
                          placeholder="box"
                          onChange={(event) =>
                            patch(level.key, { levelName: event.target.value })
                          }
                        />
                      </Field>
                      <Field
                        label="Kind of package"
                        required
                        hint="Any word the clinic uses — tray, pouch, kit, case."
                      >
                        <Input
                          value={level.levelType}
                          onChange={(event) =>
                            patch(level.key, { levelType: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Contains">
                        <Select
                          value={level.contains}
                          onChange={(event) => patch(level.key, { contains: event.target.value })}
                        >
                          <option value="">Nothing — this is the base</option>
                          {others
                            .filter((row) => row.levelName.trim())
                            .map((row) => (
                              <option value={row.levelName} key={row.key}>
                                {row.levelName}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Field
                        label="How many"
                        required={Boolean(level.contains.trim())}
                        hint={
                          level.contains.trim()
                            ? `How many ${plural(level.contains.trim(), 2)} are in one ${level.levelName || 'level'}.`
                            : 'Only a level that contains another one needs a count.'
                        }
                      >
                        <Input
                          inputMode="numeric"
                          value={level.containsCount}
                          disabled={!level.contains.trim()}
                          onChange={(event) =>
                            patch(level.key, { containsCount: event.target.value })
                          }
                        />
                      </Field>
                    </FieldRow>

                    <div className="mt-3">
                      <Disclosure label="What may be done at this level" hint={flags}>
                        <div className="space-y-2">
                          <CheckRow
                            checked={level.receivable}
                            onChange={(event) =>
                              patch(level.key, { receivable: event.target.checked })
                            }
                            label="Deliveries may be counted at this level"
                          />
                          <CheckRow
                            checked={level.sellable}
                            onChange={(event) =>
                              patch(level.key, { sellable: event.target.checked })
                            }
                            label="The counter may sell at this level"
                          />
                          <CheckRow
                            checked={level.breakable}
                            onChange={(event) =>
                              patch(level.key, { breakable: event.target.checked })
                            }
                            label="One of these may be opened"
                            hint="False for a sealed bottle, vial or inhaler."
                          />
                          <CheckRow
                            checked={level.mrpBasis}
                            onChange={(event) =>
                              patch(level.key, { mrpBasis: event.target.checked })
                            }
                            label="The printed MRP is for one of these"
                            hint="Exactly one level in a package carries the printed price."
                          />
                          <Field label="Smallest sale" hint="Sold in multiples of this.">
                            <Input
                              inputMode="numeric"
                              value={level.minimumSaleMultiple}
                              onChange={(event) =>
                                patch(level.key, { minimumSaleMultiple: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                      </Disclosure>
                    </div>

                    <div className="mt-3">
                      <Button
                        variant="danger"
                        disabled={busy || builder.levels.length === 1}
                        title="A package needs at least the base level."
                        aria-label={`Remove level ${index + 1}`}
                        onClick={() =>
                          setBuilder((current) =>
                            current
                              ? {
                                  ...current,
                                  levels: current.levels.filter((row) => row.key !== level.key),
                                }
                              : current,
                          )
                        }
                      >
                        Remove this level
                      </Button>
                    </div>
                  </div>
                )
              })}

              <Button
                disabled={busy}
                onClick={() =>
                  setBuilder((current) =>
                    current ? { ...current, levels: [...current.levels, blankLevel()] } : current,
                  )
                }
              >
                Add a level
              </Button>
            </div>

            <Field label="Note" hint="What changed, and why — kept on the version.">
              <Input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>

            {check.problem ? (
              <Notice tone="bad">{check.problem}</Notice>
            ) : (
              <Notice tone="info">
                This package reads: <span className="font-mono">{check.summary}</span>
              </Notice>
            )}

            {problem ? (
              <Notice tone="bad" onDismiss={() => setProblem('')}>
                {problem}
              </Notice>
            ) : null}
            {saved ? (
              <Notice tone="good" onDismiss={() => setSaved('')}>
                Saved. The clinic&rsquo;s record now reads:{' '}
                <span className="font-mono">{saved}</span>. Verify it against the physical pack
                before receiving stock against it.
              </Notice>
            ) : null}

            <ActionButton
              variant="primary"
              busy={busy}
              busyLabel="Saving…"
              disabled={Boolean(check.problem)}
              disabledReason={check.problem}
              onClick={save}
            >
              Save the draft
            </ActionButton>
          </div>
        ) : null}
      </CardBody>

      <VersionAction
        key={acting ? `${acting.kind}-${acting.version.id}` : 'none'}
        acting={acting}
        run={run}
        onClose={() => setActing(null)}
      />
    </Card>
  )
}

function LadderTable({ levels }: { levels: PackageLevelView[] }) {
  if (levels.length === 0) return null
  return (
    <div className="mt-2">
      <Table>
        <THead>
          <TR>
            <TH>Level</TH>
            <TH>Kind</TH>
            <TH>Contains</TH>
            <TH num>Base units</TH>
            <TH>May</TH>
          </TR>
        </THead>
        <TBody>
          {topDown(levels).map((level) => (
            <TR key={level.levelName}>
              <TD>
                <span className="font-semibold">{level.levelName}</span>
              </TD>
              <TD className="text-ink-2">{level.levelType}</TD>
              <TD className="text-ink-2">
                {level.contains
                  ? `${level.containsCount} ${plural(level.contains, level.containsCount ?? 2)}`
                  : 'Nothing — the base'}
              </TD>
              <TD num>{level.baseFactor}</TD>
              <TD className="text-[12px] text-ink-2">
                {[
                  level.receivable ? 'receive' : null,
                  level.sellable ? 'sell' : null,
                  level.breakable ? 'open' : null,
                  level.mrpBasis ? 'carry the MRP' : null,
                ]
                  .filter(Boolean)
                  .join(', ') || 'nothing on its own'}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  )
}

/** Verifying a draft against the pack, or retiring a version. Both need words. */
function VersionAction({
  acting,
  run,
  onClose,
}: {
  acting: { kind: 'verify' | 'retire'; version: PackageVersionView } | null
  run: ActionRunner
  onClose: () => void
}) {
  const busy = useBusy()
  const [source, setSource] = useState('physical_pack')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')

  const verifying = acting?.kind === 'verify'
  const blocked = verifying
    ? source === 'other' && note.trim() === ''
      ? 'Say what was checked.'
      : undefined
    : note.trim() === ''
      ? 'Say why this version is being retired.'
      : undefined

  async function commit() {
    if (!acting) return
    setProblem('')
    const result = verifying
      ? await run('verify_package_version', {
          packageVersionId: acting.version.id,
          verificationSource: source,
          verificationNote: note,
        })
      : await run('retire_package_version', {
          packageVersionId: acting.version.id,
          reason: note,
        })
    if (result.ok) onClose()
    else setProblem(result.message)
  }

  return (
    <Modal
      open={acting !== null}
      onClose={onClose}
      title={verifying ? 'Verify against the pack' : 'Retire this package version'}
      sub={acting ? `Version ${acting.version.version} · ${acting.version.summary}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant={verifying ? 'primary' : 'danger'}
            busy={busy}
            busyLabel="Saving…"
            disabled={Boolean(blocked)}
            disabledReason={blocked}
            onClick={commit}
          >
            {verifying ? 'Verify' : 'Retire it'}
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        {verifying ? (
          <>
            <Notice tone="info">
              Stock cannot be received against a conversion nobody has checked. Hold the pack,
              count what is in it, then say where the figure came from.
            </Notice>
            <Field label="What was checked" required>
              <Select value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="physical_pack">The physical pack</option>
                <option value="supplier_invoice">The supplier invoice</option>
                <option value="manufacturer_data">Manufacturer data</option>
                <option value="other">Another named source</option>
              </Select>
            </Field>
            <Field
              label="Note"
              required={source === 'other'}
              hint="Required when the source is something else."
            >
              <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Notice tone="info">
              Existing batches keep the conversion they arrived with. Retiring only stops new stock
              being received against this version.
            </Notice>
            <Field label="Reason" required>
              <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
          </>
        )}
        {problem ? (
          <Notice tone="bad" onDismiss={() => setProblem('')}>
            {problem}
          </Notice>
        ) : null}
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------------- barcodes */

function BarcodeForm({
  data,
  medicine,
  run,
}: {
  data: ClinicSnapshot
  medicine: MedicineView
  run: ActionRunner
}) {
  const busy = useBusy()
  const active = activePackageOf(data, medicine)
  const [code, setCode] = useState('')
  const [levelName, setLevelName] = useState('')
  const [symbology, setSymbology] = useState('unknown')
  const [carriesBatch, setCarriesBatch] = useState(false)
  const [problem, setProblem] = useState('')

  const canCarryBatch = BATCH_CARRYING.includes(symbology)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProblem('')
    const result = await run('map_barcode', {
      medicineId: medicine.id,
      levelName: levelName || active?.levels[0]?.levelName || '',
      code,
      symbology,
      carriesBatch: carriesBatch && canCarryBatch,
    })
    if (result.ok) setCode('')
    else setProblem(result.message)
  }

  return (
    <Disclosure
      label="Barcodes"
      hint={
        active
          ? `Map a code on the pack to one level of ${active.summary}`
          : 'A verified package is needed before a code can mean a level'
      }
    >
      {!active ? (
        <Notice tone="info">
          A code identifies a package level, so this medicine needs a verified package first.
          Build one above and verify it against the pack.
        </Notice>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <Notice tone="info">
            A plain barcode names the pack, not the lot. Batch and expiry live in GS1 application
            identifiers, which only a GS1-128, DataMatrix or QR payload carries. Codes already
            mapped are not listed back here — the clinic snapshot does not carry them yet.
          </Notice>

          <FieldRow cols={2}>
            <Field label="Code" required>
              <Input
                value={code}
                inputMode="numeric"
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Field label="One of these" required hint="What one scan of this code means.">
              <Select
                value={levelName || active.levels[0]?.levelName || ''}
                onChange={(event) => setLevelName(event.target.value)}
              >
                {topDown(active.levels).map((level) => (
                  <option value={level.levelName} key={level.levelName}>
                    {level.levelName} ({level.baseFactor}{' '}
                    {plural(active.baseUnit, level.baseFactor)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Symbology">
              <Select
                value={symbology}
                onChange={(event) => setSymbology(event.target.value)}
              >
                {SYMBOLOGY_OPTIONS.map((option) => (
                  <option value={option} key={option}>
                    {words(option)}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldRow>

          <CheckRow
            checked={carriesBatch && canCarryBatch}
            disabled={!canCarryBatch}
            onChange={(event) => setCarriesBatch(event.target.checked)}
            label="This payload carries the batch and expiry"
            hint={
              canCarryBatch
                ? 'Only tick this when the scanned payload really contains a lot number and an expiry.'
                : 'A plain barcode cannot carry a batch. Choose GS1-128, DataMatrix or QR first.'
            }
          />

          {problem ? (
            <Notice tone="bad" onDismiss={() => setProblem('')}>
              {problem}
            </Notice>
          ) : null}

          <ActionButton
            type="submit"
            busy={busy}
            busyLabel="Mapping…"
            disabled={code.trim() === ''}
            disabledReason="Scan or type the code first."
          >
            Map this code
          </ActionButton>
        </form>
      )}
    </Disclosure>
  )
}

/** The queue of codes a scanner met and nobody has explained yet. */
function UnmappedBarcodes({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const [mapping, setMapping] = useState<{ code: string; symbology: string } | null>(null)
  const [newCode, setNewCode] = useState('')

  const receivable = data.medicines.filter((medicine) => medicine.activePackageVersionId)

  return (
    <Card>
      <CardHeader
        title="Codes nobody has mapped"
        sub={`${data.unmappedBarcodes.length} waiting`}
      />
      <CardBody className="space-y-3">
        {data.unmappedBarcodes.length === 0 ? (
          <EmptyState
            title="Every code scanned so far is understood"
            direction="A scan the clinic does not recognise is recorded here rather than swallowed, so somebody can map it later."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Code</TH>
                <TH>Symbology</TH>
                <TH num>Times seen</TH>
                <TH num>Last seen</TH>
                <TH>Map</TH>
              </TR>
            </THead>
            <TBody>
              {data.unmappedBarcodes.map((row) => (
                <TR key={row.code}>
                  <TD num>{row.code}</TD>
                  <TD className="text-ink-2">{words(row.symbology)}</TD>
                  <TD num>{row.seenCount}</TD>
                  <TD num>{formatDate(row.lastSeenAt)}</TD>
                  <TD>
                    <Button
                      size="sm"
                      disabled={busy || receivable.length === 0}
                      onClick={() => setMapping({ code: row.code, symbology: row.symbology })}
                    >
                      Map this code
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        <Disclosure
          label="Record a code the scanner did not recognise"
          hint="Puts it in this queue so an admin can map it later"
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Code" className="min-w-[200px] flex-1">
              <Input
                value={newCode}
                inputMode="numeric"
                spellCheck={false}
                onChange={(event) => setNewCode(event.target.value)}
              />
            </Field>
            <ActionButton
              busy={busy}
              busyLabel="Recording…"
              disabled={newCode.trim() === ''}
              disabledReason="Type the code first."
              onClick={async () => {
                const result = await run('record_unknown_barcode', { code: newCode })
                if (result.ok) setNewCode('')
              }}
            >
              Record it
            </ActionButton>
          </div>
        </Disclosure>
      </CardBody>

      <MapUnknown
        key={mapping?.code ?? 'none'}
        mapping={mapping}
        medicines={receivable}
        packages={data.packages}
        run={run}
        onClose={() => setMapping(null)}
      />
    </Card>
  )
}

function MapUnknown({
  mapping,
  medicines,
  packages,
  run,
  onClose,
}: {
  mapping: { code: string; symbology: string } | null
  medicines: MedicineView[]
  packages: PackageVersionView[]
  run: ActionRunner
  onClose: () => void
}) {
  const busy = useBusy()
  const [medicineId, setMedicineId] = useState(medicines[0]?.id ?? '')
  const [levelName, setLevelName] = useState('')
  const [symbology, setSymbology] = useState(mapping?.symbology || 'unknown')
  const [carriesBatch, setCarriesBatch] = useState(false)
  const [problem, setProblem] = useState('')

  const medicine = medicines.find((item) => item.id === medicineId)
  const active = packages.find((version) => version.id === medicine?.activePackageVersionId)
  const levels = active ? topDown(active.levels) : []
  const canCarryBatch = BATCH_CARRYING.includes(symbology)

  async function commit() {
    if (!mapping) return
    setProblem('')
    const result = await run('map_barcode', {
      medicineId,
      levelName: levelName || levels[0]?.levelName || '',
      code: mapping.code,
      symbology,
      carriesBatch: carriesBatch && canCarryBatch,
    })
    if (result.ok) onClose()
    else setProblem(result.message)
  }

  return (
    <Modal
      open={mapping !== null}
      onClose={onClose}
      title="Map this code"
      sub={mapping?.code}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            busy={busy}
            busyLabel="Mapping…"
            disabled={!medicineId || levels.length === 0}
            disabledReason="Choose a medicine that has a verified package."
            onClick={commit}
          >
            Map it
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Medicine" required>
          <Select value={medicineId} onChange={(event) => setMedicineId(event.target.value)}>
            {medicines.map((item) => (
              <option value={item.id} key={item.id}>
                {medicineTitle(item)} · {item.packageSummary}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="One of these" required>
          <Select
            value={levelName || levels[0]?.levelName || ''}
            onChange={(event) => setLevelName(event.target.value)}
          >
            {levels.map((level) => (
              <option value={level.levelName} key={level.levelName}>
                {level.levelName} ({level.baseFactor}{' '}
                {plural(active?.baseUnit ?? 'unit', level.baseFactor)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Symbology">
          <Select value={symbology} onChange={(event) => setSymbology(event.target.value)}>
            {SYMBOLOGY_OPTIONS.map((option) => (
              <option value={option} key={option}>
                {words(option)}
              </option>
            ))}
          </Select>
        </Field>
        <CheckRow
          checked={carriesBatch && canCarryBatch}
          disabled={!canCarryBatch}
          onChange={(event) => setCarriesBatch(event.target.checked)}
          label="This payload carries the batch and expiry"
          hint={
            canCarryBatch
              ? 'Only when the payload really contains a lot number and an expiry.'
              : 'A plain barcode names the pack, not the lot.'
          }
        />
        {problem ? (
          <Notice tone="bad" onDismiss={() => setProblem('')}>
            {problem}
          </Notice>
        ) : null}
      </div>
    </Modal>
  )
}

/* ═══════════════════════════════════════════════════════ 2. receiving ═════ */

type ReceiptLine = {
  key: string
  medicineId: string
  entry: Record<string, string>
  free: Record<string, string>
  quarantined: Record<string, string>
  rejected: Record<string, string>
  quarantineReason: string
  rejectionReason: string
  batchNumber: string
  expiry: string
  mrp: string
  mrpBasisLevel: string
  purchasePrice: string
  purchaseBasisLevel: string
  taxRate: string
}

function blankLine(medicineId: string): ReceiptLine {
  return {
    key: crypto.randomUUID(),
    medicineId,
    entry: {},
    free: {},
    quarantined: {},
    rejected: {},
    quarantineReason: '',
    rejectionReason: '',
    batchNumber: '',
    expiry: '',
    mrp: '',
    mrpBasisLevel: '',
    purchasePrice: '',
    purchaseBasisLevel: '',
    taxRate: '',
  }
}

/**
 * A goods receipt: what actually arrived, in the packages it arrived in.
 *
 * A purchase order does not add stock; this does. The base-unit preview is
 * computed from the package the snapshot carries and posted alongside the
 * counts, so a package that changed between opening this screen and tapping
 * the button is caught by the server rather than silently converted.
 *
 * The idempotency key is minted once per receipt and kept across failures. A
 * refused post and a retried post are the same delivery; a successful one
 * mints the next key.
 */
export function ReceivingPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const { goTo } = useSelectedPatient()

  const receivable = useMemo(
    () => data.medicines.filter((medicine) => medicine.active && medicine.activePackageVersionId),
    [data.medicines],
  )
  const blockedCount = data.medicines.filter(
    (medicine) => medicine.active && !medicine.activePackageVersionId,
  ).length

  const [supplierId, setSupplierId] = useState('')
  const [purchaseOrderId, setPurchaseOrderId] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<ReceiptLine[]>([])
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [problem, setProblem] = useState('')
  const [posted, setPosted] = useState<{ grnNumber: string; lines: string[] } | null>(null)

  const openOrders = data.orders.filter(
    (order) =>
      order.supplierId === supplierId &&
      (order.status === 'placed' || order.status === 'partially_delivered'),
  )
  const order = data.orders.find((item) => item.id === purchaseOrderId)

  function packageFor(medicineId: string): PackageVersionView | undefined {
    const medicine = data.medicines.find((item) => item.id === medicineId)
    return medicine ? activePackageOf(data, medicine) : undefined
  }

  function patch(key: string, change: Partial<ReceiptLine>) {
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)))
  }

  /** Accepted plus free — exactly what the server compares the preview against. */
  function previewOf(line: ReceiptLine): number {
    const levels = packageFor(line.medicineId)?.levels ?? []
    return (
      baseUnitsOf(levels, entriesOf(line.entry)) + baseUnitsOf(levels, entriesOf(line.free))
    )
  }

  const blocking = useMemo(() => {
    if (!supplierId) return 'Choose which supplier this delivery came from.'
    if (lines.length === 0) return 'Add at least one delivered line.'
    for (const [index, line] of lines.entries()) {
      const label = `Line ${index + 1}`
      const levels = packageFor(line.medicineId)?.levels ?? []
      if (!line.medicineId) return `${label}: choose the medicine.`
      if (levels.length === 0) return `${label}: that medicine has no verified package.`
      const total =
        previewOf(line) +
        baseUnitsOf(levels, entriesOf(line.quarantined)) +
        baseUnitsOf(levels, entriesOf(line.rejected))
      if (total <= 0) return `${label}: enter what arrived.`
      if (!line.batchNumber.trim()) return `${label}: enter the batch number.`
      if (!line.expiry) return `${label}: enter the expiry printed on the pack.`
      if (line.mrp.trim() === '' || !Number.isFinite(Number(line.mrp))) {
        return `${label}: enter the printed MRP.`
      }
      if (!line.mrpBasisLevel) return `${label}: say which package the MRP is for.`
      if (line.purchasePrice.trim() === '' || !Number.isFinite(Number(line.purchasePrice))) {
        return `${label}: enter the purchase price.`
      }
      if (!line.purchaseBasisLevel) return `${label}: say which package the purchase price is for.`
      if (entriesOf(line.rejected).length > 0 && !line.rejectionReason.trim()) {
        return `${label}: say why the rejected quantity was refused.`
      }
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, supplierId, data.medicines, data.packages])

  async function post() {
    setProblem('')
    const payloadLines = lines.map((line) => {
      const version = packageFor(line.medicineId)
      const orderLine = order?.lines.find(
        (row) => row.medicineId === line.medicineId && row.receivedQuantity < row.orderedQuantity,
      )
      const preview = previewOf(line)
      return {
        medicineId: line.medicineId,
        packageVersionId: version?.id ?? '',
        purchaseOrderLineId: orderLine?.id ?? '',
        entry: entriesOf(line.entry),
        free: entriesOf(line.free),
        quarantined: entriesOf(line.quarantined),
        quarantineReason: line.quarantineReason,
        rejected: entriesOf(line.rejected),
        rejectionReason: line.rejectionReason,
        previewBaseQuantity: preview > 0 ? preview : '',
        batchNumber: line.batchNumber,
        expiry: line.expiry,
        mrp: line.mrp,
        mrpBasisLevel: line.mrpBasisLevel,
        purchasePrice: line.purchasePrice,
        purchaseBasisLevel: line.purchaseBasisLevel,
        taxRate: line.taxRate,
      }
    })

    const result = await run('post_goods_receipt', {
      idempotencyKey,
      supplierId,
      purchaseOrderId,
      supplierInvoiceNumber: invoiceNumber,
      supplierInvoiceDate: invoiceDate,
      note,
      lines: payloadLines,
    })

    if (!result.ok) {
      // The key is kept. A refused post added nothing, and the next tap is the
      // same delivery rather than a second one.
      setProblem(result.message)
      return
    }

    const info = result.data as { grnNumber: string; lines?: string[] }
    setPosted({ grnNumber: info.grnNumber, lines: info.lines ?? [] })
    setLines([])
    setInvoiceNumber('')
    setInvoiceDate('')
    setNote('')
    setPurchaseOrderId('')
    setIdempotencyKey(crypto.randomUUID())
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Goods received"
        title="Receive boxes"
        sub={`${receivable.length} medicines can be received · a purchase order does not add stock, this does`}
      />

      {blockedCount > 0 ? (
        <Notice tone="info">
          {blockedCount} active {blockedCount === 1 ? 'medicine has' : 'medicines have'} no
          verified package and cannot be received until one exists. Build the ladder and verify it
          against the pack first.
          <span className="mt-2 block">
            <Button size="sm" disabled={busy} onClick={() => goTo('formulary')}>
              Open the formulary
            </Button>
          </span>
        </Notice>
      ) : null}

      {posted ? (
        <Notice tone="good" onDismiss={() => setPosted(null)}>
          <span className="block font-semibold">Delivery {posted.grnNumber} received.</span>
          {posted.lines.map((summary, index) => (
            <span className="mt-0.5 block font-mono text-[12px]" key={index}>
              {summary}
            </span>
          ))}
        </Notice>
      ) : null}

      <Card variant="record">
        <CardHeader
          title="This delivery"
          sub={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
        />
        <CardBody className="space-y-4">
          <FieldRow cols={4}>
            <Field label="Supplier" required>
              <Select
                value={supplierId}
                onChange={(event) => {
                  setSupplierId(event.target.value)
                  setPurchaseOrderId('')
                }}
              >
                <option value="">Choose supplier</option>
                {data.suppliers
                  .filter((supplier) => supplier.active)
                  .map((supplier) => (
                    <option value={supplier.id} key={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field
              label="Against a purchase order"
              hint="Optional. Only orders awaiting delivery are offered."
            >
              <Select
                value={purchaseOrderId}
                disabled={!supplierId}
                onChange={(event) => setPurchaseOrderId(event.target.value)}
              >
                <option value="">No order — a direct delivery</option>
                {openOrders.map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.orderNumber} · {words(row.status)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Supplier invoice number">
              <Input
                value={invoiceNumber}
                spellCheck={false}
                onChange={(event) => setInvoiceNumber(event.target.value)}
              />
            </Field>
            <Field label="Invoice date">
              <Input
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
              />
            </Field>
          </FieldRow>

          <Field label="Note" hint="Anything about this delivery worth keeping.">
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </CardBody>
      </Card>

      {lines.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Nothing on this delivery yet"
              direction="Add a line for each medicine on the invoice, count it in the packages it arrived in, and check the preview before posting."
              action={
                <Button
                  variant="primary"
                  disabled={busy || receivable.length === 0}
                  onClick={() => setLines([blankLine(receivable[0]?.id ?? '')])}
                >
                  Add the first line
                </Button>
              }
            />
          </CardBody>
        </Card>
      ) : (
        lines.map((line, index) => (
          <ReceiptLineCard
            key={line.key}
            index={index}
            line={line}
            medicines={receivable}
            version={packageFor(line.medicineId)}
            orderLine={order?.lines.find(
              (row) =>
                row.medicineId === line.medicineId && row.receivedQuantity < row.orderedQuantity,
            )}
            preview={previewOf(line)}
            onPatch={(change) => patch(line.key, change)}
            onRemove={() => setLines((rows) => rows.filter((row) => row.key !== line.key))}
          />
        ))
      )}

      {lines.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <Button
              disabled={busy || receivable.length === 0}
              onClick={() => setLines((rows) => [...rows, blankLine(receivable[0]?.id ?? '')])}
            >
              Add another line
            </Button>

            {problem ? (
              <Notice tone="bad" onDismiss={() => setProblem('')}>
                {problem}
              </Notice>
            ) : null}
            {blocking ? <Notice tone="bad">{blocking}</Notice> : null}

            <div className="flex justify-end border-t border-rule pt-3">
              <ConfirmButton
                variant="primary"
                busy={busy}
                busyLabel="Posting…"
                disabled={Boolean(blocking)}
                disabledReason={blocking}
                title="Post this goods receipt"
                question={
                  <>
                    {lines.length} {lines.length === 1 ? 'line' : 'lines'} will be added to the
                    shelf as an append-only movement, at the base-unit figures previewed on each
                    line. Stock arriving cannot be un-received — a mistake is corrected with an
                    adjustment that stays on the record.
                  </>
                }
                confirmLabel="Receive boxes"
                onConfirm={post}
              >
                Receive boxes
              </ConfirmButton>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </Stack>
  )
}

function ReceiptLineCard({
  index,
  line,
  medicines,
  version,
  orderLine,
  preview,
  onPatch,
  onRemove,
}: {
  index: number
  line: ReceiptLine
  medicines: MedicineView[]
  version?: PackageVersionView
  orderLine?: { id: string; orderedQuantity: number; receivedQuantity: number }
  preview: number
  onPatch: (change: Partial<ReceiptLine>) => void
  onRemove: () => void
}) {
  const busy = useBusy()
  const levels = version ? topDown(version.levels) : []
  const receivableLevels = levels.filter((level) => level.receivable)
  const baseUnit = version?.baseUnit ?? 'unit'

  const accepted = entriesOf(line.entry)
  const free = entriesOf(line.free)
  const quarantined = entriesOf(line.quarantined)
  const rejected = entriesOf(line.rejected)

  const quarantinedBase = baseUnitsOf(levels, quarantined)
  const rejectedBase = baseUnitsOf(levels, rejected)

  function counts(
    field: 'entry' | 'free' | 'quarantined' | 'rejected',
    levelName: string,
    value: string,
  ) {
    onPatch({ [field]: { ...line[field], [levelName]: value } } as Partial<ReceiptLine>)
  }

  function countRow(field: 'entry' | 'free' | 'quarantined' | 'rejected') {
    return (
      <FieldRow cols={4}>
        {receivableLevels.map((level) => (
          <Field
            key={level.levelName}
            label={plural(level.levelName, 2)}
            unit={`${level.baseFactor} ${plural(baseUnit, level.baseFactor)} each`}
          >
            <Input
              inputMode="numeric"
              value={line[field][level.levelName] ?? ''}
              onChange={(event) => counts(field, level.levelName, event.target.value)}
            />
          </Field>
        ))}
      </FieldRow>
    )
  }

  return (
    <Card>
      <CardHeader
        title={`Line ${index + 1}`}
        sub={version ? version.summary : 'No verified package'}
        action={
          <Button
            variant="danger"
            disabled={busy}
            aria-label={`Remove line ${index + 1}`}
            onClick={onRemove}
          >
            Remove line
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <FieldRow cols={2}>
          <Field label="Medicine" required>
            <Select
              value={line.medicineId}
              onChange={(event) =>
                onPatch({
                  medicineId: event.target.value,
                  entry: {},
                  free: {},
                  quarantined: {},
                  rejected: {},
                  mrpBasisLevel: '',
                  purchaseBasisLevel: '',
                })
              }
            >
              {medicines.map((medicine) => (
                <option value={medicine.id} key={medicine.id}>
                  {medicineTitle(medicine)} · {medicine.packageSummary}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            {orderLine ? (
              <p className="text-[13px] text-ink-2">
                Against the order: {orderLine.orderedQuantity} ordered,{' '}
                {orderLine.receivedQuantity} received so far. Over-delivery is refused.
              </p>
            ) : (
              <p className="text-[13px] text-ink-2">Not matched to an order line.</p>
            )}
          </div>
        </FieldRow>

        <div>
          <SectionHeader title="What arrived" sub="Count it in the packages it came in." />
          <div className="mt-2">{countRow('entry')}</div>
        </div>

        <Notice tone={preview > 0 ? 'info' : 'bad'}>
          {preview > 0 ? (
            <>
              {describeEntry([...accepted, ...free])} ={' '}
              <span className="font-semibold">
                {preview} {plural(baseUnit, preview)}
              </span>{' '}
              onto the shelf.
              {quarantinedBase > 0
                ? ` ${quarantinedBase} ${plural(baseUnit, quarantinedBase)} held in quarantine.`
                : ''}
              {rejectedBase > 0
                ? ` ${rejectedBase} ${plural(baseUnit, rejectedBase)} rejected and not ours.`
                : ''}
            </>
          ) : (
            'Nothing counted on this line yet.'
          )}
        </Notice>

        <FieldRow cols={4}>
          <Field label="Batch number" required>
            <Input
              value={line.batchNumber}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(event) => onPatch({ batchNumber: event.target.value })}
            />
          </Field>
          <Field label="Expiry" required hint="Printed on the pack.">
            <Input
              type="date"
              value={line.expiry}
              onChange={(event) => onPatch({ expiry: event.target.value })}
            />
          </Field>
          <Field label="Printed MRP" unit="₹" required>
            <Input
              inputMode="decimal"
              value={line.mrp}
              onChange={(event) => onPatch({ mrp: event.target.value })}
            />
          </Field>
          <Field label="That MRP is for one" required hint="₹30 per strip of 15, never a bare ₹30.">
            <Select
              value={line.mrpBasisLevel}
              onChange={(event) => onPatch({ mrpBasisLevel: event.target.value })}
            >
              <option value="">Choose the package</option>
              {levels.map((level) => (
                <option value={level.levelName} key={level.levelName}>
                  {level.levelName} ({level.baseFactor} {plural(baseUnit, level.baseFactor)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Purchase price" unit="₹" required>
            <Input
              inputMode="decimal"
              value={line.purchasePrice}
              onChange={(event) => onPatch({ purchasePrice: event.target.value })}
            />
          </Field>
          <Field label="That price is for one" required hint="As the invoice states it.">
            <Select
              value={line.purchaseBasisLevel}
              onChange={(event) => onPatch({ purchaseBasisLevel: event.target.value })}
            >
              <option value="">Choose the package</option>
              {levels.map((level) => (
                <option value={level.levelName} key={level.levelName}>
                  {level.levelName} ({level.baseFactor} {plural(baseUnit, level.baseFactor)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tax rate" unit="%">
            <Input
              inputMode="decimal"
              value={line.taxRate}
              onChange={(event) => onPatch({ taxRate: event.target.value })}
            />
          </Field>
        </FieldRow>

        <Disclosure
          label="Free, held back or refused quantity"
          hint={`Free ${describeEntry(free)} · quarantined ${describeEntry(quarantined)} · rejected ${describeEntry(rejected)}`}
        >
          <div className="space-y-4">
            <div>
              <SectionHeader
                title="Free quantity"
                sub="Goes on the shelf and is charged for at nothing."
              />
              <div className="mt-2">{countRow('free')}</div>
            </div>
            <div>
              <SectionHeader
                title="Held in quarantine"
                sub="Arrived, counted, but not sellable until an admin releases it."
              />
              <div className="mt-2">{countRow('quarantined')}</div>
              <Field label="Why it is held" className="mt-3">
                <Input
                  value={line.quarantineReason}
                  onChange={(event) => onPatch({ quarantineReason: event.target.value })}
                />
              </Field>
            </div>
            <div>
              <SectionHeader
                title="Refused"
                sub="Sent back. It never joins the shelf and is not charged for."
              />
              <div className="mt-2">{countRow('rejected')}</div>
              <Field
                label="Why it was refused"
                required={rejected.length > 0}
                className="mt-3"
              >
                <Input
                  value={line.rejectionReason}
                  onChange={(event) => onPatch({ rejectionReason: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </Disclosure>
      </CardBody>
    </Card>
  )
}

/* ═══════════════════════════════════════════ 3. the blind opening count ═══ */

/**
 * Counting the shelf for the first time, blind.
 *
 * The whole value of this screen is in what it refuses to show. While a count
 * is open the server has not written an expected figure — it is NULL until
 * submission — and this screen shows no other stock figure for the batch
 * either, because "available: 47" beside a count box is the same leak by
 * another name.
 *
 * One subtlety worth stating: during a recount the earlier attempts DO carry
 * their expected figures, because they were written when the count was
 * submitted. Nothing in the counting branch below renders a figure from an
 * entry that has one.
 */
export function OpeningCountPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const count = data.openingCount
  const isAdmin = data.session.roles.includes('admin')
  const [note, setNote] = useState('')
  const [abandoning, setAbandoning] = useState(false)
  const [reason, setReason] = useState('')

  if (!count) {
    return (
      <Stack>
        <PageHeader
          eyebrow="Opening count"
          title="Count the shelf"
          sub="A blind count, then an admin review, then one append-only correction"
        />
        <Card variant="record">
          <CardHeader
            title="Start an opening count"
            sub="Nothing is corrected until the count is submitted and approved"
          />
          <CardBody className="space-y-3">
            <Notice tone="info">
              Count after the pharmacy counter closes. The expected figures stay hidden until you
              submit — that is what makes the count evidence rather than a confirmation.
            </Notice>
            <Field label="Note" hint="What is being counted, and when the shelf stopped moving.">
              <Input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <ActionButton
              variant="primary"
              busy={busy}
              busyLabel="Opening…"
              onClick={() => run('start_opening_count', { note })}
            >
              Start opening count
            </ActionButton>
          </CardBody>
        </Card>
      </Stack>
    )
  }

  const counting = count.status === 'counting' || count.status === 'recount'

  return (
    <Stack>
      <PageHeader
        eyebrow={`${count.reference} · ${words(count.status)}`}
        title="Count the shelf"
        sub={`Started by ${count.startedByName} on ${formatDate(count.startedAt)}${count.note ? ` · ${count.note}` : ''}`}
      />

      {counting ? (
        <CountSheet data={data} run={run} />
      ) : (
        <VarianceReview data={data} run={run} isAdmin={isAdmin} />
      )}

      <Card>
        <CardHeader
          title={counting ? 'Finish the count' : 'This count'}
          sub={`${count.entries.length} lines recorded`}
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {counting ? (
              <ConfirmButton
                variant="primary"
                busy={busy}
                busyLabel="Submitting…"
                disabled={count.entries.length === 0}
                disabledReason="Nothing has been counted yet."
                title="Submit the count"
                question={
                  <>
                    The counts stop being editable and the expected figures are written for the
                    first time. Whatever differs becomes visible now — that is the point of having
                    counted blind.
                  </>
                }
                confirmLabel="Submit the count"
                onConfirm={() => run('submit_opening_count', {})}
              >
                Submit the count
              </ConfirmButton>
            ) : null}

            {isAdmin ? (
              <Button variant="danger" disabled={busy} onClick={() => setAbandoning(true)}>
                Abandon this count
              </Button>
            ) : null}
          </div>

          {!isAdmin ? (
            <Notice tone="info">
              An admin reviews the differences and approves the count. Nothing is corrected on the
              shelf until they do.
            </Notice>
          ) : null}
        </CardBody>
      </Card>

      <Modal
        open={abandoning}
        onClose={() => setAbandoning(false)}
        title="Abandon this opening count"
        sub={count.reference}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAbandoning(false)}>
              Cancel
            </Button>
            <ActionButton
              variant="danger"
              busy={busy}
              busyLabel="Abandoning…"
              disabled={reason.trim() === ''}
              disabledReason="Say why it is being abandoned."
              onClick={async () => {
                const result = await run('abandon_opening_count', { reason })
                if (result.ok) setAbandoning(false)
              }}
            >
              Abandon it
            </ActionButton>
          </>
        }
      >
        <div className="space-y-3">
          <Notice tone="info">
            Nothing is posted and the counts are kept on the record. The shelf is left exactly as
            it stands.
          </Notice>
          <Field label="Reason" required>
            <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </Stack>
  )
}

/** The blind half. No expected figure, and no other stock figure either. */
function CountSheet({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const count = data.openingCount
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<Record<string, Record<string, string>>>({})
  const [flat, setFlat] = useState<Record<string, string>>({})

  /**
   * What this round has recorded so far.
   *
   * Only entries with no expected figure on them: an earlier round's rows come
   * back from the server carrying their expected quantity and variance, and a
   * recount that can see the first answer is not a recount.
   */
  const blindCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of count?.entries ?? []) {
      if (entry.expectedBaseQuantity === null) map.set(entry.batchId, entry.countedBaseQuantity)
    }
    return map
  }, [count])

  const shelf = useMemo(() => {
    const term = search.trim().toLowerCase()
    return data.batches
      .filter(
        (batch) =>
          !term ||
          batch.medicineName.toLowerCase().includes(term) ||
          batch.batchNumber.toLowerCase().includes(term),
      )
      .sort(
        (a, b) => a.medicineName.localeCompare(b.medicineName) || a.expiry.localeCompare(b.expiry),
      )
  }, [data.batches, search])

  function levelsOf(batch: BatchView): PackageLevelView[] {
    const version = data.packages.find((row) => row.id === batch.packageVersionId)
    return version ? topDown(version.levels) : []
  }

  async function record(batch: BatchView, kind: 'entry' | 'flat' | 'zero') {
    const typed = entriesOf(entries[batch.id] ?? {})
    const payload =
      kind === 'zero'
        ? { batchId: batch.id, countedZero: true }
        : kind === 'entry'
          ? { batchId: batch.id, entry: typed }
          : { batchId: batch.id, baseQuantity: flat[batch.id] ?? '' }
    const result = await run('record_opening_count', payload)
    if (result.ok) {
      setEntries((current) => ({ ...current, [batch.id]: {} }))
      setFlat((current) => ({ ...current, [batch.id]: '' }))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Count the shelf"
        sub="Counted zero is a real answer, and the most useful one"
      />
      <CardBody className="space-y-3">
        <Notice tone="info">
          The expected figures stay hidden until you submit. No shelf quantity for a batch is shown
          on this screen at all — count the box in front of you and enter what is in it.
        </Notice>

        <Field label="Find a medicine">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or batch number"
          />
        </Field>

        {shelf.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            direction="Clear the search to see every batch on the shelf."
            action={<Button onClick={() => setSearch('')}>Clear search</Button>}
          />
        ) : (
          <div className="space-y-3">
            {shelf.map((batch) => {
              const levels = levelsOf(batch)
              const already = blindCounts.get(batch.id)
              const typed = entriesOf(entries[batch.id] ?? {})
              const typedFlat = (flat[batch.id] ?? '').trim()
              return (
                <div key={batch.id} className="border border-rule bg-sheet p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{batch.medicineName}</p>
                      <p className="font-mono text-[12px] text-ink-2">
                        Batch {batch.batchNumber} · expires {formatExpiry(batch.expiry)} ·{' '}
                        {plural(batch.baseUnit || 'unit', 2)}
                      </p>
                    </div>
                    {already !== undefined ? (
                      <Badge tone="free">
                        Counted {already} {plural(batch.baseUnit || 'unit', already)}
                      </Badge>
                    ) : (
                      <Badge tone="plain">Not counted yet</Badge>
                    )}
                  </div>

                  {levels.length > 0 ? (
                    <div className="mt-3">
                      <FieldRow cols={4}>
                        {levels.map((level) => (
                          <Field
                            key={level.levelName}
                            label={plural(level.levelName, 2)}
                            unit={`${level.baseFactor} each`}
                          >
                            <Input
                              inputMode="numeric"
                              value={entries[batch.id]?.[level.levelName] ?? ''}
                              onChange={(event) =>
                                setEntries((current) => ({
                                  ...current,
                                  [batch.id]: {
                                    ...(current[batch.id] ?? {}),
                                    [level.levelName]: event.target.value,
                                  },
                                }))
                              }
                            />
                          </Field>
                        ))}
                      </FieldRow>
                    </div>
                  ) : (
                    <p className="mt-2 text-[12px] text-ink-2">
                      This batch has no package recorded against it, so it can only be counted in{' '}
                      {plural(batch.baseUnit || 'unit', 2)}.
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Field
                      label={`Or straight in ${plural(batch.baseUnit || 'unit', 2)}`}
                      className="w-[180px]"
                      hint="None on the shelf is Counted zero, not a typed 0."
                    >
                      <Input
                        inputMode="numeric"
                        value={flat[batch.id] ?? ''}
                        onChange={(event) =>
                          setFlat((current) => ({ ...current, [batch.id]: event.target.value }))
                        }
                      />
                    </Field>
                    <ActionButton
                      busy={busy}
                      busyLabel="Saving…"
                      disabled={
                        typed.length === 0 && (typedFlat === '' || Number(typedFlat) === 0)
                      }
                      disabledReason={
                        Number(typedFlat) === 0 && typedFlat !== ''
                          ? 'None on the shelf is recorded with Counted zero, so that it reads as a fact rather than an empty box.'
                          : 'Enter what you counted, or use Counted zero.'
                      }
                      onClick={() => record(batch, typed.length > 0 ? 'entry' : 'flat')}
                    >
                      Save this count
                    </ActionButton>
                    <ConfirmButton
                      busy={busy}
                      busyLabel="Saving…"
                      title="Counted zero"
                      question={
                        <>
                          Record that there is none of batch{' '}
                          <span className="font-semibold">{batch.batchNumber}</span> on the shelf?
                          Counted zero and not counted are different facts, and this records the
                          first.
                        </>
                      }
                      confirmLabel="Counted zero"
                      onConfirm={() => record(batch, 'zero')}
                    >
                      Counted zero
                    </ConfirmButton>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** The submitted half: what differed, and what an admin decides about it. */
function VarianceReview({
  data,
  run,
  isAdmin,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  isAdmin: boolean
}) {
  const busy = useBusy()
  const count = data.openingCount
  const [deciding, setDeciding] = useState<{
    entryId: string
    decision: 'recount' | 'reject'
    label: string
  } | null>(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')

  const entries = count?.entries ?? []
  const off = entries.filter((entry) => (entry.variance ?? 0) !== 0)
  const pending = off.filter((entry) => entry.resolution === 'pending')
  const netValue = entries.reduce(
    (total, entry) =>
      total + (entry.variance !== null && entry.variance < 0 ? -1 : 1) * (entry.varianceValue ?? 0),
    0,
  )

  return (
    <>
      <Notice tone={off.length === 0 ? 'good' : 'info'}>
        {off.length === 0
          ? 'Every batch counted matched the record exactly. Approving posts nothing.'
          : `${off.length} of ${entries.length} counted batches differ from the record, at a net ${netValue < 0 ? 'loss' : 'gain'} of ${money(Math.abs(netValue))}. ${pending.length} still to review.`}
      </Notice>

      <Card>
        <CardHeader
          title="What the count found"
          sub="Expected against counted, in base units"
        />
        <CardBody>
          {entries.length === 0 ? (
            <EmptyState
              title="Nothing was counted"
              direction="Start again and record at least one batch before submitting."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Medicine</TH>
                  <TH>Batch</TH>
                  <TH num>Attempt</TH>
                  <TH num>Expected</TH>
                  <TH num>Counted</TH>
                  <TH num>Difference</TH>
                  <TH num>Value</TH>
                  <TH>Decision</TH>
                  {isAdmin ? <TH>Review</TH> : null}
                </TR>
              </THead>
              <TBody>
                {entries.map((entry) => {
                  const variance = entry.variance ?? 0
                  return (
                    <TR key={entry.id}>
                      <TD>{entry.medicineName}</TD>
                      <TD num>{entry.batchNumber}</TD>
                      <TD num>{entry.attempt}</TD>
                      <TD num>{entry.expectedBaseQuantity ?? '—'}</TD>
                      <TD num>{entry.countedBaseQuantity}</TD>
                      <TD num>
                        {variance === 0 ? (
                          <Badge tone="free">Match</Badge>
                        ) : (
                          <Badge tone="attn">
                            {variance > 0 ? 'Over by ' : 'Short by '}
                            {Math.abs(variance)}
                          </Badge>
                        )}
                      </TD>
                      <TD num>{variance === 0 ? '—' : money(entry.varianceValue ?? 0)}</TD>
                      <TD>
                        <Badge
                          tone={
                            entry.resolution === 'approved'
                              ? 'free'
                              : entry.resolution === 'rejected'
                                ? 'stop'
                                : entry.resolution === 'recount_requested'
                                  ? 'attn'
                                  : 'plain'
                          }
                        >
                          {words(entry.resolution)}
                        </Badge>
                        {entry.reviewNote ? (
                          <span className="mt-0.5 block text-[12px] text-ink-2">
                            {entry.reviewNote}
                          </span>
                        ) : null}
                      </TD>
                      {isAdmin ? (
                        <TD>
                          {variance === 0 ? (
                            <span className="text-ink-2">Nothing to decide</span>
                          ) : (
                            <span className="flex flex-wrap gap-1.5">
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  run('review_opening_count_entry', {
                                    entryId: entry.id,
                                    decision: 'approve',
                                  })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setDeciding({
                                    entryId: entry.id,
                                    decision: 'recount',
                                    label: `${entry.medicineName} ${entry.batchNumber}`,
                                  })
                                }
                              >
                                Request recount
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() =>
                                  setDeciding({
                                    entryId: entry.id,
                                    decision: 'reject',
                                    label: `${entry.medicineName} ${entry.batchNumber}`,
                                  })
                                }
                              >
                                Reject
                              </Button>
                            </span>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader
            title="Approve the count"
            sub="One append-only movement per approved difference"
          />
          <CardBody className="space-y-3">
            {problem ? (
              <Notice tone="bad" onDismiss={() => setProblem('')}>
                {problem}
              </Notice>
            ) : null}
            <ConfirmButton
              variant="primary"
              busy={busy}
              busyLabel="Approving…"
              disabled={pending.length > 0}
              disabledReason={`${pending.length} difference(s) have not been reviewed yet.`}
              title="Approve the count"
              question={
                <>
                  Every approved difference posts as an adjustment against this count, with your
                  name on it. Nothing is overwritten — the correction is applied to today&rsquo;s
                  figure, so anything dispensed since the count is preserved.
                </>
              }
              confirmLabel="Approve the count"
              onConfirm={async () => {
                const result = await run('approve_opening_count', {})
                if (!result.ok) setProblem(result.message)
              }}
            >
              Approve the count
            </ConfirmButton>
          </CardBody>
        </Card>
      ) : null}

      <Modal
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding?.decision === 'reject' ? 'Reject this line' : 'Request a recount'}
        sub={deciding?.label}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeciding(null)}>
              Cancel
            </Button>
            <ActionButton
              variant={deciding?.decision === 'reject' ? 'danger' : 'primary'}
              busy={busy}
              busyLabel="Saving…"
              disabled={note.trim() === ''}
              disabledReason="Say why, so the pharmacist knows what to look at."
              onClick={async () => {
                if (!deciding) return
                const result = await run('review_opening_count_entry', {
                  entryId: deciding.entryId,
                  decision: deciding.decision,
                  note,
                })
                if (result.ok) {
                  setDeciding(null)
                  setNote('')
                } else {
                  setProblem(result.message)
                }
              }}
            >
              {deciding?.decision === 'reject' ? 'Reject it' : 'Send it back'}
            </ActionButton>
          </>
        }
      >
        <div className="space-y-3">
          <Notice tone="info">
            {deciding?.decision === 'reject'
              ? 'The record is left exactly as it stands and nothing posts for this batch.'
              : 'The count reopens for this batch and the recount is blind again — a recount that can see the answer is not a recount.'}
          </Notice>
          <Field label="Why" required>
            <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  )
}

/* ------------------------------------------------------------- batch actions */

/**
 * Correcting a quantity, and flagging a lot.
 *
 * Shared with the Inventory station, which is where a pharmacist already is
 * when they find a box that should not be sellable. Anything that puts stock
 * back ONTO the sellable shelf, or conjures it from nowhere, is an admin
 * decision — so those options are simply absent for everybody else, and the
 * server refuses them anyway.
 */
export function BatchActions({
  batch,
  roles,
  run,
  onDone,
}: {
  batch: BatchView
  roles: ClinicSnapshot['session']['roles']
  run: ActionRunner
  onDone: () => void
}) {
  const busy = useBusy()
  const isAdmin = roles.includes('admin')

  /*
   * Moving stock between states is a consequential act.
   *
   * It is append-only and permanent — the movement stays on the ledger for
   * good — so it gets the treatment the plan asks of a consequential action:
   * the review it already had, a blocking state on the review's own surface
   * with the operation named, and a result that says exactly what moved.
   *
   * The unconfirmed case is why this is a task rather than a busy flag. An
   * answer lost on the clinic Wi-Fi used to land in `problem` reading like a
   * refusal, and `adjust_stock` carries no idempotency key — so somebody told
   * "that did not work" would press it again and move the stock twice.
   */
  const adjust = useTask()
  const [from, setFrom] = useState('available')
  const [to, setTo] = useState('quarantine')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState(batch.status)
  const [statusReason, setStatusReason] = useState('')
  const [problem, setProblem] = useState('')

  const pools = ['available', 'quarantine', 'blocked', 'none']
  const moveProblem =
    from === to
      ? 'Choose two different places for the stock to move between.'
      : from === 'none' && to === 'none'
        ? 'Choose where the stock is moving.'
        : !Number.isInteger(Number(quantity)) || Number(quantity) < 1
          ? 'Enter a whole number of base units, at least one.'
          : reason.trim() === ''
            ? 'Say why this is moving.'
            : undefined

  return (
    <div className="space-y-5">
      <div>
        <SectionHeader
          title="Move stock"
          sub="A move between named pools, never a new total — the ledger keeps both halves."
        />
        <FieldRow cols={4} className="mt-2">
          <Field label="From">
            <Select value={from} onChange={(event) => setFrom(event.target.value)}>
              {pools
                .filter((pool) => pool !== 'none' || isAdmin)
                .map((pool) => (
                  <option value={pool} key={pool}>
                    {pool === 'none' ? 'Nowhere — a count correction' : words(pool)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="To">
            <Select value={to} onChange={(event) => setTo(event.target.value)}>
              {pools
                .filter((pool) => pool !== 'available' || isAdmin)
                .map((pool) => (
                  <option value={pool} key={pool}>
                    {pool === 'none' ? 'Out of stock — written off' : words(pool)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="How many" unit={plural(batch.baseUnit || 'unit', 2)}>
            <Input
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
          <Field label="Reason" required>
            <Input value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </FieldRow>
        {!isAdmin ? (
          <p className="mt-2 text-[12px] text-ink-2">
            Only an admin may put stock back onto the sellable shelf or add stock that was never
            received, so those two options are not offered here.
          </p>
        ) : null}
        <div className="mt-3">
          <ConfirmButton
            busy={adjust.busy}
            busyLabel={adjust.workingLabel}
            disabled={Boolean(moveProblem)}
            disabledReason={moveProblem}
            title="Record this adjustment"
            question={
              <>
                {quantity} {plural(batch.baseUnit || 'unit', Number(quantity) || 2)} of batch{' '}
                <span className="font-semibold">{batch.batchNumber}</span> move{' '}
                {from === 'none' ? 'in to' : `from ${from} to`}{' '}
                {to === 'none' ? 'out of stock' : to}. The movement stays on the ledger for good.
              </>
            }
            confirmLabel="Record it"
            onConfirm={async () => {
              setProblem('')
              const result = await adjust.run({
                working: `Moving ${quantity} ${plural(batch.baseUnit || 'unit', Number(quantity) || 2)}…`,
                request: () =>
                  run('adjust_stock', {
                    batchId: batch.id,
                    from,
                    to,
                    quantity,
                    reason,
                  }),
                confirmed: () => ({
                  kind: 'confirmed',
                  title: 'Stock moved',
                  identity: `${batch.medicineName} · batch ${batch.batchNumber}`,
                  detail: `${quantity} ${plural(batch.baseUnit || 'unit', Number(quantity) || 2)} ${
                    from === 'none' ? 'added to' : `moved from ${from} to`
                  } ${to === 'none' ? 'out of stock' : to}. The movement is on the ledger for good.`,
                  icon: 'boxes',
                  dwell: DWELL_MAJOR,
                }),
              })
              // Only a confirmed movement closes the window. A refusal keeps
              // the typed quantity and reason so they can be corrected, and an
              // unconfirmed one keeps them because nobody yet knows whether the
              // stock moved.
              if (result?.ok) onDone()
            }}
          >
            Record the adjustment
          </ConfirmButton>
          {/*
           * No `onRetry`. `adjust_stock` carries no idempotency key, so a
           * second press after a lost answer is a second movement on an
           * append-only ledger. Checking the batch first is the instruction,
           * and the unconfirmed state gives it.
           */}
          <TaskFailure failure={adjust.failure} />
        </div>
      </div>

      <TaskResult outcome={adjust.outcome} onDismiss={adjust.dismiss} />

      <div>
        <SectionHeader
          title="Recall or block this batch"
          sub="A flag, not a quantity — a recalled lot is still on the shelf and still has to be counted."
        />
        <FieldRow cols={2} className="mt-2">
          <Field label="Status">
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as BatchView['status'])}
            >
              {isAdmin ? <option value="active">Active — may be picked</option> : null}
              <option value="recalled">Recalled — do not supply</option>
              <option value="blocked">Blocked — held back</option>
            </Select>
          </Field>
          <Field label="Reason" required>
            <Input
              value={statusReason}
              onChange={(event) => setStatusReason(event.target.value)}
            />
          </Field>
        </FieldRow>
        {!isAdmin ? (
          <p className="mt-2 text-[12px] text-ink-2">
            Releasing a batch back to Active is an admin decision.
          </p>
        ) : null}
        <div className="mt-3">
          <ConfirmButton
            variant={status === 'active' ? 'primary' : 'danger'}
            busy={busy}
            busyLabel="Saving…"
            disabled={status === batch.status || statusReason.trim() === ''}
            disabledReason={
              status === batch.status
                ? `This batch is already ${batch.status}.`
                : 'Say why the status is changing.'
            }
            title="Change this batch's status"
            question={
              <>
                Batch <span className="font-semibold">{batch.batchNumber}</span> becomes{' '}
                {status}.{' '}
                {status === 'active'
                  ? 'It can be picked again.'
                  : 'It can no longer be picked for any prescription or sale.'}
              </>
            }
            confirmLabel={`Mark ${status}`}
            onConfirm={async () => {
              const result = await run('set_batch_status', {
                batchId: batch.id,
                status,
                reason: statusReason,
              })
              if (result.ok) onDone()
              else setProblem(result.message)
            }}
          >
            Save the status
          </ConfirmButton>
        </div>
      </div>

      {problem ? (
        <Notice tone="bad" onDismiss={() => setProblem('')}>
          {problem}
        </Notice>
      ) : null}
    </div>
  )
}
