import type { Action, ActionResult } from '../domain/action.js';
import type { Artifact, ArtifactKind } from '../domain/artifact.js';
import type { Size } from '../domain/coordinates.js';
import type { Display } from '../domain/display.js';
import type { Health, MetricSample } from '../domain/metrics.js';
import type { Platform } from '../domain/platform.js';
import type { WorkerState } from '../domain/stateMachine.js';

/**
 * 所有平台共用的 Worker 介面。AI 迴圈(runner)與 Scheduler 只依賴這個介面,
 * 不出現 adb / simctl / PowerShell / xdotool 這類平台指令。
 */
export interface Screenshot {
  png: Buffer;
  /** 截圖實際像素尺寸(= 裝置輸入座標空間)。 */
  size: Size;
  at: string;
}

export interface BuildInput {
  /** 已下載到 Worker 本機的檔案(或 split APK 目錄)路徑。 */
  localPath: string;
  /** package / bundle id / exe 相對路徑 / 執行檔相對路徑。 */
  entry: string;
}

export interface EnvironmentConfig {
  display: Display;
}

/** 證據上傳(S3,用 Worker 的 IAM Role);Worker 只產生內容,不管存放位置。 */
export interface ArtifactSink {
  put(kind: ArtifactKind, name: string, body: Buffer, contentType: string, step?: number): Promise<Artifact>;
}

export interface GameWorker {
  readonly platform: Platform;
  readonly state: WorkerState;

  /** 啟動裝置(Emulator / Simulator / 虛擬顯示器)並等到可用。 */
  initialize(): Promise<void>;
  /** 設定解析度並驗證實際 framebuffer;不一致要丟 EnvironmentError。 */
  prepareEnvironment(config: EnvironmentConfig): Promise<{ framebuffer: Size }>;
  installGame(build: BuildInput): Promise<void>;
  startGame(): Promise<void>;
  stopGame(): Promise<void>;
  /** 動作座標是「裝置空間」;模型空間的轉換在呼叫端用 coordinates.toDevice() 先做。 */
  executeAction(action: Action): Promise<ActionResult>;
  screenshot(): Promise<Screenshot>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Artifact[]>;
  getMetrics(): Promise<MetricSample>;
  /** watchdog 用:裝置連線、開機、遊戲程序、ANR / crash。 */
  checkHealth(): Promise<Health>;
  /** 收 log 並上傳,回傳 artifact。 */
  collectLogs(): Promise<Artifact[]>;
  restartGame(): Promise<void>;
  restartEnvironment(): Promise<void>;
  /** 測試結束:進入收證據階段(失敗也要收)。 */
  beginCollecting(): void;
  /** 收完證據:COMPLETED 或 FAILED(同一台可再接下一個 session)。 */
  finish(outcome: 'completed' | 'failed'): void;
  cleanup(): Promise<void>;
}

/** 環境問題(Emulator 起不來、解析度設不上、ADB 斷線)→ Job 標記 ENVIRONMENT_ERROR,不是測試失敗。 */
export class EnvironmentError extends Error {
  override name = 'EnvironmentError';
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

/** 平台還沒有可靠的實作(誠實回報,不假裝成功)。 */
export class PlatformNotReadyError extends Error {
  override name = 'PlatformNotReadyError';
}

/** PNG IHDR 取寬高(偏移 16..23,大端)。不是 PNG 回 null。 */
export function pngSize(buf: Buffer): Size | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width && height ? { width, height } : null;
}
