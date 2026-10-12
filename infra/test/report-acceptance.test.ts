import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import { targetSpins } from '../lambda/api/report/acceptance.js';
import { autospinWindows, buildRtpLedger } from '../lambda/api/report/rtpLedger.js';
import type { EvidenceStep } from '../lambda/api/report/types.js';

/**
 * 驗收標準(PA-AS):一次測試只有一個結論,而且每個判定都對得到證據步驟。
 * 情境取自 2026-10-12 job-mv3xfeax:列表顯示「通過」、報告封面顯示「失敗」。
 */

type RawStep = Record<string, unknown>;
const st = (index: number, screen: string, action: string, obs?: Record<string, unknown>, extra: RawStep = {}): RawStep => ({
  index, screen, action, ...(obs ? { obs } : {}), ...extra,
});
const report = (state: string, steps: RawStep[], task = '探索遊戲', message?: string) =>
  buildStructuredReport({ raw: { state, task, steps, ...(message ? { message } : {}) }, job: { jobId: 'job-test' }, app: { genre: 'slot' } });

const RTP_TASK = '目標:同一台機台、固定投注額下,累計玩滿 500 局「付費旋轉」,並用實際讀到的數字算出 RTP。所有數字都必須是畫面上實際讀到的值,不可以估算或編造。';

/** 一段 AutoSpin(同一投注額):600→350→100,共 500 局。 */
function cleanRtpSteps(): RawStep[] {
  return [
    st(1, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 1000, balance: 1000000, autospin_left: 600 }),
    st(2, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 1000, balance: 900000, autospin_left: 350 }),
    st(3, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 1000, balance: 780000, autospin_left: 100 }),
    st(4, '轉軸畫面', 'done', { bet: 1000, balance: 780000 }, { thinking: '500 局完成,餘額 780,000' }),
  ];
}

describe('verdict is a single value derived from acceptance criteria', () => {
  test('clean 500-spin RTP run → PASS, RTP recomputed from the ledger', () => {
    const r = report('pass', cleanRtpSteps(), RTP_TASK, '500 局完成');
    expect(r.acceptance.criteria.filter((c) => c.result !== 'pass' && c.result !== 'not_applicable').map((c) => `${c.id}:${c.result}:${c.actual?.en}`)).toEqual([]);
    expect(r.overallStatus).toBe('PASS');
    expect(r.acceptance.verdict).toBe('PASS');
    expect(r.testCase.result).toBe('PASS');
    // 1 + (780,000 − 1,000,000) / (500 × 1000) = 56%
    expect(r.acceptance.rtp?.rtpNet).toBe(56);
    expect(r.acceptance.criteria.find((c) => c.id === 'AC-S01')).toMatchObject({ result: 'pass', evidenceSteps: [1, 3] });
  });

  test('time limit before completion → BLOCKED (not FAIL), release readiness agrees', () => {
    const r = report('fail', cleanRtpSteps().slice(0, 2), RTP_TASK, '已達執行時間上限:Device Farm 單次連線最長 150 分鐘');
    expect(r.overallStatus).toBe('BLOCKED');
    const g01 = r.acceptance.criteria.find((c) => c.id === 'AC-G01')!;
    expect(g01).toMatchObject({ result: 'fail', attribution: 'test_execution' });
    expect(r.release.readiness).toBe('BLOCKED');
  });

  test('a confirmed crash → FAIL even when the AI said done', () => {
    const r = report('pass', [
      st(0, '大廳', 'tap', undefined, { x: 10, y: 10 }),
      st(1, '大廳', 'tap', undefined, { foregroundLost: true, appState: 1, prevAction: 'tap' }),
      st(2, '大廳', 'done'),
    ]);
    expect(r.overallStatus).toBe('FAIL');
    expect(r.acceptance.decidedBy).toContain('AC-G02');
    expect(r.release.readiness).toBe('NOT_READY');
  });
});

