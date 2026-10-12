/**
 * 指標計算器(確定性)。全部只從 Evidence / Finding / Spec 計算;資料不足回 null(not_collected)。
 * MetricDefinition.calc 以資料指向這裡的計算器,profile 不含任何函式。
 */
import type { EvidenceStep, Finding, MetricCalc, ModuleDef, PerfMeta, PerfSample } from './types.js';
import { autospinWindows, buildRtpLedger, type RtpLedger } from './rtpLedger.js';

/** 同一份 steps 只算一次 RTP 帳務(多個指標共用)。 */
const ledgerCache = new WeakMap<EvidenceStep[], RtpLedger | null>();
function ledgerOf(c: { steps: EvidenceStep[]; values: Record<string, number> }): RtpLedger | null {
  if (!ledgerCache.has(c.steps)) ledgerCache.set(c.steps, buildRtpLedger(c.steps, c.values));
  return ledgerCache.get(c.steps) ?? null;
}

export interface MetricContext {
  steps: EvidenceStep[];
  findings: Finding[];
  aiFailures: Finding[];
  terminalState: string;
  /** report-spec values(如 expectedRtp)。 */
  values: Record<string, number>;
  thresholds: Record<string, number>;
  modules: ModuleDef[];
  /** 已計算的模組/機制覆蓋。 */
  moduleCoverage: { covered: number; total: number };
  mechanicCoverage: { covered: number; total: number; pass: number; fail: number };
  wallClockMs?: number;
  tokens?: { input: number; output: number };
  /** runner 效能中繼資料(啟動時間、累計耗電)。 */
  perfMeta?: PerfMeta;
}

// hold(長按,例如拉霸長按 SPIN 開 AutoSpin)、combo、pinch 也是對畫面的實際操作。
const INTERACTIVE = new Set(['tap', 'swipe', 'move', 'type', 'back', 'launch', 'hold', 'combo', 'pinch']);

export function isInteractive(s: EvidenceStep): boolean {
  return INTERACTIVE.has(s.action);
}

