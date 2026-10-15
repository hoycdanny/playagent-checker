/**
 * 任務詳情頁的「AI 問答」:測試人員針對某一次任務發問(例:「根據目前收集到的 log 有什麼要注意的?」),
 * AI 依這次任務的實際資料回答 —— 測試腳本、執行狀態、每一步的 AI 觀察與動作、異常步驟、
 * 裝置 log(錯誤 / 當機 / ANR)、測試人員下過的指令、報告結果、注入給 AI 的知識(知識庫 / 記憶)。
 *
 * 對話存在 tenants/<t>/jobs/<id>/ask/history.json(重新整理後還在)。
 * 必須在 API Gateway 30 秒內回應:用 Haiku(快),無權限才退 Sonnet;輸入內容有上限。
 */
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

export const ASK_MODELS = [
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
];
export const MAX_QUESTION = 1000;
const MAX_HISTORY = 40; // 存檔最多保留幾則
const HISTORY_TO_MODEL = 8; // 帶給模型的前文則數
const BUDGET = {
  script: 4000,
  knowledge: 9000,
  steps: 16000,
  logs: 9000,
  report: 2500,
} as const;

export class AskValidationError extends Error {}

export interface AskMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  model?: string;
}

type Json = Record<string, unknown>;

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
async function readText(s3: S3Client, bucket: string, key: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? '';
  } catch {
    return '';
  }
}

const jobPrefix = (tenantId: string, jobId: string) => `${tenantPrefix(tenantId)}jobs/${jobId}/`;
const historyKey = (tenantId: string, jobId: string) => `${jobPrefix(tenantId, jobId)}ask/history.json`;
const cut = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export async function readAskHistory(s3: S3Client, bucket: string, tenantId: string, jobId: string): Promise<AskMessage[]> {
  const doc = await readJson<{ items?: AskMessage[] }>(s3, bucket, historyKey(tenantId, jobId));
  return Array.isArray(doc?.items) ? doc!.items : [];
}
export async function clearAskHistory(s3: S3Client, bucket: string, tenantId: string, jobId: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: historyKey(tenantId, jobId), Body: JSON.stringify({ items: [] }), ContentType: 'application/json' }));
}

