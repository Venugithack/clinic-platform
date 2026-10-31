'use client'

import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Icon } from './Icon'
import { useLayer } from './layer'

/**
 * A short decision taken on top of the current screen: confirm a dispense,
 * collect a payment, receive a delivery. Anything longer belongs on the page
 * itself, and anything that is merely supporting context belongs in a `Drawer`.
 *
 * The props are unchanged from the version this replaces, because there are 37
 * instances of it across 11 files and a behaviour fix should not be a
 * 37-file edit. What changed is underneath: `useLayer` portals it out of
 * whatever it was written inside, traps focus in it, makes the rest of the
 * document inert, returns focus to whatever opened it, and gives Escape to the
 * top dialog only.
 */
export function Modal({
  open,
  onClose,
  title,
  sub,
  footer,
  children,
  busy = false,
  busyLabel = 'Working…',
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /**
   * The dialog's own surface shows the loading state while what it asked about
   * is in flight. Closing first and showing the busy label on the trigger
   * behind it — which is what this used to do — puts the feedback somewhere
   * the reader is no longer looking.
   */
  busy?: boolean
  busyLabel?: string
  /** For a dialog carrying a table or a multi-column form. */
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const host = useLayer({ open, onClose, panelRef: panel })

  if (!open || !host) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-print="hide">
      <div
        className="absolute inset-0 bg-ink/35"
        onClick={busy ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        // Points at the visible heading rather than repeating it as a string,
        // so the name a screen reader announces and the words on the screen
        // cannot drift apart.
        aria-labelledby={titleId}
        tabIndex={-1}
        data-focus-ring="none"
        className={`jmc-rise relative flex max-h-full w-full flex-col rounded-box border-2 border-ink bg-sheet ${
          wide ? 'max-w-3xl' : 'max-w-xl'
        }`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-rule px-4 py-3">
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
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-sheet/75">
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
