import { describe, expect, test } from 'vitest';
import { sanitizeObs } from '../lambda/api/report/dataQuality.js';
import { autospinRtp } from '../lambda/api/report/metrics.js';
import type { EvidenceStep } from '../lambda/api/report/types.js';

const mk = (index: number, obs: Record<string, number>, segment?: number): EvidenceStep => ({
  index, screen: 'reels', action: 'wait', obs, ...(segment ? { segment } : {}),
});

describe('sanitizeObs (job-muvebihv misreads)', () => {
  test('a one-step balance spike that comes back is excluded, with source step, raw value and neighbours', () => {
    const steps = [mk(161, { balance: 4806255, bet: 6600 }), mk(162, { balance: 3120644728, bet: 6600 }), mk(163, { balance: 5046180, bet: 6600 })];
    const { steps: out, quality } = sanitizeObs(steps);
    expect(quality.excluded).toHaveLength(1);
    expect(quality.excluded[0]).toMatchObject({ step: 162, key: 'balance', value: 3120644728, prev: { step: 161, value: 4806255 }, next: { step: 163, value: 5046180 } });
    expect(out[1]!.obs).toEqual({ bet: 6600 });
    expect(out[1]!.excludedObs!['balance']!.value).toBe(3120644728);
    expect(steps[1]!.obs!['balance']).toBe(3120644728); // 不改輸入
  });

  test('a real big win that stays is kept; win/payout values are never filtered', () => {
    const { quality } = sanitizeObs([mk(170, { balance: 5000000, win: 0 }), mk(177, { balance: 36968680, win: 31957000 }), mk(178, { balance: 36900000, win: 0 })]);
    expect(quality.excluded).toEqual([]);
  });

  test('last reading far off the previous one is excluded; small counters going to 0 are not', () => {
    const { quality } = sanitizeObs([mk(1, { balance: 34000000, autospin_left: 5 }), mk(2, { balance: 34100000, autospin_left: 0 }), mk(3, { balance: 3410000000, autospin_left: 3 })]);
    expect(quality.excluded.map((e) => `${e.step}:${e.key}`)).toEqual(['3:balance']);
  });

  test('bet: single different reading = misread; a lasting change = bet change (not excluded)', () => {
    const { quality } = sanitizeObs([
      mk(1, { bet: 6600 }), mk(2, { bet: 66000 }), mk(3, { bet: 6600 }),
      mk(4, { bet: 6600 }), mk(5, { bet: 13200 }), mk(6, { bet: 13200 }),
    ]);
    expect(quality.excluded.map((e) => e.step)).toEqual([2]);
    expect(quality.betChanges).toEqual([{ step: 5, prevStep: 4, key: 'bet', from: 6600, to: 13200 }]);
  });

  test('values from different connection segments are not compared', () => {
    const { quality } = sanitizeObs([mk(1, { balance: 34000000 }, 1), mk(2, { balance: 34100000 }, 1), mk(3, { balance: 50000 }, 2), mk(4, { balance: 51000 }, 2)]);
    expect(quality.excluded).toEqual([]);
  });
});

describe('autospinRtp per segment and bet', () => {
  test('spins × bet and balance change are summed per (segment, bet) run', () => {
    const steps = [
      mk(1, { autospin_left: 500, balance: 1000000, bet: 1000 }),
      mk(2, { autospin_left: 400, balance: 950000, bet: 1000 }), // 100 spins, -50,000
      mk(3, { autospin_left: 500, balance: 950000, bet: 2000 }),
      mk(4, { autospin_left: 450, balance: 960000, bet: 2000 }), // 50 spins × 2000, +10,000
      mk(5, { autospin_left: 500, balance: 20000, bet: 1000 }, 2), // 新連線:餘額重置
      mk(6, { autospin_left: 450, balance: 15000, bet: 1000 }, 2), // 50 spins, -5,000
    ];
    const r = autospinRtp(steps)!;
    expect(r.spins).toBe(200);
    expect(r.groups).toBe(3);
    // 1 + (-50000 + 10000 - 5000) / (100×1000 + 50×2000 + 50×1000) = 1 - 45000/250000 = 82%
    expect(r.rtp).toBe(82);
  });
});
