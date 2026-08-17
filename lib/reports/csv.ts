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
