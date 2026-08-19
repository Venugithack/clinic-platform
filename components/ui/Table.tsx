/**
 * The register. Eight screens in this clinic are a ruled book with columns, and
 * that is not a coincidence — the software replaces a stack of them.
 *
 * The scroll container is part of the primitive rather than left to the caller,
 * and that is the fix for the layout bug this system replaced: a bare <table>
 * has an intrinsic minimum width, and inside a grid track that minimum wins.
 * The track refused to shrink, the shell overflowed, and `overflow-hidden` on
 * the shell then clipped the last columns off the screen entirely. A register
 * that silently loses its right-hand columns is worse than one that scrolls, so
 * the wrapper scrolls and `min-w-0` on it lets the track shrink.
 *
 * `num` sends a cell mono, tabular and right-aligned. Every number in a
 * register is compared with the one above it, and a column of quantities that
 * does not line up is a column nobody proof-reads.
 */
export function Table({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`min-w-0 overflow-x-auto rounded-box border border-rule bg-sheet ${className}`}
    >
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead>{children}</thead>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TR({
  className = '',
  children,
  ...rest
}: {
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLTableRowElement>, 'className' | 'children'>) {
  return (
    <tr className={`last:[&>td]:border-b-0 ${className}`} {...rest}>
      {children}
    </tr>
  );
}

export function TH({
  num = false,
  className = '',
  children,
  ...rest
}: {
  num?: boolean;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'className' | 'children'>) {
  return (
    <th
      className={`eyebrow whitespace-nowrap border-b-2 border-ink px-3 py-2 align-bottom ${
        num ? 'text-right' : 'text-left'
      } ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TD({
  num = false,
  className = '',
  children,
  ...rest
}: {
  num?: boolean;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.TdHTMLAttributes<HTMLTableCellElement>, 'className' | 'children'>) {
  return (
    <td
      className={`border-b border-rule px-3 py-2 align-top ${
        num ? 'tabular text-right font-mono' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}
