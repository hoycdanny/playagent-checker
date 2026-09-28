import type {
  AcquireSpec,
  DeviceLease,
  DeviceProvider,
  RunResult,
} from './deviceProvider.js';
import {
  extractSecretRefs,
  SecretRefError,
  type ParsedSecretRef,
} from '../api/secretRefs.js';

/**
 * DeviceFarmProvider(Req 4.2 / 14)—— AWS Device Farm 實機(Android/iOS)。
 *
 * 被測身分注入(Req 14):
 * - acquire 前先從案例 YAML 掃出機密引用,逐一驗證只引用**本租戶**機密(extractSecretRefs
 *   對跨租戶引用拋 SecretRefError)。
 * - 機密缺失 → 在任何裝置花費前失敗(Req 14.5):resolveSecrets 找不到值即拋錯,不進 run。
 * - 憑證僅 session 存活期可用(Req 14.2):解析出的明文只在本次 run 的記憶體傳遞,
 *   run 結束即拋棄,不落 S3、不寫報告、不回 API。
 *
 * ⚠ 環境限制誠實標註:開真 Device Farm 實機會計費,故 acquire/run 的「實機真的跑起來
 *    + 用注入憑證完成登入」端到端無法在此驗證。此處落地的是**機密租戶範圍與 session 注入
 *    語義可單元測試的骨架**。真實承載於允許開實機時,替換 startRun/getSecretValue 內部即可。
 */

/** 機密取值(注入以利測試:真實為 Secrets Manager GetSecretValue)。 */
export interface SecretResolver {
  /** 取某機密名稱的明文值;不存在回 null(由呼叫端 Fail before spend)。 */
  getSecretValue(name: string): Promise<string | null>;
}

/** Device Farm 控制面(注入以利測試:真實為 DeviceFarm ScheduleRun/GetRun)。 */
export interface DeviceFarmControl {
  startRun(spec: AcquireSpec): Promise<{ runArn: string }>;
  /** 在實機 session 內執行,注入的機密以記憶體 map 傳入(不落盤)。 */
  execute(
    runArn: string,
    spec: AcquireSpec,
    injectedSecrets: Map<string, string>,
  ): Promise<RunResult>;
  stopRun(runArn: string): Promise<void>;
}

export interface DeviceFarmProviderDeps {
  secrets: SecretResolver;
  farm: DeviceFarmControl;
  /** 案例 YAML 讀取(掃機密引用用)。 */
  readCaseYaml: (spec: AcquireSpec) => Promise<string>;
}

export class DeviceFarmProvider implements DeviceProvider {
  readonly backend = 'devicefarm';

  constructor(private readonly deps: DeviceFarmProviderDeps) {}

  async acquire(spec: AcquireSpec): Promise<DeviceLease> {
    const { runArn } = await this.deps.farm.startRun(spec);
    return {
      endpoint: runArn,
      // Device Farm 提供實機視訊串流;此骨架先給 null,真實承載接上串流 URL 後回填。
      viewUrl: null,
      hostOrigin: 'provisioned',
      resourceId: runArn,
    };
  }

  /**
   * 花費前解析被測身分機密(Req 14.5):任何缺失或跨租戶引用都在 startRun 之後、
   * execute 之前失敗。解析出的明文只在本次呼叫記憶體存活。
   */
  private async resolveSecrets(
    yaml: string,
    tenantId: string,
  ): Promise<Map<string, string>> {
    const refs: ParsedSecretRef[] = extractSecretRefs(yaml, tenantId); // 跨租戶會拋 SecretRefError
    const resolved = new Map<string, string>();
    for (const ref of refs) {
      const value = await this.deps.secrets.getSecretValue(ref.name);
      if (value === null) {
        throw new SecretRefError(`引用的機密不存在(花費前失敗):${ref.name}`);
      }
      resolved.set(ref.name, value);
    }
    return resolved;
  }

  async run(lease: DeviceLease, spec: AcquireSpec): Promise<RunResult> {
    const yaml = await this.deps.readCaseYaml(spec);
    // 花費前:驗證租戶範圍 + 解析機密(缺失即拋,不進實機執行)。
    const injected = await this.resolveSecrets(yaml, spec.tenantId);
    try {
      return await this.deps.farm.execute(lease.endpoint, spec, injected);
    } finally {
      // session 結束即拋棄明文(Req 14.2:憑證僅 session 存活期可用)。
      injected.clear();
    }
  }

  async release(lease: DeviceLease): Promise<void> {
    if (lease.resourceId) {
      await this.deps.farm.stopRun(lease.resourceId);
    }
  }
}
