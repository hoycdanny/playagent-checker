import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/I18nProvider.tsx';

/**
 * 提交任務表單第 2 區「在哪裡跑」的排版契約。
 *
 * 這一步要決定的事(執行環境 → 機型態 → 機型 / Android 版本)必須排在同一列。
 * 原本會換行有兩個原因,兩個都是結構問題而不是調 CSS 能解決的:
 *   1. 執行環境欄位裡塞了「適用情境 / 限制」兩段長文字,所以得佔兩欄,一列只剩一格。
 *   2. 欄位數會隨執行環境變(真機 3 個、模擬器 4 個),固定三欄時第 4 個必定掉到下一行。
 *
 * jsdom 不做版面計算,量不到實際欄位位置,所以這裡守的是讓那一列成立的結構條件:
 * 欄位數不超過欄數上限、長文字不在欄位裡、而且每欄都是「標題 → 控制項 → 說明」
 * (說明擺控制項前面的話,行數不同的說明會把各欄下拉推到不同高度)。
 */

const APPS = [
  { id: 'a1', name: '老子有錢', platform: 'android' },
  { id: 'a3', name: 'PC 遊戲', platform: 'windows' },
];

vi.mock('../api/client.ts', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.startsWith('/apps')) return { items: APPS };
    return { items: [] };
  }),
  apiPost: vi.fn(async () => ({})),
  apiPut: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
  uploadToS3: vi.fn(async () => {}),
  ApiError: class ApiError extends Error {},
}));

const { default: TasksPage } = await import('./TasksPage.tsx');

/**
 * .tform__grid--row 的 flex-basis 是 200px:一列放四欄需要約 860px,
 * 超過四欄就一定會換行,不管視窗多寬。
 */
const MAX_COLUMNS = 4;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  localStorage.setItem('playagent.locale', 'zh-Hant');
});

/**
 * 開表單並等執行環境依 App 平台落定。
 * 應用清單是非同步載入的,載完才會套用平台預設環境 —— 不等就還停在 web(只有一個欄位)。
 */
async function openForm(appId: string, expectRuntime: string) {
  const { container, getByRole } = render(
    <I18nProvider>
      <MemoryRouter><TasksPage appId={appId} /></MemoryRouter>
    </I18nProvider>,
  );
  fireEvent.click(getByRole('button', { name: '提交任務' }));
  const grid = () => {
    const el = container.querySelector('.tform__grid--row');
    if (!el) throw new Error('找不到「在哪裡跑」的欄位列');
    return el;
  };
  const runtimeSelect = () => grid().querySelector('select') as HTMLSelectElement;
  await waitFor(() => expect(runtimeSelect().value).toBe(expectRuntime));
  const fields = () => [...grid().children].filter((el) => el.classList.contains('tasks__field'));
  const labels = () => fields().map((f) => f.querySelector('.tasks__label')?.textContent ?? '');
  const setRuntime = (id: string) => fireEvent.change(runtimeSelect(), { target: { value: id } });
  return { container, grid, fields, labels, setRuntime };
}

