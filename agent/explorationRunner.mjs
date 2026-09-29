#!/usr/bin/env node
/**
 * Device Farm 探索 runner —— 跑在 ECS Fargate task 容器內。
 *
 * 用 AppiumClient 驅動 Device Farm 真機,跑 screenshot → Bedrock VLM 決策 → act 迴圈,
 * 每步把截圖 / step trace / 增量記憶地圖寫回 S3(供前端即時呈現),結束寫 report + 終態 status。
 *
 * 與 emulatorRunner.mjs 的差異:
 *   - 動作執行走 Appium(真機),非 adb;
 *   - Bedrock 呼叫走 AWS SDK,非主機 aws cli;
 *   - VLM 座標即裝置座標(Appium 截圖與點擊同座標空間),不需 emulator 的旋轉/縮放轉換。
 *
 * 環境變數(engine 啟動 Fargate task 時注入):
 *   PA_ARTIFACT_KEY     被測 APK/IPA 的 S3 key(runner 自行讀取 → 上傳 Device Farm → 開 session)
 *   PA_APPIUM_URL       (選)已建好的 Device Farm remoteDriverEndpoint;有則跳過前置
 *   PA_SESSION_ARN      (選)已建好的 Device Farm session ARN(供 endpoint 刷新)
 *   PA_PLATFORM         android | ios
 *   PA_JOB / PA_TENANT / PA_BUCKET / PA_PREFIX   S3 位置(us-east-2 資料桶)
 *   PA_VLM              VLM modelId
 *   PA_PKG              app 包名(啟動用)
 *   PA_TASK             探索目標文字
 *   PA_MAXSTEPS         步數上限(預設 40)
 *   PA_DF_PROJECT       (選)Device Farm 專案名(預設 playagent-checker)
 *   PA_MAX_OS / PA_MIN_OS  (選)真機 OS 版本區間收斂
 *
 * 架構:重活(讀數百 MB APK、上傳 Device Farm、等真機 session RUNNING)都在此 Fargate
 * 容器內做——engine Lambda 512MB/5 分無法承載。engine 只負責起這個 task。
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  DeviceFarmClient,
  StopRemoteAccessSessionCommand,
} from '@aws-sdk/client-device-farm';
import { AppiumClient } from './appiumClient.mjs';
import { refreshRemoteDriverEndpoint } from './deviceFarmRefresh.mjs';
import { setupDeviceFarmSession } from './deviceFarmSetup.mjs';
import { magickAvailable, gridOverlayB64, findBrightButton, findButtonBands, annotateTapB64, pHashHex, pHashHamming, downscaleForVlmB64, resizeToSmartB64 } from './imageTools.mjs';
import { uitarsEnabled, decideUitars } from './uitarsClient.mjs';

let APPIUM_URL = process.env.PA_APPIUM_URL;
let SESSION_ARN = process.env.PA_SESSION_ARN;
const ARTIFACT_KEY = process.env.PA_ARTIFACT_KEY || '';
const APP_ID = process.env.PA_APP || '';
const DF_PROJECT = process.env.PA_DF_PROJECT || 'playagent-checker';
const MAX_OS = process.env.PA_MAX_OS ? Number(process.env.PA_MAX_OS) : undefined;
const MIN_OS = process.env.PA_MIN_OS ? Number(process.env.PA_MIN_OS) : undefined;
// 使用者提交時明選的實體裝置 ARN(有帶就用這台;沒帶才由 OS 區間挑第一台可用真機)。
const DEVICE_ARN = process.env.PA_DEVICE_ARN || undefined;
const PLATFORM = process.env.PA_PLATFORM === 'ios' ? 'ios' : 'android';
const JOB = process.env.PA_JOB;
const BUCKET = process.env.PA_BUCKET;
const PREFIX = process.env.PA_PREFIX;
const DATA_REGION = process.env.PA_DATA_REGION || 'us-east-2';
const DF_REGION = process.env.PA_DF_REGION || 'us-west-2';
const VLM = process.env.PA_VLM || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const PKG = process.env.PA_PKG || '';
const TASK = process.env.PA_TASK || '啟動遊戲,通過開場動畫與任何彈窗,進入主畫面,並嘗試開始一場遊戲';
// 步數上限:PA_MAXSTEPS 未設或 <=0 代表「無上限」(跑到 done / 卡死偵測 / 取消 / 連續失敗才停)。
const _maxStepsRaw = Number(process.env.PA_MAXSTEPS || 0);
const MAX_STEPS = Number.isFinite(_maxStepsRaw) && _maxStepsRaw > 0 ? _maxStepsRaw : Infinity;
const CONSEC_FAIL_LIMIT = 3;

const s3 = new S3Client({ region: DATA_REGION });
const bedrock = new BedrockRuntimeClient({ region: DATA_REGION });
const dfClient = new DeviceFarmClient({ region: DF_REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 容器內是否有 ImageMagick(建置時裝);有才啟用網格疊圖/亮鈕吸附/落點標記等座標校正。
const MAGICK = magickAvailable();

// 定位模型路由:設了 PA_UITARS_ENDPOINT 就用 SageMaker 上的 UI-TARS(GUI grounding 專用,座標較準),
// 否則走 Bedrock 通用 VLM(Claude/Qwen)。UI-TARS 走單幀 + smart-resize 絕對像素,見 uitarsClient.mjs。
const USE_UITARS = uitarsEnabled();

// runner 自建 session 的收尾追蹤(loop 中途拋錯時,頂層 catch 也要停 session 釋放真機/停計費)。
let selfOwnedSessionArn = null;
async function stopSelfOwnedSession() {
  if (!selfOwnedSessionArn) return;
  const arn = selfOwnedSessionArn;
  selfOwnedSessionArn = null;
  await dfClient.send(new StopRemoteAccessSessionCommand({ arn })).catch(() => {});
}

async function s3put(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** 解析 PNG 標頭取真實像素寬高(IHDR:偏移 16..19 寬、20..23 高,大端)。非 PNG 回 null。 */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG 簽章 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h) return null;
  return { w, h };
}
async function writeStatus(state, message, steps) {
  await s3put(`${PREFIX}/status.json`,
    JSON.stringify({ jobId: JOB, state, message, steps: steps ?? 0, updatedAt: new Date().toISOString() }),
    'application/json').catch(() => {});
}

