import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const { createObsGuard } = await import('../../agent/obsGuard.mjs');

describe('obsGuard (runner live check)', () => {
  test('a 10× balance jump is flagged and hidden from the helper agent; it comes back → baseline unchanged', () => {
    const g = createObsGuard();
    expect(g.check(161, { balance: 4806255, bet: 6600 }).warnings).toEqual([]);
    const r = g.check(162, { balance: 3120644728, bet: 6600 });
    expect(r.clean).toEqual({ bet: 6600 });
    expect(r.warnings).toEqual([{ kind: 'suspect_value', key: 'balance', value: 3120644728, prev: { step: 161, value: 4806255 } }]);
    expect(g.check(163, { balance: 5046180, bet: 6600 }).warnings).toEqual([]);
  });

  test('a big jump confirmed by the next reading becomes the new baseline', () => {
    const g = createObsGuard();
    g.check(1, { balance: 1000000 });
    expect(g.check(2, { balance: 40000000 }).warnings).toHaveLength(1);
    const r = g.check(3, { balance: 40100000 });
    expect(r.warnings).toEqual([]);
    expect(r.clean).toEqual({ balance: 40100000 });
  });

  test('bet change is reported once the new value repeats; a single odd reading is not', () => {
    const g = createObsGuard();
    g.check(1, { bet: 6600 });
    expect(g.check(2, { bet: 13200 }).warnings).toEqual([]);
    expect(g.check(3, { bet: 6600 }).warnings).toEqual([]);
    g.check(4, { bet: 13200 });
    expect(g.check(5, { bet: 13200 }).warnings).toEqual([{ kind: 'bet_changed', key: 'bet', from: 6600, to: 13200, sinceStep: 4, prevStep: 3 }]);
  });

  test('win values are never flagged; reset() forgets the previous segment', () => {
    const g = createObsGuard();
    g.check(1, { win: 0, balance: 30000000 });
    expect(g.check(2, { win: 4000000, balance: 30100000 }).warnings).toEqual([]);
    g.reset();
    expect(g.check(3, { balance: 20000 }).warnings).toEqual([]);
  });
});
