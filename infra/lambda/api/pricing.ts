/**
 * 單價表(Req 7.3/7.4)—— 把 token 數換算成 Billable Spend 的唯一權威來源。
 * 口徑:Bedrock on-demand、global 端點,每百萬 token 美元價(input / output / 快取寫入 / 快取讀取)。
 * Anthropic 模型的 geo 前綴(us./eu./apac./jp./au.)為 global 的 1.10 倍;其他供應商的 geo
 * inference profile 與基礎價相同(見 resolvePrice)。
 *
 * 2026-10 依 Cost Explorer 實際帳單(us-east-2,USAGE_TYPE 金額 ÷ 用量)校正:
 *  - 非 Anthropic 的 us. profile(Kimi K3、Nova、Pixtral、Llama 4)帳單 = 基礎價,沒有 ×1.1。
 *  - Opus 4.5/4.7/4.8/5 實收 $5/$25(舊表 $15/$75 高估 3 倍);Opus 5.5 $4;Sonnet 5 $2/$10。
 *  - Kimi K3 等模型 Bedrock 會自動快取 prompt:快取寫入 = 1.25× input、快取讀取 = 0.1× input。
 *    這兩項 token 不算在 Converse 的 inputTokens 內,沒計入就會嚴重低估(實測 Kimi K3 帳單
 *    85% 是快取寫入)。
 */
export interface ModelPrice {
  /** 每百萬 input token 美元 */
  inputPerM: number;
  /** 每百萬 output token 美元 */
  outputPerM: number;
  /** 每百萬「寫入 prompt 快取」token 美元(未填 = 1.25 × input)。 */
  cacheWritePerM?: number;
  /** 每百萬「讀取 prompt 快取」token 美元(未填 = 0.1 × input)。 */
  cacheReadPerM?: number;
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
  // 以下由帳單校正(見檔頭);Opus 4.6 / Opus 5.5 / Opus 4.7 / 4.8 的 output 帳單樣本不足,依同代比例推估。
  'anthropic.claude-sonnet-5': { inputPerM: 2, outputPerM: 10 },
  'anthropic.claude-opus-4-1-20250805-v1:0': { inputPerM: 15, outputPerM: 75 },
  'anthropic.claude-opus-4-5-20251101-v1:0': { inputPerM: 5, outputPerM: 25 },
  'anthropic.claude-opus-4-6-v1': { inputPerM: 5, outputPerM: 25 },
  'anthropic.claude-opus-4-7': { inputPerM: 5, outputPerM: 25 },
  'anthropic.claude-opus-4-8': { inputPerM: 5, outputPerM: 25 },
  'anthropic.claude-opus-5': { inputPerM: 5, outputPerM: 25 },
  'anthropic.claude-opus-5-5': { inputPerM: 4, outputPerM: 20 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { inputPerM: 1, outputPerM: 5 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inputPerM: 0.25, outputPerM: 1.25 },
  'anthropic.claude-fable-5': { inputPerM: 1, outputPerM: 5 },
  'anthropic.claude-fable-5-1': { inputPerM: 1, outputPerM: 5 },
  // --- 其餘供應商(AWS Pricing API us-east-2 抓價,標估算)---
  'qwen.qwen3-235b-a22b-2507-v1:0': { inputPerM: 0.22, outputPerM: 0.88, estimated: true },
  'moonshotai.kimi-k2.5': { inputPerM: 0.6, outputPerM: 3.0, estimated: true },
  'openai.gpt-oss-120b-1:0': { inputPerM: 0.15, outputPerM: 0.6, estimated: true },
  'qwen.qwen3-next-80b-a3b': { inputPerM: 0.14, outputPerM: 1.2, estimated: true },
  // 帳單實收:input 3.3 / output 16.5 / 快取寫入 4.125 / 快取讀取 0.33(us. profile 沒有另加 ×1.1)。
  'moonshotai.kimi-k3': { inputPerM: 3.3, outputPerM: 16.5 },
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
/** geo 前綴加價:帳單上只有 Anthropic 模型加收 10%;其他供應商的 geo profile = 基礎價。 */
const GEO_MULTIPLIER = 1.1;
const GEO_PREMIUM_PROVIDERS = ['anthropic.'];
const GLOBAL_PREFIX = 'global.';
/** 快取 token 預設倍率(相對 input 單價),Bedrock 各模型帳單一致。 */
const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;

export class PricingError extends Error {}

/** 一次(或累計)模型呼叫的 token 用量;快取欄位缺省為 0(舊紀錄沒有)。 */
export interface TokenUsage {
  input?: number;
  output?: number;
  /** 讀取 prompt 快取的 token(Converse usage.cacheReadInputTokens)。 */
  cacheRead?: number;
  /** 寫入 prompt 快取的 token(Converse usage.cacheWriteInputTokens)。 */
  cacheWrite?: number;
}

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

/** 解析某 modelId 的當前有效單價(處理 geo 倍率與促銷過期);一定帶快取單價。 */
export function resolvePrice(modelId: string, now = new Date()): ModelPrice & { cacheWritePerM: number; cacheReadPerM: number } {
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
  let cacheWrite = entry.cacheWritePerM ?? input * CACHE_WRITE_FACTOR;
  let cacheRead = entry.cacheReadPerM ?? input * CACHE_READ_FACTOR;
  if (isGeo && GEO_PREMIUM_PROVIDERS.some((p) => base.startsWith(p))) {
    input *= GEO_MULTIPLIER;
    output *= GEO_MULTIPLIER;
    cacheWrite *= GEO_MULTIPLIER;
    cacheRead *= GEO_MULTIPLIER;
  }
  return {
    inputPerM: input,
    outputPerM: output,
    cacheWritePerM: cacheWrite,
    cacheReadPerM: cacheRead,
    ...(entry.estimated ? { estimated: true } : {}),
  };
}

/** 依用量(含快取 token)計算花費(美元)。 */
export function computeUsageSpend(modelId: string, usage: TokenUsage, now = new Date()): number {
  const p = resolvePrice(modelId, now);
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return (
    (n(usage.input) * p.inputPerM +
      n(usage.output) * p.outputPerM +
      n(usage.cacheWrite) * p.cacheWritePerM +
      n(usage.cacheRead) * p.cacheReadPerM) /
    1_000_000
  );
}

/** 計算一次模型呼叫的 Billable Spend(美元)。快取 token 請用 computeUsageSpend。 */
export function computeSpend(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  now = new Date(),
): number {
  return computeUsageSpend(modelId, { input: inputTokens, output: outputTokens }, now);
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
