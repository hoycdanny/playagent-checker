import { z } from 'zod';

/**
 * AI 動作(統一格式)。座標一律是「模型空間」(VLM 看到的截圖像素),
 * 由 Worker 經 coordinates.toDevice() 轉成裝置座標後才執行。
 */
const coord = z.number().finite().min(0);
const meta = {
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(500).optional(),
};
const point = { x: coord, y: coord };

export const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tap'), ...point, ...meta }),
  z.object({ action: z.literal('doubleTap'), ...point, ...meta }),
  z.object({ action: z.literal('longPress'), ...point, durationMs: z.number().int().min(100).max(10_000).default(800), ...meta }),
  z.object({ action: z.literal('swipe'), ...point, x2: coord, y2: coord, durationMs: z.number().int().min(50).max(5_000).default(300), ...meta }),
  z.object({ action: z.literal('drag'), ...point, x2: coord, y2: coord, durationMs: z.number().int().min(200).max(10_000).default(1_000), ...meta }),
  // keyboard:輸入文字(長度上限,避免把整段 prompt 當成輸入)。
  z.object({ action: z.literal('keyboard'), text: z.string().min(1).max(500), ...meta }),
  // hotkey:按鍵組合(只收白名單鍵名,避免任意字串進 OS 輸入層)。
  z.object({ action: z.literal('hotkey'), keys: z.array(z.string().regex(/^(ctrl|alt|shift|meta|enter|esc|tab|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|f([1-9]|1[0-2])|[a-z0-9])$/)).min(1).max(4), ...meta }),
  z.object({ action: z.literal('back'), ...meta }),
  z.object({ action: z.literal('wait'), durationMs: z.number().int().min(0).max(60_000).default(2_000), ...meta }),
  z.object({ action: z.literal('screenshot'), ...meta }),
  z.object({ action: z.literal('restartApp'), ...meta }),
  z.object({ action: z.literal('restartDevice'), ...meta }),
  z.object({ action: z.literal('terminateTest'), verdict: z.enum(['pass', 'fail']), ...meta }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionKind = Action['action'];

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  /** 實際送到裝置的座標(裝置空間;除錯 / 標註用)。 */
  devicePoint: z.object({ x: z.number(), y: z.number() }).optional(),
  devicePoint2: z.object({ x: z.number(), y: z.number() }).optional(),
  durationMs: z.number().min(0),
  /** unsupported = 這個平台不支援此動作(不是失敗,呼叫端換做法)。 */
  error: z.enum(['unsupported', 'device_error', 'timeout', 'invalid']).optional(),
  message: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

/** 解析模型輸出的動作;不合法回 null(呼叫端記錄 parseFailed)。 */
export function parseAction(raw: unknown): Action | null {
  const r = ActionSchema.safeParse(raw);
  return r.success ? r.data : null;
}
