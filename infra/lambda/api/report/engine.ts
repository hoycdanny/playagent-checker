/**
 * 報告引擎:runner 產出的原始 report.json(Evidence)+ 任務/App/案例/知識庫 →
 * 結構化測試報告(StructuredReport)。
 *
 * 流程:Selected Genres → Load & Merge Profiles(+ KB report-spec)→ Normalize Evidence →
 * Classify Findings → Calculate Metrics → Coverage/Modules/Scope → Charts → Risks →
 * Release Readiness(規則引擎)→ Summary。
 *
 * 純函式、確定性、不呼叫 LLM:同一份證據永遠產生同一份報告。讀取時計算,
 * 因此舊報告也能套用新版 profile,profile 更新不需重跑測試。
 */
import { autospinRtp, computeMetric, isInteractive, obsSeries, round2, spinTransactions, balanceChecks, type MetricContext } from './metrics.js';
import { applyExclude, mergeProfiles, metricOrigin, type MergedProfile } from './profiles.js';
import { mergeSpecs, specFromKb } from './reportSpec.js';
import { sanitizeObs, type DataQuality } from './dataQuality.js';
import { buildAcceptance } from './acceptance.js';
import type {
  Assertion,
  ChartData,
  ChartDefinition,
  CheckItem,
  CheckResult,
  CompareOp,
  CoverageItem,
  DimensionScore,
  EvidenceStep,
  FailureClass,
  Finding,
  FindingCategory,
  L10n,
  MechanicResult,
  MetricValue,
  ModuleDef,
  ModuleResult,
  OverallStatus,
  OverrideKind,
  PerfMeta,
  PerfSample,
  QualityDimension,
  ReleaseReadiness,
  ReportSpec,
  Risk,
  RuleHit,
  ScopeStatus,
  Severity,
  SlotCaptureManifest,
  StructuredReport,
  TestScopeId,
  ThresholdRef,
} from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });

// ───────── 輸入 ─────────

export interface EngineJob {
  jobId: string;
  backend?: string;
  category?: string;
  caseId?: string;
  /** 執行時的案例版本號(job 快照)。 */
  caseVersion?: string;
  caseName?: string;
  artifactVersion?: string;
  vlmModel?: string;
  agentModel?: string;
  platform?: string;
  deviceModel?: string;
  osVersion?: string;
  createdAt?: string;
  genres?: string[];
  /** 案例帶結構化測項(items:)—— 以測項為主:知識庫衍生的建議項目/風險僅供參考,不下修結論。 */
  scripted?: boolean;
}
export interface EngineApp {
  name?: string;
  version?: string;
  platform?: string;
  genre?: string;
  secondaryGenres?: string[];
}
export interface EngineKb {
  id: string;
  name: string;
  markdown?: string;
  genre?: string;
  version?: string;
  /** 自建知識庫的修訂號(每次儲存 +1)。 */
  revision?: number;
  builtin?: boolean;
  /** 結構化報告規格(知識庫頁規格編輯器寫入)。 */
  reportSpec?: unknown;
}
export interface EngineInput {
  raw: Record<string, unknown>;
  job?: EngineJob | null;
  app?: EngineApp | null;
  /** version = 執行時的不可變案例版本號(舊任務無)。 */
  testCase?: { id: string; name: string; yaml: string; version?: string } | null;
  kbs?: EngineKb[];
}

/**
 * runner 的 SPIN 迴圈逐局帳(report.json 的 rtp,method='spin-loop')。
 *
 * 只接 method='spin-loop':另一種是從 thinking 文字估的(computeRtpStats),品質不比
 * 從 steps 重建的好,不該拿來覆蓋。欄位不全(舊任務)就回 undefined,指標自動退回舊算法。
 */
function spinLoopOf(v: unknown): { rounds: number; totalBet: number; totalWin: number; rtpPercent: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o['method'] !== 'spin-loop') return undefined;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const rounds = num('rounds');
  const totalBet = num('totalBet');
  const totalWin = num('totalWin');
  const rtpPercent = num('rtpPercent');
  if (rounds === undefined || totalBet === undefined || totalWin === undefined || rtpPercent === undefined) return undefined;
  if (rounds <= 0 || totalBet <= 0) return undefined;
  return { rounds, totalBet, totalWin, rtpPercent };
}

function slotCaptureOf(v: unknown): SlotCaptureManifest | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = v as Partial<SlotCaptureManifest>;
  if (x.schemaVersion !== 1 || typeof x.machineId !== 'string' || !Array.isArray(x.spins) || !Array.isArray(x.gaps) || !x.summary) return undefined;
  return x as SlotCaptureManifest;
}

/** 從 job 快照(優先)或 App 取得類型清單;第一個為主類型。 */
export function resolveGenres(job?: EngineJob | null, app?: EngineApp | null): string[] {
  const fromJob = Array.isArray(job?.genres) ? job!.genres!.filter((g) => typeof g === 'string' && g) : [];
  if (fromJob.length) return [...new Set(fromJob)];
  const out: string[] = [];
  if (app?.genre) out.push(app.genre);
  for (const g of app?.secondaryGenres ?? []) if (g && !out.includes(g)) out.push(g);
  return out;
}

// ───────── Evidence 正規化 ─────────

const OVERRIDE_PATTERNS: Array<[RegExp, OverrideKind]> = [
  [/^\[戰鬥強制走位\]/, 'battle_move'],
  [/^\[走位被擋改向\]/, 'blocked_move'],
  [/^\[拒絕假完成\]/, 'reject_done'],
  [/^偵測到載入\/開場動畫畫面/, 'loading_wait'],
  [/脫困/, 'stuck_escape'],
  [/^(偵測到安裝\/載入畫面|連續 \d+ 步畫面沒變,先等待)/, 'stuck_wait'],
];
const OVERRIDES = new Set<OverrideKind>(['battle_move', 'reject_done', 'loading_wait', 'stuck_wait', 'stuck_escape', 'blocked_move']);
const CATEGORIES = new Set<FindingCategory>([
  'crash', 'functional', 'gameplay', 'graphics', 'animation', 'audio', 'ui', 'ux', 'performance',
  'network', 'localization', 'compatibility', 'physics', 'ai', 'save_data', 'economy',
]);
const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low']);
const PERF_KEYS = [
  'cpuPct', 'memMB', 'gfxMemMB', 'gpuPct', 'fps', 'frames', 'fpsSpanS',
  'batteryTempC', 'cpuTempC', 'gpuTempC', 'skinTempC', 'batteryMah',
] as const satisfies ReadonlyArray<Exclude<keyof PerfSample, 'frameHist'>>;

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function text(v: unknown, max = 400): string | undefined {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}
function assertionOf(v: unknown): Assertion | undefined {
  if (v === 'pass' || v === 'fail' || v === 'unclear') return v;
  if (v === true) return 'pass';
  if (v === false) return 'fail';
  return undefined;
}

/** 舊報告的 Slot 回退:從 thinking 正則抓下注/派彩(與舊 runner computeRtpStats 一致)。 */
function legacySpinObs(thinking: string | undefined): Record<string, number> | null {
  const t = String(thinking || '');
  const bet = /(?:TOTAL\s*BET|總下注|下注(?:額)?|押注|BET)\s*[:=是為]?\s*([\d,]+)/i.exec(t);
  if (!bet) return null;
  const win = /(?:WIN|贏得|派彩|中獎)\s*[:=是為]?\s*([\d,]+)/i.exec(t);
  const b = Number(bet[1]!.replace(/,/g, ''));
  if (!Number.isFinite(b) || b <= 0) return null;
  const w = win ? Number(win[1]!.replace(/,/g, '')) : 0;
  return { bet: b, win: Number.isFinite(w) ? w : 0 };
}

/** report.json 的 perfMeta(runner 效能中繼資料)→ 型別安全的 PerfMeta。 */
function readPerfMeta(v: unknown): PerfMeta | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: PerfMeta = {};
  if (typeof o['source'] === 'string') out.source = o['source'].slice(0, 20);
  const cores = num(o['cores']); if (cores !== undefined) out.cores = cores;
  const cap = num(o['batteryCapacityMah']); if (cap !== undefined && cap > 0) out.batteryCapacityMah = cap;
  const mah = num(o['batteryMah']); if (mah !== undefined && mah >= 0) out.batteryMah = mah;
  const l = o['launch'] as Record<string, unknown> | undefined;
  if (l && typeof l === 'object') {
    const launch: NonNullable<PerfMeta['launch']> = {};
    if (typeof l['at'] === 'string' && Number.isFinite(Date.parse(l['at']))) launch.at = l['at'];
    const t = num(l['totalTimeMs']); if (t !== undefined && t >= 0) launch.totalTimeMs = t;
    if (typeof l['state'] === 'string') launch.state = l['state'].slice(0, 12);
    if (Object.keys(launch).length) out.launch = launch;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSteps(rawSteps: unknown, opts: { legacySlot: boolean }): EvidenceStep[] {
  if (!Array.isArray(rawSteps)) return [];
  const out: EvidenceStep[] = [];
  const prevResults: Array<Assertion | undefined> = [];
  const changed: Array<boolean | undefined> = [];
  rawSteps.forEach((r, i) => {
    if (typeof r !== 'object' || r === null) return;
    const s = r as Record<string, unknown>;
    const action = text(s['action'], 40);
    if (!action) return;
    const thinking = text(s['thinking'] ?? s['reason'], 1200);
    const idx = num(s['index']) ?? num(s['stepNumber']) ?? i;
    const step: EvidenceStep = {
      index: idx,
      screen: text(s['screen'], 120) || `#${idx}`,
      action,
    };
    if (typeof s['at'] === 'string') step.at = s['at'];
    const seg = num(s['segment']);
    if (seg !== undefined && seg >= 1) step.segment = Math.floor(seg);
    if (thinking) step.thinking = thinking;
    const x = num(s['x']) ?? num((s['coords'] as Record<string, unknown> | undefined)?.['x']);
    const y = num(s['y']) ?? num((s['coords'] as Record<string, unknown> | undefined)?.['y']);
    if (x !== undefined && y !== undefined) { step.x = x; step.y = y; }
    const shot = (s['space'] as { shot?: unknown } | undefined)?.shot;
    if (Array.isArray(shot) && shot.length === 2) {
      const w = num(shot[0]); const h = num(shot[1]);
      if (w && h) step.shotSize = [w, h];
    }
    const expect = text(s['expect'], 200);
    if (expect) step.expect = expect;
    const conf = num(s['conf'] ?? s['confidence']);
    if (conf !== undefined) step.confidence = Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf));
    const module = text(s['module'], 40);
    if (module) step.module = module;
    const mechanic = text(s['mechanic'], 40);
    if (mechanic) step.mechanic = mechanic;
    // runner 的 SPIN 迴圈會記下這一局有沒有真的等到「盤面 + 數字列都靜止」才讀數字。
    const settle = (s['rtpRound'] as Record<string, unknown> | undefined)?.['settle'];
    if (typeof settle === 'string') step.settled = settle === 'still';
    if (typeof s['obs'] === 'object' && s['obs'] !== null && !Array.isArray(s['obs'])) {
      const o: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(s['obs'] as Record<string, unknown>)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
        if (typeof v === 'boolean') o[k] = v;
        else if (num(v) !== undefined) o[k] = num(v)!;
        else if (typeof v === 'string' && v.length <= 60) o[k] = v;
      }
      if (Object.keys(o).length) step.obs = o;
    }
    if (opts.legacySlot && !step.obs) {
      const lo = legacySpinObs(thinking);
      if (lo) step.obs = lo;
    }
    const iss = s['issue'] as Record<string, unknown> | undefined;
    if (iss && typeof iss === 'object') {
      const cat = (text(iss['cat'] ?? iss['category'], 20) ?? '').toLowerCase() as FindingCategory;
      const sev = (text(iss['sev'] ?? iss['severity'], 10) ?? '').toLowerCase() as Severity;
      const title = text(iss['title'], 160);
      if (title && CATEGORIES.has(cat)) {
        step.issue = { category: cat, severity: SEVERITIES.has(sev) ? sev : 'medium', title };
        const box = iss['box'];
        if (Array.isArray(box) && box.length === 4 && box.every((b) => num(b) !== undefined)) {
          step.issue.box = box.map((b) => num(b)!) as [number, number, number, number];
        }
      }
    }
    const ov = text(s['override'], 20) as OverrideKind | undefined;
    if (ov && OVERRIDES.has(ov)) step.override = ov;
    else if (thinking) {
      for (const [re, kind] of OVERRIDE_PATTERNS) if (re.test(thinking)) { step.override = kind; break; }
    }
    if (s['parseFailed'] === true || /^無法解析回應/.test(thinking ?? '')) step.parseFailed = true;
    if (s['modelError'] === true || /^模型呼叫失敗/.test(thinking ?? '')) step.modelError = true;
    if (s['foregroundLost'] === true) step.foregroundLost = true;
    const appState = num(s['appState']);
    if (appState !== undefined) step.appState = appState;
    const perf = s['perf'] as Record<string, unknown> | undefined;
    if (perf && typeof perf === 'object') {
      const p: PerfSample = {};
      for (const k of PERF_KEYS) {
        const v = num(perf[k]);
        if (v !== undefined && v >= 0) p[k] = v;
      }
      const hist = perf['frameHist'];
      if (hist && typeof hist === 'object' && !Array.isArray(hist)) {
        const h: Record<string, number> = {};
        for (const [ms, n] of Object.entries(hist as Record<string, unknown>)) {
          const c = num(n);
          if (/^\d{1,5}$/.test(ms) && c !== undefined && c > 0) h[ms] = c;
        }
        if (Object.keys(h).length) p.frameHist = h;
      }
      if (Object.keys(p).length) step.perf = p;
    }
    const d = num(s['durationMs']); if (d !== undefined) step.durationMs = d;
    const v = num(s['vlmMs']); if (v !== undefined) step.vlmMs = v;
    if (typeof s['screenshotKey'] === 'string') step.screenshotKey = s['screenshotKey'];
    if (typeof s['annotatedKey'] === 'string') step.annotatedKey = s['annotatedKey'];
    // 接管模式的手動操作:runner 寫 by='operator' + takeover=true。
    // 沒讀出來的話欄位永遠是空的,指標也就永遠排除不掉(這是加這段的唯一理由)。
    if (s['by'] === 'operator' || s['takeover'] === true) step.by = 'operator';
    out.push(step);
    prevResults.push(assertionOf(s['prevResult']));
    changed.push(typeof s['screenChanged'] === 'boolean' ? (s['screenChanged'] as boolean) : undefined);
  });
  // 本步的 prevResult / screenChanged 是「上一步」的 Actual + Assertion:回填到上一步。
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    cur.prevAction = prev.action;
    prev.actual = cur.screen;
    const a = prevResults[i];
    if (a && prev.expect) prev.assertion = a;
    if (changed[i] !== undefined) prev.effective = changed[i];
  }
  return out;
}

