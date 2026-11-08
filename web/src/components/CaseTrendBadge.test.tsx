import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../i18n/I18nProvider.tsx';
import { CaseTrendBadge } from './CaseTrendBadge.tsx';

/**
 * 趨勢徽章顯示的是**測試結論**,不是執行結果。
 * 「執行完成」不等於通過(見 docs/design/acceptance-standard.md §1),
 * 用執行結果畫結果點,會讓結論失敗的那一次顯示成 ✓。
 */

const apiGet = vi.fn();
vi.mock('../api/client.ts', () => ({ apiGet: (...args: unknown[]) => apiGet(...args) }));

const view = () =>
  render(
    <I18nProvider>
      <CaseTrendBadge app="app-1" caseId="case-1" />
    </I18nProvider>,
  );

const trend = (over: Record<string, unknown> = {}) => ({
  recent: [],
  total: 1,
  passCount: 1,
  failCount: 0,
  errorCount: 0,
  passRate: 1,
  flaky: false,
  flakyReason: '無反覆',
  blockedCount: 0,
  verdictCoverage: { withVerdict: 1, total: 1, note: '全部依測試結論判定' },
  retest: { links: [], unresolved: [], note: '歷史中沒有失敗的版本,無複驗鏈' },
  ...over,
});

beforeEach(() => {
  apiGet.mockReset();
});

describe('結果點依測試結論著色', () => {
  test('執行完成但結論失敗 → 顯示 ✕,不是 ✓', async () => {
    apiGet.mockResolvedValue(
      trend({
        recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z', outcome: 'fail', basis: 'verdict' }],
        passCount: 0,
        failCount: 1,
        passRate: 0,
      }),
    );
    view();
    await waitFor(() => expect(screen.getByLabelText('fail')).toBeInTheDocument());
    expect(screen.getByLabelText('fail').textContent).toBe('✕');
  });

  test('受阻用獨立符號,不混進通過或失敗', async () => {
    apiGet.mockResolvedValue(
      trend({
        recent: [{ jobId: 'j1', state: 'fail', createdAt: '2026-09-02T00:00:00Z', outcome: 'blocked', basis: 'verdict' }],
        passCount: 0,
        passRate: null,
        blockedCount: 1,
      }),
    );
    view();
    await waitFor(() => expect(screen.getByText('⊘')).toBeInTheDocument());
  });

  test('舊版後端只回執行結果時仍可顯示(退回原本的符號表)', async () => {
    apiGet.mockResolvedValue({
      recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z' }],
      total: 1, passCount: 1, failCount: 0, errorCount: 0, passRate: 1, flaky: false,
    });
    view();
    await waitFor(() => expect(screen.getByLabelText('pass').textContent).toBe('✓'));
  });
});

describe('依據較弱時要看得出來', () => {
  test('有退回執行結果的筆數 → 通過率加註記', async () => {
    apiGet.mockResolvedValue(
      trend({
        recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z', outcome: 'pass', basis: 'execution_state' }],
        verdictCoverage: { withVerdict: 0, total: 1, note: '皆無測試結論,全部退回執行結果' },
      }),
    );
    view();
    await waitFor(() => expect(screen.getByText(/100%\*/)).toBeInTheDocument());
  });

  test('全部依結論判定時不加註記', async () => {
    apiGet.mockResolvedValue(
      trend({
        recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z', outcome: 'pass', basis: 'verdict' }],
      }),
    );
    view();
    await waitFor(() => expect(screen.getByText(/100%$/)).toBeInTheDocument());
  });
});

describe('複驗狀態', () => {
  test('已複驗與未複驗分別呈現', async () => {
    apiGet.mockResolvedValue(
      trend({
        recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z', outcome: 'pass', basis: 'verdict' }],
        retest: {
          links: [{ failedVersion: 'b1', retestVersion: 'b2' }],
          unresolved: [{ artifactVersion: 'b3' }],
          note: '1 筆已複驗通過、1 筆尚未複驗通過;原版本的失敗紀錄保留不覆寫',
        },
      }),
    );
    view();
    await waitFor(() => expect(screen.getByText(/↻/)).toBeInTheDocument());
    expect(screen.getByText(/⚠/)).toBeInTheDocument();
  });

  test('沒有失敗過就不顯示複驗區塊', async () => {
    apiGet.mockResolvedValue(
      trend({ recent: [{ jobId: 'j1', state: 'pass', createdAt: '2026-09-02T00:00:00Z', outcome: 'pass', basis: 'verdict' }] }),
    );
    view();
    await waitFor(() => expect(screen.getByText(/100%/)).toBeInTheDocument());
    expect(screen.queryByText(/↻/)).toBeNull();
  });
});

describe('沒有歷史時不假裝有資料', () => {
  test('total 為 0 → 顯示尚無歷史執行', async () => {
    apiGet.mockResolvedValue(trend({ total: 0, passCount: 0, passRate: null }));
    view();
    await waitFor(() => expect(screen.getByText(/尚無歷史執行|No run history/)).toBeInTheDocument());
  });

  test('API 失敗時不顯示誤導的數字', async () => {
    apiGet.mockRejectedValue(new Error('network'));
    view();
    await waitFor(() => expect(screen.getByText(/尚無歷史執行|No run history/)).toBeInTheDocument());
  });
});
