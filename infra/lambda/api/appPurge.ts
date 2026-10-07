/**
 * 刪除工作區(App)時連帶清除底下所有資料:
 *   - 測試任務 / 測試報告:tenants/<t>/jobs/<jobId>/(job.json.appId === appId 的整個資料夾)
 *   - 測試情境:tenants/<t>/cases/<app>/ 與版本紀錄 tenants/<t>/case-versions/<app>/
 *   - 記憶地圖 / 操作記憶:tenants/<t>/memory/<app>/(cloud、attached、runner 扁平佈局、hints、edits)
 *   - 手寫知識:tenants/<t>/knowledge/<app>.md
 *   - 上傳的安裝檔 / 圖示:tenants/<t>/artifacts/<id>/(只刪沒有其他 App 使用的)
 *   - 測試帳密:Secrets Manager playagent/tenant/<t>/app/<app>/credentials
 *   - 共用知識庫的引用索引(App 與每個任務)
 *   - 最後才刪 App 紀錄本身
 *
 * 安全:
 *   - appId 先驗格式,所有前綴都帶結尾斜線(app-1 不會誤刪 app-12)。
 *   - 一律走租戶隔離的 S3 client(IAM 限定 tenants/<自己>/*)。
 *   - 仍在執行的測試會擋下刪除(runner 還在寫檔,刪了會留下殘檔且停不下來)。
 *
 * 大量資料時一次 API 呼叫可能做不完(API Gateway 約 30 秒上限):超過時間預算就先回
 * done=false,App 紀錄保留,前端再呼叫一次接著刪(每一步都可重複執行)。
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { appCredentialsSecretName } from './appCredentialsStore.js';
import type { SecretWriter } from './secretValueStore.js';
import { removeKbRefs } from './kbRefs.js';
import type { AppRecord } from './apps.js';

/** App id 格式(實際為 app-<ts36>-<rand>;拒絕空字串、斜線、.. 等)。 */
export const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
/** 非終態但這麼久沒更新 → 視為已死的任務(不擋刪除)。 */
export const STALE_RUNNING_MS = 20 * 60_000;

export interface PurgeCounts {
  jobs: number;
  cases: number;
  caseVersions: number;
  memory: number;
  knowledge: number;
  artifacts: number;
  credentials: number;
}

export interface PurgeResult {
  /** true = 全部清完且 App 紀錄已刪;false = 時間到,需再呼叫一次。 */
  done: boolean;
  /** 本次呼叫刪掉的物件數(依類別)。 */
  deleted: PurgeCounts;
}

export class AppRunningError extends Error {
  constructor(readonly running: Array<{ jobId: string; state: string }>) {
    super(`此工作區還有 ${running.length} 個測試正在執行,請先停止後再刪除`);
  }
}

interface JobInfo {
  jobId: string;
  state?: string;
  updatedAt?: string;
  knowledgeBaseIds?: string[];
  artifactKey?: string;
}

export class Deadline {
  constructor(private readonly at: number) {}
  get passed(): boolean {
    return Date.now() >= this.at;
  }
}

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function listFolders(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ...(token ? { ContinuationToken: token } : {}) }),
    );
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * 刪除某前綴下所有物件(每批 1000)。prefix 必須以 / 結尾。
 * 回傳 [刪除數, 是否清完];時間到就停(下次呼叫接著刪)。
 */
export async function deletePrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
  deadline?: Deadline,
  /** 這個 key 留到最後才刪(例:job.json 是辨識任務屬於哪個 App 的依據,中途中斷時要能再找到)。 */
  last?: string,
): Promise<[number, boolean]> {
  if (!prefix.endsWith('/')) throw new Error(`deletePrefix 需要以 / 結尾的前綴: ${prefix}`);
  let n = 0;
  // 刪完再從頭列(不用 continuation token:刪除後 token 指向的位置會位移)。
  for (;;) {
    if (deadline?.passed) return [n, false];
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const all = (list.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
    const keys = all.filter((k) => k !== last);
    if (keys.length === 0) {
      if (last && all.includes(last)) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: last }));
        n += 1;
      }
      return [n, true];
    }
    for (let i = 0; i < keys.length; i += 1000) {
      const res = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
      );
      const errors = (res as { Errors?: Array<{ Key?: string; Message?: string }> } | undefined)?.Errors ?? [];
      if (errors.length > 0) throw new Error(`刪除失敗: ${errors[0]?.Key ?? ''} ${errors[0]?.Message ?? ''}`);
      n += Math.min(1000, keys.length - i);
    }
    // 沒被截斷 → 這輪已看到全部;回到迴圈開頭處理 last(或確認已空)。
  }
}

/** 找出屬於這個 App 的所有任務(讀每個 job.json;分批並發)。 */
export async function findAppJobs(s3: S3Client, bucket: string, tenantId: string, appId: string): Promise<JobInfo[]> {
  const folders = await listFolders(s3, bucket, `${tenantPrefix(tenantId)}jobs/`);
  const out: JobInfo[] = [];
  for (let i = 0; i < folders.length; i += 25) {
    const batch = await Promise.all(
      folders.slice(i, i + 25).map(async (folder) => {
        const job = await readJson<{ jobId?: string; appId?: string; knowledgeBaseIds?: string[]; artifactKey?: string }>(s3, bucket, `${folder}job.json`);
        if (!job || job.appId !== appId) return null;
        const status = await readJson<{ state?: string; updatedAt?: string }>(s3, bucket, `${folder}status.json`);
        const jobId = folder.slice(0, -1).split('/').pop()!;
        return {
          jobId,
          ...(status?.state ? { state: status.state } : {}),
          ...(status?.updatedAt ? { updatedAt: status.updatedAt } : {}),
          ...(job.knowledgeBaseIds ? { knowledgeBaseIds: job.knowledgeBaseIds } : {}),
          ...(job.artifactKey ? { artifactKey: job.artifactKey } : {}),
        } satisfies JobInfo;
      }),
    );
    for (const j of batch) if (j) out.push(j);
  }
  return out;
}