// ───────── 模組/機制歸屬 ─────────

function attributeModule(step: EvidenceStep, modules: ModuleDef[]): { id: string; basis: 'ai' | 'inferred' } | null {
  if (step.module && modules.some((m) => m.id === step.module)) return { id: step.module, basis: 'ai' };
  const s = step.screen.toLowerCase();
  // 長關鍵字優先(避免 'game' 這種寬鬆字搶走更精確的模組)。
  let best: { id: string; len: number } | null = null;
  for (const m of modules) {
    for (const k of m.keywords) {
      if (k && s.includes(k.toLowerCase()) && (!best || k.length > best.len)) best = { id: m.id, len: k.length };
    }
  }
  return best ? { id: best.id, basis: 'inferred' } : null;
}

const GAME_STATES: Array<{ id: string; label: L10n; keywords: string[] }> = [
  { id: 'main_menu', label: L('主選單/大廳', 'Main Menu'), keywords: ['menu', '選單', '大廳', 'lobby', 'home', '主畫面', '主城'] },
  { id: 'gameplay', label: L('遊戲進行', 'Gameplay'), keywords: ['battle', '戰鬥', 'stage', 'wave', 'reel', '轉軸', 'play', 'game', '關卡', 'match', '對戰'] },
  { id: 'pause', label: L('暫停', 'Pause'), keywords: ['pause', '暫停'] },
  { id: 'loading', label: L('載入', 'Loading'), keywords: ['loading', '載入', '载入', 'logo', 'splash', '開場'] },
  { id: 'game_over', label: L('失敗/Game Over', 'Game Over'), keywords: ['game over', 'fail', 'defeat', '失敗', '死亡'] },
  { id: 'victory', label: L('勝利/過關', 'Victory'), keywords: ['victory', 'win', 'clear', '勝利', '過關'] },
  { id: 'disconnected', label: L('斷線', 'Disconnected'), keywords: ['disconnect', '斷線', 'network error', '網路', 'connection'] },
  { id: 'reconnect', label: L('重連', 'Reconnect'), keywords: ['reconnect', '重連', 'retry', '重試'] },
];

function gameStateOf(screen: string): string | null {
  const s = screen.toLowerCase();
  for (const g of GAME_STATES) if (g.keywords.some((k) => s.includes(k))) return g.id;
  return null;
}

// ───────── Findings ─────────

interface TerminalVerdict {
  classification?: FailureClass;
  blocked: boolean;
  finding?: Omit<Finding, 'id' | 'stepsToReproduce' | 'status' | 'frequency' | 'reproducibility'>;
  reason: L10n;
}

function classifyTerminal(state: string, message: string | undefined, steps: EvidenceStep[]): TerminalVerdict {
  const msg = message ?? '';
  const last = steps[steps.length - 1];
  const base = { firstStep: last?.index, lastStep: last?.index, gameState: last?.screen, screenshotKey: last?.screenshotKey, annotatedKey: last?.annotatedKey };
  if (state === 'pass') return { blocked: false, reason: L('AI 完成測試目標', 'AI completed the test goal') };
  if (state === 'cancelled') return { blocked: true, reason: L('使用者取消,測試未完成', 'Cancelled by user; test incomplete') };
  if (state === 'budget_exceeded') return { blocked: true, reason: L('達預算上限,測試未完成', 'Budget limit reached; test incomplete') };
  if (/執行時間上限/.test(msg)) return { blocked: true, reason: L('達執行時間上限(Device Farm 單次連線最長 150 分鐘),已提前收尾,測試未完成', 'Run-time limit reached (Device Farm sessions last at most 150 minutes); wrapped up early, test incomplete') };
  if (/達步數上限/.test(msg)) return { blocked: true, reason: L('達步數上限仍未完成目標,無法判定遊戲是否有問題', 'Step limit reached before goal; inconclusive') };
  // 測項時間盒(runner 測項為主):某一項在上限次數內做不到 → Blocked,指出卡在哪一項,交給人判斷。
  if (/測項卡住\(Blocked\)/.test(msg)) {
    const item = /第 (\d+)\/(\d+) 項「([^」]*)」/.exec(msg);
    const where = item ? `第 ${item[1]}/${item[2]} 項「${item[3]}」` : '某個測項';
    const whereEn = item ? `item ${item[1]}/${item[2]} "${item[3]}"` : 'a test item';
    return {
      blocked: true,
      classification: 'NEEDS_TRIAGE',
      reason: L(`${where}在操作上限內沒有完成,測試已停止(Blocked),需人工判讀是遊戲問題還是 AI 找不到做法`, `${whereEn} was not completed within its step budget; stopped as Blocked — needs triage (game issue or AI could not find a way)`),
      finding: { ...base, title: L(`測項卡住:${where}`, `Blocked: ${whereEn}`), description: L(msg, msg), severity: 'medium', category: 'functional', classification: 'NEEDS_TRIAGE', certainty: 'deterministic' },
    };
  }
  if (/VLM 連續 \d+ 次回應無法解析/.test(msg) || last?.modelError) {
    return {
      blocked: true,
      classification: 'AI_TEST_FAILURE',
      reason: L('AI 測試代理本身失敗(模型輸出/呼叫異常),不是遊戲缺陷', 'The AI test agent failed (model output/call error); not a game defect'),
      finding: { ...base, title: L('AI 模型輸出/呼叫異常', 'AI model output / call failure'), description: L(msg || '模型呼叫失敗', msg || 'Model call failed'), severity: 'high', category: 'ai', classification: 'AI_TEST_FAILURE', certainty: 'deterministic' },
    };
  }
  if (/連續截圖失敗|連續動作失敗|Appium|Device Farm|session|ECONN|timeout/i.test(msg) || (state === 'error' && !/畫面|wait|死循環/.test(msg))) {
    return {
      blocked: true,
      classification: 'ENVIRONMENT',
      reason: L('測試環境(裝置/連線)異常中止,不是遊戲缺陷', 'Test environment (device/connection) failure; not a game defect'),
      finding: { ...base, title: L('測試環境異常', 'Test environment failure'), description: L(msg, msg), severity: 'high', category: 'compatibility', classification: 'ENVIRONMENT', certainty: 'deterministic' },
    };
  }
  if (/死循環/.test(msg)) {
    // 舊版 runner 的訊息固定附帶「(如第三方登入服務不可用)」,不能當作登入證據;
    // 只看畫面名稱(「」內)是否為登入頁。
    const screenInMsg = msg.match(/畫面「([^」]*)」/)?.[1] ?? '';
    const login = /登入|登录|login|sign\s*in|facebook|google/i.test(screenInMsg);
    const dmsg = login ? msg : msg.replace(/,可能此裝置環境無法完成該步驟\(如第三方登入服務不可用\)。/, ',可能是遊戲卡住、AI 找不到下一步或操作沒有效果。');
    return {
      blocked: true,
      classification: 'NEEDS_TRIAGE',
      reason: login
        ? L('卡在登入流程(可能為裝置環境不支援第三方登入),需人工判讀', 'Stuck in login (likely unsupported third-party login on device); needs triage')
        : L('同一畫面反覆無法前進,可能是遊戲死路或 AI 找不到出口,需人工判讀', 'Repeated screen without progress: game dead end or AI could not find a way; needs triage'),
      finding: { ...base, title: login ? L('登入流程無法完成', 'Login flow cannot complete') : L('流程死循環/Dead End', 'Flow loop / dead end'), description: L(dmsg, msg), severity: 'high', category: login ? 'functional' : 'ux', classification: 'NEEDS_TRIAGE', certainty: 'deterministic', suspectedCause: login ? L('裝置缺 Google/Facebook 登入環境', 'Device lacks third-party login environment') : L('遊戲無出口或 AI 定位錯誤', 'No exit in game or AI mislocated controls') },
    };
  }
  if (/無變化|wait \d+ 次/.test(msg)) {
    const loading = /安裝|載入|配置下載/.test(msg);
    return {
      blocked: true,
      classification: 'NEEDS_TRIAGE',
      reason: loading
        ? L('長時間停在安裝/載入畫面,可能是遊戲啟動或資源下載失敗,需人工判讀', 'Stuck on install/loading; possible launch or asset download failure; needs triage')
        : L('畫面長時間無變化,可能凍結或 AI 無法操作,需人工判讀', 'Screen unchanged for long; possible freeze or AI could not operate; needs triage'),
      finding: { ...base, title: loading ? L('啟動/載入逾時', 'Launch / loading timeout') : L('畫面凍結/無回應', 'Screen frozen / unresponsive'), description: L(msg, msg), severity: 'critical', category: 'performance', classification: 'NEEDS_TRIAGE', certainty: 'deterministic' },
    };
  }
  return {
    blocked: true,
    classification: 'NEEDS_TRIAGE',
    reason: L('測試未通過,原因需人工判讀', 'Test did not pass; cause needs triage'),
    finding: { ...base, title: L('測試未通過', 'Test did not pass'), description: L(msg || state, msg || state), severity: 'medium', category: 'functional', classification: 'NEEDS_TRIAGE', certainty: 'deterministic' },
  };
}

/** 連線 / 帳號環境類回報(斷線、重連、另一裝置登入、逾時)。 */
const ENV_ISSUE = /斷線|断线|連線|连线|重連|重连|reconnect|disconnect|lost\s*connection|connection|network|網路|网络|另一裝置|另一个设备|another\s*device|逾時|timeout|伺服器|server/i;
const allTitlesOf = (list: EvidenceStep[]) => [...new Set(list.map((s) => s.issue!.title))].join(' ');

/** AI 回報「按了沒反應」類缺陷的字樣(需要操作紀錄佐證)。 */
const UNRESPONSIVE_CLAIM = /無反應|沒反應|没反应|沒有反應|沒有回應|點擊.{0,6}無效|點不動|按不下|按了沒|unresponsive|no\s+response|not\s+respond|doesn'?t\s+respond|does\s+not\s+respond/i;

function reproLabel(freq: number, opportunities: number): Finding['reproducibility'] {
  if (freq <= 1) return 'single';
  const r = opportunities > 0 ? freq / opportunities : 0;
  if (r >= 0.9) return 'always';
  if (r >= 0.5) return 'frequent';
  if (r >= 0.2) return 'intermittent';
  return 'rare';
}

function stepsBefore(steps: EvidenceStep[], index: number, n = 5): string[] {
  const pos = steps.findIndex((s) => s.index === index);
  const slice = steps.slice(Math.max(0, pos - n), pos + 1);
  return slice.map((s) => `#${s.index} ${s.screen} → ${s.action}${s.x !== undefined ? ` (${s.x},${s.y})` : ''}`);
}

