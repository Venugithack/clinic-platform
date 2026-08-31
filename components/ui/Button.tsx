import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Buttons say what happens when they are used, and keep that word through the
 * whole flow: the control that says "Dispense" produces a row that says
 * "Dispensed". No "Submit" anywhere in this app.
 *
 * Adapted from the hospital application. Same four variants and the same
 * tracked caps; the geometry is the tablet departure — `sm` is 44px and `md`
 * is 48px, because every one of these is pressed with a thumb rather than
 * clicked. There is no smaller size on purpose.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'border-ink bg-ink text-paper hover:bg-ink/85',
  secondary: 'border-ink bg-transparent text-ink hover:bg-ink/8',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:text-ink hover:bg-ink/6',
  danger: 'border-stop bg-transparent text-stop hover:bg-stop-wash',
}

const SIZES = {
  sm: 'min-h-[44px] px-3 py-1.5 text-[12px]',
  md: 'min-h-[48px] px-4 py-2 text-[13px]',
} as const

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  className = '',
  ...rest
}: {
  variant?: Variant
  size?: keyof typeof SIZES
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-box border font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * A button that cannot be pressed twice.
 *
 * Every write in this clinic goes over the network to one SQLite file shared
 * by four tablets, so a double tap is a double bill or a double stock
 * movement. `busy` disables and relabels in one place rather than at each of
 * the forty call sites.
 */
export function ActionButton({
  busy = false,
  busyLabel = 'Working…',
  disabledReason,
  children,
  disabled,
  ...rest
}: {
  busy?: boolean
  /** Shown in place of the label while the request is in flight. */
  busyLabel?: string
  /**
   * Why this control cannot be used. Rendered as the title so a disabled
   * button always explains itself instead of silently refusing.
   */
  disabledReason?: string
  children: ReactNode
} & Omit<Parameters<typeof Button>[0], 'children'>) {
  const off = busy || disabled
  return (
    <Button
      disabled={off}
      title={disabled && disabledReason ? disabledReason : rest.title}
      aria-disabled={off || undefined}
      {...rest}
    >
      {busy ? busyLabel : children}
    </Button>
  )
}
