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
  notes: L10n[];
}
