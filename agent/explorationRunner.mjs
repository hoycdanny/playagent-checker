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
 *   PA_PLATFORM         android | ios | windows
 *   PA_JOB / PA_TENANT / PA_BUCKET / PA_PREFIX   S3 位置(資料桶,區域跟著部署區)
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
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { applyEdits, createOperatorChannel, hintsPromptSection, loadAppMemory, operatorTurnNote, routesPromptSection, routeTurnNote, screenHintsFor, operatorGestureCmd, operatorDirectNote, POINT_ONLY_TEXT, DRAG_ONLY_TEXT } from './operatorMemory.mjs';
import { foldSystemIntoFirstUser, isRoleAlternationError } from './converseShape.mjs';
import { accumulate, addUsage, createUsageLedger, mergeByModel, usageFromAnthropic, usageFromConverse } from './tokenUsage.mjs';
import {
  DeviceFarmClient,
  StopRemoteAccessSessionCommand,
} from '@aws-sdk/client-device-farm';
import { AppiumClient } from './appiumClient.mjs';
import { AdbClient } from './adbClient.mjs';
import { WindowsClient } from './windowsClient.mjs';
import { refreshRemoteDriverEndpoint } from './deviceFarmRefresh.mjs';
import { createSession, setupDeviceFarmSession } from './deviceFarmSetup.mjs';
import { createObsGuard } from './obsGuard.mjs';
import { createLiveVideo, recordSize } from './liveVideo.mjs';
import { createSlotVideoCapture } from './slotVideoCapture.mjs';
import { createSpinSettle } from './spinSettle.mjs';
import { createMediaRecorder } from './mediaAudio.mjs';
import { SCENE_CROP, isBlocked, normDir, turnDir } from './moveFeedback.mjs';
import { createDeviceLogs } from './deviceLogs.mjs';
import { createAgentTeam, normalizeElements, screenFromSeen, scriptSteps, VISION_ELEMENTS_NOTE } from './agentTeam.mjs';
import { createScriptTracker, DEFAULT_ITEM_BUDGET } from './scriptTracker.mjs';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { liveJpeg, magickAvailable, gridOverlayB64, findBrightButton, findButtonBands, annotateTapAsync, pHashHex, pHashHamming, downscaleForVlmB64, resizeToSmartB64, grayGrid } from './imageTools.mjs';
import { isAutoSpinWait, watchAutoSpin, watchNote } from './spinWatch.mjs';
import { uitarsEnabled, decideUitars } from './uitarsClient.mjs';
import { loadAppCredentials, substituteText } from './secretsResolver.mjs';
import { evidencePromptSection, evidenceFields } from './evidenceProtocol.mjs';
import { upsertPage, recordTransition, recordMiss, recordSelfOp, compactStructure, identifyPage } from './memoryGraph.mjs';
import { REFLEX_MAX_CHAIN, chooseReflex, chooseSpinOp, cmdFromOp, coolSpinOp, createReflexState, opFromCmd, parseSpinCount, rtpSummary } from './reflex.mjs';
import { createMemoryTrace } from './memoryTrace.mjs';
import { PerfMonitor } from './perfMonitor.mjs';

let APPIUM_URL = process.env.PA_APPIUM_URL;
let SESSION_ARN = process.env.PA_SESSION_ARN;
const ARTIFACT_KEY = process.env.PA_ARTIFACT_KEY || '';
const APP_ID = process.env.PA_APP || '';
const DF_PROJECT = process.env.PA_DF_PROJECT || 'playagent-checker';
const MAX_OS = process.env.PA_MAX_OS ? Number(process.env.PA_MAX_OS) : undefined;
const MIN_OS = process.env.PA_MIN_OS ? Number(process.env.PA_MIN_OS) : undefined;
// 使用者提交時明選的實體裝置 ARN(有帶就用這台;沒帶才由 OS 區間挑第一台可用真機)。
const DEVICE_ARN = process.env.PA_DEVICE_ARN || undefined;
const PLATFORM = process.env.PA_PLATFORM === 'ios' ? 'ios' : process.env.PA_PLATFORM === 'windows' ? 'windows' : 'android';
// 裝置驅動:appium(Device Farm 真機,預設)| adb(Redroid 容器等 adb 可連的 Android,runner 跑在同一台主機)。
// windows(GameLift Streams Windows 主機,runner 與遊戲在同一個桌面 session,輸入 / 截圖走 WinHelper.cs)。
const DRIVER = process.env.PA_DRIVER === 'adb' ? 'adb' : process.env.PA_DRIVER === 'windows' ? 'windows' : 'appium';
const ADB_SERIAL = process.env.PA_ADB_SERIAL || '127.0.0.1:5555';
const JOB = process.env.PA_JOB;
const BUCKET = process.env.PA_BUCKET;
const PREFIX = process.env.PA_PREFIX;
const DATA_REGION = process.env.PA_DATA_REGION || process.env.AWS_REGION || 'us-west-2';
const DF_REGION = process.env.PA_DF_REGION || 'us-west-2';
// 'uitars' 是 SageMaker 定位模型的哨兵 id,不是 Bedrock 可呼叫的 modelId。走 Bedrock 通用 VLM 路徑時
// (UI-TARS endpoint 缺席而回退)必須換成真實 Bedrock VLM,否則 InvokeModel 會因無此模型而失敗。
const BEDROCK_VLM_FALLBACK = 'qwen.qwen3-vl-235b-a22b';
const _vlmRaw = process.env.PA_VLM || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const VLM = _vlmRaw === 'uitars' ? BEDROCK_VLM_FALLBACK : _vlmRaw;
// 決策 Agent(agent seat)/ 輔助 Agent(subagent seat)模型;engine 依任務設定注入,空 = 不啟用。
const AGENT_MODEL = (process.env.PA_AGENT_MODEL || '').trim();
const SUBAGENT_MODEL = (process.env.PA_SUBAGENT_MODEL || '').trim();
const PKG = process.env.PA_PKG || '';
// 任務目標:保持原樣送 AI(含任何 ${key} 佔位符)。憑證的真值「只在 type 到裝置那一刻」替換,
// 不改寫 TASK,避免明文進入 prompt / trace / 報告 / log。
const TASK = process.env.PA_TASK || '啟動遊戲,通過開場動畫與任何彈窗,進入主畫面,並嘗試開始一場遊戲';
// 步數上限:PA_MAXSTEPS 未設或 <=0 代表「無上限」(跑到 done / 卡死偵測 / 取消 / 連續失敗才停)。
const _maxStepsRaw = Number(process.env.PA_MAXSTEPS || 0);
const MAX_STEPS = Number.isFinite(_maxStepsRaw) && _maxStepsRaw > 0 ? _maxStepsRaw : Infinity;
const CONSEC_FAIL_LIMIT = 3;
// Device Farm 單次連線最長 150 分鐘(AWS 固定上限,不能調整;從建立連線開始算,含配置真機的時間)。
// 預設第 140 分鐘開始收尾,留 10 分鐘上傳錄影、寫報告。長時模式則在這時換一條新連線接續。
const WRAP_MIN = Math.max(10, Math.min(145, Number(process.env.PA_WRAP_MIN) || 140));
// 主機最長執行時數的截止時間(epoch ms;Android 容器 / Windows 由主機啟動腳本帶入)。
// 到了就收尾寫報告;主機的保險關機排在這之後,只是最後防線。未設 = 不限。
const DEADLINE_MS = Number(process.env.PA_DEADLINE_MS) > 0 ? Number(process.env.PA_DEADLINE_MS) : NaN;
const DEADLINE_LABEL = Number.isFinite(DEADLINE_MS) ? new Date(DEADLINE_MS).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
// runner 版本(寫進報告表頭 Test Engine Version;證據協議改版時遞增)。
const RUNNER_VERSION = 'devicefarm-runner/2.5 (evidence-v1, controls-v1, recording-v2, agent-team-v1, segments-v1, slot-board-v1)';
// 效能取樣間隔(步)。adb shell 取樣與 VLM 並行、且 FPS/CPU/GPU 為區間累計,預設每 2 步一次;0 = 停用。
// 2026-10-17:取樣走 Appium/adb,且必須在送動作前等它結束(同一條 session 不能並發指令),
// 所以它整段都在關鍵路徑上。改成每 4 步一次(原本 2 步),FPS/CPU 仍是區間累計不會漏資料。
const PERF_EVERY = process.env.PA_PERF_EVERY ? Math.max(0, Number(process.env.PA_PERF_EVERY) || 0) : 4;
/** 有啟用 adb 效能監測時的參照(main 例外收尾用,確保還原電池狀態)。 */
let activePerfMon = null;
// 進行中的整場錄影(runner 例外結束時盡力收尾,錄影才不會整段遺失)。
let activeRecorder = null;

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

// ── 背景上傳 ─────────────────────────────────────────────────────────────
// 截圖、落點標記、步驟 JSON、記憶地圖都只給人看(不影響下一步的決策),原本每一步都
// 同步等它們傳完才繼續。實測一步要傳約 5MB(截圖平均 3.2MB + 標記 2.1MB)外加記憶地圖
// 48KB 整份重傳,全部串在關鍵路徑上。改成背景上傳,收尾前再一起等完。
// 同一個 key 依序寫(後面那次內容較完整),避免後寫的被先寫的蓋掉。
const bgPuts = new Set();
const bgChain = new Map();
function s3putBg(key, body, contentType) {
  const prev = bgChain.get(key) ?? Promise.resolve();
  const p = prev.then(() => s3put(key, body, contentType)).catch(() => {});
  bgChain.set(key, p);
  bgPuts.add(p);
  void p.then(() => {
    bgPuts.delete(p);
    if (bgChain.get(key) === p) bgChain.delete(key);
  });
  return p;
}
/** 把任意背景工作掛進 flushPuts 的等待清單(例如背景產生落點標記圖再上傳)。 */
function trackBg(promise) {
  const p = Promise.resolve(promise).catch(() => {});
  bgPuts.add(p);
  void p.then(() => bgPuts.delete(p));
  return p;
}
/** 等背景上傳收尾(收尾、換連線、寫報告前呼叫)。 */
async function flushPuts(maxMs = 20_000) {
  if (!bgPuts.size) return;
  await Promise.race([Promise.all([...bgPuts]), sleep(maxMs)]);
}

/** 量測一段同步工作的耗時(寫進 step.timing,供找真正的瓶頸)。 */
function timed(tm, key, fn) {
  const t = Date.now();
  try { return fn(); } finally { tm[key] = (tm[key] ?? 0) + (Date.now() - t); }
}
/** 量測一段非同步工作的耗時。 */
async function timedAsync(tm, key, fn) {
  const t = Date.now();
  try { return await fn(); } finally { tm[key] = (tm[key] ?? 0) + (Date.now() - t); }
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
// 啟動進度(前端即時畫面上方的開機時間軸):各階段開始時間 + 目前階段 + 真機配置狀態。
// phase:download(準備 APK)→ upload(上傳 Device Farm)→ device(配置真機)→ connect(連線 Appium)→ run(AI 測試中)。
const boot = { runnerAt: new Date().toISOString(), phase: 'download', at: {} };
function bootPhase(phase, info = {}) {
  if (!boot.at[phase]) boot.at[phase] = new Date().toISOString();
  boot.phase = phase;
  if (info.deviceStatus) boot.deviceStatus = info.deviceStatus;
  if (info.deviceModel) boot.deviceModel = info.deviceModel;
  if (info.sizeMB) boot.sizeMB = info.sizeMB;
}
// 最後一次回報的步數(SIGTERM 時寫終態用)。
let lastStepCount = 0;
// 測試腳本進度(決策 Agent 追蹤):{ items, current, done }。寫進 status.json,前端即時打勾。
let scriptProgress = null;

// 取消:測試人員按「停止」→ API 寫 cancel.json。開機前後、每步開始、送出動作前都檢查。
// 看到之後就不再把狀態寫回 running,畫面不會在「已取消」和「執行中」之間跳。
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
  if (typeof steps === 'number' && steps > lastStepCount) lastStepCount = steps;
  // 已被取消:只允許寫 cancelled(或其他終態),不要用 running 蓋掉 API 寫的「已取消」。
  if (state === 'running' && await cancelRequested(3000)) return;
  await s3put(`${PREFIX}/status.json`,
    JSON.stringify({ jobId: JOB, state, message, steps: steps ?? 0, boot, ...(scriptProgress ? { script: scriptProgress } : {}), updatedAt: new Date().toISOString() }),
    'application/json').catch(() => {});
}

// 測項為主時的進度(視覺 Agent 判定;見 scriptTracker.mjs)。有它就以它為準,不用決策 Agent 的猜測。
let scriptTracker = null;

/** 更新 scriptProgress(done 只增不減:模型偶爾把步驟號往回報)。 */
function updateScriptProgress(team, { allDone = false } = {}) {
  const items = scriptTracker ? scriptTracker.items() : team?.scriptItems ?? [];
  if (items.length < 2) return; // 沒有分步驟的腳本:不顯示打勾清單
  const current = scriptTracker
    ? scriptTracker.current
    : Math.max(1, Math.min(items.length, Number(team.scriptStep) || 1));
  const done = allDone ? items.length : Math.max(scriptProgress?.done ?? 0, scriptTracker ? scriptTracker.done : current - 1);
  scriptProgress = { items: items.slice(0, 40).map((t) => String(t).slice(0, 300)), current, done };
}
const BOOT_MSG = {
  download: 'Device Farm:準備 APK',
  upload: 'Device Farm:上傳 APK',
  device: 'Device Farm:配置真機',
  connect: 'Device Farm:真機就緒,連線中',
};

// ── VLM 決策(純邏輯,對齊 emulatorRunner 的 prompt/對話策略,但改用 SDK)──

function buildSystemPrompt(w, h, knowledge, _hasGrid, evidence, controls, coordMode = 'pixel') {
  // 座標契約依模型母語切換:pixel = 回「這張圖的絕對像素」;norm1000 = 回「0~1000 相對座標」(Nova 等)。
  const normMode = coordMode === 'norm1000';
  const coordUnit = normMode ? '0~1000' : '像素';
  const coordRule = normMode
    ? `【座標規則|最重要】座標一律用「0~1000 的相對座標」:x 由左到右 0→1000、y 由上到下 0→1000(與截圖實際像素大小無關)。` +
      `左上角是 (0,0),右下角是 (1000,1000),正中央約 (500,500)。請把座標精準對到「按鈕/元件本身的正中心」(不是彈窗或文字區塊的中心)。`
    : `【座標規則|最重要】座標一律用「你看到的這張截圖的絕對像素」:左上角是 (0,0),往右 x 變大、往下 y 變大,` +
      `右下角就是該張圖的寬與高。每張圖尺寸會在該回合訊息中告知(如「這張截圖尺寸為 952x2156 像素」)。` +
      `請把座標精準對到「按鈕/元件本身的正中心」(不是彈窗或文字區塊的中心)。不要用比例、不要用 0~1000。`;
  // 操作行為(控制方案,由測試腳本勾選):有指定時注入權威操作段落,且只有「下方中央搖桿」
  // 方案才保留割草類的移動說明;沒指定 = 舊行為(全部保留)。
  const includeMow = !controls || controls.battleMove;
  const controlsBlock = controls?.prompt ? `\n${controls.prompt}\n` : '';
  const actionEnum = controls?.allowedActions?.length ? controls.allowedActions.join('|') : 'tap|swipe|move|back|type|wait|launch|done';
  const gestureFields = controls
    ? `,"durationMs":<滑動毫秒>,"tx":<右手${coordUnit}x>,"ty":<右手${coordUnit}y>,"taps":<次數>,"scale":"in|out"`
    : '';
  const gestureHelp = controls
    ? `hold 需 x,y,holdMs(按住);swipe 可加 durationMs(長=拖曳、短=快劃);combo 需 x,y(左手)、可選 dir、holdMs、tx,ty(右手按鈕)、taps;pinch 需 x,y 與 scale。只能使用上面列出的可用動作。`
    : '';
  const base =
    `你是專業遊戲測試工程師,正在測試一個 ${PLATFORM === 'ios' ? 'iOS' : PLATFORM === 'windows' ? 'Windows PC' : 'Android'} 遊戲。每一步你會看到一張最新截圖。` +
    (PLATFORM === 'windows' ? '這是 Windows 桌面:tap = 滑鼠左鍵單擊、swipe = 按住左鍵拖曳、back = 按 Esc;沒有多點觸控。截圖是整個螢幕,遊戲視窗外的桌面/工作列不要點。' : '') +
    // 座標契約依模型母語(見 coordRule):pixel 回絕對像素;norm1000 回 0~1000 相對座標。
    coordRule +
    `這是連續對話,你會記得前幾步做了什麼。每步之後我會給你執行後的最新畫面,據此判斷上一步是否生效:` +
    `若畫面推進→繼續;若沒變(無效點擊)→不要重複同座標,改點別的、換座標、或 back/swipe。` +
    `策略:遊戲開場常有彈窗/公告/教學/權限提示,積極關閉或確認它們以穿透到主畫面。` +
    `遇到「錯誤/重連(RECONNECT/try again)」彈窗時,點該按鈕重試以恢復連線,不要當成死路。` +
    `但若「同一個錯誤彈窗」(如登入失敗 login failed)已反覆出現多次、點掉又立刻跳出,代表此裝置環境無法完成該登入,` +
    `不要一直點它空轉;改走其他入口(如免登入的訪客/Play now),真的無其他路可走再用 done 收尾並在 thinking 說明原因。` +
    `目標:${TASK}` +
    controlsBlock +
    (includeMow ? (
    `【割草/動作遊戲的移動|最高優先|重要】若這是「進入遊戲後靠虛擬搖桿/按住螢幕拖曳來移動角色」的遊戲` +
    `(如割草、動作、生存類):在「戰鬥/遊戲進行畫面」中,移動【只能】用 move 動作,【嚴禁用 tap 移動】。` +
    `判斷是否在戰鬥畫面:畫面有角色在場景中、有敵人、有血條/HP、有存活倒數時間或波次進度條——這時每一步都應該是 move,不是 tap。` +
    `move 語意=「按住畫面朝某方向壓住並持續行走一段時間(虛擬搖桿)」。用 dir 指定方向(up/down/left/right,` +
    `或斜向 upleft/upright/downleft/downright),holdMs 指定按住毫秒數(建議 1500~3000,持續移動才躲得掉怪)。` +
    `【搖桿位置】這類遊戲的虛擬搖桿在【畫面下方中央】(一個半透明大圓圈/白圈,中心約在畫面寬度 49.5%、高度約 82.1% 處——` +
    `這是用原始截圖逐像素量出來的精確位置,不是目測估的;座標若偏差超過約 30px 就會完全落在熱區外、角色完全不動),` +
    `操作是「按住那個白圈中心 → 朝上下左右滑動並持續按住」來控制角色方向。move 動作 runner 會自動從下方中央的搖桿中心朝 dir 拖曳,` +
    `你只要給對 dir 即可;若截圖看得到搖桿白圈,也可用 x,y 指定它的中心更精準。注意搖桿在下方,不是畫面正中心。` +
    `這類遊戲「移動即戰鬥」(邊走位邊自動攻擊),你的任務是【不停走位】:朝敵人少/空曠處移動來躲怪、遛怪、撿經驗,活得越久越好。` +
    `站著不動(或用 tap)=被怪包圍=失敗。所以戰鬥中若你正想 tap,先自問「這是移動嗎?」是的話一律改用 move。` +
    `觀察 HP/血條、存活時間、波次/關卡進度(如 Stage/Wave/第N關/Comfort Zone)、敵人聚集處來決定往哪走。`) : '') +
    `【關卡結算/彈窗處理|重要】當出現結算或狀態彈窗時(標題如 Fail 失敗 / Win 勝利 / Clear 過關 / Level Up 升級 / 寶箱 / 結算面板),` +
    `【一定要用 tap 點畫面上的主要按鈕把它關掉或推進】,常見按鈕在【彈窗底部置中】,文字如 Confirm 確認 / OK / 繼續 / Next / Claim / Start / 再玩一次 / Retry。` +
    `絕對不要在有彈窗時 wait 空等——彈窗不會自己消失,必須按按鈕。升級/選技能彈窗則 tap 選一個強化選項。` +
    `若失敗(Fail)後出現結算,按 Confirm/繼續 收尾該局並嘗試再開始下一局,持續朝「通關到第五關」推進。` +
    `【新手教學指引|最高優先|重要】很多遊戲用「新手引導」把後續操作鎖住:只有先完成手指指的那一步,` +
    `其他按鈕(如 Start/開始)才會生效。畫面上若出現任一「教學指引訊號」,你【必須】優先點它指的目標,` +
    `不要去點 Start、不要點背景場景(房子/地圖/建築),也不要點右上角 ✕:` +
    `(1) 白色/發光的手指👆或箭頭圖示——點它「指尖所指的那個發光/高亮元件」(通常是一顆帶紅色驚嘆號「!」的圖示或按鈕);` +
    `(2) 紅色驚嘆號「!」徽章——代表該圖示有待完成的引導,點該圖示本體;` +
    `(3) 只有局部區域高亮/發光而畫面其餘變暗——點那個高亮區的正中心。` +
    `判斷要點:手指與「!」通常在底部一排功能鈕(如 Battle/Growth/成長/角色/背包)其中一顆上,或某顆發光的植物/星星圖示上。` +
    `把座標對到「手指指尖正下方那顆發光圖示的正中心」。若點了 Start 沒反應、畫面沒變,幾乎一定是被教學 gating——` +
    `立刻改點手指所指的發光圖示,完成引導後再回來點 Start。反覆點 Start/房子/✕ 卻沒反應是最常見的卡死原因,務必避免。` +
    `thinking 務必簡短(一句話,約 30~60 字即可,不要長篇分析),再給動作。只輸出 JSON:` +
    `{"thinking":"...","action":"${actionEnum}","x":<${coordUnit}>,"y":<${coordUnit}>,"x2":<${coordUnit}>,"y2":<${coordUnit}>,"dir":"up|down|left|right|upleft|upright|downleft|downright","holdMs":<毫秒>${gestureFields},"text":"...","screen":"畫面名稱","memo":"進度筆記"}。` +
    `memo 是你自己的「進度筆記」:測試腳本要你記住、之後還會用到的數字與進度(例如初始值、每局投注、已完成次數、目前第幾段、各段起始值),` +
    `每一步都覆寫成「最新的完整版」(200 字內)。你只看得到最近幾步,系統會把上一步的 memo 原樣交還給你——照它延續,不要重新開始、不要重記初始值;沒有需要記的就省略。` +
    `x/y 是「${normMode ? '0~1000 相對座標' : '這張圖的像素座標'}」。tap 需 x,y;swipe 需 x,y,x2,y2;` +
    (controls
      ? (controls.joystick ? `move 需 dir 與可選 holdMs(按住毫秒,預設1500),x,y 省略時 runner 用本遊戲搖桿的預設位置,看得到搖桿圓圈時用 x,y 指定其中心更準;` : '')
      : `move 需 dir(方向)與可選 holdMs(按住毫秒,預設1500)——虛擬搖桿在【畫面下方中央】(不是正中心),x,y 省略時預設以下方中央為搖桿中心;若你看得到搖桿(半透明圓圈/白圈)可用 x,y 指定它的中心更精準;`) +
    gestureHelp +
    `type 需 text;登入/表單有多個輸入框時,type 必須同時帶該欄位中心 x,y,runner 會先點該欄位再輸入;` +
    `每次只輸入一個欄位(帳號、密碼分兩步),不要假設前一步焦點仍在。done 只在真正完成或完全無法進行時用。` +
    `【絕對禁止提前 done|重要】「載入中/Loading/請稍候/過場動畫/剛按了 Start 或 SELECT 正在進場」都【不是】完成,這時只能 wait 或觀察,【嚴禁用 done】。` +
    `【品牌 Logo/開場動畫畫面|重要】若畫面是純展示性的「遊戲 Logo/工作室 Logo/品牌動畫/Config Ready/Loading」(畫面上沒有任何按鈕,只有標題文字、角色插圖、特效動畫,正在自動播放等待載入完成),` +
    `這種畫面本來就【沒有可互動元素】,【只能用 wait】,絕對不要對著它亂 tap/swipe/move——這種畫面不管點哪裡都不會有反應,亂點只會浪費步數並可能被系統誤判為死循環而提早中止任務。` +
    `判斷依據:畫面上只有大型標題字樣(如遊戲名稱配驚嘆號/特效)、無任何方框/按鈕外觀的文字(如 Start/OK/Confirm)、底部可能有小字樣如「Loading」「Config Ready」——這類畫面一律 wait。` +
    `對割草通關任務:只有當你在畫面上「親眼看到關卡指示已達第 5 關/第 5 波(如 Stage 5 / Wave 5 / 第5關 / 5. XXX Zone)」時,才可以 done 並在 thinking 寫出你看到的關卡文字為證。` +
    `在那之前,即使遊戲載入很久、或你覺得流程走完了,都不可 done —— 繼續 wait 或 move 走位推進關卡。誤把載入畫面當完成而 done 是嚴重錯誤。` +
    `screen 用精確畫面名(如「主選單」「大廳」「轉軸畫面」「載入中」)描述當前畫面,不同畫面用不同名稱。`;
  const k = typeof knowledge === 'string' ? knowledge.trim() : '';
  const withEvidence = base + evidencePromptSection(evidence);
  if (!k) return withEvidence;
  // 知識上限 9000 字:導覽圖摘要排在知識庫之前,4000 字時遊戲專屬知識庫常被截掉。
  return withEvidence + `\n\n這款遊戲「類型」的背景知識(參考,畫面以截圖為準):\n${k.slice(0, 9000)}`;
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
/** 對話歷史裡還帶著圖片的 user 回合數。 */
function countImages(messages) {
  let n = 0;
  for (const m of messages) if ((m.content || []).some((c) => c.type === 'image' && c.source?.data)) n++;
  return n;
}
/** 對話歷史裡還是完整內容(未被精簡)的 assistant 回合數。 */
function countAssistant(messages) {
  let n = 0;
  for (const m of messages) if (m.role === 'assistant' && !String(m.content?.[0]?.text ?? '').startsWith('(先前回應,已精簡)')) n++;
  return n;
}
/** 保留幾輪圖片 / 幾輪完整回應,以及「超過多少才裁」的批次大小(分批裁剪才不會每步打壞快取)。 */
const IMG_KEEP = 2;
const IMG_PRUNE_BATCH = 2;
const TEXT_KEEP = 6;
const TEXT_PRUNE_BATCH = 6;

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
 * 裁剪過舊的 assistant 回應文字(含 thinking 全文),只保留最近 keepLatest 輪的完整內容,
 * 更早的壓縮成極短占位。
 *
 * 背景:pruneImages 只處理圖片,assistant turn 的完整原始輸出文字從不裁剪,隨步數線性
 * 增長(273 步 ≈ 273 則完整回應文字永遠留在對話歷史裡)。這會讓送給模型的 prompt 越跑
 * 越長、越雜訊化,懷疑是長任務後期模型行為漂移、輸出格式開始不穩定(連續解析失敗)的
 * 放大因子之一。裁剪掉舊的完整回應不影響「決策」本身(模型靠最新畫面 + 少量近期歷史
 * 判斷下一步,不需要記得 200 步前自己說了什麼細節),但保留最近幾輪完整內容,維持
 * 「這是連續對話,你會記得前幾步做了什麼」的 prompt 承諾。
 */
function pruneAssistantText(messages, keepLatest = 6) {
  const assistantIdx = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'assistant') assistantIdx.push(i);
  const keepFrom = assistantIdx.length - keepLatest;
  let seen = 0;
  for (const i of assistantIdx) {
    if (seen++ >= keepFrom) continue;
    const text = messages[i].content?.[0]?.text || '';
    // 盡量保留 action/screen 這類短摘要供模型對照「上一步做了什麼」,但捨棄冗長 thinking。
    const actionMatch = /"action"\s*:\s*"([^"]+)"/.exec(text);
    const screenMatch = /"screen"\s*:\s*"([^"]+)"/.exec(text);
    const summary = `(先前回應,已精簡) action=${actionMatch?.[1] ?? '?'} screen=${screenMatch?.[1] ?? '?'}`;
    messages[i].content = [{ type: 'text', text: summary }];
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

