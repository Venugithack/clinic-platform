'use client';

/**
 * The inventory window. INVENTORY.md §4.
 *
 * Every other stock screen in this build is a screen for doing a job —
 * receiving books stock in, stock-take counts it, expiry writes it off, reorder
 * buys more. Until this one there was nowhere to simply LOOK SOMETHING UP: how
 * much Azithral is there, across how many batches, and what is it worth. Stock
 * appeared only as a side effect of other work, which meant the answer existed
 * four times over and was reachable only by starting a task nobody wanted to
 * start.
 *
 * So this screen commits nothing. No transition is imported here, there is no
 * primary action in the rail, and there is nothing on it a wrong tap can spend
 * or destroy. That is the point: it is the one stock screen a pharmacist can
 * open mid-shift with a customer waiting, and it is safe to open by accident.
 *
 * What it deliberately does NOT do:
 *
 *   · flag what is going off. `/expiry` owns that, deadline and return window
 *     and all, and a second screen with a softer version of the same warning is
 *     how a real one gets ignored. The earliest expiry is printed as a fact.
 *   · flag what is low. `/reorder` owns that, with the velocity and lead time
 *     that are what make "low" mean anything.
 *   · show expired stock. `stock_valuation` excludes it, exactly as
 *     `available_stock` does — INVENTORY.md §3, and the expiry desk is the one
 *     screen in the build that may see it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Badge, EmptyState, Notice, PageHeader } from '@/components/ui';
import {
  batchesForDrug,
  matches,
  shelf,
  shelfTotals,
  type ShelfBatch,
  type ShelfRow,
} from '@/lib/db/inventory';
import { formatQty } from '@/lib/units';

const money = (value: number | string) => `₹${Number(value).toFixed(2)}`;

/** "Mar 2027" — as printed on the strip (PLAN.md §12.3). */
const asPrinted = (date: string) =>
  new Date(date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

export default function InventoryPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ShelfRow[]>([]);
  const [query, setQuery] = useState('');
  const [openDrug, setOpenDrug] = useState<string | null>(null);
  const [batches, setBatches] = useState<ShelfBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    // Cleared before the read, never after it. A read landing is not evidence
    // that the last WRITE succeeded, and clearing on completion erased a
    // refusal somebody was in the middle of reading (M11e).
    setError(null);
    void shelf()
      .then((shelfRows) => {
        setRows(shelfRows);
        setLoaded(true);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(refresh, [refresh]);

  const shown = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);

  // Two totals, and they answer different questions. The shelf total is what
  // the business is holding; the filtered one is what the search in front of
  // you comes to. Showing a single figure that silently changes meaning with
  // the contents of a text box is how a valuation gets quoted at the wrong
  // number.
  const all = useMemo(() => shelfTotals(rows), [rows]);
  const filtered = useMemo(() => shelfTotals(shown), [shown]);
  const searching = query.trim() !== '';

  const toggle = (row: ShelfRow) => {
    if (openDrug === row.drug_id) {
      setOpenDrug(null);
      setBatches([]);
      return;
    }

    setOpenDrug(row.drug_id);
    setBatches([]);
    void batchesForDrug(row.drug_id)
      .then(setBatches)
      .catch((cause: Error) => setError(cause.message));
  };

  return (
    <ThreePane
      context={
        <div className="flex flex-col gap-6">
          <div>
            <p className="eyebrow">On the shelf</p>
            <p className="mt-1 text-lg">
              {all.drugs} drug{all.drugs === 1 ? '' : 's'}
            </p>
            <p className="tabular mt-1 font-mono text-sm text-ink-2">
              {all.batches} batch{all.batches === 1 ? '' : 'es'}
            </p>
          </div>

          <div>
            <p className="eyebrow">Value at cost</p>
            <p className="tabular mt-1 font-mono text-2xl">{money(all.value)}</p>
            <p className="mt-1 text-sm text-ink-2">
              The weighted average of what was actually paid, batch by batch —
              not MRP, and not what it would sell for.
            </p>
          </div>

          {searching ? (
            <div>
              <p className="eyebrow">This search</p>
              <p className="mt-1 text-lg">
                {filtered.drugs} drug{filtered.drugs === 1 ? '' : 's'}
              </p>
              <p className="tabular mt-1 font-mono text-sm text-ink-2">
                {money(filtered.value)}
              </p>
            </div>
          ) : null}

          <p className="text-sm text-ink-2">
            Expired stock is not counted here and never appears — the expiry desk
            is the one screen that can see it. Nothing on this page changes
            anything.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton onClick={refresh}>Refresh</RailButton>
          <RailButton onClick={() => router.push('/expiry')}>Expiry</RailButton>
          <RailButton onClick={() => router.push('/reorder')}>Reorder</RailButton>
          <RailButton onClick={() => router.push('/receiving')}>Receiving</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Pharmacy" title="Inventory" />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {/* No minimum length and no debounce: the whole shelf is already in hand,
          so this filters a list rather than costing a round trip per keystroke.
          Matching salt as well as brand is not a nicety — the box says
          Augmentin and the person looking for it is thinking amoxicillin. */}
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Brand, generic or salt"
        aria-label="Search the shelf"
        className="blank h-14 w-full max-w-4xl px-4 text-lg"
      />

      {loaded && rows.length === 0 && !error ? (
        <EmptyState
          title="Nothing on the shelf"
          direction="Book stock in through Receiving and it appears here, with what it cost."
        />
      ) : null}

      {loaded && rows.length > 0 && shown.length === 0 ? (
        <EmptyState
          title={`Nothing on the shelf matches "${query.trim()}"`}
          direction="The drug may still be in the catalogue with none in stock — this screen lists what is physically here, and nothing else."
        />
      ) : null}

      <ul className="max-w-4xl">
        {shown.map((row) => {
          const pack = {
            unitsPerStrip: row.units_per_strip,
            stripsPerBox: row.strips_per_box,
          };
          const isOpen = openDrug === row.drug_id;

          return (
            <li key={row.drug_id} className="border-b border-rule">
              {/* Named with the drug AND its numbers. A control that announces
                  itself as "expand" tells a screen reader nothing about which
                  medicine it is opening, and this list is forty rows of the
                  same control. */}
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={`${row.drug_name}: ${row.qty_base_on_hand} ${row.base_unit}, ${row.batches} batch${row.batches === 1 ? '' : 'es'}, ${money(row.value_at_cost)} at cost`}
                onClick={() => toggle(row)}
                className="w-full py-3 text-left active:bg-paper-2"
                data-testid={`inventory-${row.drug_name}`}
              >
                {/* Two lines, not one row of columns, and the reason is the
                    narrow end of the range. At 1024 (TABLET.md §3) the work
                    pane is about 460px once the brand strip, the context pane
                    and the rail have taken theirs — a single row of five
                    columns gave the drug name roughly 140px of that and
                    truncated "Alprax 0.25" to "A..". The name is the one thing
                    on this screen nobody can do without, so it gets a line
                    with only the two figures that are read against it, and
                    everything else drops to the line below. */}
                <span className="flex items-baseline gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-lg">{row.drug_name}</span>
                    {/* A schedule is a fact about the drug, not a state it is
                        in, so it takes the neutral tone. Law 2 keeps the five
                        hues for what is happening — spending red on "H1" here
                        would make a genuinely refused thing elsewhere read as
                        one more label. */}
                    {row.schedule !== 'OTC' ? (
                      <Badge>Schedule {row.schedule}</Badge>
                    ) : null}
                  </span>

                  <span className="tabular shrink-0 whitespace-nowrap font-mono text-lg">
                    {row.qty_base_on_hand}
                  </span>
                  <span className="tabular w-28 shrink-0 whitespace-nowrap text-right font-mono text-lg">
                    {money(row.value_at_cost)}
                  </span>
                </span>

                <span className="mt-0.5 flex items-baseline gap-3 text-sm text-ink-2">
                  <span className="min-w-0 flex-1 truncate">
                    {[row.salt_composition, row.strength, row.form]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">
                    {formatQty(row.qty_base_on_hand, pack, row.base_unit, { boxes: true })}
                    {' · '}
                    {row.batches} batch{row.batches === 1 ? '' : 'es'}
                    {' · '}
                    {asPrinted(row.earliest_expiry)}
                  </span>
                </span>
              </button>

              {/* The batches behind the number, in the order the next sale will
                  draw them — the same FEFO order app.dispense allocates in.
                  Somebody checking this figure against the shelf is holding the
                  boxes, so the batch number and the printed expiry are what
                  make the two comparable. */}
              {isOpen ? (
                <div className="pb-3 pl-4" data-testid={`inventory-batches-${row.drug_name}`}>
                  {batches.length === 0 ? (
                    <p className="text-sm text-ink-2">Reading the batches…</p>
                  ) : (
                    <ul>
                      {/* The same two lines, for the same reason: at 1024 a
                          single row of six columns squeezed the batch number
                          out of existence, and a batch you cannot name is not
                          a batch you can check against the shelf. Nothing
                          wraps mid-figure — "MRP" landing on the line below
                          the number it labels is the one thing a column of
                          prices must not do. */}
                      {batches.map((batch) => (
                        <li
                          key={batch.batch_id}
                          className="border-l-2 border-rule py-1 pl-3 text-sm"
                        >
                          <span className="flex items-baseline gap-3">
                            <span className="tabular min-w-0 flex-1 truncate font-mono">
                              {batch.batch_no}
                            </span>
                            <span className="tabular shrink-0 whitespace-nowrap font-mono">
                              {batch.qty_base_on_hand}
                            </span>
                            <span className="tabular w-24 shrink-0 whitespace-nowrap text-right font-mono">
                              {money(batch.qty_base_on_hand * batch.cost_per_base_unit)}
                            </span>
                          </span>

                          <span className="tabular flex items-baseline gap-3 font-mono text-ink-2">
                            <span className="min-w-0 flex-1 truncate">
                              {asPrinted(batch.expiry)}
                            </span>
                            <span className="shrink-0 whitespace-nowrap">
                              {money(batch.cost_per_base_unit)}/{row.base_unit}
                              {' · MRP '}
                              {money(batch.mrp)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreePane>
  );
}
