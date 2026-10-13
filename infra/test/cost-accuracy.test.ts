import { describe, expect, test } from 'vitest';
import { computeUsageSpend, resolvePrice } from '../lambda/api/pricing.js';
import { parseScriptProgress, priceMap, spendBySeat } from '../lambda/api/tasks.js';
import { getRealCost } from '../lambda/api/cost.js';
import { accumulate, addUsage, createUsageLedger, mergeByModel, usageFromAnthropic, usageFromConverse } from '../../agent/tokenUsage.mjs';

/**
 * 依 2026-10 Cost Explorer 帳單(us-east-2,USAGE_TYPE 金額 ÷ 用量)反推的實收單價:
 *   kimi-k3 input 3.3 / output 16.5 / cache-write 4.125 / cache-read 0.33
 *   Claude Sonnet 4.5(us.)input 3.3、Opus 5(global)5 / 25 / cache-write 6.25 / cache-read 0.5
 *   Nova Lite(us.)0.06 / 0.24、Pixtral(us.)2.0
 */
describe('prices match what AWS actually billed', () => {
  test('non-Anthropic geo profiles are billed at the base price (no ×1.1)', () => {
    expect(resolvePrice('us.moonshotai.kimi-k3')).toMatchObject({ inputPerM: 3.3, outputPerM: 16.5 });
    expect(resolvePrice('us.amazon.nova-lite-v1:0')).toMatchObject({ inputPerM: 0.06, outputPerM: 0.24 });
    expect(resolvePrice('us.mistral.pixtral-large-2502-v1:0').inputPerM).toBe(2);
  });

  test('Anthropic geo profiles keep the 10% premium', () => {
    const p = resolvePrice('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(p.inputPerM).toBeCloseTo(3.3, 6);
    expect(p.outputPerM).toBeCloseTo(16.5, 6);
    expect(resolvePrice('us.anthropic.claude-sonnet-5').inputPerM).toBeCloseTo(2.2, 6);
    expect(resolvePrice('us.anthropic.claude-opus-5').inputPerM).toBeCloseTo(5.5, 6);
  });

  test('Opus 4.5+ is $5/$25, not $15/$75', () => {
    expect(resolvePrice('global.anthropic.claude-opus-5')).toMatchObject({ inputPerM: 5, outputPerM: 25, cacheWritePerM: 6.25, cacheReadPerM: 0.5 });
    expect(resolvePrice('anthropic.claude-opus-4-5-20251101-v1:0')).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  test('cache tokens: write 1.25× input, read 0.1× input', () => {
    const p = resolvePrice('us.moonshotai.kimi-k3');
    expect(p.cacheWritePerM).toBeCloseTo(4.125, 6);
    expect(p.cacheReadPerM).toBeCloseTo(0.33, 6);
    // 一百萬各類 token:3.3 + 16.5 + 4.125 + 0.33
    expect(computeUsageSpend('us.moonshotai.kimi-k3', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 })).toBeCloseTo(24.255, 6);
  });
});

describe('runner token accounting includes cache tokens', () => {
  test('Converse usage (real Kimi K3 response shape)', () => {
    // 實測:2,900 token 的請求,inputTokens 只有 7,其餘在快取欄位。
    const first = usageFromConverse({ inputTokens: 7, outputTokens: 20, totalTokens: 2927, cacheReadInputTokens: 0, cacheWriteInputTokens: 2900 });
    const second = usageFromConverse({ inputTokens: 7, outputTokens: 20, cacheReadInputTokens: 2879, cacheWriteInputTokens: 21 });
    expect(first).toEqual({ input: 7, output: 20, cacheRead: 0, cacheWrite: 2900 });
    const both = addUsage(first, second);
    expect(both).toEqual({ input: 14, output: 40, cacheRead: 2879, cacheWrite: 2921 });
    // 只算 inputTokens 的舊算法 vs 含快取:差十幾倍。
    const old = computeUsageSpend('us.moonshotai.kimi-k3', { input: both.input, output: both.output });
    const now = computeUsageSpend('us.moonshotai.kimi-k3', both);
    expect(now / old).toBeGreaterThan(10);
  });

  test('Anthropic InvokeModel usage', () => {
    expect(usageFromAnthropic({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }))
      .toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 50 });
    expect(usageFromAnthropic(undefined)).toBeNull();
  });

  test('ledger keeps the fallback model separate', () => {
    const ledger = createUsageLedger();
    ledger.add('us.moonshotai.kimi-k3', { input: 10, output: 1, cacheWrite: 1000 });
    ledger.add('us.anthropic.claude-sonnet-4-5-20250929-v1:0', { input: 2000, output: 100 });
    ledger.add('us.moonshotai.kimi-k3', { input: 5, output: 1, cacheRead: 900 });
    expect(ledger.byModel()).toEqual({
      'us.moonshotai.kimi-k3': { input: 15, output: 2, cacheRead: 900, cacheWrite: 1000 },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 },
    });
    expect(mergeByModel({ a: { input: 1 } }, { a: { input: 2, cacheRead: 3 }, b: { output: 4 } }))
      .toEqual({ a: { input: 3, output: 0, cacheRead: 3, cacheWrite: 0 }, b: { input: 0, output: 4, cacheRead: 0, cacheWrite: 0 } });
    expect(accumulate({ input: 1, output: 1 }, { cacheWrite: 5 })).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 5 });
  });
});

