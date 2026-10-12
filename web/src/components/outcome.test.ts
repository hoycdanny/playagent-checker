import { describe, expect, test } from 'vitest';
import { outcomeTip, shortReason } from './outcome.ts';

const ZH = '本次測試無法作為驗收依據 —— AC-G01 測試流程執行完成、AC-S01 付費旋轉樣本數達標、AC-S04 非拉霸收入已逐筆分離、AC-S05 RTP 可由證據重算 未通過或無法判定(原因不是遊戲缺陷),需修正後重測';
const EN = 'This run cannot be used for acceptance — AC-G01 Test procedure completed, AC-S01 Paid-spin sample size reached failed or could not be evaluated for a non-game reason; fix and re-run';
const t = (k: string) => ({ 'outcome.blocked': '受阻', 'outcome.fail': '失敗', 'outcome.execution': '執行結果', 'state.error': '錯誤', 'state.pass': '執行完成' } as Record<string, string>)[k] ?? k;

describe('outcome tooltip is short', () => {
  test('criteria list → count + first ids', () => {
    expect(shortReason(ZH)).toBe('4 項未通過或無法判定:AC-G01、AC-S01、AC-S04 等');
    expect(shortReason(EN, 'en')).toBe('2 criteria not met: AC-G01, AC-S01');
  });

  test('plain reason → first sentence, capped', () => {
    expect(shortReason('畫面卡在載入中超過 3 分鐘。之後重啟也無效')).toBe('畫面卡在載入中超過 3 分鐘');
    expect(shortReason('x'.repeat(80)).length).toBe(40);
  });

  test('tooltip: verdict + short reason; execution only when abnormal', () => {
    const v = { status: 'BLOCKED' as const, reason: { zh: ZH, en: EN }, standard: 's' };
    expect(outcomeTip({ state: 'pass', verdict: v }, t as never)).toBe('受阻 — 4 項未通過或無法判定:AC-G01、AC-S01、AC-S04 等');
    expect(outcomeTip({ state: 'error', verdict: v }, t as never)).toContain('· 執行結果:錯誤');
    expect(outcomeTip({ state: 'error' }, t as never)).toBe('錯誤');
  });
});
