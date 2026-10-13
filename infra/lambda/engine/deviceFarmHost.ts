import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { DEVICE_FARM_REGION, type DevicePlatform } from './deviceFarm.js';
import { costTagsAsEcs } from './costTags.js';

/**
 * DeviceFarmHost —— engine Lambda 用它啟動 Device Farm 真機探索。
 *
 * 設計要點(為何 engine 只起 task、不做前置):
 *   被測 APK/IPA 常達數百 MB。engine Lambda 記憶體 512MB、逾時 5 分,無法把整包讀進
 *   記憶體再上傳 Device Farm + 等真機 session RUNNING(實測 456MB APK 直接撐爆並逾時)。
 *   因此所有重活(讀 APK、上傳、開 session、Appium 迴圈)全部搬進 ECS Fargate 容器內的
 *   explorationRunner —— Fargate 有較大記憶體且無時限,可從 S3 串流 APK。
 *
 * engine 這裡只做一件事:以 RunTask 啟動 Fargate task,把 S3 位置 / 被測產物 key / VLM /
 * 探索目標等以環境變數注入,立即返回(不 block)。真機有真實網路/GMS,可通過遊戲伺服器
 * 對模擬器環境的檢查(解決 Redroid 的 50019999)。
 */

const DATA_REGION = process.env.AWS_REGION ?? 'us-west-2';
const DF_PROJECT_NAME = 'playagent-checker';

// CDK 注入:Fargate 執行所需。
const ECS_CLUSTER = process.env.DF_ECS_CLUSTER ?? '';
const ECS_TASK_DEF = process.env.DF_ECS_TASK_DEF ?? '';
const ECS_SUBNETS = (process.env.DF_ECS_SUBNETS ?? '').split(',').filter(Boolean);
const ECS_SECURITY_GROUP = process.env.DF_ECS_SG ?? '';
const ECS_CONTAINER_NAME = process.env.DF_ECS_CONTAINER ?? 'exploration-runner';
// UI-TARS SageMaker endpoint 名(CDK 注入)。使用者選 vlmModel='uitars' 時,把它以 PA_UITARS_ENDPOINT
// 傳進 runner,runner 就改用 UI-TARS 做定位(見 agent/uitarsClient.mjs)。留空則走 Bedrock 通用 VLM。
const UITARS_ENDPOINT = process.env.UITARS_ENDPOINT ?? '';

const ecs = new ECSClient({ region: DATA_REGION });

export interface DeviceFarmRunParams {
  tenantId: string;
  jobId: string;
  appId: string;
  bucket: string;
  prefix: string; // tenants/<t>/jobs/<jobId>
  artifactKey: string;
  package?: string;
  platform?: DevicePlatform;
  vlmModel?: string;
  /** 決策 Agent 模型(agent seat);runner 每步規劃目標。 */
  agentModel?: string;
  /** 輔助 Agent 模型(subagent seat);runner 每步核對效果、整理數據、核對完成。 */
  subagentModel?: string;
  caseTask?: string;
  /** 步數上限;未給代表無上限(runner 端 PA_MAXSTEPS 不設 = Infinity)。 */
  maxSteps?: number;
  maxOsVersion?: number;
  minOsVersion?: number;
  /** 使用者提交時明選的實體裝置 ARN(runner 短路直接用此台真機)。 */
  deviceArn?: string;
  /** 使用者提交時所選機型名稱(顯示用,runner 取不到 session model 時的後備)。 */
  deviceModel?: string;
}

export interface DeviceFarmRunResult {
  ecsTaskArn: string;
}

/**
 * 啟動 Fargate 探索 task(不 block)。task 內的 runner 會自行讀 APK、上傳 Device Farm、
 * 開真機 session 並跑 Appium 探索迴圈,終態由 runner 寫回 S3。
 * 只在「環境未配置」或「RunTask 失敗」時拋錯,由 engine 落 error 終態。
 */
