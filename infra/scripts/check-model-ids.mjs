#!/usr/bin/env node
/**
 * 檢查模型目錄的 id 是否真的叫得動(對照 Bedrock 現況)。
 *
 * 為什麼需要這支:可呼叫的 id 有兩種形式 —— on-demand 用原始 foundation-model id,
 * 只給 inference profile 的模型要用 `us.<id>`。猜錯兩邊都是同一個錯誤訊息
 * 「The provided model identifier is invalid.」,而且要等到任務真的跑起來、
 * 第一次呼叫模型時才會炸。這支把它提前到開發階段。
 *
 * 用法:
 *   node infra/scripts/check-model-ids.mjs            # 只比對清單(不花錢)
 *   node infra/scripts/check-model-ids.mjs --invoke    # 另外對每個 id 實呼 1 token 驗證
 *
 * 退出碼 1 = 有問題,可當 CI 閘門。
 */
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const INVOKE = process.argv.includes('--invoke');
const here = dirname(fileURLToPath(import.meta.url));

// 目錄用正則讀(不編譯 TS):modelId + seats。
const src = readFileSync(join(here, '..', 'lambda', 'api', 'modelCatalog.ts'), 'utf8');
const entries = [...src.matchAll(/\{\s*modelId:\s*'([^']+)'[\s\S]*?seats:\s*\[([^\]]*)\]/g)].map((m) => ({
  base: m[1],
  seats: m[2].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
}));
// 前綴規則也從同一份檔案讀,規則改了這支會跟著改。
const providers = new Set(
  (/const PREFIXED_PROVIDERS = new Set\(\[([^\]]*)\]/.exec(src)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
);
const models = new Set(
  (/const PREFIXED_MODELS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
);
const callableId = (base) =>
  providers.has(base.split('.')[0] ?? '') || models.has(base) ? `us.${base}` : base;

const bedrock = new BedrockClient({ region: REGION });
const fm = (await bedrock.send(new ListFoundationModelsCommand({}))).modelSummaries ?? [];
const byId = new Map(fm.map((m) => [m.modelId, m]));
const profiles = new Set();
let token;
do {
  const r = await bedrock.send(new ListInferenceProfilesCommand({ maxResults: 100, ...(token ? { nextToken: token } : {}) }));
  for (const p of r.inferenceProfileSummaries ?? []) profiles.add(p.inferenceProfileId);
  token = r.nextToken;
} while (token);

const runtime = INVOKE ? new BedrockRuntimeClient({ region: REGION }) : null;
const problems = [];

for (const e of entries) {
  if (e.base === 'uitars') continue; // 自建 SageMaker endpoint,不在 Bedrock 目錄
  const id = callableId(e.base);
  const m = byId.get(e.base);
  const onDemand = (m?.inferenceTypesSupported ?? []).includes('ON_DEMAND');
  const hasProfile = profiles.has(`us.${e.base}`);
  const wantPrefix = id.startsWith('us.');

  if (!m && !hasProfile) {
    problems.push(`${id}:這個區域(${REGION})既沒有基礎模型也沒有 inference profile`);
  } else if (wantPrefix && !hasProfile) {
    problems.push(`${id}:加了 us. 但沒有 profile → 應改直呼 ${e.base}`);
  } else if (!wantPrefix && !onDemand) {
    problems.push(`${id}:不支援 on-demand → 應改用 us.${e.base}`);
  }

  // vlm 座位要看得懂截圖:模態必須含 IMAGE。
  if (e.seats.includes('vlm') && m && !(m.inputModalities ?? []).includes('IMAGE')) {
    problems.push(`${id}:排在 vlm 座位但只吃 ${(m.inputModalities ?? []).join('/')},看不到截圖`);
  }

  if (runtime) {
    try {
      await runtime.send(new ConverseCommand({
        modelId: id,
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        inferenceConfig: { maxTokens: 1 },
      }));
    } catch (err) {
      problems.push(`${id}:實呼失敗 ${err.name}: ${String(err.message).slice(0, 100)}`);
    }
  }
}

console.log(`目錄 ${entries.length} 筆 / 區域 ${REGION}${INVOKE ? '(含實呼)' : ''}`);
if (problems.length === 0) {
  console.log('全部可呼叫 ✓');
  process.exit(0);
}
console.log(`有問題 ${problems.length} 筆:`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
