/**
 * 任務清單的自由文字搜尋。
 *
 * 為什麼需要:列表的欄位全是圖示與摘要,任務編號只存在於每列連結的網址裡,
 * 畫面上找不到任何 job id 文字。所以使用者拿到一個 jobId(例如從日誌、報告連結、
 * 或別人轉貼的訊息)之後,在介面上完全沒有辦法把它找出來。既有的篩選器只有
 * 狀態 / 環境 / 位置 / 應用 / 三個模型 / 步數 / 花費,都不是「我知道它叫什麼」的入口。
 *
 * 比對範圍刻意放寬到「這一列看得到或查得到的字」:任務編號、案例名稱與版本、
 * 應用名稱與 id、裝置型號、結論訊息、測試內容、送出者。
 */

/** 可被搜尋的任務欄位(都可缺,舊任務不一定有)。 */
export interface SearchableTask {
  jobId: string;
  appId?: string;
  caseId?: string;
  caseName?: string;
  caseVersion?: string;
  deviceModel?: string;
  message?: string;
  task?: string;
  submittedBy?: string;
}

/**
 * 把搜尋字切成詞。空白分隔,每個詞都要命中(AND)——
 * 這樣「拉霸 fail」才能同時用兩個條件縮小範圍,而不是比對一整串不存在的字面。
 */
export function searchTerms(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 這一列可供比對的所有文字(小寫)。appName 由呼叫端提供(列表顯示的是名稱不是 id)。 */
function haystack(x: SearchableTask, appName?: string): string {
  return [
    x.jobId,
    x.appId,
    appName,
    x.caseId,
    x.caseName,
    x.caseVersion,
    x.deviceModel,
    x.message,
    x.task,
    x.submittedBy,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 搜尋字是否命中這一列(空字串 = 不篩選,全部命中)。 */
export function taskMatchesQuery(
  x: SearchableTask,
  query: string,
  appName?: string,
): boolean {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const hay = haystack(x, appName);
  return terms.every((term) => hay.includes(term));
}
