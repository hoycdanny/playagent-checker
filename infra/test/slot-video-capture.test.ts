import { describe, expect, test } from 'vitest';
// @ts-expect-error — agent 純 ESM 模組不另外發布型別。
const { createSlotVideoCapture } = await import('../../agent/slotVideoCapture.mjs');
// @ts-expect-error — agent 純 ESM 模組不另外發布型別。
const { createSlotBoardTracker } = await import('../../agent/slotBoardTracker.mjs');

const gray = (v: number) => new Uint8Array(16).fill(v);
const profile = { machineId: 'fu-xing-gao-zhao-3', appVersion: '4.6.8', roi: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, fps: 10, gridW: 4, gridH: 4 };
const tracker = () => createSlotBoardTracker({ enterDelta: 10, exitDelta: 2, enterFrames: 2, stableFrames: 3, minBusyMs: 100, refractoryMs: 100 });

/** 依 segment buffer 名稱回測試幀。 */
function captureWith(sequence: Record<string, Array<{ value: number; offsetMs: number }>>, failExtract = false) {
  const objects = new Map<string, { body: unknown; type: string }>();
  let now = 1_000_000;
  const cap = createSlotVideoCapture({
    prefix: 'tenants/t/jobs/j', profile, tracker: tracker(), now: () => now++,
    put: async (key: string, body: unknown, type: string) => { objects.set(key, { body, type }); },
    decode: async (buf: Buffer) => (sequence[buf.toString()] ?? []).map((f) => ({ gray: gray(f.value), offsetMs: f.offsetMs })),
    extract: async (buf: Buffer, offsetMs: number, opts: { format: string }) => {
      if (failExtract) throw new Error('extract broke');
      return Buffer.from(`${buf.toString()}:${offsetMs}:${opts.format}`);
    },
  });
  cap.setActive(true, 'test', 0);
  return { cap, objects };
}

describe('createSlotVideoCapture', () => {
  test('busy→stable 保存 board/context 與可追溯 manifest', async () => {
    const { cap, objects } = captureWith({ a: [
      { value: 0, offsetMs: 0 }, { value: 20, offsetMs: 100 }, { value: 40, offsetMs: 200 },
      { value: 41, offsetMs: 300 }, { value: 41, offsetMs: 400 }, { value: 41, offsetMs: 500 },
    ] });
    await cap.onSegment({ name: 's1000000000000.mp4', buf: Buffer.from('a'), startedAt: 10_000 });
    await cap.stop();
    expect(cap.summary()).toMatchObject({ detectedSpins: 1, capturedBoards: 1, captureFailures: 0, segmentCount: 1 });
    expect(objects.get('tenants/t/jobs/j/spins/000001/board.webp')?.type).toBe('image/webp');
    expect(objects.get('tenants/t/jobs/j/spins/000001/context.jpg')?.type).toBe('image/jpeg');
    const manifest = JSON.parse(String(objects.get('tenants/t/jobs/j/spins/manifest.json')?.body));
    expect(manifest.state).toBe('complete');
    expect(manifest.spins[0]).toMatchObject({ sequence: 1, sourceSegment: 's1000000000000.mp4', sourceOffsetMs: 500, status: 'captured' });
  });

  test('跨影片段保留 tracker 狀態並記錄時間缺口', async () => {
    const { cap } = captureWith({
      a: [{ value: 0, offsetMs: 0 }, { value: 20, offsetMs: 100 }, { value: 40, offsetMs: 200 }],
      b: [{ value: 41, offsetMs: 0 }, { value: 41, offsetMs: 100 }, { value: 41, offsetMs: 200 }],
    });
    await cap.onSegment({ name: 's1000000000000.mp4', buf: Buffer.from('a'), startedAt: 10_000 });
    await cap.onSegment({ name: 's1000000001000.mp4', buf: Buffer.from('b'), startedAt: 11_000 });
    await cap.stop();
    expect(cap.summary().capturedBoards).toBe(1);
    expect(cap.summary().gapCount).toBe(1);
    expect(cap.manifest.gaps[0].ms).toBe(700);
  });

  test('抽幀失敗不丟 manifest，明確標 capture_failed', async () => {
    const { cap } = captureWith({ a: [
      { value: 0, offsetMs: 0 }, { value: 20, offsetMs: 100 }, { value: 40, offsetMs: 200 },
      { value: 40, offsetMs: 300 }, { value: 40, offsetMs: 400 }, { value: 40, offsetMs: 500 },
    ] }, true);
    await cap.onSegment({ name: 's1000000000000.mp4', buf: Buffer.from('a'), startedAt: 10_000 });
    await cap.stop();
    expect(cap.summary()).toMatchObject({ detectedSpins: 1, capturedBoards: 0, captureFailures: 1, analysisFailures: 1 });
    expect(cap.manifest.spins[0]).toMatchObject({ status: 'capture_failed', error: 'extract broke' });
  });

  test('追蹤未啟用時頁面翻動不會被誤算成 Spin', async () => {
    const { cap } = captureWith({ a: [
      { value: 0, offsetMs: 0 }, { value: 100, offsetMs: 100 }, { value: 200, offsetMs: 200 },
      { value: 200, offsetMs: 300 }, { value: 200, offsetMs: 400 }, { value: 200, offsetMs: 500 },
    ] });
    cap.setActive(false, 'paytable', 0);
    await cap.onSegment({ name: 's1000000000000.mp4', buf: Buffer.from('a'), startedAt: 10_000 });
    await cap.stop();
    expect(cap.summary().detectedSpins).toBe(0);
  });

  test('永久靜止不產生假盤面', async () => {
    const { cap } = captureWith({ a: Array.from({ length: 20 }, (_, i) => ({ value: 100, offsetMs: i * 100 })) });
    await cap.onSegment({ name: 's1000000000000.mp4', buf: Buffer.from('a'), startedAt: 10_000 });
    await cap.stop();
    expect(cap.summary().detectedSpins).toBe(0);
  });
});
