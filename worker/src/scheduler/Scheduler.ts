import type { JobConfig } from '../domain/job.js';
import type { Platform } from '../domain/platform.js';

/**
 * Scheduler:依 Worker 的容量決定要排到哪一台,不盲目塞 job。
 * 這裡只有純邏輯(可單元測試);實際的 Worker 註冊表(DynamoDB)與佇列(SQS)接在外層。
 */
export interface WorkerCapacity {
  workerId: string;
  platform: Platform;
  instanceType: string;
  purchase: 'on-demand' | 'spot';
  healthy: boolean;
  /** 收到 Spot 中斷通知 / 正在排空:不再派新 job。 */
  draining: boolean;
  cpu: { total: number; reserved: number };
  ramMb: { total: number; reserved: number };
  gpu: { total: number; reserved: number };
  maxSessions: number;
  activeSessions: number;
  /** 這台能設定的解析度(Windows/Linux 看 GPU 驅動;Android/iOS 看映像)。 */
  resolutions: ReadonlyArray<readonly [number, number]>;
}

export interface SessionRequirement {
  platform: Platform;
  cpu: number;
  ramMb: number;
  gpu: number;
  width: number;
  height: number;
  allowSpot: boolean;
}

/** 每個平台一個 session 的資源預估(Phase 7 依實測調整)。 */
export const SESSION_FOOTPRINT: Record<Platform, { cpu: number; ramMb: number; gpu: number }> = {
  // Emulator 無 GPU(swiftshader):4 vCPU / 6 GB 一個 session。
  android: { cpu: 4, ramMb: 6144, gpu: 0 },
  // EC2 Mac 一台同時跑 2 個 Simulator 比較穩。
  ios: { cpu: 4, ramMb: 6144, gpu: 0 },
  // 一張 L4 一個遊戲(高解析度直向顯示器)。
  windows: { cpu: 4, ramMb: 8192, gpu: 1 },
  linux: { cpu: 4, ramMb: 8192, gpu: 1 },
};

export function requirementFor(job: Pick<JobConfig, 'platform' | 'display' | 'allowSpot'>): SessionRequirement {
  const f = SESSION_FOOTPRINT[job.platform];
  return { platform: job.platform, ...f, width: job.display.width, height: job.display.height, allowSpot: job.allowSpot };
}

export type ScheduleDecision =
  | { ok: true; workerId: string; purchase: 'on-demand' | 'spot' }
  | { ok: false; reason: 'no_worker_for_platform' | 'no_capacity' | 'resolution_unsupported'; scaleOut: boolean };

const supports = (w: WorkerCapacity, r: SessionRequirement) =>
  w.resolutions.some(([a, b]) => (a === r.width && b === r.height) || (a === r.height && b === r.width));
const fits = (w: WorkerCapacity, r: SessionRequirement) =>
  w.activeSessions < w.maxSessions
  && w.cpu.total - w.cpu.reserved >= r.cpu
  && w.ramMb.total - w.ramMb.reserved >= r.ramMb
  && w.gpu.total - w.gpu.reserved >= r.gpu;

/**
 * 選 Worker:平台相符、健康、沒在排空、解析度支援、資源夠。
 * 偏好:允許 Spot 時先用 Spot(便宜)→ 負載最低 → 剩餘 CPU 最少(bin packing,讓空機可以縮掉)。
 * 沒有可用的 → 告訴外層要不要擴容(scaleOut)。
 */
export function pickWorker(workers: readonly WorkerCapacity[], r: SessionRequirement): ScheduleDecision {
  const sameOs = workers.filter((w) => w.platform === r.platform && w.healthy && !w.draining && (r.allowSpot || w.purchase === 'on-demand'));
  if (!sameOs.length) return { ok: false, reason: 'no_worker_for_platform', scaleOut: true };
  const resOk = sameOs.filter((w) => supports(w, r));
  if (!resOk.length) return { ok: false, reason: 'resolution_unsupported', scaleOut: false };
  const candidates = resOk.filter((w) => fits(w, r));
  if (!candidates.length) return { ok: false, reason: 'no_capacity', scaleOut: true };
  candidates.sort((a, b) =>
    (a.purchase === 'spot' ? 0 : 1) - (b.purchase === 'spot' ? 0 : 1)
    || a.activeSessions / a.maxSessions - b.activeSessions / b.maxSessions
    || (a.cpu.total - a.cpu.reserved) - (b.cpu.total - b.cpu.reserved)
    || a.workerId.localeCompare(b.workerId));
  const w = candidates[0]!;
  return { ok: true, workerId: w.workerId, purchase: w.purchase };
}

/** 派出後保留資源(回傳新的容量;不改輸入)。 */
export function reserve(w: WorkerCapacity, r: SessionRequirement): WorkerCapacity {
  if (!fits(w, r)) throw new Error(`Worker ${w.workerId} 容量不足`);
  return {
    ...w,
    activeSessions: w.activeSessions + 1,
    cpu: { ...w.cpu, reserved: w.cpu.reserved + r.cpu },
    ramMb: { ...w.ramMb, reserved: w.ramMb.reserved + r.ramMb },
    gpu: { ...w.gpu, reserved: w.gpu.reserved + r.gpu },
  };
}

export function release(w: WorkerCapacity, r: SessionRequirement): WorkerCapacity {
  return {
    ...w,
    activeSessions: Math.max(0, w.activeSessions - 1),
    cpu: { ...w.cpu, reserved: Math.max(0, w.cpu.reserved - r.cpu) },
    ramMb: { ...w.ramMb, reserved: Math.max(0, w.ramMb.reserved - r.ramMb) },
    gpu: { ...w.gpu, reserved: Math.max(0, w.gpu.reserved - r.gpu) },
  };
}
