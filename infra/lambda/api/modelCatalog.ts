import { isPriceable } from './pricing.js';

/** 三個 Seat(職責,非 provider)。 */
export type Seat = 'agent' | 'vlm' | 'subagent';

/** Channel(SDK+端點+認證組合),由 modelId 推導,非使用者選擇(Req 8.2)。
 *  sagemaker = 自建 SageMaker real-time endpoint(UI-TARS GUI grounding),非 Bedrock。 */
export type Channel = 'bedrock' | 'bedrock-converse' | 'openai' | 'sagemaker';

/** 座標系:千分制 vs 像素(以實測值寫入,Req 8.4)。 */
export type CoordSystem = 'norm1000' | 'pixel';

export interface CatalogEntry {
  modelId: string;
  displayName: string;
  channel: Channel;
  regions: string[];
  coordSystem: CoordSystem;
  /** 可坐哪些 Seat。 */
  seats: Seat[];
}

/**
 * Model Catalog(Req 8.3)—— 下拉、客戶端建構、區域校驗共用的唯一權威。
 * 每個項目都必須在單價表查得到價(啟動斷言 assertCatalogPriceable 確保)。
 * 座標系為實測值(Req 8.4):Claude 系為像素;千分制模型須實測後標 norm1000。
 */
/**
 * Model Catalog 原始規格(modelId 去掉 us. 前綴前的清單由 list-foundation-models(us-east-2)實測而來)。
 * seats:有視覺(input 含 IMAGE)的模型才可坐 vlm(要看截圖判座標);純文字模型只坐 agent/subagent。
 * coordSystem:Anthropic Claude 系實測為像素;其餘供應商未逐一實測,暫標 norm1000(千分制)——
 *   若某模型座標系經實測為像素,改這裡即可。channel 一律由 modelId 推導(使用者不選)。
 * 每個 modelId 都必須在 pricing 表查得到價(unpriceableCatalogEntries 啟動斷言保證)。
 */
type CatalogSpec = Omit<CatalogEntry, 'channel'>;

