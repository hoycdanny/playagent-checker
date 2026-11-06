import { describe, expect, test } from 'vitest';
import { frameIsBlank, gridMoved, gridMovedAt } from '../../agent/frameSignal.mjs';

/**
 * 畫面變化訊號(agent/frameSignal.mjs)。
 *
 * 這三個函式是死循環護欄與卡死判定的輸入,判錯的後果是「重啟 App 把已輸入的帳密清掉」
 * 或「正常流程被判成當機中止」—— 判準演進與實測案例見 agent/loopGuard.mjs 的註解。
 */

const SIZE = 48;
const frame = (fill: number) => new Uint8Array(SIZE * SIZE).fill(fill);
const at = (gx: number, gy: number) => ({ x: (gx + 0.5) / SIZE, y: (gy + 0.5) / SIZE });
const put = (g: Uint8Array, gx: number, gy: number, v: number) => {
  g[gy * SIZE + gx] = v;
  return g;
};
/** App 視窗被遮黑、但系統的狀態列/導覽列照樣亮著(真機上就是這樣)。 */
const withSystemBars = (statusRows: number, navRows: number, bar = 200) => {
  const g = frame(0);
  for (let gy = 0; gy < statusRows; gy++) for (let gx = 0; gx < SIZE; gx++) g[gy * SIZE + gx] = bar;
  for (let gy = SIZE - navRows; gy < SIZE; gy++) for (let gx = 0; gx < SIZE; gx++) g[gy * SIZE + gx] = bar;
  return g;
};

describe('gridMoved:整張圖有沒有任何一處變了', () => {
  test('一模一樣 → 沒變', () => {
    expect(gridMoved(frame(120), frame(120))).toBe(false);
  });

  test('單格的壓縮雜訊(差 4)不算變化', () => {
    expect(gridMoved(frame(120), put(frame(120), 10, 10, 124))).toBe(false);
  });

  test('只有一格劇變也不算(游標閃爍)', () => {
    expect(gridMoved(frame(120), put(frame(120), 10, 10, 255))).toBe(false);
  });

  test('兩格變化 = 輸入框多一個字 → 算有變化(pHash 看不到的那種)', () => {
    const typed = put(put(frame(120), 10, 20, 200), 11, 20, 210);
    expect(gridMoved(frame(120), typed)).toBe(true);
  });

  test('拿不到格子回 null,不是 false(「量不到」不可以當成「沒反應」)', () => {
    expect(gridMoved(null, frame(120))).toBeNull();
    expect(gridMoved(frame(120), new Uint8Array(10))).toBeNull();
  });
});

describe('gridMovedAt:只看落點附近有沒有反應', () => {
  const base = frame(120);
  const typed = put(put(frame(120), 10, 20, 200), 11, 20, 210);

  test('點在變化的位置上 → 有反應', () => {
    expect(gridMovedAt(base, typed, at(10, 20))).toBe(true);
  });

  test('變化在畫面另一端(動畫在別處照跑)→ 落點沒反應', () => {
    // 實測 job-muv712gs:彈窗不再接受任何輸入,但動畫照跑。只看整張圖會永遠得到「有動」。
    expect(gridMovedAt(base, typed, at(40, 40))).toBe(false);
  });

  test('整個畫面換掉 → 落點附近當然也變了', () => {
    const big = frame(120);
    for (let i = 0; i < big.length; i += 3) big[i] = 240;
    expect(gridMovedAt(base, big, at(40, 40))).toBe(true);
  });

  test('落點在角落 / 超出畫面都不會爆掉', () => {
    expect(gridMovedAt(base, typed, at(0, 0))).toBe(false);
    expect(gridMovedAt(base, typed, { x: 1.5, y: -0.2 })).toBe(false);
  });

  test('沒有落點 → null(退回看整張圖)', () => {
    expect(gridMovedAt(base, typed, null)).toBeNull();
  });
});

describe('frameIsBlank:App 畫面被系統遮黑(Android 15 螢幕分享保護)', () => {
  test('App 視窗全黑、狀態列與導覽列亮著 → 仍然判定為遮黑', () => {
    // 1080x2400、狀態列 77px、導覽列 132px ≈ 48 格裡的 2 + 3 列(整張圖 10.4% 是亮的)。
    // 舊判準要求「整張圖 98% 以上是暗的」,在這個情形下永遠不成立,整套遮黑處理等於沒啟用。
    expect(frameIsBlank(withSystemBars(2, 3))).toBe(true);
    expect(frameIsBlank(withSystemBars(3, 4))).toBe(true);
  });

  test('整張全黑也算', () => {
    expect(frameIsBlank(frame(0))).toBe(true);
  });

  test('一般畫面與暗場景都不算遮黑', () => {
    expect(frameIsBlank(frame(120))).toBe(false);
    expect(frameIsBlank(frame(40))).toBe(false);
  });

  test('中央有內容(黑底畫面上有按鈕)→ 不是遮黑', () => {
    const g = frame(0);
    for (let gy = 20; gy < 28; gy++) for (let gx = 16; gx < 32; gx++) g[gy * SIZE + gx] = 180;
    expect(frameIsBlank(g)).toBe(false);
  });

  test('格子尺寸不符 / 沒有格子 → null', () => {
    expect(frameIsBlank(new Uint8Array(100))).toBeNull();
    expect(frameIsBlank(null)).toBeNull();
  });
});
