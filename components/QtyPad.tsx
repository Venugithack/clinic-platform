'use client';

/**
 * Quantity entry (TABLET.md §4).
 *
 * A custom numpad, laid out large, with the units the pharmacy actually uses
 * beside it — tablets / strips / boxes — converting live and showing the
 * resulting base units under the field. The OS keyboard never appears for a
 * number in this app: on a 10" screen it eats half the display to type "6".
 *
 * Quick chips sit above it for what gets typed most.
 *
 * The pack configuration used here is the DRUG's default, not a batch's. That
 * is correct for prescribing — the doctor is writing an intent, and which batch
 * fills it is decided at dispense by FEFO, against that batch's own pack config
 * (INVENTORY.md §1). The number stored is base units either way.
 */
import { useState } from 'react';
import { Numpad } from './Numpad';
import { decompose, toBaseUnits, type PackBasis, type PackConfig } from '@/lib/units';

export function QtyPad({
  pack,
  baseUnitLabel,
  onCommit,
  onCancel,
}: {
  pack: PackConfig;
  baseUnitLabel: string;
  onCommit: (qtyBase: number) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState('');
  const [basis, setBasis] = useState<PackBasis>('unit');

  const typed = Number(digits || '0');
  const qtyBase = typed > 0 ? toBaseUnits(typed, basis, pack) : 0;
  const parts = decompose(qtyBase, pack);

  const chips: Array<{ label: string; qty: number; basis: PackBasis }> = [
    { label: '10', qty: 10, basis: 'unit' },
    { label: `1 strip`, qty: 1, basis: 'strip' },
    { label: `2 strips`, qty: 2, basis: 'strip' },
    { label: '1 box', qty: 1, basis: 'box' },
  ];

  const units: Array<{ label: string; value: PackBasis }> = [
    { label: baseUnitLabel, value: 'unit' },
    { label: 'strips', value: 'strip' },
    { label: 'boxes', value: 'box' },
  ];

  return (
    <div className="rounded-box border border-rule bg-sheet p-4" data-testid="qtypad">
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => {
              setDigits(String(chip.qty));
              setBasis(chip.basis);
            }}
            className="h-11 rounded-box border border-rule px-4 text-sm active:bg-paper-2"
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <span className="tabular text-4xl font-medium">{digits || '0'}</span>
        <div className="flex gap-2">
          {units.map((unit) => (
            <button
              key={unit.value}
              type="button"
              onClick={() => setBasis(unit.value)}
              className={`h-11 rounded-box border px-3 text-sm ${
                basis === unit.value ? 'border-ink bg-ink text-paper' : 'border-rule'
              }`}
            >
              {unit.label}
            </button>
          ))}
        </div>
      </div>

      {/* The conversion is shown, not assumed. He is prescribing 30 tablets;
          the fact that this is 2 strips is information, not a substitution. */}
      <p className="tabular mt-2 text-sm text-ink-2" data-testid="qty-base">
        {qtyBase} {baseUnitLabel}
        {basis !== 'unit' && qtyBase > 0
          ? ` — ${parts.strips} strip${parts.strips === 1 ? '' : 's'}${
              parts.loose > 0 ? ` + ${parts.loose}` : ''
            }`
          : ''}
      </p>

      <div className="mt-4 w-64">
        <Numpad
          onDigit={(digit) => setDigits((current) => (current + digit).slice(0, 4))}
          onBackspace={() => setDigits((current) => current.slice(0, -1))}
        />
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={() => onCommit(qtyBase)}
          disabled={qtyBase <= 0}
          className="h-14 flex-1 rounded-box border border-ink bg-ink px-4 font-medium text-paper disabled:opacity-40"
        >
          Add to prescription
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-14 rounded-box border border-rule px-5 text-ink-2 active:bg-paper-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
