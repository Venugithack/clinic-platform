'use client'

import { useMemo, useState } from 'react'
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
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  EmptyState,
  Field,
  Input,
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
  Token,
  clinicDayOf,
  clinicToday,
  formatDate,
  formatDay,
  money,
  type Tone,
} from '@/components/ui'

/**
 * The counter: handing medicine over, selling across it, and taking money.
 *
 * Slice 4's screen for the three things that happen at one desk, in the order
 * they happen in. They share one surface because the patient standing there is
 * one person with one bill, and they are three stations because only one of
 * them is ever the thing being done right now — a pharmacist counting out a
 * strip should not be looking at a payment form, and the tablet is ten inches
 * wide.
 *
 * Three rules run through all of it.
 *
 *   NOTHING HERE MOVES ANYTHING. Opening a prescription, typing a `Give now`
 *   quantity and adding a line to a basket are local state. Stock leaves the
 *   shelf and money is taken in exactly three commands, each behind a
 *   confirmation that states what will move.
 *
 *   THE SERVER DOES THE ARITHMETIC THAT MATTERS. Amounts are sent as the
 *   counter typed them, and every total that ends up on a bill is computed
 *   where the money is. Figures shown here are read off the snapshot or are
 *   labelled an estimate from the shelf.
 *
 *   A REFUSAL IS SHOWN, NOT INTERPRETED. Every command's own sentence reaches
 *   the staff member through the shell's notice strip, and nothing on this
 *   screen claims something was saved because it was asked for.
 */

const SUPPLY_STATE: Record<
  NonNullable<PrescriptionItemView['supplyState']>,
  { word: string; tone: Tone }
> = {
  waiting: { word: 'Waiting', tone: 'attn' },
  part_supplied: { word: 'Part supplied', tone: 'attn' },
  supplied: { word: 'Supplied', tone: 'free' },
  patient_declined: { word: 'Patient declined', tone: 'plain' },
  doctor_cancelled: { word: 'Doctor cancelled', tone: 'plain' },
  needs_review: { word: 'Needs review', tone: 'stop' },
}

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

/* =========================================================== the workspace */

type Station = 'prescriptions' | 'sale' | 'checkout'

/**
 * The three stations, and who may work each one.
 *
 * These mirror the command gates in `_shared/counter.ts` exactly, and that is
 * the only correct relationship between them. A station offered to somebody
 * the server will refuse teaches that person to press a button that cannot
 * work; a station withheld from somebody the server would allow is a feature
 * nobody can find. Neither is security — the refusal at the command is — but
 * both are lies about what the clinic permits.
 *
 * Policy register item 17: medicine over the counter is a pharmacist's,
 * prescription or not. Money is admin's and pharmacy's.
 */
const STATIONS: Array<{ id: Station; label: string; roles: Role[] }> = [
  { id: 'prescriptions', label: 'Hand over a prescription', roles: ['pharmacy'] },
  { id: 'sale', label: 'Counter sale', roles: ['pharmacy'] },
  { id: 'checkout', label: 'Take payment', roles: ['admin', 'pharmacy'] },
]

const may = (roles: Role[], allowed: Role[]) => roles.some((role) => allowed.includes(role))

export function CounterPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const roles = data.session.roles
  const stations = useMemo(() => STATIONS.filter((entry) => may(roles, entry.roles)), [roles])
  const [station, setStation] = useState<Station>(() => stations[0]?.id ?? 'checkout')
  const [invoiceId, setInvoiceId] = useState('')

  const queue = useMemo(
    () => data.prescriptions.filter((rx) => rx.items.some(isPending)),
    [data.prescriptions],
  )
  const sellableCount = data.medicines.filter(
    (medicine) => medicine.active && medicine.saleClass === 'otc',
  ).length
  /*
   * What this counter can actually collect.
   *
   * An over-refunded bill has a `due` bigger than its own total — money that
   * has already left the drawer twice, not money anybody is going to hand
   * over. Counting it here would send a pharmacist looking for a patient who
   * owes nothing, so it is held out of the figure and named separately.
   *
   * A cancelled bill with money still against it is the clinic's other
   * accounting exception, and it is deliberately not here at all: `live` drops
   * every voided bill first, and nothing is collectable on a bill the clinic
   * has cancelled, whichever way its money points. It belongs on Billing, in
   * front of an admin. What the test below is for is the day one arrives some
   * other way — it asks whether a bill is an exception rather than naming one
   * of the two, so the counter can never grow a payment form for either.
   */
  const live = data.invoices.filter((invoice) => invoice.status !== 'void')
  const underReview = live.filter(isUnderReview)
  const owing = live.filter((invoice) => invoice.due > 0 && !isUnderReview(invoice))
  const owed = owing.reduce((total, invoice) => total + invoice.due, 0)

  const counts: Record<Station, string> = {
    prescriptions: `${queue.length} waiting`,
    sale: `${sellableCount} sellable over the counter`,
    checkout: `${owing.length} ${owing.length === 1 ? 'bill' : 'bills'} · ${money(owed)} due${underReview.length > 0 ? ` · ${underReview.length} under review` : ''}`,
  }

  /** Move to the bill a hand-over or a sale just raised, with it already open. */
  function collect(nextInvoiceId: string) {
    setInvoiceId(nextInvoiceId)
    setStation('checkout')
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Pharmacy counter"
        title="Counter"
        sub={`${queue.length} prescriptions waiting · ${money(owed)} due across ${owing.length} ${owing.length === 1 ? 'bill' : 'bills'}${underReview.length > 0 ? ` · ${underReview.length} ${underReview.length === 1 ? 'bill is' : 'bills are'} under review and with the administrator` : ''}`}
      />

      <div
        role="group"
        aria-label="Counter stations"
        className="flex flex-wrap gap-2"
        data-print="hide"
      >
        {stations.map((entry) => {
          const open = station === entry.id
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={open}
              onClick={() => setStation(entry.id)}
              className={`min-h-[56px] min-w-0 flex-1 basis-[220px] rounded-box border px-4 py-2 text-left transition-colors duration-150 ${
                open
                  ? 'border-ink bg-ink text-paper'
                  : 'border-rule bg-sheet text-ink hover:bg-paper/60'
              }`}
            >
              <span className="block text-[13px] font-semibold tracking-[0.08em] uppercase">
                {entry.label}
              </span>
              <span
                className={`mt-0.5 block font-mono text-[12px] ${open ? 'text-paper/80' : 'text-ink-2'}`}
              >
                {counts[entry.id]}
                {open ? ' · open' : ''}
              </span>
            </button>
          )
        })}
      </div>

      {station === 'prescriptions' ? (
        <PrescriptionStation data={data} run={run} queue={queue} onCollect={collect} />
      ) : null}
      {station === 'sale' ? <SaleStation data={data} run={run} onCollect={collect} /> : null}
      {station === 'checkout' ? (
        <CheckoutStation data={data} run={run} invoiceId={invoiceId} onSelect={setInvoiceId} />
      ) : null}
    </Stack>
  )
}