// ── VLM 決策(純邏輯,對齊 emulatorRunner 的 prompt/對話策略,但改用 SDK)──

function buildSystemPrompt(w, h, knowledge, _hasGrid) {
  const base =
    `你是專業遊戲測試工程師,正在測試一個 ${PLATFORM === 'ios' ? 'iOS' : 'Android'} 遊戲。每一步你會看到一張最新截圖。` +
    // A 路座標契約:直接回「這張圖的絕對像素座標」(Qwen-VL 系天生的定位方式),不要正規化。
    `【座標規則|最重要】座標一律用「你看到的這張截圖的絕對像素」:左上角是 (0,0),往右 x 變大、往下 y 變大,` +
    `右下角就是該張圖的寬與高。每張圖尺寸會在該回合訊息中告知(如「這張截圖尺寸為 952x2156 像素」)。` +
    `請把座標精準對到「按鈕/元件本身的正中心」(不是彈窗或文字區塊的中心)。不要用比例、不要用 0~1000。` +
    `這是連續對話,你會記得前幾步做了什麼。每步之後我會給你執行後的最新畫面,據此判斷上一步是否生效:` +
    `若畫面推進→繼續;若沒變(無效點擊)→不要重複同座標,改點別的、換座標、或 back/swipe。` +
    `策略:遊戲開場常有彈窗/公告/教學/權限提示,積極關閉或確認它們以穿透到主畫面。` +
    `遇到「錯誤/重連(RECONNECT/try again)」彈窗時,點該按鈕重試以恢復連線,不要當成死路。` +
    `但若「同一個錯誤彈窗」(如登入失敗 login failed)已反覆出現多次、點掉又立刻跳出,代表此裝置環境無法完成該登入,` +
    `不要一直點它空轉;改走其他入口(如免登入的訪客/Play now),真的無其他路可走再用 done 收尾並在 thinking 說明原因。` +
    `目標:${TASK}` +
    `先簡短思考(thinking),再給動作。只輸出 JSON:` +
    `{"thinking":"...","action":"tap|swipe|back|type|wait|launch|done","x":<像素>,"y":<像素>,"x2":<像素>,"y2":<像素>,"text":"...","screen":"畫面名稱"}。` +
    `x/y 是「這張圖的像素座標」。tap 需 x,y;swipe 需 x,y,x2,y2;type 需 text;done 只在真正完成或完全無法進行時用。` +
    `screen 用精確畫面名(如「主選單」「大廳」「轉軸畫面」「載入中」)描述當前畫面,不同畫面用不同名稱。`;
  const k = typeof knowledge === 'string' ? knowledge.trim() : '';
  if (!k) return base;
  return base + `\n\n這款遊戲「類型」的背景知識(參考,畫面以截圖為準):\n${k.slice(0, 4000)}`;
}

function makeUserTurn(images, text, fmt = 'png') {
  const mediaType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  const content = [];
  // 記下每張圖的格式(jpeg/png),供 Converse 轉換時用正確 format。
  for (const b64 of images) if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
  content.push({ type: 'text', text });
  return { role: 'user', content };
}
function makeAssistantTurn(rawText) {
  return { role: 'assistant', content: [{ type: 'text', text: rawText }] };
}
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
/**
 * 由 modelId 推導呼叫通道(對齊後端 modelCatalog.channelFromModelId):
 *   anthropic.* → 'bedrock'(InvokeModel + Anthropic body:max_tokens/messages)
 *   其餘(Nova/Llama/Qwen/DeepSeek 等)→ 'converse'(Bedrock Converse API,統一格式)
 * 之前 runner 只發 Anthropic body,選 Nova 等模型會被 Bedrock 拒(extraneous key max_tokens)。
 */
function channelFor(modelId) {
  const base = String(modelId).replace(/^(us|eu|apac|jp|au|global)\./, '');
  if (base.startsWith('anthropic.')) return 'bedrock';
  return 'converse';
}

/** 從模型輸出的文字抽出決策 JSON;失敗回 done。 */
function parseCmd(out) {
  const m = /\{[\s\S]*\}/.exec(out || '');
  try { return m ? JSON.parse(m[0]) : { action: 'done', thinking: '無法解析回應' }; }
  catch { return { action: 'done', thinking: '無法解析回應 JSON' }; }
}

/** 把內部 Anthropic 形態的 messages 轉成 Converse API 形態(image bytes + text)。 */
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