/** 仍在執行(非終態且最近有更新)的任務。 */
export function runningJobs(jobs: JobInfo[], now = Date.now()): Array<{ jobId: string; state: string }> {
  return jobs
    .filter((j) => {
      const state = j.state ?? 'queued';
      if (TERMINAL.has(state)) return false;
      const t = j.updatedAt ? Date.parse(j.updatedAt) : NaN;
      return Number.isFinite(t) && now - t < STALE_RUNNING_MS;
    })
    .map((j) => ({ jobId: j.jobId, state: j.state ?? 'queued' }));
}

/** artifacts/<id>/... key → id。 */
function artifactIdFromKey(tenantId: string, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const base = `${tenantPrefix(tenantId)}artifacts/`;
  if (!key.startsWith(base)) return undefined;
  const id = key.slice(base.length).split('/')[0];
  return id && ARTIFACT_ID_RE.test(id) ? id : undefined;
}

export interface PurgeDeps {
  s3: S3Client;
  sharedS3: S3Client;
  bucket: string;
  tenantId: string;
  secretWriter?: SecretWriter;
  /** 其他 App(判斷安裝檔是否仍被共用)。 */
  otherApps: AppRecord[];
  /** 刪 App 紀錄(最後一步)。 */
  deleteAppRecord: () => Promise<void>;
}

/**
 * 連帶刪除工作區的所有資料。app 為 null 表示 App 紀錄已不存在(仍會清掉殘留資料)。
 * 有正在執行的測試 → 丟 AppRunningError(什麼都不刪)。
 */
export async function purgeApp(deps: PurgeDeps, appId: string, app: AppRecord | null, opts: { budgetMs?: number } = {}): Promise<PurgeResult> {
  if (!APP_ID_RE.test(appId)) throw new Error('appId 格式不正確');
  const { s3, bucket, tenantId } = deps;
  const base = tenantPrefix(tenantId);
  const deadline = new Deadline(Date.now() + (opts.budgetMs ?? 20_000));
  const deleted: PurgeCounts = { jobs: 0, cases: 0, caseVersions: 0, memory: 0, knowledge: 0, artifacts: 0, credentials: 0 };
  const unfinished = (): PurgeResult => ({ done: false, deleted });

  const jobs = await findAppJobs(s3, bucket, tenantId, appId);
  const running = runningJobs(jobs);
  if (running.length > 0) throw new AppRunningError(running);

  // 1. 測試任務 / 報告(含截圖、影片、指令、洞察…)。並發 4 個任務。
  const queue = [...jobs];
  const cleared: JobInfo[] = [];
  let jobsDone = true;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const prefix = `${base}jobs/${j.jobId}/`;
        const [n, complete] = await deletePrefix(s3, bucket, prefix, deadline, `${prefix}job.json`);
        deleted.jobs += n;
        if (complete) cleared.push(j);
        else jobsDone = false;
      }
    }),
  );
  // 知識庫引用索引是「讀-改-寫」沒有鎖:逐筆依序更新,避免並發互相覆蓋。
  for (const j of cleared) {
    await removeKbRefs(deps.sharedS3, bucket, j.knowledgeBaseIds, { type: 'job', tenantId, jobId: j.jobId }).catch(() => {});
  }
  if (!jobsDone) return unfinished();

  // 2. 測試情境 + 版本紀錄、3. 記憶。
  for (const [field, prefix] of [
    ['cases', `${base}cases/${appId}/`],
    ['caseVersions', `${base}case-versions/${appId}/`],
    ['memory', `${base}memory/${appId}/`],
  ] as const) {
    const [n, complete] = await deletePrefix(s3, bucket, prefix, deadline);
    deleted[field] += n;
    if (!complete) return unfinished();
  }

  // 4. 手寫知識。
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${base}knowledge/${appId}.md` }));
  deleted.knowledge += 1;

  // 5. 安裝檔 / 圖示:App 本身(含所有版本)與各任務用過的;其他 App 還在用的保留。
  // in-use 必須展開其他 App 的 builds[],否則刪一個 App 會誤刪另一個 App 的歷史版本安裝檔。
  const inUse = new Set(
    deps.otherApps
      .flatMap((a) => [a.artifactId, a.iconArtifactId, ...(a.builds ?? []).map((b) => b.artifactId)])
      .filter((x): x is string => Boolean(x)),
  );
  const artifactIds = new Set(
    [
      app?.artifactId,
      app?.iconArtifactId,
      ...(app?.builds ?? []).map((b) => b.artifactId),
      ...jobs.map((j) => artifactIdFromKey(tenantId, j.artifactKey)),
    ].filter(
      (x): x is string => typeof x === 'string' && ARTIFACT_ID_RE.test(x) && !inUse.has(x),
    ),
  );
  for (const id of artifactIds) {
    const [n, complete] = await deletePrefix(s3, bucket, `${base}artifacts/${id}/`, deadline);
    deleted.artifacts += n;
    if (!complete) return unfinished();
  }

  // 6. 測試帳密(整個 secret;找不到視為成功)。
  if (deps.secretWriter) {
    await deps.secretWriter.deleteSecret(appCredentialsSecretName(tenantId, appId));
    deleted.credentials += 1;
  }

  // 7. 知識庫引用 + App 紀錄。
  await removeKbRefs(deps.sharedS3, bucket, app?.defaultKnowledgeBaseIds, { type: 'app', tenantId, appId }).catch(() => {});
  await deps.deleteAppRecord();
  return { done: true, deleted };
}
