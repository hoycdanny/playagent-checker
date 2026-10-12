import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/I18nProvider.tsx';

/**
 * 勾選任務後的批次動作鈕要出現在標題列(「提交任務」旁邊),不是篩選列末端。
 * 原因:勾選是在下方表格做的,動作鈕要落在同一個視線範圍;篩選條件一多,
 * 放在篩選列末端的鈕會被推到難以預期的位置。
 *
 * 另外驗證「可取消」與「可刪除」是依狀態分流的:執行中的只能取消,已結束的只能刪除。
 */

const TASKS = [
  // 執行中 → 只能取消
  { jobId: 'job-run-1', backend: 'web', locality: 'cloud', category: 'test', appId: 'a1', caseId: 'c1', state: 'running', createdAt: '2026-10-12T00:00:00.000Z' },
  // 已結束 → 只能刪除
  { jobId: 'job-done-1', backend: 'web', locality: 'cloud', category: 'test', appId: 'a1', caseId: 'c1', state: 'pass', createdAt: '2026-10-11T00:00:00.000Z' },
];

vi.mock('../api/client.ts', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.startsWith('/tasks')) return { items: TASKS, total: TASKS.length };
    if (path.startsWith('/apps')) return { items: [{ id: 'a1', name: '測試應用', platform: 'web' }] };
    return { items: [] };
  }),
  apiPost: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}));

const { default: TasksPage } = await import('./TasksPage.tsx');

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  localStorage.setItem('playagent.locale', 'zh-Hant');
});

describe('任務列表的批次動作鈕位置', () => {
  test('沒勾選時標題列只有「提交任務」', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByLabelText('選取此列').length).toBe(2));
    const header = container.querySelector('.listpage__header')!;
    expect(header.querySelector('.tasks__submit-btn')).not.toBeNull();
    expect(header.querySelector('.tasks__batch-cancel')).toBeNull();
    expect(header.querySelector('.tasks__batch-delete')).toBeNull();
  });

  test('勾選執行中的任務 → 取消鈕出現在標題列、提交任務之後', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByLabelText('選取此列').length).toBe(2));
    fireEvent.click(screen.getAllByLabelText('選取此列')[0]!); // 執行中那列

    const header = container.querySelector('.listpage__header')!;
    const cancel = header.querySelector('.tasks__batch-cancel');
    expect(cancel).not.toBeNull();
    // 執行中的任務不能刪除
    expect(header.querySelector('.tasks__batch-delete')).toBeNull();
    // 順序:提交任務在前,批次鈕在後(DOM 順序 = 視覺順序,兩者同一個 flex 容器)
    const actions = [...header.querySelectorAll('.tasks__submit-btn, .tasks__batch-cancel')];
    expect(actions[0]!.className).toContain('tasks__submit-btn');
    expect(actions[1]!.className).toContain('tasks__batch-cancel');
    // 不再留在篩選列裡
    expect(container.querySelector('.tasks__filter .tasks__batch-cancel')).toBeNull();
  });

  test('勾選已結束的任務 → 刪除鈕出現在標題列', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByLabelText('選取此列').length).toBe(2));
    fireEvent.click(screen.getAllByLabelText('選取此列')[1]!); // 已結束那列

    const header = container.querySelector('.listpage__header')!;
    expect(header.querySelector('.tasks__batch-delete')).not.toBeNull();
    expect(header.querySelector('.tasks__batch-cancel')).toBeNull();
    expect(container.querySelector('.tasks__filter .tasks__batch-delete')).toBeNull();
  });

  test('兩種都勾選 → 取消與刪除都在標題列,各自顯示自己的筆數', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByLabelText('選取此列').length).toBe(2));
    fireEvent.click(screen.getByLabelText('全選'));

    const header = container.querySelector('.listpage__header')!;
    const cancel = header.querySelector('.tasks__batch-cancel')!;
    const del = header.querySelector('.tasks__batch-delete')!;
    expect(cancel.textContent).toContain('1');
    expect(del.textContent).toContain('1');
  });
});
