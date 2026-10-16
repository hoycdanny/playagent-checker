/**
 * 被測 App 目前是直向還是橫向(任務詳情頁依此換版面)。
 * 來源:每步的座標空間 step.space.device / shot = [寬, 高](runner 寫的,有點擊座標的步驟才有);
 * 沒有的步驟沿用前一個已知方向。
 */
export type Orientation = 'portrait' | 'landscape';

export function stepOrientation(s: Record<string, unknown> | undefined): Orientation | null {
  const space = s?.space as { device?: unknown; shot?: unknown } | undefined;
  for (const dims of [space?.device, space?.shot]) {
    if (Array.isArray(dims) && dims.length === 2) {
      const [w, h] = dims.map(Number);
      if (w! > 0 && h! > 0) return w! > h! ? 'landscape' : 'portrait';
    }
  }
  return null;
}

/** 這一步被測 App 畫面的寬 / 高比(沒有座標空間回 null)。 */
export function stepAspect(s: Record<string, unknown> | undefined): number | null {
  const space = s?.space as { device?: unknown; shot?: unknown } | undefined;
  for (const dims of [space?.device, space?.shot]) {
    if (Array.isArray(dims) && dims.length === 2) {
      const [w, h] = dims.map(Number);
      if (w! > 0 && h! > 0) return w! / h!;
    }
  }
  return null;
}

/**
 * 某一步(含)之前最近的畫面寬高比(找不到往後找)。
 * 錄影是固定大小(例如 480×720),App 轉向時畫面會被縮在中間加黑邊;用這個比例把黑邊裁掉。
 */
export function aspectAt(steps: Array<Record<string, unknown> & { index: number }>, index: number | null): number | null {
  const sorted = [...steps].sort((a, b) => a.index - b.index);
  const upto = index === null ? sorted : sorted.filter((s) => s.index <= index);
  for (let i = upto.length - 1; i >= 0; i--) {
    const a = stepAspect(upto[i]);
    if (a) return a;
  }
  for (const s of sorted) {
    const a = stepAspect(s);
    if (a) return a;
  }
  return null;
}

/**
 * 把固定大小影片裡置中、等比縮放的 App 畫面(寬高比 aspect)放大到填滿容器:
 * 回傳影片要畫多大(px)。影片置中 + 容器 overflow:hidden → 黑邊被裁掉。
 */
export function contentCrop(video: { w: number; h: number }, aspect: number | null): { aspect: number; wPct: number; hPct: number } | null {
  if (video.w <= 0 || video.h <= 0) return null;
  const va = video.w / video.h;
  // 影片裡 App 畫面的實際大小(影片像素)。
  const a = aspect && aspect > 0 ? aspect : va;
  const cw = a >= va ? video.w : video.h * a;
  const ch = a >= va ? video.w / a : video.h;
  // 框 = App 畫面比例;影片相對框的大小(%)——影片置中、框 overflow:hidden → 黑邊被裁掉。
  return { aspect: a, wPct: (video.w / cw) * 100, hPct: (video.h / ch) * 100 };
}

/** 某一步(含)之前最近的已知方向;index = null 用最新一步。都不知道回 null。 */
export function orientationAt(steps: Array<Record<string, unknown> & { index: number }>, index: number | null): Orientation | null {
  const sorted = [...steps].sort((a, b) => a.index - b.index);
  const upto = index === null ? sorted : sorted.filter((s) => s.index <= index);
  for (let i = upto.length - 1; i >= 0; i--) {
    const o = stepOrientation(upto[i]);
    if (o) return o;
  }
  // 這一步之前都沒有,往後找第一個(開頭幾步常是 wait,還沒有座標)。
  for (const s of sorted) {
    const o = stepOrientation(s);
    if (o) return o;
  }
  return null;
}
