import {
  DeviceFarmClient,
  CreateRemoteAccessSessionCommand,
  GetRemoteAccessSessionCommand,
  StopRemoteAccessSessionCommand,
  ListDevicesCommand,
  CreateProjectCommand,
  ListProjectsCommand,
  CreateUploadCommand,
  GetUploadCommand,
  ListUploadsCommand,
  TagResourceCommand,
  type Device,
  type Upload,
  type UploadType,
} from '@aws-sdk/client-device-farm';
import { createHash } from 'node:crypto';

/**
 * Device Farm Remote Access Session 管理(移植自 game-ai-qa src/device/deviceFarm.ts,
 * 改用 Node 22 API、APK 以 buffer 傳入而非本地檔路徑)。
 *
 * 用 CreateRemoteAccessSession 取得真機的 Appium 端點(remoteDriverEndpoint),
 * 讓截圖→VLM→操作迴圈能驅動實體 Android/iOS 裝置。真機有真實網路/GMS,可通過
 * IGS 等遊戲伺服器對模擬器環境的檢查(解決 Redroid 的 50019999)。
 */

/**
 * Device Farm 固定 region。AWS Device Farm 真機服務僅在 us-west-2(專案/上傳/session 都在此)。
 */
export const DEVICE_FARM_REGION = 'us-west-2';

export type DevicePlatform = 'android' | 'ios';

/** 成本分配標籤(與 CDK/費用歸屬一致)。 */
const COST_TAG_KEY = 'project';
const COST_TAG_VALUE = 'playagent-checker';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function platformFilterValue(platform: DevicePlatform | undefined): 'ANDROID' | 'IOS' {
  return platform === 'ios' ? 'IOS' : 'ANDROID';
}

/** platform → Device Farm upload type。 */
function appUploadType(platform: DevicePlatform | undefined): UploadType {
  return platform === 'ios' ? 'IOS_APP' : 'ANDROID_APP';
}

/**
 * 列出指定 platform 下支援 Remote Access 的可用手機,按 OS 版本降序。
 * 可選 min/maxOsVersion 收斂到某 Android 版本區間(舊 targetSdk APK 配 maxOsVersion 避免
 * INSTALL_FAILED_DEPRECATED_SDK_VERSION)。過濾後為空則回退不過濾(真機可用性隨時變化,
 * 寧可挑版本不理想的也別整個失敗)。
 */
export async function listRemoteAccessDevices(
  client: DeviceFarmClient,
  platform: DevicePlatform | undefined,
  maxOsVersion?: number,
  minOsVersion?: number,
): Promise<Device[]> {
  const response = await client.send(
    new ListDevicesCommand({
      filters: [
        { attribute: 'PLATFORM', operator: 'EQUALS', values: [platformFilterValue(platform)] },
        { attribute: 'AVAILABILITY', operator: 'EQUALS', values: ['AVAILABLE', 'HIGHLY_AVAILABLE'] },
        { attribute: 'FORM_FACTOR', operator: 'EQUALS', values: ['PHONE'] },
        { attribute: 'REMOTE_ACCESS_ENABLED', operator: 'EQUALS', values: ['TRUE'] },
      ],
    }),
  );
  const devices = response.devices ?? [];
  let pool = devices;
  if (maxOsVersion !== undefined || minOsVersion !== undefined) {
    const filtered = devices.filter((d) => {
      const v = parseFloat(d.os ?? '99');
      if (maxOsVersion !== undefined && v > maxOsVersion) return false;
      if (minOsVersion !== undefined && v < minOsVersion) return false;
      return true;
    });
    if (filtered.length > 0) pool = filtered;
  }
  return pool.sort((a, b) => parseFloat(b.os ?? '0') - parseFloat(a.os ?? '0'));
}

// ── 專案管理 ──

async function findExistingProject(
  name: string,
  client: DeviceFarmClient,
): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListProjectsCommand({ nextToken }));
    const match = res.projects?.find((p) => p.name === name);
    if (match?.arn) return match.arn;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

async function tagForCostAllocation(client: DeviceFarmClient, resourceArn: string): Promise<void> {
  try {
    await client.send(
      new TagResourceCommand({
        ResourceARN: resourceArn,
        Tags: [{ Key: COST_TAG_KEY, Value: COST_TAG_VALUE }],
      }),
    );
  } catch (err) {
    console.warn('Device Farm 專案打成本標籤失敗(不影響主流程)', String(err));
  }
}

