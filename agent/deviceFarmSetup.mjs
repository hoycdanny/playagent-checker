/**
 * Device Farm 探索前置(跑在 ECS Fargate 容器內,由 explorationRunner 呼叫)。
 *
 * 為何在 Fargate 而非 engine Lambda:被測 APK 常達數百 MB。engine Lambda 記憶體
 * 512MB、逾時 5 分,無法把整包讀進記憶體再上傳 + 等 session RUNNING(實測 456MB APK
 * 直接把 engine 撐爆並逾時)。Fargate 有較大記憶體與無時限,且可從 S3 串流 APK 到本地
 * 暫存檔(不整包進記憶體),再以 fs stream 上傳 Device Farm。
 *
 * 流程:getOrCreateProject → (串流)uploadApp → createSession → 回 { appiumUrl, sessionArn, deviceModel }。
 * 移植自 infra/lambda/engine/deviceFarm.ts,改 Node ESM + 串流上傳。
 */
import {
  CreateRemoteAccessSessionCommand,
  GetRemoteAccessSessionCommand,
  ListDevicesCommand,
  CreateProjectCommand,
  ListProjectsCommand,
  CreateUploadCommand,
  GetUploadCommand,
  ListUploadsCommand,
  TagResourceCommand,
} from '@aws-sdk/client-device-farm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { detectXapk, mergeXapkToApk, isThirtyTwoBitOnly, isStandaloneApk, detectApkPackage } from './apkMerge.mjs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COST_TAG_KEY = 'project';
const COST_TAG_VALUE = 'playagent-checker';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function platformFilterValue(platform) {
  return platform === 'ios' ? 'IOS' : 'ANDROID';
}
function appUploadType(platform) {
  return platform === 'ios' ? 'IOS_APP' : 'ANDROID_APP';
}

/**
 * 列支援 Remote Access 的可用手機(按 OS 版本降序),可選 OS 版本區間收斂。
 * opts.prefer32bit=true 時(被測 app 為 32-bit-only,只有 armeabi-v7a):
 *   新裝置(尤其 Android 14+ 的旗艦)常為「64-bit-only」,裝 32bit app 會 INSTALL_FAILED_NO_MATCHING_ABIS。
 *   故收斂到 OS 主版本 <= 13 的裝置(這一輩幾乎都保留 32bit 支援),仍取其中最新者;
 *   若該範圍無可用機才回退全部,至少讓流程往下走。
 */
export async function listRemoteAccessDevices(client, platform, maxOsVersion, minOsVersion, opts = {}) {
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
  const osMajor = (d) => parseInt(String(d.os ?? '0').split('.')[0], 10) || 0;
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
  // 32-bit-only app:優先選 OS<=13 的裝置(可靠支援 32bit);範圍內有機才收斂。
  if (opts.prefer32bit) {
    const safe32 = pool.filter((d) => { const m = osMajor(d); return m > 0 && m <= 13; });
    if (safe32.length > 0) pool = safe32;
  }
  return pool.sort((a, b) => parseFloat(b.os ?? '0') - parseFloat(a.os ?? '0'));
}

