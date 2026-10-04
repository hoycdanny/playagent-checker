import { createHash } from 'node:crypto';
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

// ───────────────────────── 案例版本(不可變)─────────────────────────
//
// 每次儲存案例內容(新建 / 編輯 / 舊案例補建基準)都寫一個不可變版本:
//   tenants/<t>/case-versions/<app>/<caseId>/<version>.json
// 版本號 = 台北時間(UTC+8)YYYY-MMDD-HHmm-SSss(ss = 百分之一秒),例:2027-0606-1124-3399。
// 字串排序 = 時間先後。以 S3 條件寫入(If-None-Match: *)保證同一版本號不會被覆寫;
// 同一個百分之一秒內撞號則 +0.01 秒重試。
// 「目前使用中」的 head 仍在 cases/<app>/<caseId>.yaml(metadata.version 指向版本);
// 切換版本 = 把 head 換成該版本的內容,版本本身永不修改。刪除案例只刪 head,保留版本供溯源。

/** 版本號格式:YYYY-MMDD-HHmm-SSss。 */
export const CASE_VERSION_RE = /^\d{4}-\d{4}-\d{4}-\d{4}$/;
const TZ_OFFSET_MS = 8 * 3_600_000; // Asia/Taipei(無夏令時間)

/** 以台北時間格式化成版本號(百分之一秒精度)。 */
export function formatCaseVersion(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}${p(Math.floor(d.getUTCMilliseconds() / 10))}`;
}

/** 版本號 → 時間(ms);格式不符回 null。 */
export function parseCaseVersion(v: string): number | null {
  const m = /^(\d{4})-(\d{2})(\d{2})-(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, cs] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, cs! * 10) - TZ_OFFSET_MS;
}

export type CaseVersionSource = 'create' | 'edit' | 'baseline';

export interface CaseVersion {
  version: string;
  app: string;
  caseId: string;
  name: string;
  yaml: string;
  createdAt: string;
  createdBy?: string;
  /** 內容雜湊(name + yaml),可驗證版本未被竄改。 */
  sha256: string;
  source: CaseVersionSource;
  /** 由哪個版本編輯而來。 */
  basedOn?: string;
}

export type CaseVersionSummary = Omit<CaseVersion, 'yaml'>;

function versionsPrefix(tenantId: string, app: string, caseId: string): string {
  return `${tenantPrefix(tenantId)}case-versions/${app}/${caseId}/`;
}
function versionKey(tenantId: string, app: string, caseId: string, version: string): string {
  return `${versionsPrefix(tenantId, app, caseId)}${version}.json`;
}

export function contentHash(name: string, yaml: string): string {
  return createHash('sha256').update(`${name}\n\u0000\n${yaml}`).digest('hex');
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412 || e?.name === 'ConditionalRequestConflict';
}

async function listVersionIds(s3: S3Client, bucket: string, tenantId: string, app: string, caseId: string): Promise<string[]> {
  const prefix = versionsPrefix(tenantId, app, caseId);
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const o of res.Contents ?? []) {
      const id = (o.Key ?? '').slice(prefix.length).replace(/\.json$/, '');
      if (CASE_VERSION_RE.test(id)) ids.push(id);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids.sort();
}

/**
 * 寫一個新的不可變版本。版本號以 at(預設現在)產生,且必定晚於既有最新版本;
 * 撞號(同一個百分之一秒)時 +10ms 重試。
 */
export async function writeCaseVersion(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  v: { app: string; caseId: string; name: string; yaml: string; source: CaseVersionSource; createdBy?: string; basedOn?: string; at?: number },
): Promise<CaseVersion> {
  const existing = await listVersionIds(s3, bucket, tenantId, v.app, v.caseId);
  const latestMs = existing.length ? parseCaseVersion(existing[existing.length - 1]!) : null;
  let ms = v.at ?? Date.now();
  if (latestMs !== null && ms <= latestMs) ms = latestMs + 10;
  for (let attempt = 0; attempt < 20; attempt++, ms += 10) {
    const version = formatCaseVersion(ms);
    const rec: CaseVersion = {
      version,
      app: v.app,
      caseId: v.caseId,
      name: v.name,
      yaml: v.yaml,
      createdAt: new Date().toISOString(),
      ...(v.createdBy ? { createdBy: v.createdBy } : {}),
      sha256: contentHash(v.name, v.yaml),
      source: v.source,
      ...(v.basedOn ? { basedOn: v.basedOn } : {}),
    };
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: versionKey(tenantId, v.app, v.caseId, version),
          Body: JSON.stringify(rec),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
      return rec;
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }
  }
  throw new Error('無法產生唯一的案例版本號');
}

/** 讀單一版本(不存在回 null)。 */
export async function getCaseVersion(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
  version: string,
): Promise<CaseVersion | null> {
  if (!CASE_VERSION_RE.test(version)) return null;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: versionKey(tenantId, app, caseId, version) }));
    const text = (await res.Body?.transformToString()) ?? '';
    return JSON.parse(text) as CaseVersion;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
    throw err;
  }
}

/** 列出案例的所有版本(新到舊)。舊案例尚無版本時先補建基準版本。 */
export async function listCaseVersions(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
): Promise<{ active?: string; items: CaseVersionSummary[] }> {
  const head = await getCase(s3, bucket, tenantId, app, caseId);
  if (head) await ensureCaseVersion(s3, bucket, tenantId, app, caseId, head);
  const ids = await listVersionIds(s3, bucket, tenantId, app, caseId);
  const latest = ids.slice(-300).reverse();
  const items = (
    await Promise.all(latest.map((id) => getCaseVersion(s3, bucket, tenantId, app, caseId, id).catch(() => null)))
  )
    .filter((v): v is CaseVersion => v !== null)
    .map(({ yaml: _yaml, ...rest }) => rest);
  const active = (await getCase(s3, bucket, tenantId, app, caseId))?.version;
  return { ...(active ? { active } : {}), items };
}

/**
 * 確保 head 對應到一個版本並回傳版本號。
 * 舊案例(功能上線前建立,head 無版本號)補建「基準版本」,版本時間取 head 最後修改時間。
 */
export async function ensureCaseVersion(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
  head?: CaseDetail | null,
): Promise<string | null> {
  const h = head ?? (await getCase(s3, bucket, tenantId, app, caseId));
  if (!h) return null;
  if (h.version) {
    // head 指向的版本必須真的存在且內容一致;否則(版本被手動刪除/head 被外部改寫)補建新版本。
    const v = await getCaseVersion(s3, bucket, tenantId, app, caseId, h.version);
    if (v && v.sha256 === contentHash(h.name, h.yaml)) return h.version;
  }
  const at = h.updatedAt ? Date.parse(h.updatedAt) : undefined;
  const v = await writeCaseVersion(s3, bucket, tenantId, {
    app, caseId, name: h.name, yaml: h.yaml, source: h.version ? 'edit' : 'baseline',
    ...(h.version ? { basedOn: h.version } : {}),
    ...(at !== undefined && Number.isFinite(at) && !h.version ? { at } : {}),
  });
  await putHead(s3, bucket, tenantId, app, caseId, h.name, h.yaml, v.version);
  return v.version;
}

/** 切換「目前使用中」的版本(head 換成該版本內容;不產生新版本、不修改任何版本)。 */
export async function activateCaseVersion(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
  version: string,
): Promise<CaseDetail> {
  const v = await getCaseVersion(s3, bucket, tenantId, app, caseId, version);
  if (!v) throw new NotFoundError(`找不到案例版本: ${version}`);
  await putHead(s3, bucket, tenantId, app, caseId, v.name, v.yaml, v.version);
  return { id: caseId, app, name: v.name, yaml: v.yaml, version: v.version };
}

// ───────────────────────── 案例 head ─────────────────────────

function casesPrefix(tenantId: string, app: string): string {
  return `${tenantPrefix(tenantId)}cases/${app}/`;
}

function caseKey(tenantId: string, app: string, caseId: string): string {
  return `${casesPrefix(tenantId, app)}${caseId}.yaml`;
}

/** 寫「目前使用中」的案例 head(正文逐字保存;名稱/app/版本號記於 metadata)。 */
async function putHead(s3: S3Client, bucket: string, tenantId: string, app: string, caseId: string, name: string, yaml: string, version: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: caseKey(tenantId, app, caseId),
      Body: yaml,
      ContentType: 'application/yaml',
      Metadata: { name: encodeURIComponent(name), app, version },
    }),
  );
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
  createdBy?: string,
): Promise<{ id: string; app: string; name: string; version: string }> {
  const id = `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 先寫不可變版本,再寫 head(head 指向版本)。
  const v = await writeCaseVersion(s3, bucket, tenantId, {
    app: input.app, caseId: id, name: input.name, yaml: input.yaml, source: 'create', ...(createdBy ? { createdBy } : {}),
  });
  await putHead(s3, bucket, tenantId, input.app, id, input.name, input.yaml, v.version);
  return { id, app: input.app, name: input.name, version: v.version };
}

