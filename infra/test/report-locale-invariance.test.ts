import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';

/**
 * 同一次錄製的執行,agent 用五種語言寫畫面名/想法/備忘時,報告的判定與數字必須完全相同。
 * 判定只能依 AI 回報的 phase、動作、座標、步驟序號,不能依畫面名稱的語言。
 * 只有 en 的盤面名稱命中關鍵字('game'),其他語言都沒有,所以拿掉 phase 處理這個測試就會失敗。
 */

type Loc = 'zh-Hant' | 'en' | 'zh-Hans' | 'ja' | 'ko';
const LOCS: Loc[] = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'];

const SCREENS: Record<Loc, { title: string; board: string; note: string; memo: string }> = {
  'zh-Hant': { title: '起始頁', board: '老虎機盤面', note: '點擊開始', memo: '餘額 1000' },
  en: { title: 'Title Screen', board: 'Slot Game Board', note: 'Tap start', memo: 'balance 1000' },
  'zh-Hans': { title: '起始页', board: '老虎机盘面', note: '点击开始', memo: '余额 1000' },
  ja: { title: 'タイトル画面', board: 'スロット本編', note: '開始をタップ', memo: '残高 1000' },
  ko: { title: '시작 화면', board: '슬롯 본편', note: '시작 누르기', memo: '잔액 1000' },
};

function recordedRun(l: Loc): Array<Record<string, unknown>> {
  const t = SCREENS[l];
  // module 與 phase 一樣是 AI 依證據協議回報的 id(與語言無關);畫面名只是顯示用。
  const mk = (index: number, screen: string, phase: string, extra: Record<string, unknown> = {}) => ({
    index, action: 'tap', screen, phase, module: phase === 'gameplay' ? 'reels' : 'machine_select',
    x: 100 + index, y: 200, thinking: t.note, memo: t.memo,
    expect: 'next screen', prevResult: index === 0 ? undefined : 'pass', screenChanged: true, ...extra,
  });
  return [
    mk(0, t.title, 'main_menu'),
    mk(1, t.title, 'loading'),
    mk(2, t.board, 'gameplay'),
    mk(3, t.board, 'gameplay'),
    mk(4, t.board, 'gameplay', { prevResult: 'fail', issue: { cat: 'ui', sev: 'low', title: t.note } }),
  ];
}

function build(l: Loc, steps = recordedRun(l), raw: Record<string, unknown> = {}) {
  return buildStructuredReport({
    raw: { state: 'pass', task: 'play a slot', steps, ...raw },
    job: { jobId: 'job-locale', locale: l },
    app: { genre: 'slot' },
  });
}

/** 與語言無關的判定與數字。 */
function projection(r: ReturnType<typeof build>) {
  const resultCounts: Record<string, number> = {};
  for (const c of r.checks) resultCounts[c.result] = (resultCounts[c.result] ?? 0) + 1;
  return {
    overallStatus: r.overallStatus,
    acceptanceVerdict: r.acceptance.verdict,
    criteria: r.acceptance.criteria.map((c) => [c.id, c.result]),
    counts: r.counts,
    findings: r.findings.map((f) => [f.severity, f.category, f.firstStep, f.lastStep]),
    checkResults: resultCounts,
    checkSteps: r.checks.map((c) => [c.kind, c.step, c.result]),
    evidenceIndices: r.evidence.map((s) => s.index),
    metrics: r.metrics.map((m) => [m.id, m.value]),
    gameStates: r.coverage.gameState.map((g) => [g.id, g.covered, g.steps]),
    terminal: r.terminal,
  };
}

describe('報告判定與語言無關', () => {
  const base = projection(build('zh-Hant'));

  test('基準:遊戲進行狀態有被認出來', () => {
    expect(base.gameStates.find((g) => g[0] === 'gameplay')).toEqual(['gameplay', true, 3]);
  });

  test.each(LOCS)('%s 與 zh-Hant 的判定、數字完全相同', (l) => {
    expect(projection(build(l))).toEqual(base);
  });

  test('五種語言互相相同', () => {
    const all = LOCS.map((l) => projection(build(l)));
    for (const p of all) expect(p).toEqual(all[0]);
  });
});

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

