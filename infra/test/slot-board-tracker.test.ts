import { describe, expect, test } from 'vitest';
// @ts-expect-error — 純 JS 模組(agent 端),無型別宣告
const { DEFAULT_BOARD_TRACKER, createSlotBoardTracker, roiGrid, frameSharpness } = await import('../../agent/slotBoardTracker.mjs');

/** 建立每格同值的簡單盤面，方便精確控制平均相鄰差異。 */
const gray = (value: number) => new Uint8Array(16).fill(value);
const sample = (value: number, t: number, frame: unknown = `f${t}`) => ({ gray: gray(value), t, frame });

function tracker(overrides = {}) {
  return createSlotBoardTracker({
    enterDelta: 10,
    exitDelta: 2,
    enterFrames: 2,
    stableFrames: 3,
    minBusyMs: 100,
    refractoryMs: 200,
    ...overrides,
  });
}

describe('createSlotBoardTracker', () => {
  test('正常 busy → stable，依序送出開始與穩定盤面', () => {
    const a = tracker();
    expect(a.push(sample(0, 0))).toBeNull();
    expect(a.push(sample(20, 20))).toBeNull();
    const start = a.push(sample(40, 40));
    expect(start).toMatchObject({ type: 'spin_start', sequence: 1, startedAt: 20, detectedAt: 40 });
    expect(a.state).toBe('SPINNING');

    expect(a.push(sample(41, 80))).toBeNull();
    expect(a.state).toBe('SETTLING');
    expect(a.push(sample(42, 100))).toBeNull();
    const stable = a.push(sample(42, 140));
    expect(stable).toMatchObject({
      type: 'stable_board', sequence: 1, startedAt: 20, capturedAt: 140,
      busyMs: 120, stableMs: 60, frame: 'f140',
    });
    expect(stable.confidence).toBeGreaterThan(0);
    expect(stable.metrics.bestDelta).toBe(0);
    expect(a.state).toBe('STABLE');
  });

  test('低幅雜訊不會開始旋轉', () => {
    const a = tracker();
    const events = [0, 1, 0, 2, 1, 0].map((v, i) => a.push(sample(v, i * 20)));
    expect(events.every((event) => event === null)).toBe(true);
    expect(a.state).toBe('WAITING');
    expect(a.sequence).toBe(0);
  });

  test('只有一張的短暫閃爍不符合 enterFrames', () => {
    const a = tracker();
    expect(a.push(sample(0, 0))).toBeNull();
    expect(a.push(sample(30, 20))).toBeNull();
    expect(a.push(sample(30, 40))).toBeNull();
    expect(a.push(sample(31, 60))).toBeNull();
    expect(a.state).toBe('WAITING');
  });

  test('穩定候選中選相鄰差異最低者，保留原始 frame payload', () => {
    const a = tracker({ minBusyMs: 0 });
    const bestPayload = { id: 'best', pixels: [1, 2, 3] };
    a.push(sample(0, 0));
    a.push(sample(20, 10));
    a.push(sample(40, 20));
    a.push(sample(42, 30, { id: 'first' }));
    a.push(sample(42, 40, bestPayload));
    const event = a.push(sample(43, 50, { id: 'last' }));
    expect(event.type).toBe('stable_board');
    expect(event.frame).toBe(bestPayload);
    expect(event.capturedAt).toBe(40);
    expect(event.metrics.bestDelta).toBe(0);
  });

  test('永久靜止不重複送出，refractory 期間的忙碌也不開始', () => {
    const a = tracker({ minBusyMs: 0, refractoryMs: 100 });
    a.push(sample(0, 0));
    a.push(sample(20, 10));
    a.push(sample(40, 20));
    a.push(sample(40, 30));
    a.push(sample(40, 40));
    expect(a.push(sample(40, 50))?.type).toBe('stable_board');
    expect(a.push(sample(40, 60))).toBeNull();
    expect(a.push(sample(40, 70))).toBeNull();
    expect(a.push(sample(80, 80))).toBeNull();
    expect(a.push(sample(120, 90))).toBeNull();
    expect(a.state).toBe('STABLE');
    expect(a.sequence).toBe(1);
  });

  test('兩次完整旋轉送出兩個遞增 sequence', () => {
    const a = tracker({ minBusyMs: 0, refractoryMs: 20 });
    const events: any[] = [];
    for (const s of [
      sample(0, 0), sample(20, 10), sample(40, 20), sample(40, 30), sample(40, 40), sample(40, 50),
      sample(60, 80), sample(80, 90), sample(80, 100), sample(80, 110), sample(80, 120),
    ]) {
      const event = a.push(s);
      if (event) events.push(event);
    }
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ['spin_start', 1], ['stable_board', 1], ['spin_start', 2], ['stable_board', 2],
    ]);
    expect(a.sequence).toBe(2);
  });

  test('reset 清除狀態、序號與固定長度基準', () => {
    const a = tracker();
    a.push(sample(0, 0));
    a.push(sample(20, 10));
    a.push(sample(40, 20));
    expect(a.sequence).toBe(1);
    a.reset();
    expect(a.state).toBe('WAITING');
    expect(a.sequence).toBe(0);
    expect(a.push({ gray: new Uint8Array(4), t: 0, frame: 'new-size' })).toBeNull();
  });

  test('匯出凍結的預設設定', () => {
    expect(Object.isFrozen(DEFAULT_BOARD_TRACKER)).toBe(true);
    expect(DEFAULT_BOARD_TRACKER.enterDelta).toBeGreaterThan(DEFAULT_BOARD_TRACKER.exitDelta);
  });
});

describe('roiGrid', () => {
  test('依標準化 ROI 擷取並縮成固定網格', () => {
    const source = new Uint8Array([
      0, 1, 2, 3,
      10, 11, 12, 13,
      20, 21, 22, 23,
      30, 31, 32, 33,
    ]);
    expect(Array.from(roiGrid(source, 4, 4, { x: 0.5, y: 0, w: 0.5, h: 1 }, 2, 2))).toEqual([12, 13, 32, 33]);
    expect(roiGrid(source, 4, 4, { x: 0.8, y: 0, w: 0.3, h: 1 })).toBeNull();
  });
});

describe('frameSharpness', () => {
  test('局部梯度越強，清晰度分數越高', () => {
    const flat = new Uint8Array(9).fill(100);
    const edged = new Uint8Array([
      0, 255, 0,
      255, 0, 255,
      0, 255, 0,
    ]);
    expect(frameSharpness(flat, 3, 3)).toBe(0);
    expect(frameSharpness(edged, 3, 3)).toBeGreaterThan(200);
    expect(frameSharpness(edged, 2, 3)).toBe(0);
  });
});
