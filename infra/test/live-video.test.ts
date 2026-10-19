import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { completedSegments, createLiveVideo, recordSize, segTime } from '../../agent/liveVideo.mjs';

const SEG_A = 's1700000000000.mp4';
const SEG_B = 's1700000000002.mp4';

/** 假裝置:mkdir 回 started、ls 回指定的段落清單(最新那段會被當成還在寫而略過)。 */
function fakeClient(opts: { lsFails?: boolean; segments?: string[] } = {}) {
  const shell = vi.fn(async (cmd: string) => {
    if (/mkdir/.test(cmd)) return 'started';
    if (/^ls /.test(cmd)) {
      if (opts.lsFails) throw new Error('socket hang up');
      return `${(opts.segments ?? [SEG_A, SEG_B]).join('\n')}\n`;
    }
    return 'stopped';
  });
  return { shell, pullFile: vi.fn(async () => Buffer.from('mp4').toString('base64')) };
}

/** 從 t0 往後每 2 秒一段,共 n 段(檔名就是裝置毫秒時間)。 */
const segsFrom = (t0: number, n: number) => Array.from({ length: n }, (_, i) => `s${t0 + i * 2000}.mp4`);

describe('recordSize / completedSegments', () => {
  test('依螢幕比例算出寬 540、高取偶數的尺寸', () => {
    expect(recordSize(1080, 1920)).toBe('540x960');
    expect(recordSize(3088, 1440)).toBe('540x252');
  });

  test('最新那段還在寫入,不送', () => {
    expect(completedSegments(`${SEG_A} ${SEG_B}`)).toEqual([SEG_A]);
    expect(completedSegments('')).toEqual([]);
    expect(completedSegments('不是分段的檔名.txt')).toEqual([]);
  });

  test('segTime 讀檔名裡的裝置時間;認不出來回 0(當成很舊,不會誤判成很新)', () => {
    expect(segTime(SEG_A)).toBe(1700000000000);
    expect(segTime('garbage.mp4')).toBe(0);
    expect(segTime(undefined)).toBe(0);
  });
});

