import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

/**
 * WebHost —— engine Lambda 用它啟動「網頁探索」Fargate task(headless Chromium)。
 *
 * 為何走 Fargate(不在 engine Lambda 內跑瀏覽器):headless Chromium 需數百 MB 記憶體、
 * 且一輪 screenshot→VLM→click 迴圈可能跑數分鐘,engine Lambda 512MB/5 分撐不住。
 * 故與 Device Farm 真機同架構:engine 只 RunTask 起 task,把 S3 位置/起始網址/VLM/目標以
 * 環境變數注入,立即返回(不 block);終態由 task 內的 webExplorationRunner 寫回 S3。
 */
const DATA_REGION = process.env.AWS_REGION ?? 'us-east-2';

// CDK 注入:Fargate 執行所需(與 Device Farm 共用 cluster,但各自的 task def / container)。
const ECS_CLUSTER = process.env.WEB_ECS_CLUSTER ?? '';
const ECS_TASK_DEF = process.env.WEB_ECS_TASK_DEF ?? '';
const ECS_SUBNETS = (process.env.WEB_ECS_SUBNETS ?? '').split(',').filter(Boolean);
const ECS_SECURITY_GROUP = process.env.WEB_ECS_SG ?? '';
const ECS_CONTAINER_NAME = process.env.WEB_ECS_CONTAINER ?? 'web-runner';

const ecs = new ECSClient({ region: DATA_REGION });

export interface WebRunParams {
  tenantId: string;
  jobId: string;
  appId: string;
  bucket: string;
  prefix: string; // tenants/<t>/jobs/<jobId>
  url: string; // 起始網址(engine 已從 case/app 解析)
  vlmModel?: string;
  caseTask?: string;
}

export interface WebRunResult {
  ecsTaskArn: string;
}

/** 啟動網頁探索 Fargate task(不 block)。終態由 runner 寫回 S3。 */
export async function startWebRun(params: WebRunParams): Promise<WebRunResult> {
  if (!ECS_CLUSTER || !ECS_TASK_DEF || ECS_SUBNETS.length === 0) {
    throw new Error(
      'Web 執行環境未配置(需 WEB_ECS_CLUSTER / WEB_ECS_TASK_DEF / WEB_ECS_SUBNETS)',
    );
  }

  const env: Array<{ name: string; value: string }> = [
    { name: 'PA_URL', value: params.url },
    { name: 'PA_JOB', value: params.jobId },
    { name: 'PA_TENANT', value: params.tenantId },
    { name: 'PA_APP', value: params.appId },
    { name: 'PA_BUCKET', value: params.bucket },
    { name: 'PA_PREFIX', value: params.prefix },
    { name: 'PA_DATA_REGION', value: DATA_REGION },
    { name: 'PA_VLM', value: params.vlmModel ?? '' },
    { name: 'PA_TASK', value: params.caseTask ?? '' },
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
          assignPublicIp: 'ENABLED', // 需出網連目標網站 + Bedrock/S3
          ...(ECS_SECURITY_GROUP ? { securityGroups: [ECS_SECURITY_GROUP] } : {}),
        },
      },
      overrides: {
        containerOverrides: [{ name: ECS_CONTAINER_NAME, environment: env }],
      },
    }),
  );
  const ecsTaskArn = runResp.tasks?.[0]?.taskArn;
  if (!ecsTaskArn) {
    const reason = runResp.failures?.[0]?.reason ?? '未知';
    throw new Error(`啟動網頁探索 task 失敗: ${reason}`);
  }
  return { ecsTaskArn };
}
