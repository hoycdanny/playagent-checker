import { describe, expect, test } from 'vitest';
// @ts-expect-error — 純 JS 模組(agent 端),無型別宣告
const { isAutoSpinWait, watchAutoSpin, watchNote, createAnalyzer } = await import('../../agent/spinWatch.mjs');

/**
 * AutoSpin 看守模式:runner 每秒截圖做灰階格子比對,只在彈窗 / 停住 / 心跳時叫醒 AI。
 * 用假的 grab / toGray / 時鐘測判斷邏輯(不需要 ImageMagick)。
 */
const N = 48 * 48;
const REEL = (i: number) => { const x = i % 48, y = Math.floor(i / 48); return x >= 8 && x < 40 && y >= 12 && y < 36; };

/** 背景固定 100、轉軸區每張亂變;overlay=true 時背景整片變暗(彈窗)。 */
function frame(k: number, { overlay = false, spinning = true } = {}) {
  const g = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (REEL(i)) g[i] = spinning ? (i * 37 + k * 91) % 256 : 50;
    else g[i] = overlay ? 20 : 100;
  }
  return g;
}

/** 假時鐘 + 假截圖序列:grab 回 frame 編號字串,toGray 轉成對應格子。 */
function rig(seq: (k: number) => Uint8Array | 'fail') {
  let t = 0;
  let k = 0;
  const grays = new Map<string, Uint8Array>();
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    grab: async () => {
      k += 1;
      const g = seq(k);
      if (g === 'fail') throw new Error('appium gone');
      const id = `f${k}`;
      grays.set(id, g);
      return id;
    },
    toGray: async (b64: string) => grays.get(b64) ?? null,
  };
}

describe('isAutoSpinWait', () => {
  test.each([
    [{ action: 'wait', screen: 'Slot Reels (AutoSpin)', thinking: '' }, true],
    [{ action: 'wait', screen: 'Slot', thinking: 'SPIN 鈕顯示剩餘 120,繼續等待' }, true],
    [{ action: 'wait', screen: 'Free Spins', thinking: '' }, true],
    [{ action: 'wait', screen: 'Loading', thinking: '載入中' }, false],
    [{ action: 'tap', screen: 'Slot (AutoSpin)', thinking: '' }, false],
    [{ action: 'wait', screen: 'Slot (AutoSpin)', thinking: '', override: 'loading_wait' }, false],
  ])('%j → %s', (cmd, want) => {
    expect(isAutoSpinWait(cmd)).toBe(want);
  });
});

describe('watchAutoSpin', () => {
  test('只有轉軸在轉 → 不觸發,到上限回 heartbeat', async () => {
    const r = rig((k) => frame(k));
    const res = await watchAutoSpin({ ...r, maxMs: 10_000, intervalMs: 1000 });
    expect(res.reason).toBe('heartbeat');
    expect(res.frames).toBe(10);
    expect(res.frame).toBe('f10');
  });

  test('彈窗蓋住背景 → overlay,回傳事件當下那張', async () => {
    const r = rig((k) => frame(k, { overlay: k >= 6 }));
    const res = await watchAutoSpin({ ...r, maxMs: 30_000 });
    expect(res.reason).toBe('overlay');
    expect(res.frame).toBe('f6');
    expect(res.detail.changedFraction).toBeGreaterThanOrEqual(0.3);
  });

  test('只閃 1 張就自動關閉的彈窗也抓得到', async () => {
    const r = rig((k) => frame(k, { overlay: k === 4 }));
    const res = await watchAutoSpin({ ...r, maxMs: 30_000 });
    expect(res.reason).toBe('overlay');
    expect(res.frame).toBe('f4');
  });

  test('畫面完全不動 ≥4 秒 → still', async () => {
    const r = rig((k) => frame(k, { spinning: k < 4 }));
    const res = await watchAutoSpin({ ...r, maxMs: 30_000 });
    expect(res.reason).toBe('still');
    expect(res.ms).toBeLessThan(12_000);
  });

  test('種子基準:一開始就跳出的彈窗不會被吸收成「平常的樣子」', async () => {
    // 種子 = AI 剛看過的正常畫面;之後每張都是彈窗(背景暗、轉軸照轉)。
    const r = rig((k) => frame(k, { overlay: true }));
    const seedGray = frame(0);
    const toGray = async (b64: string) => (b64 === 'seed' ? seedGray : r.toGray(b64));
    const res = await watchAutoSpin({ ...r, toGray, seed: 'seed', maxMs: 30_000 });
    expect(res.reason).toBe('overlay');
  });

  test('連續 3 次截圖失敗 → error', async () => {
    const r = rig((k) => (k >= 3 ? 'fail' : frame(k)));
    const res = await watchAutoSpin({ ...r, maxMs: 30_000 });
    expect(res.reason).toBe('error');
    expect(res.frame).toBe('f2');
    expect(res.detail.error).toContain('appium gone');
  });

  test('單次截圖失敗會重試,不中斷', async () => {
    const r = rig((k) => (k === 2 ? 'fail' : frame(k)));
    const res = await watchAutoSpin({ ...r, maxMs: 6_000 });
    expect(res.reason).toBe('heartbeat');
  });
});

describe('createAnalyzer / watchNote', () => {
  test('整個畫面都在動(calm 格子太少)→ 不判斷覆蓋', () => {
    const a = createAnalyzer();
    let ev = null;
    for (let k = 0; k < 10; k++) {
      const g = new Uint8Array(N);
      for (let i = 0; i < N; i++) g[i] = (i * 13 + k * 77) % 256;
      ev = a.push(g, k * 1000) ?? ev;
    }
    expect(ev).toBeNull();
    expect(a.calmCells).toBeLessThan(40);
  });

  test('watchNote 依原因給不同說明', () => {
    expect(watchNote({ reason: 'overlay', ms: 5000, frames: 5 })).toContain('非拉霸收入');
    expect(watchNote({ reason: 'still', ms: 8000, frames: 8 })).toContain('沒動');
    expect(watchNote({ reason: 'heartbeat', ms: 30000, frames: 30 })).toContain('定時檢查');
    expect(watchNote(null)).toBe('');
  });
});
