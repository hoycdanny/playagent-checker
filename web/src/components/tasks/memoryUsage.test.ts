import { describe, expect, test } from 'vitest';
import { memoryChips, memoryVerdict, summarizeMemory, type StepMemory } from './memoryUsage.ts';

const baseline = { pages: 4, verifiedPaths: 3, hints: 1, routes: 0, navInjected: true };

describe('執行軌跡的記憶標籤', () => {
  test('命中記憶的一步:已知畫面 + 預測應驗 + 照已驗證路徑 + 教學', () => {
    const m: StepMemory = {
      screen: 'known', page: { name: '大廳', priorVisits: 5 },
      arrival: { from: '登入畫面', kind: 'tap', target: 'PLAY', expected: ['大廳'], result: 'followed', hit: 2, miss: 0 },
      plan: { kind: 'tap', target: 'Slots', to: '機台選擇', hit: 1, miss: 0 },
      hints: [{ text: '先關簽到彈窗', matched: true }],
    };
    const chips = memoryChips(m, 'zh');
    expect(chips.map((c) => c.text)).toEqual([
      '🧠 已知畫面', '🧠 記憶預測應驗', '🧭 照已驗證路徑:點擊 Slots → 機台選擇', '📌 套用教學 1 條',
    ]);
    expect(chips[0]!.tip).toContain('先前到訪 5 次');
    expect(chips[1]!.tip).toBe('記憶說:在「登入畫面」點擊 PLAY 會到「大廳」(先前 成功 2 / 失敗 0)');
    expect(chips.every((c) => c.tone === 'hit')).toBe(true);
  });

  test('與記憶不符、新畫面要清楚標出', () => {
    const chips = memoryChips({ screen: 'new', arrival: { from: '大廳', kind: 'tap', target: 'Slots', expected: ['機台選擇'], result: 'diverged' } }, 'zh');
    expect(chips.map((c) => [c.text, c.tone])).toEqual([['✨ 新畫面', 'new'], ['⚠ 與記憶不符', 'warn']]);
  });

  test('舊任務沒有記憶資料時不顯示', () => {
    expect(memoryChips(undefined, 'zh')).toEqual([]);
    expect(summarizeMemory([{}, {}])).toBeNull();
  });
});

describe('整場記憶使用與結論', () => {
  const steps = [
    { memory: { baseline, screen: 'known', plan: { kind: 'tap', target: 'PLAY', to: '大廳' } } },
    { memory: { screen: 'known', arrival: { result: 'followed' }, hints: [{ matched: true }] } },
    { memory: { screen: 'known', arrival: { result: 'followed' } } },
    { memory: { screen: 'new', arrival: { result: 'diverged' } } },
    { memory: { screen: 'known', arrival: { result: 'followed' } } },
  ];

  test('統計已知畫面、預測應驗、照記憶操作', () => {
    const u = summarizeMemory(steps)!;
    expect(u).toMatchObject({ baseline, namedSteps: 5, knownSteps: 4, newScreens: 1, predictions: 4, followed: 3, diverged: 1, guided: 1, hintSteps: 1 });
    expect(memoryVerdict(u, 'zh')).toMatchObject({ tone: 'hit', text: expect.stringContaining('記憶運作正常') });
  });

  test('第一次測試、導覽圖沒給 AI、記憶過時,各有明確結論', () => {
    expect(memoryVerdict(summarizeMemory([{ memory: { baseline: { ...baseline, pages: 0 }, screen: 'new' } }])!, 'zh').text).toContain('第一次測試');
    expect(memoryVerdict(summarizeMemory([{ memory: { baseline: { ...baseline, navInjected: false }, screen: 'known' } }])!, 'zh').tone).toBe('warn');
    const drift = [0, 1, 2, 3].map(() => ({ memory: { screen: 'known', arrival: { result: 'diverged' } } }));
    expect(memoryVerdict(summarizeMemory([{ memory: { baseline } }, ...drift])!, 'zh').text).toContain('畫面或流程可能改版');
  });
});
