/**
 * 三種重試預算(不可無限重試):
 *   action — 按鈕沒點到等動作層級
 *   app    — App crash / ANR 後重開遊戲
 *   worker — Emulator / EC2 Worker 掛掉,換一台(由 Scheduler 執行)
 */
export type RetryKind = 'action' | 'app' | 'worker';

export class RetryBudget {
  readonly #limit: Record<RetryKind, number>;
  readonly #used: Record<RetryKind, number> = { action: 0, app: 0, worker: 0 };

  constructor(limit: Record<RetryKind, number>) {
    for (const k of Object.keys(limit) as RetryKind[]) {
      if (!Number.isInteger(limit[k]) || limit[k] < 0) throw new Error(`retry.${k} 必須是 ≥ 0 的整數`);
    }
    this.#limit = { ...limit };
  }

  /** 還有額度就扣一次並回 true;用完回 false(呼叫端改判失敗,不再重試)。 */
  consume(kind: RetryKind): boolean {
    if (this.#used[kind] >= this.#limit[kind]) return false;
    this.#used[kind]++;
    return true;
  }
  remaining(kind: RetryKind): number {
    return this.#limit[kind] - this.#used[kind];
  }
  /** action 重試在動作成功後歸零(每個動作各自 3 次);app / worker 是整場累計。 */
  resetAction(): void {
    this.#used.action = 0;
  }
  snapshot(): { limit: Record<RetryKind, number>; used: Record<RetryKind, number> } {
    return { limit: { ...this.#limit }, used: { ...this.#used } };
  }
}
