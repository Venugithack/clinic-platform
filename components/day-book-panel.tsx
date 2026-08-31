'use client'

import { useState, type FormEvent } from 'react'
import type { ClinicSnapshot } from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
import { ClinicLetterhead, Stack } from './shared-panels'
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
  FieldRow,
  Input,
  Notice,
  PageHeader,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui'

/**
 * The cash drawer, and closing the day against it.
 *
 * The question this exists to answer is the one asked at eight in the evening:
 * is ₹400 missing, or was it never taken? Without a count against an expected
 * figure there is no way to tell, and nobody finds out for weeks — by which
 * time nobody remembers the day either.
 *
 * Card and UPI are shown but deliberately kept out of the expected cash. They
 * never reach the drawer, and counting them is how a till appears to be
 * hundreds short every single day until staff stop reading the number.
 */
export function DayBookPanel({
  data,
  run,
}: {
  data: ClinicSnapshot
  run: ActionRunner
}) {
  const busy = useBusy()
  const till = data.till
  const [counted, setCounted] = useState('')

  const today = new Date().toISOString().slice(0, 10)
  const paidToday = data.bills.filter((b) => b.status === 'paid' && b.paidAt?.startsWith(today))
  const salesToday = data.otcSales.filter((s) => s.createdAt.startsWith(today))

  const byMethod = (method: string) =>
    paidToday.filter((b) => b.paymentMethod === method).reduce((sum, b) => sum + b.amount, 0) +
    salesToday.filter((s) => s.paymentMethod === method).reduce((sum, s) => sum + s.total, 0)

  const takings = byMethod('cash') + byMethod('upi') + byMethod('card')

  async function openTill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    await run('open_till', { openingFloat: Number(values.get('openingFloat') ?? 0) })
  }

  async function moveCash(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const result = await run('record_cash', {
      direction: values.get('direction'),
      amount: Number(values.get('amount') ?? 0),
      reason: values.get('reason'),
    })
    if (result.ok) form.reset()
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Collected at the clinic"
        title="Day book"
        sub={`₹${takings.toFixed(2)} taken today across ${paidToday.length + salesToday.length} transactions`}
        action={
          <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
            Print the day
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3" data-print="hide">
        <Money label="Cash" value={byMethod('cash')} note="Reaches the drawer" />
        <Money label="UPI" value={byMethod('upi')} note="Does not reach the drawer" />
        <Money label="Card" value={byMethod('card')} note="Does not reach the drawer" />
      </div>

      {!till ? (
        <Card variant="record">
          <CardHeader title="The till is closed" sub="Open it with the float that is in the drawer" />
          <CardBody>
            <form onSubmit={openTill} className="flex flex-wrap items-end gap-3">
              <Field label="Opening float" hint="What is physically in the drawer right now.">
                <Input name="openingFloat" inputMode="decimal" defaultValue="0" required />
              </Field>
              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Opening…">
                Open the till
              </ActionButton>
            </form>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card variant="record">
            <CardHeader
              title="What the drawer should hold"
              sub={`Open since ${till.openedAt.slice(0, 16).replace('T', ' ')} · ${till.openedBy}`}
            />
            <CardBody>
              <Table>
                <TBody>
                  <Line label="Opening float" value={till.openingFloat} />
                  <Line label="Cash from bills" value={till.cashFromBills} />
                  <Line label="Cash from counter sales" value={till.cashFromSales} />
                  <Line label="Cash put in" value={till.cashIn} />
                  <Line label="Cash taken out" value={-till.cashOut} />
                  <TR>
                    <TD>
                      <strong>Expected in the drawer</strong>
                    </TD>
                    <TD num>
                      <strong>₹{till.expectedCash.toFixed(2)}</strong>
                    </TD>
                  </TR>
                </TBody>
              </Table>
            </CardBody>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2" data-print="hide">
            <Card>
              <CardHeader title="Move cash" sub="Petty cash out, change in — anything not a sale" />
              <CardBody>
                <form onSubmit={moveCash} className="space-y-3">
                  <FieldRow cols={2}>
                    <Field label="Direction">
                      <Select name="direction" defaultValue="out">
                        <option value="out">Taken out</option>
                        <option value="in">Put in</option>
                      </Select>
                    </Field>
                    <Field label="Amount">
                      <Input name="amount" inputMode="decimal" required />
                    </Field>
                  </FieldRow>
                  <Field label="Reason" required>
                    <Input name="reason" required placeholder="Auto fare for delivery" />
                  </Field>
                  <ActionButton type="submit" busy={busy} busyLabel="Recording…">
                    Record it
                  </ActionButton>
                </form>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Close the day" sub="Count the drawer, then enter what is there" />
              <CardBody>
                <Notice tone="info">
                  Count first, then type. Entering the expected figure and calling it counted is the
                  one thing that makes this whole exercise worthless.
                </Notice>
                <div className="mt-3 space-y-3">
                  <Field label="Counted cash">
                    <Input
                      inputMode="decimal"
                      value={counted}
                      onChange={(e) => setCounted(e.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                  <ConfirmButton
                    variant="primary"
                    disabled={busy || counted.trim() === ''}
                    title="Close the till?"
                    question={
                      <>
                        The drawer will be recorded as holding ₹
                        {Number(counted || 0).toFixed(2)} against ₹{till.expectedCash.toFixed(2)}{' '}
                        expected. The figures are fixed at this moment and do not move afterwards.
                      </>
                    }
                    confirmLabel="Close the till"
                    onConfirm={async () => {
                      await run('close_till', { countedCash: Number(counted || 0) })
                      setCounted('')
                    }}
                  >
                    Close the till
                  </ConfirmButton>
                </div>
              </CardBody>
            </Card>
          </div>

          {till.movements.length > 0 ? (
            <Card>
              <CardHeader title="Cash moved by hand" sub={`${till.movements.length} today`} />
              <CardBody>
                <Table>
                  <THead>
                    <TR>
                      <TH>Time</TH>
                      <TH>Direction</TH>
                      <TH num>Amount</TH>
                      <TH>Reason</TH>
                      <TH>By</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {till.movements.map((m) => (
                      <TR key={m.id}>
                        <TD>{m.at.slice(11, 16)}</TD>
                        <TD>{m.direction === 'in' ? 'In' : 'Out'}</TD>
                        <TD num>₹{m.amount.toFixed(2)}</TD>
                        <TD>{m.reason}</TD>
                        <TD>{m.actorName}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </>
      )}

      <Card data-print="sheet">
        <ClinicLetterhead settings={data.settings} kind="register" />
        <CardHeader title="Day closes" sub="What was counted, against what was expected" />
        <CardBody>
          {data.tillHistory.length === 0 ? (
            <EmptyState
              title="The till has never been closed"
              direction="Open it at the start of the day, count it at the end, and the difference between the two appears here."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Closed</TH>
                  <TH>By</TH>
                  <TH num>Expected</TH>
                  <TH num>Counted</TH>
                  <TH num>Difference</TH>
                  <TH>Note</TH>
                </TR>
              </THead>
              <TBody>
                {data.tillHistory.map((close) => (
                  <TR key={close.id}>
                    <TD>{close.closedAt.slice(0, 16).replace('T', ' ')}</TD>
                    <TD>{close.closedBy}</TD>
                    <TD num>₹{close.expectedCash.toFixed(2)}</TD>
                    <TD num>₹{close.countedCash.toFixed(2)}</TD>
                    <TD num>
                      {close.variance === 0 ? (
                        <Badge tone="free">exact</Badge>
                      ) : (
                        <Badge tone={Math.abs(close.variance) > 100 ? 'stop' : 'attn'}>
                          {close.variance > 0 ? '+' : '−'}₹{Math.abs(close.variance).toFixed(2)}
                        </Badge>
                      )}
                    </TD>
                    <TD>{close.note || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </Stack>
  )
}

function Money({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <Card>
      <CardBody>
        <p className="eyebrow">{label}</p>
        <p className="tabular mt-1 font-mono text-2xl">₹{value.toFixed(2)}</p>
        <p className="mt-1 text-[12px] text-ink-2">{note}</p>
      </CardBody>
    </Card>
  )
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <TR>
      <TD>{label}</TD>
      <TD num>₹{value.toFixed(2)}</TD>
    </TR>
  )
}
