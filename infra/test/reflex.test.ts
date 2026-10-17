import { describe, expect, test } from 'vitest';
import {
  compactStructure,
  emptyStructure,
  identifyPage,
  recordMiss,
  recordSelfOp,
  recordTransition,
  sanitizeOp,
  upsertPage,
  type GraphStructure,
} from '../../agent/memoryGraph.mjs';
import {
  chooseReflex,
  chooseSpinOp,
  cmdFromOp,
  createReflexState,
  opFromCmd,
  opTrust,
  pageSelfOps,
  parseSpinCount,
  rtpSummary,
  selfOpKey,
} from '../../agent/reflex.mjs';
import { edgeKey } from '../../agent/operatorMemory.mjs';
import { parseEditOp } from '../lambda/api/memoryHints.js';

/** 1024-bit hex hash:用不同 nibble 填滿,彼此距離很遠。 */
const H = (c: string) => c.repeat(256);
const tap = (x: number, y: number, target: string) => ({ action: 'tap', x, y, target });

/**
 * 模擬使用者的例子:第一次啟動 → PLAY → 大廳 → 選遊戲 → 拉霸機(發現 SPIN)。
 * 每段轉場都由「上一步的操作」造成;同一個 SPIN 在拉霸機畫面上按了好幾次。
 */
function learnedGame(runs = 2): GraphStructure {
  const s = emptyStructure('slot-app');
  for (let r = 0; r < runs; r++) {
    const start = upsertPage(s, { name: '啟動畫面', pHash: H('0') }).pageId;
    const lobby = upsertPage(s, { name: '機台大廳', pHash: H('f') }).pageId;
    const slot = upsertPage(s, { name: 'Desert Legend 轉軸', pHash: H('3') }).pageId;
    const op = (c: ReturnType<typeof tap>) => opFromCmd(c, 1000, 500, { version: 'art-1' });
    recordTransition(s, start, lobby, { action: 'tap', target: 'PLAY', op: op(tap(500, 450, 'PLAY')) });
    recordTransition(s, lobby, slot, { action: 'tap', target: 'Desert Legend', op: op(tap(800, 250, 'Desert Legend')) });
    recordSelfOp(s, slot, { action: 'tap', target: 'SPIN', op: op(tap(900, 440, 'SPIN')) });
    recordSelfOp(s, slot, { action: 'tap', target: 'SPIN', op: op(tap(900, 440, 'SPIN')) });
  }
  return s;
}
const idOf = (s: GraphStructure, name: string) => Object.values(s.pages).find((p) => p.name === name)!.id;

describe('operation recording (memoryGraph)', () => {
  test('opFromCmd / cmdFromOp round-trip in relative coordinates', () => {
    const op = opFromCmd({ action: 'swipe', x: 100, y: 200, x2: 300, y2: 400, durationMs: 250 }, 1000, 500)!;
    expect(op).toMatchObject({ a: 'swipe', x: 0.1, y: 0.4, x2: 0.3, y2: 0.8, ms: 250, ar: 2 });
    // 換到不同解析度(同比例)重播,落點跟著縮放。
    expect(cmdFromOp(op, 2000, 1000)).toMatchObject({ action: 'swipe', x: 200, y: 400, x2: 600, y2: 800, durationMs: 250 });
    expect(opFromCmd({ action: 'wait' }, 1000, 500)).toBeNull();
    expect(opFromCmd({ action: 'tap' }, 1000, 500)).toBeNull();
  });

  test('sanitizeOp rejects bad shapes', () => {
    expect(sanitizeOp({ a: 'tap', x: 1.2, y: 0.5 })).toBeNull();
    expect(sanitizeOp({ a: 'launch' })).toBeNull();
    expect(sanitizeOp({ a: 'move', dir: 'sideways' })).toBeNull();
    expect(sanitizeOp({ a: 'back' })).toEqual({ a: 'back' });
    expect(sanitizeOp({ a: 'type', text: '${password}' })).toEqual({ a: 'type', text: '${password}' });
  });

  test('transitions keep the latest op; same-screen actions become selfOps; misses count', () => {
    const s = learnedGame();
    const lobby = idOf(s, '機台大廳');
    const slot = idOf(s, 'Desert Legend 轉軸');
    const e = s.edges.find((x) => x.fromPageId === lobby)!;
    expect(e.hitCount).toBe(2);
    expect(e.op).toMatchObject({ a: 'tap', x: 0.8, y: 0.5, v: 'art-1' });
    const spin = s.pages[slot]!.selfOps![0]!;
    expect(spin).toMatchObject({ kind: 'tap', target: 'SPIN', hitCount: 4, missCount: 0 });
    recordMiss(s, slot, { action: 'tap', target: 'SPIN' });
    expect(s.pages[slot]!.selfOps![0]!.missCount).toBe(1);
  });

  test('compactStructure keeps ops and selfOps (runner reloads every run)', () => {
    const s = compactStructure(JSON.parse(JSON.stringify(learnedGame())));
    expect(s.edges.every((e) => e.op)).toBe(true);
    expect(s.pages[idOf(s, 'Desert Legend 轉軸')]!.selfOps?.[0]?.op).toBeTruthy();
  });

  test('identifyPage needs a close and unambiguous match', () => {
    const s = learnedGame(1);
    expect(identifyPage(s, H('f'))?.pageId).toBe(idOf(s, '機台大廳'));
    expect(identifyPage(s, H('7'))).toBeNull(); // 誰都不像
    expect(identifyPage(s, null)).toBeNull();
  });
});

