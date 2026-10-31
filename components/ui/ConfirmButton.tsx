'use client'

import { useState, type ReactNode } from 'react'
import { ActionButton, Button } from './Button'
import { Modal } from './Modal'
import type { IconName } from './Icon'

/**
 * An action that cannot be taken back, asked for once in words.
 *
 * Money changing hands, stock leaving the shelf, a WhatsApp message going to a
 * supplier and a staff account losing access are all one tap from a thumb on a
 * tablet lying on a counter — so each one states what is about to happen and
 * waits. Never `window.confirm`: a browser dialog is the wrong voice, cannot be
 * styled, and blocks the page.
 *
 * This is the plan's "review when needed" step, and the review is where the
 * loading state now lives. It used to close the dialog and then await, which
 * put "Handing over…" on a button behind a box that had just vanished, while
 * the reader was still looking at where the box had been. The dialog now stays
 * up, shows the operation on its own surface, and closes when the clinic has
 * actually answered.
 */
export function ConfirmButton({
  onConfirm,
  title,
  question,
  confirmLabel,
  confirmVariant = 'primary',
  busy = false,
  busyLabel = 'Working…',
  disabled,
  disabledReason,
  icon,
  children,
  ...rest
}: {
  onConfirm: () => void | Promise<unknown>
  /** Names the decision, e.g. "Dispense prescription". */
  title: string
  /** What will happen, in one or two sentences. */
  question: ReactNode
  /** The word on the button that commits. Matches the action, never "OK". */
  confirmLabel: string
  confirmVariant?: 'primary' | 'danger'
  busy?: boolean
  busyLabel?: string
  disabled?: boolean
  disabledReason?: string
  icon?: IconName
  children: ReactNode
} & Omit<Parameters<typeof Button>[0], 'children' | 'onClick' | 'disabled' | 'icon'>) {
  const [open, setOpen] = useState(false)
  // The dialog's own view of the request. `busy` from the caller drives the
  // trigger; this drives the dialog, and the two are the same request seen
  // from either side of it.
  const [committing, setCommitting] = useState(false)

  async function commit() {
    if (committing) return
    setCommitting(true)
    try {
      await onConfirm()
    } finally {
      setCommitting(false)
      setOpen(false)
    }
  }

  return (
    <>
      <ActionButton
        busy={busy}
        busyLabel={busyLabel}
        disabled={disabled}
        disabledReason={disabledReason}
        icon={icon}
        onClick={() => setOpen(true)}
        {...rest}
      >
        {children}
      </ActionButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        busy={committing}
        busyLabel={busyLabel}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={committing}>
              Cancel
            </Button>
            <ActionButton
              variant={confirmVariant}
              busy={committing}
              busyLabel={busyLabel}
              onClick={() => void commit()}
            >
              {confirmLabel}
            </ActionButton>
          </>
        }
      >
        <div className="text-[15px] leading-relaxed">{question}</div>
      </Modal>
    </>
  )
}
