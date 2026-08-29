import { describe, expect, it } from 'vitest';
import { deepLink, isDeliverable, normaliseNumber, numberProblem } from './index';

describe('normalising a supplier number', () => {
  it('keeps only digits, however the number was written down', () => {
    expect(normaliseNumber('+919000000001')).toBe('919000000001');
    expect(normaliseNumber('+91 90000 00001')).toBe('919000000001');
    expect(normaliseNumber('+91-90000-00001')).toBe('919000000001');
  });
});

describe('the country code, which is the part nobody types', () => {
  it('accepts a number that carries one', () => {
    expect(isDeliverable('+919000000001')).toBe(true);
    expect(isDeliverable('91 63831 87889')).toBe(true);
  });

  // The three numbers the live clinic actually had on 29 Aug 2026. Every one of
  // them is a real supplier written down the way an Indian number is spoken,
  // and every one of them produced a wa.me link addressed to nobody.
  it('refuses the ten-digit numbers that were sitting in production', () => {
    for (const stored of ['6383187889', '9360976118', '7904194033']) {
      expect(isDeliverable(stored)).toBe(false);
      expect(numberProblem(stored)).toMatch(/country code/i);
    }
  });

  it('refuses a trunk prefix, which means something only inside the country', () => {
    expect(isDeliverable('09000000001')).toBe(false);
    expect(numberProblem('09000000001')).toMatch(/leading 0/i);
  });

  it('refuses nothing at all, and says so differently', () => {
    expect(isDeliverable('')).toBe(false);
    expect(isDeliverable(null)).toBe(false);
    expect(isDeliverable(undefined)).toBe(false);
    expect(numberProblem('')).toMatch(/Enter/i);
  });

  it('refuses something too long to be a phone number', () => {
    expect(isDeliverable('9199999999999999')).toBe(false);
  });

  it('has nothing to say about a number that is fine', () => {
    expect(numberProblem('+919000000001')).toBeNull();
  });
});

describe('the link itself', () => {
  it('addresses wa.me with digits and carries the order as written', () => {
    const body = 'Jayamurugan Clinic\nPO 2026-27/0001\n\n1. Dolo 650 650mg — 2 boxes (300)';
    const href = deepLink('+919000000001', body);

    expect(href.startsWith('https://wa.me/919000000001?text=')).toBe(true);

    // The message survives the round trip intact — newlines and the em-dash
    // that the pack-size line is written with.
    expect(new URL(href).searchParams.get('text')).toBe(body);
  });
});