function pct(n: number, d: number): number | null {
  return d > 0 ? round2((n / d) * 100) : null;
}
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
function avg(values: number[]): number | null {
  return values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

/** 數值觀測序列(依步序)。 */
export function obsSeries(steps: EvidenceStep[], key: string): Array<{ step: number; v: number }> {
  const out: Array<{ step: number; v: number }> = [];
  for (const s of steps) {
    const raw = s.obs?.[key];
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : NaN;
    if (Number.isFinite(v)) out.push({ step: s.index, v });
  }
  return out;
}

// ───────── Slot / 經濟:逐 spin 交易重建 ─────────

export interface SpinTxn {
  step: number;
  bet: number;
  win: number;
  balance?: number;
}

/** 由觀測欄位(bet/win/balance)重建每一次 spin;同一 spin 連續重複回報只算一次。 */
export function spinTransactions(steps: EvidenceStep[]): SpinTxn[] {
  const txns: SpinTxn[] = [];
  let lastSig = '';
  for (const s of steps) {
    const o = s.obs;
    if (!o) continue;
    // AutoSpin 進行中的觀測是「多次 spin 之後的累計狀態」,不是單次 spin 結果(改走 autospinRtp 餘額差法),
    // 不可當成逐次交易,否則餘額一致性檢查會誤報大量不一致。
    if (toNum(o['autospin_left']) !== null) continue;
    // Bonus / Free Spins 期間不扣注、派彩於結算時一次入帳,逐格比對必然「不一致」,不列入逐次交易。
    if (o['bonus'] === true) continue;
    const bet = toNum(o['bet']);
    if (bet === null || bet <= 0) continue;
    const spun = o['spun'] === true || s.mechanic === 'spin';
    const win = toNum(o['win']) ?? 0;
    const balance = toNum(o['balance']) ?? undefined;
    const sig = `${bet}|${win}|${balance ?? ''}`;
    // 沒有明確 spun 旗標時,用「數值組合改變」視為新的一次 spin 結果。
    if (!spun && sig === lastSig) continue;
    lastSig = sig;
    txns.push({ step: s.index, bet, win, ...(balance !== undefined ? { balance } : {}) });
  }
  return txns;
}

/**
 * 自動旋轉(AutoSpin)RTP:餘額差法。AI 只讀畫面上的數字(autospin_left 剩餘次數、balance、bet),
 * 由程式計算:spins = 剩餘次數的累計遞減(重新啟動 AutoSpin 計數回升時視為新段落),
 * RTP = 1 + (最後餘額 − 最初餘額) / (spins × bet)。逐次讀派彩太慢(每步 1 spin),AutoSpin 一步可跑數十次。
 * 限制:期間若有非 spin 的獎勵入帳(升級/任務獎金)會使 RTP 偏高;報告附註說明。
 */
export function autospinRtp(steps: EvidenceStep[]): { spins: number; bet: number; startBalance: number; endBalance: number; rtp: number; groups: number } | null {
  // 量測區間的切法(換連線 / 換投注額 / 重開 AutoSpin 都切開)集中在 rtpLedger,報告各處用同一套數字。
  const windows = autospinWindows(steps);
  if (!windows.length) return null;
  const spins = windows.reduce((a, w) => a + w.spins, 0);
  const wagered = windows.reduce((a, w) => a + w.wagered, 0);
  const delta = windows.reduce((a, w) => a + w.balanceDelta, 0);
  if (!spins || !wagered) return null;
  const bets = windows.map((w) => w.bet).sort((a, b) => a - b);
  return {
    spins,
    bet: bets[Math.floor(bets.length / 2)]!,
    startBalance: windows[0]!.balanceStart.value,
    endBalance: windows[windows.length - 1]!.balanceEnd.value,
    groups: windows.length,
    rtp: round2((1 + delta / wagered) * 100),
  };
}

/** 本次可用的 Spin 樣本數(逐次交易與 AutoSpin 餘額差法取較大者)。 */
export function spinSampleCount(steps: EvidenceStep[]): number {
  return Math.max(spinTransactions(steps).length, autospinRtp(steps)?.spins ?? 0);
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 餘額一致性檢查:balance_n ≈ balance_{n-1} − bet_n + win_n(容差 0.5% 或 1)。 */
export function balanceChecks(txns: SpinTxn[]): { checked: number; mismatches: SpinTxn[] } {
  let checked = 0;
  const mismatches: SpinTxn[] = [];
  for (let i = 1; i < txns.length; i++) {
    const prev = txns[i - 1]!;
    const cur = txns[i]!;
    if (prev.balance === undefined || cur.balance === undefined) continue;
    const expected = prev.balance - cur.bet + cur.win;
    const tol = Math.max(1, Math.abs(expected) * 0.005);
    checked++;
    if (Math.abs(cur.balance - expected) > tol) mismatches.push(cur);
  }
  return { checked, mismatches };
}

// ───────── 內建計算器 ─────────

type Calc = (ctx: MetricContext) => number | null;

function assertionCounts(steps: EvidenceStep[]) {
  let pass = 0, fail = 0, unclear = 0;
  for (const s of steps) {
    if (s.assertion === 'pass') pass++;
    else if (s.assertion === 'fail') fail++;
    else if (s.assertion === 'unclear') unclear++;
  }
  return { pass, fail, unclear };
}

function gameFindings(ctx: MetricContext, sev?: string): number {
  return ctx.findings.filter((f) => f.classification === 'GAME_FAILURE' && (!sev || f.severity === sev)).length;
}

function crashCount(ctx: MetricContext): number {
  return ctx.findings.filter((f) => f.category === 'crash').reduce((a, f) => a + f.frequency, 0);
}

/** 卡住事件(連續 stuck_wait/stuck_escape 視為一次)。 */
function stuckEpisodes(steps: EvidenceStep[]): number {
  let n = 0;
  let inEp = false;
  for (const s of steps) {
    const stuck = s.override === 'stuck_wait' || s.override === 'stuck_escape';
    if (stuck && !inEp) n++;
    inEp = stuck;
  }
  return n;
}

/** 重試:同畫面、同動作,且上一步無可見效果。 */
function retryCount(steps: EvidenceStep[]): number {
  let n = 0;
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!;
    const b = steps[i]!;
    if (isInteractive(b) && a.action === b.action && a.screen === b.screen && a.effective === false) n++;
  }
  return n;
}

function recoveryStats(steps: EvidenceStep[]): { attempts: number; success: number } {
  let attempts = 0, success = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.override !== 'stuck_escape' && !s.foregroundLost) continue;
    attempts++;
    if (s.effective === true) success++;
  }
  return { attempts, success };
}

