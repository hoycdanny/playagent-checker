/**
 * 搖桿走位回饋:判斷「上一步 move 有沒有真的走動」並決定被擋住時改走的方向。
 *
 * 有搖桿的遊戲鏡頭跟著角色走 → 角色有走,背景就會捲動。只比對「背景區塊」(避開上方 HUD
 * 的暫停鈕/等級/計時、中間角色、下方搖桿、右側技能欄),角色被樹擋住時轉身動畫不會干擾判斷。
 * 2026-10-05 job-muv1zsvi-0qbt8v 實測:被樹擋住 0 bit 變化;真的走動 278 bit(共 1024 bit)。
 */

export const SCENE_CROP = { x: 0.05, y: 0.18, w: 0.8, h: 0.22 };
/** 背景區塊 pHash 差異 ≤ 此值視為沒動。 */
export const SCENE_BLOCKED_BITS = 16;

const DIR_RING = ['up', 'upright', 'right', 'downright', 'down', 'downleft', 'left', 'upleft'];

/** 方向字串正規化(up-left / UpLeft → upleft);不認得回 null。 */
export function normDir(d) {
  const s = String(d ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return DIR_RING.includes(s) ? s : null;
}

/** 被擋住時改走的方向:第 1 次轉 90°、第 2 次轉另一邊 90°、第 3 次往反方向,之後循環。 */
export function turnDir(dir, streak) {
  const i = DIR_RING.indexOf(normDir(dir) ?? '');
  if (i < 0) return 'up';
  const offset = [2, -2, 4][(Math.max(1, streak) - 1) % 3];
  return DIR_RING[(i + offset + 8) % 8];
}

/** 兩張背景雜湊比較:回 true = 上一步 move 後背景沒動(被擋住)。缺資料回 false。 */
export function isBlocked(prevScene, curScene, hamming) {
  if (!prevScene || !curScene) return false;
  return hamming(prevScene, curScene) <= SCENE_BLOCKED_BITS;
}