export async function startDeviceFarmRun(
  params: DeviceFarmRunParams,
): Promise<DeviceFarmRunResult> {
  if (!ECS_CLUSTER || !ECS_TASK_DEF || ECS_SUBNETS.length === 0) {
    throw new Error(
      'Device Farm 執行環境未配置(需 DF_ECS_CLUSTER / DF_ECS_TASK_DEF / DF_ECS_SUBNETS)',
    );
  }
  const platform = params.platform ?? 'android';

  const env: Array<{ name: string; value: string }> = [
    { name: 'PA_ARTIFACT_KEY', value: params.artifactKey },
    { name: 'PA_PLATFORM', value: platform },
    { name: 'PA_JOB', value: params.jobId },
    { name: 'PA_TENANT', value: params.tenantId },
    { name: 'PA_APP', value: params.appId },
    { name: 'PA_BUCKET', value: params.bucket },
    { name: 'PA_PREFIX', value: params.prefix },
    { name: 'PA_DATA_REGION', value: DATA_REGION },
    { name: 'PA_DF_REGION', value: DEVICE_FARM_REGION },
    { name: 'PA_DF_PROJECT', value: DF_PROJECT_NAME },
    { name: 'PA_VLM', value: params.vlmModel ?? '' },
    { name: 'PA_AGENT_MODEL', value: params.agentModel ?? '' },
    { name: 'PA_SUBAGENT_MODEL', value: params.subagentModel ?? '' },
    { name: 'PA_PKG', value: params.package ?? '' },
    { name: 'PA_TASK', value: params.caseTask ?? '' },
    // 使用者選 UI-TARS 定位:把 endpoint 名傳給 runner(需 endpoint 已部署 InService)。
    ...(params.vlmModel === 'uitars' && UITARS_ENDPOINT
      ? [{ name: 'PA_UITARS_ENDPOINT', value: UITARS_ENDPOINT }]
      : []),
    // 步數上限:僅在使用者設了有限值時注入;不設 = runner 端無上限。
    ...(params.maxSteps && params.maxSteps > 0
      ? [{ name: 'PA_MAXSTEPS', value: String(params.maxSteps) }]
      : []),
    ...(params.maxOsVersion !== undefined
      ? [{ name: 'PA_MAX_OS', value: String(params.maxOsVersion) }]
      : []),
    ...(params.minOsVersion !== undefined
      ? [{ name: 'PA_MIN_OS', value: String(params.minOsVersion) }]
      : []),
    // 使用者明選的裝置:ARN 讓 runner 短路挑此台真機;model 供 runner 取不到 session 機型時後備顯示。
    ...(params.deviceArn ? [{ name: 'PA_DEVICE_ARN', value: params.deviceArn }] : []),
    ...(params.deviceModel ? [{ name: 'PA_DEVICE_MODEL', value: params.deviceModel }] : []),
  ];

  const runResp = await ecs.send(
    new RunTaskCommand({
      cluster: ECS_CLUSTER,
      taskDefinition: ECS_TASK_DEF,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ECS_SUBNETS,
          assignPublicIp: 'ENABLED', // 需出網連 Device Farm(us-west-2)與 Bedrock/S3
          ...(ECS_SECURITY_GROUP ? { securityGroups: [ECS_SECURITY_GROUP] } : {}),
        },
      },
      overrides: {
        containerOverrides: [{ name: ECS_CONTAINER_NAME, environment: env }],
      },
      // 成本分攤標籤:讓執行期 Fargate task 也能在 Cost Explorer 依同一組標籤歸屬。
      ...(costTagsAsEcs().length > 0 ? { tags: costTagsAsEcs() } : {}),
    }),
  );
  const ecsTaskArn = runResp.tasks?.[0]?.taskArn;
  if (!ecsTaskArn) {
    const reason = runResp.failures?.[0]?.reason ?? '未知';
    throw new Error(`啟動 Fargate 探索 task 失敗: ${reason}`);
  }

  return { ecsTaskArn };
}
