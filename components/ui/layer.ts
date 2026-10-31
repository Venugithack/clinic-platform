'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * What it takes for something on top to actually be on top.
 *
 * The application had a `Modal` that moved focus once and closed on Escape,
 * and nothing else. Everything behind it stayed in the tab order, so a keyboard
 * user could Tab out of a dispense confirmation into the counter behind it and
 * press a control the dialog was still asking about. It was also not portalled,
 * so one instance rendered inside a `<td>` inside a horizontally scrolling
 * table wrapper, where a `position: fixed` box is clipped by its ancestor.
 *
 * This is that machinery, in one place, because there are 37 dialog instances
 * across 11 files and they must all behave the same:
 *
 *   - a portal, so no ancestor's `transform`, `filter` or `overflow` can clip
 *     or reposition a layer;
 *   - a focus trap that wraps in both directions;
 *   - the rest of the document made `inert`, so nothing behind it is
 *     clickable, focusable, or readable by a screen reader;
 *   - focus returned to whatever opened it;
 *   - Escape closing the TOP layer only. There is a real nested case — the
 *     discharge confirmation inside the observation form — and before this
 *     both listened on `document`, so one Escape closed both and threw away a
 *     typed outcome note;
 *   - the body's scroll frozen while a layer is open, so a dialog on a tablet
 *     does not scroll the queue behind it under the reader's thumb.
 */

type Layer = { close: () => void }

/** Open layers, oldest first. The last one owns Escape. */
const stack: Layer[] = []

let scrollLocks = 0
let restoreOverflow = ''

function lockScroll() {
  if (scrollLocks === 0) {
    restoreOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
}

function releaseScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1)
  if (scrollLocks === 0) document.body.style.overflow = restoreOverflow
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.hasAttribute('inert')) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    // `offsetParent` is null for `display:none` and anything inside it, and
    // also for `position: fixed`, hence the rect fallback.
    return element.offsetParent !== null || element.getBoundingClientRect().width > 0
  })
}

/**
 * Mounts one layer: a container portalled to `<body>`, with everything already
 * there made inert for as long as it is open.
 *
 * Returns the element to render into, or `null` on the first render before it
 * exists.
 */
export function useLayer({
  open,
  onClose,
  panelRef,
  trapFocus = true,
}: {
  open: boolean
  onClose: () => void
  /** The panel that holds focus. Focus moves into it and cannot leave it. */
  panelRef: RefObject<HTMLElement | null>
  /**
   * A popover anchored to its control is dismissed by moving away from it
   * rather than held captive, so it takes the portal and the Escape ordering
   * without the trap.
   */
  trapFocus?: boolean
}): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)

  // The latest `onClose` without making the effect depend on it. Every call
  // site passes an inline arrow, which is a new identity on every render; with
  // it in the dependency array the effect tears down and rebuilds on every
  // keystroke, and its focus move pulls the caret out of the field being typed
  // into — one letter per press, in a form asking for a batch number.
  const latestClose = useRef(onClose)
  latestClose.current = onClose

  useEffect(() => {
    if (!open) {
      setHost(null)
      return
    }

    const container = document.createElement('div')
    container.setAttribute('data-jmc-layer', '')
    document.body.appendChild(container)
    setHost(container)

    // Everything already in the document — which for a nested layer includes
    // the layer below it. Each is restored to what it was, because something
    // may legitimately have been inert before this opened.
    const madeInert: Array<{ element: HTMLElement; was: boolean }> = []
    for (const child of [...document.body.children]) {
      if (child === container) continue
      if (!(child instanceof HTMLElement)) continue
      madeInert.push({ element: child, was: child.inert })
      child.inert = true
    }

    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const entry: Layer = { close: () => latestClose.current() }
    stack.push(entry)
    lockScroll()

    const onKey = (event: KeyboardEvent) => {
      // Only the top layer answers, so one Escape closes one thing.
      if (stack[stack.length - 1] !== entry) return

      if (event.key === 'Escape') {
        event.stopPropagation()
        entry.close()
        return
      }

      if (!trapFocus || event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const targets = focusableWithin(panel)
      if (targets.length === 0) {
        // Nothing to move to. Hold focus on the panel rather than letting it
        // escape into the inert document behind.
        event.preventDefault()
        panel.focus()
        return
      }
      const first = targets[0]
      const last = targets[targets.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // Capture phase, so the trap sees Tab before anything in the panel does.
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('keydown', onKey, true)
      const at = stack.indexOf(entry)
      if (at !== -1) stack.splice(at, 1)
      releaseScroll()
      for (const { element, was } of madeInert) element.inert = was
      container.remove()
      setHost(null)
      // Back to whatever opened this. A dialog that leaves focus on <body>
      // sends the next Tab to the top of the page.
      if (trigger && document.contains(trigger)) trigger.focus()
    }
    // `panelRef` and `trapFocus` are stable for the life of a call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /*
   * Move focus in — and only once the panel is actually there.
   *
   * This is a second effect rather than four lines at the end of the first,
   * and the reason is the portal. The effect above CREATES the container and
   * puts it in state; the dialog's children are rendered into it on the render
   * that state change causes, which is after that effect has finished. So at
   * the point the first effect runs, `panelRef.current` is still null and
   * focusing it is a no-op — the window opens and focus stays on the counter
   * behind it, where Tab then walks along the row of medicines instead of
   * through the decision being asked for.
   *
   * Depending on `host` is what makes this run on the render where the portal
   * has mounted.
   */
  useEffect(() => {
    if (!open || !host) return
    const panel = panelRef.current
    if (!panel) return
    const targets = trapFocus ? focusableWithin(panel) : []
    // The first thing worth filling in, else the panel itself so that the
    // trap has something to hold on to.
    ;(targets[0] ?? panel).focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host])

  return host
}

/**
 * Moves focus into a panel once it has rendered.
 *
 * `useLayer` focuses on mount, but a panel whose content arrives a render later
 * — a drawer that loads a patient's history, say — has nothing to focus yet.
 */
export function focusFirstIn(panel: HTMLElement | null): void {
  if (!panel) return
  const targets = focusableWithin(panel)
  ;(targets[0] ?? panel).focus()
}
