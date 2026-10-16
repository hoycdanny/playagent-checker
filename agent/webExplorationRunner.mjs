#!/usr/bin/env node
/**
 * Web 探索 runner —— 跑在 ECS Fargate task 容器內(headless Chromium via Playwright)。
 *
 * 與 explorationRunner.mjs(Device Farm 真機)同架構:screenshot → Bedrock VLM 決策 → act 迴圈,
 * 每步把截圖 / step / trace / annotated / 增量記憶地圖寫回 S3(前端即時呈現),結束寫 report + 終態。
 * 差別只在裝置驅動層:用 PlaywrightClient(瀏覽器)取代 AppiumClient(真機)。
 *
 * 座標:沿用 smart-resize(imageTools.resizeToSmartB64)—— 送模型的圖 == 模型座標基準,
 * 模型回像素後除以 smart 尺寸得比例、再乘視埠尺寸 → 視埠像素 → page.mouse.click。
 *
 * 環境變數(engine 起 Fargate task 時注入):
 *   PA_URL      起始網址(必填;engine 已從 case/app 解析)
 *   PA_JOB / PA_TENANT / PA_BUCKET / PA_PREFIX   S3 位置
 *   PA_VLM      VLM modelId
 *   PA_TASK     測試/探索目標文字
 *   PA_APP      appId(記憶地圖用)
 *   PA_MAXSTEPS 步數上限(預設 30)
 *   PA_VIEWPORT (選)WxH,預設 1280x800
 */
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { applyEdits, createOperatorChannel, hintsPromptSection, loadAppMemory, operatorTurnNote, routesPromptSection, routeTurnNote, screenHintsFor, operatorGestureCmd, POINT_ONLY_TEXT, DRAG_ONLY_TEXT } from './operatorMemory.mjs';
import { foldSystemIntoFirstUser } from './converseShape.mjs';
import { accumulate, addUsage, createUsageLedger, usageFromAnthropic, usageFromConverse } from './tokenUsage.mjs';
import { PlaywrightClient } from './playwrightClient.mjs';
import { normalizeKey, KEY_IDS } from './keyNames.mjs';
import { magickAvailable, annotateTapB64, pHashHex, pHashHamming, resizeToSmartB64 } from './imageTools.mjs';
import { loadAppCredentials, substituteText } from './secretsResolver.mjs';
import { evidencePromptSection, evidenceFields } from './evidenceProtocol.mjs';
import { upsertPage, recordTransition, recordMiss, recordSelfOp, compactStructure } from './memoryGraph.mjs';
import { opFromCmd } from './reflex.mjs';
import { createMemoryTrace } from './memoryTrace.mjs';

const START_URL = process.env.PA_URL || 'https://example.com';
const JOB = process.env.PA_JOB;
const BUCKET = process.env.PA_BUCKET;
const PREFIX = process.env.PA_PREFIX;
const APP_ID = process.env.PA_APP || '';
const DATA_REGION = process.env.PA_DATA_REGION || process.env.AWS_REGION || 'us-west-2';
// Web runner 無 UI-TARS 路徑(UI-TARS 為行動 GUI 微調,且 web task role 無 SageMaker 權限)。
// 'uitars' 為 SageMaker 定位哨兵 id,非 Bedrock 可呼叫模型;web 一律回退到真實 Bedrock 通用 VLM。
const BEDROCK_VLM_FALLBACK = 'qwen.qwen3-vl-235b-a22b';
const _vlmRaw = process.env.PA_VLM || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const VLM = _vlmRaw === 'uitars' ? BEDROCK_VLM_FALLBACK : _vlmRaw;
// 任務目標:保持原樣送 AI(含任何 ${key} 佔位符)。真值只在 type 到頁面那一刻替換,不改寫 TASK。
const TASK = process.env.PA_TASK || '探索這個網頁應用:穿透開場彈窗/公告,進入主要功能並操作,盡量走遍不同畫面。';
// 步數上限:PA_MAXSTEPS 未設或 <=0 代表「無上限」(跑到 done / 死循環 / 取消 / 連續失敗才停)。
const _maxStepsRaw = Number(process.env.PA_MAXSTEPS || 0);
const MAX_STEPS = Number.isFinite(_maxStepsRaw) && _maxStepsRaw > 0 ? _maxStepsRaw : Infinity;
const [VP_W, VP_H] = (process.env.PA_VIEWPORT || '1280x800').split('x').map((n) => Number(n) || 0);
const CONSEC_FAIL_LIMIT = 3;
// runner 版本(寫進報告表頭 Test Engine Version)。
const RUNNER_VERSION = 'web-runner/2.0 (evidence-v1)';

