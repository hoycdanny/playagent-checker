import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { STSClient } from '@aws-sdk/client-sts';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import {
  DeviceFarmClient,
  ListDevicesCommand,
  ListProjectsCommand,
  ListRemoteAccessSessionsCommand,
  type Device,
} from '@aws-sdk/client-device-farm';
import { ECSClient, ListClustersCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import {
  GameLiftStreamsClient,
  GetStreamGroupCommand,
  ListStreamSessionsCommand,
} from '@aws-sdk/client-gameliftstreams';
import { createHash, randomBytes } from 'node:crypto';
import { handleRequest, type ApiDeps, type ApiRequest, type CloudDevice, type RuntimeInfra } from './core.js';
import { assumeTenantS3 } from './tenantCredentials.js';
import { draftCaseYaml, makeBedrockClient } from './draft.js';
import { parseSheetLayout } from './sheetParse.js';
import { getRealCost, jobIdFromSessionName, makeCostExplorerClient, type DeviceSessionUsage, type RealCost } from './cost.js';
import { makeUserAdmin, makeCognitoAdminClient } from './users.js';
import { makeSecretWriter } from './secretValueStore.js';
import { makeSystemUpdatePorts, systemUpdateConfigFromEnv } from './systemUpdatePorts.js';
import { makeSystemLogsPorts, systemLogsConfigFromEnv } from './systemLogsPorts.js';
import { makeUitarsPorts, uitarsConfigFromEnv } from './uitarsSwitch.js';
import { makeBedrockControl, scanBedrockModels } from './modelScan.js';
import { makeModelAdminStore } from './modelAdminStore.js';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const TENANT_ROLE_ARN = process.env.TENANT_ROLE_ARN ?? '';
const DISPATCH_QUEUE_URL = process.env.DISPATCH_QUEUE_URL ?? '';

const sts = new STSClient({ region: REGION });
const bedrock = makeBedrockClient(REGION);
const sqs = new SQSClient({ region: REGION });
// 共用命名空間(shared/*)用 Lambda 自身角色,不經租戶隔離角色。
const sharedS3 = new S3Client({ region: REGION });
// 執行基礎設施唯讀查詢(裝置管理頁的容器 / 主機 / 串流三區)。
const ecs = new ECSClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const gls = new GameLiftStreamsClient({ region: REGION });
// Device Farm 真機服務僅在 us-west-2;列真機池供裝置管理頁顯示(唯讀)。
const DF_REGION = process.env.DF_REGION ?? 'us-west-2';
const deviceFarm = new DeviceFarmClient({ region: DF_REGION });
// Cost Explorer 僅 us-east-1;費用分析頁取真實成本用(唯讀)。
const costExplorer = makeCostExplorerClient();
// 成員管理(admin 專用):對本 user pool 做 Admin* 操作。未設 USER_POOL_ID 則不注入。
const USER_POOL_ID = process.env.USER_POOL_ID ?? '';
const userAdmin = USER_POOL_ID
  ? makeUserAdmin(makeCognitoAdminClient(REGION), USER_POOL_ID)
  : undefined;
// 測試憑證值寫入(Secrets Manager,與資料同區,跟著部署區);runner 執行時才讀值替換 PA_TASK。
const secretWriter = makeSecretWriter(REGION);
// 系統更新(admin 專用):CDK 注入專案名/參數名才啟用;未設定時 /system/* 回 501。
const updateCfg = systemUpdateConfigFromEnv(process.env, REGION, BUCKET);
const systemUpdate = updateCfg
  ? {
    ports: makeSystemUpdatePorts(updateCfg, secretWriter, sharedS3),
    repo: process.env.GITHUB_REPO ?? '',
  }
  : undefined;
// UI-TARS 開關(admin 專用):CDK 注入 endpoint 名/映像/權重/角色才啟用。
const uitarsCfg = uitarsConfigFromEnv(process.env, REGION, BUCKET);
const uitars = uitarsCfg
  ? { ports: makeUitarsPorts(uitarsCfg, sharedS3), endpointName: uitarsCfg.endpointName, instanceType: uitarsCfg.instanceType }
  : undefined;
// 集中式日誌(admin 專用):CDK 注入 LOG_STAGE_PREFIX 才啟用;未設定時 /system/logs/* 回 501。
const logsCfg = systemLogsConfigFromEnv(process.env, REGION);
const systemLogs = logsCfg ? { ports: makeSystemLogsPorts(logsCfg) } : undefined;
// 模型管理(admin 專用):Bedrock 控制面掃描 + 設定存 shared/model-admin.json(自身角色)。
const bedrockControl = makeBedrockControl(REGION);
const modelAdminStore = makeModelAdminStore(sharedS3, BUCKET);
// Bedrock 控制面掃描結果快取 5 分鐘:提交任務頁(all=1)與模型管理頁都會打,避免每次開頁都掃一遍。
let scanCache: { at: number; items: Awaited<ReturnType<typeof scanBedrockModels>> } | null = null;
const SCAN_TTL_MS = 5 * 60 * 1000;
const cachedScan = async () => {
  if (scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.items;
  const items = await scanBedrockModels(bedrockControl);
  scanCache = { at: Date.now(), items };
  return items;
};
const modelAdmin = {
  scan: cachedScan,
  readConfig: () => modelAdminStore.readConfig(),
  writeConfig: (c: Parameters<typeof modelAdminStore.writeConfig>[0]) => modelAdminStore.writeConfig(c),
};

// 真機池不常變動,快取 5 分鐘,避免每次開頁都打 Device Farm API。
let cloudDeviceCache: { at: number; items: CloudDevice[] } | null = null;
const CLOUD_DEVICE_TTL_MS = 5 * 60 * 1000;
async function listCloudDevices(): Promise<CloudDevice[]> {
  if (cloudDeviceCache && Date.now() - cloudDeviceCache.at < CLOUD_DEVICE_TTL_MS) {
    return cloudDeviceCache.items;
  }
  // ListDevices 一次只回一頁(約 ~19 台),必須用 nextToken 分頁把整個真機池撈完,
  // 否則清單會被截斷(us-west-2 Android 手機池實際有 ~90 台)。
  const rawDevices: Device[] = [];
  let nextToken: string | undefined;
  do {
    const res = await deviceFarm.send(
      new ListDevicesCommand({
        filters: [
          { attribute: 'PLATFORM', operator: 'EQUALS', values: ['ANDROID'] },
          { attribute: 'AVAILABILITY', operator: 'EQUALS', values: ['AVAILABLE', 'HIGHLY_AVAILABLE'] },
          // 機型不過濾:真機池裡手機與平板都要列出來,讓使用者自己挑
          // (先前硬編碼成只列手機,所以平板完全看不到)。每台的 formFactor 會回給前端篩選。
          { attribute: 'REMOTE_ACCESS_ENABLED', operator: 'EQUALS', values: ['TRUE'] },
        ],
        ...(nextToken ? { nextToken } : {}),
      }),
    );
    if (res.devices) rawDevices.push(...res.devices);
    nextToken = res.nextToken;
  } while (nextToken);
  const items: CloudDevice[] = rawDevices
    .map((d) => ({
      ...(d.arn ? { arn: d.arn } : {}),
      name: d.name ?? d.model ?? '未知裝置',
      os: d.os ?? '',
      arch: d.cpu?.architecture ?? '',
      manufacturer: d.manufacturer ?? '',
      formFactor: d.formFactor ?? 'PHONE',
      ...(d.availability ? { availability: d.availability } : {}),
      // 機型特性:讓使用者挑機時看得到解析度/記憶體/CPU。
      ...(d.resolution?.width && d.resolution?.height
        ? { resolution: `${d.resolution.width}x${d.resolution.height}` }
        : {}),
      ...(typeof d.memory === 'number' ? { memoryBytes: d.memory } : {}),
      // clock 的單位由 cpu.frequency 決定(Device Farm 實測回 "MHz",如 2649=2.649GHz);
      // 依單位換算成 GHz 顯示;缺值或 0 則只留架構。
      ...(d.cpu?.architecture || (typeof d.cpu?.clock === 'number' && d.cpu.clock > 0)
        ? {
            cpu: [
              d.cpu?.architecture,
              typeof d.cpu?.clock === 'number' && d.cpu.clock > 0
                ? `${(d.cpu.clock / (String(d.cpu.frequency).toUpperCase() === 'MHZ' ? 1000 : 1e9)).toFixed(2)} GHz`
                : undefined,
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
    }))
    // 新到舊排序(OS 主版本);同版無所謂。
    .sort((a, b) => (parseInt(b.os) || 0) - (parseInt(a.os) || 0));
  cloudDeviceCache = { at: Date.now(), items };
  return items;
}

// ── 執行基礎設施現況(裝置管理頁:容器 / 主機 / 串流)──────────────────
// 平台共用資源的唯讀快照。三段各自 try/catch:一段讀不到就記進 errors,
// 不讓整頁掛掉也不假裝 0(容量顯示錯誤比沒顯示更糟)。
let infraCache: { at: number; data: RuntimeInfra } | null = null;
const INFRA_TTL_MS = 30 * 1000;

async function listRuntimeInfra(): Promise<RuntimeInfra> {
  if (infraCache && Date.now() - infraCache.at < INFRA_TTL_MS) return infraCache.data;
  const errors: string[] = [];
  const containers: RuntimeInfra['containers'] = [];
  const hosts: RuntimeInfra['hosts'] = [];
  let streams: RuntimeInfra['streams'] = null;

  // 1) Fargate 容器:本帳號每個 cluster 的 RUNNING task。
  try {
    const clusters = (await ecs.send(new ListClustersCommand({}))).clusterArns ?? [];
    for (const cluster of clusters.slice(0, 10)) {
      const arns = (await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING' }))).taskArns ?? [];
      if (arns.length === 0) continue;
      const shortCluster = cluster.split('/').pop() ?? cluster;
      // DescribeTasks 一次上限 100 個 ARN。
      for (let i = 0; i < arns.length; i += 100) {
        const d = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns.slice(i, i + 100) }));
        for (const task of d.tasks ?? []) {
          containers.push({
            taskArn: task.taskArn ?? '',
            cluster: shortCluster,
            status: task.lastStatus ?? 'UNKNOWN',
            ...(task.cpu ? { cpu: task.cpu } : {}),
            ...(task.memory ? { memory: task.memory } : {}),
            ...(task.startedAt ? { startedAt: new Date(task.startedAt).toISOString() } : {}),
          });
        }
      }
    }
  } catch (err) {
    errors.push(`containers: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) EC2 主機:帶 playagent:jobId 標籤的每任務主機(Redroid Graviton 等)。
  try {
    const res = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'shutting-down'] },
        { Name: 'tag-key', Values: ['playagent:jobId'] },
      ],
    }));
    for (const inst of (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])) {
      const jobId = inst.Tags?.find((x) => x.Key === 'playagent:jobId')?.Value;
      hosts.push({
        instanceId: inst.InstanceId ?? '',
        instanceType: inst.InstanceType ?? '',
        state: inst.State?.Name ?? 'unknown',
        ...(inst.Placement?.AvailabilityZone ? { az: inst.Placement.AvailabilityZone } : {}),
        ...(inst.LaunchTime ? { launchedAt: new Date(inst.LaunchTime).toISOString() } : {}),
        ...(jobId ? { jobId } : {}),
      });
    }
  } catch (err) {
    errors.push(`hosts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) GameLift Streams:stream group id 由 worker/windows-host/gamelift/setup.mjs 寫進
  //    SSM /playagent/<stack>/windows-gls/streamGroupId。這裡用 GetParametersByPath 找,
  //    避免把 Execution stack 名稱跨 stack 傳進 ControlPlane。
  try {
    const groupId = await findStreamGroupId();
    if (!groupId) {
      streams = null;
    } else {
      const g = await gls.send(new GetStreamGroupCommand({ Identifier: groupId }));
      let activeSessions: number | undefined;
      try {
        const s = await gls.send(new ListStreamSessionsCommand({ Identifier: groupId, Status: 'ACTIVE' }));
        activeSessions = (s.Items ?? []).length;
      } catch {
        /* session 列舉失敗不影響容量顯示 */
      }
      streams = {
        groupId,
        ...(g.Status ? { status: g.Status } : {}),
        locations: (g.LocationStates ?? []).map((l) => ({
          location: l.LocationName ?? '',
          ...(typeof l.AlwaysOnCapacity === 'number' ? { alwaysOn: l.AlwaysOnCapacity } : {}),
          ...(typeof l.OnDemandCapacity === 'number' ? { onDemand: l.OnDemandCapacity } : {}),
          ...(typeof l.AllocatedCapacity === 'number' ? { allocated: l.AllocatedCapacity } : {}),
          ...(typeof l.IdleCapacity === 'number' ? { idle: l.IdleCapacity } : {}),
          ...(l.Status ? { status: l.Status } : {}),
        })),
        ...(activeSessions !== undefined ? { activeSessions } : {}),
      };
    }
  } catch (err) {
    errors.push(`streams: ${err instanceof Error ? err.message : String(err)}`);
  }

  const data: RuntimeInfra = {
    containers,
    hosts,
    streams,
    ...(errors.length > 0 ? { errors } : {}),
  };
  infraCache = { at: Date.now(), data };
  return data;
}

/** 找 Windows GameLift Streams 的 stream group id(SSM /playagent/**​/windows-gls/streamGroupId)。 */
async function findStreamGroupId(): Promise<string | null> {
  let token: string | undefined;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({
      Path: '/playagent',
      Recursive: true,
      ...(token ? { NextToken: token } : {}),
    }));
    const hit = (r.Parameters ?? []).find((p) => p.Name?.endsWith('/windows-gls/streamGroupId'));
    if (hit?.Value) return hit.Value;
    token = r.NextToken;
  } while (token);
  return null;
}

// Device Farm session 實際計量分鐘(費用頁依任務歸屬用);快取 2 分鐘。
const DF_PROJECT = process.env.DF_PROJECT ?? 'playagent-checker';
let deviceSessionCache: { at: number; items: DeviceSessionUsage[] } | null = null;
async function listDeviceSessions(): Promise<DeviceSessionUsage[]> {
  if (deviceSessionCache && Date.now() - deviceSessionCache.at < 2 * 60 * 1000) return deviceSessionCache.items;
  let projectArn: string | undefined;
  let pt: string | undefined;
  do {
    const res = await deviceFarm.send(new ListProjectsCommand({ ...(pt ? { nextToken: pt } : {}) }));
    projectArn = res.projects?.find((p) => p.name === DF_PROJECT)?.arn ?? projectArn;
    pt = projectArn ? undefined : res.nextToken;
  } while (pt);
  const items: DeviceSessionUsage[] = [];
  if (projectArn) {
    let nt: string | undefined;
    do {
      const res = await deviceFarm.send(new ListRemoteAccessSessionsCommand({ arn: projectArn, ...(nt ? { nextToken: nt } : {}) }));
      for (const s of res.remoteAccessSessions ?? []) {
        const name = s.name ?? '';
        const jobId = jobIdFromSessionName(name);
        // 只有 METERED 的分鐘才計費(UNMETERED = 購買的 device slot,已月費)。
        const metered = s.billingMethod === 'UNMETERED' ? 0 : Number(s.deviceMinutes?.metered ?? 0);
        items.push({
          name,
          ...(jobId ? { jobId } : {}),
          ...(s.created ? { created: s.created.toISOString() } : {}),
          meteredMinutes: Number.isFinite(metered) ? metered : 0,
          totalMinutes: Number(s.deviceMinutes?.total ?? 0) || 0,
        });
      }
      nt = res.nextToken;
    } while (nt);
  }
  deviceSessionCache = { at: Date.now(), items };
  return items;
}
let realCostCache: { key: string; at: number; value: RealCost } | null = null;

const deps: ApiDeps = {
  bucket: BUCKET,
  sharedS3,
  getTenantS3: (tenantId) =>
    assumeTenantS3({ sts, roleArn: TENANT_ROLE_ARN, region: REGION }, tenantId),
  draftCase: (description, appId, baseYaml, opts) =>
    draftCaseYaml({ bedrock }, description, appId, baseYaml, opts),
  enqueueJob: async (msg) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: DISPATCH_QUEUE_URL,
        MessageBody: JSON.stringify(msg),
      }),
    );
  },
  hasher: {
    hash: (input) => createHash('sha256').update(input).digest('hex'),
    randomToken: () => randomBytes(24).toString('base64url'),
  },
  listCloudDevices,
  listRuntimeInfra,
  parseSheet: (grid) => parseSheetLayout({ bedrock }, grid),
  listDeviceSessions,
  // Cost Explorer 每次查詢約 US$0.01 且資料本來就有 ~24h 延遲:同一 Lambda 實例快取 10 分鐘。
  getRealCost: async (opts) => {
    const key = JSON.stringify(opts);
    if (realCostCache && realCostCache.key === key && Date.now() - realCostCache.at < 10 * 60 * 1000) return realCostCache.value;
    // Bedrock 帳單對照:部署區域(runner 與 API 同區呼叫 Bedrock)。
    const value = await getRealCost(costExplorer, { ...opts, ...(process.env['AWS_REGION'] ? { bedrockRegion: process.env['AWS_REGION'] } : {}) });
    realCostCache = { key, at: Date.now(), value };
    return value;
  },
  ...(userAdmin ? { userAdmin } : {}),
  ...(systemUpdate ? { systemUpdate } : {}),
  ...(uitars ? { uitars } : {}),
  ...(systemLogs ? { systemLogs } : {}),
  secretWriter,
  modelAdmin,
};

const CORS_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  // 控制面 API 回應為即時狀態(任務列表/狀態等),嚴禁被瀏覽器或中間層快取,
  // 否則提交新任務後 GET /tasks 會回舊的快取列表,看似「提交沒反應」。
  'cache-control': 'no-store',
};

/**
 * Lambda 進入點:把 API Gateway v2(HTTP API + JWT authorizer)event
 * 轉成純核心的 ApiRequest。claims 來自 authorizer 已驗證的 JWT,不取請求主體。
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  let parsedBody: unknown = null;
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: '請求主體不是合法 JSON' }),
      };
    }
  }

  const req: ApiRequest = {
    method: event.requestContext.http.method,
    path: event.requestContext.http.path,
    claims: event.requestContext.authorizer?.jwt?.claims ?? null,
    body: parsedBody,
    query: event.queryStringParameters ?? {},
  };

  try {
    const res = await handleRequest(req, deps);
    return {
      statusCode: res.status,
      headers: CORS_HEADERS,
      body: JSON.stringify(res.body),
    };
  } catch (err) {
    // 不裸露堆疊給客戶端;記錄於 CloudWatch。
    console.error('API 未預期錯誤', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal error' }),
    };
  }
}