export interface CaseSummary {
  id: string;
  app: string;
  name: string;
  /** 目前使用中的版本號(舊案例尚未建立版本時無此欄位)。 */
  version?: string;
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
      const version = head.Metadata?.['version'];
      return { id: fileId, app: appName, name, ...(version && CASE_VERSION_RE.test(version) ? { version } : {}) };
    }),
  );
  return summaries;
}

export interface CaseDetail {
  id: string;
  app: string;
  name: string;
  yaml: string;
  /** 目前使用中的版本號(舊案例尚未建立版本時無此欄位)。 */
  version?: string;
  /** head 最後寫入時間。 */
  updatedAt?: string;
}

/** 讀單一案例(目前使用中的 head:YAML 正文、名稱、版本號)。不存在回 null。 */
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
    const version = res.Metadata?.['version'];
    return {
      id: caseId,
      app,
      name,
      yaml,
      ...(version && CASE_VERSION_RE.test(version) ? { version } : {}),
      ...(res.LastModified ? { updatedAt: res.LastModified.toISOString() } : {}),
    };
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/**
 * 更新案例(改名稱 / 改 YAML 正文):內容有變就產生新的不可變版本並切換為使用中;
 * 內容沒變則不產生版本。找不到原案例時拋 NotFoundError;YAML 仍走字面量密鑰邊界檢查。
 */