const s3 = new S3Client({ region: DATA_REGION });
const bedrock = new BedrockRuntimeClient({ region: DATA_REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGICK = magickAvailable();

async function s3put(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (!w || !h) return null;
  return { w, h };
}
// 取消:測試人員按「停止」→ API 寫 cancel.json。看到之後就不再把狀態寫回 running。
let cancelSeen = false;
let cancelCheckedAt = 0;
async function cancelRequested(maxAgeMs = 0) {
  if (cancelSeen) return true;
  if (maxAgeMs && Date.now() - cancelCheckedAt < maxAgeMs) return false;
  cancelCheckedAt = Date.now();
  try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/cancel.json` })); cancelSeen = true; } catch { /* 沒有取消 */ }
  return cancelSeen;
}
async function writeStatus(state, message, steps) {
  if (state === 'running' && await cancelRequested(3000)) return;
  await s3put(`${PREFIX}/status.json`,
    JSON.stringify({ jobId: JOB, state, message, steps: steps ?? 0, updatedAt: new Date().toISOString() }),
    'application/json').catch(() => {});
}

// ── VLM 決策(對齊 explorationRunner,但 prompt 改成「網頁」語意)──
// 網頁 runner(PlaywrightClient)實際支援的動作;controls 開放的觸控手勢(move/combo/pinch)在網頁上無效。
const WEB_ACTIONS = ['tap', 'hold', 'swipe', 'type', 'key', 'back', 'wait', 'done'];
function buildSystemPrompt(knowledge, evidence, controls = null) {
  // 測試腳本指定了操作方式(鍵盤 / 滑鼠 / 按鍵對應)→ 用權威段落取代通用的鍵盤說明,JSON 也只列可用的動作與鍵。
  const actions = controls ? WEB_ACTIONS.filter((a) => controls.allowedActions.includes(a)) : WEB_ACTIONS.filter((a) => a !== 'hold');
  const mappedKeys = controls && Array.isArray(controls.keys) ? controls.keys.map((k) => k.key).filter((k) => KEY_IDS.includes(k)) : [];
  const keyEnum = mappedKeys.length ? mappedKeys.join('|') : 'up|down|left|right|enter|space|escape|tab|shift|z|x|w|a|s|d|…';
  const keyboardSection = controls
    ? `\n${controls.prompt}\n` +
      (actions.includes('hold') ? `hold = 滑鼠左鍵在 x,y 按住 holdMs 毫秒再放開。` : '') +
      (actions.includes('key') ? `key 可加 holdMs(按住毫秒,衝刺 / 蓄力才需要;不給 = 一般按一下)。` : '')
    : `【鍵盤操作】網頁遊戲若點擊/滑動都沒反應,很可能只吃鍵盤:用 key 送按鍵。` +
      `可用按鍵:up/down/left/right、enter、space、escape、tab、shift、ctrl、alt、backspace、a~z、0~9,可加 repeat(1~20)連按、holdMs(按住毫秒)。`;
  const base =
    `你是專業網頁應用測試工程師,正在用瀏覽器測試一個網站/網頁遊戲。每一步你會看到一張最新的網頁截圖。` +
    `【座標規則|最重要】座標一律用「你看到的這張截圖的絕對像素」:左上角是 (0,0),往右 x 變大、往下 y 變大,` +
    `右下角就是該張圖的寬與高(該回合訊息會告知尺寸)。請把座標精準對到「按鈕/連結/輸入框本身的正中心」。不要用比例、不要 0~1000。` +
    `這是連續對話,你會記得前幾步做了什麼。每步之後我會給你執行後的最新畫面,據此判斷上一步是否生效:` +
    `若畫面推進→繼續;若沒變→不要重複同座標,改點別的、換座標、或 back/swipe(捲動)。` +
    `策略:網頁常有 Cookie 同意/訂閱彈窗/廣告,積極關閉或接受以進入主要內容。` +
    `【登入處理|重要】若「目標」文字有提供帳號與密碼,遇到登入畫面/彈窗時「必須用該帳密登入」,` +
    `不可關閉登入彈窗、也不要略過登入:先點需要帳密輸入的方式(如「會員」「手機」「帳號登入」等,` +
    `不是 LINE/Facebook/Apple 第三方),再 tap 帳號欄輸入帳號、tap 密碼欄輸入密碼,然後點登入/送出。` +
    `唯有「目標」沒有提供帳密時,才關閉登入彈窗改走訪客/其他路徑。` +
    `需要輸入時,先 tap 輸入框再用 type 輸入(type 會自動送出 Enter)。需要往下看更多內容時用 swipe(垂直)捲動。` +
    // 很多網頁遊戲(2048、射擊、平台跳躍)只監聽鍵盤,滑鼠點擊與拖曳完全沒反應,必須讓模型知道有 key 可用。
    keyboardSection +
    `目標:${TASK}` +
    `先簡短思考(thinking),再給動作。只輸出 JSON:` +
    `{"thinking":"...","action":"${actions.join('|')}","x":<像素>,"y":<像素>,"x2":<像素>,"y2":<像素>,"text":"..."` +
    (actions.includes('key') ? `,"key":"${keyEnum}","repeat":<連按次數>` : '') +
    (actions.includes('key') || actions.includes('hold') ? `,"holdMs":<按住毫秒>` : '') +
    `,"button":"left|right","screen":"畫面名稱"}。` +
    `x/y 是「這張圖的像素座標」。tap 需 x,y(button 預設 left,滑鼠右鍵才給 "right");swipe(捲動/拖曳)需 x,y,x2,y2;type 需 text;` +
    (actions.includes('key') ? `key 需 key(可選 repeat、holdMs);` : '') +
    (actions.includes('hold') ? `hold 需 x,y,holdMs;` : '') +
    `done 只在真正完成目標或完全無法進行時用。` +
    `screen 用精確畫面名描述當前畫面(如「首頁」「登入」「遊戲主畫面」「結算」),不同畫面用不同名稱。`;
  const k = typeof knowledge === 'string' ? knowledge.trim() : '';
  const withEvidence = base + evidencePromptSection(evidence, { subject: '網頁/遊戲' });
  return k ? withEvidence + `\n\n這款應用「類型」的背景知識(參考,畫面以截圖為準):\n${k.slice(0, 4000)}` : withEvidence;
}
function makeUserTurn(images, text, fmt = 'png') {
  const mediaType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  const content = [];
  for (const b64 of images) if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
  content.push({ type: 'text', text });
  return { role: 'user', content };
}
function makeAssistantTurn(rawText) { return { role: 'assistant', content: [{ type: 'text', text: rawText }] }; }
function pruneImages(messages, keepLatest = 2) {
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') userIdx.push(i);
  const keepFrom = userIdx.length - keepLatest;
  let seen = 0;
  for (const i of userIdx) {
    if (seen++ >= keepFrom) continue;
    const textParts = (messages[i].content || []).filter((c) => c.type === 'text');
    messages[i].content = textParts.length > 0 ? textParts : [{ type: 'text', text: '(先前畫面)' }];
  }
  return messages;
}
function channelFor(modelId) {
  const base = String(modelId).replace(/^(us|eu|apac|jp|au|global)\./, '');
  return base.startsWith('anthropic.') ? 'bedrock' : 'converse';
}
function parseCmd(out) {
  const m = /\{[\s\S]*\}/.exec(out || '');
  // 解析失敗 ≠ 模型宣告完成:回 wait 重試(對齊真機 runner;舊版回 done 會被誤判為 pass)。
  try { return m ? JSON.parse(m[0]) : { action: 'wait', duration: 3, thinking: '無法解析回應,等待後重試', parseFailed: true }; }
  catch { return { action: 'wait', duration: 3, thinking: '無法解析回應 JSON,等待後重試', parseFailed: true }; }
}
function toConverseMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: (m.content || []).map((c) => {
      if (c.type === 'image' && c.source?.data) {
        const format = c.source.media_type === 'image/jpeg' ? 'jpeg' : 'png';
        return { image: { format, source: { bytes: Buffer.from(c.source.data, 'base64') } } };
      }
      return { text: c.type === 'text' ? c.text : '(先前畫面)' };
    }),
  }));
}
/** 拒收獨立 system 回合的模型(與 explorationRunner 同一套處理,見 converseShape.mjs)。 */
const systemUnsupportedModels = new Set();
function summarizeRequest(system, messages) {
  let imageCount = 0, imageBytes = 0, lastText = '';
  for (const m of messages) for (const c of m.content || []) {
    if (c.type === 'image' && c.source?.data) { imageCount++; imageBytes += Math.floor((c.source.data.length * 3) / 4); }
    else if (c.type === 'text' && m.role === 'user') lastText = c.text;
  }
  return { systemChars: (system || '').length, turnText: lastText, imageCount, imageApproxKB: Math.round(imageBytes / 1024), messageTurns: messages.length };
}
function totalImageBytes(messages) {
  let bytes = 0;
  for (const m of messages) for (const c of m.content || []) if (c.type === 'image' && c.source?.data) bytes += Math.floor((c.source.data.length * 3) / 4);
  return bytes;
}
// Web runner 解析失敗備援:先用同模型精簡歷史重問,再改用穩定模型。
const VLM_RETRY_FALLBACK = process.env.PA_VLM_FALLBACK
  || (VLM.includes('anthropic') ? 'us.amazon.nova-pro-v1:0' : 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
// 每次呼叫依「實際模型」記帳(含重問、備援模型、快取 token)→ report.tokensByModel。
const vlmLedger = createUsageLedger();

async function decide(system, messages, modelId = VLM) {
  pruneImages(messages, 2);
  if (totalImageBytes(messages) > 1_500_000) pruneImages(messages, 1);
  const channel = channelFor(modelId);
  const request = summarizeRequest(system, messages);
  const baseTrace = { modelId, channel, request };
  try {
    if (channel === 'bedrock') {
      const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 1000, system, messages };
      const res = await bedrock.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) }));
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      const out = parsed.content?.find((c) => c.type === 'text')?.text ?? '{}';
      const usage = usageFromAnthropic(parsed.usage);
      vlmLedger.add(modelId, usage);
      return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
    }
    // 有些模型不吃 Converse 的獨立 system 欄位(服務端併成 user 回合 → user→user →
    // 「roles must alternate」被拒)。被拒一次就記住,改把 system 併進第一個 user 回合。
    const send = (withSystem) => bedrock.send(new ConverseCommand({
      modelId: VLM,
      ...(withSystem ? { system: [{ text: system }] } : {}),
      messages: toConverseMessages(withSystem ? messages : foldSystemIntoFirstUser(system, messages)),
      inferenceConfig: { maxTokens: 500 },
    }));
    let res;
    try {
      res = await send(!systemUnsupportedModels.has(VLM));
    } catch (e) {
      if (!/roles must alternate/i.test(String(e?.message || '')) || systemUnsupportedModels.has(VLM)) throw e;
      systemUnsupportedModels.add(VLM);
      res = await send(false);
    }
    const out = res.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '{}';
    // 含快取 token(見 tokenUsage.mjs)。
    const usage = usageFromConverse(res.usage);
    vlmLedger.add(modelId, usage);
    return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
  } catch (err) {
    const name = err?.name ? String(err.name) : 'Error';
    const message = err?.message ? String(err.message) : String(err);
    return { cmd: { action: 'done', thinking: `模型呼叫失敗:${message}` }, usage: null, rawText: '', trace: { ...baseTrace, ok: false, error: { name, message } } };
  }
}

// ── 增量記憶地圖 ──
const MEM_PREFIX = `tenants/${process.env.PA_TENANT}/memory/${APP_ID}`;
async function loadStructure() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${MEM_PREFIX}/structure.json` }));
    return JSON.parse(await res.Body.transformToString());
  } catch {
    return { schemaVersion: 1, appName: APP_ID, rootPageId: null, pages: {}, edges: [], lastUpdatedAt: null };
  }
}
function pageIdFromName(name, idx) {
  let h = 0; const s = String(name || `screen_${idx}`);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `page_${h.toString(16).padStart(8, '0')}`;
}

