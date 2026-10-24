/**
 * 收尾時間的租約 —— Windows 長時測試用。
 *
 * 問題:GameLift Streams 的 session 在沒有 client 連著時一定會在
 * `ConnectionTimeoutSeconds`(上限 3600 秒,AWS 強制)被收掉。超過一小時的任務因此需要一個
 * 保活 task 連上去掛著,但 engine 在開 session 的那一刻**無法知道那個 task 會不會連上**
 * (映像拉不到、WebRTC 出不去都可能)。
 *
 * 於是 runner 的收尾時間不能是常數:
 *   給太短 → 任務提早收工,少測一段(看得出來,報告還在)
 *   給太長 → session 被 GameLift 收掉而 runner 以為還有好幾小時
 *            → 任務停在「執行中」、沒有報告,而且不會跳任何錯
 * 後者嚴重得多,所以 engine 給的是保守值(最多一小時),保活 task 連上之後才把 S3 上的
 * 租約往後推,runner 每分鐘讀一次取較晚的那個。保活連不上或中途死掉 → 租約停止更新
 * → runner 自然退回保守行為。
 *
 * 這個模組刻意只有純函式、沒有任何 import:保活端(Fargate,有 AWS SDK)與 runner 端
 * (Windows 主機 / Redroid,相依是另外打包的)都要用它,而兩邊用的必須是同一組數字。
 *
 * 見 docs/design/windows-long-run.md。
 */

/** 保活死掉之後,session 還會留著等重連的秒數(= ConnectionTimeoutSeconds 的 AWS 上限)。 */
export const RECONNECT_WINDOW_SEC = 3600;
/** runner 收尾寫報告需要的時間(deadline 要比 session 真正被收掉早這麼多)。 */
export const WRAP_UP_SEC = 300;

/**
 * 保活端:算這一刻要寫進租約的 deadline。
 *
 * 只擔保「一個重連窗口」而不是「到 session 結束」:保活如果下一秒就死,WebRTC 斷掉後
 * session 會轉成等重連,再過一個窗口才真的被收掉。那是這一刻唯一能確定的下限。
 *
 * @param {object} o
 * @param {number} o.nowMs
 * @param {number} o.sessionEndMs  session 的硬性結束時刻(SessionLengthSeconds 到期);0 / 壞值 = 不知道
 * @returns {number} deadline 的毫秒時戳
 */
export function leaseDeadlineMs({ nowMs, sessionEndMs }) {
  const window = nowMs + RECONNECT_WINDOW_SEC * 1000;
  // 不知道硬性結束時刻就只用重連窗口;知道的話取小的 —— session 的總長不會因為有人連著就延長。
  const end = Number.isFinite(sessionEndMs) && sessionEndMs > 0 ? Math.min(window, sessionEndMs) : window;
  return end - WRAP_UP_SEC * 1000;
}

/**
 * runner 端:讀到一份租約之後,收尾時間該是多少。
 *
 * @param {number} currentMs 目前的收尾時刻;NaN = 不限時數
 * @param {string} leaseText lease.json 的原始內容(可能是空的、壞的、還不存在)
 * @returns {number} 新的收尾時刻
 */
export function nextDeadline(currentMs, leaseText) {
  // 「不限時數」不該因為讀到一份租約就變成有限的 —— 那會讓本來能一直跑的任務提早收工。
  // (目前只有 Windows 的保活會帶租約,但這個函式不該依賴那個巧合。)
  if (!Number.isFinite(currentMs)) return currentMs;
  let v = NaN;
  try {
    v = Number(JSON.parse(String(leaseText ?? ''))?.deadlineMs);
  } catch {
    return currentMs; // 空字串 / 寫到一半 / 壞 JSON:沿用現值
  }
  if (!Number.isFinite(v)) return currentMs;
  // 只往後延。租約比現值早的時候(時鐘偏移、讀到舊的那一份)不該讓任務提早收工。
  return Math.max(currentMs, v);
}
