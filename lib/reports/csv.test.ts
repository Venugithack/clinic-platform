import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, parseCsvObjects, toCsv } from './csv';

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

describe('reading a csv somebody typed', () => {
  it('handles the quoting a real export contains', () => {
    const csv =
      'Name,Salt,Address\r\n' +
      '"Combiflam, 400/325mg",Ibuprofen,"12 Nehru Street\nKadapa"\r\n' +
      'Dolo 650,Paracetamol,\r\n';

    expect(parseCsv(csv)).toEqual([
      ['Name', 'Salt', 'Address'],
      ['Combiflam, 400/325mg', 'Ibuprofen', '12 Nehru Street\nKadapa'],
      ['Dolo 650', 'Paracetamol', ''],
    ]);
  });

  it('survives a doubled quote, a BOM and a blank line', () => {
    const csv = '﻿Name\n"Kumar ""Bhai"" Distributors"\n\nReddy Pharma\n';
    expect(parseCsv(csv)).toEqual([
      ['Name'],
      ['Kumar "Bhai" Distributors'],
      ['Reddy Pharma'],
    ]);
  });

  it('normalises headers, because three people typed this file', () => {
    const csv = 'Drug Name,UNITS PER STRIP,salt_composition\nDolo 650,15,Paracetamol\n';
    expect(parseCsvObjects(csv)).toEqual([
      { drug_name: 'Dolo 650', units_per_strip: '15', salt_composition: 'Paracetamol' },
    ]);
  });

  it('round-trips what it writes', () => {
    const rows = [{ name: 'Combiflam, 400/325mg', qty: '15' }];
    const csv = toCsv(rows, [
      { key: 'name', label: 'Name' },
      { key: 'qty', label: 'Qty' },
    ]);
    expect(parseCsvObjects(csv)).toEqual([{ name: 'Combiflam, 400/325mg', qty: '15' }]);
  });
});
