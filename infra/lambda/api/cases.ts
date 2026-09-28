import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

/**
 * 用例的秘密邊界(Req 2.3):案例是入庫文件,只接受 `${ENV}`/機密引用形式的憑證,
 * 一律拒絕字面量密鑰。偵測 YAML 中出現「像密鑰的鍵: 字面量值」的樣態。
 */
const SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|api[_-]?key|access[_-]?key|token|credential)\s*:\s*(.+)/gi;

/** 值若為 ${ENV} 佔位或機密引用(secretRef/arn),視為合規;其餘字面量拒絕。 */
function isAllowedSecretValue(raw: string): boolean {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (v === '') return true;
  if (v.startsWith('${') && v.endsWith('}')) return true; // ${ENV}
  if (/^secretRef:/i.test(v)) return true;
  if (/^arn:aws:secretsmanager:/i.test(v)) return true;
  return false;
}

/** 掃描案例 YAML,含字面量密鑰即拋錯(Req 2.3)。 */
export function assertNoLiteralSecrets(yaml: string): void {
  SECRET_KEY_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_KEY_PATTERN.exec(yaml)) !== null) {
    const value = m[1] ?? '';
    if (!isAllowedSecretValue(value)) {
      throw new ValidationError(
        '案例中不可寫入字面量密鑰;請改用 ${ENV} 佔位或機密引用(secretRef:/arn:aws:secretsmanager:)',
      );
    }
  }
}

function casesPrefix(tenantId: string, app: string): string {
  return `${tenantPrefix(tenantId)}cases/${app}/`;
}

function caseKey(tenantId: string, app: string, caseId: string): string {
  return `${casesPrefix(tenantId, app)}${caseId}.yaml`;
}

export interface CaseInput {
  app: string;
  name: string;
  yaml: string;
}

export function validateCaseInput(body: unknown): CaseInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const app = b['app'];
  const name = b['name'];
  const yaml = b['yaml'];
  if (typeof app !== 'string' || app.trim() === '') {
    throw new ValidationError('app 為必填');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ValidationError('name 為必填');
  }
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    throw new ValidationError('yaml 為必填');
  }
  assertNoLiteralSecrets(yaml);
  return { app: app.trim(), name: name.trim(), yaml };
}

export async function createCase(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  input: CaseInput,
): Promise<{ id: string; app: string; name: string }> {
  const id = `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 案例正文逐字保存(使用者內容,不改動)。名稱與 app 記於物件 metadata。
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: caseKey(tenantId, input.app, id),
      Body: input.yaml,
      ContentType: 'application/yaml',
      Metadata: { name: encodeURIComponent(input.name), app: input.app },
    }),
  );
  return { id, app: input.app, name: input.name };
}

export interface CaseSummary {
  id: string;
  app: string;
  name: string;
}

/** 列出某租戶(可選某 app)的案例。 */
export async function listCases(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app?: string,
): Promise<CaseSummary[]> {
  const prefix = app
    ? casesPrefix(tenantId, app)
    : `${tenantPrefix(tenantId)}cases/`;
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.yaml'));

  const summaries = await Promise.all(
    keys.map(async (key) => {
      const head = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const parts = key.split('/');
      const appName = parts[parts.length - 2] ?? '';
      const fileId = (parts[parts.length - 1] ?? '').replace(/\.yaml$/, '');
      const rawName = head.Metadata?.['name'];
      const name = rawName ? decodeURIComponent(rawName) : fileId;
      return { id: fileId, app: appName, name };
    }),
  );
  return summaries;
}

export interface CaseDetail {
  id: string;
  app: string;
  name: string;
  yaml: string;
}

/** 讀單一案例(含 YAML 正文與名稱)。不存在回 null。 */
export async function getCase(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
): Promise<CaseDetail | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: caseKey(tenantId, app, caseId) }),
    );
    const yaml = (await res.Body?.transformToString()) ?? '';
    const rawName = res.Metadata?.['name'];
    const name = rawName ? decodeURIComponent(rawName) : caseId;
    return { id: caseId, app, name, yaml };
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/**
 * 更新案例(改名稱 / 改 YAML 正文)。維持同一 key(app/caseId 不變)。
 * 找不到原案例時拋 NotFoundError;YAML 仍走字面量密鑰邊界檢查。
 */
export async function updateCase(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
  patch: { name?: string; yaml?: string },
): Promise<CaseDetail> {
  const existing = await getCase(s3, bucket, tenantId, app, caseId);
  if (!existing) throw new NotFoundError(`找不到測試案例: ${caseId}`);

  const name = patch.name !== undefined && patch.name.trim() !== ''
    ? patch.name.trim()
    : existing.name;
  const yaml = patch.yaml !== undefined ? patch.yaml : existing.yaml;
  if (yaml.trim() === '') throw new ValidationError('yaml 不可為空');
  assertNoLiteralSecrets(yaml);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: caseKey(tenantId, app, caseId),
      Body: yaml,
      ContentType: 'application/yaml',
      Metadata: { name: encodeURIComponent(name), app },
    }),
  );
  return { id: caseId, app, name, yaml };
}

/** 刪除案例(幂等;不存在視為已刪)。 */
export async function deleteCase(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: caseKey(tenantId, app, caseId) }),
  );
}
