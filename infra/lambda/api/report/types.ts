/**
 * 測試報告引擎資料模型。
 *
 * 架構(對齊測試顧問規格):BaseReport + GenreProfile[] + MetricDefinition[] + ChartDefinition[]
 * + RiskRule[] + ReleaseRule[]。新增遊戲類型只要新增 GenreProfile(資料),不改引擎。
 *
 * 核心原則:
 * - 所有數字(成功率、Crash、RTP、延遲…)由程式從 Evidence 計算;LLM 只負責「觀察與描述」。
 * - Game Quality 與 AI Testing Quality 完全分開:Finding 必帶 classification,
 *   AI 點錯/解析失敗等屬 AI_TEST_FAILURE,不得算成遊戲缺陷。
 * - 沒收集到的指標回 null 並標示 not_collected,不得以 0 或猜測值充數。
 */

/** 雙語標籤(zh = 繁中;zh-Hans 前端回退 zh,ja/ko 回退 en)。 */
export interface L10n {
  zh: string;
  en: string;
}

export type QualityDimension =
  | 'functional'
  | 'gameplay'
  | 'performance'
  | 'visual'
  | 'audio'
  | 'ux'
  | 'compatibility'
  | 'localization'
  | 'network';

export type MetricUnit = '%' | 'ms' | 's' | 'count' | 'MB' | 'pp' | '/h' | '°C' | 'mAh' | 'mAh/h' | '' ;

/** objective = 確定性計算;ai_evaluation = 由 AI 觀察/標註彙總(需與確定性 Bug 區分)。 */
export type MetricSource = 'objective' | 'ai_evaluation';

export type MetricGroup =
  | 'summary'
  | 'ai_reliability'
  | 'performance'
  | 'stability'
  | 'coverage'
  | 'genre'
  | 'economy'
  | 'progression'
  | 'ux';

// ───────────────────────── Evidence ─────────────────────────

export type Assertion = 'pass' | 'fail' | 'unclear';

export type FindingCategory =
  | 'crash'
  | 'functional'
  | 'gameplay'
  | 'graphics'
  | 'animation'
  | 'audio'
  | 'ui'
  | 'ux'
  | 'performance'
  | 'network'
  | 'localization'
  | 'compatibility'
  | 'physics'
  | 'ai'
  | 'save_data'
  | 'economy';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** AI 在某一步回報的「畫面上看得到的遊戲缺陷」。 */
export interface ReportedIssue {
  category: FindingCategory;
  severity: Severity;
  title: string;
  /** 缺陷區域(該步截圖座標空間 [x1,y1,x2,y2]),可選。 */
  box?: [number, number, number, number];
}

/** runner 層介入動作(屬 AI 測試品質,不是遊戲品質)。 */
export type OverrideKind =
  | 'battle_move'
  | 'reject_done'
  | 'loading_wait'
  | 'stuck_wait'
  | 'stuck_escape';

/**
 * 一次效能取樣(runner agent/perfMonitor.mjs 以 adb shell 收集;舊版只有 cpuPct/memMB)。
 * fps/cpuPct/gpuPct 為「上次取樣到這次」的區間值;frameHist = 區間內 present-to-present 直方圖(ms → 幀數)。
 */
export interface PerfSample {
  cpuPct?: number;
  memMB?: number;
  gfxMemMB?: number;
  gpuPct?: number;
  fps?: number;
  frames?: number;
  fpsSpanS?: number;
  frameHist?: Record<string, number>;
  batteryTempC?: number;
  cpuTempC?: number;
  gpuTempC?: number;
  skinTempC?: number;
  /** 自測試開始累計的 App 估算耗電(mAh)。 */
  batteryMah?: number;
}

/** runner 寫在 report.json 的效能中繼資料。 */
export interface PerfMeta {
  source?: string;
  cores?: number;
  launch?: { at?: string; totalTimeMs?: number; state?: string };
  batteryCapacityMah?: number;
  batteryMah?: number;
}