export async function updateCase(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  caseId: string,
  patch: { name?: string; yaml?: string },
  createdBy?: string,
): Promise<CaseDetail & { created: boolean }> {
  const existing = await getCase(s3, bucket, tenantId, app, caseId);
  if (!existing) throw new NotFoundError(`找不到測試案例: ${caseId}`);

  const name = patch.name !== undefined && patch.name.trim() !== ''
    ? patch.name.trim()
    : existing.name;
  const yaml = patch.yaml !== undefined ? patch.yaml : existing.yaml;
  if (yaml.trim() === '') throw new ValidationError('yaml 不可為空');
  assertNoLiteralSecrets(yaml);

  // 舊案例先補建基準版本,讓「編輯前」的內容也有版本可回溯。
  const baseVersion = await ensureCaseVersion(s3, bucket, tenantId, app, caseId, existing);
  if (name === existing.name && yaml === existing.yaml && baseVersion) {
    return { id: caseId, app, name, yaml, version: baseVersion, created: false };
  }
  const v = await writeCaseVersion(s3, bucket, tenantId, {
    app, caseId, name, yaml, source: 'edit',
    ...(createdBy ? { createdBy } : {}),
    ...(baseVersion ? { basedOn: baseVersion } : {}),
  });
  await putHead(s3, bucket, tenantId, app, caseId, name, yaml, v.version);
  return { id: caseId, app, name, yaml, version: v.version, created: true };
}

/** 刪除案例(幂等;不存在視為已刪)。只刪使用中的 head,歷史版本保留供溯源。 */
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
