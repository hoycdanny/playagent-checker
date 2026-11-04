import { describe, expect, test } from 'vitest';
// runner 模組是 .mjs、沒有型別宣告(與 emulatorCoordTransform.test.ts 同一個情況)。
// @ts-ignore
import { parseRxBytes, rxRateBps, createDownloadProbe } from '../../agent/downloadProbe.mjs';

/**
 * 「裝置是不是正在下載」的探測器。
 *
 * 這個訊號存在的理由:載入畫面上「遊戲在下載 1.36 GB」與「遊戲卡死了」長得一模一樣,
 * 而兩者的處置完全相反(前者要繼續等、不要重啟;後者要重啟)。判斷錯的代價是
 * 20 分鐘的機器時間加上上百次模型呼叫,或是卡死的任務永遠不被救回。
 */

// 真實格式(前兩行是標頭,沒有 `名稱: 數字` 的形狀)。
const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500000000  123456    0    0    0     0          0         0  500000000  123456    0    0    0     0       0          0
  eth0: 98765432    54321    0    0    0     0          0         0    123456    4321    0    0    0     0       0          0
 wlan0:  1000000     1234    0    0    0     0          0         0     20000     321    0    0    0     0       0          0
`;

describe('parseRxBytes', () => {
  test('把所有非迴圈介面的接收位元組加起來', () => {
    expect(parseRxBytes(PROC_NET_DEV)).toBe(98_765_432 + 1_000_000);
  });

  test('一定要排除 lo —— 否則我們自己的截圖流量會被當成遊戲在下載', () => {
    // runner 的截圖是走 adb 過來的,在容器裡就是迴圈介面的流量:每 5 秒一張 1.8 MB
    // 的 PNG 等於 360 KB/s,足以超過「正在下載」的門檻。
    // 算進去的話訊號會完全反過來,而症狀是「卡死的任務永遠不會被重啟」,極難查。
    const n = parseRxBytes(PROC_NET_DEV);
    expect(n).not.toBeNull();
    expect(n! < 500_000_000).toBe(true);
  });

  test('只有 lo 時視為量不到(回 null,不是 0)', () => {
    // 0 會被當成「確定沒在下載」,但實際上是「這台機器沒有對外介面可量」。
    // 兩者的處置不一樣,所以不能混。
    const only = `Inter-|   Receive
 face |bytes
    lo: 123    1    0    0    0     0          0         0  123    1    0    0    0     0       0          0
