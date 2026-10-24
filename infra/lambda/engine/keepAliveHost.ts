import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { costTagsAsEcs } from './costTags.js';

/**
 * KeepAliveHost —— engine 用它啟動 Windows 長時測試的保活 task。
 *
 * 為什麼需要:engine 開的 stream session 沒有任何 client 連進來,而
 * ConnectionTimeoutSeconds(等 client 連線的窗口)上限是 AWS 強制的 3600 秒,
 * 所以無人連線的 session 一定在一小時內被收掉。SessionLengthSeconds 可以到 24 小時 ——
 * 差別只在「有沒有 client 連著」。這個 task 就是那個 client(真實 Chromium 跑 AWS 的
 * Web SDK;SignalRequest 只有那支 SDK 產得出合法格式)。詳見
 * docs/design/windows-long-run.md。
 *
 * 為什麼走 Fargate:保活要陪著 session 整段(可能數小時),engine Lambda 的 5 分鐘撐不住;
 * 而平台已經有一樣的東西(web 探索 runner 就是 Fargate + Playwright),這是那個模式的縮小版。
 */
const DATA_REGION = process.env.AWS_REGION ?? 'us-west-2';

// CDK 注入(與兩個探索 runner 共用 cluster,但各自的 task def / container / role)。
const ECS_CLUSTER = process.env.KEEPALIVE_ECS_CLUSTER ?? '';
const ECS_TASK_DEF = process.env.KEEPALIVE_ECS_TASK_DEF ?? '';
const ECS_SUBNETS = (process.env.KEEPALIVE_ECS_SUBNETS ?? '').split(',').filter(Boolean);
const ECS_SECURITY_GROUP = process.env.KEEPALIVE_ECS_SG ?? '';
const ECS_CONTAINER_NAME = process.env.KEEPALIVE_ECS_CONTAINER ?? 'keepalive-runner';

/**
 * 保活環境是否已配置。
 *
 * 分開成一個函式是為了讓呼叫端可以**先問再決定**:映像還沒推上去的舊部署也該能跑
 * Windows 任務(退回一小時),而不是整個任務失敗。
 */
export function keepAliveConfigured(): boolean {
  return Boolean(ECS_CLUSTER && ECS_TASK_DEF && ECS_SUBNETS.length > 0);
}

export interface KeepAliveParams {
  /** stream group id(保活要自己查 session 狀態)。 */
  streamGroupId: string;
  /** 要保活的 session ARN。 */
  sessionArn: string;
  bucket: string;
  /** tenants/<t>/jobs/<jobId>;保活把 deadline 租約寫在這個前綴下。 */
  prefix: string;
  /** session 的硬性結束時刻(毫秒時戳);租約不會超過它。 */
  sessionEndMs: number;
}

/** 啟動保活 task(不 block)。task 會在 session 進入終態時自己退出。 */
export async function startKeepAlive(params: KeepAliveParams): Promise<{ ecsTaskArn: string }> {
  if (!keepAliveConfigured()) {
    throw new Error('保活執行環境未配置(需 KEEPALIVE_ECS_CLUSTER / KEEPALIVE_ECS_TASK_DEF / KEEPALIVE_ECS_SUBNETS)');
  }

  const env: Array<{ name: string; value: string }> = [
    { name: 'PA_SG', value: params.streamGroupId },
    { name: 'PA_SESSION_ARN', value: params.sessionArn },
    { name: 'PA_BUCKET', value: params.bucket },
    { name: 'PA_PREFIX', value: params.prefix },
    { name: 'PA_DATA_REGION', value: DATA_REGION },
    { name: 'PA_SESSION_END_MS', value: String(params.sessionEndMs) },
  ];

  const runResp = await new ECSClient({ region: DATA_REGION }).send(
    new RunTaskCommand({
      cluster: ECS_CLUSTER,
      taskDefinition: ECS_TASK_DEF,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ECS_SUBNETS,
          assignPublicIp: 'ENABLED', // WebRTC 要出網連 GameLift Streams,還要寫 S3
          ...(ECS_SECURITY_GROUP ? { securityGroups: [ECS_SECURITY_GROUP] } : {}),
        },
      },
      overrides: {
        containerOverrides: [{ name: ECS_CONTAINER_NAME, environment: env }],
      },
      ...(costTagsAsEcs().length > 0 ? { tags: costTagsAsEcs() } : {}),
    }),
  );
  const ecsTaskArn = runResp.tasks?.[0]?.taskArn;
  if (!ecsTaskArn) {
    const reason = runResp.failures?.[0]?.reason ?? '未知';
    throw new Error(`啟動保活 task 失敗: ${reason}`);
  }
  return { ecsTaskArn };
}
