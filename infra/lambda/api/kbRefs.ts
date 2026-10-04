/**
 * 知識庫引用追蹤(刪除防呆)。
 *
 * 知識庫是跨租戶共用資源,但引用它的 App(預設知識庫)與測試任務(job.json.knowledgeBaseIds)
 * 存在各租戶前綴下 —— API 以租戶隔離角色只看得到自己租戶。因此用兩層資料判斷「是否仍被使用」:
 *  1. 共用引用索引 shared/kb-refs/<kbId>.json:提交任務 / 建立或修改 App / 刪除任務或 App 時維護,
 *     涵蓋所有租戶(其他租戶只回數量,不洩漏細節)。
 *  2. 目前租戶的即時掃描(App + 任務 job.json):補上索引建立前的舊資料,確保舊引用也擋得住。
 * 任一層有引用就禁止刪除(只能封存)。
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { isBuiltinKbId } from './builtinKnowledgeBases.js';

const REFS_PREFIX = 'shared/kb-refs/';

interface RefIndex {
  /** key = `${tenantId}/${appId}` */
  apps: Record<string, { tenantId: string; appId: string; at: string }>;
  /** key = `${tenantId}/${jobId}` */
  jobs: Record<string, { tenantId: string; jobId: string; at: string }>;
}

export interface KbUsage {
  apps: Array<{ appId: string; name: string }>;
  jobs: Array<{ jobId: string; appId?: string; createdAt?: string; state?: string }>;
  /** 其他租戶的引用數(不回細節)。 */
  otherTenants: { apps: number; jobs: number };
  total: number;
}

function refKey(kbId: string): string {
  return `${REFS_PREFIX}${kbId}.json`;
}

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
    throw err;
  }
}

async function readIndex(s3: S3Client, bucket: string, kbId: string): Promise<RefIndex> {
  const idx = await readJson<RefIndex>(s3, bucket, refKey(kbId));
  return { apps: idx?.apps ?? {}, jobs: idx?.jobs ?? {} };
}

async function writeIndex(s3: S3Client, bucket: string, kbId: string, idx: RefIndex): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: refKey(kbId), Body: JSON.stringify(idx), ContentType: 'application/json' }),
  );
}

const trackable = (ids: string[] | undefined) => [...new Set((ids ?? []).filter((id) => id && !isBuiltinKbId(id)))];

/** 登記引用(內建知識庫不可刪,不必追蹤)。失敗不擋主流程,由呼叫端 catch。 */
export async function addKbRefs(
  sharedS3: S3Client,
  bucket: string,
  kbIds: string[] | undefined,
  ref: { type: 'app'; tenantId: string; appId: string } | { type: 'job'; tenantId: string; jobId: string },
): Promise<void> {
  const at = new Date().toISOString();
  await Promise.all(
    trackable(kbIds).map(async (kbId) => {
      const idx = await readIndex(sharedS3, bucket, kbId);
      if (ref.type === 'app') idx.apps[`${ref.tenantId}/${ref.appId}`] = { tenantId: ref.tenantId, appId: ref.appId, at };
      else idx.jobs[`${ref.tenantId}/${ref.jobId}`] = { tenantId: ref.tenantId, jobId: ref.jobId, at };
      await writeIndex(sharedS3, bucket, kbId, idx);
    }),
  );
}

/** 移除引用(App 取消預設 / App 刪除 / 任務刪除)。 */
export async function removeKbRefs(
  sharedS3: S3Client,
  bucket: string,
  kbIds: string[] | undefined,
  ref: { type: 'app'; tenantId: string; appId: string } | { type: 'job'; tenantId: string; jobId: string },
): Promise<void> {
  await Promise.all(
    trackable(kbIds).map(async (kbId) => {
      const idx = await readIndex(sharedS3, bucket, kbId);
      if (ref.type === 'app') delete idx.apps[`${ref.tenantId}/${ref.appId}`];
      else delete idx.jobs[`${ref.tenantId}/${ref.jobId}`];
      await writeIndex(sharedS3, bucket, kbId, idx);
    }),
  );
}

/** App 的預設知識庫變更:差集登記/移除。 */
export async function syncAppKbRefs(
  sharedS3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
  before: string[] | undefined,
  after: string[] | undefined,
): Promise<void> {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  await Promise.all([
    addKbRefs(sharedS3, bucket, [...a].filter((x) => !b.has(x)), { type: 'app', tenantId, appId }),
    removeKbRefs(sharedS3, bucket, [...b].filter((x) => !a.has(x)), { type: 'app', tenantId, appId }),
  ]);
}