`;
    expect(parseRxBytes(only)).toBeNull();
  });

  test('認不出來的輸入回 null', () => {
    for (const bad of ['', '   ', 'cat: /proc/net/dev: No such file or directory', undefined, null]) {
      expect(parseRxBytes(bad as string), String(bad)).toBeNull();
    }
  });

  test('數字緊貼冒號也要讀得到(位元組大的時候沒有空格)', () => {
    expect(parseRxBytes(' eth0:12345 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0')).toBe(12345);
  });
});

describe('rxRateBps', () => {
  test('一般情況:位元組差 / 時間差', () => {
    expect(rxRateBps({ at: 1000, bytes: 0 }, { at: 3000, bytes: 2_400_000 })).toBe(1_200_000);
  });

  test('沒有基準(第一次取樣)回 null', () => {
    expect(rxRateBps(null, { at: 1000, bytes: 1 })).toBeNull();
  });

  test('位元組變少 = 計數器被重置(App 重啟/介面重建),差值沒有意義', () => {
    expect(rxRateBps({ at: 1000, bytes: 9_000 }, { at: 2000, bytes: 10 })).toBeNull();
  });

  test('時間沒有前進回 null,不是 Infinity', () => {
    expect(rxRateBps({ at: 1000, bytes: 0 }, { at: 1000, bytes: 100 })).toBeNull();
    expect(rxRateBps({ at: 2000, bytes: 0 }, { at: 1000, bytes: 100 })).toBeNull();
  });
});

describe('createDownloadProbe', () => {
  /** 可控時間 + 可控 shell 輸出的探測器。 */
  function harness(outputs: Array<string | Error>, opts: Record<string, unknown> = {}) {
    let t = 0;
    let i = 0;
    const calls: string[] = [];
    const probe = createDownloadProbe({
      shell: async (cmd: string) => {
        calls.push(cmd);
        const o = outputs[Math.min(i++, outputs.length - 1)];
        if (o instanceof Error) throw o;
        return o;
      },
      now: () => t,
      ...opts,
    });
    return { probe, calls, tick: (ms: number) => { t += ms; }, at: () => t };
  }

  const dev = (bytes: number) => ` eth0: ${bytes} 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0`;

  test('沒有 shell(iOS / Windows / web)一律回「不知道」,而且不會說在下載', async () => {
    const probe = createDownloadProbe({});
    expect(await probe.sample()).toBeNull();
    expect(probe.bps).toBeNull();
    // 不知道 → 不抑制重啟。保守的那一邊。
    expect(probe.downloading).toBe(false);
  });

  test('第一次取樣只建立基準;第二次才算得出速率', async () => {
    const h = harness([dev(0), dev(2_400_000)]);
    expect(await h.probe.sample()).toBeNull();
    h.tick(2000);
    expect(await h.probe.sample()).toBe(1_200_000);
    expect(h.probe.downloading).toBe(true);
  });

  test('窗口太短時沿用上一個值,不重新量', async () => {
    // 隔 0.3 秒量兩次會得到暴衝或 0;那個數字會讓判斷在「下載中/卡死」之間亂跳。
    const h = harness([dev(0), dev(2_400_000), dev(2_400_001)]);
    await h.probe.sample();
    h.tick(2000);
    expect(await h.probe.sample()).toBe(1_200_000);
    const callsBefore = h.calls.length;
    h.tick(300);
    expect(await h.probe.sample()).toBe(1_200_000); // 沿用
    expect(h.calls.length).toBe(callsBefore); // 連 shell 都沒再呼叫
  });

  test('速率低於門檻就不算在下載', async () => {
    const h = harness([dev(0), dev(100_000)], { thresholdBps: 150_000 });
    await h.probe.sample();
    h.tick(2000); // 100KB / 2s = 50 KB/s
    expect(await h.probe.sample()).toBe(50_000);
    expect(h.probe.downloading).toBe(false);
  });

  test('reset 之後要重新建立基準(離開載入畫面就該忘掉舊數字)', async () => {
    const h = harness([dev(0), dev(2_400_000), dev(2_400_000), dev(2_400_000)]);
    await h.probe.sample();
    h.tick(2000);
    expect(await h.probe.sample()).toBe(1_200_000);
    expect(h.probe.downloading).toBe(true);
    h.probe.reset();
    expect(h.probe.bps).toBeNull();
    expect(h.probe.downloading).toBe(false);
    h.tick(2000);
    expect(await h.probe.sample()).toBeNull(); // 重新建立基準
  });

  test('shell 失敗不要讓整步爆掉,也不要把它當成「沒在下載」', async () => {
    const h = harness([dev(0), dev(2_400_000), new Error('device offline')]);
    await h.probe.sample();
    h.tick(2000);
    expect(await h.probe.sample()).toBe(1_200_000);
    h.tick(2000);
    // 問不到就沿用上一個值:一次 adb 逾時不該讓「正在下載」瞬間翻成「卡死了」而重啟 App。
    expect(await h.probe.sample()).toBe(1_200_000);
    expect(h.probe.downloading).toBe(true);
  });

  test('量到的輸出認不出格式 → 回到「不知道」', async () => {
    const h = harness([dev(0), dev(2_400_000), 'cat: /proc/net/dev: Permission denied']);
    await h.probe.sample();
    h.tick(2000);
    expect(await h.probe.sample()).toBe(1_200_000);
    expect(h.probe.downloading).toBe(true);
    h.tick(2000);
    expect(await h.probe.sample()).toBeNull();
    expect(h.probe.downloading).toBe(false);
  });

  test('實測數量級:1.36 GB / 1.2 MB/s 會被判定為下載中', async () => {
    // job-mvxtpxj7 的實測值(畫面上的 bytes 與步間時間推算)。
    const h = harness([dev(1_193_524_636), dev(1_277_762_440)]);
    await h.probe.sample();
    h.tick(68_000); // 第 15 步到第 21 步,6 步 × 11.4s
    const bps = await h.probe.sample();
    expect(bps).not.toBeNull();
    expect(Math.round(bps! / 1000)).toBe(1239); // ≈1.24 MB/s
    expect(h.probe.downloading).toBe(true);
  });
});
