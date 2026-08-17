/**
 * CSV, for a file somebody opens in Excel.
 *
 * Two details make this more than `rows.join(',')`, and both come from the file
 * being read by a person with an agenda — an inspector, an accountant, the
 * doctor at tax time.
 *
 * **Quoting.** A drug called `Combiflam, 400/325mg` and an address with a
 * newline in it both break a naive join, and they break it silently: the file
 * opens, the columns shift by one, and the register reads as nonsense.
 *
 * **Formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed as a
 * formula by Excel and by LibreOffice. Nothing in this build lets a patient
 * type into a register, so this is not a live attack — but a supplier's name is
 * free text, a batch number is whatever is printed on the box, and a register
 * that quietly evaluates one of them is wrong in a way nobody would think to
 * check. The guard costs one character.
 */

export interface CsvColumn<T> {
  key: keyof T & string;
  label: string;
}

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // Excel and LibreOffice both execute a leading =, +, - or @. A leading
  // apostrophe makes it text again and is invisible in the cell.
  if (FORMULA.test(text)) text = `'${text}`;

  if (NEEDS_QUOTES.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<CsvColumn<T>>,
): string {
  const header = columns.map((column) => csvCell(column.label)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => csvCell(row[column.key])).join(','),
  );
  // CRLF: it is what Excel expects, and it survives being mailed around.
  return [header, ...body].join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * A BOM, because Excel on Windows reads a UTF-8 file without one as Latin-1 —
 * and this register has ₹ in it and Indian names in it.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Reading a CSV somebody typed.
 *
 * Written by hand rather than pulled in, because the file this parses is the
 * doctor's drug master — five hundred rows of a spreadsheet exported by a
 * person who has never heard of RFC 4180 — and the failure modes are all in the
 * quoting. A dependency would handle those too; it would also be a dependency
 * in a build that has three.
 *
 * What it handles, because real exports contain all of it: quoted fields,
 * commas and newlines inside quotes, doubled quotes as an escape, CRLF, a
 * trailing newline, and blank lines in the middle.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  // Excel writes a BOM. Left in place it becomes an invisible first character
  // of the first header, and that column silently fails to match.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index] as string;

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
    } else if (char === ',') {
      endField();
      index += 1;
    } else if (char === '\r') {
      index += 1;
    } else if (char === '\n') {
      endRow();
      index += 1;
    } else {
      field += char;
      index += 1;
    }
  }

  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Rows keyed by header, with the header normalised.
 *
 * "Units per strip", "units_per_strip" and "UNITS PER STRIP" are the same
 * column, because three different people will have typed this file.
 */
export function parseCsvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) return [];

  const keys = header.map((cell) =>
    cell.trim().toLowerCase().replace(/[\s-]+/g, '_'),
  );

  return rows.map((cells) =>
    Object.fromEntries(
      keys.map((key, index) => [key, (cells[index] ?? '').trim()]),
    ),
  );
}