/** 概述本次要送出的 request(供 Log 呈現;不落整張圖的 base64,只記數量與體積)。 */
function summarizeRequest(system, messages) {
  let imageCount = 0;
  let imageBytes = 0;
  let lastText = '';
  for (const m of messages) {
    for (const c of m.content || []) {
      if (c.type === 'image' && c.source?.data) {
        imageCount += 1;
        // base64 長度 ≈ 原始位元組 × 4/3;估回原始位元組。
        imageBytes += Math.floor((c.source.data.length * 3) / 4);
      } else if (c.type === 'text' && m.role === 'user') {
        lastText = c.text;
      }
    }
  }
  return {
    systemChars: (system || '').length,
    turnText: lastText,
    imageCount,
    imageApproxKB: Math.round(imageBytes / 1024),
    messageTurns: messages.length,
  };
}

/**
 * 呼叫 VLM 決策,並回傳完整 trace 供 Log 呈現:
 *   { cmd, usage, rawText, trace }
 * trace = { modelId, channel, request:{...摘要}, rawResponse, tokens, ok, error? }
 * 失敗(如請求 body 太大、ValidationException)不再吞掉:回 cmd=done + trace.error 完整訊息。
 */
/** 估算 messages 內所有圖片的原始位元組總量(base64 長度 × 3/4)。 */
function totalImageBytes(messages) {
  let bytes = 0;
  for (const m of messages) for (const c of m.content || []) {
    if (c.type === 'image' && c.source?.data) bytes += Math.floor((c.source.data.length * 3) / 4);
  }
  return bytes;
}

async function decide(system, messages) {
  // 預設保留最近 2 張圖;但再加一道保險:若總圖量仍逼近模型 body 上限(~2MB),就降到只留最新 1 張,
  // 避免像大廳這種細節多的畫面兩張疊起來撐爆(Failed to buffer request body: length limit exceeded)。
  pruneImages(messages, 2);
  const SOFT_LIMIT = 1_500_000; // ~1.5MB 原始位元組(base64 會再脹 ~33%,保守留裕度)
  if (totalImageBytes(messages) > SOFT_LIMIT) pruneImages(messages, 1);
  const channel = channelFor(VLM);
  const request = summarizeRequest(system, messages);
  const baseTrace = { modelId: VLM, channel, request };
  try {
    if (channel === 'bedrock') {
      // Anthropic Claude:InvokeModel + Anthropic body。
      const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 500, system, messages };
      const res = await bedrock.send(new InvokeModelCommand({
        modelId: VLM, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body),
      }));
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      const out = parsed.content?.find((c) => c.type === 'text')?.text ?? '{}';
      const usage = parsed.usage ? { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens } : null;
      return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
    }
    // Nova / Llama / Qwen / DeepSeek 等:Bedrock Converse API(統一格式,含視覺)。
    const res = await bedrock.send(new ConverseCommand({
      modelId: VLM,
      system: [{ text: system }],
      messages: toConverseMessages(messages),
      inferenceConfig: { maxTokens: 500 },
    }));
    const out = res.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '{}';
    const usage = res.usage ? { input: res.usage.inputTokens, output: res.usage.outputTokens } : null;
    return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
  } catch (err) {
    // 模型呼叫失敗(如「請求 body 太大」「ValidationException」)—— 完整落地,不再只留一句 status。
    const name = err && err.name ? String(err.name) : 'Error';
    const message = err && err.message ? String(err.message) : String(err);
    return {
      cmd: { action: 'done', thinking: `模型呼叫失敗:${message}` },
      usage: null,
      rawText: '',
      trace: { ...baseTrace, ok: false, error: { name, message } },
    };
  }
}

// ── 增量記憶地圖(每步更新 structure.json,供前端即時重繪)──

