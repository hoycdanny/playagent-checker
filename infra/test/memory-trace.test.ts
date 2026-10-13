import { describe, expect, test } from 'vitest';
// @ts-expect-error agent mjs 沒有型別宣告(runner 端 ESM)
const graph = await import('../../agent/memoryGraph.mjs');
// @ts-expect-error agent mjs 沒有型別宣告(runner 端 ESM)
const trace = await import('../../agent/memoryTrace.mjs');

/**
 * 情境:第一次測試建立記憶(登入 → 大廳 → 機台 → 轉軸),第二次測試照同樣流程走。
 * 第二次每一步都應該看得出命中記憶,而且「記憶預測」應驗 —— 這就是記憶正常運作的間接證據。
 */
const h = (n: number) => n.toString(16).padStart(256, '0'); // 每個畫面不同的假 pHash

function firstRun() {
  const s = graph.emptyStructure('slot');
  const visit = (name: string, hash: number, module?: string) => graph.upsertPage(s, { name, pHash: h(hash), ...(module ? { module } : {}) }).pageId as string;
  const login = visit('登入畫面', 1, 'login');
  const lobby = visit('大廳', 2, 'lobby');
  graph.recordTransition(s, login, lobby, { action: 'tap', target: 'PLAY' });
  const machine = visit('機台選擇', 3, 'machine_select');
  graph.recordTransition(s, lobby, machine, { action: 'tap', target: 'Slots' });
  const reels = visit('轉軸畫面', 4, 'reels');
  graph.recordTransition(s, machine, reels, { action: 'tap', target: 'XING ZHAO 3' });
  // 第二輪又走一次,讓路徑有 2 次成功。
  graph.recordTransition(s, login, lobby, { action: 'tap', target: 'PLAY' });
  return { s, ids: { login, lobby, machine, reels } };
}

