/**
 * 動態掃描 Bedrock 可用模型(模型管理頁用)。
 *
 * 為什麼要掃描而非維護白名單:靜態 modelCatalog 會過期,新上架的模型(GPT / Grok / Nova 2…)
 * 不會出現。這裡用 Bedrock 控制面 API 即時列出帳號當前可用的模型與其能力(是否看圖、文字輸出),
 * 並據「是否支援 ON_DEMAND / 是否有 us. inference profile」決定正確的可呼叫 id(前綴),
 * 避免手寫前綴出錯。單價仍以 pricing.ts 為權威(查無價的模型由呼叫端過濾不顯示)。
 */
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { channelFromModelId, defaultCoordSystem, type Channel, type CoordSystem } from './modelCatalog.js';

export interface ScannedModel {
  /** 可呼叫 id(ON_DEMAND 用基礎 id;只有 inference profile 的用 us. 前綴)。 */
  modelId: string;
  /** 基礎 id(無前綴),供單價查詢/比對。 */
  baseId: string;
  displayName: string;
  provider: string;
  channel: Channel;
  coordSystem: CoordSystem;
  /** 輸入支援影像(可坐 vlm=分析畫面)。 */
  image: boolean;
  /** 輸出文字(可坐 agent/subagent/draft)。 */
  text: boolean;
  /** 是否可直接 ON_DEMAND 呼叫(否則走 us. inference profile)。 */
  onDemand: boolean;
}

/** 控制面 client 的最小介面(便於測試注入)。 */
export interface BedrockControl {
  send: (cmd: unknown) => Promise<unknown>;
}

export function makeBedrockControl(region: string): BedrockControl {
  return new BedrockClient({ region }) as unknown as BedrockControl;
}

interface FmSummary {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}

/**
 * 掃描 Bedrock foundation models + inference profiles,正規化成 ScannedModel[]。
 * 只保留「輸出含 TEXT」的模型(本平台一律以文字 JSON 回動作);純圖像生成/嵌入模型排除。
 * 無法簡單呼叫的(既非 ON_DEMAND、也沒有 us. profile)略過。
 */
export async function scanBedrockModels(client: BedrockControl): Promise<ScannedModel[]> {
  const fmRes = (await client.send(new ListFoundationModelsCommand({}))) as {
    modelSummaries?: FmSummary[];
  };
  const fms = fmRes.modelSummaries ?? [];

  // us. 跨區推論設定檔(分頁撈完):有 us.<baseId> 才能呼叫「只有 profile」的模型。
  const usProfiles = new Set<string>();
  let nextToken: string | undefined;
  do {
    const r = (await client.send(
      new ListInferenceProfilesCommand({
        typeEquals: 'SYSTEM_DEFINED',
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as { inferenceProfileSummaries?: Array<{ inferenceProfileId?: string }>; nextToken?: string };
    for (const p of r.inferenceProfileSummaries ?? []) {
      if (p.inferenceProfileId) usProfiles.add(p.inferenceProfileId);
    }
    nextToken = r.nextToken;
  } while (nextToken);

  const out: ScannedModel[] = [];
  const seen = new Set<string>();
  for (const m of fms) {
    const baseId = m.modelId ?? '';
    if (!baseId) continue;
    // 退役/legacy 生命週期的略過(避免列出叫不動的)。
    if (m.modelLifecycle?.status && m.modelLifecycle.status !== 'ACTIVE') continue;
    const outputs = m.outputModalities ?? [];
    const inputs = m.inputModalities ?? [];
    const text = outputs.includes('TEXT');
    if (!text) continue; // 只用文字輸出模型
    const image = inputs.includes('IMAGE');
    const types = m.inferenceTypesSupported ?? [];
    const onDemand = types.includes('ON_DEMAND');
    const usProfile = `us.${baseId}`;
    const hasUsProfile = usProfiles.has(usProfile);

    let modelId: string;
    if (onDemand) modelId = baseId;
    else if (hasUsProfile) modelId = usProfile;
    else continue; // 無法簡單呼叫

    if (seen.has(modelId)) continue;
    seen.add(modelId);
    out.push({
      modelId,
      baseId,
      displayName: m.modelName || baseId,
      provider: m.providerName || baseId.split('.')[0] || '',
      channel: channelFromModelId(modelId),
      coordSystem: defaultCoordSystem(modelId),
      image,
      text,
      onDemand,
    });
  }
  // 名稱排序,前端表格好找。
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}
