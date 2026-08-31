'use client'

import { callApi } from '@/lib/api'
import { useMemo, useState, type FormEvent } from 'react'
import type {
  ClinicSnapshot,
  CommandResponse,
  MedicineView,
  PurchaseOrderView,
  SupplierView,
} from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
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
  Textarea,
  Token,
  formatDate,
  formatExpiry,
  money,
  words,
} from '@/components/ui'

const ORDER_TONE = {
  pending: 'plain',
  placed: 'live',
  partially_delivered: 'attn',
  delivered: 'free',
  cancelled: 'stop',
} as const

const SALE_CLASS_TONE = {
  otc: 'free',
  prescription: 'attn',
  restricted: 'stop',
  unknown: 'plain',
} as const

type OtcRow = { key: string; medicineId: string; quantity: number }
type Receipt = {
  receiptNumber: string
  total: number
  paymentMethod: string
  lines: { name: string; quantity: number }[]
  at: string
}

/* ------------------------------------------------------------------ counter */

/**
 * Fetch a CSV and hand it to the browser as a file.
 *
 * It used to be an ordinary link, which worked when the API was on this origin
 * and the session was a cookie the browser attached by itself. The session is a
 * bearer token now and an <a href> carries no headers, so the download has to
 * be fetched and turned into a file here.
 */
