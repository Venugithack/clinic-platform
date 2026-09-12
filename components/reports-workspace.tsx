'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callApi } from '@/lib/api'
import { useBusy } from './clinic-context'
import { Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Notice,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  formatDate,
  formatDay,
  formatExpiry,
  money,
  words,
} from '@/components/ui'

/**
 * Slice 6's reading room.
 *
 * Every report here is derived on the server, every time — stock from the
 * movement ledger, money from invoice lines and payment allocations, supply
 * state from dispense events. None of it is in the fifteen-second snapshot,
 * because a report is read by one person standing in front of it and the
 * snapshot is fetched by four tablets whether anybody is standing there or not.
 *
 * ── WHY THE TABLES ARE GENERIC ──────────────────────────────────────────────
 *
 * Fourteen reports carry thirty-one sections between them and something over
 * two hundred columns. Hand-writing those means two hundred chances to put a
 * quantity in a money column or to drop a column when the SQL gains one, and
 * the way anybody finds out is a blank cell on a tablet during a stock
 * reconciliation. So the columns come from the rows: whatever the server
 * selected is what appears, in the order it selected it, with the key
 * humanised into a heading.
 *
 * What is NOT generic is the meaning. Each report and each section is titled
 * and explained here in the clinic's own words, because `needsDoctor` is not a
 * heading and "What was prescribed and never collected" is.
 *
 * ── WHY IT COPIES RATHER THAN DOWNLOADS ────────────────────────────────────
 *
 * A download would work — this is an ordinary page in an ordinary browser —
 * but on the device it is read on it works badly. A CSV saved on an iPad
 * lands in Files, and getting it from there into a spreadsheet or into a
 * message to the accountant is four steps nobody wants at nine in the
 * evening. The clipboard is one step into either. So Copy is what is offered,
 * and when the browser refuses the clipboard the screen says exactly that,
 * rather than reporting a copy that did not happen.
 */

type Row = Record<string, unknown>

type Section = {
  /** The key the server puts this array under. */
  key: string
  title: string
  /** What this section answers. One line. */
  note: string
  /**
   * False when the server's own query for this section ignores the day range —
   * a fixed tail of the last 200 rows, say. Saying so stops the owner reading
   * a recent-looking figure as belonging to the period on screen.
   */
  ranged: boolean
}

type ReportSpec = {
  id: string
  title: string
  /** The question this report answers, in the clinic's words. */
  question: string
  /** True when the server's cutoff changes what comes back. */
  dated: boolean
  sections: Section[]
}

