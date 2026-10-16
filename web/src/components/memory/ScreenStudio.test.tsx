import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiPost = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('../../api/client.ts', () => ({
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiGet: vi.fn(async () => ({ items: [] })),
  apiPut: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}));

import { ScreenStudio, type StudioPage } from './ScreenStudio.tsx';
import type { HintsApi } from './MemoryEditor.tsx';
import type { OpEdit, ScriptEdge } from './memoryScript.ts';

const pages: Record<string, StudioPage> = {
  home: { id: 'home', name: '首頁', visitCount: 3, pHash: 'f'.repeat(64) },
  slot: {
    id: 'slot', name: '老虎機', visitCount: 5, pHash: '0'.repeat(64),
    selfOps: [{ kind: 'tap', target: 'SPIN', hitCount: 1, missCount: 0, op: { a: 'tap', x: 0.9, y: 0.9 } }],
  },
};
const edges: ScriptEdge[] = [
  { fromPageId: 'home', toPageId: 'slot', trigger: { kind: 'tap', target: 'PLAY' }, hitCount: 3, missCount: 0, op: { a: 'tap', x: 0.5, y: 0.8 } },
];
const hintsApi = { hints: [], reload: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() } as unknown as HintsApi;

function renderStudio(opEdits: Record<string, OpEdit> = {}) {
  const onEdited = vi.fn();
  render(
    <ScreenStudio
      lang="zh"
      appId="app-1"
      pageId="slot"
      pages={pages}
      edges={edges}
      rootPageId="home"
      opEdits={opEdits}
      shots={{}}
      hintsApi={hintsApi}
      onEdited={onEdited}
      onOpenPage={vi.fn()}
      onClose={vi.fn()}
      onBackToMap={vi.fn()}
    />,
  );
  return { onEdited };
}

describe('ScreenStudio', () => {
  beforeEach(() => apiPost.mockClear());

  test('shows the script from the start and the actions on this screen', () => {
    renderStudio();
    expect(screen.getByRole('heading', { name: '老虎機' })).toBeTruthy();
    const path = screen.getByText('在「首頁」').closest('li')!;
    expect(within(path).getByText('點擊「PLAY」')).toBeTruthy();
    expect(screen.getByText(/到達「老虎機」/)).toBeTruthy();
    // 同一畫面的 SPIN:成功 1 次 → 學習中,可以按確認
    expect(screen.getByText('點擊「SPIN」')).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 1 個操作:點擊「SPIN」/ })).toBeTruthy();
  });

  test('confirm sends setOp verified for that action', async () => {
    const { onEdited } = renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![1]).toEqual({ app: 'app-1', op: 'setOp', key: 'slot>slot>tap>SPIN', verified: true });
    await waitFor(() => expect(onEdited).toHaveBeenCalled());
  });

  test('editing a position in the form saves the op (and confirms it)', async () => {
    renderStudio();
    fireEvent.click(screen.getByText('點擊「SPIN」'));
    const x = screen.getByLabelText('X %');
    fireEvent.change(x, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存修改' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![1]).toEqual({
      app: 'app-1', op: 'setOp', key: 'slot>slot>tap>SPIN', opData: { a: 'tap', x: 0.8, y: 0.9 }, verified: true,
    });
  });

  test('adding a same-screen action that needs no position', async () => {
    renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '+ 新增操作' }));
    fireEvent.change(screen.getByLabelText('動作'), { target: { value: 'back' } });
    fireEvent.change(screen.getByLabelText('名稱(按鈕上的字)'), { target: { value: '關閉 > 彈窗' } });
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![1]).toEqual({ app: 'app-1', op: 'setOp', key: 'slot>slot>back>關閉 彈窗', opData: { a: 'back' }, verified: true });
  });

  test('adding an action to another screen creates the path first', async () => {
    renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '+ 新增操作' }));
    fireEvent.change(screen.getByLabelText('動作'), { target: { value: 'back' } });
    fireEvent.change(screen.getByLabelText('名稱(按鈕上的字)'), { target: { value: '返回' } });
    fireEvent.change(screen.getByLabelText('做完之後'), { target: { value: 'home' } });
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost.mock.calls[0]![1]).toEqual({ app: 'app-1', op: 'addEdge', fromPageId: 'slot', toPageId: 'home', kind: 'back', target: '返回' });
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ op: 'setOp', key: 'slot>home>back>返回', verified: true });
  });

  test('Appium code tab renders the generated script', () => {
    renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: 'Appium 程式碼' }));
    expect(screen.getByText(/import \{ remote \} from 'webdriverio'/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '下載 .mjs' })).toBeTruthy();
  });
});
