/**
 * 單價表(Req 7.3/7.4)—— 把 token 數換算成 Billable Spend 的唯一權威來源。
 * 口徑:Bedrock on-demand、global 端點,每百萬 token 美元價(input / output)。
 * geo 前綴(us./eu./apac./jp./au.)為 global 的 1.10 倍(見 resolvePrice)。
 */
export interface ModelPrice {
  /** 每百萬 input token 美元 */
  inputPerM: number;
  /** 每百萬 output token 美元 */
  outputPerM: number;
  /** 是否為估算價(報告標「估算」) */
  estimated?: boolean;
  /** 促銷價失效日(過期後改標準價),ISO 日期 */
  promoUntil?: string;
  /** 促銷失效後的標準價 */
  standardAfterPromo?: { inputPerM: number; outputPerM: number };
}

/**
 * 以「去前綴」的基礎 modelId 為鍵。geo 前綴在 resolvePrice 處理。
 * Anthropic Claude:公開 list 價(權威)。其餘供應商:由 AWS Pricing API(us-east-2 on-demand)
 * 於建表時抓取,標 estimated=true(報告顯示「估算」)——實際計費仍以 Bedrock 為準,估算價僅供護欄與呈現。
 * 要更新價格:重跑 Pricing API 抓價腳本後同步此表。此表為 Model Catalog 的定價前提(catalog ⊆ 此表)。
 */
const TABLE: Record<string, ModelPrice> = {
  // --- Anthropic Claude(公開 list 價)---
  'anthropic.claude-sonnet-4-5-20250929-v1:0': { inputPerM: 3, outputPerM: 15 },
  'anthropic.claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'anthropic.claude-sonnet-4-20250514-v1:0': { inputPerM: 3, outputPerM: 15 },
  'anthropic.claude-sonnet-5': { inputPerM: 3, outputPerM: 15 },
  'anthropic.claude-opus-4-1-20250805-v1:0': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-4-5-20251101-v1:0': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-4-6-v1': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-4-7': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-4-8': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-5': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-5-5': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { inputPerM: 1, outputPerM: 5 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inputPerM: 0.25, outputPerM: 1.25 },
  'anthropic.claude-fable-5': { inputPerM: 1, outputPerM: 5 },
  'anthropic.claude-fable-5-1': { inputPerM: 1, outputPerM: 5 },
  // --- 其餘供應商(AWS Pricing API us-east-2 抓價,標估算)---
  'qwen.qwen3-235b-a22b-2507-v1:0': { inputPerM: 0.22, outputPerM: 0.88, estimated: true },
  'moonshotai.kimi-k2.5': { inputPerM: 0.6, outputPerM: 3.0, estimated: true },
  'openai.gpt-oss-120b-1:0': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'qwen.qwen3-next-80b-a3b': { inputPerM: 0.14, outputPerM: 1.2, estimated: true },
  'moonshotai.kimi-k3': { inputPerM: 3.3, outputPerM: 16.5, estimated: true },
  'deepseek.v3.2': { inputPerM: 0.62, outputPerM: 1.85, estimated: true },
  'nvidia.nemotron-nano-3-30b': { inputPerM: 0.06, outputPerM: 0.24, estimated: true },
  'minimax.minimax-m2': { inputPerM: 0.3, outputPerM: 1.2, estimated: true },
  'zai.glm-4.7-flash': { inputPerM: 0.07, outputPerM: 0.4, estimated: true },
  'amazon.nova-pro-v1:0': { inputPerM: 0.8, outputPerM: 3.2, estimated: true },
  'minimax.minimax-m2.5': { inputPerM: 0.3, outputPerM: 1.2, estimated: true },
  'google.gemma-3-12b-it': { inputPerM: 0.09, outputPerM: 0.29, estimated: true },
  'moonshot.kimi-k2-thinking': { inputPerM: 0.6, outputPerM: 2.5, estimated: true },
  'mistral.mistral-large-3-675b-instruct': { inputPerM: 0.5, outputPerM: 1.5, estimated: true },
  'mistral.devstral-2-123b': { inputPerM: 0.4, outputPerM: 2.0, estimated: true },
  'minimax.minimax-m2.1': { inputPerM: 0.3, outputPerM: 1.2, estimated: true },
  'nvidia.nemotron-super-3-120b': { inputPerM: 0.15, outputPerM: 0.65, estimated: true },
  'qwen.qwen3-32b-v1:0': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'mistral.ministral-3-14b-instruct': { inputPerM: 0.2, outputPerM: 0.2, estimated: true },
  'zai.glm-5': { inputPerM: 1.0, outputPerM: 3.2, estimated: true },
  'openai.gpt-oss-20b-1:0': { inputPerM: 0.07, outputPerM: 0.3, estimated: true },
  'google.gemma-3-4b-it': { inputPerM: 0.04, outputPerM: 0.08, estimated: true },
  'openai.gpt-oss-safeguard-120b': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'google.gemma-3-27b-it': { inputPerM: 0.23, outputPerM: 0.38, estimated: true },
  'qwen.qwen3-vl-235b-a22b': { inputPerM: 0.53, outputPerM: 2.66, estimated: true },
  // UI-TARS 自建 SageMaker endpoint:成本是「每小時 GPU 常駐費」(g6e.xlarge ~US$1.86/hr),
  // 非 per-token。token 價設 0 以滿足 catalog 可定價不變式;實際成本由 endpoint 開機時數計,另行掌握。
  'uitars': { inputPerM: 0, outputPerM: 0, estimated: true },
  'zai.glm-4.7': { inputPerM: 0.6, outputPerM: 2.2, estimated: true },
  'writer.palmyra-vision-7b': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'qwen.qwen3-coder-480b-a35b-v1:0': { inputPerM: 0.45, outputPerM: 1.8, estimated: true },
  'deepseek.v3-v1:0': { inputPerM: 0.58, outputPerM: 1.68, estimated: true },
  'mistral.ministral-3-3b-instruct': { inputPerM: 0.1, outputPerM: 0.1, estimated: true },
  'qwen.qwen3-coder-30b-a3b-v1:0': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'openai.gpt-oss-safeguard-20b': { inputPerM: 0.07, outputPerM: 0.2, estimated: true },
  'amazon.nova-lite-v1:0': { inputPerM: 0.06, outputPerM: 0.24, estimated: true },
  'amazon.nova-micro-v1:0': { inputPerM: 0.035, outputPerM: 0.14, estimated: true },
  'deepseek.r1-v1:0': { inputPerM: 1.35, outputPerM: 5.4, estimated: true },
  'mistral.pixtral-large-2502-v1:0': { inputPerM: 2.0, outputPerM: 6.0, estimated: true },
  'meta.llama3-1-8b-instruct-v1:0:128k': { inputPerM: 0.22, outputPerM: 0.22, estimated: true },
  'meta.llama3-1-8b-instruct-v1:0': { inputPerM: 0.22, outputPerM: 0.22, estimated: true },
  'meta.llama3-1-70b-instruct-v1:0:128k': { inputPerM: 0.72, outputPerM: 0.72, estimated: true },
  'meta.llama3-1-70b-instruct-v1:0': { inputPerM: 0.72, outputPerM: 0.72, estimated: true },
  'meta.llama3-3-70b-instruct-v1:0': { inputPerM: 0.72, outputPerM: 0.72, estimated: true },
  'meta.llama4-scout-17b-instruct-v1:0': { inputPerM: 0.17, outputPerM: 0.66, estimated: true },
  'meta.llama4-maverick-17b-instruct-v1:0': { inputPerM: 0.24, outputPerM: 0.97, estimated: true },
};

