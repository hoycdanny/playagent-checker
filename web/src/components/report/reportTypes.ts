/**
 * 結構化報告型別(對齊後端 infra/lambda/api/report/types.ts 的 StructuredReport)。
 * 前端只讀取、不計算;所有數字由後端報告引擎以程式從證據計算。
 */

export interface L10n {
  zh: string;
  en: string;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FailureClass = 'GAME_FAILURE' | 'AI_TEST_FAILURE' | 'ENVIRONMENT' | 'NEEDS_TRIAGE';
export type OverallStatus = 'PASS' | 'PASS_WITH_RISK' | 'FAIL' | 'BLOCKED';
export type ReleaseReadiness = 'READY' | 'READY_WITH_RISK' | 'NOT_READY' | 'BLOCKED' | 'INSUFFICIENT_TESTING';

export interface MetricValue {
  id: string;
  label: L10n;
  unit: string;
  group: string;
  source: 'objective' | 'ai_evaluation';
  dimension?: string;
  value: number | null;
  status: 'ok' | 'not_collected';
  profile: string;
}

export interface ChartData {
  id: string;
  type: 'line' | 'bar' | 'donut';
  title: L10n;
  series: Array<{ name: L10n; points: Array<{ x: number | string; y: number }> }>;
  threshold?: number;
  xLabel?: L10n;
  yLabel?: L10n;
  profile: string;
}

export interface Finding {
  id: string;
  title: L10n;
  description: L10n;
  severity: Severity;
  category: string;
  classification: FailureClass;
  certainty: 'deterministic' | 'ai_evaluation';
  module?: string;
  gameState?: string;
  frequency: number;
  reproducibility: string;
  firstStep?: number;
  lastStep?: number;
  expected?: string;
  actual?: string;
  stepsToReproduce: string[];
  screenshotUrl?: string;
  annotatedUrl?: string;
  box?: [number, number, number, number];
  shotSize?: [number, number];
  aiConfidence?: number;
  suspectedCause?: L10n;
  suggestion?: L10n;
  relatedTestCase?: string;
}

export type CheckResult = 'pass' | 'fail' | 'unclear' | 'skipped';

/** 判定明細的一列(後端 buildChecks 產出)。 */
export interface CheckItem {
  id: string;
  kind: 'step' | 'milestone';
  title?: L10n;
  step: number;
  afterStep?: number;
  module?: string;
  screen: string;
  action: string;
  expected: string;
  actual?: string;
  result: CheckResult;
  reason?: string;
  confidence?: number;
  effective?: boolean;
  relatedFinding?: string;
  basis: 'deterministic' | 'ai_evaluation';
  suggestion?: L10n;
}

export type RequirementResult = 'pass' | 'fail' | 'unclear' | 'not_tested';

export interface ReportInsights {
  schemaVersion: 1;
  generatedAt: string;
  model: string;
  lang: 'zh' | 'en';
  summary: L10n;
  rootCause: L10n;
  /** 需要注意的點:逐條針對算出來的數字(舊報告沒有這個欄位)。 */
  watchouts?: L10n[];
  requirements: Array<{ id: string; text: string; result: RequirementResult; evidenceSteps: number[]; reason: L10n; suggestion?: L10n }>;
  recommendations: Array<{ priority: 'P0' | 'P1' | 'P2'; owner: 'dev' | 'qa' | 'env'; text: L10n; relatedFindings: string[] }>;
  notes: Record<string, L10n>;
}

export interface EvidenceStep {
  index: number;
  at?: string;
  screen: string;
  thinking?: string;
  action: string;
  x?: number;
  y?: number;
  expect?: string;
  actual?: string;
  assertion?: 'pass' | 'fail' | 'unclear';
  effective?: boolean;
  confidence?: number;
  module?: string;
  mechanic?: string;
  obs?: Record<string, number | string | boolean>;
  /** 長時模式的連線段。 */
  segment?: number;
  /** 判定為讀錯、不計入指標的數值(原值 + 原因)。 */
  excludedObs?: Record<string, { value: number; reason: L10n }>;
  issue?: { category: string; severity: Severity; title: string };
  override?: string;
  parseFailed?: boolean;
  modelError?: boolean;
  foregroundLost?: boolean;
  perf?: {
    cpuPct?: number; memMB?: number; gfxMemMB?: number; gpuPct?: number; fps?: number; frames?: number; fpsSpanS?: number;
    frameHist?: Record<string, number>; batteryTempC?: number; cpuTempC?: number; gpuTempC?: number; skinTempC?: number; batteryMah?: number;
  };
  durationMs?: number;
  vlmMs?: number;
  screenshotUrl?: string;
  annotatedUrl?: string;
}

export interface RuleHit {
  ruleId: string;
  outcome: string;
  reason: L10n;
  metric: string;
  actual: number | null;
  threshold: number;
  op: string;
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

export interface CoverageItem {
  id: string;
  label: L10n;
  covered: boolean;
  steps: number;
  basis?: 'ai' | 'inferred';
}

export interface StructuredReport {
  schemaVersion: 1;
  header: {
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
    /** 執行時的測試案例版本號(不可變)。 */
    caseVersion?: string;
  };
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
    /** 舊版後端沒有此欄位。 */
    unclear?: number;
    blocked: number;
    skipped: number;
    passRate: number | null;
    executionRate: number | null;
    defects: Record<Severity, number>;
  };
  metrics: MetricValue[];
  dashboard: Array<{ dimension: string; score: number | null; executed: boolean; findingCount: number; metrics: string[] }>;
  scope: Array<{ id: string; selected: boolean; status: 'executed' | 'not_executed' | 'not_applicable' }>;
  coverage: {
    feature: CoverageItem[];
    mechanic: CoverageItem[];
    gameState: CoverageItem[];
    scenario: CoverageItem[];
    device: Array<{ label: L10n; value: string }>;
  };
  modules: Array<{
    id: string; label: L10n; checks: number; pass: number; fail: number; unclear: number;
    passRate: number | null; critical: number; high: number; avgDurationMs: number | null; steps: number;
  }>;
  mechanics: Array<{ id: string; label: L10n; tested: boolean; pass: number; fail: number; steps: number }>;
  testCase: {
    id: string; name: string; version?: string; category: string; module?: string; priority?: string; severity?: string;
    precondition?: string; input?: string; testSteps?: string; expectedResult?: string; actualResult?: string;
    result: OverallStatus; startTime?: string; endTime?: string; durationMs?: number; aiGenerated: boolean;
    aiConfidence?: number; agentModel?: string; vlmModel?: string; retryCount: number; recoveryCount: number;
  };
  /** 驗收標準判定(overallStatus 的來源)。舊版後端沒有此欄位。 */
  acceptance?: Acceptance;
  /** 舊版後端沒有此欄位。 */
  checks?: CheckItem[];
  findings: Finding[];
  aiFailures: Finding[];
  risks: Risk[];
  charts: ChartData[];
  sections: string[];
  profiles: Array<{ id: string; version: string; label: L10n }>;
  spec: { values: Record<string, number>; sources: string[] };
  evidence: EvidenceStep[];
  dataQuality?: {
    excluded: Array<{ step: number; key: string; value: number; reason: L10n; prev?: { step: number; value: number }; next?: { step: number; value: number } }>;
    betChanges: Array<{ step: number; prevStep: number; key: string; from: number; to: number }>;
  };
  /** 逐局盤面影片證據(slot-board-v1)。 */
  slotCapture?: SlotCaptureManifest;
  notes: L10n[];
}

// ───────── 驗收標準(後端 report/acceptance.ts、rtpLedger.ts)─────────

export type AcLevel = 'must' | 'should';
export type AcResult = 'pass' | 'fail' | 'not_evaluable' | 'not_applicable';
export type AcAttribution = 'game' | 'test_execution' | 'environment' | 'ai_agent' | 'data';

export interface AcceptanceCriterion {
  id: string;
  group: string;
  level: AcLevel;
  title: L10n;
  requirement: L10n;
  threshold?: L10n;
  actual?: L10n;
  result: AcResult;
  attribution?: AcAttribution;
  basis: 'deterministic' | 'ai_evaluation';
  evidenceSteps: number[];
  relatedFindings: string[];
  sources: Array<{ kind: 'case' | 'standard' | 'engine'; ref: string; quote?: string }>;
  note?: L10n;
}

export interface LedgerPoint { step: number; value: number }

export interface RtpWindow {
  id: string;
  segment: number;
  bet: number;
  firstStep: number;
  lastStep: number;
  counterStart: LedgerPoint;
  counterEnd: LedgerPoint;
  spins: number;
  wagered: number;
  balanceStart: LedgerPoint;
  balanceEnd: LedgerPoint;
  balanceDelta: number;
  steps: number[];
}

export interface NonSlotCredit {
  id: string;
  steps: number[];
  screen: string;
  amount: number | null;
  basis: 'obs' | 'balance_diff' | 'ai_read' | 'none_seen' | 'unresolved';
  windowId?: string;
  quote?: string;
  note: L10n;
}

export interface RtpLedger {
  method: 'autospin_balance';
  windows: RtpWindow[];
  spins: number;
  wagered: number;
  balanceDelta: number;
  credits: NonSlotCredit[];
  creditsInWindow: number;
  unresolvedInWindow: number;
  rtpGross: number;
  rtpNet: number | null;
  derivedWin: number | null;
  stats: { sigma: number; sigmaSource: 'spec' | 'assumed'; ci95Pp: number | null; spinsFor1Pp: number; expectedRtp?: number; z?: number };
  formula: L10n;
}

export interface Acceptance {
  standard: string;
  verdict: OverallStatus;
  verdictReason: L10n;
  decidedBy: string[];
  criteria: AcceptanceCriterion[];
  rtp?: RtpLedger;
  references: Array<{ id: string; title: string; url: string; use: L10n }>;
  rules: L10n[];
}

// ───────── 逐局盤面影片證據(slot-board-v1)─────────
export interface SlotCaptureSpin {
  sequence: number;
  session: number;
  kind: 'paid' | 'free' | 'unknown';
  modeReason?: string;
  startedAt: number;
  capturedAt: number;
  sourceSegment: string;
  sourceOffsetMs: number;
  busyMs: number;
  stableMs: number;
  confidence: number;
  boardKey: string;
  contextKey: string;
  status: 'captured' | 'capture_failed';
  error?: string;
  boardUrl?: string;
  contextUrl?: string;
}
export interface SlotCaptureManifest {
  schemaVersion: number;
  machineId: string;
  appVersion: string;
  state: string;
  capture: { fps: number; roi: { x: number; y: number; w: number; h: number }; grid: [number, number]; source: string };
  summary: { detectedSpins: number; paidSpins: number; freeSpins: number; unknownSpins: number; capturedBoards: number; captureFailures: number; segmentCount: number; gapCount: number; gapMs: number; analysisFailures: number };
  spins: SlotCaptureSpin[];
  gaps: Array<{ after: string; before: string; from: number; to: number; ms: number }>;
  segments: Array<{ name: string; session: number; startedAt: number; durationMs: number; frameCount: number; bytes: number }>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}