/** 建立或複用同名 Device Farm 專案,回 ARN。 */
export async function getOrCreateProject(
  name: string,
  client: DeviceFarmClient,
): Promise<string> {
  const existing = await findExistingProject(name, client);
  if (existing) {
    await tagForCostAllocation(client, existing);
    return existing;
  }
  const result = await client.send(new CreateProjectCommand({ name }));
  const arn = result.project?.arn;
  if (!arn) throw new Error('CreateProject 未回傳 ARN');
  await tagForCostAllocation(client, arn);
  return arn;
}

// ── APK/IPA 上傳 ──

async function findExistingUpload(
  projectArn: string,
  fileName: string,
  type: UploadType,
  client: DeviceFarmClient,
): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListUploadsCommand({ arn: projectArn, type, nextToken }));
    const match = res.uploads?.find((u) => u.name === fileName && u.status === 'SUCCEEDED');
    if (match?.arn) return match.arn;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

/** 解析上傳失敗原因(Device Farm 校驗失敗的真因常埋在 metadata JSON)。 */
function describeUploadFailure(upload: Upload | undefined): string {
  const metadata = upload?.metadata;
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { errorMessage?: string; errorCode?: string };
      if (parsed.errorMessage || parsed.errorCode) {
        const code = parsed.errorCode ? ` (${parsed.errorCode})` : '';
        return `${parsed.errorMessage ?? '未知錯誤'}${code}`;
      }
    } catch {
      /* metadata 非 JSON,回退 message */
    }
  }
  return upload?.message ?? '未知錯誤(Device Farm 未回傳失敗原因)';
}

/**
 * 上傳 app 包(APK/IPA)到專案;同內容(sha256 前綴命名)已上傳則複用,否則建立並輪詢至 SUCCEEDED。
 * content 為 app 二進位內容(engine 從 S3 讀好傳入)。
 */
export async function uploadApp(
  projectArn: string,
  content: Uint8Array,
  fileStem: string,
  platform: DevicePlatform | undefined,
  client: DeviceFarmClient,
): Promise<string> {
  const type = appUploadType(platform);
  const ext = platform === 'ios' ? '.ipa' : '.apk';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const fileName = `${fileStem}.${sha256.slice(0, 6)}${ext}`;

  const existing = await findExistingUpload(projectArn, fileName, type, client);
  if (existing) return existing;

  const createResult = await client.send(
    new CreateUploadCommand({ projectArn, name: fileName, type }),
  );
  const uploadUrl = createResult.upload?.url;
  const uploadArn = createResult.upload?.arn;
  if (!uploadUrl || !uploadArn) throw new Error('CreateUpload 未回傳 URL/ARN');

  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    body: content,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!resp.ok) throw new Error(`上傳 PUT 失敗: ${resp.status}`);

  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const getResult = await client.send(new GetUploadCommand({ arn: uploadArn }));
    const status = getResult.upload?.status;
    if (status === 'SUCCEEDED') return uploadArn;
    if (status === 'FAILED') throw new Error(`上傳失敗: ${describeUploadFailure(getResult.upload)}`);
  }
  throw new Error('上傳逾時');
}

/**
 * 建立 session 前確認 appArn 仍可用。Device Farm 對失效 upload 會回一句誤導性的
 * `Missing RemoteAccessSession for Project`,這裡顯式 GetUpload 換成人話。
 * 權限/網路類錯誤不阻斷(避免用新錯誤蓋掉原問題)。
 */
async function assertAppUploadUsable(client: DeviceFarmClient, appArn: string): Promise<void> {
  let upload: Upload | undefined;
  try {
    upload = (await client.send(new GetUploadCommand({ arn: appArn }))).upload;
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') {
      throw new Error(
        `應用包已不存在於 Device Farm(appArn 失效): ${appArn}。請重新上傳。`,
      );
    }
    console.warn('跳過應用包可用性校驗(不影響建 session)', String(err));
    return;
  }
  if (upload?.status && upload.status !== 'SUCCEEDED') {
    throw new Error(
      `應用包在 Device Farm 上不可用(status=${upload.status}): ${appArn}。${upload.message ?? ''}`,
    );
  }
}

// ── Remote Access Session ──

export interface DeviceFarmSession {
  appiumUrl: string;
  sessionArn: string;
  region: string;
  deviceModel?: string;
}

async function resolveDeviceArn(
  client: DeviceFarmClient,
  platform: DevicePlatform | undefined,
  deviceArn: string | undefined,
  maxOsVersion: number | undefined,
  minOsVersion: number | undefined,
): Promise<string> {
  if (deviceArn) return deviceArn;
  const devices = await listRemoteAccessDevices(client, platform, maxOsVersion, minOsVersion);
  if (devices.length === 0) {
    throw new Error(
      `Device Farm 中沒有可用的 ${platformFilterValue(platform)} 手機(需支援 Remote Access)。`,
    );
  }
  return devices[0]!.arn!;
}

