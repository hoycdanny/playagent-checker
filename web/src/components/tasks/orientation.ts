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
