import type { Platform } from './platform.js';

/**
 * 成本模型。單價一律由呼叫端傳入(從 AWS Price List API 或設定讀),不寫死在程式裡 ——
 * 價格會變、也因區域不同。這裡只負責「怎麼算」。
 */
export interface ComputePrice {
  platform: Platform;
  instanceType: string;
  purchase: 'on-demand' | 'spot';
  usdPerHour: number;
  /** 最低計費(小時)。EC2 Mac Dedicated Host 配置後至少 24 小時。 */
  minimumBilledHours?: number;
}

export interface RunCostInput {
  price: ComputePrice;
  /** 這次 job 實際佔用主機的分鐘數(含開機、安裝、收證據)。 */
  minutes: number;
  /** 同一台主機同時跑的 session 數(分攤主機成本)。 */
  sessionsOnWorker: number;
  /** AI(Bedrock)花費,由既有 token × 單價計算後傳入。 */
  aiUsd: number;
}

export interface RunCost {
  computeUsd: number;
  aiUsd: number;
  totalUsd: number;
  costPerMinute: number;
}

export function runCost(i: RunCostInput): RunCost {
  if (i.minutes < 0 || i.sessionsOnWorker < 1 || i.price.usdPerHour < 0 || i.aiUsd < 0) throw new Error('成本輸入不合法');
  const hours = i.minutes / 60;
  const computeUsd = round4((hours * i.price.usdPerHour) / i.sessionsOnWorker);
  const totalUsd = round4(computeUsd + i.aiUsd);
  return { computeUsd, aiUsd: round4(i.aiUsd), totalUsd, costPerMinute: i.minutes > 0 ? round4(totalUsd / i.minutes) : 0 };
}

/**
 * EC2 Mac 這類有最低計費的主機:回傳「這段配置期間的固定成本」,
 * 用來決定要不要讓同一台 Host 在 24 小時內接更多 job 來攤提。
 */
export function minimumHostCost(price: ComputePrice): number {
  return round4((price.minimumBilledHours ?? 0) * price.usdPerHour);
}

/** 同一場 job 用 On-Demand vs Spot 的差額(Spot 可能被中斷,報告要同時列出重試成本)。 */
export function spotSavings(onDemand: ComputePrice, spot: ComputePrice, minutes: number): number {
  return round4(((onDemand.usdPerHour - spot.usdPerHour) * minutes) / 60);
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