describe('終態訊息', () => {
  const stepLimit = '達步數上限(30 步)仍未完成目標';

  test('達步數上限:ja 與沒有 locale 的分類相同', () => {
    const steps = recordedRun('ja');
    const ja = buildStructuredReport({ raw: { state: 'fail', message: stepLimit, steps }, job: { jobId: 'j', locale: 'ja' }, app: { genre: 'slot' } });
    const none = buildStructuredReport({ raw: { state: 'fail', message: stepLimit, steps }, job: { jobId: 'j' }, app: { genre: 'slot' } });
    expect(ja.terminal).toEqual(none.terminal);
    expect(ja.overallStatus).toBe(none.overallStatus);
    expect(ja.statusReason).toEqual(none.statusReason);
    expect(ja.findings.map((f) => f.severity)).toEqual(none.findings.map((f) => f.severity));
  });

  test('非 zh-Hant 任務的終態描述 en 欄位沒有 CJK;zh 欄位保留原訊息', () => {
    const msg = '連續截圖失敗 5 次,測試環境異常';
    const steps = recordedRun('ja');
    const ja = buildStructuredReport({ raw: { state: 'error', message: msg, steps }, job: { jobId: 'j', locale: 'ja' }, app: { genre: 'slot' } });
    const f = ja.findings.find((x) => x.classification === 'ENVIRONMENT') ?? ja.aiFailures.find((x) => x.classification === 'ENVIRONMENT');
    expect(f).toBeTruthy();
    expect(f!.description.en).not.toMatch(CJK);
    expect(f!.description.zh).toBe(msg);
    const none = buildStructuredReport({ raw: { state: 'error', message: msg, steps }, job: { jobId: 'j' }, app: { genre: 'slot' } });
    const g = none.findings.find((x) => x.classification === 'ENVIRONMENT') ?? none.aiFailures.find((x) => x.classification === 'ENVIRONMENT');
    expect(g!.description.en).toBe(msg);
  });
});