describe('job-mv3xfeax regression: list said pass, report said fail', () => {
  /** AutoSpin 停了、投注額被換成 3,300,AI 寫「點減號」卻一直 wait,最後回報「減注鈕多次點擊無反應」。 */
  function steps(): RawStep[] {
    const out: RawStep[] = [
      st(1, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 1320, balance: 1000000, autospin_left: 500 }),
      st(2, '轉軸畫面-LEVEL UP彈窗', 'wait', { bet: 1320, balance: 1020000, autospin_left: 480 }, { thinking: 'LEVEL UP 9彈窗:REWARD 10K + SPECIAL AWARD 1,500 = 11,500入帳,記為非拉霸收入' }),
      st(3, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 1320, balance: 1100000, autospin_left: 279 }),
      st(4, '轉軸畫面', 'wait', { bet: 3300, balance: 1100000 }),
      st(5, '轉軸畫面', 'wait', { bet: 3300, balance: 1100000 }),
    ];
    for (let i = 6; i <= 14; i++) out.push(st(i, '轉軸畫面', 'wait', { bet: 3300, balance: 1100000 }, { thinking: `連續 ${i - 3} 步畫面沒變,先等待(可能仍在載入)` }));
    out.push(st(15, '轉軸畫面', 'wait', { bet: 3300, balance: 1100000 }, { issue: { cat: 'functional', sev: 'high', title: '減注鈕多次點擊無反應,TOTAL BET卡在3,300' }, conf: 0.6 }));
    out.push(st(16, '轉軸畫面', 'back', { bet: 3300, balance: 1100000 }, { issue: { cat: 'functional', sev: 'high', title: '減注鈕多次點擊無反應,TOTAL BET卡在3,300' }, conf: 0.6 }));
    out.push(st(17, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 3300, balance: 1100000, autospin_left: 500 }));
    out.push(st(18, '轉軸畫面-LEVEL UP彈窗', 'wait', { bet: 3300, balance: 1500000, autospin_left: 300 }, { thinking: 'LEVEL UP 24彈窗,REWARD約50K+3K=53K(金幣遮擋,記為待核對)' }));
    out.push(st(19, '轉軸畫面-AutoSpin進行中', 'wait', { bet: 3300, balance: 1400000, autospin_left: 200 }));
    out.push(st(20, '轉軸畫面', 'done', { bet: 3300, balance: 1400000 }));
    return out;
  }
  const conclusion = '累計付費524局已達標。非拉霸收入約211,300(LEVEL UP 9:11,500實讀;7日寶箱約16,800由餘額推斷;LEVEL UP 24約53,000部分遮擋,屬待核對估計)。';

  test('the AI-claimed "button unresponsive" defect without any tap is an AI failure, not a game defect', () => {
    const r = report('pass', steps(), RTP_TASK, conclusion);
    expect(r.findings.some((f) => /減注鈕/.test(f.title.zh) && f.classification === 'GAME_FAILURE')).toBe(false);
    const aif = r.aiFailures.find((f) => /沒有對應的操作紀錄/.test(f.title.zh))!;
    expect(aif).toBeDefined();
    expect(aif.description.zh).toContain('wait');
  });

  test('verdict is BLOCKED with the exact failing criteria and evidence steps', () => {
    const r = report('pass', steps(), RTP_TASK, conclusion);
    expect(r.overallStatus).toBe('BLOCKED');
    const by = Object.fromEntries(r.acceptance.criteria.map((c) => [c.id, c]));
    expect(by['AC-G03']!.result).toBe('pass');
    expect(by['AC-S02']).toMatchObject({ level: 'must', result: 'fail', attribution: 'test_execution', evidenceSteps: [3, 4] });
    expect(by['AC-S03']).toMatchObject({ level: 'must', result: 'fail', attribution: 'data' });
    expect(by['AC-S03']!.actual!.zh).toContain('7日寶箱約16,800由餘額推斷');
    expect(by['AC-S04']).toMatchObject({ result: 'fail', evidenceSteps: [2, 18] });
    expect(by['AC-S05']!.result).toBe('not_evaluable');
    expect(r.acceptance.rtp!.rtpNet).toBeNull();
    expect(r.release.readiness).toBe('BLOCKED');
  });
});

