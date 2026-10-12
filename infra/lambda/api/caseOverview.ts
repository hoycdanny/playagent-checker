/**
 * 測試案例總覽:把案例 YAML 解析成結構化欄位(步驟/驗收條件/操作行為/前置條件…),
 * 並併入執行紀錄(次數、通過率、最近結果、費用、趨勢)。供「測試案例」頁專業呈現。
 *
 * YAML 解析刻意只支援案例實際用到的子集(頂層 key、區塊純量 |/>、清單 - item、行內 [a, b]),
 * 不引入 YAML 套件;未知的頂層 key 也會列出,不會被吞掉。
 */
import { outcomeOf, type TaskListItem } from './tasks.js';

export interface ParsedCase {
  task?: string;
  /** 由 task 的編號行(1. / 1、/ - )拆出的步驟;沒有編號則整段 task 為一步。 */
  steps: string[];
  assertions: string[];
  controls?: string[];
  url?: string;
  priority?: string;
  severity?: string;
  module?: string;
  category?: string;
  precondition?: string;
  expected?: string;
  tags: string[];
  /** 其餘頂層欄位(key → 摘要字串)。 */
  extra: Record<string, string>;
}

const KNOWN = new Set(['name', 'app', 'task', 'assertions', 'controls', 'url', 'priority', 'severity', 'module', 'category', 'precondition', 'preconditions', 'expected', 'expectedResult', 'tags']);

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 頂層 key → 原始值(純量字串或字串陣列)。 */
export function parseTopLevel(yaml: string): Map<string, string | string[]> {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n');
  const out = new Map<string, string | string[]>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!.replace(/\s+#.*$/, '').trim();
    // 收集縮排的子行
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === '') { body.push(''); continue; }
      if (!/^\s/.test(l)) break;
      body.push(l);
    }
    i = j - 1;
    while (body.length && body[body.length - 1] === '') body.pop();
    if (/^[|>][+-]?$/.test(rest)) {
      const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const text = body.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : '')).join(rest.startsWith('>') ? ' ' : '\n');
      out.set(key, text.trim());
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      out.set(key, rest.slice(1, -1).split(',').map(unquote).filter(Boolean));
    } else if (rest === '' && body.some((l) => /^\s*-\s+/.test(l))) {
      const items: string[] = [];
      for (const l of body) {
        const im = /^\s*-\s+(.*)$/.exec(l);
        if (im) items.push(unquote(im[1]!));
        else if (l.trim() && items.length) items[items.length - 1] += ` ${l.trim()}`;
      }
      out.set(key, items);
    } else if (rest === '' && body.length) {
      out.set(key, body.map((l) => l.trim()).filter(Boolean).join('\n'));
    } else {
      out.set(key, unquote(rest));
    }
  }
  return out;
}

/** task 文字 → 步驟清單(支援「1.」「1、」「1)」「- 」「• 」開頭)。 */
export function splitSteps(task: string | undefined): string[] {
  if (!task) return [];
  const lines = task.split('\n').map((l) => l.trim()).filter(Boolean);
  const re = /^(?:\d+\s*[.、)\]]|[-•*])\s*/;
  if (lines.filter((l) => re.test(l)).length >= 2) {
    const steps: string[] = [];
    for (const l of lines) {
      if (re.test(l)) steps.push(l.replace(re, ''));
      else if (steps.length) steps[steps.length - 1] += ` ${l}`;
      else steps.push(l);
    }
    return steps;
  }
  return [lines.join(' ')];
}

export function parseCase(yaml: string): ParsedCase {
  const top = parseTopLevel(yaml);
  const str = (k: string): string | undefined => {
    const v = top.get(k);
    if (v === undefined) return undefined;
    const s = Array.isArray(v) ? v.join('\n') : v;
    return s.trim() ? s : undefined;
  };
  const list = (k: string): string[] => {
    const v = top.get(k);
    if (v === undefined) return [];
    return (Array.isArray(v) ? v : v.split('\n')).map((x) => x.trim()).filter(Boolean);
  };
  const task = str('task');
  const extra: Record<string, string> = {};
  for (const [k, v] of top) {
    if (KNOWN.has(k)) continue;
    extra[k] = (Array.isArray(v) ? v.join(', ') : v).slice(0, 200);
  }
  const controls = top.has('controls') ? list('controls') : undefined;
  return {
    ...(task ? { task } : {}),
    steps: splitSteps(task),
    assertions: list('assertions'),
    ...(controls ? { controls } : {}),
    ...(str('url') ? { url: str('url') } : {}),
    ...(str('priority') ? { priority: str('priority') } : {}),
    ...(str('severity') ? { severity: str('severity') } : {}),
    ...(str('module') ? { module: str('module') } : {}),
    ...(str('category') ? { category: str('category') } : {}),
    ...((str('precondition') ?? str('preconditions')) ? { precondition: str('precondition') ?? str('preconditions') } : {}),
    ...((str('expected') ?? str('expectedResult')) ? { expected: str('expected') ?? str('expectedResult') } : {}),
    tags: list('tags'),
    extra,
  };
}

