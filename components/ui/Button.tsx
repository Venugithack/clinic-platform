/**
 * Four variants. The label names the outcome, and keeps the word through the
 * flow — a button that says "Dispense" leaves a row that reads "Dispensed",
 * never "Submit" leaving "Success".
 *
 * Sizing is the clinic's, not the brief's. TABLET.md §2 rule 2: 44px minimum
 * for anything tappable, 56px for anything primary or destructive, because a
 * 32px target is fine with a mouse and a genuine hazard for a pharmacist's
 * finger sitting next to "cancel prescription". `primary` and `danger`
 * therefore default to the larger size rather than offering it as an option.
 * eslint tablet/min-touch-target fails the build if this slips.
 *
 * There is no hover state. There is no cursor (TABLET.md §2 rule 1); the
 * feedback is `active:`, which a finger does trigger.
 */
/*
 * Note the disabled treatment on `primary`: it loses the fill rather than
 * merely fading it.
 *
 * A 40%-opacity ink fill is still a solid slab, and in the action rail it
 * outweighed the enabled outline buttons beside it — the heaviest thing on the
 * screen was the one action you could not take, which is exactly backwards.
 * Dropping to an outline puts a disabled primary below an enabled secondary in
 * the visual order, where it belongs.
 */
const VARIANTS = {
  primary:
    'border-ink bg-ink text-paper disabled:border-rule disabled:bg-transparent disabled:text-ink-3',
  default: 'border-ink bg-transparent text-ink disabled:opacity-40',
  ghost: 'border-transparent bg-transparent text-ink-2 disabled:opacity-40',
  danger: 'border-stop bg-transparent text-stop disabled:opacity-40',
} as const;

export function Button({
  variant = 'default',
  size,
  className = '',
  type = 'button',
  children,
  ...rest
}: {
  variant?: keyof typeof VARIANTS;
  size?: 'md' | 'lg';
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // Primary and destructive are 56px unless a caller insists otherwise.
  const resolved = size ?? (variant === 'primary' || variant === 'danger' ? 'lg' : 'md');
  const height = resolved === 'lg' ? 'h-14' : 'h-11';

  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-box border px-4 text-xs font-semibold uppercase tracking-[0.08em] active:opacity-80 ${height} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