describe('memoryTrace — 每一步看得出有沒有命中記憶', () => {
  test('第二次測試:認得畫面、照已驗證路徑走、記憶預測應驗', () => {
    const { s, ids } = firstRun();
    const knowledge = '# APP KNOWLEDGE\n...\n\n## 畫面導覽圖(先前測試累積)\n已知畫面(4):登入畫面、大廳…';
    const hints = [{ id: 'h1', text: '大廳先關掉每日簽到彈窗', screen: '大廳' }];
    const mt = trace.createMemoryTrace({ struct: s, hints, edits: null, knowledge, knowledgeLimit: 9000 });

    expect(mt.startupLog()).toContain('已知畫面 4、已驗證路徑 3(已注入 AI)');
    expect(mt.startupLog()).toContain('測試人員教學 1 條');

    // #0 登入畫面:AI 點 PLAY(正是記憶中的已驗證路徑)
    const r0 = mt.onStep({ pageId: ids.login, screenName: '登入畫面', action: 'tap', target: 'PLAY' });
    expect(r0.baseline).toMatchObject({ pages: 4, verifiedPaths: 3, navInjected: true });
    expect(r0.screen).toBe('known');
    expect(r0.page).toMatchObject({ name: '登入畫面', verifiedExits: 1 });
    expect(r0.plan).toMatchObject({ kind: 'tap', target: 'PLAY', to: '大廳', hit: 2, miss: 0 });
    expect(r0.arrival).toBeUndefined();

    // #1 大廳:上一步 tap PLAY 記憶說會到大廳 → 應驗;這步提示詞帶了大廳的教學
    const r1 = mt.onStep({
      pageId: ids.lobby, screenName: '大廳', prevPageId: ids.login, navAction: 'tap', prevTarget: 'PLAY',
      screenChanged: true, injectedHints: hints, action: 'tap', target: 'Slots',
    });
    expect(r1.arrival).toMatchObject({ from: '登入畫面', expected: ['大廳'], result: 'followed', hit: 2 });
    expect(r1.hints).toEqual([{ id: 'h1', text: '大廳先關掉每日簽到彈窗', matched: true }]);
    expect(r1.plan).toMatchObject({ target: 'Slots', to: '機台選擇' });
    expect(mt.formatLog(1, r1)).toContain('記憶預測「登入畫面」tap PLAY → 「大廳」:應驗 ✓');

    // #2 遊戲改版:點 Slots 卻跳出活動彈窗(記憶裡沒有)→ 與記憶不符 + 新畫面
    const ev = graph.upsertPage(s, { name: '限時活動彈窗', pHash: h(9), module: 'popup' }).pageId;
    const r2 = mt.onStep({ pageId: ev, screenName: '限時活動彈窗', prevPageId: ids.lobby, navAction: 'tap', prevTarget: 'Slots', screenChanged: true, action: 'tap', target: 'X' });
    expect(r2.screen).toBe('new');
    expect(r2.arrival).toMatchObject({ result: 'diverged', expected: ['機台選擇'] });
    expect(r2.plan).toBeUndefined();

    // #3 再回到同一個活動彈窗:這次是「本次稍早見過」,不算命中舊記憶
    const r3 = mt.onStep({ pageId: ev, screenName: '限時活動彈窗', prevPageId: ev, navAction: 'tap', prevTarget: 'X', screenChanged: false, action: 'tap', target: 'X' });
    expect(r3.screen).toBe('learned');

    // #4 機台選擇點 XING ZHAO 3 但畫面沒反應 → 記憶路徑這次沒反應
    const r4 = mt.onStep({ pageId: ids.machine, screenName: '機台選擇', prevPageId: ids.lobby, navAction: 'tap', prevTarget: 'Slots', screenChanged: true, action: 'tap', target: 'XING ZHAO 3' });
    expect(r4.arrival?.result).toBe('followed');
    const r5 = mt.onStep({ pageId: ids.machine, screenName: '機台選擇', prevPageId: ids.machine, navAction: 'tap', prevTarget: 'XING ZHAO 3', screenChanged: false, action: 'wait' });
    expect(r5.arrival).toMatchObject({ result: 'no_effect', expected: ['轉軸畫面'] });

    const sum = mt.summary();
    expect(sum).toMatchObject({
      steps: 6, namedSteps: 6, knownScreenSteps: 4, learnedScreenSteps: 1, newScreens: 1,
      hintReminderSteps: 1, hintsMatchedScreen: 1, distinctHintsUsed: 1,
      memoryGuidedActions: 3,
      predictions: { total: 4, followed: 2, diverged: 1, noEffect: 1 },
    });
    expect(mt.summaryLog()).toContain('記憶預測 4 次,應驗 2(50%)');
  });

  test('本次途中才學到的路徑不算命中舊記憶(基準是測試開始前的記憶)', () => {
    const s = graph.emptyStructure('x');
    const mt = trace.createMemoryTrace({ struct: s, knowledge: '' });
    expect(mt.startupLog()).toContain('導覽圖 空白(第一次測試這個 App');
    const a = graph.upsertPage(s, { name: '首頁', pHash: h(1) }).pageId;
    const r0 = mt.onStep({ pageId: a, screenName: '首頁', action: 'tap', target: 'Go' });
    expect(r0.screen).toBe('new');
    const b = graph.upsertPage(s, { name: '設定', pHash: h(2) }).pageId;
    graph.recordTransition(s, a, b, { action: 'tap', target: 'Go' }); // 本次才學到
    const r1 = mt.onStep({ pageId: b, screenName: '設定', prevPageId: a, navAction: 'tap', prevTarget: 'Go', screenChanged: true });
    expect(r1.screen).toBe('new');
    expect(r1.arrival).toBeUndefined();
    expect(mt.summary().predictions.total).toBe(0);
  });

  test('導覽圖摘要被背景知識截掉時,如實標示「未注入」', () => {
    const { s } = firstRun();
    const knowledge = `${'x'.repeat(5000)}\n## 畫面導覽圖(先前測試累積)\n…`;
    const mt = trace.createMemoryTrace({ struct: s, knowledge, knowledgeLimit: 4000 });
    expect(mt.baseline).toMatchObject({ navInjected: false, navTruncated: true });
    expect(mt.startupLog()).toContain('未注入:背景知識過長被截掉');
  });

  test('測試人員手畫的路徑也算記憶;runner 改寫的動作不算 AI 照記憶走', () => {
    const { s, ids } = firstRun();
    const edits = { addedEdges: [{ fromPageId: ids.reels, toPageId: ids.lobby, trigger: { kind: 'back', label: 'back' } }] };
    const mt = trace.createMemoryTrace({ struct: s, edits, knowledge: '## 畫面導覽圖' });
    const r = mt.onStep({ pageId: ids.reels, screenName: '轉軸畫面', action: 'back' });
    expect(r.plan).toMatchObject({ kind: 'back', to: '大廳', manual: true });
    const overridden = mt.onStep({ pageId: ids.login, screenName: '登入畫面', action: 'tap', target: 'PLAY', override: 'stuck_escape' });
    expect(overridden.plan).toBeUndefined();
  });

  test('路線位置會標出來', () => {
    const { s, ids } = firstRun();
    const edits = { routes: [{ id: 'r', name: '主線', steps: [{ id: 'a', pageId: ids.login }, { id: 'b', pageId: ids.lobby }], branches: [] }] };
    const mt = trace.createMemoryTrace({ struct: s, edits, knowledge: '' });
    const r = mt.onStep({ pageId: ids.lobby, screenName: '大廳', prevPageId: ids.lobby, navAction: 'wait', screenChanged: false });
    expect(r.route).toEqual([{ name: '主線', step: 2, total: 2 }]);
  });
});