/** Every report the backend serves, in the order they are worth reading. */
const REPORTS: ReportSpec[] = [
  {
    id: 'stock_on_hand',
    title: 'Stock on hand',
    question: 'What is on the shelf right now, what it cost, and what is at or below its reorder level.',
    dated: false,
    sections: [
      {
        key: 'rows',
        title: 'Every active medicine',
        note: 'Sellable, quarantined, blocked and expired base units side by side, with the value of the active batches behind them.',
        ranged: false,
      },
    ],
  },
  {
    id: 'expiry_and_holds',
    title: 'Expiry and holds',
    question: 'What goes off within six months, what is held or recalled, and what has already gone back or been written off.',
    dated: false,
    sections: [
      {
        key: 'expiring',
        title: 'Going off',
        note: 'Ordered by how little time is left before the supplier’s return window closes, not by expiry date.',
        ranged: false,
      },
      {
        key: 'held',
        title: 'Quarantined, blocked and recalled',
        note: 'Stock that exists and cannot be sold, with who put it on hold and why.',
        ranged: false,
      },
      {
        key: 'returns',
        title: 'Returned to the supplier',
        note: 'The last 200 return notes and the credit expected against them.',
        ranged: false,
      },
      {
        key: 'writeoffs',
        title: 'Written off',
        note: 'The last 200 write-offs, what they cost the clinic, and who recorded each.',
        ranged: false,
      },
    ],
  },
  {
    id: 'stock_movements',
    title: 'Stock movements',
    question: 'Every base unit that entered or left a batch in the period, what it was for, and who moved it.',
    dated: true,
    sections: [
      {
        key: 'rows',
        title: 'The ledger',
        note: 'Newest first, up to 2,000 movements. This is the ledger every shelf figure is derived from.',
        ranged: true,
      },
    ],
  },
  {
    id: 'package_audit',
    title: 'Packages and classification',
    question: 'Which package ladder each medicine is received and sold in, who verified it, and what is still unclassified.',
    dated: false,
    sections: [
      {
        key: 'rows',
        title: 'Package versions',
        note: 'Every version of every ladder, what verified it, and how many batches were received under it.',
        ranged: false,
      },
      {
        key: 'unclassified',
        title: 'No verified drug schedule',
        note: 'These are missing from the Schedule H1 register whether they belong in it or not.',
        ranged: false,
      },
      {
        key: 'unpackaged',
        title: 'No active package',
        note: 'Stock cannot be received against these until somebody defines and verifies a ladder.',
        ranged: false,
      },
      {
        key: 'unlinked',
        title: 'Not linked to a clinical drug',
        note: 'A shelf product with no ingredient, strength and form behind it cannot be matched to what a doctor prescribed.',
        ranged: false,
      },
    ],
  },
  {
    id: 'purchasing',
    title: 'Purchasing',
    question: 'What was ordered from each supplier against what actually arrived.',
    dated: false,
    sections: [
      {
        key: 'orders',
        title: 'Purchase orders',
        note: 'The last 200 orders, with ordered and received base units on the same row. An order adds no stock.',
        ranged: false,
      },
      {
        key: 'receipts',
        title: 'Goods received',
        note: 'The last 200 accepted receipts, each of which did add stock, with the supplier invoice they came against.',
        ranged: false,
      },
    ],
  },
  {
    id: 'outstanding_prescriptions',
    title: 'Outstanding prescriptions',
    question: 'Medicine a doctor signed for that the patient has not collected, and lines nobody can read until a doctor settles them.',
    dated: false,
    sections: [
      {
        key: 'rows',
        title: 'Still collectable',
        note: 'Lines with a remainder the counter may still supply, soonest to expire first.',
        ranged: false,
      },
      {
        key: 'needsDoctor',
        title: 'Waiting on a doctor',
        note: 'Old lines whose medicine or quantity was never recorded. The counter may not supply one; only a doctor may say what it authorized.',
        ranged: false,
      },
    ],
  },
  {
    id: 'dispensing',
    title: 'Dispensing',
    question: 'Every hand-over at the counter in the period, and the exact batches it came out of.',
    dated: true,
    sections: [
      {
        key: 'rows',
        title: 'Hand-overs and batch allocations',
        note: 'One row per batch allocation, so a line supplied from two batches appears twice. Up to 2,000 rows.',
        ranged: true,
      },
    ],
  },
  {
    id: 'sales',
    title: 'Sales',
    question: 'What was charged in the period, split between consultation and medicine, plus counter sales and anything returned.',
    dated: true,
    sections: [
      {
        key: 'byLine',
        title: 'Charged, by what it was for',
        note: 'Voided bills are excluded. Consultation and medicine are separate lines and are never merged.',
        ranged: true,
      },
      {
        key: 'otc',
        title: 'Counter sales',
        note: 'Sales made across the counter without a prescription. Up to 500.',
        ranged: true,
      },
      {
        key: 'returns',
        title: 'Counter returns',
        note: 'The last 200 returns against counter sales, whatever the day range on this screen says.',
        ranged: false,
      },
    ],
  },
  {
    id: 'consultation_fees',
    title: 'Consultation fees',
    question: 'What each encounter was charged, what the standing fee was, and which fees were waived or changed.',
    dated: true,
    sections: [
      {
        key: 'rows',
        title: 'Fee per encounter',
        note: 'The fee as it stood when the encounter was completed, beside the clinic default at that moment. Up to 1,000.',
        ranged: true,
      },
    ],
  },
  {
    id: 'payments',
    title: 'Payments',
    question: 'Cash, UPI and card taken in the period — the day-close question, receipt by receipt.',
    dated: true,
    sections: [
      {
        key: 'byMethod',
        title: 'Taken, by method',
        note: 'Received payments only. Reversed ones are not netted off here; they are in Reversals.',
        ranged: true,
      },
      {
        key: 'receipts',
        title: 'Every receipt',
        note: 'Including reversed and refunded ones, with the bills each was allocated against. Up to 1,000.',
        ranged: true,
      },
      {
        key: 'splits',
        title: 'Bills settled in more than one payment',
        note: 'Part payments and cash-plus-UPI splits, so a bill that took three tries is one row.',
        ranged: true,
      },
    ],
  },
  {
    id: 'patient_dues',
    title: 'Patient dues',
    question: 'Who owes the clinic money, how long it has been outstanding, and what they have paid so far.',
    dated: false,
    sections: [
      {
        key: 'rows',
        title: 'Outstanding balances',
        note: 'Derived from immutable bill lines and payment allocations, largest first.',
        ranged: false,
      },
      {
        key: 'repayments',
        title: 'Payments by named patients',
        note: 'The last 500, whatever the day range on this screen says.',
        ranged: false,
      },
    ],
  },
  {
    id: 'reversals',
    title: 'Reversals',
    question: 'Every time money or stock moved backwards — the list to read before believing any total.',
    dated: false,
    sections: [
      { key: 'voidedInvoices', title: 'Voided bills', note: 'With the reason and who voided each.', ranged: false },
      { key: 'refunds', title: 'Refunds issued', note: 'Money paid back out of the drawer.', ranged: false },
      {
        key: 'reversedPayments',
        title: 'Reversed payments',
        note: 'A receipt taken and then undone. The original is never deleted.',
        ranged: false,
      },
      {
        key: 'reversedDispenses',
        title: 'Reversed hand-overs',
        note: 'Medicine that went out and came back, with the compensating stock movement behind it.',
        ranged: false,
      },
      {
        key: 'adjustments',
        title: 'Stock adjustments and reversals',
        note: 'Corrections to the ledger, with the actor and whoever approved each.',
        ranged: false,
      },
    ],
  },
  {
    id: 'financial_review',
    title: 'Financial review',
    question:
      'Bills that more money has left than ever entered. These are exceptions waiting on the accountant, not bills to chase — nobody on them owes the clinic anything.',
    dated: false,
    sections: [
      {
        key: 'queue',
        title: 'Over-refunded bills',
        note: 'Usually a refund, and then the reversal of the payment that refund answered. The due figure on one of these is the over-refund itself.',
        ranged: false,
      },
      {
        key: 'documents',
        title: 'The receipts, refunds and reversals behind them',
        note: 'One row each, so the sequence that produced the exception can be read straight through before anybody decides what to do about it.',
        ranged: false,
      },
      {
        key: 'patients',
        title: 'Patients carrying an over-refund',
        note: 'Their outstanding figure in Patient dues includes this money. It is not a debt and none of them should be asked for it.',
        ranged: false,
      },
    ],
  },
  {
    id: 'follow_ups',
    title: 'Follow-ups',
    question: 'Who the doctor asked to come back, when they are due, and who is already overdue.',
    dated: false,
    sections: [
      {
        key: 'rows',
        title: 'Open follow-ups',
        note: 'Soonest first. Completed and cancelled ones are not here.',
        ranged: false,
      },
    ],
  },
  {
    id: 'image_access',
    title: 'Clinical image access',
    question: 'Who opened a clinical photograph, who was turned away, and which images are due for retention review.',
    dated: true,
    sections: [
      {
        key: 'rows',
        title: 'Every access event',
        note: 'Who, when, what they were allowed to do and on what basis. Carries no image content.',
        ranged: true,
      },
      {
        key: 'refusals',
        title: 'Refusals, grouped',
        note: 'Repeated refusals on the same basis are worth a conversation rather than a policy change.',
        ranged: true,
      },
      {
        key: 'grants',
        title: 'Standing grants',
        note: 'The last 200 grants and revocations, whatever the day range on this screen says.',
        ranged: false,
      },
      {
        key: 'retention',
        title: 'Due for retention review',
        note: 'Images the retention policy says somebody must now decide about.',
        ranged: false,
      },
    ],
  },
]

