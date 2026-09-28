import { describe, test, expect } from 'vitest';
import {
  resolvePrice,
  computeSpend,
  isPriceable,
  budgetExceeded,
  PricingError,
} from '../lambda/api/pricing.js';

describe('單價表 / Fail Closed(Req 7.3/7.4)', () => {
  test('已知模型可解析單價', () => {
    const p = resolvePrice('anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(p.inputPerM).toBe(3);
    expect(p.outputPerM).toBe(15);
  });

  test('global 前綴與基礎 id 同價', () => {
    const p = resolvePrice('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(p.inputPerM).toBe(3);
  });

  test('geo 前綴為 global 的 1.10 倍', () => {
    const p = resolvePrice('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(p.inputPerM).toBeCloseTo(3.3, 5);
    expect(p.outputPerM).toBeCloseTo(16.5, 5);
  });

  test('Fail Closed:查不到價拋錯,絕不當 $0', () => {
    expect(() => resolvePrice('unknown.model.v9')).toThrow(PricingError);
    expect(isPriceable('unknown.model.v9')).toBe(false);
  });

  test('computeSpend 依 token 換算', () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const s = computeSpend('anthropic.claude-sonnet-4-5-20250929-v1:0', 1_000_000, 1_000_000);
    expect(s).toBeCloseTo(18, 5);
  });
});

describe('Budget 閘口(Req 7.1/7.2)', () => {
  test('達閾值即超出', () => {
    expect(budgetExceeded({ budgetUsd: 30, spentUsd: 30 })).toBe(true);
    expect(budgetExceeded({ budgetUsd: 30, spentUsd: 30.7 })).toBe(true);
    expect(budgetExceeded({ budgetUsd: 30, spentUsd: 29.9 })).toBe(false);
  });
});
