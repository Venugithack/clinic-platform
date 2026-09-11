/**
 * The package ladder, and the only arithmetic that converts between what a
 * person counts and what the ledger moves.
 *
 * A person counts "two boxes, three strips and four loose tablets". The ledger
 * moves 349 tablets. Everything in this file exists so that conversion happens
 * in exactly one place, is checked before it is used, and is frozen onto a
 * batch so that a later pack-size change cannot reach back and reinterpret it.
 *
 * The shape is deliberately recursive and data-driven. `tablets_per_strip` and
 * `strips_per_box` cannot express a tray of vials, a carton of bottles, a pouch
 * of patches, or a kit containing a device and its consumables — and the
 * approval pack is explicit that the clinic will meet all of those. What they
 * CAN express is a chain, so that is the structure: each level names the level
 * directly inside it and how many of them it holds.
 *
 * Nothing here permits a fraction. `childCount` is a whole number, every
 * quantity is a whole number, and the base unit is the smallest safe countable
 * item. The clinic answered "no" to dividing an opened bottle, tube, vial or
 * inhaler, so there is no path from this file to thirty millilitres.
 */

export type LevelInput = {
  levelName: string
  levelType: string
  /** The level directly inside this one, by name. Absent at the base. */
  contains?: string
  /** How many of `contains` fit in one of these. */
  containsCount?: number
  receivable?: boolean
  sellable?: boolean
  /** May the counter open one of these? False for a sealed bottle or vial. */
  breakable?: boolean
  minimumSaleMultiple?: number
  /** The level the printed MRP applies to. Exactly one per version. */
  mrpBasis?: boolean
  barcodeHint?: string
}

export type Level = {
  levelName: string
  levelType: string
  contains: string | null
  containsCount: number | null
  depth: number
  baseFactor: number
  receivable: boolean
  sellable: boolean
  breakable: boolean
  minimumSaleMultiple: number
  mrpBasis: boolean
  barcodeHint: string
}

export type Ladder = {
  baseUnit: string
  /** Base first, so index 0 is always the unit the ledger counts in. */
  levels: Level[]
}

/** What a person typed at a counter or a receiving desk. */
export type PackageEntry = { levelName: string; count: number }

const MAX_DEPTH = 8
const MAX_FACTOR = 100_000_000

/**
 * Turn what the builder screen collected into a validated chain.
 *
 * Refuses, with the reason a pharmacist would need to hear:
 *
 *   * a level that contains a level nobody defined;
 *   * a zero, negative or fractional count;
 *   * two levels containing the same level, which is a fork rather than a
 *     ladder and makes "how many tablets is a box" ambiguous;
 *   * a cycle;
 *   * more than one base, or none;
 *   * more than one MRP basis.
 *
 * The database enforces the same things through `enforce_package_level_chain`.
 * This exists so the refusal is a sentence rather than a constraint name, and
 * so the factors are computed once, here, rather than in a browser that a
 * later screen might compute differently.
 */
