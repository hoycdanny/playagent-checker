/** 型別宣告:agent/frameSignal.mjs。 */

/** 整張圖有沒有任何一處變了;null = 拿不到訊號(不是「沒變」)。 */
export function gridMoved(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
  cellDelta?: number,
  minCells?: number,
): boolean | null;

/** 只看落點(0~1 相對座標)附近那一小塊有沒有變;null = 拿不到訊號。 */
export function gridMovedAt(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
  at: { x: number; y: number } | null | undefined,
  opt?: { size?: number; r?: number; cellDelta?: number; minCells?: number },
): boolean | null;

/**
 * App 畫面被系統遮黑(Android 15 螢幕分享保護的特徵);null = 拿不到格子。
 * 判「中央區域幾乎全暗 + 整張圖大多是暗的」—— 狀態列/導覽列是系統視窗,不會被遮黑。
 */
export function frameIsBlank(
  grid: Uint8Array | null | undefined,
  opt?: { dark?: number; size?: number; edgeRows?: number; centreRatio?: number; overallRatio?: number },
): boolean | null;