const SPEC_BY_ID = new Map(REPORTS.map((spec) => [spec.id, spec]))

/* ------------------------------------------------------- reading a value */

/**
 * Words that mean money when they sit on a number.
 *
 * A quantity and an amount look identical in a table and are not the same
 * mistake to make, so the test is deliberately narrow: the key has to name
 * money AND the value has to parse as a number. `fee_waived` is a boolean and
 * `fee_reason` is a sentence; neither becomes ₹0.00 here.
 */
const MONEY_WORDS = /(amount|total|subtotal|value|price|fee|cost|credit|refund|mrp|paid|billed|outstanding|charge)/

function isMoneyKey(key: string): boolean {
  const lower = key.toLowerCase()
  // `days_outstanding` is a count of days. `count`/`quantity` are never money.
  if (lower.includes('day') || lower.includes('count') || lower.includes('quantity')) return false
  return MONEY_WORDS.test(lower)
}

/** Postgres hands `numeric` and `bigint` back as strings; both are numbers here. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const DATE_KEY = /(_at|_date|_on)$|expiry|due|until|last_seen|last_contact/
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The formatted date, or null when this key/value pair is not a date at all. */
function dateText(key: string, value: string): string | null {
  const lower = key.toLowerCase()
  if (!DATE_KEY.test(lower)) return null
  if (Number.isNaN(new Date(value).getTime())) return null
  if (lower.includes('expiry')) return formatExpiry(value)
  return PLAIN_DAY.test(value) ? formatDay(value) : formatDate(value)
}