// ───────────────────────── 執行統計 ─────────────────────────

export interface CaseRunSummary {
  jobId: string;
  state: string;
  createdAt: string;
  finishedAt?: string;
  caseVersion?: string;
  message?: string;
  stepCount?: number;
  deviceModel?: string;
  vlmModel?: string;
  costUsd?: number;
}

export interface CaseRunStats {
  runs: number;
  /** 測試結論為通過(含通過・有風險)的次數。 */
  pass: number;
  /** 測試結論為失敗的次數。 */
  fail: number;
  /** 測試結論為受阻(無法作為驗收依據)的次數。 */
  blocked: number;
  error: number;
  cancelled: number;
  running: number;
  /** pass / (pass + fail);沒有確定結果時為 null。 */
  passRate: number | null;
  /** 最近 10 次狀態(舊 → 新)。 */
  recent: Array<{ jobId: string; state: string }>;
  last?: CaseRunSummary;
  /** 最近一次「有確定結果」(pass/fail)的執行。 */
  lastResult?: CaseRunSummary;
  costUsd: number;
  avgDurationMs: number | null;
  avgSteps: number | null;
  /** 使用「目前版本」執行過的次數。 */
  runsOnCurrentVersion: number;
  /** 實際執行過的不同版本數。 */
  versionsRun: number;
}

export interface CaseOverviewItem {
  id: string;
  app: string;
  name: string;
  version?: string;
  updatedAt?: string;
  versionCount: number;
  parsed: ParsedCase;
  stats: CaseRunStats;
}

const TERMINAL_RUNNING = new Set(['running', 'queued']);

export function runStats(
  jobs: TaskListItem[],
  currentVersion: string | undefined,
  costOf: (t: TaskListItem) => number,
): CaseRunStats {
  const sorted = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // 通過 / 失敗以測試結論為準(與報告封面一致);沒有結論的任務才看執行狀態。
  const count = (s: string) => sorted.filter((j) => outcomeOf(j) === s).length;
  const pass = count('pass') + count('pass_risk');
  const fail = count('fail');
  const summary = (t: TaskListItem): CaseRunSummary => ({
    jobId: t.jobId,
    state: outcomeOf(t),
    createdAt: t.createdAt,
    ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
    ...(t.caseVersion ? { caseVersion: t.caseVersion } : {}),
    ...(t.message ? { message: t.message.slice(0, 160) } : {}),
    ...(typeof t.stepCount === 'number' ? { stepCount: t.stepCount } : {}),
    ...(t.deviceModel ? { deviceModel: t.deviceModel } : {}),
    ...((t.seatModels?.vlm ?? t.vlmModel) ? { vlmModel: t.seatModels?.vlm ?? t.vlmModel } : {}),
    costUsd: Math.round(costOf(t) * 10000) / 10000,
  });
  const durations = sorted
    .filter((t) => !TERMINAL_RUNNING.has(t.state) && t.finishedAt)
    .map((t) => Date.parse(t.finishedAt!) - Date.parse(t.createdAt))
    .filter((d) => Number.isFinite(d) && d > 0);
  const steps = sorted.map((t) => t.stepCount).filter((s): s is number => typeof s === 'number');
  const last = sorted[sorted.length - 1];
  const lastResult = [...sorted].reverse().find((t) => ['pass', 'pass_risk', 'fail', 'blocked'].includes(outcomeOf(t)));
  return {
    runs: sorted.length,
    pass,
    fail,
    blocked: count('blocked'),
    error: count('error'),
    cancelled: count('cancelled') + count('budget_exceeded'),
    running: sorted.filter((t) => TERMINAL_RUNNING.has(t.state)).length,
    passRate: pass + fail > 0 ? Math.round((pass / (pass + fail)) * 1000) / 10 : null,
    recent: sorted.slice(-10).map((t) => ({ jobId: t.jobId, state: outcomeOf(t) })),
    ...(last ? { last: summary(last) } : {}),
    ...(lastResult ? { lastResult: summary(lastResult) } : {}),
    costUsd: Math.round(sorted.reduce((a, t) => a + costOf(t), 0) * 100) / 100,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    avgSteps: steps.length ? Math.round((steps.reduce((a, b) => a + b, 0) / steps.length) * 10) / 10 : null,
    runsOnCurrentVersion: currentVersion ? sorted.filter((t) => t.caseVersion === currentVersion).length : 0,
    versionsRun: new Set(sorted.map((t) => t.caseVersion).filter(Boolean)).size,
  };
}
