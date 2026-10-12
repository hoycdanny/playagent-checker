import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AcceptancePanel } from './AcceptancePanel.tsx';
import type { Acceptance, EvidenceStep } from './reportTypes.ts';

const L = (zh: string, en = zh) => ({ zh, en });

/** 2026-10-12 job-mv3xfeax 的驗收結果(節錄):受阻,投注額在 #78 被換掉。 */
const acceptance: Acceptance = {
  standard: 'PA-AS-1.0',
  verdict: 'BLOCKED',
  verdictReason: L('本次測試無法作為驗收依據 —— AC-S02 投注額全程固定 未通過'),
  decidedBy: ['AC-S02'],
  criteria: [
    { id: 'AC-G01', group: 'execution', level: 'must', title: L('測試流程執行完成'), requirement: L('依案例步驟執行到完成條件'), actual: L('AI 在第 131 步宣告完成'), result: 'pass', basis: 'ai_evaluation', evidenceSteps: [131], relatedFindings: [], sources: [] },
    {
      id: 'AC-S02', group: 'protocol', level: 'must', title: L('投注額全程固定'), requirement: L('同一台機台、同一投注額'), threshold: L('投注額變更 0 次'),
      actual: L('#78:1,320 → 3,300'), result: 'fail', attribution: 'test_execution', basis: 'deterministic', evidenceSteps: [68, 78], relatedFindings: ['DEF-002'],
      sources: [{ kind: 'case', ref: 'case', quote: '同一台機台、固定投注額下' }],
    },
    { id: 'AC-S06', group: 'rtp', level: 'should', title: L('RTP 與理論值無顯著差異'), requirement: L('|z| ≤ 2.576'), actual: L('知識庫沒有提供理論 RTP'), result: 'not_applicable', basis: 'deterministic', evidenceSteps: [], relatedFindings: [], sources: [{ kind: 'standard', ref: 'GLI-11' }] },
  ],
  rtp: {
    method: 'autospin_balance',
    windows: [{ id: 'W1', segment: 1, bet: 1320, firstStep: 7, lastStep: 40, counterStart: { step: 7, value: 496 }, counterEnd: { step: 40, value: 279 }, spins: 217, wagered: 286440, balanceStart: { step: 7, value: 1036020 }, balanceEnd: { step: 40, value: 2993488 }, balanceDelta: 1957468, steps: [7, 40] }],
    spins: 217, wagered: 286440, balanceDelta: 1957468,
    credits: [{ id: 'C1', steps: [126], screen: '轉軸畫面-LEVEL UP彈窗', amount: null, basis: 'unresolved', windowId: 'W1', quote: '=53K', note: L('AI 標示為估計 / 被遮擋 / 待核對,金額不可採用') }],
    creditsInWindow: 0, unresolvedInWindow: 1, rtpGross: 783.39, rtpNet: null, derivedWin: null,
    stats: { sigma: 6, sigmaSource: 'assumed', ci95Pp: 79.83, spinsFor1Pp: 1382976 },
    formula: L('淨 RTP =(Σ區間餘額變化 − Σ區間內非拉霸收入 + Σ投注)÷ Σ投注'),
  },
  references: [{ id: 'GLI-11', title: 'GLI-11 v3.0 Gaming Devices', url: 'https://example.org/gli11', use: L('理論 RTP') }],
  rules: [L('FAIL:任一必要項目不通過且歸因為遊戲本身')],
};
const evidence: EvidenceStep[] = [
  { index: 68, screen: '轉軸畫面', action: 'wait', screenshotUrl: 'https://img/68.png' },
  { index: 78, screen: '轉軸畫面', action: 'wait', thinking: 'TOTAL BET 變成 3,300', screenshotUrl: 'https://img/78.png' },
];

describe('AcceptancePanel', () => {
  test('shows the single verdict, the decisive criterion and its case-text source', () => {
    render(<AcceptancePanel acceptance={acceptance} evidence={evidence} lang="zh" onOpenImage={() => {}} onOpenFinding={() => {}} />);
    expect(screen.getByText('受阻')).toBeTruthy();
    expect(screen.getByText(/決定結論的項目:AC-S02/)).toBeTruthy();
    expect(screen.getByText('#78:1,320 → 3,300')).toBeTruthy();
    expect(screen.getByText('案例原文:「同一台機台、固定投注額下」')).toBeTruthy();
    expect(screen.getByText('不適用')).toBeTruthy();
    expect(screen.getByText('不可算')).toBeTruthy();
  });

  test('evidence step chips open the step screenshot; finding chips jump to the finding', () => {
    const onOpenImage = vi.fn();
    const onOpenFinding = vi.fn();
    render(<AcceptancePanel acceptance={acceptance} evidence={evidence} lang="zh" onOpenImage={onOpenImage} onOpenFinding={onOpenFinding} />);
    fireEvent.click(screen.getAllByRole('button', { name: '#78' })[0]!);
    expect(onOpenImage).toHaveBeenCalledWith('https://img/78.png');
    fireEvent.click(screen.getByRole('button', { name: 'DEF-002' }));
    expect(onOpenFinding).toHaveBeenCalledWith('DEF-002');
  });
});
