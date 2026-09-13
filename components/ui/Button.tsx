'use client'

import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * Buttons say what happens when they are used, and keep that word through the
 * whole flow: the control that says "Dispense" produces a row that says
 * "Dispensed". No "Submit" anywhere in this app.
 *
 * Adapted from the hospital application. Same four variants; the geometry is
 * the tablet departure — `sm` is 44px and `md` is 48px, because every one of
 * these is pressed with a thumb rather than clicked. There is no smaller size
 * on purpose.
 *
 * The case is the other departure, and it is the plan's. These were 12–13px
 * tracked capitals, which is the reference system's voice; on a clinic tablet
 * it made "CONFIRM AND HAND OVER" a line and a half of shouting and pushed the
 * primary action of the counter below the fold on a 768px screen. Sentence
 * case at the same size reads faster and fits.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  // The plan gives the primary control and a confirmed result the same green,
  // which is deliberate: the button that completes the task and the mark that
  // says it completed are the same idea one moment apart.
  primary: 'border-active bg-active text-sheet hover:bg-active/88',
  secondary: 'border-ink bg-transparent text-ink hover:bg-ink/8',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:text-ink hover:bg-ink/6',
  danger: 'border-stop bg-transparent text-stop hover:bg-stop-wash',
}

const SIZES = {
  sm: 'min-h-[44px] px-3 py-1.5 text-[13px]',
  md: 'min-h-[48px] px-4 py-2 text-[14px]',
} as const

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ref,
  ...rest
}: {
  variant?: Variant
  size?: keyof typeof SIZES
  /** Paired with the label, never replacing it. */
  icon?: IconName
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-box border font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 17 : 19} /> : null}
      {children}
    </button>
  )
}

/**
 * A button that cannot be pressed twice, and that says why when it cannot be
 * pressed at all.
 *
 * Every write in this clinic goes over the network to one database shared by
 * four tablets, so a double tap is a double bill or a double stock movement.
 *
 * ── WHY A REFUSED BUTTON STAYS FOCUSABLE ───────────────────────────────────
 *
 * `disabledReason` used to be delivered as `title`, which is a tooltip: there
 * is no hover on a tablet, and a natively `disabled` button is out of the tab
 * order, so the one explanation of why the counter will not let you hand
 * anything over was unreachable by touch AND by keyboard. It was written for
 * nobody.
 *
 * So a control refused *for a reason* is `aria-disabled` instead — focusable,
 * announced as unavailable, carrying its reason as its description, and
 * ignoring presses. A control that is merely busy keeps the native `disabled`,
 * because there is nothing to read and nothing to explain; it is about to be
 * pressable again.
 */
export function ActionButton({
  busy = false,
  busyLabel = 'Working…',
  disabledReason,
  children,
  disabled,
  onClick,
  icon,
  className = '',
  ...rest
}: {
  busy?: boolean
  /** Shown in place of the label while the request is in flight. */
  busyLabel?: string
  /** Why this control cannot be used, in the clinic's own words. */
  disabledReason?: string
  icon?: IconName
  children: ReactNode
} & Omit<Parameters<typeof Button>[0], 'children' | 'icon'>) {
  const reasonId = useId()
  const refused = Boolean(disabled) && !busy && Boolean(disabledReason)

  return (
    <>
      <Button
        // Busy is a hard stop: nothing to read, and it must not be pressed.
        disabled={busy || (Boolean(disabled) && !refused)}
        aria-disabled={refused || undefined}
        aria-describedby={refused ? reasonId : undefined}
        onClick={refused ? undefined : onClick}
        icon={busy ? undefined : icon}
        // `disabled:opacity-40` in `Button` only fires on the native attribute,
        // so a refused-with-a-reason control has to be dimmed by hand.
        className={`${refused ? 'cursor-not-allowed opacity-40' : ''} ${className}`}
        {...rest}
      >
        {busy ? (
          <>
            <Icon name="ring" size={17} className="jmc-spin" />
            {busyLabel}
          </>
        ) : (
          children
        )}
      </Button>
      {refused ? (
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      ) : null}
    </>
  )
}