interface TenantScan {
  apps: Array<{ id: string; name: string; defaultKnowledgeBaseIds?: string[] }>;
  jobs: Array<{ jobId: string; appId?: string; createdAt?: string; knowledgeBaseIds?: string[]; state?: string }>;
}

/** 掃描目前租戶的 App 與任務(只讀 app.json / job.json / status.json,不碰步驟與截圖)。 */
async function scanTenant(tenantS3: S3Client, bucket: string, tenantId: string): Promise<TenantScan> {
  const listKeys = async (prefix: string, delimiter?: string) => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await tenantS3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(delimiter ? { Delimiter: delimiter } : {}), ...(token ? { ContinuationToken: token } : {}) }),
      );
      if (delimiter) for (const p of res.CommonPrefixes ?? []) { if (p.Prefix) out.push(p.Prefix); }
      else for (const o of res.Contents ?? []) { if (o.Key) out.push(o.Key); }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  };
  const base = tenantPrefix(tenantId);
  const [appKeys, jobFolders] = await Promise.all([listKeys(`${base}apps/`), listKeys(`${base}jobs/`, '/')]);
  const apps = (
    await Promise.all(
      appKeys.filter((k) => k.endsWith('.json')).map((k) => readJson<{ id: string; name: string; defaultKnowledgeBaseIds?: string[] }>(tenantS3, bucket, k).catch(() => null)),
    )
  ).filter((a): a is NonNullable<typeof a> => a !== null);
  // 並發讀 job.json(分批,避免一次開太多連線)。
  const jobs: TenantScan['jobs'] = [];
  for (let i = 0; i < jobFolders.length; i += 25) {
    const batch = await Promise.all(
      jobFolders.slice(i, i + 25).map(async (prefix) => {
        const job = await readJson<{ jobId: string; appId?: string; createdAt?: string; knowledgeBaseIds?: string[] }>(tenantS3, bucket, `${prefix}job.json`).catch(() => null);
        if (!job || !job.knowledgeBaseIds?.length) return null;
        const status = await readJson<{ state?: string }>(tenantS3, bucket, `${prefix}status.json`).catch(() => null);
        return { ...job, ...(status?.state ? { state: status.state } : {}) };
      }),
    );
    for (const j of batch) if (j) jobs.push(j);
  }
  return { apps, jobs };
}

/** 目前租戶 kbId → 引用(一次掃描,供列表頁顯示「使用中」數)。 */
export async function tenantUsageMap(
  tenantS3: S3Client,
  bucket: string,
  tenantId: string,
): Promise<Map<string, { apps: number; jobs: number }>> {
  const scan = await scanTenant(tenantS3, bucket, tenantId);
  const m = new Map<string, { apps: number; jobs: number }>();
  const bump = (id: string, k: 'apps' | 'jobs') => {
    const v = m.get(id) ?? { apps: 0, jobs: 0 };
    v[k]++;
    m.set(id, v);
  };
  for (const a of scan.apps) for (const id of new Set(a.defaultKnowledgeBaseIds ?? [])) bump(id, 'apps');
  for (const j of scan.jobs) for (const id of new Set(j.knowledgeBaseIds ?? [])) bump(id, 'jobs');
  return m;
}

/** 某知識庫的完整使用情況(目前租戶細節 + 其他租戶數量)。 */
export async function getKbUsage(
  sharedS3: S3Client,
  tenantS3: S3Client,
  bucket: string,
  tenantId: string,
  kbId: string,
): Promise<KbUsage> {
  const [idx, scan] = await Promise.all([readIndex(sharedS3, bucket, kbId), scanTenant(tenantS3, bucket, tenantId)]);
  const apps = scan.apps
    .filter((a) => (a.defaultKnowledgeBaseIds ?? []).includes(kbId))
    .map((a) => ({ appId: a.id, name: a.name }));
  const jobs = scan.jobs
    .filter((j) => (j.knowledgeBaseIds ?? []).includes(kbId))
    .map((j) => ({ jobId: j.jobId, ...(j.appId ? { appId: j.appId } : {}), ...(j.createdAt ? { createdAt: j.createdAt } : {}), ...(j.state ? { state: j.state } : {}) }))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const otherTenants = {
    apps: Object.values(idx.apps).filter((r) => r.tenantId !== tenantId).length,
    jobs: Object.values(idx.jobs).filter((r) => r.tenantId !== tenantId).length,
  };
  return { apps, jobs, otherTenants, total: apps.length + jobs.length + otherTenants.apps + otherTenants.jobs };
}
