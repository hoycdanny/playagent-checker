import {
  ListObjectsV2Command,
  GetObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import type { TaskState } from './status.js';

/**
 * 案例趨勢與 flaky 分診(Req 12)——純函式核心 + S3 彙整。
 *
 * flaky 的定義(Req 12.2):在「無對應被測變更」(同一 App 產物版本 artifactId)的前提下,
 * 同一案例的結果在 pass 與 fail 之間反覆(至少一次翻轉)。此與「確定性 fail」(同一產物下
 * 一路都 fail)明確區分——後者是真缺陷,不標 flaky。
 *
 * error(環境/基礎設施)不參與 flaky 判定(它不是 App 行為訊號);趨勢計數區分呈現。
 */

/** 一次執行在趨勢分析中的精煉樣態。 */
export interface RunPoint {
  jobId: string;
  state: TaskState | 'queued';
  /** 執行當下被測 App 的產物版本(用以判斷「有無被測變更」)。 */
  artifactVersion: string;
  createdAt: string;
}

export interface CaseTrend {
  appId: string;
  caseId: string;
  /** 最近 N 次結果(新→舊),供 UI 呈現趨勢條。 */
  recent: Array<{ jobId: string; state: RunPoint['state']; createdAt: string }>;
  total: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  /** 通過率(僅計 pass/fail 這類確定性結果,排除 error/queued/running/cancelled)。 */
  passRate: number | null;
  /** flaky 判定(Req 12.2)。 */
  flaky: boolean;
  /** 判定說明(供 UI/審計)。 */
  flakyReason: string;
}

/** 只有 pass/fail 才是「App 行為的確定性訊號」。 */
function isDeterministic(state: RunPoint['state']): state is 'pass' | 'fail' {
  return state === 'pass' || state === 'fail';
}

/**
 * 純函式:由一組執行點(任意順序)計算案例趨勢與 flaky。
 * @param recentN 最近幾次納入 recent 呈現(預設 10)。
 */
export function computeCaseTrend(
  appId: string,
  caseId: string,
  points: RunPoint[],
  recentN = 10,
): CaseTrend {
  // 依時間新→舊排序。
  const sorted = [...points].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const passCount = sorted.filter((p) => p.state === 'pass').length;
  const failCount = sorted.filter((p) => p.state === 'fail').length;
  const errorCount = sorted.filter((p) => p.state === 'error').length;
  const deterministic = passCount + failCount;
  const passRate = deterministic > 0 ? passCount / deterministic : null;

  const { flaky, flakyReason } = detectFlaky(sorted);

  return {
    appId,
    caseId,
    recent: sorted.slice(0, recentN).map((p) => ({
      jobId: p.jobId,
      state: p.state,
      createdAt: p.createdAt,
    })),
    total: sorted.length,
    passCount,
    failCount,
    errorCount,
    passRate,
    flaky,
    flakyReason,
  };
}

/**
 * flaky 偵測:對每個「產物版本」分組,若該組內同時出現 pass 與 fail(結果反覆但被測未變),
 * 即判為 flaky。跨產物版本的 pass→fail 變化可能是真回歸,不據此判 flaky。
 */
function detectFlaky(sorted: RunPoint[]): { flaky: boolean; flakyReason: string } {
  const byVersion = new Map<string, Set<'pass' | 'fail'>>();
  for (const p of sorted) {
    if (!isDeterministic(p.state)) continue;
    const set = byVersion.get(p.artifactVersion) ?? new Set<'pass' | 'fail'>();
    set.add(p.state);
    byVersion.set(p.artifactVersion, set);
  }
  for (const [version, results] of byVersion) {
    if (results.has('pass') && results.has('fail')) {
      return {
        flaky: true,
        flakyReason: `同一被測版本(${version})下結果反覆(pass 與 fail 皆出現),可能為 flaky`,
      };
    }
  }
  return { flaky: false, flakyReason: '無反覆:同一被測版本下結果一致(或樣本不足)' };
}

/**
 * 成因引導(Req 12.3):依終局狀態給出分診方向。
 * fail → 被測 App / 測試案例;error → 環境 / 基礎設施。
 */
export function triageHint(state: RunPoint['state']): 'app-or-case' | 'infra' | 'none' {
  if (state === 'fail') return 'app-or-case';
  if (state === 'error') return 'infra';
  return 'none';
}

/* ---------- S3 彙整:讀某案例的歷史執行 ---------- */

interface JobMeta {
  jobId: string;
  appId: string;
  caseId: string;
  artifactVersion: string;
  createdAt: string;
}

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/**
 * 彙整某租戶下某案例的歷史執行為趨勢。掃 jobs 前綴,篩出 appId/caseId 相符者,
 * 合併其 status.state 與執行當下的 artifactVersion(記於 job.json,缺則以 appId 當版本)。
 */
export async function readCaseTrend(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
  caseId: string,
  recentN = 10,
): Promise<CaseTrend> {
  const prefix = `${tenantPrefix(tenantId)}jobs/`;
  // 用 Delimiter='/' 只列「job 資料夾」(CommonPrefixes),不把每個 job 底下上千張
  // screenshots/steps/traces 都列出來——否則 1000 個 key 的單頁上限會被截圖塞爆,
  // 較新的 job.json 排在後面就掃不到,導致趨勢誤判為「尚無歷史」。仍需分頁抓完所有資料夾。
  const jobKeys: string[] = [];
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const cp of list.CommonPrefixes ?? []) {
      if (cp.Prefix) jobKeys.push(`${cp.Prefix}job.json`);
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  const points: RunPoint[] = [];
  await Promise.all(
    jobKeys.map(async (key) => {
      const job = await readJson<JobMeta & { artifactVersion?: string }>(s3, bucket, key);
      if (!job || job.appId !== appId || job.caseId !== caseId) return;
      const statusKey = key.replace(/job\.json$/, 'status.json');
      const status = await readJson<{ state: TaskState }>(s3, bucket, statusKey);
      points.push({
        jobId: job.jobId,
        state: status?.state ?? 'queued',
        artifactVersion: job.artifactVersion ?? appId,
        createdAt: job.createdAt,
      });
    }),
  );

  return computeCaseTrend(appId, caseId, points, recentN);
}
