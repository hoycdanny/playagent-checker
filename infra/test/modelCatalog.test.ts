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
});
