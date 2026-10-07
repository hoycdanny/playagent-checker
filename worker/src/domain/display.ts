import { z } from 'zod';

/**
 * 顯示設定(Job Configuration)。Windows / Linux 必須真的用這個解析度渲染,
 * 不可「1920×1080 渲染再縮放截圖」。實際 framebuffer 由 Worker 啟動前驗證(verifyFramebuffer)。
 */
export const SUPPORTED_RESOLUTIONS = [
  [1080, 1920],
  [1080, 2160],
  [1080, 2400],
  [1080, 2560],
  [1080, 3840],
  [1080, 4096],
  [1440, 4096],
  [2160, 4096],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
] as const;

export const DisplaySchema = z
  .object({
    width: z.number().int().min(320).max(8192),
    height: z.number().int().min(320).max(8192),
    orientation: z.enum(['portrait', 'landscape']),
    refreshRate: z.number().int().min(24).max(144).default(60),
  })
  .refine((d) => (d.orientation === 'portrait' ? d.height >= d.width : d.width >= d.height), {
    message: 'orientation 與寬高不符(portrait 需 height ≥ width,landscape 需 width ≥ height)',
  });
export type Display = z.infer<typeof DisplaySchema>;

/** 平台目前支援的解析度(短邊/長邊不分方向比對)。 */
export function isSupportedResolution(width: number, height: number): boolean {
  return SUPPORTED_RESOLUTIONS.some(([a, b]) => (a === width && b === height) || (a === height && b === width));
}

/**
 * framebuffer 驗證:實際尺寸必須和設定完全一致(方向也要一致)。
 * 不一致 → 呼叫端標記 ENVIRONMENT_ERROR,不得開始 AI 測試。
 */
export function framebufferMatches(expected: Pick<Display, 'width' | 'height'>, actual: { width: number; height: number }): boolean {
  return expected.width === actual.width && expected.height === actual.height;
}
