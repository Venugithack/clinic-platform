/**
 * The token box — the signature object of the reference system, and the one
 * string the patient, the desk and the doctor all say out loud.
 *
 * Every sequenced identifier in this clinic has the same `PREFIX-0001` shape:
 * queue tokens (`JMC-0004`), OTC receipts, purchase orders. The internal rule
 * between prefix and serial is the point — they are two different facts.
 *
 * Monochrome by design: it appears beside status badges everywhere, so it must
 * never compete with them for colour. `active` inverts to solid ink, which is
 * how this system says "happening right now".
 */

type Size = 'sm' | 'md' | 'lg'

const SIZES: Record<Size, { box: string; prefix: string; serial: string }> = {
  sm: { box: 'border', prefix: 'px-1.5 py-0.5 text-[10px]', serial: 'px-1.5 py-0.5 text-[13px]' },
  md: { box: 'border-2', prefix: 'px-2 py-1 text-[11px]', serial: 'px-2.5 py-1 text-[17px]' },
  lg: { box: 'border-2', prefix: 'px-3 py-2 text-[12px]', serial: 'px-4 py-2 text-[30px]' },
}

/** Splits `JMC-0004` into its two facts. Anything else is shown whole. */
function split(code: string): { prefix: string; serial: string } {
  const at = code.lastIndexOf('-')
  if (at <= 0 || at === code.length - 1) return { prefix: '', serial: code }
  return { prefix: code.slice(0, at), serial: code.slice(at + 1) }
}

export function Token({
  code,
  size = 'sm',
  active = false,
}: {
  /** The full identifier, e.g. `JMC-0004`. */
  code: string
  size?: Size
  active?: boolean
}) {
  const { prefix, serial } = split(code)
  const s = SIZES[size]
  const ink = active ? 'border-ink bg-ink text-paper' : 'border-ink bg-transparent text-ink'
  const divider = active ? 'border-paper/35' : 'border-rule'

  return (
    <span
      className={`inline-flex shrink-0 items-stretch rounded-box transition-colors duration-150 ${s.box} ${ink}`}
      title={code}
    >
      {prefix ? (
        <span
          className={`flex items-center border-r font-semibold tracking-[0.14em] ${divider} ${s.prefix}`}
        >
          {prefix}
        </span>
      ) : null}
      <span className={`flex items-center font-mono font-medium tabular-nums ${s.serial}`}>
        {serial}
      </span>
    </span>
  )
}
