'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClinicSnapshot,
  InvoiceView,
  MedicineView,
  PackageLevelView,
  PackageVersionView,
  PrescriptionItemView,
  PrescriptionView,
  Role,
} from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
import { plural } from './formulary-workspace'
import {
  LOOSE,
  SUPPLY_STATE,
  capQuantity,
  countedQuantity,
  countsToBase,
  countsToEntry,
  estimatePaise,
  isPending,
  isSupplyable,
  medicineIdentity,
  packageOf,
  remainingOf,
  sourcePaise,
  stillToCollect,
  substituteOptions,
  topDown,
  typedFor,
} from './counter-math'
import {
  ClinicLetterhead,
  Figure,
  InvoiceLines,
  InvoicePayments,
  METHOD_LABEL,
  PaymentParts,
  PaymentStateBadge,
  ReasonAction,
  Stack,
  blankPart,
  fromPaise,
  isUnderReview,
  partsPayload,
  partsTotal,
  type PartDraft,
} from './shared-panels'
import {
  ActionButton,
  Badge,
  Busy,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  DWELL_MAJOR,
  Drawer,
  EmptyState,
  Field,
  Icon,
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
  Token,
  clinicDayOf,
  clinicToday,
  formatDate,
  formatDay,
  money,
  useTask,
  type TaskOutcome,
} from '@/components/ui'

/**
 * The counter. One desk, one patient, one amount due.
 *
 * This used to be three stations that unmounted one another — hand a
 * prescription over on the first, sell across the counter on the second, take
 * money on the third — and a pharmacist standing in front of a patient had to
 * carry the answer from one to the next in their head. Opening a prescription
 * threw away a half-built basket. The money a hand-over had just raised was on
 * a screen the hand-over could not see, so the one figure the patient actually
 * asks for — what do I owe — was never on the same surface as the work that
 * created it.
 *
 * So it is one surface now, and the three things it does are regions of it
 * rather than places you go:
 *
 *   COUNTER SALE is always there, with the scan/search field in focus, because
 *   a walk-in asking for paracetamol is the commonest thing that happens here.
 *
 *   PRESCRIPTION MODE fills the same surface from a signed order — patient,
 *   doctor, prescribed lines, what has already been supplied, what is left, and
 *   the bill and the consultation fee that go with it. It does not replace the
 *   basket; a patient collecting medicine may also buy a toothbrush.
 *
 *   THE BILL sits beside both and is the only place money is taken, so the
 *   consultation fee, the medicine handed over and anything sold across the
 *   counter reach the patient as one amount due.
 *
 * Four rules run through all of it.
 *
 *   NOTHING HERE MOVES ANYTHING. Opening a prescription, typing a `Supply now`
 *   quantity, choosing a substitute and adding a line to a basket are local
 *   state. Stock leaves the shelf and money is taken in exactly three commands,
 *   each behind a confirmation that states what will move.
 *
 *   THE SERVER DOES THE ARITHMETIC THAT MATTERS. Amounts are sent as the
 *   counter typed them, and every total that ends up on a bill is computed
 *   where the money is. Figures shown here are read off the snapshot or are
 *   labelled an estimate from the shelf.
 *
 *   A RESULT IS THE BACKEND'S WORD. Each of the three commands owns a
 *   `useTask`: its own working label, its own confirmed result, and its own
 *   refusal. A request that did not come back is never reported as a refusal,
 *   and a response carrying `duplicate` is never reported as a fresh success.
 *
 *   THE EVIDENCE STAYS. Closing a result overlay clears the overlay. Only
 *   `New sale` clears the counter.
 */

const may = (roles: Role[], allowed: Role[]) => roles.some((role) => allowed.includes(role))

function dayText(value: string | undefined): string {
  if (!value) return 'Not set'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : formatDay(value)
}

/**
 * Every patient this desk can put a name to.
 *
 * The counter is not on the patient register — the snapshot sends the pharmacy
 * a list of bare ids — so the names it does have come from the documents it is
 * allowed to see: the prescriptions in its queue, the bills on its screen and
 * the balances it collects against. Anybody on none of those cannot be attached
 * to a sale here, which is honest: the counter has never been told who they are.
 */
