'use client'

import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Icon } from './Icon'
import { useLayer } from './layer'

/**
 * Supporting context, beside the work rather than instead of it.
 *
 * A patient's history, a vitals entry pad, the detail behind a prescription:
 * things the person working needs to see without losing the queue, the
 * consultation or the counter they are standing in. It opens over part of the
 * workspace on a wide tablet and takes the whole screen on a narrow one, which
 * is the plan's rule for where patient context lives when there is no room for
 * a column.
 *
 * The difference from `Modal` is what it is for, not how it behaves: a modal
 * asks a question and will not let go until it is answered, a drawer shows
 * something and closes when it is done being looked at. Both trap focus, both
 * make the rest inert, both give Escape to the top layer.
 */
export function Drawer({
  open,
  onClose,
  title,
  sub,
  footer,
  children,
  busy = false,
  busyLabel = 'Working…',
  width = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: ReactNode
  footer?: ReactNode
  children: ReactNode
  busy?: boolean
  busyLabel?: string
  /** `sm` for a list, `md` for a form, `lg` for a record beside a record. */
  width?: 'sm' | 'md' | 'lg'
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const host = useLayer({ open, onClose, panelRef: panel })

  if (!open || !host) return null

  const size =
    width === 'sm' ? 'sm:max-w-sm' : width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" data-print="hide">
      <div
        className="absolute inset-0 bg-ink/35"
        onClick={busy ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-focus-ring="none"
        // Full width below `sm`, because 400px of drawer on a 390px phone is
        // a drawer with nothing behind it worth preserving.
        className={`relative flex h-full w-full flex-col border-l-2 border-ink bg-sheet ${size}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] leading-snug font-semibold">
              {title}
            </h2>
            {sub ? <div className="mt-1 font-mono text-[14px] text-ink-2">{sub}</div> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy} aria-label="Close">
            Close
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div inert={busy || undefined}>{children}</div>
          {busy ? (
            <div className="absolute inset-0 z-10 flex items-start justify-center bg-sheet/75 pt-16">
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-2.5 text-[14px] font-medium"
              >
                <Icon name="ring" size={20} className="jmc-spin text-ink-2" />
                {busyLabel}
              </p>
            </div>
          ) : null}
        </div>

        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-rule px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    host,
  )
}