async function findExistingProject(name, client) {
  let nextToken;
  do {
    const res = await client.send(new ListProjectsCommand({ nextToken }));
    const match = res.projects?.find((p) => p.name === name);
    if (match?.arn) return match.arn;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

async function tagForCostAllocation(client, resourceArn) {
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

export async function getOrCreateProject(name, client) {
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

async function findExistingUpload(projectArn, fileName, type, client) {
  let nextToken;
  do {
    const res = await client.send(new ListUploadsCommand({ arn: projectArn, type, nextToken }));
    const match = res.uploads?.find((u) => u.name === fileName && u.status === 'SUCCEEDED');
    if (match?.arn) return match.arn;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

function describeUploadFailure(upload) {
  const metadata = upload?.metadata;
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed.errorMessage || parsed.errorCode) {
        const code = parsed.errorCode ? ` (${parsed.errorCode})` : '';
        return `${parsed.errorMessage ?? '未知錯誤'}${code}`;
      }
    } catch {
      /* metadata 非 JSON */
    }
  }
  return upload?.message ?? '未知錯誤(Device Farm 未回傳失敗原因)';
}

/**
 * 從 S3 串流下載被測產物到本地暫存檔,回 { path, sha256 }。
 * 邊寫檔邊算 sha256(不整包進記憶體);供 uploadApp 用 fileStream PUT。
 */
export async function downloadArtifactToTmp(s3, bucket, key, platform) {
  const ext = platform === 'ios' ? '.ipa' : '.apk';
  const tmpPath = join(tmpdir(), `pa-artifact-${Date.now()}${ext}`);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`讀取 S3 物件為空: ${key}`);
  const hash = createHash('sha256');
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(tmpPath));
  const sha256 = hash.digest('hex');
  const { size } = await stat(tmpPath);
  return { path: tmpPath, sha256, size };
}

/**
 * 上傳本地暫存 app 檔到專案(串流 PUT,不整包進記憶體);同內容已上傳則複用。
 * @param artifact { path, sha256, size } 來自 downloadArtifactToTmp
 */
export async function uploadAppFromFile(projectArn, artifact, fileStem, platform, client) {
  const type = appUploadType(platform);
  const ext = platform === 'ios' ? '.ipa' : '.apk';
  const fileName = `${fileStem}.${artifact.sha256.slice(0, 6)}${ext}`;

  const existing = await findExistingUpload(projectArn, fileName, type, client);
  if (existing) return existing;

  const createResult = await client.send(
    new CreateUploadCommand({ projectArn, name: fileName, type }),
  );
  const uploadUrl = createResult.upload?.url;
  const uploadArn = createResult.upload?.arn;
  if (!uploadUrl || !uploadArn) throw new Error('CreateUpload 未回傳 URL/ARN');

  // 串流 PUT(fetch + Readable body;Node 18+ 支援 duplex:'half')。
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    body: createReadStream(artifact.path),
    duplex: 'half',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(artifact.size),
    },
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

async function assertAppUploadUsable(client, appArn) {
  let upload;
  try {
    upload = (await client.send(new GetUploadCommand({ arn: appArn }))).upload;
  } catch (err) {
    if (err?.name === 'NotFoundException') {
      throw new Error(`應用包已不存在於 Device Farm(appArn 失效): ${appArn}。請重新上傳。`);
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

async function resolveDeviceArn(client, platform, deviceArn, maxOsVersion, minOsVersion, prefer32bit) {
  if (deviceArn) return deviceArn;
  const devices = await listRemoteAccessDevices(client, platform, maxOsVersion, minOsVersion, { prefer32bit });
  if (devices.length === 0) {
    throw new Error(
      `Device Farm 中沒有可用的 ${platformFilterValue(platform)} 手機(需支援 Remote Access)。`,
    );
  }
  if (prefer32bit) {
    console.log(`被測 app 為 32-bit-only,選用支援 32bit 的裝置:${devices[0].name ?? devices[0].arn}(Android ${devices[0].os})`);
  }
  return devices[0].arn;
}

/** 等 session RUNNING,回 { appiumUrl, deviceModel }。 */
async function waitForSession(client, sessionArn, timeoutMs = 300_000, onStatus) {
  const startTime = Date.now();
  let lastStatus;
  while (Date.now() - startTime < timeoutMs) {
    const resp = await client.send(new GetRemoteAccessSessionCommand({ arn: sessionArn }));
    const session = resp.remoteAccessSession;
    if (!session) throw new Error(`Session ${sessionArn} 不存在`);
    console.log('Device Farm session 狀態', session.status);
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      // 回報真機配置進度(PENDING/PREPARING/SCHEDULING/INITIALIZING…),前端顯示啟動進度。
      try { await onStatus?.(session.status); } catch { /* 進度回報失敗不影響開機 */ }
    }
    if (session.status === 'RUNNING') {
      const appiumUrl = session.endpoints?.remoteDriverEndpoint;
      if (!appiumUrl) throw new Error('Session RUNNING 但無 remoteDriverEndpoint');
      const dev = session.device;
      const rawName = dev?.name ?? dev?.model ?? '';
      const manufacturer = dev?.manufacturer ?? '';
      const deviceModel = dev
        ? (rawName.startsWith(manufacturer) ? rawName : `${manufacturer} ${rawName}`).trim()
        : undefined;
      return { appiumUrl, deviceModel };
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

/** 建立 Device Farm Remote Access Session,回 { appiumUrl, sessionArn, deviceModel, region }。 */
export async function createSession(client, params) {
  const deviceArn = await resolveDeviceArn(
    client,
    params.platform,
    params.deviceArn,
    params.maxOsVersion,
    params.minOsVersion,
    params.prefer32bit,
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

  const result = await waitForSession(client, sessionArn, 300_000, params.onStatus);
  try { await params.onConnecting?.(result.deviceModel); } catch { /* ignore */ }
  await sleep(10_000); // Appium 端點初始化緩衝
  return { ...result, sessionArn, deviceArn };
}

/**
 * 一次完成前置:讀 APK(串流)→ 專案 → 上傳 → 開 session。回 session 資訊。
 * dfRegion 固定 us-west-2(Device Farm 真機服務僅此區)。
 */
export async function setupDeviceFarmSession(deps, params) {
  const { dfClient, s3 } = deps;
  const platform = params.platform ?? 'android';
  const projectName = params.projectName ?? 'playagent-checker';
  // 啟動進度回報(download → upload → device → connect),失敗不影響流程。
  const phase = async (name, info) => { try { await params.onPhase?.(name, info); } catch { /* ignore */ } };

  await phase('download');
  const artifact = await downloadArtifactToTmp(s3, params.bucket, params.artifactKey, platform);
  // 若下載回來的是 XAPK / split bundle(Android 專用),先合併成單一 universal APK 再上傳,
  // 否則 Device Farm 的 aapt badging 會失敗(ANDROID_APP_AAPT_DEBUG_BADGING_FAILED)。
  // 合併後改用合併檔上傳;原始 XAPK 與合併檔都在 finally 清掉。
  let mergedPath = null;
  let uploadArtifact = artifact;
  if (platform !== 'ios') {
    const det = detectXapk(artifact.path);
    if (det.isXapk) {
      console.log(`偵測到 XAPK/split bundle(內含 ${det.apkEntries.length} 個 APK),合併為 universal APK 中…`);
      try {
        mergedPath = mergeXapkToApk(artifact.path);
        const { size } = await stat(mergedPath);
        // 串流算 sha256(合併後 APK 可能數百 MB,不整包進記憶體)。
        const hash = createHash('sha256');
        await pipeline(createReadStream(mergedPath), async function* (source) {
          for await (const chunk of source) { hash.update(chunk); yield chunk; }
        }, async function (source) { for await (const _ of source) { /* drain */ } });
        uploadArtifact = { path: mergedPath, sha256: hash.digest('hex'), size };
        console.log(`XAPK 合併完成:${Math.round(size / 1024 / 1024)}MB signed universal APK(aapt/zipalign/apksigner 已驗證)`);
      } catch (mergeErr) {
        // 失敗原因一定要進 CloudWatch(否則日誌停在「合併中…」,看不出是記憶體、磁碟還是 APK 本身的問題)。
        console.error(`XAPK 合併失敗:${String(mergeErr?.message || mergeErr).slice(0, 1500)}`);
        // 保底:若合併失敗但原檔本就是合法單一 APK(誤判成 XAPK),直接沿用原檔上傳,不阻斷任務。
        if (isStandaloneApk(artifact.path)) {
          console.log(`合併失敗但原檔為合法單一 APK,改用原始 APK 上傳(略過合併):${String(mergeErr?.message || mergeErr).slice(0, 200)}`);
          mergedPath = null;
          uploadArtifact = artifact;
        } else {
          throw mergeErr;
        }
      }
    }
  }
  // 偵測要上傳的 APK 的原生庫 ABI:若為 32-bit-only(只有 armeabi-v7a),挑選支援 32bit 的裝置,
  // 避免被分到「64-bit-only」的新機而 INSTALL_FAILED_NO_MATCHING_ABIS(如 Brotato 只帶 v7a split)。
  const prefer32bit = platform !== 'ios' && isThirtyTwoBitOnly(uploadArtifact.path);
  if (prefer32bit) console.log('偵測到被測 app 為 32-bit-only(僅 armeabi-v7a),將挑選支援 32bit 的裝置。');
  // 從 APK 解析套件名:App 建立時若未填 identifier,job 沒有 package,runner 就無法自動啟動遊戲
  // (會停在桌面對著 "Installing" 圖示空轉)。這裡自動補上,回給 runner 當 launch 依據。
  let detectedPackage;
  if (platform !== 'ios') {
    try {
      detectedPackage = detectApkPackage(uploadArtifact.path);
      if (detectedPackage) console.log(`從 APK 解析到套件名:${detectedPackage}`);
    } catch { /* 取不到就算了,交給 runner 視覺找入口 */ }
  }
  try {
    await phase('upload', { sizeMB: uploadArtifact.size ? Math.round(uploadArtifact.size / 1024 / 1024) : undefined });
    const projectArn = await getOrCreateProject(projectName, dfClient);
    const appArn = await uploadAppFromFile(projectArn, uploadArtifact, params.appId, platform, dfClient);
    await phase('device', { deviceStatus: 'PENDING' });
    const session = await createSession(dfClient, {
      projectArn,
      appArn,
      platform,
      onStatus: (s) => phase('device', { deviceStatus: s }),
      onConnecting: (model) => phase('connect', model ? { deviceModel: model } : {}),
      namePrefix: `pa-${params.jobId}`,
      ...(prefer32bit ? { prefer32bit: true } : {}),
      // 使用者明選的裝置優先(resolveDeviceArn 會短路直接用此 ARN);沒帶才靠 OS 區間挑。
      ...(params.deviceArn ? { deviceArn: params.deviceArn } : {}),
      ...(params.maxOsVersion !== undefined ? { maxOsVersion: params.maxOsVersion } : {}),
      ...(params.minOsVersion !== undefined ? { minOsVersion: params.minOsVersion } : {}),
    });
    // 附上偵測到的套件名(runner 在 PA_PKG 為空時據此自動啟動遊戲)。
    // projectArn / appArn / deviceArn:長時模式換新連線時直接重開 session(不必重新下載、上傳 APK)。
    return { ...session, projectArn, appArn, ...(prefer32bit ? { prefer32bit: true } : {}), ...(detectedPackage ? { detectedPackage } : {}) };
  } finally {
    await unlink(artifact.path).catch(() => {});
    if (mergedPath) await unlink(mergedPath).catch(() => {});
  }
}
