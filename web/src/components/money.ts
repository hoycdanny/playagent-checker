/**
 * 花費金額顯示:一律到小數點後四位。
 * 單次任務/每局花費常只有幾分錢,兩位小數會把 $0.0042 和 $0.0049 都顯示成 $0.00,無法評估。
 * (模型單價「每百萬 token」是公告價,維持兩位即可,不走這裡。)
 */
export function usd4(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}
