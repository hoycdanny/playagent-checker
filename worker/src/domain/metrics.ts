import { z } from 'zod';

/**
 * 效能取樣(每 5~10 秒一筆,每筆都有 timestamp)。取不到的欄位留空,不要填 0
 * (報告會顯示「未收集」而不是 0)。
 */
const pct = z.number().min(0).max(100);
const nonneg = z.number().min(0);

export const MetricSampleSchema = z.object({
  timestamp: z.string(),
  // 整機
  cpuPct: pct.optional(),
  ramUsedMb: nonneg.optional(),
  ramTotalMb: nonneg.optional(),
  gpuPct: pct.optional(),
  gpuMemUsedMb: nonneg.optional(),
  netRxBytes: nonneg.optional(),
  netTxBytes: nonneg.optional(),
  diskReadBytes: nonneg.optional(),
  diskWriteBytes: nonneg.optional(),
  // 遊戲程序
  processCpuPct: z.number().min(0).optional(),
  processMemMb: nonneg.optional(),
  fps: nonneg.optional(),
  // Android
  adbState: z.enum(['device', 'offline', 'unauthorized', 'unknown']).optional(),
  anr: z.boolean().optional(),
  gcCount: nonneg.optional(),
  memPressure: z.enum(['normal', 'moderate', 'low', 'critical']).optional(),
});
export type MetricSample = z.infer<typeof MetricSampleSchema>;

/** 收集頻率上下限(秒)。 */
export const METRICS_INTERVAL_MIN_S = 5;
export const METRICS_INTERVAL_MAX_S = 10;

/** 系統健康訊號(watchdog 每 30 秒一次)。 */
export const HealthSchema = z.object({
  timestamp: z.string(),
  deviceReachable: z.boolean(),
  deviceBooted: z.boolean(),
  gameRunning: z.boolean(),
  /** 偵測到的異常(已排除正常狀態)。 */
  problems: z.array(z.enum(['device_disconnected', 'device_crashed', 'game_crashed', 'anr', 'not_booted'])),
  detail: z.string().max(2000).optional(),
});
export type Health = z.infer<typeof HealthSchema>;