/**
 * Columns that hold a state word rather than a written value.
 *
 * `partially_delivered` is a code and reads as `Partially delivered`; a batch
 * number is a value and is never re-spelled, however code-shaped it looks.
 * Which one a cell is cannot be told from the cell, so it is told from the
 * column — transcription-critical identifiers are left exactly as they came.
 */
const ENUM_KEY =
  /(_state|_type|_status|_class)$|^(status|state|method|kind|bucket|basis|action|source|scope|category|schedule|supply_state)$/

/** A lower-case code. An identifier with digits in it is not one. */
const CODE = /^[a-z]+(_[a-z]+)*$/

function cellText(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  if (typeof value === 'number') {
    return isMoneyKey(key) ? money(value) : String(value)
  }

  if (typeof value === 'string') {
    if (value === '') return '—'
    const asDate = dateText(key, value)
    if (asDate) return asDate
    const asNumber = numberOf(value)
    if (asNumber !== null) return isMoneyKey(key) ? money(asNumber) : value
    const lower = key.toLowerCase()
    if (ENUM_KEY.test(lower) && CODE.test(value)) return humanise(value)
    return value.includes('_') && CODE.test(value) ? words(value) : value
  }

  return JSON.stringify(value)
}

/**
 * A column that exists for this screen to act on, not for anybody to read.
 *
 * `outstanding_prescriptions.needsDoctor` carries `prescription_line_id` and
 * `patient_id` so the review queue can name the line it is settling. A uuid in
 * a column of a stock report is noise at best, and at worst it is a reader
 * copying one into a message because it looked official.
 */
const isIdentifier = (key: string) => key === 'id' || key.endsWith('_id') || key.endsWith('Id')

/** Columns, in the order the server selected them, across every row. */
function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>()
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key) || isIdentifier(key)) continue
      seen.add(key)
      columns.push(key)
    }
  }
  return columns
}

/**
 * Whether a column is set in mono and right-aligned.
 *
 * Quantities, amounts and times are read down a column and compared with the
 * one above, which is the whole reason this system has a register. A column
 * with one word in it is not that.
 */
function isFigureColumn(rows: Row[], key: string): boolean {
  let seen = false
  for (const row of rows) {
    const value = row[key]
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'boolean') return false
    if (typeof value === 'string' && dateText(key, value)) {
      seen = true
      continue
    }
    if (numberOf(value) === null) return false
    seen = true
  }
  return seen
}

