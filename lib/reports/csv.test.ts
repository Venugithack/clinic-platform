import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csv cells', () => {
  it('quotes what would otherwise shift every column', () => {
    // A real drug name and a real address. Both break a naive join, and both
    // break it silently — the file opens and the register reads as nonsense.
    expect(csvCell('Combiflam, 400/325mg')).toBe('"Combiflam, 400/325mg"');
    expect(csvCell('12 Nehru Street\nKadapa')).toBe('"12 Nehru Street\nKadapa"');
    expect(csvCell('Kumar "Bhai" Distributors')).toBe('"Kumar ""Bhai"" Distributors"');
  });

  it('defuses a cell Excel would execute', () => {
    // Nothing in this build lets a patient type into a register, but a supplier
    // name is free text and a batch number is whatever is printed on the box.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+91 90000 00001')).toBe("'+91 90000 00001");
    expect(csvCell('-500')).toBe("'-500");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('leaves ordinary values alone, and empty means empty', () => {
    expect(csvCell('Dolo 650')).toBe('Dolo 650');
    expect(csvCell(10)).toBe('10');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('csv files', () => {
  it('writes a header and CRLF line endings', () => {
    const rows = [
      { patient_name: 'Ravi Kumar', qty_base: 10 },
      { patient_name: 'Sita Devi', qty_base: 5 },
    ];

    expect(
      toCsv(rows, [
        { key: 'patient_name', label: 'Patient' },
        { key: 'qty_base', label: 'Quantity' },
      ]),
    ).toBe('Patient,Quantity\r\nRavi Kumar,10\r\nSita Devi,5');
  });

  it('exports the columns asked for, in that order, and nothing else', () => {
    // A register is a legal document with a defined shape. Exporting whatever
    // happens to be on the row is how a patient's phone number ends up in a
    // file that was only ever asked for a drug and a date.
    const rows = [{ a: 1, b: 2, secret: 'phone' }];
    expect(toCsv(rows, [{ key: 'b', label: 'B' }])).toBe('B\r\n2');
  });
});
