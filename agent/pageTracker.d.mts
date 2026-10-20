/** 型別宣告:agent/pageTracker.mjs(infra 測試會引用)。 */

/** Page / Context 只用到這幾個方法(鴨子型別,測試可用假物件)。 */
export interface TrackedPage {
  url(): string;
  isClosed(): boolean;
  on(ev: string, fn: (...args: unknown[]) => unknown): unknown;
}

export interface TrackedContext {
  on(ev: string, fn: (...args: unknown[]) => unknown): unknown;
  pages(): TrackedPage[];
}

export interface PageTracker {
  /** 目前該操作的分頁(已關閉會自動退回還開著的)。 */
  active(): TrackedPage;
  /** 目前開著的分頁數。 */
  readonly count: number;
  /** 是不是還有別的分頁可以退回。 */
  canClosePopup(): boolean;
  /** 取走「分頁切換了」的說明(取走即清空)。 */
  consumeNote(): string;
}

/** 分頁網址;已關閉的 Page 回 'about:blank' 而不拋錯。 */
export declare function safePageUrl(p: TrackedPage | null | undefined): string;

export declare function createPageTracker(o: {
  context: TrackedContext;
  page: TrackedPage;
  onActiveChange?: (p: TrackedPage) => unknown;
  log?: (m: string) => unknown;
}): PageTracker;
