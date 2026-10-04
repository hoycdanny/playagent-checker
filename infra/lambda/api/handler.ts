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
import { createHash, randomBytes } from 'node:crypto';
import { handleRequest, type ApiDeps, type ApiRequest, type CloudDevice } from './core.js';
import { assumeTenantS3 } from './tenantCredentials.js';
import { draftCaseYaml, makeBedrockClient } from './draft.js';
import { getRealCost, jobIdFromSessionName, makeCostExplorerClient, type DeviceSessionUsage, type RealCost } from './cost.js';
import { makeUserAdmin, makeCognitoAdminClient } from './users.js';
import { makeSecretWriter } from './secretValueStore.js';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const TENANT_ROLE_ARN = process.env.TENANT_ROLE_ARN ?? '';
const DISPATCH_QUEUE_URL = process.env.DISPATCH_QUEUE_URL ?? '';

const sts = new STSClient({ region: REGION });
const bedrock = makeBedrockClient(REGION);
const sqs = new SQSClient({ region: REGION });
// 共用命名空間(shared/*)用 Lambda 自身角色,不經租戶隔離角色。
const sharedS3 = new S3Client({ region: REGION });
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
// 測試憑證值寫入(Secrets Manager,與資料同區 us-east-2);runner 執行時才讀值替換 PA_TASK。
const secretWriter = makeSecretWriter(REGION);

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
          { attribute: 'FORM_FACTOR', operator: 'EQUALS', values: ['PHONE'] },
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
  draftCase: (description, appId, baseYaml) =>
    draftCaseYaml({ bedrock }, description, appId, baseYaml),
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
  listDeviceSessions,
  // Cost Explorer 每次查詢約 US$0.01 且資料本來就有 ~24h 延遲:同一 Lambda 實例快取 10 分鐘。
  getRealCost: async (opts) => {
    const key = JSON.stringify(opts);
    if (realCostCache && realCostCache.key === key && Date.now() - realCostCache.at < 10 * 60 * 1000) return realCostCache.value;
    const value = await getRealCost(costExplorer, opts);
    realCostCache = { key, at: Date.now(), value };
    return value;
  },
  ...(userAdmin ? { userAdmin } : {}),
  secretWriter,
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