const GEO_PREFIXES = ['us.', 'eu.', 'apac.', 'jp.', 'au.'];
const GEO_MULTIPLIER = 1.1;
const GLOBAL_PREFIX = 'global.';

export class PricingError extends Error {}

/** 去掉 geo/global 前綴,回傳 [基礎 id, 是否 geo]。 */
function stripPrefix(modelId: string): { base: string; isGeo: boolean } {
  for (const p of GEO_PREFIXES) {
    if (modelId.startsWith(p)) return { base: modelId.slice(p.length), isGeo: true };
  }
  if (modelId.startsWith(GLOBAL_PREFIX)) {
    return { base: modelId.slice(GLOBAL_PREFIX.length), isGeo: false };
  }
  return { base: modelId, isGeo: false };
}

/** 解析某 modelId 的當前有效單價(處理 geo 倍率與促銷過期)。 */
export function resolvePrice(modelId: string, now = new Date()): ModelPrice {
  const { base, isGeo } = stripPrefix(modelId);
  const entry = TABLE[base];
  if (!entry) {
    // Fail Closed(Req 7.3):查不到價 → 拋錯,由呼叫端拒絕執行或按保守上限。
    throw new PricingError(`單價表查無此模型:${modelId}`);
  }
  let input = entry.inputPerM;
  let output = entry.outputPerM;
  // 促銷過期切標準價
  if (entry.promoUntil && entry.standardAfterPromo && now > new Date(entry.promoUntil)) {
    input = entry.standardAfterPromo.inputPerM;
    output = entry.standardAfterPromo.outputPerM;
  }
  if (isGeo) {
    input *= GEO_MULTIPLIER;
    output *= GEO_MULTIPLIER;
  }
  return { inputPerM: input, outputPerM: output, ...(entry.estimated ? { estimated: true } : {}) };
}

/** 計算一次模型呼叫的 Billable Spend(美元)。 */
export function computeSpend(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  now = new Date(),
): number {
  const price = resolvePrice(modelId, now);
  return (
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM
  );
}

/** modelId 是否可定價(供下拉/啟動斷言:下拉可選必在單價表)。 */
export function isPriceable(modelId: string): boolean {
  try {
    resolvePrice(modelId);
    return true;
  } catch {
    return false;
  }
}

export interface BudgetGate {
  budgetUsd: number;
  spentUsd: number;
}

/** Budget 閘口(Req 7.1/7.2):達到閾值即停(在迭代頂部判定,接受略微超出)。 */
export function budgetExceeded(gate: BudgetGate): boolean {
  return gate.spentUsd >= gate.budgetUsd;
}