/** 知識內容裡的「可用測試資料」段落含可見的帳密值:整段換成只列 key 名的說明,值不送給模型。 */
export function maskCredentials(context: string): string {
  const lines = context.split('\n');
  const out: string[] = [];
  let inCred = false;
  for (const line of lines) {
    if (/^#\s*可用測試資料|AVAILABLE TEST CREDENTIALS/i.test(line)) {
      inCred = true;
      out.push('# 可用測試資料(已隱藏實際值)');
      continue;
    }
    if (inCred && /^#\s/.test(line)) inCred = false;
    if (inCred) {
      // 只留 key 名(`- key = value` / `key: value` → `- key`)。
      const m = /^\s*[-*]?\s*([^=:：]{1,60})\s*[=:：]/.exec(line);
      if (m) out.push(`- ${m[1]!.trim()}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 裝置 log:只挑跟問題有關的行(錯誤 / 當機 / ANR / 例外 / 記憶體),由新到舊,控制長度。 */
const LOG_IMPORTANT = /\bE\/|\bF\/|\s[EF]\s|FATAL|AndroidRuntime|ANR in|Exception|Error|crash|SIGSEGV|SIGABRT|tombstone|OutOfMemory|lowmemorykiller|am_kill|Force finishing|died|ActivityManager: Process/i;
export function pickLogLines(chunks: Array<{ name: string; text: string }>, budget: number): string {
  const picked: string[] = [];
  let used = 0;
  for (const c of [...chunks].reverse()) {
    const header = c.text.split('\n').find((l) => l.startsWith('# step=')) ?? '';
    const lines = c.text.split('\n').filter((l) => !l.startsWith('#') && LOG_IMPORTANT.test(l));
    if (!lines.length) continue;
    // 同一則訊息重複刷很多次只留一次(log 常見),並保留出現次數。
    const seen = new Map<string, number>();
    for (const l of lines) {
      const key = l.replace(/^\S+\s+\S+\s+/, '').replace(/\d+/g, '#').slice(0, 200);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const block = [`${header || `# ${c.name}`}`];
    for (const [k, n] of seen) block.push(`${k.slice(0, 240)}${n > 1 ? `(×${n})` : ''}`);
    const text = block.join('\n');
    if (used + text.length > budget) {
      if (!picked.length) picked.push(text.slice(0, budget));
      break;
    }
    picked.unshift(text);
    used += text.length;
  }
  return picked.join('\n');
}

/** 步驟摘要:全部步驟取樣出流程輪廓 + 最近 30 步詳細 + 所有異常步驟(覆寫、警告、沒反應、解析失敗)。 */
export function summarizeSteps(steps: Json[], budget: number): string {
  if (!steps.length) return '(還沒有任何步驟)';
  const line = (s: Json, detail: boolean) => {
    const flags = [
      s['override'] ? `runner改寫=${String(s['override'])}` : '',
      s['parseFailed'] ? '模型回應無法解析' : '',
      s['modelError'] ? '模型呼叫失敗' : '',
      s['foregroundLost'] ? '遊戲離開前景' : '',
      s['screenChanged'] === false ? '畫面沒變' : '',
      (s['review'] as Json | undefined)?.['effect'] === 'no_effect' ? '動作沒反應' : '',
      Array.isArray(s['warnings']) && (s['warnings'] as unknown[]).length ? `數值警告=${cut(s['warnings'], 160)}` : '',
      Array.isArray(s['operatorCommands']) && (s['operatorCommands'] as unknown[]).length ? `測試人員指令=${cut((s['operatorCommands'] as Json[]).map((c) => c['text']), 160)}` : '',
    ].filter(Boolean).join(';');
    const at = typeof s['at'] === 'string' ? (s['at'] as string).slice(11, 19) : '';
    const base = `#${String(s['index'])} ${at} [${cut(s['screen'], 40)}] ${cut(s['action'], 12)}${flags ? ` {${flags}}` : ''}`;
    return detail ? `${base}:${cut(s['thinking'], 260)}${s['memo'] ? `|筆記:${cut(s['memo'], 160)}` : ''}` : base;
  };
  const recent = steps.slice(-30);
  const recentIdx = new Set(recent.map((s) => s['index']));
  const anomalies = steps.filter((s) => !recentIdx.has(s['index']) && (s['override'] || s['parseFailed'] || s['modelError'] || s['foregroundLost']
    || (Array.isArray(s['warnings']) && (s['warnings'] as unknown[]).length) || (Array.isArray(s['operatorCommands']) && (s['operatorCommands'] as unknown[]).length)));
  const stride = Math.max(1, Math.ceil(steps.length / 40));
  const outline = steps.filter((_, i) => i % stride === 0 && !recentIdx.has(steps[i]!['index'])).map((s) => line(s, false));
  const parts = [
    `共 ${steps.length} 步。`,
    outline.length ? `【流程輪廓(每 ${stride} 步取一筆)】\n${outline.join('\n')}` : '',
    anomalies.length ? `【較早的異常步驟】\n${anomalies.slice(-40).map((s) => line(s, true)).join('\n')}` : '',
    `【最近 ${recent.length} 步(詳細)】\n${recent.map((s) => line(s, true)).join('\n')}`,
  ].filter(Boolean);
  let text = parts.join('\n\n');
  // 超過預算:保留最近步驟,從前面砍。
  if (text.length > budget) text = `…(前面省略)\n${text.slice(text.length - budget)}`;
  return text;
}

/** 收集這次任務的資料 → 給模型的參考資料(純文字,分段標題)。 */
export async function buildTaskContext(s3: S3Client, bucket: string, tenantId: string, jobId: string): Promise<string> {
  const p = jobPrefix(tenantId, jobId);
  const [job, status, report, ctx, cmdList, logList] = await Promise.all([
    readJson<Json>(s3, bucket, `${p}job.json`),
    readJson<Json>(s3, bucket, `${p}status.json`),
    readJson<Json>(s3, bucket, `${p}report.json`),
    readJson<Json>(s3, bucket, `${p}context.json`),
    s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${p}commands/` })).catch(() => null),
    s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${p}devlogs/logcat/` })).catch(() => null),
  ]);
  if (!job) throw new AskValidationError('找不到任務');

  // 步驟:有報告就用報告裡的(完整),否則讀 steps/。
  let steps: Json[] = Array.isArray(report?.['steps']) ? (report!['steps'] as Json[]) : [];
  if (!steps.length) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${p}steps/` })).catch(() => null);
    const keys = (list?.Contents ?? []).map((o) => o.Key ?? '').filter((k) => k.endsWith('.json'));
    const read = await Promise.all(keys.map((k) => readJson<Json>(s3, bucket, k)));
    steps = read.filter((s): s is Json => !!s && typeof s['index'] === 'number').sort((a, b) => (a['index'] as number) - (b['index'] as number));
  }

  // 裝置 log:最後 12 個片段。
  const logKeys = (logList?.Contents ?? []).map((o) => o.Key ?? '').filter((k) => /\/\d{6}\.txt$/.test(k)).sort().slice(-12);
  const chunks = await Promise.all(logKeys.map(async (k) => ({ name: k.split('/').pop()!, text: (await readText(s3, bucket, k)).slice(0, 300_000) })));
  const logs = pickLogLines(chunks, BUDGET.logs);

  // 測試人員的即時指令。
  const cmdKeys = (cmdList?.Contents ?? []).map((o) => o.Key ?? '').filter((k) => k.endsWith('.json')).sort().slice(-20);
  const cmds = (await Promise.all(cmdKeys.map((k) => readJson<Json>(s3, bucket, k)))).filter(Boolean).map((c) => `- ${cut(c!['createdAt'], 19)} ${cut(c!['text'], 200)}`);

  const knowledge = typeof ctx?.['context'] === 'string' ? maskCredentials(ctx['context'] as string) : '';
  const meta = [
    `任務 ${jobId}|環境 ${String(job['backend'] ?? '?')}${job['maxSegments'] !== undefined ? `(段數 ${String(job['maxSegments'])})` : ''}|裝置 ${String(report?.['deviceModel'] ?? job['deviceModel'] ?? '?')}`,
    `案例:${String(job['caseName'] ?? job['caseId'] ?? '?')}${job['caseVersion'] ? `(版本 ${String(job['caseVersion'])})` : ''}`,
    `操作方式:${cut((job['controls'] as Json | undefined)?.['ids'], 80) || '未限定'}|模型:視覺 ${String(job['vlmModel'] ?? '?')}、決策 ${String(job['agentModel'] ?? '?')}`,
    `目前狀態:${String(status?.['state'] ?? '?')}|訊息:${cut(status?.['message'], 400)}|已執行 ${steps.length} 步|最後更新 ${String(status?.['updatedAt'] ?? '?')}`,
  ].join('\n');
  const rep = report
    ? cut({ state: report['state'], message: report['message'], rtp: report['rtp'], perfMeta: report['perfMeta'], segments: report['segments'], tokens: report['tokens'] }, BUDGET.report)
    : '(任務還沒結束,尚無報告)';

  return [
    `## 任務概要\n${meta}`,
    `## 測試腳本\n${cut(job['caseTask'], BUDGET.script) || '(無)'}`,
    `## 執行步驟(AI 每一步看到的畫面、動作與想法)\n${summarizeSteps(steps, BUDGET.steps)}`,
    `## 裝置 log(只列錯誤 / 當機 / ANR / 例外等重要訊息,由舊到新)\n${logs || '(沒有裝置 log 或沒有錯誤等級的訊息)'}`,
    `## 測試人員下過的即時指令\n${cmds.join('\n') || '(無)'}`,
    `## 報告結果\n${rep}`,
    `## 注入給 AI 的知識(知識庫 / 應用記憶 / 導覽圖)\n${cut(knowledge, BUDGET.knowledge) || '(無)'}`,
  ].join('\n\n');
}