function screenIsLoading(screen: string): boolean {
  return /loading|載入|载入|請稍候|connecting|連線中|logo|進場/i.test(screen);
}

const BUILTIN: Record<string, Calc> = {
  ai_action_count: (c) => c.steps.filter(isInteractive).length,
  total_steps: (c) => c.steps.length,
  ai_successful_actions: (c) => {
    const ok = c.steps.filter((s) => isInteractive(s) && (s.assertion === 'pass' || (s.assertion === undefined && s.effective === true))).length;
    return c.steps.some((s) => s.assertion !== undefined || s.effective !== undefined) ? ok : null;
  },
  ai_action_success_rate: (c) => {
    const { pass, fail } = assertionCounts(c.steps);
    if (pass + fail > 0) return pct(pass, pass + fail);
    // 舊報告無 assertion:退用「動作後畫面有可見變化」比例。
    const judged = c.steps.filter((s) => isInteractive(s) && s.effective !== undefined);
    return judged.length ? pct(judged.filter((s) => s.effective).length, judged.length) : null;
  },
  effective_action_rate: (c) => {
    const judged = c.steps.filter((s) => isInteractive(s) && s.effective !== undefined);
    return judged.length ? pct(judged.filter((s) => s.effective).length, judged.length) : null;
  },
  assertion_pass: (c) => nullIfNoAssert(c, assertionCounts(c.steps).pass),
  assertion_fail: (c) => nullIfNoAssert(c, assertionCounts(c.steps).fail),
  assertion_unclear: (c) => nullIfNoAssert(c, assertionCounts(c.steps).unclear),
  assertion_pass_rate: (c) => {
    const { pass, fail } = assertionCounts(c.steps);
    return pass + fail > 0 ? pct(pass, pass + fail) : null;
  },
  avg_confidence: (c) => {
    const v = c.steps.map((s) => s.confidence).filter((x): x is number => typeof x === 'number');
    return v.length ? round2(avg(v)! * 100) : null;
  },
  low_confidence_actions: (c) => {
    const v = c.steps.filter((s) => typeof s.confidence === 'number');
    return v.length ? v.filter((s) => s.confidence! < 0.6).length : null;
  },
  retry_count: (c) => (c.steps.some((s) => s.effective !== undefined) ? retryCount(c.steps) : null),
  retry_rate: (c) => {
    if (!c.steps.some((s) => s.effective !== undefined)) return null;
    return pct(retryCount(c.steps), c.steps.filter(isInteractive).length);
  },
  recovery_count: (c) => recoveryStats(c.steps).attempts,
  recovery_success_rate: (c) => {
    const r = recoveryStats(c.steps);
    return r.attempts && c.steps.some((s) => s.effective !== undefined) ? pct(r.success, r.attempts) : null;
  },
  invalid_action_count: (c) => c.steps.filter((s) => s.parseFailed).length,
  invalid_action_rate: (c) => pct(c.steps.filter((s) => s.parseFailed).length, c.steps.length),
  model_error_count: (c) => c.steps.filter((s) => s.modelError).length,
  runner_override_count: (c) => c.steps.filter((s) => s.override).length,
  stuck_count: (c) => stuckEpisodes(c.steps),
  /** 導航失敗:runner 必須介入脫困的事件數(AI 找不到出口/可互動元件)。 */
  navigation_failure_count: (c) => {
    let n = 0;
    let inEp = false;
    for (const s of c.steps) {
      const esc = s.override === 'stuck_escape';
      if (esc && !inEp) n++;
      inEp = esc;
    }
    return n;
  },
  unique_screens: (c) => new Set(c.steps.map((s) => s.screen)).size,
  screen_transitions: (c) => {
    let n = 0;
    for (let i = 1; i < c.steps.length; i++) if (c.steps[i]!.screen !== c.steps[i - 1]!.screen) n++;
    return n;
  },
  avg_step_ms: (c) => avg(c.steps.map((s) => s.durationMs).filter((x): x is number => typeof x === 'number')),
  p95_step_ms: (c) => percentile(c.steps.map((s) => s.durationMs).filter((x): x is number => typeof x === 'number'), 95),
  avg_vlm_ms: (c) => avg(c.steps.map((s) => s.vlmMs).filter((x): x is number => typeof x === 'number')),
  ai_exec_time_s: (c) => {
    const v = c.steps.map((s) => s.durationMs).filter((x): x is number => typeof x === 'number');
    return v.length ? round2(v.reduce((a, b) => a + b, 0) / 1000) : null;
  },
  wall_clock_s: (c) => (c.wallClockMs !== undefined ? round2(c.wallClockMs / 1000) : null),
  tokens_total: (c) => (c.tokens ? c.tokens.input + c.tokens.output : null),
  defects_critical: (c) => gameFindings(c, 'critical'),
  defects_high: (c) => gameFindings(c, 'high'),
  defects_medium: (c) => gameFindings(c, 'medium'),
  defects_low: (c) => gameFindings(c, 'low'),
  game_defects_total: (c) => gameFindings(c),
  needs_triage_count: (c) => c.findings.filter((f) => f.classification === 'NEEDS_TRIAGE').length,
  ai_test_failures: (c) => c.aiFailures.length,
  crash_count: (c) => crashCount(c),
  crash_rate_per_hour: (c) => {
    const ms = c.wallClockMs ?? c.steps.reduce((a, s) => a + (s.durationMs ?? 0), 0);
    return ms > 0 ? round2(crashCount(c) / (ms / 3_600_000)) : null;
  },
  core_gameplay_block: (c) => c.findings.filter((f) => f.classification === 'GAME_FAILURE' && f.category !== 'crash' && isCoreModule(c, f.module) && (f.severity === 'critical' || f.severity === 'high')).length,
  progression_block: (c) => c.findings.filter((f) => f.classification === 'GAME_FAILURE' && /progress|block|卡關|阻斷/i.test(f.title.en + f.title.zh)).length,
  freeze_count: (c) => c.findings.filter((f) => f.category === 'performance' && /freeze|凍結/i.test(f.title.en + f.title.zh)).length,
  module_coverage: (c) => (c.moduleCoverage.total ? pct(c.moduleCoverage.covered, c.moduleCoverage.total) : null),
  mechanic_coverage: (c) => (c.mechanicCoverage.total ? pct(c.mechanicCoverage.covered, c.mechanicCoverage.total) : null),
  mechanic_pass_rate: (c) => {
    const { pass, fail } = c.mechanicCoverage;
    return pass + fail > 0 ? pct(pass, pass + fail) : null;
  },
  loading_steps: (c) => c.steps.filter((s) => screenIsLoading(s.screen)).length,
  // 效能(runner adb shell 取樣;舊版為 Appium getPerformanceData,只有 CPU/記憶體)
  perf_samples: (c) => c.steps.filter((s) => s.perf && Object.keys(s.perf).length > 0).length || null,
  /** 平均 FPS = 全部取樣區間的總幀數 ÷ 總時間(幀加權,不是取樣值平均)。 */
  fps_avg: (c) => {
    const ss = c.steps.map((s) => s.perf).filter((p): p is PerfSample => typeof p?.frames === 'number' && typeof p.fpsSpanS === 'number' && p.fpsSpanS > 0);
    const span = ss.reduce((a, p) => a + p.fpsSpanS!, 0);
    if (span > 0) return round2(ss.reduce((a, p) => a + p.frames!, 0) / span);
    return avg(perfVals(c, 'fps'));
  },
  /** 最低 FPS = 取樣區間(≥ 2 秒)中最低的區間平均 FPS。 */
  fps_min: (c) => {
    const v = c.steps.map((s) => s.perf).filter((p): p is PerfSample => typeof p?.fps === 'number' && (p.fpsSpanS ?? 2) >= 2).map((p) => p.fps!);
    return v.length ? round2(Math.min(...v)) : null;
  },
  /**
   * P1 FPS(1% Low)= 1000 ÷ 第 99 百分位幀時間(合併全部取樣的 present-to-present 直方圖)。
   * 直方圖以 1ms 取整分桶(8.33ms 落在 8ms 桶),取桶中點估算;定義上 1% Low 不會高於平均。
   */
  fps_p1: (c) => {
    const p99 = histPercentile(mergedFrameHist(c), 99);
    if (p99 === null) return null;
    const v = round2(1000 / (p99 + 0.5));
    const mean = BUILTIN['fps_avg']!(c);
    return mean !== null ? Math.min(v, mean) : v;
  },
  frame_time_p95: (c) => {
    const p95 = histPercentile(mergedFrameHist(c), 95);
    return p95 === null ? null : p95 + 0.5;
  },
  gpu_usage: (c) => avg(perfVals(c, 'gpuPct')),
  gpu_peak: (c) => maxOrNull(perfVals(c, 'gpuPct')),
  gfx_mem_peak_mb: (c) => maxOrNull(perfVals(c, 'gfxMemMB')),
  /** 冷啟動時間:am start -W 的 TotalTime(啟動到第一幀)。 */
  app_start_ms: (c) => (typeof c.perfMeta?.launch?.totalTimeMs === 'number' ? c.perfMeta.launch.totalTimeMs : null),
  /** 載入時間:App 啟動 → AI 第一次看到「非載入/開場」畫面的時間。 */
  loading_time: (c) => {
    const at = c.perfMeta?.launch?.at;
    const t0 = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t0)) return null;
    const first = c.steps.find((s) => s.at && !screenIsLoading(s.screen));
    const t1 = first?.at ? Date.parse(first.at) : NaN;
    return Number.isFinite(t1) && t1 >= t0 ? round2((t1 - t0) / 1000) : null;
  },
  device_temperature: (c) => maxOrNull(perfVals(c, 'batteryTempC')),
  cpu_temp_peak: (c) => maxOrNull(perfVals(c, 'cpuTempC')),
  /** App 估算耗電(mAh;Android batterystats 依 power profile 估算,Device Farm 真機接電時仍可用)。 */
  battery_drain: (c) => {
    const meta = c.perfMeta?.batteryMah;
    const fromSteps = maxOrNull(perfVals(c, 'batteryMah'));
    const v = typeof meta === 'number' ? Math.max(meta, fromSteps ?? 0) : fromSteps;
    return v === null || v === undefined ? null : round2(v);
  },
  battery_drain_per_hour: (c) => {
    const drain = BUILTIN['battery_drain']!(c);
    const ms = c.wallClockMs;
    return drain !== null && ms && ms > 60_000 ? round2(drain / (ms / 3_600_000)) : null;
  },
  cpu_avg: (c) => avg(perfVals(c, 'cpuPct')),
  cpu_peak: (c) => maxOrNull(perfVals(c, 'cpuPct')),
  mem_avg_mb: (c) => avg(perfVals(c, 'memMB')),
  mem_peak_mb: (c) => maxOrNull(perfVals(c, 'memMB')),
  /**
   * 記憶體成長:以「載入完成後」的第一筆為基準(載入期資源配置不算洩漏);
   * 載入後取樣不足 2 筆才退回全部取樣。
   */
  mem_growth_mb: (c) => {
    const firstPlay = c.steps.findIndex((s) => !screenIsLoading(s.screen));
    const after = firstPlay >= 0
      ? c.steps.slice(firstPlay).map((s) => s.perf?.memMB).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      : [];
    const v = after.length >= 2 ? after : perfVals(c, 'memMB');
    return v.length >= 2 ? round2(v[v.length - 1]! - v[0]!) : null;
  },
  // Slot
  spin_count: (c) => nz(spinSampleCount(c.steps)),
  autospin_spins: (c) => autospinRtp(c.steps)?.spins ?? null,
  autospin_rtp: (c) => autospinRtp(c.steps)?.rtp ?? null,
  win_count: (c) => nz0(spinTransactions(c.steps), (t) => t.filter((x) => x.win > 0).length),
  loss_count: (c) => nz0(spinTransactions(c.steps), (t) => t.filter((x) => x.win === 0).length),
  hit_frequency: (c) => {
    const t = spinTransactions(c.steps);
    return t.length ? pct(t.filter((x) => x.win > 0).length, t.length) : null;
  },
  // AutoSpin(餘額差法)樣本較多時,總下注 / 總派彩 / RTP 一律取 RTP 帳務(與報告「RTP 帳務」表同一組數字)。
  total_bet: (c) => {
    const t = spinTransactions(c.steps);
    const led = ledgerOf(c);
    if (led && led.spins >= t.length) return led.wagered;
    return nz0(t, (x) => x.reduce((a, y) => a + y.bet, 0));
  },
  total_win: (c) => {
    const t = spinTransactions(c.steps);
    const led = ledgerOf(c);
    if (led && led.spins >= t.length) return led.derivedWin;
    return nz0(t, (x) => x.reduce((a, y) => a + y.win, 0));
  },
  /** 淨 RTP(已扣除量測區間內的非拉霸收入);區間內有金額未確認的贈送 → null(不可算)。 */
  observed_rtp: (c) => {
    const t = spinTransactions(c.steps);
    const led = ledgerOf(c);
    if (led && led.spins >= t.length) return led.rtpNet;
    const bet = t.reduce((a, x) => a + x.bet, 0);
    return bet > 0 ? pct(t.reduce((a, x) => a + x.win, 0), bet) : null;
  },
  rtp_deviation_pp: (c) => {
    const exp = c.values['expectedRtp'];
    const obs = BUILTIN['observed_rtp']!(c);
    return typeof exp === 'number' && obs !== null ? round2(obs - exp) : null;
  },
  rtp_abs_deviation_pp: (c) => {
    const d = BUILTIN['rtp_deviation_pp']!(c);
    return d === null ? null : Math.abs(d);
  },
  /** 樣本數達 rtpMinSamples 才有統計意義;不足回 null(不據以判定)。 */
  rtp_significant_deviation_pp: (c) => {
    const min = c.thresholds['rtpMinSamples'] ?? 100;
    if (spinSampleCount(c.steps) < min) return null;
    return BUILTIN['rtp_abs_deviation_pp']!(c);
  },
  /** Hit Frequency 與規格的偏差(需知識庫提供 expectedHitFrequency;樣本需達 rtpMinSamples)。 */
  hit_frequency_deviation_pp: (c) => {
    const exp = c.values['expectedHitFrequency'];
    const t = spinTransactions(c.steps);
    if (typeof exp !== 'number' || t.length < (c.thresholds['rtpMinSamples'] ?? 100)) return null;
    return round2(Math.abs((t.filter((x) => x.win > 0).length / t.length) * 100 - exp));
  },
  /** 下注額超出規格範圍(知識庫提供 minBet / maxBet)的次數。 */
  bet_out_of_range_count: (c) => {
    const min = c.values['minBet'];
    const max = c.values['maxBet'];
    if (typeof min !== 'number' && typeof max !== 'number') return null;
    const t = spinTransactions(c.steps);
    if (!t.length) return null;
    return t.filter((x) => (typeof min === 'number' && x.bet < min) || (typeof max === 'number' && x.bet > max)).length;
  },
  /** 單次派彩超過「最大倍率 × 下注」(知識庫提供 maxWinMultiplier)的次數。 */
  win_cap_violation_count: (c) => {
    const cap = c.values['maxWinMultiplier'];
    if (typeof cap !== 'number') return null;
    const t = spinTransactions(c.steps);
    return t.length ? t.filter((x) => x.win > x.bet * cap).length : null;
  },
  // AutoSpin 模式下兩次觀測之間跨了多次 spin / Bonus 結算,逐次餘額比對不成立 → 不收集(避免誤報 Critical)。
  balance_checks: (c) => (autospinRtp(c.steps) ? null : nz(balanceChecks(spinTransactions(c.steps)).checked)),
  balance_mismatch_count: (c) => {
    if (autospinRtp(c.steps)) return null;
    const r = balanceChecks(spinTransactions(c.steps));
    return r.checked ? r.mismatches.length : null;
  },
  balance_accuracy: (c) => {
    if (autospinRtp(c.steps)) return null;
    const r = balanceChecks(spinTransactions(c.steps));
    return r.checked ? pct(r.checked - r.mismatches.length, r.checked) : null;
  },
  // 經濟(通用 currency/balance)
  negative_balance_count: (c) => {
    const s = [...obsSeries(c.steps, 'balance'), ...obsSeries(c.steps, 'currency'), ...obsSeries(c.steps, 'gold')];
    return s.length ? s.filter((p) => p.v < 0).length : null;
  },
};