/* ============================================ 1. the prescription hand-over */

/** A line with something still to be done about it, one way or the other. */
function isPending(item: PrescriptionItemView): boolean {
  if (item.supplyState) {
    return (
      item.supplyState === 'waiting' ||
      item.supplyState === 'part_supplied' ||
      item.supplyState === 'needs_review'
    )
  }
  return !item.cancelled
}

/** A line the counter may actually put on the scale right now. */
function isSupplyable(item: PrescriptionItemView): boolean {
  if (item.supplyState) return item.supplyState === 'waiting' || item.supplyState === 'part_supplied'
  return !item.cancelled && !item.needsReview
}

function remainingOf(item: PrescriptionItemView): number {
  if (item.remaining !== undefined) return item.remaining
  return Math.max((item.quantity ?? 0) - (item.supplied ?? 0), 0)
}

type HandOver = {
  dispenseNumber: string
  invoiceId: string
  charged: string
  lines: string[]
  patientName: string
  prescriptionNumber: string
}

function PrescriptionStation({
  data,
  run,
  queue,
  onCollect,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  queue: PrescriptionView[]
  onCollect: (invoiceId: string) => void
}) {
  const busy = useBusy()
  const [openId, setOpenId] = useState('')
  const [give, setGive] = useState<Record<string, string>>({})
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [done, setDone] = useState<HandOver | null>(null)

  // The same list `dispense_rx` enforces. An administrator reaching this
  // surface some other way sees the refusal rather than a live button.
  const maySupply = may(data.session.roles, ['pharmacy'])
  const selected = queue.find((rx) => rx.id === openId) ?? queue[0]
  const today = clinicToday()
  const finishedToday = data.prescriptions.filter(
    (rx) => !rx.items.some(isPending) && clinicDayOf(rx.signedAt) === today,
  )

  /**
   * One key per hand-over attempt, kept across refusals.
   *
   * If the request went out and the answer was lost, pressing again with the
   * same key returns the first hand-over rather than making a second one. A
   * hand-over that actually completed mints a new key, so the remainder can be
   * collected later on its own.
   */
  function keyFor(prescriptionId: string): string {
    const existing = keys[prescriptionId]
    if (existing) return existing
    const key = crypto.randomUUID()
    setKeys((current) => ({ ...current, [prescriptionId]: key }))
    return key
  }

  function typedFor(item: PrescriptionItemView): number {
    const remaining = remainingOf(item)
    const raw = item.prescriptionLineId ? give[item.prescriptionLineId] : undefined
    if (raw === undefined) return remaining
    if (raw.trim() === '') return 0
    return Math.min(Math.max(Math.floor(Number(raw)) || 0, 0), remaining)
  }

  function setTyped(lineId: string, raw: string, remaining: number) {
    const digits = raw.replace(/[^0-9]/g, '')
    const capped =
      digits === '' ? '' : String(Math.min(Math.max(Number(digits), 0), Math.max(remaining, 0)))
    setGive((current) => ({ ...current, [lineId]: capped }))
  }

  const record = done ? (
    <HandOverRecord data={data} done={done} onCollect={onCollect} onClose={() => setDone(null)} />
  ) : null

  if (!selected) {
    return (
      <>
        {record}
        <Card>
          <CardBody>
            <EmptyState
              title="No prescription is waiting"
              direction="A doctor signs a consultation with medicine on it and it arrives here. Counter sales and payments are on the other two stations."
            />
          </CardBody>
        </Card>
      </>
    )
  }

  const blocking = selected.items.filter(
    (item) => item.supplyState === 'needs_review' || item.needsReview,
  )
  const supplyable = selected.items.filter(isSupplyable)
  const moving = supplyable
    .map((item) => ({ item, quantity: typedFor(item) }))
    .filter((row) => row.quantity > 0)
  const identified = supplyable.every((item) => Boolean(item.prescriptionLineId))
  const partial =
    selected.supplyInParts === false &&
    moving.some((row) => row.quantity < remainingOf(row.item))

  const refusal = selected.expired
    ? `This prescription could be supplied until ${dayText(selected.validUntil)}. The remainder needs a new or amended order from the doctor.`
    : blocking.length > 0
      ? `${blocking[0].medicineName} must be resolved by a doctor before anything on this prescription is handed over.`
      : !maySupply
        ? 'Medicine is handed over by the pharmacy. An administrator can review a hand-over, and void, refund or reverse it, but cannot make one.'
        : moving.length === 0
          ? 'Enter a quantity against at least one line.'
          : partial
            ? 'This prescription is marked to be supplied in one go. Give the whole remaining quantity of every line, or none of it.'
            : undefined

  async function handOver() {
    const key = keyFor(selected.id)
    const result = await run('dispense_rx', {
      prescriptionId: selected.id,
      idempotencyKey: key,
      note: note.trim() || undefined,
      // A line from before per-line supply existed carries no identifier to
      // name back, so those prescriptions go over whole or not at all.
      ...(identified
        ? {
            lines: moving.map((row) => ({
              prescriptionLineId: row.item.prescriptionLineId,
              quantity: row.quantity,
            })),
          }
        : {}),
    })
    if (!result.ok) return

    const payload = (result.data ?? {}) as {
      dispenseNumber?: string
      invoiceId?: string
      charged?: string
      lines?: string[]
    }
    setKeys((current) => {
      const next = { ...current }
      delete next[selected.id]
      return next
    })
    setGive((current) => {
      const next = { ...current }
      for (const row of moving) {
        if (row.item.prescriptionLineId) delete next[row.item.prescriptionLineId]
      }
      return next
    })
    setNote('')
    setDone({
      dispenseNumber: payload.dispenseNumber ?? '',
      invoiceId: payload.invoiceId ?? '',
      charged: payload.charged ?? '0.00',
      lines: payload.lines ?? [],
      patientName: selected.patientName,
      prescriptionNumber: selected.prescriptionNumber,
    })
  }

  return (
    <>
      {record}

      <div
        className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]"
        data-print="hide"
      >
        <aside className="min-w-0 space-y-2" aria-label="Prescriptions waiting">
          <SectionHeader title="Waiting" sub={`${queue.length} to hand over`} />
          {queue.map((rx) => {
            const open = rx.id === selected.id
            return (
              <button
                key={rx.id}
                type="button"
                aria-pressed={open}
                onClick={() => setOpenId(rx.id)}
                className={`block min-h-[56px] w-full rounded-box border px-3 py-2 text-left transition-colors duration-150 ${
                  open ? 'border-ink bg-active-wash' : 'border-rule bg-sheet hover:bg-paper/60'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[15px] font-semibold">{rx.patientName}</span>
                  {open ? <span className="eyebrow shrink-0">Open</span> : null}
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
          })}

          {finishedToday.length > 0 ? (
            <div className="pt-2">
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
        </aside>

        <div className="min-w-0">
          <Card variant="record">
            <CardHeader
              title="Prescription"
              sub={`${selected.patientName} · ${selected.prescriptionNumber}`}
              action={<Token code={selected.prescriptionNumber} />}
            />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure
                  label="Signed"
                  value={formatDay(selected.signedAt)}
                  note={selected.doctorName}
                />
                <Figure label="Valid until" value={dayText(selected.validUntil)} />
                <Figure
                  label="Validity"
                  value={selected.expired ? 'Expired' : 'In date'}
                  note={selected.expired ? 'Only a new order can supply it' : undefined}
                />
                <Figure
                  label="Supply"
                  value={selected.supplyInParts === false ? 'In one go' : 'May be split'}
                  note={
                    selected.supplyInParts === false
                      ? 'The doctor directed one supply'
                      : 'The remainder may be collected later'
                  }
                />
              </div>

              {selected.expired ? (
                <Notice tone="bad">
                  This prescription could be supplied until {dayText(selected.validUntil)}. Nothing
                  further may be handed over against it — the patient needs a new or amended order
                  from the doctor.
                </Notice>
              ) : null}

              {blocking.length > 0 ? (
                <Notice tone="bad">
                  {blocking.length === 1 ? 'One line is' : `${blocking.length} lines are`} from
                  before this system and {blocking.length === 1 ? 'does' : 'do'} not record enough
                  to supply:{' '}
                  <span className="font-semibold">
                    {blocking.map((item) => item.medicineName).join(', ')}
                  </span>
                  . A doctor must resolve {blocking.length === 1 ? 'that line' : 'those lines'}{' '}
                  before anything on this prescription is handed over.
                </Notice>
              ) : null}

              {!identified && supplyable.length > 0 ? (
                <Notice>
                  This prescription is from before per-line supply was recorded, so it can only be
                  handed over whole. Give now cannot be set line by line on it.
                </Notice>
              ) : null}

              <ol className="space-y-3">
                {selected.items.map((item, index) => {
                  const state = item.supplyState ? SUPPLY_STATE[item.supplyState] : undefined
                  const remaining = remainingOf(item)
                  const supplied = item.supplied ?? 0
                  const available = item.available ?? 0
                  const typed = typedFor(item)
                  const unit = item.quantityUnit || 'unit'
                  const editable = isSupplyable(item) && identified && !selected.expired
                  const lineId = item.prescriptionLineId ?? ''
                  const after = Math.max(remaining - (editable ? typed : 0), 0)

                  return (
                    <li
                      key={lineId || `${selected.id}-${index}`}
                      className="border-l-2 border-ink bg-paper/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[15px] font-semibold">
                            {index + 1}. {item.medicineName}
                          </p>
                          <p className="mt-0.5 text-[12px] text-ink-2">
                            {[item.strength, item.dosageForm, item.route]
                              .filter(Boolean)
                              .join(' · ') || 'Strength and form not recorded'}
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
                        </div>
                      </div>

                      {item.outcomeReason ? (
                        <p className="mt-2 text-[12px] text-ink-2">
                          Recorded reason: {item.outcomeReason}
                        </p>
                      ) : null}

                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                        <Figure
                          label="Prescribed"
                          value={item.quantity === undefined ? 'Not recorded' : `${item.quantity}`}
                          note={
                            item.quantity === undefined ? undefined : plural(unit, item.quantity)
                          }
                        />
                        <Figure
                          label="Previously supplied"
                          value={`${supplied}`}
                          note={plural(unit, supplied)}
                        />
                        <Figure
                          label="Available"
                          value={`${available}`}
                          note={`${plural(unit, available)} on the shelf`}
                        />
                        <div className="min-w-0 border border-ink bg-sheet px-2.5 py-2">
                          {editable ? (
                            <Field label="Give now" unit={unit}>
                              <Input
                                inputMode="numeric"
                                value={give[lineId] ?? String(remaining)}
                                disabled={busy}
                                onChange={(event) =>
                                  setTyped(lineId, event.target.value, remaining)
                                }
                              />
                            </Field>
                          ) : (
                            <>
                              <p className="eyebrow">Give now</p>
                              <p className="mt-1 font-mono text-[17px] tabular-nums">0</p>
                            </>
                          )}
                          <p className="mt-1 text-[11px] leading-snug text-ink-2">
                            {editable
                              ? `At most ${remaining} ${plural(unit, remaining)}`
                              : 'Nothing further on this line'}
                          </p>
                        </div>
                        <Figure
                          label="Remaining after this"
                          value={`${after}`}
                          note={plural(unit, after)}
                          strong
                        />
                      </div>

                      {maySupply && isSupplyable(item) && lineId ? (
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
                                <span className="font-semibold">{item.medicineName}</span>? The line
                                stops being supplyable and the prescription itself is unchanged.
                                This is not the same as the doctor cancelling it — only a doctor can
                                do that.
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
                    </li>
                  )
                })}
              </ol>

              <Field label="Note on this hand-over" hint="Optional. Kept with the dispense record.">
                <Input
                  value={note}
                  disabled={busy}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>

              <div
                className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t-2 border-ink bg-sheet/95 px-1 py-3 backdrop-blur"
                data-print="hide"
              >
                <ConfirmButton
                  variant="primary"
                  busy={busy}
                  busyLabel="Handing over…"
                  disabled={Boolean(refusal)}
                  disabledReason={refusal}
                  title="Confirm and hand over"
                  confirmLabel="Confirm and hand over"
                  question={
                    <>
                      <p>
                        Hand over to <span className="font-semibold">{selected.patientName}</span>,
                        against {selected.prescriptionNumber}:
                      </p>
                      <ul className="mt-2 space-y-1">
                        {moving.map((row) => (
                          <li key={row.item.prescriptionLineId ?? row.item.medicineName}>
                            <span className="font-semibold">{row.item.medicineName}</span> —{' '}
                            {row.quantity} {plural(row.item.quantityUnit || 'unit', row.quantity)}
                            {row.quantity < remainingOf(row.item)
                              ? `, leaving ${remainingOf(row.item) - row.quantity} to collect`
                              : ''}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2">
                        Stock is taken first-expiry-first and leaves the shelf. The medicine is
                        charged to the patient&apos;s bill; payment is taken separately.
                      </p>
                    </>
                  }
                  onConfirm={handOver}
                >
                  Confirm and hand over
                </ConfirmButton>
                <p className="text-[12px] text-ink-2">
                  {moving.length === 0
                    ? 'Nothing is set to move.'
                    : `${moving.length} ${moving.length === 1 ? 'line' : 'lines'} will move.`}
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}

/** What was handed over, with its number, and the one thing to do next. */
function HandOverRecord({
  data,
  done,
  onCollect,
  onClose,
}: {
  data: ClinicSnapshot
  done: HandOver
  onCollect: (invoiceId: string) => void
  onClose: () => void
}) {
  return (
    <Card variant="record" data-print="sheet">
      <ClinicLetterhead settings={data.settings} kind="register" />
      <CardHeader
        title="Handed over"
        sub={done.dispenseNumber || 'Recorded'}
        action={
          <span className="flex flex-wrap gap-2" data-print="hide">
            <Button variant="primary" onClick={() => window.print()}>
              Print this record
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </span>
        }
      />
      <CardBody className="space-y-3">
        <p className="text-[14px]">
          <span className="font-semibold">{done.patientName}</span> · against{' '}
          {done.prescriptionNumber}
        </p>
        {done.lines.length > 0 ? (
          <ul className="space-y-1 text-[14px]">
            {done.lines.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-2">The server did not itemise this hand-over.</p>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-t-2 border-ink pt-3">
          <span className="eyebrow">Added to the bill</span>
          <span className="font-mono text-[20px] tabular-nums">
            {money(Number(done.charged) || 0)}
          </span>
        </div>
        {done.invoiceId ? (
          <div data-print="hide">
            <Button variant="primary" onClick={() => onCollect(done.invoiceId)}>
              Take payment for this bill
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

/* ================================================== 2. the over-the-counter */

type SaleLine = { key: string; medicineId: string; counts: Record<string, string> }

/** The key a medicine with no verified package counts its loose units under. */
const LOOSE = '__loose'

/** Biggest package first — a box reads before a strip before a tablet. */
function topDown(levels: PackageLevelView[]): PackageLevelView[] {
  return [...levels].sort((a, b) => b.depth - a.depth)
}

function packageOf(
  data: ClinicSnapshot,
  medicine: MedicineView | undefined,
): PackageVersionView | undefined {
  if (!medicine?.activePackageVersionId) return undefined
  return data.packages.find((version) => version.id === medicine.activePackageVersionId)
}

/** What the typed counts come to in base units, and how to say it out loud. */
function countsToBase(levels: PackageLevelView[], counts: Record<string, string>) {
  let total = 0
  const said: string[] = []
  const problems: string[] = []
  for (const level of topDown(levels)) {
    const raw = (counts[level.levelName] ?? '').trim()
    if (raw === '') continue
    const count = Number(raw)
    if (!Number.isInteger(count) || count < 0) {
      problems.push(`The number of ${plural(level.levelName, 2)} must be a whole number.`)
      continue
    }
    if (count === 0) continue
    if (count % level.minimumSaleMultiple !== 0) {
      problems.push(`${level.levelName} is sold in multiples of ${level.minimumSaleMultiple}.`)
      continue
    }
    total += level.baseFactor * count
    said.push(`${count} ${plural(level.levelName, count)}`)
  }
  return { total, said: said.join(' + '), problems }
}

/** The `entry` a counter-sale line carries. Zero counts are left out. */
function countsToEntry(levels: PackageLevelView[], counts: Record<string, string>) {
  return topDown(levels)
    .map((level) => ({
      levelName: level.levelName,
      count: Number((counts[level.levelName] ?? '').trim()),
    }))
    .filter((row) => Number.isInteger(row.count) && row.count > 0)
}

/**
 * What this quantity would come to at today's shelf prices.
 *
 * The same first-expiry-first walk the server does, so the figure on the screen
 * is the figure on the bill in the ordinary case — but it is read off a
 * snapshot that may be fifteen seconds old, and it is labelled an estimate for
 * exactly that reason. The bill is whatever the server computes when it
 * allocates the batches. Undefined means the shelf cannot cover it.
 */
function estimatePaise(
  data: ClinicSnapshot,
  medicineId: string,
  quantity: number,
): number | undefined {
  if (quantity <= 0) return 0
  const candidates = data.batches
    .filter((batch) => batch.medicineId === medicineId && batch.pickable && batch.availableQuantity > 0)
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.id.localeCompare(b.id))

  let left = quantity
  let paise = 0
  for (const batch of candidates) {
    if (left === 0) break
    const take = Math.min(batch.availableQuantity, left)
    paise += Math.round(batch.sellingPrice * 100) * take
    left -= take
  }
  return left > 0 ? undefined : paise
}

function SaleStation({
  data,
  run,
  onCollect,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  onCollect: (invoiceId: string) => void
}) {
  const busy = useBusy()
  const sellable = useMemo(
    () => data.medicines.filter((medicine) => medicine.active && medicine.saleClass === 'otc'),
    [data.medicines],
  )
  const patients = useMemo(() => knownPatients(data), [data])

  const [lines, setLines] = useState<SaleLine[]>([])
  const [patientId, setPatientId] = useState('')
  const [parts, setParts] = useState<PartDraft[]>([blankPart()])
  const [draftMedicine, setDraftMedicine] = useState('')
  const [draftCounts, setDraftCounts] = useState<Record<string, string>>({})
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID())
  const [sold, setSold] = useState<{
    receiptNumber: string
    total: string
    receipts: string[]
    invoiceId: string
  } | null>(null)

  const draft = sellable.find((medicine) => medicine.id === draftMedicine) ?? sellable[0]
  const draftPackage = packageOf(data, draft)
  const draftLevels = draftPackage ? draftPackage.levels.filter((level) => level.sellable) : []
  const draftBaseUnit = draftPackage?.baseUnit || draft?.baseUnit || draft?.unit || 'unit'
  const draftCounted = countsToBase(draftLevels, draftCounts)
  const draftQuantity = draftPackage
    ? draftCounted.total
    : Math.floor(Number((draftCounts[LOOSE] ?? '').trim() || 0)) || 0
  const draftPrice = draft ? estimatePaise(data, draft.id, draftQuantity) : undefined

  const priced = lines.map((line) => {
    const medicine = data.medicines.find((item) => item.id === line.medicineId)
    const version = packageOf(data, medicine)
    const levels = version ? version.levels.filter((level) => level.sellable) : []
    const counted = countsToBase(levels, line.counts)
    const baseUnit = version?.baseUnit || medicine?.baseUnit || medicine?.unit || 'unit'
    const quantity = version
      ? counted.total
      : Math.floor(Number((line.counts[LOOSE] ?? '').trim() || 0)) || 0
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
  const typed = partsTotal(parts)

  // Policy register 45 and 46: an unverified or non-OTC classification cannot
  // cross the counter without a patient attached to it.
  const anonymousBlock = patientId
    ? undefined
    : priced.find(
        (row) => row.medicine && (row.medicine.schedule !== 'OTC' || !row.medicine.scheduleVerified),
      )?.medicine

  // Policy register 46: taking nothing at all is pay later, and pay later needs
  // somebody for the balance to belong to. An anonymous sale is paid in full.
  const payingNothing = partsPayload(parts).length === 0

  // `otc_sale` is gated to pharmacy. This station is not offered to anybody
  // else, so reaching here means arriving some other way; say so rather than
  // let the basket fill up against a command that will refuse it.
  const maySell = may(data.session.roles, ['pharmacy'])

  const problem = !maySell
    ? 'A counter sale is made by the pharmacy. An administrator can review a sale, and refund or reverse it, but cannot make one.'
    : lines.length === 0
      ? 'Add at least one medicine to the sale.'
      : priced.some((row) => row.quantity <= 0)
        ? 'Every line needs a quantity above zero.'
        : priced.some((row) => row.paise === undefined)
          ? 'One of these lines asks for more than is on the shelf.'
          : anonymousBlock
            ? `${anonymousBlock.name} has not been verified as an over-the-counter medicine, so it cannot be sold anonymously.`
            : typed === undefined
              ? 'One of the payment amounts is not an amount in rupees.'
              : !patientId && payingNothing
                ? 'An anonymous sale is paid in full at the counter. Enter what was paid, and how.'
                : undefined

  function addLine() {
    if (!draft || draftQuantity <= 0) return
    setLines((current) => [
      ...current,
      { key: crypto.randomUUID(), medicineId: draft.id, counts: { ...draftCounts } },
    ])
    setDraftCounts({})
  }

  async function complete() {
    const result = await run('otc_sale', {
      idempotencyKey: saleKey,
      patientId: patientId || undefined,
      lines: priced.map((row) =>
        row.version
          ? { medicineId: row.line.medicineId, entry: countsToEntry(row.levels, row.line.counts) }
          : { medicineId: row.line.medicineId, quantity: row.quantity },
      ),
      parts: partsPayload(parts),
    })
    if (!result.ok) return

    const payload = (result.data ?? {}) as {
      receiptNumber?: string
      total?: string
      receipts?: string[]
      invoiceId?: string
    }
    setSold({
      receiptNumber: payload.receiptNumber ?? '',
      total: payload.total ?? '0.00',
      receipts: payload.receipts ?? [],
      invoiceId: payload.invoiceId ?? '',
    })
    setLines([])
    setParts([blankPart()])
    setPatientId('')
    setSaleKey(crypto.randomUUID())
  }

  return (
    <>
      {sold ? (
        <Card variant="record" data-print="sheet">
          <ClinicLetterhead settings={data.settings} kind="register" />
          <CardHeader
            title="Counter sale"
            sub={sold.receiptNumber}
            action={
              <span className="flex flex-wrap gap-2" data-print="hide">
                <Button variant="primary" onClick={() => window.print()}>
                  Print receipt
                </Button>
                <Button variant="ghost" onClick={() => setSold(null)}>
                  Done
                </Button>
              </span>
            }
          />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="eyebrow">Sale total</span>
              <span className="font-mono text-[20px] tabular-nums">
                {money(Number(sold.total) || 0)}
              </span>
            </div>
            <p className="text-[13px]">
              {sold.receipts.length > 0 ? (
                <>
                  Receipt {sold.receipts.length === 1 ? 'number' : 'numbers'}:{' '}
                  <span className="font-mono font-semibold">{sold.receipts.join(', ')}</span>
                </>
              ) : (
                'Nothing was collected at the counter, so the amount stands on the patient’s balance.'
              )}
            </p>
            {sold.invoiceId ? (
              <div data-print="hide">
                <Button onClick={() => onCollect(sold.invoiceId)}>Open this bill</Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div
        className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]"
        data-print="hide"
      >
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title="Add a medicine"
              sub={draft ? `${draft.name} ${draft.strength}`.trim() : 'Nothing is marked OTC'}
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
                    label="Medicine"
                    hint="Only medicines marked OTC. Anything else needs a signed prescription."
                    required
                  >
                    <Select
                      value={draft?.id ?? ''}
                      disabled={busy}
                      onChange={(event) => {
                        setDraftMedicine(event.target.value)
                        setDraftCounts({})
                      }}
                    >
                      {sellable.map((medicine) => (
                        <option key={medicine.id} value={medicine.id}>
                          {medicine.name} {medicine.strength} · {medicine.totalAvailable}{' '}
                          {plural(medicine.baseUnit || medicine.unit, medicine.totalAvailable)} on
                          the shelf
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {draft ? (
                    <p className="text-[12px] text-ink-2">
                      {draft.packageSummary || 'No package recorded'} ·{' '}
                      {draft.scheduleVerified
                        ? `Schedule ${draft.schedule}, verified by a pharmacist`
                        : 'Regulatory class not verified by a pharmacist'}
                    </p>
                  ) : null}

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
                            disabled={busy}
                            onChange={(event) =>
                              setDraftCounts((current) => ({
                                ...current,
                                [level.levelName]: event.target.value,
                              }))
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
                        disabled={busy}
                        onChange={(event) =>
                          setDraftCounts((current) => ({ ...current, [LOOSE]: event.target.value }))
                        }
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
                        Only {draft?.totalAvailable ?? 0}{' '}
                        {plural(draftBaseUnit, draft?.totalAvailable ?? 0)} of {draft?.name} can be
                        supplied, and {draftQuantity} were counted.
                      </>
                    ) : (
                      <>
                        {draftPackage && draftCounted.said ? `${draftCounted.said} = ` : ''}
                        <span className="font-semibold">
                          {draftQuantity} {plural(draftBaseUnit, draftQuantity)}
                        </span>{' '}
                        · about <span className="font-semibold">{fromPaise(draftPrice)}</span> at
                        today&apos;s shelf prices. The amount charged is computed by the clinic
                        server when the sale is rung up.
                      </>
                    )}
                  </Notice>

                  <ActionButton
                    busy={busy}
                    disabled={draftQuantity <= 0 || draftPrice === undefined}
                    disabledReason="Count a quantity that is on the shelf first."
                    onClick={addLine}
                  >
                    Add to the sale
                  </ActionButton>
                </>
              )}
            </CardBody>
          </Card>

          <Card variant="record">
            <CardHeader
              title="This sale"
              sub={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
            />
            <CardBody className="space-y-3">
              {lines.length === 0 ? (
                <EmptyState
                  title="Nothing on the counter yet"
                  direction="Choose a medicine above, count the packages, and add it to the sale."
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
                        <TD num>
                          {row.paise === undefined ? 'Not on the shelf' : fromPaise(row.paise)}
                        </TD>
                        <TD>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy}
                            aria-label={`Remove ${row.medicine?.name ?? 'line'}`}
                            onClick={() =>
                              setLines((current) =>
                                current.filter((item) => item.key !== row.line.key),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}

              <div className="flex flex-wrap items-baseline justify-between gap-3 border-t-2 border-ink pt-3">
                <span className="eyebrow">Estimated total</span>
                <span className="font-mono text-[20px] tabular-nums">
                  {estimate === undefined ? 'Not priceable' : fromPaise(estimate)}
                </span>
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title="Who is buying"
              sub={patientId ? 'Registered patient' : 'Anonymous sale'}
            />
            <CardBody className="space-y-3">
              <Field
                label="Attach a registered patient"
                hint="Optional. Attaching one is what allows part payment and pay later."
              >
                <Select
                  value={patientId}
                  disabled={busy}
                  onChange={(event) => setPatientId(event.target.value)}
                >
                  <option value="">Nobody — anonymous sale</option>
                  {patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.name}
                    </option>
                  ))}
                </Select>
              </Field>

              {patientId ? (
                <Notice>
                  This sale goes onto the patient&apos;s bill, so it may be part paid, or left
                  entirely to pay later by taking nothing now.
                </Notice>
              ) : (
                <Notice tone="bad">
                  An anonymous sale has to be paid in full at the counter. There is nobody for a
                  balance to belong to, so part payment and pay later are not available — attach a
                  registered patient if the money is not being taken now.
                </Notice>
              )}

              {anonymousBlock ? (
                <Notice tone="bad">
                  {anonymousBlock.name} has not been verified as an over-the-counter medicine by a
                  pharmacist, so it cannot be sold anonymously. Attach a registered patient, or
                  classify it on the Formulary screen first.
                </Notice>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Payment" sub="Cash, UPI, card, or a split of them" />
            <CardBody className="space-y-4">
              <PaymentParts
                parts={parts}
                onChange={setParts}
                legend="What is being taken"
                hint="Method is required; a reference is not."
              />

              {estimate !== undefined && lines.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
                  <p className="text-[12px] text-ink-2">
                    The sale is estimated at {fromPaise(estimate)}.
                  </p>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => setParts([blankPart((estimate / 100).toFixed(2))])}
                  >
                    Use this amount
                  </Button>
                </div>
              ) : null}

              {!patientId && estimate !== undefined && typed !== undefined && typed < estimate ? (
                <Notice tone="bad">
                  {fromPaise(typed)} has been entered against an estimated {fromPaise(estimate)}. An
                  anonymous sale is refused unless it is paid in full.
                </Notice>
              ) : null}

              <ConfirmButton
                variant="primary"
                busy={busy}
                busyLabel="Ringing up…"
                disabled={Boolean(problem)}
                disabledReason={problem}
                title={payingNothing ? 'Sell and pay later' : 'Complete the counter sale'}
                confirmLabel={payingNothing ? 'Sell and pay later' : 'Complete the sale'}
                question={
                  <>
                    <p>
                      Sell {lines.length} {lines.length === 1 ? 'line' : 'lines'}
                      {patientId
                        ? ` to ${patients.find((patient) => patient.id === patientId)?.name ?? 'the patient'}`
                        : ' across the counter with no patient attached'}
                      {payingNothing
                        ? ', taking nothing now and leaving it on their balance?'
                        : `, and take ${typed === undefined ? 'the entered amount' : fromPaise(typed)}?`}
                    </p>
                    <p className="mt-2">
                      Stock is taken first-expiry-first and leaves the shelf. The receipt is
                      numbered, and neither can be undone here — a return is recorded separately.
                    </p>
                  </>
                }
                onConfirm={complete}
              >
                {payingNothing && patientId ? 'Sell and pay later' : 'Complete the sale'}
              </ConfirmButton>
            </CardBody>
          </Card>

          <Card data-print="hide">
            <CardHeader
              title="Recent counter receipts"
              sub={`${data.otcSales.length} on the record`}
            />
            <CardBody className="space-y-2">
              {data.otcSales.length === 0 ? (
                <p className="text-[13px] text-ink-2">
                  No counter sale has been rung up yet. Completed sales are listed here with their
                  receipt number.
                </p>
              ) : (
                data.otcSales.slice(0, 12).map((sale) => (
                  <div
                    key={sale.id}
                    className="flex items-baseline justify-between gap-3 border-b border-rule pb-2 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <Token code={sale.receiptNumber} />
                      <span className="mt-1 block font-mono text-[11px] text-ink-2">
                        {formatDate(sale.createdAt)}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[14px] tabular-nums">
                      {money(sale.total)}
                    </span>
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}

/* ======================================================== 3. taking payment */

function CheckoutStation({
  data,
  run,
  invoiceId,
  onSelect,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  invoiceId: string
  onSelect: (invoiceId: string) => void
}) {
  const busy = useBusy()
  const [parts, setParts] = useState<PartDraft[]>([blankPart()])
  const [note, setNote] = useState('')
  const [payKey, setPayKey] = useState(() => crypto.randomUUID())
  const [taken, setTaken] = useState<{
    receipts: string[]
    amount: string
    due: string
    invoiceNumber: string
  } | null>(null)
  const [later, setLater] = useState<string | null>(null)

  /*
   * Three lists, not two.
   *
   * An over-refunded bill would otherwise fall into Due now — its `due` is
   * larger than its total — and the counter would open a payment form the
   * server refuses. It is neither owed nor settled, so it gets its own list
   * and its own explanation, and it is never what this screen opens by
   * default: the work at this counter is the bills above it.
   *
   * A cancelled bill carrying money is the same kind of thing and is not on
   * this screen in any list: `live` drops it, and `invoice` below is looked up
   * within `live`, so neither the sidebar nor `onSelect` can reach one. That
   * is the right answer — a bill the clinic has cancelled collects nothing —
   * and it is Billing's to settle. The test is written as "is this an
   * exception" all the same, so that if one ever does arrive here it lands in
   * With the administrator and meets the notice, rather than a payment form.
   */
  const live = data.invoices.filter((invoice) => invoice.status !== 'void')
  const underReview = live.filter(isUnderReview)
  const collectable = live.filter((invoice) => !isUnderReview(invoice))
  const owing = collectable.filter((invoice) => invoice.due > 0)
  const settled = collectable.filter((invoice) => invoice.due <= 0)
  const invoice =
    live.find((item) => item.id === invoiceId) ?? owing[0] ?? settled[0] ?? underReview[0]

  if (!invoice) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="No bill is open"
            direction="A signed consultation, a hand-over and a counter sale each raise a bill, and it appears here for payment."
          />
        </CardBody>
      </Card>
    )
  }

  const duePaise = Math.round(invoice.due * 100)
  const typed = partsTotal(parts)
  const entered = partsPayload(parts)
  const full = typed !== undefined && typed >= duePaise

  const problem =
    invoice.due <= 0
      ? 'This bill is settled. There is nothing left to take.'
      : typed === undefined
        ? 'One of those amounts is not an amount in rupees.'
        : entered.length === 0
          ? 'Enter what is being paid, and how.'
          : typed > duePaise
            ? `${fromPaise(typed)} was entered against ${money(invoice.due)} due.`
            : undefined

  async function takePayment() {
    const result = await run('take_payment', {
      invoiceId: invoice.id,
      idempotencyKey: payKey,
      parts: entered,
      note: note.trim() || undefined,
    })
    if (!result.ok) return
    const payload = (result.data ?? {}) as { receipts?: string[]; taken?: string; due?: string }
    setTaken({
      receipts: payload.receipts ?? [],
      amount: payload.taken ?? '0.00',
      due: payload.due ?? '0.00',
      invoiceNumber: invoice.invoiceNumber,
    })
    setParts([blankPart()])
    setNote('')
    setPayKey(crypto.randomUUID())
    setLater(null)
  }

  return (
    <>
      {taken ? (
        <Card variant="record" data-print="sheet">
          <ClinicLetterhead settings={data.settings} kind="register" />
          <CardHeader
            title="Payment receipt"
            sub={taken.receipts.join(', ') || taken.invoiceNumber}
            action={
              <span className="flex flex-wrap gap-2" data-print="hide">
                <Button variant="primary" onClick={() => window.print()}>
                  Print receipt
                </Button>
                <Button variant="ghost" onClick={() => setTaken(null)}>
                  Done
                </Button>
              </span>
            }
          />
          <CardBody className="space-y-2">
            <p className="text-[14px]">
              Against bill <span className="font-mono font-semibold">{taken.invoiceNumber}</span>
            </p>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="eyebrow">Taken</span>
              <span className="font-mono text-[20px] tabular-nums">
                {money(Number(taken.amount) || 0)}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-rule pt-2">
              <span className="eyebrow">Still due</span>
              <span className="font-mono text-[16px] tabular-nums">
                {money(Number(taken.due) || 0)}
              </span>
            </div>
            <p className="text-[13px]">
              {taken.receipts.length > 0 ? (
                <>
                  Receipt {taken.receipts.length === 1 ? 'number' : 'numbers'}:{' '}
                  <span className="font-mono font-semibold">{taken.receipts.join(', ')}</span>
                </>
              ) : (
                'The clinic server returned no receipt number for this payment.'
              )}
            </p>
          </CardBody>
        </Card>
      ) : null}

      {later ? (
        <div data-print="hide">
          <Notice onDismiss={() => setLater(null)}>{later}</Notice>
        </div>
      ) : null}

      <div
        className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]"
        data-print="hide"
      >
        <aside className="min-w-0 space-y-2" aria-label="Bills">
          <SectionHeader title="Due now" sub={`${owing.length} to collect`} />
          {owing.length === 0 ? (
            <p className="text-[13px] text-ink-2">Nothing is owed right now.</p>
          ) : (
            owing.map((row) => (
              <InvoiceButton
                key={row.id}
                invoice={row}
                open={row.id === invoice.id}
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
                  open={row.id === invoice.id}
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
                  open={row.id === invoice.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ) : null}
        </aside>

        <div className="min-w-0">
          <Card variant="record">
            <CardHeader
              title="Bill"
              sub={`${invoice.patientName ?? 'Counter sale — no patient attached'} · ${invoice.invoiceNumber}`}
              action={<PaymentStateBadge invoice={invoice} />}
            />
            <CardBody className="space-y-4">
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
                {/* The Due figure is the biggest thing on this card, and on a
                    bill under review it is the one that is most misread — for
                    opposite reasons: on an over-refunded bill it is the
                    over-refund itself, and on a cancelled one it is a figure
                    nobody is being charged. Neither travels without words. */}
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

              {invoice.payments.length > 0 ? <InvoicePayments invoice={invoice} /> : null}

              {isUnderReview(invoice) ? (
                <Notice tone="bad">
                  {invoice.paymentState === 'over_refunded'
                    ? `This bill is over-refunded: ${money(-invoice.paid)} more has gone back out than ever came in.`
                    : invoice.paid > 0
                      ? `This bill was cancelled and ${money(invoice.paid)} is still held against it.`
                      : `This bill was cancelled and ${money(-invoice.paid)} went back out on it afterwards.`}{' '}
                  Nothing can be taken against it here, and taking money would not put it right —
                  the pharmacy cannot settle this one. It is with the administrator and the
                  clinic&rsquo;s accountant, who correct it between them.{' '}
                  {invoice.patientName
                    ? `${invoice.patientName} owes the clinic nothing on it.`
                    : 'Nobody owes the clinic anything on it.'}
                </Notice>
              ) : invoice.due > 0 ? (
                <div className="space-y-4 border-t-2 border-ink pt-4" data-print="hide">
                  <PaymentParts
                    parts={parts}
                    onChange={setParts}
                    legend="Take payment"
                    hint="One row per method. Cash and GPay on the same bill is two rows."
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12px] text-ink-2">
                      {money(invoice.due)} is due.{' '}
                      {typed === undefined
                        ? ''
                        : full
                          ? 'That settles the bill.'
                          : `${fromPaise(typed)} leaves ${fromPaise(duePaise - typed)} outstanding.`}
                    </p>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setParts([blankPart(invoice.due.toFixed(2))])}
                    >
                      Use the full amount
                    </Button>
                  </div>

                  <Field label="Note on this payment" hint="Optional. Kept with the receipt.">
                    <Input
                      value={note}
                      disabled={busy}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </Field>

                  <div className="flex flex-wrap items-center gap-3">
                    <ConfirmButton
                      variant="primary"
                      busy={busy}
                      busyLabel="Taking…"
                      disabled={Boolean(problem)}
                      disabledReason={problem}
                      title={full ? 'Take payment' : 'Record part payment'}
                      confirmLabel={full ? 'Take payment' : 'Record part payment'}
                      question={
                        <>
                          <p>
                            Take {typed === undefined ? 'the entered amount' : fromPaise(typed)} on{' '}
                            {invoice.invoiceNumber}
                            {invoice.patientName ? ` for ${invoice.patientName}` : ''}, as{' '}
                            {entered.map((part) => METHOD_LABEL[part.method]).join(' + ') ||
                              'no method'}
                            ?
                          </p>
                          <p className="mt-2">
                            {full
                              ? 'That settles the bill.'
                              : 'The rest stays due and the bill reads as part paid.'}{' '}
                            Each part is its own numbered receipt, and money changing hands cannot
                            be undone here.
                          </p>
                        </>
                      }
                      onConfirm={takePayment}
                    >
                      {full ? 'Take payment' : 'Record part payment'}
                    </ConfirmButton>

                    {invoice.patientId ? (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setParts([blankPart()])
                          setNote('')
                          setLater(
                            `Nothing was taken. ${money(invoice.due)} stays due on ${invoice.invoiceNumber} and on ${invoice.patientName ?? 'the patient'}’s balance.`,
                          )
                        }}
                      >
                        Pay later
                      </Button>
                    ) : (
                      <p className="text-[12px] text-ink-2">
                        Pay later needs a registered patient. This bill has nobody attached to it,
                        so it is paid in full at the counter.
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
        </div>
      </div>
    </>
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
