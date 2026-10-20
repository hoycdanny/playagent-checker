/** 型別宣告:agent/browserLogs.mjs(infra 測試會引用)。 */

/** logcat 等級字母。 */
export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | 'A';

export interface BrowserLogEvent {
  /** console 類型(log/warning/error…);有 level 時可省略。 */
  type?: string;
  /** 直接指定等級(pageerror / requestfailed 用)。 */
  level?: LogLevel;
  /** 來源標籤(不可含冒號,會被正規化)。 */
  tag?: string;
  msg: string;
  /** epoch ms;未給用現在時間。 */
  at?: number;
  /** 第幾個分頁(1 起算);借 logcat 的 pid 欄位呈現。 */
  pageIndex?: number;
}

export interface BrowserLogs {
  readonly stats: { all: number; error: number; warn: number; pending: number; dropped: number; chunks: number };
  push(e: BrowserLogEvent): void;
  /** 寫出一個片段;沒有待寫內容回 false。 */
  collect(step: number, url?: string): Promise<boolean>;
}

export declare function levelOf(type: string | undefined): LogLevel;
export declare function cleanMessage(s: unknown): string;
export declare function cleanTag(s: unknown): string;
export declare function formatLine(e: {
  at?: number; level: LogLevel; tag?: string; msg: string; pageIndex?: number;
}): string;
export declare function collapseRepeats<T extends { level: string; tag: string; msg: string; pageIndex?: number; at: number }>(
  entries: T[],
): Array<T & { count: number }>;

export declare function createBrowserLogs(o: {
  put: (key: string, body: string, contentType: string) => Promise<unknown>;
  prefix: string;
  log?: (m: string) => unknown;
  now?: () => number;
}): BrowserLogs;
