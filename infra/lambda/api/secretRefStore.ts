import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { tenantSecretPrefix, SecretRefError } from './secretRefs.js';

/**
 * 機密引用管理(Req 14.4)—— 只管理「引用名稱清單」,永不儲存或回傳機密明文。
 * 明文值由使用者透過 Secrets Manager 主控台/CLI 直接寫入(命名須落 tenantSecretPrefix),
 * 本平台只登記「案例會用到哪些引用」以利前端下拉與缺失預檢。
 *
 * 儲存:tenants/<t>/secret-refs.json = { refs: [{ name, label, createdAt }] }
 */

export interface SecretRefEntry {
  /** 完整機密名稱(含租戶前綴)。 */
  name: string;
  /** 使用者可讀標籤(如「遊戲登入密碼」)。 */
  label: string;
  createdAt: string;
}

function refsKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}secret-refs.json`;
}

async function readAll(
  s3: S3Client,
  bucket: string,
  tenantId: string,
): Promise<SecretRefEntry[]> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: refsKey(tenantId) }),
    );
    const text = (await res.Body?.transformToString()) ?? '';
    if (!text) return [];
    const parsed = JSON.parse(text) as { refs?: SecretRefEntry[] };
    return parsed.refs ?? [];
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return [];
    }
    throw err;
  }
}

/** 列出租戶的機密引用(只回名稱與標籤,絕不回值,Req 14.4)。 */
export async function listSecretRefs(
  s3: S3Client,
  bucket: string,
  tenantId: string,
): Promise<SecretRefEntry[]> {
  return readAll(s3, bucket, tenantId);
}

/**
 * 登記一個機密引用(只記名稱/標籤)。強制名稱落本租戶前綴(Req 14.3),
 * 跨租戶名稱一律拒絕。永不接受、儲存明文值。
 */
export async function putSecretRef(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  input: { name: string; label?: string },
): Promise<SecretRefEntry> {
  const prefix = tenantSecretPrefix(tenantId);
  const name = input.name.trim();
  if (!name.startsWith(prefix)) {
    throw new SecretRefError(
      `機密名稱必須以本租戶前綴開頭:${prefix}(收到:${name})`,
    );
  }
  const existing = await readAll(s3, bucket, tenantId);
  const entry: SecretRefEntry = {
    name,
    label: input.label?.trim() || name.slice(prefix.length),
    createdAt: new Date().toISOString(),
  };
  const next = [...existing.filter((e) => e.name !== name), entry];
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: refsKey(tenantId),
      Body: JSON.stringify({ refs: next }),
      ContentType: 'application/json',
    }),
  );
  return entry;
}

/** 移除一個機密引用登記(不影響 Secrets Manager 本身)。 */
export async function deleteSecretRef(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  name: string,
): Promise<void> {
  const existing = await readAll(s3, bucket, tenantId);
  const next = existing.filter((e) => e.name !== name);
  if (next.length === existing.length) return; // 無此項,無操作
  if (next.length === 0) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: refsKey(tenantId) }));
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: refsKey(tenantId),
      Body: JSON.stringify({ refs: next }),
      ContentType: 'application/json',
    }),
  );
}

export { SecretRefError };