function buildFindings(steps: EvidenceStep[], terminal: TerminalVerdict, moduleOf: (s: EvidenceStep) => string | undefined, testCaseId?: string, quality?: DataQuality) {
  const findings: Finding[] = [];
  const aiFailures: Finding[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${String(++seq).padStart(3, '0')}`;

  // (a) AI 回報的畫面缺陷:依「畫面 + 類別族群」彙總頻率。
  // 實測(job-mus3e5cp-4po0p4):同一個「大廳機台列表空白」被 AI 每步用不同措辭、
  // 時而歸 functional 時而歸 network 回報,若以標題分組會拆成 3 個缺陷、各只出現 1 次。
  // 改以畫面名 + 類別族群(功能類 / 視覺類 / UX / 效能 …)分組,標題取最常見者。
  const family = (c: FindingCategory): string =>
    ['functional', 'network', 'gameplay', 'save_data', 'economy', 'physics', 'ai'].includes(c) ? 'function'
      : ['graphics', 'animation', 'ui'].includes(c) ? 'visual'
        : c;
  const groups = new Map<string, EvidenceStep[]>();
  for (const s of steps) {
    if (!s.issue) continue;
    const key = `${s.screen}|${family(s.issue.category)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const list of groups.values()) {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    // 代表標題/類別:取出現最多次者(同次數取最早)。
    const mostCommon = <T,>(vals: T[]): T => {
      const cnt = new Map<T, number>();
      for (const v of vals) cnt.set(v, (cnt.get(v) ?? 0) + 1);
      return [...cnt].sort((a, b) => b[1] - a[1])[0]![0];
    };
    const iss = {
      ...first.issue!,
      title: mostCommon(list.map((s) => s.issue!.title)),
      category: mostCommon(list.map((s) => s.issue!.category)),
      box: list.find((s) => s.issue!.box)?.issue!.box,
    };
    const variants = [...new Set(list.map((s) => s.issue!.title))].filter((t) => t !== iss.title);
    const confs = list.map((s) => s.confidence).filter((c): c is number => typeof c === 'number');
    const conf = confs.length ? round2(confs.reduce((a, b) => a + b, 0) / confs.length) : undefined;
    // AI 觀察型缺陷要「可重現」才算 GAME_FAILURE(驗收標準 PA-AS §4):至少 2 個步驟都看到、平均信心 ≥ 0.5。
    // 只看到一次(即使信心很高)→ 待判讀:會讓結論變「通過(有風險)」,不會單憑一張截圖判遊戲失敗。
    let confirmed = list.length >= 2 && (conf === undefined || conf >= 0.5);
    // 斷線 / 連線錯誤 / 帳號在另一裝置登入:雲端真機的網路與帳號狀態是測試環境的一部分,
    // AI 看到彈窗無法分辨是伺服器問題還是環境 → 一律待判讀(需要對照伺服器紀錄或在穩定網路重現)。
    const envLike = iss.category === 'network' || ENV_ISSUE.test(allTitlesOf(list));
    if (envLike) confirmed = false;
    const sevRank: Severity[] = ['critical', 'high', 'medium', 'low'];
    const severity = list.map((s) => s.issue!.severity).sort((a, b) => sevRank.indexOf(a) - sevRank.indexOf(b))[0]!;
    // 「按了沒反應」類的回報必須有實際操作紀錄佐證:回報前 8 步內要有點擊 / 長按等動作,且至少一次畫面沒變。
    // 2026-10-12 job-mv3xfeax:AI 回報「減注鈕多次點擊無反應」(High),但第 78–95 步實際執行的全是 wait,
    // 減注鈕一次都沒按過 —— 舊規則照樣當成已確認缺陷,報告判「失敗」。沒有操作紀錄 → 是 AI 回報錯誤,不是遊戲缺陷。
    const allTitles = allTitlesOf(list);
    if (UNRESPONSIVE_CLAIM.test(allTitles)) {
      const from = first.index - 8;
      const window = steps.filter((s) => s.index >= from && s.index <= first.index);
      const tried = window.filter(isInteractive);
      if (tried.length === 0) {
        const acts = [...new Set(window.map((s) => s.action))].join(' / ');
        aiFailures.push({
          id: nextId('AIF'),
          title: L('AI 回報的缺陷沒有對應的操作紀錄', 'AI-reported defect has no matching action'),
          description: L(
            `AI 在第 ${first.index}${last.index !== first.index ? `–${last.index}` : ''} 步回報「${iss.title}」,但第 ${Math.max(0, from)}–${first.index} 步實際執行的動作只有 ${acts},沒有任何點擊 / 長按紀錄。此回報不能當成遊戲缺陷;同時代表 AI 的畫面描述與實際操作不一致。`,
            `At step ${first.index}${last.index !== first.index ? `–${last.index}` : ''} the AI reported "${iss.title}", but steps ${Math.max(0, from)}–${first.index} only executed ${acts} — no tap / hold at all. This is not a game defect, and the AI's narrative disagrees with the recorded actions.`,
          ),
          severity: 'medium',
          category: 'ai',
          classification: 'AI_TEST_FAILURE',
          certainty: 'deterministic',
          gameState: first.screen,
          frequency: list.length,
          reproducibility: list.length > 1 ? 'frequent' : 'single',
          firstStep: first.index,
          lastStep: last.index,
          stepsToReproduce: stepsBefore(steps, first.index, 8),
          ...(first.screenshotKey ? { screenshotKey: first.screenshotKey } : {}),
          status: 'open',
        });
        continue;
      }
      if (!tried.some((s) => s.effective === false)) confirmed = false;
      // 「卡死 / 沒反應」= 只有重啟才救得回來。回報之後、在任何重啟之前,同一畫面的操作又生效了(畫面有變)
      // → 回報被後續證據推翻(常見原因:AI 座標偏移、截圖尺寸改變、動畫未結束),只能列待判讀。
      for (const s of steps) {
        if (s.index <= first.index) continue;
        // 重啟 = launch、runner 重啟 App、或程序已終止後被拉起(只是退到背景再拉回前景不算重啟)。
        const relaunched = s.foregroundLost && (s.appState === undefined || s.appState <= 1);
        if (s.action === 'launch' || relaunched || /runner 重啟 App/.test(s.thinking ?? '')) break;
        if (s.screen === first.screen && isInteractive(s) && s.effective === true) { confirmed = false; break; }
      }
    }
    findings.push({
      id: nextId('DEF'),
      title: L(iss.title, iss.title),
      description: L(
        `AI 於 ${list.length} 個步驟觀察到此問題(畫面:${first.screen})。${variants.length ? `其他描述:${variants.slice(0, 3).join(';')}` : ''}`,
        `Observed by AI in ${list.length} step(s) (screen: ${first.screen}).${variants.length ? ` Other wording: ${variants.slice(0, 3).join('; ')}` : ''}`,
      ),
      severity,
      category: iss.category,
      classification: confirmed ? 'GAME_FAILURE' : 'NEEDS_TRIAGE',
      certainty: 'ai_evaluation',
      ...(moduleOf(first) ? { module: moduleOf(first) } : {}),
      gameState: first.screen,
      frequency: list.length,
      reproducibility: reproLabel(list.length, steps.filter((s) => s.screen === first.screen).length),
      firstStep: first.index,
      lastStep: last.index,
      ...(first.expect ? { expected: first.expect } : {}),
      actual: iss.title,
      stepsToReproduce: stepsBefore(steps, first.index),
      ...(first.screenshotKey ? { screenshotKey: first.screenshotKey } : {}),
      ...(first.annotatedKey ? { annotatedKey: first.annotatedKey } : {}),
      ...(iss.box ? { box: iss.box } : {}),
      ...((list.find((s) => s.issue!.box)?.shotSize ?? first.shotSize) ? { shotSize: (list.find((s) => s.issue!.box)?.shotSize ?? first.shotSize)! } : {}),
      ...(conf !== undefined ? { aiConfidence: conf } : {}),
      ...(testCaseId ? { relatedTestCase: testCaseId } : {}),
      status: 'open',
    });
  }

  // (b) 餘額一致性(程式規則,數值由 AI 讀取)。
  const txns = spinTransactions(steps);
  // AutoSpin 模式(餘額差法)下觀測不是逐次 spin,不做逐次餘額比對(見 metrics.balance_checks)。
  const bc = autospinRtp(steps)
    ? { checked: 0, mismatches: [] as typeof txns, plausible: [] as typeof txns, misread: [] as typeof txns, skippedChainBreaks: 0, preCredit: [] as typeof txns }
    : balanceChecks(txns);
  if (bc.mismatches.length > 0) {
    const first = (bc.plausible[0] ?? bc.mismatches[0])!;
    const st = steps.find((s) => s.index === first.step);
    // 升級成「已確認的遊戲缺陷」的條件(PA-AS §4「可重現才算已確認」的量化版):
    // 量級合理的不一致 ≥ 3 次,而且佔可比對次數 > 20%。數字是 AI 讀來的,單一來源沒有交叉驗證,
    // 低比例的不一致更可能是讀數誤差 —— 原本只要 2 次就判 GAME_FAILURE,實測兩個任務都因此
    // 被判失敗(job-mvc3jedr 29 次裡 2 次、job-mvc3knmo 86 次裡 11 次,後者多數是看錯位數)。
    const rate = bc.checked ? bc.plausible.length / bc.checked : 0;
    const confirmed = bc.plausible.length >= 3 && rate > 0.2;
    findings.push({
      id: nextId('DEF'),
      title: confirmed
        ? L('餘額與下注/派彩不一致', 'Balance does not match bet / payout')
        : L('餘額對帳有疑點(數值可信度不足)', 'Balance reconciliation anomaly (readings not reliable enough)'),
      description: L(
        `${bc.checked} 次可比對的 Spin 中有 ${bc.mismatches.length} 次「前餘額 − 下注 + 派彩 ≠ 後餘額」`
        + `(量級合理 ${bc.plausible.length} 次;差額超過投注額 100 倍、判定為讀數誤差 ${bc.misread.length} 次)。`
        + `數值由 AI 從畫面讀取,只有單一來源,${confirmed ? '不一致的比例與次數已達可確認門檻。' : '尚不足以判定為遊戲帳務錯誤,需人工判讀。'}`,
        `${bc.mismatches.length} of ${bc.checked} comparable spins violate prev − bet + win = balance `
        + `(${bc.plausible.length} with a plausible magnitude; ${bc.misread.length} off by more than 100× the bet and treated as read errors). `
        + `Values come from a single source (AI reading the screen); ${confirmed ? 'the rate and count meet the confirmation threshold.' : 'this is not yet enough to call it a game accounting bug and needs triage.'}`,
      ),
      severity: confirmed ? 'critical' : 'medium',
      category: 'economy',
      classification: confirmed ? 'GAME_FAILURE' : 'NEEDS_TRIAGE',
      certainty: 'deterministic',
      module: 'reels',
      gameState: st?.screen,
      frequency: bc.mismatches.length,
      reproducibility: reproLabel(bc.plausible.length, bc.checked),
      firstStep: first.step,
      lastStep: (bc.plausible[bc.plausible.length - 1] ?? bc.mismatches[bc.mismatches.length - 1])!.step,
      expected: L('前餘額 − 下注 + 派彩', 'prev − bet + win').zh,
      actual: `balance=${first.balance}, bet=${first.bet}, win=${first.win}`,
      stepsToReproduce: stepsBefore(steps, first.step),
      ...(st?.screenshotKey ? { screenshotKey: st.screenshotKey } : {}),
      ...(testCaseId ? { relatedTestCase: testCaseId } : {}),
      status: 'open',
    });
  }

  // (b2) 投注額在測試中改變(確定性規則;每一次變更都列出步驟與前後值)。
  if (quality?.betChanges.length) {
    const ch = quality.betChanges;
    const first = ch[0]!;
    const st = steps.find((s) => s.index === first.step);
    const list = ch.slice(0, 6).map((c) => `#${c.step}:${c.from.toLocaleString('en-US')} → ${c.to.toLocaleString('en-US')}`).join(';');
    findings.push({
      id: nextId('DEF'),
      title: L('投注額在測試中改變', 'Bet amount changed during the test'),
      description: L(
        `投注額共變更 ${ch.length} 次(${list})。若測試腳本要求固定投注額,這段期間的 RTP 會受影響;RTP 已依投注額分段計算。常見原因:App 重啟後沿用其他投注設定、AI 誤觸投注鈕。`,
        `The bet changed ${ch.length} time(s) (${list}). If the script requires a fixed bet, RTP for this period is affected; RTP is computed per bet level. Common causes: different bet settings after an app restart, or the AI touching the bet button.`,
      ),
      severity: 'medium',
      category: 'economy',
      classification: 'NEEDS_TRIAGE',
      certainty: 'deterministic',
      gameState: st?.screen,
      frequency: ch.length,
      reproducibility: reproLabel(ch.length, ch.length),
      firstStep: first.step,
      lastStep: ch[ch.length - 1]!.step,
      expected: `bet = ${first.from.toLocaleString('en-US')}(#${first.prevStep})`,
      actual: `bet = ${first.to.toLocaleString('en-US')}(#${first.step})`,
      stepsToReproduce: stepsBefore(steps, first.step),
      ...(st?.screenshotKey ? { screenshotKey: st.screenshotKey } : {}),
      ...(testCaseId ? { relatedTestCase: testCaseId } : {}),
      status: 'open',
    });
  }

  // (c) App 離開前景:AI 按 back 退出 = AI 失敗;程序未執行 = 疑似閃退;背景 = 跳到其他 App。
  for (const s of steps.filter((x) => x.foregroundLost)) {
    const appState = s.appState;
    // AI 主動 launch(重啟)造成的前景切換是刻意操作,不算缺陷。
    if (s.prevAction === 'launch') continue;
    if (s.prevAction === 'back') {
      aiFailures.push(aiFinding(nextId('AIF'), s, L('AI 按 back 退出遊戲', 'AI pressed back and exited the game'), L('App 被 AI 的 back 操作退到背景,runner 已拉回前景。', 'The AI back action sent the app to background; runner restored it.'), 'low', steps));
      continue;
    }
    const crashed = appState === undefined || appState <= 1;
    findings.push({
      id: nextId('DEF'),
      title: crashed ? L('疑似閃退(App 程序未執行)', 'Suspected crash (app process not running)') : L('App 跳到其他畫面/App', 'App left to another app'),
      description: crashed
        ? L(`第 ${s.index} 步前偵測到 App 不在執行中(上一步動作:${s.prevAction ?? '?'}),runner 已重新啟動。`, `Before step ${s.index} the app was not running (previous action: ${s.prevAction ?? '?'}); runner relaunched it.`)
        : L(`第 ${s.index} 步前偵測到 App 被切到背景(常見:廣告/外部連結),runner 已拉回。`, `Before step ${s.index} the app was in background (often ads/external links); runner restored it.`),
      severity: crashed ? 'critical' : 'low',
      category: crashed ? 'crash' : 'ux',
      classification: crashed && appState !== undefined ? 'GAME_FAILURE' : 'NEEDS_TRIAGE',
      certainty: 'deterministic',
      gameState: s.screen,
      frequency: 1,
      reproducibility: 'single',
      firstStep: s.index,
      lastStep: s.index,
      stepsToReproduce: stepsBefore(steps, s.index),
      ...(s.screenshotKey ? { screenshotKey: s.screenshotKey } : {}),
      ...(testCaseId ? { relatedTestCase: testCaseId } : {}),
      status: 'open',
    });
  }

  // (d) 終局判定。
  if (terminal.finding) {
    const f: Finding = {
      ...terminal.finding,
      id: nextId(terminal.finding.classification === 'AI_TEST_FAILURE' ? 'AIF' : 'DEF'),
      frequency: 1,
      reproducibility: 'single',
      stepsToReproduce: terminal.finding.lastStep !== undefined ? stepsBefore(steps, terminal.finding.lastStep) : [],
      ...(testCaseId ? { relatedTestCase: testCaseId } : {}),
      status: 'open',
    };
    if (f.classification === 'AI_TEST_FAILURE' || f.classification === 'ENVIRONMENT') aiFailures.push(f);
    else findings.push(f);
  }

  // (e) AI 測試品質問題(不是遊戲缺陷)。
  const parseFails = steps.filter((s) => s.parseFailed);
  if (parseFails.length) aiFailures.push(aiFinding(nextId('AIF'), parseFails[0]!, L('AI 回應無法解析', 'AI response could not be parsed'), L(`共 ${parseFails.length} 步模型輸出不是有效動作 JSON。`, `${parseFails.length} step(s) produced no valid action JSON.`), 'medium', steps, parseFails.length));
  const forcedDone = steps.filter((s) => s.override === 'reject_done');
  if (forcedDone.length) aiFailures.push(aiFinding(nextId('AIF'), forcedDone[0]!, L('AI 提前宣告完成(已被攔截)', 'AI declared done prematurely (intercepted)'), L(`AI 在目標未達成時 ${forcedDone.length} 次想結束測試,runner 攔截並要求繼續。`, `AI tried to finish ${forcedDone.length} time(s) before the goal was met; runner intercepted.`), 'medium', steps, forcedDone.length));
  const battleFix = steps.filter((s) => s.override === 'battle_move');
  if (battleFix.length) aiFailures.push(aiFinding(nextId('AIF'), battleFix[0]!, L('戰鬥中 AI 未用移動(已被修正)', 'AI did not move during combat (corrected)'), L(`${battleFix.length} 步 AI 在戰鬥中選擇點擊/等待,runner 改為搖桿移動。`, `${battleFix.length} step(s) where AI tapped/waited in combat; runner converted to joystick move.`), 'low', steps, battleFix.length));
  const blockedFix = steps.filter((s) => s.override === 'blocked_move');
  if (blockedFix.length) aiFailures.push(aiFinding(nextId('AIF'), blockedFix[0]!, L('AI 重複往被擋住的方向走(已改向)', 'AI kept moving into an obstacle (redirected)'), L(`${blockedFix.length} 步 AI 往上一步已被障礙物擋住的方向推搖桿,runner 改走其他方向。`, `${blockedFix.length} step(s) where AI pushed the joystick toward a blocked direction; runner redirected.`), 'low', steps, blockedFix.length));
  const escapes = steps.filter((s) => s.override === 'stuck_escape');
  if (escapes.length) aiFailures.push(aiFinding(nextId('AIF'), escapes[0]!, L('AI 找不到可互動元件(runner 脫困)', 'AI could not find an interactive element (runner escape)'), L(`runner 共 ${escapes.length} 次介入掃描/返回以脫困。`, `Runner intervened ${escapes.length} time(s) to escape.`), 'low', steps, escapes.length));
  const lowEff = steps.filter((s) => isInteractive(s) && s.effective === false && s.assertion !== 'pass');
  if (lowEff.length >= 5) aiFailures.push(aiFinding(nextId('AIF'), lowEff[0]!, L('多次無效點擊', 'Many ineffective actions'), L(`${lowEff.length} 個操作後畫面沒有變化(可能座標偏移或點到非互動區)。`, `${lowEff.length} action(s) produced no visible change (likely coordinate offset or non-interactive area).`), 'low', steps, lowEff.length));

  return { findings, aiFailures };
}

// ───────── 修正建議(確定性模板)─────────

/**
 * 依歸因 + 類別 + 標題產生修正建議。模板只給「下一步該查什麼/改什麼」,不臆測根因細節;
 * 更具體的建議由 AI 洞察(可選)補充。
 */
export function suggestFor(f: Pick<Finding, 'classification' | 'category' | 'title' | 'certainty' | 'frequency'>): L10n {
  const t = `${f.title.en} ${f.title.zh}`.toLowerCase();
  if (f.classification === 'AI_TEST_FAILURE') {
    if (/parse|解析/.test(t)) return L('調整 VLM 提示詞與輸出格式(要求只輸出 JSON)、確認 max_tokens 足夠;重跑確認是否為偶發。此項不影響遊戲品質判定。', 'Tighten the VLM prompt/output format (JSON only) and make sure max_tokens is sufficient; re-run to see if it is intermittent. Does not affect game quality.');
    if (/model|模型/.test(t)) return L('檢查模型配額、區域與逾時設定後重跑;此項為測試代理失敗,不代表遊戲缺陷。', 'Check model quota, region and timeout settings, then re-run. This is a test-agent failure, not a game defect.');
    if (/back/.test(t)) return L('在案例或知識庫註明「不要使用系統返回鍵」,並描述遊戲內的返回/關閉按鈕位置。', 'State "do not use the system back key" in the case or knowledge base and describe where the in-game back/close button is.');
    if (/prematurely|提前/.test(t)) return L('在案例「預期結果」寫出可在畫面上驗證的完成條件(例如出現特定文字或數值),避免 AI 過早判定完成。', 'Write a screen-verifiable completion condition in the case expected result (e.g. a specific text or value) so the AI cannot finish early.');
    if (/combat|戰鬥/.test(t)) return L('在知識庫的操作方案標註搖桿位置與戰鬥操作方式。', 'Describe the joystick position and combat controls in the knowledge base control scheme.');
    if (/ineffective|無效/.test(t)) return L('比對截圖確認點擊熱區與按鈕視覺是否一致;若遊戲正常,屬 AI 座標偏差,可在知識庫補充按鈕位置。', 'Compare screenshots to confirm tap hit areas match the button visuals; if the game is fine, this is AI coordinate drift — document button positions in the knowledge base.');
    if (/interactive|互動|escape|脫困/.test(t)) return L('在知識庫補充該畫面的操作說明;同時檢查按鈕對比與大小是否足以辨識。', 'Document how to operate this screen in the knowledge base; also check that buttons have enough contrast and size to be recognizable.');
    return L('檢查 AI 測試設定(案例描述、知識庫)後重跑;此項不計入遊戲缺陷。', 'Review the AI test setup (case wording, knowledge base) and re-run. Not counted as a game defect.');
  }
  if (f.classification === 'ENVIRONMENT') {
    return L('確認測試裝置與連線(Device Farm / Appium session)狀態後重跑;此結果不代表遊戲品質。', 'Check the test device and connection (Device Farm / Appium session), then re-run. This result does not reflect game quality.');
  }
  const triage = f.classification === 'NEEDS_TRIAGE'
    ? (f.certainty === 'ai_evaluation'
      ? L('先人工對照截圖確認是否為真缺陷(AI 觀察,出現次數或信心不足)。', 'First confirm manually against the screenshot (AI observation with limited frequency or confidence). ')
      : L('需人工判讀歸因。', 'Needs manual attribution. '))
    : L('', '');
  const join = (a: L10n): L10n => L(`${triage.zh}${a.zh}`, `${triage.en}${a.en}`);
  if (/login|登入/.test(t)) return join(L('提供測試帳號(應用設定 → 測試憑證),或在測試環境開放訪客/帳密登入;裝置缺 Google Play 服務時第三方登入無法完成。', 'Provide a test account (App settings → test credentials) or enable guest/password login in the test build; third-party login cannot complete on devices without Google Play services.'));
  if (/loading|載入/.test(t)) return join(L('檢查首次啟動的資源下載(CDN/網路)與載入流程是否有逾時與重試;確認裝置可連外網。', 'Check first-launch asset download (CDN/network) and whether loading has timeouts and retries; confirm the device has internet access.'));
  if (/frozen|凍結/.test(t)) return join(L('抓取裝置 logcat / ANR 紀錄,確認是否主執行緒阻塞;確認該畫面是否需要特定操作才能繼續。', 'Collect device logcat / ANR traces to check for main-thread blocking; confirm whether this screen needs a specific action to continue.'));
  if (/loop|dead end|死循環/.test(t)) return join(L('確認此畫面有明確可點的出口(關閉/返回/下一步);若存在,在知識庫描述其位置讓 AI 能辨識。', 'Confirm the screen has a clear exit (close/back/next); if it does, describe its position in the knowledge base so the AI can find it.'));
  if (/did not pass|未通過/.test(t)) return join(L('檢視最後幾步截圖與 AI 推理,判斷是遊戲行為異常還是案例描述不清,再修正案例或回報缺陷。', 'Review the last steps’ screenshots and AI reasoning to decide whether the game misbehaved or the case is unclear, then fix the case or file the defect.'));
  if (/another app|其他/.test(t)) return join(L('確認廣告或外部連結跳轉是否為預期行為;測試版可停用廣告 SDK 以穩定測試。', 'Confirm ad or external-link redirects are expected; consider disabling the ad SDK in test builds.'));
  switch (f.category) {
    case 'crash': return join(L('收集 logcat / tombstone 崩潰堆疊,依重現步驟在本機重現;同時檢查記憶體峰值與原生外掛。', 'Collect logcat / tombstone crash stacks and reproduce locally with the listed steps; also check memory peaks and native plugins.'));
    case 'economy': return join(L('核對伺服器結算與前端餘額更新時序(下注扣款 → 派彩入帳);若為讀數誤差,提高金額文字對比與字級。', 'Verify server settlement against client balance update order (bet debit → payout credit); if it is a read error, raise contrast/size of amount text.'));
    case 'functional': case 'gameplay': case 'network': case 'save_data':
      return join(L('依重現步驟手動驗證;檢查該功能的 API 回應與錯誤處理(空資料應顯示提示並可重試)。', 'Verify manually with the repro steps; check the feature’s API responses and error handling (empty data should show a message and allow retry).'));
    case 'graphics': case 'ui': case 'animation':
      return join(L('對照設計稿確認元素位置、層級與裁切;在不同解析度/長寬比裝置上驗證。', 'Compare with the design for element position, layering and clipping; verify on devices with different resolutions/aspect ratios.'));
    case 'localization': return join(L('檢查字串表是否缺翻譯、文字溢出或字型缺字。', 'Check the string table for missing translations, text overflow or missing glyphs.'));
    case 'performance': return join(L('以 Profiler 檢查該畫面的 CPU/GPU/記憶體,確認是否有長時間阻塞或資源洩漏。', 'Profile CPU/GPU/memory on this screen for long stalls or leaks.'));
    case 'ux': return join(L('補上明確的操作引導或回饋(按鈕狀態、提示文字)。', 'Add clear guidance or feedback (button states, hint text).'));
    case 'audio': return join(L('檢查音效資源載入與音量設定。', 'Check audio asset loading and volume settings.'));
    case 'compatibility': return join(L('在其他裝置/OS 版本重跑比對,確認是否為裝置相容性問題。', 'Re-run on other devices/OS versions to confirm a compatibility issue.'));
    default: return join(L('依重現步驟手動驗證並修正。', 'Verify manually with the repro steps and fix.'));
  }
}

// ───────── 判定明細(Checks)─────────

/** 逐步判定 + 里程碑判定。每列都能回溯到截圖(step / afterStep)與判定依據。 */
function buildChecks(
  steps: EvidenceStep[],
  state: string,
  terminal: TerminalVerdict,
  findings: Finding[],
  aiFailures: Finding[],
  moduleOf: (s: EvidenceStep) => string | undefined,
  coreCovered: boolean,
): CheckItem[] {
  const out: CheckItem[] = [];
  const all = [...findings, ...aiFailures];
  const findingAt = (a: number, b?: number): Finding | undefined =>
    all.find((f) => f.firstStep !== undefined && f.lastStep !== undefined && ((a >= f.firstStep && a <= f.lastStep) || (b !== undefined && b >= f.firstStep && b <= f.lastStep)));
  const first = steps[0];
  const last = steps[steps.length - 1];
  let ms = 0;
  const msId = () => `MS-${String(++ms).padStart(2, '0')}`;

  // ── 里程碑 ──
  out.push({
    id: msId(), kind: 'milestone', basis: 'deterministic',
    title: L('App 啟動並顯示畫面', 'App launched and rendered a screen'),
    step: first?.index ?? 0, screen: first?.screen ?? '—', action: first?.action ?? '—',
    expected: L('App 啟動後可擷取到畫面', 'A screen is captured after launch').zh,
    ...(first ? { actual: first.screen } : {}),
    result: first ? 'pass' : 'fail',
    reason: first ? `第 ${first.index} 步已擷取畫面「${first.screen}」` : '沒有任何步驟證據',
    ...(first ? {} : { suggestion: L('確認 APK 可在測試裝置安裝並啟動;檢查安裝紀錄與啟動 Activity。', 'Confirm the APK installs and launches on the test device; check install logs and the launch activity.') }),
  });

  const termFinding = terminal.finding ? all.find((f) => f.title.en === terminal.finding!.title.en && f.lastStep === terminal.finding!.lastStep) : undefined;
  const playStep = steps.find((s) => gameStateOf(s.screen) === 'gameplay');
  out.push({
    id: msId(), kind: 'milestone', basis: 'ai_evaluation',
    title: L('進入遊戲主要玩法', 'Reached core gameplay'),
    step: (playStep ?? last)?.index ?? 0, screen: (playStep ?? last)?.screen ?? '—', action: (playStep ?? last)?.action ?? '—',
    expected: L('流程可推進到遊戲主要玩法畫面', 'The flow reaches a core gameplay screen').zh,
    ...((playStep ?? last) ? { actual: (playStep ?? last)!.screen } : {}),
    result: playStep || coreCovered ? 'pass' : terminal.blocked ? 'fail' : 'unclear',
    reason: playStep
      ? `第 ${playStep.index} 步 AI 標示畫面為「${playStep.screen}」(遊戲進行中)`
      : coreCovered ? '核心模組有操作紀錄' : `整段 ${steps.length} 步沒有出現遊戲進行畫面${last ? `,最後停在「${last.screen}」` : ''}`,
    ...(!playStep && !coreCovered && termFinding ? { relatedFinding: termFinding.id } : {}),
    ...(!playStep && !coreCovered ? { suggestion: termFinding ? termFinding.suggestion ?? suggestFor(termFinding) : L('檢查進入玩法前的流程(登入/教學/下載)是否有阻擋。', 'Check whether login/tutorial/download blocks the flow before gameplay.') } : {}),
  });

  const goalResult: CheckResult = state === 'pass' ? 'pass' : state === 'cancelled' || state === 'budget_exceeded' ? 'skipped' : terminal.classification === 'AI_TEST_FAILURE' || terminal.classification === 'ENVIRONMENT' ? 'unclear' : 'fail';
  out.push({
    id: msId(), kind: 'milestone', basis: state === 'pass' ? 'ai_evaluation' : 'deterministic',
    // 這是「AI 有沒有走完流程」的里程碑;案例要求是否真的達成,由驗收標準(acceptance)逐項判定。
    title: L('AI 宣告完成測試流程', 'AI declared the procedure complete'),
    step: last?.index ?? 0, screen: last?.screen ?? '—', action: last?.action ?? '—',
    expected: L('AI 依案例走完流程並宣告完成(是否達成案例要求見驗收標準)', 'AI walks the case to its end and declares completion (whether the case requirements are met: see acceptance criteria)').zh,
    actual: terminal.reason.zh,
    result: goalResult,
    reason: [terminal.reason.zh, termFinding?.description.zh].filter(Boolean).join(' — '),
    ...(termFinding ? { relatedFinding: termFinding.id, suggestion: termFinding.suggestion ?? suggestFor(termFinding) } : {}),
  });

  const crash = findings.find((f) => f.category === 'crash');
  out.push({
    id: msId(), kind: 'milestone', basis: 'deterministic',
    title: L('執行期間無閃退', 'No crash during the run'),
    step: crash?.firstStep ?? last?.index ?? 0, screen: crash?.gameState ?? last?.screen ?? '—', action: '—',
    expected: L('App 全程維持執行', 'The app stays running throughout').zh,
    result: crash ? 'fail' : steps.length ? 'pass' : 'skipped',
    reason: crash ? crash.description.zh : `${steps.length} 步中未偵測到 App 程序中止`,
    ...(crash ? { relatedFinding: crash.id, suggestion: crash.suggestion ?? suggestFor(crash) } : {}),
  });

  const severe = findings.filter((f) => f.classification === 'GAME_FAILURE');
  out.push({
    id: msId(), kind: 'milestone', basis: severe.some((f) => f.certainty === 'ai_evaluation') ? 'ai_evaluation' : 'deterministic',
    title: L('未發現確認的遊戲缺陷', 'No confirmed game defects'),
    step: severe[0]?.firstStep ?? last?.index ?? 0, screen: severe[0]?.gameState ?? last?.screen ?? '—', action: '—',
    expected: L('沒有確認的遊戲缺陷', 'No confirmed game defects').zh,
    result: severe.length ? 'fail' : steps.length ? 'pass' : 'skipped',
    reason: severe.length ? `確認缺陷 ${severe.length} 個:${severe.slice(0, 3).map((f) => f.title.zh).join('、')}` : '沒有 AI 重複觀察或程式規則確認的遊戲缺陷',
    ...(severe[0] ? { relatedFinding: severe[0].id, suggestion: severe[0].suggestion ?? suggestFor(severe[0]) } : {}),
  });

  // ── 逐步判定 ──
  let seq = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s.expect) continue;
    const next = steps[i + 1];
    const result: CheckResult = s.assertion ?? (next ? 'unclear' : 'skipped');
    const f = result === 'pass' ? undefined : findingAt(s.index, next?.index);
    let suggestion: L10n | undefined;
    if (result === 'fail') {
      suggestion = f?.suggestion ?? (s.effective === false
        ? L('動作後畫面沒有變化:確認該位置是否為可點擊元件、熱區是否與按鈕視覺一致、是否有點擊回饋;若遊戲正常則屬 AI 座標偏差。', 'No visible change after the action: confirm the spot is interactive, the hit area matches the button visual, and there is tap feedback; if the game is fine, this is AI coordinate drift.')
        : L(`畫面有變化但不是預期結果(預期「${s.expect}」,實際到了「${s.actual ?? '?'}」):確認流程導向是否正確,或更新案例預期。`, `The screen changed but not as expected (expected "${s.expect}", got "${s.actual ?? '?'}"): verify the navigation flow, or update the case expectation.`));
    } else if (result === 'unclear') {
      suggestion = L('AI 無法從截圖確定結果:請人工檢視前後截圖;若畫面缺少狀態回饋,建議加入明確提示。', 'The AI could not tell from the screenshot: review the before/after screenshots; if the UI lacks state feedback, add a clear indication.');
    }
    const mod = moduleOf(s);
    out.push({
      id: `CHK-${String(++seq).padStart(3, '0')}`,
      kind: 'step',
      basis: 'ai_evaluation',
      step: s.index,
      ...(next ? { afterStep: next.index } : {}),
      ...(mod ? { module: mod } : {}),
      screen: s.screen,
      action: `${s.action}${s.x !== undefined ? ` (${s.x},${s.y})` : ''}`,
      expected: s.expect,
      ...(s.actual ? { actual: s.actual } : {}),
      result,
      ...(next?.thinking ? { reason: next.thinking } : {}),
      ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
      ...(s.effective !== undefined ? { effective: s.effective } : {}),
      ...(f ? { relatedFinding: f.id } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return out;
}

function aiFinding(id: string, s: EvidenceStep, title: L10n, description: L10n, severity: Severity, steps: EvidenceStep[], frequency = 1): Finding {
  return {
    id,
    title,
    description,
    severity,
    category: 'ai',
    classification: 'AI_TEST_FAILURE',
    certainty: 'deterministic',
    gameState: s.screen,
    frequency,
    reproducibility: frequency > 1 ? 'frequent' : 'single',
    firstStep: s.index,
    lastStep: s.index,
    stepsToReproduce: stepsBefore(steps, s.index, 3),
    ...(s.screenshotKey ? { screenshotKey: s.screenshotKey } : {}),
    status: 'open',
  };
}

// ───────── 規則引擎 ─────────

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '!=': return a !== b;
  }
}
function resolveThreshold(v: ThresholdRef, thresholds: Record<string, number>): number | null {
  if (typeof v === 'number') return v;
  const t = thresholds[v.threshold];
  return typeof t === 'number' ? t : null;
}

// ───────── 主函式 ─────────

const CATEGORY_DIMENSION: Record<FindingCategory, QualityDimension> = {
  crash: 'functional', functional: 'functional', save_data: 'functional',
  gameplay: 'gameplay', physics: 'gameplay', ai: 'gameplay', economy: 'gameplay',
  graphics: 'visual', animation: 'visual', ui: 'visual',
  ux: 'ux', audio: 'audio', performance: 'performance', network: 'network',
  localization: 'localization', compatibility: 'compatibility',
};
const SEVERITY_PENALTY: Record<Severity, number> = { critical: 40, high: 20, medium: 10, low: 5 };
const ALL_SCOPES: TestScopeId[] = [
  'functional', 'gameplay', 'mechanics', 'ui', 'ux', 'graphics', 'animation', 'audio', 'performance',
  'compatibility', 'network', 'multiplayer', 'localization', 'save_load', 'account', 'economy', 'payment',
  'ai_behavior', 'physics', 'controller', 'level',
];

/** 從案例 YAML 取單行/區塊純量欄位(precondition / expected / priority …)。 */
function yamlField(yaml: string, key: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key}:\\s*`).test(l));
  if (idx < 0) return undefined;
  const inline = lines[idx]!.replace(new RegExp(`^${key}:\\s*`), '').trim();
  if (inline && !/^[|>][+-]?\d*$/.test(inline)) return inline.replace(/^["']|["']$/g, '');
  const body: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '') { body.push(''); continue; }
    if (l.length - l.trimStart().length === 0) break;
    body.push(l.trim());
  }
  const t = body.join('\n').trim();
  return t || undefined;
}

export function buildStructuredReport(input: EngineInput): StructuredReport {
  const raw = input.raw;
  const job = input.job ?? null;
  const app = input.app ?? null;
  // 類型 = App/job 類型 ∪ 本次掛載的「類別型」知識庫所綁定的類型(知識庫引導報告:掛上 Slot 樣板/其 clone
  // 就套用 Slot 的模組、指標、規則)。
  const genres = [...new Set([...resolveGenres(job, app), ...(input.kbs ?? []).map((k) => k.genre).filter((g): g is string => Boolean(g))])];
  // 知識庫規格(結構化 reportSpec + Markdown 區塊):規格值、門檻覆寫、額外模組/觀測欄位、停用項目。
  const spec: ReportSpec = mergeSpecs((input.kbs ?? []).map((k) => specFromKb(k)));
  const profile: MergedProfile = applyExclude(mergeProfiles(genres), spec.exclude);

  const modules: ModuleDef[] = [...profile.modules];
  for (const m of spec.modules) if (!modules.some((x) => x.id === m.id)) modules.push(m);
  const thresholds = { ...profile.thresholds, ...spec.thresholds };

  const state = typeof raw['state'] === 'string' ? raw['state'] : 'unknown';
  const slotCapture = slotCaptureOf(raw['slotCaptureManifest']);
  const message = typeof raw['message'] === 'string' ? raw['message'] : undefined;
  const isSlotLike = genres.some((g) => g === 'slot' || g === 'casino');
  // 讀錯的數值(餘額/投注額尖峰)從 obs 移除、改記在 excludedObs,不計入任何指標;清單附在報告 dataQuality。
  const { steps, quality } = sanitizeObs(normalizeSteps(raw['steps'], { legacySlot: isSlotLike }));

  const moduleAttr = new Map<number, { id: string; basis: 'ai' | 'inferred' }>();
  for (const s of steps) {
    const a = attributeModule(s, modules);
    if (a) moduleAttr.set(s.index, a);
  }
  const moduleOf = (s: EvidenceStep) => moduleAttr.get(s.index)?.id;

  const terminal = classifyTerminal(state, message, steps);
  const { findings, aiFailures } = buildFindings(steps, terminal, moduleOf, job?.caseId, quality);
  for (const f of [...findings, ...aiFailures]) f.suggestion ??= suggestFor(f);

  // 機制歸屬(AI 標註優先,其次以畫面名/思考關鍵字推斷)。
  const mechanicSteps = new Map<string, EvidenceStep[]>();
  for (const s of steps) {
    let id = s.mechanic && profile.mechanics.some((m) => m.id === s.mechanic) ? s.mechanic : undefined;
    if (!id) {
      const hay = `${s.screen}`.toLowerCase();
      id = profile.mechanics.find((m) => (m.keywords ?? []).some((k) => k && hay.includes(k.toLowerCase())))?.id;
    }
    if (id) mechanicSteps.set(id, [...(mechanicSteps.get(id) ?? []), s]);
  }
  const mechanics: MechanicResult[] = profile.mechanics.map((m) => {
    const list = mechanicSteps.get(m.id) ?? [];
    return {
      id: m.id,
      label: m.label,
      tested: list.length > 0,
      pass: list.filter((s) => s.assertion === 'pass').length,
      fail: list.filter((s) => s.assertion === 'fail').length,
      steps: list.length,
    };
  });

  // 模組結果。
  const modulesResult: ModuleResult[] = modules.map((m) => {
    const list = steps.filter((s) => moduleOf(s) === m.id);
    const pass = list.filter((s) => s.assertion === 'pass').length;
    const fail = list.filter((s) => s.assertion === 'fail').length;
    const unclear = list.filter((s) => s.assertion === 'unclear').length;
    const durs = list.map((s) => s.durationMs).filter((d): d is number => typeof d === 'number');
    const mf = findings.filter((f) => f.module === m.id && f.classification === 'GAME_FAILURE');
    return {
      id: m.id,
      label: m.label,
      checks: pass + fail + unclear,
      pass,
      fail,
      unclear,
      passRate: pass + fail > 0 ? round2((pass / (pass + fail)) * 100) : null,
      critical: mf.filter((f) => f.severity === 'critical').length,
      high: mf.filter((f) => f.severity === 'high').length,
      avgDurationMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
      steps: list.length,
    };
  });

  const coveredModules = modulesResult.filter((m) => m.steps > 0).length;
  const testedMech = mechanics.filter((m) => m.tested);

  const startIso = job?.createdAt ?? steps.find((s) => s.at)?.at;
  const endIso = typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : [...steps].reverse().find((s) => s.at)?.at;
  const wallClockMs = startIso && endIso ? Math.max(0, Date.parse(endIso) - Date.parse(startIso)) : undefined;
  const perfMeta = readPerfMeta(raw['perfMeta']);
  const tokensRaw = raw['tokens'] as { input?: number; output?: number } | undefined;
  const tokens = typeof tokensRaw?.input === 'number' && typeof tokensRaw.output === 'number' ? { input: tokensRaw.input, output: tokensRaw.output } : undefined;

  // 指標分流:steps = AI 自己做的,allSteps = 整場(含測試人員接管的手動操作)。
  // 接管模式下人幫 AI 過關,若混在一起,報告會把人的成果算成 AI 的成功率。
  const aiSteps = steps.filter((s) => s.by !== 'operator');
  const ctx: MetricContext = {
    steps: aiSteps,
    allSteps: steps,
    findings,
    aiFailures,
    terminalState: state,
    values: spec.values,
    thresholds,
    modules,
    moduleCoverage: { covered: coveredModules, total: modules.length },
    mechanicCoverage: {
      covered: testedMech.length,
      total: profile.mechanics.length,
      pass: testedMech.reduce((a, m) => a + m.pass, 0),
      fail: testedMech.reduce((a, m) => a + m.fail, 0),
    },
    ...(spinLoopOf(raw['rtp']) ? { spinLoop: spinLoopOf(raw['rtp'])! } : {}),
    ...(wallClockMs !== undefined && Number.isFinite(wallClockMs) ? { wallClockMs } : {}),
    ...(tokens ? { tokens } : {}),
    ...(perfMeta ? { perfMeta } : {}),
  };

  // 指標(含 KB 規格擴充的觀測欄位:自動產生 max/last 指標)。
  const origin = metricOrigin(genres);
  const metricDefs = [...profile.metrics];
  for (const o of spec.observe) {
    if (o.type !== 'number' || metricDefs.some((d) => d.id === `spec_${o.key}`)) continue;
    metricDefs.push({ id: `spec_${o.key}`, label: o.label, unit: '', group: 'genre', source: 'ai_evaluation', calc: { kind: 'obs_last', key: o.key } });
  }
  const metrics: MetricValue[] = metricDefs.map((d) => {
    const value = computeMetric(d.calc, ctx);
    return {
      id: d.id,
      label: d.label,
      unit: d.unit,
      group: d.group,
      source: d.source,
      ...(d.dimension ? { dimension: d.dimension } : {}),
      value,
      status: value === null ? 'not_collected' : 'ok',
      profile: origin.get(d.id) ?? 'knowledge_base',
    };
  });
  const mval = (id: string): number | null => metrics.find((m) => m.id === id)?.value ?? computeMetric({ kind: 'builtin', fn: id }, ctx);

  // 覆蓋。
  const featureCov: CoverageItem[] = modulesResult.map((m) => ({
    id: m.id,
    label: m.label,
    covered: m.steps > 0,
    steps: m.steps,
    basis: steps.some((s) => moduleAttr.get(s.index)?.id === m.id && moduleAttr.get(s.index)?.basis === 'ai') ? 'ai' : 'inferred',
  }));
  const mechanicCov: CoverageItem[] = mechanics.map((m) => ({ id: m.id, label: m.label, covered: m.tested, steps: m.steps }));
  const stateCounts = new Map<string, number>();
  for (const s of steps) {
    const g = gameStateOf(s.screen);
    if (g) stateCounts.set(g, (stateCounts.get(g) ?? 0) + 1);
  }
  const gameStateCov: CoverageItem[] = GAME_STATES.map((g) => ({ id: g.id, label: g.label, covered: (stateCounts.get(g.id) ?? 0) > 0, steps: stateCounts.get(g.id) ?? 0, basis: 'inferred' }));
  const passAsserts = steps.filter((s) => s.assertion === 'pass').length;
  const recovery = mval('recovery_count') ?? 0;
  const retries = mval('retry_count') ?? 0;
  const scenarioCov: CoverageItem[] = [
    { id: 'happy_path', label: L('正常流程', 'Happy Path'), covered: state === 'pass' || passAsserts > 0, steps: passAsserts },
    { id: 'negative_path', label: L('異常流程', 'Negative Path'), covered: false, steps: 0 },
    { id: 'boundary', label: L('邊界值', 'Boundary'), covered: false, steps: 0 },
    { id: 'recovery', label: L('恢復', 'Recovery'), covered: recovery > 0, steps: recovery },
    { id: 'interruption', label: L('中斷', 'Interruption'), covered: steps.some((s) => s.foregroundLost), steps: steps.filter((s) => s.foregroundLost).length },
    { id: 'repeated_action', label: L('重複操作', 'Repeated Action'), covered: retries > 0, steps: retries },
    { id: 'invalid_action', label: L('無效操作', 'Invalid Action'), covered: steps.some((s) => isInteractive(s) && s.effective === false), steps: steps.filter((s) => isInteractive(s) && s.effective === false).length },
    { id: 'unexpected_sequence', label: L('非預期順序', 'Unexpected Sequence'), covered: false, steps: 0 },
  ];
  const device = raw['device'] as { w?: number; h?: number } | undefined;
  const resolution = device?.w && device?.h ? `${device.w}x${device.h}` : undefined;
  const deviceModel = (typeof raw['deviceModel'] === 'string' ? raw['deviceModel'] : undefined) ?? job?.deviceModel;
  const deviceCov = [
    { label: L('平台', 'Platform'), value: job?.platform ?? app?.platform ?? '—' },
    { label: L('作業系統', 'OS'), value: job?.osVersion ? `${job.platform === 'ios' ? 'iOS' : 'Android'} ${job.osVersion}` : '—' },
    { label: L('裝置', 'Device'), value: deviceModel ?? '—' },
    { label: L('解析度', 'Resolution'), value: resolution ?? '—' },
    { label: L('GPU / CPU', 'GPU / CPU'), value: '—' },
  ];

  // 測試範疇:profile/規格選定的才 selected;未選定 = Not Applicable(不得算 Fail)。
  const selectedScopes = new Set<TestScopeId>([...profile.scopes, ...spec.scopes]);
  const hasPerf = steps.some((s) => s.perf);
  const executedEvidence: Record<TestScopeId, boolean> = {
    functional: steps.some(isInteractive),
    gameplay: coveredModules > 0 && modulesResult.some((m) => m.steps > 0 && modules.find((x) => x.id === m.id)?.core),
    mechanics: testedMech.length > 0,
    ui: steps.some(isInteractive),
    ux: steps.some(isInteractive),
    graphics: steps.some((s) => s.screenshotKey),
    animation: false,
    audio: false,
    performance: hasPerf,
    compatibility: !!deviceModel,
    network: gameStateCov.some((g) => (g.id === 'disconnected' || g.id === 'reconnect') && g.covered),
    multiplayer: false,
    localization: false,
    save_load: false,
    account: featureCov.some((f) => f.id === 'login' && f.covered),
    economy: steps.some((s) => s.obs && ['currency', 'balance', 'gold', 'bet'].some((k) => k in s.obs!)),
    payment: false,
    ai_behavior: false,
    physics: false,
    controller: steps.some((s) => s.action === 'move'),
    level: steps.some((s) => s.obs && ['level', 'wave', 'stage', 'floor', 'chapter'].some((k) => k in s.obs!)) || featureCov.some((f) => (f.id === 'gameplay' || f.id === 'battle' || f.id === 'stage') && f.covered),
  };
  const scope: ScopeStatus[] = ALL_SCOPES.map((id) => {
    const selected = selectedScopes.has(id);
    const executed = executedEvidence[id];
    return { id, selected, status: !selected && !executed ? 'not_applicable' : executed ? 'executed' : 'not_executed' };
  });

  // Quality Dashboard:分數 = 100 − Σ(該維度遊戲缺陷扣分);未執行的維度不給分(null)。
  // AI/環境失敗導致沒有任何實際操作時,任何品質維度都不算「已測」,不給分(避免「沒測卻 100 分」)。
  const interactiveCount = steps.filter(isInteractive).length;
  const anyExecuted = interactiveCount > 0;
  const dimensionExecuted: Record<QualityDimension, boolean> = {
    functional: anyExecuted,
    gameplay: anyExecuted && (executedEvidence.gameplay || executedEvidence.mechanics),
    performance: anyExecuted && hasPerf,
    visual: anyExecuted && executedEvidence.graphics,
    audio: false,
    ux: anyExecuted,
    compatibility: anyExecuted && executedEvidence.compatibility,
    localization: false,
    network: anyExecuted && executedEvidence.network,
  };
  const DIM_METRICS: Record<QualityDimension, string[]> = {
    functional: ['assertion_pass_rate', 'crash_count', 'core_gameplay_block'],
    gameplay: ['mechanic_pass_rate', 'mechanic_coverage', 'progression_block'],
    performance: ['fps_avg', 'fps_p1', 'cpu_peak', 'gpu_usage', 'mem_peak_mb', 'device_temperature'],
    visual: [],
    audio: [],
    ux: ['retry_rate', 'stuck_count'],
    compatibility: [],
    localization: [],
    network: [],
  };
  const gameFindings = findings.filter((f) => f.classification === 'GAME_FAILURE');
  const dashboard: DimensionScore[] = (Object.keys(dimensionExecuted) as QualityDimension[]).map((dim) => {
    const fs = gameFindings.filter((f) => CATEGORY_DIMENSION[f.category] === dim);
    // 有確認的遊戲缺陷落在此維度 = 這個維度實際被觀察到了,必須計分(不能因「未收集」而吞掉扣分)。
    const executed = dimensionExecuted[dim] || fs.length > 0;
    const penalty = fs.reduce((a, f) => a + SEVERITY_PENALTY[f.severity], 0);
    return { dimension: dim, score: executed ? Math.max(0, 100 - penalty) : null, executed, findingCount: fs.length, metrics: DIM_METRICS[dim] };
  });

  // 圖表。
  const charts = buildCharts(profile.charts, steps, findings, aiFailures, modulesResult, spec, origin, genres, hasPerf, stateCounts);

  // 風險。
  const risks: Risk[] = [];
  for (const r of profile.riskRules) {
    const actual = mval(r.metric);
    const th = resolveThreshold(r.value, thresholds);
    if (actual === null || th === null || !compare(actual, r.op, th)) continue;
    const related = findings.filter((f) => relatedToMetric(r.metric, f));
    risks.push({
      id: `RISK-${r.id}`,
      level: r.level,
      title: r.title,
      evidence: L(`${metricLabel(metrics, r.metric).zh} = ${actual}(門檻 ${r.op} ${th})`, `${metricLabel(metrics, r.metric).en} = ${actual} (threshold ${r.op} ${th})`),
      ...(r.affected ? { affected: r.affected } : related[0]?.module ? { affected: modules.find((m) => m.id === related[0]!.module)?.label } : {}),
      frequency: related.reduce((a, f) => a + f.frequency, 0) || undefined,
      impact: r.impact,
      relatedSteps: [...new Set(related.flatMap((f) => [f.firstStep, f.lastStep]).filter((x): x is number => typeof x === 'number'))],
      relatedFindings: related.map((f) => f.id),
    });
  }
  const sevOrder: Severity[] = ['critical', 'high', 'medium', 'low'];
  risks.sort((a, b) => sevOrder.indexOf(a.level) - sevOrder.indexOf(b.level));

  // 放行規則引擎。
  const hits: RuleHit[] = [];
  for (const r of profile.releaseRules) {
    const actual = mval(r.metric);
    const th = resolveThreshold(r.value, thresholds);
    if (actual === null || th === null) continue;
    if (compare(actual, r.op, th)) hits.push({ ruleId: r.id, outcome: r.outcome, reason: r.reason, metric: r.metric, actual, threshold: th, op: r.op });
  }
  let readiness: ReleaseReadiness;
  if (terminal.blocked) readiness = 'BLOCKED';
  else if (hits.some((h) => h.outcome === 'NOT_READY')) readiness = 'NOT_READY';
  else if (hits.some((h) => h.outcome === 'INSUFFICIENT_TESTING')) readiness = 'INSUFFICIENT_TESTING';
  else if (hits.some((h) => h.outcome === 'READY_WITH_RISK') || risks.some((r) => r.level === 'critical' || r.level === 'high')) readiness = 'READY_WITH_RISK';
  else readiness = 'READY';
  // 被阻斷時仍要把已觸發的 NOT_READY 規則呈現(遊戲缺陷優先告知)。
  if (terminal.blocked && hits.some((h) => h.outcome === 'NOT_READY')) readiness = 'NOT_READY';

  // 測試結論:唯一來源 = 驗收標準(acceptance.ts)。列表、任務詳情、報告封面都讀同一個結論。
  const acceptance = buildAcceptance({
    task: typeof raw['task'] === 'string' ? raw['task'] : job?.caseName ?? '',
    state,
    terminal,
    ...(message ? { conclusion: message } : {}),
    steps,
    findings,
    aiFailures,
    risks,
    quality,
    values: spec.values,
    thresholds,
    scripted: job?.scripted === true,
    ...(slotCapture ? { slotCapture } : {}),
  });
  const overallStatus: OverallStatus = acceptance.verdict;
  const statusReason: L10n = acceptance.verdictReason;
  // 發布建議不能比測試結論樂觀:結論失敗 → 不可發布;結論受阻 → 受阻(已觸發 NOT_READY 規則時維持不可發布)。
  if (overallStatus === 'FAIL') readiness = 'NOT_READY';
  else if (overallStatus === 'BLOCKED' && readiness !== 'NOT_READY') readiness = 'BLOCKED';

  // 判定明細:KPI 的通過/失敗/不確定數字 = 這張表的列數,點擊可一一對應。
  const checks = buildChecks(steps, state, terminal, findings, aiFailures, moduleOf, executedEvidence.gameplay);
  const countOf = (r: CheckResult) => checks.filter((c) => c.result === r).length;
  const assertPass = countOf('pass');
  const assertFail = countOf('fail');
  const assertUnclear = countOf('unclear');
  const expectCount = checks.length;
  const defects: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of gameFindings) defects[f.severity]++;

  const kbVersions = (input.kbs ?? []).map((k) => {
    const v = k.version ?? (k.builtin && k.genre ? profile.sources.find((s) => s.id === k.genre)?.version : undefined);
    return `${k.name}${v ? ` v${v}` : ''}${typeof k.revision === 'number' ? ` r${k.revision}` : ''}`;
  });

  const yaml = input.testCase?.yaml ?? '';
  const caseVersion = job?.caseVersion ?? input.testCase?.version;
  const confs = steps.map((s) => s.confidence).filter((c): c is number => typeof c === 'number');

  const report: StructuredReport = {
    schemaVersion: 1,
    header: {
      reportId: `RPT-${job?.jobId ?? String(raw['jobId'] ?? '')}`,
      ...(app?.name ? { gameName: app.name } : {}),
      ...(app?.version ? { gameVersion: app.version } : {}),
      ...(job?.artifactVersion ? { buildNumber: job.artifactVersion } : {}),
      ...(genres[0] ? { genre: genres[0] } : {}),
      secondaryGenres: genres.slice(1),
      ...((job?.platform ?? app?.platform) ? { platform: job?.platform ?? app?.platform } : {}),
      ...(job?.osVersion ? { operatingSystem: job.osVersion } : {}),
      ...(deviceModel ? { device: deviceModel } : {}),
      ...(resolution ? { resolution } : {}),
      ...(job?.backend ? { testEnvironment: job.backend } : {}),
      ...(startIso ? { testStartTime: startIso } : {}),
      ...(endIso ? { testEndTime: endIso } : {}),
      ...(wallClockMs !== undefined && Number.isFinite(wallClockMs) ? { testDurationMs: wallClockMs } : {}),
      ...((typeof raw['vlmModel'] === 'string' ? raw['vlmModel'] : job?.vlmModel) ? { aiModelVersion: (typeof raw['vlmModel'] === 'string' ? raw['vlmModel'] : job?.vlmModel)! } : {}),
      ...(job?.agentModel ? { agentModel: job.agentModel } : {}),
      testEngineVersion: typeof raw['runnerVersion'] === 'string' ? raw['runnerVersion'] : 'legacy',
      knowledgeBaseVersions: kbVersions,
      ...(caseVersion ? { caseVersion } : {}),
      testPlanVersion: profile.version,
    },
    overallStatus,
    statusReason,
    acceptance,
    terminal: { state, ...(message ? { message } : {}), ...(terminal.classification ? { classification: terminal.classification } : {}) },
    release: { readiness, hits, thresholds },
    summaryLines: [],
    counts: {
      totalChecks: expectCount,
      executedChecks: assertPass + assertFail + assertUnclear,
      passed: assertPass,
      failed: assertFail,
      unclear: assertUnclear,
      blocked: terminal.blocked ? 1 : 0,
      skipped: Math.max(0, expectCount - (assertPass + assertFail + assertUnclear)),
      passRate: assertPass + assertFail > 0 ? round2((assertPass / (assertPass + assertFail)) * 100) : null,
      executionRate: expectCount > 0 ? round2(((assertPass + assertFail + assertUnclear) / expectCount) * 100) : null,
      defects,
    },
    metrics,
    dashboard,
    scope,
    coverage: { feature: featureCov, mechanic: mechanicCov, gameState: gameStateCov, scenario: scenarioCov, device: deviceCov },
    modules: modulesResult,
    mechanics,
    testCase: {
      id: job?.caseId ?? input.testCase?.id ?? '—',
      name: input.testCase?.name ?? job?.caseName ?? (job?.category === 'exploration' ? 'Exploration' : job?.caseId ?? '—'),
      ...(caseVersion ? { version: caseVersion } : {}),
      category: job?.category ?? 'test',
      ...(yamlField(yaml, 'module') ? { module: yamlField(yaml, 'module') } : {}),
      ...(yamlField(yaml, 'priority') ? { priority: yamlField(yaml, 'priority') } : {}),
      ...(yamlField(yaml, 'severity') ? { severity: yamlField(yaml, 'severity') } : {}),
      ...(yamlField(yaml, 'precondition') ? { precondition: yamlField(yaml, 'precondition') } : {}),
      ...(yamlField(yaml, 'input') ? { input: yamlField(yaml, 'input') } : {}),
      ...((yamlField(yaml, 'steps') ?? (typeof raw['task'] === 'string' ? raw['task'] : undefined)) ? { testSteps: yamlField(yaml, 'steps') ?? (raw['task'] as string) } : {}),
      ...(yamlField(yaml, 'expected') ? { expectedResult: yamlField(yaml, 'expected') } : {}),
      ...(message ? { actualResult: message } : {}),
      result: overallStatus,
      ...(startIso ? { startTime: startIso } : {}),
      ...(endIso ? { endTime: endIso } : {}),
      ...(wallClockMs !== undefined && Number.isFinite(wallClockMs) ? { durationMs: wallClockMs } : {}),
      aiGenerated: !yamlField(yaml, 'expected'),
      ...(confs.length ? { aiConfidence: round2(confs.reduce((a, b) => a + b, 0) / confs.length) } : {}),
      ...(job?.agentModel ? { agentModel: job.agentModel } : {}),
      ...((typeof raw['vlmModel'] === 'string' ? raw['vlmModel'] : job?.vlmModel) ? { vlmModel: (typeof raw['vlmModel'] === 'string' ? raw['vlmModel'] : job?.vlmModel)! } : {}),
      retryCount: retries,
      recoveryCount: recovery,
    },
    checks,
    findings,
    aiFailures,
    risks,
    charts,
    sections: profile.sections,
    profiles: profile.sources,
    spec: { values: spec.values, sources: spec.sources },
    evidence: steps,
    ...(slotCapture ? { slotCapture } : {}),
    dataQuality: quality,
    notes: [...qualityNotes(quality), ...buildNotes(steps, hasPerf, spec, genres)],
  };
  report.summaryLines = buildSummary(report, mval);
  return report;
}

function relatedToMetric(metricId: string, f: Finding): boolean {
  if (metricId.startsWith('crash')) return f.category === 'crash';
  if (metricId.startsWith('balance') || metricId.startsWith('negative_balance')) return f.category === 'economy';
  if (metricId === 'defects_critical') return f.classification === 'GAME_FAILURE' && f.severity === 'critical';
  if (metricId === 'defects_high') return f.classification === 'GAME_FAILURE' && f.severity === 'high';
  if (metricId === 'core_gameplay_block' || metricId === 'progression_block') return f.classification === 'GAME_FAILURE' && (f.severity === 'critical' || f.severity === 'high');
  return false;
}

function metricLabel(metrics: MetricValue[], id: string): L10n {
  return metrics.find((m) => m.id === id)?.label ?? L(id, id);
}

/** 數據品質附註:排除了哪些讀錯的值(列前 5 筆,完整清單在 dataQuality.excluded 與各步驟的 excludedObs)。 */
function qualityNotes(q: DataQuality): L10n[] {
  if (!q.excluded.length) return [];
  const head = q.excluded.slice(0, 5).map((e) => `#${e.step} ${e.key}=${e.value.toLocaleString('en-US')}`).join('、');
  const more = q.excluded.length > 5 ? `…` : '';
  return [L(
    `已排除 ${q.excluded.length} 筆疑似 AI 讀錯的數值,不計入 RTP 與經濟指標:${head}${more}。每一筆的原值與判斷依據都保留在「數據品質」與執行軌跡中。`,
    `Excluded ${q.excluded.length} value(s) the AI likely misread; they are not used for RTP or economy metrics: ${head}${more}. Each original value and the reason are kept under Data quality and in the evidence trace.`,
  )];
}