/** 正規化後的一步 AI 執行證據(Observe → Reason → Action → Result → Assertion)。 */
export interface EvidenceStep {
  index: number;
  at?: string;
  /** Observed State(AI 標的畫面名)。 */
  screen: string;
  /** Reason。 */
  thinking?: string;
  action: string;
  x?: number;
  y?: number;
  /** 截圖座標空間(標註/框選用)。 */
  shotSize?: [number, number];
  /** Expected(AI 預期此動作造成的結果)。 */
  expect?: string;
  /** Actual(下一步觀察到的畫面)。 */
  actual?: string;
  /** Assertion(由下一步 AI 依新畫面判定 expect 是否達成)。 */
  assertion?: Assertion;
  /** 動作後畫面是否有可見變化(pHash,確定性)。 */
  effective?: boolean;
  /** AI 對本步判斷/座標的信心 0~1。 */
  confidence?: number;
  module?: string;
  mechanic?: string;
  /** 畫面上明確讀到的觀測值(依 GenreProfile.observe)。 */
  obs?: Record<string, number | string | boolean>;
  issue?: ReportedIssue;
  override?: OverrideKind;
  parseFailed?: boolean;
  modelError?: boolean;
  /** 本步開始前發現 App 不在前景(被拉回)。 */
  foregroundLost?: boolean;
  /** Appium queryAppState(1=未執行 → 疑似閃退;2/3=背景 → 跳到其他 App)。 */
  appState?: number;
  /** 上一步動作是否為 back(判斷前景遺失是 AI 誤操作還是疑似閃退)。 */
  prevAction?: string;
  perf?: PerfSample;
  durationMs?: number;
  vlmMs?: number;
  screenshotKey?: string;
  annotatedKey?: string;
}

// ───────────────────────── Finding ─────────────────────────

export type FailureClass = 'GAME_FAILURE' | 'AI_TEST_FAILURE' | 'ENVIRONMENT' | 'NEEDS_TRIAGE';

/** deterministic = 程式規則判定;ai_evaluation = AI 觀察回報(需人工確認)。 */
export type Certainty = 'deterministic' | 'ai_evaluation';

export type Reproducibility = 'always' | 'frequent' | 'intermittent' | 'rare' | 'single' | 'unable';

export interface Finding {
  id: string;
  title: L10n;
  description: L10n;
  severity: Severity;
  category: FindingCategory;
  classification: FailureClass;
  certainty: Certainty;
  module?: string;
  gameState?: string;
  /** 本次執行中出現次數。 */
  frequency: number;
  reproducibility: Reproducibility;
  firstStep?: number;
  lastStep?: number;
  expected?: string;
  actual?: string;
  stepsToReproduce: string[];
  screenshotKey?: string;
  annotatedKey?: string;
  box?: [number, number, number, number];
  shotSize?: [number, number];
  aiConfidence?: number;
  suspectedCause?: L10n;
  /** 修正建議(程式規則依歸因/類別產生;AI 洞察可再補充更具體的建議)。 */
  suggestion?: L10n;
  relatedTestCase?: string;
  status: 'open';
}

/**
 * 逐步檢查判定:AI 在第 step 步宣告了 expected,下一步看到新畫面後判定是否達成。
 * 報告「判定明細」表的每一列(通過/失敗/不確定)都可回溯到這裡。
 */
/** skipped = 有預期但沒有下一步可判定(例如最後一步)。 */
export type CheckResult = Assertion | 'skipped';

export interface CheckItem {
  id: string;
  /** step = AI 逐步預期判定;milestone = 程式依整體證據判定的里程碑(啟動/進入遊戲/目標完成…)。 */
  kind: 'step' | 'milestone';
  /** 里程碑名稱(kind=milestone)。 */
  title?: L10n;
  /** 執行動作的步驟(動作前截圖 = 此步;動作後截圖 = afterStep)。 */
  step: number;
  afterStep?: number;
  module?: string;
  screen: string;
  action: string;
  expected: string;
  /** 動作後觀察到的畫面。 */
  actual?: string;
  result: CheckResult;
  /** 判定依據:下一步 AI 看到新畫面時的推理。 */
  reason?: string;
  confidence?: number;
  /** 動作後畫面是否有可見變化(pHash,確定性)。 */
  effective?: boolean;
  relatedFinding?: string;
  /** 判定依據的確定性:deterministic = 程式規則;ai_evaluation = AI 看下一張截圖判定。 */
  basis: Certainty;
  suggestion?: L10n;
}