/**
 * 從模型輸出的文字抽出決策 JSON;解析失敗時回 wait(不是 done)。
 *
 * 2026-10-02 修正:舊版解析失敗時回 { action: 'done', ... },而主迴圈把 done 一律當成
 * 「模型主動宣告完成」,直接判 finalState='pass' 收尾(除了「割草通關」任務有額外的
 * 「拒絕假完成」保護,其他任務類型完全沒有防護)。結果就是任何一次 VLM 回應格式異常
 * (例如被截斷、夾雜非 JSON 說明文字導致抽取失敗),都會讓整個任務在還沒真正完成時就
 * 被誤判為成功結束(實測:老虎機 RTP 測試在第 12 步因此直接 pass,訊息「無法解析結果」,
 * 但任務要求的 500 次 spin 根本沒跑完)。解析失敗跟「模型決定完成」是完全不同的事,
 * 不該共用同一個分支——改成回 wait,讓流程自然進入下一輪重試,並標記 parseFailed 供
 * 主迴圈做連續失敗次數的獨立計數(避免模型持續輸出不可解析內容時無限 wait 空轉)。
 */
function parseCmd(out) {
  const m = /\{[\s\S]*\}/.exec(out || '');
  try { return m ? JSON.parse(m[0]) : { action: 'wait', duration: 3, thinking: '無法解析回應,等待後重試', parseFailed: true }; }
  catch { return { action: 'wait', duration: 3, thinking: '無法解析回應 JSON,等待後重試', parseFailed: true }; }
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

// 拒收 temperature/topP 的模型(首次被拒後記住,見 decide() 的 Converse 分支)。
const samplingUnsupportedModels = new Set();
// 拒收獨立 `system` 回合的模型(首次被拒後記住,之後直接把 system 併進 user)。
const systemUnsupportedModels = new Set();
// 解析失敗的最後一道備援:換一個穩定的視覺模型重問(2026-10-05:Kimi K3 長任務中段開始
// 頻繁吐出 1000 token 亂碼/空字串,連同重問都失敗,測試人員下的指令也因此被吞掉)。
const VLM_FALLBACK = process.env.PA_VLM_FALLBACK
  || (VLM.includes('anthropic') ? 'us.amazon.nova-pro-v1:0' : 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
// 視覺 Agent 每次呼叫依「實際模型」記帳(含解析失敗重問、備援模型、快取 token)→ report.tokensByModel。
const vlmLedger = createUsageLedger();

async function decide(system, messages, modelId = VLM) {
  // 預設保留最近 2 張圖;但再加一道保險:若總圖量仍逼近模型 body 上限(~2MB),就降到只留最新 1 張,
  // 避免像大廳這種細節多的畫面兩張疊起來撐爆(Failed to buffer request body: length limit exceeded)。
  // 【分批裁剪】裁剪會改動到 prompt 的「前綴」,而模型端的 prompt 快取是比對前綴的 ——
  // 每步都裁一點,等於每步都讓快取失效。實測 job-mvbrqar9:視覺 Agent 21 次呼叫寫進
  // 285,279 個快取 token,只命中過 1 次(就是對話還沒開始被裁剪的第 0→1 步)。
  // 改成「超過上限才一次裁到位」:多數步驟前綴不變,快取才有機會命中。保留的內容比原本更多,
  // 不會讓模型看到更少資訊。體積上限(SOFT_LIMIT)仍然照舊把關。
  if (countImages(messages) > IMG_KEEP + IMG_PRUNE_BATCH) pruneImages(messages, IMG_KEEP);
  const SOFT_LIMIT = 1_500_000; // ~1.5MB 原始位元組(base64 會再脹 ~33%,保守留裕度)
  if (totalImageBytes(messages) > SOFT_LIMIT) pruneImages(messages, 1);
  if (countAssistant(messages) > TEXT_KEEP + TEXT_PRUNE_BATCH) pruneAssistantText(messages, TEXT_KEEP);
  const channel = channelFor(modelId);
  const request = summarizeRequest(system, messages);
  const baseTrace = { modelId, channel, request };
  try {
    if (channel === 'bedrock') {
      // Anthropic Claude:InvokeModel + Anthropic body。
      // max_tokens 原為 500 ——與系統 prompt「先 thinking 再給完整 JSON」的格式要求衝突:
      // thinking 稍長,JSON 本體還沒輸出完就被截斷(stop_reason=max_tokens),parseCmd 的
      // /\{[\s\S]*\}/ 抓不到配對的結尾 },JSON.parse 必定失敗。實測長任務(273 步)在局面
      // 變複雜時 thinking 變長,連續 10 次因此解析失敗而中止整個任務。配合上面把 prompt
      // 改成要求「thinking 30~60 字」雙重防護,這裡提高到 1000 留足夠餘裕。
      const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 1600, system, messages };
      const res = await bedrock.send(new InvokeModelCommand({
        modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body),
      }));
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      const out = parsed.content?.find((c) => c.type === 'text')?.text ?? '{}';
      const usage = usageFromAnthropic(parsed.usage);
      vlmLedger.add(modelId, usage);
      return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
    }
    // Nova / Llama / Qwen / DeepSeek 等:Bedrock Converse API(統一格式,含視覺)。
    // 2026-10-03:部分模型在預設取樣下偶爾整段吐出亂碼/空字串(輸出吃滿 maxTokens 卻沒有 JSON),
    // 長任務會因連續解析失敗中止。降低溫度收斂輸出;呼叫端另有「解析失敗立即重問」。
    // 2026-10-04:但 Kimi K3 等模型直接拒收 temperature/topP 欄位(ValidationException:
    // "This model doesn't support the temperature field"),第 0 步就失敗。改為:被拒時去掉取樣參數
    // 重送一次,並記住此模型不支援,後續步驟直接不送。
    // withSystem=false:不送 system 欄位,改把它併進第一個 user 回合(見 foldSystemIntoFirstUser)。
    const converse = (withSampling, withSystem = true) => bedrock.send(new ConverseCommand({
      modelId,
      ...(withSystem ? { system: [{ text: system }] } : {}),
      messages: toConverseMessages(withSystem ? messages : foldSystemIntoFirstUser(system, messages)),
      inferenceConfig: withSampling ? { maxTokens: 1600, temperature: 0.2, topP: 0.9 } : { maxTokens: 1600 },
    }));
    const sampling = !samplingUnsupportedModels.has(modelId);
    const withSystem = !systemUnsupportedModels.has(modelId);
    let res;
    try {
      res = await converse(sampling, withSystem);
    } catch (e) {
      if (/temperature|top_?p/i.test(String(e?.message || ''))) {
        // 取樣參數不支援:記住並去掉重送。
        samplingUnsupportedModels.add(modelId);
        res = await converse(false, withSystem);
      } else if (withSystem && isRoleAlternationError(e)) {
        // 獨立 system 回合不支援:記住並改用「system 併進第一個 user」重送。
        systemUnsupportedModels.add(modelId);
        res = await converse(sampling, false);
      } else {
        throw e;
      }
    }
    const out = res.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '{}';
    // 含快取 token(Kimi K3 等會自動快取,inputTokens 只剩一小部分;見 tokenUsage.mjs)。
    const usage = usageFromConverse(res.usage);
    vlmLedger.add(modelId, usage);
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

/**
 * RTP(Return To Player)統計:僅當案例任務要求算 RTP 時才有意義,從每步 thinking 文字裡
 * 嘗試抓出「本次下注(bet/TOTAL BET/下注)」與「本次派彩(WIN/贏得/派彩)」的數字配對,
 * 逐步累加總下注與總派彩,算出 RTP = 總派彩 / 總下注 × 100%。
 *
 * 這是「盡力而為」的擷取(從模型自由敘述的 thinking 文字正則比對,不是結構化資料),
 * 原因:老虎機類遊戲沒有統一的畫面 UI 可結構化讀取下注/派彩金額,模型的 thinking 本來就
 * 會描述這些數字(prompt 沒有特別要求,是模型自主判讀畫面上的文字產生的描述),這是目前
 * 唯一可行的資料來源。擷取結果的準確性取決於模型描述的一致性,無法保證 100% 精確,但能
 * 提供一個遠優於「完全沒有」的估算與視覺化。
 */
/**
 * 步調統計(收尾時印一次):每步真正花在哪。
 * 間隔 = 相鄰兩步的 at 之差(含送動作與等待);模型 = 視覺 + 決策;其餘為流程開銷。
 */
function logPaceSummary(steps) {
  const list = (steps ?? []).filter((s) => s && typeof s.at === 'string');
  if (list.length < 2) return;
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const s1 = (ms) => (ms / 1000).toFixed(1);
  const gaps = [];
  for (let k = 0; k + 1 < list.length; k++) {
    const g = Date.parse(list[k + 1].at) - Date.parse(list[k].at);
    if (Number.isFinite(g) && g > 0) gaps.push({ g, s: list[k] });
  }
  const ai = gaps.filter((x) => !x.s.reflex);
  const rfx = gaps.filter((x) => x.s.reflex);
  const model = (s) => (s.vlmMs ?? 0) + (s.decisionMs ?? 0);
  const keys = ['shot', 'prefetch', 'phash', 'resize', 'annotate', 'winSize', 'fg', 'act'];
  const parts = keys
    .map((k) => {
      const vals = list.map((s) => s.timing?.[k]).filter((v) => Number.isFinite(v) && v > 0);
      return vals.length ? `${k} ${s1(med(vals))}s×${vals.length}` : '';
    })
    .filter(Boolean)
    .join(' · ');
  const prefetched = list.filter((s) => s.timing?.shotPrefetched).length;
  console.log('[pace] 每步中位數:'
    + `間隔 ${s1(med(ai.map((x) => x.g)))}s`
    + ` = 模型 ${s1(med(ai.map((x) => model(x.s))))}s`
    + ` + durationMs 內其他 ${s1(med(ai.map((x) => (x.s.durationMs ?? 0) - model(x.s))))}s`
    + ` + durationMs 外 ${s1(med(ai.map((x) => x.g - (x.s.durationMs ?? 0))))}s`);
  if (rfx.length) console.log(`[pace] 照記憶執行的步驟 ${rfx.length} 步:間隔中位數 ${s1(med(rfx.map((x) => x.g)))}s(不呼叫模型)`);
  console.log(`[pace] 預抓截圖命中 ${prefetched}/${list.length} 步;分段耗時 ${parts || '(無)'}`);
}

/** SPIN 迴圈的讀數字提示:只看、不操作,輸出越短越快。 */
const SPIN_READER_SYSTEM = '你只負責讀拉霸機畫面上的數字,不要操作、不要推理玩法。只輸出 JSON:' +
  '{"screen":"畫面名稱","balance":<目前餘額,讀不到填 null>,"bet":<這一局的總投注,讀不到填 null>,' +
  '"win":<這一局的贏分,沒中獎填 0>,"free_spins_left":<剩餘免費次數,沒有填 0>,' +
  // 很多機台沒中獎時不顯示 0,而是把贏分欄位換成玩法名稱(實測 Fortune Rabbit Part2 顯示「All Ways」)。
  '贏分欄位若顯示的是玩法名稱(例如 All Ways、Hold & Win)或空白,代表這局沒有派彩,win 填 0。' +
  '"bonus":<是否正在免費遊戲 / Bonus 中 true|false>,"popup":<是否有彈窗、大獎動畫或公告擋住盤面 true|false>}。' +
  '數字去掉逗號與貨幣符號,只填畫面上看得到的數字,不要估算。';

function isRtpTask(task) {
  return /RTP|Return\s*To\s*Player|派彩率|回報率/i.test(String(task || ''));
}

/**
 * 畫面數值的指紋(只取數字欄位,排序後串起來);沒有任何數字回 ''。
 * 用於死循環偵測:同一個畫面名重複出現,但數值在變 → 遊戲有回應,不是卡死。
 * 只看數字是刻意的 —— 布林(bonus/spun)與字串在同一畫面上本來就常常一樣,放進來會讓指紋失去鑑別力。
 */
export function numericObsSig(obs) {
  if (!obs || typeof obs !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(obs)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN;
    if (Number.isFinite(n)) parts.push(`${k}=${n}`);
  }
  return parts.sort().join('|');
}

/**
 * 從單句 thinking 文字抓出 { bet, win } 數字配對(若找得到)。數字可能含千分位逗號。
 * 嘗試多種常見描述順序與中英混用寫法,找不到就回 null(該步不計入統計,不當作 0)。
 */
function extractSpinResult(thinking) {
  const text = String(thinking || '');
  const num = (s) => Number(String(s).replace(/,/g, ''));
  // 下注:TOTAL BET=1,320 / 下注 880 / 總下注 1320 / bet: 880
  const betMatch = /(?:TOTAL\s*BET|總下注|下注(?:額)?|押注|BET)\s*[:=是為]?\s*([\d,]+)/i.exec(text);
  // 派彩:WIN=9,600 / WIN 9600 / 贏得 300 / 派彩 19,040
  const winMatch = /(?:WIN|贏得|派彩|中獎)\s*[:=是為]?\s*([\d,]+)/i.exec(text);
  if (!betMatch) return null;
  const bet = num(betMatch[1]);
  const win = winMatch ? num(winMatch[1]) : 0;
  if (!Number.isFinite(bet) || bet <= 0) return null;
  return { bet, win: Number.isFinite(win) ? win : 0 };
}

/**
 * 掃描全部 steps 的 thinking,累計 RTP 統計:總下注、總派彩、取樣次數、RTP 百分比,
 * 以及「逐次累積 RTP」序列(供報告畫折線圖,觀察 RTP 隨取樣次數收斂的趨勢)。
 * 回 null 代表完全沒抓到任何可用的下注/派彩資料(不應顯示 RTP 圖表)。
 */
function computeRtpStats(steps) {
  let totalBet = 0;
  let totalWin = 0;
  let sampleCount = 0;
  const series = []; // [{ n, rtp }],每抓到一筆有效 spin 就記一個點,n = 累積取樣次數
  for (const step of steps) {
    if (step.warnings?.some((w) => w.kind === 'suspect_value' && /bet|win/.test(w.key))) continue; // 疑似讀錯不計入
    const result = extractSpinResult(step.thinking);
    if (!result) continue;
    totalBet += result.bet;
    totalWin += result.win;
    sampleCount++;
    series.push({ n: sampleCount, rtp: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : 0 });
  }
  if (sampleCount === 0) return null;
  return {
    sampleCount,
    totalBet,
    totalWin,
    rtpPercent: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : 0,
    series,
  };
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
  // 測試憑證:啟動時把本 App 的憑證表載入記憶體(值不寫回任何地方)。實際替換在 type 到裝置那一刻。
  let appCredentials = {};
  try { appCredentials = await loadAppCredentials(); } catch (e) { console.warn('[secrets] 載入憑證例外(略過):', e?.message || e); }

  // 前置:若 engine 未預先建好 session,runner 自行讀 APK → 上傳 Device Farm → 開 session。
  // 重活在此(Fargate),不在 engine(512MB/5 分撐不住數百 MB APK)。
  let ownsSession = false;
  let deviceModel; // 執行此任務的實體真機機型(寫進 report 供前端顯示)
  // 有效套件名:優先用 job 帶來的 PA_PKG(App identifier);若為空,改用 runner 從 APK 解析到的套件名。
  // 這攸關「能不能自動啟動遊戲」——沒有套件名時 runner 只會停在桌面對著安裝中圖示空轉。
  let effectivePkg = PKG;
  // 執行時長(job.json maxSegments):1 = 單段(第 ${WRAP_MIN} 分鐘收尾);N = 最多 N 段連線;0 = 不限段數。
  let maxSegments = 1;
  // 這次測試的 App 版本(產物 id):記憶腳本的操作記著錄製時的版本,遊戲改版時據此降級。
  let appVersion = '';
  try {
    const jm = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/job.json` }))).Body.transformToString());
    const n = Number(jm?.maxSegments);
    if (Number.isInteger(n) && n >= 0 && n <= 50) maxSegments = n;
    if (typeof jm?.artifactVersion === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(jm.artifactVersion)) appVersion = jm.artifactVersion;
  } catch { /* 沒有就單段 */ }
  let segment = 1;
  let segStartedAt = 0; // 這一段 Device Farm 連線開始建立的時間
  let sessionInfo = null; // { projectArn, appArn, deviceArn, prefer32bit }:長時模式換新連線用
  console.log('執行時長', maxSegments === 1 ? `單段(${WRAP_MIN} 分鐘收尾)` : `長時:最多 ${maxSegments || '不限'} 段,每段 ${WRAP_MIN} 分鐘`);
  // 排隊中就被停止:不要再上傳 APK、開真機。
  if (await cancelRequested()) { await writeStatus('cancelled', '使用者取消', 0); return; }
  if (DRIVER === 'windows') {
    // 遊戲已由 GameLift 主機腳本(host.ps1)解開;runner 用 PA_PKG(exe 完整路徑)啟動。
    bootPhase('connect', { deviceModel: 'Windows' });
    deviceModel = process.env.PA_DEVICE_MODEL || 'Windows(GameLift Streams)';
    await writeStatus('running', `Windows 主機就緒(${deviceModel}),啟動遊戲中`, 0);
  } else if (DRIVER === 'adb') {
    // 遊戲已由主機啟動腳本裝好;這裡只連 adb。
    bootPhase('connect', { deviceModel: 'Redroid' });
    deviceModel = process.env.PA_DEVICE_MODEL || 'Redroid(Android 容器)';
    await writeStatus('running', `Android 容器就緒(${deviceModel}),連線中`, 0);
  } else if (!APPIUM_URL) {
    if (!ARTIFACT_KEY) throw new Error('缺少 PA_ARTIFACT_KEY,無法建立 Device Farm session');
    bootPhase('download');
    await writeStatus('running', BOOT_MSG.download, 0);
    const session = await setupDeviceFarmSession(
      { dfClient, s3 },
      {
        onPhase: async (p, info) => {
          if (p === 'device' && !segStartedAt) segStartedAt = Date.now();
          const changed = boot.phase !== p || (info?.deviceStatus && info.deviceStatus !== boot.deviceStatus);
          bootPhase(p, info);
          if (changed) await writeStatus('running', BOOT_MSG[p] ?? 'Device Farm 啟動中', 0);
        },
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
    sessionInfo = { projectArn: session.projectArn, appArn: session.appArn, deviceArn: session.deviceArn, prefer32bit: session.prefer32bit };
    if (!effectivePkg && session.detectedPackage) {
      effectivePkg = session.detectedPackage;
      console.log(`PA_PKG 未提供,改用從 APK 解析的套件名啟動:${effectivePkg}`);
    }
    bootPhase('connect', deviceModel ? { deviceModel } : {});
    await writeStatus('running', `Device Farm 真機就緒(${deviceModel ?? '真機'}),Appium 連線中`, 0);
  } else {
    bootPhase('connect');
    await writeStatus('running', 'Appium 連線中', 0);
  }

  // 開機期間(上傳 APK、配置真機要幾分鐘)被停止:真機一就緒就立刻釋放,不再連 Appium、開遊戲。
  if (await cancelRequested()) {
    await stopSelfOwnedSession();
    await writeStatus('cancelled', '使用者取消', 0);
    return;
  }

  if (!segStartedAt) segStartedAt = Date.now();
  const setSessionBoot = () => {
    boot.session = { segment, maxSegments, startedAt: new Date(segStartedAt).toISOString(), wrapAt: new Date(segStartedAt + WRAP_MIN * 60_000).toISOString(), wrapMin: WRAP_MIN };
  };
  if (SESSION_ARN) setSessionBoot();

  // 閉包讀 module 層的 SESSION_ARN:換新連線後自動改刷新新的 session。
  const refreshEndpoint = SESSION_ARN
    ? () => refreshRemoteDriverEndpoint(dfClient, SESSION_ARN)
    : undefined;
  let client = DRIVER === 'windows'
    ? await WindowsClient.create()
    : DRIVER === 'adb'
    ? await AdbClient.create(ADB_SERIAL)
    : await AppiumClient.create(APPIUM_URL, { platform: PLATFORM, autoLaunch: false, refreshEndpoint });

  // 機型後備:engine 若已預建 session,runner 這邊沒有 session.deviceModel,
  // 改從 Appium 連上後的 capabilities 讀(UiAutomator2 通常帶 deviceModel/deviceManufacturer)。
  // 都取不到才用使用者提交時所選機型(PA_DEVICE_MODEL)當顯示後備。
  if (!deviceModel) {
    try { const di = client.deviceInfo?.(); if (di?.model) deviceModel = di.model; } catch { /* 取不到就算了 */ }
  }
  if (!deviceModel && process.env.PA_DEVICE_MODEL) deviceModel = process.env.PA_DEVICE_MODEL;

  // 讀注入知識(engine 已組 context.json)。
  let knowledge = '';
  let evidence = null; // 證據協議(模組/機制/觀測欄位),由類型知識庫決定
  let controls = null; // 操作行為(控制方案):測試腳本勾選或類型建議,engine 組成協議
  // 「以測項為主」:案例帶結構化測項時為 true。走完所有測項並宣告完成即為權威完成,
  // 輔助 Agent(靠知識庫/弱模型)不得推翻,避免用錯誤理由逼測試延伸到腳本以外。
  let scripted = false;
  // VLM 座標系:pixel(Claude/K3/UI-TARS,回絕對像素)或 norm1000(Nova/Qwen/Gemma…,回 0~1000)。
  // 由引擎依模型目錄寫進 context.json;runner 據此下座標契約並把 norm1000 換算成像素。
  let vlmCoordSystem = 'pixel';
  try {
    const ctx = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/context.json` }))).Body.transformToString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
    if (ctx && ctx.evidence && typeof ctx.evidence === 'object') evidence = ctx.evidence;
    if (ctx && ctx.controls && Array.isArray(ctx.controls.allowedActions)) controls = ctx.controls;
    if (ctx && ctx.scripted === true) scripted = true;
    if (ctx && ctx.vlmCoordSystem === 'norm1000') vlmCoordSystem = 'norm1000';
  } catch { /* 無則略過 */ }
  // UI-TARS 走自己的像素 grounding;norm1000 契約只套用在一般 Bedrock VLM。
  const normCoord = vlmCoordSystem === 'norm1000' && !USE_UITARS;
  console.log('VLM 座標系', vlmCoordSystem, normCoord ? '(回 0~1000,runner 換算像素)' : '(絕對像素)');
  // 操作行為:允許的動作集合(null = 未指定,不限定)。
  const allowedActions = controls ? new Set(controls.allowedActions) : null;
  if (controls) console.log('操作行為', controls.ids.join(','), `(${controls.source})`, '可用動作', controls.allowedActions.join('/'));
  // 測項為主:視覺 Agent 逐項判定完成、每項有時間盒(PA_ITEM_STEPS 可覆寫,預設 20 次操作)。
  scriptTracker = scripted
    ? createScriptTracker({ items: scriptSteps(TASK), itemBudget: Math.max(3, Number(process.env.PA_ITEM_STEPS) || DEFAULT_ITEM_BUDGET) })
    : null;
  if (scriptTracker) console.log(`[測項為主] ${scriptTracker.total} 項,由視覺 Agent 逐項判定完成;每項上限 ${Math.max(3, Number(process.env.PA_ITEM_STEPS) || DEFAULT_ITEM_BUDGET)} 次操作(長時間測項不限)`);

  // 效能監測(Android:adb shell 收 FPS/CPU/GPU/記憶體/溫度/耗電;不可用時退回 getPerformanceData)。
  let perfMon = PLATFORM === 'android' && effectivePkg && PERF_EVERY > 0 ? new PerfMonitor(client, effectivePkg) : null;
  let perfShell = perfMon ? await perfMon.start() : false;
  if (perfShell) activePerfMon = perfMon;
  // 真機 log(任務詳情頁「裝置 Log」可展開查看):需要 mobile: shell。
  const makeDevLogs = () => (PLATFORM === 'android' && perfShell && process.env.PA_DEVLOGS !== '0'
    ? createDeviceLogs({ client, put: s3put, prefix: PREFIX, pkg: effectivePkg, log: (m) => console.log(m) })
    : null);
  let devLogs = makeDevLogs();
  let devLogsPending = null;
  console.log('真機 log 收集', devLogs ? '啟用(每步 logcat + 音效播放狀態)' : '停用');
  console.log('效能監測', perfShell ? `adb shell(每 ${PERF_EVERY} 步取樣)` : perfMon ? 'Appium getPerformanceData(僅 CPU/記憶體)' : '停用');
  let launchInfo = null;

  // 遊戲錄影(含聲音,整場一段):必須在「啟動遊戲之前」開始 —— 開始錄影會跳一次系統權限畫面,
  // 遊戲若已在跑會因失去焦點而自動暫停。結束時直傳 S3,供任務頁回放 + 每步音效判斷(見 mediaAudio.mjs)。
  let recorder = null;
  // prev = 前一條連線的 recorder:新連線接續段號與已收下的段(levels.json 不會被覆蓋)。
  const makeRecorder = (prev) => createMediaRecorder({
      ...(prev ? { startIndex: prev.nextIndex, initialChunks: prev.chunks } : {}),
      client,
      put: s3put,
      prefix: PREFIX,
      // 每 20 分鐘切一段(約 400 MB):長時任務也不會產生數 GB 的單一檔案,回放與音量分析都快;
      // 段與段之間由看門狗接續(會漏掉約 30 秒內的空檔)。PA_RECORD_MAX_SEC 可覆寫。
      maxSec: Number(process.env.PA_RECORD_MAX_SEC) || 1200,
      watchMs: 10_000, // 每 10 秒檢查一次,段落結束後盡快接下一段(空檔 ≤ 10 秒)
      presignPost: (key) => createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: key,
        Conditions: [['content-length-range', 1, 5 * 1024 * 1024 * 1024]],
        Fields: { 'Content-Type': 'video/mp4' },
        Expires: 3600,
      }),
      // 串流存檔(長時錄影可達數 GB,不能整份讀進 2 GB 的容器記憶體)。
      downloadTo: async (key, file) => {
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        await pipeline(res.Body, createWriteStream(file));
        return Number(res.ContentLength) || 0;
      },
      log: (m) => console.log(m),
    });
  const recordingEnabled = PLATFORM === 'android' && process.env.PA_AUDIO !== '0';
  if (recordingEnabled) {
    recorder = makeRecorder(null);
    if (await recorder.start()) { activeRecorder = recorder; await sleep(1500); } // 等權限畫面收掉再啟動遊戲
    else recorder = null;
  }

  // 啟動 app(可用 shell 時以 am start -W 冷啟動並量測啟動時間)。
  if (effectivePkg) {
    if (perfShell) launchInfo = await perfMon.launch();
    if (!launchInfo) { try { await client.launchPackage(effectivePkg); } catch { /* 交給 agent 視覺找入口 */ } }
    await sleep(8000);
  }

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
  // 應用記憶:使用者教過 AI 的經驗(hints.json)+ 記憶地圖手動編修(edits.json)。
  const S3CMDS = { ListObjectsV2Command, GetObjectCommand, PutObjectCommand };
  const appMemory = await loadAppMemory({ s3, bucket: BUCKET, memPrefix: MEM_PREFIX, cmds: S3CMDS });
  if (appMemory.hints.length) console.log(`應用記憶:載入 ${appMemory.hints.length} 條使用者教學`);
  // 測試人員即時指令通道(聊天室 → commands/*.json,每步輪詢)。
  const operator = createOperatorChannel({ s3, bucket: BUCKET, jobPrefix: PREFIX, cmds: S3CMDS });
  // 載入時先收斂舊格式的雜亂資料(重複節點/自環/wait 邊),之後以新規則增量更新;
  // 使用者在記憶地圖刪掉的畫面/路徑先移除(只套刪除,改名留在讀取端)。
  const struct = applyEdits(compactStructure(await loadStructure()), appMemory.edits, { renames: false, addedEdges: false });
  // 路線裡的畫面名:優先用測試人員改的名字(路線是他們畫的);畫面已不存在回空字串。
  const routePageName = (id) => appMemory.edits?.renames?.[id] ?? struct.pages?.[id]?.name ?? '';
  // 【記憶腳本 / 反射層】認得的畫面直接照記憶操作,不問 AI(見 reflex.mjs)。PA_REFLEX=0 關閉。
  const REFLEX_ON = process.env.PA_REFLEX !== '0';
  // ── 步調相關的常數(2026-10-17 依實測調整,見下方註解)──────────────────
  // 動作送出後等畫面穩定的時間。原本固定 3000ms,之後下一步才去抓圖(再花數秒,串列)。
  // 改成等較短時間後「就地把下一步要用的圖抓好」:抓圖本身也在等畫面穩定,實際取到的
  // 畫面比原本更晚(更穩),但下一步少掉一次串列的 Appium 取圖。
  const SETTLE_MS = Math.max(0, Number(process.env.PA_SETTLE_MS ?? 1500));
  const REFLEX_SETTLE_MS = Math.max(0, Number(process.env.PA_REFLEX_SETTLE_MS ?? 800));
  // 【SPIN 迴圈的停輪判定】
  // 轉軸停了不等於這一局結束 —— 派彩時餘額還會滾動數字 1~2 秒。要讀到正確的餘額/贏分,
  // 必須「轉軸區」與「畫面下方數字列」兩塊都不動滿 SPIN_STILL_MS 才去讀。
  //
  // 2026-10-17 用 job-mvcei8tq 的真實截圖量過(Fortune Rabbit Part2,直向 1440x3088):
  // 轉輪 5x3 只佔 y 0.51–0.70 的一條;數字列在最底 y 0.93–0.995。
  // 先前用的是猜的通用比例(轉輪 y 0.22–0.74、數字列整條含右側),等於把上方會動的金兔子、
  // 燈籠背景,以及右下角會脈動發光的 SPIN 鈕都框進來 —— 那些永遠不會靜止,所以靜止條件要
  // 等 5~6 秒才勉強成立(實測 stillMs 4960/5191/6459,門檻只要 2000)。
  // 數字列刻意只取左側 70%:右邊是 MAX BET 與會發光的 SPIN 鈕。
  const SPIN_CROPS_PORTRAIT = {
    reels: { x: 0.12, y: 0.50, w: 0.79, h: 0.21 },
    nums: { x: 0.0, y: 0.93, w: 0.70, h: 0.07 },
  };
  // 橫向版面沒有實測資料(這款遊戲是直向);保守取中段與底部左側,並在報告標示未校準。
  const SPIN_CROPS_LANDSCAPE = {
    reels: { x: 0.18, y: 0.28, w: 0.64, h: 0.44 },
    nums: { x: 0.0, y: 0.88, w: 0.70, h: 0.12 },
  };
  const spinCrops = (ow, oh) => (ow > oh ? SPIN_CROPS_LANDSCAPE : SPIN_CROPS_PORTRAIT);
  const SPIN_STILL_MS = Math.max(0, Number(process.env.PA_SPIN_STILL_MS ?? 2000));
  const SPIN_STILL_BITS = Math.max(0, Number(process.env.PA_SPIN_STILL_BITS ?? 20));
  const SPIN_MOVED_BITS = Math.max(0, Number(process.env.PA_SPIN_MOVED_BITS ?? 24));
  const SPIN_POLL_MS = Math.max(0, Number(process.env.PA_SPIN_POLL_MS ?? 250));
  const SPIN_SETTLE_MAX_MS = Math.max(1000, Number(process.env.PA_SPIN_SETTLE_MAX_MS ?? 20_000));
  // 前景檢查的間隔(步);0 = 每步都查。有風險的步(back / launch / 剛掉出前景)一律會查。
  const FG_EVERY = Math.max(1, Number(process.env.PA_FG_EVERY ?? 4));
  let lastForegroundLost = false;
  let spaceDims = null;           // 已告知裝置的截圖尺寸 [w,h];尺寸沒變就不重問
  let lastStructFingerprint = ''; // 記憶地圖內容指紋;沒變就不重傳
  const reflexState = createReflexState();
  let reflexPending = null; // 上一步反射操作的預期結果 { key, from, to, cross, waits }
  let reflexNotes = []; // 這串反射做了什麼(AI 下一次看畫面時告訴它)
  let navOp = null; // 上一步實際執行的操作細節(0~1 座標),寫進記憶地圖供下次重播
  // 【SPIN 迴圈】RTP 任務且畫面有可信的 SPIN 操作 → runner 自己按 SPIN、等盤面停、只讀數字。
  const rtpLoop = {
    target: isRtpTask(TASK) ? parseSpinCount(TASK) : 0,
    paid: 0, rounds: [], misses: 0, handBack: false, done: false, startBalance: undefined, endBalance: undefined,
  };
  /** SPIN 迴圈還有局數沒轉完:這時 AI 說「全部完成」一律不採用(局數以系統計數為準)。 */
  const spinLoopPending = () => rtpLoop.target > 0 && !rtpLoop.done;
  // 局數沒達標的「完成」宣告最多攔這麼多次;再來就以失敗收尾(而不是無止盡攔下去燒預算)。
  const SPIN_DONE_REJECT_CAP = Math.max(1, Number(process.env.PA_SPIN_DONE_REJECTS) || 3);
  let spinDoneRejects = 0;
  // 停輪判定要盯的區域(每步依截圖方向更新;影片判定與截圖退路共用同一組)。
  let spinRois = SPIN_CROPS_PORTRAIT;
  /**
   * 即時錄影:分段同時餵給「逐局盤面擷取」與「停輪判定」(兩者都只讀分段,不改內容)。
   * 開新連線時也用同一份設定(長時模式換連線後要繼續餵)。
   */
  const makeLiveVideo = () => {
    const consumers = [
      ...(slotCapture ? [(seg) => slotCapture.onSegment({ ...seg, session: segment })] : []),
      ...(spinSettle ? [(seg) => spinSettle.onSegment(seg)] : []),
    ];
    return createLiveVideo({
      client, put: s3put, prefix: PREFIX, size: recordSize(w, h),
      // onSegment 必須回 Promise(liveVideo 要 await 它);回 undefined 會讓上傳迴圈每秒丟
      // 「Cannot read properties of undefined」,整條即時影片就死了(job-mvd8vsfb 實測:
      // 影片停輪判定全程沒資料、裝置端分段也不再清掉,連 Appium 連線都被失敗重試佔滿)。
      ...(consumers.length
        ? { preserveBacklog: true, onSegment: async (seg) => { await Promise.all(consumers.map((f) => f(seg))); } }
        : {}),
      log: (m) => console.log(m),
    });
  };
  // 【停輪判定:影片版】RTP 任務才建。用即時錄影的影格判斷靜止,不佔 Appium 連線。
  const spinSettle = rtpLoop.target > 0
    ? createSpinSettle({
      rois: () => [spinRois.reels, spinRois.nums],
      threshold: Number(process.env.PA_SPIN_MOTION_DELTA) || 2.5,
      log: (m) => console.log(m),
    })
    : null;
  if (REFLEX_ON) console.log(`[記憶腳本] 啟用(App 版本 ${appVersion || '未知'})${rtpLoop.target ? `;SPIN 迴圈目標 ${rtpLoop.target} 局` : ''}`);
  let system = buildSystemPrompt(w, h, knowledge, MAGICK, evidence, controls, vlmCoordSystem)
    + hintsPromptSection(appMemory.hints, (id) => struct.pages?.[id]?.name ?? id) + routesPromptSection(appMemory.edits?.routes, routePageName)
    + (scriptTracker ? scriptTracker.promptSection() : '');
  // 記憶命中追蹤:以「本次開始前的記憶」為基準,每步記錄 AI 有沒有用到記憶、記憶的預測有沒有應驗。
  const memTrace = createMemoryTrace({ struct, hints: appMemory.hints, edits: appMemory.edits, knowledge, knowledgeLimit: 9000 });
  console.log(memTrace.startupLog());
  console.log('ImageMagick 座標校正', MAGICK ? '啟用' : '不可用(裸座標)');
  console.log('定位模型', USE_UITARS ? `UI-TARS(SageMaker endpoint=${process.env.PA_UITARS_ENDPOINT})` : `Bedrock VLM(${VLM})`);
  const messages = [];
  const steps = [];
  // prevAction:給 prompt 的上一步動作;navAction/prevTarget:導覽圖「造成轉場的動作/目標」。
  let prevPageId = null, prevAction = null, navAction = null, prevTarget = '';
  let prevScreen = ''; // 上一步 AI 標的畫面名(記憶提醒 / 指令回執用)
  let pendingCmds = []; // 尚未得到有效回應的測試人員指令(解析失敗時延續到下一步)
  let consecFail = 0;
  // AutoSpin 看守模式抓到的「事件當下那張」:下一步直接拿它給 AI(自動關閉的彈窗不會因重新截圖而錯過)。
  let pendingShot = null;
  // 無上限時不會「達步數上限」;若真的迴圈自然結束(理論上只有有限步才會),訊息才用步數上限。
  let finalState = 'fail';
  let finalMsg = Number.isFinite(MAX_STEPS) ? '達步數上限仍未完成' : '探索結束';
  const tok = { input: 0, output: 0 };
  // 卡住偵測:連續多步畫面沒變(pHash 幾乎相同)就介入,輪換嘗試中央偏下主按鈕/back/右上角。
  let lastPhash = null;
  let stuckCount = 0;
  let battleMoveTick = 0; // 割草戰鬥強制走位的方向輪換計數
  // 走位回饋:上一步實際執行的 move(方向 + 執行前的背景雜湊);本步被擋住的方向與連續被擋次數。
  let lastMove = null;
  let blockedDir = null;
  let blockedStreak = 0;
  // 戰鬥自動走位(VLM 思考期間背景繞圈):僅「下方中央搖桿」方案或 PA_AUTOPILOT=1 啟用。
  const battleAutoEnabled = Boolean(controls?.battleMove) || process.env.PA_AUTOPILOT === '1';
  const AUTOPILOT_MS = Math.max(2000, Math.min(8000, Number(process.env.PA_AUTOPILOT_MS || 6000)));
  let lastBattleMove = false; // 上一步是否為「戰鬥中走位」
  let popupLastStep = false; // 上一步是否判定有彈窗(有彈窗時不自動走位,免得誤觸)
  let autopilotTick = 0;
  let everInBattle = false; // 是否曾進入戰鬥畫面
  let seenLevel5 = false; // 是否曾在畫面看到第5關/第5波證據
  let prematureDoneCount = 0; // agent 提前 done 被 runner 攔截的次數
  // App 死循環偵測:某個「畫面名」(如登入失敗彈窗)反覆出現超過此門檻,代表 App 端阻斷
  // (常見:此裝置無 Google/Facebook 登入環境,關掉彈窗又立刻重跳),提早收斂不空轉到步數上限。
  const screenSeen = new Map();
  // 每個畫面名最近一次的數值指紋(餘額/贏分/下注…);用來分辨「同畫面重複」是卡死還是正常重複玩法。
  const screenObsSig = new Map();
  const LOOP_ABORT_LIMIT = 8;
  const loopRestarted = new Set(); // 已因「同畫面操作無效」重啟過的畫面(同一畫面只重啟一次)
  // 連續 wait 次數上限:2026-10-02 修正死循環偵測排除 wait 動作後的副作用——純等待不再計入
  // screenSeen,但若畫面本身真的卡死在載入階段(如 APK 配置下載失敗/逾時),會變成無上限空等,
  // 持續燒錢卻永遠不會觸發任何中止條件。這裡加一個獨立、簡單的「連續 wait 次數」硬上限,
  // 不管畫面名稱、pHash 是否變化,純粹計數「上一步也是 wait」的連續次數。
  let consecWaitCount = 0;
  let loadingStreak = 0; // 連續停在「載入畫面且無變化」的步數
  let appRestarts = 0; // runner 主動重啟 App 次數
  const LOADING_RECOVER_AFTER = 12; // 之後開放 AI 用 back/launch 脫困
  const LOADING_RESTART_AFTER = Number(process.env.PA_LOADING_RESTART || 20); // 之後 runner 主動重啟 App
  const WAIT_ABORT_LIMIT = 40; // 連續 wait ~40 次(每輪約數秒,約略對應 2-3 分鐘耐心)上限
  // 連續「VLM 回應無法解析」次數上限:這代表模型本身輸出有問題(非畫面載入),給較短的
  // 耐心(10 次)就中止,避免解析失敗被誤判成功之外,也不要在模型持續壞輸出時無限空等。
  let consecParseFailCount = 0;
  const PARSE_FAIL_ABORT_LIMIT = 10;
  // 方向追蹤(直向/橫向):用來偵測「進遊戲前後方向切換」並提示模型重新評估版面。null=尚未知。
  let prevOrient = null;
  // 上一步被「操作行為」攔下時的回饋(下一回合告訴 AI 改用允許的動作)。
  let controlNote = '';
  // 視覺 Agent 的進度筆記(memo):每回合原樣交還,長流程(例如 500 局)才不會因為歷史被裁掉而重來。
  let progressMemo = '';
  let perfPending = null; // 進行中的效能取樣(Promise)

  // 三個 Agent 協作:決策 Agent 定每步目標、輔助 Agent 核對效果/數值/完成(視覺 Agent 照目標操作)。
  // 沒給模型或 PA_AGENT_TEAM=0 → 只用視覺 Agent(舊行為)。任何呼叫失敗也自動退回只用視覺 Agent。
  const team = process.env.PA_AGENT_TEAM !== '0' && (AGENT_MODEL || SUBAGENT_MODEL)
    ? createAgentTeam({
      bedrock, ConverseCommand, agentModel: AGENT_MODEL, subagentModel: SUBAGENT_MODEL, task: TASK,
      controlsPrompt: controls?.prompt ?? '', knowledge, scripted, put: s3put, prefix: PREFIX, log: (m) => console.log(m),
      externalProgress: Boolean(scriptTracker),
    })
    : null;
  console.log('Agent 協作', team ? `決策=${AGENT_MODEL || '停用'} 輔助=${SUBAGENT_MODEL || '停用'}` : '停用(只用視覺 Agent)');
  // 腳本清單一開始就給前端(全部未完成);決策 Agent 每步更新進度。
  if (team?.enabled.agent || scriptTracker) updateScriptProgress(team);
  let teamPending = null; // 進行中的輔助 Agent 核對(在動作後等待畫面穩定時跑)
  let teamDoneRejects = 0;
  let agentDoneOverrides = 0; // 決策 Agent 下 done、但視覺 Agent 判斷要繼續 → 被駁回的次數
  const stepPlans = new Map(); // 步驟 index → 決策 Agent 這一步的決定
  // 每一步:視覺 Agent 看圖並列出可操作元件 → 決策 Agent 選動作 → runner 執行 → 輔助 Agent 背景核對。
  if (team?.enabled.agent && !USE_UITARS) system += VISION_ELEMENTS_NOTE;

  bootPhase('run');
  await writeStatus('running', 'AI 探索執行中', 0);

  // ── 即時畫面串流(真機):背景以 ~2.5fps 額外截圖覆寫 live 幀。
  // Appium 單一 session 不可並發:用 in-flight 旗標,若主迴圈或上一張仍在截圖就跳過這輪。
  // 真機 takeScreenshot 是 WebDriver 往返(較慢),故頻率保守(每 400ms 嘗試一次)。
  const LIVE_KEY = `${PREFIX}/live`;
  // Fu Xing Gao Zhao 3 逐局盤面證據:直接分析 Android screenrecord 影片(10 FPS),不依賴慢速 Appium 截圖或 VLM wait。
  // 底層模組可換 profile 擴充其他機台;第一版只對已確認的 4.6.8 機台啟用。
  const slotCaptureEnabled = PLATFORM === 'android' && process.env.PA_SLOT_CAPTURE !== '0'
    && /Fu\s*Xing\s*Gao\s*Zhao\s*3|福星高照\s*3/i.test(String(TASK));
  let slotCapture = slotCaptureEnabled
    ? createSlotVideoCapture({ put: s3put, prefix: PREFIX, log: (m) => console.log(m) })
    : null;
  let slotCaptureSummary = null;
  if (slotCapture) console.log('[slot-capture] Fu Xing Gao Zhao 3 逐局盤面擷取已啟用(影片 10 FPS)');
  // 即時影片(screenrecord 2 秒分段,30+ fps):Android 才有;啟動失敗就只用截圖輪播。
  let liveVideo = null;
  if (PLATFORM === 'android' && process.env.PA_LIVE_VIDEO !== '0') {
    try {
      liveVideo = makeLiveVideo();
      await liveVideo.start();
    } catch (e) {
      console.warn('[live-video] 無法啟動,改用截圖輪播:', e?.message || e);
      liveVideo = null;
    }
  }

  let liveBusy = false;
  let liveLastShotAt = 0;
  const liveTick = async () => {
    if (liveBusy) return;
    // 影片串流正常時,截圖幀只當備援/封面(每 5 秒一張),把 Appium 時間留給 AI 與影片。
    if (liveVideo?.healthy() && Date.now() - liveLastShotAt < 5000) return;
    liveBusy = true;
    liveLastShotAt = Date.now();
    try {
      const b64 = await client.takeScreenshot();
      const png = Buffer.from(b64, 'base64');
      // 原圖 PNG 太大(數 MB),前端來不及下載下一幀就被換掉 → 畫面看似凍結。壓成小 JPEG 再上傳。
      const jpg = MAGICK ? await liveJpeg(png) : null;
      await s3put(LIVE_KEY, jpg ?? png, jpg ? 'image/jpeg' : 'image/png');
    } catch { /* 幀丟失不影響 */ }
    finally { liveBusy = false; }
  };
  let liveTimer = setInterval(liveTick, 400);
  if (liveTimer.unref) liveTimer.unref();

  // 即時數值把關(疑似讀錯 / 投注額變更)。
  const obsGuard = createObsGuard();
  // 時間到:單段 → 最後一步收尾;長時 → 換新連線接續。
  let wrapUpAsked = false;
  let wrapReason = ''; // 'devicefarm' | 'deadline'

  /**
   * 長時模式:收下這條連線的錄影 / log / 效能 → 關掉 → 用同一個 App 上傳(appArn)開新連線
   * (優先同一台裝置,不行就換一台)→ 重新開始錄影、啟動遊戲、即時串流。步驟編號接續。
   * 成功回 null;失敗回錯誤訊息。
   */
  async function switchSession() {
    console.log(`[segment] 第 ${segment} 段已到 ${WRAP_MIN} 分鐘,換新連線接續`);
    await writeStatus('running', `第 ${segment} 段連線已到 ${WRAP_MIN} 分鐘,換新連線接續中`, steps.length);
    if (teamPending) await Promise.race([teamPending, sleep(15_000)]);
    if (devLogs) { if (devLogsPending) await devLogsPending; devLogsPending = null; await devLogs.collect(steps.length).catch(() => null); }
    clearInterval(liveTimer);
    if (liveVideo) { await liveVideo.stop().catch(() => {}); liveVideo = null; }
    for (let w2 = 0; liveBusy && w2 < 20; w2++) await sleep(50);
    const prevRecorder = recorder;
    if (recorder) { activeRecorder = null; await recorder.stop().catch((e) => console.warn('[record] 收尾失敗', e?.message || e)); recorder = null; }
    if (perfPending) { await perfPending.catch(() => null); perfPending = null; }
    if (perfShell) await perfMon.stop().catch(() => {});
    activePerfMon = null;
    await flushPuts(); // 背景上傳(截圖 / 步驟 JSON / 記憶地圖)先收完,再換連線
    await client.quit().catch(() => {});
    await stopSelfOwnedSession();

    segment += 1;
    if (slotCapture) slotCapture.setSession(segment);
    segStartedAt = Date.now();
    bootPhase('device', { deviceStatus: 'PENDING' });
    setSessionBoot();
    await writeStatus('running', `第 ${segment} 段:Device Farm 配置真機中`, steps.length);
    let session = null;
    let lastErr = '';
    for (const deviceArn of [sessionInfo.deviceArn, undefined]) {
      try {
        session = await createSession(dfClient, {
          projectArn: sessionInfo.projectArn,
          appArn: sessionInfo.appArn,
          platform: PLATFORM,
          namePrefix: `pa-${JOB}-s${segment}`,
          onStatus: (st) => { boot.deviceStatus = st; },
          ...(sessionInfo.prefer32bit ? { prefer32bit: true } : {}),
          ...(deviceArn ? { deviceArn } : {}),
          ...(MAX_OS !== undefined ? { maxOsVersion: MAX_OS } : {}),
          ...(MIN_OS !== undefined ? { minOsVersion: MIN_OS } : {}),
        });
        break;
      } catch (e) {
        lastErr = String(e?.message || e).slice(0, 300);
        console.warn(`[segment] 開新連線失敗(${deviceArn ? '同一台裝置' : '任一台'}):${lastErr}`);
      }
    }
    if (!session) return lastErr || '無法建立新連線';
    APPIUM_URL = session.appiumUrl;
    SESSION_ARN = session.sessionArn;
    selfOwnedSessionArn = session.sessionArn;
    if (session.deviceModel) deviceModel = session.deviceModel;
    sessionInfo.deviceArn = session.deviceArn ?? sessionInfo.deviceArn;
    bootPhase('connect', session.deviceModel ? { deviceModel: session.deviceModel } : {});
    client = await AppiumClient.create(APPIUM_URL, { platform: PLATFORM, autoLaunch: false, refreshEndpoint });
    // 新 client 的座標基準是空的:清掉快取,下一步一定會重新告知截圖尺寸(否則點擊不會換算到視窗座標)。
    spaceDims = null;

    perfMon = PLATFORM === 'android' && effectivePkg && PERF_EVERY > 0 ? new PerfMonitor(client, effectivePkg) : null;
    perfShell = perfMon ? await perfMon.start() : false;
    if (perfShell) activePerfMon = perfMon;
    devLogs = makeDevLogs();
    if (recordingEnabled) {
      recorder = makeRecorder(prevRecorder);
      if (await recorder.start()) { activeRecorder = recorder; await sleep(1500); } else recorder = null;
    }
    if (effectivePkg) {
      let li = null;
      if (perfShell) li = await perfMon.launch();
      if (!li) { try { await client.launchPackage(effectivePkg); } catch { /* 交給 AI 找入口 */ } }
      await sleep(8000);
    }
    // 換了裝置時解析度可能不同:重量畫面尺寸、重建系統提示。
    try {
      const dim = pngSize(Buffer.from(await client.takeScreenshot(), 'base64'));
      if (dim && (dim.w !== w || dim.h !== h)) {
        w = dim.w; h = dim.h;
        system = buildSystemPrompt(w, h, knowledge, MAGICK, evidence, controls, vlmCoordSystem)
          + hintsPromptSection(appMemory.hints, (id) => struct.pages?.[id]?.name ?? id) + routesPromptSection(appMemory.edits?.routes, routePageName)
          + (scriptTracker ? scriptTracker.promptSection() : '')
          + (team?.enabled.agent && !USE_UITARS ? VISION_ELEMENTS_NOTE : '');
      }
    } catch { /* 用原尺寸 */ }
    if (PLATFORM === 'android' && process.env.PA_LIVE_VIDEO !== '0') {
      try {
        liveVideo = makeLiveVideo();
        await liveVideo.start();
      } catch (e) {
        console.warn('[live-video] 換新連線後無法啟動,改用截圖輪播:', e?.message || e);
        liveVideo = null;
      }
    }
    liveTimer = setInterval(liveTick, 400);
    if (liveTimer.unref) liveTimer.unref();
    // 新遊戲狀態:卡住 / 死循環計數歸零,數值不跟前一段比。
    lastPhash = null; stuckCount = 0; loadingStreak = 0; consecWaitCount = 0; lastMove = null;
    screenSeen.clear();
    obsGuard.reset();
    pendingShot = null; // 換了連線,上一段看守留下的畫面已不是現況
    prevAction = 'launch';
    controlNote += `【系統】Device Farm 單次連線最長 150 分鐘,已換新連線(第 ${segment} 段)並重新安裝、啟動遊戲:帳號與遊戲狀態可能已重置(例如訪客帳號、餘額重新開始)。請從第一個畫面重新進入,接著完成測試腳本還沒做完的部分。`;
    bootPhase('run');
    await writeStatus('running', `第 ${segment} 段連線就緒(${deviceModel ?? '真機'}),繼續測試`, steps.length);
    console.log(`[segment] 第 ${segment} 段就緒:${deviceModel ?? ''}`);
    return null;
  }

  // 【與控制遊戲 Agent 互動】測試人員在即時畫面上的點擊/拖曳 = 直接操作裝置(不經 AI,不等下一步截圖)。
  // 用最近一步的座標空間換算成裝置像素立刻執行,再把「你的座標 + 裝置像素」告訴 Agent(下一回合注入)。
  let lastSpace = null; // { cw, ch, origW, origH }:最近一步的截圖(給模型)與裝置座標空間
  let directOps = []; // 步驟之間直接執行的手勢(附到下一步的 step 紀錄,執行軌跡看得到)
  let curStep = 0;
  const runOperatorGesture = async (c) => {
    if (!lastSpace) return false;
    const { cw: scw, ch: sch, origW: sW, origH: sH } = lastSpace;
    const g = operatorGestureCmd(c, scw, sch);
    if (!g) return false;
    const dev = (v, span, max) => Math.max(0, Math.min(max, Math.round((v / span) * max)));
    const device = {
      x: dev(g.x, scw, sW), y: dev(g.y, sch, sH),
      ...(g.operatorDrag ? { x2: dev(g.x2, scw, sW), y2: dev(g.y2, sch, sH) } : {}),
    };
    try {
      await client.act({ ...g, ...device });
    } catch (e) {
      console.warn('[operator] 直接執行失敗,改由下一步執行', e?.message || e);
      return false;
    }
    const said = c.text && c.text !== POINT_ONLY_TEXT && c.text !== DRAG_ONLY_TEXT ? c.text : '';
    const op = {
      id: c.id, kind: g.operatorDrag ? 'drag' : 'tap',
      shot: { x: g.x, y: g.y, ...(g.operatorDrag ? { x2: g.x2, y2: g.y2 } : {}) },
      device, space: { shot: [scw, sch], device: [sW, sH] },
      ...(said ? { said } : {}), at: new Date().toISOString(),
    };
    directOps.push(op);
    controlNote += operatorDirectNote(op, normCoord);
    await operator.ack(c, {
      status: 'applied', step: curStep, action: g.operatorDrag ? 'swipe' : 'tap', direct: true, device,
      reply: g.operatorDrag
        ? `已直接在裝置上拖曳:(${device.x}, ${device.y}) → (${device.x2}, ${device.y2}),並把座標告知控制遊戲 Agent。`
        : `已直接在裝置上點擊 (${device.x}, ${device.y}),並把座標告知控制遊戲 Agent。`,
    }).catch(() => {});
    console.log(`[operator] 直接執行 ${op.kind} 裝置 (${device.x},${device.y})${g.operatorDrag ? ` → (${device.x2},${device.y2})` : ''}`);
    return true;
  };

  // 可被即時操作打斷的等待:每 ~0.4 秒輪詢測試人員指令。點擊/拖曳當下直接在裝置上執行,
  // 執行後再多等 1.5 秒讓畫面反應(期間連續點也都馬上執行);文字指令暫存,下一步交給 Agent。
  const sleepOrOperator = async (ms) => {
    const chunk = 400;
    let deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await sleep(Math.min(chunk, Math.max(0, deadline - Date.now())));
      let fresh = [];
      try { fresh = await operator.poll(); } catch { fresh = []; }
      if (!fresh.length) continue;
      let deferred = false;
      for (const c of fresh) {
        if (c.point && await runOperatorGesture(c)) {
          deadline = Math.max(deadline, Date.now() + 1500);
          continue;
        }
        await operator.ack(c, { status: 'received' }).catch(() => {});
        pendingCmds.push(c);
        if (c.point) deferred = true; // 沒辦法直接執行(例:還沒有第一張截圖)→ 下一步照舊執行
      }
      if (deferred) return;
    }
  };

  for (let i = 0; i < MAX_STEPS; i++) {
    curStep = i;
    // 取消旗標檢查。
    if (await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; break; }

    // 執行時間:這段連線到第 WRAP_MIN 分鐘 → 長時模式換新連線;否則這一步當最後一步收尾。
    if (!wrapUpAsked && SESSION_ARN && Date.now() - segStartedAt >= WRAP_MIN * 60_000) {
      const more = maxSegments === 0 || segment < maxSegments;
      if (more && ownsSession && sessionInfo?.appArn) {
        const err = await switchSession().catch((e) => String(e?.message || e));
        if (err) {
          finalState = 'error';
          finalMsg = `已達執行時間上限:第 ${segment} 段連線無法建立(${err}),測試在此結束。`;
          break;
        }
      } else {
        wrapUpAsked = true;
        wrapReason = 'devicefarm';
        controlNote += `【系統|最後一步】已到 Device Farm 連線的時間上限(單次最長 150 分鐘),這是最後一張畫面,不會再執行動作。請在 thinking 寫出目前為止的進度與測試腳本要求的統計數字,並在 obs 回報畫面上的數值。`;
      }
    }
    // 主機最長時數(Android 容器 / Windows):到了就用這一步收尾並寫報告,
    // 不要等主機的保險關機把 runner 直接殺掉(那樣報告與終態都不會寫,任務永遠卡在「執行中」)。
    if (!wrapUpAsked && Number.isFinite(DEADLINE_MS) && Date.now() >= DEADLINE_MS) {
      wrapUpAsked = true;
      wrapReason = 'deadline';
      controlNote += `【系統|最後一步】已到這次任務設定的最長執行時數,這是最後一張畫面,不會再執行動作。請在 thinking 寫出目前為止的進度與測試腳本要求的統計數字,並在 obs 回報畫面上的數值。`;
    }

    const t0 = Date.now();
    // 這一步各段耗時(ms),寫進 step.timing;收尾時印出中位數,用來找真正的瓶頸。
    const tm = {};
    // 前景守衛:AI 可能誤按 back 把遊戲退到背景/桌面。已知包名時確保遊戲在前景,
    // 若被拉回前景則多等一下載入,避免整段在 Android 桌面/Play Games 空轉。
    // 前景遺失記錄成證據(報告據 appState + 上一步動作區分:AI 按 back / 疑似閃退 / 跳到其他 App)。
    //
    // 每步都問一次是一次 Appium 往返(實測整步開銷約 7.6 秒,這類往返是其中一部分)。
    // 改成只在「上一步可能把 App 弄到背景」時必查(back / launch / 上一步剛掉出前景 / 第一步),
    // 其餘每 FG_EVERY 步查一次 —— 真的掉出前景時,下一張截圖也會讓 AI 看到桌面並自行處理。
    let foregroundLost = false;
    let appState;
    const fgRisk = i === 0 || lastForegroundLost || prevAction === 'back' || prevAction === 'launch';
    if (effectivePkg && (fgRisk || i % FG_EVERY === 0)) {
      try {
        const wasForeground = await timedAsync(tm, 'fg', () => client.ensureForeground(effectivePkg));
        if (!wasForeground) { foregroundLost = true; appState = client.lastAppState; await sleepOrOperator(4000); }
      } catch { /* 盡力,不擋主流程 */ }
    }
    lastForegroundLost = foregroundLost;
    // 效能取樣(每 PERF_EVERY 步一次;取不到為 null,報告標示未收集)。
    // adb shell 取樣與 VLM 推理並行(不拖慢步調);FPS/CPU/GPU 是「區間累計」,不會漏掉取樣間的幀。
    // 本步若中途 continue,未寫入的結果留給下一步(perfPending 不會重複發起)。
    if (!perfPending && perfMon && i % PERF_EVERY === 0) {
      perfPending = perfShell
        ? perfMon.sample().catch(() => null)
        : client.perfSample(effectivePkg).catch(() => null);
    }
    // 真機 log(logcat + 音效播放狀態)與 VLM 推理並行;動作送出前等它結束(Appium 指令不交錯)。
    if (devLogs && !devLogsPending) devLogsPending = devLogs.collect(i).catch(() => null);
    let shot;
    // pendingShot = 上一步等畫面穩定時就預先抓好的那張(見迴圈尾端),這一步不必再等取圖。
    const prefetched = Boolean(pendingShot);
    try { shot = pendingShot ?? await timedAsync(tm, 'shot', () => client.takeScreenshot()); pendingShot = null; } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續截圖失敗'; break; } continue; }
    if (prefetched) tm.shotPrefetched = 1;
    // 即時推截圖到 S3(只給前端看)→ 背景上傳,不擋決策。
    s3putBg(`${PREFIX}/screenshots/${i}.png`, Buffer.from(shot, 'base64'), 'image/png');

    // 卡住偵測:本步 pHash 與上一步比,幾乎相同(<40 bit)視為畫面沒變。
    const curPhash = MAGICK ? timed(tm, 'phash', () => pHashHex(shot)) : null;
    const screenChanged = lastPhash && curPhash ? pHashHamming(lastPhash, curPhash) > 40 : true;
    if (lastPhash && !screenChanged) stuckCount++; else stuckCount = 0;
    lastPhash = curPhash;

    // 【走位回饋】有搖桿的遊戲,鏡頭跟著角色走:上一步 move 之後,背景區塊若完全沒捲動,
    // 代表角色被障礙物(樹/石頭/牆)擋住 —— 角色會轉身、動畫在動,整張圖的 pHash 看不出來。
    // 2026-10-05 job-muv1zsvi-0qbt8v:AI 連續往右推搖桿,角色右邊緊貼一棵樹,背景 0 bit 變化;
    // 真的有走時同一區塊差 278 bit。
    const curScene = MAGICK && controls?.joystick ? pHashHex(shot, SCENE_CROP) : null;
    blockedDir = null;
    if (lastMove?.scene && curScene) {
      if (isBlocked(lastMove.scene, curScene, pHashHamming)) {
        blockedDir = lastMove.dir;
        blockedStreak++;
        const alt = turnDir(blockedDir, blockedStreak);
        controlNote += `【走位回饋】上一步 move dir=${blockedDir} 有按住搖桿,但背景完全沒有移動 —— 角色被障礙物(樹/石頭/牆)擋住了。不要再往 ${blockedDir},改往 ${alt} 或其他方向繞開。`;
      } else blockedStreak = 0;
    }
    lastMove = null;

    // 每步以「當前這張截圖」的真實像素尺寸為原始基準(遊戲可能中途由直向轉橫向,尺寸會變)。
    const dimNow = pngSize(Buffer.from(shot, 'base64'));
    const origW = dimNow ? dimNow.w : w;
    const origH = dimNow ? dimNow.h : h;
    // ── smart-resize(A 路核心)──
    // Qwen-VL 系模型天生「在它 smart_resize 後那張圖的座標系裡回報絕對像素座標」。
    // 故把截圖精確縮到 smart_resize 尺寸再送(送出尺寸 == 模型座標基準 cw×ch),
    // 模型回像素座標後,除以 cw/ch 得比例、再乘 origW/origH → 裝置像素,座標才會準。
    // 不再疊網格、不再要 0~1000(那是造成先前不準的錯誤問法)。
    const ds = MAGICK ? timed(tm, 'resize', () => resizeToSmartB64(shot, origW, origH)) : { b64: shot, w: origW, h: origH, bytes: Math.floor((shot.length * 3) / 4), format: 'png' };
    const cw = ds.w;   // smart-resize 寬 = 模型座標 x 基準
    const ch = ds.h;   // smart-resize 高 = 模型座標 y 基準
    const visionFmt = ds.format; // 'jpeg' | 'png'
    // 點擊仍換算到裝置截圖空間(origW×origH == Appium 點擊空間);setCoordinateSpace 傳原圖尺寸。
    // 座標空間只在截圖尺寸變了(例如遊戲轉向)才重新問裝置 —— 原本每步都問,是一次沒必要的
    // Appium 往返;尺寸沒變時 client 內部的基準值本來就不用動。
    let space = null;
    if (!spaceDims || spaceDims[0] !== origW || spaceDims[1] !== origH) {
      space = await timedAsync(tm, 'winSize', () => client.setCoordinateSpace(origW, origH).catch(() => null));
      spaceDims = [origW, origH];
    }
    lastSpace = { cw, ch, origW, origH };
    // 停輪判定的區域跟著畫面方向(遊戲可能中途轉向)。
    spinRois = spinCrops(origW, origH);
    if (i === 0 && space) console.log('座標空間 裝置=', space.shot, 'window=', space.win, 'smart-resize(給模型)=', `${cw}x${ch}`, ds.format, `${Math.round(ds.bytes / 1024)}KB`);
    // 方向偵測(僅用於提示模型重新評估版面;不影響座標換算)。
    const isLandscape = origW > origH;
    const orient = isLandscape ? '橫向(landscape,寬>高)' : '直向(portrait,高>寬)';
    const orientChanged = prevOrient != null && prevOrient !== isLandscape;
    // 座標契約依模型母語:pixel 回絕對像素;norm1000 回 0~1000 相對座標。
    const dimHint =
      (normCoord
        ? `這張截圖尺寸為 ${cw}x${ch} 像素(寬x高),但座標請一律用「0~1000 的相對座標」:左上角 (0,0)、右下角 (1000,1000)、正中央約 (500,500),與實際像素大小無關。`
        : `這張截圖尺寸為 ${cw}x${ch} 像素(寬x高)。座標請用「這張圖的絕對像素」:左上角是 (0,0),右下角是 (${cw},${ch})。`) +
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
    // 測試人員即時指令(聊天室):新指令最高優先注入本回合;先前指令持續提醒。
    const freshCmds = await operator.poll();
    for (const c of freshCmds) await operator.ack(c, { status: 'received', step: i, screen: prevScreen || undefined });
    // 上一步沒有成功處理(模型回應無法解析)的指令延續到這一步,仍以「剛下的指令」最高優先注入,
    // 直到 AI 真的給出有效回應為止 —— 之前會在解析失敗那一步被「吃掉」,之後只剩一句提醒。
    const newCmds = [...pendingCmds, ...freshCmds];
    pendingCmds = [];
    // 回到某畫面時,提醒使用者教過的該畫面操作(system 裡的長清單之外,再於當下強調一次)。
    const scoped = screenHintsFor(appMemory.hints, { screen: prevScreen, pageId: prevPageId });
    const memoryNote = scoped.length
      ? `\n【記憶提醒】你之前在「${prevScreen}」被測試人員教過(由新到舊,矛盾時照第一則):${scoped.slice(0, 3).map((h) => `「${h.text}」`).join(';')}。照做,不要重複撞牆。`
      : '';
    const memoNote = progressMemo ? `\n【你的進度筆記(上一步寫的,照它延續,不要重新開始)】${progressMemo}` : '';

    // ── 【記憶腳本 / 反射層】先用畫面指紋認畫面:認得、而且記憶裡有可信的操作 → 這一步直接照做,不問 AI。
    // 測試人員正在下指令、收尾、戰鬥走位中都不用反射(交給 AI 看)。
    // 「測項確認中」(pendingFinal)原本也整個關掉反射 —— 2026-10-17(job-mvch7zri)實測這會
    // 造成大量空轉:AI 在第 78 步宣告全部完成,之後的 206 步裡只有 5 步走得到反射層,
    // SPIN 迴圈幾乎停擺。確認要的是「AI 再看一張畫面」,不是「停止按 SPIN」,所以只擋導航,
    // SPIN 迴圈照跑(它本來就是這個任務要做的動作,而且每局都會自行驗證轉輪有沒有動)。
    const confirming = Boolean(scriptTracker?.pendingFinal);
    let reflexCmd = null;
    if (REFLEX_ON && MAGICK && curPhash && !newCmds.length && !wrapUpAsked && !lastBattleMove) {
      const here = identifyPage(struct, curPhash);
      const nameOf = (id) => struct.pages?.[id]?.name ?? '';
      // 1) 確認上一步反射的結果:到了預期畫面才繼續;載入中就等;沒反應記失敗並交回 AI。
      if (!confirming && reflexPending) {
        const p = reflexPending;
        if (here?.pageId === p.to) {
          reflexPending = null;
          reflexState.recent = [...reflexState.recent, p.to].slice(-6);
        } else if (here?.transient && p.waits < 6) {
          p.waits++;
          reflexCmd = { action: 'wait', duration: 1, screen: nameOf(here.pageId), reflex: { kind: 'wait', to: p.to },
            thinking: `[記憶腳本] 等「${nameOf(p.to)}」載入(${p.waits}/6)。` };
        } else if (here?.pageId === p.from && !screenChanged && p.waits < 1) {
          p.waits++;
          reflexCmd = { action: 'wait', duration: 1, screen: nameOf(here.pageId), reflex: { kind: 'wait', to: p.to },
            thinking: `[記憶腳本] 畫面還沒反應,再等一下。` };
        } else {
          if (here?.pageId === p.from) {
            // 照記憶點了卻沒反應:這條本次不再用;跨版本的操作失敗 → 本次不再用任何跨版本操作(遊戲可能改版)。
            reflexState.demoted.add(p.key);
            if (p.cross) reflexState.crossVersionFailed = true;
            console.log(`[記憶腳本] 第 ${i} 步:照記憶操作後畫面沒有變化,停用這條並交回 AI(${p.key})`);
            reflexNotes.push(`在「${nameOf(p.from)}」照記憶操作沒有反應,已交回你判斷`);
          } else {
            console.log(`[記憶腳本] 第 ${i} 步:到了預期外的畫面(預期「${nameOf(p.to)}」),交回 AI`);
          }
          reflexPending = null;
        }
      }
      // 2) SPIN 迴圈:RTP 任務、還沒轉完、目前在有可信 SPIN 操作的畫面。
      if (!reflexCmd && !reflexPending && rtpLoop.target > 0 && !rtpLoop.done && !rtpLoop.handBack && here && !here.transient) {
        const spin = chooseSpinOp({ struct, edits: appMemory.edits, pageId: here.pageId, version: appVersion, state: reflexState, step: i });
        const c = spin ? cmdFromOp(spin.op, cw, ch) : null;
        if (c) {
          reflexCmd = { ...c, target: spin.target, screen: nameOf(here.pageId),
            reflex: { kind: 'spin', key: spin.key, round: rtpLoop.paid + 1, of: rtpLoop.target },
            thinking: `[SPIN 迴圈] 第 ${rtpLoop.paid + 1}/${rtpLoop.target} 局:照記憶點「${spin.target}」。` };
        }
      }
      // 3) 導航:這個畫面有可信、通往目標的出路 → 直接走。
      if (!confirming && !reflexCmd && !reflexPending && here && !here.transient && reflexState.chain < REFLEX_MAX_CHAIN) {
        const focus = scriptTracker ? (scriptTracker.items()[scriptTracker.current - 1] ?? '') : '';
        const d = chooseReflex({ struct, edits: appMemory.edits, pageId: here.pageId, task: TASK, focus, version: appVersion, state: reflexState });
        const c = d ? cmdFromOp(d.op, cw, ch) : null;
        if (d && c) {
          const how = { route: '照路線', named: '目標點名', popup: '關彈窗', verified: '人工確認', dominant: '主要出口' }[d.reason] ?? d.reason;
          const trustTxt = d.trust === 'verified' ? '人工確認' : `成功 ${d.hits} / 失敗 ${d.misses}`;
          reflexCmd = { ...c, target: d.target, screen: nameOf(here.pageId),
            reflex: { kind: 'nav', key: d.key, from: here.pageId, to: d.toPageId, reason: d.reason, trust: d.trust },
            thinking: `[記憶腳本] 認出「${nameOf(here.pageId)}」→ ${c.action}「${d.target}」前往「${nameOf(d.toPageId) || '?'}」(${how};${trustTxt})。` };
          reflexPending = { key: d.key, from: here.pageId, to: d.toPageId, cross: d.cross, waits: 0 };
          reflexState.chain++;
          reflexNotes.push(`在「${nameOf(here.pageId)}」${c.action}「${d.target}」`);
        }
      }
    }
    if (!reflexCmd) { reflexState.chain = 0; reflexState.recent = []; }
    const reflexNote = !reflexCmd && reflexNotes.length
      ? `\n【記憶腳本】上一張畫面之前,系統已依記憶自動執行:${reflexNotes.slice(-8).join(' → ')}。這張就是執行後的畫面,從這裡接著做,不要重做這些步驟。`
      : '';
    if (!reflexCmd) reflexNotes = [];

    const turnText = (i === 0 ? `第一張畫面。目標:${TASK}` : `上一步(${prevAction})執行後的最新畫面。`) + dimHint + stuckNote + memoNote + controlNote
      + reflexNote
      + (scriptTracker ? scriptTracker.turnNote() : '')
      + memoryNote + routeTurnNote(appMemory.edits?.routes, prevPageId, routePageName) + operatorTurnNote(newCmds, operator.active);
    // 反射步不問 AI:不清掉要告訴 AI 的提醒、也不把這張圖放進對話(下次 AI 看畫面時一併交代)。
    if (!reflexCmd) {
      controlNote = '';
      messages.push(makeUserTurn([visionShot], turnText, visionFmt));
    }
    // UI-TARS(SageMaker):單幀 GUI grounding,座標直接落在 cw×ch smart-resize 幀;否則走 Bedrock 通用 VLM。
    const tVlm = Date.now();
    // 【戰鬥自動走位】割草類(下方中央搖桿):上一步是戰鬥中的走位時,AI 思考期間(數秒)角色
    // 若站著不動就會被包圍死亡 —— 先前實測每步只走 2 秒、其餘 8~10 秒原地挨打,第 1 關就陣亡。
    // 這裡在呼叫 VLM 的同時,背景執行一段「繞圈走位」手勢(按住搖桿畫圓,角色持續繞圈遛怪)。
    const autopilot = battleAutoEnabled && lastBattleMove && !popupLastStep;
    let autopilotPromise = null;
    if (autopilot) {
      autopilotTick++;
      autopilotPromise = client
        .act({ action: 'kite', holdMs: AUTOPILOT_MS, clockwise: autopilotTick % 2 === 0, start: autopilotTick * 1.3,
          ...(controls?.joystick ? { x: Math.round(origW * controls.joystick.x), y: Math.round(origH * controls.joystick.y) } : {}) })
        .catch((e) => console.warn('[autopilot] kite 失敗', e?.message || e));
    }
    // UI-TARS 只看 instruction(不吃 system/回合文字):把測試人員指令與畫面記憶併進 instruction。
    const uitarsBase = TASK;
    const uitarsInstr = operator.active.length || scoped.length
      ? `${uitarsBase}\n\nTester instructions (highest priority, follow now):\n${[...operator.active.slice(-3).map((c) => c.text), ...scoped.slice(0, 3).map((h) => h.text)].map((t) => `- ${t}`).join('\n')}`
      : uitarsBase;
    // 測試人員直接在即時畫面上點了位置 / 拖了一段:不靠 AI 猜座標,這一步就照做(最準)。
    // point/to 是相對畫面的比例(0–1),換算到本步截圖(cw×ch)空間後走同一條點擊/拖曳/標記鏈。
    // 測試人員在即時畫面上的手勢 → 這一步直接照做(不經 VLM)的「決策」物件。
    const buildOperatorDecided = (c) => {
      const gesture = operatorGestureCmd(c, cw, ch);
      const said = c.text && c.text !== POINT_ONLY_TEXT && c.text !== DRAG_ONLY_TEXT ? c.text : '';
      const note = said ? `(${said})` : '';
      const opCmd = {
        ...gesture,
        ...(prevScreen ? { screen: prevScreen } : {}),
        thinking: gesture.operatorDrag
          ? `依測試人員在即時畫面上拖曳的路徑,從 (${gesture.x}, ${gesture.y}) 按住拖到 (${gesture.x2}, ${gesture.y2}),耗時 ${gesture.durationMs} ms${note}。`
          : `依測試人員在即時畫面上點選的位置直接點擊 (${gesture.x}, ${gesture.y})${note}。`,
        target: said || (gesture.operatorDrag ? '測試人員指定拖曳路徑' : '測試人員指定位置'),
      };
      return { cmd: opCmd, usage: null, rawText: JSON.stringify(opCmd), trace: { modelId: 'operator', channel: 'operator', ok: true, request: {} } };
    };
    let pointCmd = [...newCmds].reverse().find((c) => c.point);
    let decided;
    if (reflexCmd) {
      decided = { cmd: reflexCmd, usage: null, rawText: JSON.stringify(reflexCmd), trace: { modelId: 'reflex', channel: 'reflex', ok: true, request: {} } };
    } else if (pointCmd) {
      decided = buildOperatorDecided(pointCmd);
    } else if (USE_UITARS) {
      decided = await decideUitars(uitarsInstr, messages, cw, ch);
    } else {
      // 【即時操作】等 VLM 的 10~30 秒內,背景每 0.5 秒輪詢你的即時點擊;一偵測到點擊就
      // 中止這一步的等待、直接執行你的手勢(丟棄這次 VLM 結果),讓「人點一下 → 裝置幾乎立刻動」。
      // 全程單執行緒:背景只做 S3 輪詢,送點擊仍走主迴圈唯一的裝置通道,不會與主迴圈搶 Appium。
      let stopPoll = false;
      const operatorArrived = new Promise((resolve) => {
        (async () => {
          while (!stopPoll) {
            await sleep(500);
            if (stopPoll) return;
            let fresh = [];
            try { fresh = await operator.poll(); } catch { fresh = []; }
            for (const c of fresh) await operator.ack(c, { status: 'received', step: i, screen: prevScreen || undefined }).catch(() => {});
            if (fresh.length) newCmds.push(...fresh); // 讓本步 operatorDirected 生效、並供後續注入
            const pt = [...fresh].reverse().find((c) => c.point);
            if (pt) { resolve(pt); return; }
          }
        })();
      });
      const vlmPromise = decide(system, messages);
      const winner = await Promise.race([
        vlmPromise.then((r) => ({ kind: 'vlm', r })),
        operatorArrived.then((pt) => ({ kind: 'operator', pt })),
      ]);
      stopPoll = true;
      if (winner.kind === 'operator') {
        vlmPromise.catch(() => {}); // 丟棄這次 VLM(背景自然結束,避免 unhandled rejection)
        pointCmd = winner.pt;
        decided = buildOperatorDecided(pointCmd);
        console.log(`[operator] 即時點擊打斷 VLM 等待,立刻執行(第 ${i} 步)`);
      } else {
        decided = winner.r;
      }
    }
    // 解析失敗(模型吐亂碼/空字串)時立即重問,最多 2 次;不浪費一個步驟、也不讓連續失敗計數誤殺任務。
    //   第 1 次:同模型,但只帶「本回合」(拿掉長對話歷史 —— 實測模型多半是被長歷史帶歪才開始吐亂碼)。
    //   第 2 次:換備援模型(VLM_FALLBACK),同樣只帶本回合。
    // 備援呼叫本身失敗(如無權限)時保留原結果(wait 重試),不讓「模型呼叫失敗 → done」誤結束任務。
    for (let r = 0; r < 2 && decided.cmd.parseFailed && decided.trace?.ok !== false && !USE_UITARS; r++) {
      const model = r === 0 ? VLM : VLM_FALLBACK;
      const retry = await decide(system, [messages[messages.length - 1]], model);
      if (retry.trace?.ok === false) { console.warn(`[decide] 重問(${model})呼叫失敗:${retry.trace?.error?.message ?? ''}`); continue; }
      if (retry.usage && decided.usage) retry.usage = addUsage(retry.usage, decided.usage);
      decided = { ...retry, trace: { ...retry.trace, retries: r + 1, ...(model !== VLM ? { fallbackModel: model } : {}) } };
      if (!retry.cmd.parseFailed && model !== VLM) console.log(`[decide] 第 ${i} 步改由備援模型 ${model} 決策`);
    }
    const { cmd, usage, rawText, trace } = decided;
    // 【座標換算】norm1000 模型(Nova 等)回 0~1000 相對座標 → 換算成本張圖(cw×ch)的像素,
    // 之後所有下游(元件正規化、落點標記、裝置換算)都在像素空間,與 pixel 模型一致。
    // operator 直接點選(pointCmd)已是像素,不換算。
    if (normCoord && !pointCmd && !reflexCmd) {
      const toPx = (v, span) => { const n = Number(v); return Number.isFinite(n) ? Math.round((n / 1000) * span) : v; };
      for (const [k, span] of [['x', cw], ['y', ch], ['x2', cw], ['y2', ch], ['tx', cw], ['ty', ch]]) {
        if (cmd[k] != null) cmd[k] = toPx(cmd[k], span);
      }
      if (Array.isArray(cmd.elements)) {
        for (const el of cmd.elements) {
          if (el && el.x != null) el.x = toPx(el.x, cw);
          if (el && el.y != null) el.y = toPx(el.y, ch);
        }
      }
    }
    const vlmMs = Date.now() - tVlm;
    // 【測項為主】看得到畫面的視覺 Agent 回報「已完成到第幾項」→ 推進進度(決策 Agent 只讀這個數字)。
    // 宣告全部完成:這一步停手,下一張畫面再確認一次;兩次都成立才結束(見 scriptTracker.mjs)。
    let scriptEvent = null;
    if (scriptTracker && !USE_UITARS && !pointCmd && !reflexCmd && !cmd.parseFailed && trace?.ok !== false) {
      const before = scriptTracker.done;
      // 視覺 Agent 給 done 卻沒填 scriptDone → 視同宣告全部完成(確認回合說 done = 確認)。
      let claim = cmd.scriptDone ?? (String(cmd.action || '').trim().toLowerCase() === 'done' ? scriptTracker.total : undefined);
      // 【SPIN 迴圈未達標就不可能全部完成】局數 runner 自己數得出來(rtpLoop.paid),比 AI 從
      // 畫面上數可靠。job-mvch7zri:AI 從第 78 步起反覆宣告 5 項全部完成,runner 只能要它
      // 「再看一張畫面確認」,它看完又改口 —— 這個確認迴圈重複了 62 次(override=script_confirm),
      // 每次都是一趟 VLM 往返。現在直接用客觀局數駁回,並把真實進度告訴它,不進確認迴圈。
      if (Number.isFinite(Number(claim)) && Number(claim) >= scriptTracker.total && spinLoopPending()) {
        claim = Math.max(0, scriptTracker.total - 1);
        controlNote += `【SPIN 迴圈】系統計數:已完成 ${rtpLoop.paid}/${rtpLoop.target} 局付費 SPIN,還沒達標,所以最後一項還不算完成。局數由系統計數,你不用自己數也不要宣告完成;回到主盤面讓系統繼續轉即可。`;
      }
      scriptEvent = scriptTracker.observe(claim, typeof cmd.scriptEvidence === 'string' ? cmd.scriptEvidence : '');
      if (scriptEvent.advanced) console.log(`[測項為主] 第 ${i} 步:完成 ${before} → ${scriptTracker.done}/${scriptTracker.total}(${scriptTracker.evidence || '—'})`);
      if (scriptEvent.confirm) console.log(`[測項為主] 第 ${i} 步:視覺 Agent 回報全部完成,停手確認`);
      if (scriptEvent.retracted) console.log(`[測項為主] 第 ${i} 步:確認未成立,繼續做第 ${scriptTracker.current} 項`);
      if (scriptEvent.complete) console.log(`[測項為主] 第 ${i} 步:再次確認全部完成 → 結束`);
      team?.setScriptStep(scriptTracker.current);
      updateScriptProgress(team);
    }
    const scriptStops = Boolean(scriptEvent && (scriptEvent.complete || scriptEvent.confirm));
    // 【決策 Agent】看視覺 Agent 的描述與元件清單,決定這一步的動作(座標取自元件清單)。
    // 測試人員在畫面上直接點的位置、UI-TARS、視覺回應無法解析時不經決策。決策失敗 → 採用視覺 Agent 的建議。
    // 測項已宣告完成 / 正在確認時不再問決策 Agent(不用再操作,省一次呼叫)。
    let decisionMs;
    if (team?.enabled.agent && !USE_UITARS && !pointCmd && !reflexCmd && !cmd.parseFailed && trace?.ok !== false && !scriptStops) {
      // 等輔助 Agent 對上一步的核對(多半已在上一步的等待時間做完;戰鬥走位中不等)。
      if (teamPending) {
        const settled = await Promise.race([teamPending.then(() => true), sleep(lastBattleMove ? 0 : 5000).then(() => false)]);
        if (settled) teamPending = null;
      }
      const tDec = Date.now();
      const elements = normalizeElements(cmd.elements, cw, ch);
      const visionAction = cmd.action;
      const res = await team.decideAction({
        index: i,
        observation: { screen: cmd.screen, seen: typeof cmd.seen === 'string' ? cmd.seen : '', thinking: String(cmd.thinking || ''), ...(cmd.obs ? { obs: cmd.obs } : {}) },
        elements,
        suggestion: { action: cmd.action, target: typeof cmd.target === 'string' ? cmd.target : '', dir: typeof cmd.dir === 'string' ? cmd.dir : '' },
        screenChanged,
        allowedActions: allowedActions ? [...allowedActions] : [],
        dims: { cw, ch },
        operator: operator.active.slice(-3).map((c2) => c2.text),
        runnerNote: [
          stuckCount > 0 ? `畫面已連續 ${stuckCount} 步沒有變化` : '',
          blockedDir ? `上一步往 ${blockedDir} 走被擋住` : '',
        ].filter(Boolean).join(';'),
      }).catch(() => null);
      decisionMs = Date.now() - tDec;
      if (res) {
        stepPlans.set(i, res.decision);
        updateScriptProgress(team);
        if (res.cmd) {
          // 用決策的動作取代視覺的建議(保留視覺的畫面名 / 描述 / 證據欄位)。
          for (const k of ['x', 'y', 'x2', 'y2', 'tx', 'ty', 'dir', 'direction', 'holdMs', 'durationMs', 'duration', 'text', 'taps', 'scale', 'target']) delete cmd[k];
          Object.assign(cmd, res.cmd);
          if (res.decision.expect) cmd.expect = res.decision.expect;
          cmd.decidedBy = 'agent';
          if (visionAction !== cmd.action) cmd.visionSuggested = visionAction;
        } else {
          cmd.decidedBy = 'vision';
        }
      }
    }
    // 戰鬥自動走位在「視覺 + 決策」整段思考期間持續。
    if (autopilotPromise) await autopilotPromise;
    // AI 原始動作(runner 若覆寫,原始 expect 不再代表實際動作,報告不據以判定 assertion)。
    const aiAction = cmd.action;
    // 反射步沒有送出 user 回合,也就不加 assistant 回合(對話必須 user/assistant 交替)。
    if (!reflexCmd) messages.push(makeAssistantTurn(rawText));
    if (usage) accumulate(tok, usage);
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
    s3putBg(`${PREFIX}/traces/${i}.json`, JSON.stringify(traceRecord), 'application/json');
    // 座標數值化:部分模型(如 Nova)把 x/y 以字串回傳,統一轉成數字供後續吸附/標記/點擊計算。
    for (const k of ['x', 'y', 'x2', 'y2', 'tx', 'ty', 'holdMs', 'durationMs', 'taps']) {
      if (cmd[k] != null && typeof cmd[k] !== 'number') { const n = Number(cmd[k]); if (Number.isFinite(n)) cmd[k] = n; }
    }
    if (typeof cmd.action === 'string') cmd.action = cmd.action.trim().toLowerCase();
    // A 路:模型回的「已經是 smart-resize 圖(cw×ch)的絕對像素座標」,不需正規化還原。
    // 只夾到 [0, cw/ch] 範圍(模型偶爾越界)。落點標記/吸附都在此 cw×ch 空間;點擊再換算到裝置像素。
    const clampTo = (v, span) => Math.max(0, Math.min(span, Math.round(v)));
    if (cmd.x != null && Number.isFinite(cmd.x)) cmd.x = clampTo(cmd.x, cw);
    if (cmd.y != null && Number.isFinite(cmd.y)) cmd.y = clampTo(cmd.y, ch);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) cmd.x2 = clampTo(cmd.x2, cw);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) cmd.y2 = clampTo(cmd.y2, ch);
    if (cmd.tx != null && Number.isFinite(cmd.tx)) cmd.tx = clampTo(cmd.tx, cw);
    if (cmd.ty != null && Number.isFinite(cmd.ty)) cmd.ty = clampTo(cmd.ty, ch);
    // 縮圖(smart-resize)空間 → 裝置截圖空間 的等比換算係數(origW/cw 與 origH/ch 理論上相同,分開算更穩健)。
    const devScaleX = cw > 0 ? origW / cw : 1;
    const devScaleY = ch > 0 ? origH / ch : 1;
    const toDeviceX = (x) => Math.max(0, Math.min(origW, Math.round(x * devScaleX)));
    const toDeviceY = (y) => Math.max(0, Math.min(origH, Math.round(y * devScaleY)));

    // 卡住脫困:連續 ≥3 步畫面沒變 → VLM 顯然瞄不準或選錯。介入輪換。
    // 但先分辨「安裝/載入畫面」:此時亂點無意義,應「耐心等待」而非脫困(APK 尤其數百 MB 首裝很慢)。
    // 且脫困若試了很多輪畫面仍全無變化,代表真的卡死(安裝失敗/當機/需人工)—— 判定 error 結束,
    // 不再無止盡空轉(尤其步數無上限的任務,避免在真機上一直計費)。
    // 連續 VLM 回應無法解析次數上限:parseCmd 解析失敗時回 wait(見該函式註解),這裡累計
    // 連續次數,超過門檻代表模型本身持續輸出不可用內容(非畫面載入問題),中止並明確回報
    // error(而不是像舊版一樣被當成 done 直接誤判 pass)。
    consecParseFailCount = cmd.parseFailed ? consecParseFailCount + 1 : 0;
    if (consecParseFailCount >= PARSE_FAIL_ABORT_LIMIT) {
      finalState = 'error';
      finalMsg = `VLM 連續 ${consecParseFailCount} 次回應無法解析為有效動作 —— 模型輸出格式異常,已中止(避免誤判為完成)。`;
      await writeStatus('error', finalMsg, steps.length);
      break;
    }

    let escapeOverride = false;
    // 安裝/載入偵測:VLM 的 thinking 或畫面名提到 install/loading/安裝/載入 → 視為載入中。
    const loadingHint = /install|loading|安裝|安装|載入|载入|請稍候|请稍候|connecting|連線中|连接中|config\s*ready|進場|进场|logo|品牌動畫|品牌动画|開場|开场/i;
    // 注意:此處在 screenName 宣告之前,只能用 cmd.screen(別引用 screenName,否則 TDZ ReferenceError)。
    // 2026-10-03 修正(實測 job-mus2tskm-mlstop):AI 把有 PLAY 鈕的標題頁命名為「開場畫面」,
    // thinking 寫「開場畫面已載入…點 PLAY」—— 舊規則對 thinking/畫面名做寬鬆關鍵字比對,
    // 「開場」「已載入」都命中,AI 每次想點 PLAY 都被強制改成 wait,卡死 20+ 步。
    // 改為:AI 高信心(conf ≥ 0.8)要點擊/滑動時,只有「畫面名」明確是載入中狀態才強制等待;
    // 其餘情況(低信心或沒回報信心)維持原本的寬鬆判斷。
    const strongLoadingScreen = /loading|載入中|载入中|請稍候|请稍候|installing|安裝中|安装中|connecting|連線中|连接中|config\s*ready/i;
    const aiConf = Number(cmd.conf);
    // 2026-10-15 修正(job-mv8qsz6l-dp2f8r):Nova Pro 不回報 conf,點擊 PLAY 卻因 conf 無值
    // 落入寬鬆分支,畫面名「開場畫面」命中 loadingHint 的「開場」,PLAY 的 tap 連 15 步全被
    // 強制改成 wait,卡死在第一步。只要模型給出「具體落點(有限 x/y)」就代表畫面上有它要點的
    // 東西(非純展示動畫),一律以嚴格 loading 判斷,不被「開場」等寬鬆字誤殺。
    const hasConcreteTarget = (cmd.action === 'tap' || cmd.action === 'swipe')
      && Number.isFinite(Number(cmd.x)) && Number.isFinite(Number(cmd.y));
    const confidentInteract = (cmd.action === 'tap' || cmd.action === 'swipe')
      && ((Number.isFinite(aiConf) && aiConf >= 0.8) || hasConcreteTarget);
    // 2026-10-05 修正(job-muv712gs-pvg7ow 第 4–5 步):大廳的「手指教學指引」被命名為「大廳開場教學」,
    // 「開場」命中寬鬆規則,AI 要點手指指的地方被強制改成 wait,最後要測試人員手動點。
    // 有教學手指 / 指引箭頭 = 畫面上一定有要點的東西,只看畫面名是否明確為載入中。
    const tutorialHint = /教學|教学|指引|引導|引导|手指|箭頭|箭头|tutorial|guide|finger|arrow/i;
    const guidedInteract = (cmd.action === 'tap' || cmd.action === 'swipe')
      && (tutorialHint.test(String(cmd.thinking || '')) || tutorialHint.test(String(cmd.screen || '')));
    const looksLoading = confidentInteract || guidedInteract
      ? strongLoadingScreen.test(String(cmd.screen || ''))
      : loadingHint.test(String(cmd.thinking || '')) || loadingHint.test(String(cmd.screen || ''));

    // 2026-10-02 修正:品牌 Logo/開場動畫畫面常帶有持續的粒子/火焰特效,導致 pHash 判定
    // 「畫面有變化」而讓 stuckCount 一直被重置為 0,使下面「連續無變化才耐心等待」的保護
    // 從未生效——結果 VLM 對著純展示性動畫反覆 tap/swipe/move,8 次就被死循環偵測誤殺
    // (實測 job-muqscmna-syzeke:畫面「大廳頁面ConfigReady」反覆被亂點 8 次才中止)。
    // 這裡獨立於 stuckCount,只要畫面本身被判定為載入/開場動畫,一律強制改 wait,不亂點。
    // 載入畫面連續停留計數:卡太久(如倖存者 Config Ready 等 SDK 回調卡死)時,
    // 允許 AI 的 back/launch 脫困,並由 runner 主動重啟 App(實測 AI 的 launch 一直被改成 wait,永遠出不去)。
    // 不看 pHash:Config Ready 這類畫面有持續動畫,「畫面有變」不代表流程有進展。
    loadingStreak = looksLoading ? loadingStreak + 1 : 0;
    // 本步有測試人員指令:AI 正照人的指示操作,runner 的自動覆寫(強制等待/脫困/強制走位)讓路。
    const operatorDirected = newCmds.length > 0;
    const allowRecovery = loadingStreak >= LOADING_RECOVER_AFTER && (cmd.action === 'back' || cmd.action === 'launch');
    if (looksLoading && loadingStreak >= LOADING_RESTART_AFTER && effectivePkg && appRestarts < 3) {
      appRestarts++;
      loadingStreak = 0;
      console.log(`[recover] 載入畫面卡住 ${LOADING_RESTART_AFTER} 步,重啟 App(第 ${appRestarts} 次)`);
      try { await client.restartApp(effectivePkg); await sleep(8000); } catch (e) { console.warn('[recover] 重啟失敗', e?.message || e); }
      cmd.action = 'wait'; cmd.duration = 1; cmd.x = undefined; cmd.y = undefined;
      cmd.thinking = `[runner 重啟 App] 載入畫面長時間無進展,已關閉並重新開啟遊戲(第 ${appRestarts} 次),請從頭依流程進入。` + String(cmd.thinking || '');
      cmd.override = 'app_restart';
      escapeOverride = true;
      controlNote = '【系統】遊戲剛被重新啟動,請從第一個畫面重新依知識庫流程進入。';
    } else if (looksLoading && cmd.action !== 'wait' && !allowRecovery && !operatorDirected) {
      const origAction = cmd.action;
      cmd.action = 'wait'; cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.duration = 3;
      cmd.thinking = `偵測到載入/開場動畫畫面(無可互動元素),強制改為等待,不亂點。原動作:${origAction}。` + String(cmd.thinking || '');
      cmd.override = 'loading_wait';
      escapeOverride = true;
    }

    // 2026-10-02 修正:老虎機/輪盤等賭場類遊戲的核心節奏是「轉輪結果畫面停留 → 玩家點
    // SPIN 繼續下一輪」,畫面停留期間 pHash 本來就幾乎不變(不是卡死,是在等玩家操作)。
    // 舊版 stuckCount>=3 就不分青紅皂白把接下來最多 20 步「全部強制改 wait」,完全蓋掉模型
    // 自己已經正確判斷要點 SPIN 的 tap(實測 job-muqvy57p-cquk7t:模型第 13 步明確說「繼續
    // 第 2 次旋轉,點 SPIN」,但接下來 7 步全被覆寫成「連續畫面沒變,先等待」,最終因為脫困
    // 輪換掃描的座標都沒掃到 SPIN 鈕,8 次無效互動後被死循環偵測中止)。
    // 這裡偵測「模型自己想做 tap/swipe」且畫面名(非 thinking)像是老虎機轉輪結果 → 放行讓它試,
    // 不用 stuckCount 覆寫;若真的連續試了也沒用,交由下面既有的死循環計數器(LOOP_ABORT_LIMIT)
    // 去判斷是不是真的卡死,而不是在這裡提前擋掉。
    // 2026-10-02 修正(二):原本連 thinking 也納入比對,而且用了過寬的單字「spin」—— 任何
    // 遊戲只要在 thinking 裡提到類似「10 Spins Completed(成就/任務文案)」就會誤中,把
    // 「活動彈窗卡死」誤判成「老虎機轉輪結果」,反而讓死循環保護被意外豁免、卡更久才被
    // 解析失敗計數器攔下(實測 job-muqz92nk-05pqac:卡在 EVENT 任務彈窗,因 thinking 提到
    // 「10 Spins Completed」被誤判豁免,拖到 VLM 連續解析失敗才中止,比正常死循環慢很多)。
    // 改成只看「畫面名」(模型對畫面的簡短分類標籤,比自由敘述穩定),且用更明確的複合詞,
    // 避免「spin」這種在成就/任務文案裡常見的單字誤觸。
    // 拉霸機的自動進行畫面(Free Spins / Bonus / 大獎動畫 / AutoSpin)也會長時間停在同一個畫面名,屬於正常玩法。
    const slotHint = /slot machine|slot game|轮盘|輪盤|spin\s*wheel|轉軸|转轴|老虎機|老虎机|jackpot|賭場|赌场|casino|free\s*spins?|免費遊戲|免费游戏|免費旋轉|免费旋转|autospin|auto\s*spin|big\s*win|mega\s*win|super\s*win/i;
    const looksSlotSpin = (cmd.action === 'tap' || cmd.action === 'swipe') &&
      slotHint.test(String(cmd.screen || ''));

    // (B) 硬上限:脫困(含等待)累計超過 STUCK_ABORT_STEPS 步畫面仍完全沒變 → 判定卡死結束。
    // 這個判斷不受 looksSlotSpin 影響 —— 即使放行模型自己點 SPIN,若真的連續 30 步畫面
    // 都沒變(模型可能瞄不準 SPIN 鈕位置),仍要有硬性中止,不能無上限空轉。
    const STUCK_ABORT_STEPS = 30;
    // 中止前先嘗試「重啟 App」(最多 3 次):很多卡死(載入回調、空白大廳)重開就好。
    if (stuckCount >= STUCK_ABORT_STEPS && effectivePkg && appRestarts < 3) {
      appRestarts++;
      console.log(`[recover] 畫面 ${stuckCount} 步無變化,重啟 App(第 ${appRestarts} 次)`);
      try { await client.restartApp(effectivePkg); await sleep(8000); } catch (e) { console.warn('[recover] 重啟失敗', e?.message || e); }
      stuckCount = 0; lastPhash = null; loadingStreak = 0;
      cmd.action = 'wait'; cmd.duration = 1; cmd.x = undefined; cmd.y = undefined;
      cmd.thinking = `[runner 重啟 App] 畫面長時間無變化,已重新開啟遊戲(第 ${appRestarts} 次)。` + String(cmd.thinking || '');
      cmd.override = 'app_restart';
      escapeOverride = true;
      controlNote = '【系統】遊戲剛被重新啟動,請從第一個畫面重新依知識庫流程進入。';
    }
    if (stuckCount >= STUCK_ABORT_STEPS) {
      finalState = 'error';
      finalMsg = looksLoading
        ? `畫面連續 ${stuckCount} 步無變化且停在安裝/載入畫面 —— 可能 APK 安裝或首次啟動失敗/逾時(此 APK 可能過大或需額外下載資源)。已中止,避免空轉。`
        : `畫面連續 ${stuckCount} 步無變化,各種脫困嘗試均無效 —— 可能當機/卡死或需人工介入。已中止,避免空轉。`;
      await writeStatus('error', finalMsg, steps.length);
      break;
    }

    // AI 高信心要點擊且畫面不是載入中:耐心期內放行 AI 自己換位置嘗試(prompt 已提示換座標),
    // 不用「先等待」蓋掉;耐心期過後仍無變化才進入 runner 脫困輪換。
    // 2026-10-04:不再要求高信心才放行——實測大廳機台列表空白時,AI 想點分類/展開鈕卻被
    // 「先等待」連續蓋掉 20 步。非載入畫面一律讓 AI 自己換位置嘗試,耐心期過後才進 runner 脫困輪換。
    const letAiTry = !looksLoading && cmd.action !== 'wait' && stuckCount < 20;
    if (stuckCount >= 3 && !looksSlotSpin && !letAiTry && !operatorDirected) {
      // (A) 安裝/載入階段:給長耐心 —— 前 STUCK_WAIT_STEPS 輪一律 wait(每輪 sleep 已 3s,
      //     配合此處額外 wait 動作,等於給數十秒到 1-2 分鐘讓安裝/載入完成),不亂點。
      const STUCK_WAIT_STEPS = 20; // 卡住的前 20 輪(約 60-100s)只等待,不亂點

      if (looksLoading || stuckCount < STUCK_WAIT_STEPS) {
        // 載入中或仍在耐心期:等待,不亂點。
        cmd.action = 'wait'; cmd.x = undefined; cmd.y = undefined; cmd.duration = 4;
        cmd.thinking = looksLoading
          ? `偵測到安裝/載入畫面(第 ${stuckCount + 1} 次未變),耐心等待安裝/載入完成`
          : `連續 ${stuckCount} 步畫面沒變,先等待(可能仍在載入)`;
        cmd.override = 'stuck_wait';
        escapeOverride = true;
      } else {
        // 耐心期過後仍未變 → 才進入主動脫困輪換(中下段掃描 + back + 右上角)。
        const yBand = [0.70, 0.78, 0.64, 0.86, 0.57];
        const mode = (stuckCount - STUCK_WAIT_STEPS) % (yBand.length + 2);
        cmd.override = 'stuck_escape';
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
    // 【操作行為把關】測試腳本指定了操作方式時,不在允許清單的手勢(例:拉霸機卻要 move 搖桿、
    // 沒勾多點觸控卻要 combo/pinch)不送裝置,改為短暫等待並在下一回合明確告知 AI 可用動作,
    // 避免用錯操作方式撞牆空轉。runner 自己的脫困/載入覆寫不受限。
    // 測試人員親手點/拖的手勢不受限(人看著畫面下的指示,遊戲操作方式沒列 swipe 也照做)。
    if (allowedActions && !escapeOverride && !cmd.operatorTap && !allowedActions.has(cmd.action)) {
      const bad = cmd.action;
      cmd.action = 'wait'; cmd.duration = 1;
      cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.tx = undefined; cmd.ty = undefined;
      cmd.thinking = `[操作方式限制] 「${bad}」不在本遊戲的操作方式內,未執行。` + String(cmd.thinking || '');
      cmd.override = 'control_violation';
      controlNote = `【操作方式提醒】上一步你用了「${bad}」,但本遊戲的操作方式只允許:${controls.allowedActions.join(' / ')}。請改用允許的動作(依系統提示的操作方式說明)。`;
    }

    // 【測項為主】任何「done」都要經視覺 Agent 確認:還沒確認全部完成就想結束 → 當成完成宣告,停手再看一張畫面。
    // (例如決策 Agent 自認做完了,或視覺 Agent 給 done 卻沒填 scriptDone。)
    if (scriptTracker && cmd.action === 'done' && !scriptEvent?.complete && !scriptEvent?.confirm && trace?.ok !== false && !operatorDirected && !wrapUpAsked && !spinLoopPending()) {
      const ev = scriptTracker.observe(scriptTracker.total, typeof cmd.scriptEvidence === 'string' ? cmd.scriptEvidence : '');
      scriptEvent = { ...(scriptEvent ?? {}), ...ev };
      team?.setScriptStep(scriptTracker.current);
      updateScriptProgress(team);
    }
    if (scriptEvent?.complete) {
      cmd.action = 'done';
      cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.tx = undefined; cmd.ty = undefined;
      cmd.thinking = `[測項全部完成] 視覺 Agent 兩次確認 ${scriptTracker.total} 項測項都已達成(${scriptTracker.evidence || '見畫面'}),結束測試。` + String(cmd.thinking || '');
      cmd.override = 'script_complete';
    } else if (scriptEvent?.confirm) {
      cmd.action = 'wait'; cmd.duration = 1;
      cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.tx = undefined; cmd.ty = undefined;
      cmd.thinking = `[測項確認] 回報 ${scriptTracker.total} 項全部完成(${scriptTracker.evidence || '—'}),停手再看一張畫面確認。` + String(cmd.thinking || '');
      cmd.override = 'script_confirm';
    }

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

    // 視覺模型漏給 screen 時先從 seen 推畫面名;都沒有才用「畫面 N」佔位(記憶地圖不收佔位名)。
    if (!cmd.screen && typeof cmd.seen === 'string') {
      const guess = screenFromSeen(cmd.seen);
      if (guess) cmd.screen = guess;
    }
    const screenName = cmd.screen || `畫面 ${i}`;

    // 落點標記圖:tap/swipe 時在點擊座標畫紅十字+圓圈+座標,存 annotated/<i>.png(前端顯示 AI 點在哪)。
    // 這張圖只給人看,不影響判斷,而 ImageMagick 要跑約 1.2 秒 → 先只決定 key,圖在背景產生並上傳
    // (見迴圈後半的 annotatePending);真的失敗時會把 step 的 annotatedKey 收回,前端就退回原始截圖。
    const annotateSwipeTo = cmd.action === 'swipe' && Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2)
      ? { x: Math.round(cmd.x2), y: Math.round(cmd.y2) } : undefined;
    const wantAnnotate = Boolean(MAGICK && (cmd.action === 'tap' || cmd.action === 'swipe') && cmd.x != null && cmd.y != null);
    const annotatedKey = wantAnnotate ? `${PREFIX}/annotated/${i}.png` : undefined;

    const perf = perfPending ? await perfPending : null;
    perfPending = null;
    // 進度筆記:有新的就更新(解析失敗的回應不覆蓋舊筆記)。
    if (!cmd.parseFailed && typeof cmd.memo === 'string' && cmd.memo.trim()) progressMemo = cmd.memo.trim().slice(0, 400);
    const step = { index: i, action: cmd.action, screen: screenName, thinking: cmd.thinking,
      ...(progressMemo ? { memo: progressMemo } : {}),
      // x/y 為「縮圖空間」座標(與標記圖一致);deviceXY 為實際送裝置的截圖像素座標,供除錯比對。
      ...(cmd.x != null ? { x: cmd.x, y: cmd.y, deviceX: toDeviceX(cmd.x), deviceY: toDeviceY(cmd.y) } : {}),
      // move 動作額外記 dir/holdMs(除錯用:之前排查 move 不生效時,step json 完全沒存方向與
      // 按住時長,只能從 x,y 猜搖桿中心,猜不出實際終點座標與持續時間,拖慢了排查速度)。
      ...(cmd.action === 'move' ? { dir: cmd.dir ?? cmd.direction ?? null, holdMs: cmd.holdMs ?? null, x2: cmd.x2 ?? null, y2: cmd.y2 ?? null } : {}),
      // 多點觸控/長按手勢參數(除錯與報告用)。
      ...(cmd.action === 'hold' ? { holdMs: cmd.holdMs ?? null } : {}),
      ...(cmd.action === 'combo' ? { dir: cmd.dir ?? null, holdMs: cmd.holdMs ?? null, tx: cmd.tx ?? null, ty: cmd.ty ?? null, taps: cmd.taps ?? null } : {}),
      ...(cmd.action === 'pinch' ? { scale: cmd.scale ?? null } : {}),
      ...(cmd.action === 'swipe' && Number.isFinite(cmd.durationMs) ? { swipeMs: cmd.durationMs } : {}),
      // swipe 終點(縮圖空間 + 裝置像素)—— 之前只記起點,看不出 AI/測試人員往哪拖。
      ...(cmd.action === 'swipe' && Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2)
        ? { x2: cmd.x2, y2: cmd.y2, deviceX2: toDeviceX(cmd.x2), deviceY2: toDeviceY(cmd.y2) } : {}),
      ...(cmd.operatorTap ? { operatorGesture: cmd.operatorDrag ? 'drag' : 'tap' } : {}),
      ...(snappedFrom ? { snappedFrom } : {}),
      ...(cmd.x != null ? { space: { shot: [cw, ch], device: [origW, origH] } } : {}),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotatedKey ? { annotatedKey } : {}),
      durationMs: Date.now() - t0, ...(usage ? { tokens: usage } : {}),
      // 各段耗時(ms):shot 取圖、phash 指紋、resize 縮圖、winSize 問尺寸、fg 前景檢查、
      // annotate 落點標記、act 送動作、prefetch 預抓下一張。用來找真正的瓶頸。
      timing: tm,
      // ── 證據(報告引擎據此以程式計算指標;AI 只觀察與標註)──
      at: new Date(t0).toISOString(),
      vlmMs,
      // 本步截圖相對上一步是否有可見變化 = 「上一步動作是否生效」(pHash,確定性)。
      ...(i > 0 && curPhash ? { screenChanged } : {}),
      ...evidenceFields(cmd, aiAction),
      ...(cmd.override ? { override: cmd.override } : {}),
      ...(cmd.parseFailed ? { parseFailed: true } : {}),
      ...(trace && trace.ok === false ? { modelError: true } : {}),
      ...(foregroundLost ? { foregroundLost: true, ...(appState !== undefined ? { appState } : {}) } : {}),
      ...(perf ? { perf } : {}),
      ...(newCmds.length && !cmd.parseFailed ? { operatorCommands: newCmds.map((c) => ({ id: c.id, text: c.text })) } : {}),
      // 上一步之後、這張截圖之前,測試人員直接在裝置上做的點擊/拖曳(不經 AI)。
      ...(directOps.length ? { operatorDirect: directOps } : {}) };
    directOps = [];
    // 決策 Agent 給這一步的目標(執行軌跡顯示「🎯 目標」;報告與除錯用)。
    const usedPlan = stepPlans.get(i);
    if (cmd.decidedBy) step.decidedBy = cmd.decidedBy;
    if (cmd.reflex) { step.decidedBy = 'reflex'; step.reflex = cmd.reflex; }
    if (cmd.visionSuggested) step.visionSuggested = cmd.visionSuggested;
    if (decisionMs !== undefined) step.decisionMs = decisionMs;
    if (usedPlan) {
      step.plan = {
        goal: usedPlan.goal,
        ...(usedPlan.expect ? { expect: usedPlan.expect } : {}),
        scriptStep: usedPlan.scriptStep,
        ...(team?.scriptTotal ? { scriptTotal: team.scriptTotal } : {}),
        ...(usedPlan.strategy ? { strategy: usedPlan.strategy } : {}),
        ...(usedPlan.suggestFail ? { suggestFail: true, reason: usedPlan.reason } : {}),
      };
    }
    if (maxSegments !== 1) step.segment = segment;
    // 數值把關:疑似讀錯的值不交給輔助 Agent;投注額變更 → 警告並提醒 AI(每筆都記步驟與前後值)。
    const guard = obsGuard.check(i, step.obs);
    const guardedObs = guard.clean;
    if (guard.warnings.length) step.warnings = guard.warnings;
    for (const wv of guard.warnings) {
      if (wv.kind === 'bet_changed') {
        controlNote += `【數據警告】投注額(${wv.key})從 ${wv.from} 變成 ${wv.to}(第 ${wv.sinceStep} 步起)。如果測試腳本要求固定投注額,請先把投注額調回 ${wv.from} 再繼續。`;
      }
    }
    steps.push(step);
    // 落點標記:背景產生 + 上傳(不佔決策時間)。產圖失敗就把 annotatedKey 收回並重寫步驟 JSON,
    // 否則前端會指到一個不存在的物件(顯示破圖)。
    if (wantAnnotate && annotatedKey) {
      const tAnn = Date.now();
      const stepKey = `${PREFIX}/steps/${i}.json`;
      trackBg(
        annotateTapAsync(ds.b64, Math.round(cmd.x), Math.round(cmd.y), cmd.operatorDrag ? 'drag' : cmd.action, ssDim, annotateSwipeTo)
          .then((annB64) => {
            tm.annotateBg = Date.now() - tAnn;
            if (annB64) return s3put(annotatedKey, Buffer.from(annB64, 'base64'), 'image/png');
            delete step.annotatedKey;
            console.warn(`[annotate] 第 ${i} 步產生落點標記圖失敗,前端改用原始截圖`);
            return s3putBg(stepKey, JSON.stringify(step), 'application/json');
          })
          .catch(() => {}),
      );
    }
    // 盤面擷取區間由結構化觀測/畫面狀態驅動,不是等 VLM 回 wait 才開始。用本步起始時間回填,
    // 讓稍晚拉回的 screenrecord 分段仍能按影格時間判斷是否屬於 AutoSpin / Free Spin。
    if (slotCapture) {
      const slotStateText = `${screenName} ${String(cmd.thinking || '')}`;
      const hasAutoCounter = Number.isFinite(Number(cmd.obs?.autospin_left));
      const freeMode = cmd.obs?.bonus === true || /Free\s*Spin\s*進行中|免費遊戲(?:畫面|進行中)|免费游戏(?:画面|进行中)/i.test(slotStateText);
      const spinningMode = hasAutoCounter || freeMode || /AutoSpin\s*進行中|Auto\s*Spin\s*(?:running|active)/i.test(slotStateText);
      const stopMode = /AutoSpin.{0,12}(?:已停|停止|結束|结束)|SPIN.{0,12}HOLD\s*FOR\s*AUTOSPIN/i.test(slotStateText);
      const outsideMachine = /PAYTABLE|GAME\s*INFO|RULES|大廳|大厅|登入|登录|載入|载入|首儲|首储/i.test(screenName);
      if (spinningMode) slotCapture.setActive(true, `#${i} ${screenName}`, t0, freeMode ? 'free' : 'paid');
      else if (stopMode || outsideMachine || cmd.action === 'done') slotCapture.setActive(false, `#${i} ${screenName}`, t0);
    }
    s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
    // 指令回執:AI 這一步怎麼回應(聊天室顯示)。回應無法解析 → 不算已處理,留到下一步再送。
    if (cmd.parseFailed && newCmds.length) pendingCmds = newCmds;
    // 這一步本身就是測試人員的手勢(不經 AI):回執標成「直接執行」並附裝置座標,
    // 下一回合告訴 Agent 人點在哪(它自己的座標 + 裝置像素)。
    const stepDirect = cmd.operatorTap && cmd.x != null
      ? {
        kind: cmd.operatorDrag ? 'drag' : 'tap',
        shot: { x: cmd.x, y: cmd.y, ...(cmd.operatorDrag ? { x2: cmd.x2, y2: cmd.y2 } : {}) },
        device: { x: toDeviceX(cmd.x), y: toDeviceY(cmd.y), ...(cmd.operatorDrag ? { x2: toDeviceX(cmd.x2), y2: toDeviceY(cmd.y2) } : {}) },
        space: { shot: [cw, ch], device: [origW, origH] },
        ...(pointCmd && pointCmd.text !== POINT_ONLY_TEXT && pointCmd.text !== DRAG_ONLY_TEXT ? { said: pointCmd.text } : {}),
      }
      : null;
    if (stepDirect) controlNote += operatorDirectNote(stepDirect, normCoord);
    for (const c of cmd.parseFailed ? [] : newCmds) {
      const isGesture = stepDirect && pointCmd && c.id === pointCmd.id;
      await operator.ack(c, {
        status: 'applied', step: i, action: cmd.action, screen: screenName,
        ...(isGesture ? { direct: true, device: stepDirect.device } : {}),
        reply: isGesture
          ? (stepDirect.kind === 'drag'
            ? `已直接在裝置上拖曳:(${stepDirect.device.x}, ${stepDirect.device.y}) → (${stepDirect.device.x2}, ${stepDirect.device.y2}),並把座標告知控制遊戲 Agent。`
            : `已直接在裝置上點擊 (${stepDirect.device.x}, ${stepDirect.device.y}),並把座標告知控制遊戲 Agent。`)
          : String(cmd.thinking || '').slice(0, 400),
      });
    }

    // 增量記憶地圖:建/更新當前畫面節點 + 從上一畫面的轉移邊,即時寫回供前端重繪。
    // 畫面身分用「視覺指紋 + 正規化名稱 + 模組」判斷(見 memoryGraph.mjs),AI 換說法不會長出重複節點。
    const { pageId: pid, isNew } = upsertPage(struct, { name: screenName, pHash: curPhash, module: cmd.module });
    if (isNew) s3putBg(`${MEM_PREFIX}/screenshots/${pid}.png`, Buffer.from(shot, 'base64'), 'image/png');
    // 記憶命中(必須在 recordTransition 之前:那之後本步的轉場已算進次數,分不出是不是舊記憶)。
    const memHit = memTrace.onStep({
      pageId: pid, screenName, prevPageId, navAction, prevTarget, screenChanged,
      injectedHints: scoped, action: cmd.action, target: typeof cmd.target === 'string' ? cmd.target : '', override: cmd.override,
    });
    step.memory = memHit;
    console.log(memTrace.formatLog(i, memHit));
    s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
    if (prevPageId && pid) {
      // 畫面真的換了才建邊(觸發 = 上一步實際執行的動作 + 目標元件);同畫面且無變化 = 該操作失效一次。
      // navOp = 上一步實際執行的操作細節(相對座標),一起記下來,下次就能照記憶重播。
      if (prevPageId !== pid) recordTransition(struct, prevPageId, pid, { action: navAction, target: prevTarget, op: navOp });
      else if (!screenChanged) recordMiss(struct, pid, { action: navAction, target: prevTarget });
      // 同一畫面、畫面有變(例如按 SPIN 轉輪):記成這個畫面上的操作(SPIN 迴圈靠它)。
      else if (navOp) recordSelfOp(struct, pid, { action: navAction, target: prevTarget, op: navOp });
    }
    // 記憶地圖:只有真的變了才上傳(原本每步整份重傳 48KB,21 步共約 1MB 全是白做的)。
    struct.lastUpdatedAt = new Date().toISOString();
    {
      const sj = JSON.stringify(struct);
      // lastUpdatedAt 每步都不同,比較時拿掉它才看得出內容有沒有變。
      const fingerprint = sj.replace(/"lastUpdatedAt":"[^"]*"/, '');
      if (fingerprint !== lastStructFingerprint) {
        lastStructFingerprint = fingerprint;
        s3putBg(`${MEM_PREFIX}/structure.json`, sj, 'application/json');
      }
    }

    await writeStatus('running', `${segment > 1 ? `第 ${segment} 段 · ` : ''}第 ${i + 1} 步:${cmd.action} @ ${screenName}`, steps.length);
    if (wrapUpAsked) {
      finalState = 'fail';
      finalMsg = wrapReason === 'deadline'
        ? `已達這次任務設定的最長執行時數(${DEADLINE_LABEL}),已提前收尾並寫出報告,測試腳本尚未完成。最後畫面:${String(cmd.thinking || '').slice(0, 300)}`
        : `已達執行時間上限:Device Farm 單次連線最長 150 分鐘,已在第 ${WRAP_MIN} 分鐘提前收尾${segment > 1 ? `(共 ${segment} 段)` : ''},測試腳本尚未完成。最後畫面:${String(cmd.thinking || '').slice(0, 300)}`;
      break;
    }

    // App 死循環偵測:累計每個「畫面名」出現次數;超過門檻代表卡在同一處(常見:登入失敗彈窗
    // 反覆跳,此裝置無對應第三方登入環境)。提早收斂為 fail 並在訊息點出原因,不空轉到步數上限。
    // 2026-10-02 修正:原本不分動作一律計數,導致「載入畫面持續 wait 耐心等待」(正常行為,
    // stuckCount 機制本該給到 STUCK_ABORT_STEPS=30 步耐心)在第 8 次就被這裡誤判成死循環
    // 提早判 fail,比耐心機制還早觸發。改成只有「主動互動動作」(tap/swipe/move/type/back)
    // 重複才算死循環,純粹等待載入(wait)不計入——真正的死循環一定是「做了動作畫面還是沒變」,
    // 不會是「單純等待」。
    const screenNameLower = String(screenName || '').toLowerCase();
    const loopLoadingHint = /loading|載入|载入|請稍候|请稍候|connecting|連線中|连接中|進場|进场/i;
    // 2026-10-02 修正:老虎機類遊戲每輪 SPIN 後畫面名稱常常一樣(都是同一台機台的「轉輪
    // 結果」畫面),這是正常重複玩法(連續多輪 SPIN 本就該停在同畫面名),不是卡死 —— 不該
    // 計入死循環次數,否則玩滿 8 輪 SPIN 就會被誤判成「App 死循環」提早中止整個任務。
    const screenLoopExempt = loopLoadingHint.test(screenNameLower) || slotHint.test(screenNameLower);
    // 2026-10-17(job-mvc3jedr / job-mvc3knmo):畫面名豁免清單是字串比對,補不完 —— 清單裡有
    // 「轉軸」但沒有「拉霸」,於是「拉霸轉軸畫面」被豁免、「拉霸結果畫面」沒有,正常玩拉霸
    // 每局停在結果畫面,連點 8 次 SPIN 就被判死循環、重啟、再 8 次就判失敗(50 局只跑到 18 局)。
    // 比字串可靠的判準:同一個畫面名重複出現,但畫面上的數值(餘額/贏分/下注)在變,就代表
    // 遊戲確實在回應,不是卡死。真正的死循環一定是「做了動作,畫面與數值都沒有任何變化」。
    const obsSig = numericObsSig(cmd.obs);
    const prevObsSig = screenObsSig.get(screenName);
    const obsMoved = Boolean(obsSig) && Boolean(prevObsSig) && obsSig !== prevObsSig;
    if (obsSig) screenObsSig.set(screenName, obsSig);
    // done 不是對畫面的操作:被駁回的 done(例如 AutoSpin 中想提早結束)不能算「操作了沒反應」。
    // 實測 job-mv1oqkmk:Free Spins 畫面 8 次被駁回的 done 被當成死循環 → 重啟遊戲 → 離開機台、累計局數全丟。
    // SPIN 迴圈每局都停在同一個畫面,是預期行為,不算死循環。
    const countsForLoop = cmd.action !== 'wait' && cmd.action !== 'done' && !screenLoopExempt
      && cmd.reflex?.kind !== 'spin' && !obsMoved;
    // 數值有變 = 這個畫面有進展,先前累積的「操作沒反應」次數不該留著算帳。
    if (obsMoved && (screenSeen.get(screenName) || 0) > 0) screenSeen.set(screenName, 0);
    const seen = countsForLoop ? (screenSeen.get(screenName) || 0) + 1 : (screenSeen.get(screenName) || 0);
    if (countsForLoop) screenSeen.set(screenName, seen);
    // 2026-10-05(job-muv712gs-pvg7ow):NEWBIE MISSION 彈窗在動畫還沒播完時被點了寶箱,之後整個
    // 彈窗不再接受任何輸入(按鈕/back/滑動都沒反應,動畫照跑)——遊戲端卡住,不是 AI 點錯
    // (同一按鈕在其他 8 次任務都點得動)。先重啟遊戲再試一次,同一畫面第二次卡住才判失敗。
    if (countsForLoop && seen >= LOOP_ABORT_LIMIT && effectivePkg && appRestarts < 3 && !loopRestarted.has(screenName) && !operatorDirected) {
      loopRestarted.add(screenName);
      appRestarts++;
      screenSeen.delete(screenName);
      stuckCount = 0;
      console.log(`[recover] 畫面「${screenName}」操作 ${seen} 次沒有進展,重啟 App(第 ${appRestarts} 次)`);
      try { await client.restartApp(effectivePkg); await sleep(8000); } catch (e) { console.warn('[recover] 重啟失敗', e?.message || e); }
      step.override = 'app_restart';
      step.thinking = `[runner 重啟 App] 畫面「${screenName}」操作 ${seen} 次都沒有反應(遊戲可能卡住),已重新啟動遊戲。` + String(step.thinking || '');
      s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
      controlNote = `【系統】畫面「${screenName}」操作 ${seen} 次都沒有反應(遊戲可能卡住),已重新啟動遊戲。請從第一個畫面重新進入;再遇到這個畫面時,先等它的動畫播完、主要按鈕出現後再點主要按鈕。`;
      prevAction = 'launch';
      await sleep(1000);
      continue;
    }
    if (countsForLoop && seen >= LOOP_ABORT_LIMIT) {
      finalState = 'fail';
      // 只有畫面名稱本身像登入頁才提示登入問題;否則一律中性描述(先前寫死「第三方登入」,
      // 讓與登入無關的任務也被報告歸因成登入失敗)。
      const loginScreen = /登入|登录|login|sign\s*in|facebook|google/i.test(String(screenName || ''));
      finalMsg = `偵測到 App 死循環:畫面「${screenName}」反覆出現 ${seen} 次仍無法前進` +
        (loginScreen ? ',可能此裝置環境無法完成登入(如第三方登入服務不可用)。' : ',可能是遊戲卡住、AI 找不到下一步或操作沒有效果。') +
        '已提早結束以節省時間與成本。';
      break;
    }

    // 連續 wait 次數上限:純等待不計入上面的死循環計數,但也不能無上限空等——
    // 若真的卡在載入/配置下載失敗,須有一個與畫面名稱都無關的獨立硬停止點。
    // 2026-10-02 修正:原本只看「動作是不是 wait」,完全不管畫面有沒有實際變化,導致
    // 老虎機 AUTOSPIN 這種「畫面持續在變(累積次數/餘額/畫面名稱都在跳動),玩家只需要
    // 持續觀察等待」的正常情境被誤殺(實測 job-muqxaa0z-m4hbrl:AUTOSPIN 已經正確跑了
    // 127 輪,餘額從 1,573,680 漲到 1,742,678,中間還觸發 JACKPOT,卻在第 70 步因為連續
    // 40 次 wait 被判定「可能載入逾時」中止——但畫面明明一直在變,不是卡死)。
    // 改成只有在「畫面真的沒變化」(stuckCount 同步在累積,即 pHash 判定卡住)時才計入
    // 這個上限;若畫面持續變動(如 AUTOSPIN 跑動畫),純等待不設上限,真正的卡死由
    // stuckCount 自己的 STUCK_ABORT_STEPS(30 步)去把關。
    consecWaitCount = (cmd.action === 'wait' && stuckCount > 0) ? consecWaitCount + 1 : 0;
    if (consecWaitCount >= WAIT_ABORT_LIMIT) {
      finalState = 'error';
      finalMsg = `連續 wait ${consecWaitCount} 次且畫面無變化,仍停在「${screenName}」—— 可能載入/配置下載逾時或失敗,此裝置環境無法完成該步驟。已中止,避免空轉。`;
      await writeStatus('error', finalMsg, steps.length);
      break;
    }

    // 【測項時間盒】小測項有操作次數上限(預設 20 次;wait 不算)。超過 → 判 Blocked 並指出卡在哪一項,
    // 不再無止盡地繞(job-mv95w48j:第 4 項早就達成,卻又玩了 2 小時)。測試人員正在指揮時不計。
    if (scriptTracker && !operatorDirected && !cmd.reflex && cmd.action !== 'wait' && cmd.action !== 'done') {
      const blocked = scriptTracker.tick();
      if (blocked) {
        finalState = 'fail';
        finalMsg = `測項卡住(Blocked):第 ${blocked.item}/${scriptTracker.total} 項「${String(blocked.text).slice(0, 120)}」已操作 ${blocked.steps} 次仍未完成,已停止(每項上限 ${blocked.budget} 次)。` +
          `已完成 ${scriptTracker.done}/${scriptTracker.total} 項。最後畫面「${screenName}」:${String(cmd.thinking || '').slice(0, 200)}`;
        console.log(`[測項為主] ${finalMsg}`);
        break;
      }
    }

    // 偵測第5關證據(畫面或 thinking 出現 stage/wave/level 5 或 第5關/5. Zone)。
    const lvl5Hint = /stage\s*5|wave\s*5|level\s*5|lv\.?\s*5|第\s*5\s*[關关波]|\b5\.\s|5\s*[關关波]/i;
    if (lvl5Hint.test(String(cmd.thinking || '')) || lvl5Hint.test(String(cmd.screen || ''))) seenLevel5 = true;
    // 【拒絕假完成】agent 下 done,但這是割草通關任務(TASK 含 5/第五/level/stage/survivor 等),
    // 且從未看到第5關證據 → 這多半是「載入中/過場誤判完成」。runner 攔截,改成 wait 逼它繼續,不讓假 pass 收尾。
    // 模型呼叫失敗時 decide() 回 done:這是 AI 測試代理失敗,不是「完成」,不可判 pass。
    if (cmd.action === 'done' && trace && trace.ok === false) {
      finalState = 'error';
      finalMsg = String(cmd.thinking || '模型呼叫失敗');
      break;
    }
    // 【決策 Agent 不能單方面結束】done 由決策 Agent 給出、但看著畫面的視覺 Agent 判斷還要繼續
    // (例如 AutoSpin 還在跑)→ 以視覺 Agent 為準,不結束。實測 job-mv1nkax6:500 局只跑了約 27 局,
    // 決策 Agent 自認「腳本最後一步」就下 done,視覺 Agent 當時是 wait。
    // 上限 60 次:避免視覺 Agent 一直誤判「還要繼續」時永遠結束不了(步數 / 預算 / 時數上限仍然有效)。
    // 測項為主:使用者有明確測項、且已走到最後一項並宣告 done → 不讓視覺 Agent 推翻,
    // 直接進入下方的「權威完成」判定(否則弱視覺模型如 Nova 會一直要求繼續 tap,測不完)。
    // 測項為主:以視覺 Agent 兩次確認的進度為準(scriptTracker);沒有 tracker 才看決策 Agent 的 scriptStep。
    const scriptAllDone = scriptTracker
      ? scriptTracker.total >= 1 && scriptTracker.done >= scriptTracker.total
      : scripted && team && team.scriptTotal >= 1 && team.scriptStep >= team.scriptTotal;
    if (cmd.action === 'done' && cmd.decidedBy === 'agent' && cmd.visionSuggested && cmd.visionSuggested !== 'done' && agentDoneOverrides < 60 && !scriptAllDone) {
      agentDoneOverrides++;
      let back = cmd.visionSuggested;
      // done 本身沒有座標;若視覺建議的是需要座標的動作(tap/swipe/hold/combo)卻沒有座標,
      // 改成 wait,避免送出「沒有位置的點擊」被 Appium 擋下(連續失敗 3 次會直接判 error)。
      const needsXY = back === 'tap' || back === 'swipe' || back === 'hold' || back === 'combo';
      if (needsXY && !(Number.isFinite(cmd.x) && Number.isFinite(cmd.y))) back = 'wait';
      cmd.action = back;
      if (back === 'wait') { cmd.duration = 2; cmd.x = undefined; cmd.y = undefined; }
      cmd.thinking = `[拒絕假完成] 決策 Agent 想結束,但看畫面的視覺 Agent 判斷還要繼續(${back}),第 ${agentDoneOverrides} 次以視覺為準。` + String(cmd.thinking || '');
      cmd.override = 'reject_done';
      step.action = cmd.action; step.override = 'reject_done'; step.thinking = cmd.thinking; delete step.expect;
      controlNote = '【系統】你剛才想結束測試,但畫面顯示還在進行中。請依測試腳本的完成條件(例如次數、數值)確認真的達成後才 done。';
    }
    if (cmd.action === 'done') {
      // 只針對「要打到第 5 關」這類割草/存活目標;一般文字裡的 level(例如 LEVEL UP 彈窗)不算。
      const isSurvivorGoal = /survivor|倖存|割草|第.?[五5].?[關关波]|(stage|wave|level)\s*5\b/i.test(String(TASK || ''));
      if (isSurvivorGoal && !seenLevel5 && prematureDoneCount < 8) {
        prematureDoneCount++;
        cmd.action = everInBattle && (!allowedActions || allowedActions.has('move')) ? 'move' : 'wait';
        if (cmd.action === 'move') { cmd.dir = ['up','right','down','left'][prematureDoneCount % 4]; cmd.holdMs = 2200; }
        cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.duration = 4;
        cmd.thinking = `[拒絕假完成] agent 想 done 但尚未看到第5關證據(載入/過場不算完成),第 ${prematureDoneCount} 次攔截,改為 ${cmd.action} 繼續推進。` + String(cmd.thinking || '');
        cmd.override = 'reject_done';
        step.action = cmd.action; step.override = 'reject_done'; step.thinking = cmd.thinking; delete step.expect;
        stuckCount = 0;
      } else {
        // 【以測項為主】案例帶結構化測項(scripted)且已走到最後一項並宣告完成 → 權威完成:
        // 直接通過,不讓輔助 Agent(靠知識庫 / 弱模型)用錯誤理由或知識庫延伸項目逼測試繼續。
        // 這是客戶「我只叫它進畫面就結束」卻被硬測到玩 slot、最後誤判 FAIL 的根因修正。
        const reachedAllItems = scriptTracker
          ? scriptAllDone
          : team && team.scriptTotal >= 1 && team.scriptStep >= team.scriptTotal;
        const authoritativeDone = scripted && reachedAllItems;
        // 輔助 Agent 核對「完成」宣告:證據不足就退回繼續。
        // scripted(測項為主)時最多核對 1 次就放行,避免弱模型反覆否決;一般探索維持 3 次。
        // 測試人員指揮中、或已是權威完成時不再核對。核對失敗 / 無法核對 → 照舊結束。
        const vetoCap = scripted ? 1 : 3;
        const vd = team && !operatorDirected && !authoritativeDone && teamDoneRejects < vetoCap
          ? await team.verifyDone({ index: i, observation: { screen: cmd.screen, thinking: cmd.thinking, obs: cmd.obs } }).catch(() => null)
          : null;
        if (vd && vd.ok === false) {
          teamDoneRejects++;
          cmd.action = 'wait'; cmd.duration = 2;
          cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined;
          cmd.thinking = `[拒絕假完成] 輔助 Agent 核對未通過(第 ${teamDoneRejects} 次):${vd.missing || '腳本還沒全部完成'}。` + String(cmd.thinking || '');
          cmd.override = 'reject_done';
          step.action = 'wait'; step.override = 'reject_done'; step.thinking = cmd.thinking; step.doneCheck = vd; delete step.expect;
          controlNote = scripted
            ? `【提醒|測項為主】還差:${vd.missing || '腳本項目未完成'}。只需完成測試腳本列出的測項;知識庫僅供理解遊戲,不要延伸腳本以外的玩法(例如多餘的轉動 / 刷任務)。所有測項完成後即可 done。`
            : `【輔助 Agent 核對】你宣告測試完成,但還缺:${vd.missing || '腳本還沒全部完成'}。請繼續完成測試腳本,不要再提早 done。`;
          stuckCount = 0;
        } else if (spinLoopPending() && spinDoneRejects < SPIN_DONE_REJECT_CAP) {
          // 【局數是客觀事實】SPIN 迴圈還沒轉完就不可能「完成」,不管 AI 或輔助 Agent 怎麼說。
          // job-mvd3hil3:裝置卡在系統「Fully charged」全螢幕覆蓋層,遊戲從頭沒載入、一局都沒轉,
          // 卻因為輔助 Agent 核對放行而判了 pass(訊息還寫著「流程確定阻塞」)。
          spinDoneRejects++;
          cmd.action = 'wait'; cmd.duration = 2;
          cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined;
          cmd.thinking = `[拒絕假完成] 系統計數:只完成 ${rtpLoop.paid}/${rtpLoop.target} 局付費 SPIN,還沒達標(第 ${spinDoneRejects} 次攔截)。` + String(cmd.thinking || '');
          cmd.override = 'reject_done';
          step.action = 'wait'; step.override = 'reject_done'; step.thinking = cmd.thinking; delete step.expect;
          controlNote = `【系統計數】目前只完成 ${rtpLoop.paid}/${rtpLoop.target} 局付費 SPIN。局數由系統計數,不是你自己數的 —— 還沒達標就不能 done。回到拉霸主盤面讓系統繼續轉;若畫面真的被擋住無法進入遊戲,就說明被什麼擋住,不要宣告完成。`;
          stuckCount = 0;
        } else {
          if (vd) step.doneCheck = vd;
          // 攔了 SPIN_DONE_REJECT_CAP 次還是進不去:這是失敗,不是通過(以客觀局數為準)。
          if (spinLoopPending()) {
            finalState = 'fail';
            finalMsg = `只完成 ${rtpLoop.paid}/${rtpLoop.target} 局付費 SPIN 就無法繼續:${String(cmd.thinking || '').slice(0, 200)}`;
            console.log(`[SPIN 迴圈] ${finalMsg}`);
            break;
          }
          finalState = 'pass';
          finalMsg = cmd.thinking || (authoritativeDone ? '所有測項完成,任務結束' : '流程完成');
          if (authoritativeDone) {
            const n = scriptTracker ? `${scriptTracker.done}/${scriptTracker.total}` : `${team?.scriptStep}/${team?.scriptTotal}`;
            console.log(`[測項為主] 已走完所有測項(${n})且宣告完成 → 直接通過,不經輔助 Agent 推翻。`);
          }
          break;
        }
      }
    }

    // 【割草戰鬥強制走位】割草類遊戲:進入戰鬥後角色必須「持續移動走位」才能存活,
    // 但 VLM/agent 常回退用 tap(站著不動→被包圍→Fail)。這裡在 runner 層強制:
    // 偵測「戰鬥畫面」(thinking/screen 提到存活倒數、波次、關卡、Comfort Zone、Stage/Wave,
    // 或畫面名含戰鬥字樣),且 agent 下的是 tap/swipe/wait(非升級選技能彈窗)→ 改寫成一個輪換方向的 move。
    // 升級/選技能/結算彈窗(Select Skill / Level Up / Fail / Win / Confirm / Tap to Continue)則放行 tap。
    const battleHint = /存活|倒數|倒计时|波次|wave|stage|comfort zone|關卡|关卡|敵人|敌人|survive|survival|遛怪|走位|hp|血條|血条/i;
    const popupHint = /select\s*skill|選.{0,3}技能|选.{0,3}技能|level\s*up|升級|升级|fail|win|clear|confirm|確認|确认|continue|繼續|继续|tap to|結算|结算|寶箱|宝箱|revive|新功能|new feature|growth/i;
    const inBattle = battleHint.test(String(cmd.thinking || '')) || battleHint.test(String(cmd.screen || ''));
    if (inBattle) everInBattle = true;
    const isPopup = popupHint.test(String(cmd.thinking || '')) || popupHint.test(String(cmd.screen || ''));
    // 測試腳本指定了操作方式時,只有「下方中央搖桿」(割草類)才啟用強制走位;
    // 其他類型(如左搖桿+技能、賽車)不可把 tap 改寫成 move,否則會破壞技能/轉向操作。
    const battleMoveEnabled = !controls || controls.battleMove;
    if (battleMoveEnabled && inBattle && !isPopup && !operatorDirected && (cmd.action === 'tap' || cmd.action === 'swipe' || cmd.action === 'wait')) {
      const dirs = ['up', 'right', 'down', 'left', 'upright', 'downleft', 'upleft', 'downright'];
      const forcedDir = dirs[battleMoveTick % dirs.length];
      battleMoveTick++;
      cmd.action = 'move'; cmd.dir = forcedDir; cmd.holdMs = 2200;
      cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined;
      cmd.thinking = `[戰鬥強制走位] 偵測到戰鬥畫面,角色必須持續移動躲怪。原動作(${cmd.action})改為 move dir=${forcedDir} 走位。` + String(cmd.thinking || '');
      cmd.override = 'battle_move';
      step.action = 'move'; step.dir = forcedDir; step.holdMs = 2200; step.override = 'battle_move'; step.thinking = cmd.thinking; delete step.expect;
      // 戰鬥中畫面背景持續變動,stuck-detection 不應介入;重置 stuckCount 避免誤判。
      stuckCount = 0;
    }

    // 【走位被擋改向】上一步往某方向推搖桿但背景沒動(被障礙物擋住),AI 這步又往同一方向 → 改向繞開。
    // 測試人員正在指揮時不覆寫。
    if (blockedDir && !operatorDirected && cmd.action === 'move' && normDir(cmd.dir ?? cmd.direction) === blockedDir && !Number.isFinite(cmd.x2)) {
      const alt = turnDir(blockedDir, blockedStreak);
      cmd.dir = alt; delete cmd.direction;
      cmd.thinking = `[走位被擋改向] 上一步往 ${blockedDir} 背景沒有移動(被障礙物擋住),改往 ${alt}。` + String(cmd.thinking || '');
      cmd.override = 'blocked_move';
      step.dir = alt; step.blockedFrom = blockedDir; step.override = 'blocked_move'; step.thinking = cmd.thinking; delete step.expect;
    } else if (blockedDir) {
      step.blockedFrom = blockedDir;
    }

    lastBattleMove = battleAutoEnabled && inBattle && !isPopup && cmd.action === 'move';
    popupLastStep = isPopup;
    if (autopilot) { step.autopilotMs = AUTOPILOT_MS; }

    // runner 在 step 落地後才改寫動作(拒絕假完成/戰鬥強制走位/走位被擋)時,重寫 step json 讓證據與實際執行一致。
    if (step.override === 'reject_done' || step.override === 'battle_move' || step.override === 'blocked_move' || step.blockedFrom || autopilot) {
      s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
    }

    // 實際點擊用「裝置截圖像素」座標:把 cmd(縮圖空間)的 x/y/x2/y2 換算到 origW/origH 空間再送。
    // 這一步是消除歪斜的關鍵 —— 縮圖與裝置解析度不同,直接拿縮圖座標點會整個偏掉。
    // 搖桿預設位置依操作方式(左搖桿 / 下方中央);AI 沒給 x,y 時補上(截圖空間)。
    if (controls?.joystick && (cmd.action === 'move' || (cmd.action === 'combo' && cmd.dir)) && !Number.isFinite(cmd.x)) {
      cmd.x = Math.round(cw * controls.joystick.x); cmd.y = Math.round(ch * controls.joystick.y);
    }
    // AI 思考一步要十幾秒:這段時間內按了停止,就不要再把動作送到裝置。
    if (await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; break; }
    const deviceCmd = { ...cmd };
    let spinWatched = null; // 這一步有跑 AutoSpin 看守 → 結束後不再額外等 3 秒(看守本身就是等待)
    let actOk = false; // 動作真的送到裝置了(才把它記成可重播的操作)
    if (cmd.tx != null && Number.isFinite(cmd.tx)) deviceCmd.tx = toDeviceX(cmd.tx);
    if (cmd.ty != null && Number.isFinite(cmd.ty)) deviceCmd.ty = toDeviceY(cmd.ty);
    if (cmd.x != null && Number.isFinite(cmd.x)) deviceCmd.x = toDeviceX(cmd.x);
    if (cmd.y != null && Number.isFinite(cmd.y)) deviceCmd.y = toDeviceY(cmd.y);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) deviceCmd.x2 = toDeviceX(cmd.x2);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) deviceCmd.y2 = toDeviceY(cmd.y2);
    // 憑證替換:僅在「輸入到裝置」時把 text 的 ${key}/secretRef 換成真值(step/trace 已存原佔位符)。
    // 找不到時重載一次(使用者可能剛更新憑證);仍缺少就 fail closed,絕不把 `${...}` 原樣打進遊戲。
    if (deviceCmd.action === 'type' && typeof deviceCmd.text === 'string' && deviceCmd.text.length > 0) {
      const refs = [...deviceCmd.text.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
      let sub;
      try {
        sub = await substituteText(deviceCmd.text, appCredentials);
        if (sub.missing.length > 0) {
          appCredentials = await loadAppCredentials();
          sub = await substituteText(deviceCmd.text, appCredentials);
        }
      } catch (e) {
        const why = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200);
        step.credentialError = { refs, reason: 'resolver_error' };
        s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
        finalState = 'error'; finalMsg = `測試憑證解析失敗:${why}`;
        await writeStatus('error', finalMsg, steps.length);
        break;
      }
      step.credentialRefs = refs;
      step.credentialResolved = sub.resolved;
      if (sub.missing.length > 0) {
        const missingKeys = sub.missing.map((x) => x.replace(/^\$\{|\}$/g, ''));
        step.credentialError = { refs: missingKeys, reason: 'missing' };
        s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
        finalState = 'error';
        finalMsg = `測試案例引用的憑證尚未設定:${missingKeys.join('、')}。請在應用管理設定同名 key,或只保留一組「帳號/密碼」供系統自動對應。`;
        await writeStatus('error', finalMsg, steps.length);
        break;
      }
      deviceCmd.text = sub.text;
      // 只重寫「解析結果/引用名稱」,不寫 substituted text(明文永不落 S3)。
      s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
    }
    // launch 沒帶 app 時(AI 想「重開遊戲」),實際關閉並重開被測 App;舊版只 activateApp(已在前景時等於什麼都沒做)。
    if (deviceCmd.action === 'launch' && !deviceCmd.app && effectivePkg) {
      try { await client.restartApp(effectivePkg); await sleep(8000); consecFail = 0; } catch (e) { console.warn('[launch] 重啟失敗', e?.message || e); }
    } else
    try {
      if (devLogsPending) { await devLogsPending; devLogsPending = null; }
      // 【AutoSpin 看守】拉霸 AutoSpin 進行中 AI 選擇等待:runner 每秒自己截圖做本機灰階比對,
      // 有彈窗 / 畫面停住 / 到心跳上限才交回 AI,並把事件當下那張給下一步(不會漏掉自動關閉的獎勵彈窗)。
      if (isAutoSpinWait(cmd) && MAGICK && !operatorDirected && process.env.PA_SPIN_WATCH !== '0') {
        for (let w2 = 0; liveBusy && w2 < 40; w2++) await sleep(50); // 等飛行中的即時截圖結束
        liveBusy = true; // 看守期間暫停 liveTick,即時畫面改由看守幀更新
        let res;
        try {
          res = await watchAutoSpin({
            grab: () => client.takeScreenshot(),
            toGray: (b64) => grayGrid(b64),
            seed: shot,
            maxMs: Number(process.env.PA_SPIN_WATCH_MAX_MS) || 30_000,
            onFrame: (b64) => {
              if (liveVideo?.healthy() && Date.now() - liveLastShotAt < 5000) return;
              liveLastShotAt = Date.now();
              const png = Buffer.from(b64, 'base64');
              (MAGICK ? liveJpeg(png) : Promise.resolve(null))
                .then((jpg) => s3put(LIVE_KEY, jpg ?? png, jpg ? 'image/jpeg' : 'image/png'))
                .catch(() => {});
            },
          });
        } finally { liveBusy = false; }
        spinWatched = res;
        // 事件幀 / 心跳最後一張(≤1 秒前)直接給下一步;截圖失敗時那張可能過時,下一步重新截。
        if (res.frame && res.reason !== 'error') pendingShot = res.frame;
        controlNote += watchNote(res);
        step.watch = { reason: res.reason, frames: res.frames, ms: res.ms, ...(res.detail && Object.keys(res.detail).length ? { detail: res.detail } : {}) };
        s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
        console.log(`[spin-watch] 第 ${i} 步:${res.reason}(${res.frames} 張 / ${Math.round(res.ms / 1000)}s)${res.detail ? ' ' + JSON.stringify(res.detail) : ''}`);
        if (res.reason === 'error') throw new Error(`AutoSpin 看守截圖失敗:${res.detail?.error ?? ''}`);
      } else
      await timedAsync(tm, 'act', () => client.act(deviceCmd));
      actOk = true;
      // 點 AutoSpin 次數選項或 SPIN 後立刻開始影片盤面追蹤;不必等下一輪 VLM 看見剩餘次數。
      if (slotCapture && (cmd.action === 'tap' || cmd.action === 'hold' || cmd.action === 'swipe')) {
        const intent = `${cmd.target ?? ''} ${cmd.screen ?? ''} ${cmd.thinking ?? ''}`;
        const selectedAuto = /AutoSpin\s*選單|Auto\s*Spin\s*(?:menu|option)/i.test(intent) && /(?:500|100|50|30)/.test(intent);
        const pressedSpin = /(?:^|\b)SPIN(?:\b|鈕|按鈕)/i.test(String(cmd.target ?? ''));
        if (selectedAuto || pressedSpin) slotCapture.setActive(true, `#${i} ${selectedAuto ? '選擇 AutoSpin 次數' : '按下 SPIN'}`, Date.now(), 'paid');
      }
      consecFail = 0;
      // 記下這次走位(方向 + 走位前的背景),下一步比對背景有沒有捲動。
      const moved = cmd.action === 'move' || (cmd.action === 'combo' && cmd.dir);
      const mdir = moved && !Number.isFinite(cmd.x2) ? normDir(cmd.dir ?? cmd.direction) : null;
      if (mdir && curScene) lastMove = { dir: mdir, scene: curScene };
    } catch (e) {
      // 記下錯誤原因(之前完全吞掉,報告只剩「連續動作失敗」,看不出是連線斷了還是指令不被接受)。
      const why = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 300);
      console.warn(`[act] 第 ${i} 步 ${cmd.action} 失敗(連續 ${consecFail + 1} 次):${why}`);
      consecFail++;
      if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = `連續動作失敗(${consecFail} 次):${why}`; break; }
    }
    // 【SPIN 迴圈】這一步是照記憶按的 SPIN:runner 自己等盤面停下,再只讀數字(不做決策,快又省)。
    if (cmd.reflex?.kind === 'spin' && actOk) {
      // 從這裡開始解碼錄影分段(分段是事後拉回來的,涵蓋剛才那一下 SPIN 的那段會晚點才到)。
      spinSettle?.arm();
      const t1 = Date.now();
      let reelsPrev = null;   // 上一張的轉軸區
      let numsPrev = null;    // 上一張的數字列
      let lastB64 = null;
      let moved = false;      // 轉軸真的轉過(沒轉 = 多半沒按到)
      let stillSince = null;  // 兩區都不動的起始時刻
      let stillMs = 0;
      let samples = 0;
      let why = 'timeout';
      const { reels: SPIN_REELS_CROP, nums: SPIN_NUMS_CROP } = spinRois;
      // 【影片判定】優先用已經在錄的即時錄影判斷停輪(見 spinSettle.mjs):每秒 10 個樣本、
      // 不佔 Appium 連線,「靜止 2 秒」就是真的 2 秒。確認停好之後才取一張圖來讀數字。
      // 截圖輪詢(下面的 else)留作沒有錄影時的退路 —— 它一個樣本要 5 秒多,量不出 2 秒的窗口
      // (job-mvch7zri:每局等 16~23 秒,回報的靜止時間都是 5~6 秒)。
      let settledByVideo = false;
      if (spinSettle?.healthy()) {
        const r = await spinSettle.waitSettled({ after: t1, stillMs: SPIN_STILL_MS, timeoutMs: SPIN_SETTLE_MAX_MS, sleep })
          .finally(() => spinSettle.disarm());
        // 量測失敗不等於遊戲沒反應,不能拿它去扣 SPIN 按鈕的可信度(實測這樣會把 24/11 的
        // 按鈕扣成 24/17 而被停用,之後整段都回去走 VLM)。兩種量測失敗:
        //   frames === 0 → 影片這條路根本沒資料(例如串流掛了)。
        //   reason 'stale' → 解碼進度還沒走到按下 SPIN 那一刻(積壓落後),等於沒看過。
        if (r.reason === 'stale' || (r.reason === 'no_move' && spinSettle.stats.frames === 0)) {
          console.log(`[SPIN 迴圈] 影片${r.reason === 'stale' ? `落後 ${Math.round((Date.now() - t1 - r.covered) / 100) / 10}s,還沒解到按下 SPIN 的那一刻` : '沒有任何影格'}(等了 ${Math.round(r.waitedMs / 100) / 10}s),改用截圖輪詢判定停輪`);
        } else {
          settledByVideo = true;
          why = r.reason;
          moved = Boolean(r.movedAt);
          stillMs = Math.round(r.stillMs);
          for (let w2 = 0; liveBusy && w2 < 40; w2++) await sleep(50);
          liveBusy = true;
          try { lastB64 = await client.takeScreenshot(); } catch { lastB64 = null; } finally { liveBusy = false; }
          samples = 1;
          console.log(`[SPIN 迴圈] 等盤面停 ${Math.round((Date.now() - t1) / 100) / 10}s(影片判定 ${why};靜止 ${stillMs}ms,影片落後 ${Math.max(0, Math.round((Date.now() - t1 - r.covered) / 100) / 10)}s,轉動=${moved})`);
        }
      }
      if (!settledByVideo) {
      // 按下 SPIN 之前的轉軸區(用這一步開頭那張截圖),用來判斷有沒有真的轉動。
      const reelsBefore = MAGICK ? pHashHex(shot, SPIN_REELS_CROP) : null;
      // 退路自己重新計時:影片那條路可能已經先燒掉整個 SPIN_SETTLE_MAX_MS,
      // 沿用 t1 當起點的話這個迴圈會一次都不跑,直接回報「沒有轉動」。
      const t2 = Date.now();
      for (let k = 0; k < 40 && Date.now() - t2 < SPIN_SETTLE_MAX_MS; k++) {
        await sleep(SPIN_POLL_MS);
        // 即時畫面的截圖也走同一條 Appium session,不避讓會互相排隊(實測 shot 從 2.3 秒變 6.4 秒)。
        for (let w2 = 0; liveBusy && w2 < 40; w2++) await sleep(50);
        let b64;
        liveBusy = true;
        try { b64 = await client.takeScreenshot(); }
        catch { break; }
        finally { liveBusy = false; }
        samples++;
        lastB64 = b64;
        if (!MAGICK) { why = 'no_magick'; break; }
        const reels = pHashHex(b64, SPIN_REELS_CROP);
        const nums = pHashHex(b64, SPIN_NUMS_CROP);
        if (!reels || !nums) continue;
        if (reelsBefore && pHashHamming(reelsBefore, reels) > SPIN_MOVED_BITS) moved = true;
        // 「停下來」= 轉軸不動,而且數字列也不動。只看轉軸會在派彩滾動數字的途中就放行,
        // 讀到滾到一半的餘額(job-mvc3knmo 的 86 局裡 11 局餘額對不上帳就是這樣來的)。
        const still = reelsPrev && numsPrev
          && pHashHamming(reelsPrev, reels) <= SPIN_STILL_BITS
          && pHashHamming(numsPrev, nums) <= SPIN_STILL_BITS;
        reelsPrev = reels;
        numsPrev = nums;
        const now = Date.now();
        if (!still) { stillSince = null; continue; }
        if (stillSince === null) stillSince = now;
        stillMs = now - stillSince;
        // 以「持續不動的時間」為準,不是「連續幾張圖」—— 取一張圖要 2 秒多,張數換算不出秒數。
        if (moved && stillMs >= SPIN_STILL_MS) { why = 'still'; break; }
        // 沒轉動過:多半是沒按到,不必等滿整個靜止窗,早點交還。
        if (!moved && now - t2 > 4000 && stillMs >= 1500) { why = 'no_move'; break; }
      }
      console.log(`[SPIN 迴圈] 等盤面停 ${Math.round((Date.now() - t1) / 100) / 10}s(截圖輪詢 ${why};取樣 ${samples} 次,靜止 ${stillMs}ms,轉動=${moved})`);
      }
      let reading = null;
      if (lastB64) {
        pendingShot = lastB64; // 下一步直接用這張(不再多等 3 秒)
        const d2 = pngSize(Buffer.from(lastB64, 'base64'));
        const r2 = MAGICK ? resizeToSmartB64(lastB64, d2?.w ?? origW, d2?.h ?? origH) : { b64: lastB64, format: 'png' };
        const rd = await decide(SPIN_READER_SYSTEM, [makeUserTurn([r2.b64], '讀出這張畫面上的數字。', r2.format)]).catch(() => null);
        if (rd?.usage) accumulate(tok, rd.usage);
        if (rd && rd.trace?.ok !== false && !rd.cmd?.parseFailed) reading = rd.cmd;
      }
      const num = (v) => {
        if (v === null || v === undefined || v === '') return undefined;
        const x = Number(String(v).replace(/[^\d.-]/g, ''));
        return Number.isFinite(x) ? x : undefined;
      };
      const freeLeft = num(reading?.free_spins_left) ?? 0;
      const bonusNow = reading?.bonus === true || freeLeft > 0;
      // 已經在免費遊戲中又讀到免費遊戲 → 這不是付費局(觸發免費遊戲的那一局才算)。
      const paidRound = moved && !(rtpLoop.lastBonus && bonusNow);
      const round = { n: rtpLoop.paid + (paidRound ? 1 : 0), bet: num(reading?.bet), win: num(reading?.win) ?? 0, balance: num(reading?.balance), free: freeLeft, bonus: bonusNow };
      rtpLoop.lastBonus = bonusNow;
      if (paidRound) {
        rtpLoop.paid++;
        rtpLoop.misses = 0;
        rtpLoop.rounds.push(round);
        if (rtpLoop.startBalance === undefined && Number.isFinite(round.balance) && Number.isFinite(round.bet)) rtpLoop.startBalance = round.balance - round.win + round.bet;
      } else if (!moved) {
        rtpLoop.misses++;
        // 連兩次沒轉:交回 AI 處理(多半是獎勵動畫 / 彈窗壓著),但只把這個操作冷卻幾步,
        // 不永久停用 —— 永久停用的代價是每次都要 AI 摸索幾十步才回到盤面(見 SPIN_COOLDOWN_STEPS)。
        if (rtpLoop.misses >= 2) {
          const until = coolSpinOp(reflexState, cmd.reflex.key, i);
          rtpLoop.handBack = true;
          console.log(`[SPIN 迴圈] 連 2 次沒轉動,交回 AI;這個 SPIN 操作冷卻到第 ${until} 步(不是永久停用)`);
        }
      }
      if (Number.isFinite(round.balance)) rtpLoop.endBalance = round.balance;
      // settle:'still' = 兩區都靜止滿門檻才讀(數字可信);'timeout' / 'no_move' = 沒等到靜止,
      // 這一局的數字不該拿去做餘額對帳(報告端據此排除,不要當成遊戲算錯帳)。
      step.rtpRound = { ...round, paid: paidRound, moved, ms: Date.now() - t1, settle: why, stillMs, samples };
      if (reading) {
        step.obs = { ...(step.obs ?? {}),
          ...(Number.isFinite(round.balance) ? { balance: round.balance } : {}),
          ...(Number.isFinite(round.bet) ? { bet: round.bet } : {}),
          ...(moved ? { win: round.win } : {}),
          // spun 讓報告端知道這是「一局的結果」:沒有它,連續兩局數字剛好一樣會被去重合併成一局。
          ...(paidRound ? { spun: true } : {}) };
      }
      if (paidRound) step.mechanic = 'spin';
      step.thinking = moved
        ? `[SPIN 迴圈] 第 ${rtpLoop.paid}/${rtpLoop.target} 局${paidRound ? '' : '(免費遊戲中,不算付費局)'}:下注 ${round.bet ?? '?'}、贏分 ${round.win ?? '?'}、餘額 ${round.balance ?? '?'}${bonusNow ? '(免費遊戲 / Bonus)' : ''}。`
        : `[SPIN 迴圈] 點了「${cmd.target}」但盤面沒有轉動(第 ${rtpLoop.misses} 次)。`;
      if (reading && (reading.popup === true || bonusNow)) {
        rtpLoop.handBack = true;
        controlNote += `【SPIN 迴圈】第 ${rtpLoop.paid} 局後出現${bonusNow ? '免費遊戲 / Bonus' : '彈窗'},請處理到回到主盤面;回到主盤面後系統會自動繼續轉(已完成 ${rtpLoop.paid}/${rtpLoop.target} 局)。`;
      }
      if (rtpLoop.paid >= rtpLoop.target) {
        rtpLoop.done = true;
        const s = rtpSummary(rtpLoop.rounds, { startBalance: rtpLoop.startBalance, endBalance: rtpLoop.endBalance });
        controlNote += `【SPIN 迴圈完成】已轉完 ${rtpLoop.target} 局付費 SPIN,RTP 已由系統統計(${s?.rtpPercent ?? '?'}%,95% 信賴區間 ${s?.ci95?.join('–') ?? '?'}%)。不用再轉;完成測試腳本其餘項目,沒有其他項目就 done。`;
        console.log(`[SPIN 迴圈] 完成 ${rtpLoop.target} 局:RTP ${s?.rtpPercent ?? '?'}%`);
      }
      s3putBg(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json');
      console.log(`[SPIN 迴圈] 第 ${i} 步:${step.thinking}(${Math.round((Date.now() - t1) / 100) / 10}s)`);
    }
    prevOrient = isLandscape;
    // 導覽圖用的「上一畫面/上一動作」:AI 沒給畫面名(pid=null,如解析失敗)時沿用上一個已知畫面,
    // 且該步若只是 wait 不覆蓋真正造成轉場的動作(如先 tap Slots → 解析失敗 wait → 機台選擇)。
    prevAction = cmd.action; // 給 prompt 用:上一步實際執行的動作
    if (cmd.screen) prevScreen = screenName;
    if (pid) {
      prevPageId = pid; navAction = cmd.action;
      // runner 覆寫了動作時,AI 的 target 不代表實際操作的元件。
      prevTarget = cmd.override ? '' : (typeof cmd.target === 'string' ? cmd.target : '');
      // 可重播的操作細節(runner 自己的脫困 / 改寫不算;記憶腳本自己的操作照樣記,累積成功次數)。
      navOp = actOk && !cmd.override ? opFromCmd(cmd, cw, ch, { version: appVersion }) : null;
    } else if (cmd.action !== 'wait') {
      navAction = cmd.action; prevTarget = ''; navOp = null;
    }
    // AI 看過一次畫面後,被打斷的 SPIN 迴圈可以再接著轉;沒轉動的連續計數也重新起算
    // (那兩次是上一個擋住盤面的狀況留下的,不該算到 AI 處理完之後)。
    if (!cmd.reflex) { rtpLoop.handBack = false; rtpLoop.misses = 0; }
    // 輔助 Agent 核對上一步 + 決策 Agent 規劃下一步:在等待畫面穩定的這段時間背景進行(依序串接,不交錯)。
    if (team && !cmd.reflex) {
      const idx = i;
      const observation = { screen: screenName, thinking: String(cmd.thinking || ''), ...(guardedObs ? { obs: guardedObs } : {}) };
      const actionText = [cmd.action, cmd.dir ? `dir=${cmd.dir}` : '', cmd.target ? `→ ${cmd.target}` : '', cmd.override ? `(runner 改寫:${cmd.override})` : '']
        .filter(Boolean).join(' ');
      const prevStep = steps.find((s) => s.index === idx - 1);
      const prevPlan = stepPlans.get(idx - 1) ?? null;
      const changed = screenChanged;
      const opTexts = operator.active.slice(-3).map((c) => c.text);
      const runnerNote = [
        stuckCount > 0 ? `畫面已連續 ${stuckCount} 步沒有變化` : '',
        (screenSeen.get(screenName) || 0) >= 4 ? `「${screenName}」已操作 ${screenSeen.get(screenName)} 次` : '',
        cmd.override === 'app_restart' ? '遊戲剛被重新啟動' : '',
        blockedDir ? `往 ${blockedDir} 走被擋住` : '',
      ].filter(Boolean).join(';');
      const work = async () => {
        // 這一步的畫面 = 上一步動作的結果 → 判斷上一步有沒有生效,寫回上一步的紀錄。
        const rv = idx > 0
          ? await team.review({ index: idx, prevAction: prevStep ? `${prevStep.action}${prevStep.dir ? ` dir=${prevStep.dir}` : ''}` : '', prevPlan, observation, screenChanged: changed }).catch(() => null)
          : null;
        if (rv && prevStep) {
          prevStep.review = { effect: rv.effect, ...(rv.note ? { note: rv.note } : {}), ...(rv.issues.length ? { issues: rv.issues } : {}) };
          s3putBg(`${PREFIX}/steps/${prevStep.index}.json`, JSON.stringify(prevStep), 'application/json');
        }
        const cur = steps.find((s) => s.index === idx);
        if (rv && cur && Object.keys(rv.facts).length) {
          cur.facts = rv.facts;
          s3putBg(`${PREFIX}/steps/${idx}.json`, JSON.stringify(cur), 'application/json');
        }
        team.record({ index: idx, screen: observation.screen, action: actionText, effect: rv?.effect });
        await team.maybeSummarize(idx).catch(() => {});
      };
      teamPending = (teamPending ?? Promise.resolve()).then(work, work);
    }
    // 戰鬥走位中不額外等待(站著不動就會被包圍);其餘維持 3 秒讓畫面穩定。
    // AutoSpin 看守剛結束:事件幀已備好,立刻交回 AI(再等 3 秒,自動關閉的彈窗就消失了)。
    // 記憶腳本:SPIN 迴圈已在上面等過盤面;導航操作只等 1.5 秒(下一步會確認是否到了預期畫面,載入中會再等)。
    if (cmd.reflex?.kind === 'spin') { /* 已等過 */ }
    else if (!spinWatched) {
      if (lastBattleMove) await sleep(300);
      else {
        await sleepOrOperator(cmd.reflex ? REFLEX_SETTLE_MS : SETTLE_MS);
        // 【預抓下一張】趁這裡把下一步要用的截圖抓好(取圖本身要數秒,期間畫面也在繼續穩定)。
        // 下一步直接用這張,省掉一次串列的 Appium 取圖。
        // 有新指令待處理時不預抓(那條路要最新畫面);liveBusy 旗標避免與即時串流搶同一條 session。
        if (!pendingShot && !pendingCmds.length) {
          for (let w2 = 0; liveBusy && w2 < 40; w2++) await sleep(50);
          liveBusy = true;
          const tShot = Date.now();
          try { pendingShot = await client.takeScreenshot(); }
          catch { pendingShot = null; }
          finally {
            liveBusy = false;
            const last = steps[steps.length - 1];
            if (last?.timing) last.timing.prefetch = Date.now() - tShot;
          }
        }
      }
    }
  }
  // 背景上傳(截圖 / 標記 / 步驟 JSON / 記憶地圖)收尾。
  await flushPuts();

  // 收尾(停止並上傳整場錄影、收 log、產生報告)可能要十幾秒到一兩分鐘;先更新狀態訊息,讓前端不是乾等。
  await writeStatus('running', '測試已結束,正在收尾:上傳錄影、整理畫面與產生報告(約需 1–2 分鐘)…', steps.length).catch(() => {});

  // 等最後一輪 Agent 協作寫完紀錄(最多 15 秒)。
  if (teamPending) await Promise.race([teamPending, sleep(15_000)]);

  // 收最後一段真機 log(結束前的 crash / 錯誤最有價值)。
  if (devLogs) {
    if (devLogsPending) await devLogsPending;
    await devLogs.collect(steps.length).catch(() => null);
  }
  // 停止即時串流(先停,避免 quit session 後仍嘗試截圖)。
  clearInterval(liveTimer);
  if (liveVideo) await liveVideo.stop();
  if (slotCapture) slotCaptureSummary = await slotCapture.stop().catch((e) => {
    console.warn('[slot-capture] 收尾失敗:', e?.message || e);
    return slotCapture.summary();
  });
  if (recorder) {
    activeRecorder = null;
    await recorder.stop().catch((e) => console.warn('[record] 收尾失敗', e?.message || e));
  }
  // 等待可能仍在飛行中的最後一張 live 截圖結束,避免對已關閉 session 發請求。
  for (let w2 = 0; liveBusy && w2 < 20; w2++) await sleep(50);
  // 效能監測收尾:讀最終耗電、還原電池「未接電」模擬與 timestats(必須在 quit session 前)。
  if (perfPending) await perfPending.catch(() => null);
  if (perfShell) await perfMon.stop().catch(() => {});

  // 步調統計:各段耗時的中位數 + 模型與流程開銷的佔比。用來確認加速有沒有生效、
  // 以及下一輪該從哪裡再省(之前完全沒有這些數字,只能從 durationMs 反推)。
  logPaceSummary(steps);

  // 報告 + 終態。
  console.log(memTrace.summaryLog());
  await s3put(`${PREFIX}/memory-usage.json`, JSON.stringify(memTrace.summary()), 'application/json').catch(() => {});
  const nodes = Object.values(struct.pages).map((p) => ({ id: p.id, name: p.name, screenshotKey: `${MEM_PREFIX}/screenshots/${p.id}.png` }));
  // RTP 統計:只有案例任務要求算 RTP、且確實從 thinking 抓到可用資料時才附上 rtp 欄位,
  // 前端據此判斷要不要顯示 RTP 圖表(見 computeRtpStats 註解)。
  // 結束前才按停止(例如最後一步正好卡住/出錯):以使用者的「停止」為準;真的完成(pass)則保留。
  if (finalState !== 'pass' && finalState !== 'cancelled' && await cancelRequested()) { finalState = 'cancelled'; finalMsg = '使用者取消'; }
  if (finalState === 'pass') updateScriptProgress(team, { allDone: true });
  // SPIN 迴圈有逐局數字 → 以它為準(含餘額交叉驗算與 95% 信賴區間);否則照舊從 thinking 文字估。
  const loopRtp = rtpLoop.rounds.length ? rtpSummary(rtpLoop.rounds, { startBalance: rtpLoop.startBalance, endBalance: rtpLoop.endBalance }) : null;
  const rtp = loopRtp
    ? {
      method: 'spin-loop',
      target: rtpLoop.target,
      sampleCount: loopRtp.rounds,
      ...loopRtp,
      series: rtpLoop.rounds.filter((r) => Number.isFinite(r.bet) && r.bet > 0).reduce((acc, r) => {
        const prev = acc[acc.length - 1] ?? { bet: 0, win: 0 };
        const bet = prev.bet + r.bet;
        const win = prev.win + (r.win ?? 0);
        acc.push({ n: acc.length + 1, bet, win, rtp: Number(((win / bet) * 100).toFixed(2)) });
        return acc;
      }, []).map(({ n, rtp: v }) => ({ n, rtp: v })),
    }
    : (isRtpTask(TASK) ? computeRtpStats(steps) : null);
  const report = { jobId: JOB, state: finalState, message: finalMsg, task: TASK, device: { w, h }, vlmModel: VLM,
    runnerVersion: RUNNER_VERSION,
    ...(evidence?.profiles ? { evidenceProfiles: evidence.profiles } : {}),
    ...(controls ? { controls: { ids: controls.ids, source: controls.source } } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(maxSegments !== 1 ? { segments: segment } : {}),
    ...(rtp ? { rtp } : {}),
    ...(slotCaptureSummary ? { slotCapture: slotCaptureSummary } : {}),
    ...(perfShell ? { perfMeta: perfMon.meta(launchInfo) } : {}),
    // tokens = 三個 Agent 合計;tokensBySeat 分開記(花費依各 Agent 的模型單價分別計算)。
    ...(team ? {
      tokensBySeat: { vlm: { ...tok }, agent: { ...team.tokens.agent }, subagent: { ...team.tokens.subagent } },
      seatModels: { vlm: VLM, ...(AGENT_MODEL ? { agent: AGENT_MODEL } : {}), ...(SUBAGENT_MODEL ? { subagent: SUBAGENT_MODEL } : {}) },
    } : {}),
    stepCount: steps.length, steps, navGraph: { nodes, edges: struct.edges },
    tokens: team ? addUsage(addUsage(tok, team.tokens.agent), team.tokens.subagent) : { ...tok },
    // 依「實際呼叫的模型」記的 token(含快取、含解析失敗改用的備援模型)—— 費用以它為準。
    tokensByModel: mergeByModel(vlmLedger.byModel(), team?.tokensByModel?.() ?? {}),
    generatedAt: new Date().toISOString() };
  await s3put(`${PREFIX}/report.json`, JSON.stringify(report), 'application/json').catch(() => {});
  await writeStatus(finalState, finalMsg, steps.length);
  await client.quit().catch(() => {});
  // runner 自建的 session 由 runner 收尾(釋放真機,停止計費);engine 預建的則不動。
  if (ownsSession) await stopSelfOwnedSession();
}

// 主機關機 / 被終止時會送 SIGTERM:至少把終態寫成 error,任務才不會永遠停在「執行中」。
// 已經寫過終態(正常結束)時 writeStatus 只會再覆寫一次相同語意的 error,所以只在還沒結束時做。
let finished = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, async () => {
    if (!finished) {
      finished = true;
      await writeStatus('error', `執行主機被終止(${sig}),測試中斷;已完成的步驟與截圖仍保留在執行軌跡中。`, lastStepCount).catch(() => {});
    }
    process.exit(143);
  });
}

main().then(() => { finished = true; }).catch(async (e) => {
  finished = true;
  await writeStatus('error', String(e), 0);
  // 整場錄影盡力收下(session 還活著才拿得到;拿不到就算了)。
  if (activeRecorder) await activeRecorder.stop().catch(() => {});
  // 還原「未接電」模擬(盡力;session 隨後也會被釋放並由 Device Farm 清機)。
  if (activePerfMon) await activePerfMon.stop().catch(() => {});
  await stopSelfOwnedSession(); // 中途失敗也要釋放真機/停計費
  process.exitCode = 1;
});
