/**
 * UI-TARS 開關(系統管理頁,admin 專用)。
 *
 * UI-TARS 是部署在 SageMaker 的 GPU endpoint(ml.g6e.xlarge,開著就按小時計費,不管有沒有任務)。
 * 所以做成可開關、預設關閉:
 *   - 開啟 = 建 Model / EndpointConfig(不存在才建,兩者本身不收費)→ CreateEndpoint(冷啟 10~15 分鐘)
 *   - 關閉 = DeleteEndpoint(保留 Model / EndpointConfig,下次開啟直接用)
 * 「目前開或關」以 endpoint 實際狀態為準,不另存旗標,避免旗標與 AWS 實況不一致。
 *
 * endpoint 名固定(預設 ui-tars-playagent),引擎與 runner 永遠用同一個名字,開關不需要重新部署。
 * 核心邏輯只依賴 UitarsPorts,可用 fake 做單元測試;真實 AWS 實作在 makeUitarsPorts。
 */
import {
  SageMakerClient,
  DescribeEndpointCommand,
  DescribeModelCommand,
  DescribeEndpointConfigCommand,
  CreateModelCommand,
  CreateEndpointConfigCommand,
  CreateEndpointCommand,
  DeleteEndpointCommand,
} from '@aws-sdk/client-sagemaker';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

/** 介面上呈現的狀態。 */
export type UitarsState = 'off' | 'starting' | 'on' | 'stopping' | 'failed';

export interface UitarsAudit {
  action: 'enable' | 'disable';
  by: string;
  at: string;
}

export interface UitarsStatus {
  state: UitarsState;
  /** SageMaker 原始狀態(除錯用;endpoint 不存在時沒有)。 */
  endpointStatus?: string;
  failureReason?: string;
  endpointName: string;
  instanceType: string;
  /** 最後一次由介面開/關的紀錄。 */
  last?: UitarsAudit;
}

export interface UitarsConfig {
  region: string;
  bucket: string;
  endpointName: string;
  modelName: string;
  configName: string;
  instanceType: string;
  /** vLLM BYOC 映像 URI。 */
  image: string;
  /** 模型權重(未壓縮 S3 字首)。 */
  modelDataS3: string;
  /** SageMaker 執行角色(拉映像 + 讀權重)。 */
  executionRoleArn: string;
  /** 開關紀錄的 S3 key(_system/ 前綴)。 */
  auditKey: string;
  /** 套到 SageMaker 資源的成本標籤。 */
  tags: Record<string, string>;
}

export interface UitarsPorts {
  /** endpoint 不存在回 null。 */
  describeEndpoint(): Promise<{ status: string; failureReason?: string } | null>;
  modelExists(): Promise<boolean>;
  configExists(): Promise<boolean>;
  createModel(): Promise<void>;
  createConfig(): Promise<void>;
  createEndpoint(): Promise<void>;
  deleteEndpoint(): Promise<void>;
  readAudit(): Promise<UitarsAudit | null>;
  writeAudit(a: UitarsAudit): Promise<void>;
}

/** 開關被拒(狀態轉換中、或已經是目標狀態以外的衝突)。路由回 409。 */
export class UitarsSwitchError extends Error {}

/** SageMaker EndpointStatus → 介面狀態。 */
export function toState(endpointStatus: string | null): UitarsState {
  switch (endpointStatus) {
    case null:
      return 'off';
    case 'InService':
      return 'on';
    case 'Creating':
    case 'Updating':
    case 'SystemUpdating':
    case 'RollingBack':
      return 'starting';
    case 'Deleting':
      return 'stopping';
    default:
      // Failed / OutOfService 等:endpoint 還在(仍可能計費),要讓管理員看見並能關掉。
      return 'failed';
  }
}

export async function getUitarsStatus(ports: UitarsPorts, cfg: Pick<UitarsConfig, 'endpointName' | 'instanceType'>): Promise<UitarsStatus> {
  const [ep, last] = await Promise.all([ports.describeEndpoint(), ports.readAudit().catch(() => null)]);
  return {
    state: toState(ep ? ep.status : null),
    ...(ep ? { endpointStatus: ep.status } : {}),
    ...(ep?.failureReason ? { failureReason: ep.failureReason } : {}),
    endpointName: cfg.endpointName,
    instanceType: cfg.instanceType,
    ...(last ? { last } : {}),
  };
}

/** UI-TARS 目前能不能用(提交任務 / 模型清單用)。讀不到狀態一律當作不能用。 */
export async function uitarsAvailable(ports: UitarsPorts): Promise<boolean> {
  try {
    const ep = await ports.describeEndpoint();
    return toState(ep ? ep.status : null) === 'on';
  } catch {
    return false;
  }
}

/**
 * 開或關。冪等:已經是目標狀態(或正在往目標狀態走)就直接回目前狀態。
 * 轉換中往反方向切換會被拒(SageMaker 不允許刪除 Creating 中途以外的大多數轉換,且容易留下殘局)。
 */