describe('per-task spend', () => {
  test('tokensByModel prices every model it actually called, cache included', () => {
    const report = {
      tokensBySeat: { vlm: { input: 1e6, output: 0 } },
      seatModels: { vlm: 'us.moonshotai.kimi-k3' },
      tokensByModel: {
        'us.moonshotai.kimi-k3': { input: 0, output: 0, cacheWrite: 1e6, cacheRead: 0 },
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 1e6, output: 0 },
      },
    };
    // 4.125(Kimi 快取寫入)+ 3.3(備援 Claude 的輸入)—— 不是 tokensBySeat 的 1M × Kimi 3.3。
    expect(spendBySeat(report, () => undefined)).toBeCloseTo(7.425, 6);
  });

  test('per-seat tokens with cache fields (no tokensByModel)', () => {
    const report = { tokensBySeat: { vlm: { input: 0, output: 0, cacheWrite: 1e6 } }, seatModels: { vlm: 'us.moonshotai.kimi-k3' } };
    expect(spendBySeat(report, () => undefined)).toBeCloseTo(4.125, 6);
  });

  test('priceMap: current prices incl. cache; unknown models skipped', () => {
    const m = priceMap(['us.moonshotai.kimi-k3', 'unknown.model', 'us.moonshotai.kimi-k3']);
    expect(Object.keys(m)).toEqual(['us.moonshotai.kimi-k3']);
    expect(m['us.moonshotai.kimi-k3']!.cacheWritePerM).toBeCloseTo(4.125, 6);
  });
});

describe('live script progress (status.json)', () => {
  test('parseScriptProgress validates and clamps', () => {
    expect(parseScriptProgress({ items: ['a', 'b', 'c'], current: 2, done: 1 })).toEqual({ items: ['a', 'b', 'c'], current: 2, done: 1 });
    expect(parseScriptProgress({ items: ['a', 'b'], current: 9, done: -3 })).toEqual({ items: ['a', 'b'], current: 2, done: 0 });
    expect(parseScriptProgress({ items: ['only one'], current: 1, done: 0 })).toBeUndefined();
    expect(parseScriptProgress('nope')).toBeUndefined();
  });
});

describe('Cost Explorer: Bedrock reference bill', () => {
  function fakeCe(failBedrock = false) {
    const inputs: Array<Record<string, unknown>> = [];
    return {
      inputs,
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input);
        const f = JSON.stringify(cmd.input['Filter'] ?? {});
        if (f.includes('"REGION"')) {
          if (failBedrock) throw new Error('denied');
          return { ResultsByTime: [{ Groups: [
            { Keys: ['USE2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard'], Metrics: { UnblendedCost: { Amount: '1162.57' }, UsageQuantity: { Amount: '281836.1', Unit: '1K tokens' } } },
            { Keys: ['USE2-moonshotai.kimi-k3-mantle-input-tokens-standard'], Metrics: { UnblendedCost: { Amount: '96.2' }, UsageQuantity: { Amount: '29150.3', Unit: '1K tokens' } } },
          ] }] };
        }
        return { ResultsByTime: [] };
      },
    };
  }

  test('queries Bedrock in the deploy region and keeps it out of the project total', async () => {
    const ce = fakeCe();
    const real = await getRealCost(ce as never, { bedrockRegion: 'us-east-2', now: new Date('2026-10-14T00:00:00Z') });
    expect(real.bedrock?.region).toBe('us-east-2');
    expect(real.bedrock?.totalUsd).toBeCloseTo(1258.77, 2);
    expect(real.bedrock?.byUsageType[0]!.usageType).toContain('cache-write');
    expect(real.totalUsd).toBe(0);
    const q = ce.inputs.find((i) => JSON.stringify(i['Filter']).includes('"REGION"'))!;
    expect(JSON.stringify(q['Filter'])).toContain('Amazon Bedrock');
    expect(JSON.stringify(q['Filter'])).toContain('us-east-2');
  });

  test('a Bedrock query failure does not break the rest', async () => {
    const real = await getRealCost(fakeCe(true) as never, { bedrockRegion: 'us-east-2' });
    expect(real.available).toBe(true);
    expect(real.bedrock).toBeUndefined();
  });

  test('no region → no Bedrock query', async () => {
    const ce = fakeCe();
    await getRealCost(ce as never, {});
    expect(ce.inputs.some((i) => JSON.stringify(i['Filter']).includes('"REGION"'))).toBe(false);
  });
});
