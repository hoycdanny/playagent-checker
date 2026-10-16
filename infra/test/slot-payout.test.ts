import { describe, expect, test } from 'vitest';

// @ts-expect-error 此純 ESM 基礎模組目前不另外發布型別宣告。
const { classifySymbol, comparePayout, evaluateAllWays, normalizeBoard, validateMachineProfile } = await import('../../agent/slotPayout.mjs');

function profile(overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: '1.0.0', machineId: 'test-machine', appId: 'test.app', appVersion: '1.0',
    layout: { reels: 5, variableRows: true, ways: true },
    symbols: [
      { id: 'A', aliases: ['Ace'] },
      { id: 'B' },
      { id: 'W', aliases: ['Wild'], wild: true },
      { id: 'S', aliases: ['Bonus'], scatter: true },
    ],
    paytable: [{ symbol: 'A', count: 3, multiplier: 10 }],
    rules: { consecutiveFromLeft: true, wildSubstitutes: true, betBasis: 'perWay' },
    provenance: { sourceScreenshots: ['fixture.png'] },
  };
  return { ...base, ...overrides };
}

describe('machine profile 與盤面驗證', () => {
  test('有效設定通過、無效設定一次回報錯誤', () => {
    expect(validateMachineProfile(profile())).toEqual({ ok: true, errors: [] });
    const result = validateMachineProfile(profile({ machineId: '', layout: { reels: 0 } }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  test('拒絕未知符號並正規化 alias', () => {
    const p = profile();
    expect(normalizeBoard([['Ace'], ['A'], ['W'], ['B'], ['S']], p).board).toEqual([['A'], ['A'], ['W'], ['B'], ['S']]);
    const result = normalizeBoard([['A'], ['A'], ['UNKNOWN'], ['B'], ['S']], p);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('未知符號');
  });
});

describe('All-Ways 派彩', () => {
  test('ways 是各 reel 命中數乘積且 wild 可替代', () => {
    const result = evaluateAllWays({
      board: [['A', 'B'], ['A', 'W'], ['A', 'A'], ['B'], ['B']], bet: 2, profile: profile(),
    });
    expect(result).toMatchObject({ ok: true, expectedPayout: 80 });
    expect(result.wins[0]).toMatchObject({ type: 'ways', symbol: 'A', count: 3, ways: 4, payout: 80 });
  });

  test('最左 reel 沒命中時不派彩', () => {
    const result = evaluateAllWays({ board: [['B'], ['A'], ['A'], ['A'], ['A']], bet: 1, profile: profile() });
    expect(result).toMatchObject({ ok: true, expectedPayout: 0, wins: [] });
  });

  test('total bet basis 精確除以 totalWays', () => {
    const p = profile({
      paytable: [{ symbol: 'A', count: 5, multiplier: 100 }],
      rules: { consecutiveFromLeft: true, wildSubstitutes: true, betBasis: 'total', totalWays: 20 },
    });
    const result = evaluateAllWays({ board: [['A', 'A'], ['A'], ['A', 'A'], ['A'], ['A']], bet: 10, profile: p });
    expect(result).toMatchObject({ ok: true, expectedPayout: 200 });
  });

  test('非整數派彩明確失敗而不四捨五入', () => {
    const p = profile({ rules: { consecutiveFromLeft: true, wildSubstitutes: true, betBasis: 'total', totalWays: 3 } });
    const result = evaluateAllWays({ board: [['A'], ['A'], ['A'], ['B'], ['B']], bet: 1, profile: p });
    expect(result.ok).toBe(false);
    expect(result.expectedPayout).toBeNull();
    expect(result.errors[0]).toContain('不是精確整數');
  });

  test('未核准 profile 或 total bet 缺 totalWays 時拒絕自動判派彩', () => {
    const pending = profile({ provenance: { sourceScreenshots: ['page.png'], approved: false } });
    expect(evaluateAllWays({ board: [['A'], ['A'], ['A'], ['B'], ['B']], bet: 1, profile: pending }).errors[0]).toContain('尚未人工核准');
    const noWays = profile({ rules: { consecutiveFromLeft: true, wildSubstitutes: true, betBasis: 'total' } });
    expect(evaluateAllWays({ board: [['A'], ['A'], ['A'], ['B'], ['B']], bet: 1, profile: noWays }).errors).toContain('total bet basis 必須由已核准規則提供 rules.totalWays');
  });

  test('全 wild 組合只算 wild 自己，不重複灌入一般符號', () => {
    const p = profile({ paytable: [
      { symbol: 'A', count: 3, multiplier: 10 },
      { symbol: 'B', count: 3, multiplier: 8 },
      { symbol: 'W', count: 3, multiplier: 20 },
    ] });
    const result = evaluateAllWays({ board: [['W'], ['W'], ['W'], ['A'], ['B']], bet: 1, profile: p });
    expect(result).toMatchObject({ ok: true, expectedPayout: 20 });
    expect(result.wins).toHaveLength(1);
    expect(result.wins[0].symbol).toBe('W');
  });

  test('scatter anywhere 跨全盤計數，且不乘 ways', () => {
    const p = profile({
      paytable: [{ symbol: 'S', count: 3, multiplier: 5 }],
      rules: { consecutiveFromLeft: true, wildSubstitutes: true, scatterAnywhere: true, betBasis: 'total', totalWays: 20 },
    });
    const result = evaluateAllWays({ board: [['S', 'A'], ['A'], ['S', 'W'], ['B'], ['S']], bet: 4, profile: p });
    expect(result).toMatchObject({ ok: true, expectedPayout: 20 });
    expect(result.wins[0]).toMatchObject({ type: 'scatter', count: 3, ways: 1, payout: 20 });
  });
});

describe('比對與符號分類', () => {
  test('tolerance 含邊界並回傳有正負號 delta', () => {
    expect(comparePayout({ expected: 100, actual: 102, tolerance: 2 })).toEqual({ pass: true, delta: 2 });
    expect(comparePayout({ expected: 100, actual: 97, tolerance: 2 })).toEqual({ pass: false, delta: -3 });
  });

  test('template 門檻、低信心及 VLM alias 的優先序固定', () => {
    const p = profile();
    expect(classifySymbol({ templateScores: { A: 0.98 }, vlmLabel: 'Wild' }, p)).toEqual({ id: 'A', confidence: 0.98, basis: 'template' });
    expect(classifySymbol({ templateScores: { A: 0.90 }, vlmLabel: 'Wild' }, p)).toEqual({ id: 'A', confidence: 0.90, basis: 'template-low-confidence' });
    expect(classifySymbol({ templateScores: { A: 0.899 }, vlmLabel: '  WILD  ' }, p)).toEqual({ id: 'W', confidence: 0, basis: 'vlm-alias' });
    expect(classifySymbol({ templateScores: { A: 0.1 }, vlmLabel: 'not-known' }, p)).toEqual({ id: null, confidence: 0, basis: 'unresolved' });
  });
});
