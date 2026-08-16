'use client';

/**
 * Drug search — the interaction that matters most (TABLET.md §4).
 *
 * Used in the prescription composer and at the counter, dozens of times a day.
 * The rules it follows, and why each one is not a preference:
 *
 *   full-screen overlay      a dropdown under a field on a 10" screen is a
 *                            list you cannot read
 *   results in the top half  the OS keyboard covers the bottom half, which is
 *                            exactly where the list would otherwise be
 *   3 characters is enough   he is typing between patients
 *   stock badge inline       he stops prescribing what is not on his shelf
 *   frequent drugs first     the top 40 are most of the prescriptions, so most
 *                            searches become one tap with nothing typed
 *
 * There is deliberately no camera button yet: barcode scanning is M3
 * (INVENTORY.md §2), and a control that does nothing teaches people to distrust
 * the ones that do.
 */
import { useEffect, useRef, useState } from 'react';
import {
  frequentDrugs,
  MIN_SEARCH_LENGTH,
  searchDrugs,
  stockBadge,
  type DrugRow,
} from '@/lib/db/drugs';

export function DrugSearch({
  onPick,
  onClose,
}: {
  onPick: (drug: DrugRow) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DrugRow[]>([]);
  const [frequent, setFrequent] = useState<DrugRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void frequentDrugs().then(setFrequent).catch(() => setFrequent([]));
  }, []);

  useEffect(() => {
    if (query.trim().length < MIN_SEARCH_LENGTH) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void searchDrugs(query)
      .then((rows) => {
        if (!cancelled) {
          setResults(rows);
          setError(null);
        }
      })
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const typing = query.trim().length >= MIN_SEARCH_LENGTH;
  const shown = typing ? results : frequent;

  return (
    <div className="fixed inset-0 z-50 bg-surface" role="dialog" aria-label="Find a medicine">
      {/* Everything lives in the top half. The keyboard owns the bottom. */}
      <div className="flex h-[50vh] flex-col border-b border-line">
        <div className="flex items-center gap-3 p-4">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Brand, generic or salt"
            aria-label="Search medicines"
            className="h-14 flex-1 rounded-xl border border-line bg-white px-4 text-lg"
          />
          <button
            type="button"
            onClick={onClose}
            className="h-14 rounded-xl border border-line bg-white px-5 text-muted active:bg-line"
          >
            Cancel
          </button>
        </div>

        <p className="px-4 pb-2 text-sm text-muted">
          {typing
            ? `${shown.length} match${shown.length === 1 ? '' : 'es'}`
            : frequent.length > 0
              ? 'Most prescribed'
              : 'Type at least three characters'}
        </p>

        <ul className="flex-1 overflow-y-auto px-4 pb-4">
          {error ? <li className="py-3 text-danger">{error}</li> : null}

          {shown.map((drug) => {
            const badge = stockBadge(drug);
            return (
              <li key={drug.id}>
                <button
                  type="button"
                  onClick={() => onPick(drug)}
                  className="h-16 w-full border-b border-line px-2 text-left active:bg-line"
                >
                  <span className="flex items-baseline justify-between gap-4">
                    <span className="truncate text-lg">
                      {drug.name}
                      <span className="ml-2 text-sm text-muted">{drug.strength}</span>
                      {drug.schedule === 'H1' ? (
                        <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-xs text-danger">
                          H1
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`tabular shrink-0 text-sm ${badge.out ? 'text-danger' : 'text-ok'}`}
                    >
                      {badge.label}
                    </span>
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {drug.salt_composition}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
