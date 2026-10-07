/**
 * 座標轉換層:VLM 看到的截圖尺寸(模型空間)和裝置輸入座標(裝置空間)必須明確轉換。
 * 截圖縮小給模型看時,模型回的座標一律先經過 toDevice() 才能拿去點。
 *
 * 例:原始 1080×4096,送模型 540×2048,模型回 (270, 1800) → 裝置 (540, 3600)。
 */
export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export class CoordinateError extends Error {
  override name = 'CoordinateError';
}

function assertSize(s: Size, label: string): void {
  if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width <= 0 || s.height <= 0) {
    throw new CoordinateError(`${label} 尺寸無效:${s.width}×${s.height}`);
  }
}

/** 模型空間 → 裝置空間(四捨五入、夾在畫面內)。 */
export function toDevice(p: Point, model: Size, device: Size): Point {
  assertSize(model, 'model');
  assertSize(device, 'device');
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new CoordinateError(`座標無效:(${p.x}, ${p.y})`);
  const x = Math.round((p.x / model.width) * device.width);
  const y = Math.round((p.y / model.height) * device.height);
  return { x: clamp(x, 0, device.width - 1), y: clamp(y, 0, device.height - 1) };
}

/** 裝置空間 → 模型空間(標註落點、回放用)。 */
export function toModel(p: Point, device: Size, model: Size): Point {
  assertSize(model, 'model');
  assertSize(device, 'device');
  return {
    x: clamp(Math.round((p.x / device.width) * model.width), 0, model.width - 1),
    y: clamp(Math.round((p.y / device.height) * model.height), 0, model.height - 1),
  };
}

/**
 * 給模型的截圖尺寸:等比例縮到長邊 ≤ maxLongEdge,且寬高都是 multiple 的倍數(VLM patch 對齊)。
 * 不會放大。
 */
export function modelInputSize(device: Size, maxLongEdge = 2048, multiple = 2): Size {
  assertSize(device, 'device');
  const scale = Math.min(1, maxLongEdge / Math.max(device.width, device.height));
  const round = (v: number) => Math.max(multiple, Math.round((v * scale) / multiple) * multiple);
  return { width: round(device.width), height: round(device.height) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