function knownPatients(data: ClinicSnapshot): Array<{ id: string; name: string }> {
  const names = new Map<string, string>()
  for (const patient of data.patients) {
    if (patient.name) names.set(patient.id, patient.name)
  }
  for (const balance of data.patientBalances) {
    if (balance.patientName) names.set(balance.patientId, balance.patientName)
  }
  for (const invoice of data.invoices) {
    if (invoice.patientId && invoice.patientName) names.set(invoice.patientId, invoice.patientName)
  }
  for (const prescription of data.prescriptions) {
    if (prescription.patientName) names.set(prescription.patientId, prescription.patientName)
  }
  return [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** One basket line: a medicine and however the pharmacist counted it out. */
type SaleLine = { key: string; medicineId: string; counts: Record<string, string> }

/** A pharmacist's recorded decision to supply a different product. */
type Swap = { medicineId: string; reason: string }

type HandOverRecordData = {
  dispenseNumber: string
  charged: string
  lines: string[]
  patientName: string
  prescriptionNumber: string
  duplicate: boolean
}

type SaleRecordData = {
  receiptNumber: string
  total: string
  receipts: string[]
  patientName: string
  duplicate: boolean
}

type PaymentRecordData = {
  receipts: string[]
  amount: string
  due: string
  invoiceNumber: string
  patientName: string
  methods: string
  duplicate: boolean
}

/** Which record is being sent to the printer, so only that one becomes paper. */
type Printing = 'handover' | 'sale' | 'payment' | null

/* =========================================================== the one counter */

export function CounterPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const roles = data.session.roles

  /*
   * The role mirror, and it mirrors the command gates in `_shared/counter.ts`
   * exactly. Policy register item 17: medicine across this counter is a
   * pharmacist's, prescription or not; money is admin's and pharmacy's. An
   * administrator is not shown a disabled hand-over control — they are shown no
   * hand-over control, because a button that can only be refused teaches
   * somebody to press it.
   */
  const mayDispense = may(roles, ['pharmacy'])
  const maySell = may(roles, ['pharmacy'])

  // ── the counter's mode ──────────────────────────────────────────────────
  const [openRxId, setOpenRxId] = useState('')
  const [queueOpen, setQueueOpen] = useState(false)
  const [invoiceId, setInvoiceId] = useState('')
  const [printing, setPrinting] = useState<Printing>(null)

  // ── supplying a prescription ────────────────────────────────────────────
  const [give, setGive] = useState<Record<string, string>>({})
  const [swap, setSwap] = useState<Record<string, Swap>>({})
  const [note, setNote] = useState('')
  const [dispenseKeys, setDispenseKeys] = useState<Record<string, string>>({})

  // ── the basket ──────────────────────────────────────────────────────────
  const [lines, setLines] = useState<SaleLine[]>([])
  const [search, setSearch] = useState('')
  const [draftMedicine, setDraftMedicine] = useState('')
  const [draftCounts, setDraftCounts] = useState<Record<string, string>>({})
  const [salePatientId, setSalePatientId] = useState('')
  const [saleParts, setSaleParts] = useState<PartDraft[]>([blankPart()])
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID())

  // ── the bill ────────────────────────────────────────────────────────────
  const [parts, setParts] = useState<PartDraft[]>([blankPart()])
  const [payNote, setPayNote] = useState('')
  const [payKeys, setPayKeys] = useState<Record<string, string>>({})
  const [later, setLater] = useState<string | null>(null)

  // ── what has happened at this counter, until New sale ───────────────────
  const [handOverRecord, setHandOverRecord] = useState<HandOverRecordData | null>(null)
  const [saleRecord, setSaleRecord] = useState<SaleRecordData | null>(null)
  const [paymentRecord, setPaymentRecord] = useState<PaymentRecordData | null>(null)

  const supply = useTask()
  const sale = useTask()
  const payment = useTask()

  const searchRef = useRef<HTMLInputElement>(null)

  // The plan's landing rule: a pharmacist arrives ready to sell, with the
  // scan/search field already carrying the caret.
  useEffect(() => {
    if (maySell) searchRef.current?.focus()
  }, [maySell])

  /*
   * Printing one record and not the other two.
   *
   * The print stylesheet turns `data-print="sheet"` into the page and hides
   * everything else, so with three records on screen at once the choice of
   * which becomes paper has to be made before the dialog opens. The state
   * lands in the DOM first; the effect prints what is now there.
   */
  useEffect(() => {
    if (!printing) return
    window.print()
    setPrinting(null)
  }, [printing])

  /* ------------------------------------------------------------- the queue */

  const queue = useMemo(
    () => (mayDispense ? data.prescriptions.filter((rx) => rx.items.some(isPending)) : []),
    [data.prescriptions, mayDispense],
  )
  const today = clinicToday()
  const finishedToday = useMemo(
    () =>
      mayDispense
        ? data.prescriptions.filter(
            (rx) => !rx.items.some(isPending) && clinicDayOf(rx.signedAt) === today,
          )
        : [],
    [data.prescriptions, mayDispense, today],
  )

  // Looked up across every prescription rather than only the waiting ones, so
  // that the prescription a pharmacist has just finished stays on the screen
  // reading `Supplied` instead of vanishing at the moment of success.
  const openRx = openRxId
    ? data.prescriptions.find((rx) => rx.id === openRxId)
    : undefined
  const serving = openRx ? openRx.patientId : salePatientId
  const servingName = openRx
    ? openRx.patientName
    : knownPatients(data).find((patient) => patient.id === salePatientId)?.name ?? ''

  /* -------------------------------------------------------------- the bill */

  /*
   * Three lists, not two.
   *
   * An over-refunded bill would otherwise fall into Due now — its `due` is
   * larger than its total — and the counter would open a payment form the
   * server refuses. It is neither owed nor settled, so it gets its own list and
   * its own explanation.
   *
   * A cancelled bill carrying money is the same kind of thing and is not on
   * this screen in any list: `live` drops it first, and the bill this counter
   * opens is looked up within `live`, so neither the sidebar nor a hand-over's
   * returned invoice id can reach one. That is the right answer — a bill the
   * clinic has cancelled collects nothing — and it is Billing's to settle. The
   * test below is written as "is this an exception" rather than naming one of
   * the two states, so that if one ever does arrive here it lands under With
   * the administrator and meets the notice, rather than a payment form.
   */
  const live = data.invoices.filter((invoice) => invoice.status !== 'void')
  const underReview = live.filter(isUnderReview)
  const collectable = live.filter((invoice) => !isUnderReview(invoice))
  const owing = collectable.filter((invoice) => invoice.due > 0)
  const settled = collectable.filter((invoice) => invoice.due <= 0)
  const owed = owing.reduce((total, invoice) => total + invoice.due, 0)

  const chosenInvoice = invoiceId ? live.find((item) => item.id === invoiceId) : undefined
  const patientInvoice = useMemo(() => {
    if (!serving) return undefined
    const mine = live
      .filter((item) => item.patientId === serving)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const open = mine.filter((item) => !isUnderReview(item))
    return open.find((item) => item.due > 0) ?? open[0] ?? mine[0]
    // `live` is rebuilt on every render from the snapshot; the identity that
    // matters is the snapshot and the patient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.invoices, serving])

  const invoice = chosenInvoice ?? patientInvoice ?? owing[0] ?? settled[0] ?? underReview[0]

  const feePaise = sourcePaise(invoice, 'consultation_fee')
  const medicinePaise = sourcePaise(invoice, 'prescription')
  const otcPaise = sourcePaise(invoice, 'otc')
  const adjustmentPaise = sourcePaise(invoice, 'adjustment')

  /* ------------------------------------------------------ supply arithmetic */

  const supplyable = openRx ? openRx.items.filter(isSupplyable) : []
  const blocking = openRx
    ? openRx.items.filter((item) => item.supplyState === 'needs_review' || item.needsReview)
    : []
  // A line from before per-line supply existed carries no identifier to name
  // back, so those prescriptions go over whole or not at all.
  const identified = supplyable.every((item) => Boolean(item.prescriptionLineId))
  const moving = supplyable
    .map((item) => ({
      item,
      quantity: identified ? typedFor(item, give) : remainingOf(item),
      swap: item.prescriptionLineId ? swap[item.prescriptionLineId] : undefined,
    }))
    .filter((row) => row.quantity > 0)
  const partialAgainstOrder =
    openRx?.supplyInParts === false &&
    moving.some((row) => row.quantity < remainingOf(row.item))
  const leftAfter = supplyable.reduce(
    (total, item) =>
      total + Math.max(remainingOf(item) - (identified ? typedFor(item, give) : remainingOf(item)), 0),
    0,
  )

  const supplyRefusal = !openRx
    ? 'Open a waiting prescription first.'
    : openRx.expired
      ? `This prescription could be supplied until ${dayText(openRx.validUntil)}. The remainder needs a new or amended order from the doctor.`
      : blocking.length > 0
        ? `${blocking[0].medicineName} must be resolved by a doctor before anything on this prescription is handed over.`
        : !mayDispense
          ? 'Medicine is handed over by the pharmacy. An administrator can review a hand-over, and void, refund or reverse it, but cannot make one.'
          : moving.length === 0
            ? 'Enter a quantity against at least one line.'
            : partialAgainstOrder
              ? 'This prescription is marked to be supplied in one go. Give the whole remaining quantity of every line, or none of it.'
              : undefined

  /* ------------------------------------------------------ basket arithmetic */

  const sellable = useMemo(
    () => data.medicines.filter((medicine) => medicine.active && medicine.saleClass === 'otc'),
    [data.medicines],
  )
  const patients = useMemo(() => knownPatients(data), [data])

  const query = search.trim().toLowerCase()
  const scanned = useMemo(() => {
    if (!query) return undefined
    const mapped = data.medicineBarcodes.find((code) => code.code.toLowerCase() === query)
    const id =
      mapped?.medicineId ??
      sellable.find((medicine) => medicine.barcode && medicine.barcode.toLowerCase() === query)?.id
    return id ? sellable.find((medicine) => medicine.id === id) : undefined
  }, [data.medicineBarcodes, sellable, query])

  const matches = useMemo(() => {
    if (!query) return sellable.slice(0, 8)
    const hits = sellable.filter((medicine) =>
      [
        medicine.name,
        medicine.brandName,
        medicine.genericName,
        medicine.strength,
        medicine.dosageForm,
        medicine.route,
        medicine.code,
        medicine.barcode,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
    return (scanned ? [scanned, ...hits.filter((hit) => hit.id !== scanned.id)] : hits).slice(0, 8)
  }, [sellable, query, scanned])

  const draft = sellable.find((medicine) => medicine.id === draftMedicine) ?? matches[0]
  const draftPackage = packageOf(data, draft)
  const draftLevels = draftPackage ? draftPackage.levels.filter((level) => level.sellable) : []
  const draftBaseUnit = draftPackage?.baseUnit || draft?.baseUnit || draft?.unit || 'unit'
  const draftCounted = countsToBase(draftLevels, draftCounts)
  const draftQuantity = countedQuantity(draftPackage, draftLevels, draftCounts)
  const draftPrice = draft ? estimatePaise(data, draft.id, draftQuantity) : undefined

  const priced = lines.map((line) => {
    const medicine = data.medicines.find((item) => item.id === line.medicineId)
    const version = packageOf(data, medicine)
    const levels = version ? version.levels.filter((level) => level.sellable) : []
    const counted = countsToBase(levels, line.counts)
    const baseUnit = version?.baseUnit || medicine?.baseUnit || medicine?.unit || 'unit'
    const quantity = countedQuantity(version, levels, line.counts)
    return {
      line,
      medicine,
      version,
      levels,
      quantity,
      baseUnit,
      said: version ? counted.said : `${quantity} ${plural(baseUnit, quantity)}`,
      paise: medicine ? estimatePaise(data, medicine.id, quantity) : undefined,
    }
  })

  const estimate = priced.reduce<number | undefined>(
    (total, row) => (total === undefined || row.paise === undefined ? undefined : total + row.paise),
    0,
  )

  // Policy register 45 and 46: an unverified or non-OTC classification cannot
  // cross the counter without a patient attached to it.
  const anonymousBlock = serving
    ? undefined
    : priced.find(
        (row) => row.medicine && (row.medicine.schedule !== 'OTC' || !row.medicine.scheduleVerified),
      )?.medicine

  const saleTyped = partsTotal(saleParts)
  const saleProblem = !maySell
    ? 'A counter sale is made by the pharmacy. An administrator can review a sale, and refund or reverse it, but cannot make one.'
    : lines.length === 0
      ? 'Add at least one medicine to the sale.'
      : priced.some((row) => row.quantity <= 0)
        ? 'Every line needs a quantity above zero.'
        : priced.some((row) => row.paise === undefined)
          ? 'One of these lines asks for more than is on the shelf.'
          : anonymousBlock
            ? `${anonymousBlock.name} has not been verified as an over-the-counter medicine, so it cannot be sold anonymously.`
            : serving
              ? undefined
              : saleTyped === undefined
                ? 'One of the payment amounts is not an amount in rupees.'
                : partsPayload(saleParts).length === 0
                  ? 'An anonymous sale is paid in full at the counter. Enter what was paid, and how.'
                  : undefined

  /* ----------------------------------------------------- payment arithmetic */

  const duePaise = invoice ? Math.round(invoice.due * 100) : 0
  const payTyped = partsTotal(parts)
  const entered = partsPayload(parts)
  const payingInFull = payTyped !== undefined && payTyped >= duePaise
  const outstanding = serving ? stillToCollect(data.prescriptions, serving) : { lines: 0, units: 0 }

  const payProblem = !invoice
    ? 'No bill is open.'
    : isUnderReview(invoice)
      ? 'This bill is with the administrator. Nothing can be taken against it here.'
      : invoice.due <= 0
        ? 'This bill is settled. There is nothing left to take.'
        : payTyped === undefined
          ? 'One of those amounts is not an amount in rupees.'
          : entered.length === 0
            ? 'Enter what is being paid, and how.'
            : payTyped > duePaise
              ? `${fromPaise(payTyped)} was entered against ${money(invoice.due)} due.`
              : undefined

  /* ------------------------------------------------------ idempotency keys */

  /**
   * One key per hand-over attempt, kept across refusals.
   *
   * If the request went out and the answer was lost, pressing again with the
   * same key returns the first hand-over rather than making a second one. A
   * hand-over that actually completed mints a new key, so the remainder can be
   * collected later on its own.
   */
  function dispenseKeyFor(prescriptionId: string): string {
    const existing = dispenseKeys[prescriptionId]
    if (existing) return existing
    const minted = crypto.randomUUID()
    setDispenseKeys((current) =>
      current[prescriptionId] ? current : { ...current, [prescriptionId]: minted },
    )
    return minted
  }

  /**
   * One payment key per bill, not one per counter session.
   *
   * This was a single key minted when the payment station mounted and rotated
   * only after a success, which is right in every respect except that it was
   * not tied to the bill it was paying for. The server's duplicate check asks
   * only "have I seen this key?" and not "on this invoice?", so:
   *
   *   take ₹300 on INV-A → the reply is lost on the clinic Wi-Fi →
   *   the key is kept (correctly, so a retry cannot double-charge INV-A) →
   *   the pharmacist moves on and takes ₹500 on INV-B →
   *   the server recognises the key, charges nothing, and answers with
   *   INV-A's receipt →
   *   the screen renders a receipt headed INV-B.
   *
   * INV-B is never paid and the counter says it was. Keying per bill closes it:
   * the retry on INV-A still dedupes, and INV-B carries a key the clinic has
   * never seen, so it is charged exactly once. `payKeys` is kept rather than
   * replaced so that moving to another bill and back does not mint a second key
   * for a payment that may already be in the ledger.
   */
  function payKeyFor(bill: string): string {
    const existing = payKeys[bill]
    if (existing) return existing
    const minted = crypto.randomUUID()
    setPayKeys((current) => (current[bill] ? current : { ...current, [bill]: minted }))
    return minted
  }

  /* ------------------------------------------------------------- the three */

  async function handOver() {
    if (!openRx) return
    const rx = openRx
    const rows = moving
    const supplied = rows.reduce((total, row) => total + row.quantity, 0)
    const remainder = leftAfter

    const result = await supply.run({
      working: 'Handing over medicines…',
      request: () =>
        run('dispense_rx', {
          prescriptionId: rx.id,
          idempotencyKey: dispenseKeyFor(rx.id),
          note: note.trim() || undefined,
          ...(identified
            ? {
                lines: rows.map((row) => ({
                  prescriptionLineId: row.item.prescriptionLineId,
                  quantity: row.quantity,
                  ...(row.swap
                    ? { medicineId: row.swap.medicineId, substitutionReason: row.swap.reason }
                    : {}),
                })),
              }
            : {}),
        }),
      confirmed: (answer) => {
        const payload = (answer.data ?? {}) as {
          dispenseNumber?: string
          charged?: string
          lines?: string[]
          duplicate?: boolean
        }
        if (payload.duplicate) {
          return {
            kind: 'partial',
            title: 'Already handed over',
            icon: 'question-circle',
            identity: `${rx.patientName} · ${payload.dispenseNumber ?? rx.prescriptionNumber}`,
            detail: `${payload.dispenseNumber ?? 'This hand-over'} was already handed over. Nothing was given twice.`,
            dwell: DWELL_MAJOR,
          } satisfies TaskOutcome
        }
        const charged = Number(payload.charged) || 0
        return {
          kind: remainder > 0 ? 'partial' : 'confirmed',
          title: remainder > 0 ? 'Part of the prescription handed over' : 'Medicines handed over',
          icon: remainder > 0 ? 'clock' : 'bag',
          identity: `${rx.patientName} · ${payload.dispenseNumber ?? rx.prescriptionNumber}`,
          detail: (payload.lines ?? []).join(' · ') || `${supplied} supplied`,
          facts: [
            { label: 'Added to the bill', value: money(charged) },
            {
              label: 'Still to collect',
              value: remainder > 0 ? `${remainder}` : 'Nothing',
            },
          ],
          dwell: DWELL_MAJOR,
        } satisfies TaskOutcome
      },
    })

    if (!result?.ok) return
    const payload = (result.data ?? {}) as {
      dispenseNumber?: string
      invoiceId?: string
      charged?: string
      lines?: string[]
      duplicate?: boolean
    }
    const duplicate = payload.duplicate === true

    setHandOverRecord({
      dispenseNumber: payload.dispenseNumber ?? '',
      charged: payload.charged ?? '0.00',
      lines: payload.lines ?? [],
      patientName: rx.patientName,
      prescriptionNumber: rx.prescriptionNumber,
      duplicate,
    })
    if (payload.invoiceId) setInvoiceId(payload.invoiceId)

    if (duplicate) return
    // This attempt is over. The remainder collected later is a new event and
    // needs a key the clinic has not seen.
    setDispenseKeys((current) => {
      const next = { ...current }
      delete next[rx.id]
      return next
    })
    setGive((current) => {
      const next = { ...current }
      for (const row of rows) {
        if (row.item.prescriptionLineId) delete next[row.item.prescriptionLineId]
      }
      return next
    })
    setSwap((current) => {
      const next = { ...current }
      for (const row of rows) {
        if (row.item.prescriptionLineId) delete next[row.item.prescriptionLineId]
      }
      return next
    })
    setNote('')
  }

  async function ringUp() {
    const attached = serving
    const total = estimate
    const result = await sale.run({
      working:
        total === undefined ? 'Ringing up the sale…' : `Ringing up ${fromPaise(total)}…`,
      request: () =>
        run('otc_sale', {
          idempotencyKey: saleKey,
          patientId: attached || undefined,
          // Policy register 48: an over-the-counter line bought during a visit
          // joins that visit's bill rather than opening a second one.
          // `openInvoice` reuses the encounter's invoice — the counter simply
          // never told it which encounter this was.
          encounterId: (attached && patientInvoice?.encounterId) || undefined,
          lines: priced.map((row) =>
            row.version
              ? { medicineId: row.line.medicineId, entry: countsToEntry(row.levels, row.line.counts) }
              : { medicineId: row.line.medicineId, quantity: row.quantity },
          ),
          parts: attached ? [] : partsPayload(saleParts),
        }),
      confirmed: (answer) => {
        const payload = (answer.data ?? {}) as {
          receiptNumber?: string
          total?: string
          receipts?: string[]
          duplicate?: boolean
        }
        if (payload.duplicate) {
          return {
            kind: 'partial',
            title: 'Already rung up',
            icon: 'question-circle',
            identity: payload.receiptNumber ?? '',
            detail: `${payload.receiptNumber ?? 'This sale'} was already rung up. Nothing was sold twice.`,
            dwell: DWELL_MAJOR,
          } satisfies TaskOutcome
        }
        const sold = Number(payload.total) || 0
        const collected = (payload.receipts ?? []).length > 0
        return {
          kind: attached && !collected ? 'partial' : 'confirmed',
          title: attached && !collected ? 'Sold — on the bill' : 'Sale completed',
          icon: attached && !collected ? 'clock' : 'pack',
          identity: `${payload.receiptNumber ?? ''}${attached ? ` · ${servingName}` : ''}`,
          detail:
            attached && !collected
              ? `${money(sold)} added to the bill. Take it below with the rest of what is due.`
              : `${money(sold)} collected`,
          facts: [
            { label: 'Lines', value: `${lines.length}` },
            {
              label: 'Receipts',
              value: (payload.receipts ?? []).join(', ') || 'None — on the bill',
            },
          ],
          dwell: DWELL_MAJOR,
        } satisfies TaskOutcome
      },
    })

    if (!result?.ok) return
    const payload = (result.data ?? {}) as {
      receiptNumber?: string
      total?: string
      receipts?: string[]
      invoiceId?: string
      duplicate?: boolean
    }
    const duplicate = payload.duplicate === true

    setSaleRecord({
      receiptNumber: payload.receiptNumber ?? '',
      total: payload.total ?? '0.00',
      receipts: payload.receipts ?? [],
      patientName: attached ? servingName : '',
      duplicate,
    })
    if (payload.invoiceId) setInvoiceId(payload.invoiceId)

    if (duplicate) return
    /*
     * The basket is NOT cleared here.
     *
     * It used to be — the lines, the parts and the patient all went at the
     * moment the command answered, which meant the record of what had just been
     * sold rendered beside an empty counter and the pharmacist had nothing left
     * to check it against. The basket stays, frozen and marked sold, and only
     * `New sale` clears it. What does rotate is the key: this sale is in the
     * ledger, and the next one must not dedupe against it.
     */
    setSaleKey(crypto.randomUUID())
  }

  async function takePayment() {
    if (!invoice) return
    const bill = invoice
    const amount = payTyped === undefined ? undefined : payTyped
    const methods = entered.map((part) => METHOD_LABEL[part.method]).join(' + ') || 'no method'

    const result = await payment.run({
      working: amount === undefined ? 'Receiving payment…' : `Receiving ${fromPaise(amount)}…`,
      request: () =>
        run('take_payment', {
          invoiceId: bill.id,
          idempotencyKey: payKeyFor(bill.id),
          parts: entered,
          note: payNote.trim() || undefined,
        }),
      confirmed: (answer) => {
        const payload = (answer.data ?? {}) as {
          receipts?: string[]
          taken?: string
          due?: string
          duplicate?: boolean
        }
        if (payload.duplicate) {
          return {
            kind: 'partial',
            title: 'Already taken',
            icon: 'question-circle',
            identity: `${bill.patientName ?? 'Counter sale'} · ${bill.invoiceNumber}`,
            detail: `Receipt ${(payload.receipts ?? []).join(', ') || 'for this payment'} was already taken. Nothing was charged twice.`,
            dwell: DWELL_MAJOR,
          } satisfies TaskOutcome
        }
        const taken = Number(payload.taken) || 0
        const dueAfter = Number(payload.due) || 0
        const receipts = (payload.receipts ?? []).join(', ')
        const facts = [
          { label: 'Method', value: methods },
          { label: 'Receipt', value: receipts || 'Not numbered' },
          { label: 'Balance', value: dueAfter <= 0 ? '₹0' : money(dueAfter) },
          {
            label: 'Still to collect',
            value:
              outstanding.lines > 0
                ? `${outstanding.units} on ${outstanding.lines} ${outstanding.lines === 1 ? 'line' : 'lines'}`
                : 'Nothing',
          },
        ]
        return dueAfter <= 0
          ? ({
              kind: 'confirmed',
              title: 'Payment received',
              icon: 'rupee',
              identity: `${bill.patientName ?? 'Counter sale'} · ${bill.invoiceNumber}`,
              detail: `${money(taken)} received · Balance ₹0`,
              facts,
              dwell: DWELL_MAJOR,
            } satisfies TaskOutcome)
          : ({
              kind: 'partial',
              title: 'Part payment received',
              icon: 'clock',
              identity: `${bill.patientName ?? 'Counter sale'} · ${bill.invoiceNumber}`,
              detail: `${money(taken)} received · ${money(dueAfter)} still due`,
              facts,
              dwell: DWELL_MAJOR,
            } satisfies TaskOutcome)
      },
    })

    // A refusal and a lost answer both keep the key. Pressing again then asks
    // the clinic about THIS payment rather than starting a second one.
    if (!result?.ok) return
    const payload = (result.data ?? {}) as {
      receipts?: string[]
      taken?: string
      due?: string
      duplicate?: boolean
    }
    const duplicate = payload.duplicate === true

    setPaymentRecord({
      receipts: payload.receipts ?? [],
      amount: payload.taken ?? '0.00',
      due: payload.due ?? '0.00',
      invoiceNumber: bill.invoiceNumber,
      patientName: bill.patientName ?? 'Counter sale',
      methods,
      duplicate,
    })
    setLater(null)

    if (duplicate) return
    setParts([blankPart()])
    setPayNote('')
    // Settled or part paid, this attempt is over. The next payment on the same
    // bill — a part payment followed by the balance — is a new event and needs
    // a key the clinic has not seen.
    setPayKeys((current) => {
      const next = { ...current }
      delete next[bill.id]
      return next
    })
  }

  /* --------------------------------------------------------------- the desk */

  function openPrescription(id: string) {
    setOpenRxId(id)
    setQueueOpen(false)
    setInvoiceId('')
    setSalePatientId('')
  }

  function closePrescription() {
    setOpenRxId('')
    setGive({})
    setSwap({})
    setNote('')
    setInvoiceId('')
  }

  /**
   * The counter, cleared on purpose.
   *
   * Dismissing a result never does this — the plan is explicit that the
   * evidence outlives the popup — so the only thing that empties the basket,
   * closes the prescription and forgets the records is a pharmacist saying so.
   *
   * The idempotency keys deliberately survive it. A key still in the map
   * belongs to an attempt whose outcome nobody knows, and throwing it away is
   * how the same money gets taken twice.
   */
  function newSale() {
    setOpenRxId('')
    setGive({})
    setSwap({})
    setNote('')
    setLines([])
    setSearch('')
    setDraftMedicine('')
    setDraftCounts({})
    setSalePatientId('')
    setSaleParts([blankPart()])
    setParts([blankPart()])
    setPayNote('')
    setInvoiceId('')
    setLater(null)
    setHandOverRecord(null)
    setSaleRecord(null)
    setPaymentRecord(null)
    supply.dismiss()
    sale.dismiss()
    payment.dismiss()
    searchRef.current?.focus()
  }

  const anythingDone = Boolean(handOverRecord || saleRecord || paymentRecord || later)

  return (
    <Stack>
      <PageHeader
        eyebrow="Pharmacy counter"
        title="Counter"
        sub={`${queue.length} ${queue.length === 1 ? 'prescription' : 'prescriptions'} waiting · ${money(owed)} due across ${owing.length} ${owing.length === 1 ? 'bill' : 'bills'}${underReview.length > 0 ? ` · ${underReview.length} ${underReview.length === 1 ? 'bill is' : 'bills are'} under review and with the administrator` : ''}`}
        action={
          <>
            {mayDispense ? (
              <Button
                icon="prescription"
                data-testid="prescriptions-waiting"
                onClick={() => setQueueOpen(true)}
              >
                Prescriptions waiting ({queue.length})
              </Button>
            ) : null}
            <Button
              variant={anythingDone ? 'primary' : 'secondary'}
              icon="plus"
              data-testid="new-sale"
              onClick={newSale}
            >
              New sale
            </Button>
          </>
        }
      />

      <CounterRecords
        data={data}
        printing={printing}
        handOver={handOverRecord}
        sale={saleRecord}
        payment={paymentRecord}
        later={later}
        onPrint={setPrinting}
        onDismissLater={() => setLater(null)}
      />

      <div className="space-y-4" data-testid="counter-surface" data-print="hide">
        {supply.failure || sale.failure || payment.failure ? (
          <div className="space-y-2">
            <TaskFailure
              failure={supply.failure}
              onRetry={openRx && moving.length > 0 ? () => void handOver() : undefined}
              onDismiss={supply.dismiss}
            />
            <TaskFailure
              failure={sale.failure}
              onRetry={lines.length > 0 ? () => void ringUp() : undefined}
              onDismiss={sale.dismiss}
            />
            <TaskFailure
              failure={payment.failure}
              onRetry={invoice && entered.length > 0 ? () => void takePayment() : undefined}
              onDismiss={payment.dismiss}
            />
          </div>
        ) : null}

        <CounterMode
          openRx={openRx}
          servingName={servingName}
          onClose={closePrescription}
          onOpenQueue={mayDispense ? () => setQueueOpen(true) : undefined}
          waiting={queue.length}
        />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <div className="min-w-0 space-y-4">
            {openRx ? (
              <Busy on={supply.busy} label={supply.workingLabel}>
                <PrescriptionPanel
                  data={data}
                  run={run}
                  rx={openRx}
                  give={give}
                  swap={swap}
                  note={note}
                  identified={identified}
                  mayDispense={mayDispense}
                  moving={moving}
                  leftAfter={leftAfter}
                  blocking={blocking}
                  refusal={supplyRefusal}
                  busy={supply.busy}
                  feePaise={feePaise}
                  medicinePaise={medicinePaise}
                  otcPaise={otcPaise}
                  invoice={invoice}
                  onGive={(lineId, raw, remaining) =>
                    setGive((current) => ({ ...current, [lineId]: capQuantity(raw, remaining) }))
                  }
                  onSwap={(lineId, next) =>
                    setSwap((current) => {
                      const map = { ...current }
                      if (next) map[lineId] = next
                      else delete map[lineId]
                      return map
                    })
                  }
                  onNote={setNote}
                  onHandOver={handOver}
                />
              </Busy>
            ) : null}

            <Busy on={sale.busy} label={sale.workingLabel}>
              <SaleBasket
                data={data}
                sellable={sellable}
                matches={matches}
                patients={patients}
                lines={lines}
                priced={priced}
                estimate={estimate}
                search={search}
                searchRef={searchRef}
                draft={draft}
                draftPackage={draftPackage}
                draftLevels={draftLevels}
                draftBaseUnit={draftBaseUnit}
                draftCounts={draftCounts}
                draftCounted={draftCounted}
                draftQuantity={draftQuantity}
                draftPrice={draftPrice}
                parts={saleParts}
                problem={saleProblem}
                anonymousBlock={anonymousBlock}
                maySell={maySell}
                busy={sale.busy}
                sold={saleRecord}
                lockedPatientName={openRx ? openRx.patientName : ''}
                patientId={salePatientId}
                serving={serving}
                onSearch={(value) => {
                  setSearch(value)
                  setDraftMedicine('')
                  setDraftCounts({})
                }}
                onPick={(id) => {
                  setDraftMedicine(id)
                  setDraftCounts({})
                }}
                onCounts={setDraftCounts}
                onAdd={() => {
                  if (!draft || draftQuantity <= 0) return
                  setLines((current) => [
                    ...current,
                    { key: crypto.randomUUID(), medicineId: draft.id, counts: { ...draftCounts } },
                  ])
                  setDraftCounts({})
                  setSearch('')
                  setDraftMedicine('')
                  searchRef.current?.focus()
                }}
                onRemove={(key) =>
                  setLines((current) => current.filter((item) => item.key !== key))
                }
                onPatient={(id) => {
                  setSalePatientId(id)
                  setInvoiceId('')
                }}
                onParts={setSaleParts}
                onRingUp={ringUp}
              />
            </Busy>
          </div>

          <Busy on={payment.busy} label={payment.workingLabel} className="min-w-0">
            <BillPanel
              invoice={invoice}
              owing={owing}
              settled={settled}
              underReview={underReview}
              selectedId={invoice?.id ?? ''}
              feePaise={feePaise}
              medicinePaise={medicinePaise}
              otcPaise={otcPaise}
              adjustmentPaise={adjustmentPaise}
              parts={parts}
              payNote={payNote}
              problem={payProblem}
              payingInFull={payingInFull}
              typed={payTyped}
              duePaise={duePaise}
              busy={payment.busy}
              globalBusy={busy}
              outstanding={outstanding}
              onSelect={(id) => setInvoiceId(id)}
              onParts={setParts}
              onNote={setPayNote}
              onTake={takePayment}
              onLater={() => {
                if (!invoice) return
                setParts([blankPart()])
                setPayNote('')
                setLater(
                  `Nothing was taken. ${money(invoice.due)} stays due on ${invoice.invoiceNumber} and on ${invoice.patientName ?? 'the patient'}’s balance.`,
                )
              }}
            />
          </Busy>
        </div>
      </div>

      <TaskResult
        outcome={supply.outcome}
        onDismiss={supply.dismiss}
        next={{ label: 'New sale', onPress: newSale }}
      />
      <TaskResult
        outcome={sale.outcome}
        onDismiss={sale.dismiss}
        next={{ label: 'New sale', onPress: newSale }}
      />
      <TaskResult
        outcome={payment.outcome}
        onDismiss={payment.dismiss}
        next={{ label: 'New sale', onPress: newSale }}
      />

      {mayDispense ? (
        <WaitingDrawer
          open={queueOpen}
          queue={queue}
          finishedToday={finishedToday}
          openRxId={openRxId}
          onOpen={openPrescription}
          onClose={() => setQueueOpen(false)}
        />
      ) : null}
    </Stack>
  )
}

/* ================================================================= the mode */

/** Which counter this is right now, said in one line at the top of it. */
function CounterMode({
  openRx,
  servingName,
  onClose,
  onOpenQueue,
  waiting,
}: {
  openRx: PrescriptionView | undefined
  servingName: string
  onClose: () => void
  onOpenQueue?: () => void
  waiting: number
}) {
  if (!openRx) {
    return (
      <div
        data-testid="counter-mode"
        className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-rule bg-paper px-4 py-3"
      >
        <p className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
          <Icon name="counter" size={20} className="shrink-0 text-ink-2" />
          <span className="min-w-0">
            Over-the-counter sale
            {servingName ? (
              <span className="font-normal text-ink-2"> · for {servingName}</span>
            ) : (
              <span className="font-normal text-ink-2"> · walk-in</span>
            )}
          </span>
        </p>
        {onOpenQueue ? (
          <p className="text-[13px] text-ink-2">
            {waiting === 0
              ? 'No prescription is waiting.'
              : `${waiting} ${waiting === 1 ? 'prescription is' : 'prescriptions are'} waiting to be handed over.`}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div
      data-testid="prescription-mode"
      className="flex flex-wrap items-center justify-between gap-3 rounded-box border-2 border-ink bg-active-wash px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Icon name="prescription" size={22} className="shrink-0" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">Prescription {openRx.prescriptionNumber}</p>
          <p className="mt-0.5 truncate text-[13px] text-ink-2">
            {openRx.patientName} · signed {formatDay(openRx.signedAt)} by {openRx.doctorName}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Token code={openRx.prescriptionNumber} />
        <Button variant="ghost" icon="close" onClick={onClose}>
          Close prescription
        </Button>
      </div>
    </div>
  )
}

/* =============================================== the waiting-prescription list */

function WaitingDrawer({
  open,
  queue,
  finishedToday,
  openRxId,
  onOpen,
  onClose,
}: {
  open: boolean
  queue: PrescriptionView[]
  finishedToday: PrescriptionView[]
  openRxId: string
  onOpen: (id: string) => void
  onClose: () => void
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Prescriptions waiting"
      sub={`${queue.length} to hand over`}
      width="sm"
    >
      <div className="space-y-2" data-testid="waiting-list">
        {queue.length === 0 ? (
          <EmptyState
            title="No prescription is waiting"
            direction="A doctor signs a consultation with medicine on it and it arrives here. The counter stays ready for an over-the-counter sale meanwhile."
          />
        ) : (
          queue.map((rx) => {
            const current = rx.id === openRxId
            return (
              <button
                key={rx.id}
                type="button"
                aria-pressed={current}
                onClick={() => onOpen(rx.id)}
                className={`block min-h-[56px] w-full rounded-box border px-3 py-2 text-left transition-colors duration-150 ${
                  current ? 'border-ink bg-active-wash' : 'border-rule bg-sheet hover:bg-paper/60'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[15px] font-semibold">{rx.patientName}</span>
                  {current ? <span className="eyebrow shrink-0">Open</span> : null}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-2">
                  {rx.prescriptionNumber} · {formatDate(rx.signedAt)}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {rx.expired ? <Badge tone="stop">Expired</Badge> : null}
                  {rx.items.some(
                    (item) => item.supplyState === 'needs_review' || item.needsReview,
                  ) ? (
                    <Badge tone="stop">Needs review</Badge>
                  ) : null}
                  {rx.items.some((item) => item.supplyState === 'part_supplied') ? (
                    <Badge tone="attn">Part supplied</Badge>
                  ) : null}
                </span>
              </button>
            )
          })
        )}

        {finishedToday.length > 0 ? (
          <div className="pt-3">
            <SectionHeader title="Finished today" sub={`${finishedToday.length} closed`} />
            <ul className="mt-2 space-y-1">
              {finishedToday.map((rx) => (
                <li key={rx.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate">{rx.patientName}</span>
                  <span className="shrink-0 font-mono text-ink-2">{rx.prescriptionNumber}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

/* ================================================= prescription mode, filled */

type MovingRow = { item: PrescriptionItemView; quantity: number; swap: Swap | undefined }

function PrescriptionPanel({
  data,
  run,
  rx,
  give,
  swap,
  note,
  identified,
  mayDispense,
  moving,
  leftAfter,
  blocking,
  refusal,
  busy,
  feePaise,
  medicinePaise,
  otcPaise,
  invoice,
  onGive,
  onSwap,
  onNote,
  onHandOver,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  rx: PrescriptionView
  give: Record<string, string>
  swap: Record<string, Swap>
  note: string
  identified: boolean
  mayDispense: boolean
  moving: MovingRow[]
  leftAfter: number
  blocking: PrescriptionItemView[]
  refusal: string | undefined
  busy: boolean
  feePaise: number
  medicinePaise: number
  otcPaise: number
  invoice: InvoiceView | undefined
  onGive: (lineId: string, raw: string, remaining: number) => void
  onSwap: (lineId: string, next: Swap | undefined) => void
  onNote: (value: string) => void
  onHandOver: () => Promise<void>
}) {
  const global = useBusy()

  return (
    <Card variant="record">
      <CardHeader
        title="Prescription"
        sub={`${rx.patientName} · ${rx.prescriptionNumber}`}
        action={<Token code={rx.prescriptionNumber} />}
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Signed" value={formatDay(rx.signedAt)} note={rx.doctorName} />
          <Figure label="Valid until" value={dayText(rx.validUntil)} />
          <Figure
            label="Validity"
            value={rx.expired ? 'Expired' : 'In date'}
            note={rx.expired ? 'Only a new order can supply it' : undefined}
          />
          <Figure
            label="Supply"
            value={rx.supplyInParts === false ? 'In one go' : 'May be split'}
            note={
              rx.supplyInParts === false
                ? 'The doctor directed one supply'
                : 'The remainder may be collected later'
            }
          />
        </div>

        {/*
         * The money, on the screen where the medicine is.
         *
         * This is the whole reason the counter was unified. The consultation
         * fee was raised when the doctor completed the encounter and sat on a
         * station the hand-over could not see, so a pharmacist counting out
         * tablets had no idea the patient owed ₹200 for the visit and the
         * patient had to be sent to another queue to find out.
         */}
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-testid="prescription-money"
        >
          <Figure
            label="Consultation fee"
            value={feePaise > 0 ? fromPaise(feePaise) : 'Not billed'}
            note={feePaise > 0 ? 'Collected at this counter' : 'No fee on this bill yet'}
          />
          <Figure
            label="Medicines billed"
            value={fromPaise(medicinePaise + otcPaise)}
            note={otcPaise > 0 ? 'Prescription and counter sale' : 'Supplied so far'}
          />
          <Figure label="Bill" value={invoice ? invoice.invoiceNumber : 'None yet'} />
          <Figure
            label="Amount due"
            value={invoice ? money(invoice.due) : money(0)}
            strong
            note={invoice ? undefined : 'No bill has been raised for this patient yet'}
          />
        </div>

        {rx.expired ? (
          <Notice tone="bad">
            This prescription could be supplied until {dayText(rx.validUntil)}. Nothing further may
            be handed over against it — the patient needs a new or amended order from the doctor.
          </Notice>
        ) : null}

        {blocking.length > 0 ? (
          <Notice tone="bad">
            {blocking.length === 1 ? 'One line is' : `${blocking.length} lines are`} from before this
            system and {blocking.length === 1 ? 'does' : 'do'} not record enough to supply:{' '}
            <span className="font-semibold">
              {blocking.map((item) => item.medicineName).join(', ')}
            </span>
            . A doctor must resolve {blocking.length === 1 ? 'that line' : 'those lines'} before
            anything on this prescription is handed over.
          </Notice>
        ) : null}

        {!identified && rx.items.some(isSupplyable) ? (
          <Notice>
            This prescription is from before per-line supply was recorded, so it can only be handed
            over whole. Supply now and the product supplied cannot be set line by line on it.
          </Notice>
        ) : null}

        <ol className="space-y-3">
          {rx.items.map((item, index) => (
            <SupplyLine
              key={item.prescriptionLineId || `${rx.id}-${index}`}
              data={data}
              run={run}
              rx={rx}
              item={item}
              index={index}
              give={give}
              swap={item.prescriptionLineId ? swap[item.prescriptionLineId] : undefined}
              identified={identified}
              mayDispense={mayDispense}
              onGive={onGive}
              onSwap={onSwap}
            />
          ))}
        </ol>

        <Field label="Note on this hand-over" hint="Optional. Kept with the dispense record.">
          <Input value={note} disabled={global} onChange={(event) => onNote(event.target.value)} />
        </Field>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t-2 border-ink bg-sheet/95 px-1 py-3 backdrop-blur">
          {mayDispense ? (
            <ConfirmButton
              variant="primary"
              icon="bag"
              busy={busy}
              busyLabel="Handing over medicines…"
              disabled={Boolean(refusal)}
              disabledReason={refusal}
              title="Confirm and hand over"
              confirmLabel="Confirm and hand over"
              question={
                <>
                  <p>
                    Hand over to <span className="font-semibold">{rx.patientName}</span>, against{' '}
                    {rx.prescriptionNumber}:
                  </p>
                  <ul className="mt-2 space-y-1">
                    {moving.map((row) => {
                      const substitute = row.swap
                        ? data.medicines.find((medicine) => medicine.id === row.swap?.medicineId)
                        : undefined
                      return (
                        <li key={row.item.prescriptionLineId ?? row.item.medicineName}>
                          <span className="font-semibold">
                            {substitute
                              ? `${substitute.name} ${substitute.strength}`.trim()
                              : row.item.medicineName}
                          </span>{' '}
                          — {row.quantity}{' '}
                          {plural(row.item.quantityUnit || 'unit', row.quantity)}
                          {row.quantity < remainingOf(row.item)
                            ? `, leaving ${remainingOf(row.item) - row.quantity} to collect`
                            : ''}
                          {substitute ? (
                            <span className="block text-[13px] text-ink-2">
                              Substituted for {row.item.medicineName} — {row.swap?.reason}
                            </span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-2">
                    Stock is taken first-expiry-first and leaves the shelf. The medicine is charged
                    to the patient&apos;s bill; payment is taken at this counter.
                  </p>
                </>
              }
              onConfirm={onHandOver}
            >
              Confirm and hand over
            </ConfirmButton>
          ) : (
            <Notice tone="bad">
              Medicine is handed over by the pharmacy. An administrator can review a hand-over, and
              void, refund or reverse it, but cannot make one.
            </Notice>
          )}
          <p className="text-[12px] text-ink-2">
            {moving.length === 0
              ? 'Nothing is set to move.'
              : `${moving.length} ${moving.length === 1 ? 'line' : 'lines'} will move${leftAfter > 0 ? `, leaving ${leftAfter} to collect` : ''}.`}
          </p>
        </div>
      </CardBody>
    </Card>
  )
}

/* ===================================================== one prescribed line */

function SupplyLine({
  data,
  run,
  rx,
  item,
  index,
  give,
  swap,
  identified,
  mayDispense,
  onGive,
  onSwap,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  rx: PrescriptionView
  item: PrescriptionItemView
  index: number
  give: Record<string, string>
  swap: Swap | undefined
  identified: boolean
  mayDispense: boolean
  onGive: (lineId: string, raw: string, remaining: number) => void
  onSwap: (lineId: string, next: Swap | undefined) => void
}) {
  const busy = useBusy()
  const [asking, setAsking] = useState(false)

  const state = item.supplyState ? SUPPLY_STATE[item.supplyState] : undefined
  const remaining = remainingOf(item)
  const supplied = item.supplied ?? 0
  const typed = typedFor(item, give)
  const unit = item.quantityUnit || 'unit'
  const editable = isSupplyable(item) && identified && !rx.expired
  const lineId = item.prescriptionLineId ?? ''
  const after = Math.max(remaining - (editable ? typed : 0), 0)

  const substitute = swap ? data.medicines.find((medicine) => medicine.id === swap.medicineId) : undefined
  // Shelf stock follows whatever is actually being supplied, not what was
  // written: a substitution that leaves the counter short is the same problem
  // as a prescribed line that does, and it must read the same way.
  const available = substitute ? substitute.totalAvailable : (item.available ?? 0)

  return (
    <li className="border-l-2 border-ink bg-paper/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">
            {index + 1}. {item.medicineName}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {[item.strength, item.dosageForm, item.route].filter(Boolean).join(' · ') ||
              'Strength and form not recorded'}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {item.dosage || 'Directions not recorded'}
            {item.instructions ? ` · ${item.instructions}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {state ? <Badge tone={state.tone}>{state.word}</Badge> : null}
          {isSupplyable(item) && available < remaining ? (
            <Badge tone="attn">Short on the shelf</Badge>
          ) : null}
          {substitute ? <Badge tone="attn">Substituted</Badge> : null}
        </div>
      </div>

      {item.outcomeReason ? (
        <p className="mt-2 text-[12px] text-ink-2">Recorded reason: {item.outcomeReason}</p>
      ) : null}

      {/*
       * Prescribed and supplied are two cells, always, and they never merge.
       * The left one is the doctor's signed order and nothing on this screen
       * can edit it; the right one is what the pharmacist actually put in the
       * bag. When they differ the record says so, with a reason, for good.
       */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0 border border-rule bg-sheet px-2.5 py-2">
          <p className="eyebrow">Prescribed</p>
          <p className="mt-1 text-[15px] font-semibold">{item.medicineName}</p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {item.quantity === undefined
              ? 'Quantity not recorded'
              : `${item.quantity} ${plural(unit, item.quantity)}`}
          </p>
        </div>
        <div
          className={`min-w-0 border bg-sheet px-2.5 py-2 ${substitute ? 'border-attn' : 'border-rule'}`}
          data-testid={lineId ? `supplied-product-${lineId}` : undefined}
        >
          <p className="eyebrow">Product supplied</p>
          <p className="mt-1 text-[15px] font-semibold">
            {substitute ? `${substitute.name} ${substitute.strength}`.trim() : item.medicineName}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {substitute ? `Substituted · ${swap?.reason}` : 'As written on the prescription'}
          </p>
          {mayDispense && editable && lineId ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                icon="pack"
                data-testid={`substitute-${lineId}`}
                disabled={busy}
                onClick={() => setAsking(true)}
              >
                Change product supplied
              </Button>
              {substitute ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSwap(lineId, undefined)}>
                  Supply as prescribed
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="Previously supplied" value={`${supplied}`} note={plural(unit, supplied)} />
        <Figure
          label="Available"
          value={`${available}`}
          note={`${plural(unit, available)} on the shelf`}
        />
        <div className="min-w-0 border border-ink bg-sheet px-2.5 py-2">
          {editable ? (
            <Field label="Supply now" unit={unit}>
              <Input
                inputMode="numeric"
                value={give[lineId] ?? String(remaining)}
                disabled={busy}
                onChange={(event) => onGive(lineId, event.target.value, remaining)}
              />
            </Field>
          ) : (
            <>
              <p className="eyebrow">Supply now</p>
              <p className="mt-1 font-mono text-[17px] tabular-nums">0</p>
            </>
          )}
          <p className="mt-1 text-[11px] leading-snug text-ink-2">
            {editable ? `At most ${remaining} ${plural(unit, remaining)}` : 'Nothing further on this line'}
          </p>
        </div>
        <Figure label="Remaining after this" value={`${after}`} note={plural(unit, after)} strong />
      </div>

      {mayDispense && isSupplyable(item) && lineId ? (
        <div className="mt-3" data-print="hide">
          <ReasonAction
            size="sm"
            title="The patient declined this line"
            confirmLabel="Record: patient declined"
            reasonLabel="What the patient said"
            reasonHint="Kept on the record beside your name and the time."
            question={
              <>
                Record that the patient declined{' '}
                <span className="font-semibold">{item.medicineName}</span>? The line stops being
                supplyable and the prescription itself is unchanged. This is not the same as the
                doctor cancelling it — only a doctor can do that.
              </>
            }
            onConfirm={(reason) =>
              run('record_prescription_line_outcome', {
                prescriptionLineId: lineId,
                outcome: 'patient_declined',
                reason,
              })
            }
          >
            Patient declined
          </ReasonAction>
        </div>
      ) : null}

      {lineId ? (
        <SubstituteDialog
          open={asking}
          data={data}
          item={item}
          chosen={swap}
          onClose={() => setAsking(false)}
          onChoose={(next) => {
            onSwap(lineId, next)
            setAsking(false)
          }}
        />
      ) : null}
    </li>
  )
}

/* ====================================================== controlled substitution */

/**
 * The only product change a pharmacist may make, and the wall around it.
 *
 * Policy register 21 and the `dispense_rx` command agree on one narrow case: a
 * genuinely GENERIC order — no brand on it — where another active product maps
 * to the same clinical drug row, with a recorded reason. Everything else is the
 * doctor's, and this dialog says so in the words the clinic uses for it:
 * **Doctor amendment required**, with no control that would commit anything.
 *
 * The candidate list is computed here and enforced at the command. Neither is
 * enough on its own: the screen must not offer what the server would refuse,
 * and the server must not trust what the screen sent.
 */
function SubstituteDialog({
  open,
  data,
  item,
  chosen,
  onClose,
  onChoose,
}: {
  open: boolean
  data: ClinicSnapshot
  item: PrescriptionItemView
  chosen: Swap | undefined
  onClose: () => void
  onChoose: (next: Swap) => void
}) {
  const [medicineId, setMedicineId] = useState(chosen?.medicineId ?? '')
  const [reason, setReason] = useState(chosen?.reason ?? '')
  const gate = substituteOptions(data, item)

  if (gate.kind === 'blocked') {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Doctor amendment required"
        sub={item.medicineName}
        footer={
          <Button variant="secondary" onClick={onClose}>
            Back to the prescription
          </Button>
        }
      >
        <div className="space-y-3" data-testid="substitution-stop">
          <Notice tone="bad" icon="lock">
            <span className="font-semibold">Doctor amendment required.</span> {gate.reason}
          </Notice>
          <p className="text-[14px] leading-relaxed">
            A pharmacist may supply a different product only when the prescription is generic and
            the clinic can prove the offered product is the same clinical drug. This one is outside
            that rule, so it is supplied exactly as written, or the doctor issues an amended or
            replacement order.
          </p>
        </div>
      </Modal>
    )
  }

  const picked = gate.candidates.find((medicine) => medicine.id === medicineId)
  const problem = !picked
    ? 'Choose the product being supplied.'
    : reason.trim() === ''
      ? 'Say why a different product is being supplied.'
      : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change the product supplied"
      sub={`${item.medicineName} · ${gate.prescribed.clinicalDrugName || 'same clinical drug'}`}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            disabled={Boolean(problem)}
            disabledReason={problem}
            onClick={() => {
              if (!picked) return
              onChoose({ medicineId: picked.id, reason: reason.trim() })
            }}
          >
            Record this substitution
          </ActionButton>
        </>
      }
    >
      <div className="space-y-4">
        <Notice>
          {gate.prescribed.name} was prescribed generically, so an in-stock product mapped to the
          same clinical drug may be supplied instead. The signed prescription is unchanged; the
          record keeps both products and your reason.
        </Notice>

        <div className="space-y-2" role="radiogroup" aria-label="Product supplied">
          {gate.candidates.map((medicine) => {
            const open = medicine.id === medicineId
            return (
              <button
                key={medicine.id}
                type="button"
                role="radio"
                aria-checked={open}
                onClick={() => setMedicineId(medicine.id)}
                className={`block min-h-[56px] w-full rounded-box border px-3 py-2 text-left transition-colors duration-150 ${
                  open ? 'border-ink bg-active-wash' : 'border-rule bg-sheet hover:bg-paper/60'
                }`}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[15px] font-semibold">
                    {medicine.name}
                    {medicine.brandName ? ` · ${medicine.brandName}` : ''}
                  </span>
                  <span className="font-mono text-[13px] tabular-nums">
                    {medicine.totalAvailable}{' '}
                    {plural(medicine.baseUnit || medicine.unit, medicine.totalAvailable)} on the
                    shelf
                  </span>
                </span>
                {/* Strength, form and route in full, never collapsed: two
                    products of the same clinical drug still have to be read. */}
                <span className="mt-0.5 block text-[12px] text-ink-2">
                  {medicineIdentity(medicine)}
                </span>
              </button>
            )
          })}
        </div>

        <Field
          label="Why a different product is being supplied"
          hint="Kept on the dispense record beside your name and the time."
          required
        >
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/* ============================================================== the basket */

type PricedLine = {
  line: SaleLine
  medicine: MedicineView | undefined
  version: PackageVersionView | undefined
  levels: PackageLevelView[]
  quantity: number
  baseUnit: string
  said: string
  paise: number | undefined
}

function SaleBasket({
  data,
  sellable,
  matches,
  patients,
  lines,
  priced,
  estimate,
  search,
  searchRef,
  draft,
  draftPackage,
  draftLevels,
  draftBaseUnit,
  draftCounts,
  draftCounted,
  draftQuantity,
  draftPrice,
  parts,
  problem,
  anonymousBlock,
  maySell,
  busy,
  sold,
  lockedPatientName,
  patientId,
  serving,
  onSearch,
  onPick,
  onCounts,
  onAdd,
  onRemove,
  onPatient,
  onParts,
  onRingUp,
}: {
  data: ClinicSnapshot
  sellable: MedicineView[]
  matches: MedicineView[]
  patients: Array<{ id: string; name: string }>
  lines: SaleLine[]
  priced: PricedLine[]
  estimate: number | undefined
  search: string
  searchRef: React.RefObject<HTMLInputElement | null>
  draft: MedicineView | undefined
  draftPackage: PackageVersionView | undefined
  draftLevels: PackageLevelView[]
  draftBaseUnit: string
  draftCounts: Record<string, string>
  draftCounted: { total: number; said: string; problems: string[] }
  draftQuantity: number
  draftPrice: number | undefined
  parts: PartDraft[]
  problem: string | undefined
  anonymousBlock: MedicineView | undefined
  maySell: boolean
  busy: boolean
  sold: SaleRecordData | null
  lockedPatientName: string
  patientId: string
  serving: string
  onSearch: (value: string) => void
  onPick: (id: string) => void
  onCounts: (counts: Record<string, string>) => void
  onAdd: () => void
  onRemove: (key: string) => void
  onPatient: (id: string) => void
  onParts: (parts: PartDraft[]) => void
  onRingUp: () => Promise<void>
}) {
  const global = useBusy()

  // Policy register 17 and 44: an administrator does not get a disabled counter
  // sale, they get no counter sale. The bill beside this is theirs.
  if (!maySell) return null

  const typed = partsTotal(parts)

  return (
    <Card data-testid="otc-basket">
      <CardHeader
        title="Counter sale"
        sub={
          lockedPatientName
            ? `Also buying · ${lockedPatientName}`
            : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`
        }
        action={sold ? <Badge tone="free">Sold · {sold.receiptNumber}</Badge> : null}
      />
      <CardBody className="space-y-4">
        {sellable.length === 0 ? (
          <EmptyState
            title="Nothing may be sold across the counter"
            direction="A medicine appears here once a pharmacist marks its sale class as OTC on the Formulary screen."
          />
        ) : (
          <>
            <Field
              label="Scan or search a medicine"
              hint="Brand, ingredient, strength, code or a scanned barcode."
            >
              <Input
                ref={searchRef}
                value={search}
                disabled={global}
                data-testid="counter-search"
                placeholder="Scan a barcode, or type a name"
                onChange={(event) => onSearch(event.target.value)}
              />
            </Field>

            <div className="space-y-2" data-testid="counter-matches">
              {matches.length === 0 ? (
                <p className="text-[13px] text-ink-2">
                  Nothing marked over-the-counter matches “{search}”. Anything else needs a signed
                  prescription.
                </p>
              ) : (
                matches.map((medicine) => {
                  const open = draft?.id === medicine.id
                  const stock = medicine.totalAvailable
                  return (
                    <button
                      key={medicine.id}
                      type="button"
                      aria-pressed={open}
                      onClick={() => onPick(medicine.id)}
                      className={`block min-h-[56px] w-full rounded-box border px-3 py-2 text-left transition-colors duration-150 ${
                        open ? 'border-ink bg-active-wash' : 'border-rule bg-sheet hover:bg-paper/60'
                      }`}
                    >
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[15px] font-semibold">
                          {medicine.name}
                          {medicine.brandName ? ` · ${medicine.brandName}` : ''}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {stock > 0 ? (
                            <Badge tone={stock > 10 ? 'free' : 'attn'}>
                              {stock} {plural(medicine.baseUnit || medicine.unit, stock)}
                            </Badge>
                          ) : (
                            <Badge tone="stop">Nothing on the shelf</Badge>
                          )}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[12px] text-ink-2">
                        {medicineIdentity(medicine)}
                        {medicine.scheduleVerified
                          ? ` · Schedule ${medicine.schedule}, verified`
                          : ' · class not verified'}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            {draft ? (
              <div className="space-y-3 border-t border-rule pt-3">
                <p className="text-[13px] text-ink-2">
                  {draft.packageSummary || 'No package recorded'}
                </p>

                {draftPackage ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {topDown(draftLevels).map((level) => (
                      <Field
                        key={level.levelName}
                        label={
                          level.depth === 0
                            ? `Loose ${plural(level.levelName, 2)}`
                            : plural(level.levelName, 2)
                        }
                        hint={
                          level.minimumSaleMultiple > 1
                            ? `Sold in multiples of ${level.minimumSaleMultiple}`
                            : undefined
                        }
                        unit={`${level.baseFactor} ${plural(draftBaseUnit, level.baseFactor)} each`}
                      >
                        <Input
                          inputMode="numeric"
                          value={draftCounts[level.levelName] ?? ''}
                          disabled={global}
                          onChange={(event) =>
                            onCounts({ ...draftCounts, [level.levelName]: event.target.value })
                          }
                        />
                      </Field>
                    ))}
                    {draftLevels.length === 0 ? (
                      <p className="text-[13px] text-ink-2">
                        This medicine&apos;s package has no level marked sellable, so it cannot go
                        across the counter until a pharmacist marks one.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <Field
                    label={`Loose ${plural(draftBaseUnit, 2)}`}
                    unit={draftBaseUnit}
                    hint="This medicine has no verified package, so it is sold by the base unit."
                  >
                    <Input
                      inputMode="numeric"
                      value={draftCounts[LOOSE] ?? ''}
                      disabled={global}
                      onChange={(event) => onCounts({ ...draftCounts, [LOOSE]: event.target.value })}
                    />
                  </Field>
                )}

                {draftCounted.problems.length > 0 ? (
                  <Notice tone="bad">{draftCounted.problems.join(' ')}</Notice>
                ) : null}

                <Notice tone={draftQuantity > 0 && draftPrice !== undefined ? 'info' : 'bad'}>
                  {draftQuantity <= 0 ? (
                    'Nothing counted on this line yet.'
                  ) : draftPrice === undefined ? (
                    <>
                      Only {draft.totalAvailable} {plural(draftBaseUnit, draft.totalAvailable)} of{' '}
                      {draft.name} can be supplied, and {draftQuantity} were counted.
                    </>
                  ) : (
                    <>
                      {draftPackage && draftCounted.said ? `${draftCounted.said} = ` : ''}
                      <span className="font-semibold">
                        {draftQuantity} {plural(draftBaseUnit, draftQuantity)}
                      </span>{' '}
                      · about <span className="font-semibold">{fromPaise(draftPrice)}</span> at
                      today&apos;s shelf prices. The amount charged is computed by the clinic server
                      when the sale is rung up.
                    </>
                  )}
                </Notice>

                <ActionButton
                  icon="plus"
                  busy={busy}
                  disabled={draftQuantity <= 0 || draftPrice === undefined}
                  disabledReason="Count a quantity that is on the shelf first."
                  onClick={onAdd}
                >
                  Add to the sale
                </ActionButton>
              </div>
            ) : null}
          </>
        )}

        <div className="border-t-2 border-ink pt-3">
          {lines.length === 0 ? (
            <EmptyState
              title="Nothing on the counter yet"
              direction="Scan or search a medicine above, count the packages, and add it to the sale."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Medicine</TH>
                  <TH>Counted</TH>
                  <TH num>Base units</TH>
                  <TH num>About</TH>
                  <TH>Remove</TH>
                </TR>
              </THead>
              <TBody>
                {priced.map((row) => (
                  <TR key={row.line.key}>
                    <TD className="font-semibold">
                      {row.medicine
                        ? `${row.medicine.name} ${row.medicine.strength}`.trim()
                        : 'Unknown medicine'}
                    </TD>
                    <TD className="text-ink-2">{row.said || 'nothing'}</TD>
                    <TD num>
                      {row.quantity} {plural(row.baseUnit, row.quantity)}
                    </TD>
                    <TD num>{row.paise === undefined ? 'Not on the shelf' : fromPaise(row.paise)}</TD>
                    <TD>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={global || Boolean(sold)}
                        aria-label={`Remove ${row.medicine?.name ?? 'line'}`}
                        onClick={() => onRemove(row.line.key)}
                      >
                        Remove
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
            <span className="eyebrow">Estimated total</span>
            <span className="font-mono text-[20px] tabular-nums">
              {estimate === undefined ? 'Not priceable' : fromPaise(estimate)}
            </span>
          </div>
        </div>

        {lockedPatientName ? (
          <Notice icon="user">
            This sale is recorded against {lockedPatientName} and joins the same visit bill as the
            prescription. Close the prescription to sell to somebody else.
          </Notice>
        ) : (
          <Field
            label="Who is buying"
            hint="Optional. Attaching a registered patient is what allows part payment and pay later."
          >
            <Select
              value={patientId}
              disabled={global || Boolean(sold)}
              onChange={(event) => onPatient(event.target.value)}
            >
              <option value="">Nobody — anonymous sale</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {anonymousBlock ? (
          <Notice tone="bad">
            {anonymousBlock.name} has not been verified as an over-the-counter medicine by a
            pharmacist, so it cannot be sold anonymously. Attach a registered patient, or classify
            it on the Formulary screen first.
          </Notice>
        ) : null}

        {/*
         * Where the money for this sale is taken.
         *
         * With nobody attached there is no balance for it to belong to, so
         * policy register 46 requires it in full here and now. With a patient
         * attached it goes onto their bill and is collected once, beside the
         * consultation fee and whatever was handed over — which is the whole
         * point of one counter, and of policy register 48.
         */}
        {serving ? (
          <Notice tone="pending" icon="rupee">
            {estimate === undefined ? 'This sale' : fromPaise(estimate)} goes onto the patient’s
            bill. Take it beside the consultation fee and the medicine, on the bill to the right.
          </Notice>
        ) : (
          <div className="space-y-3 border-t border-rule pt-3">
            <PaymentParts
              parts={parts}
              onChange={onParts}
              legend="What is being taken"
              hint="Method is required; a reference is not. An anonymous sale is paid in full."
            />
            {estimate !== undefined && lines.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-ink-2">
                  The sale is estimated at {fromPaise(estimate)}.
                </p>
                <Button
                  size="sm"
                  disabled={global}
                  onClick={() => onParts([blankPart((estimate / 100).toFixed(2))])}
                >
                  Use this amount
                </Button>
              </div>
            ) : null}
            {estimate !== undefined && typed !== undefined && typed < estimate ? (
              <Notice tone="bad">
                {fromPaise(typed)} has been entered against an estimated {fromPaise(estimate)}. An
                anonymous sale is refused unless it is paid in full.
              </Notice>
            ) : null}
          </div>
        )}

        <ConfirmButton
          variant="primary"
          icon="pack"
          busy={busy}
          busyLabel="Ringing up the sale…"
          disabled={Boolean(problem) || Boolean(sold)}
          disabledReason={
            sold
              ? 'This sale has been rung up. Choose New sale to start another.'
              : problem
          }
          title={serving ? 'Sell and add to the bill' : 'Complete the counter sale'}
          confirmLabel={serving ? 'Sell and add to the bill' : 'Complete the sale'}
          question={
            <>
              <p>
                Sell {lines.length} {lines.length === 1 ? 'line' : 'lines'}
                {serving
                  ? ` to ${lockedPatientName || patients.find((patient) => patient.id === patientId)?.name || 'the patient'}, adding it to their bill?`
                  : `, and take ${typed === undefined ? 'the entered amount' : fromPaise(typed)}?`}
              </p>
              <p className="mt-2">
                Stock is taken first-expiry-first and leaves the shelf. The receipt is numbered, and
                neither can be undone here — a return is recorded separately.
              </p>
            </>
          }
          onConfirm={onRingUp}
        >
          {serving ? 'Sell and add to the bill' : 'Complete the sale'}
        </ConfirmButton>
      </CardBody>
    </Card>
  )
}

/* ================================================================= the bill */

function BillPanel({
  invoice,
  owing,
  settled,
  underReview,
  selectedId,
  feePaise,
  medicinePaise,
  otcPaise,
  adjustmentPaise,
  parts,
  payNote,
  problem,
  payingInFull,
  typed,
  duePaise,
  busy,
  globalBusy,
  outstanding,
  onSelect,
  onParts,
  onNote,
  onTake,
  onLater,
}: {
  invoice: InvoiceView | undefined
  owing: InvoiceView[]
  settled: InvoiceView[]
  underReview: InvoiceView[]
  selectedId: string
  feePaise: number
  medicinePaise: number
  otcPaise: number
  adjustmentPaise: number
  parts: PartDraft[]
  payNote: string
  problem: string | undefined
  payingInFull: boolean
  typed: number | undefined
  duePaise: number
  busy: boolean
  globalBusy: boolean
  outstanding: { lines: number; units: number }
  onSelect: (id: string) => void
  onParts: (parts: PartDraft[]) => void
  onNote: (value: string) => void
  onTake: () => Promise<void>
  onLater: () => void
}) {
  if (!invoice) {
    return (
      <Card data-testid="bill-panel">
        <CardHeader title="Bill" sub="Nothing to collect" />
        <CardBody>
          <EmptyState
            title="No bill is open"
            direction="A signed consultation, a hand-over and a counter sale each raise a bill, and it appears here for payment."
          />
        </CardBody>
      </Card>
    )
  }

  const review = isUnderReview(invoice)

  return (
    <div className="min-w-0 space-y-4" data-testid="bill-panel">
      <Card variant="record">
        <CardHeader
          title="Bill"
          sub={`${invoice.patientName ?? 'Counter sale — no patient attached'} · ${invoice.invoiceNumber}`}
          action={<PaymentStateBadge invoice={invoice} />}
        />
        <CardBody className="space-y-4">
          {/*
           * The consultation fee is its own line and stays one even when no
           * medicine was supplied. A consultation-only visit is collectable
           * here, which is what policy register 17 and 48 require of this desk.
           */}
          <dl className="space-y-1.5 text-[14px]" data-testid="bill-summary">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-ink-2">
                <Icon name="stethoscope" size={16} />
                Consultation fee
              </dt>
              <dd className="font-mono tabular-nums">
                {feePaise > 0 ? fromPaise(feePaise) : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-ink-2">
                <Icon name="pack" size={16} />
                Medicines handed over
              </dt>
              <dd className="font-mono tabular-nums">
                {medicinePaise > 0 ? fromPaise(medicinePaise) : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-ink-2">
                <Icon name="counter" size={16} />
                Counter sale
              </dt>
              <dd className="font-mono tabular-nums">{otcPaise > 0 ? fromPaise(otcPaise) : '—'}</dd>
            </div>
            {adjustmentPaise !== 0 ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-ink-2">
                  <Icon name="tag" size={16} />
                  Adjustment
                </dt>
                <dd className="font-mono tabular-nums">{fromPaise(adjustmentPaise)}</dd>
              </div>
            ) : null}
          </dl>

          <InvoiceLines invoice={invoice} />

          <div className="grid grid-cols-3 gap-3">
            <Figure label="Total" value={money(invoice.total)} />
            <Figure
              label="Paid"
              value={money(invoice.paid)}
              note={
                invoice.paymentState === 'over_refunded'
                  ? 'Below nothing: more went back out than came in.'
                  : invoice.paymentState === 'void_with_balance'
                    ? 'Money on a bill the clinic cancelled.'
                    : undefined
              }
            />
            {/* The Due figure is the biggest thing on this card, and on a bill
                under review it is the one that is most misread — for opposite
                reasons: on an over-refunded bill it is the over-refund itself,
                and on a cancelled one it is a figure nobody is being charged.
                Neither travels without words. */}
            <Figure
              label="Due"
              value={money(invoice.due)}
              strong
              note={
                invoice.paymentState === 'over_refunded'
                  ? 'The over-refund, not money owed.'
                  : invoice.paymentState === 'void_with_balance'
                    ? 'Nothing is owed on a cancelled bill.'
                    : undefined
              }
            />
          </div>

          {outstanding.lines > 0 ? (
            <Notice tone="pending">
              {outstanding.units} {outstanding.units === 1 ? 'unit is' : 'units are'} still to be
              collected on {outstanding.lines} prescribed{' '}
              {outstanding.lines === 1 ? 'line' : 'lines'}. Medicine is charged when it is handed
              over, never before.
            </Notice>
          ) : null}

          {invoice.payments.length > 0 ? <InvoicePayments invoice={invoice} /> : null}

          {review ? (
            <Notice tone="bad">
              {invoice.paymentState === 'over_refunded'
                ? `This bill is over-refunded: ${money(-invoice.paid)} more has gone back out than ever came in.`
                : invoice.paid > 0
                  ? `This bill was cancelled and ${money(invoice.paid)} is still held against it.`
                  : `This bill was cancelled and ${money(-invoice.paid)} went back out on it afterwards.`}{' '}
              Nothing can be taken against it here, and taking money would not put it right — the
              pharmacy cannot settle this one. It is with the administrator and the clinic&rsquo;s
              accountant, who correct it between them.{' '}
              {invoice.patientName
                ? `${invoice.patientName} owes the clinic nothing on it.`
                : 'Nobody owes the clinic anything on it.'}
            </Notice>
          ) : invoice.due > 0 ? (
            <div className="space-y-4 border-t-2 border-ink pt-4">
              <PaymentParts
                parts={parts}
                onChange={onParts}
                legend="Take payment"
                hint="One row per method. Cash and GPay on the same bill is two rows."
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-ink-2">
                  {money(invoice.due)} is due.{' '}
                  {typed === undefined
                    ? ''
                    : payingInFull
                      ? 'That settles the bill.'
                      : `${fromPaise(typed)} leaves ${fromPaise(duePaise - typed)} outstanding.`}
                </p>
                <Button
                  size="sm"
                  disabled={globalBusy}
                  onClick={() => onParts([blankPart(invoice.due.toFixed(2))])}
                >
                  Use the full amount
                </Button>
              </div>

              <Field label="Note on this payment" hint="Optional. Kept with the receipt.">
                <Input
                  value={payNote}
                  disabled={globalBusy}
                  onChange={(event) => onNote(event.target.value)}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <ConfirmButton
                  variant="primary"
                  icon="rupee"
                  busy={busy}
                  busyLabel={
                    typed === undefined ? 'Receiving payment…' : `Receiving ${fromPaise(typed)}…`
                  }
                  disabled={Boolean(problem)}
                  disabledReason={problem}
                  title={payingInFull ? 'Take payment' : 'Record part payment'}
                  confirmLabel={payingInFull ? 'Take payment' : 'Record part payment'}
                  question={
                    <>
                      <p>
                        Take {typed === undefined ? 'the entered amount' : fromPaise(typed)} on{' '}
                        {invoice.invoiceNumber}
                        {invoice.patientName ? ` for ${invoice.patientName}` : ''}, as{' '}
                        {partsPayload(parts)
                          .map((part) => METHOD_LABEL[part.method])
                          .join(' + ') || 'no method'}
                        ?
                      </p>
                      <p className="mt-2">
                        {payingInFull
                          ? 'That settles the bill.'
                          : 'The rest stays due and the bill reads as part paid.'}{' '}
                        Each part is its own numbered receipt, and money changing hands cannot be
                        undone here.
                      </p>
                    </>
                  }
                  onConfirm={onTake}
                >
                  {payingInFull ? 'Take payment' : 'Record part payment'}
                </ConfirmButton>

                {invoice.patientId ? (
                  <Button icon="clock" disabled={globalBusy} onClick={onLater}>
                    Pay later
                  </Button>
                ) : (
                  <p className="text-[12px] text-ink-2">
                    Pay later needs a registered patient. This bill has nobody attached to it, so it
                    is paid in full at the counter.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <Notice tone="good">
              This bill is settled. {money(invoice.paid)} has been taken against{' '}
              {money(invoice.total)}.
            </Notice>
          )}
        </CardBody>
      </Card>

      <div className="space-y-2">
        <SectionHeader title="Due now" sub={`${owing.length} to collect`} />
        {owing.length === 0 ? (
          <p className="text-[13px] text-ink-2">Nothing is owed right now.</p>
        ) : (
          owing.map((row) => (
            <InvoiceButton
              key={row.id}
              invoice={row}
              open={row.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}

        {settled.length > 0 ? (
          <div className="space-y-2 pt-2">
            <SectionHeader title="Settled today" sub={`${settled.length} closed`} />
            {settled.map((row) => (
              <InvoiceButton
                key={row.id}
                invoice={row}
                open={row.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : null}

        {/* Listed rather than hidden: a pharmacist who remembers raising the
            bill should find it here, reading why it is not in Due now. */}
        {underReview.length > 0 ? (
          <div className="space-y-2 pt-2">
            <SectionHeader
              title="With the administrator"
              sub={`${underReview.length} under review · nothing to collect`}
            />
            {underReview.map((row) => (
              <InvoiceButton
                key={row.id}
                invoice={row}
                open={row.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function InvoiceButton({
  invoice,
  open,
  onSelect,
}: {
  invoice: InvoiceView
  open: boolean
  onSelect: (invoiceId: string) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => onSelect(invoice.id)}
      className={`block min-h-[56px] w-full rounded-box border px-3 py-2 text-left transition-colors duration-150 ${
        open ? 'border-ink bg-active-wash' : 'border-rule bg-sheet hover:bg-paper/60'
      }`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[15px] font-semibold">
          {invoice.patientName ?? 'Counter sale'}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          {open ? <span className="eyebrow">Open</span> : null}
          <span className="font-mono text-[14px] tabular-nums">{money(invoice.due)}</span>
        </span>
      </span>
      <span className="mt-0.5 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-ink-2">
          {invoice.invoiceNumber} · {formatDate(invoice.createdAt)}
        </span>
        <PaymentStateBadge invoice={invoice} />
      </span>
    </button>
  )
}

/* ============================================== what happened at this counter */

/**
 * The evidence, kept until the pharmacist starts the next one.
 *
 * The result overlay reads an amount out and goes, as the plan requires; these
 * are what it leaves behind. Each is a document — a dispense, a sale, a receipt
 * — and each prints on its own, which is why only the one being printed carries
 * `data-print="sheet"`: three records on screen would otherwise become three
 * pages nobody asked for.
 */
function CounterRecords({
  data,
  printing,
  handOver,
  sale,
  payment,
  later,
  onPrint,
  onDismissLater,
}: {
  data: ClinicSnapshot
  printing: Printing
  handOver: HandOverRecordData | null
  sale: SaleRecordData | null
  payment: PaymentRecordData | null
  later: string | null
  onPrint: (which: Printing) => void
  onDismissLater: () => void
}) {
  if (!handOver && !sale && !payment && !later) return null

  return (
    <div className="space-y-4">
      {handOver ? (
        <Card variant="record" data-print={printing === 'handover' ? 'sheet' : 'hide'}>
          <ClinicLetterhead settings={data.settings} kind="register" />
          <CardHeader
            title={handOver.duplicate ? 'Already handed over' : 'Handed over'}
            sub={handOver.dispenseNumber || 'Recorded'}
            action={
              <span className="flex flex-wrap gap-2" data-print="hide">
                <Button variant="primary" icon="printer" onClick={() => onPrint('handover')}>
                  Print this record
                </Button>
              </span>
            }
          />
          <CardBody className="space-y-3">
            <p className="text-[14px]">
              <span className="font-semibold">{handOver.patientName}</span> · against{' '}
              {handOver.prescriptionNumber}
            </p>
            {handOver.duplicate ? (
              <Notice tone="pending">
                {handOver.dispenseNumber || 'This hand-over'} was already handed over. Nothing was
                given twice.
              </Notice>
            ) : handOver.lines.length > 0 ? (
              <ul className="space-y-1 text-[14px]">
                {handOver.lines.map((line, index) => (
                  <li key={`${line}-${index}`}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-2">The server did not itemise this hand-over.</p>
            )}
            {handOver.duplicate ? null : (
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-t-2 border-ink pt-3">
                <span className="eyebrow">Added to the bill</span>
                <span className="font-mono text-[20px] tabular-nums">
                  {money(Number(handOver.charged) || 0)}
                </span>
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}

      {sale ? (
        <Card variant="record" data-print={printing === 'sale' ? 'sheet' : 'hide'}>
          <ClinicLetterhead settings={data.settings} kind="register" />
          <CardHeader
            title={sale.duplicate ? 'Already rung up' : 'Counter sale'}
            sub={sale.receiptNumber}
            action={
              <span className="flex flex-wrap gap-2" data-print="hide">
                <Button variant="primary" icon="printer" onClick={() => onPrint('sale')}>
                  Print receipt
                </Button>
              </span>
            }
          />
          <CardBody className="space-y-3">
            {sale.duplicate ? (
              <Notice tone="pending">
                {sale.receiptNumber || 'This sale'} was already rung up. Nothing was sold twice.
              </Notice>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="eyebrow">Sale total</span>
                  <span className="font-mono text-[20px] tabular-nums">
                    {money(Number(sale.total) || 0)}
                  </span>
                </div>
                <p className="text-[13px]">
                  {sale.receipts.length > 0 ? (
                    <>
                      Receipt {sale.receipts.length === 1 ? 'number' : 'numbers'}:{' '}
                      <span className="font-mono font-semibold">{sale.receipts.join(', ')}</span>
                    </>
                  ) : (
                    `Nothing was collected on this line, so the amount stands on ${sale.patientName || 'the patient'}’s bill and is taken with the rest of it.`
                  )}
                </p>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}

      {payment ? (
        <Card variant="record" data-print={printing === 'payment' ? 'sheet' : 'hide'}>
          <ClinicLetterhead settings={data.settings} kind="register" />
          <CardHeader
            title={payment.duplicate ? 'Already taken' : 'Payment receipt'}
            sub={payment.receipts.join(', ') || payment.invoiceNumber}
            action={
              <span className="flex flex-wrap gap-2" data-print="hide">
                <Button variant="primary" icon="printer" onClick={() => onPrint('payment')}>
                  Print receipt
                </Button>
              </span>
            }
          />
          <CardBody className="space-y-2">
            <p className="text-[14px]">
              {payment.patientName} · against bill{' '}
              <span className="font-mono font-semibold">{payment.invoiceNumber}</span>
            </p>
            {payment.duplicate ? (
              <Notice tone="pending">
                Receipt {payment.receipts.join(', ') || 'for this payment'} was already taken.
                Nothing was charged twice.
              </Notice>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="eyebrow">Taken · {payment.methods}</span>
                  <span className="font-mono text-[20px] tabular-nums">
                    {money(Number(payment.amount) || 0)}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-rule pt-2">
                  <span className="eyebrow">
                    {Number(payment.due) > 0 ? 'Still due' : 'Balance'}
                  </span>
                  <span className="font-mono text-[16px] tabular-nums">
                    {Number(payment.due) > 0 ? money(Number(payment.due)) : '₹0'}
                  </span>
                </div>
                <p className="text-[13px]">
                  {payment.receipts.length > 0 ? (
                    <>
                      Receipt {payment.receipts.length === 1 ? 'number' : 'numbers'}:{' '}
                      <span className="font-mono font-semibold">{payment.receipts.join(', ')}</span>
                    </>
                  ) : (
                    'The clinic server returned no receipt number for this payment.'
                  )}
                </p>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}

      {later ? (
        <div data-print="hide">
          <Notice tone="pending" icon="clock" onDismiss={onDismissLater}>
            {later}
          </Notice>
        </div>
      ) : null}
    </div>
  )
}
