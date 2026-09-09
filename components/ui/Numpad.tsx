'use client'

/**
 * The on-screen number pad.
 *
 * The device keyboard never appears for a number in this app. On a 10" tablet
 * it eats half the display to type one digit, and it covers exactly the field
 * being filled in. Keys are 56px because this is tapped by somebody in a hurry
 * with a patient in front of them.
 */

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export function Numpad({
  onDigit,
  onBackspace,
  disabled = false,
}: {
  onDigit: (digit: string) => void
  onBackspace: () => void
  disabled?: boolean
}) {
  const key =
    'tabular h-14 rounded-box border border-rule bg-sheet text-2xl font-medium text-ink active:bg-paper-2 disabled:opacity-40'

  return (
    <div className="grid grid-cols-3 gap-3" role="group" aria-label="Number pad">
      {KEYS.map((digit) => (
        <button key={digit} type="button" disabled={disabled} onClick={() => onDigit(digit)} className={key}>
          {digit}
        </button>
      ))}

      <div aria-hidden="true" />

      <button type="button" disabled={disabled} onClick={() => onDigit('0')} className={key}>
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
  )
}
