/**
 * 停輪判定(影片版):用「已經在錄的即時錄影」判斷畫面有沒有靜止,不佔 Appium 連線。
 *
 * 為什麼不用截圖輪詢(舊做法,explorationRunner 的 SPIN 迴圈):
 *   Appium 取一張圖要 2~6 秒(job-mvch7zri 實測每取樣 5.6 秒),而我們要量的是「靜止 2 秒」。
 *   取樣間隔比要量的窗口還大,再怎麼調門檻或區域都量不出來 —— 實測每局要等 16~23 秒,
 *   而且回報的靜止時間都是 5~6 秒(至少要等到第二個靜止樣本才會成立)。
 *   即時錄影本來就在跑(2 秒一段、全解析度、約 60fps),解碼成低解析灰階網格後
 *   每秒有 10 個樣本,「靜止 2 秒」就是真的 2 秒,而且完全不跟決策搶裝置。
 *
 * 代價:錄影分段是事後拉回來的,所以解碼出來的時間軸會落後現實約一個分段(2~3 秒)。
 *   waitSettled 等的是「已解碼的時間軸上安靜了 stillMs」,所以這段落後會反映成等待時間,
 *   但它是固定成本,不像截圖輪詢會隨取樣次數累加。
 */
import { decodeBoardFrames } from './slotVideoCapture.mjs';

/** 整張畫面(不裁切):一次解碼,各區域的差異在網格上分別算。 */
const FULL_ROI = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** 網格上某個區域(0~1 比例)的平均灰階差 0~255。區域落在網格外會被夾住。 */
export function roiDelta(a, b, gw, gh, roi) {
  const x0 = Math.max(0, Math.min(gw - 1, Math.floor(roi.x * gw)));
  const x1 = Math.max(x0 + 1, Math.min(gw, Math.ceil((roi.x + roi.w) * gw)));
  const y0 = Math.max(0, Math.min(gh - 1, Math.floor(roi.y * gh)));
  const y1 = Math.max(y0 + 1, Math.min(gh, Math.ceil((roi.y + roi.h) * gh)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * gw;
    for (let x = x0; x < x1; x++) { sum += Math.abs(a[row + x] - b[row + x]); n++; }
  }
  return n ? sum / n : 0;
}

/**
 * @param {object} o
 * @param {() => Array<{x:number,y:number,w:number,h:number}>} o.rois 要盯的區域(每步可能因轉向而變,所以用函式)
 * @param {number} [o.fps] 解碼取樣率
 * @param {number} [o.threshold] 平均灰階差超過此值視為「有在動」
 */
export function createSpinSettle({
  rois, fps = 6, gridW = 72, gridH = 160, threshold = 2.5, graceMs = 4000,
  decode = decodeBoardFrames, log = () => {}, now = Date.now,
}) {
  // 只在「等停輪」那段時間解碼。全程解碼的代價很實際:1440x3088、60fps 的 2 秒分段,
  // 每 2 秒要解上百張全解析度影格,把容器 CPU 吃掉之後整個主迴圈都被拖慢
  // (實測每步 15.7 秒 → 30 秒)。armedUntil 之後還留 graceMs,因為分段是事後才拉回來的,
  // 覆蓋等待區間的那一段往往在解除武裝之後才到。
  let armedUntil = 0;
  let prev = null;
  let prevT = 0;
  let coveredUntil = 0;  // 已解碼到哪個時刻(epoch ms)
  let lastMotionAt = 0;  // 任一區域最後一次有動作的時刻
  let chain = Promise.resolve();
  let segs = 0;
  let frames = 0;
  let fails = 0;

  async function ingest({ buf, startedAt }) {
    if (!Buffer.isBuffer(buf) || !buf.length) return;
    const start = Number.isFinite(startedAt) ? startedAt : Date.now();
    const list = await decode(buf, { roi: FULL_ROI, fps, gridW, gridH });
    segs++;
    const watch = rois() ?? [];
    for (const f of list) {
      const t = start + (f.offsetMs ?? 0);
      // 分段可能略有重疊/亂序:只往前推進。
      if (prev && t > prevT && watch.some((r) => roiDelta(f.gray, prev, gridW, gridH, r) > threshold)) lastMotionAt = t;
      if (t >= prevT) { prev = f.gray; prevT = t; }
      frames++;
      if (t > coveredUntil) coveredUntil = t;
    }
  }

  return {
    get stats() { return { segs, frames, fails, coveredUntil, lastMotionAt }; },
    /**
     * 影片這條路還能不能用。解碼一直失敗卻一幀都沒拿到(例如容器沒有 ffmpeg、分段格式有問題)
     * 就回 false —— 呼叫端要退回截圖輪詢,否則每局都會乾等到逾時才知道沒資料。
     */
    healthy() { return frames > 0 || fails === 0; },
    /** 開始等停輪:從現在起解碼進來的分段。 */
    arm() { armedUntil = Infinity; },
    /** 等完了:再收 graceMs 內到達的分段(它們才覆蓋剛才那段等待),之後就不解碼了。 */
    disarm() { if (armedUntil === Infinity) armedUntil = now() + graceMs; },
    /** 掛在 liveVideo 的 onSegment;序列化處理(分段必須按順序比對)。沒在等停輪就直接丟掉。 */
    onSegment(seg) {
      if (now() > armedUntil) { prev = null; return chain; }
      chain = chain.then(() => ingest(seg), () => ingest(seg)).catch((e) => {
        fails++;
        log(`[spin-settle] 分段 ${seg?.name ?? '?'} 解碼失敗:${String(e?.message || e).slice(0, 180)}`);
      });
      return chain;
    },
    /**
     * 等到「動作之後畫面動過,而且已經連續靜止 stillMs」。
     * @param {number} o.after 送出動作的時刻(epoch ms):之後必須看到動作,才算真的有轉
     * @returns {Promise<{ok:boolean, reason:'still'|'timeout'|'no_move', stillMs:number, movedAt:number, waitedMs:number, covered:number}>}
     */
    async waitSettled({ after, stillMs = 2000, timeoutMs = 15_000, pollMs = 200, sleep, now = Date.now }) {
      const t0 = now();
      // 迭代上限:逾時只看時間,萬一時鐘沒前進(或 sleep 被換成立即回傳)就會變成無窮忙迴圈。
      const maxLoops = Math.max(2, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 2);
      for (let k = 0; k < maxLoops; k++) {
        await chain.catch(() => {});
        const movedAt = lastMotionAt > after ? lastMotionAt : 0;
        // 已解碼的時間軸上,最後一次動作之後安靜了多久(資料還沒到的部分不算安靜)。
        const quiet = Math.max(0, coveredUntil - Math.max(lastMotionAt, after));
        if (movedAt && quiet >= stillMs) {
          return { ok: true, reason: 'still', stillMs: quiet, movedAt, waitedMs: now() - t0, covered: coveredUntil - after };
        }
        if (now() - t0 >= timeoutMs) {
          return { ok: false, reason: movedAt ? 'timeout' : 'no_move', stillMs: quiet, movedAt, waitedMs: now() - t0, covered: coveredUntil - after };
        }
        await sleep(pollMs);
      }
      const movedAt = lastMotionAt > after ? lastMotionAt : 0;
      return {
        ok: false,
        reason: movedAt ? 'timeout' : 'no_move',
        stillMs: Math.max(0, coveredUntil - Math.max(lastMotionAt, after)),
        movedAt,
        waitedMs: now() - t0,
        covered: coveredUntil - after,
      };
    },
  };
}
