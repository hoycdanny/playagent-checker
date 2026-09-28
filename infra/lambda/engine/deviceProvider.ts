import type { TaskState } from '../api/status.js';

/**
 * 統一裝置抽象(Req 4.1)—— 引擎恆在雲端,透過此介面接入所有後端,不為每種裝置分叉引擎。
 * 各 Provider 的 acquire/endpoint/viewUrl/release 語義相同,差異只在承載形態。
 */
export interface DeviceLease {
  /** 引擎控制目標端點(ADB / Appium / CDP / attached 通道)。 */
  endpoint: string;
  /** Live View URL;無畫面後端(如無伺服器 fetch)為 null(Req 5.3)。 */
  viewUrl: string | null;
  /** 主機出處:動態建立(任務終態銷毀)vs 接入常駐(不銷毀)(Req 4.5/4.6)。 */
  hostOrigin: 'provisioned' | 'attached';
  /** 供回收用的資源識別(instanceId / sessionArn / connectionId)。 */
  resourceId?: string;
}

export interface AcquireSpec {
  tenantId: string;
  jobId: string;
  /** APK/IPA ABI 等,供選實例族。 */
  abi?: string;
}

export interface RunResult {
  state: TaskState;
  steps: number;
  message: string;
}

export interface DeviceProvider {
  readonly backend: string;
  acquire(spec: AcquireSpec): Promise<DeviceLease>;
  /** 在租約的裝置上執行引擎迴圈,寫 step/screenshot 到 S3,回終態。 */
  run(lease: DeviceLease, spec: AcquireSpec): Promise<RunResult>;
  release(lease: DeviceLease): Promise<void>;
}
