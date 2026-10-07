import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/I18nProvider.tsx';

/**
 * 「嵌入模式」:測試案例 / 測試任務 / 測試報告三頁同時服務獨立頁面與應用工作區分頁。
 * 這裡驗證的是兩者排版同源 —— 嵌入時只少了頁標題與應用選擇,其餘結構一致。
 */

const APPS = [
  { id: 'a1', name: '老子有錢', platform: 'android' },
  { id: 'a2', name: '別的遊戲', platform: 'web' },
];
const CASES = [
  { id: 'c1', app: 'a1', name: '登入流程' },
  { id: 'c2', app: 'a2', name: '別的案例' },
];

vi.mock('../api/client.ts', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.startsWith('/apps')) return { items: APPS };
    if (path.startsWith('/cases/overview')) return { items: [] };
    if (path.startsWith('/cases')) return { items: CASES };
    if (path.startsWith('/tasks')) return { items: [] };
    if (path.startsWith('/reports')) return { items: [] };
    return { items: [] };
  }),
  apiPost: vi.fn(async () => ({})),
  apiPut: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
  uploadToS3: vi.fn(async () => {}),
  ApiError: class ApiError extends Error {},
}));

const { default: CasesPage } = await import('./CasesPage.tsx');
const { default: TasksPage } = await import('./TasksPage.tsx');
const { default: ReportsPage } = await import('./ReportsPage.tsx');
const client = await import('../api/client.ts');

function renderPage(ui: React.ReactElement) {
  return render(
    <I18nProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  // jsdom 沒有實作 scrollIntoView(兩頁展開表單時會呼叫)。
  Element.prototype.scrollIntoView = () => {};
  localStorage.setItem('playagent.locale', 'zh-Hant');
  vi.mocked(client.apiGet).mockClear();
});

describe('測試案例頁', () => {
  test('獨立頁:有頁標題與「所屬應用」下拉', async () => {
    const { container } = renderPage(<CasesPage />);
    expect(screen.getByRole('heading', { name: '測試案例' })).toBeInTheDocument();
    expect(container.querySelector('.listpage--embed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '建立測試案例' }));
    expect(screen.getByText('所屬應用')).toBeInTheDocument();
  });

  test('嵌入模式:沒有頁標題與應用下拉,但建立表單照樣是同一份', async () => {
    const { container } = renderPage(<CasesPage appId="a1" />);
    expect(screen.queryByRole('heading', { name: '測試案例' })).toBeNull();
    expect(container.querySelector('.listpage--embed')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '建立測試案例' }));
    expect(screen.queryByText('所屬應用')).toBeNull();
    // 同一份表單:案例名稱欄與自然語言/YAML 分頁都還在
    expect(screen.getByText('案例名稱')).toBeInTheDocument();
    expect(container.querySelector('.cases__form')).not.toBeNull();
  });
});

describe('測試任務頁', () => {
  test('獨立頁:讀最新 100 筆、表單有應用下拉', async () => {
    renderPage(<TasksPage />);
    await waitFor(() => expect(client.apiGet).toHaveBeenCalledWith('/tasks?limit=100'));
    fireEvent.click(screen.getByRole('button', { name: '提交任務' }));
    expect(screen.getByText('應用')).toBeInTheDocument();
    expect(screen.getByText('測試案例')).toBeInTheDocument();
  });

  test('嵌入模式:只讀本應用的任務,表單沒有應用下拉', async () => {
    const { container } = renderPage(<TasksPage appId="a1" />);
    await waitFor(() => expect(client.apiGet).toHaveBeenCalledWith('/tasks?app=a1&limit=200'));
    expect(container.querySelector('.listpage--embed')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '提交任務' }));
    expect(screen.queryByText('應用')).toBeNull();
    // 同一份表單:案例欄仍在,且案例清單已篩成本應用的
    expect(screen.getByText('測試案例')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: '登入流程' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: '別的案例' })).toBeNull();
  });
});

describe('測試報告頁', () => {
  test('獨立頁:讀全部報告', async () => {
    renderPage(<ReportsPage />);
    await waitFor(() => expect(client.apiGet).toHaveBeenCalledWith('/reports'));
    expect(screen.getByRole('heading', { name: '測試報告' })).toBeInTheDocument();
  });

  test('嵌入模式:只讀本應用的報告,且沒有頁標題', async () => {
    const { container } = renderPage(<ReportsPage appId="a1" />);
    await waitFor(() => expect(client.apiGet).toHaveBeenCalledWith('/reports?app=a1'));
    expect(screen.queryByRole('heading', { name: '測試報告' })).toBeNull();
    expect(container.querySelector('.listpage--embed')).not.toBeNull();
  });
});
