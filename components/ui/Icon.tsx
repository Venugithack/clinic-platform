import type { ReactNode, SVGProps } from 'react'

/**
 * One icon family, drawn here.
 *
 * The plan asks for "one consistent icon family with similar stroke weight and
 * optical size". The obvious way to get that is a package, and this project has
 * three runtime dependencies — next, react, react-dom — on a clinic whose
 * hosting has to stay free and whose tablets are on clinic Wi-Fi. A thousand
 * icons downloaded to use thirty is the wrong trade, so the thirty are drawn
 * here on one 24×24 grid at one stroke weight, and the bundle carries only the
 * ones a screen actually uses.
 *
 * The rules that make them a family:
 *   - 24×24 box, geometry between 3 and 21, so every glyph has the same optical
 *     weight at the same rendered size.
 *   - Stroke only: `currentColor`, 1.75px, round caps and joins. No fills, so an
 *     icon inherits the meaning of the text beside it rather than carrying
 *     colour of its own.
 *   - `aria-hidden` by default. Section 7 of the plan is explicit — an icon is
 *     never the only source of meaning, so each of these sits beside a word and
 *     stays invisible to a screen reader. Passing `title` is the deliberate
 *     exception and makes the glyph an `img` with a name.
 */

export type IconName =
  // Outcome and state
  | 'check'
  | 'check-circle'
  | 'clock'
  | 'alert'
  | 'alert-circle'
  | 'close'
  | 'x-circle'
  | 'question-circle'
  | 'info'
  | 'ring'
  // Doctor
  | 'stethoscope'
  | 'queue'
  | 'prescription'
  | 'draft'
  | 'printer'
  // Nurse
  | 'pulse'
  | 'thermometer'
  | 'bed'
  | 'skip'
  // Pharmacy
  | 'counter'
  | 'pack'
  | 'bag'
  | 'rupee'
  | 'receipt'
  | 'boxes'
  | 'truck'
  | 'tag'
  | 'clipboard'
  | 'lock'
  // People and admin
  | 'user'
  | 'users'
  | 'calendar'
  | 'overview'
  | 'settings'
  | 'shield'
  | 'history'
  // Structure
  | 'search'
  | 'plus'
  | 'arrow-right'
  | 'arrow-left'
  | 'chevron-down'
  | 'chevron-right'
  | 'menu'
  | 'more'
  | 'signal'
  | 'signal-off'

/**
 * Each entry is the inside of one `<svg>`, written as JSX rather than a path
 * string so a mistake is a compile error and not a blank square.
 */
