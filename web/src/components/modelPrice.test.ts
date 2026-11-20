import { describe, expect, it } from 'vitest';
import { formatPerM, regionalNote, regionalSuffix, regionalTip } from './modelPrice.ts';

describe('regional price labelling', () => {
  const sonnet = { displayName: 'Claude Sonnet 4.6', pricing: { inputPerM: 3.3, outputPerM: 16.5, globalPrice: { inputPerM: 3, outputPerM: 15 } } };
  const nova = { displayName: 'Nova Lite', pricing: { inputPerM: 0.06, outputPerM: 0.24 } };

  it('tags only models that have a cheaper Global price', () => {
    expect(regionalSuffix(sonnet.pricing, 'en')).toBe(' · regional price');
    expect(regionalSuffix(sonnet.pricing, 'zh-Hant')).toBe(' · 區域價');
    expect(regionalSuffix(nova.pricing, 'en')).toBe('');
    expect(regionalSuffix(undefined, 'en')).toBe('');
  });

  it('tooltip shows the official Global price', () => {
    expect(regionalTip(sonnet.pricing, 'en')).toContain('$3.00/$15.00');
    expect(regionalTip(nova.pricing, 'en')).toBe('');
  });

  it('note appears only when a regional model is listed, with both prices of the example', () => {
    expect(regionalNote([nova], 'en')).toBeNull();
    const n = regionalNote([nova, sonnet], 'en')!;
    expect(n).toContain('Claude Sonnet 4.6');
    expect(n).toContain('$3.30/$16.50');
    expect(n).toContain('$3.00/$15.00');
    expect(n).toContain('10%');
    for (const lc of ['zh-Hant', 'zh-Hans', 'ja', 'ko'] as const) {
      const t = regionalNote([sonnet], lc)!;
      expect(t, lc).toContain('$3.30/$16.50');
      expect(t, lc).not.toContain('{');
    }
  });
});

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