function buildNotes(steps: EvidenceStep[], hasPerf: boolean, spec: ReportSpec, genres: string[]): L10n[] {
  const notes: L10n[] = [];
  if (!steps.some((s) => s.expect)) {
    notes.push(L('此報告來自舊版 runner(無逐步 Expected/Assertion),檢查通過率與機制通過率無法計算,AI 操作成功率改以「畫面是否變化」估算。', 'Legacy runner evidence (no per-step expected/assertion): check and mechanic pass rates are unavailable; AI action success uses screen-change as a proxy.'));
  }
  if (!hasPerf) notes.push(L('本次未取得效能取樣(FPS/CPU/RAM),效能維度不評分。', 'No performance samples (FPS/CPU/RAM) collected; performance dimension not scored.'));
  const hasFps = steps.some((s) => typeof s.perf?.fps === 'number');
  if (hasPerf && !hasFps) {
    notes.push(L('本次效能取樣來自舊版 runner(僅 CPU/記憶體),FPS、GPU、溫度、耗電顯示為「未收集」而非 0。', 'Performance samples come from the legacy runner (CPU/RAM only); FPS, GPU, temperature and battery are shown as “not collected”, not 0.'));
  }
  if (hasFps) {
    notes.push(L(
      '效能由 adb 在真機上取樣:FPS/幀時間來自 SurfaceFlinger timestats(被測 App 繪製層,取樣區間內全部幀);CPU 為 App 占全部核心的比例;GPU 為 App 的 GPU 活動時間占比;耗電為 Android batterystats 依 power profile 的估算值(Device Farm 裝置全程接電,無法量實際電流)。',
      'Performance is sampled on the real device via adb: FPS/frame time from SurfaceFlinger timestats (the app’s render layer, every frame in each interval); CPU is the app’s share of all cores; GPU is the app’s GPU active-time share; battery is Android batterystats’ power-profile estimate (Device Farm devices stay plugged in, so real current cannot be measured).',
    ));
  }
  notes.push(L('網路延遲目前尚未接上資料來源,顯示為「未收集」而非 0。', 'Network latency is not yet instrumented and is shown as “not collected”, not 0.'));
  if ((genres.includes('slot') || genres.includes('casino')) && spec.values['expectedRtp'] === undefined) {
    notes.push(L('知識庫未提供 Expected RTP,不計算 RTP 偏差(AI 不會自行假設)。', 'No Expected RTP in knowledge base; RTP deviation not computed (AI never assumes it).'));
  }
  notes.push(L('單次執行無法做跨次重現分析;重現率以本次執行內的出現次數標示。', 'Cross-run reproduction is not available from a single run; reproducibility reflects in-run frequency.'));
  return notes;
}