const GLYPHS: Record<IconName, ReactNode> = {
  check: <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M8 12.4 10.9 15.3 16.2 9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 6.75V12.4l3.5 2.1" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 19.3H3Z" />
      <path d="M12 10v4" />
      <path d="M12 17.1h.01" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.5v5.2" />
      <path d="M12 16.3h.01" />
    </>
  ),
  close: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M9.2 9.2 14.8 14.8M14.8 9.2 9.2 14.8" />
    </>
  ),
  'question-circle': (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M9.4 9.4a2.7 2.7 0 1 1 3.4 3.3c-.6.2-.9.7-.9 1.3v.5" />
      <path d="M12 17.3h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11.2v5" />
      <path d="M12 7.9h.01" />
    </>
  ),
  // An open ring. The working state spins it; reduced motion leaves it still,
  // and the word beside it is doing the explaining either way.
  ring: <path d="M12 3.25a8.75 8.75 0 1 0 8.75 8.75" />,

  stethoscope: (
    <>
      <path d="M5 3v5.5a4.5 4.5 0 0 0 9 0V3" />
      <path d="M3.4 3h3.2M12.4 3h3.2" />
      <path d="M9.5 13v2a4.6 4.6 0 0 0 9.2 0v-1.4" />
      <circle cx="18.7" cy="10.4" r="2.1" />
    </>
  ),
  queue: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4 6.5h1.4M4 12h1.4M4 17.5h1.4" />
    </>
  ),
  prescription: (
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v4h4" />
      <path d="M9 12.5h6M9 16.5h4" />
    </>
  ),
  draft: (
    <>
      <path d="M6 3h8l4 4v5.5" />
      <path d="M14 3v4h4" />
      <path d="M6 3v18h5.5" />
      <path d="M19.3 13.9a1.55 1.55 0 0 1 2.2 2.2L16.4 21.2H14v-2.4Z" />
    </>
  ),
  printer: (
    <>
      <path d="M7 8.5V3h10v5.5" />
      <path d="M7 17.5H4.5A1.5 1.5 0 0 1 3 16v-4.5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3V16a1.5 1.5 0 0 1-1.5 1.5H17" />
      <path d="M7 14h10v7H7Z" />
    </>
  ),

  pulse: <path d="M3 12h3.6l2.6-7.2 4.2 14.4 2.6-7.2H21" />,
  thermometer: (
    <>
      <path d="M14 13.6V5.2a2 2 0 1 0-4 0v8.4a4.4 4.4 0 1 0 4 0Z" />
      <path d="M12 9.2v6.2" />
    </>
  ),
  bed: (
    <>
      <path d="M3 19.5V8.5" />
      <path d="M3 13.8h18v5.7" />
      <path d="M21 13.8a3.4 3.4 0 0 0-3.4-3.4H10.6v3.4" />
      <circle cx="6.6" cy="10.6" r="2.1" />
    </>
  ),
  skip: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M6.2 17.8 17.8 6.2" />
    </>
  ),

  counter: (
    <>
      <path d="M4 9.2h16V20H4Z" />
      <path d="M3 9.2 4.6 4.5h14.8L21 9.2" />
      <path d="M9.3 20v-6h5.4v6" />
    </>
  ),
  pack: (
    <>
      <path d="M4 6.5h16v11H4Z" />
      <path d="M4 12h16" />
      <path d="M9.3 6.5v11M14.7 6.5v11" />
    </>
  ),
  bag: (
    <>
      <path d="M4.8 7.8h14.4L18 20.5H6Z" />
      <path d="M9 7.8V6a3 3 0 0 1 6 0v1.8" />
    </>
  ),
  rupee: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M9 7.8h6M9 10.9h6" />
      <path d="M13.4 7.8c0 3.1-1.9 3.1-4.4 3.1l5.2 5.3" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4Z" />
      <path d="M9.4 8h5.2M9.4 12h5.2" />
    </>
  ),
  boxes: (
    <>
      <path d="M8 3h8v7.5H8Z" />
      <path d="M3 13.5h8V21H3Z" />
      <path d="M13 13.5h8V21h-8Z" />
    </>
  ),
  truck: (
    <>
      <path d="M3 6.5h10.5V16H3Z" />
      <path d="M13.5 9.8h3.8L21 13v3h-7.5Z" />
      <circle cx="7.2" cy="18.3" r="1.9" />
      <circle cx="17" cy="18.3" r="1.9" />
    </>
  ),
  tag: (
    <>
      <path d="M11.4 3.4H20v8.6l-8.7 8.7a1.6 1.6 0 0 1-2.3 0l-6.3-6.3a1.6 1.6 0 0 1 0-2.3Z" />
      <path d="M16.3 7.7h.01" />
    </>
  ),
  clipboard: (
    <>
      <path d="M9 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15" />
      <path d="M9.4 3h5.2v3.4H9.4Z" />
      <path d="M8.6 11.4h6.8M8.6 15.4h4.4" />
    </>
  ),
  lock: (
    <>
      <path d="M5.5 10.6h13V21h-13Z" />
      <path d="M8.4 10.6V7.4a3.6 3.6 0 0 1 7.2 0v3.2" />
      <path d="M12 14.6v2.8" />
    </>
  ),

  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.2" cy="8" r="3.3" />
      <path d="M3.2 20a6 6 0 0 1 12 0" />
      <path d="M16 5.1a3.3 3.3 0 0 1 0 5.8" />
      <path d="M17.4 14.4A6 6 0 0 1 20.8 20" />
    </>
  ),
  calendar: (
    <>
      <path d="M4.5 6h15v14h-15Z" />
      <path d="M4.5 10h15" />
      <path d="M8.5 3.5v4.2M15.5 3.5v4.2" />
      <path d="M8.3 13.8h.01M12 13.8h.01M15.7 13.8h.01M8.3 17h.01M12 17h.01" />
    </>
  ),
  overview: (
    <>
      <path d="M4 4h6.5v6H4Z" />
      <path d="M13.5 4H20v9h-6.5Z" />
      <path d="M4 13h6.5v7H4Z" />
      <path d="M13.5 16H20v4h-6.5Z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6.8h16M4 12h16M4 17.2h16" />
      <circle cx="9" cy="6.8" r="1.9" />
      <circle cx="15.5" cy="12" r="1.9" />
      <circle cx="8" cy="17.2" r="1.9" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v6.1c0 4.4-3.3 7.6-8 8.9-4.7-1.3-8-4.5-8-8.9V6Z" />
      <path d="M9.2 12.1 11.3 14.2 15 10.5" />
    </>
  ),
  history: (
    <>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
      <path d="M3 4.8v4.4h4.4" />
      <path d="M12 7.8v4.6l3.2 1.9" />
    </>
  ),

  search: (
    <>
      <circle cx="10.6" cy="10.6" r="6.1" />
      <path d="M15.1 15.1 20.5 20.5" />
    </>
  ),
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  'arrow-right': <path d="M4.5 12h14M12.8 6.3 18.5 12l-5.7 5.7" />,
  'arrow-left': <path d="M19.5 12h-14M11.2 6.3 5.5 12l5.7 5.7" />,
  'chevron-down': <path d="M6.5 9.5 12 15l5.5-5.5" />,
  'chevron-right': <path d="M9.5 6.5 15 12l-5.5 5.5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  more: (
    <>
      <circle cx="5.3" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18.7" cy="12" r="1.5" />
    </>
  ),
  signal: (
    <>
      <path d="M4.6 12.4a10.5 10.5 0 0 1 14.8 0" />
      <path d="M8.1 15.9a5.5 5.5 0 0 1 7.8 0" />
      <path d="M12 19.4h.01" />
    </>
  ),
  'signal-off': (
    <>
      <path d="M4.6 12.4a10.5 10.5 0 0 1 5.1-2.8" />
      <path d="M14.8 10a10.5 10.5 0 0 1 4.6 2.4" />
      <path d="M8.1 15.9a5.5 5.5 0 0 1 2.2-1.4" />
      <path d="M12 19.4h.01" />
      <path d="M3.6 3.6 20.4 20.4" />
    </>
  ),
}

export function Icon({
  name,
  size = 20,
  title,
  className = '',
  ...rest
}: {
  name: IconName
  /** Rendered px. 20 beside body text, 23 in navigation, 44 in a result. */
  size?: number
  /**
   * Only for the rare glyph that genuinely is the label. Supplying it makes the
   * icon an `img` with an accessible name instead of decoration.
   */
  title?: string
  className?: string
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height' | 'className'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`shrink-0 ${className}`}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  )
}