export function buildLadder(baseUnit: string, inputs: LevelInput[]): Ladder {
  const unit = baseUnit.trim()
  if (!unit) throw new Error('Choose the unit this medicine is counted in.')
  if (inputs.length === 0) throw new Error('A package needs at least the base level.')
  if (inputs.length > MAX_DEPTH) {
    throw new Error(`A package may have at most ${MAX_DEPTH} levels.`)
  }

  const byName = new Map<string, LevelInput>()
  for (const input of inputs) {
    const name = input.levelName?.trim()
    if (!name) throw new Error('Every package level needs a name.')
    if (!input.levelType?.trim()) throw new Error(`Say what kind of package "${name}" is.`)
    if (byName.has(name.toLowerCase())) {
      throw new Error(`"${name}" is listed twice. Each level appears once.`)
    }
    byName.set(name.toLowerCase(), { ...input, levelName: name, levelType: input.levelType.trim() })
  }

  // One parent per level: two levels claiming to contain the strip means a
  // strip is worth two different numbers of tablets.
  const claimed = new Map<string, string>()
  for (const input of byName.values()) {
    const contains = input.contains?.trim()
    if (!contains) continue
    const key = contains.toLowerCase()
    if (!byName.has(key)) {
      throw new Error(`"${input.levelName}" contains "${contains}", which is not one of the levels.`)
    }
    if (key === input.levelName.toLowerCase()) {
      throw new Error(`"${input.levelName}" cannot contain itself.`)
    }
    const already = claimed.get(key)
    if (already) {
      throw new Error(`Both "${already}" and "${input.levelName}" contain "${contains}". A package is a ladder, not a fork.`)
    }
    claimed.set(key, input.levelName)
    if (!Number.isInteger(input.containsCount) || Number(input.containsCount) <= 0) {
      throw new Error(`Say how many ${contains} are in one ${input.levelName}, as a whole number above zero.`)
    }
  }

  const bases = [...byName.values()].filter((input) => !input.contains?.trim())
  if (bases.length === 0) {
    throw new Error('Every level contains another one, so there is no smallest unit. One level must be the base.')
  }
  if (bases.length > 1) {
    throw new Error(
      `"${bases[0].levelName}" and "${bases[1].levelName}" both contain nothing. A package has one base unit.`,
    )
  }

  const mrpBases = [...byName.values()].filter((input) => input.mrpBasis)
  if (mrpBases.length > 1) {
    throw new Error('The printed MRP applies to one package level. Choose which one.')
  }

  // Walk up from the base. Anything not reached is either in a cycle or
  // hanging off one, and either way it is not part of this ladder.
  const levels: Level[] = []
  let current: LevelInput | undefined = bases[0]
  let depth = 0
  let factor = 1

  while (current) {
    levels.push(toLevel(current, depth, factor))
    const parentName = claimed.get(current.levelName.toLowerCase())
    const parent = parentName ? byName.get(parentName.toLowerCase()) : undefined
    if (!parent) break
    depth += 1
    factor *= Number(parent.containsCount)
    if (factor > MAX_FACTOR) {
      throw new Error(`One ${parent.levelName} would be ${factor} ${unit}. Check the counts.`)
    }
    current = parent
  }

  if (levels.length !== byName.size) {
    const reached = new Set(levels.map((level) => level.levelName.toLowerCase()))
    const orphan = [...byName.values()].find((input) => !reached.has(input.levelName.toLowerCase()))
    throw new Error(
      `"${orphan?.levelName}" does not sit above the base unit. Check what each level contains — the levels must form one chain.`,
    )
  }

  return { baseUnit: unit, levels }
}

function toLevel(input: LevelInput, depth: number, baseFactor: number): Level {
  const minimum = input.minimumSaleMultiple ?? 1
  if (!Number.isInteger(minimum) || minimum <= 0) {
    throw new Error(`The smallest sale of "${input.levelName}" is a whole number above zero.`)
  }
  return {
    levelName: input.levelName,
    levelType: input.levelType,
    contains: input.contains?.trim() || null,
    containsCount: input.contains?.trim() ? Number(input.containsCount) : null,
    depth,
    baseFactor,
    // The base is always receivable and, unless said otherwise, sellable: it is
    // the unit the clinic counts in.
    receivable: input.receivable ?? true,
    sellable: input.sellable ?? depth === 0,
    breakable: input.breakable ?? depth > 0,
    minimumSaleMultiple: minimum,
    mrpBasis: input.mrpBasis ?? false,
    barcodeHint: (input.barcodeHint ?? '').trim(),
  }
}

/** Rebuild a ladder from what was stored on a package version or frozen on a batch. */
export function ladderFromRows(baseUnit: string, rows: Level[]): Ladder {
  return { baseUnit, levels: [...rows].sort((a, b) => a.depth - b.depth) }
}

export function levelNamed(ladder: Ladder, name: string): Level {
  const level = ladder.levels.find((row) => row.levelName.toLowerCase() === name.trim().toLowerCase())
  if (!level) {
    const known = ladder.levels.map((row) => row.levelName).join(', ')
    throw new Error(`"${name}" is not a package level for this medicine. It has: ${known}.`)
  }
  return level
}

