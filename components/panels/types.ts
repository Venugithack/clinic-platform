import type { ReactNode } from 'react';

/**
 * What every panel takes from the desk it is mounted on.
 *
 * `chrome` is the tab strips — see components/WorkspaceTabs. It is handed down
 * rather than rendered by the desk around the panel because ThreePane owns the
 * region between the top bar and the scrolling work area, and the strips have
 * to sit inside that, above the scroll, where they cannot be scrolled away.
 *
 * Optional, so a panel still renders correctly when something mounts it on its
 * own — the print routes and the E2E suite both do.
 */
export interface PanelProps {
  chrome?: ReactNode;
}
