/** 型別宣告:agent/loopGuard.mjs(infra 測試會引用)。 */

/** 判死依據。'no_response' = 做了動作但所有訊號都沒反應;'repeat' = 拿不到訊號時的退路。 */
export type LoopReason = 'no_response' | 'repeat';

export interface LoopObservation {
  /** 這一步的畫面名(AI 給的分類標籤)。 */
  screen: string;
  /** 步序(0 起算;第 0 步沒有「上一步」可比)。 */
  step: number;
  /** 這一步準備執行的動作。 */
  action: string;
  /** 上一步實際執行的動作(changed 的成因)。 */
  prevAction?: string | null;
  /**
   * 上一步執行後狀態有沒有變。呼叫端可以餵多個訊號的聯集
   * (例如 DOM 指紋變了 或 截圖 pHash 變了)。null = 完全拿不到訊號,走退路判準。
   */
  changed: boolean | null;
}

export interface LoopVerdict {
  /** 是否該中止任務。 */
  abort: boolean;
  /** 這個畫面名目前累計的無效操作次數。 */
  seen: number;
  /** 這一步有沒有被計入。 */
  counted: boolean;
  reason: LoopReason;
}

export interface LoopGuard {
  readonly limit: number;
  /** 目前各畫面的累計次數(除錯用快照)。 */
  snapshot(): Map<string, number>;
  /** 換新的被測目標/重啟後歸零。 */
  reset(): void;
  observe(o: LoopObservation): LoopVerdict;
  /** 中止訊息。 */
  message(screen: string, seen: number, reason: LoopReason): string;
}

export declare function createLoopGuard(options?: { limit?: number }): LoopGuard;