describe('createLiveVideo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // job-mvd8vsfb 實測:onSegment 回 undefined → 上傳迴圈每秒丟
  // 「Cannot read properties of undefined (reading 'catch')」,整場測試的即時影片都沒了。
  test('消費端忘了回 Promise 也不能把上傳迴圈打掛', async () => {
    const client = fakeClient();
    const put = vi.fn(async () => undefined);
    const logs: string[] = [];
    const seen: string[] = [];
    const lv = createLiveVideo({
      client,
      put,
      prefix: 'jobs/j1',
      size: '540x960',
      // 刻意回 undefined(不是 Promise)
      onSegment: ((seg: { name: string }) => { seen.push(seg.name); }) as never,
      log: (m: string) => logs.push(m),
    });
    await lv.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen).toEqual([SEG_A]);
    expect(put).toHaveBeenCalledWith('jobs/j1/live/' + SEG_A, expect.any(Buffer), 'video/mp4');
    expect(lv.uploaded).toBe(1);
    expect(lv.dead).toBe(false);
    expect(logs.some((m) => /連續失敗/.test(m))).toBe(false);
    // 送出去的段落要從裝置刪掉(不刪會一直堆積,把裝置空間與 CPU 吃光)
    expect(client.shell.mock.calls.some(([c]) => /rm -f .*s1700000000000\.mp4/.test(c))).toBe(true);
  });

  test('onSegment 丟錯只記 log,不影響上傳', async () => {
    const client = fakeClient();
    const logs: string[] = [];
    const lv = createLiveVideo({
      client,
      put: vi.fn(async () => undefined),
      prefix: 'jobs/j1',
      size: '540x960',
      onSegment: async () => { throw new Error('decode boom'); },
      log: (m: string) => logs.push(m),
    });
    await lv.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(lv.uploaded).toBe(1);
    expect(lv.dead).toBe(false);
    expect(logs.some((m) => /證據分析失敗/.test(m))).toBe(true);
  });

  // 壞掉卻一直每秒重試,會把 Appium 連線(一次只跑一條指令)佔住 —— 實測每步 15.7s → 63.8s。
  test('連續失敗到上限就停用自己,並收掉裝置端的錄影迴圈', async () => {
    const client = fakeClient({ lsFails: true });
    const logs: string[] = [];
    const lv = createLiveVideo({
      client,
      put: vi.fn(async () => undefined),
      prefix: 'jobs/j1',
      size: '540x960',
      maxFailures: 3,
      log: (m: string) => logs.push(m),
    });
    await lv.start();
    expect(lv.healthy()).toBe(false); // 還沒上傳成功過

    await vi.advanceTimersByTimeAsync(3000);
    expect(lv.dead).toBe(true);
    expect(lv.healthy()).toBe(false);
    expect(logs.some((m) => /停用即時影片/.test(m))).toBe(true);
    expect(client.shell.mock.calls.some(([c]) => /pkill -f screenrecord/.test(c))).toBe(true);

    // 停用之後不再打裝置(計時器要真的被清掉)
    const callsAfter = client.shell.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.shell.mock.calls.length).toBe(callsAfter);
  });

  // 證據模式原則上不丟段,但積壓到落後太久時,停輪判定拿到的畫面已經沒有意義。
  // job-mvdyyr1j 實測:落後從 5s 長到 87s,每局都被判「盤面沒有轉動」。
  test('證據模式:沒落後就一段都不丟', async () => {
    const now = Date.now();
    const client = fakeClient({ segments: segsFrom(now - 6000, 4) }); // 最新那段還在寫 → 送 3 段
    const logs: string[] = [];
    const lv = createLiveVideo({
      client,
      put: vi.fn(async () => undefined),
      prefix: 'jobs/j1',
      size: '540x960',
      preserveBacklog: true,
      maxBacklog: 1,
      staleMs: 20_000,
      log: (m: string) => logs.push(m),
    });
    await lv.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(lv.uploaded).toBe(3);
    expect(lv.gapStats).toEqual({ dropped: 0, gaps: 0 });
    expect(logs.some((m) => /丟掉最舊/.test(m))).toBe(false);
  });

  test('證據模式:落後超過上限就丟舊段追上,並把缺口記下來', async () => {
    const now = Date.now();
    // 最新「已錄完」的那段是 40 秒前的 → 落後遠超過 staleMs
    const client = fakeClient({ segments: segsFrom(now - 60_000, 11) });
    const logs: string[] = [];
    const lv = createLiveVideo({
      client,
      put: vi.fn(async () => undefined),
      prefix: 'jobs/j1',
      size: '540x960',
      preserveBacklog: true,
      maxBacklog: 2,
      staleMs: 20_000,
      log: (m: string) => logs.push(m),
    });
    await lv.start();
    await vi.advanceTimersByTimeAsync(1000);

    // 10 段已錄完,只留最新 2 段
    expect(lv.uploaded).toBe(2);
    expect(lv.gapStats).toEqual({ dropped: 8, gaps: 1 });
    expect(logs.some((m) => /丟掉最舊的 8 段/.test(m))).toBe(true);
    // 丟掉的段落也要從裝置刪乾淨
    expect(client.shell.mock.calls.some(([c]) => /rm -f .*s\d{13}\.mp4/.test(c))).toBe(true);
  });

  test('啟動指令沒回 started 就當啟動失敗', async () => {
    const client = fakeClient();
    client.shell.mockImplementation(async () => 'sh: screenrecord: not found');
    const lv = createLiveVideo({
      client,
      put: vi.fn(async () => undefined),
      prefix: 'jobs/j1',
      size: '540x960',
    });
    await expect(lv.start()).rejects.toThrow(/啟動失敗/);
  });
});
