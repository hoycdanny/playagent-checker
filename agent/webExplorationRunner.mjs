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
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PlaywrightClient } from './playwrightClient.mjs';
import { magickAvailable, annotateTapB64, pHashHex, pHashHamming, resizeToSmartB64 } from './imageTools.mjs';

const START_URL = process.env.PA_URL || 'https://example.com';
const JOB = process.env.PA_JOB;
const BUCKET = process.env.PA_BUCKET;
const PREFIX = process.env.PA_PREFIX;
const APP_ID = process.env.PA_APP || '';
const DATA_REGION = process.env.PA_DATA_REGION || 'us-east-2';
const VLM = process.env.PA_VLM || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const TASK = process.env.PA_TASK || '探索這個網頁應用:穿透開場彈窗/公告,進入主要功能並操作,盡量走遍不同畫面。';
const MAX_STEPS = Number(process.env.PA_MAXSTEPS || 30);
const [VP_W, VP_H] = (process.env.PA_VIEWPORT || '1280x800').split('x').map((n) => Number(n) || 0);
const CONSEC_FAIL_LIMIT = 3;

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
async function writeStatus(state, message, steps) {
  await s3put(`${PREFIX}/status.json`,
    JSON.stringify({ jobId: JOB, state, message, steps: steps ?? 0, updatedAt: new Date().toISOString() }),
    'application/json').catch(() => {});
}

