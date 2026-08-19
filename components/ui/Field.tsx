/**
 * The case-sheet blank: a printed label above a ruled line you write on. No
 * boxed inputs anywhere in the clinic — a box is a form control, a rule is a
 * place to write, and the whole system is built on the second reading.
 *
 * Clinical fields are optional by default, so this marks what is REQUIRED
 * rather than what is optional: the rare case is loud, the common case is
 * silent. Inverting that would put "(optional)" beside forty fields on the
 * consult screen and teach everyone to stop reading it.
 *
 * The label wraps its control rather than pairing by id. That keeps the
 * primitive a server component — no useId, no 'use client' — and it is also
 * what `getByLabel` in the e2e suite resolves against, so the association is
 * exercised on every test run rather than assumed.
 *
 * Units are printed beside the blank, never typed into it. Hints explain; they
 * never repeat the label.
 */
export function Field({
  label,
  hint,
  required = false,
  unit,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  unit?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="eyebrow">
        {label}
        {required ? (
          <span className="ml-1 text-[0.625rem] font-semibold normal-case tracking-normal text-stop">
            required
          </span>
        ) : null}
      </span>

      {unit ? (
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1">{children}</span>
          <span className="shrink-0 font-mono text-[0.6875rem] text-ink-2">
            {unit}
          </span>
        </span>
      ) : (
        children
      )}

      {hint ? <span className="text-xs text-ink-2">{hint}</span> : null}
    </label>
  );
}

/**
 * Anything numeric goes mono without the caller remembering to ask: a quantity,
 * a price and a batch number are all read digit by digit and compared with the
 * line above.
 */
function monoIfNumeric(
  type: string | undefined,
  inputMode: string | undefined,
  className: string,
) {
  const numeric = type === 'number' || inputMode === 'numeric' || inputMode === 'decimal';
  return `${numeric ? 'font-mono' : ''} ${className}`;
}

export function Input({
  className = '',
  type,
  inputMode,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      inputMode={inputMode}
      className={`blank h-11 px-2 text-base ${monoIfNumeric(type, inputMode, className)}`}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`blank h-11 px-2 text-base ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className = '',
  rows = 3,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      className={`blank px-2 py-2 text-base ${className}`}
      {...rest}
    />
  );
}