const ACRONYMS = new Map([
  ['mrp', 'MRP'],
  ['grn', 'GRN'],
  ['upi', 'UPI'],
  ['otc', 'OTC'],
  ['gtin', 'GTIN'],
  ['id', 'ID'],
])

/** `at_or_below_reorder` → `At or below reorder`. `grn_number` → `GRN number`. */
function humanise(key: string): string {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .filter(Boolean)
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase()
      const acronym = ACRONYMS.get(lower)
      if (acronym) return acronym
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

/* -------------------------------------------------------------------- csv */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * The section as a spreadsheet would want it.
 *
 * Headings are the ones on screen so the two can be compared; values are the
 * server's own, unformatted, so a total stays a number and a timestamp stays
 * sortable. A pasted `₹1,234.50` is text, and text does not add up.
 */
function csvOf(rows: Row[]): string {
  const columns = columnsOf(rows)
  return [
    columns.map((column) => csvCell(humanise(column))).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n')
}

/* ----------------------------------------------------------- the register */

/**
 * How many rows are drawn.
 *
 * The ledger reports return up to two thousand movements, which at fourteen
 * columns is twenty-eight thousand cells — enough to make a clinic tablet
 * think for several seconds and then scroll badly. Nobody reads two thousand
 * rows down a screen anyway; they read the top of them and take the rest to a
 * spreadsheet. So the screen draws the newest few hundred and says plainly how
 * many it is not drawing, and Copy as CSV always takes every row the server
 * sent.
 */
const DRAWN = 250

function SectionTable({ rows }: { rows: Row[] }) {
  const columns = useMemo(() => columnsOf(rows), [rows])
  const figures = useMemo(
    () => new Set(columns.filter((column) => isFigureColumn(rows, column))),
    [columns, rows],
  )
  const drawn = rows.length > DRAWN ? rows.slice(0, DRAWN) : rows

  return (
    <>
      {drawn.length < rows.length ? (
        <p className="border-b border-rule px-4 py-2 text-[12px] text-ink-2">
          Showing the first {drawn.length} of {rows.length} rows. Copy as CSV takes all{' '}
          {rows.length}, or narrow the day range.
        </p>
      ) : null}
      <Table>
        <THead>
          <TR>
            {columns.map((column) => (
              <TH key={column} num={figures.has(column)}>
                {humanise(column)}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {drawn.map((row, index) => (
            <TR key={index}>
              {columns.map((column) => (
                <TD key={column} num={figures.has(column)}>
                  {cellText(column, row[column])}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </>
  )
}

/* --------------------------------------------------------------- the page */

const RANGES = [7, 30, 90, 365] as const

type Loaded = { report: string; days: number; sections: Record<string, Row[]> }

type IndexState =
  | { state: 'loading' }
  | { state: 'ready'; ids: string[] }
  | { state: 'failed'; message: string }

export function ReportsPanel() {
  const busy = useBusy()
  const [index, setIndex] = useState<IndexState>({ state: 'loading' })
  const [openId, setOpenId] = useState('')
  const [days, setDays] = useState<number>(7)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [copied, setCopied] = useState<{ tone: 'good' | 'bad'; message: string } | null>(null)

  /** A later answer must never land on top of the report now on screen. */
  const attempt = useRef(0)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await callApi('reports?report=index')
        const body = (await response.json()) as { ok: boolean; message?: string; reports?: string[] }
        if (!live) return
        if (!body.ok) {
          setIndex({ state: 'failed', message: body.message ?? 'The report list could not be read.' })
          return
        }
        setIndex({ state: 'ready', ids: body.reports ?? [] })
      } catch {
        if (live) {
          setIndex({
            state: 'failed',
            message: 'The clinic server is not reachable, so the report list could not be read.',
          })
        }
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const available = useMemo(() => {
    if (index.state !== 'ready') return []
    const allowed = new Set(index.ids)
    return REPORTS.filter((spec) => allowed.has(spec.id))
  }, [index])

  /**
   * A report the server lists and this screen has never heard of.
   *
   * Better named than dropped: the backend is frozen and this file is not, so
   * the day a report is added the owner is told it exists rather than shown a
   * list that quietly omits it.
   */
  const unlisted = useMemo(() => {
    if (index.state !== 'ready') return []
    return index.ids.filter((id) => !SPEC_BY_ID.has(id))
  }, [index])

  const open = available.find((spec) => spec.id === openId) ?? null

  const load = useCallback(async (spec: ReportSpec, forDays: number) => {
    const mine = ++attempt.current
    setLoading(true)
    setFailure(null)
    setCopied(null)
    try {
      const response = await callApi(
        `reports?report=${encodeURIComponent(spec.id)}&days=${forDays}`,
      )
      const body = (await response.json()) as { ok: boolean; message?: string } & Record<
        string,
        unknown
      >
      if (mine !== attempt.current) return
      if (!body.ok) {
        setLoaded(null)
        // The server's own sentence, unedited. It knows why it refused.
        setFailure(body.message ?? `That report could not be read — the server answered ${response.status}.`)
        return
      }
      const sections: Record<string, Row[]> = {}
      for (const section of spec.sections) {
        const value = body[section.key]
        sections[section.key] = Array.isArray(value)
          ? (value.filter((row) => row !== null && typeof row === 'object') as Row[])
          : []
      }
      setLoaded({ report: spec.id, days: forDays, sections })
    } catch {
      if (mine !== attempt.current) return
      setLoaded(null)
      setFailure('The clinic server is not reachable, so that report could not be read.')
    } finally {
      if (mine === attempt.current) setLoading(false)
    }
  }, [])

  function choose(spec: ReportSpec) {
    setOpenId(spec.id)
    setLoaded(null)
    setFailure(null)
    void load(spec, spec.dated ? days : 7)
  }

  function chooseRange(next: number) {
    setDays(next)
    if (open?.dated) void load(open, next)
  }

  async function copySection(section: Section, rows: Row[]) {
    const text = csvOf(rows)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
      setCopied({
        tone: 'good',
        message: `${section.title}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} copied. Paste into a spreadsheet.`,
      })
    } catch {
      setCopied({
        tone: 'bad',
        message:
          'This browser will not let the page write to the clipboard, so nothing was copied. Select the table and copy it by hand, or open this screen over https on a browser that allows it.',
      })
    }
  }

  const off = busy || loading

  return (
    <Stack>
      <PageHeader
        eyebrow="Ask the record"
        title="Reports"
        sub={
          index.state === 'ready'
            ? `${available.length} ${available.length === 1 ? 'report' : 'reports'} your role may read`
            : 'Reading which reports your role may open…'
        }
        action={
          open ? (
            <ActionButton
              variant="primary"
              busy={loading}
              busyLabel="Reading…"
              disabled={busy}
              disabledReason="Another action is still going through."
              onClick={() => void load(open, open.dated ? days : 7)}
            >
              Read again
            </ActionButton>
          ) : null
        }
      />

      {index.state === 'failed' ? <Notice tone="bad">{index.message}</Notice> : null}

      {index.state === 'ready' && available.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="No report is open to your role"
              direction="Reports are shared by desk: stock and purchasing with the pharmacy, money with the desks that handle it, and the clinical image audit with the administrator alone. Ask the administrator if you need one of them."
            />
          </CardBody>
        </Card>
      ) : null}

      {unlisted.length > 0 ? (
        <Notice tone="info">
          The server also offers {unlisted.map(humanise).join(', ')}, which this version of the
          workspace does not know how to lay out yet.
        </Notice>
      ) : null}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <nav aria-label="Reports" className="min-w-0">
          <Card>
            <CardBody className="space-y-1.5">
              {index.state === 'loading' ? (
                <p className="py-2 font-mono text-[13px] text-ink-2">Reading the list…</p>
              ) : null}
              {available.map((spec) => {
                const on = spec.id === openId
                return (
                  <button
                    key={spec.id}
                    type="button"
                    aria-current={on ? 'true' : undefined}
                    disabled={off}
                    onClick={() => choose(spec)}
                    className={`block w-full min-h-[44px] rounded-box border px-3 py-2.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                      on
                        ? 'border-ink bg-ink text-paper'
                        : 'border-rule bg-sheet text-ink hover:bg-paper/60'
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold tracking-[0.08em] uppercase">
                        {spec.title}
                      </span>
                      {spec.dated ? (
                        <span
                          className={`shrink-0 font-mono text-[11px] ${on ? 'text-paper/70' : 'text-ink-2'}`}
                        >
                          dated
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`mt-1 block text-[12px] leading-snug ${on ? 'text-paper/80' : 'text-ink-2'}`}
                    >
                      {spec.question}
                    </span>
                  </button>
                )
              })}
            </CardBody>
          </Card>
        </nav>

        <div className="min-w-0 space-y-4">
          {!open ? (
            index.state === 'ready' && available.length > 0 ? (
              <Card>
                <CardBody>
                  <EmptyState
                    title="No report open"
                    direction="Choose one from the list. Every figure is worked out from the clinic's own ledgers when you ask for it, so a report and the screen it checks can never quietly disagree."
                  />
                </CardBody>
              </Card>
            ) : null
          ) : (
            <>
              <Card variant="record">
                <CardBody className="space-y-3">
                  <div className="min-w-0">
                    <h2 className="text-[18px] leading-tight font-semibold tracking-tight">
                      {open.title}
                    </h2>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{open.question}</p>
                  </div>

                  {open.dated ? (
                    <div
                      role="group"
                      aria-label="How far back this report reaches"
                      className="flex flex-wrap items-center gap-2"
                    >
                      <span className="eyebrow">Covering</span>
                      {RANGES.map((range) => {
                        const on = days === range
                        return (
                          <button
                            key={range}
                            type="button"
                            aria-pressed={on}
                            disabled={off}
                            onClick={() => chooseRange(range)}
                            className={`min-h-[44px] rounded-box border px-3 text-[13px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                              on
                                ? 'border-ink bg-ink text-paper'
                                : 'border-rule bg-sheet text-ink hover:bg-paper/60'
                            }`}
                          >
                            {range === 365 ? 'Last year' : `Last ${range} days`}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[12px] text-ink-2">
                      This report is the position as it stands now, so it has no day range.
                    </p>
                  )}
                </CardBody>
              </Card>

              {failure ? <Notice tone="bad">{failure}</Notice> : null}
              {copied ? (
                <Notice tone={copied.tone} onDismiss={() => setCopied(null)}>
                  {copied.message}
                </Notice>
              ) : null}

              {loading && !loaded ? (
                <Card>
                  <CardBody>
                    <p className="font-mono text-[13px] text-ink-2">Reading {open.title}…</p>
                  </CardBody>
                </Card>
              ) : null}

              {loaded && loaded.report === open.id
                ? open.sections.map((section) => {
                    const rows = loaded.sections[section.key] ?? []
                    return (
                      <Card key={section.key}>
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3">
                          <div className="min-w-0">
                            <h3 className="eyebrow">{section.title}</h3>
                            <p className="mt-1 text-[12px] leading-snug text-ink-2">
                              {section.note}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge>
                              {rows.length} {rows.length === 1 ? 'row' : 'rows'}
                            </Badge>
                            {open.dated && !section.ranged ? <Badge>All dates</Badge> : null}
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={off || rows.length === 0}
                              title={
                                rows.length === 0
                                  ? 'There is nothing in this section to copy.'
                                  : 'Copies this section to the clipboard as CSV, with the values as the server sent them.'
                              }
                              onClick={() => void copySection(section, rows)}
                            >
                              Copy as CSV
                            </Button>
                          </div>
                        </div>
                        {rows.length === 0 ? (
                          <CardBody>
                            <p className="text-[13px] text-ink-2">
                              Nothing here{' '}
                              {open.dated && section.ranged
                                ? `in the last ${loaded.days} ${loaded.days === 1 ? 'day' : 'days'}.`
                                : 'at the moment.'}
                            </p>
                          </CardBody>
                        ) : (
                          <SectionTable rows={rows} />
                        )}
                      </Card>
                    )
                  })
                : null}
            </>
          )}
        </div>
      </div>
    </Stack>
  )
}
