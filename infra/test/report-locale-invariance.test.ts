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