function nullIfNoAssert(c: MetricContext, v: number): number | null {
  return c.steps.some((s) => s.assertion !== undefined) ? v : null;
}
function nz(v: number): number | null {
  return v > 0 ? v : null;
}
function nz0<T>(arr: T[], f: (a: T[]) => number): number | null {
  return arr.length ? f(arr) : null;
}
type PerfNumKey = Exclude<keyof PerfSample, 'frameHist'>;
function perfVals(c: MetricContext, k: PerfNumKey): number[] {
  return c.steps.map((s) => s.perf?.[k]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}
/** 合併所有取樣的幀時間直方圖(ms → 幀數)。 */
function mergedFrameHist(c: MetricContext): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of c.steps) {
    for (const [ms, n] of Object.entries(s.perf?.frameHist ?? {})) m.set(Number(ms), (m.get(Number(ms)) ?? 0) + n);
  }
  return m;
}
function histPercentile(h: Map<number, number>, p: number): number | null {
  const total = [...h.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = Math.ceil((p / 100) * total);
  let acc = 0;
  for (const ms of [...h.keys()].sort((a, b) => a - b)) {
    acc += h.get(ms)!;
    if (acc >= target) return ms;
  }
  return null;
}
function maxOrNull(v: number[]): number | null {
  return v.length ? round2(Math.max(...v)) : null;
}
function isCoreModule(c: MetricContext, id: string | undefined): boolean {
  if (!id) return true; // 無法歸屬模組的阻斷,保守視為核心流程
  return c.modules.some((m) => m.id === id && m.core);
}

export function hasBuiltinMetric(fn: string): boolean {
  return fn in BUILTIN;
}

/** 依 MetricCalc 計算值;資料不足回 null。 */
export function computeMetric(calc: MetricCalc, ctx: MetricContext): number | null {
  switch (calc.kind) {
    case 'builtin': {
      const f = BUILTIN[calc.fn];
      return f ? f(ctx) : null;
    }
    case 'spec':
      return typeof ctx.values[calc.key] === 'number' ? ctx.values[calc.key]! : null;
    case 'obs_true_count': {
      const has = ctx.steps.some((s) => s.obs && calc.key in s.obs);
      return has ? ctx.steps.filter((s) => s.obs?.[calc.key] === true || s.obs?.[calc.key] === 'true').length : null;
    }
    default: {
      const s = obsSeries(ctx.steps, calc.key);
      if (s.length === 0) return null;
      const v = s.map((p) => p.v);
      switch (calc.kind) {
        case 'obs_max': return round2(Math.max(...v));
        case 'obs_min': return round2(Math.min(...v));
        case 'obs_last': return round2(v[v.length - 1]!);
        case 'obs_delta': return v.length >= 2 ? round2(v[v.length - 1]! - v[0]!) : null;
        case 'obs_count': return v.length;
        case 'obs_sum': return round2(v.reduce((a, b) => a + b, 0));
        case 'obs_increase_count': {
          let n = 0;
          for (let i = 1; i < v.length; i++) if (v[i]! > v[i - 1]!) n++;
          return n;
        }
      }
      return null;
    }
  }
}
