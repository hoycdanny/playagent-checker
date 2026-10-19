/** 型別宣告:agent/spinSettle.mjs(infra 測試會引用)。 */

export interface Roi { x: number; y: number; w: number; h: number }

/** 網格上某個區域的平均灰階差 0~255。區域落在網格外會被夾住。 */
export declare function roiDelta(
  a: Uint8Array,
  b: Uint8Array,
  gw: number,
  gh: number,
  roi: Roi,
): number;

export interface DecodedFrame {
  gray: Uint8Array;
  offsetMs?: number;
}

/** 等停輪的結果。'stale' = 解碼進度還沒走到送出動作那一刻(量測落後,不是盤面沒轉)。 */
export interface SettleResult {
  ok: boolean;
  reason: 'still' | 'timeout' | 'no_move' | 'stale';
  stillMs: number;
  movedAt: number;
  waitedMs: number;
  covered: number;
}

export interface SpinSettle {
  readonly stats: {
    segs: number;
    frames: number;
    fails: number;
    attempts: number;
    staleStreak: number;
    givenUp: boolean;
    coveredUntil: number;
    lastMotionAt: number;
  };
  /** 影片這條路還能不能用;回 false 時呼叫端要退回截圖輪詢。 */
  healthy(): boolean;
  /** 開始等停輪:從現在起解碼進來的分段。 */
  arm(): void;
  /** 等完了:再收寬限期內到達的分段,之後就不解碼。 */
  disarm(): void;
  /** 掛在 liveVideo 的 onSegment;序列化處理。 */
  onSegment(seg: { name?: string; buf: Buffer; startedAt: number | null }): Promise<unknown>;
  waitSettled(o: {
    after: number;
    stillMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    sleep: (ms: number) => Promise<unknown>;
    now?: () => number;
    /** 已經落後時最多再等多久(等不到就認定追不上)。 */
    staleProbeMs?: number;
  }): Promise<SettleResult>;
}

export declare function createSpinSettle(o: {
  rois: () => Roi[];
  fps?: number;
  gridW?: number;
  gridH?: number;
  threshold?: number;
  graceMs?: number;
  decode?: (buf: Buffer, o: { roi: Roi; fps: number; gridW: number; gridH: number }) => Promise<DecodedFrame[]>;
  log?: (m: string) => void;
  now?: () => number;
}): SpinSettle;
