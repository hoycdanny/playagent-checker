/**
 * 畫面變化訊號 —— 從兩張 48×48 灰階格子判斷「上一步做了動作之後,畫面上有東西變了嗎」。
 *
 * ⚠ 抽成獨立模組的唯一理由是「讓它可以被測試」(同 pageSignature.mjs):
 *   explorationRunner.mjs 的最後一行就會呼叫 main(),一 import 就開始跑任務,
 *   而這裡的門檻與視窗大小是整個死循環護欄的判準核心,必須能單獨餵數字驗證。
 *
 * 為什麼需要它(判準演進見 loopGuard.mjs):
 *   pHash 是 32×32 DCT 低頻雜湊、判「畫面沒變」的門檻是 40/1024 bit —— 它看得出
 *   「換了一個畫面」,卻看不出「輸入框多了一個字」。web runner 用 DOM 互動狀態指紋補這個
 *   盲區,原生遊戲沒有 DOM,只能從畫面本身取更敏感的訊號。
 *
 * 門檻取值:
 *   cellDelta = 8   單格平均亮度差(0–255)。濾掉 JPEG 雜訊與呼吸燈式的微動畫(實測約 2–4)。
 *   minCells  = 2   至少兩格同時超標。1 格太敏感(游標閃爍),2 格仍足以涵蓋
 *                   「輸入框多一個字」「血條掉一截」「船往前走了一點」。
 *
 * 方向性是刻意的:這些訊號只用來回答護欄的問題。寧可偏向「有變」(護欄晚點觸發,後面還有
 * 卡死硬停止點、測項時間盒、預算三道後手),也不要把「正在填表單」或「戰鬥畫面正在推進」
 * 誤判成沒反應,而去重啟 App / 中止任務。
 */

const CELL_DELTA = 8;
const MIN_CELLS = 2;

/** 整張圖有沒有任何一處真的變了。長度不符 / 缺資料回 null(= 沒有訊號,不是「沒變」)。 */
export function gridMoved(a, b, cellDelta = CELL_DELTA, minCells = MIN_CELLS) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) >= cellDelta) {
      n++;
      if (n >= minCells) return true;
    }
  }
  return false;
}

/**
 * 同上,但只看「上一步點擊位置附近」那一小塊。
 *
 * 為什麼要分開看:整張圖有沒有動,和「你點的那顆按鈕有沒有反應」是兩件事。
 * 實測 job-muv712gs:彈窗在動畫沒播完時被點了寶箱,之後整個彈窗不再接受任何輸入
 * (按鈕 / back / 滑動全都沒反應),但動畫照跑 —— 只看「整張圖有沒有動」會永遠得到
 * 「有動」,死循環護欄就永遠不會觸發,任務一路燒到步數或預算上限。
 *
 * 只對「點在某個位置」的動作(tap / hold)這樣判;打字、走位、back 的效果不一定出現在
 * 手指底下,那些仍然看整張圖。
 *
 * @param {Uint8Array} a 上一步的格子
 * @param {Uint8Array} b 這一步的格子
 * @param {{x:number,y:number}} at 落點,0~1 相對座標(畫面尺寸可能中途改變,所以不收像素)
 * @param {{size?:number, r?:number, cellDelta?:number, minCells?:number}} [opt]
 *   r = 視窗半徑(格)。3 → 7×7 格,約各軸 15% 畫面,足以涵蓋一顆按鈕與它的點擊回饋。
 */
export function gridMovedAt(a, b, at, opt = {}) {
  const { size = 48, r = 3, cellDelta = CELL_DELTA, minCells = MIN_CELLS } = opt;
  if (!a || !b || a.length !== b.length || a.length !== size * size) return null;
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const cx = Math.max(0, Math.min(size - 1, Math.floor(at.x * size)));
  const cy = Math.max(0, Math.min(size - 1, Math.floor(at.y * size)));
  let n = 0;
  for (let gy = Math.max(0, cy - r); gy <= Math.min(size - 1, cy + r); gy++) {
    for (let gx = Math.max(0, cx - r); gx <= Math.min(size - 1, cx + r); gx++) {
      const i = gy * size + gx;
      if (Math.abs(a[i] - b[i]) >= cellDelta) {
        n++;
        if (n >= minCells) return true;
      }
    }
  }
  return false;
}
