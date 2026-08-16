import { describe, expect, it } from 'vitest';
import {
  decompose,
  formatQty,
  lineAmountPaise,
  paiseToRupees,
  toBaseUnits,
  unitsInPack,
} from './index';

const STRIP_OF_15 = { unitsPerStrip: 15, stripsPerBox: 10 };

describe('pack conversion', () => {
  it('converts what the counter types into what the ledger stores', () => {
    // The worked example from INVENTORY.md §1: 2 boxes in, 300 tablets recorded.
    expect(toBaseUnits(2, 'box', { unitsPerStrip: 15, stripsPerBox: 10 })).toBe(300);
    expect(toBaseUnits(1, 'strip', STRIP_OF_15)).toBe(15);
    expect(toBaseUnits(6, 'unit', STRIP_OF_15)).toBe(6);
  });

  it('reads pack size from the batch, so two batches of one drug differ', () => {
    // The same drug, one run at 15 to a strip and the next at 10. This is the
    // case that corrupts every historical quantity if the factor lives on the
    // drug record instead of the batch.
    expect(unitsInPack({ unitsPerStrip: 15, stripsPerBox: 10 }, 'strip')).toBe(15);
    expect(unitsInPack({ unitsPerStrip: 10, stripsPerBox: 10 }, 'strip')).toBe(10);
  });

  it('refuses a fractional or negative quantity', () => {
    expect(() => toBaseUnits(1.5, 'strip', STRIP_OF_15)).toThrow(RangeError);
    expect(() => toBaseUnits(-1, 'strip', STRIP_OF_15)).toThrow(RangeError);
  });
});

describe('loose-strip tracking', () => {
  it('computes strips and loose rather than storing them', () => {
    expect(decompose(47, STRIP_OF_15)).toEqual({ boxes: 0, strips: 3, loose: 2 });
    expect(decompose(294, STRIP_OF_15)).toEqual({ boxes: 0, strips: 19, loose: 9 });
  });

  it('decomposes to boxes when asked', () => {
    expect(decompose(294, STRIP_OF_15, { boxes: true })).toEqual({
      boxes: 1,
      strips: 9,
      loose: 9,
    });
  });

  it('formats the way a pharmacist counts', () => {
    expect(formatQty(294, STRIP_OF_15, 'tablets')).toBe('19 strips + 9 tablets');
    expect(formatQty(45, STRIP_OF_15, 'tablets')).toBe('3 strips');
    expect(formatQty(0, STRIP_OF_15, 'tablets')).toBe('0 tablets');
  });
});

describe('the MRP ceiling', () => {
  it('bills a full strip at exactly the printed MRP', () => {
    expect(lineAmountPaise(15, 4500, STRIP_OF_15, 'strip')).toBe(4500);
  });

  it('rounds a loose unit DOWN rather than up past MRP', () => {
    // 667.00 for 200 units is 3.335 each. Rounding to the nearest paise gives
    // 3.34, which is above the pro-rata MRP — illegal, not merely untidy.
    const pack = { unitsPerStrip: 200, stripsPerBox: 1 };
    expect(lineAmountPaise(1, 66700, pack, 'strip')).toBe(333);
  });

  it('never exceeds MRP x packs, at any quantity', () => {
    const pack = { unitsPerStrip: 200, stripsPerBox: 1 };
    const mrp = 66700;
    for (let qty = 1; qty <= 400; qty++) {
      const cap = (mrp * qty) / 200;
      expect(lineAmountPaise(qty, mrp, pack, 'strip')).toBeLessThanOrEqual(cap);
    }
  });
});

describe('money formatting', () => {
  it('keeps paise exact', () => {
    expect(paiseToRupees(4500)).toBe('45.00');
    expect(paiseToRupees(333)).toBe('3.33');
    expect(paiseToRupees(5)).toBe('0.05');
  });
});