describe('AI-observed defects must be reproducible before they can fail a run', () => {
  test('a single high-confidence observation is triage, not a confirmed game defect', () => {
    const r = report('pass', [
      st(0, '相容性提示彈窗', 'tap', undefined, { x: 5, y: 5, conf: 0.95, issue: { cat: 'compatibility', sev: 'high', title: 'App 與最新版 Android 不相容提示' } }),
      st(1, '大廳', 'done'),
    ]);
    expect(r.findings[0]!.classification).toBe('NEEDS_TRIAGE');
    expect(r.overallStatus).toBe('PASS_WITH_RISK');
  });

  test('disconnect / another-device errors are environment triage even when repeated', () => {
    const issue = { cat: 'functional', sev: 'critical', title: '8020另一裝置錯誤,RECONNECT無效' };
    const r = report('pass', [
      st(0, '斷線錯誤彈窗', 'tap', undefined, { x: 5, y: 5, conf: 0.9, issue }),
      st(1, '斷線錯誤彈窗', 'tap', undefined, { x: 5, y: 5, conf: 0.9, issue }),
      st(2, '大廳', 'done'),
    ]);
    expect(r.findings.find((f) => /8020/.test(f.title.zh))!.classification).toBe('NEEDS_TRIAGE');
    expect(r.overallStatus).not.toBe('FAIL');
  });

  test('"unresponsive" is overturned when the same screen responds within 10 steps', () => {
    const issue = { cat: 'functional', sev: 'critical', title: 'SPIN 按鈕點擊無反應,機台疑似軟鎖' };
    const r = report('pass', [
      st(0, '轉軸畫面', 'tap', undefined, { x: 5, y: 5 }),
      st(1, '轉軸畫面', 'tap', undefined, { x: 5, y: 5, conf: 0.7, issue }),
      st(2, '轉軸畫面', 'tap', undefined, { x: 5, y: 5, conf: 0.7, issue }),
      st(3, '轉軸畫面', 'tap', undefined, { x: 5, y: 5 }),
      st(4, '轉軸畫面-LEVEL UP彈窗', 'tap', undefined, { x: 5, y: 5 }),
      st(5, '轉軸畫面', 'done'),
    ]);
    expect(r.findings.find((f) => /軟鎖/.test(f.title.zh))!.classification).toBe('NEEDS_TRIAGE');
  });
});

describe('RTP ledger', () => {
  test('windows split on bet change, AutoSpin restart and connection segment', () => {
    const s = (index: number, obs: Record<string, number>, segment?: number): EvidenceStep => ({ index, screen: 'reels', action: 'wait', obs, ...(segment ? { segment } : {}) });
    const w = autospinWindows([
      s(1, { autospin_left: 500, balance: 1000, bet: 10 }),
      s(2, { autospin_left: 400, balance: 900, bet: 10 }),
      s(3, { autospin_left: 500, balance: 950, bet: 10 }), // 重開 AutoSpin:新區間
      s(4, { autospin_left: 450, balance: 940, bet: 10 }),
      s(5, { autospin_left: 450, balance: 940, bet: 20 }), // 換投注額
      s(6, { autospin_left: 440, balance: 930, bet: 20 }),
      s(7, { autospin_left: 100, balance: 50 }, 2), // 換連線
      s(8, { autospin_left: 90, balance: 40 }, 2),
    ]);
    expect(w.map((x) => [x.firstStep, x.lastStep, x.spins, x.bet])).toEqual([[1, 2, 100, 10], [3, 4, 50, 10], [5, 6, 10, 20], [7, 8, 10, 20]]);
  });

  test('credits inside a window are deducted; lobby rewards between windows are listed but not counted', () => {
    const s = (index: number, screen: string, obs?: Record<string, number | boolean>, thinking?: string): EvidenceStep =>
      ({ index, screen, action: 'wait', ...(obs ? { obs } : {}), ...(thinking ? { thinking } : {}) });
    const led = buildRtpLedger([
      s(1, '轉軸畫面', { autospin_left: 100, balance: 100000, bet: 1000 }),
      s(2, '轉軸畫面-LEVEL UP彈窗', { autospin_left: 90, balance: 120000, bet: 1000 }, 'LEVEL UP:REWARD 10K = 10,000入帳'),
      s(3, '轉軸畫面', { autospin_left: 0, balance: 60000, bet: 1000 }),
      s(4, '大廳', { balance: 60000 }),
      s(5, '每日登入彈窗', undefined, '按 COLLECT 領取'),
      s(6, '大廳', { balance: 190000 }),
    ], {})!;
    expect(led.credits.map((c) => [c.steps.join(','), c.amount, c.basis, c.windowId ?? null])).toEqual([
      ['2', 10000, 'ai_read', 'W1'],
      ['5', 130000, 'balance_diff', null],
    ]);
    // (60,000 − 100,000 − 10,000 + 100,000) / 100,000 = 50%
    expect(led.rtpNet).toBe(50);
    expect(led.rtpGross).toBe(60);
    expect(led.stats.sigmaSource).toBe('assumed');
    expect(led.stats.ci95Pp).toBe(117.6);
  });

  test('target spins are parsed from the case text', () => {
    expect(targetSpins(RTP_TASK)).toBe(500);
    expect(targetSpins('跑滿 1000 次')).toBe(1000);
    expect(targetSpins('隨便玩')).toBeNull();
  });
});