/** 等 session RUNNING,回 Appium URL + 裝置型號。 */
async function waitForSession(
  client: DeviceFarmClient,
  sessionArn: string,
  timeoutMs = 180_000,
): Promise<{ appiumUrl: string; deviceModel?: string }> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const resp = await client.send(new GetRemoteAccessSessionCommand({ arn: sessionArn }));
    const session = resp.remoteAccessSession;
    if (!session) throw new Error(`Session ${sessionArn} 不存在`);
    console.log('Device Farm session 狀態', session.status);

    if (session.status === 'RUNNING') {
      const appiumUrl = session.endpoints?.remoteDriverEndpoint;
      if (!appiumUrl) throw new Error('Session RUNNING 但無 remoteDriverEndpoint');
      const dev = session.device;
      const rawName = dev?.name ?? dev?.model ?? '';
      const manufacturer = dev?.manufacturer ?? '';
      const deviceModel = dev
        ? (rawName.startsWith(manufacturer) ? rawName : `${manufacturer} ${rawName}`).trim()
        : undefined;
      return deviceModel ? { appiumUrl, deviceModel } : { appiumUrl };
    }
    if (session.status === 'COMPLETED' || session.status === 'STOPPING') {
      throw new Error(
        `Session 異常結束(status=${session.status}, result=${session.result ?? 'unknown'}): ${session.message ?? '無詳情'}`,
      );
    }
    await sleep(5000);
  }
  throw new Error(`等待 session 就緒逾時(${timeoutMs / 1000}s)`);
}

export interface CreateSessionParams {
  projectArn: string;
  appArn?: string;
  platform?: DevicePlatform;
  deviceArn?: string;
  maxOsVersion?: number;
  minOsVersion?: number;
  namePrefix?: string;
}

/** 建立 Device Farm Remote Access Session,回 Appium 端點。 */
export async function createSession(
  client: DeviceFarmClient,
  params: CreateSessionParams,
): Promise<DeviceFarmSession> {
  const deviceArn = await resolveDeviceArn(
    client,
    params.platform,
    params.deviceArn,
    params.maxOsVersion,
    params.minOsVersion,
  );
  if (params.appArn) await assertAppUploadUsable(client, params.appArn);

  const createResp = await client.send(
    new CreateRemoteAccessSessionCommand({
      projectArn: params.projectArn,
      deviceArn,
      name: `${params.namePrefix ?? 'playagent'}-${Date.now()}`,
      configuration: { billingMethod: 'METERED' },
      ...(params.appArn ? { appArn: params.appArn } : {}),
    }),
  );
  const sessionArn = createResp.remoteAccessSession?.arn;
  if (!sessionArn) throw new Error('Device Farm 建 session 失敗:未回傳 ARN');

  const result = await waitForSession(client, sessionArn, 180_000);
  // Appium 端點初始化緩衝。
  await sleep(10_000);
  return { ...result, sessionArn, region: DEVICE_FARM_REGION };
}

/**
 * 重新取得 RUNNING session 的 Appium endpoint(remoteDriverEndpoint 是預簽名 URL,約 15 分後失效,
 * 必須重新呼叫 API,不能複用/改寫舊 URL)。
 */
export async function refreshRemoteDriverEndpoint(
  client: DeviceFarmClient,
  sessionArn: string,
): Promise<string> {
  const resp = await client.send(new GetRemoteAccessSessionCommand({ arn: sessionArn }));
  const session = resp.remoteAccessSession;
  if (!session) throw new Error(`Device Farm session ${sessionArn} 不存在,無法刷新 endpoint`);
  if (session.status !== 'RUNNING') {
    throw new Error(
      `session 無法刷新 endpoint(status=${session.status ?? 'UNKNOWN'}): ${session.message ?? '已不再運行'}`,
    );
  }
  const endpoint = session.endpoints?.remoteDriverEndpoint;
  if (!endpoint) throw new Error('session 運行中但無 remoteDriverEndpoint');
  return endpoint;
}

/** 停止 session(冪等,已結束不報錯)。 */
export async function stopSession(client: DeviceFarmClient, sessionArn: string): Promise<void> {
  try {
    await client.send(new StopRemoteAccessSessionCommand({ arn: sessionArn }));
  } catch {
    /* 可能已結束 */
  }
}