const CATALOG_SPECS: CatalogSpec[] = [
  // --- Anthropic Claude(座標系實測=像素,list 價權威)---
  // 注意:modelId 一律寫「基礎 id(無 us. 前綴)」;正確前綴由 applyRegionPrefix 依供應商集中套用。
  { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', displayName: 'Claude Sonnet 4.5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', displayName: 'Claude Sonnet 4', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-sonnet-5', displayName: 'Claude Sonnet 5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-4-1-20250805-v1:0', displayName: 'Claude Opus 4.1', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-4-5-20251101-v1:0', displayName: 'Claude Opus 4.5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-4-6-v1', displayName: 'Claude Opus 4.6', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-4-7', displayName: 'Claude Opus 4.7', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-4-8', displayName: 'Claude Opus 4.8', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-5', displayName: 'Claude Opus 5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-opus-5-5', displayName: 'Claude Opus 5.5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Claude Haiku 4.5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-3-haiku-20240307-v1:0', displayName: 'Claude 3 Haiku', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['subagent'] },
  { modelId: 'anthropic.claude-fable-5', displayName: 'Claude Fable 5', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'anthropic.claude-fable-5-1', displayName: 'Claude Fable 5.1', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['agent', 'vlm', 'subagent'] },
  // --- 視覺模型(可坐 vlm/agent/subagent;座標系未實測,標 norm1000)---
  { modelId: 'amazon.nova-pro-v1:0', displayName: 'Nova Pro', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'amazon.nova-lite-v1:0', displayName: 'Nova Lite', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'meta.llama4-scout-17b-instruct-v1:0', displayName: 'Llama 4 Scout 17B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'meta.llama4-maverick-17b-instruct-v1:0', displayName: 'Llama 4 Maverick 17B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'qwen.qwen3-vl-235b-a22b', displayName: 'Qwen3 VL 235B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  // UI-TARS-1.5-7B:專為 GUI grounding 微調,部署在 SageMaker(非 Bedrock)。座標=smart-resize 幀絕對像素。
  // 只坐 vlm(定位);channel=sagemaker,engine 依 vlmModel==='uitars' 把 endpoint 名傳給 runner。
  { modelId: 'uitars', displayName: 'UI-TARS 1.5 7B(SageMaker · 定位專用)', regions: ['us-east-2'], coordSystem: 'pixel', seats: ['vlm'] },
  { modelId: 'mistral.pixtral-large-2502-v1:0', displayName: 'Pixtral Large 25.02', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'google.gemma-3-27b-it', displayName: 'Gemma 3 27B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'google.gemma-3-12b-it', displayName: 'Gemma 3 12B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'google.gemma-3-4b-it', displayName: 'Gemma 3 4B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['vlm', 'subagent'] },
  { modelId: 'moonshotai.kimi-k2.5', displayName: 'Kimi K2.5', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'mistral.mistral-large-3-675b-instruct', displayName: 'Mistral Large 3', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'mistral.ministral-3-14b-instruct', displayName: 'Ministral 14B 3.0', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'vlm', 'subagent'] },
  { modelId: 'mistral.ministral-3-3b-instruct', displayName: 'Ministral 3B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['vlm', 'subagent'] },
  { modelId: 'writer.palmyra-vision-7b', displayName: 'Palmyra Vision 7B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['vlm', 'subagent'] },
  // --- 純文字模型(只坐 agent/subagent,不看畫面)---
  { modelId: 'qwen.qwen3-235b-a22b-2507-v1:0', displayName: 'Qwen3 235B A22B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'qwen.qwen3-next-80b-a3b', displayName: 'Qwen3 Next 80B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'qwen.qwen3-32b-v1:0', displayName: 'Qwen3 32B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'qwen.qwen3-coder-480b-a35b-v1:0', displayName: 'Qwen3 Coder 480B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'qwen.qwen3-coder-30b-a3b-v1:0', displayName: 'Qwen3 Coder 30B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'deepseek.v3.2', displayName: 'DeepSeek V3.2', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'deepseek.v3-v1:0', displayName: 'DeepSeek V3.1', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'deepseek.r1-v1:0', displayName: 'DeepSeek R1', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'minimax.minimax-m2', displayName: 'MiniMax M2', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'minimax.minimax-m2.1', displayName: 'MiniMax M2.1', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'minimax.minimax-m2.5', displayName: 'MiniMax M2.5', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'moonshot.kimi-k2-thinking', displayName: 'Kimi K2 Thinking', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'zai.glm-5', displayName: 'GLM 5', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'zai.glm-4.7', displayName: 'GLM 4.7', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'zai.glm-4.7-flash', displayName: 'GLM 4.7 Flash', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'openai.gpt-oss-120b-1:0', displayName: 'gpt-oss-120b', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'openai.gpt-oss-20b-1:0', displayName: 'gpt-oss-20b', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'openai.gpt-oss-safeguard-120b', displayName: 'gpt-oss Safeguard 120B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'openai.gpt-oss-safeguard-20b', displayName: 'gpt-oss Safeguard 20B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'nvidia.nemotron-super-3-120b', displayName: 'Nemotron 3 Super 120B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'nvidia.nemotron-nano-3-30b', displayName: 'Nemotron Nano 3 30B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'mistral.devstral-2-123b', displayName: 'Devstral 2 123B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'amazon.nova-micro-v1:0', displayName: 'Nova Micro', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
  { modelId: 'meta.llama3-3-70b-instruct-v1:0', displayName: 'Llama 3.3 70B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'meta.llama3-1-70b-instruct-v1:0', displayName: 'Llama 3.1 70B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['agent', 'subagent'] },
  { modelId: 'meta.llama3-1-8b-instruct-v1:0', displayName: 'Llama 3.1 8B', regions: ['us-east-2'], coordSystem: 'norm1000', seats: ['subagent'] },
];

/**
 * 需要 `us.` 跨區推論設定檔前綴才能呼叫的供應商(其餘用原始 foundation-model id,不可加前綴)。
 * 此清單由 Bedrock us-east-2 實測(bedrock-runtime converse 兩種 id 形式對照)得出:
 * - 需前綴:anthropic / amazon / meta / mistral / writer
 * - 不可加前綴:qwen / google / moonshotai / moonshot / minimax / nvidia / openai / deepseek / zai
 * 加錯前綴會導致 ValidationException: invalid model identifier。
 */
const PREFIXED_PROVIDERS = new Set(['anthropic', 'amazon', 'meta', 'mistral', 'writer']);
const REGION_PREFIX = 'us.';

/** 去掉任何 geo/global 前綴,回傳基礎 id(供推供應商/單價鍵)。 */
function stripRegionPrefix(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|jp|au|global)\./, '');
}

/** 依供應商套用正確前綴(實測規則):該加的加 us.,不該加的維持原始 id。 */
function applyRegionPrefix(baseId: string): string {
  const provider = baseId.split('.')[0] ?? '';
  return PREFIXED_PROVIDERS.has(provider) ? `${REGION_PREFIX}${baseId}` : baseId;
}

// CATALOG_SPECS 的 modelId 一律以「基礎 id(無前綴)」撰寫;此處集中套用正確前綴,
// 成為對外唯一權威的可呼叫 id。避免逐條手寫前綴出錯。
export const CATALOG: CatalogEntry[] = CATALOG_SPECS.map((s) => {
  const modelId = applyRegionPrefix(s.modelId);
  return { ...s, modelId, channel: channelFromModelId(modelId) };
});

/** 由 modelId 推導 Channel(Req 8.2)—— 使用者不選 Channel。 */
export function channelFromModelId(modelId: string): Channel {
  const base = stripRegionPrefix(modelId);
  if (base === 'uitars') return 'sagemaker'; // 自建 SageMaker endpoint,非 Bedrock
  if (base.startsWith('anthropic.')) return 'bedrock';
  if (base.startsWith('openai.')) return 'openai';
  // Nova / Qwen / Llama / DeepSeek 等走 Converse
  return 'bedrock-converse';
}

/** 某 Seat 可選的模型(下拉清單來源)。 */
export function modelsForSeat(seat: Seat): CatalogEntry[] {
  return CATALOG.filter((e) => e.seats.includes(seat));
}

export function findEntry(modelId: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.modelId === modelId);
}

/**
 * 啟動斷言(Req 8.3 邊界不變式):下拉可選的每個模型都必須在單價表查得到價,
 * 否則「下拉選得到、執行時 Fail Closed 跑不起來」。回傳不可定價的 modelId 清單。
 */
export function unpriceableCatalogEntries(): string[] {
  return CATALOG.filter((e) => !isPriceable(e.modelId)).map((e) => e.modelId);
}
