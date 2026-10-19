/** 型別宣告:agent/liveVideo.mjs(infra 測試會引用)。 */

/** 分段檔名裡的裝置毫秒時間;認不出來回 0。 */
export declare function segTime(name: string | undefined): number;
/** 依裝置螢幕比例算 screenrecord 尺寸(寬 540,高取偶數)。 */
export declare function recordSize(w: number, h: number): string;
/** `ls` 輸出 → 已錄完的段落(排除最新、可能仍在寫入的那一段),舊 → 新。 */
export declare function completedSegments(lsOut: string | undefined): string[];

export interface LiveVideoSegment {
  name: string;
  buf: Buffer;
  startedAt: number | null;
}

export interface LiveVideo {
  /** 已成功上傳的段數。 */
  readonly uploaded: number;
  /** 為了追上即時而丟掉的段數 / 缺口處數。 */
  readonly gapStats: { dropped: number; gaps: number };
  /** circuit breaker 跳掉了(連續失敗太多次)。 */
  readonly dead: boolean;
  /** 最近 8 秒內有成功上傳 → 前端可用影片;否則呼叫端應回退截圖輪播。 */
  healthy(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export declare function createLiveVideo(o: {
  client: { shell(cmd: string, timeoutMs?: number): Promise<unknown>; pullFile(p: string): Promise<string> };
  put: (key: string, body: Buffer, type: string) => Promise<unknown>;
  prefix: string;
  size: string;
  maxBacklog?: number;
  preserveBacklog?: boolean;
  /** 證據模式的落後上限:超過就還是丟舊段以追上即時。 */
  staleMs?: number;
  onSegment?: (seg: LiveVideoSegment) => Promise<unknown> | unknown;
  /** 連續失敗幾次就停用自己(circuit breaker)。 */
  maxFailures?: number;
  log?: (m: string) => void;
}): LiveVideo;
