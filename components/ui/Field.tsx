import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

/**
 * A field on a case sheet: a printed label above a ruled blank you write on.
 * Hence no boxed inputs anywhere — a baseline rule and a faint sheet ground.
 *
 * `Field` renders a real `<label>` wrapping its control, so every input in
 * this application is labelled by construction rather than by remembering to
 * pair an id. Tapping the label puts the caret in the blank, which on a tablet
 * roughly doubles the target of a short field.
 *
 * Required is marked rather than optional: most clinical fields may be left
 * empty, so marking the rare mandatory one keeps the common case quiet.
 */

const CONTROL =
  'blank w-full min-h-[44px] px-2.5 py-2 text-[15px] text-ink placeholder:text-ink-3 outline-none focus:border-active disabled:cursor-not-allowed disabled:opacity-50'

export function Field({
  label,
  hint,
  required = false,
  unit,
  className = '',
  children,
}: {
  label: string
  /** One line of direction. Not a second label — it explains, never repeats. */
  hint?: string
  required?: boolean
  /** mmHg, °C, mg, ₹ — printed beside the blank, not typed into it. */
  unit?: string
  className?: string
  children: ReactNode
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="eyebrow flex items-baseline gap-1.5">
        <span>{label}</span>
        {required ? (
          <span className="text-stop normal-case tracking-normal">required</span>
        ) : null}
      </span>
      <span className="mt-1 flex items-baseline gap-2">
        <span className="min-w-0 flex-1">{children}</span>
        {unit ? <span className="shrink-0 font-mono text-[12px] text-ink-2">{unit}</span> : null}
      </span>
      {hint ? <span className="mt-1 block text-[12px] leading-snug text-ink-2">{hint}</span> : null}
    </label>
  )
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  // Values typed into a blank are transcription-critical — set them in mono.
  const mono =
    rest.type === 'number' ||
    rest.type === 'date' ||
    rest.type === 'datetime-local' ||
    rest.type === 'tel' ||
    rest.inputMode === 'numeric' ||
    rest.inputMode === 'decimal'
      ? 'font-mono'
      : ''
  return <input className={`${CONTROL} ${mono} ${className}`} {...rest} />
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${CONTROL} ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function Textarea({
  className = '',
  rows = 3,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={`${CONTROL} resize-y ${className}`} {...rest} />
}

/**
 * A checkbox and its sentence, as one 48px target.
 *
 * The base layer already floors the box itself at 22px; this makes the whole
 * row tappable so nobody has to hit the box.
 */
export function CheckRow({
  label,
  hint,
  className = '',
  ...rest
}: { label: ReactNode; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label
      className={`flex min-h-[48px] cursor-pointer items-center gap-3 rounded-box border border-rule bg-sheet px-3 py-2 text-[14px] transition-colors hover:bg-paper/60 has-[input:checked]:border-ink has-[input:checked]:bg-active-wash ${className}`}
    >
      <input type="checkbox" {...rest} />
      <span className="min-w-0">
        <span className="block leading-tight">{label}</span>
        {hint ? <span className="mt-0.5 block text-[12px] text-ink-2">{hint}</span> : null}
      </span>
    </label>
  )
}

/**
 * A row of fields. Two columns on a tablet in portrait, four where the content
 * is short enough to take it, one on a phone.
 */
export function FieldRow({
  cols = 2,
  className = '',
  children,
}: {
  cols?: 2 | 3 | 4
  className?: string
  children: ReactNode
}) {
  const grid =
    cols === 4
      ? 'sm:grid-cols-2 xl:grid-cols-4'
      : cols === 3
        ? 'sm:grid-cols-2 lg:grid-cols-3'
        : 'sm:grid-cols-2'
  return <div className={`grid grid-cols-1 gap-4 ${grid} ${className}`}>{children}</div>
}