const SYSTEM = (lang: 'zh' | 'en') => `你是資深遊戲 QA 測試顧問,正在協助測試人員分析「一次自動化測試任務」。
你會收到這次任務的參考資料:任務概要、測試腳本、執行步驟(AI 測試代理每一步看到的畫面、動作與想法)、裝置 log、測試人員指令、報告結果、注入給 AI 的知識。
規則:
- 只根據參考資料回答;資料裡沒有的就直說「資料中看不到」,不要猜測或捏造步驟、數字、log 內容。
- 引用證據時標出步驟編號(例:#123)或 log 片段(step=…),讓測試人員能回頭查。
- 步驟後面 {…} 是 runner 的標記:「runner改寫=stuck_wait」= 畫面連續多步沒變,runner 主動改成等待(不是指令被誤解);
  「runner改寫=stuck_escape」= 卡住太久,runner 主動點畫面脫困;「runner改寫=reject_done」= AI 想結束但被駁回、繼續測;
  「runner改寫=control_violation」= AI 用了案例不允許的操作方式,被擋下;「畫面沒變」= 這一步動作後畫面和前一步一樣。
- 區分「遊戲本身的問題」與「AI 測試代理 / 測試環境的問題」(例如點不到按鈕、模型讀錯數字、裝置連線斷掉),不要把後者說成遊戲缺陷。
- 測試人員問「要注意什麼」時:依嚴重程度列出重點(當機/ANR/錯誤、卡住或重複失敗、數值異常、與腳本不符之處),每點附證據與建議的下一步。
- 簡潔:最多 6 個重點、整體約 400 字內;測試人員想看細節會再追問。
- 純文字排版:用「1.」「-」條列即可,不要用 Markdown 符號(#、**、\`\`\`、表格)。不要輸出參考資料原文。
- 用${lang === 'en' ? 'English' : '繁體中文'}回答。`;

