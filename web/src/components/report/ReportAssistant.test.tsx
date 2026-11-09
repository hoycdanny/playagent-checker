import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReportAssistant } from './ReportAssistant.tsx';
import type { StructuredReport } from './reportTypes.ts';

const L = (zh: string, en = zh) => ({ zh, en });

/**
 * 報告助手。
 *
 * 這組測試守的是助手的設計約束,不是像素:
 *   1. 助手**不產生新結論** —— 顯示的理由必須是報告算出來的那一句。
 *   2. 「不涵蓋什麼」必須完整列出,不能只挑前幾項(挑選就是替讀者判斷)。
 *   3. 能力統計必須用後端的結構化數字;舊報告沒有那個欄位時整段不顯示,
 *      而不是顯示 0(0 會被讀成「沒有缺口」,與事實相反)。
 *   4. 待判斷的件數要含「無法判斷的檢查項」,否則 PASS 看起來比實際乾淨。
 */
function report(over: Partial<StructuredReport> = {}): StructuredReport {
  return {
    schemaVersion: 1,
    header: { reportId: 'R-1' },
    overallStatus: 'PASS',
    statusReason: L('狀態理由(後備)'),
    terminal: { state: 'pass' },
    release: { readiness: 'READY', thresholds: {}, hits: [] },
    summaryLines: [],
    counts: {
      totalChecks: 12, executedChecks: 12, passed: 12, failed: 0, unclear: 0,
      blocked: 0, skipped: 0, passRate: 1, executionRate: 1,
      defects: { critical: 0, high: 0, medium: 0, low: 0 },
    },
    metrics: [], dashboard: [], scope: [],
    coverage: { feature: [], mechanic: [], gameState: [], scenario: [], device: [] },
    modules: [], mechanics: [],
    testCase: { id: 'c1', name: 'c', category: 'test', result: 'PASS', aiGenerated: false, retryCount: 0, recoveryCount: 0 },
    findings: [], aiFailures: [], charts: [], evidence: [], risks: [],
    profiles: [], spec: { values: {}, sources: [] }, dataQuality: {}, notes: [],
    ...over,
  } as unknown as StructuredReport;
}

const noop = () => {};
const LAUNCH = '報告導讀';

function open(r: StructuredReport, onVerdicts = noop, onSection = noop) {
  render(<ReportAssistant report={r} lang="zh" onGoVerdicts={onVerdicts} onGoSection={onSection} />);
  fireEvent.click(screen.getByRole('button', { name: LAUNCH }));
}

