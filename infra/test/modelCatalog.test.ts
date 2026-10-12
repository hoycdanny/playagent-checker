import { describe, test, expect } from 'vitest';
import {
  CATALOG,
  channelFromModelId,
  modelsForSeat,
  unpriceableCatalogEntries,
} from '../lambda/api/modelCatalog.js';

describe('Model Catalog(Req 8)', () => {
  test('下拉可選的每個模型都必須在單價表查得到價(Req 8.3 邊界)', () => {
    expect(unpriceableCatalogEntries()).toEqual([]);
  });

  test('Channel 由 modelId 推導(Req 8.2)', () => {
    expect(channelFromModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('bedrock');
    expect(channelFromModelId('openai.gpt-5.5')).toBe('openai');
    expect(channelFromModelId('apac.qwen.qwen-max')).toBe('bedrock-converse');
    expect(channelFromModelId('us.amazon.nova-pro-v1:0')).toBe('bedrock-converse');
  });

  test('依 Seat 過濾模型', () => {
    const agentModels = modelsForSeat('agent');
    expect(agentModels.length).toBeGreaterThan(0);
    expect(agentModels.every((m) => m.seats.includes('agent'))).toBe(true);
    const subModels = modelsForSeat('subagent');
    expect(subModels.some((m) => m.displayName.includes('Haiku'))).toBe(true);
  });

  test('每個項目都記座標系(實測值,Req 8.4)', () => {
    for (const e of CATALOG) {
      expect(['norm1000', 'pixel']).toContain(e.coordSystem);
    }
  });

  /**
   * `us.` 前綴是**逐模型**的事實,不是供應商規則:on-demand 上架的要直呼,
   * 只給 inference profile 的才加前綴。兩邊猜錯都是同一句
   * 「The provided model identifier is invalid.」,而且要等任務跑起來才炸
   * (job-mv4ogljf-t6izg9 就是 us.mistral.mistral-large-3 這樣死的)。
   * 下列對照以 us-east-2 實呼驗證過;要重新驗證跑 infra/scripts/check-model-ids.mjs --invoke。
   */
  describe('可呼叫 id 的前綴(2026-10-12 於 us-east-2 實呼驗證)', () => {
    const idOf = (displayName: string) => CATALOG.find((e) => e.displayName === displayName)?.modelId;

    test('on-demand 模型直呼,不加 us.', () => {
      expect(idOf('Mistral Large 3')).toBe('mistral.mistral-large-3-675b-instruct');
      expect(idOf('Ministral 14B 3.0')).toBe('mistral.ministral-3-14b-instruct');
      expect(idOf('Ministral 3B')).toBe('mistral.ministral-3-3b-instruct');
      expect(idOf('Devstral 2 123B')).toBe('mistral.devstral-2-123b');
      expect(idOf('Palmyra Vision 7B')).toBe('writer.palmyra-vision-7b');
      expect(idOf('Kimi K2.5')).toBe('moonshotai.kimi-k2.5');
    });

    test('profile-only 模型加 us.(含同供應商內的特例)', () => {
      expect(idOf('Pixtral Large 25.02')).toBe('us.mistral.pixtral-large-2502-v1:0');
      expect(idOf('DeepSeek R1')).toBe('us.deepseek.r1-v1:0');
      expect(idOf('Kimi K3')).toBe('us.moonshotai.kimi-k3');
      expect(idOf('Claude Sonnet 4.5')).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(idOf('Nova Lite')).toBe('us.amazon.nova-lite-v1:0');
      expect(idOf('Llama 3.3 70B')).toBe('us.meta.llama3-3-70b-instruct-v1:0');
    });

    test('同供應商可以混用兩種形式(mistral / deepseek / moonshotai)', () => {
      const prefixed = (name: string) => idOf(name)?.startsWith('us.');
      expect(prefixed('Pixtral Large 25.02')).toBe(true);
      expect(prefixed('Mistral Large 3')).toBe(false);
      expect(prefixed('DeepSeek R1')).toBe(true);
      expect(prefixed('DeepSeek V3.1')).toBe(false);
      expect(prefixed('Kimi K3')).toBe(true);
      expect(prefixed('Kimi K2.5')).toBe(false);
    });

    test('沒有任何 id 被加兩層前綴', () => {
      for (const e of CATALOG) expect(e.modelId).not.toMatch(/^us\.us\./);
    });
  });
});