// ───────────────────────── Definitions(Profile 資料)─────────────────────────

export interface ModuleDef {
  id: string;
  label: L10n;
  /** 用來從畫面名推斷模組(舊報告無 module 標註時)。小寫比對。 */
  keywords: string[];
  /** 核心模組:此模組發生 GAME_FAILURE 阻斷 = Core Gameplay Block。 */
  core?: boolean;
}

export interface MechanicDef {
  id: string;
  label: L10n;
  keywords?: string[];
}

/** 要求 AI 每步從畫面讀取的觀測欄位(只填看得到的,不准猜)。 */
export interface ObserveDef {
  key: string;
  label: L10n;
  /** 給 AI 的簡短說明。 */
  hint: string;
  type: 'number' | 'string' | 'boolean';
}

/**
 * 指標計算方式(資料化,不寫死函式)。
 * builtin:引擎內建計算器 id;obs_*:對觀測欄位的通用聚合。
 */
export type MetricCalc =
  | { kind: 'builtin'; fn: string }
  | { kind: 'obs_max' | 'obs_min' | 'obs_last' | 'obs_delta' | 'obs_count' | 'obs_increase_count' | 'obs_sum'; key: string }
  | { kind: 'obs_true_count'; key: string }
  | { kind: 'spec'; key: string };

export interface MetricDefinition {
  id: string;
  label: L10n;
  unit: MetricUnit;
  group: MetricGroup;
  source: MetricSource;
  calc: MetricCalc;
  dimension?: QualityDimension;
  higherIsBetter?: boolean;
  description?: L10n;
}

export type ChartType = 'line' | 'bar' | 'donut';

export type ChartSource =
  | { kind: 'obs_timeline'; key: string }
  | { kind: 'builtin'; fn: string };

export interface ChartDefinition {
  id: string;
  type: ChartType;
  title: L10n;
  source: ChartSource;
  /** 參考線(如 Expected RTP)。可為固定值或 spec key。 */
  threshold?: number | { spec: string };
  priority: number;
  /** 出現條件:預設 has_data(資料不足不出圖)。 */
  condition?: 'has_data' | 'perf_available' | 'expected_rtp';
  xLabel?: L10n;
  yLabel?: L10n;
}

export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** 門檻值:固定數字或指向可由客戶覆寫的 threshold key。 */
export type ThresholdRef = number | { threshold: string };

export interface RiskRule {
  id: string;
  metric: string;
  op: CompareOp;
  value: ThresholdRef;
  level: Severity;
  title: L10n;
  impact: L10n;
  affected?: L10n;
}

export type ReleaseOutcome = 'NOT_READY' | 'INSUFFICIENT_TESTING' | 'READY_WITH_RISK';

export interface ReleaseRule {
  id: string;
  metric: string;
  op: CompareOp;
  value: ThresholdRef;
  outcome: ReleaseOutcome;
  reason: L10n;
}

export type ReportSection = 'progression' | 'economy';

export type TestScopeId =
  | 'functional' | 'gameplay' | 'mechanics' | 'ui' | 'ux' | 'graphics' | 'animation' | 'audio'
  | 'performance' | 'compatibility' | 'network' | 'multiplayer' | 'localization' | 'save_load'
  | 'account' | 'economy' | 'payment' | 'ai_behavior' | 'physics' | 'controller' | 'level';

export interface GenreProfile {
  id: string;
  version: string;
  label: L10n;
  modules: ModuleDef[];
  mechanics: MechanicDef[];
  observe: ObserveDef[];
  metrics: MetricDefinition[];
  charts: ChartDefinition[];
  riskRules: RiskRule[];
  releaseRules: ReleaseRule[];
  sections: ReportSection[];
  /** 此類型「應納入」的測試範疇(其餘視為 Not Applicable,不得算 Fail)。 */
  scopes: TestScopeId[];
  /** 預設門檻(可被 KB report-spec 覆寫)。 */
  thresholds?: Record<string, number>;
  /** 此類型客戶應填寫的規格值(如 Slot 的 Expected RTP)。 */
  specValues?: SpecValueDef[];
}

