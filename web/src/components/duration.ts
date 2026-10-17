/**
 * 任務耗時 —— 報告列表與任務列表共用同一套算法與格式,兩邊的「耗時」欄一定對得上。
 *
 * 口徑:createdAt → finishedAt(報告產生時間;無報告則退回 status 最後更新時間)。
 * 這段包含排隊與開機時間,不只是 AI 實際操作的時間;執行中的任務會隨著每次輪詢長大,
 * 等於「到目前為止經過多久」。
 */

/** 列表項目裡與耗時有關的三個時間欄位(API 的 /tasks 與 /reports 都會回這些)。 */
export interface DurationFields {
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
}

/** 耗時毫秒;算不出來(沒有結束時間、時間字串壞掉、負數)回 null。 */
export function taskDurationMs(x: DurationFields): number | null {
  const end = x.finishedAt ?? x.updatedAt;
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(x.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** 耗時 → 「45s」「3m 20s」「1h 05m」;null 回「—」。 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