async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await callApi(path)
  if (!response.ok) return

  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function CounterPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const otcMedicines = data.medicines.filter(
    (medicine) => medicine.active && medicine.saleClass === 'otc',
  )
  const [rows, setRows] = useState<OtcRow[]>([])
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const waiting = data.prescriptions.filter((rx) => !rx.dispensedAt)

  function nameOf(id: string) {
    const medicine = data.medicines.find((item) => item.id === id)
    return medicine ? `${medicine.name} ${medicine.strength}`.trim() : id
  }

  function stockOf(id: string) {
    return data.medicines.find((item) => item.id === id)?.totalAvailable ?? 0
  }

  /** What the basket comes to, priced off the shelf figures on the snapshot. */
  const basketProblem = useMemo(() => {
    for (const row of rows) {
      if (!row.medicineId) return 'Choose a medicine on every line.'
      if (!Number.isFinite(row.quantity) || row.quantity < 1) return 'Every line needs a quantity of at least one.'
      if (row.quantity > stockOf(row.medicineId)) {
        return `Only ${stockOf(row.medicineId)} of ${nameOf(row.medicineId)} is on the shelf.`
      }
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, data.medicines])

  function addLine() {
    const first = otcMedicines[0]
    if (first) {
      setRows((current) => [
        ...current,
        { key: crypto.randomUUID(), medicineId: first.id, quantity: 1 },
      ])
    }
  }

  async function completeSale() {
    const sold = rows.map((row) => ({ name: nameOf(row.medicineId), quantity: row.quantity }))
    const result = await run('otc_sale', { lines: rows, paymentMethod })
    if (result.ok) {
      const info = result.data as { receiptNumber: string; total: number }
      setRows([])
      setReceipt({
        receiptNumber: info.receiptNumber,
        total: info.total,
        paymentMethod,
        lines: sold,
        at: new Date().toISOString(),
      })
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Pharmacy counter"
        title="Dispensing & OTC sales"
        sub={`${waiting.length} prescriptions waiting · ${otcMedicines.length} medicines sellable over the counter`}
      />

      {receipt ? <OtcReceipt receipt={receipt} onClose={() => setReceipt(null)} /> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {/* --------------------------------------------------- OTC basket */}
          <Card variant="record" data-print="hide">
            <CardHeader
              title="New OTC sale"
              sub={`${rows.length} ${rows.length === 1 ? 'line' : 'lines'}`}
              action={<Badge tone="plain">No patient required</Badge>}
            />
            <CardBody className="space-y-3">
              {rows.length === 0 ? (
                <EmptyState
                  title="The basket is empty"
                  direction="Only medicines marked OTC can be sold here. Anything prescription-only must go through a signed prescription."
                  action={
                    <Button
                      variant="primary"
                      onClick={addLine}
                      disabled={otcMedicines.length === 0}
                      title={
                        otcMedicines.length === 0
                          ? 'No medicine on the shelf is marked OTC.'
                          : undefined
                      }
                    >
                      Add first item
                    </Button>
                  }
                />
              ) : (
                <>
                  {rows.map((row, index) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-1 gap-3 border-l-2 border-ink bg-paper/40 p-3 sm:grid-cols-[minmax(0,2fr)_110px_auto] sm:items-end"
                    >
                      <Field label={`Item ${index + 1}`}>
                        <Select
                          value={row.medicineId}
                          onChange={(event) =>
                            setRows((current) =>
                              current.map((item) =>
                                item.key === row.key
                                  ? { ...item, medicineId: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        >
                          {otcMedicines.map((medicine) => (
                            <option value={medicine.id} key={medicine.id}>
                              {medicine.name} {medicine.strength} · {medicine.totalAvailable} in stock
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Quantity" unit={data.medicines.find((m) => m.id === row.medicineId)?.unit}>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max={stockOf(row.medicineId)}
                          value={row.quantity}
                          onChange={(event) =>
                            setRows((current) =>
                              current.map((item) =>
                                item.key === row.key
                                  ? { ...item, quantity: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Button
                        variant="danger"
                        aria-label={`Remove ${nameOf(row.medicineId)}`}
                        onClick={() =>
                          setRows((current) => current.filter((item) => item.key !== row.key))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}

                  <Button onClick={addLine}>Add another item</Button>
                </>
              )}

              {basketProblem ? <Notice tone="bad">{basketProblem}</Notice> : null}

              <div className="flex flex-wrap items-end justify-end gap-3 border-t border-rule pt-3">
                <Field label="Payment" className="w-[160px]">
                  <Select
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value)}
                  >
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                  </Select>
                </Field>
                <ConfirmButton
                  variant="primary"
                  busy={busy}
                  busyLabel="Completing…"
                  disabled={rows.length === 0 || Boolean(basketProblem)}
                  disabledReason={basketProblem ?? 'Add at least one item to the basket.'}
                  title="Complete OTC sale"
                  question={
                    <>
                      Take payment by {paymentMethod} and hand over{' '}
                      <span className="font-semibold">{rows.length}</span>{' '}
                      {rows.length === 1 ? 'item' : 'items'}? Stock leaves the shelf and the receipt
                      is numbered — neither can be undone here.
                    </>
                  }
                  confirmLabel="Complete sale"
                  onConfirm={completeSale}
                >
                  Collect & complete
                </ConfirmButton>
              </div>
            </CardBody>
          </Card>

          {/* --------------------------------------------- Rx dispensing */}
          <Card data-print="hide">
            <CardHeader title="Prescriptions ready to dispense" sub={`${waiting.length} waiting`} />
            <CardBody className="space-y-3">
              {waiting.length === 0 ? (
                <EmptyState
                  title="No prescriptions waiting"
                  direction="A doctor signs a consultation with medicines on it, and it arrives here for the counter."
                />
              ) : (
                waiting.map((rx) => (
                  <div key={rx.id} className="border-l-2 border-ink bg-paper/40 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[15px] font-semibold">{rx.patientName}</p>
                      <p className="font-mono text-[12px] text-ink-2">
                        {rx.doctorName} · {formatDate(rx.signedAt)}
                      </p>
                    </div>
                    <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {rx.items.map((item) => (
                        <li
                          key={`${rx.id}-${item.medicineId}`}
                          className="border border-rule bg-sheet px-2.5 py-2 text-[13px]"
                        >
                          <span className="block font-semibold">{item.medicineName}</span>
                          <span className="mt-0.5 block font-mono text-[12px] text-ink-2">
                            {item.dosage} · {item.instructions} · qty {item.quantity}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ConfirmButton
                        variant="primary"
                        busy={busy}
                        busyLabel="Dispensing…"
                        title="Dispense prescription"
                        question={
                          <>
                            Hand over every line of{' '}
                            <span className="font-semibold">{rx.patientName}</span>&apos;s
                            prescription? Stock is allocated first-expiry-first and leaves the shelf
                            for good.
                          </>
                        }
                        confirmLabel="Dispense"
                        onConfirm={() => run('dispense_rx', { prescriptionId: rx.id })}
                      >
                        Dispense Rx
                      </ConfirmButton>
                      <Button onClick={() => window.print()}>Print</Button>
                    </div>
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------------- receipt ledger */}
        <aside className="xl:sticky xl:top-5 xl:self-start" data-print="hide">
          <Card>
            <CardHeader title="Recent OTC receipts" sub={`${data.otcSales.length} today`} />
            <CardBody className="space-y-2">
              {data.otcSales.length === 0 ? (
                <p className="text-[13px] text-ink-2">
                  No OTC sale has been rung up yet. Completed sales are listed here with their
                  receipt number.
                </p>
              ) : (
                data.otcSales.map((sale) => (
                  <div
                    key={sale.id}
                    className="flex items-baseline justify-between gap-3 border-b border-rule pb-2 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <Token code={sale.receiptNumber} />
                      <span className="mt-1 block font-mono text-[11px] text-ink-2">
                        {formatDate(sale.createdAt)} · {sale.lineCount}{' '}
                        {sale.lineCount === 1 ? 'item' : 'items'}
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
        </aside>
      </div>
    </Stack>
  )
}

/**
 * The receipt the customer walks out holding.
 *
 * A record-weight document that becomes the whole page when printed: the app
 * chrome, the basket and the ledger all carry `data-print="hide"`, and this
 * carries `data-print="sheet"`. Printing is the tablet's own dialog.
 */
function OtcReceipt({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  return (
    <Card variant="record" data-print="sheet">
      <CardHeader
        title="OTC receipt"
        sub={receipt.receiptNumber}
        action={
          <span className="flex gap-2" data-print="hide">
            <Button variant="primary" onClick={() => window.print()}>
              Print receipt
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </span>
        }
      />
      <CardBody>
        <p className="text-[18px] font-semibold tracking-tight">Jayamurugan Clinic</p>
        <p className="mt-0.5 font-mono text-[12px] text-ink-2">
          {formatDate(receipt.at)} · paid by {receipt.paymentMethod}
        </p>

        <Table>
          <THead>
            <TR>
              <TH>Item</TH>
              <TH num>Quantity</TH>
            </TR>
          </THead>
          <TBody>
            {receipt.lines.map((line, index) => (
              <TR key={`${line.name}-${index}`}>
                <TD>{line.name}</TD>
                <TD num>{line.quantity}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <div className="mt-3 flex items-baseline justify-between border-t-2 border-ink pt-3">
          <span className="eyebrow">Total paid</span>
          <span className="font-mono text-[20px] font-medium tabular-nums">
            {money(receipt.total)}
          </span>
        </div>
        <p className="mt-3 text-[11px] text-ink-2">
          Over-the-counter sale. No patient record is attached to this receipt.
        </p>
      </CardBody>
    </Card>
  )
}

/* ---------------------------------------------------------------- inventory */

export function InventoryPanel({
  data,
  run,
  uploadCsv,
}: {
  data: ClinicSnapshot
  run: ActionRunner
  uploadCsv: (file: File) => Promise<CommandResponse>
}) {
  const busy = useBusy()
  const [query, setQuery] = useState('')
  const [batchesFor, setBatchesFor] = useState<MedicineView | null>(null)

  const shown = data.medicines.filter((medicine) =>
    `${medicine.code} ${medicine.name} ${medicine.strength} ${medicine.preferredSupplierName ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const low = data.medicines.filter(
    (medicine) => medicine.active && medicine.totalAvailable <= medicine.reorderLevel,
  )

  async function addMedicine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form))
    const result = await run('add_medicine', values)
    if (result.ok) form.reset()
  }

  async function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const file = new FormData(form).get('file')
    if (file instanceof File) {
      const result = await uploadCsv(file)
      if (result.ok) form.reset()
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Batch inventory"
        title="Medicines & stock"
        sub={`${data.medicines.length} medicines · ${low.length} at or below reorder level`}
        action={
          <>
            <button
              type="button"
              onClick={() => void downloadCsv('csv?template=1', 'jayamurugan-inventory-template.csv')}
              className="inline-flex min-h-[48px] items-center justify-center rounded-box border border-ink px-4 py-2 text-[13px] font-semibold tracking-[0.08em] uppercase transition-colors hover:bg-ink/8"
            >
              CSV template
            </button>
            <button
              type="button"
              onClick={() => void downloadCsv('csv', 'jayamurugan-inventory.csv')}
              className="inline-flex min-h-[48px] items-center justify-center rounded-box border border-ink px-4 py-2 text-[13px] font-semibold tracking-[0.08em] uppercase transition-colors hover:bg-ink/8"
            >
              Export CSV
            </button>
          </>
        }
      />

      <div className="space-y-4" data-print="hide">
        <Disclosure
          label="Add a medicine"
          hint="Everything the counter and the reorder calculation need to know about one line on the shelf"
        >
          <form onSubmit={addMedicine} className="space-y-5">
            <div>
              <SectionHeader title="Identity" />
              <FieldRow cols={4} className="mt-2">
                <Field label="Code" required>
                  <Input name="code" required autoCapitalize="characters" spellCheck={false} />
                </Field>
                <Field label="Medicine name" required>
                  <Input name="name" required />
                </Field>
                <Field label="Strength">
                  <Input name="strength" placeholder="500mg" />
                </Field>
                <Field label="Dosage form">
                  <Input name="dosageForm" placeholder="Tablet" />
                </Field>
                <Field label="Stock unit" required hint="What one of it is called: tablets, bottles.">
                  <Input name="unit" placeholder="tablets" required />
                </Field>
                <Field label="Barcode">
                  <Input name="barcode" inputMode="numeric" />
                </Field>
                <Field
                  label="Sale class"
                  hint="Only OTC may be sold at the counter without a prescription."
                >
                  <Select name="saleClass" defaultValue="otc">
                    <option value="otc">OTC</option>
                    <option value="prescription">Prescription</option>
                    <option value="restricted">Restricted</option>
                    <option value="unknown">Unknown</option>
                  </Select>
                </Field>
                <Field label="Preferred supplier">
                  <Select name="preferredSupplierId" defaultValue="">
                    <option value="">None</option>
                    {data.suppliers
                      .filter((supplier) => supplier.active)
                      .map((supplier) => (
                        <option value={supplier.id} key={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </FieldRow>
            </div>

            <div>
              <SectionHeader title="Reordering" />
              <FieldRow cols={4} className="mt-2">
                <Field label="Reorder level" required hint="Order when the shelf falls to this.">
                  <Input name="reorderLevel" type="number" min="0" defaultValue="10" required />
                </Field>
                <Field label="Target stock" required hint="Order back up to this.">
                  <Input name="targetStock" type="number" min="0" defaultValue="50" required />
                </Field>
              </FieldRow>
            </div>

            <div>
              <SectionHeader
                title="Opening batch"
                sub="Optional — leave the quantity at zero to add the medicine with an empty shelf."
              />
              <FieldRow cols={4} className="mt-2">
                <Field label="Opening quantity">
                  <Input name="initialQuantity" type="number" min="0" defaultValue="0" />
                </Field>
                <Field label="Batch number">
                  <Input name="batchNumber" autoCapitalize="characters" spellCheck={false} />
                </Field>
                <Field label="Expiry">
                  <Input name="expiry" type="date" />
                </Field>
                <Field label="MRP" unit="₹">
                  <Input name="mrp" type="number" min="0" step="0.01" defaultValue="0" />
                </Field>
                <Field label="Purchase price" unit="₹">
                  <Input name="purchasePrice" type="number" min="0" step="0.01" defaultValue="0" />
                </Field>
                <Field label="Selling price" unit="₹">
                  <Input name="sellingPrice" type="number" min="0" step="0.01" defaultValue="0" />
                </Field>
              </FieldRow>
            </div>

            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Adding…">
              Add medicine
            </ActionButton>
          </form>
        </Disclosure>

        <Card>
          <CardHeader title="Import inventory CSV" />
          <CardBody>
            <form onSubmit={importFile} className="flex flex-wrap items-end gap-3">
              <Field
                label="CSV file"
                className="min-w-[240px] flex-1"
                hint="Validated as one transaction — one bad row and nothing is imported. The same file cannot be imported twice, and existing batch balances are never overwritten."
              >
                <Input name="file" type="file" accept=".csv,text/csv" required />
              </Field>
              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Validating…">
                Validate & import
              </ActionButton>
            </form>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Shelf"
          sub={`${shown.length} of ${data.medicines.length} shown`}
          action={
            <span className="w-[240px]" data-print="hide">
              <Field label="Search">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Medicine, code or supplier"
                  type="search"
                />
              </Field>
            </span>
          }
        />
        {shown.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nothing matches that search"
              direction="Clear the search box to see the whole shelf again."
              action={<Button onClick={() => setQuery('')}>Clear search</Button>}
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Medicine</TH>
                <TH>Class</TH>
                <TH num>Available</TH>
                <TH num>Reorder / target</TH>
                <TH>Preferred supplier</TH>
                <TH>Batches</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((medicine) => {
                const isLow = medicine.totalAvailable <= medicine.reorderLevel
                return (
                  <TR key={medicine.id} muted={!medicine.active}>
                    <TD>
                      <span className="block font-semibold">
                        {medicine.name} {medicine.strength}
                      </span>
                      <span className="mt-0.5 block font-mono text-[12px] text-ink-2">
                        {medicine.code}
                        {medicine.dosageForm ? ` · ${medicine.dosageForm}` : ''}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={SALE_CLASS_TONE[medicine.saleClass]}>{medicine.saleClass}</Badge>
                    </TD>
                    <TD num>
                      <span className={isLow ? 'font-semibold text-stop' : ''}>
                        {medicine.totalAvailable}
                      </span>
                      <span className="ml-1 text-[11px] text-ink-2">{medicine.unit}</span>
                    </TD>
                    <TD num>
                      {medicine.reorderLevel} / {medicine.targetStock}
                    </TD>
                    <TD>
                      {medicine.preferredSupplierName ?? (
                        <span className="text-ink-2">Not linked</span>
                      )}
                    </TD>
                    <TD>
                      <Button size="sm" data-print="hide" onClick={() => setBatchesFor(medicine)}>
                        Batches
                      </Button>
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={batchesFor !== null}
        onClose={() => setBatchesFor(null)}
        title="Batches on the shelf"
        sub={batchesFor ? `${batchesFor.name} ${batchesFor.strength}`.trim() : undefined}
      >
        {(() => {
          const batches = data.batches.filter((batch) => batch.medicineId === batchesFor?.id)
          if (batches.length === 0) {
            return (
              <EmptyState
                title="No stock on the shelf"
                direction="Receiving a supplier delivery, or importing a CSV, creates the first batch."
              />
            )
          }
          return (
            <Table>
              <THead>
                <TR>
                  <TH>Batch</TH>
                  <TH>Expiry</TH>
                  <TH num>Available</TH>
                  <TH num>MRP</TH>
                  <TH>From</TH>
                </TR>
              </THead>
              <TBody>
                {batches.map((batch) => (
                  <TR key={batch.id}>
                    <TD num>{batch.batchNumber}</TD>
                    <TD num>{formatExpiry(batch.expiry)}</TD>
                    <TD num>{batch.availableQuantity}</TD>
                    <TD num>{money(batch.mrp)}</TD>
                    <TD className="text-ink-2">{batch.receivedFromSupplierName ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )
        })()}
      </Modal>
    </Stack>
  )
}

/* ---------------------------------------------------------------- suppliers */

export function SuppliersPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const [linking, setLinking] = useState<SupplierView | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const result = await run('add_supplier', Object.fromEntries(new FormData(form)))
    if (result.ok) form.reset()
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Supply network"
        title="Suppliers"
        sub={`${data.suppliers.filter((s) => s.active).length} active of ${data.suppliers.length}`}
      />

      <div data-print="hide">
        <Disclosure label="Add a supplier" hint="A WhatsApp number is what orders are sent to">
          <form onSubmit={submit} className="space-y-4">
            <FieldRow cols={4}>
              <Field label="Supplier code" required>
                <Input name="code" required autoCapitalize="characters" spellCheck={false} />
              </Field>
              <Field label="Business name" required>
                <Input name="name" required />
              </Field>
              <Field label="Contact person">
                <Input name="contactPerson" />
              </Field>
              <Field label="WhatsApp number" required>
                <Input name="whatsapp" type="tel" inputMode="tel" required />
              </Field>
              <Field label="Phone">
                <Input name="phone" type="tel" inputMode="tel" />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field label="Address">
                <Input name="address" />
              </Field>
              <Field label="GSTIN">
                <Input name="gstin" autoCapitalize="characters" spellCheck={false} />
              </Field>
            </FieldRow>
            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Adding…">
              Add supplier
            </ActionButton>
          </form>
        </Disclosure>
      </div>

      <Card>
        <CardHeader title="Suppliers" sub={`${data.suppliers.length} on file`} />
        {data.suppliers.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No suppliers yet"
              direction="Add the first supplier above, then link the medicines they carry."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Supplier</TH>
                <TH>Contact</TH>
                <TH>WhatsApp</TH>
                <TH num>Medicines linked</TH>
                <TH>Status</TH>
                <TH>Links</TH>
              </TR>
            </THead>
            <TBody>
              {data.suppliers.map((supplier) => (
                <TR key={supplier.id} muted={!supplier.active}>
                  <TD>
                    <span className="block font-semibold">{supplier.name}</span>
                    <span className="mt-0.5 block font-mono text-[12px] text-ink-2">
                      {supplier.code}
                    </span>
                  </TD>
                  <TD className="text-ink-2">{supplier.contactPerson || '—'}</TD>
                  <TD num>{supplier.whatsapp}</TD>
                  <TD num>{supplier.medicineIds.length}</TD>
                  <TD>
                    <Badge tone={supplier.active ? 'free' : 'stop'}>
                      {supplier.active ? 'Active' : 'Disabled'}
                    </Badge>
                  </TD>
                  <TD>
                    <Button size="sm" data-print="hide" onClick={() => setLinking(supplier)}>
                      Edit links
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <SupplierLinks
        key={linking?.id ?? 'none'}
        supplier={linking}
        medicines={data.medicines}
        run={run}
        onClose={() => setLinking(null)}
      />
    </Stack>
  )
}

/**
 * Linking medicines to a supplier — the one screen that had to stay easy.
 *
 * Full-width 56px rows, the whole row a target, the box on the left and the
 * state repeated as a filled ground so a glance down the column reads as
 * "these ones". Select-all and clear are one tap each, the search narrows
 * without losing what is already ticked, and the count is stated next to the
 * save so nobody saves a set they did not mean.
 */
function SupplierLinks({
  supplier,
  medicines,
  run,
  onClose,
}: {
  supplier: SupplierView | null
  medicines: MedicineView[]
  run: ActionRunner
  onClose: () => void
}) {
  const busy = useBusy()
  const [selected, setSelected] = useState(() => new Set(supplier?.medicineIds ?? []))
  const [query, setQuery] = useState('')

  const shown = medicines.filter((medicine) =>
    `${medicine.name} ${medicine.strength} ${medicine.code}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const original = new Set(supplier?.medicineIds ?? [])
  const dirty =
    selected.size !== original.size || [...selected].some((id) => !original.has(id))

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Modal
      open={supplier !== null}
      onClose={onClose}
      title="Medicines from this supplier"
      sub={supplier?.name}
      footer={
        <>
          <span className="mr-auto self-center font-mono text-[13px] text-ink-2 tabular-nums">
            {selected.size} selected{dirty ? ' · unsaved' : ''}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            variant="primary"
            busy={busy}
            busyLabel="Saving…"
            disabled={!dirty}
            disabledReason="Nothing has changed since this was opened."
            onClick={async () => {
              if (!supplier) return
              const result = await run('set_supplier_medicines', {
                supplierId: supplier.id,
                medicineIds: [...selected],
              })
              if (result.ok) onClose()
            }}
          >
            Save links
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Find a medicine" className="min-w-[200px] flex-1">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or code"
            />
          </Field>
          <Button onClick={() => setSelected(new Set(medicines.map((m) => m.id)))}>
            Select all
          </Button>
          <Button onClick={() => setSelected(new Set())}>Clear</Button>
        </div>

        {shown.length === 0 ? (
          <EmptyState
            title="No medicine matches"
            direction="Clear the search to see the whole shelf again."
          />
        ) : (
          <div className="space-y-2">
            {shown.map((medicine) => (
              <CheckRow
                key={medicine.id}
                checked={selected.has(medicine.id)}
                onChange={() => toggle(medicine.id)}
                label={
                  <span className="font-semibold">
                    {medicine.name} {medicine.strength}
                  </span>
                }
                hint={`${medicine.code} · ${medicine.totalAvailable} ${medicine.unit} on the shelf`}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------- orders */

export function OrdersPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const low = data.medicines.filter(
    (medicine) => medicine.totalAvailable <= medicine.reorderLevel && medicine.active,
  )
  const [supplierId, setSupplierId] = useState(data.suppliers[0]?.id ?? '')
  const [receiving, setReceiving] = useState<PurchaseOrderView | null>(null)

  return (
    <Stack>
      <PageHeader
        eyebrow="Purchase orders"
        title="Supplier orders"
        sub={`${low.length} medicines need reordering · ${data.orders.length} orders on file`}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-print="hide">
        <Card>
          <CardHeader title="Needs reordering" sub={`${low.length} medicines`} />
          {low.length === 0 ? (
            <CardBody>
              <EmptyState
                title="Stock is above every reorder level"
                direction="A medicine appears here as soon as its shelf figure falls to its reorder level."
              />
            </CardBody>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Medicine</TH>
                  <TH num>On shelf</TH>
                  <TH num>Target</TH>
                  <TH>Preferred supplier</TH>
                </TR>
              </THead>
              <TBody>
                {low.map((medicine) => (
                  <TR key={medicine.id}>
                    <TD className="font-semibold">
                      {medicine.name} {medicine.strength}
                    </TD>
                    <TD num>
                      <span className="font-semibold text-stop">{medicine.totalAvailable}</span>
                    </TD>
                    <TD num>{medicine.targetStock}</TD>
                    <TD>
                      {medicine.preferredSupplierName ?? (
                        <span className="text-ink-2">Not linked</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Draft an order" />
          <CardBody className="space-y-4">
            <p className="text-[13px] leading-relaxed text-ink-2">
              The clinic groups every linked low-stock medicine for one supplier and works out how
              many packs bring each back up to its target. The draft is yours to edit before it goes
              anywhere.
            </p>
            <Field label="Supplier" required>
              <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
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
            <ActionButton
              variant="primary"
              busy={busy}
              busyLabel="Drafting…"
              disabled={!supplierId}
              disabledReason="Choose which supplier this order goes to."
              onClick={() => run('create_order', { supplierId })}
            >
              Create draft order
            </ActionButton>
          </CardBody>
        </Card>
      </div>

      {data.orders.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="No orders yet"
              direction="Draft one above and it stays here through placing, part-delivery and delivery."
            />
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              connected={data.whatsapp.configured}
              connectionNote={data.whatsapp.note}
              run={run}
              onReceive={() => setReceiving(order)}
            />
          ))}
        </div>
      )}

      <ReceiveDelivery
        key={receiving?.id ?? 'none'}
        order={receiving}
        run={run}
        onClose={() => setReceiving(null)}
      />
    </Stack>
  )
}

function OrderCard({
  order,
  connected,
  connectionNote,
  run,
  onReceive,
}: {
  order: PurchaseOrderView
  connected: boolean
  connectionNote: string
  run: ActionRunner
  onReceive: () => void
}) {
  const busy = useBusy()
  const [draft, setDraft] = useState(order.messageDraft)
  const editable = order.status === 'pending'
  const receivable = order.status === 'placed' || order.status === 'partially_delivered'
  const blocked = !connected
    ? connectionNote || 'WhatsApp is not connected, so no order can be sent.'
    : draft.trim() === ''
      ? 'The message is empty.'
      : undefined

  return (
    <Card variant="record" data-print="sheet">
      <CardHeader
        title={order.supplierName}
        sub={order.orderNumber}
        action={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_TONE[order.status]}>{words(order.status)}</Badge>
            {order.messageStatus ? (
              <Badge tone={order.messageStatus === 'failed' ? 'stop' : 'plain'}>
                WhatsApp {order.messageStatus}
              </Badge>
            ) : null}
          </span>
        }
      />
      <CardBody className="space-y-4">
        <p className="font-mono text-[12px] text-ink-2">
          Created {formatDate(order.createdAt)}
          {order.placedAt ? ` · placed ${formatDate(order.placedAt)}` : ''}
        </p>

        <Table>
          <THead>
            <TR>
              <TH>Medicine</TH>
              <TH num>Ordered</TH>
              <TH num>Received</TH>
              <TH num>Outstanding</TH>
            </TR>
          </THead>
          <TBody>
            {order.lines.map((line) => {
              const outstanding = line.orderedQuantity - line.receivedQuantity
              return (
                <TR key={line.id}>
                  <TD className="font-semibold">{line.medicineName}</TD>
                  <TD num>{line.orderedQuantity}</TD>
                  <TD num>{line.receivedQuantity}</TD>
                  <TD num>
                    <span className={outstanding > 0 ? 'text-attn' : 'text-free'}>
                      {outstanding}
                    </span>
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>

        <div data-print="hide">
          <Field
            label="WhatsApp message to the supplier"
            hint={
              editable
                ? 'Edit freely before it is sent. Nothing goes out until you place the order.'
                : 'This order has been placed — the message is kept as it was sent.'
            }
          >
            <Textarea
              rows={6}
              value={editable ? draft : order.messageDraft}
              readOnly={!editable}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2" data-print="hide">
          {editable ? (
            <>
              <ActionButton
                busy={busy}
                busyLabel="Saving…"
                disabled={draft.trim() === order.messageDraft.trim()}
                disabledReason="The draft has not been changed."
                onClick={() => run('update_order_draft', { orderId: order.id, messageDraft: draft })}
              >
                Save draft
              </ActionButton>
              <ConfirmButton
                variant="primary"
                busy={busy}
                busyLabel="Sending…"
                disabled={Boolean(blocked)}
                disabledReason={blocked}
                title="Place this order"
                question={
                  <>
                    Send this message to{' '}
                    <span className="font-semibold">{order.supplierName}</span> on WhatsApp and mark
                    the order placed? A sent message cannot be recalled.
                  </>
                }
                confirmLabel="Send & place"
                onConfirm={() => run('send_order', { orderId: order.id, messageDraft: draft })}
              >
                {connected ? 'Send & place order' : 'Connect WhatsApp to send'}
              </ConfirmButton>
            </>
          ) : null}

          {receivable ? (
            <Button variant="primary" onClick={onReceive}>
              Receive delivery
            </Button>
          ) : null}

          <Button onClick={() => window.print()}>Print order</Button>
        </div>

        {!connected && editable ? (
          <Notice tone="bad">
            {connectionNote ||
              'WhatsApp is not connected. Orders can be drafted and printed, but nothing is sent until real Meta credentials exist.'}
          </Notice>
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * Goods receipt: what actually arrived, and the batch it arrived in.
 *
 * Every field here is required because a batch with no expiry cannot be
 * allocated first-expiry-first later, and a batch with no number cannot be
 * traced when a supplier recalls one.
 */
function ReceiveDelivery({
  order,
  run,
  onClose,
}: {
  order: PurchaseOrderView | null
  run: ActionRunner
  onClose: () => void
}) {
  const busy = useBusy()
  const remaining = (order?.lines ?? []).filter(
    (line) => line.receivedQuantity < line.orderedQuantity,
  )
  const [lineId, setLineId] = useState(remaining[0]?.id ?? '')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!order) return
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form))
    const result = await run('receive_order', {
      orderId: order.id,
      receipts: [{ ...values, lineId }],
    })
    if (result.ok) {
      form.reset()
      onClose()
    }
  }

  const line = remaining.find((item) => item.id === lineId)
  const outstanding = line ? line.orderedQuantity - line.receivedQuantity : undefined

  return (
    <Modal
      open={order !== null}
      onClose={onClose}
      title="Receive delivery"
      sub={order ? `${order.orderNumber} · ${order.supplierName}` : undefined}
    >
      {remaining.length === 0 ? (
        <EmptyState
          title="Every line has been received"
          direction="This order is complete — nothing is outstanding."
        />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Medicine" required>
            <Select value={lineId} onChange={(event) => setLineId(event.target.value)} required>
              {remaining.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.medicineName} · {item.orderedQuantity - item.receivedQuantity} outstanding
                </option>
              ))}
            </Select>
          </Field>

          <FieldRow>
            <Field
              label="Quantity received"
              required
              hint={outstanding ? `${outstanding} outstanding on this line.` : undefined}
            >
              <Input name="quantity" type="number" min="1" inputMode="numeric" required />
            </Field>
            <Field label="Batch number" required>
              <Input name="batchNumber" required autoCapitalize="characters" spellCheck={false} />
            </Field>
            <Field label="Expiry" required hint="Printed on the strip — month and year.">
              <Input name="expiry" type="date" required />
            </Field>
            <Field label="MRP" unit="₹" required>
              <Input name="mrp" type="number" min="0" step="0.01" required />
            </Field>
            <Field label="Purchase price" unit="₹" required>
              <Input name="purchasePrice" type="number" min="0" step="0.01" required />
            </Field>
            <Field label="Selling price" unit="₹" required>
              <Input name="sellingPrice" type="number" min="0" step="0.01" required />
            </Field>
          </FieldRow>

          <div className="flex justify-end gap-2 border-t border-rule pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Adding…">
              Add to stock
            </ActionButton>
          </div>
        </form>
      )}
    </Modal>
  )
}
