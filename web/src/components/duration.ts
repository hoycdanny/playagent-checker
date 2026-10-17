/**
 * 任務耗時 —— 列表與任務詳情頁共用同一套算法與格式,同一個任務在不同頁面不會出現兩個數字。
 *
 * 兩種口徑,不要混用:
 * - 總耗時 taskDurationMs:createdAt → finishedAt。含排隊、開機、連線。報告列表用這個。
 * - 操作時間 taskRunDurationMs:runStartedAt → finishedAt。扣掉排隊、開機、連線,只算 AI
 *   真的在操作遊戲的那段,等於任務詳情頁啟動時間軸上「測試中」那一段(見 BootTimeline)。
 */

/** 列表項目裡與耗時有關的時間欄位(API 的 /tasks 與 /reports 都會回這些)。 */
export interface DurationFields {
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
  /** AI 開始操作遊戲的時間(後端取 status.boot.at.run,web 任務退回報告第一步的時間)。 */
  runStartedAt?: string;
}

/** 總耗時毫秒(含排隊與開機);算不出來回 null。 */
export function taskDurationMs(x: DurationFields): number | null {
  const end = x.finishedAt ?? x.updatedAt;
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(x.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * 操作時間毫秒(扣掉排隊、開機、連線)。沒有 runStartedAt(還沒開始操作、或舊任務沒有這個
 * 欄位)回 null。
 * @param now 執行中的任務沒有結束時間,用這個當結束點(呼叫端傳 Date.now(),測試可固定)。
 */
export function taskRunDurationMs(x: DurationFields, now = Date.now()): number | null {
  if (!x.runStartedAt) return null;
  const start = Date.parse(x.runStartedAt);
  if (!Number.isFinite(start)) return null;
  // 結束點刻意先取 updatedAt(與 taskDurationMs 相反):任務詳情頁的時間軸就是用
  // status.updatedAt 收尾,而 report.generatedAt 比它早約 0.2 秒 —— 用 finishedAt 會讓
  // 同一個任務在列表與詳情頁偶爾差 1 秒(時鐘格式是向下取整)。
  const endIso = x.updatedAt ?? x.finishedAt;
  const end = endIso ? Date.parse(endIso) : now;
  const ms = (Number.isFinite(end) ? end : now) - start;
  return ms >= 0 ? ms : null;
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

/**
 * 耗時 → 時鐘格式「0:45」「3:20」「1:02:05」;算不出來回「—」。
 * 任務詳情頁的啟動時間軸用這個格式,列表的操作時間欄也用同一個,兩邊字串完全一樣。
 */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
