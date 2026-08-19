'use client';

import { useEffect, useRef } from 'react';

/**
 * Work done beside the list you came from — a patient's record opened from the
 * queue, a batch opened from the shelf.
 *
 * The list stays visible on the left, and that is the point: the next patient
 * is always the reason you are looking at this one. On a 1280px landscape
 * tablet there is room for both, which is why this exists at all and why a
 * modal is the rarer choice here.
 *
 * Same `onClose` ref treatment as Modal, for the same keystroke bug.
 */
export function Drawer({
  open,
  onClose,
  title,
  sub,
  footer,
  width = '32rem',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  footer?: React.ReactNode;
  width?: string;
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
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40" data-print="hide">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-focus-ring="none"
        style={{ width }}
        className="flex h-full max-w-full flex-col border-l-2 border-ink bg-sheet"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">{title}</p>
            {sub ? (
              <p className="mt-1 truncate font-mono text-xs text-ink-2">{sub}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-11 shrink-0 rounded-box border border-ink px-3 text-xs font-semibold uppercase tracking-[0.08em] active:opacity-80"
          >
            Close
          </button>
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