/** 停用繼承自類型樣板的項目(以 id / key 指定)。 */
export interface SpecExclude {
  metrics?: string[];
  charts?: string[];
  riskRules?: string[];
  releaseRules?: string[];
  observe?: string[];
  modules?: string[];
  mechanics?: string[];
}

/** 知識庫宣告的報告規格(客戶可設定;結構化欄位或 ```playagent-report 區塊)。 */
export interface ReportSpec {
  /** 例:expectedRtp(%)。AI 不得自行假設,必須由此提供。 */
  values: Record<string, number>;
  thresholds: Record<string, number>;
  modules: ModuleDef[];
  observe: ObserveDef[];
  scopes: TestScopeId[];
  /** 停用的樣板項目。 */
  exclude: SpecExclude;
  /** 提供規格的知識庫 id(可追溯)。 */
  sources: string[];
}

/** 類型樣板宣告的「規格值」欄位(客戶填,例如 Expected RTP、最小/最大下注)。 */
export interface SpecValueDef {
  key: string;
  label: L10n;
  unit: string;
  hint: L10n;
}

/** 門檻說明(知識庫頁顯示預設值與意義)。 */
export interface ThresholdDef {
  key: string;
  label: L10n;
  unit: string;
}

// ───────────────────────── Output ─────────────────────────

export interface MetricValue {
  id: string;
  label: L10n;
  unit: MetricUnit;
  group: MetricGroup;
  source: MetricSource;
  dimension?: QualityDimension;
  value: number | null;
  status: 'ok' | 'not_collected';
  /** 來自哪個 profile(global/slot/...)。 */
  profile: string;
}

export interface ChartSeries {
  name: L10n;
  points: Array<{ x: number | string; y: number }>;
}

export interface ChartData {
  id: string;
  type: ChartType;
  title: L10n;
  series: ChartSeries[];
  threshold?: number;
  xLabel?: L10n;
  yLabel?: L10n;
  profile: string;
}

export type OverallStatus = 'PASS' | 'PASS_WITH_RISK' | 'FAIL' | 'BLOCKED';
export type ReleaseReadiness = 'READY' | 'READY_WITH_RISK' | 'NOT_READY' | 'BLOCKED' | 'INSUFFICIENT_TESTING';

export interface RuleHit {
  ruleId: string;
  outcome: ReleaseReadiness | Severity;
  reason: L10n;
  metric: string;
  actual: number | null;
  threshold: number;
  op: CompareOp;
}

export interface Risk {
  id: string;
  level: Severity;
  title: L10n;
  evidence: L10n;
  affected?: L10n;
  frequency?: number;
  impact: L10n;
  relatedSteps: number[];
  relatedFindings: string[];
}

export interface DimensionScore {
  dimension: QualityDimension;
  /** null = 本次未執行/未收集,不給分。 */
  score: number | null;
  executed: boolean;
  findingCount: number;
  metrics: string[];
}

export interface ScopeStatus {
  id: TestScopeId;
  selected: boolean;
  status: 'executed' | 'not_executed' | 'not_applicable';
}

export interface CoverageItem {
  id: string;
  label: L10n;
  covered: boolean;
  steps: number;
  /** AI 標註(ai)或由畫面名關鍵字推斷(inferred)。 */
  basis?: 'ai' | 'inferred';
}

export interface ModuleResult {
  id: string;
  label: L10n;
  checks: number;
  pass: number;
  fail: number;
  unclear: number;
  passRate: number | null;
  critical: number;
  high: number;
  avgDurationMs: number | null;
  steps: number;
}

export interface MechanicResult {
  id: string;
  label: L10n;
  tested: boolean;
  pass: number;
  fail: number;
  steps: number;
}