/**
 * "2 boxes + 3 strips + 4 tablets" -> 349.
 *
 * Every entry is checked against the ladder rather than trusted, because the
 * tablet computed the same number for the preview and the two must agree — if
 * the package version changed between the preview and the post, this is what
 * notices.
 */
export function baseQuantityOf(
  ladder: Ladder,
  entries: PackageEntry[],
  { require = 'receivable' as 'receivable' | 'sellable' | 'any' } = {},
): number {
  if (entries.length === 0) throw new Error('Enter a quantity.')

  let total = 0
  const seen = new Set<string>()
  for (const entry of entries) {
    const level = levelNamed(ladder, entry.levelName)
    const key = level.levelName.toLowerCase()
    if (seen.has(key)) throw new Error(`${level.levelName} is entered twice. Add the counts together.`)
    seen.add(key)

    if (!Number.isInteger(entry.count) || entry.count < 0) {
      throw new Error(`The number of ${level.levelName} must be a whole number.`)
    }
    if (entry.count === 0) continue

    if (require === 'receivable' && !level.receivable) {
      throw new Error(`This medicine is not received by the ${level.levelName}.`)
    }
    if (require === 'sellable' && !level.sellable) {
      throw new Error(`This medicine is not sold by the ${level.levelName}.`)
    }
    if (require === 'sellable' && entry.count % level.minimumSaleMultiple !== 0) {
      throw new Error(
        `${level.levelName} is sold in multiples of ${level.minimumSaleMultiple}.`,
      )
    }

    total += level.baseFactor * entry.count
    if (!Number.isSafeInteger(total)) throw new Error('That quantity is larger than this ledger can hold.')
  }

  if (total <= 0) throw new Error('Enter a quantity above zero.')
  return total
}

/**
 * 349 -> "2 boxes, 3 strips, 4 tablets", using THIS batch's ladder.
 *
 * Per batch, never per medicine: a shelf holding a batch in strips of fifteen
 * and a batch in strips of ten has no single correct decomposition, and
 * printing one would be a number the pharmacist cannot find on the shelf.
 */
export function decompose(ladder: Ladder, baseQuantity: number): PackageEntry[] {
  if (!Number.isInteger(baseQuantity) || baseQuantity < 0) {
    throw new Error('A stock quantity is a whole number of base units.')
  }
  const out: PackageEntry[] = []
  let remaining = baseQuantity
  for (const level of [...ladder.levels].sort((a, b) => b.depth - a.depth)) {
    const count = Math.floor(remaining / level.baseFactor)
    if (count > 0 || level.depth === 0) out.push({ levelName: level.levelName, count })
    remaining -= count * level.baseFactor
  }
  return out
}

/** One `box`, two `boxes`. Enough English for a package name a clinic types. */
export function plural(name: string, count: number): string {
  if (count === 1) return name
  return /(s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`
}

/** "2 boxes, 3 strips and 4 tablets" — for a preview, a receipt or an audit line. */
export function describeEntry(entries: PackageEntry[]): string {
  const parts = entries
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${plural(entry.levelName, entry.count)}`)
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * "1 box = 10 strips = 150 tablets".
 *
 * Approval pack §4 step C requires the builder to show the expanded result in
 * plain language before it can be saved, because "10" and "15" typed into two
 * boxes do not tell a pharmacist whether they have described the pack in front
 * of them. The sentence does.
 */
export function describeLadder(ladder: Ladder): string {
  const ordered = [...ladder.levels].sort((a, b) => b.depth - a.depth)
  const top = ordered[0]
  if (!top || ordered.length === 1) return `1 ${ladder.baseUnit}`

  const parts = [`1 ${top.levelName}`]
  for (const level of ordered.slice(1)) {
    const count = top.baseFactor / level.baseFactor
    parts.push(`${count} ${plural(level.levelName, count)}`)
  }
  return parts.join(' = ')
}
