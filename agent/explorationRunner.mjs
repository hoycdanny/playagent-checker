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
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { applyEdits, createOperatorChannel, hintsPromptSection, loadAppMemory, operatorTurnNote, routesPromptSection, routeTurnNote, screenHintsFor, POINT_ONLY_TEXT } from './operatorMemory.mjs';
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
import { createMediaRecorder } from './mediaAudio.mjs';
import { SCENE_CROP, isBlocked, normDir, turnDir } from './moveFeedback.mjs';
import { createDeviceLogs } from './deviceLogs.mjs';
import { createAgentTeam, normalizeElements, VISION_ELEMENTS_NOTE } from './agentTeam.mjs';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { liveJpeg, magickAvailable, gridOverlayB64, findBrightButton, findButtonBands, annotateTapB64, pHashHex, pHashHamming, downscaleForVlmB64, resizeToSmartB64 } from './imageTools.mjs';
import { uitarsEnabled, decideUitars } from './uitarsClient.mjs';
import { loadAppCredentials, substituteText } from './secretsResolver.mjs';
import { evidencePromptSection, evidenceFields } from './evidenceProtocol.mjs';
import { upsertPage, recordTransition, recordMiss, compactStructure } from './memoryGraph.mjs';
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
const DATA_REGION = process.env.PA_DATA_REGION || 'us-east-2';
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
const RUNNER_VERSION = 'devicefarm-runner/2.4 (evidence-v1, controls-v1, recording-v2, agent-team-v1, segments-v1)';
// 效能取樣間隔(步)。adb shell 取樣與 VLM 並行、且 FPS/CPU/GPU 為區間累計,預設每 2 步一次;0 = 停用。
const PERF_EVERY = process.env.PA_PERF_EVERY ? Math.max(0, Number(process.env.PA_PERF_EVERY) || 0) : 2;
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
async function writeStatus(state, message, steps) {
  if (typeof steps === 'number' && steps > lastStepCount) lastStepCount = steps;
  await s3put(`${PREFIX}/status.json`,
    JSON.stringify({ jobId: JOB, state, message, steps: steps ?? 0, boot, updatedAt: new Date().toISOString() }),
    'application/json').catch(() => {});
}
const BOOT_MSG = {
  download: 'Device Farm:準備 APK',
  upload: 'Device Farm:上傳 APK',
  device: 'Device Farm:配置真機',
  connect: 'Device Farm:真機就緒,連線中',
};

// ── VLM 決策(純邏輯,對齊 emulatorRunner 的 prompt/對話策略,但改用 SDK)──

