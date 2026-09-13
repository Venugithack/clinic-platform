'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLayer } from './layer'

/**
 * A compact set of options, anchored to the control that opened it.
 *
 * Theme choice, a filter, a short menu. It is deliberately the smallest of the
 * four layers: it holds options, never a form and never a record. Anything
 * with a text field in it is a `Modal`; anything with a patient in it is a
 * `Drawer`.
 *
 * It is portalled and positioned from the trigger's own rectangle rather than
 * positioned absolutely inside it, because the two places this is most wanted —
 * the shell header and a table's filter row — both sit inside ancestors that
 * clip or scroll.
 */
export function Popover({
  trigger,
  title,
  children,
  align = 'end',
}: {
  /** Renders the button. `open` lets it show its own pressed state. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>
    onClick: () => void
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
  }) => ReactNode
  /** Names the group for a screen reader. Shown as a small heading. */
  title: string
  children: ReactNode | ((close: () => void) => ReactNode)
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number; right: number } | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const host = useLayer({ open, onClose: () => setOpen(false), panelRef: panel })

  // Measured from the trigger, and re-measured whenever the page moves under
  // it. A popover that stays where the button used to be is worse than one
  // that never opened.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const box = anchor.current?.getBoundingClientRect()
      if (!box) return
      setAt({ top: box.bottom + 6, left: box.left, right: window.innerWidth - box.right })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((was) => !was),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      })}
      {open && host && at
        ? createPortal(
            <div className="fixed inset-0 z-50" data-print="hide">
              <div className="absolute inset-0" onClick={() => setOpen(false)} aria-hidden="true" />
              <div
                ref={panel}
                role="menu"
                aria-labelledby={titleId}
                tabIndex={-1}
                data-focus-ring="none"
                style={{
                  top: at.top,
                  ...(align === 'end' ? { right: at.right } : { left: at.left }),
                }}
                // `max-w` and the viewport clamp keep it on a 320px screen even
                // when the trigger is hard against the right edge.
                className="jmc-rise absolute max-h-[70vh] w-[min(17rem,calc(100vw-1.5rem))] overflow-y-auto rounded-box border-2 border-ink bg-sheet py-1.5"
              >
                <p id={titleId} className="eyebrow px-3 pt-1 pb-1.5">
                  {title}
                </p>
                {typeof children === 'function' ? children(() => setOpen(false)) : children}
              </div>
            </div>,
            host,
          )
        : null}
    </>
  )
}
