'use client'

import { useMemo } from 'react'
import type { ClinicSnapshot } from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
import { Stack } from './shared-panels'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  clinicToday,
} from '@/components/ui'

/**
 * Stock that is going off, and the three things you can do about it.
 *
 * INVENTORY.md §6: return it to the supplier, dispense it first, or write it
 * off at cost. The list is split the way that decision is actually made rather
 * than sorted by expiry date — because the deadline that matters is usually not
 * the expiry.
 *
 * Most suppliers take stock back within a window before expiry, and the window
 * differs per supplier. A batch expiring in five months from a supplier who
 * accepts returns at six is already past saving; one expiring in three months
 * from a supplier who accepts none was never returnable at all. Sorted by
 * expiry those two appear in the wrong order, and the money goes quietly. Your
 * own notes call this "the most common thing missing from cheap pharmacy
 * software".
 */
export function ExpiringPanel({
  data,
  run,
}: {
  data: ClinicSnapshot
  run: ActionRunner
}) {
  const busy = useBusy()
  const today = clinicToday()

  const rows = useMemo(() => {
    const supplierById = new Map(data.suppliers.map((s) => [s.id, s]))

    // Two horizons, because the two deadlines are acted on at different notice.
    // Expiry keeps its six months: that is how long ahead you can still plan to
    // dispense a batch out of the way. A return deadline gets three, because
    // returning stock is a job of days — box it, note it, hand it to the
    // supplier's man on his next round — and a supplier with a generous
    // twelve-month window would otherwise put a batch on this list a year
    // before anybody could do anything but scroll past it. A list you scroll
    // past is a list you stop reading, and the whole point of this screen is
    // that it is short enough to act on.
    const dispenseHorizon = addMonths(today, 6)
    const returnHorizon = addMonths(today, 3)

    return data.batches
      .filter((batch) => batch.availableQuantity > 0)
      .map((batch) => {
        const supplier = batch.receivedFromSupplierId
          ? supplierById.get(batch.receivedFromSupplierId)
          : undefined
        const window = supplier?.returnWindowDays ?? 0

        let returnBy: string | null = null
        if (window > 0) {
          const date = new Date(`${batch.expiry}T00:00:00Z`)
          date.setUTCDate(date.getUTCDate() - window)
          returnBy = date.toISOString().slice(0, 10)
        }

        return {
          batch,
          returnBy,
          expired: batch.expiry < today,
          // Past the return deadline is not the same as expired: the stock is
          // still perfectly sellable, it simply cannot go back any more.
          windowClosed: returnBy !== null && returnBy < today,
        }
      })
      // A batch earns a place here by needing a decision, not by having a
      // supplier who takes returns. The old test was `returnBy !== null`, which
      // is every batch bought from every supplier with any window at all — a
      // 2029 expiry from a supplier who accepts returns at six months has a
      // return date, so it sat in "still returnable" sorted by a deadline three
      // years out, and the short list the screen exists to be became the whole
      // shelf. Having a deadline is not the same as being near one.
      .filter(
        (row) =>
          row.expired ||
          row.batch.expiry <= dispenseHorizon ||
          (row.returnBy !== null && row.returnBy <= returnHorizon),
      )
  }, [data.batches, data.suppliers, today])

  const returnable = rows
    .filter((row) => row.returnBy && !row.windowClosed && !row.expired)
    .sort((a, b) => (a.returnBy! < b.returnBy! ? -1 : 1))

  const others = rows
    .filter((row) => !(row.returnBy && !row.windowClosed && !row.expired))
    .sort((a, b) => (a.batch.expiry < b.batch.expiry ? -1 : 1))

  const openCredits = data.supplierReturns.filter((entry) => entry.status === 'sent')
  const owed = openCredits.reduce((sum, entry) => sum + entry.expectedCredit, 0)
  const lost = data.writeoffs.reduce((sum, entry) => sum + entry.costValue, 0)

  return (
    <Stack>
      <PageHeader
        eyebrow="Batch inventory"
        title="Expiring stock"
        sub={`${returnable.length} still returnable · ${others.length} to dispense or write off`}
      />

      {openCredits.length > 0 ? (
        <Card variant="record">
          <CardHeader
            title="Credits the supplier owes"
            sub={`₹${owed.toFixed(2)} outstanding — a credit nobody chases is a write-off with paperwork`}
          />
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH>Note</TH>
                  <TH>Supplier</TH>
                  <TH>Medicine</TH>
                  <TH num>Credit</TH>
                  <TH>Action</TH>
                </TR>
              </THead>
              <TBody>
                {openCredits.map((entry) => (
                  <TR key={entry.id}>
                    <TD>{entry.noteNumber}</TD>
                    <TD>{entry.supplierName}</TD>
                    <TD>
                      {entry.medicineName} ×{entry.quantity}
                    </TD>
                    <TD num>₹{entry.expectedCredit.toFixed(2)}</TD>
                    <TD>
                      <div className="flex gap-2" data-print="hide">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run('settle_return', { returnId: entry.id, status: 'credited' })
                          }
                        >
                          Credited
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run('settle_return', { returnId: entry.id, status: 'rejected' })
                          }
                        >
                          Rejected
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      <Card variant="record">
        <CardHeader
          title="Still returnable"
          sub="The supplier will take these back — until the date shown"
        />
        <CardBody>
          {returnable.length === 0 ? (
            <EmptyState
              title="Nothing is inside a return window"
              direction="A batch appears here when its supplier accepts returns and the deadline is approaching. Set each supplier's return window on the Suppliers screen — with none set, everything falls through to write-off."
            />
          ) : (
            <ExpiringTable rows={returnable} run={run} busy={busy} showReturn />
          )}
        </CardBody>
      </Card>

      <Card variant="record">
        <CardHeader
          title="Dispense first, or write off"
          sub="No return window, or the window has already closed"
        />
        <CardBody>
          {others.length === 0 ? (
            <EmptyState
              title="Nothing going off in the next six months"
              direction="Batches appear here as they approach expiry, or as soon as their supplier's return window closes."
            />
          ) : (
            <ExpiringTable rows={others} run={run} busy={busy} showReturn={false} />
          )}
        </CardBody>
      </Card>

      {data.writeoffs.length > 0 ? (
        <Card>
          <CardHeader title="Written off" sub={`₹${lost.toFixed(2)} at cost`} />
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Medicine</TH>
                  <TH>Batch</TH>
                  <TH num>Qty</TH>
                  <TH>Reason</TH>
                  <TH num>Cost</TH>
                  <TH>By</TH>
                </TR>
              </THead>
              <TBody>
                {data.writeoffs.map((entry) => (
                  <TR key={entry.id}>
                    <TD>{entry.date}</TD>
                    <TD>{entry.medicineName}</TD>
                    <TD>{entry.batchNumber}</TD>
                    <TD num>{entry.quantity}</TD>
                    <TD>{entry.reason}</TD>
                    <TD num>₹{entry.costValue.toFixed(2)}</TD>
                    <TD>{entry.actorName}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </Stack>
  )
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCMonth(value.getUTCMonth() + months)
  return value.toISOString().slice(0, 10)
}

type ExpiringRow = {
  batch: ClinicSnapshot['batches'][number]
  returnBy: string | null
  expired: boolean
  windowClosed: boolean
}

function ExpiringTable({
  rows,
  run,
  busy,
  showReturn,
}: {
  rows: ExpiringRow[]
  run: ActionRunner
  busy: boolean
  showReturn: boolean
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Medicine</TH>
          <TH>Batch</TH>
          <TH>Expiry</TH>
          <TH num>On hand</TH>
          <TH>Supplier</TH>
          <TH>{showReturn ? 'Return by' : 'Status'}</TH>
          <TH>Action</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.batch.id}>
            <TD>{row.batch.medicineName}</TD>
            <TD>{row.batch.batchNumber}</TD>
            <TD>{row.batch.expiry}</TD>
            <TD num>{row.batch.availableQuantity}</TD>
            <TD>{row.batch.receivedFromSupplierName ?? '—'}</TD>
            <TD>
              {showReturn ? (
                row.returnBy
              ) : row.expired ? (
                <Badge tone="stop">Expired</Badge>
              ) : row.windowClosed ? (
                <Badge tone="attn">Window closed</Badge>
              ) : (
                <Badge>No returns</Badge>
              )}
            </TD>
            <TD>
              <div className="flex gap-2" data-print="hide">
                {showReturn ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run('return_to_supplier', {
                        batchId: row.batch.id,
                        quantity: row.batch.availableQuantity,
                      })
                    }
                  >
                    Return all
                  </Button>
                ) : null}

                {/* Two gestures, because this destroys stock and the number it
                    destroys is money. */}
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  title="Write off this batch?"
                  question={
                    <>
                      {row.batch.availableQuantity} of {row.batch.medicineName}, batch{" "}
                      {row.batch.batchNumber}, leaves the shelf permanently and is
                      recorded as a loss at cost. This cannot be undone.
                    </>
                  }
                  confirmLabel="Write it off"
                  confirmVariant="danger"
                  onConfirm={() =>
                    void run('write_off_stock', {
                      batchId: row.batch.id,
                      quantity: row.batch.availableQuantity,
                      reason: 'expiry',
                    })
                  }
                >
                  Write off
                </ConfirmButton>
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
