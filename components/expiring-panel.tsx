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
  DWELL_MAJOR,
  EmptyState,
  PageHeader,
  TaskFailure,
  TaskResult,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  clinicToday,
  useTask,
} from '@/components/ui'

/**
 * Stock that is going off, and the three things you can do about it.
 *
 * docs/reference/INVENTORY.md §6: return it to the supplier, dispense it first, or write it
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

  /*
   * Stock leaving the shelf is a consequential act, and the plan says so.
   *
   * Writing a batch off destroys stock and records a loss at cost; returning it
   * sends it back to a supplier; settling a credit note decides whether money
   * is coming back at all. Each of these used to be a bare `void run(...)`
   * behind the global busy flag, so every control on the screen greyed out at
   * once, the outcome arrived as one line in the shell strip far from the row
   * it was about, and an answer lost on the clinic Wi-Fi read as "nothing
   * happened" about stock that may well have moved.
   *
   * One task rather than four: only one of these can be in flight, because each
   * one now goes through a confirmation that blocks while it runs. The working
   * label is set per invocation, so it still names the exact operation.
   */
  const task = useTask()

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

      {/*
       * A refusal, or an answer that never came back. Neither dismisses itself,
       * and the second one says the outcome is unknown rather than that nothing
       * happened — stock this screen moves may well have moved even when the
       * reply was lost on the way home.
       *
       * No `onRetry`: none of these three commands carries an idempotency key,
       * so a blind second press could write off the same batch twice. Checking
       * the shelf first is the honest instruction, and it is what the
       * unconfirmed state says.
       */}
      <TaskFailure failure={task.failure} />

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
                        <ConfirmButton
                          size="sm"
                          busy={task.busy}
                          busyLabel={task.workingLabel}
                          disabled={busy && !task.busy}
                          title={`Credit note ${entry.noteNumber} settled?`}
                          question={
                            <>
                              {entry.supplierName} has credited the return of{' '}
                              {entry.quantity} of {entry.medicineName}. The note closes and
                              the money is recorded as received.
                            </>
                          }
                          confirmLabel="Record the credit"
                          onConfirm={() =>
                            task.run({
                              working: `Settling ${entry.noteNumber}…`,
                              request: () =>
                                run('settle_return', { returnId: entry.id, status: 'credited' }),
                              confirmed: () => ({
                                kind: 'confirmed',
                                title: 'Credit recorded',
                                identity: `${entry.noteNumber} · ${entry.supplierName}`,
                                detail: `Credited for ${entry.quantity} of ${entry.medicineName}.`,
                                icon: 'rupee',
                                dwell: DWELL_MAJOR,
                              }),
                            })
                          }
                        >
                          Credited
                        </ConfirmButton>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          busy={task.busy}
                          busyLabel={task.workingLabel}
                          disabled={busy && !task.busy}
                          title={`Credit note ${entry.noteNumber} refused?`}
                          question={
                            <>
                              {entry.supplierName} has refused the return of{' '}
                              {entry.quantity} of {entry.medicineName}. The note closes with
                              no money coming back, and what was expected against it is not
                              collectable.
                            </>
                          }
                          confirmLabel="Record the refusal"
                          confirmVariant="danger"
                          onConfirm={() =>
                            task.run({
                              working: `Settling ${entry.noteNumber}…`,
                              request: () =>
                                run('settle_return', { returnId: entry.id, status: 'rejected' }),
                              // Amber. Nothing here completed happily — the stock
                              // has gone and the money is not coming back.
                              confirmed: () => ({
                                kind: 'partial',
                                title: 'Refusal recorded',
                                identity: `${entry.noteNumber} · ${entry.supplierName}`,
                                detail: `No credit for ${entry.quantity} of ${entry.medicineName}. What was expected against this note is not collectable.`,
                                icon: 'alert',
                                dwell: DWELL_MAJOR,
                              }),
                            })
                          }
                        >
                          Rejected
                        </ConfirmButton>
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
            <ExpiringTable rows={returnable} run={run} busy={busy} showReturn task={task} />
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
            <ExpiringTable rows={others} run={run} busy={busy} showReturn={false} task={task} />
          )}
        </CardBody>
      </Card>

      <TaskResult outcome={task.outcome} onDismiss={task.dismiss} />

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
  task,
}: {
  rows: ExpiringRow[]
  run: ActionRunner
  busy: boolean
  showReturn: boolean
  /**
   * The panel's one task, passed down rather than started here.
   *
   * Two tables are drawn — returnable, and dispense-first — and a batch can
   * only be in one of them, so a task per table would be two spinners for one
   * shelf. The result overlay belongs to the panel that owns both.
   */
  task: ReturnType<typeof useTask>
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
                  <ConfirmButton
                    size="sm"
                    busy={task.busy}
                    busyLabel={task.workingLabel}
                    disabled={busy && !task.busy}
                    title="Return this batch to the supplier?"
                    question={
                      <>
                        {row.batch.availableQuantity} of {row.batch.medicineName}, batch{' '}
                        {row.batch.batchNumber}, leaves the shelf and goes back to the
                        supplier. A credit note is raised for what is expected back.
                      </>
                    }
                    confirmLabel="Return it"
                    onConfirm={() =>
                      task.run({
                        working: `Returning ${row.batch.medicineName}…`,
                        request: () =>
                          run('return_to_supplier', {
                            batchId: row.batch.id,
                            quantity: row.batch.availableQuantity,
                          }),
                        confirmed: () => ({
                          kind: 'confirmed',
                          title: 'Returned to the supplier',
                          identity: `${row.batch.medicineName} · batch ${row.batch.batchNumber}`,
                          detail: `${row.batch.availableQuantity} left the shelf. The credit note is on the returns list.`,
                          icon: 'truck',
                          dwell: DWELL_MAJOR,
                        }),
                      })
                    }
                  >
                    Return all
                  </ConfirmButton>
                ) : null}

                {/* Two gestures, because this destroys stock and the number it
                    destroys is money. */}
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  busy={task.busy}
                  busyLabel={task.workingLabel}
                  disabled={busy && !task.busy}
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
                    task.run({
                      working: `Writing off ${row.batch.medicineName}…`,
                      request: () =>
                        run('write_off_stock', {
                          batchId: row.batch.id,
                          quantity: row.batch.availableQuantity,
                          reason: 'expiry',
                        }),
                      // Amber, and it names the loss. Destroying stock is not a
                      // green completion even when it is the right call.
                      confirmed: () => ({
                        kind: 'partial',
                        title: 'Written off',
                        identity: `${row.batch.medicineName} · batch ${row.batch.batchNumber}`,
                        detail: `${row.batch.availableQuantity} destroyed and recorded as a loss at cost. This cannot be undone.`,
                        icon: 'alert',
                        dwell: DWELL_MAJOR,
                      }),
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
