import { describe, it, expect } from 'vitest';
import {
  defaultSeatSelection,
  resolveExecutionConfig,
  SpendAccumulator,
  PricingError,
  type SeatSelection,
} from '../lambda/engine/costGuard.js';

describe('成本護欄 — 執行配置快照(Req 7.5)', () => {
  it('對可定價的預設選型產生三 Seat 快照,並記下生效後模型與單價', () => {
    const snapshot = resolveExecutionConfig(defaultSeatSelection(), 5);
    expect(snapshot.budgetUsd).toBe(5);
    expect(snapshot.seats.map((s) => s.seat).sort()).toEqual([
      'agent',
      'subagent',
      'vlm',
    ]);
    for (const seat of snapshot.seats) {
      expect(seat.modelId).toBeTruthy();
      expect(seat.channel).toBeTruthy();
      // 生效後模型必可定價(單價已解析、非負)。UI-TARS 走 SageMaker 常駐計費,per-token 為 0,
      // 仍屬可定價(滿足 Fail-Closed 不變式),故只要求「非負」而非「嚴格為正」。
      expect(seat.inputPerM).toBeGreaterThanOrEqual(0);
      expect(seat.outputPerM).toBeGreaterThanOrEqual(0);
    }
    expect(snapshot.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('Fail Closed:任一 Seat 模型查不到價即拋 PricingError(不得以 $0 起跑)', () => {
    const bad: SeatSelection = {
      agent: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      vlm: 'nonexistent.model-xyz', // 單價表查不到
      subagent: 'us.anthropic.claude-3-haiku-20240307-v1:0',
    };
    expect(() => resolveExecutionConfig(bad, 5)).toThrow(PricingError);
  });

  it('預設選型:agent=Nova Lite / vlm=Kimi K3 / subagent=Nova Micro', () => {
    const sel = defaultSeatSelection();
    expect(sel.agent).toBe('us.amazon.nova-lite-v1:0');
    expect(sel.vlm).toBe('us.moonshotai.kimi-k3');
    expect(sel.subagent).toBe('us.amazon.nova-micro-v1:0');
  });

  it('channel 由 modelId 推導寫入快照(預設三 seat 皆走 bedrock-converse)', () => {
    const snapshot = resolveExecutionConfig(defaultSeatSelection(), 1);
    const bySeat = Object.fromEntries(snapshot.seats.map((s) => [s.seat, s.channel]));
    expect(bySeat.vlm).toBe('bedrock-converse');
    expect(bySeat.agent).toBe('bedrock-converse');
    expect(bySeat.subagent).toBe('bedrock-converse');
  });
});

describe('成本護欄 — Billable Spend 累加器(Req 7.1/7.2)', () => {
  const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'; // input 3/output 15 per M, geo x1.1

  it('spentUsd 單調增長,shouldStop 於達閾值時為真', () => {
    const acc = new SpendAccumulator(0.01);
    expect(acc.spentUsd).toBe(0);
    expect(acc.shouldStop()).toBe(false);

    // 一次 100 萬 input token:3 * 1.1 = 3.3 美元,遠超 0.01 閾值。
    acc.add(MODEL, 1_000_000, 0);
    expect(acc.spentUsd).toBeGreaterThan(0);
    expect(acc.shouldStop()).toBe(true);
  });

  it('多次累加只增不減', () => {
    const acc = new SpendAccumulator(100);
    const a = acc.add(MODEL, 1000, 500);
    const b = acc.add(MODEL, 1000, 500);
    expect(b).toBeGreaterThan(a);
    expect(acc.shouldStop()).toBe(false); // 遠低於 100 美元
  });

  it('查不到價的模型累加時 Fail Closed(拋 PricingError)', () => {
    const acc = new SpendAccumulator(100);
    expect(() => acc.add('nonexistent.model-xyz', 1000, 1000)).toThrow(PricingError);
  });
});
