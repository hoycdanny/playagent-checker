import { describe, expect, it } from 'vitest';
import { formatPerM } from './modelPrice.ts';

describe('formatPerM', () => {
  it('keeps official three- and four-decimal prices instead of rounding to cents', () => {
    expect(formatPerM(0.035)).toBe('$0.035'); // Nova Micro input
    expect(formatPerM(0.00875)).toBe('$0.0088'); // four decimals maximum
    expect(formatPerM(0.0825)).toBe('$0.0825');
  });
  it('shows at least two decimals', () => {
    expect(formatPerM(3)).toBe('$3.00');
    expect(formatPerM(16.5)).toBe('$16.50');
    expect(formatPerM(0.22)).toBe('$0.22');
    expect(formatPerM(0)).toBe('$0.00');
  });
  it('removes floating-point noise', () => {
    expect(formatPerM(0.1 + 0.2)).toBe('$0.30');
    expect(formatPerM(3 * 1.1)).toBe('$3.30');
  });
});
