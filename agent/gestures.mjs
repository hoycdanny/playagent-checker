/**
 * 連續路徑手勢的幾何 —— 「按住不放、依序經過多個位置、再放開」要經過哪些點。
 *
 * ⚠ 抽成獨立模組的唯一理由是「讓它可以被測試」(同 pageSignature.mjs / frameSignal.mjs):
 *   手勢的實際送出在 appiumClient(W3C pointer chain)與 adbClient(input motionevent)裡,
 *   兩邊都是私有方法、而且需要真機才跑得起來。把「要經過哪些點」這段純計算抽出來,
 *   就能直接餵數字驗證圈數、順逆時鐘、重複次數對不對 —— 這些算錯的話,在真機上只會表現成
 *   「手勢好像沒反應」,極難查。
 *
 * 兩個函式都只回「按下之後要依序 move 過去的點」,不含起點的按下與最後的放開。
 */

/**
 * path:按住 points[0] 之後要依序經過的點。
 *
 * loops > 1 時整條路徑重複:每一圈結束後先回到起點,再走一遍(不回起點的話,
 * 第二圈會從終點直接跳到第二個點,路徑就不是原本那條了)。
 *
 * @param {Array<{x:number,y:number}>} points 依序的座標點(至少 2 個)
 * @param {number} loops 整條路徑重複次數
 * @returns {Array<{x:number,y:number}>} 要依序 move 的點;points 不足 2 個時回空陣列
 */
export function pathSequence(points, loops = 1) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (pts.length < 2) return [];
  const n = Math.max(1, Math.min(5, Math.round(Number(loops) || 1)));
  const out = [];
  for (let lap = 0; lap < n; lap++) {
    if (lap > 0) out.push(pts[0]);          // 回到起點,再走下一圈
    for (let k = 1; k < pts.length; k++) out.push(pts[k]);
  }
  return out;
}

/**
 * circle:按住圓心之後要依序經過的點(先推到圓周,再沿圓周轉 laps 圈)。
 *
 * 每圈 segs 段:再少遊戲會把它當成幾段直線拖曳,再多則(adb 驅動每個點一次呼叫)太慢。
 * 起點取圓周左側(start = π),手指不會從一開始就遮住圓心的搖桿。
 *
 * @param {number} cx 圓心 x
 * @param {number} cy 圓心 y
 * @param {number} r  半徑
 * @param {number} laps 圈數(1~10)
 * @param {{segs?:number, clockwise?:boolean, start?:number}} [opt]
 * @returns {Array<{x:number,y:number}>} 要依序 move 的點(第一個是圓周上的起點)
 */
export function circleSequence(cx, cy, r, laps = 1, { segs = 12, clockwise = true, start = Math.PI } = {}) {
  if (![cx, cy, r].every((v) => Number.isFinite(v)) || r <= 0) return [];
  const n = Math.max(1, Math.min(10, Math.round(Number(laps) || 1)));
  const sign = clockwise ? 1 : -1;
  const at = (a) => ({ x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) });
  const out = [at(start)];
  for (let k = 1; k <= segs * n; k++) out.push(at(start + (sign * 2 * Math.PI * k) / segs));
  return out;
}