describe('chooseReflex (navigation only, trusted ops)', () => {
  const state = () => createReflexState();

  test('replays the learned path: start → PLAY, lobby → the usual game', () => {
    const s = learnedGame(2);
    const a = chooseReflex({ struct: s, edits: null, pageId: idOf(s, '啟動畫面'), task: '進入遊戲並分析 RTP', state: state() })!;
    expect(a).toMatchObject({ target: 'PLAY', reason: 'dominant', trust: 'auto' });
    expect(cmdFromOp(a.op, 1000, 500)).toMatchObject({ action: 'tap', x: 500, y: 450 });
    const b = chooseReflex({ struct: s, edits: null, pageId: idOf(s, '機台大廳'), task: '進入遊戲並分析 RTP', state: state() })!;
    expect(b.target).toBe('Desert Legend');
  });

  test('one success is not enough; a tester confirmation is', () => {
    const s = learnedGame(1);
    const lobby = idOf(s, '機台大廳');
    expect(chooseReflex({ struct: s, edits: null, pageId: lobby, task: 'x', state: state() })).toBeNull();
    const key = edgeKey(s.edges.find((e) => e.fromPageId === lobby)!);
    const d = chooseReflex({ struct: s, edits: { opEdits: { [key]: { verified: true } } }, pageId: lobby, task: 'x', state: state() });
    expect(d).toMatchObject({ trust: 'verified', reason: 'verified' });
    // 停用 → 不走;修正過的座標優先。
    expect(chooseReflex({ struct: s, edits: { opEdits: { [key]: { disabled: true } } }, pageId: lobby, task: 'x', state: state() })).toBeNull();
    const fixed = chooseReflex({ struct: s, edits: { opEdits: { [key]: { verified: true, op: { a: 'tap', x: 0.25, y: 0.5 } } } }, pageId: lobby, task: 'x', state: state() })!;
    expect(cmdFromOp(fixed.op, 1000, 500)).toMatchObject({ x: 250, y: 250 });
  });

  test('task naming another game → hand to AI instead of the usual path', () => {
    const s = learnedGame(2);
    const lobby = idOf(s, '機台大廳');
    const fortune = upsertPage(s, { name: 'Fortune Rabbit 轉軸', pHash: H('9') }).pageId;
    recordTransition(s, lobby, fortune, { action: 'tap', target: 'Fortune Rabbit' });
    expect(chooseReflex({ struct: s, edits: null, pageId: lobby, task: '進入 Fortune Rabbit 測試免費遊戲', state: state() })).toBeNull();
    // 點名的遊戲本身也走過且可信 → 直接走它。
    const op = opFromCmd(tap(200, 250, 'Fortune Rabbit'), 1000, 500);
    recordTransition(s, lobby, fortune, { action: 'tap', target: 'Fortune Rabbit', op });
    const d = chooseReflex({ struct: s, edits: null, pageId: lobby, task: '進入 Fortune Rabbit 測試免費遊戲', state: state() })!;
    expect(d).toMatchObject({ target: 'Fortune Rabbit', reason: 'named' });
  });

  test('stops at the screen the task is about; never auto-buys; never spins as navigation', () => {
    const s = learnedGame(2);
    const slot = idOf(s, 'Desert Legend 轉軸');
    const lobby = idOf(s, '機台大廳');
    const goal = '在 Desert Legend 轉軸 畫面轉 100 局';
    // 大廳:目標點名了這款遊戲 → 直接走過去。
    expect(chooseReflex({ struct: s, edits: null, pageId: lobby, task: goal, state: state() })).toMatchObject({ target: 'Desert Legend', reason: 'named' });
    // 到了目標畫面:就算有可信的「回大廳」也不走,交給 AI / SPIN 迴圈。
    for (let k = 0; k < 2; k++) recordTransition(s, slot, lobby, { action: 'tap', target: 'HOME', op: opFromCmd(tap(40, 30, 'HOME'), 1000, 500) });
    expect(chooseReflex({ struct: s, edits: null, pageId: slot, task: goal, state: state() })).toBeNull();
    expect(chooseReflex({ struct: s, edits: null, pageId: slot, task: '回大廳', state: state() })).toMatchObject({ target: 'HOME' });
    const promo = upsertPage(s, { name: '首儲促銷彈窗', pHash: H('c') }).pageId;
    for (let k = 0; k < 3; k++) recordTransition(s, promo, lobby, { action: 'tap', target: 'USD 0.99', op: opFromCmd(tap(500, 300, 'USD 0.99'), 1000, 500) });
    expect(chooseReflex({ struct: s, edits: null, pageId: promo, task: 'x', state: state() })).toBeNull();
    const result = upsertPage(s, { name: '結算彈窗', pHash: H('a') }).pageId;
    for (let k = 0; k < 3; k++) recordTransition(s, slot, result, { action: 'tap', target: 'SPIN', op: opFromCmd(tap(900, 440, 'SPIN'), 1000, 500) });
    expect(chooseReflex({ struct: s, edits: null, pageId: slot, task: 'x', state: state() })).toBeNull();
  });

  test('popups are closed from memory even when not the dominant habit', () => {
    const s = learnedGame(2);
    const popup = upsertPage(s, { name: '每日登入彈窗', pHash: H('5') }).pageId;
    const lobby = idOf(s, '機台大廳');
    for (let k = 0; k < 2; k++) recordTransition(s, popup, lobby, { action: 'tap', target: 'X', op: opFromCmd(tap(950, 30, 'X'), 1000, 500) });
    expect(chooseReflex({ struct: s, edits: null, pageId: popup, task: 'x', state: state() })).toMatchObject({ target: 'X', reason: 'popup' });
  });

  test('a failed op is demoted for the run; a failed cross-version op disables all cross-version ops', () => {
    const s = learnedGame(2);
    const start = idOf(s, '啟動畫面');
    const st = state();
    const first = chooseReflex({ struct: s, edits: null, pageId: start, task: 'x', version: 'art-2', state: st })!;
    expect(first.cross).toBe(true);
    st.demoted.add(first.key);
    expect(chooseReflex({ struct: s, edits: null, pageId: start, task: 'x', version: 'art-2', state: st })).toBeNull();
    const st2 = state();
    st2.crossVersionFailed = true;
    expect(chooseReflex({ struct: s, edits: null, pageId: idOf(s, '機台大廳'), task: 'x', version: 'art-2', state: st2 })).toBeNull();
    expect(chooseReflex({ struct: s, edits: null, pageId: idOf(s, '機台大廳'), task: 'x', version: 'art-1', state: st2 })).not.toBeNull();
  });

  test('tester-drawn routes win, and no A → B → A loops', () => {
    const s = learnedGame(2);
    const lobby = idOf(s, '機台大廳');
    const other = upsertPage(s, { name: 'Golden HoYeah 轉軸', pHash: H('b') }).pageId;
    recordTransition(s, lobby, other, { action: 'tap', target: 'Golden HoYeah', op: opFromCmd(tap(300, 250, 'Golden HoYeah'), 1000, 500) });
    recordTransition(s, lobby, other, { action: 'tap', target: 'Golden HoYeah', op: opFromCmd(tap(300, 250, 'Golden HoYeah'), 1000, 500) });
    const routes = [{ id: 'route-abcdef', name: '主線', enabled: true, steps: [{ id: 's-aaaa', pageId: lobby, action: '' }, { id: 's-bbbb', pageId: other, action: '' }], branches: [] }];
    expect(chooseReflex({ struct: s, edits: { routes }, pageId: lobby, task: 'x', state: state() })).toMatchObject({ target: 'Golden HoYeah', reason: 'route' });
    const st = state();
    st.recent = [other];
    expect(chooseReflex({ struct: s, edits: { routes }, pageId: lobby, task: 'x', state: st })?.target).not.toBe('Golden HoYeah');
  });
});