/** 模型偶爾仍會用 Markdown:去掉標題井號、粗體星號、程式碼圍欄,面板以純文字顯示。 */
export function plainText(s: string): string {
  return s
    .replace(/^```[a-z]*\s*$/gim, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface AskDeps {
  bedrock?: Pick<BedrockRuntimeClient, 'send'>;
  /** 指定問答模型(由管理員在模型管理開放、使用者在任務詳情選擇);未指定則用 ASK_MODELS 預設。 */
  modelId?: string;
}

const ASK_MAX_TOKENS = 1100;
const isAnthropic = (modelId: string) => /^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\./.test(modelId);

/**
 * 非 Claude 模型(Nova / GPT / Grok…)走 Converse(統一格式)。
 * 有些模型不收 temperature,被拒就拿掉重送;有些不收獨立 system,被拒就併進第一則 user。
 */
async function converseAsk(
  br: Pick<BedrockRuntimeClient, 'send'>,
  modelId: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ text: string; truncated: boolean }> {
  const toBlocks = (withSystem: boolean) => {
    const ms = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: [{ text: m.content }] }));
    if (!withSystem && ms[0]) ms[0] = { ...ms[0], content: [{ text: `${system}\n\n${ms[0].content[0]!.text}` }] };
    return ms;
  };
  const send = (withTemp: boolean, withSystem: boolean) =>
    br.send(new ConverseCommand({
      modelId,
      ...(withSystem ? { system: [{ text: system }] } : {}),
      messages: toBlocks(withSystem),
      inferenceConfig: withTemp ? { maxTokens: ASK_MAX_TOKENS, temperature: 0.2 } : { maxTokens: ASK_MAX_TOKENS },
    })) as Promise<{ output?: { message?: { content?: Array<{ text?: string }> } }; stopReason?: string }>;
  let withTemp = true;
  let withSystem = true;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await send(withTemp, withSystem);
      const text = (res.output?.message?.content ?? []).map((c) => c.text ?? '').join('').trim();
      return { text, truncated: res.stopReason === 'max_tokens' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && withTemp && /temperature|top_?p/i.test(msg)) { withTemp = false; continue; }
      if (attempt < 2 && withSystem && /system|alternate/i.test(msg)) { withSystem = false; continue; }
      throw err;
    }
  }
}
let client: BedrockRuntimeClient | null = null;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' }));

export function cleanQuestion(v: unknown): string {
  if (typeof v !== 'string') throw new AskValidationError('question 必填');
  const q = v.trim();
  if (!q) throw new AskValidationError('問題不可為空');
  if (q.length > MAX_QUESTION) throw new AskValidationError(`問題最多 ${MAX_QUESTION} 字`);
  return q;
}

/** 問一題:組參考資料 → 呼叫模型 → 存對話。回傳整份對話。 */
export async function askTask(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  question: string,
  lang: 'zh' | 'en' = 'zh',
  deps: AskDeps = {},
): Promise<{ answer: AskMessage; items: AskMessage[] }> {
  const [context, history] = await Promise.all([
    buildTaskContext(s3, bucket, tenantId, jobId),
    readAskHistory(s3, bucket, tenantId, jobId),
  ]);
  const prior = history.slice(-HISTORY_TO_MODEL).map((m) => ({ role: m.role, content: m.text }));
  // 前文必須從 user 開始、user/assistant 交替(Anthropic messages 規則)。
  while (prior.length && prior[0]!.role !== 'user') prior.shift();
  const messages = [
    ...prior,
    { role: 'user', content: `【這次任務的參考資料】\n${context}\n\n【問題】\n${question}` },
  ];
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    // 回答上限(也控制延遲:API Gateway 30 秒內要回)。
    max_tokens: ASK_MAX_TOKENS,
    temperature: 0.2,
    system: SYSTEM(lang),
    messages,
  });
  const br = deps.bedrock ?? bedrock();
  const cutNote = lang === 'en' ? '\n…(answer cut off — ask a follow-up for details)' : '\n…(回答過長已截斷,可以追問細節)';
  let lastErr: unknown;
  let text = '';
  let usedModel = '';
  // 指定模型(管理員在任務詳情選的)只試那一個,失敗就直接回錯誤 —— 不默默改用別的模型。
  const candidates = deps.modelId ? [deps.modelId] : ASK_MODELS;
  for (const modelId of candidates) {
    try {
      if (isAnthropic(modelId)) {
        const res = await br.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body }));
        const parsed = JSON.parse(new TextDecoder().decode(res.body as Uint8Array)) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
        text = plainText((parsed.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim());
        if (parsed.stop_reason === 'max_tokens') text += cutNote;
      } else {
        const r = await converseAsk(br, modelId, SYSTEM(lang), messages);
        text = plainText(r.text);
        if (r.truncated) text += cutNote;
      }
      usedModel = modelId;
      break;
    } catch (err) {
      lastErr = err;
      if (deps.modelId) throw err;
      const name = err instanceof Error ? err.name : '';
      if (!/AccessDenied|ResourceNotFound|ValidationException/.test(name)) throw err;
    }
  }
  if (!usedModel) throw lastErr instanceof Error ? lastErr : new Error('AI 問答失敗');
  const now = new Date().toISOString();
  const answer: AskMessage = { role: 'assistant', text: text || '(模型沒有回答)', at: now, model: usedModel };
  const items = [...history, { role: 'user' as const, text: question, at: now }, answer].slice(-MAX_HISTORY);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: historyKey(tenantId, jobId), Body: JSON.stringify({ items }), ContentType: 'application/json' }));
  return { answer, items };
}
