import { describe, it, expect } from 'vitest';
import { parsePositiveInt } from '../src/lib/numeric.js';

describe('parsePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveInt('5', '--limit')).toBe(5);
    expect(parsePositiveInt('100', '--limit')).toBe(100);
  });

  it('rejects undefined', () => {
    expect(() => parsePositiveInt(undefined, '--limit')).toThrow(/--limit: missing/);
  });

  it('rejects empty string', () => {
    expect(() => parsePositiveInt('', '--limit')).toThrow(/--limit: missing/);
  });

  it('rejects non-integer', () => {
    expect(() => parsePositiveInt('abc', '--limit')).toThrow(/--limit: not an integer/);
    expect(() => parsePositiveInt('1.5', '--limit')).toThrow(/--limit: not an integer/);
    expect(() => parsePositiveInt('1e3', '--limit')).toThrow(/--limit: not an integer/);
  });

  it('rejects zero by default', () => {
    expect(() => parsePositiveInt('0', '--limit')).toThrow(/--limit: must be >= 1/);
  });

  it('accepts zero when allowZero', () => {
    expect(parsePositiveInt('0', '--community', { allowZero: true })).toBe(0);
  });

  it('rejects negative', () => {
    expect(() => parsePositiveInt('-5', '--limit')).toThrow(/--limit: must be >= 1/);
  });

  it('respects max', () => {
    expect(() => parsePositiveInt('100', '--depth', { max: 50 })).toThrow(/must be <= 50/);
  });

  it('respects custom min', () => {
    expect(() => parsePositiveInt('1', '--limit', { min: 5 })).toThrow(/must be >= 5/);
  });
});