describe('收合與展開', () => {
  test('預設收合,只有一顆啟動器', () => {
    render(<ReportAssistant report={report()} lang="zh" onGoVerdicts={noop} onGoSection={noop} />);
    expect(screen.getByRole('button', { name: LAUNCH })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  test('點開後出現面板,可以再收起來', () => {
    open(report());
    expect(screen.getByRole('complementary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收合' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  test('沒有待確認項目時,啟動器不顯示數字', () => {
    render(<ReportAssistant report={report()} lang="zh" onGoVerdicts={noop} onGoSection={noop} />);
    expect(screen.getByRole('button', { name: LAUNCH }).textContent).not.toMatch(/\d/);
  });
});

describe('問答分頁', () => {
  test('沒有 jobId 就不顯示問答分頁(例如從匯出的報告檔開啟)', () => {
    open(report());
    expect(screen.queryByRole('button', { name: '問答' })).toBeNull();
  });

  test('有 jobId 才出現,且預設停在導讀', () => {
    render(<ReportAssistant report={report()} lang="zh" jobId="job-1" onGoVerdicts={noop} onGoSection={noop} />);
    fireEvent.click(screen.getByRole('button', { name: LAUNCH }));
    expect(screen.getByRole('button', { name: '問答' })).toBeTruthy();
    // 預設是導讀:使用者先看到結論與邊界,而不是一個空的輸入框
    expect(screen.getByText(/判定結果/)).toBeTruthy();
  });

  test('切到問答後導讀內容收起,不同時佔版面', () => {
    render(<ReportAssistant report={report()} lang="zh" jobId="job-1" onGoVerdicts={noop} onGoSection={noop} />);
    fireEvent.click(screen.getByRole('button', { name: LAUNCH }));
    fireEvent.click(screen.getByRole('button', { name: '問答' }));
    expect(screen.queryByText(/判定結果/)).toBeNull();
  });
});

describe('用語:中性、無第二人稱、與報告本文一致', () => {
  /** 介面文字會被客戶看到,語氣要與報告本文同一套:名詞短語、不對讀者說話。 */
  const panelText = (r: StructuredReport) => {
    open(r);
    return screen.getByRole('complementary').textContent ?? '';
  };

  test('不出現第二人稱', () => {
    const t = panelText(report({
      claimScope: { envelope: [], statements: [], notVaried: [{ id: 'audio', label: L('音訊'), note: L('無量測') }] } as never,
      qaDocs: { capability: { automated: 7, partial: 10, not_supported: 2, total: 19, note: L('n') }, documents: [], notes: [] } as never,
      findings: [{ id: 'F-1', classification: 'NEEDS_TRIAGE' }] as never,
    }));
    expect(t).not.toMatch(/你|您/);
  });

  test('不出現口語或對抗性的措辭', () => {
    const t = panelText(report());
    for (const bad of ['憑什麼', '件事', '真的缺陷', '逐筆查看']) {
      expect(t, `介面不應出現「${bad}」`).not.toContain(bad);
    }
  });

  test('能力分級沿用報告本文的同一組詞,不自創簡稱', () => {
    const t = panelText(report({
      qaDocs: { capability: { automated: 7, partial: 10, not_supported: 2, total: 19, note: L('n') }, documents: [], notes: [] } as never,
    }));
    // 與 T07 可執行範圍表一致 —— 一個概念只用一個詞
    expect(t).toContain('可自動執行');
    expect(t).toContain('部分(有缺口)');
    expect(t).toContain('結構性做不到');
  });
});

describe('結論:助手不產生新結論', () => {
  test('理由用驗收判定算出來的那一句,不自己改寫', () => {
    const r = report({
      acceptance: { verdictReason: L('AC-S02 投注額全程固定 未通過') } as never,
      statusReason: L('不該用到的後備理由'),
    });
    open(r);
    expect(screen.getByText('AC-S02 投注額全程固定 未通過')).toBeTruthy();
    expect(screen.queryByText('不該用到的後備理由')).toBeNull();
  });

  test('沒有驗收判定時才退回 statusReason(舊報告)', () => {
    open(report({ statusReason: L('舊報告的狀態理由') }));
    expect(screen.getByText('舊報告的狀態理由')).toBeTruthy();
  });

  test('標題帶出實際狀態,不美化', () => {
    open(report({ overallStatus: 'FAIL' }));
    expect(screen.getByText(/FAIL/)).toBeTruthy();
  });
});

describe('不涵蓋什麼', () => {
  const claimScope = {
    envelope: [],
    statements: [],
    notVaried: [
      { id: 'audio', label: L('音訊'), note: L('本次沒有音訊量測') },
      { id: 'network', label: L('網路條件'), note: L('未施加任何網路條件') },
      { id: 'locale', label: L('語系'), note: L('只跑在 en 一個語系') },
    ],
  };

  test('完整列出每一項,不截斷', () => {
    open(report({ claimScope: claimScope as never }));
    expect(screen.getByText(/本結論未涵蓋範圍（3 項）|本結論未涵蓋範圍\(3 項\)/)).toBeTruthy();
    expect(screen.getByText('本次沒有音訊量測', { exact: false })).toBeTruthy();
    expect(screen.getByText('未施加任何網路條件', { exact: false })).toBeTruthy();
    expect(screen.getByText('只跑在 en 一個語系', { exact: false })).toBeTruthy();
  });

  test('舊報告沒有適用邊界 → 明說未提供資料,不以 0 項當成沒有限制', () => {
    open(report());
    expect(screen.getByText(/未提供適用邊界資料/)).toBeTruthy();
  });

  test('可以跳到適用邊界那一節', () => {
    const go = vi.fn();
    open(report({ claimScope: claimScope as never }), noop, go);
    fireEvent.click(screen.getByText(/詳見「適用邊界」章節/));
    expect(go).toHaveBeenCalledWith('srep-claimScope');
  });
});

describe('平台可執行範圍', () => {
  const cap = { automated: 7, partial: 10, not_supported: 2, total: 19, note: L('分類數不等於測項數 —— 不可當涵蓋率') };

  test('用後端的結構化數字,並附上「不等於涵蓋率」的警告', () => {
    open(report({ qaDocs: { capability: cap, documents: [], notes: [] } as never }));
    expect(screen.getByText(/平台可執行範圍/)).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    // 這句話是必要的:三個數字很容易被讀成涵蓋率
    expect(screen.getByText(/分類數不等於測項數/)).toBeTruthy();
  });

  test('舊報告沒有這個欄位 → 整段不顯示,而不是顯示 0', () => {
    // 顯示 0 會被讀成「沒有缺口」,與事實正好相反 —— 寧可不顯示。
    open(report({ qaDocs: { documents: [], notes: [] } as never }));
    expect(screen.queryByText(/平台可執行範圍/)).toBeNull();
  });
});

describe('待你判斷', () => {
  test('待判讀的缺陷會計入,並可跳去逐筆查看', () => {
    const go = vi.fn();
    open(report({
      findings: [
        { id: 'F-07', classification: 'NEEDS_TRIAGE' },
        { id: 'F-08', classification: 'NEEDS_TRIAGE' },
        { id: 'F-09', classification: 'GAME_FAILURE' },
      ] as never,
    }), go);
    expect(screen.getByText(/2 項缺陷待判讀/)).toBeTruthy();
    fireEvent.click(screen.getByText('檢視明細'));
    expect(go).toHaveBeenCalledWith('all');
  });

  test('無法認定的檢查項也要算進去,否則通過看起來比實際乾淨', () => {
    const r = report();
    (r.counts as { unclear?: number }).unclear = 3;
    render(<ReportAssistant report={r} lang="zh" onGoVerdicts={noop} onGoSection={noop} />);
    expect(screen.getByRole('button', { name: LAUNCH }).textContent).toContain('3');
  });

  test('有無法認定的項目時,跳轉直接套用該篩選', () => {
    const go = vi.fn();
    const r = report();
    (r.counts as { unclear?: number }).unclear = 2;
    open(r, go);
    expect(screen.getByText(/2 項判定無法認定/)).toBeTruthy();
    fireEvent.click(screen.getByText('檢視明細'));
    expect(go).toHaveBeenCalledWith('unclear');
  });

  test('兩者都沒有才顯示無待確認項目', () => {
    open(report());
    expect(screen.getByText('無待確認項目')).toBeTruthy();
  });
});
