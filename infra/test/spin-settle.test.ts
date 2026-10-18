import { describe, expect, test } from 'vitest';
import { createSpinSettle, roiDelta } from '../../agent/spinSettle.mjs';

const GW = 10;
const GH = 10;
/** 全黑網格;patch 把某個矩形塗成指定灰階。 */
const grid = (patches: Array<{ x0: number; y0: number; x1: number; y1: number; v: number }> = []) => {
  const g = new Uint8Array(GW * GH);
  for (const p of patches) {
    for (let y = p.y0; y < p.y1; y++) for (let x = p.x0; x < p.x1; x++) g[y * GW + x] = p.v;
  }
  return g;
};
const TOP = { x: 0, y: 0, w: 1, h: 0.5 };
const BOTTOM = { x: 0, y: 0.5, w: 1, h: 0.5 };

describe('roiDelta', () => {
  test('只看指定區域的平均灰階差', () => {
    const a = grid();
    const b = grid([{ x0: 0, y0: 0, x1: 10, y1: 5, v: 100 }]); // 只有上半變了
    expect(roiDelta(a, b, GW, GH, TOP)).toBe(100);
    expect(roiDelta(a, b, GW, GH, BOTTOM)).toBe(0);
    expect(roiDelta(a, a, GW, GH, TOP)).toBe(0);
  });

  test('區域超出網格會被夾住,不會回 NaN', () => {
    const a = grid();
    const b = grid([{ x0: 0, y0: 0, x1: 10, y1: 10, v: 50 }]);
    expect(roiDelta(a, b, GW, GH, { x: -1, y: -1, w: 5, h: 5 })).toBe(50);
    expect(roiDelta(a, b, GW, GH, { x: 0.99, y: 0.99, w: 0.001, h: 0.001 })).toBe(50);
  });
});

describe('createSpinSettle', () => {
  /** 用假的解碼器:每個分段給一串灰階網格,時間由 startedAt + offsetMs 決定。 */
  const settleFor = (opts: { rois?: Array<{ x: number; y: number; w: number; h: number }> } = {}) => {
    const queue: Uint8Array[][] = [];
    const s = createSpinSettle({
      rois: () => opts.rois ?? [TOP, BOTTOM],
      fps: 10,
      gridW: GW,
      gridH: GH,
      threshold: 2.5,
      decode: async () => {
        const g = queue.shift() ?? [];
        return g.map((gray, i) => ({ gray, offsetMs: i * 100 }));
      },
    });
    s.arm(); // 這些案例測的是停輪判定本身,先進入「等停輪」狀態
    return { s, push: (startedAt: number, g: Uint8Array[]) => { queue.push(g); return s.onSegment({ name: 's', buf: Buffer.from('x'), startedAt }); } };
  };
  const still = grid([{ x0: 0, y0: 0, x1: 10, y1: 10, v: 80 }]);
  const moving = (v: number) => grid([{ x0: 0, y0: 0, x1: 10, y1: 5, v }]); // 只有上半(轉輪)在動

  test('動過之後連續靜止滿門檻 → ok,而且回報真正的靜止長度', async () => {
    const { s, push } = settleFor();
    // 0~1000ms:轉輪在動
    await push(0, [moving(10), moving(200), moving(10), moving(200), moving(10), moving(200), moving(10), moving(200), moving(10), moving(200)]);
    // 1000~3000ms:完全靜止
    await push(1000, Array.from({ length: 10 }, () => still));
    await push(2000, Array.from({ length: 10 }, () => still));
    let now = 0;
    const r = await s.waitSettled({ after: 0, stillMs: 1500, pollMs: 100, timeoutMs: 1000, sleep: async () => { now += 100; }, now: () => now });
    expect(r).toMatchObject({ ok: true, reason: 'still' });
    // 「從動變成靜」那一幀本身也是一次變化,所以最後動作時刻是第二段的第一幀 1000ms
    // (刻意保守:寧可多等一格,也不要把還在變的畫面當成已經停好)。解碼到 2900ms → 安靜 1900ms。
    expect(r.movedAt).toBe(1000);
    expect(r.stillMs).toBe(1900);
  });

  test('還沒安靜滿門檻就不算停(資料還沒到的部分不當成安靜)', async () => {
    const { s, push } = settleFor();
    await push(0, [moving(10), moving(200), moving(10)]);
    await push(300, [still, still, still]); // 只安靜 300ms
    let now = 0;
    const r = await s.waitSettled({ after: 0, stillMs: 2000, timeoutMs: 500, pollMs: 100, sleep: async () => { now += 100; }, now: () => now });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.stillMs).toBeLessThan(2000);
  });

  test('完全沒動過 → no_move(多半是沒按到,不要當成已停輪)', async () => {
    const { s, push } = settleFor();
    await push(0, Array.from({ length: 10 }, () => still));
    let now = 0;
    const r = await s.waitSettled({ after: 0, stillMs: 500, timeoutMs: 300, pollMs: 100, sleep: async () => { now += 100; }, now: () => now });
    expect(r).toMatchObject({ ok: false, reason: 'no_move' });
  });

  test('只盯指定區域:區域外的動畫不算畫面在動', async () => {
    // 只盯下半(數字列);上半的轉輪/吉祥物動畫不該影響判定。
    const { s, push } = settleFor({ rois: [BOTTOM] });
    await push(0, [moving(10), moving(200), moving(10), moving(200)]);
    let now = 0;
    const r = await s.waitSettled({ after: 0, stillMs: 100, timeoutMs: 200, pollMs: 100, sleep: async () => { now += 100; }, now: () => now });
    expect(r.reason).toBe('no_move'); // 下半從頭到尾沒變 → 沒看到動作
  });

  // 全程解碼會把容器 CPU 吃掉(實測每步 15.7 秒 → 30 秒),所以只在等停輪那段才解碼。
  test('沒在等停輪時直接丟掉分段,不呼叫解碼', async () => {
    let decodes = 0;
    const clock = { t: 1000 };
    const s = createSpinSettle({
      rois: () => [TOP],
      gridW: GW,
      gridH: GH,
      graceMs: 4000,
      now: () => clock.t,
      decode: async () => { decodes++; return []; },
    });
    // 預設沒武裝 → 不解碼
    await s.onSegment({ name: 'a', buf: Buffer.from('x'), startedAt: 0 });
    expect(decodes).toBe(0);
    // 等停輪期間 → 解碼
    s.arm();
    await s.onSegment({ name: 'b', buf: Buffer.from('x'), startedAt: 0 });
    expect(decodes).toBe(1);
    // 等完了,但寬限期內的分段還要收(它們才涵蓋剛才那段等待)
    s.disarm();
    clock.t += 3000;
    await s.onSegment({ name: 'c', buf: Buffer.from('x'), startedAt: 0 });
    expect(decodes).toBe(2);
    // 超過寬限期 → 不再解碼
    clock.t += 2000;
    await s.onSegment({ name: 'd', buf: Buffer.from('x'), startedAt: 0 });
    expect(decodes).toBe(2);
  });

  test('解碼失敗不會中斷後續分段', async () => {
    const logs: string[] = [];
    const s = createSpinSettle({
      rois: () => [TOP],
      gridW: GW,
      gridH: GH,
      decode: async () => { throw new Error('ffmpeg boom'); },
      log: (m: string) => logs.push(m),
    });
    s.arm();
    await s.onSegment({ name: 'bad', buf: Buffer.from('x'), startedAt: 0 });
    expect(s.stats.fails).toBe(1);
    expect(logs[0]).toContain('解碼失敗');
  });
});
