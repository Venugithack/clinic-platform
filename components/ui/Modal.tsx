'use client';

import { useEffect, useRef } from 'react';

/**
 * A short decision taken on top of the current screen — confirm a dispense,
 * void a bill. The list behind it does not matter for the next ten seconds.
 *
 * ONE HARD RULE, from TABLET.md §3: these never stack. A modal over a modal on
 * a tablet is a dead end — there is no corner to tap out to and no keyboard to
 * escape with. Anything that needs a second decision is a Drawer or a page.
 *
 * `onClose` is held in a ref rather than listed in the effect's dependencies,
 * and that is not a style preference. Every call site passes an inline arrow,
 * which is a new function identity on every render. With `onClose` in the deps
 * the effect re-ran on every keystroke, and its `panel.focus()` pulled the
 * caret out of the input — one letter per tap, in a form asking for a patient's
 * name. Depending on `open` alone moves focus exactly once, when it opens.
 */
export function Modal({
  open,
  onClose,
  title,
  sub,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latestClose.current();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
      data-print="hide"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-focus-ring="none"
        className="flex max-h-full w-full max-w-lg flex-col rounded-box border-2 border-ink bg-sheet"
      >
        <div className="border-b-2 border-ink px-4 py-3">
          <p className="eyebrow">{title}</p>
          {sub ? <p className="mt-1 font-mono text-xs text-ink-2">{sub}</p> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