const MEM_PREFIX = `tenants/${process.env.PA_TENANT}/memory/${process.env.PA_APP}`;
async function loadStructure() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${MEM_PREFIX}/structure.json` }));
    return JSON.parse(await res.Body.transformToString());
  } catch {
    return { schemaVersion: 1, appName: process.env.PA_APP, rootPageId: null, pages: {}, edges: [], lastUpdatedAt: null };
  }
}
function pageIdFromName(name, idx) {
  let h = 0; const s = String(name || `screen_${idx}`);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `page_${h.toString(16).padStart(8, '0')}`;
}

async function main() {
  // 前置:若 engine 未預先建好 session,runner 自行讀 APK → 上傳 Device Farm → 開 session。
  // 重活在此(Fargate),不在 engine(512MB/5 分撐不住數百 MB APK)。
  let ownsSession = false;
  let deviceModel; // 執行此任務的實體真機機型(寫進 report 供前端顯示)
  if (!APPIUM_URL) {
    if (!ARTIFACT_KEY) throw new Error('缺少 PA_ARTIFACT_KEY,無法建立 Device Farm session');
    await writeStatus('running', 'Device Farm:上傳 APK 並開真機 session 中', 0);
    const session = await setupDeviceFarmSession(
      { dfClient, s3 },
      {
        bucket: BUCKET,
        artifactKey: ARTIFACT_KEY,
        appId: APP_ID || JOB,
        jobId: JOB,
        platform: PLATFORM,
        projectName: DF_PROJECT,
        ...(DEVICE_ARN ? { deviceArn: DEVICE_ARN } : {}),
        ...(MAX_OS !== undefined ? { maxOsVersion: MAX_OS } : {}),
        ...(MIN_OS !== undefined ? { minOsVersion: MIN_OS } : {}),
      },
    );
    APPIUM_URL = session.appiumUrl;
    SESSION_ARN = session.sessionArn;
    ownsSession = true;
    selfOwnedSessionArn = session.sessionArn;
    deviceModel = session.deviceModel;
    await writeStatus('running', `Device Farm 真機就緒(${deviceModel ?? '真機'}),Appium 連線中`, 0);
  } else {
    await writeStatus('running', 'Appium 連線中', 0);
  }

  const refreshEndpoint = SESSION_ARN
    ? () => refreshRemoteDriverEndpoint(dfClient, SESSION_ARN)
    : undefined;
  const client = await AppiumClient.create(APPIUM_URL, { platform: PLATFORM, autoLaunch: false, refreshEndpoint });

  // 機型後備:engine 若已預建 session,runner 這邊沒有 session.deviceModel,
  // 改從 Appium 連上後的 capabilities 讀(UiAutomator2 通常帶 deviceModel/deviceManufacturer)。
  // 都取不到才用使用者提交時所選機型(PA_DEVICE_MODEL)當顯示後備。
  if (!deviceModel) {
    try { const di = client.deviceInfo?.(); if (di?.model) deviceModel = di.model; } catch { /* 取不到就算了 */ }
  }
  if (!deviceModel && process.env.PA_DEVICE_MODEL) deviceModel = process.env.PA_DEVICE_MODEL;

  // 讀注入知識(engine 已組 context.json)。
  let knowledge = '';
  try {
    const ctx = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/context.json` }))).Body.transformToString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
  } catch { /* 無則略過 */ }

  // 啟動 app。
  if (PKG) { try { await client.launchPackage(PKG); await sleep(8000); } catch { /* 交給 agent 視覺找入口 */ } }

  // 座標空間以「實際截圖像素尺寸」為準(Appium 截圖空間 == 點擊空間)。
  // 不用 getWindowSize:Device Farm/UiAutomator2 有時回傳直向預設,與橫向遊戲畫面不符,
  // 導致 VLM 座標整個錯位(PLAY 按鈕點不到)。改由首張截圖的 PNG 標頭解析真實寬高。
  let w = 1080, h = 1920;
  try {
    const probe = await client.takeScreenshot();
    const dim = pngSize(Buffer.from(probe, 'base64'));
    if (dim) { w = dim.w; h = dim.h; }
    else { const [gw, gh] = await client.getScreenSize().catch(() => [1080, 1920]); w = gw; h = gh; }
  } catch {
    const [gw, gh] = await client.getScreenSize().catch(() => [1080, 1920]); w = gw; h = gh;
  }
  const system = buildSystemPrompt(w, h, knowledge, MAGICK);
  console.log('ImageMagick 座標校正', MAGICK ? '啟用' : '不可用(裸座標)');
  console.log('定位模型', USE_UITARS ? `UI-TARS(SageMaker endpoint=${process.env.PA_UITARS_ENDPOINT})` : `Bedrock VLM(${VLM})`);
  const messages = [];
  const steps = [];
  const struct = await loadStructure();
  let prevPageId = null, prevAction = null;
  let consecFail = 0;
  // 無上限時不會「達步數上限」;若真的迴圈自然結束(理論上只有有限步才會),訊息才用步數上限。
  let finalState = 'fail';
  let finalMsg = Number.isFinite(MAX_STEPS) ? '達步數上限仍未完成' : '探索結束';
  const tok = { input: 0, output: 0 };
  // 卡住偵測:連續多步畫面沒變(pHash 幾乎相同)就介入,輪換嘗試中央偏下主按鈕/back/右上角。
  let lastPhash = null;
  let stuckCount = 0;
  // App 死循環偵測:某個「畫面名」(如登入失敗彈窗)反覆出現超過此門檻,代表 App 端阻斷
  // (常見:此裝置無 Google/Facebook 登入環境,關掉彈窗又立刻重跳),提早收斂不空轉到步數上限。
  const screenSeen = new Map();
  const LOOP_ABORT_LIMIT = 8;
  // 方向追蹤(直向/橫向):用來偵測「進遊戲前後方向切換」並提示模型重新評估版面。null=尚未知。
  let prevOrient = null;

  await writeStatus('running', 'AI 探索執行中', 0);

  // ── 即時畫面串流(真機):背景以 ~2.5fps 額外截圖覆寫 live 幀。
  // Appium 單一 session 不可並發:用 in-flight 旗標,若主迴圈或上一張仍在截圖就跳過這輪。
  // 真機 takeScreenshot 是 WebDriver 往返(較慢),故頻率保守(每 400ms 嘗試一次)。
  const LIVE_KEY = `${PREFIX}/live`;
  let liveBusy = false;
  const liveTimer = setInterval(async () => {
    if (liveBusy) return;
    liveBusy = true;
    try {
      const b64 = await client.takeScreenshot();
      await s3put(LIVE_KEY, Buffer.from(b64, 'base64'), 'image/png');
    } catch { /* 幀丟失不影響 */ }
    finally { liveBusy = false; }
  }, 400);
  if (liveTimer.unref) liveTimer.unref();

  for (let i = 0; i < MAX_STEPS; i++) {
    // 取消旗標檢查。
    try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/cancel.json` })); finalState = 'cancelled'; finalMsg = '使用者取消'; break; } catch { /* 無取消 */ }

    const t0 = Date.now();
    // 前景守衛:AI 可能誤按 back 把遊戲退到背景/桌面。已知包名時,每步先確保遊戲在前景,
    // 若被拉回前景則多等一下載入,避免整段在 Android 桌面/Play Games 空轉。
    if (PKG) {
      try {
        const wasForeground = await client.ensureForeground(PKG);
        if (!wasForeground) await sleep(4000);
      } catch { /* 盡力,不擋主流程 */ }
    }
    let shot;
    try { shot = await client.takeScreenshot(); } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續截圖失敗'; break; } continue; }
    // 即時推截圖到 S3(前端即時顯示)。
    await s3put(`${PREFIX}/screenshots/${i}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});

    // 卡住偵測:本步 pHash 與上一步比,幾乎相同(<40 bit)視為畫面沒變。
    const curPhash = MAGICK ? pHashHex(shot) : null;
    const screenChanged = lastPhash && curPhash ? pHashHamming(lastPhash, curPhash) > 40 : true;
    if (lastPhash && !screenChanged) stuckCount++; else stuckCount = 0;
    lastPhash = curPhash;

    // 每步以「當前這張截圖」的真實像素尺寸為原始基準(遊戲可能中途由直向轉橫向,尺寸會變)。
    const dimNow = pngSize(Buffer.from(shot, 'base64'));
    const origW = dimNow ? dimNow.w : w;
    const origH = dimNow ? dimNow.h : h;
    // ── smart-resize(A 路核心)──
    // Qwen-VL 系模型天生「在它 smart_resize 後那張圖的座標系裡回報絕對像素座標」。
    // 故把截圖精確縮到 smart_resize 尺寸再送(送出尺寸 == 模型座標基準 cw×ch),
    // 模型回像素座標後,除以 cw/ch 得比例、再乘 origW/origH → 裝置像素,座標才會準。
    // 不再疊網格、不再要 0~1000(那是造成先前不準的錯誤問法)。
    const ds = MAGICK ? resizeToSmartB64(shot, origW, origH) : { b64: shot, w: origW, h: origH, bytes: Math.floor((shot.length * 3) / 4), format: 'png' };
    const cw = ds.w;   // smart-resize 寬 = 模型座標 x 基準
    const ch = ds.h;   // smart-resize 高 = 模型座標 y 基準
    const visionFmt = ds.format; // 'jpeg' | 'png'
    // 點擊仍換算到裝置截圖空間(origW×origH == Appium 點擊空間);setCoordinateSpace 傳原圖尺寸。
    const space = await client.setCoordinateSpace(origW, origH).catch(() => null);
    if (i === 0 && space) console.log('座標空間 裝置=', space.shot, 'window=', space.win, 'smart-resize(給模型)=', `${cw}x${ch}`, ds.format, `${Math.round(ds.bytes / 1024)}KB`);
    // 方向偵測(僅用於提示模型重新評估版面;不影響座標換算)。
    const isLandscape = origW > origH;
    const orient = isLandscape ? '橫向(landscape,寬>高)' : '直向(portrait,高>寬)';
    const orientChanged = prevOrient != null && prevOrient !== isLandscape;
    // 座標契約:回「這張圖的絕對像素座標」(左上 0,0;右下 cw,ch),不是比例、不是 0~1000。
    const dimHint =
      `這張截圖尺寸為 ${cw}x${ch} 像素(寬x高)。座標請用「這張圖的絕對像素」:左上角是 (0,0),右下角是 (${cw},${ch})。` +
      `把座標對到按鈕/元件本身的正中心。目前畫面方向:${orient}。` +
      (orientChanged
        ? `【方向已改變!】畫面剛從${prevOrient ? '橫向' : '直向'}切成${isLandscape ? '橫向' : '直向'},版面已不同,請重新看清整張圖再定位。`
        : ``);
    const ssDim = { w: cw, h: ch };
    // 送出乾淨的 smart-resize 圖(不疊網格):UI-TARS/Qwen-VL 系是在乾淨圖的 smart-resize 幀
    // 裡吐絕對像素座標,疊網格反而污染 grounding。落點標記/座標鏈都用此 cw×ch 空間。
    const visionShot = ds.b64;
    const stuckNote = (stuckCount >= 2)
      ? `【注意】畫面已連續 ${stuckCount + 1} 步沒有變化 —— 你先前點的位置不是可互動按鈕。請「換一個明顯不同的位置」,對準畫面上最大最醒目的主按鈕(通常在中下段,文字如 Play now / START / 開始 / 進入),把座標對到那顆按鈕的正中心,不要再點同一處或空白處。`
      : (i > 0 && !screenChanged ? '上一步後畫面沒變(可能無效),換個位置或做法。' : '');
    const turnText = (i === 0 ? `第一張畫面。目標:${TASK}` : `上一步(${prevAction})執行後的最新畫面。`) + dimHint + stuckNote;
    messages.push(makeUserTurn([visionShot], turnText, visionFmt));
    // UI-TARS(SageMaker):單幀 GUI grounding,座標直接落在 cw×ch smart-resize 幀;否則走 Bedrock 通用 VLM。
    const { cmd, usage, rawText, trace } = USE_UITARS
      ? await decideUitars(TASK, messages, cw, ch)
      : await decide(system, messages);
    messages.push(makeAssistantTurn(rawText));
    if (usage) { tok.input += usage.input; tok.output += usage.output; }
    // 完整互動 log:每步落一份 traces/<i>.json(模型/channel/請求摘要/原始回應/token/錯誤)。
    // 供任務詳情頁「Log」呈現;失敗步(如請求 body 太大)也會完整記錄錯誤,便於除錯。
    const traceRecord = {
      index: i,
      seat: 'vlm',
      modelId: trace?.modelId ?? VLM,
      channel: trace?.channel,
      ok: trace?.ok !== false,
      // request 摘要(送圖數量/大小/輪數)+ 縮圖資訊(原尺寸→縮圖尺寸/格式/實際 KB),
      // 讓 Log 直接看到「圖從多大降到多少」,便於判斷 body 是否仍過大。
      request: {
        ...(trace?.request || {}),
        image: {
          origSize: `${origW}x${origH}`,
          sentSize: `${cw}x${ch}`,
          format: visionFmt,
          approxKB: Math.round((ds.bytes || 0) / 1024),
        },
      },
      rawResponse: trace?.rawResponse ?? rawText ?? '',
      ...(trace?.tokens ? { tokens: trace.tokens } : {}),
      ...(trace?.error ? { error: trace.error } : {}),
      at: new Date().toISOString(),
    };
    await s3put(`${PREFIX}/traces/${i}.json`, JSON.stringify(traceRecord), 'application/json').catch(() => {});
    // 座標數值化:部分模型(如 Nova)把 x/y 以字串回傳,統一轉成數字供後續吸附/標記/點擊計算。
    for (const k of ['x', 'y', 'x2', 'y2']) {
      if (cmd[k] != null && typeof cmd[k] !== 'number') { const n = Number(cmd[k]); if (Number.isFinite(n)) cmd[k] = n; }
    }
    // A 路:模型回的「已經是 smart-resize 圖(cw×ch)的絕對像素座標」,不需正規化還原。
    // 只夾到 [0, cw/ch] 範圍(模型偶爾越界)。落點標記/吸附都在此 cw×ch 空間;點擊再換算到裝置像素。
    const clampTo = (v, span) => Math.max(0, Math.min(span, Math.round(v)));
    if (cmd.x != null && Number.isFinite(cmd.x)) cmd.x = clampTo(cmd.x, cw);
    if (cmd.y != null && Number.isFinite(cmd.y)) cmd.y = clampTo(cmd.y, ch);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) cmd.x2 = clampTo(cmd.x2, cw);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) cmd.y2 = clampTo(cmd.y2, ch);
    // 縮圖(smart-resize)空間 → 裝置截圖空間 的等比換算係數(origW/cw 與 origH/ch 理論上相同,分開算更穩健)。
    const devScaleX = cw > 0 ? origW / cw : 1;
    const devScaleY = ch > 0 ? origH / ch : 1;
    const toDeviceX = (x) => Math.max(0, Math.min(origW, Math.round(x * devScaleX)));
    const toDeviceY = (y) => Math.max(0, Math.min(origH, Math.round(y * devScaleY)));

    // 卡住脫困:連續 ≥3 步畫面沒變 → VLM 顯然瞄不準或選錯。介入輪換。
    // 但先分辨「安裝/載入畫面」:此時亂點無意義,應「耐心等待」而非脫困(APK 尤其數百 MB 首裝很慢)。
    // 且脫困若試了很多輪畫面仍全無變化,代表真的卡死(安裝失敗/當機/需人工)—— 判定 error 結束,
    // 不再無止盡空轉(尤其步數無上限的任務,避免在真機上一直計費)。
    let escapeOverride = false;
    // 安裝/載入偵測:VLM 的 thinking 或畫面名提到 install/loading/安裝/載入 → 視為載入中。
    const loadingHint = /install|loading|安裝|安装|載入|载入|請稍候|请稍候|connecting|連線中|连接中/i;
    const looksLoading =
      loadingHint.test(String(cmd.thinking || '')) || loadingHint.test(String(cmd.screen || screenName || ''));

    if (stuckCount >= 3) {
      // (A) 安裝/載入階段:給長耐心 —— 前 STUCK_WAIT_STEPS 輪一律 wait(每輪 sleep 已 3s,
      //     配合此處額外 wait 動作,等於給數十秒到 1-2 分鐘讓安裝/載入完成),不亂點。
      const STUCK_WAIT_STEPS = 20; // 卡住的前 20 輪(約 60-100s)只等待,不亂點
      // (B) 硬上限:脫困(含等待)累計超過 STUCK_ABORT_STEPS 步畫面仍完全沒變 → 判定卡死結束。
      const STUCK_ABORT_STEPS = 30;

      if (stuckCount >= STUCK_ABORT_STEPS) {
        finalState = 'error';
        finalMsg = looksLoading
          ? `畫面連續 ${stuckCount} 步無變化且停在安裝/載入畫面 —— 可能 APK 安裝或首次啟動失敗/逾時(此 APK 可能過大或需額外下載資源)。已中止,避免空轉。`
          : `畫面連續 ${stuckCount} 步無變化,各種脫困嘗試均無效 —— 可能當機/卡死或需人工介入。已中止,避免空轉。`;
        await writeStatus('error', finalMsg, steps.length);
        break;
      }

      if (looksLoading || stuckCount < STUCK_WAIT_STEPS) {
        // 載入中或仍在耐心期:等待,不亂點。
        cmd.action = 'wait'; cmd.x = undefined; cmd.y = undefined; cmd.duration = 4;
        cmd.thinking = looksLoading
          ? `偵測到安裝/載入畫面(第 ${stuckCount + 1} 次未變),耐心等待安裝/載入完成`
          : `連續 ${stuckCount} 步畫面沒變,先等待(可能仍在載入)`;
        escapeOverride = true;
      } else {
        // 耐心期過後仍未變 → 才進入主動脫困輪換(中下段掃描 + back + 右上角)。
        const yBand = [0.70, 0.78, 0.64, 0.86, 0.57];
        const mode = (stuckCount - STUCK_WAIT_STEPS) % (yBand.length + 2);
        if (mode < yBand.length) {
          cmd.action = 'tap'; cmd.x = Math.round(cw * 0.5); cmd.y = Math.round(ch * yBand[mode]);
          cmd.thinking = `連續 ${stuckCount} 步畫面沒變,掃描中下段主按鈕帶 y=${(yBand[mode] * 100).toFixed(0)}% 脫困`;
          escapeOverride = true;
        } else if (mode === yBand.length) {
          cmd.action = 'back'; cmd.x = undefined; cmd.y = undefined;
          cmd.thinking = `連續 ${stuckCount} 步畫面沒變,用 back 脫困`;
          escapeOverride = true;
        } else {
          cmd.action = 'tap'; cmd.x = Math.round(cw * 0.93); cmd.y = Math.round(ch * 0.06);
          cmd.thinking = `連續 ${stuckCount} 步畫面沒變,點右上角(關閉鈕常在此)脫困`;
          escapeOverride = true;
        }
      }
    }

    // 垂直校正(只修 y,不動 x):實測 VLM 對水平(x)準、對垂直(y)常系統性偏低(佐證 job-muk2fm25
    // 步驟 2:模型估 Play now 在 75%,實際約 69%,偏低約 6%)。用「按鈕條偵測」做溫和校正:
    // 若模型點擊的 x 落在某個按鈕條的水平跨度內、且 y 與該按鈕中心差在合理範圍,就把 y 吸到按鈕中心。
    // 關鍵區別:findButtonBands 用「形狀」(寬扁圓角條)找按鈕,不像舊的 findBrightButton 找「最亮色塊」
    // (會誤抓金幣/logo/社群圖示),且這裡「只改 y」,水平位置完全尊重模型,不會把點擊拉到別的元素。
    // 預設關閉:實測 findButtonBands 在這類「按鈕不是畫面最鮮明物件」的美術重的賭場畫面偵測不到按鈕
    // (金幣/天空才是最高彩度),硬套反而有誤觸風險。主力校正靠「0~1000 正規化網格 + prompt 提示」。
    // 保留開關 PA_YSNAP=1,供日後在偵測穩定的畫面啟用「只修 y」的按鈕條吸附。
    let snappedFrom = null;
    if (process.env.PA_YSNAP === '1' && MAGICK && !escapeOverride && cmd.action === 'tap' && cmd.x != null && cmd.y != null) {
      const bands = findButtonBands(ds.b64, ssDim);
      // 找出「x 落在其水平跨度內」的按鈕條(含少量左右容差),取 y 最接近模型點擊的那一個。
      const yTol = ch * 0.14;        // 垂直吸附上限:與按鈕中心差 <=14% 螢幕高才吸(對應觀察到的 ~6% 偏移並留裕度)
      const xPad = cw * 0.04;        // 水平容差:x 稍微超出按鈕邊緣一點仍算命中
      let bestBand = null, bestDy = Infinity;
      for (const b of bands) {
        const left = b.x - b.w / 2 - xPad;
        const right = b.x + b.w / 2 + xPad;
        if (cmd.x < left || cmd.x > right) continue;   // x 必須落在此按鈕條水平範圍內
        const dy = Math.abs(b.y - cmd.y);
        if (dy <= yTol && dy < bestDy) { bestDy = dy; bestBand = b; }
      }
      if (bestBand && bestDy > 2) {
        snappedFrom = { x: cmd.x, y: cmd.y };
        cmd.y = bestBand.y;                              // 只校正垂直,x 保留模型原值
      }
    }

    const screenName = cmd.screen || `畫面 ${i}`;

    // 落點標記圖:tap/swipe 時在點擊座標畫紅十字+圓圈+座標,存 annotated/<i>.png(前端顯示 AI 點在哪)。
    let annotatedKey;
    if (MAGICK && (cmd.action === 'tap' || cmd.action === 'swipe') && cmd.x != null && cmd.y != null) {
      // 落點標記畫在「縮圖」上(座標同縮圖空間),前端顯示 AI 實際點在哪。
      const annB64 = annotateTapB64(ds.b64, Math.round(cmd.x), Math.round(cmd.y), cmd.action, ssDim);
      if (annB64) {
        annotatedKey = `${PREFIX}/annotated/${i}.png`;
        await s3put(annotatedKey, Buffer.from(annB64, 'base64'), 'image/png').catch(() => { annotatedKey = undefined; });
      }
    }

    const step = { index: i, action: cmd.action, screen: screenName, thinking: cmd.thinking,
      // x/y 為「縮圖空間」座標(與標記圖一致);deviceXY 為實際送裝置的截圖像素座標,供除錯比對。
      ...(cmd.x != null ? { x: cmd.x, y: cmd.y, deviceX: toDeviceX(cmd.x), deviceY: toDeviceY(cmd.y) } : {}),
      ...(snappedFrom ? { snappedFrom } : {}),
      ...(cmd.x != null ? { space: { shot: [cw, ch], device: [origW, origH] } } : {}),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotatedKey ? { annotatedKey } : {}),
      durationMs: Date.now() - t0, ...(usage ? { tokens: usage } : {}) };
    steps.push(step);
    await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});

    // 增量記憶地圖:建/更新當前畫面節點 + 從上一畫面的轉移邊,即時寫回供前端重繪。
    const pid = pageIdFromName(screenName, i);
    if (!struct.pages[pid]) {
      struct.pages[pid] = { id: pid, name: screenName, pHash: '', screenshotRef: `screenshots/${pid}.png`,
        knownControlLabels: [], visitCount: 1, hitCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      await s3put(`${MEM_PREFIX}/screenshots/${pid}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});
    } else { struct.pages[pid].visitCount++; struct.pages[pid].lastSeenAt = new Date().toISOString(); }
    if (struct.rootPageId === null) struct.rootPageId = pid;
    if (prevPageId && prevPageId !== pid) {
      const label = prevAction || '';
      let edge = struct.edges.find((e) => e.fromPageId === prevPageId && e.toPageId === pid && (e.trigger?.label || '') === label);
      if (edge) { edge.hitCount++; } else struct.edges.push({ fromPageId: prevPageId, toPageId: pid, trigger: { kind: 'tap', label }, hitCount: 1, missCount: 0 });
    }
    struct.lastUpdatedAt = new Date().toISOString();
    await s3put(`${MEM_PREFIX}/structure.json`, JSON.stringify(struct), 'application/json').catch(() => {});

    await writeStatus('running', `第 ${i + 1} 步:${cmd.action} @ ${screenName}`, steps.length);

    // App 死循環偵測:累計每個「畫面名」出現次數;超過門檻代表卡在同一處(常見:登入失敗彈窗
    // 反覆跳,此裝置無對應第三方登入環境)。提早收斂為 fail 並在訊息點出原因,不空轉到步數上限。
    const seen = (screenSeen.get(screenName) || 0) + 1;
    screenSeen.set(screenName, seen);
    if (seen >= LOOP_ABORT_LIMIT) {
      finalState = 'fail';
      finalMsg = `偵測到 App 死循環:畫面「${screenName}」反覆出現 ${seen} 次仍無法前進,可能此裝置環境無法完成該步驟(如第三方登入服務不可用)。已提早結束以節省時間與成本。`;
      break;
    }

    if (cmd.action === 'done') { finalState = 'pass'; finalMsg = cmd.thinking || '流程完成'; break; }
    // 實際點擊用「裝置截圖像素」座標:把 cmd(縮圖空間)的 x/y/x2/y2 換算到 origW/origH 空間再送。
    // 這一步是消除歪斜的關鍵 —— 縮圖與裝置解析度不同,直接拿縮圖座標點會整個偏掉。
    const deviceCmd = { ...cmd };
    if (cmd.x != null && Number.isFinite(cmd.x)) deviceCmd.x = toDeviceX(cmd.x);
    if (cmd.y != null && Number.isFinite(cmd.y)) deviceCmd.y = toDeviceY(cmd.y);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) deviceCmd.x2 = toDeviceX(cmd.x2);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) deviceCmd.y2 = toDeviceY(cmd.y2);
    try { await client.act(deviceCmd); consecFail = 0; } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續動作失敗'; break; } }
    prevPageId = pid; prevAction = cmd.action; prevOrient = isLandscape;
    await sleep(3000);
  }

  // 停止即時串流(先停,避免 quit session 後仍嘗試截圖)。
  clearInterval(liveTimer);
  // 等待可能仍在飛行中的最後一張 live 截圖結束,避免對已關閉 session 發請求。
  for (let w2 = 0; liveBusy && w2 < 20; w2++) await sleep(50);

  // 報告 + 終態。
  const nodes = Object.values(struct.pages).map((p) => ({ id: p.id, name: p.name, screenshotKey: `${MEM_PREFIX}/screenshots/${p.id}.png` }));
  const report = { jobId: JOB, state: finalState, message: finalMsg, task: TASK, device: { w, h }, vlmModel: VLM,
    ...(deviceModel ? { deviceModel } : {}),
    stepCount: steps.length, steps, navGraph: { nodes, edges: struct.edges }, tokens: tok, generatedAt: new Date().toISOString() };
  await s3put(`${PREFIX}/report.json`, JSON.stringify(report), 'application/json').catch(() => {});
  await writeStatus(finalState, finalMsg, steps.length);
  await client.quit().catch(() => {});
  // runner 自建的 session 由 runner 收尾(釋放真機,停止計費);engine 預建的則不動。
  if (ownsSession) await stopSelfOwnedSession();
}

main().catch(async (e) => {
  await writeStatus('error', String(e), 0);
  await stopSelfOwnedSession(); // 中途失敗也要釋放真機/停計費
  process.exitCode = 1;
});