function buildSystemPrompt(w, h, knowledge, _hasGrid, evidence, controls) {
  // 操作行為(控制方案,由測試腳本勾選):有指定時注入權威操作段落,且只有「下方中央搖桿」
  // 方案才保留割草類的移動說明;沒指定 = 舊行為(全部保留)。
  const includeMow = !controls || controls.battleMove;
  const controlsBlock = controls?.prompt ? `\n${controls.prompt}\n` : '';
  const actionEnum = controls?.allowedActions?.length ? controls.allowedActions.join('|') : 'tap|swipe|move|back|type|wait|launch|done';
  const gestureFields = controls
    ? ',"durationMs":<滑動毫秒>,"tx":<右手像素x>,"ty":<右手像素y>,"taps":<次數>,"scale":"in|out"'
    : '';
  const gestureHelp = controls
    ? `hold 需 x,y,holdMs(按住);swipe 可加 durationMs(長=拖曳、短=快劃);combo 需 x,y(左手)、可選 dir、holdMs、tx,ty(右手按鈕)、taps;pinch 需 x,y 與 scale。只能使用上面列出的可用動作。`
    : '';
  const base =
    `你是專業遊戲測試工程師,正在測試一個 ${PLATFORM === 'ios' ? 'iOS' : PLATFORM === 'windows' ? 'Windows PC' : 'Android'} 遊戲。每一步你會看到一張最新截圖。` +
    (PLATFORM === 'windows' ? '這是 Windows 桌面:tap = 滑鼠左鍵單擊、swipe = 按住左鍵拖曳、back = 按 Esc;沒有多點觸控。截圖是整個螢幕,遊戲視窗外的桌面/工作列不要點。' : '') +
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
    `{"thinking":"...","action":"${actionEnum}","x":<像素>,"y":<像素>,"x2":<像素>,"y2":<像素>,"dir":"up|down|left|right|upleft|upright|downleft|downright","holdMs":<毫秒>${gestureFields},"text":"...","screen":"畫面名稱","memo":"進度筆記"}。` +
    `memo 是你自己的「進度筆記」:測試腳本要你記住、之後還會用到的數字與進度(例如初始值、每局投注、已完成次數、目前第幾段、各段起始值),` +
    `每一步都覆寫成「最新的完整版」(200 字內)。你只看得到最近幾步,系統會把上一步的 memo 原樣交還給你——照它延續,不要重新開始、不要重記初始值;沒有需要記的就省略。` +
    `x/y 是「這張圖的像素座標」。tap 需 x,y;swipe 需 x,y,x2,y2;` +
    (controls
      ? (controls.joystick ? `move 需 dir 與可選 holdMs(按住毫秒,預設1500),x,y 省略時 runner 用本遊戲搖桿的預設位置,看得到搖桿圓圈時用 x,y 指定其中心更準;` : '')
      : `move 需 dir(方向)與可選 holdMs(按住毫秒,預設1500)——虛擬搖桿在【畫面下方中央】(不是正中心),x,y 省略時預設以下方中央為搖桿中心;若你看得到搖桿(半透明圓圈/白圈)可用 x,y 指定它的中心更精準;`) +
    gestureHelp +
    `type 需 text;done 只在真正完成或完全無法進行時用。` +
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
// 解析失敗的最後一道備援:換一個穩定的視覺模型重問(2026-10-05:Kimi K3 長任務中段開始
// 頻繁吐出 1000 token 亂碼/空字串,連同重問都失敗,測試人員下的指令也因此被吞掉)。
const VLM_FALLBACK = process.env.PA_VLM_FALLBACK
  || (VLM.includes('anthropic') ? 'us.amazon.nova-pro-v1:0' : 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');

async function decide(system, messages, modelId = VLM) {
  // 預設保留最近 2 張圖;但再加一道保險:若總圖量仍逼近模型 body 上限(~2MB),就降到只留最新 1 張,
  // 避免像大廳這種細節多的畫面兩張疊起來撐爆(Failed to buffer request body: length limit exceeded)。
  pruneImages(messages, 2);
  const SOFT_LIMIT = 1_500_000; // ~1.5MB 原始位元組(base64 會再脹 ~33%,保守留裕度)
  if (totalImageBytes(messages) > SOFT_LIMIT) pruneImages(messages, 1);
  // 裁剪過舊的 assistant 回應文字(見 pruneAssistantText 註解):長任務的對話歷史文字
  // 本來無限增長,這裡控制在最近 6 輪完整內容,避免 prompt 隨步數線性變長變雜訊化。
  pruneAssistantText(messages, 6);
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
      const usage = parsed.usage ? { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens } : null;
      return { cmd: parseCmd(out), usage, rawText: out, trace: { ...baseTrace, ok: true, rawResponse: out, tokens: usage } };
    }
    // Nova / Llama / Qwen / DeepSeek 等:Bedrock Converse API(統一格式,含視覺)。
    // 2026-10-03:部分模型在預設取樣下偶爾整段吐出亂碼/空字串(輸出吃滿 maxTokens 卻沒有 JSON),
    // 長任務會因連續解析失敗中止。降低溫度收斂輸出;呼叫端另有「解析失敗立即重問」。
    // 2026-10-04:但 Kimi K3 等模型直接拒收 temperature/topP 欄位(ValidationException:
    // "This model doesn't support the temperature field"),第 0 步就失敗。改為:被拒時去掉取樣參數
    // 重送一次,並記住此模型不支援,後續步驟直接不送。
    const converse = (withSampling) => bedrock.send(new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: toConverseMessages(messages),
      inferenceConfig: withSampling ? { maxTokens: 1600, temperature: 0.2, topP: 0.9 } : { maxTokens: 1600 },
    }));
    let res;
    if (samplingUnsupportedModels.has(modelId)) {
      res = await converse(false);
    } else {
      try {
        res = await converse(true);
      } catch (e) {
        if (!/temperature|top_?p/i.test(String(e?.message || ''))) throw e;
        samplingUnsupportedModels.add(modelId);
        res = await converse(false);
      }
    }
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
function isRtpTask(task) {
  return /RTP|Return\s*To\s*Player|派彩率|回報率/i.test(String(task || ''));
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
  try {
    const jm = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/job.json` }))).Body.transformToString());
    const n = Number(jm?.maxSegments);
    if (Number.isInteger(n) && n >= 0 && n <= 50) maxSegments = n;
  } catch { /* 沒有就單段 */ }
  let segment = 1;
  let segStartedAt = 0; // 這一段 Device Farm 連線開始建立的時間
  let sessionInfo = null; // { projectArn, appArn, deviceArn, prefer32bit }:長時模式換新連線用
  console.log('執行時長', maxSegments === 1 ? `單段(${WRAP_MIN} 分鐘收尾)` : `長時:最多 ${maxSegments || '不限'} 段,每段 ${WRAP_MIN} 分鐘`);
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
  try {
    const ctx = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/context.json` }))).Body.transformToString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
    if (ctx && ctx.evidence && typeof ctx.evidence === 'object') evidence = ctx.evidence;
    if (ctx && ctx.controls && Array.isArray(ctx.controls.allowedActions)) controls = ctx.controls;
  } catch { /* 無則略過 */ }
  // 操作行為:允許的動作集合(null = 未指定,不限定)。
  const allowedActions = controls ? new Set(controls.allowedActions) : null;
  if (controls) console.log('操作行為', controls.ids.join(','), `(${controls.source})`, '可用動作', controls.allowedActions.join('/'));

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
      maxSec: Number(process.env.PA_RECORD_MAX_SEC) || 9000,
      presignPost: (key) => createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: key,
        Conditions: [['content-length-range', 1, 5 * 1024 * 1024 * 1024]],
        Fields: { 'Content-Type': 'video/mp4' },
        Expires: 3600,
      }),
      download: async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body.transformToByteArray()),
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
  let system = buildSystemPrompt(w, h, knowledge, MAGICK, evidence, controls)
    + hintsPromptSection(appMemory.hints, (id) => struct.pages?.[id]?.name ?? id) + routesPromptSection(appMemory.edits?.routes, routePageName);
  console.log('ImageMagick 座標校正', MAGICK ? '啟用' : '不可用(裸座標)');
  console.log('定位模型', USE_UITARS ? `UI-TARS(SageMaker endpoint=${process.env.PA_UITARS_ENDPOINT})` : `Bedrock VLM(${VLM})`);
  const messages = [];
  const steps = [];
  // prevAction:給 prompt 的上一步動作;navAction/prevTarget:導覽圖「造成轉場的動作/目標」。
  let prevPageId = null, prevAction = null, navAction = null, prevTarget = '';
  let prevScreen = ''; // 上一步 AI 標的畫面名(記憶提醒 / 指令回執用)
  let pendingCmds = []; // 尚未得到有效回應的測試人員指令(解析失敗時延續到下一步)
  let consecFail = 0;
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
      controlsPrompt: controls?.prompt ?? '', knowledge, put: s3put, prefix: PREFIX, log: (m) => console.log(m),
    })
    : null;
  console.log('Agent 協作', team ? `決策=${AGENT_MODEL || '停用'} 輔助=${SUBAGENT_MODEL || '停用'}` : '停用(只用視覺 Agent)');
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
  // 即時影片(screenrecord 2 秒分段,30+ fps):Android 才有;啟動失敗就只用截圖輪播。
  let liveVideo = null;
  if (PLATFORM === 'android' && process.env.PA_LIVE_VIDEO !== '0') {
    try {
      liveVideo = createLiveVideo({ client, put: s3put, prefix: PREFIX, size: recordSize(w, h), log: (m) => console.log(m) });
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
    await client.quit().catch(() => {});
    await stopSelfOwnedSession();

    segment += 1;
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
        system = buildSystemPrompt(w, h, knowledge, MAGICK, evidence, controls)
          + hintsPromptSection(appMemory.hints, (id) => struct.pages?.[id]?.name ?? id) + routesPromptSection(appMemory.edits?.routes, routePageName)
          + (team?.enabled.agent && !USE_UITARS ? VISION_ELEMENTS_NOTE : '');
      }
    } catch { /* 用原尺寸 */ }
    if (PLATFORM === 'android' && process.env.PA_LIVE_VIDEO !== '0') {
      try {
        liveVideo = createLiveVideo({ client, put: s3put, prefix: PREFIX, size: recordSize(w, h), log: (m) => console.log(m) });
        await liveVideo.start();
      } catch (e) { console.warn('[live-video] 新連線無法啟動,改用截圖輪播:', e?.message || e); liveVideo = null; }
    }
    liveTimer = setInterval(liveTick, 400);
    if (liveTimer.unref) liveTimer.unref();
    // 新遊戲狀態:卡住 / 死循環計數歸零,數值不跟前一段比。
    lastPhash = null; stuckCount = 0; loadingStreak = 0; consecWaitCount = 0; lastMove = null;
    screenSeen.clear();
    obsGuard.reset();
    prevAction = 'launch';
    controlNote += `【系統】Device Farm 單次連線最長 150 分鐘,已換新連線(第 ${segment} 段)並重新安裝、啟動遊戲:帳號與遊戲狀態可能已重置(例如訪客帳號、餘額重新開始)。請從第一個畫面重新進入,接著完成測試腳本還沒做完的部分。`;
    bootPhase('run');
    await writeStatus('running', `第 ${segment} 段連線就緒(${deviceModel ?? '真機'}),繼續測試`, steps.length);
    console.log(`[segment] 第 ${segment} 段就緒:${deviceModel ?? ''}`);
    return null;
  }

  for (let i = 0; i < MAX_STEPS; i++) {
    // 取消旗標檢查。
    try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/cancel.json` })); finalState = 'cancelled'; finalMsg = '使用者取消'; break; } catch { /* 無取消 */ }

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
    // 前景守衛:AI 可能誤按 back 把遊戲退到背景/桌面。已知包名時,每步先確保遊戲在前景,
    // 若被拉回前景則多等一下載入,避免整段在 Android 桌面/Play Games 空轉。
    // 前景遺失記錄成證據(報告據 appState + 上一步動作區分:AI 按 back / 疑似閃退 / 跳到其他 App)。
    let foregroundLost = false;
    let appState;
    if (effectivePkg) {
      try {
        const wasForeground = await client.ensureForeground(effectivePkg);
        if (!wasForeground) { foregroundLost = true; appState = client.lastAppState; await sleep(4000); }
      } catch { /* 盡力,不擋主流程 */ }
    }
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
    try { shot = await client.takeScreenshot(); } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續截圖失敗'; break; } continue; }
    // 即時推截圖到 S3(前端即時顯示)。
    await s3put(`${PREFIX}/screenshots/${i}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});

    // 卡住偵測:本步 pHash 與上一步比,幾乎相同(<40 bit)視為畫面沒變。
    const curPhash = MAGICK ? pHashHex(shot) : null;
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
    const turnText = (i === 0 ? `第一張畫面。目標:${TASK}` : `上一步(${prevAction})執行後的最新畫面。`) + dimHint + stuckNote + memoNote + controlNote
      + memoryNote + routeTurnNote(appMemory.edits?.routes, prevPageId, routePageName) + operatorTurnNote(newCmds, operator.active);
    controlNote = '';
    messages.push(makeUserTurn([visionShot], turnText, visionFmt));
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
    // 測試人員直接在即時畫面上點了位置:不靠 AI 猜座標,這一步就點那個點(最準)。
    // point 是相對畫面的比例(0–1),換算到本步截圖(cw×ch)空間後走同一條點擊/標記鏈。
    const pointCmd = [...newCmds].reverse().find((c) => c.point);
    let decided;
    if (pointCmd) {
      const px = Math.round(pointCmd.point.x * cw);
      const py = Math.round(pointCmd.point.y * ch);
      const note = pointCmd.text && pointCmd.text !== POINT_ONLY_TEXT ? `(${pointCmd.text})` : '';
      const opCmd = {
        action: 'tap', x: px, y: py,
        ...(prevScreen ? { screen: prevScreen } : {}),
        thinking: `依測試人員在即時畫面上點選的位置直接點擊 (${px}, ${py})${note}。`,
        target: pointCmd.text && pointCmd.text !== POINT_ONLY_TEXT ? pointCmd.text : '測試人員指定位置',
        operatorTap: true,
      };
      decided = { cmd: opCmd, usage: null, rawText: JSON.stringify(opCmd), trace: { modelId: 'operator', channel: 'operator', ok: true, request: {} } };
    } else {
      decided = USE_UITARS
        ? await decideUitars(uitarsInstr, messages, cw, ch)
        : await decide(system, messages);
    }
    // 解析失敗(模型吐亂碼/空字串)時立即重問,最多 2 次;不浪費一個步驟、也不讓連續失敗計數誤殺任務。
    //   第 1 次:同模型,但只帶「本回合」(拿掉長對話歷史 —— 實測模型多半是被長歷史帶歪才開始吐亂碼)。
    //   第 2 次:換備援模型(VLM_FALLBACK),同樣只帶本回合。
    // 備援呼叫本身失敗(如無權限)時保留原結果(wait 重試),不讓「模型呼叫失敗 → done」誤結束任務。
    for (let r = 0; r < 2 && decided.cmd.parseFailed && decided.trace?.ok !== false && !USE_UITARS; r++) {
      const model = r === 0 ? VLM : VLM_FALLBACK;
      const retry = await decide(system, [messages[messages.length - 1]], model);
      if (retry.trace?.ok === false) { console.warn(`[decide] 重問(${model})呼叫失敗:${retry.trace?.error?.message ?? ''}`); continue; }
      if (retry.usage && decided.usage) retry.usage = { input: retry.usage.input + decided.usage.input, output: retry.usage.output + decided.usage.output };
      decided = { ...retry, trace: { ...retry.trace, retries: r + 1, ...(model !== VLM ? { fallbackModel: model } : {}) } };
      if (!retry.cmd.parseFailed && model !== VLM) console.log(`[decide] 第 ${i} 步改由備援模型 ${model} 決策`);
    }
    const { cmd, usage, rawText, trace } = decided;
    const vlmMs = Date.now() - tVlm;
    // 【決策 Agent】看視覺 Agent 的描述與元件清單,決定這一步的動作(座標取自元件清單)。
    // 測試人員在畫面上直接點的位置、UI-TARS、視覺回應無法解析時不經決策。決策失敗 → 採用視覺 Agent 的建議。
    let decisionMs;
    if (team?.enabled.agent && !USE_UITARS && !pointCmd && !cmd.parseFailed && trace?.ok !== false) {
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
    const confidentInteract = (cmd.action === 'tap' || cmd.action === 'swipe') && Number.isFinite(aiConf) && aiConf >= 0.8;
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
    if (allowedActions && !escapeOverride && !allowedActions.has(cmd.action)) {
      const bad = cmd.action;
      cmd.action = 'wait'; cmd.duration = 1;
      cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined; cmd.tx = undefined; cmd.ty = undefined;
      cmd.thinking = `[操作方式限制] 「${bad}」不在本遊戲的操作方式內,未執行。` + String(cmd.thinking || '');
      cmd.override = 'control_violation';
      controlNote = `【操作方式提醒】上一步你用了「${bad}」,但本遊戲的操作方式只允許:${controls.allowedActions.join(' / ')}。請改用允許的動作(依系統提示的操作方式說明)。`;
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
      ...(snappedFrom ? { snappedFrom } : {}),
      ...(cmd.x != null ? { space: { shot: [cw, ch], device: [origW, origH] } } : {}),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotatedKey ? { annotatedKey } : {}),
      durationMs: Date.now() - t0, ...(usage ? { tokens: usage } : {}),
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
      ...(newCmds.length && !cmd.parseFailed ? { operatorCommands: newCmds.map((c) => ({ id: c.id, text: c.text })) } : {}) };
    // 決策 Agent 給這一步的目標(執行軌跡顯示「🎯 目標」;報告與除錯用)。
    const usedPlan = stepPlans.get(i);
    if (cmd.decidedBy) step.decidedBy = cmd.decidedBy;
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
    await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});
    // 指令回執:AI 這一步怎麼回應(聊天室顯示)。回應無法解析 → 不算已處理,留到下一步再送。
    if (cmd.parseFailed && newCmds.length) pendingCmds = newCmds;
    for (const c of cmd.parseFailed ? [] : newCmds) {
      await operator.ack(c, { status: 'applied', step: i, action: cmd.action, screen: screenName, reply: String(cmd.thinking || '').slice(0, 400) });
    }

    // 增量記憶地圖:建/更新當前畫面節點 + 從上一畫面的轉移邊,即時寫回供前端重繪。
    // 畫面身分用「視覺指紋 + 正規化名稱 + 模組」判斷(見 memoryGraph.mjs),AI 換說法不會長出重複節點。
    const { pageId: pid, isNew } = upsertPage(struct, { name: screenName, pHash: curPhash, module: cmd.module });
    if (isNew) await s3put(`${MEM_PREFIX}/screenshots/${pid}.png`, Buffer.from(shot, 'base64'), 'image/png').catch(() => {});
    if (prevPageId && pid) {
      // 畫面真的換了才建邊(觸發 = 上一步實際執行的動作 + 目標元件);同畫面且無變化 = 該操作失效一次。
      if (prevPageId !== pid) recordTransition(struct, prevPageId, pid, { action: navAction, target: prevTarget });
      else if (!screenChanged) recordMiss(struct, pid, { action: navAction, target: prevTarget });
    }
    struct.lastUpdatedAt = new Date().toISOString();
    await s3put(`${MEM_PREFIX}/structure.json`, JSON.stringify(struct), 'application/json').catch(() => {});

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
    // done 不是對畫面的操作:被駁回的 done(例如 AutoSpin 中想提早結束)不能算「操作了沒反應」。
    // 實測 job-mv1oqkmk:Free Spins 畫面 8 次被駁回的 done 被當成死循環 → 重啟遊戲 → 離開機台、累計局數全丟。
    const countsForLoop = cmd.action !== 'wait' && cmd.action !== 'done' && !screenLoopExempt;
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
      await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});
      controlNote = `【系統】畫面「${screenName}」操作 ${seen} 次都沒有反應(遊戲可能卡住),已重新啟動遊戲。請從第一個畫面重新進入;再遇到這個畫面時,先等它的動畫播完、主要按鈕出現後再點主要按鈕。`;
      prevAction = 'launch';
      await sleep(1000);
      continue;
    }
    if (countsForLoop && seen >= LOOP_ABORT_LIMIT) {
      finalState = 'fail';
      finalMsg = `偵測到 App 死循環:畫面「${screenName}」反覆出現 ${seen} 次仍無法前進,可能此裝置環境無法完成該步驟(如第三方登入服務不可用)。已提早結束以節省時間與成本。`;
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
    if (cmd.action === 'done' && cmd.decidedBy === 'agent' && cmd.visionSuggested && cmd.visionSuggested !== 'done' && agentDoneOverrides < 60) {
      agentDoneOverrides++;
      const back = cmd.visionSuggested;
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
        // 輔助 Agent 核對「完成」宣告:證據不足就退回繼續(最多 3 次,之後交給視覺 Agent 判斷)。
        // 測試人員正在指揮時不擋。核對失敗 / 無法核對 → 照舊結束。
        const vd = team && !operatorDirected && teamDoneRejects < 3
          ? await team.verifyDone({ index: i, observation: { screen: cmd.screen, thinking: cmd.thinking, obs: cmd.obs } }).catch(() => null)
          : null;
        if (vd && vd.ok === false) {
          teamDoneRejects++;
          cmd.action = 'wait'; cmd.duration = 2;
          cmd.x = undefined; cmd.y = undefined; cmd.x2 = undefined; cmd.y2 = undefined;
          cmd.thinking = `[拒絕假完成] 輔助 Agent 核對未通過(第 ${teamDoneRejects} 次):${vd.missing || '腳本還沒全部完成'}。` + String(cmd.thinking || '');
          cmd.override = 'reject_done';
          step.action = 'wait'; step.override = 'reject_done'; step.thinking = cmd.thinking; step.doneCheck = vd; delete step.expect;
          controlNote = `【輔助 Agent 核對】你宣告測試完成,但還缺:${vd.missing || '腳本還沒全部完成'}。請繼續完成測試腳本,不要再提早 done。`;
          stuckCount = 0;
        } else {
          if (vd) step.doneCheck = vd;
          finalState = 'pass'; finalMsg = cmd.thinking || '流程完成'; break;
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
      await s3put(`${PREFIX}/steps/${i}.json`, JSON.stringify(step), 'application/json').catch(() => {});
    }

    // 實際點擊用「裝置截圖像素」座標:把 cmd(縮圖空間)的 x/y/x2/y2 換算到 origW/origH 空間再送。
    // 這一步是消除歪斜的關鍵 —— 縮圖與裝置解析度不同,直接拿縮圖座標點會整個偏掉。
    // 搖桿預設位置依操作方式(左搖桿 / 下方中央);AI 沒給 x,y 時補上(截圖空間)。
    if (controls?.joystick && (cmd.action === 'move' || (cmd.action === 'combo' && cmd.dir)) && !Number.isFinite(cmd.x)) {
      cmd.x = Math.round(cw * controls.joystick.x); cmd.y = Math.round(ch * controls.joystick.y);
    }
    const deviceCmd = { ...cmd };
    if (cmd.tx != null && Number.isFinite(cmd.tx)) deviceCmd.tx = toDeviceX(cmd.tx);
    if (cmd.ty != null && Number.isFinite(cmd.ty)) deviceCmd.ty = toDeviceY(cmd.ty);
    if (cmd.x != null && Number.isFinite(cmd.x)) deviceCmd.x = toDeviceX(cmd.x);
    if (cmd.y != null && Number.isFinite(cmd.y)) deviceCmd.y = toDeviceY(cmd.y);
    if (cmd.x2 != null && Number.isFinite(cmd.x2)) deviceCmd.x2 = toDeviceX(cmd.x2);
    if (cmd.y2 != null && Number.isFinite(cmd.y2)) deviceCmd.y2 = toDeviceY(cmd.y2);
    // 憑證替換:僅在「輸入到裝置」時把 text 的 ${key}/secretRef 換成真值(step/trace 已存原佔位符)。
    if (deviceCmd.action === 'type' && typeof deviceCmd.text === 'string' && deviceCmd.text.length > 0) {
      try { deviceCmd.text = (await substituteText(deviceCmd.text, appCredentials)).text; }
      catch (e) { console.warn('[secrets] type 替換例外(用原文):', e?.message || e); }
    }
    // launch 沒帶 app 時(AI 想「重開遊戲」),實際關閉並重開被測 App;舊版只 activateApp(已在前景時等於什麼都沒做)。
    if (deviceCmd.action === 'launch' && !deviceCmd.app && effectivePkg) {
      try { await client.restartApp(effectivePkg); await sleep(8000); consecFail = 0; } catch (e) { console.warn('[launch] 重啟失敗', e?.message || e); }
    } else
    try {
      if (devLogsPending) { await devLogsPending; devLogsPending = null; }
      await client.act(deviceCmd);
      consecFail = 0;
      // 記下這次走位(方向 + 走位前的背景),下一步比對背景有沒有捲動。
      const moved = cmd.action === 'move' || (cmd.action === 'combo' && cmd.dir);
      const mdir = moved && !Number.isFinite(cmd.x2) ? normDir(cmd.dir ?? cmd.direction) : null;
      if (mdir && curScene) lastMove = { dir: mdir, scene: curScene };
    } catch (e) { consecFail++; if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續動作失敗'; break; } }
    prevOrient = isLandscape;
    // 導覽圖用的「上一畫面/上一動作」:AI 沒給畫面名(pid=null,如解析失敗)時沿用上一個已知畫面,
    // 且該步若只是 wait 不覆蓋真正造成轉場的動作(如先 tap Slots → 解析失敗 wait → 機台選擇)。
    prevAction = cmd.action; // 給 prompt 用:上一步實際執行的動作
    if (cmd.screen) prevScreen = screenName;
    if (pid) {
      prevPageId = pid; navAction = cmd.action;
      // runner 覆寫了動作時,AI 的 target 不代表實際操作的元件。
      prevTarget = cmd.override ? '' : (typeof cmd.target === 'string' ? cmd.target : '');
    } else if (cmd.action !== 'wait') {
      navAction = cmd.action; prevTarget = '';
    }
    // 輔助 Agent 核對上一步 + 決策 Agent 規劃下一步:在等待畫面穩定的這段時間背景進行(依序串接,不交錯)。
    if (team) {
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
          await s3put(`${PREFIX}/steps/${prevStep.index}.json`, JSON.stringify(prevStep), 'application/json').catch(() => {});
        }
        const cur = steps.find((s) => s.index === idx);
        if (rv && cur && Object.keys(rv.facts).length) {
          cur.facts = rv.facts;
          await s3put(`${PREFIX}/steps/${idx}.json`, JSON.stringify(cur), 'application/json').catch(() => {});
        }
        team.record({ index: idx, screen: observation.screen, action: actionText, effect: rv?.effect });
        await team.maybeSummarize(idx).catch(() => {});
      };
      teamPending = (teamPending ?? Promise.resolve()).then(work, work);
    }
    // 戰鬥走位中不額外等待(站著不動就會被包圍);其餘維持 3 秒讓畫面穩定。
    await sleep(lastBattleMove ? 300 : 3000);
  }

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
  if (recorder) {
    activeRecorder = null;
    await recorder.stop().catch((e) => console.warn('[record] 收尾失敗', e?.message || e));
  }
  // 等待可能仍在飛行中的最後一張 live 截圖結束,避免對已關閉 session 發請求。
  for (let w2 = 0; liveBusy && w2 < 20; w2++) await sleep(50);
  // 效能監測收尾:讀最終耗電、還原電池「未接電」模擬與 timestats(必須在 quit session 前)。
  if (perfPending) await perfPending.catch(() => null);
  if (perfShell) await perfMon.stop().catch(() => {});

  // 報告 + 終態。
  const nodes = Object.values(struct.pages).map((p) => ({ id: p.id, name: p.name, screenshotKey: `${MEM_PREFIX}/screenshots/${p.id}.png` }));
  // RTP 統計:只有案例任務要求算 RTP、且確實從 thinking 抓到可用資料時才附上 rtp 欄位,
  // 前端據此判斷要不要顯示 RTP 圖表(見 computeRtpStats 註解)。
  const rtp = isRtpTask(TASK) ? computeRtpStats(steps) : null;
  const report = { jobId: JOB, state: finalState, message: finalMsg, task: TASK, device: { w, h }, vlmModel: VLM,
    runnerVersion: RUNNER_VERSION,
    ...(evidence?.profiles ? { evidenceProfiles: evidence.profiles } : {}),
    ...(controls ? { controls: { ids: controls.ids, source: controls.source } } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(maxSegments !== 1 ? { segments: segment } : {}),
    ...(rtp ? { rtp } : {}),
    ...(perfShell ? { perfMeta: perfMon.meta(launchInfo) } : {}),
    // tokens = 三個 Agent 合計;tokensBySeat 分開記(花費依各 Agent 的模型單價分別計算)。
    ...(team ? {
      tokensBySeat: { vlm: { ...tok }, agent: { ...team.tokens.agent }, subagent: { ...team.tokens.subagent } },
      seatModels: { vlm: VLM, ...(AGENT_MODEL ? { agent: AGENT_MODEL } : {}), ...(SUBAGENT_MODEL ? { subagent: SUBAGENT_MODEL } : {}) },
    } : {}),
    stepCount: steps.length, steps, navGraph: { nodes, edges: struct.edges },
    tokens: team
      ? { input: tok.input + team.tokens.agent.input + team.tokens.subagent.input, output: tok.output + team.tokens.agent.output + team.tokens.subagent.output }
      : tok,
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