async function main() {
  // 測試憑證:啟動時載入本 App 憑證表到記憶體(值不寫回任何地方);實際替換在 type 那一刻。
  let appCredentials = {};
  try { appCredentials = await loadAppCredentials(); } catch (e) { console.warn('[secrets] 載入憑證例外(略過):', e?.message || e); }

  await writeStatus('running', '瀏覽器啟動中', 0);
  const client = await PlaywrightClient.create({ width: VP_W || 1280, height: VP_H || 800, url: START_URL });

  // 讀注入知識(engine 已組 context.json)。
  let knowledge = '';
  let evidence = null; // 證據協議(由類型知識庫決定)
  let controls = null; // 操作方式協議(engine 依測試腳本 controls: / keys: 組成)
  try {
    const ctx = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/context.json` }))).Body.transformToString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
    if (ctx && ctx.evidence && typeof ctx.evidence === 'object') evidence = ctx.evidence;
    if (ctx && ctx.controls && Array.isArray(ctx.controls.allowedActions)) controls = ctx.controls;
  } catch { /* 無則略過 */ }
  // 舊案例只勾了手機觸控方案(搖桿、技能鍵…,多半是依類型自動預選)→ 在網頁上沒有意義,
  // 維持舊行為(不限定動作、不注入手機操作說明),避免把原本能用的鍵盤擋掉。
  // 有勾「鍵盤」或「滑鼠」(網頁版的操作方式選擇器)或有按鍵對應,才依測試腳本把關。
  if (controls && !(controls.ids || []).some((id) => id === 'keyboard' || id === 'mouse') && !(Array.isArray(controls.keys) && controls.keys.length)) {
    console.log('操作方式只有手機觸控方案,網頁測試不套用:', (controls.ids || []).join(','));
    controls = null;
  }
  // 操作方式(測試腳本勾的鍵盤 / 滑鼠 / 觸控方案)與按鍵對應;null = 未指定,不限定。
  const allowedActions = controls ? new Set(controls.allowedActions) : null;
  const allowedKeys = controls && Array.isArray(controls.keys) && controls.keys.some((k) => KEY_IDS.includes(k.key))
    ? new Set(controls.keys.map((k) => k.key).filter((k) => KEY_IDS.includes(k)))
    : null;
  if (controls) console.log('操作方式', (controls.ids || []).join(','), '可用動作', controls.allowedActions.join('/'), allowedKeys ? `按鍵 ${[...allowedKeys].join(',')}` : '');
  let controlNote = ''; // 上一步被操作方式擋下時,下一回合提醒 AI

  // 應用記憶(使用者教過 AI 的經驗 + 記憶地圖編修)與測試人員即時指令通道(見 operatorMemory.mjs)。
  const S3CMDS = { ListObjectsV2Command, GetObjectCommand, PutObjectCommand };
  const appMemory = await loadAppMemory({ s3, bucket: BUCKET, memPrefix: MEM_PREFIX, cmds: S3CMDS });
  const operator = createOperatorChannel({ s3, bucket: BUCKET, jobPrefix: PREFIX, cmds: S3CMDS });
  const messages = [];
  const steps = [];
  // 載入時先收斂舊格式的雜亂資料,之後以新規則增量更新(見 memoryGraph.mjs);套用使用者刪除的畫面/路徑。
  const struct = applyEdits(compactStructure(await loadStructure()), appMemory.edits, { renames: false, addedEdges: false });
  // 路線裡的畫面名:優先用測試人員改的名字(路線是他們畫的);畫面已不存在回空字串。
  const routePageName = (id) => appMemory.edits?.renames?.[id] ?? struct.pages?.[id]?.name ?? '';
  const system = buildSystemPrompt(knowledge, evidence, controls) + hintsPromptSection(appMemory.hints, (id) => struct.pages?.[id]?.name ?? id) + routesPromptSection(appMemory.edits?.routes, routePageName);
  // 記憶命中追蹤(以本次開始前的記憶為基準;見 memoryTrace.mjs)。
  const memTrace = createMemoryTrace({ struct, hints: appMemory.hints, edits: appMemory.edits, knowledge, knowledgeLimit: 4000 });
  console.log(memTrace.startupLog());
  let prevPageId = null, prevAction = null, navAction = null, prevTarget = '';
  let navOp = null; // 上一步實際執行的操作細節(0~1 座標),記進記憶地圖供記憶腳本重播 / 匯出
  let prevScreen = '';
  let pendingCmds = []; // 尚未得到有效回應的測試人員指令
  let consecFail = 0;
  let finalState = 'fail';
  let finalMsg = Number.isFinite(MAX_STEPS) ? '達步數上限仍未完成' : '探索結束';
  const tok = { input: 0, output: 0 };
  let lastPhash = null, stuckCount = 0;
  const screenSeen = new Map();
  const LOOP_ABORT_LIMIT = 8;
  let consecParseFail = 0;

  await writeStatus('running', 'AI 網頁探索執行中', 0);

  // ── 即時畫面串流:CDP screencast 連續 JPEG 幀 → 覆寫 live.jpg(節流 ~8fps)。
  // 只保留最新幀、以 in-flight 旗標避免上傳堆積;與逐步截圖/決策互不干擾。
  const LIVE_KEY = `${PREFIX}/live`;
  const LIVE_MIN_INTERVAL_MS = 120; // ~8fps 上限
  let liveLatest = null; // 最新一幀 base64(尚未上傳)
  let liveUploading = false;
  let liveLastAt = 0;
  const pumpLive = async () => {
    if (liveUploading || !liveLatest) return;
    const now = Date.now();
    if (now - liveLastAt < LIVE_MIN_INTERVAL_MS) return;
    const b64 = liveLatest; liveLatest = null; liveUploading = true; liveLastAt = now;
    try { await s3put(LIVE_KEY, Buffer.from(b64, 'base64'), 'image/jpeg'); } catch { /* 幀丟失不影響 */ }
    finally { liveUploading = false; }
  };
  const liveTimer = setInterval(() => { void pumpLive(); }, LIVE_MIN_INTERVAL_MS);
  if (liveTimer.unref) liveTimer.unref();
  const stopScreencast = await client.startScreencast((b64) => { liveLatest = b64; }, { quality: 55, maxWidth: 1280, maxHeight: 800 }).catch(() => async () => {});

  for (let i = 0; i < MAX_STEPS; i++) {
    if (await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; break; }
    const t0 = Date.now();
    let shot;
    try { shot = await client.takeScreenshot(); } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續截圖失敗'; break; } continue; }
    await s3put(`${PREFIX}/screenshots/${i}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});

    const curPhash = MAGICK ? pHashHex(shot) : null;
    const screenChanged = lastPhash && curPhash ? pHashHamming(lastPhash, curPhash) > 40 : true;
    if (lastPhash && !screenChanged) stuckCount++; else stuckCount = 0;
    lastPhash = curPhash;

    const dimNow = pngSize(Buffer.from(shot, 'base64'));
    const origW = dimNow ? dimNow.w : (VP_W || 1280);
    const origH = dimNow ? dimNow.h : (VP_H || 800);
    // smart-resize:送模型的圖 == 模型座標基準 cw×ch。
    const ds = MAGICK ? resizeToSmartB64(shot, origW, origH) : { b64: shot, w: origW, h: origH, bytes: Math.floor((shot.length * 3) / 4), format: 'png' };
    const cw = ds.w, ch = ds.h, visionFmt = ds.format;
    const ssDim = { w: cw, h: ch };
    const dimHint =
      `這張截圖尺寸為 ${cw}x${ch} 像素(寬x高)。座標請用「這張圖的絕對像素」:左上 (0,0),右下 (${cw},${ch})。把座標對到元件本身的正中心。` +
      (stuckCount >= 2 ? `【注意】畫面已連續 ${stuckCount + 1} 步沒變化——換一個明顯不同的位置或改用 swipe 捲動。` : (i > 0 && !screenChanged ? '上一步後畫面沒變,換個位置或做法。' : ''));
    const freshCmds = await operator.poll();
    for (const c of freshCmds) await operator.ack(c, { status: 'received', step: i, screen: prevScreen || undefined });
    // 上一步回應無法解析的指令延續到這一步,仍以「剛下的指令」注入。
    const newCmds = [...pendingCmds, ...freshCmds];
    pendingCmds = [];
    const scoped = screenHintsFor(appMemory.hints, { screen: prevScreen, pageId: prevPageId });
    const memoryNote = scoped.length
      ? `\n【記憶提醒】你之前在「${prevScreen}」被測試人員教過(由新到舊,矛盾時照第一則):${scoped.slice(0, 3).map((h) => `「${h.text}」`).join(';')}。照做,不要重複撞牆。`
      : '';
    const turnText = (i === 0 ? `第一張畫面(網址 ${client.currentUrl()})。目標:${TASK}` : `上一步(${prevAction})執行後的最新畫面。`) + dimHint
      + controlNote
      + memoryNote + routeTurnNote(appMemory.edits?.routes, prevPageId, routePageName) + operatorTurnNote(newCmds, operator.active);
    controlNote = '';
    messages.push(makeUserTurn([ds.b64], turnText, visionFmt));

    const tVlm = Date.now();
    // 測試人員在即時畫面上點了位置 / 拖了一段 → 這一步直接照做(不靠 AI 猜座標)。
    const pointCmd = [...newCmds].reverse().find((c) => c.point);
    let decided = pointCmd
      ? (() => {
          const g = operatorGestureCmd(pointCmd, cw, ch);
          const label = pointCmd.text && pointCmd.text !== POINT_ONLY_TEXT && pointCmd.text !== DRAG_ONLY_TEXT ? pointCmd.text : '';
          const how = g.operatorDrag
            ? `依測試人員在即時畫面上拖曳的路徑,從 (${g.x}, ${g.y}) 按住拖到 (${g.x2}, ${g.y2}),耗時 ${g.durationMs} ms`
            : `依測試人員在即時畫面上點選的位置直接點擊 (${g.x}, ${g.y})`;
          // drag:true → PlaywrightClient 一定用滑鼠按住拖曳(不會把垂直拖曳改成捲動)。
          const op = { ...g, ...(g.operatorDrag ? { drag: true } : {}), ...(prevScreen ? { screen: prevScreen } : {}), thinking: `${how}${label ? `(${label})` : ''}。` };
          return { cmd: op, usage: null, rawText: JSON.stringify(op), trace: { modelId: 'operator', ok: true } };
        })()
      : await decide(system, messages);
    // 模型回空白/亂碼:同模型只帶當前畫面重問;仍失敗則換穩定備援模型。
    if (!pointCmd && decided.cmd.parseFailed && decided.trace?.ok !== false) {
      for (const model of [VLM, VLM_RETRY_FALLBACK]) {
        const retry = await decide(system, [messages[messages.length - 1]], model);
        if (retry.trace?.ok === false) continue;
        if (retry.usage && decided.usage) retry.usage = addUsage(retry.usage, decided.usage);
        decided = { ...retry, trace: { ...retry.trace, retries: (decided.trace?.retries ?? 0) + 1, ...(model !== VLM ? { fallbackModel: model } : {}) } };
        if (!retry.cmd.parseFailed) break;
      }
    }
    const { cmd, usage, rawText, trace } = decided;
    const vlmMs = Date.now() - tVlm;
    messages.push(makeAssistantTurn(rawText));
    if (usage) accumulate(tok, usage);

    const traceRecord = {
      index: i, seat: 'vlm', modelId: trace?.modelId ?? VLM, channel: trace?.channel, ok: trace?.ok !== false,
      request: { ...(trace?.request || {}), url: client.currentUrl(), image: { origSize: `${origW}x${origH}`, sentSize: `${cw}x${ch}`, format: visionFmt, approxKB: Math.round((ds.bytes || 0) / 1024) } },
      rawResponse: trace?.rawResponse ?? rawText ?? '',
      ...(trace?.tokens ? { tokens: trace.tokens } : {}),
      ...(trace?.error ? { error: trace.error } : {}),
      at: new Date().toISOString(),
    };
    await s3put(`${PREFIX}/traces/${i}.json`, JSON.stringify(traceRecord), 'application/json').catch(() => {});

    // 座標數值化 + 夾範圍(模型回的是 smart-resize 圖 cw×ch 的像素)。
    for (const k of ['x', 'y', 'x2', 'y2']) if (cmd[k] != null && typeof cmd[k] !== 'number') { const n = Number(cmd[k]); if (Number.isFinite(n)) cmd[k] = n; }
    const clampTo = (v, span) => Math.max(0, Math.min(span, Math.round(v)));
    if (cmd.x != null && Number.isFinite(cmd.x)) cmd.x = clampTo(cmd.x, cw);
    if (cmd.y != null && Number.isFinite(cmd.y)) cmd.y = clampTo(cmd.y, ch);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) cmd.x2 = clampTo(cmd.x2, cw);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) cmd.y2 = clampTo(cmd.y2, ch);
    // smart-resize 空間 → 視埠像素。
    const toDevX = (x) => Math.max(0, Math.min(origW, Math.round(x * (cw > 0 ? origW / cw : 1))));
    const toDevY = (y) => Math.max(0, Math.min(origH, Math.round(y * (ch > 0 ? origH / ch : 1))));

    const screenName = cmd.screen || `畫面 ${i}`;

    // 【操作方式把關】測試腳本指定了操作方式 / 按鍵對應時:不在允許清單的動作、或沒定義用途的按鍵,
    // 不送到頁面,改成短暫等待並在下一回合告訴 AI 能用什麼(測試人員親手點/拖的不受限)。
    if (typeof cmd.action === 'string') cmd.action = cmd.action.trim().toLowerCase();
    let controlViolation = '';
    if (allowedActions && !cmd.operatorTap && cmd.action && !allowedActions.has(cmd.action)) {
      controlViolation = `上一步你用了「${cmd.action}」,但本遊戲的操作方式只允許:${controls.allowedActions.join(' / ')}。`;
    } else if (cmd.action === 'key' && allowedKeys) {
      const k = normalizeKey(cmd.key);
      if (!k || !allowedKeys.has(k)) {
        controlViolation = `上一步你按了「${cmd.key ?? ''}」,但測試腳本只定義了這些按鍵:${controls.keys.filter((x) => allowedKeys.has(x.key)).map((x) => `${x.key}=${x.purpose || '?'}`).join('、')}。請改用用途相符的鍵。`;
      } else {
        cmd.key = k;
      }
    }
    if (controlViolation) {
      const bad = cmd.action === 'key' ? `key ${cmd.key ?? ''}` : cmd.action;
      cmd.thinking = `[操作方式限制] 「${bad}」不在本遊戲的操作方式內,未執行。` + String(cmd.thinking || '');
      cmd.action = 'wait'; cmd.duration = 1;
      for (const k of ['x', 'y', 'x2', 'y2', 'key']) cmd[k] = undefined;
      cmd.override = 'control_violation';
      controlNote = `\n【操作方式提醒】${controlViolation}`;
    }

    // 落點標記圖(畫在 smart-resize 圖上,座標同空間)。
    let annotatedKey;
    if (MAGICK && (cmd.action === 'tap' || cmd.action === 'swipe') && cmd.x != null && cmd.y != null) {
      const swipeTo = cmd.action === 'swipe' && Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2) ? { x: Math.round(cmd.x2), y: Math.round(cmd.y2) } : undefined;
      const annB64 = annotateTapB64(ds.b64, Math.round(cmd.x), Math.round(cmd.y), cmd.operatorDrag ? 'drag' : cmd.action, ssDim, swipeTo);
      if (annB64) { annotatedKey = `${PREFIX}/annotated/${i}.png`; await s3put(annotatedKey, Buffer.from(annB64, 'base64'), 'image/png').catch(() => { annotatedKey = undefined; }); }
    }

    const step = {
      index: i, action: cmd.action, screen: screenName, thinking: cmd.thinking,
      ...(cmd.x != null ? { x: cmd.x, y: cmd.y, deviceX: toDevX(cmd.x), deviceY: toDevY(cmd.y) } : {}),
      ...(cmd.action === 'swipe' && Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2)
        ? { x2: cmd.x2, y2: cmd.y2, deviceX2: toDevX(cmd.x2), deviceY2: toDevY(cmd.y2), ...(Number.isFinite(cmd.durationMs) ? { swipeMs: cmd.durationMs } : {}) } : {}),
      ...(cmd.operatorTap ? { operatorGesture: cmd.operatorDrag ? 'drag' : 'tap' } : {}),
      ...(cmd.x != null ? { space: { shot: [cw, ch], device: [origW, origH] } } : {}),
      ...(cmd.action === 'key' && cmd.key ? { key: cmd.key, ...(cmd.repeat ? { repeat: cmd.repeat } : {}), ...(cmd.holdMs ? { holdMs: cmd.holdMs } : {}) } : {}),
      ...(cmd.action === 'hold' && cmd.holdMs ? { holdMs: cmd.holdMs } : {}),
      ...(cmd.action === 'tap' && (cmd.button === 'right' || cmd.button === 'middle') ? { button: cmd.button } : {}),
      ...(cmd.override ? { override: cmd.override } : {}),
      url: client.currentUrl(),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotatedKey ? { annotatedKey } : {}),
      durationMs: Date.now() - t0, ...(usage ? { tokens: usage } : {}),
      // ── 證據(報告引擎以程式計算指標)──
      at: new Date(t0).toISOString(),
      vlmMs,
      ...(i > 0 && curPhash ? { screenChanged } : {}),
      ...evidenceFields(cmd, cmd.action),
      ...(cmd.parseFailed ? { parseFailed: true } : {}),
      ...(trace && trace.ok === false ? { modelError: true } : {}),
      ...(newCmds.length && !cmd.parseFailed ? { operatorCommands: newCmds.map((c) => ({ id: c.id, text: c.text })) } : {}),
    };
    steps.push(step);
    await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});
    if (cmd.parseFailed && newCmds.length) pendingCmds = newCmds;
    for (const c of cmd.parseFailed ? [] : newCmds) {
      await operator.ack(c, { status: 'applied', step: i, action: cmd.action, screen: screenName, reply: String(cmd.thinking || '').slice(0, 400) });
    }

    // 記憶地圖:建/更新畫面節點 + 轉移邊。
    const { pageId: pid, isNew } = upsertPage(struct, { name: screenName, pHash: curPhash, module: cmd.module });
    if (isNew) await s3put(`${MEM_PREFIX}/screenshots/${pid}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});
    // 記憶命中(在 recordTransition 之前判斷,才分得出是不是舊記憶)。
    const memHit = memTrace.onStep({
      pageId: pid, screenName, prevPageId, navAction, prevTarget, screenChanged,
      injectedHints: scoped, action: cmd.action, target: typeof cmd.target === 'string' ? cmd.target : '',
    });
    step.memory = memHit;
    console.log(memTrace.formatLog(i, memHit));
    await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});
    if (prevPageId && pid) {
      if (prevPageId !== pid) recordTransition(struct, prevPageId, pid, { action: navAction, target: prevTarget, op: navOp });
      else if (!screenChanged) recordMiss(struct, pid, { action: navAction, target: prevTarget });
      else if (navOp) recordSelfOp(struct, pid, { action: navAction, target: prevTarget, op: navOp });
    }
    struct.lastUpdatedAt = new Date().toISOString();
    await s3put(`${MEM_PREFIX}/structure.json`, JSON.stringify(struct), 'application/json').catch(() => {});

    await writeStatus('running', `第 ${i + 1} 步:${cmd.action} @ ${screenName}`, steps.length);

    // 凍結畫面中止:畫面連續多步完全沒變(phash 不變)→ 可能載入卡死/被外部驗證阻擋/需人工。
    // 前 STUCK_WAIT_STEPS 步只耐心等待(可能仍在載入),超過硬上限仍全無變化 → 判定 error 結束,
    // 避免步數無上限的任務在雲端無止盡空轉計費。(對齊真機 runner 的耐心+中止策略。)
    if (stuckCount >= 3) {
      const STUCK_WAIT_STEPS = 12;   // 前 12 步只耐心等待,不判死
      const STUCK_ABORT_STEPS = 24;  // 連續 24 步畫面全無變化 → 判定卡死中止
      const loadingHint = /loading|載入|载入|請稍候|请稍候|connecting|連線中|连接中|加载|驗證|验证|captcha|recaptcha/i;
      const looksLoading = loadingHint.test(String(cmd.thinking || '')) || loadingHint.test(String(screenName || ''));
      if (stuckCount >= STUCK_ABORT_STEPS) {
        finalState = 'error';
        finalMsg = looksLoading
          ? `畫面連續 ${stuckCount} 步無變化且停在載入/驗證畫面 —— 可能頁面載入失敗/逾時或被外部驗證(如 reCAPTCHA)阻擋。已中止,避免空轉。`
          : `畫面連續 ${stuckCount} 步無變化,無法前進 —— 可能當機/卡死或需人工介入。已中止,避免空轉。`;
        await writeStatus('error', finalMsg, steps.length);
        break;
      }
    }

    // 死循環偵測:同畫面名反覆出現 → 提早收斂。
    const seen = (screenSeen.get(screenName) || 0) + 1;
    screenSeen.set(screenName, seen);
    if (seen >= LOOP_ABORT_LIMIT) { finalState = 'fail'; finalMsg = `偵測到死循環:畫面「${screenName}」反覆出現 ${seen} 次仍無法前進,提早結束。`; break; }

    // 連續解析失敗 = 模型輸出異常(AI 測試失敗),中止並明確回報。
    consecParseFail = cmd.parseFailed ? consecParseFail + 1 : 0;
    if (consecParseFail >= 10) { finalState = 'error'; finalMsg = `VLM 連續 ${consecParseFail} 次回應無法解析為有效動作 —— 模型輸出格式異常,已中止(避免誤判為完成)。`; break; }
    // 模型呼叫失敗時 decide() 回 done:這是 AI 測試代理失敗,不可判 pass。
    if (cmd.action === 'done' && trace && trace.ok === false) { finalState = 'error'; finalMsg = String(cmd.thinking || '模型呼叫失敗'); break; }
    if (cmd.action === 'done') { finalState = 'pass'; finalMsg = cmd.thinking || '流程完成'; break; }
    // AI 思考期間按了停止:不要再把動作送到頁面。
    if (await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; break; }
    // 實際操作用視埠像素座標。
    const deviceCmd = { ...cmd };
    if (cmd.x != null && Number.isFinite(cmd.x)) deviceCmd.x = toDevX(cmd.x);
    if (cmd.y != null && Number.isFinite(cmd.y)) deviceCmd.y = toDevY(cmd.y);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) deviceCmd.x2 = toDevX(cmd.x2);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) deviceCmd.y2 = toDevY(cmd.y2);
    // 憑證替換:僅在「輸入到頁面」時換成真值。缺值時重載一次後 fail closed,不輸入 literal `${...}`。
    if (deviceCmd.action === 'type' && typeof deviceCmd.text === 'string' && deviceCmd.text.length > 0) {
      try {
        let sub = await substituteText(deviceCmd.text, appCredentials);
        if (sub.missing.length > 0) {
          appCredentials = await loadAppCredentials();
          sub = await substituteText(deviceCmd.text, appCredentials);
        }
        if (sub.missing.length > 0) {
          const missingKeys = sub.missing.map((x) => x.replace(/^\$\{|\}$/g, ''));
          finalState = 'error';
          finalMsg = `測試案例引用的憑證尚未設定:${missingKeys.join('、')}。請在應用管理設定同名 key。`;
          await writeStatus('error', finalMsg, steps.length);
          break;
        }
        deviceCmd.text = sub.text;
      } catch (e) {
        finalState = 'error'; finalMsg = `測試憑證解析失敗:${String(e?.message || e).slice(0, 200)}`;
        await writeStatus('error', finalMsg, steps.length);
        break;
      }
    }
    let actOk = false;
    try { await client.act(deviceCmd); actOk = true; consecFail = 0; } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續動作失敗'; break; } }
    // 導覽圖:AI 沒給畫面名時沿用上一個已知畫面;該步只是 wait 則不覆蓋真正造成轉場的動作。
    prevAction = cmd.action; // 給 prompt 用
    if (cmd.screen) prevScreen = screenName;
    if (pid) {
      prevPageId = pid; navAction = cmd.action; prevTarget = typeof cmd.target === 'string' ? cmd.target : '';
      navOp = actOk && !cmd.override ? opFromCmd(cmd, cw, ch) : null;
    }
    else if (cmd.action !== 'wait') { navAction = cmd.action; prevTarget = ''; navOp = null; }
    await sleep(2500);
  }

  // 停止即時串流(先停,避免 quit 後仍嘗試上傳)。
  clearInterval(liveTimer);
  await stopScreencast().catch(() => {});

  console.log(memTrace.summaryLog());
  await s3put(`${PREFIX}/memory-usage.json`, JSON.stringify(memTrace.summary()), 'application/json').catch(() => {});
  const nodes = Object.values(struct.pages).map((p) => ({ id: p.id, name: p.name, screenshotKey: `${MEM_PREFIX}/screenshots/${p.id}.png` }));
  // 結束前才按停止:以使用者的「停止」為準;真的完成(pass)則保留。
  if (finalState !== 'pass' && finalState !== 'cancelled' && await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; }
  const report = { jobId: JOB, state: finalState, message: finalMsg, task: TASK, device: { w: VP_W || 1280, h: VP_H || 800 }, vlmModel: VLM, runnerVersion: RUNNER_VERSION, ...(evidence?.profiles ? { evidenceProfiles: evidence.profiles } : {}), stepCount: steps.length, steps, navGraph: { nodes, edges: struct.edges }, tokens: tok, tokensByModel: vlmLedger.byModel(), generatedAt: new Date().toISOString() };
  await s3put(`${PREFIX}/report.json`, JSON.stringify(report), 'application/json').catch(() => {});
  await writeStatus(finalState, finalMsg, steps.length);
  await client.quit().catch(() => {});
}

main().catch(async (e) => { await writeStatus('error', String(e), 0); process.exitCode = 1; });
