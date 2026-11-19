import { describe, expect, test } from 'vitest';
import { resolvePrice } from '../lambda/api/pricing.js';

/**
 * 價格表對官方價目表的回歸測試。
 *
 * 來源:AWS Price List API(ServiceCode AmazonBedrock / AmazonBedrockFoundationModels,
 * regionCode us-west-2,On-demand Inference、standard tier),2026-11-18 取得。
 * 平台用 us. 前綴(或不加前綴)呼叫,所以對應的是官方「Standard / 非 Global」那一欄。
 *
 * 這裡列的是那次逐筆比對時錯掉的 13 個模型,以及幾個預設會用到的模型。
 * 官方價格改了就改這裡,並在註解寫來源與日期。
 */
const OFFICIAL: Array<[string, { in: number; out: number; cw: number; cr: number }]> = [
  // 舊 Anthropic 模型:geo 與 Global 同價,沒有 +10%(舊表多收 10%)。
  ['us.anthropic.claude-sonnet-4-20250514-v1:0', { in: 3, out: 15, cw: 3.75, cr: 0.3 }],
  ['us.anthropic.claude-opus-4-1-20250805-v1:0', { in: 15, out: 75, cw: 18.75, cr: 1.5 }],
  ['us.anthropic.claude-3-haiku-20240307-v1:0', { in: 0.25, out: 1.25, cw: 0.3125, cr: 0.025 }],
  // Fable:舊表低估 10 倍。
  ['us.anthropic.claude-fable-5', { in: 11, out: 55, cw: 13.75, cr: 1.1 }],
  ['us.anthropic.claude-fable-5-1', { in: 11, out: 55, cw: 13.75, cr: 0.275 }],
  // Opus 5.5:快取讀取是 input 的 5%。
  ['us.anthropic.claude-opus-5-5', { in: 4.4, out: 22, cw: 5.5, cr: 0.22 }],
  // Nova:快取寫入 $0、讀取 = input 的 25%。
  ['us.amazon.nova-pro-v1:0', { in: 0.8, out: 3.2, cw: 0, cr: 0.2 }],
  ['us.amazon.nova-lite-v1:0', { in: 0.06, out: 0.24, cw: 0, cr: 0.015 }],
  ['amazon.nova-lite-v1:0', { in: 0.06, out: 0.24, cw: 0, cr: 0.015 }],
  ['us.amazon.nova-micro-v1:0', { in: 0.035, out: 0.14, cw: 0, cr: 0.00875 }],
  ['us.amazon.nova-2-lite-v1:0', { in: 0.33, out: 2.75, cw: 0, cr: 0.0825 }],
  // Grok:快取讀取 = input 的 25%。
  ['xai.grok-4.7', { in: 2.2, out: 6.6, cw: 2.75, cr: 0.55 }],
  ['xai.grok-4.6', { in: 2.2, out: 6.6, cw: 2.75, cr: 0.55 }],
  // 預設與常用模型(比對時已正確,一併釘住)。
  ['us.anthropic.claude-sonnet-4-6', { in: 3.3, out: 16.5, cw: 4.125, cr: 0.33 }],
  ['us.anthropic.claude-sonnet-5', { in: 2.2, out: 11, cw: 2.75, cr: 0.22 }],
  ['us.anthropic.claude-haiku-4-5-20251001-v1:0', { in: 1.1, out: 5.5, cw: 1.375, cr: 0.11 }],
  ['us.anthropic.claude-opus-4-5-20251101-v1:0', { in: 5.5, out: 27.5, cw: 6.875, cr: 0.55 }],
  ['us.moonshotai.kimi-k3', { in: 3.3, out: 16.5, cw: 4.125, cr: 0.33 }],
  ['us.openai.gpt-5.6-luna', { in: 0.22, out: 1.32, cw: 0.275, cr: 0.022 }],
];

describe('單價表 = 官方價目表(us-west-2 on-demand standard)', () => {
  test.each(OFFICIAL)('%s', (id, want) => {
    const p = resolvePrice(id);
    expect(p.inputPerM).toBeCloseTo(want.in, 6);
    expect(p.outputPerM).toBeCloseTo(want.out, 6);
    expect(p.cacheWritePerM).toBeCloseTo(want.cw, 6);
    expect(p.cacheReadPerM).toBeCloseTo(want.cr, 6);
  });

  test('Anthropic 新模型的 us. 價仍是 Global 的 1.1 倍', () => {
    expect(resolvePrice('us.anthropic.claude-sonnet-4-6').inputPerM).toBeCloseTo(resolvePrice('anthropic.claude-sonnet-4-6').inputPerM * 1.1, 6);
  });
});
