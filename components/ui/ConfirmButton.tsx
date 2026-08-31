'use client'

import { useState, type ReactNode } from 'react'
import { ActionButton, Button } from './Button'
import { Modal } from './Modal'

/**
 * An action that cannot be taken back, asked for once in words.
 *
 * Money changing hands, stock leaving the shelf, a WhatsApp message going to a
 * supplier and a staff account losing access are all one tap from a thumb on a
 * tablet lying on a counter — so each one states what is about to happen and
 * waits. Never `window.confirm`: a browser dialog is the wrong voice, cannot
 * be styled, and blocks the page.
 */
export function ConfirmButton({
  onConfirm,
  title,
  question,
  confirmLabel,
  confirmVariant = 'primary',
  busy = false,
  busyLabel,
  disabled,
  disabledReason,
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
  children: ReactNode
} & Omit<Parameters<typeof Button>[0], 'children' | 'onClick' | 'disabled'>) {
  const [open, setOpen] = useState(false)

  async function commit() {
    setOpen(false)
    await onConfirm()
  }

  return (
    <>
      <ActionButton
        busy={busy}
        busyLabel={busyLabel}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => setOpen(true)}
        {...rest}
      >
        {children}
      </ActionButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={confirmVariant} onClick={commit}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="text-[14px] leading-relaxed">{question}</div>
      </Modal>
    </>
  )
}
