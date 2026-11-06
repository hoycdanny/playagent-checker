import { describe, expect, test } from 'vitest';
import { circleSequence, pathSequence } from '../../agent/gestures.mjs';

/**
 * 連續路徑手勢的幾何(agent/gestures.mjs)。
 *
 * 三個驅動(Appium 真機 / adb / Playwright)共用這份幾何,所以同一個測項在三個平台上
 * 語意一致。算錯的話在真機上只會表現成「手勢好像沒反應」,極難查 —— 所以在這裡用數字驗。
 */

const A = { x: 10, y: 10 };
const B = { x: 20, y: 10 };
const C = { x: 30, y: 10 };

describe('pathSequence:按住起點 → 依序經過 → 放開', () => {
  test('單趟:按下第一點之後依序經過其餘各點', () => {
    expect(pathSequence([A, B, C])).toEqual([B, C]);
  });

  test('重複兩趟:第二趟先回到起點再走一遍(不回起點路徑就不是原本那條)', () => {
    expect(pathSequence([A, B, C], 2)).toEqual([B, C, A, B, C]);
  });

  test('不足兩個點 → 空陣列(呼叫端據此拒絕送出)', () => {
    expect(pathSequence([A])).toEqual([]);
    expect(pathSequence([A, { x: Number.NaN, y: 1 }])).toEqual([]);
    expect(pathSequence(null)).toEqual([]);
  });

  test('loops 夾在 1~5', () => {
    expect(pathSequence([A, B], 99)).toHaveLength(9); // 5 趟:5 段 + 4 次回起點
    expect(pathSequence([A, B], 0)).toEqual([B]);
  });
});

describe('circleSequence:繞圈(搖桿畫圓、轉盤)', () => {
  test('一圈 = 圓周起點 + 12 段,而且會回到起點', () => {
    const one = circleSequence(100, 100, 50, 1);
    expect(one).toHaveLength(13);
    expect(one[one.length - 1]).toEqual(one[0]);
  });

  test('起點在圓周左側,手指不會一開始就遮住圓心的搖桿', () => {
    expect(circleSequence(100, 100, 50, 1)[0]).toEqual({ x: 50, y: 100 });
  });

  test('「搖桿轉三圈」= laps 3,一個手勢走完 36 段', () => {
    expect(circleSequence(100, 100, 50, 3)).toHaveLength(37);
  });

  test('方向:螢幕座標 y 向下,角度遞增 = 左→上→右→下,在錶面上是順時鐘', () => {
    // 這個慣例與既有、已在真機驗證過的繞圈走位(kite)相同,不要改。
    const cw = circleSequence(100, 100, 50, 1, { segs: 4 }).map((p) => `${p.x},${p.y}`);
    const ccw = circleSequence(100, 100, 50, 1, { segs: 4, clockwise: false }).map((p) => `${p.x},${p.y}`);
    expect(cw).toEqual(['50,100', '100,50', '150,100', '100,150', '50,100']);
    expect(ccw).toEqual(['50,100', '100,150', '150,100', '100,50', '50,100']);
  });

  test('圈數夾在 1~10;三圈仍在 adb 驅動的 60 點上限內', () => {
    expect(circleSequence(100, 100, 50, 99)).toHaveLength(121);
    expect(circleSequence(0, 0, 10, 3).length).toBeLessThanOrEqual(60);
  });

  test('半徑 0 或座標非數字 → 空陣列(不送出沒有意義的手勢)', () => {
    expect(circleSequence(100, 100, 0, 1)).toEqual([]);
    expect(circleSequence(Number.NaN, 100, 50, 1)).toEqual([]);
  });
});
