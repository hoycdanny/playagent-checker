import type { Action, ActionResult } from '../../domain/action.js';
import type { Artifact } from '../../domain/artifact.js';
import type { Size } from '../../domain/coordinates.js';
import type { Health, MetricSample } from '../../domain/metrics.js';
import { createWorkerStateMachine, type WorkerState } from '../../domain/stateMachine.js';
import {
  EnvironmentError,
  PlatformNotReadyError,
  type BuildInput,
  type EnvironmentConfig,
  type GameWorker,
  type Screenshot,
} from '../GameWorker.js';

/**
 * Windows Worker(EC2 G6 + Windows Server + NVIDIA GRID 驅動)。
 *
 * 這一層只做「平台無關的流程與檢查」(狀態機、解析度驗證、動作分派);
 * 真正碰 OS 的部分交給 WindowsHostAgent —— 在 Windows 主機上執行的原生 helper
 * (SendInput 送滑鼠/鍵盤、DXGI Desktop Duplication 截圖、NVENC 錄影、PDH/nvidia-smi 指標、
 * Event Log)。Helper 尚未實作前,所有方法會丟 PlatformNotReadyError,不會假裝成功。
 *
 * 已知限制(要在 PoC 驗證後才能保證):
 *  - 1080×4096 直向:GRID 驅動單一虛擬顯示器上限是 4096 寬;做法是建立 4096×1080 模式再旋轉成直向,
 *    遊戲真的以 1080×4096 渲染。實際能否設定成功要在 G6 上實測(prepareEnvironment 會驗證 framebuffer)。
 *  - 遊戲需要互動式桌面(AutoLogon 進 console session);Session 0 的服務看不到畫面,也收不到輸入。
 *  - 部分遊戲(DirectInput / Raw Input / 反作弊)會忽略 SendInput 合成事件,需要虛擬 HID 驅動(例如 ViGEm)。
 */
export interface WindowsHostAgent {
  createDisplay(width: number, height: number, refreshRate: number): Promise<Size>;
  install(localPath: string): Promise<{ executable: string }>;
  launch(executable: string): Promise<{ pid: number }>;
  terminate(pid: number): Promise<void>;
  sendInput(action: Action): Promise<ActionResult>;
  capture(): Promise<Screenshot>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Artifact[]>;
  metrics(pid: number | null): Promise<MetricSample>;
  health(pid: number | null): Promise<Health>;
  collectLogs(): Promise<Artifact[]>;
}

const NOT_READY = 'Windows 主機 helper(WindowsHostAgent)尚未實作:需要 SendInput / DXGI 截圖 / NVENC 錄影的原生程式,見 docs/design/multi-platform-workers.md 第 4 節';

/** 沒有 helper 時的預設:每個方法都誠實回報「平台尚未就緒」。 */
export const unavailableWindowsAgent: WindowsHostAgent = new Proxy({} as WindowsHostAgent, {
  get: () => async () => { throw new PlatformNotReadyError(NOT_READY); },
});

export class WindowsWorker implements GameWorker {
  readonly platform = 'windows' as const;
  readonly #sm = createWorkerStateMachine();
  #exe: string | null = null;
  #pid: number | null = null;

  constructor(private readonly agent: WindowsHostAgent = unavailableWindowsAgent) {}

  get state(): WorkerState {
    return this.#sm.state;
  }

  async initialize(): Promise<void> {
    this.#sm.transition('BOOTING');
    // 主機開機與 AutoLogon 由 AMI / userdata 完成;這裡確認 helper 可用(先做一次健康檢查)。
    try {
      await this.agent.health(null);
      this.#sm.transition('READY');
    } catch (e) {
      this.#sm.transition('FAILED', String(e));
      throw e;
    }
  }

  async prepareEnvironment(config: EnvironmentConfig): Promise<{ framebuffer: Size }> {
    this.#sm.transition('PREPARING');
    const { width, height, refreshRate } = config.display;
    const fb = await this.agent.createDisplay(width, height, refreshRate);
    // 禁止「低解析度渲染再縮放」:實際 framebuffer 必須完全等於設定。
    if (fb.width !== width || fb.height !== height) {
      this.#sm.transition('FAILED', 'framebuffer mismatch');
      throw new EnvironmentError(`實際顯示 ${fb.width}×${fb.height} 和設定 ${width}×${height} 不符`);
    }
    return { framebuffer: fb };
  }

  async installGame(build: BuildInput): Promise<void> {
    this.#sm.transition('INSTALLING');
    const { executable } = await this.agent.install(build.localPath);
    this.#exe = executable;
  }

  async startGame(): Promise<void> {
    if (!this.#exe) throw new Error('尚未安裝遊戲');
    this.#pid = (await this.agent.launch(this.#exe)).pid;
    if (this.#sm.state !== 'RUNNING') this.#sm.transition('RUNNING');
  }

  async stopGame(): Promise<void> {
    if (this.#pid !== null) await this.agent.terminate(this.#pid);
    this.#pid = null;
  }

  executeAction(action: Action): Promise<ActionResult> {
    return this.agent.sendInput(action);
  }
  screenshot(): Promise<Screenshot> {
    return this.agent.capture();
  }
  startRecording(): Promise<void> {
    return this.agent.startRecording();
  }
  stopRecording(): Promise<Artifact[]> {
    return this.agent.stopRecording();
  }
  getMetrics(): Promise<MetricSample> {
    return this.agent.metrics(this.#pid);
  }
  checkHealth(): Promise<Health> {
    return this.agent.health(this.#pid);
  }
  collectLogs(): Promise<Artifact[]> {
    return this.agent.collectLogs();
  }

  async restartGame(): Promise<void> {
    if (this.#sm.state === 'RUNNING') this.#sm.transition('RECOVERING', 'restartGame');
    await this.stopGame();
    await this.startGame();
  }

  async restartEnvironment(): Promise<void> {
    // Windows 主機重開機會中斷 runner 本身,由 Scheduler 的 worker retry 換一台處理。
    throw new PlatformNotReadyError('Windows 不在 Worker 內重開主機;改由 Scheduler 的 worker retry 換一台');
  }

  beginCollecting(): void {
    this.#sm.transition('COLLECTING_ARTIFACTS');
  }
  finish(outcome: 'completed' | 'failed'): void {
    this.#sm.transition(outcome === 'completed' ? 'COMPLETED' : 'FAILED');
  }
  async cleanup(): Promise<void> {
    await this.stopGame().catch(() => undefined);
    if (this.#sm.state !== 'TERMINATED') this.#sm.transition('TERMINATED');
  }
}