describe('「在哪裡跑」排成一列', () => {
  test('真機:執行環境 / 機型 / 裝置型號 三欄,放得進一列', async () => {
    const { labels, fields } = await openForm('a1', 'devicefarm-android');
    expect(labels()).toEqual(['執行環境', '機型', '裝置型號 / Android 版本']);
    expect(fields().length).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  test('模擬器:多了 Android 版本與螢幕尺寸,仍在一列的上限內', async () => {
    const { labels, setRuntime, fields } = await openForm('a1', 'devicefarm-android');
    setRuntime('emulator-android');
    expect(labels()).toEqual(['執行環境', '最長執行時間', 'Android 版本', '螢幕尺寸']);
    expect(fields().length).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  test('長時真機:多了執行時長,仍在一列的上限內', async () => {
    const { labels, setRuntime, fields } = await openForm('a1', 'devicefarm-android');
    setRuntime('devicefarm-android-long');
    expect(labels()).toContain('執行時長');
    expect(fields().length).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  test('Windows:執行環境 / 最長執行時間 / 畫面解析度', async () => {
    const { labels, fields } = await openForm('a3', 'windows');
    expect(labels()).toEqual(['執行環境', '最長執行時間', '畫面解析度']);
    expect(fields().length).toBeLessThanOrEqual(MAX_COLUMNS);
  });
});

describe('欄位內部順序:標題 → 控制項 → 說明', () => {
  const controlFirst = (field: Element) => {
    const kids = [...field.children];
    expect(kids[0]!.className).toContain('tasks__label');
    // 控制項要緊接在標題後面。說明若插在中間,行數多寡就會決定下拉的高度,
    // 同一列的下拉便對不齊。
    const second = kids[1]!;
    const isControl = second.tagName === 'SELECT' || second.classList.contains('tasks__device-pick');
    expect(isControl, `「${kids[0]!.textContent}」的控制項不在標題後面`).toBe(true);
  };

  test('真機三欄都是這個順序', async () => {
    const { fields } = await openForm('a1', 'devicefarm-android');
    for (const f of fields()) controlFirst(f);
  });

  test('模擬器四欄都是這個順序', async () => {
    const { fields, setRuntime } = await openForm('a1', 'devicefarm-android');
    setRuntime('emulator-android');
    for (const f of fields()) controlFirst(f);
  });

  test('Windows 的最長執行時間與畫面解析度也是', async () => {
    const { fields } = await openForm('a3', 'windows');
    for (const f of fields()) controlFirst(f);
  });
});

describe('每一欄都要有自己的說明', () => {
  /**
   * 同一列裡只有某一欄的控制項底下是空的,看起來像那一欄漏了東西 ——
   * 執行環境原本就是這樣(說明全被移到底下的長文字區),整列因此高低不齊。
   * CSS 另外用 min-height 補齊一兩行的落差,但「完全沒有說明」補不出來。
   */
  const everyFieldHasHint = (fields: Element[]) => {
    for (const f of fields) {
      const hint = f.querySelector('.tasks__field-hint')?.textContent?.trim() ?? '';
      expect(hint.length, `「${f.querySelector('.tasks__label')?.textContent}」底下沒有說明`).toBeGreaterThan(0);
    }
  };

  test('真機', async () => {
    const { fields } = await openForm('a1', 'devicefarm-android');
    everyFieldHasHint(fields());
  });

  test('模擬器', async () => {
    const { fields, setRuntime } = await openForm('a1', 'devicefarm-android');
    setRuntime('emulator-android');
    everyFieldHasHint(fields());
  });

  test('Windows', async () => {
    const { fields } = await openForm('a3', 'windows');
    everyFieldHasHint(fields());
  });
});

describe('執行環境的長文字不在欄位裡', () => {
  test('適用情境與限制放在橫跨整排的說明區,不是執行環境那一欄', async () => {
    const { grid, fields } = await openForm('a1', 'devicefarm-android');
    const detail = grid().querySelector('.tform__runtime-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('適用情境');
    expect(detail!.textContent).toContain('限制');
    // 說明區是欄位列的兄弟節點(CSS 用 flex-basis: 100% 獨占一整列),
    // 不是任何一欄的子孫 —— 塞回欄位裡就會再把那一欄撐寬。
    for (const f of fields()) expect(f.contains(detail!)).toBe(false);
    expect(fields()[0]!.textContent).not.toContain('適用情境');
  });

  test('換執行環境時說明跟著換', async () => {
    const { grid, setRuntime } = await openForm('a1', 'devicefarm-android');
    const detail = () => grid().querySelector('.tform__runtime-detail')!.textContent ?? '';
    expect(detail()).toContain('真實 GMS');
    setRuntime('emulator-android');
    expect(detail()).toContain('沒有 150 分鐘限制');
    expect(detail()).toContain('反模擬器');
  });
});
