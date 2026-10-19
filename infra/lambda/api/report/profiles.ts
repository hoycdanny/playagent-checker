/**
 * Genre Profiles —— 「類型知識庫」的報告部分(資料,不含函式)。
 *
 * 每個 profile 定義:測試模組、遊戲機制、要 AI 從畫面讀的觀測欄位、指標、圖表、
 * 風險規則、放行規則、適用的報告區段與測試範疇。報告引擎 = GLOBAL + 所選類型 profiles 合併,
 * 重複項只保留一次。新增類型只需在此新增一筆資料。
 *
 * id 對齊 APP_GENRES(apps.ts)與內建知識庫(kb-builtin-<genre>)。
 */
import type {
  ChartDefinition,
  GenreProfile,
  L10n,
  MechanicDef,
  MetricCalc,
  MetricDefinition,
  MetricGroup,
  MetricSource,
  MetricUnit,
  ModuleDef,
  ObserveDef,
  QualityDimension,
  ReleaseRule,
  RiskRule,
  SpecExclude,
  SpecValueDef,
  TestScopeId,
  ThresholdDef,
} from './types.js';

// ───────── 小工具(讓 profile 資料保持精簡)─────────

const L = (zh: string, en: string): L10n => ({ zh, en });

function metric(
  id: string,
  zh: string,
  en: string,
  unit: MetricUnit,
  group: MetricGroup,
  calc: MetricCalc | string,
  opts: { source?: MetricSource; dimension?: QualityDimension; higherIsBetter?: boolean; description?: L10n } = {},
): MetricDefinition {
  return {
    id,
    label: L(zh, en),
    unit,
    group,
    source: opts.source ?? 'objective',
    calc: typeof calc === 'string' ? { kind: 'builtin', fn: calc } : calc,
    ...(opts.dimension ? { dimension: opts.dimension } : {}),
    ...(opts.higherIsBetter !== undefined ? { higherIsBetter: opts.higherIsBetter } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}
const mod = (id: string, zh: string, en: string, keywords: string[], core = false): ModuleDef => ({
  id, label: L(zh, en), keywords, ...(core ? { core: true } : {}),
});
const mech = (id: string, zh: string, en: string, keywords: string[] = []): MechanicDef => ({ id, label: L(zh, en), keywords });
const obs = (key: string, zh: string, en: string, hint: string, type: ObserveDef['type'] = 'number'): ObserveDef => ({
  key, label: L(zh, en), hint, type,
});
const obsMetric = (
  kind: 'obs_max' | 'obs_min' | 'obs_last' | 'obs_delta' | 'obs_count' | 'obs_increase_count' | 'obs_sum',
  key: string,
  id: string,
  zh: string,
  en: string,
  group: MetricGroup = 'genre',
  unit: MetricUnit = '',
): MetricDefinition => metric(id, zh, en, unit, group, { kind, key }, { source: 'ai_evaluation' });
const timeline = (key: string, zh: string, en: string, priority = 50): ChartDefinition => ({
  id: `obs_${key}_timeline`,
  type: 'line',
  title: L(zh, en),
  source: { kind: 'obs_timeline', key },
  priority,
  xLabel: L('步驟', 'Step'),
});
const risk = (
  id: string, metricId: string, op: RiskRule['op'], value: RiskRule['value'], level: RiskRule['level'],
  title: L10n, impact: L10n,
): RiskRule => ({ id, metric: metricId, op, value, level, title, impact });
const release = (
  id: string, metricId: string, op: ReleaseRule['op'], value: ReleaseRule['value'], outcome: ReleaseRule['outcome'], reason: L10n,
): ReleaseRule => ({ id, metric: metricId, op, value, outcome, reason });
const T = (threshold: string) => ({ threshold });

const ECONOMY_OBS = obs('currency', '主要貨幣', 'Currency', '畫面上主要貨幣/金幣/鑽石數量(只填看得到的數字)');

// ───────── GLOBAL ─────────

const GLOBAL_MODULES: ModuleDef[] = [
  mod('launch', '啟動/載入', 'Launch / Loading', ['loading', '載入', '载入', 'logo', 'splash', '開場', '進場', 'config', 'install', '安裝']),
  mod('login', '登入/帳號', 'Login / Account', ['login', '登入', '登录', 'sign in', 'account', '帳號', 'guest', '訪客']),
  mod('lobby', '大廳/主選單', 'Lobby / Main Menu', ['lobby', '大廳', '大厅', 'main menu', '主選單', '主菜单', '主畫面', 'home', '主城']),
  mod('tutorial', '新手教學', 'Tutorial', ['tutorial', '教學', '教学', 'guide', '引導', '新手']),
  mod('gameplay', '核心玩法', 'Core Gameplay', ['gameplay', 'battle', '戰鬥', '战斗', 'stage', 'level', '關卡', '关卡', 'game'], true),
  mod('result', '結算', 'Result / Settlement', ['result', '結算', '结算', 'victory', 'defeat', 'win', 'fail', 'game over', 'clear']),
  mod('shop', '商店/付費', 'Shop / IAP', ['shop', '商店', 'store', 'purchase', '購買', 'iap', '儲值', '充值']),
  mod('settings', '設定', 'Settings', ['setting', '設定', '设置', 'option', '選項']),
  mod('popup', '公告/活動彈窗', 'Notices / Event Popups', ['popup', '公告', '彈窗', '弹窗', 'notice', 'event', '活動', '簽到', 'reward', '獎勵']),
];

const GLOBAL_METRICS: MetricDefinition[] = [
  // Summary
  metric('ai_action_count', 'AI 操作次數', 'AI Actions', 'count', 'summary', 'ai_action_count'),
  metric('ai_successful_actions', 'AI 成功操作次數', 'AI Successful Actions', 'count', 'summary', 'ai_successful_actions'),
  metric('ai_action_success_rate', 'AI 操作成功率', 'AI Action Success Rate', '%', 'ai_reliability', 'ai_action_success_rate', { higherIsBetter: true }),
  metric('assertion_pass_rate', '檢查通過率', 'Check Pass Rate', '%', 'summary', 'assertion_pass_rate', { dimension: 'functional', higherIsBetter: true, source: 'ai_evaluation' }),
  metric('wall_clock_s', '測試總時間', 'Total Test Time', 's', 'summary', 'wall_clock_s'),
  metric('ai_exec_time_s', 'AI 執行時間', 'AI Execution Time', 's', 'summary', 'ai_exec_time_s'),
  metric('defects_critical', 'Critical 缺陷', 'Critical Defects', 'count', 'summary', 'defects_critical'),
  metric('defects_high', 'High 缺陷', 'High Defects', 'count', 'summary', 'defects_high'),
  metric('defects_medium', 'Medium 缺陷', 'Medium Defects', 'count', 'summary', 'defects_medium'),
  metric('defects_low', 'Low 缺陷', 'Low Defects', 'count', 'summary', 'defects_low'),
  metric('needs_triage_count', '待人工判讀', 'Needs Triage', 'count', 'summary', 'needs_triage_count'),
  metric('tokens_total', 'Token 用量', 'Tokens Used', 'count', 'summary', 'tokens_total'),
  // AI Reliability
  metric('effective_action_rate', '動作有效率(畫面有變化)', 'Effective Action Rate', '%', 'ai_reliability', 'effective_action_rate', { higherIsBetter: true }),
  metric('avg_confidence', '平均信心', 'Average Confidence', '%', 'ai_reliability', 'avg_confidence', { source: 'ai_evaluation', higherIsBetter: true }),
  metric('low_confidence_actions', '低信心操作數(<0.6)', 'Low Confidence Actions', 'count', 'ai_reliability', 'low_confidence_actions', { source: 'ai_evaluation' }),
  metric('retry_rate', '重試率', 'Retry Rate', '%', 'ai_reliability', 'retry_rate'),
  metric('retry_count', '重試次數', 'Retry Count', 'count', 'ai_reliability', 'retry_count'),
  metric('recovery_count', '恢復介入次數', 'Recovery Attempts', 'count', 'ai_reliability', 'recovery_count'),
  metric('recovery_success_rate', '恢復成功率', 'Recovery Success Rate', '%', 'ai_reliability', 'recovery_success_rate', { higherIsBetter: true }),
  metric('invalid_action_count', '無效輸出(無法解析)', 'Invalid Action Count', 'count', 'ai_reliability', 'invalid_action_count'),
  metric('invalid_action_rate', '無效輸出比例', 'Invalid Output Rate', '%', 'ai_reliability', 'invalid_action_rate'),
  metric('model_error_count', '模型呼叫失敗/逾時', 'Model Error / Timeout', 'count', 'ai_reliability', 'model_error_count'),
  metric('runner_override_count', 'Runner 介入修正次數', 'Runner Overrides', 'count', 'ai_reliability', 'runner_override_count'),
  metric('stuck_count', '卡住事件數', 'Stuck Count', 'count', 'ai_reliability', 'stuck_count'),
  metric('navigation_failure_count', '導航失敗', 'Navigation Failures', 'count', 'ai_reliability', 'navigation_failure_count'),
  metric('hallucinated_action_count', '幻覺操作數', 'Hallucinated Actions', 'count', 'ai_reliability', 'hallucinated_action_count'),
  metric('element_detection_accuracy', '元件偵測準確率', 'Element Detection Accuracy', '%', 'ai_reliability', 'element_detection_accuracy'),
  metric('avg_vlm_ms', '平均模型延遲', 'Avg Model Latency', 'ms', 'ai_reliability', 'avg_vlm_ms'),
  metric('avg_step_ms', '平均每步耗時', 'Avg Step Duration', 'ms', 'ai_reliability', 'avg_step_ms'),
  metric('p95_step_ms', 'P95 每步耗時', 'P95 Step Duration', 'ms', 'ai_reliability', 'p95_step_ms'),
  // Coverage
  metric('module_coverage', '模組覆蓋率', 'Module Coverage', '%', 'coverage', 'module_coverage', { higherIsBetter: true }),
  metric('mechanic_coverage', '機制覆蓋率', 'Mechanic Coverage', '%', 'coverage', 'mechanic_coverage', { higherIsBetter: true }),
  metric('mechanic_pass_rate', '機制測試通過率', 'Mechanic Test Pass Rate', '%', 'coverage', 'mechanic_pass_rate', { dimension: 'gameplay', higherIsBetter: true, source: 'ai_evaluation' }),
  metric('unique_screens', '不同畫面數', 'Unique Screens', 'count', 'coverage', 'unique_screens'),
  metric('screen_transitions', '畫面轉換數', 'Screen Transitions', 'count', 'coverage', 'screen_transitions'),
  // Performance(未接上資料來源者顯示「未收集」,不給假值)
  metric('fps_avg', '平均 FPS', 'Average FPS', '', 'performance', 'fps_avg', { dimension: 'performance' }),
  metric('fps_p1', 'P1 FPS', 'P1 FPS', '', 'performance', 'fps_p1', { dimension: 'performance' }),
  metric('fps_min', '最低 FPS', 'Minimum FPS', '', 'performance', 'fps_min', { dimension: 'performance' }),
  metric('frame_time_p95', 'P95 Frame Time', 'P95 Frame Time', 'ms', 'performance', 'frame_time_p95', { dimension: 'performance' }),
  metric('cpu_avg', '平均 CPU', 'Avg CPU Usage', '%', 'performance', 'cpu_avg', { dimension: 'performance' }),
  metric('cpu_peak', '峰值 CPU', 'Peak CPU Usage', '%', 'performance', 'cpu_peak', { dimension: 'performance' }),
  metric('mem_avg_mb', '平均記憶體', 'Avg RAM', 'MB', 'performance', 'mem_avg_mb', { dimension: 'performance' }),
  metric('mem_peak_mb', '峰值記憶體', 'Peak RAM', 'MB', 'performance', 'mem_peak_mb', { dimension: 'performance' }),
  metric('gpu_usage', 'GPU 使用率', 'GPU Usage', '%', 'performance', 'gpu_usage', { dimension: 'performance' }),
  metric('gpu_peak', '峰值 GPU', 'Peak GPU Usage', '%', 'performance', 'gpu_peak', { dimension: 'performance' }),
  metric('gfx_mem_peak_mb', '峰值圖形記憶體', 'Peak Graphics Memory', 'MB', 'performance', 'gfx_mem_peak_mb', { dimension: 'performance' }),
  metric('app_start_ms', '冷啟動時間', 'Cold Start Time', 'ms', 'performance', 'app_start_ms', { dimension: 'performance' }),
  metric('loading_time', '載入時間', 'Loading Time', 's', 'performance', 'loading_time', { dimension: 'performance', description: L('App 啟動到 AI 第一次看到非載入/開場畫面', 'From app launch to the first non-loading screen seen by the AI') }),
  metric('device_temperature', '裝置溫度(電池峰值)', 'Device Temperature (battery peak)', '°C', 'performance', 'device_temperature'),
  metric('cpu_temp_peak', 'CPU 溫度峰值', 'Peak CPU Temperature', '°C', 'performance', 'cpu_temp_peak'),
  metric('battery_drain', '電量消耗(App 估算)', 'Battery Consumption (app estimate)', 'mAh', 'performance', 'battery_drain'),
  metric('battery_drain_per_hour', '每小時耗電', 'Battery Drain Rate', 'mAh/h', 'performance', 'battery_drain_per_hour'),
  metric('perf_samples', '效能取樣數', 'Perf Samples', 'count', 'performance', 'perf_samples'),
  // Stability
  metric('crash_count', 'Crash 次數(疑似閃退)', 'Crash Count (suspected)', 'count', 'stability', 'crash_count', { dimension: 'functional' }),
  metric('crash_rate_per_hour', 'Crash 率', 'Crash Rate', '/h', 'stability', 'crash_rate_per_hour'),
  metric('freeze_count', 'Freeze 次數', 'Freeze Count', 'count', 'stability', 'freeze_count'),
  metric('mem_growth_mb', '記憶體成長', 'Memory Growth', 'MB', 'stability', 'mem_growth_mb'),
  metric('core_gameplay_block', '核心玩法阻斷', 'Core Gameplay Block', 'count', 'stability', 'core_gameplay_block'),
  metric('progression_block', '進度阻斷', 'Progression Block', 'count', 'progression', 'progression_block'),
];

const GLOBAL_CHARTS: ChartDefinition[] = [
  { id: 'assertion_donut', type: 'donut', title: L('檢查結果分布', 'Check Results'), source: { kind: 'builtin', fn: 'assertion_donut' }, priority: 10 },
  { id: 'module_pass_bar', type: 'bar', title: L('模組通過率', 'Module Pass Rate'), source: { kind: 'builtin', fn: 'module_pass_bar' }, priority: 12, yLabel: L('%', '%') },
  { id: 'severity_bar', type: 'bar', title: L('缺陷嚴重度分布', 'Severity Distribution'), source: { kind: 'builtin', fn: 'severity_bar' }, priority: 14 },
  { id: 'category_bar', type: 'bar', title: L('缺陷類別分布', 'Failure Category Distribution'), source: { kind: 'builtin', fn: 'category_bar' }, priority: 16 },
  { id: 'classification_donut', type: 'donut', title: L('失敗歸因(遊戲 vs AI)', 'Failure Attribution (Game vs AI)'), source: { kind: 'builtin', fn: 'classification_donut' }, priority: 18 },
  { id: 'action_bar', type: 'bar', title: L('AI 動作分布', 'AI Action Distribution'), source: { kind: 'builtin', fn: 'action_bar' }, priority: 30 },
  { id: 'confidence_line', type: 'line', title: L('AI 信心走勢', 'AI Confidence Timeline'), source: { kind: 'builtin', fn: 'confidence_line' }, priority: 32, xLabel: L('步驟', 'Step') },
  { id: 'latency_line', type: 'line', title: L('每步耗時', 'Step Duration Timeline'), source: { kind: 'builtin', fn: 'latency_line' }, priority: 34, xLabel: L('步驟', 'Step'), yLabel: L('ms', 'ms') },
  { id: 'cpu_line', type: 'line', title: L('CPU 走勢', 'CPU Timeline'), source: { kind: 'builtin', fn: 'cpu_line' }, priority: 40, condition: 'perf_available', xLabel: L('步驟', 'Step'), yLabel: L('%', '%') },
  { id: 'mem_line', type: 'line', title: L('記憶體走勢', 'Memory Timeline'), source: { kind: 'builtin', fn: 'mem_line' }, priority: 41, condition: 'perf_available', xLabel: L('步驟', 'Step'), yLabel: L('MB', 'MB') },
  { id: 'fps_line', type: 'line', title: L('FPS 走勢', 'FPS Timeline'), source: { kind: 'builtin', fn: 'fps_line' }, priority: 39, condition: 'perf_available', xLabel: L('步驟', 'Step'), yLabel: L('FPS', 'FPS') },
  { id: 'gpu_line', type: 'line', title: L('GPU 走勢', 'GPU Timeline'), source: { kind: 'builtin', fn: 'gpu_line' }, priority: 42, condition: 'perf_available', xLabel: L('步驟', 'Step'), yLabel: L('%', '%') },
  { id: 'temp_line', type: 'line', title: L('溫度走勢', 'Temperature Timeline'), source: { kind: 'builtin', fn: 'temp_line' }, priority: 43, condition: 'perf_available', xLabel: L('步驟', 'Step'), yLabel: L('°C', '°C') },
  { id: 'frametime_bar', type: 'bar', title: L('幀時間分布', 'Frame Time Distribution'), source: { kind: 'builtin', fn: 'frametime_bar' }, priority: 44, condition: 'perf_available' },
  { id: 'state_bar', type: 'bar', title: L('遊戲狀態停留步數', 'Steps per Game State'), source: { kind: 'builtin', fn: 'state_bar' }, priority: 45 },
];

const GLOBAL_RISKS: RiskRule[] = [
  risk('crash', 'crash_count', '>', T('maxCrashCount'), 'critical', L('遊戲中疑似閃退', 'Crash during gameplay'), L('玩家遊玩中斷,可能遺失進度', 'Player session interrupted; progress may be lost')),
  risk('core_block', 'core_gameplay_block', '>', 0, 'critical', L('核心玩法被阻斷', 'Core gameplay blocked'), L('玩家無法完成核心流程', 'Players cannot complete the core loop')),
  risk('progression_block', 'progression_block', '>', 0, 'high', L('進度阻斷', 'Progression blocked'), L('玩家卡關無法推進', 'Players cannot progress')),
  risk('critical_defect', 'defects_critical', '>', 0, 'critical', L('存在 Critical 缺陷', 'Critical defects present'), L('需於發布前修正', 'Must be fixed before release')),
  risk('high_defect', 'defects_high', '>', 0, 'high', L('存在 High 缺陷', 'High defects present'), L('明顯影響玩家體驗', 'Noticeably impacts player experience')),
  risk('mem_growth', 'mem_growth_mb', '>', T('maxMemGrowthMb'), 'medium', L('記憶體持續成長', 'Memory growth over session'), L('長時間遊玩可能閃退或卡頓', 'Long sessions may crash or stutter')),
  risk('cpu_peak', 'cpu_peak', '>', T('maxCpuPeak'), 'medium', L('CPU 峰值過高', 'High CPU peak'), L('可能發熱、耗電、掉幀', 'May cause heat, battery drain, frame drops')),
  risk('fps_low', 'fps_avg', '<', T('minAvgFps'), 'medium', L('平均 FPS 偏低', 'Low average FPS'), L('畫面不流暢,影響操作手感', 'Choppy rendering hurts controls and feel')),
  risk('frame_spike', 'frame_time_p95', '>', T('maxFrameTimeP95Ms'), 'low', L('掉幀/卡頓偏多', 'Frequent frame spikes'), L('玩家可感覺到頓挫', 'Players may notice stutter')),
  risk('device_hot', 'device_temperature', '>', T('maxDeviceTempC'), 'medium', L('裝置溫度過高', 'Device running hot'), L('長時間遊玩可能降頻、掉幀', 'Long sessions may throttle and drop frames')),
  risk('slow_start', 'app_start_ms', '>', T('maxColdStartMs'), 'low', L('冷啟動偏慢', 'Slow cold start'), L('首次開啟等待過久,影響留存', 'Long first-launch wait hurts retention')),
  risk('ai_reliability', 'ai_action_success_rate', '<', T('minAiActionSuccessRate'), 'medium', L('AI 測試證據可信度偏低', 'Low AI test evidence reliability'), L('結果可能低估或高估遊戲品質,建議人工複核', 'Results may misjudge game quality; manual review advised')),
  risk('low_conf', 'low_confidence_actions', '>', T('maxLowConfidenceActions'), 'low', L('低信心操作偏多', 'Many low-confidence actions'), L('部分步驟判斷不確定', 'Some steps were uncertain')),
  risk('stuck', 'stuck_count', '>', T('maxStuckEpisodes'), 'low', L('多次卡住', 'Repeated stuck episodes'), L('可能是遊戲無回應或 AI 找不到控制項,需判讀', 'Either the game is unresponsive or the AI cannot find controls; triage needed')),
];

const GLOBAL_RELEASE: ReleaseRule[] = [
  release('critical_defects', 'defects_critical', '>', T('maxCriticalDefects'), 'NOT_READY', L('Critical 缺陷數超過門檻', 'Critical defects exceed threshold')),
  release('core_block', 'core_gameplay_block', '>', T('maxCoreGameplayBlocks'), 'NOT_READY', L('核心玩法被阻斷', 'Core gameplay blocked')),
  release('crash', 'crash_count', '>', T('maxCrashCount'), 'NOT_READY', L('Crash 次數超過門檻', 'Crash count exceeds threshold')),
  release('crash_rate', 'crash_rate_per_hour', '>', T('maxCrashRatePerHour'), 'NOT_READY', L('Crash 率超過門檻', 'Crash rate exceeds threshold')),
  release('progression', 'progression_block', '>', 0, 'NOT_READY', L('存在進度阻斷', 'Progression block present')),
  release('coverage', 'module_coverage', '<', T('minModuleCoverage'), 'INSUFFICIENT_TESTING', L('模組覆蓋率不足', 'Module coverage below threshold')),
  release('ai_reliability', 'ai_action_success_rate', '<', T('minAiActionSuccessRate'), 'INSUFFICIENT_TESTING', L('AI 操作成功率過低,證據不足以下結論', 'AI action success too low to conclude')),
  release('invalid_output', 'invalid_action_rate', '>', T('maxInvalidActionRate'), 'INSUFFICIENT_TESTING', L('AI 無效輸出比例過高,測試證據不足以下結論', 'Too many invalid AI outputs to conclude')),
  release('high_defects', 'defects_high', '>', T('maxHighDefects'), 'READY_WITH_RISK', L('存在 High 缺陷', 'High defects present')),
  release('medium_defects', 'defects_medium', '>', T('maxMediumDefects'), 'READY_WITH_RISK', L('存在 Medium 缺陷', 'Medium defects present')),
  release('triage', 'needs_triage_count', '>', 0, 'READY_WITH_RISK', L('有待人工判讀的異常', 'Anomalies pending manual triage')),
];

export const DEFAULT_THRESHOLDS: Record<string, number> = {
  maxCriticalDefects: 0,
  maxCoreGameplayBlocks: 0,
  maxCrashCount: 0,
  maxCrashRatePerHour: 0,
  maxHighDefects: 0,
  maxMediumDefects: 2,
  minModuleCoverage: 30,
  minAiActionSuccessRate: 70,
  maxInvalidActionRate: 10,
  maxLowConfidenceActions: 10,
  maxStuckEpisodes: 3,
  maxMemGrowthMb: 300,
  maxCpuPeak: 90,
  minAvgFps: 25,
  maxFrameTimeP95Ms: 50,
  maxDeviceTempC: 45,
  maxColdStartMs: 5000,
  rtpTolerancePp: 2,
  rtpMinSamples: 100,
  hitFrequencyTolerancePp: 5,
};

/** 門檻的顯示名稱與單位(知識庫頁顯示「預設值 / 你的覆寫」)。 */
export const THRESHOLD_DEFS: ThresholdDef[] = [
  { key: 'maxCriticalDefects', label: L('允許 Critical 缺陷數', 'Max critical defects'), unit: 'count' },
  { key: 'maxCoreGameplayBlocks', label: L('允許核心玩法阻斷數', 'Max core gameplay blocks'), unit: 'count' },
  { key: 'maxCrashCount', label: L('允許 Crash 次數', 'Max crashes'), unit: 'count' },
  { key: 'maxCrashRatePerHour', label: L('允許 Crash 率', 'Max crash rate'), unit: '/h' },
  { key: 'maxHighDefects', label: L('允許 High 缺陷數(超過=有風險)', 'Max high defects (above = with risk)'), unit: 'count' },
  { key: 'maxMediumDefects', label: L('允許 Medium 缺陷數(超過=有風險)', 'Max medium defects (above = with risk)'), unit: 'count' },
  { key: 'minModuleCoverage', label: L('最低模組覆蓋率', 'Min module coverage'), unit: '%' },
  { key: 'minAiActionSuccessRate', label: L('最低 AI 操作成功率', 'Min AI action success rate'), unit: '%' },
  { key: 'maxInvalidActionRate', label: L('最高 AI 無效輸出比例', 'Max invalid AI output rate'), unit: '%' },
  { key: 'maxLowConfidenceActions', label: L('低信心操作上限', 'Max low-confidence actions'), unit: 'count' },
  { key: 'maxStuckEpisodes', label: L('卡住事件上限', 'Max stuck episodes'), unit: 'count' },
  { key: 'maxMemGrowthMb', label: L('記憶體成長上限', 'Max memory growth'), unit: 'MB' },
  { key: 'maxCpuPeak', label: L('CPU 峰值上限', 'Max CPU peak'), unit: '%' },
  { key: 'minAvgFps', label: L('最低平均 FPS', 'Min average FPS'), unit: '' },
  { key: 'maxFrameTimeP95Ms', label: L('P95 幀時間上限', 'Max P95 frame time'), unit: 'ms' },
  { key: 'maxDeviceTempC', label: L('裝置溫度上限', 'Max device temperature'), unit: '°C' },
  { key: 'maxColdStartMs', label: L('冷啟動時間上限', 'Max cold start time'), unit: 'ms' },
  { key: 'rtpTolerancePp', label: L('RTP 容許偏差', 'RTP tolerance'), unit: 'pp' },
  { key: 'rtpMinSamples', label: L('RTP/命中率判定最少 Spin 數', 'Min spins for RTP / hit-rate checks'), unit: 'count' },
  { key: 'hitFrequencyTolerancePp', label: L('Hit Frequency 容許偏差', 'Hit frequency tolerance'), unit: 'pp' },
];

export const GLOBAL_PROFILE: GenreProfile = {
  id: 'global',
  version: '1.0',
  label: L('通用', 'Global'),
  modules: GLOBAL_MODULES,
  mechanics: [
    mech('navigation', 'UI 導覽', 'UI Navigation', ['menu', '選單', 'tab', '分頁']),
    mech('interaction', '互動', 'Interaction'),
  ],
  observe: [],
  metrics: GLOBAL_METRICS,
  charts: GLOBAL_CHARTS,
  riskRules: GLOBAL_RISKS,
  releaseRules: GLOBAL_RELEASE,
  sections: [],
  scopes: ['functional', 'gameplay', 'mechanics', 'ui', 'ux', 'graphics', 'performance', 'compatibility', 'account', 'level'],
  thresholds: DEFAULT_THRESHOLDS,
};

// ───────── 類型 profiles ─────────

function profile(p: Partial<GenreProfile> & { id: string; label: L10n }): GenreProfile {
  return {
    version: '1.0',
    modules: [],
    mechanics: [],
    observe: [],
    metrics: [],
    charts: [],
    riskRules: [],
    releaseRules: [],
    sections: [],
    scopes: [],
    ...p,
  };
}

const ECONOMY_METRICS: MetricDefinition[] = [
  obsMetric('obs_delta', 'currency', 'currency_delta', '貨幣淨變化', 'Currency Net Change', 'economy'),
  obsMetric('obs_min', 'currency', 'currency_min', '貨幣最低值', 'Currency Minimum', 'economy'),
  metric('negative_balance_count', '負餘額次數', 'Negative Balance Count', 'count', 'economy', 'negative_balance_count', { source: 'ai_evaluation' }),
];
const ECONOMY_RISK = risk('negative_balance', 'negative_balance_count', '>', 0, 'high', L('出現負餘額', 'Negative balance observed'), L('經濟系統異常,可能被濫用', 'Economy integrity issue; potential exploit'));

const PROGRESSION_OBS = obs('level', '等級/關卡', 'Level / Stage', '目前角色等級或關卡編號(數字)');

const RPG_BASE = {
  modules: [
    mod('character', '角色/養成', 'Character', ['character', '角色', 'hero', '英雄', '養成', 'upgrade', '升級']),
    mod('inventory', '背包/裝備', 'Inventory / Equipment', ['inventory', 'bag', '背包', 'equipment', '裝備', '装备']),
    mod('quest', '任務', 'Quest', ['quest', 'mission', '任務', '任务']),
    mod('battle', '戰鬥', 'Battle', ['battle', 'combat', '戰鬥', '战斗', 'fight'], true),
    mod('stage_select', '關卡選擇', 'Stage Select', ['stage select', 'chapter', '章節', '關卡選擇', 'map', '地圖']),
  ],
  mechanics: [
    mech('combat', '戰鬥', 'Combat', ['battle', '戰鬥']),
    mech('skill', '技能施放', 'Skill Execution', ['skill', '技能']),
    mech('item', '道具/裝備', 'Item / Equipment', ['item', '道具', 'equip']),
    mech('progression', '角色成長', 'Character Progression', ['level up', '升級']),
    mech('npc_dialogue', 'NPC 互動/對話', 'NPC Interaction / Dialogue', ['npc', 'dialogue', '對話']),
    mech('quest_flow', '任務流程', 'Quest Flow', ['quest', '任務']),
    mech('save_load', '存讀檔一致性', 'Save / Load Consistency'),
  ],
  observe: [
    PROGRESSION_OBS,
    obs('exp', '經驗值', 'EXP', '經驗值數字或經驗條百分比'),
    obs('hp', 'HP', 'HP', '我方角色 HP(數字或百分比)'),
    ECONOMY_OBS,
    obs('questDone', '任務完成', 'Quest Completed', '本畫面是否顯示任務完成', 'boolean'),
  ],
  metrics: [
    obsMetric('obs_delta', 'level', 'level_gain', '等級提升', 'Level Gain', 'progression'),
    obsMetric('obs_increase_count', 'exp', 'exp_increase_events', 'EXP 增加次數', 'EXP Gain Events', 'progression'),
    metric('quests_completed', '任務完成次數', 'Quests Completed', 'count', 'progression', { kind: 'obs_true_count', key: 'questDone' }, { source: 'ai_evaluation' }),
    obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP'),
    ...ECONOMY_METRICS,
  ],
  charts: [timeline('level', '角色成長', 'Player Progression', 60), timeline('currency', '貨幣走勢', 'Currency Timeline', 62)],
  riskRules: [ECONOMY_RISK],
  sections: ['progression', 'economy'] as GenreProfile['sections'],
  scopes: ['save_load', 'economy', 'level', 'controller'] as TestScopeId[],
};

const PROFILES: GenreProfile[] = [
  profile({
    id: 'slot',
    version: '1.3',
    label: L('拉霸/Slot', 'Slot'),
    modules: [
      mod('machine_select', '機台選擇/大廳', 'Machine Select / Hub', ['slots', '機台', 'machine', 'hub', '大廳']),
      mod('reels', '主轉軸', 'Reels / Spin', ['reel', '轉軸', '转轴', 'spin', 'slot'], true),
      mod('bet', '下注', 'Bet Control', ['bet', '下注', '押注']),
      mod('bonus', 'Bonus / 免費遊戲', 'Bonus / Free Spins', ['bonus', 'free spin', '免費', 'jackpot']),
      mod('paytable', '賠付表/規則', 'Paytable / Rules', ['paytable', '賠付', 'rule', '規則', 'info']),
      mod('autospin', '自動旋轉', 'Auto Spin', ['auto', '自動']),
    ],
    mechanics: [
      mech('spin', 'Spin', 'Spin', ['spin']),
      mech('bet_change', '下注調整', 'Bet Adjustment', ['bet']),
      mech('payout', '派彩', 'Payout', ['win', '贏', '派彩']),
      mech('bonus_trigger', 'Bonus 觸發', 'Bonus Trigger', ['bonus', 'free']),
      mech('auto_spin', 'Auto Spin', 'Auto Spin', ['auto']),
      mech('interruption_recovery', '中斷恢復', 'Interruption Recovery'),
    ],
    observe: [
      obs('bet', '下注額', 'Bet', '本次下注額(TOTAL BET)數字'),
      obs('win', '本次贏分', 'Win', '本次 Spin 的贏分(沒中填 0)'),
      obs('balance', '餘額', 'Balance', '餘額/Credit 數字'),
      obs('spun', '剛完成一次 Spin', 'Spin Completed', '這張畫面是否為一次 Spin 剛停輪的結果', 'boolean'),
      obs('bonus', 'Bonus/免費遊戲觸發', 'Bonus Triggered', '畫面是否顯示 Bonus/Free Spins 觸發', 'boolean'),
      obs('autospin_left', 'AutoSpin 剩餘次數', 'AutoSpin Remaining', 'AutoSpin 進行中時 SPIN 鈕上顯示的剩餘次數(數字;未啟動不填)'),
      // 非拉霸收入(RTP 帳務必須扣除):只在彈窗上「清楚寫出」贈送金幣時填加總後的數字;被遮擋 / 看不清 / 要估算就不填。
      obs('non_slot_credit', '非拉霸收入', 'Non-slot Credit', '升級 / 任務 / 登入 / 活動彈窗上清楚寫出的贈送金幣合計(數字;10K 寫 10000;被遮擋、看不清或需要估算就不填)'),
      // 大廳型 App(老子有錢 / FaFaFa 這類)一個 App 裡有很多台機台,每台的數學模型都不同。
      // 不記機台名的話,報告會把多台混在一起算 RTP,那個數字沒有意義。
      obs('machine_kind', '機台名稱', 'Machine', '目前在玩哪一台機台的名稱(畫面上標示的機台名,如 Fortune Rabbit;看不出來就不填)', 'string'),
    ],
    metrics: [
      metric('spin_count', 'Spin 次數', 'Spin Count', 'count', 'genre', 'spin_count', { source: 'ai_evaluation' }),
      metric('autospin_spins', 'AutoSpin 次數(餘額差法)', 'AutoSpin Spins (balance method)', 'count', 'genre', 'autospin_spins', { source: 'ai_evaluation' }),
      metric('autospin_rtp', 'AutoSpin RTP(餘額差法,未扣非拉霸收入)', 'AutoSpin RTP (balance method, before non-slot credits)', '%', 'genre', 'autospin_rtp', { source: 'ai_evaluation' }),
      metric('win_count', '中獎次數', 'Win Count', 'count', 'genre', 'win_count', { source: 'ai_evaluation' }),
      metric('loss_count', '未中次數', 'Loss Count', 'count', 'genre', 'loss_count', { source: 'ai_evaluation' }),
      metric('hit_frequency', 'Hit Frequency', 'Hit Frequency', '%', 'genre', 'hit_frequency', { source: 'ai_evaluation' }),
      metric('bonus_trigger_count', 'Bonus 觸發次數', 'Bonus Trigger Count', 'count', 'genre', { kind: 'obs_true_count', key: 'bonus' }, { source: 'ai_evaluation' }),
      metric('total_bet', '總下注', 'Total Bet', '', 'economy', 'total_bet', { source: 'ai_evaluation' }),
      metric('total_win', '總派彩', 'Total Payout', '', 'economy', 'total_win', { source: 'ai_evaluation' }),
      metric('observed_rtp', 'Observed RTP(淨,已扣非拉霸收入)', 'Observed RTP (net of non-slot credits)', '%', 'genre', 'observed_rtp', { source: 'ai_evaluation' }),
      metric('expected_rtp', 'Expected RTP(規格提供)', 'Expected RTP (spec)', '%', 'genre', { kind: 'spec', key: 'expectedRtp' }),
      metric('rtp_deviation_pp', 'RTP 偏差', 'RTP Deviation', 'pp', 'genre', 'rtp_deviation_pp', { source: 'ai_evaluation' }),
      metric('rtp_significant_deviation_pp', 'RTP 偏差(樣本足夠時)', 'RTP Deviation (sufficient samples)', 'pp', 'genre', 'rtp_significant_deviation_pp', { source: 'ai_evaluation' }),
      metric('balance_checks', '餘額一致性檢查數', 'Balance Checks', 'count', 'economy', 'balance_checks'),
      metric('balance_accuracy', '餘額正確率', 'Balance Accuracy', '%', 'economy', 'balance_accuracy', { higherIsBetter: true }),
      metric('balance_mismatch_count', '餘額不一致次數', 'Balance Mismatches', 'count', 'economy', 'balance_mismatch_count'),
      metric('spin_duration', 'Spin 時長', 'Spin Duration', 'ms', 'genre', 'spin_duration'),
      metric('expected_hit_frequency', 'Expected Hit Frequency(規格提供)', 'Expected Hit Frequency (spec)', '%', 'genre', { kind: 'spec', key: 'expectedHitFrequency' }),
      metric('hit_frequency_deviation_pp', 'Hit Frequency 偏差(樣本足夠時)', 'Hit Frequency Deviation (sufficient samples)', 'pp', 'genre', 'hit_frequency_deviation_pp', { source: 'ai_evaluation' }),
      metric('bet_out_of_range_count', '下注超出規格範圍次數', 'Bets Outside Spec Range', 'count', 'economy', 'bet_out_of_range_count', { source: 'ai_evaluation' }),
      metric('win_cap_violation_count', '派彩超過最大倍率次數', 'Wins Above Max Multiplier', 'count', 'economy', 'win_cap_violation_count', { source: 'ai_evaluation' }),
      metric('machines_played', '玩過的機台數', 'Machines Played', 'count', 'coverage', { kind: 'obs_distinct_count', key: 'machine_kind' }, { source: 'ai_evaluation' }),
    ],
    // 典型老虎機規格值(由客戶在 clone 後的知識庫填寫;AI 不會自行假設)。
    specValues: [
      { key: 'expectedRtp', label: L('理論 RTP', 'Expected RTP'), unit: '%', hint: L('數學模型的理論返還率,如 96.5', 'Theoretical return-to-player from the math model, e.g. 96.5') },
      { key: 'expectedHitFrequency', label: L('理論 Hit Frequency', 'Expected Hit Frequency'), unit: '%', hint: L('有中獎的 Spin 比例,如 28', 'Share of spins with any win, e.g. 28') },
      { key: 'minBet', label: L('最小下注', 'Min Bet'), unit: '', hint: L('允許的最小下注額', 'Minimum allowed bet') },
      { key: 'maxBet', label: L('最大下注', 'Max Bet'), unit: '', hint: L('允許的最大下注額', 'Maximum allowed bet') },
      { key: 'maxWinMultiplier', label: L('最大派彩倍率', 'Max Win Multiplier'), unit: 'x', hint: L('單次派彩不得超過「下注 × 倍率」,如 5000', 'A single win must not exceed bet × multiplier, e.g. 5000') },
      { key: 'rtpStdDev', label: L('單局報酬標準差 σ', 'Per-spin Std Dev σ'), unit: 'x', hint: L('PAR 表的單局報酬標準差(以投注額倍數計),用來算 RTP 信賴區間;未填時以 6 估算', 'Per-spin return standard deviation from the PAR sheet (in bet multiples), used for the RTP confidence interval; 6 is assumed when empty') },
    ],
    thresholds: { rtpTolerancePp: 2, rtpMinSamples: 100, hitFrequencyTolerancePp: 5, balanceAccuracyMin: 98 },
    // ③ 類型參考區間:只寫進「需要注意的點」,不參與判定(見 types.ts 的 ReferenceBand)。
    referenceBands: [
      {
        // 2026-10 實測:同一款遊戲各跑 50 局付費 SPIN,算出來的 RTP 分別是 20.68%、
        // 662.65%、579.85%。這不是 bug,是 50 局的統計極限(單局報酬標準差 σ≈6 時,
        // 50 局的 95% 區間約 ±166pp)。沒有這條提醒,報告會把 662% 講得像真的。
        metric: 'spin_count',
        min: 1000,
        minSamples: { metric: 'spin_count', value: 1 },
        note: L(
          '拉霸的 RTP 要數千局才會收斂。單局報酬標準差 σ 約 6 時,50 局的 95% 信賴區間約 ±166 個百分點、500 局約 ±53 個百分點 —— 局數不足時實測 RTP 只能當「有沒有派彩、帳有沒有算對」的旁證,不能用來判斷是否符合標稱值。這是統計性質的提醒,不是驗收標準。',
          'Slot RTP needs thousands of spins to converge. With a per-spin return σ of about 6, the 95% interval is roughly ±166 percentage points at 50 spins and ±53 at 500. Below that, the observed RTP only corroborates that payouts happen and the ledger adds up; it cannot show whether the game matches its nominal RTP. A statistical caveat, not an acceptance standard.',
        ),
      },
      {
        // 大廳型 App 一個包裡有很多台機台,每台數學模型不同。只玩一台時,RTP 只代表那一台。
        // 用 min: 2 而不是 max: 1 —— 區間的語意是「低於 min 或高於 max 才提醒」,
        // 寫 max: 1 的話「剛好 1 台」落在範圍內,永遠不會觸發(實測 job-mvfcpfig 抓到)。
        metric: 'balance_mismatch_count',
        max: 0,
        note: L(
          '逐局的下注 / 贏分 / 餘額是 AI 從畫面讀出來的,偶發讀錯在所難免。餘額正確率仍高(例如 98% 以上)時,少數幾次不符通常是讀數問題而不是遊戲算錯帳;真的算錯帳會讓正確率明顯下降。請連同 dataQuality 裡被排除的讀數一起看。這是判讀提醒,不是驗收標準。',
          'Per-round bet / win / balance values are read from the screen by the AI, so occasional misreads happen. While balance accuracy stays high (say above 98%), a few mismatches usually mean a misread rather than a ledger error; a real ledger bug drives accuracy down visibly. Read this together with the excluded values in dataQuality. An interpretation note, not an acceptance standard.',
        ),
      },
      {
        metric: 'machines_played',
        min: 2,
        note: L(
          '本次只在單一機台上取樣。大廳型 App(一個 App 內含多台機台)每台的數學模型與派彩表都不同,所以這份經濟類數據只代表這一台,不能推論整個 App。這是取樣範圍的說明,不是驗收標準。',
          'Only one machine was sampled. In hub-style apps each machine has its own math model and paytable, so these economy figures describe that machine only and do not generalise to the whole app. A note on sampling scope, not an acceptance standard.',
        ),
      },
    ],
    charts: [
      timeline('balance', '餘額走勢', 'Balance Timeline', 20),
      { id: 'rtp_convergence', type: 'line', title: L('累積 RTP 收斂', 'Cumulative RTP'), source: { kind: 'builtin', fn: 'rtp_convergence' }, threshold: { spec: 'expectedRtp' }, priority: 21, xLabel: L('Spin 次數', 'Spins'), yLabel: L('%', '%') },
      { id: 'win_loss_donut', type: 'donut', title: L('中獎 / 未中', 'Win / Loss'), source: { kind: 'builtin', fn: 'win_loss_donut' }, priority: 22 },
      { id: 'bet_vs_payout', type: 'bar', title: L('下注 vs 派彩', 'Bet vs Payout'), source: { kind: 'builtin', fn: 'bet_vs_payout' }, priority: 23 },
    ],
    riskRules: [
      // 用「正確率」而不是「不符次數 > 0」:逐局數字是 AI 從畫面讀的,偶發讀錯在所難免。
      // 2026-10-19(job-mvfcpfig)實測:115 次檢查中 2 次不符(正確率 98.26%),驗收引擎
      // 依「量級合理 ≥3 次且佔比 >20%」判定為 NEEDS_TRIAGE(不是遊戲缺陷),但舊的
      // `> 0` 風險規則同時判 critical + NOT_READY —— 同一份證據兩個子系統結論相反。
      // 改成看佔比後兩邊一致:真的算錯帳會讓正確率明顯掉下來,單次讀錯不會。
      risk('balance_mismatch', 'balance_accuracy', '<', T('balanceAccuracyMin'), 'critical', L('餘額/派彩不一致', 'Balance / payout inconsistency'), L('可能少算或多算玩家金額', 'Player funds may be miscalculated')),
      risk('rtp_deviation', 'rtp_significant_deviation_pp', '>', T('rtpTolerancePp'), 'high', L('RTP 偏離規格', 'RTP deviates from spec'), L('數學模型或實作可能有誤', 'Math model or implementation may be wrong')),
      risk('hit_frequency_deviation', 'hit_frequency_deviation_pp', '>', T('hitFrequencyTolerancePp'), 'medium', L('Hit Frequency 偏離規格', 'Hit frequency deviates from spec'), L('中獎頻率與設計不符,影響玩家體感', 'Win frequency differs from design; affects player experience')),
      risk('bet_out_of_range', 'bet_out_of_range_count', '>', 0, 'high', L('下注額超出規格範圍', 'Bet outside spec range'), L('下注上下限未正確限制', 'Bet limits not enforced')),
      risk('win_cap', 'win_cap_violation_count', '>', 0, 'critical', L('派彩超過最大倍率', 'Win above max multiplier'), L('可能派彩錯誤', 'Possible payout error')),
    ],
    releaseRules: [
      release('balance_mismatch', 'balance_accuracy', '<', T('balanceAccuracyMin'), 'NOT_READY', L('餘額/派彩計算不一致', 'Balance / payout inconsistency')),
      release('rtp_deviation', 'rtp_significant_deviation_pp', '>', T('rtpTolerancePp'), 'READY_WITH_RISK', L('RTP 偏離規格容差', 'RTP outside spec tolerance')),
      release('win_cap', 'win_cap_violation_count', '>', 0, 'NOT_READY', L('派彩超過最大倍率', 'Win above max multiplier')),
      release('bet_out_of_range', 'bet_out_of_range_count', '>', 0, 'READY_WITH_RISK', L('下注額超出規格範圍', 'Bet outside spec range')),
    ],
    sections: ['economy'],
    scopes: ['economy', 'payment'],
  }),
  profile({
    id: 'casino',
    version: '1.1',
    label: L('博弈/Casino', 'Casino'),
    modules: [
      mod('game_select', '玩法選擇大廳', 'Game Select Hub', ['slots', 'fish', '棋牌', 'chess', 'card', '玩法', 'category']),
      mod('table_select', '桌台選擇', 'Table Select', ['table', '桌', 'room', '房間', 'hub']),
      mod('round', '牌局/回合', 'Round', ['round', '牌局', 'deal', '開獎'], true),
      mod('bet', '下注', 'Bet', ['bet', '下注', 'chip', '籌碼']),
      mod('history', '遊戲紀錄', 'Game History', ['history', '紀錄', 'record']),
      mod('responsible_gaming', '負責任博弈 UI', 'Responsible Gaming UI', ['limit', '限額', 'responsible', '自我限制']),
    ],
    mechanics: [mech('bet', '下注', 'Bet'), mech('payout', '派彩', 'Payout'), mech('game_rule', '遊戲規則', 'Game Rule'), mech('disconnect_recovery', '斷線恢復', 'Disconnect Recovery')],
    // bet / win / balance 的 key 沿用與 slot 相同的名字,才能重用 total_bet / balance_accuracy
    // 等既有的 builtin 計算器(餘額對帳那套邏輯不必重寫)。
    observe: [
      obs('bet', '下注額', 'Bet', '本局下注額'),
      obs('win', '派彩', 'Payout', '本局派彩(未中填 0)'),
      obs('balance', '餘額', 'Balance', '餘額數字'),
      obs('round_settled', '本局已開獎結算', 'Round Settled', '這張畫面是否為一局剛開獎結算完的結果', 'boolean'),
      obs('game_kind', '目前玩法', 'Game Kind', '目前在玩哪一種玩法(roulette / blackjack / baccarat / sicbo / slots / fish / cards;看不出來就不填)', 'string'),
    ],
    metrics: [
      // 樣本量與覆蓋:大廳型 App 常有多種玩法,只走一種就不能把結論說成整個 App 的。
      metric('casino_rounds', '完成局數', 'Rounds Settled', 'count', 'genre', { kind: 'obs_true_count', key: 'round_settled' }, { source: 'ai_evaluation' }),
      metric('games_played', '玩過的玩法數', 'Game Kinds Played', 'count', 'coverage', { kind: 'obs_distinct_count', key: 'game_kind' }, { source: 'ai_evaluation' }),
      metric('total_bet', '總下注', 'Total Bet', '', 'economy', 'total_bet', { source: 'ai_evaluation' }),
      metric('total_win', '總派彩', 'Total Payout', '', 'economy', 'total_win', { source: 'ai_evaluation' }),
      // 下注實際走過的範圍:對照 spec 的 minBet / maxBet 才知道上下限有沒有真的被測到。
      metric('bet_min_seen', '實測最小下注', 'Min Bet Observed', '', 'economy', { kind: 'obs_min', key: 'bet' }, { source: 'ai_evaluation' }),
      metric('bet_max_seen', '實測最大下注', 'Max Bet Observed', '', 'economy', { kind: 'obs_max', key: 'bet' }, { source: 'ai_evaluation' }),
      metric('balance_checks', '餘額一致性檢查數', 'Balance Checks', 'count', 'economy', 'balance_checks'),
      metric('balance_accuracy', '餘額正確率', 'Balance Accuracy', '%', 'economy', 'balance_accuracy', { higherIsBetter: true }),
      metric('balance_mismatch_count', '餘額不一致次數', 'Balance Mismatches', 'count', 'economy', 'balance_mismatch_count'),
      metric('bet_out_of_range_count', '下注超出規格範圍次數', 'Bets Outside Spec Range', 'count', 'economy', 'bet_out_of_range_count', { source: 'ai_evaluation' }),
    ],
    // ② 遊戲設計規格:只有客戶知道,一律留空。沒填的項目報告只陳述實測值,不做判定。
    specValues: [
      { key: 'minBet', label: L('最小下注', 'Min Bet'), unit: '', hint: L('桌台允許的最小下注額', 'Minimum allowed table bet') },
      { key: 'maxBet', label: L('最大下注', 'Max Bet'), unit: '', hint: L('桌台允許的最大下注額', 'Maximum allowed table bet') },
      { key: 'nominalReturnPct', label: L('標稱返還率', 'Nominal Return'), unit: '%', hint: L('該玩法的理論返還率(如輪盤 97.3)。未填時報告只列實測值,不判定是否合格', 'Theoretical return for this game, e.g. 97.3 for roulette. Left empty, the report states the observed value without judging it') },
    ],
    // ① 技術硬指標的門檻:局數不足時不讓報告下經濟類結論。
    thresholds: { casinoMinRounds: 100, balanceAccuracyMin: 98 },
    charts: [timeline('balance', '餘額走勢', 'Balance Timeline', 20)],
    riskRules: [
      risk('bet_out_of_range', 'bet_out_of_range_count', '>', 0, 'high', L('下注額超出規格範圍', 'Bet outside spec range'), L('下注上下限未正確限制', 'Bet limits not enforced')),
      // 與 slot 同一個判準:看正確率而不是「不符次數 > 0」(見 slot 的註解)。
      risk('balance_mismatch', 'balance_accuracy', '<', T('balanceAccuracyMin'), 'critical', L('餘額/派彩不一致', 'Balance / payout inconsistency'), L('可能少算或多算玩家金額', 'Player funds may be miscalculated')),
    ],
    releaseRules: [
      release('balance_mismatch', 'balance_accuracy', '<', T('balanceAccuracyMin'), 'NOT_READY', L('餘額/派彩計算不一致', 'Balance / payout inconsistency')),
      release('casino_rounds_insufficient', 'casino_rounds', '<', T('casinoMinRounds'), 'INSUFFICIENT_TESTING', L('完成局數不足,經濟類數據不足以下結論', 'Too few settled rounds to conclude on economy metrics')),
    ],
    // ③ 類型參考區間:只寫進「需要注意的點」,不參與判定(見 types.ts 的 ReferenceBand)。
    referenceBands: [
      {
        metric: 'games_played',
        min: 3,
        note: L(
          '賭場大廳型 App 通常有 4~6 種玩法(Slots / Fish / 棋牌等)。走過的玩法太少時,結論只代表已測玩法,不能當成整個 App 的品質。這是類型常見做法,不是驗收標準。',
          'Casino hubs usually offer 4–6 game kinds (slots / fish / card games). With few kinds exercised, conclusions cover only what was played, not the whole app. This is a genre norm, not an acceptance standard.',
        ),
      },
      {
        metric: 'balance_checks',
        min: 20,
        note: L(
          '餘額對帳次數低於 20 次時,餘額正確率的代表性有限(單次讀錯就會讓百分比大幅跳動)。這是樣本量提醒,不是驗收標準。',
          'Below 20 balance checks the accuracy percentage is not representative (a single misread swings it a lot). This is a sample-size caveat, not an acceptance standard.',
        ),
      },
      {
        metric: 'casino_rounds',
        min: 100,
        minSamples: { metric: 'casino_rounds', value: 1 },
        note: L(
          '博弈類的返還率要數千局才會收斂;數十局只能看出「有沒有派彩、帳有沒有算錯」,不能談返還率是否符合設計。這是統計性質的提醒,不是驗收標準。',
          'Casino return rates need thousands of rounds to converge; a few dozen rounds can only show whether payouts happen and the ledger adds up, not whether the return matches design. A statistical caveat, not an acceptance standard.',
        ),
      },
    ],
    sections: ['economy'],
    scopes: ['economy', 'payment', 'network'],
  }),
  profile({
    id: 'bingo',
    label: L('賓果', 'Bingo'),
    modules: [mod('room', '房間/購卡', 'Room / Card Purchase', ['room', '房間', 'card', '卡']), mod('draw', '開球', 'Number Draw', ['draw', 'ball', '開球', 'bingo'], true), mod('reward', '派彩', 'Reward', ['reward', 'win', '派彩'])],
    mechanics: [mech('card_generation', '卡片生成', 'Card Generation'), mech('number_draw', '開球', 'Number Draw'), mech('mark', '標記', 'Mark Accuracy'), mech('pattern', '連線判定', 'Pattern Detection'), mech('bingo_claim', 'Bingo 宣告', 'Bingo Claim')],
    observe: [obs('drawn', '已開球數', 'Balls Drawn', '已開出的號碼數'), obs('marked', '已標記數', 'Marked', '卡上已標記數'), ECONOMY_OBS],
    metrics: [obsMetric('obs_max', 'drawn', 'balls_drawn', '開球數', 'Balls Drawn'), obsMetric('obs_max', 'marked', 'marked_max', '最大標記數', 'Max Marked'), ...ECONOMY_METRICS],
    charts: [timeline('marked', '標記進度', 'Mark Progress', 30)],
    riskRules: [ECONOMY_RISK],
    sections: ['economy'],
    scopes: ['economy'],
  }),
  profile({ id: 'rpg', label: L('RPG 角色扮演', 'RPG'), ...RPG_BASE }),
  profile({
    id: 'mmorpg',
    label: L('MMORPG', 'MMORPG'),
    ...RPG_BASE,
    modules: [
      ...RPG_BASE.modules,
      mod('server', '伺服器/連線', 'Server Connection', ['server', '伺服器', '服务器', 'connect', '連線', 'reconnect', '重連']),
      mod('social', '社交(公會/組隊/聊天)', 'Social (Guild / Party / Chat)', ['guild', '公會', 'party', '組隊', 'chat', '聊天', 'friend']),
      mod('trade', '交易', 'Trade', ['trade', '交易', 'auction', '拍賣']),
    ],
    mechanics: [...RPG_BASE.mechanics, mech('sync', '同步', 'Synchronization'), mech('reconnect', '重連', 'Reconnect', ['reconnect', '重連'])],
    scopes: [...RPG_BASE.scopes, 'network', 'multiplayer'],
  }),
  profile({
    id: 'puzzle',
    label: L('三消/解謎', 'Puzzle / Match-3'),
    modules: [mod('level_map', '關卡地圖', 'Level Map', ['map', '地圖', 'level', '關卡']), mod('board', '盤面', 'Board', ['board', '盤面', 'match', '消除'], true), mod('booster', '道具', 'Booster', ['booster', '道具'])],
    mechanics: [mech('valid_move', '有效移動判定', 'Valid Move Detection'), mech('match', '消除判定', 'Match Detection'), mech('combo', '連鎖/Combo', 'Combo / Cascade'), mech('special_tile', '特殊方塊', 'Special Tile'), mech('shuffle', '無步可走洗牌', 'No-Move Shuffle'), mech('level_complete', '過關判定', 'Level Completion')],
    observe: [obs('score', '分數', 'Score', '目前分數'), obs('movesLeft', '剩餘步數', 'Moves Left', '剩餘步數'), PROGRESSION_OBS, obs('cleared', '過關', 'Level Cleared', '是否顯示過關', 'boolean')],
    metrics: [
      obsMetric('obs_max', 'score', 'score_max', '最高分數', 'Max Score'),
      obsMetric('obs_min', 'movesLeft', 'moves_left_min', '最少剩餘步數', 'Min Moves Left'),
      metric('levels_cleared', '過關次數', 'Levels Cleared', 'count', 'progression', { kind: 'obs_true_count', key: 'cleared' }, { source: 'ai_evaluation' }),
    ],
    charts: [timeline('score', '分數走勢', 'Score Timeline', 30), timeline('movesLeft', '剩餘步數', 'Moves Left', 31)],
    sections: ['progression'],
    scopes: ['level', 'economy'],
  }),
  profile({
    id: 'card',
    label: L('卡牌/TCG', 'Card / TCG'),
    modules: [mod('deck', '牌組', 'Deck', ['deck', '牌組', '卡組']), mod('match', '對戰', 'Match', ['match', 'battle', '對戰', 'turn', '回合'], true), mod('gacha', '抽卡', 'Gacha / Packs', ['gacha', '抽卡', 'pack', '卡包'])],
    mechanics: [mech('draw', '抽牌', 'Draw'), mech('card_effect', '卡牌效果', 'Card Effect'), mech('turn_order', '回合順序', 'Turn Order'), mech('resource', '費用/Mana', 'Mana / Resource'), mech('target', '目標選擇', 'Target Selection'), mech('win_condition', '勝負判定', 'Win Condition')],
    observe: [obs('turn', '回合數', 'Turn', '目前回合數'), obs('mana', '費用/Mana', 'Mana', '我方可用費用'), obs('myHp', '我方生命', 'My HP', '我方英雄生命'), obs('enemyHp', '對手生命', 'Enemy HP', '對手英雄生命')],
    metrics: [obsMetric('obs_max', 'turn', 'turns_played', '對戰回合數', 'Turns Played'), obsMetric('obs_min', 'enemyHp', 'enemy_hp_min', '對手最低生命', 'Enemy Min HP')],
    charts: [timeline('myHp', '我方生命', 'My HP', 30), timeline('enemyHp', '對手生命', 'Enemy HP', 31)],
    scopes: ['economy'],
  }),
  profile({
    id: 'shooter',
    label: L('射擊', 'Shooter'),
    modules: [mod('loadout', '武器配置', 'Loadout', ['loadout', '武器', 'weapon']), mod('match', '對戰/關卡', 'Match', ['match', 'battle', '對戰', 'mission'], true)],
    mechanics: [mech('aim', '瞄準', 'Aim'), mech('hit_detection', '命中判定', 'Hit Detection'), mech('reload', '換彈', 'Reload'), mech('weapon_switch', '切換武器', 'Weapon Switch'), mech('respawn', '重生', 'Respawn')],
    observe: [obs('ammo', '彈藥', 'Ammo', '目前彈匣子彈數'), obs('hp', 'HP', 'HP', '我方 HP'), obs('kills', '擊殺數', 'Kills', '擊殺數')],
    metrics: [obsMetric('obs_max', 'kills', 'kills', '擊殺數', 'Kills'), obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP')],
    charts: [timeline('hp', 'HP 走勢', 'HP Timeline', 30), timeline('ammo', '彈藥走勢', 'Ammo Timeline', 31)],
    scopes: ['controller', 'network', 'multiplayer'],
  }),
  profile({
    id: 'fighting',
    label: L('格鬥', 'Fighting'),
    modules: [mod('select', '角色選擇', 'Character Select', ['select', '選角', 'character']), mod('match', '對戰', 'Match', ['round', 'fight', '對戰', 'vs'], true)],
    mechanics: [mech('input', '輸入準確', 'Input Accuracy'), mech('combo', '連段', 'Combo Execution'), mech('block', '防禦', 'Block'), mech('ko', 'KO 判定', 'KO Condition'), mech('round_state', '回合狀態', 'Round State')],
    observe: [obs('myHp', '我方血量', 'My HP', '我方血條百分比'), obs('enemyHp', '對手血量', 'Enemy HP', '對手血條百分比'), obs('round', '回合', 'Round', '目前回合')],
    metrics: [obsMetric('obs_min', 'enemyHp', 'enemy_hp_min', '對手最低血量', 'Enemy Min HP'), obsMetric('obs_max', 'round', 'rounds', '回合數', 'Rounds')],
    charts: [timeline('myHp', '我方血量', 'My HP', 30), timeline('enemyHp', '對手血量', 'Enemy HP', 31)],
    scopes: ['controller'],
  }),
  profile({
    id: 'racing',
    label: L('競速', 'Racing'),
    modules: [mod('garage', '車庫/選車', 'Garage', ['garage', '車庫', 'car', '選車']), mod('race', '比賽', 'Race', ['race', '比賽', 'lap', '圈'], true)],
    mechanics: [mech('vehicle_control', '車輛操控', 'Vehicle Control'), mech('checkpoint', '檢查點', 'Checkpoint'), mech('collision', '碰撞', 'Collision'), mech('finish', '完賽判定', 'Finish Condition')],
    observe: [obs('lap', '圈數', 'Lap', '目前圈數'), obs('position', '名次', 'Position', '目前名次'), obs('speed', '速度', 'Speed', '目前速度數字')],
    metrics: [obsMetric('obs_max', 'lap', 'laps', '完成圈數', 'Laps'), obsMetric('obs_last', 'position', 'final_position', '最終名次', 'Final Position'), obsMetric('obs_max', 'speed', 'top_speed', '最高速度', 'Top Speed')],
    charts: [timeline('speed', '速度走勢', 'Speed Timeline', 30), timeline('position', '名次走勢', 'Position Timeline', 31)],
    scopes: ['controller', 'physics'],
  }),
  profile({
    id: 'sports',
    label: L('運動', 'Sports'),
    modules: [mod('team', '隊伍/模式', 'Team / Mode', ['team', '隊伍', 'mode']), mod('match', '比賽', 'Match', ['match', '比賽', 'game'], true)],
    mechanics: [mech('player_control', '球員操控', 'Player Control'), mech('score', '計分', 'Score Accuracy'), mech('rule', '規則判定', 'Rule Enforcement'), mech('timer', '比賽計時', 'Match Timer')],
    observe: [obs('myScore', '我方比分', 'My Score', '我方比分'), obs('oppScore', '對手比分', 'Opponent Score', '對手比分')],
    metrics: [obsMetric('obs_last', 'myScore', 'my_score', '我方比分', 'My Score'), obsMetric('obs_last', 'oppScore', 'opp_score', '對手比分', 'Opponent Score')],
    charts: [timeline('myScore', '比分走勢', 'Score Timeline', 30)],
    scopes: ['controller', 'physics'],
  }),
  profile({
    id: 'rhythm',
    label: L('音樂節奏', 'Rhythm'),
    modules: [mod('song_select', '選曲', 'Song Select', ['song', '選曲', 'music']), mod('play', '演奏', 'Play', ['play', 'combo', '演奏'], true)],
    mechanics: [mech('timing', '判定時機', 'Input Timing'), mech('combo', '連段', 'Combo'), mech('audio_sync', '音畫同步', 'Audio / Visual Sync')],
    observe: [obs('combo', 'Combo', 'Combo', '目前 combo 數'), obs('score', '分數', 'Score', '分數'), obs('miss', 'Miss', 'Miss', 'Miss 數')],
    metrics: [obsMetric('obs_max', 'combo', 'max_combo', '最高 Combo', 'Max Combo'), obsMetric('obs_last', 'miss', 'miss_count', 'Miss 數', 'Miss Count'), obsMetric('obs_max', 'score', 'score_max', '分數', 'Score')],
    charts: [timeline('combo', 'Combo 走勢', 'Combo Timeline', 30)],
    scopes: ['audio', 'controller'],
  }),
  profile({
    id: 'roguelike',
    label: L('Roguelike', 'Roguelike'),
    modules: [mod('run', '單局', 'Run', ['room', '房間', 'floor', '層', 'run'], true), mod('build', '道具/Build', 'Items / Build', ['item', '道具', 'relic', '遺物']), mod('meta', '元進度', 'Meta Progression', ['meta', 'unlock', '解鎖'])],
    mechanics: [mech('procedural', '程序生成', 'Procedural Generation'), mech('room_connect', '房間連通', 'Room Connectivity'), mech('item_pick', '道具選擇', 'Item Selection'), mech('boss', 'Boss', 'Boss Spawn'), mech('restart', '重新開局', 'Restart')],
    observe: [obs('floor', '層數/房間', 'Floor / Room', '目前層數或房間編號'), obs('hp', 'HP', 'HP', '我方 HP')],
    metrics: [obsMetric('obs_max', 'floor', 'max_floor', '最深層數', 'Deepest Floor', 'progression'), obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP')],
    charts: [timeline('floor', '推進深度', 'Run Depth', 30), timeline('hp', 'HP 走勢', 'HP Timeline', 31)],
    sections: ['progression'],
    scopes: ['level', 'save_load'],
  }),
  profile({
    id: 'battle_royale',
    label: L('大逃殺', 'Battle Royale'),
    modules: [mod('matchmaking', '匹配', 'Matchmaking', ['match', '匹配', 'queue']), mod('drop', '空降/搜刮', 'Drop / Loot', ['drop', '跳傘', 'loot', '搜刮']), mod('combat', '交戰', 'Combat', ['fight', '交戰', 'zone', '安全區'], true)],
    mechanics: [mech('spawn', '出生點', 'Player Spawn'), mech('loot', '物資生成', 'Loot Spawn'), mech('safe_zone', '安全區', 'Safe Zone'), mech('elimination', '淘汰', 'Elimination'), mech('winner', '勝者判定', 'Winner Detection')],
    observe: [obs('alive', '存活人數', 'Players Alive', '剩餘存活人數'), obs('hp', 'HP', 'HP', '我方 HP'), obs('kills', '擊殺數', 'Kills', '擊殺數')],
    metrics: [obsMetric('obs_min', 'alive', 'alive_min', '最少存活人數', 'Min Players Alive'), obsMetric('obs_max', 'kills', 'kills', '擊殺數', 'Kills')],
    charts: [timeline('alive', '存活人數', 'Players Alive', 30)],
    scopes: ['network', 'multiplayer', 'controller'],
  }),
  profile({
    id: 'sandbox',
    label: L('沙盒/開放世界', 'Sandbox / Open World'),
    modules: [mod('world', '世界探索', 'World', ['world', '世界', 'map', '地圖'], true), mod('build', '建造/製作', 'Build / Craft', ['build', '建造', 'craft', '製作']), mod('quest', '任務', 'Quest', ['quest', '任務'])],
    mechanics: [mech('streaming', '世界串流', 'World Streaming'), mech('fast_travel', '快速移動', 'Fast Travel'), mech('boundary', '地圖邊界', 'Map Boundary'), mech('persistence', '世界持久化', 'World Persistence'), mech('long_nav', '長距離移動', 'Long-distance Navigation')],
    observe: [obs('hp', 'HP', 'HP', '我方 HP'), ECONOMY_OBS],
    metrics: [obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP'), ...ECONOMY_METRICS],
    charts: [timeline('hp', 'HP 走勢', 'HP Timeline', 30)],
    sections: ['progression'],
    scopes: ['save_load', 'physics', 'controller'],
  }),
  profile({
    id: 'idle',
    label: L('放置掛機', 'Idle'),
    modules: [mod('production', '產出', 'Production', ['production', '產出', 'collect', '收集'], true), mod('upgrade', '升級', 'Upgrade', ['upgrade', '升級']), mod('offline', '離線收益', 'Offline Reward', ['offline', '離線'])],
    mechanics: [mech('currency_gen', '貨幣產出', 'Currency Generation'), mech('upgrade', '升級', 'Upgrade'), mech('offline_reward', '離線獎勵', 'Offline Reward'), mech('timer', '計時準確', 'Timer Accuracy')],
    observe: [ECONOMY_OBS, obs('rate', '產出速率', 'Production Rate', '每秒/每分產出數字')],
    metrics: [...ECONOMY_METRICS, obsMetric('obs_max', 'rate', 'rate_max', '最高產出速率', 'Max Production Rate', 'economy')],
    charts: [timeline('currency', '貨幣走勢', 'Currency Timeline', 30), timeline('rate', '產出速率', 'Production Rate', 31)],
    riskRules: [ECONOMY_RISK],
    sections: ['economy', 'progression'],
    scopes: ['economy', 'save_load'],
  }),
  profile({
    id: 'moba',
    label: L('MOBA', 'MOBA'),
    modules: [mod('matchmaking', '匹配/選英雄', 'Matchmaking / Hero Pick', ['match', '匹配', 'hero', '英雄', 'pick']), mod('battlefield', '戰場', 'Battlefield', ['lane', '兵線', 'tower', '塔', 'battle'], true), mod('shop', '裝備商店', 'Item Shop', ['shop', '商店', 'item'])],
    mechanics: [mech('skill', '技能/冷卻', 'Skill / Cooldown'), mech('minion', '小兵/補刀', 'Minion / Last Hit'), mech('tower', '推塔', 'Tower'), mech('respawn', '重生', 'Respawn'), mech('sync', '同步', 'Synchronization')],
    observe: [obs('gold', '金錢', 'Gold', '我方金錢'), obs('kills', '擊殺', 'Kills', '擊殺數'), obs('deaths', '死亡', 'Deaths', '死亡數')],
    metrics: [obsMetric('obs_delta', 'gold', 'gold_gain', '金錢成長', 'Gold Gain', 'economy'), obsMetric('obs_max', 'kills', 'kills', '擊殺', 'Kills'), obsMetric('obs_max', 'deaths', 'deaths', '死亡', 'Deaths')],
    charts: [timeline('gold', '金錢走勢', 'Gold Timeline', 30)],
    sections: ['economy'],
    scopes: ['network', 'multiplayer', 'controller', 'economy'],
  }),
  profile({
    id: 'tower_defense',
    label: L('塔防', 'Tower Defense'),
    modules: [mod('level_select', '關卡選擇', 'Level Select', ['level', '關卡', 'map']), mod('defense', '防守', 'Defense', ['wave', '波', 'tower', '塔'], true)],
    mechanics: [mech('path', '敵人路徑', 'Enemy Path'), mech('placement', '放塔', 'Tower Placement'), mech('targeting', '目標選擇', 'Target Selection'), mech('upgrade', '升級', 'Upgrade'), mech('wave', '波次', 'Wave Completion')],
    observe: [obs('wave', '波次', 'Wave', '目前波次'), obs('baseHp', '基地生命', 'Base HP', '基地生命'), obs('gold', '金錢', 'Gold', '金錢')],
    metrics: [obsMetric('obs_max', 'wave', 'max_wave', '最高波次', 'Max Wave', 'progression'), obsMetric('obs_min', 'baseHp', 'base_hp_min', '基地最低生命', 'Base Min HP'), obsMetric('obs_delta', 'gold', 'gold_delta', '金錢淨變化', 'Gold Net Change', 'economy')],
    charts: [timeline('wave', '波次推進', 'Wave Progress', 30), timeline('baseHp', '基地生命', 'Base HP', 31)],
    sections: ['progression'],
    scopes: ['level', 'economy'],
  }),
  profile({
    id: 'survivor',
    version: '1.1',
    label: L('割草', 'Bullet Heaven'),
    modules: [mod('character_select', '角色/關卡選擇', 'Character / Stage Select', ['select', '選擇', 'character', '角色']), mod('battle', '戰鬥', 'Battle', ['battle', '戰鬥', 'stage', 'wave', 'zone', '關卡'], true), mod('upgrade', '升級選技能', 'Level-up Upgrade', ['level up', '升級', 'skill', '技能'])],
    mechanics: [mech('movement', '虛擬搖桿移動', 'Joystick Movement'), mech('auto_attack', '自動攻擊', 'Auto Attack'), mech('pickup', '拾取經驗', 'Pickup / XP'), mech('level_up', '升級選擇', 'Upgrade Selection'), mech('boss', 'Boss', 'Boss Spawn'), mech('death', '死亡結算', 'Death / Settlement')],
    observe: [
      obs('hp', 'HP', 'HP', '角色 HP(數字或百分比)'),
      obs('wave', '波次/關卡', 'Wave / Stage', '目前波次或關卡數字'),
      obs('level', '角色等級', 'Level', '本局角色等級'),
      obs('enemies', '敵人數(估計)', 'Enemies (est.)', '畫面上敵人數量粗估'),
      obs('timer', '存活秒數', 'Survival Time', '存活計時器換算成秒'),
    ],
    metrics: [
      obsMetric('obs_max', 'wave', 'max_wave', '最高波次/關卡', 'Max Wave / Stage', 'progression'),
      obsMetric('obs_increase_count', 'level', 'level_ups', '升級次數', 'Level Ups'),
      obsMetric('obs_max', 'enemies', 'enemy_peak', '敵人數峰值(估計)', 'Peak Enemy Count (est.)'),
      obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP'),
      obsMetric('obs_max', 'timer', 'survival_s', '最長存活時間', 'Longest Survival', 'genre', 's'),
    ],
    charts: [timeline('enemies', '敵人密度走勢', 'Enemy Density Timeline', 30), timeline('hp', 'HP 走勢', 'HP Timeline', 31), timeline('wave', '波次推進', 'Wave Progress', 32)],
    sections: ['progression'],
    scopes: ['controller', 'level'],
  }),
  profile({
    id: 'action',
    label: L('動作', 'Action'),
    modules: [mod('stage', '關卡', 'Stage', ['stage', '關卡', 'level'], true)],
    mechanics: [mech('movement', '移動', 'Movement'), mech('attack', '攻擊', 'Attack'), mech('dodge', '閃避/跳躍', 'Dodge / Jump'), mech('collision', '碰撞', 'Collision'), mech('lose_condition', '失敗條件', 'Lose Condition')],
    observe: [obs('hp', 'HP', 'HP', '我方 HP'), PROGRESSION_OBS],
    metrics: [obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP'), obsMetric('obs_max', 'level', 'max_stage', '最高關卡', 'Max Stage', 'progression')],
    charts: [timeline('hp', 'HP 走勢', 'HP Timeline', 30)],
    scopes: ['controller', 'physics'],
  }),
  profile({
    id: 'adventure',
    label: L('冒險', 'Adventure'),
    modules: [mod('scene', '場景探索', 'Scene', ['scene', '場景', 'explore'], true), mod('inventory', '物品欄', 'Inventory', ['inventory', '物品', '背包']), mod('dialogue', '對話/劇情', 'Dialogue', ['dialogue', '對話', 'story', '劇情'])],
    mechanics: [mech('interaction', '物件互動', 'Object Interaction'), mech('item_use', '道具使用', 'Item Use'), mech('dialogue_branch', '對話分支', 'Dialogue Branch'), mech('progression', '劇情推進', 'Story Progression')],
    observe: [obs('chapter', '章節', 'Chapter', '章節編號')],
    metrics: [obsMetric('obs_max', 'chapter', 'max_chapter', '最遠章節', 'Furthest Chapter', 'progression')],
    sections: ['progression'],
    scopes: ['save_load', 'level'],
  }),
  profile({
    id: 'action_adventure',
    label: L('動作冒險', 'Action Adventure'),
    modules: [mod('world', '世界', 'World', ['world', '世界', 'map'], true), mod('quest', '任務', 'Quest', ['quest', '任務'])],
    mechanics: [mech('combat', '戰鬥', 'Combat'), mech('exploration', '探索', 'Exploration'), mech('quest_flow', '任務推進', 'Quest Flow')],
    observe: [obs('hp', 'HP', 'HP', '我方 HP')],
    metrics: [obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP')],
    charts: [timeline('hp', 'HP 走勢', 'HP Timeline', 30)],
    sections: ['progression'],
    scopes: ['controller', 'save_load'],
  }),
  profile({
    id: 'strategy',
    label: L('策略', 'Strategy'),
    modules: [mod('base', '基地/主城', 'Base', ['base', '基地', 'city', '主城'], true), mod('battle', '戰役', 'Battle', ['battle', '戰役', 'war'])],
    mechanics: [mech('build', '建造', 'Build'), mech('production', '生產', 'Production'), mech('deploy', '部署', 'Deploy'), mech('resource', '資源', 'Resource')],
    observe: [ECONOMY_OBS],
    metrics: [...ECONOMY_METRICS],
    charts: [timeline('currency', '資源走勢', 'Resource Timeline', 30)],
    riskRules: [ECONOMY_RISK],
    sections: ['economy'],
    scopes: ['economy'],
  }),
  profile({
    id: 'simulation',
    label: L('模擬經營', 'Simulation'),
    modules: [mod('facility', '設施', 'Facility', ['facility', '設施', 'build', '建造'], true), mod('management', '管理面板', 'Management', ['manage', '管理'])],
    mechanics: [mech('production', '生產/收益', 'Production / Income'), mech('upgrade', '升級/擴建', 'Upgrade / Expand')],
    observe: [ECONOMY_OBS],
    metrics: [...ECONOMY_METRICS],
    charts: [timeline('currency', '資金走勢', 'Funds Timeline', 30)],
    riskRules: [ECONOMY_RISK],
    sections: ['economy'],
    scopes: ['economy', 'save_load'],
  }),
  profile({
    id: 'platformer',
    label: L('平台跳躍', 'Platformer'),
    modules: [mod('stage', '關卡', 'Stage', ['stage', 'level', '關卡'], true)],
    mechanics: [mech('jump', '跳躍', 'Jump'), mech('collision', '碰撞', 'Collision'), mech('collect', '收集', 'Collectibles'), mech('checkpoint', '存檔點', 'Checkpoint')],
    observe: [obs('lives', '剩餘生命', 'Lives', '剩餘生命數'), PROGRESSION_OBS],
    metrics: [obsMetric('obs_min', 'lives', 'lives_min', '最少剩餘生命', 'Min Lives'), obsMetric('obs_max', 'level', 'max_stage', '最高關卡', 'Max Stage', 'progression')],
    scopes: ['controller', 'physics', 'level'],
  }),
  profile({
    id: 'board',
    label: L('桌遊/棋牌', 'Board Game'),
    modules: [mod('room', '房間', 'Room', ['room', '房間', 'table']), mod('game', '對局', 'Game', ['turn', '回合', 'board', '棋'], true)],
    mechanics: [mech('turn_order', '回合順序', 'Turn Order'), mech('rule', '規則判定', 'Rule'), mech('win_condition', '勝負判定', 'Win Condition')],
    observe: [obs('turn', '回合', 'Turn', '回合數'), ECONOMY_OBS],
    metrics: [obsMetric('obs_max', 'turn', 'turns', '回合數', 'Turns'), ...ECONOMY_METRICS],
    scopes: ['multiplayer'],
  }),
  profile({
    id: 'survival',
    label: L('生存', 'Survival'),
    modules: [mod('world', '世界', 'World', ['world', '世界'], true), mod('craft', '製作/建造', 'Craft / Build', ['craft', '製作', 'build', '建造'])],
    mechanics: [mech('gather', '採集', 'Gather'), mech('craft', '製作', 'Craft'), mech('status', '生存狀態', 'Survival Status')],
    observe: [obs('hp', 'HP', 'HP', '生命值'), obs('hunger', '飢餓', 'Hunger', '飢餓值')],
    metrics: [obsMetric('obs_min', 'hp', 'hp_min', '最低 HP', 'Minimum HP'), obsMetric('obs_min', 'hunger', 'hunger_min', '最低飢餓值', 'Min Hunger')],
    charts: [timeline('hp', 'HP 走勢', 'HP Timeline', 30)],
    scopes: ['save_load', 'controller'],
  }),
  profile({
    id: 'casual',
    label: L('休閒', 'Casual'),
    modules: [mod('level', '關卡', 'Level', ['level', '關卡', 'play'], true)],
    mechanics: [mech('core_action', '核心操作', 'Core Action'), mech('level_complete', '過關', 'Level Completion')],
    observe: [obs('score', '分數', 'Score', '分數'), PROGRESSION_OBS],
    metrics: [obsMetric('obs_max', 'score', 'score_max', '最高分數', 'Max Score'), obsMetric('obs_max', 'level', 'max_level', '最高關卡', 'Max Level', 'progression')],
    scopes: ['level'],
  }),
  profile({
    id: 'hyper_casual',
    label: L('超休閒', 'Hyper Casual'),
    modules: [mod('play', '遊玩', 'Play', ['play', 'tap'], true), mod('ads', '廣告', 'Ads', ['ad', '廣告'])],
    mechanics: [mech('core_action', '單一核心操作', 'Core Action'), mech('retry', '一鍵重玩', 'Retry')],
    observe: [obs('score', '分數', 'Score', '分數')],
    metrics: [obsMetric('obs_max', 'score', 'score_max', '最高分數', 'Max Score')],
    scopes: ['level'],
  }),
  profile({
    id: 'educational',
    label: L('教育', 'Educational'),
    modules: [mod('lesson', '課程', 'Lesson', ['lesson', '課程', 'quiz', '題'], true)],
    mechanics: [mech('answer', '作答', 'Answer'), mech('feedback', '對錯回饋', 'Feedback')],
    observe: [obs('correct', '答對數', 'Correct', '答對題數'), obs('wrong', '答錯數', 'Wrong', '答錯題數')],
    metrics: [obsMetric('obs_max', 'correct', 'correct', '答對數', 'Correct'), obsMetric('obs_max', 'wrong', 'wrong', '答錯數', 'Wrong')],
    scopes: ['localization'],
  }),
  profile({ id: 'other', label: L('其他', 'General / Other') }),
];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export function getGenreProfile(id: string | undefined): GenreProfile | null {
  return id ? BY_ID.get(id) ?? null : null;
}

export function allGenreProfiles(): GenreProfile[] {
  return PROFILES;
}

function uniqBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** 合併後的 profile(GLOBAL + 所選類型);重複的指標/模組/圖表/規則只保留第一次出現者。 */
export interface MergedProfile extends GenreProfile {
  sources: Array<{ id: string; version: string; label: L10n }>;
}

export function mergeProfiles(genres: string[]): MergedProfile {
  const picked = [GLOBAL_PROFILE, ...uniqBy(genres, (g) => g).map(getGenreProfile).filter((p): p is GenreProfile => p !== null)];
  return {
    id: picked.map((p) => p.id).join('+'),
    version: picked.map((p) => `${p.id}-v${p.version}`).join(','),
    label: L(picked.map((p) => p.label.zh).join(' + '), picked.map((p) => p.label.en).join(' + ')),
    modules: uniqBy(picked.flatMap((p) => p.modules), (m) => m.id),
    mechanics: uniqBy(picked.flatMap((p) => p.mechanics), (m) => m.id),
    observe: uniqBy(picked.flatMap((p) => p.observe), (o) => o.key),
    metrics: uniqBy(picked.flatMap((p) => p.metrics), (m) => m.id),
    charts: uniqBy(picked.flatMap((p) => p.charts), (c) => c.id).sort((a, b) => a.priority - b.priority),
    riskRules: uniqBy(picked.flatMap((p) => p.riskRules), (r) => r.id),
    releaseRules: uniqBy(picked.flatMap((p) => p.releaseRules), (r) => r.id),
    sections: uniqBy(picked.flatMap((p) => p.sections), (s) => s),
    scopes: uniqBy(picked.flatMap((p) => p.scopes), (s) => s),
    thresholds: Object.assign({}, ...picked.map((p) => p.thresholds ?? {})),
    specValues: uniqBy(picked.flatMap((p) => p.specValues ?? []), (v) => v.key),
    // 參考區間只給 AI 分析用(不進判定);同一個指標只留第一個區間。
    referenceBands: uniqBy(picked.flatMap((p) => p.referenceBands ?? []), (b) => b.metric),
    sources: picked.map((p) => ({ id: p.id, version: p.version, label: p.label })),
  };
}

/** 套用知識庫的「停用」清單(客戶 clone 樣板後關掉不適用的項目)。 */
export function applyExclude(p: MergedProfile, ex: SpecExclude | undefined): MergedProfile {
  if (!ex) return p;
  const not = (list: string[] | undefined) => {
    const s = new Set(list ?? []);
    return (id: string) => !s.has(id);
  };
  return {
    ...p,
    metrics: p.metrics.filter((m) => not(ex.metrics)(m.id)),
    charts: p.charts.filter((c) => not(ex.charts)(c.id)),
    riskRules: p.riskRules.filter((r) => not(ex.riskRules)(r.id)),
    releaseRules: p.releaseRules.filter((r) => not(ex.releaseRules)(r.id)),
    observe: p.observe.filter((o) => not(ex.observe)(o.key)),
    modules: p.modules.filter((m) => not(ex.modules)(m.id)),
    mechanics: p.mechanics.filter((m) => not(ex.mechanics)(m.id)),
  };
}

/** 每個指標出自哪個 profile(報告標示來源用)。 */
export function metricOrigin(genres: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of [GLOBAL_PROFILE, ...genres.map(getGenreProfile).filter((x): x is GenreProfile => x !== null)]) {
    for (const d of p.metrics) if (!m.has(d.id)) m.set(d.id, p.id);
  }
  return m;
}

/** 規則門檻的可讀形式:固定值或「門檻 key(預設值)」。 */
function thresholdView(v: RiskRule['value'], defaults: Record<string, number>): { value: number | null; thresholdKey?: string } {
  if (typeof v === 'number') return { value: v };
  return { value: defaults[v.threshold] ?? null, thresholdKey: v.threshold };
}

/**
 * 類型樣板描述(知識庫頁顯示「這個類型的預設配置」,clone 後可逐項停用/覆寫)。
 * 只列此類型自己帶的項目(GLOBAL 通用項目一律套用,另以 global 樣板呈現)。
 */
export interface TemplateDescriptor {
  id: string;
  version: string;
  label: L10n;
  modules: Array<{ id: string; label: L10n; keywords: string[]; core: boolean }>;
  mechanics: Array<{ id: string; label: L10n }>;
  observe: Array<{ key: string; label: L10n; hint: string; type: string }>;
  metrics: Array<{ id: string; label: L10n; unit: string; source: string; group: string }>;
  charts: Array<{ id: string; title: L10n; type: string }>;
  riskRules: Array<{ id: string; title: L10n; level: string; metric: string; op: string; value: number | null; thresholdKey?: string }>;
  releaseRules: Array<{ id: string; reason: L10n; outcome: string; metric: string; op: string; value: number | null; thresholdKey?: string }>;
  specValues: SpecValueDef[];
  thresholds: Array<ThresholdDef & { default: number }>;
  sections: string[];
  scopes: string[];
}

export function describeProfile(id: string): TemplateDescriptor | null {
  const p = id === 'global' ? GLOBAL_PROFILE : getGenreProfile(id);
  if (!p) return null;
  const defaults = { ...DEFAULT_THRESHOLDS, ...(p.thresholds ?? {}) };
  return {
    id: p.id,
    version: p.version,
    label: p.label,
    modules: p.modules.map((m) => ({ id: m.id, label: m.label, keywords: m.keywords, core: Boolean(m.core) })),
    mechanics: p.mechanics.map((m) => ({ id: m.id, label: m.label })),
    observe: p.observe.map((o) => ({ key: o.key, label: o.label, hint: o.hint, type: o.type })),
    metrics: p.metrics.map((m) => ({ id: m.id, label: m.label, unit: m.unit, source: m.source, group: m.group })),
    charts: p.charts.map((c) => ({ id: c.id, title: c.title, type: c.type })),
    riskRules: p.riskRules.map((r) => ({ id: r.id, title: r.title, level: r.level, metric: r.metric, op: r.op, ...thresholdView(r.value, defaults) })),
    releaseRules: p.releaseRules.map((r) => ({ id: r.id, reason: r.reason, outcome: r.outcome, metric: r.metric, op: r.op, ...thresholdView(r.value, defaults) })),
    specValues: p.specValues ?? [],
    // 門檻:全部平台門檻(各類型皆適用)+ 此類型的預設值。
    thresholds: THRESHOLD_DEFS.map((d) => ({ ...d, default: defaults[d.key] ?? 0 })),
    sections: p.sections,
    scopes: p.scopes,
  };
}