function buildSummary(r: StructuredReport, mval: (id: string) => number | null): L10n[] {
  const lines: L10n[] = [];
  const statusZh: Record<OverallStatus, string> = { PASS: '通過', PASS_WITH_RISK: '通過(有風險)', FAIL: '失敗', BLOCKED: '受阻(無法下結論)' };
  const readyZh: Record<ReleaseReadiness, string> = { READY: '可發布', READY_WITH_RISK: '可發布(有風險)', NOT_READY: '不可發布', BLOCKED: '受阻', INSUFFICIENT_TESTING: '測試不足' };
  lines.push(L(`測試結論:${statusZh[r.overallStatus]} —— ${r.statusReason.zh}。`, `Verdict: ${r.overallStatus} — ${r.statusReason.en}.`));
  const ac = r.acceptance.criteria;
  const applicable = ac.filter((c) => c.result !== 'not_applicable');
  const passedAc = applicable.filter((c) => c.result === 'pass').length;
  const mustAc = applicable.filter((c) => c.level === 'must');
  lines.push(L(
    `驗收標準 ${r.acceptance.standard}:${applicable.length} 項中通過 ${passedAc} 項(必要項目 ${mustAc.filter((c) => c.result === 'pass').length}/${mustAc.length})。`,
    `Acceptance standard ${r.acceptance.standard}: ${passedAc} of ${applicable.length} criteria pass (MUST ${mustAc.filter((c) => c.result === 'pass').length}/${mustAc.length}).`,
  ));
  lines.push(L(`發布建議(規則引擎):${readyZh[r.release.readiness]}${r.release.hits.length ? `,觸發 ${r.release.hits.length} 條規則` : ''}。`, `Release readiness (rules engine): ${r.release.readiness}${r.release.hits.length ? `, ${r.release.hits.length} rule(s) triggered` : ''}.`));
  const d = r.counts.defects;
  const total = d.critical + d.high + d.medium + d.low;
  lines.push(total
    ? L(`遊戲缺陷 ${total} 個(Critical ${d.critical} / High ${d.high} / Medium ${d.medium} / Low ${d.low})。`, `${total} game defect(s) (Critical ${d.critical} / High ${d.high} / Medium ${d.medium} / Low ${d.low}).`)
    : L('未發現確認的遊戲缺陷。', 'No confirmed game defects.'));
  const triage = r.findings.filter((f) => f.classification === 'NEEDS_TRIAGE').length;
  if (triage) lines.push(L(`${triage} 項異常無法自動歸因,需人工判讀。`, `${triage} anomaly(ies) could not be attributed automatically; manual triage needed.`));
  if (r.aiFailures.length) lines.push(L(`AI 測試本身有 ${r.aiFailures.length} 類問題(不計入遊戲缺陷)。`, `${r.aiFailures.length} AI-testing issue type(s) recorded (not counted as game defects).`));
  const sr = mval('ai_action_success_rate');
  const cov = mval('module_coverage');
  lines.push(L(
    `AI 共 ${mval('ai_action_count') ?? 0} 次操作${sr !== null ? `,成功率 ${sr}%` : ''}${cov !== null ? `;模組覆蓋率 ${cov}%` : ''}。`,
    `${mval('ai_action_count') ?? 0} AI action(s)${sr !== null ? `, success ${sr}%` : ''}${cov !== null ? `; module coverage ${cov}%` : ''}.`,
  ));
  const led = r.acceptance.rtp;
  const rtp = mval('observed_rtp');
  if (led) {
    lines.push(led.rtpNet !== null
      ? L(
        `RTP(帳務重算):淨 ${led.rtpNet}%,${led.spins.toLocaleString('en-US')} 局付費旋轉,95% 信賴區間 ±${led.stats.ci95Pp} 個百分點${led.stats.sigmaSource === 'assumed' ? '(σ 為假設值)' : ''}。`,
        `RTP (ledger): net ${led.rtpNet}% over ${led.spins.toLocaleString('en-US')} paid spins, 95% CI ±${led.stats.ci95Pp} pp${led.stats.sigmaSource === 'assumed' ? ' (assumed σ)' : ''}.`,
      )
      : L(
        `RTP(帳務重算):淨 RTP 不可算 —— 量測區間內有 ${led.unresolvedInWindow} 筆非拉霸收入金額未確認;未扣贈送的上限為 ${led.rtpGross}%(${led.spins.toLocaleString('en-US')} 局)。`,
        `RTP (ledger): net RTP not computable — ${led.unresolvedInWindow} non-slot credit(s) in the windows are unconfirmed; upper bound before credits ${led.rtpGross}% (${led.spins.toLocaleString('en-US')} spins).`,
      ));
  } else if (rtp !== null) {
    const exp = r.spec.values['expectedRtp'];
    const spins = mval('spin_count') ?? 0;
    const minSamples = r.release.thresholds['rtpMinSamples'] ?? 100;
    const small = spins < minSamples;
    lines.push(L(
      `Observed RTP ${rtp}%(${spins} 次 Spin${small ? `,未達 ${minSamples} 次,統計上不具代表性` : ''})${exp !== undefined ? `,規格 ${exp}%` : ',未提供 Expected RTP'}。`,
      `Observed RTP ${rtp}% over ${spins} spin(s)${small ? ` (below ${minSamples}; not statistically meaningful)` : ''}${exp !== undefined ? `, spec ${exp}%` : ', no Expected RTP provided'}.`,
    ));
  }
  const topRisk = r.risks[0];
  if (topRisk) lines.push(L(`最高風險:${topRisk.title.zh}(${topRisk.level})。`, `Top risk: ${topRisk.title.en} (${topRisk.level}).`));
  return lines.slice(0, 10);
}

