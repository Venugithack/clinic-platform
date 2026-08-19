/**
 * The token box — the signature object of the system.
 *
 * `T│004` is the one string the patient, the counter and the doctor all say out
 * loud. The internal rule between the halves is the whole point: they are two
 * different facts. The prefix carries the kind, the serial carries the
 * position, and the rule is what stops them being read as one number.
 *
 * Deliberately monochrome. It sits beside status badges on every screen, so it
 * must never compete with them for colour. `active` inverts it to solid ink —
 * the system's way of saying "happening right now", and the only element in the
 * clinic that ever does it.
 *
 * The clinic has no departments, so the prefix is optional: the queue shows a
 * bare serial, while a prescription is RX│1042 and a bill BILL│0007.
 */
export function Token({
  prefix,
  serial,
  size = 'md',
  active = false,
}: {
  prefix?: string;
  serial: string | number;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
}) {
  const box = active
    ? 'border-ink bg-ink text-paper'
    : 'border-ink bg-transparent text-ink';

  const border = size === 'sm' ? 'border' : 'border-2';

  const prefixSize = {
    sm: 'px-1.5 text-[0.5rem]',
    md: 'px-2 text-[0.625rem]',
    lg: 'px-3 py-2 text-xs',
  }[size];

  const serialSize = {
    sm: 'px-1.5 text-xs',
    md: 'px-2.5 text-base',
    lg: 'px-4 py-1.5 text-3xl',
  }[size];

  return (
    // shrink-0: an identifier that ellipsises is a bug, not a layout.
    <span
      className={`inline-flex shrink-0 items-stretch rounded-box ${border} ${box}`}
    >
      {prefix ? (
        <span
          className={`flex items-center border-r font-semibold tracking-[0.14em] ${prefixSize} ${
            active ? 'border-paper/35' : 'border-rule'
          }`}
        >
          {prefix}
        </span>
      ) : null}
      <span
        className={`tabular flex items-center font-mono font-medium ${serialSize}`}
      >
        {serial}
      </span>
    </span>
  );
}
