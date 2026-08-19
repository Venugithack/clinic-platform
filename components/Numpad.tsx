'use client';

/**
 * The custom on-screen numpad. TABLET.md §2 rule 3, §4.
 *
 * The OS keyboard never appears for a number in this app. On a 10" screen it
 * eats half the display to type "6", and it covers exactly the list or the
 * field being worked on. This is used for the PIN, for quantity entry at the
 * counter, and for anything else numeric.
 *
 * Keys are 56px — the destructive-or-primary size — because this is a control
 * used hundreds of times a day by someone in a hurry.
 */

interface NumpadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  disabled?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function Numpad({ onDigit, onBackspace, disabled = false }: NumpadProps) {
  return (
    <div className="grid grid-cols-3 gap-3" role="group" aria-label="Number pad">
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onDigit(key)}
          className="tabular h-14 rounded-box border border-rule bg-sheet text-2xl font-medium text-ink active:bg-paper-2 disabled:opacity-40"
        >
          {key}
        </button>
      ))}

      <div aria-hidden="true" />

      <button
        type="button"
        disabled={disabled}
        onClick={() => onDigit('0')}
        className="tabular h-14 rounded-box border border-rule bg-sheet text-2xl font-medium text-ink active:bg-paper-2 disabled:opacity-40"
      >
        0
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={onBackspace}
        aria-label="Delete"
        className="h-14 rounded-box border border-rule bg-sheet text-xl text-ink-2 active:bg-paper-2 disabled:opacity-40"
      >
        ←
      </button>
    </div>
  );
}
