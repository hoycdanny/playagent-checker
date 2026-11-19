/**
 * 模型單價(每百萬 token 美元)的顯示格式。
 *
 * 不用 toFixed(2):官方有 $0.035(Nova Micro)這種三位小數的價格,toFixed(2) 會顯示成
 * $0.04 或 $0.03(浮點誤差),和官方價目表對不上。這裡至少兩位小數、最多四位,多餘的 0 去掉。
 */
export function formatPerM(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  const s = n.toFixed(4).replace(/0+$/, '');
  const [i, d = ''] = s.split('.');
  return `$${i}.${d.padEnd(2, '0')}`;
}