export interface TestCaseDetail {
  id: string;
  name: string;
  category: string;
  module?: string;
  priority?: string;
  severity?: string;
  precondition?: string;
  input?: string;
  testSteps?: string;
  expectedResult?: string;
  actualResult?: string;
  result: OverallStatus;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  aiGenerated: boolean;
  aiConfidence?: number;
  agentModel?: string;
  vlmModel?: string;
  retryCount: number;
  recoveryCount: number;
}

export interface ReportHeader {
  reportId: string;
  gameName?: string;
  gameVersion?: string;
  buildNumber?: string;
  genre?: string;
  secondaryGenres: string[];
  platform?: string;
  operatingSystem?: string;
  device?: string;
  resolution?: string;
  testEnvironment?: string;
  serverRegion?: string;
  testStartTime?: string;
  testEndTime?: string;
  testDurationMs?: number;
  aiModelVersion?: string;
  agentModel?: string;
  testEngineVersion?: string;
  knowledgeBaseVersions: string[];
  testPlanVersion?: string;
}

export interface StructuredReport {
  schemaVersion: 1;
  header: ReportHeader;
  overallStatus: OverallStatus;
  statusReason: L10n;
  terminal: { state: string; message?: string; classification?: FailureClass };
  release: { readiness: ReleaseReadiness; hits: RuleHit[]; thresholds: Record<string, number> };
  summaryLines: L10n[];
  counts: {
    totalChecks: number;
    executedChecks: number;
    passed: number;
    failed: number;
    unclear: number;
    blocked: number;
    skipped: number;
    passRate: number | null;
    executionRate: number | null;
    defects: Record<Severity, number>;
  };
  metrics: MetricValue[];
  dashboard: DimensionScore[];
  scope: ScopeStatus[];
  coverage: {
    feature: CoverageItem[];
    mechanic: CoverageItem[];
    gameState: CoverageItem[];
    scenario: CoverageItem[];
    device: Array<{ label: L10n; value: string }>;
  };
  modules: ModuleResult[];
  mechanics: MechanicResult[];
  testCase: TestCaseDetail;
  /** 逐步檢查判定(判定明細表)。 */
  checks: CheckItem[];
  findings: Finding[];
  /** AI 測試本身的失敗(不是遊戲缺陷)。 */
  aiFailures: Finding[];
  risks: Risk[];
  charts: ChartData[];
  sections: ReportSection[];
  profiles: Array<{ id: string; version: string; label: L10n }>;
  spec: { values: Record<string, number>; sources: string[] };
  evidence: EvidenceStep[];
  notes: L10n[];
}

// ───────────────────────── AI 洞察(可選,LLM 產生)─────────────────────────

/** 需求驗證結果(案例步驟/預期逐條對應)。 */
export type RequirementResult = 'pass' | 'fail' | 'unclear' | 'not_tested';

export interface RequirementVerdict {
  id: string;
  /** 案例中的需求原文(一條步驟或一條預期)。 */
  text: string;
  result: RequirementResult;
  evidenceSteps: number[];
  reason: L10n;
  suggestion?: L10n;
}

export interface Recommendation {
  priority: 'P0' | 'P1' | 'P2';
  /** dev = 遊戲開發修正;qa = 測試案例/知識庫調整;env = 測試環境。 */
  owner: 'dev' | 'qa' | 'env';
  text: L10n;
  relatedFindings: string[];
}

/**
 * AI 洞察:LLM 根據「已由程式計算好的」結構化報告做歸納,不改任何數字。
 * 存 tenants/<t>/jobs/<id>/insights.json;使用者按鈕觸發產生。
 */
export interface ReportInsights {
  schemaVersion: 1;
  generatedAt: string;
  model: string;
  /** 產生時使用的語言(文字欄位 zh/en 內容相同,為單一語言)。 */
  lang: 'zh' | 'en';
  summary: L10n;
  rootCause: L10n;
  requirements: RequirementVerdict[];
  recommendations: Recommendation[];
  /** 對個別缺陷/判定的更具體修正建議(key = Finding.id 或 CheckItem.id)。 */
  notes: Record<string, L10n>;
}