describe('plain-string report fields follow the job locale', () => {
  // qaDocs (the QA-DS delivery documents) is still Chinese-only plain text; tracked separately.
  const cjkPaths = (v: unknown, path = 'r', out: string[] = []): string[] => {
    if (typeof v === 'string') { if (CJK.test(v)) out.push(path); return out; }
    if (Array.isArray(v)) { v.forEach((x) => cjkPaths(x, `${path}[]`, out)); return out; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const isPair = typeof o['zh'] === 'string' && typeof o['en'] === 'string' && Object.keys(o).length === 2;
      if (isPair) return cjkPaths(o['en'], `${path}.en`, out);
      for (const [k, x] of Object.entries(o)) if (!(path === 'r' && k === 'qaDocs')) cjkPaths(x, `${path}.${k}`, out);
    }
    return out;
  };
  const STATES = ['pass', 'fail', 'error', 'cancelled', 'budget_exceeded'];
  const run = (l: Loc | undefined, state: string, withSteps: boolean) =>
    buildStructuredReport({
      raw: { state, task: 'play a slot', steps: withSteps ? recordedRun('en') : [], message: state === 'pass' ? undefined : 'Reached the step limit (30)' },
      job: { jobId: 'job-x', ...(l ? { locale: l } : {}) },
      app: { genre: 'slot' },
    });
  /** Every plain-string field this change localizes. */
  const fields = (r: ReturnType<typeof run>) => [
    ...r.checks.filter((c) => c.kind === 'milestone').flatMap((c) => [c.expected, c.actual, c.reason].filter((x): x is string => typeof x === 'string')),
    ...r.claimScope.envelope.map((e) => e.value),
    ...r.acceptance.references.map((x) => x.title),
  ];
  const KANA = /[\u3040-\u30ff]/;
  const HANGUL = /[\uac00-\ud7af]/;
  // Characters that differ between Traditional and Simplified, taken from the zh-Hant strings of these fields.
  const TRAD_ONLY = /[測試畫擷啟執觀確項遊戲與無過這錯誤實際應請權據覺階標選]/;

  test('en: no CJK in checks, claim scope, references or findings (all states)', () => {
    for (const state of STATES) for (const withSteps of [true, false]) {
      expect(cjkPaths(run('en', state, withSteps)), `en ${state} steps=${withSteps}`).toEqual([]);
    }
  });

  test('ja gets kana, ko gets hangul, zh-Hans gets no Traditional-only characters', () => {
    for (const state of STATES) for (const withSteps of [true, false]) {
      const ja = fields(run('ja', state, withSteps)).join('\n');
      const ko = fields(run('ko', state, withSteps)).join('\n');
      const hans = fields(run('zh-Hans', state, withSteps)).join('\n');
      expect(ja, `ja ${state} ${withSteps}`).toMatch(KANA);
      expect(ja).not.toMatch(HANGUL);
      expect(ko, `ko ${state} ${withSteps}`).toMatch(HANGUL);
      expect(ko).not.toMatch(KANA);
      expect(hans, `zh-Hans ${state} ${withSteps}`).toMatch(/[\u4e00-\u9fff]/);
      expect(hans, `zh-Hans ${state} ${withSteps}`).not.toMatch(TRAD_ONLY);
      expect(hans).not.toMatch(KANA);
    }
  });

  test('each locale gets its own text for the milestone rows', () => {
    const texts = LOCS.map((l) => JSON.stringify(run(l, 'pass', true).checks.slice(0, 5).map((c) => [c.expected, c.reason])));
    expect(new Set(texts).size).toBe(5);
  });

  test('zh-Hant and an absent locale keep the Chinese milestone text and are identical to each other', () => {
    const a = run(undefined, 'fail', true);
    const b = run('zh-Hant', 'fail', true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.checks[0]!.reason).toMatch(CJK);
    expect(a.claimScope.envelope.some((e) => CJK.test(e.value))).toBe(true);
  });

  test('verdicts, counts, check ids, claim-scope flags and reference ids are identical in all five locales', () => {
    for (const state of STATES) for (const withSteps of [true, false]) {
      const p = (l: Loc | undefined) => {
        const r = run(l, state, withSteps);
        return { ...projection(r), checkIds: r.checks.map((c) => [c.id, c.kind, c.result]), observed: r.claimScope.envelope.map((e) => [e.id, e.observed]), refs: r.acceptance.references.map((x) => x.id) };
      };
      const base = p('zh-Hant');
      for (const l of LOCS) expect(p(l), `${l} ${state} steps=${withSteps}`).toEqual(base);
    }
  });
});

describe('built-in knowledge base label in the report header', () => {
  const kbs = [{ id: 'kb-builtin-slot', name: '拉霸/Slot 遊戲', builtin: true, genre: 'slot', version: '1.3' }];
  const header = (l: Loc | undefined) =>
    buildStructuredReport({
      raw: { state: 'pass', task: 'play a slot', steps: recordedRun('en') },
      job: { jobId: 'job-x', ...(l ? { locale: l } : {}) },
      app: { genre: 'slot' },
      kbs,
    } as never).header.knowledgeBaseVersions;
  test('zh-Hant and absent locale keep the Chinese name; every other locale gets the neutral id', () => {
    expect(header(undefined)[0]).toContain('拉霸');
    expect(header('zh-Hant')[0]).toContain('拉霸');
    for (const l of ['en', 'zh-Hans', 'ja', 'ko'] as Loc[]) {
      expect(header(l)[0]).toBe('kb-builtin-slot v1.3');
    }
  });
});
