'use client'

import { useMemo, useState, type FormEvent } from 'react'
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
 * Counting the shelf, and correcting the record against it.
 *
 * The whole value of this screen is in what it REFUSES to show. A count field
 * with the expected number printed beside it does not find discrepancies: the
 * counter sees 47, counts "about 47", types 47, and everyone agrees the stock
 * is perfect. So while a sheet is being counted the server does not send the
 * expected quantity or the variance at all, and this panel could not display
 * them if it wanted to.
 *
 * The figures appear at submission, which is also the moment the counts stop
 * being editable. Anything wildly out goes back for a second count — and that
 * recount is blind again, for exactly the same reason.
 */
export function StockTakePanel({
  data,
  run,
}: {
  data: ClinicSnapshot
  run: ActionRunner
}) {
  const busy = useBusy()
  const take = data.stockTake
  const roles = data.session.roles
  const canApprove = roles.includes('admin') || roles.includes('doctor')
  const canAbandon = roles.includes('admin')

  const [search, setSearch] = useState('')
  const [counts, setCounts] = useState<Record<string, string>>({})

  const countedByBatch = useMemo(() => {
    const map = new Map<string, number>()
    for (const line of take?.lines ?? []) map.set(line.batchId, line.countedQuantity)
    return map
  }, [take])

  const shelf = useMemo(() => {
    const term = search.trim().toLowerCase()
    return data.batches
      .filter(
        (b) =>
          !term ||
          b.medicineName.toLowerCase().includes(term) ||
          b.batchNumber.toLowerCase().includes(term),
      )
      .sort((a, b) => a.medicineName.localeCompare(b.medicineName))
  }, [data.batches, search])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    await run('start_stock_take', {
      scope: values.get('scope'),
      scopeNote: values.get('scopeNote'),
      recountThreshold: Number(values.get('recountThreshold') ?? 500),
    })
  }

  async function count(batchId: string) {
    const typed = counts[batchId]
    if (typed === undefined || typed.trim() === '') return
    const result = await run('count_batch', {
      batchId,
      countedQuantity: Number(typed),
    })
    if (result.ok) setCounts((prev) => ({ ...prev, [batchId]: '' }))
  }

  // ---- nothing open -------------------------------------------------------

  if (!take) {
    return (
      <Stack>
        <PageHeader
          eyebrow="Pharmacy"
          title="Stock-take"
          sub="Count the shelf, then correct the record against what is actually there"
        />

        <Card variant="record">
          <CardHeader
            title="Start a stock-take"
            sub="Nothing is corrected until a count is submitted and approved"
          />
          <CardBody>
            <form onSubmit={start} className="space-y-3">
              <FieldRow cols={2}>
                <Field label="Scope">
                  <Select name="scope" defaultValue="partial">
                    <option value="partial">Part of the shelf</option>
                    <option value="full">The whole pharmacy</option>
                  </Select>
                </Field>
                <Field
                  label="Recount above"
                  hint="A difference worth more than this must be counted twice."
                >
                  <Input name="recountThreshold" inputMode="decimal" defaultValue="500" />
                </Field>
              </FieldRow>
              <Field label="What is being counted" hint="Written on the record so it makes sense later.">
                <Input name="scopeNote" placeholder="Front rack, antibiotics" />
              </Field>
              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Opening…">
                Start counting
              </ActionButton>
            </form>
          </CardBody>
        </Card>

        <History rows={data.stockTakeHistory} settings={data.settings} />
      </Stack>
    )
  }

  // ---- counting: blind ----------------------------------------------------

  if (take.status === 'counting') {
    return (
      <Stack>
        <PageHeader
          eyebrow={`${take.reference} · counting`}
          title="Stock-take"
          sub={
            take.scopeNote
              ? `${take.scopeNote} — ${take.lines.length} counted so far`
              : `${take.lines.length} batches counted so far`
          }
        />

        <Notice tone="info">
          What the record expects is deliberately not shown, and is not even sent to this tablet
          while counting. Count the box, type what is in it. If a number looks wrong afterwards,
          that is the point.
        </Notice>

        <Card>
          <CardHeader title="Count the shelf" sub="Zero is a real answer and the most useful one" />
          <CardBody>
            <Field label="Find a medicine">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or batch number"
              />
            </Field>

            {shelf.length === 0 ? (
              <EmptyState
                title="Nothing matches"
                direction="Clear the search to see the whole shelf."
              />
            ) : (
              <div className="mt-3 space-y-2">
                {shelf.map((batch) => {
                  const already = countedByBatch.get(batch.id)
                  return (
                    <div
                      key={batch.id}
                      className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-3"
                    >
                      <div className="min-w-[12rem] flex-1">
                        <p className="font-medium">{batch.medicineName}</p>
                        <p className="text-[12px] text-ink-2">
                          Batch {batch.batchNumber} · expires {batch.expiry}
                        </p>
                      </div>
                      {already !== undefined ? (
                        <Badge tone="free">counted {already}</Badge>
                      ) : null}
                      <Input
                        className="w-28"
                        inputMode="numeric"
                        placeholder="Count"
                        value={counts[batch.id] ?? ''}
                        onChange={(e) =>
                          setCounts((prev) => ({ ...prev, [batch.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void count(batch.id)
                          }
                        }}
                      />
                      <Button
                        disabled={busy || (counts[batch.id] ?? '').trim() === ''}
                        onClick={() => void count(batch.id)}
                      >
                        {already !== undefined ? 'Recount' : 'Save'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Finish counting"
            sub="Only batches with a number typed against them are part of this count"
          />
          <CardBody>
            <div className="flex flex-wrap gap-3">
              <ConfirmButton
                variant="primary"
                disabled={busy || take.lines.length === 0}
                title="Submit the count?"
                question={
                  <>
                    {take.lines.length} {take.lines.length === 1 ? 'batch' : 'batches'} will be
                    submitted and can no longer be edited. The difference against the record becomes
                    visible only now — that is what keeps the count honest. Batches you did not
                    count are left alone.
                  </>
                }
                confirmLabel="Submit the count"
                onConfirm={() => run('submit_stock_take', {})}
              >
                Submit the count
              </ConfirmButton>

              {canAbandon ? (
                <ConfirmButton
                  variant="danger"
                  disabled={busy}
                  title="Abandon this stock-take?"
                  question="Every count typed so far is discarded. Nothing has been posted, so the shelf record is unchanged."
                  confirmLabel="Abandon it"
                  onConfirm={() => run('abandon_stock_take', {})}
                >
                  Abandon
                </ConfirmButton>
              ) : null}
            </div>
          </CardBody>
        </Card>
      </Stack>
    )
  }

  // ---- submitted: the variance, and the decision --------------------------

  const needingRecount = take.lines.filter((l) => l.needsRecount)
  const off = take.lines.filter((l) => (l.variance ?? 0) !== 0)
  const netValue = take.lines.reduce((sum, l) => sum + (l.varianceValue ?? 0), 0)

  return (
    <Stack>
      <PageHeader
        eyebrow={`${take.reference} · submitted`}
        title="Stock-take"
        sub={`${off.length} of ${take.lines.length} counted batches differ from the record`}
        action={
          <Button onClick={() => window.print()} title="Opens this tablet's own print sheet">
            Print the sheet
          </Button>
        }
      />

      {needingRecount.length > 0 ? (
        <Notice tone="bad">
          {needingRecount.length} {needingRecount.length === 1 ? 'batch is' : 'batches are'} out by
          more than ₹{take.recountThreshold.toFixed(2)} and must be counted a second time before
          this can be approved. A difference that large is far more often a miscount than a real
          loss, and approving it destroys the number you would have checked it against.
        </Notice>
      ) : (
        <Notice tone={off.length === 0 ? 'good' : 'info'}>
          {off.length === 0
            ? 'Every batch counted matched the record exactly. Approving posts nothing.'
            : `Approving corrects ${off.length} ${off.length === 1 ? 'batch' : 'batches'} on the shelf record, at a net ${netValue < 0 ? 'loss' : 'gain'} of ₹${Math.abs(netValue).toFixed(2)}.`}
        </Notice>
      )}

      <Card data-print="sheet">
        <ClinicLetterhead settings={data.settings} kind="register" />
        <CardHeader
          title="What the count found"
          sub="Largest difference by value first — three insulin pens matter, three paracetamol do not"
        />
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>Medicine</TH>
                <TH>Batch</TH>
                <TH num>Record</TH>
                <TH num>Counted</TH>
                <TH num>Difference</TH>
                <TH num>Value</TH>
                <TH>Count</TH>
              </TR>
            </THead>
            <TBody>
              {take.lines.map((line) => {
                const variance = line.variance ?? 0
                return (
                  <TR key={line.id}>
                    <TD>{line.medicineName}</TD>
                    <TD>{line.batchNumber}</TD>
                    <TD num>{line.expectedQuantity}</TD>
                    <TD num>{line.countedQuantity}</TD>
                    <TD num>
                      {variance === 0 ? (
                        <Badge tone="free">match</Badge>
                      ) : (
                        <Badge tone={line.needsRecount ? 'stop' : 'attn'}>
                          {variance > 0 ? '+' : '−'}
                          {Math.abs(variance)}
                        </Badge>
                      )}
                    </TD>
                    <TD num>
                      {variance === 0 ? '—' : `₹${Math.abs(line.varianceValue ?? 0).toFixed(2)}`}
                    </TD>
                    <TD>
                      {line.needsRecount ? (
                        <Badge tone="stop">recount needed</Badge>
                      ) : line.countNumber > 1 ? (
                        <Badge tone="free">counted twice</Badge>
                      ) : (
                        '—'
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <Card data-print="hide">
        <CardHeader
          title="Approve the correction"
          sub={`Counted by ${take.lines[0]?.countedBy ?? '—'} · submitted by ${take.submittedBy ?? '—'}`}
        />
        <CardBody>
          {!canApprove ? (
            <Notice tone="info">
              The doctor or the owner approves a stock-take. Nothing is corrected until they do.
            </Notice>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-3">
            {canApprove ? (
              <ConfirmButton
                variant="primary"
                disabled={busy || needingRecount.length > 0}
                title="Approve and correct the record?"
                question={
                  <>
                    {off.length} {off.length === 1 ? 'batch' : 'batches'} will be corrected, each as
                    a recorded adjustment against {take.reference}. Anything dispensed since the
                    count is preserved — the difference is applied to today&rsquo;s figure, not
                    written over it. This cannot be undone.
                  </>
                }
                confirmLabel="Approve the correction"
                onConfirm={() => run('post_stock_take', {})}
              >
                Approve and correct
              </ConfirmButton>
            ) : null}

            <ConfirmButton
              disabled={busy}
              title="Send back for recounting?"
              question="The sheet reopens for counting and the difference is hidden again — a recount that can see the answer is not a recount."
              confirmLabel="Send it back"
              onConfirm={() => run('reopen_stock_take', {})}
            >
              Send back for recounting
            </ConfirmButton>

            {canAbandon ? (
              <ConfirmButton
                variant="danger"
                disabled={busy}
                title="Abandon this stock-take?"
                question="The whole count is discarded. Nothing has been posted, so the shelf record is unchanged."
                confirmLabel="Abandon it"
                onConfirm={() => run('abandon_stock_take', {})}
              >
                Abandon
              </ConfirmButton>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <History rows={data.stockTakeHistory} settings={data.settings} />
    </Stack>
  )
}

function History({
  rows,
  settings,
}: {
  rows: ClinicSnapshot['stockTakeHistory']
  settings: ClinicSnapshot['settings']
}) {
  return (
    <Card data-print="sheet">
      <ClinicLetterhead settings={settings} kind="register" />
      <CardHeader title="Past stock-takes" sub="What was counted, and what it corrected" />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState
            title="The shelf has never been counted"
            direction="Count a rack at a time rather than waiting for a quiet day to count everything. A partial count that happens beats a full one that does not."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Reference</TH>
                <TH>Finished</TH>
                <TH>By</TH>
                <TH>Scope</TH>
                <TH num>Counted</TH>
                <TH num>Corrected</TH>
                <TH num>Net value</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>{row.reference}</TD>
                  <TD>{row.finishedAt.slice(0, 10)}</TD>
                  <TD>{row.finishedBy}</TD>
                  <TD>
                    {row.status === 'abandoned' ? (
                      <Badge tone="plain">abandoned</Badge>
                    ) : row.scope === 'full' ? (
                      'Whole pharmacy'
                    ) : (
                      'Part of the shelf'
                    )}
                  </TD>
                  <TD num>{row.batchesCounted}</TD>
                  <TD num>{row.status === 'abandoned' ? '—' : row.batchesCorrected}</TD>
                  <TD num>
                    {row.status === 'abandoned' || row.netValue === 0
                      ? '—'
                      : `${row.netValue < 0 ? '−' : '+'}₹${Math.abs(row.netValue).toFixed(2)}`}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  )
}