describe('SPIN loop and RTP', () => {
  test('parseSpinCount understands ranges and counts', () => {
    expect(parseSpinCount('請幫我分析 1-100 局的 RTP')).toBe(100);
    expect(parseSpinCount('RTP: spin 500 rounds')).toBe(500);
    expect(parseSpinCount('分析 RTP')).toBe(0);
  });

  // job-mvcei8tq:這款遊戲按 SPIN 會在「結果畫面」與「轉軸畫面」之間來回,所以 SPIN 被記成
  // 一條「出邊」而不是 selfOp。只看 selfOps 的話 55 次點 SPIN 只有 3 次走到迴圈。
  test('chooseSpinOp also uses a SPIN recorded as a page transition, not only selfOps', () => {
    const s = emptyStructure('slot-app');
    const result = upsertPage(s, { name: '拉霸結果畫面', pHash: H('3') }).pageId;
    const reels = upsertPage(s, { name: '拉霸轉軸畫面', pHash: H('7') }).pageId;
    const op = (c: ReturnType<typeof tap>) => opFromCmd(c, 1000, 500, { version: 'art-1' });
    // 按 SPIN 從結果畫面到轉軸畫面:成功一次、沒失敗過。
    recordTransition(s, result, reels, { action: 'tap', target: 'SPIN', op: op(tap(900, 440, 'SPIN')) });
    expect(s.pages[result]!.selfOps ?? []).toHaveLength(0);

    const pick = chooseSpinOp({ struct: s, edits: null, pageId: result, state: createReflexState() })!;
    expect(pick).toMatchObject({ target: 'SPIN', op: { a: 'tap', x: 0.9, y: 0.88 } });
    expect(pick.key).toBe(edgeKey({ fromPageId: result, toPageId: reels, trigger: { kind: 'tap', target: 'SPIN' } }));

    // 這一局沒轉動被降級後就不再用它(runner 連續 2 次沒轉動會這樣做)。
    const demoted = createReflexState();
    demoted.demoted.add(pick.key);
    expect(chooseSpinOp({ struct: s, edits: null, pageId: result, state: demoted })).toBeNull();
    // 測試人員停用也一樣。
    expect(chooseSpinOp({ struct: s, edits: { opEdits: { [pick.key]: { disabled: true } } }, pageId: result, state: createReflexState() })).toBeNull();
  });

  test('chooseSpinOp picks the trusted SPIN, not AutoSpin / free spin', () => {
    const s = learnedGame(1);
    const slot = idOf(s, 'Desert Legend 轉軸');
    recordSelfOp(s, slot, { action: 'tap', target: 'AUTO SPIN', op: opFromCmd(tap(800, 440, 'AUTO SPIN'), 1000, 500) });
    recordSelfOp(s, slot, { action: 'tap', target: 'AUTO SPIN', op: opFromCmd(tap(800, 440, 'AUTO SPIN'), 1000, 500) });
    const pick = chooseSpinOp({ struct: s, edits: null, pageId: slot, state: createReflexState() })!;
    expect(pick.target).toBe('SPIN');
    expect(pick.key).toBe(selfOpKey(slot, { kind: 'tap', target: 'SPIN' }));
    expect(chooseSpinOp({ struct: s, edits: { opEdits: { [pick.key]: { disabled: true } } }, pageId: slot, state: createReflexState() })).toBeNull();
  });

  test('a SPIN the tester added on the memory map (opEdits only) is used by the SPIN loop', () => {
    const s = learnedGame(1);
    const slot = idOf(s, 'Desert Legend 轉軸');
    s.pages[slot]!.selfOps = [];
    const key = `${slot}>${slot}>tap>開始旋轉`;
    const edits = { opEdits: { [key]: { op: { a: 'tap', x: 0.9, y: 0.85 }, verified: true } } };
    expect(pageSelfOps(s.pages[slot], slot, edits.opEdits).map((x) => x.target)).toEqual(['開始旋轉']);
    const pick = chooseSpinOp({ struct: s, edits, pageId: slot, state: createReflexState() })!;
    expect(pick).toMatchObject({ key, target: '開始旋轉', trust: 'verified', op: { a: 'tap', x: 0.9, y: 0.85 } });
    // 只有確認 / 停用旗標、沒有操作內容的不算新增
    expect(pageSelfOps(s.pages[slot], slot, { [`${slot}>${slot}>tap>X`]: { disabled: true } })).toHaveLength(0);
  });

  test('rtpSummary: totals, hit rate, 95% CI and the balance cross-check', () => {
    const rounds = [
      { bet: 100, win: 0 }, { bet: 100, win: 250 }, { bet: 100, win: 0 }, { bet: 100, win: 50 },
    ];
    const r = rtpSummary(rounds, { startBalance: 10_000, endBalance: 9_900 })!;
    expect(r).toMatchObject({ rounds: 4, totalBet: 400, totalWin: 300, rtpPercent: 75, hitRatePercent: 50 });
    expect(r.ci95[0]).toBeLessThan(75);
    expect(r.ci95[1]).toBeGreaterThan(75);
    // 餘額差法:9,900 − 10,000 + 400 = 300 → 75%。
    expect(r.balanceCheck).toEqual({ startBalance: 10_000, endBalance: 9_900, rtpPercent: 75 });
    expect(rtpSummary([])).toBeNull();
  });

  test('opTrust: verified > auto (≥2 hits, 0 misses) > learning', () => {
    expect(opTrust({ hitCount: 5, missCount: 0 })).toBe('auto');
    expect(opTrust({ hitCount: 5, missCount: 1 })).toBe('learning');
    expect(opTrust({ hitCount: 1, missCount: 0 })).toBe('learning');
    expect(opTrust({ hitCount: 0, missCount: 3 }, { verified: true })).toBe('verified');
    expect(opTrust({ hitCount: 9 }, { disabled: true })).toBe('disabled');
  });
});

describe('memory edit API: setOp / clearOp', () => {
  const key = 'page_aaaaaaaa>page_bbbbbbbb>tap>PLAY';
  test('validates key, op shape and action match', () => {
    expect(parseEditOp({ op: 'setOp', key, verified: true })).toEqual({ op: 'setOp', key, patch: { verified: true } });
    expect(parseEditOp({ op: 'setOp', key, opData: { a: 'tap', x: 0.5, y: 0.25 } })).toMatchObject({ patch: { op: { a: 'tap', x: 0.5, y: 0.25 } } });
    expect(() => parseEditOp({ op: 'setOp', key, opData: { a: 'swipe', x: 0.1, y: 0.1, x2: 0.2, y2: 0.2 } })).toThrow(/不一致/);
    expect(() => parseEditOp({ op: 'setOp', key, opData: { a: 'tap', x: 2, y: 0 } })).toThrow();
    expect(() => parseEditOp({ op: 'setOp', key: 'bad', verified: true })).toThrow();
    expect(() => parseEditOp({ op: 'setOp', key })).toThrow();
    expect(parseEditOp({ op: 'clearOp', key })).toEqual({ op: 'clearOp', key });
  });
});
