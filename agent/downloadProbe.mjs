/**
 * 「裝置是不是正在下載」的探測器。
 *
 * 為什麼需要它:載入畫面上「遊戲正在下載 1.36 GB 資源」與「遊戲卡死了」長得一模一樣。
 * 進度條可能好幾十秒才動一格,而卡死的載入畫面往往還有動畫 —— 從畫面完全分不出來。
 * 分得出來的是網路:下載中裝置會持續收位元組。
 *
 * 這件事會影響兩個決定:
 *   1. 要不要在載入畫面上就地等(等就不用每 11 秒花一次模型呼叫看同一條進度條)。
 *   2. 要不要重啟 App。下載中重啟純粹是浪費 —— 實測 1.36 GB 的首次下載會連續
 *      觸發三次「載入畫面卡住」重啟。
 *
 * 純函式放在這裡是為了能測:explorationRunner.mjs 的最後一行就會呼叫 main(),
 * 一 import 就開始跑測試,沒辦法在單元測試裡 import。
 */

/**
 * 解析 `/proc/net/dev`,回「所有非迴圈介面」的累計接收位元組。認不出格式回 null。
 *
 * **一定要排除 lo。** runner 的截圖是走 adb 過來的,在容器裡那就是迴圈介面的流量;
 * 不排掉的話「我們自己每 5 秒抓一張 1.8 MB 的圖」會被當成「遊戲在下載」,
 * 這個訊號就完全反了 —— 而且症狀是「卡死的任務永遠不會被重啟」,很難查。
 */
export function parseRxBytes(text) {
  let total = 0;
  let seen = false;
  for (const line of String(text ?? '').split('\n')) {
    // 格式:`  eth0: 12345 67 0 0 ...`(第一個數字欄就是 receive bytes)
    const m = /^\s*([^:\s]+):\s*(\d+)/.exec(line);
    if (!m) continue;
    const iface = m[1];
    if (iface === 'lo' || iface.startsWith('lo:')) continue;
    const bytes = Number(m[2]);
    if (!Number.isFinite(bytes)) continue;
    total += bytes;
    seen = true;
  }
  return seen ? total : null;
}

/**
 * 兩次取樣算接收速率(bytes/s)。無法比較時回 null,呼叫端要把 null 當成
 * 「不知道」而不是「沒有在下載」—— 兩者的處置不一樣。
 *
 * 回 null 的情況:
 *   - 少了任一次取樣(第一次量,沒有基準)
 *   - 時間沒有前進(算出來會是 Infinity)
 *   - 位元組變少 = 計數器被重置(App 重啟、介面重建),差值沒有意義
 */
export function rxRateBps(prev, cur) {
  if (!prev || !cur) return null;
  if (!Number.isFinite(prev.bytes) || !Number.isFinite(cur.bytes)) return null;
  if (!Number.isFinite(prev.at) || !Number.isFinite(cur.at)) return null;
  const dt = cur.at - prev.at;
  if (dt <= 0) return null;
  if (cur.bytes < prev.bytes) return null;
  return ((cur.bytes - prev.bytes) * 1000) / dt;
}

/**
 * 下載速率取樣器。
 *
 * @param {object} o
 * @param {(cmd: string, timeoutMs?: number) => Promise<string>} [o.shell]
 *   裝置上的 shell(adb 的 shell() 或 Appium 的 mobile: shell)。沒有就一律回 null。
 * @param {number} [o.thresholdBps] 超過這個速率視為「正在下載」。
 * @param {number} [o.minWindowMs] 最小取樣間隔。窗口太短算出來的數字沒有意義
 *   (隔 0.3 秒量兩次會得到暴衝或 0),所以直接沿用上一個值。
 * @param {() => number} [o.now] 時間來源(測試用)。
 */
export function createDownloadProbe({ shell, thresholdBps = 150_000, minWindowMs = 2000, now = Date.now } = {}) {
  let prev = null; // { at, bytes }
  let bps = null;

  return {
    /** 最近算出的速率(bytes/s);null = 不知道。 */
    get bps() { return bps; },
    /** 已經有足夠證據說「正在下載」。不知道時回 false(保守:不知道就別抑制重啟)。 */
    get downloading() { return bps !== null && bps >= thresholdBps; },
    /** 離開載入畫面時呼叫:清掉基準,下次重新量。 */
    reset() { prev = null; bps = null; },
    /** 取樣一次,回速率(bytes/s)或 null。 */
    async sample() {
      if (typeof shell !== 'function') return null;
      const t = now();
      if (prev && t - prev.at < minWindowMs) return bps;
      let out;
      try { out = await shell('cat /proc/net/dev', 8000); } catch { return bps; }
      const bytes = parseRxBytes(out);
      if (bytes === null) { bps = null; return null; }
      const cur = { at: now(), bytes };
      bps = rxRateBps(prev, cur);
      prev = cur;
      return bps;
    },
  };
}
