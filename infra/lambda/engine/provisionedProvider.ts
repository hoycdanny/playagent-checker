import type { S3Client } from '@aws-sdk/client-s3';
import type {
  AcquireSpec,
  DeviceLease,
  DeviceProvider,
  RunResult,
} from './deviceProvider.js';

/**
 * 雲端供給(provisioned)裝置 Provider —— Emulator(Redroid)與 Windows 共用同一生命週期骨架。
 *
 * 生命週期(Req 4.3/4.5/4.6):
 *   acquire  → 動態 RunInstances 起一台專屬主機(帶 hostLifecycle=per-job + jobId tag)
 *   run      → 引擎在該主機上跑逐步流程,寫 step/screenshot 到 S3
 *   release  → 終局(pass/fail/error/cancelled)即 TerminateInstances 回收主機與併發槽
 *
 * 回收前提(Req 4.6):以「容器/實例確認終結」為釋放併發槽的前提,避免殭屍主機佔額度。
 * 常駐主機(hostOrigin=attached / 使用者標記為 reusable)絕不由此路徑銷毀(Req 4.5)。
 *
 * ⚠ 環境限制誠實標註:此建置環境無 Docker daemon,且開真 EC2 會計費,
 *    因此 acquire/run 的「主機真的起來跑 Redroid/Appium」端到端無法在此驗證。
 *    此處落地的是**回收正確性可單元測試的生命週期骨架** + IaC(per-job-host construct)。
 *    真實承載於 Docker/EC2 可用時,替換 provisionHost/terminateHost 內部實作即可,介面不變。
 */

export type ProvisionedKind = 'emulator' | 'windows';

/** 主機控制面(注入以利測試:真實為 EC2 RunInstances/TerminateInstances)。 */
export interface HostControl {
  /** 起一台專屬主機,回 instanceId 與控制端點。 */
  provisionHost(spec: AcquireSpec, kind: ProvisionedKind): Promise<{
    instanceId: string;
    endpoint: string;
  }>;
  /** 終結主機(冪等:已終結再呼叫不報錯)。 */
  terminateHost(instanceId: string): Promise<void>;
  /** 確認主機是否已終結(釋放併發槽的前提,Req 4.6)。 */
  isTerminated(instanceId: string): Promise<boolean>;
}

/** 在主機上跑引擎迴圈(注入以利測試:真實為 ADB/Appium 驅動 + VLM 逐步)。 */
export interface HostRunner {
  runOnHost(
    s3: S3Client,
    lease: DeviceLease,
    spec: AcquireSpec,
    kind: ProvisionedKind,
  ): Promise<RunResult>;
}

export interface ProvisionedProviderDeps {
  s3: S3Client;
  host: HostControl;
  runner: HostRunner;
}

export class ProvisionedProvider implements DeviceProvider {
  readonly backend: ProvisionedKind;

  constructor(
    kind: ProvisionedKind,
    private readonly deps: ProvisionedProviderDeps,
  ) {
    this.backend = kind;
  }

  async acquire(spec: AcquireSpec): Promise<DeviceLease> {
    const { instanceId, endpoint } = await this.deps.host.provisionHost(
      spec,
      this.backend,
    );
    return {
      endpoint,
      // Emulator 有畫面串流(scrcpy/CDP);Windows 有互動式桌面。此處骨架先給 null,
      // 真實承載接上串流 URL 後回填(Req 5.3 無畫面才回 null)。
      viewUrl: null,
      hostOrigin: 'provisioned',
      resourceId: instanceId,
    };
  }

  async run(lease: DeviceLease, spec: AcquireSpec): Promise<RunResult> {
    return this.deps.runner.runOnHost(this.deps.s3, lease, spec, this.backend);
  }

  /**
   * 終局回收(Req 4.6):只回收 provisioned 主機,且以「確認終結」為完成前提。
   * 常駐/attached 主機不由此銷毀(Req 4.5)。
   */
  async release(lease: DeviceLease): Promise<void> {
    if (lease.hostOrigin !== 'provisioned') {
      // 常駐主機:絕不終結。
      return;
    }
    if (!lease.resourceId) return;
    await this.deps.host.terminateHost(lease.resourceId);
    // 併發槽釋放前提:確認實例已終結,否則視為未回收(留給 Lifecycle 逾時清)。
    const done = await this.deps.host.isTerminated(lease.resourceId);
    if (!done) {
      throw new Error(
        `主機 ${lease.resourceId} 尚未確認終結,併發槽不釋放(避免殭屍主機)`,
      );
    }
  }
}