// ───────── 圖表 ─────────

function buildCharts(
  defs: ChartDefinition[],
  steps: EvidenceStep[],
  findings: Finding[],
  aiFailures: Finding[],
  modules: ModuleResult[],
  spec: ReportSpec,
  origin: Map<string, string>,
  genres: string[],
  hasPerf: boolean,
  stateCounts: Map<string, number>,
): ChartData[] {
  void origin;
  const out: ChartData[] = [];
  const allDefs = [...defs];
  for (const o of spec.observe) {
    if (o.type === 'number' && !allDefs.some((d) => d.id === `obs_${o.key}_timeline`)) {
      allDefs.push({ id: `obs_${o.key}_timeline`, type: 'line', title: o.label, source: { kind: 'obs_timeline', key: o.key }, priority: 90, xLabel: L('步驟', 'Step') });
    }
  }
  for (const d of allDefs) {
    if (d.condition === 'perf_available' && !hasPerf) continue;
    const threshold = typeof d.threshold === 'number' ? d.threshold : d.threshold ? spec.values[d.threshold.spec] : undefined;
    if (d.condition === 'expected_rtp' && threshold === undefined) continue;
    const series = chartSeries(d, steps, findings, aiFailures, modules, stateCounts);
    const points = series.reduce((a, s) => a + s.points.length, 0);
    const minPoints = d.type === 'line' ? 2 : 1;
    if (!series.length || series.every((s) => s.points.length < minPoints) || points === 0) continue;
    out.push({
      id: d.id,
      type: d.type,
      title: d.title,
      series,
      ...(threshold !== undefined ? { threshold } : {}),
      ...(d.xLabel ? { xLabel: d.xLabel } : {}),
      ...(d.yLabel ? { yLabel: d.yLabel } : {}),
      profile: genres.find((g) => d.id.includes(g)) ?? 'global',
    });
  }
  return out;
}