export async function setUitars(
  ports: UitarsPorts,
  cfg: Pick<UitarsConfig, 'endpointName' | 'instanceType'>,
  enabled: boolean,
  by: string,
): Promise<UitarsStatus> {
  const ep = await ports.describeEndpoint();
  const state = toState(ep ? ep.status : null);

  if (enabled) {
    if (state === 'on' || state === 'starting') return getUitarsStatus(ports, cfg);
    if (state === 'stopping') throw new UitarsSwitchError('UI-TARS 正在關閉中,請等它關完再開啟');
    if (state === 'failed') throw new UitarsSwitchError('UI-TARS 上次啟動失敗,請先關閉再重新開啟');
    // Model / EndpointConfig 不收費,保留重用;不存在才建。
    if (!(await ports.modelExists())) await ports.createModel();
    if (!(await ports.configExists())) await ports.createConfig();
    await ports.createEndpoint();
  } else {
    if (state === 'off' || state === 'stopping') return getUitarsStatus(ports, cfg);
    if (state === 'starting' && ep?.status !== 'Creating') {
      throw new UitarsSwitchError('UI-TARS 正在更新中,請等它完成再關閉');
    }
    // InService / Failed / Creating 都可以直接刪(Creating 中刪除會中止啟動,不再計費)。
    await ports.deleteEndpoint();
  }

  await ports
    .writeAudit({ action: enabled ? 'enable' : 'disable', by, at: new Date().toISOString() })
    .catch(() => {});
  return getUitarsStatus(ports, cfg);
}

function isNotFound(err: unknown): boolean {
  // SageMaker 對不存在的資源回 ValidationException("Could not find ...")。
  return err instanceof Error && (err.name === 'ValidationException' || err.name === 'ResourceNotFound') && /could not find|not found|does not exist/i.test(err.message);
}

export function makeUitarsPorts(cfg: UitarsConfig, s3: S3Client): UitarsPorts {
  const sm = new SageMakerClient({ region: cfg.region });
  const tags = Object.entries(cfg.tags).map(([Key, Value]) => ({ Key, Value }));

  return {
    async describeEndpoint() {
      try {
        const r = await sm.send(new DescribeEndpointCommand({ EndpointName: cfg.endpointName }));
        return {
          status: r.EndpointStatus ?? 'Unknown',
          ...(r.FailureReason ? { failureReason: r.FailureReason } : {}),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async modelExists() {
      try {
        await sm.send(new DescribeModelCommand({ ModelName: cfg.modelName }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async configExists() {
      try {
        await sm.send(new DescribeEndpointConfigCommand({ EndpointConfigName: cfg.configName }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    // 參數與 agent/sagemaker/deployUitars.mjs 一致(該腳本含下載/上傳/建映像,這裡只做最後一步)。
    async createModel() {
      await sm.send(new CreateModelCommand({
        ModelName: cfg.modelName,
        PrimaryContainer: {
          Image: cfg.image,
          ModelDataSource: { S3DataSource: { S3Uri: cfg.modelDataS3, S3DataType: 'S3Prefix', CompressionType: 'None' } },
          Environment: {
            MODEL_ID: 'ByteDance-Seed/UI-TARS-1.5-7B',
            SERVED_MODEL_NAME: 'default',
            MAX_MODEL_LEN: '32768',
            DTYPE: 'bfloat16',
            MODEL_TYPE: 'multimodal',
            SAGEMAKER_BIND_TO_PORT: '8080',
            VLLM_WORKER_MULTIPROC_METHOD: 'spawn',
          },
        },
        ExecutionRoleArn: cfg.executionRoleArn,
        Tags: tags,
      }));
    },

    async createConfig() {
      await sm.send(new CreateEndpointConfigCommand({
        EndpointConfigName: cfg.configName,
        ProductionVariants: [{
          VariantName: 'AllTraffic',
          ModelName: cfg.modelName,
          InitialInstanceCount: 1,
          InstanceType: cfg.instanceType as never,
          ContainerStartupHealthCheckTimeoutInSeconds: 1800,
          ModelDataDownloadTimeoutInSeconds: 1800,
        }],
        Tags: tags,
      }));
    },

    async createEndpoint() {
      await sm.send(new CreateEndpointCommand({
        EndpointName: cfg.endpointName,
        EndpointConfigName: cfg.configName,
        Tags: tags,
      }));
    },

    async deleteEndpoint() {
      await sm.send(new DeleteEndpointCommand({ EndpointName: cfg.endpointName }));
    },

    async readAudit() {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.auditKey }));
        const v = JSON.parse((await r.Body?.transformToString()) ?? 'null') as UitarsAudit | null;
        return v && typeof v.action === 'string' ? v : null;
      } catch {
        return null;
      }
    },

    async writeAudit(a) {
      await s3.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: cfg.auditKey,
        Body: JSON.stringify(a),
        ContentType: 'application/json',
      }));
    },
  };
}

/** 從環境變數組設定(CDK 注入);缺必要值回 null,路由回 501。 */
export function uitarsConfigFromEnv(env: NodeJS.ProcessEnv, region: string, bucket: string): UitarsConfig | null {
  const endpointName = env.UITARS_ENDPOINT_NAME ?? '';
  const image = env.UITARS_IMAGE ?? '';
  const modelDataS3 = env.UITARS_MODEL_S3 ?? '';
  const executionRoleArn = env.UITARS_ROLE_ARN ?? '';
  if (!endpointName || !image || !modelDataS3 || !executionRoleArn) return null;
  let tags: Record<string, string> = {};
  try { tags = JSON.parse(env.UITARS_TAGS ?? '{}') as Record<string, string>; } catch { tags = {}; }
  return {
    region,
    bucket,
    endpointName,
    modelName: `${endpointName}-model`,
    configName: `${endpointName}-config`,
    instanceType: env.UITARS_INSTANCE ?? 'ml.g6e.xlarge',
    image,
    modelDataS3,
    executionRoleArn,
    auditKey: '_system/uitars.json',
    tags,
  };
}