// ── VLM 決策(對齊 explorationRunner,但 prompt 改成「網頁」語意)──
function buildSystemPrompt(knowledge) {
  const base =
    `你是專業網頁應用測試工程師,正在用瀏覽器測試一個網站/網頁遊戲。每一步你會看到一張最新的網頁截圖。` +
    `【座標規則|最重要】座標一律用「你看到的這張截圖的絕對像素」:左上角是 (0,0),往右 x 變大、往下 y 變大,` +
    `右下角就是該張圖的寬與高(該回合訊息會告知尺寸)。請把座標精準對到「按鈕/連結/輸入框本身的正中心」。不要用比例、不要 0~1000。` +
    `這是連續對話,你會記得前幾步做了什麼。每步之後我會給你執行後的最新畫面,據此判斷上一步是否生效:` +
    `若畫面推進→繼續;若沒變→不要重複同座標,改點別的、換座標、或 back/swipe(捲動)。` +
    `策略:網頁常有 Cookie 同意/訂閱彈窗/廣告/登入提示,積極關閉或接受以進入主要內容。` +
    `需要輸入時,先 tap 輸入框再用 type 輸入(type 會自動送出 Enter)。需要往下看更多內容時用 swipe(垂直)捲動。` +
    `目標:${TASK}` +
    `先簡短思考(thinking),再給動作。只輸出 JSON:` +
    `{"thinking":"...","action":"tap|swipe|type|back|wait|done","x":<像素>,"y":<像素>,"x2":<像素>,"y2":<像素>,"text":"...","screen":"畫面名稱"}。` +
    `x/y 是「這張圖的像素座標」。tap 需 x,y;swipe(捲動)需 x,y,x2,y2;type 需 text;done 只在真正完成目標或完全無法進行時用。` +
    `screen 用精確畫面名描述當前畫面(如「首頁」「登入」「遊戲主畫面」「結算」),不同畫面用不同名稱。`;
  const k = typeof knowledge === 'string' ? knowledge.trim() : '';
  return k ? base + `\n\n這款應用「類型」的背景知識(參考,畫面以截圖為準):\n${k.slice(0, 4000)}` : base;
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
  try { return m ? JSON.parse(m[0]) : { action: 'done', thinking: '無法解析回應' }; }
  catch { return { action: 'done', thinking: '無法解析回應 JSON' }; }
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
async function decide(system, messages) {
  pruneImages(messages, 2);
  if (totalImageBytes(messages) > 1_500_000) pruneImages(messages, 1);
  const channel = channelFor(VLM);
  const request = summarizeRequest(system, messages);
  const baseTrace = { modelId: VLM, channel, request };
  try {
    if (channel === 'bedrock') {
      const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 500, system, messages };
      const res = await bedrock.send(new InvokeModelCommand({ modelId: VLM, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) }));
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      const out = parsed.content?.find((c) => c.type === 'text')?.text ?? '{}';
      const usage = parsed.usage ? { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens } : null;
      return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
    }
    const res = await bedrock.send(new ConverseCommand({ modelId: VLM, system: [{ text: system }], messages: toConverseMessages(messages), inferenceConfig: { maxTokens: 500 } }));
    const out = res.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '{}';
    const usage = res.usage ? { input: res.usage.inputTokens, output: res.usage.outputTokens } : null;
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
  await writeStatus('running', '瀏覽器啟動中', 0);
  const client = await PlaywrightClient.create({ width: VP_W || 1280, height: VP_H || 800, url: START_URL });

  // 讀注入知識(engine 已組 context.json)。
  let knowledge = '';
  try {
    const ctx = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/context.json` }))).Body.transformToString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
  } catch { /* 無則略過 */ }

  const system = buildSystemPrompt(knowledge);
  const messages = [];
  const steps = [];
  const struct = await loadStructure();
  let prevPageId = null, prevAction = null;
  let consecFail = 0;
  let finalState = 'fail', finalMsg = '達步數上限仍未完成';
  const tok = { input: 0, output: 0 };
  let lastPhash = null, stuckCount = 0;
  const screenSeen = new Map();
  const LOOP_ABORT_LIMIT = 8;

  await writeStatus('running', 'AI 網頁探索執行中', 0);

  for (let i = 0; i < MAX_STEPS; i++) {
    try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/cancel.json` })); finalState = 'cancelled'; finalMsg = '使用者取消'; break; } catch { /* 無取消 */ }
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
    const turnText = (i === 0 ? `第一張畫面(網址 ${client.currentUrl()})。目標:${TASK}` : `上一步(${prevAction})執行後的最新畫面。`) + dimHint;
    messages.push(makeUserTurn([ds.b64], turnText, visionFmt));

    const { cmd, usage, rawText, trace } = await decide(system, messages);
    messages.push(makeAssistantTurn(rawText));
    if (usage) { tok.input += usage.input; tok.output += usage.output; }

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

    // 落點標記圖(畫在 smart-resize 圖上,座標同空間)。
    let annotatedKey;
    if (MAGICK && (cmd.action === 'tap' || cmd.action === 'swipe') && cmd.x != null && cmd.y != null) {
      const annB64 = annotateTapB64(ds.b64, Math.round(cmd.x), Math.round(cmd.y), cmd.action, ssDim);
      if (annB64) { annotatedKey = `${PREFIX}/annotated/${i}.png`; await s3put(annotatedKey, Buffer.from(annB64, 'base64'), 'image/png').catch(() => { annotatedKey = undefined; }); }
    }

    const step = {
      index: i, action: cmd.action, screen: screenName, thinking: cmd.thinking,
      ...(cmd.x != null ? { x: cmd.x, y: cmd.y, deviceX: toDevX(cmd.x), deviceY: toDevY(cmd.y) } : {}),
      ...(cmd.x != null ? { space: { shot: [cw, ch], device: [origW, origH] } } : {}),
      url: client.currentUrl(),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotatedKey ? { annotatedKey } : {}),
      durationMs: Date.now() - t0, ...(usage ? { tokens: usage } : {}),
    };
    steps.push(step);
    await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});

    // 記憶地圖:建/更新畫面節點 + 轉移邊。
    const pid = pageIdFromName(screenName, i);
    if (!struct.pages[pid]) {
      struct.pages[pid] = { id: pid, name: screenName, pHash: '', screenshotRef: `screenshots/${pid}.png`, knownControlLabels: [], visitCount: 1, hitCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      await s3put(`${MEM_PREFIX}/screenshots/${pid}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});
    } else { struct.pages[pid].visitCount++; struct.pages[pid].lastSeenAt = new Date().toISOString(); }
    if (struct.rootPageId === null) struct.rootPageId = pid;
    if (prevPageId && prevPageId !== pid) {
      const label = prevAction || '';
      const edge = struct.edges.find((e) => e.fromPageId === prevPageId && e.toPageId === pid && (e.trigger?.label || '') === label);
      if (edge) edge.hitCount++; else struct.edges.push({ fromPageId: prevPageId, toPageId: pid, trigger: { kind: 'tap', label }, hitCount: 1, missCount: 0 });
    }
    struct.lastUpdatedAt = new Date().toISOString();
    await s3put(`${MEM_PREFIX}/structure.json`, JSON.stringify(struct), 'application/json').catch(() => {});

    await writeStatus('running', `第 ${i + 1} 步:${cmd.action} @ ${screenName}`, steps.length);

    // 死循環偵測:同畫面名反覆出現 → 提早收斂。
    const seen = (screenSeen.get(screenName) || 0) + 1;
    screenSeen.set(screenName, seen);
    if (seen >= LOOP_ABORT_LIMIT) { finalState = 'fail'; finalMsg = `偵測到死循環:畫面「${screenName}」反覆出現 ${seen} 次仍無法前進,提早結束。`; break; }

    if (cmd.action === 'done') { finalState = 'pass'; finalMsg = cmd.thinking || '流程完成'; break; }
    // 實際操作用視埠像素座標。
    const deviceCmd = { ...cmd };
    if (cmd.x != null && Number.isFinite(cmd.x)) deviceCmd.x = toDevX(cmd.x);
    if (cmd.y != null && Number.isFinite(cmd.y)) deviceCmd.y = toDevY(cmd.y);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) deviceCmd.x2 = toDevX(cmd.x2);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) deviceCmd.y2 = toDevY(cmd.y2);
    try { await client.act(deviceCmd); consecFail = 0; } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續動作失敗'; break; } }
    prevPageId = pid; prevAction = cmd.action;
    await sleep(2500);
  }

  const nodes = Object.values(struct.pages).map((p) => ({ id: p.id, name: p.name, screenshotKey: `${MEM_PREFIX}/screenshots/${p.id}.png` }));
  const report = { jobId: JOB, state: finalState, message: finalMsg, task: TASK, device: { w: VP_W || 1280, h: VP_H || 800 }, vlmModel: VLM, stepCount: steps.length, steps, navGraph: { nodes, edges: struct.edges }, tokens: tok, generatedAt: new Date().toISOString() };
  await s3put(`${PREFIX}/report.json`, JSON.stringify(report), 'application/json').catch(() => {});
  await writeStatus(finalState, finalMsg, steps.length);
  await client.quit().catch(() => {});
}

main().catch(async (e) => { await writeStatus('error', String(e), 0); process.exitCode = 1; });