function chartSeries(
  d: ChartDefinition,
  steps: EvidenceStep[],
  findings: Finding[],
  aiFailures: Finding[],
  modules: ModuleResult[],
  stateCounts: Map<string, number>,
): ChartData['series'] {
  if (d.source.kind === 'obs_timeline') {
    const s = obsSeries(steps, d.source.key);
    return [{ name: d.title, points: s.map((p) => ({ x: p.step, y: p.v })) }];
  }
  switch (d.source.fn) {
    case 'assertion_donut': {
      const c = { pass: 0, fail: 0, unclear: 0 };
      for (const s of steps) if (s.assertion) c[s.assertion]++;
      if (c.pass + c.fail + c.unclear === 0) return [];
      return [{ name: L('檢查', 'Checks'), points: [{ x: 'pass', y: c.pass }, { x: 'fail', y: c.fail }, { x: 'unclear', y: c.unclear }] }];
    }
    case 'module_pass_bar': {
      const pts = modules.filter((m) => m.passRate !== null).map((m) => ({ x: m.label.en, y: m.passRate! }));
      return pts.length ? [{ name: L('通過率', 'Pass Rate'), points: pts }] : [];
    }
    case 'severity_bar': {
      const g = findings.filter((f) => f.classification !== 'AI_TEST_FAILURE');
      if (!g.length) return [];
      return [{ name: L('缺陷', 'Defects'), points: (['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => ({ x: s, y: g.filter((f) => f.severity === s).length })) }];
    }
    case 'category_bar': {
      const g = findings.filter((f) => f.classification !== 'AI_TEST_FAILURE');
      if (!g.length) return [];
      const m = new Map<string, number>();
      for (const f of g) m.set(f.category, (m.get(f.category) ?? 0) + 1);
      return [{ name: L('缺陷', 'Defects'), points: [...m].map(([x, y]) => ({ x, y })) }];
    }
    case 'classification_donut': {
      const all = [...findings, ...aiFailures];
      if (!all.length) return [];
      const m = new Map<string, number>();
      for (const f of all) m.set(f.classification, (m.get(f.classification) ?? 0) + 1);
      return [{ name: L('歸因', 'Attribution'), points: [...m].map(([x, y]) => ({ x, y })) }];
    }
    case 'action_bar': {
      const m = new Map<string, number>();
      for (const s of steps) m.set(s.action, (m.get(s.action) ?? 0) + 1);
      return m.size ? [{ name: L('動作', 'Actions'), points: [...m].map(([x, y]) => ({ x, y })) }] : [];
    }
    case 'confidence_line':
      return [{ name: L('信心', 'Confidence'), points: steps.filter((s) => typeof s.confidence === 'number').map((s) => ({ x: s.index, y: round2(s.confidence! * 100) })) }];
    case 'latency_line':
      return [{ name: L('耗時', 'Duration'), points: steps.filter((s) => typeof s.durationMs === 'number').map((s) => ({ x: s.index, y: s.durationMs! })) }];
    case 'cpu_line':
      return [{ name: L('CPU', 'CPU'), points: steps.filter((s) => typeof s.perf?.cpuPct === 'number').map((s) => ({ x: s.index, y: s.perf!.cpuPct! })) }];
    case 'mem_line':
      return [{ name: L('RAM', 'RAM'), points: steps.filter((s) => typeof s.perf?.memMB === 'number').map((s) => ({ x: s.index, y: s.perf!.memMB! })) }];
    case 'fps_line':
      return [{ name: L('FPS', 'FPS'), points: steps.filter((s) => typeof s.perf?.fps === 'number').map((s) => ({ x: s.index, y: s.perf!.fps! })) }];
    case 'gpu_line':
      return [{ name: L('GPU', 'GPU'), points: steps.filter((s) => typeof s.perf?.gpuPct === 'number').map((s) => ({ x: s.index, y: s.perf!.gpuPct! })) }];
    case 'temp_line': {
      const series = (name: L10n, k: 'batteryTempC' | 'cpuTempC' | 'gpuTempC' | 'skinTempC') => ({
        name, points: steps.filter((s) => typeof s.perf?.[k] === 'number').map((s) => ({ x: s.index, y: s.perf![k]! })),
      });
      return [series(L('電池', 'Battery'), 'batteryTempC'), series(L('CPU', 'CPU'), 'cpuTempC'), series(L('GPU', 'GPU'), 'gpuTempC'), series(L('機身', 'Skin'), 'skinTempC')]
        .filter((x) => x.points.length > 0);
    }
    case 'frametime_bar': {
      // 幀時間分布(合併所有取樣的 present-to-present 直方圖,分段彙總)。
      const bands: Array<[string, number, number]> = [['≤17ms', 0, 17], ['18–25ms', 18, 25], ['26–34ms', 26, 34], ['35–50ms', 35, 50], ['51–100ms', 51, 100], ['>100ms', 101, Infinity]];
      const cnt = bands.map(() => 0);
      for (const s of steps) {
        for (const [ms, n] of Object.entries(s.perf?.frameHist ?? {})) {
          const v = Number(ms);
          const bi = bands.findIndex(([, lo, hi]) => v >= lo && v <= hi);
          if (bi >= 0) cnt[bi]! += n;
        }
      }
      if (cnt.every((n) => n === 0)) return [];
      return [{ name: L('幀數', 'Frames'), points: bands.map(([label], i) => ({ x: label, y: cnt[i]! })) }];
    }
    case 'state_bar': {
      if (!stateCounts.size) return [];
      const label = (id: string) => GAME_STATES.find((g) => g.id === id)?.label.en ?? id;
      return [{ name: L('步數', 'Steps'), points: [...stateCounts].map(([id, y]) => ({ x: label(id), y })) }];
    }
    case 'rtp_convergence': {
      const t = spinTransactions(steps);
      let bet = 0, win = 0;
      const pts = t.map((x, i) => { bet += x.bet; win += x.win; return { x: i + 1, y: bet > 0 ? round2((win / bet) * 100) : 0 }; });
      return [{ name: L('累積 RTP', 'Cumulative RTP'), points: pts }];
    }
    case 'win_loss_donut': {
      const t = spinTransactions(steps);
      if (!t.length) return [];
      return [{ name: L('Spin', 'Spins'), points: [{ x: 'win', y: t.filter((x) => x.win > 0).length }, { x: 'loss', y: t.filter((x) => x.win === 0).length }] }];
    }
    case 'bet_vs_payout': {
      const t = spinTransactions(steps);
      if (!t.length) return [];
      return [{ name: L('金額', 'Amount'), points: [{ x: 'bet', y: t.reduce((a, x) => a + x.bet, 0) }, { x: 'payout', y: t.reduce((a, x) => a + x.win, 0) }] }];
    }
  }
  return [];
}
