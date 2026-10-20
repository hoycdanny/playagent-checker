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
  /** 某個分頁的序號(1 起算);沒納管過回 0。console log 用它標示來源分頁。 */
  indexOf(p: TrackedPage): number;
}

/** 分頁網址;已關閉的 Page 回 'about:blank' 而不拋錯。 */
export declare function safePageUrl(p: TrackedPage | null | undefined): string;

export declare function createPageTracker(o: {
  context: TrackedContext;
  page: TrackedPage;
  /** 作用中分頁換人時呼叫(帶到前景、重綁即時串流)。 */
  onActiveChange?: (p: TrackedPage) => unknown;
  /** 納管一個新分頁時呼叫(掛 console 監聽);idx 為分頁序號,1 起算。 */
  onPageAdded?: (p: TrackedPage, idx: number) => unknown;
  log?: (m: string) => unknown;
}): PageTracker;
