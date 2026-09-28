import {
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

/**
 * Attached 本地裝置註冊(Req 13)。
 *
 * 註冊模型:
 * - 使用者在 Devices 頁「註冊本地裝置」→ POST /devices/register,發一個 deviceId + 連線 token。
 * - 本地代理帶 token 主動撥出 WS 連雲端(不需本地入站埠,Req 13.1);WS authorizer 驗 token
 *   歸屬本租戶後,代理進入「截圖上送→雲端判座標→指令回傳→本地執行」迴圈。
 * - token 為連線憑證,只在註冊回應回傳一次(之後只回遮罩後的 tokenHint,不回明文)。
 *
 * 儲存:tenants/<t>/devices/<deviceId>.json = { deviceId, label, tokenHash, tokenHint, status, ... }
 */

export class DeviceError extends Error {}

export interface DeviceRecord {
  deviceId: string;
  label: string;
  /** token 的雜湊(驗證用,不存明文)。 */
  tokenHash: string;
  /** token 遮罩提示(前 4 後 4),供使用者辨識,非機密。 */
  tokenHint: string;
  status: 'registered' | 'online' | 'offline';
  createdAt: string;
  lastSeenAt?: string;
}

/** 對外(API 回應)不含 tokenHash。 */
export interface DeviceView {
  deviceId: string;
  label: string;
  tokenHint: string;
  status: DeviceRecord['status'];
  createdAt: string;
  lastSeenAt?: string;
}

function deviceKey(tenantId: string, deviceId: string): string {
  return `${tenantPrefix(tenantId)}devices/${deviceId}.json`;
}
function devicesPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}devices/`;
}

/** 產生 deviceId 與連線 token(token 明文只回一次)。 */
function newDeviceId(): string {
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 產生 token 明文與其雜湊。雜湊用簡單 SHA-256(Node 內建 crypto)。
 * 注入 hasher 以利測試(預設用 node:crypto)。
 */
export interface Hasher {
  hash(input: string): string;
  randomToken(): string;
}

function toView(r: DeviceRecord): DeviceView {
  return {
    deviceId: r.deviceId,
    label: r.label,
    tokenHint: r.tokenHint,
    status: r.status,
    createdAt: r.createdAt,
    ...(r.lastSeenAt ? { lastSeenAt: r.lastSeenAt } : {}),
  };
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * 註冊一台本地裝置(Req 13.1)。回傳 deviceView + **一次性 token 明文**。
 * token 明文不落 S3(只存 hash + hint),之後任何 API 都不回傳明文。
 */
export async function registerDevice(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  input: { label?: string },
  hasher: Hasher,
): Promise<{ device: DeviceView; token: string }> {
  const deviceId = newDeviceId();
  const token = hasher.randomToken();
  const record: DeviceRecord = {
    deviceId,
    label: input.label?.trim() || deviceId,
    tokenHash: hasher.hash(token),
    tokenHint: maskToken(token),
    status: 'registered',
    createdAt: new Date().toISOString(),
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: deviceKey(tenantId, deviceId),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
  return { device: toView(record), token };
}

/** 列出本租戶的裝置(不回 tokenHash,Req:機密不回傳)。 */
export async function listDevices(
  s3: S3Client,
  bucket: string,
  tenantId: string,
): Promise<DeviceView[]> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: devicesPrefix(tenantId) }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.json'));
  const records = await Promise.all(
    keys.map(async (Key) => {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
        const text = (await res.Body?.transformToString()) ?? '';
        return text ? (JSON.parse(text) as DeviceRecord) : null;
      } catch {
        return null;
      }
    }),
  );
  return records
    .filter((r): r is DeviceRecord => r !== null)
    .map(toView)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 移除裝置註冊。 */
export async function deleteDevice(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: deviceKey(tenantId, deviceId) }),
  );
}

/**
 * 驗證裝置連線 token(WS 連線授權用):讀該裝置記錄,比對 tokenHash。
 * 回傳是否有效 —— 供 WS authorizer 判斷 attached 代理連線是否歸屬本租戶(Req 13.1)。
 */
export async function verifyDeviceToken(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  deviceId: string,
  token: string,
  hasher: Hasher,
): Promise<boolean> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: deviceKey(tenantId, deviceId) }),
    );
    const text = (await res.Body?.transformToString()) ?? '';
    if (!text) return false;
    const record = JSON.parse(text) as DeviceRecord;
    return record.tokenHash === hasher.hash(token);
  } catch {
    return false;
  }
}
