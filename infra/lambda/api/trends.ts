import {
  ListObjectsV2Command,
  GetObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import type { TaskState } from './status.js';
import { verdictKey, type Verdict, type VerdictRecord } from './tasks.js';

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
  /**
   * 測試結論(verdict.json,由報告引擎依驗收標準算出)。
   *
   * 趨勢與 flaky 要用這個,不是 `state`。`state` 只代表 AI 有沒有走完流程 ——
   * 「執行完成」不等於通過(見 docs/design/acceptance-standard.md §1)。
   * 兩者混用過去造成過「列表通過、報告失敗」的矛盾。
   */
  verdict?: Verdict;
}

/** 趨勢分析用的結果訊號。blocked 不進通過率分母(那次測試沒有得出結果)。 */
export type RunOutcome = 'pass' | 'fail' | 'blocked' | 'none';

/** 這個訊號是依結論算的,還是沒有結論只好退回執行結果。 */
export type OutcomeBasis = 'verdict' | 'execution_state';

/**
 * 一次執行的結果訊號。
 *
 * 優先用測試結論。沒有結論(舊任務尚未算過)才退回執行結果,並標明依據 ——
 * 退回是為了不讓歷史資料整片變空白,但它的意義較弱,必須讓讀者看得到。
 */
export function runSignal(p: RunPoint): { outcome: RunOutcome; basis: OutcomeBasis } {
  if (p.verdict) {
    // 通過(有風險)仍是通過:必要項目全過,只是有建議項目或待判讀。
    if (p.verdict === 'PASS' || p.verdict === 'PASS_WITH_RISK') return { outcome: 'pass', basis: 'verdict' };
    if (p.verdict === 'FAIL') return { outcome: 'fail', basis: 'verdict' };
    return { outcome: 'blocked', basis: 'verdict' };
  }
  if (p.state === 'pass') return { outcome: 'pass', basis: 'execution_state' };
  if (p.state === 'fail') return { outcome: 'fail', basis: 'execution_state' };
  return { outcome: 'none', basis: 'execution_state' };
}

/** 修正複驗鏈:初測失敗 → 換版本 → 複驗通過。 */
export interface RetestChain {
  /** 依時間新→舊的版本段(同一產物版本合併為一段)。 */
  stages: Array<{
    artifactVersion: string;
    outcome: RunOutcome;
    basis: OutcomeBasis;
    firstAt: string;
    lastAt: string;
    jobIds: string[];
  }>;
  /** 偵測到的修正複驗:某版本失敗,之後的新版本通過。 */
  links: Array<{ failedVersion: string; failedJobId: string; retestVersion: string; retestJobId: string }>;
  /** 失敗後尚未在任何後續版本通過的版本。 */
  unresolved: Array<{ artifactVersion: string; jobId: string }>;
  note: string;
}

export interface CaseTrend {
  appId: string;
  caseId: string;
  /**
   * 最近 N 次結果(新→舊),供 UI 呈現趨勢條。
   * `outcome` 才是該次的測試結論;`state` 只是執行結果,保留供排錯對照,不該用來畫結果點。
   */
  recent: Array<{
    jobId: string;
    state: RunPoint['state'];
    createdAt: string;
    outcome: RunOutcome;
    basis: OutcomeBasis;
  }>;
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
  /** 受阻次數(不進通過率分母:那幾次沒有得出結果)。 */
  blockedCount: number;
  /**
   * 判定依據的組成:有多少點是依測試結論算的。
   * 依據混雜時,通過率的意義會被稀釋,所以要讓讀者看得到比例而不是只看到一個百分比。
   */
  verdictCoverage: { withVerdict: number; total: number; note: string };
  /** 修正複驗鏈。 */
  retest: RetestChain;
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

  const signals = sorted.map((p) => ({ point: p, ...runSignal(p) }));

  const passCount = signals.filter((s) => s.outcome === 'pass').length;
  const failCount = signals.filter((s) => s.outcome === 'fail').length;
  const blockedCount = signals.filter((s) => s.outcome === 'blocked').length;
  const errorCount = sorted.filter((p) => p.state === 'error').length;
  // 受阻不進分母:那次測試沒有得出結果(對齊驗收標準 §2)。
  const deterministic = passCount + failCount;
  const passRate = deterministic > 0 ? passCount / deterministic : null;

  const withVerdict = signals.filter((s) => s.basis === 'verdict').length;
  const verdictCoverage = {
    withVerdict,
    total: sorted.length,
    note:
      sorted.length === 0
        ? '無歷史執行'
        : withVerdict === sorted.length
          ? '全部依測試結論判定'
          : withVerdict === 0
            ? '皆無測試結論,全部退回執行結果;執行完成不等於通過,此通過率意義較弱'
            : `${sorted.length - withVerdict}/${sorted.length} 筆沒有測試結論,已退回執行結果;依據混雜,通過率意義較弱`,
  };

  const { flaky, flakyReason } = detectFlaky(signals);

  return {
    appId,
    caseId,
    recent: signals.slice(0, recentN).map((s) => ({
      jobId: s.point.jobId,
      state: s.point.state,
      createdAt: s.point.createdAt,
      outcome: s.outcome,
      basis: s.basis,
    })),
    total: sorted.length,
    passCount,
    failCount,
    errorCount,
    blockedCount,
    passRate,
    flaky,
    flakyReason,
    verdictCoverage,
    retest: computeRetestChain(points),
  };
}

/**
 * 修正複驗鏈。
 *
 * 規則:**初測的失敗不被覆寫**。複驗通過只代表後續版本通過,原版本那一列仍是 FAIL ——
 * 用新版本的結果蓋掉舊版本的失敗,會讓這份歷史看起來從沒出過問題。
 */
export function computeRetestChain(points: RunPoint[]): RetestChain {
  const asc = [...points].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 同一產物版本合併為一段;段內若出現失敗,該段即記為失敗(不被同版本的後續通過抹掉)。
  const order: string[] = [];
  const groups = new Map<string, { jobIds: string[]; firstAt: string; lastAt: string; outcomes: Array<{ outcome: RunOutcome; basis: OutcomeBasis; jobId: string }> }>();
  for (const p of asc) {
    const g = groups.get(p.artifactVersion);
    const sig = runSignal(p);
    if (!g) {
      order.push(p.artifactVersion);
      groups.set(p.artifactVersion, {
        jobIds: [p.jobId],
        firstAt: p.createdAt,
        lastAt: p.createdAt,
        outcomes: [{ ...sig, jobId: p.jobId }],
      });
      continue;
    }
    g.jobIds.push(p.jobId);
    g.lastAt = p.createdAt;
    g.outcomes.push({ ...sig, jobId: p.jobId });
  }

  const stagesAsc = order.map((version) => {
    const g = groups.get(version)!;
    const firstFail = g.outcomes.find((o) => o.outcome === 'fail');
    const firstPass = g.outcomes.find((o) => o.outcome === 'pass');
    const firstBlocked = g.outcomes.find((o) => o.outcome === 'blocked');
    const chosen = firstFail ?? firstPass ?? firstBlocked ?? g.outcomes[0]!;
    return {
      artifactVersion: version,
      outcome: chosen.outcome,
      basis: chosen.basis,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      jobIds: g.jobIds,
      failJobId: firstFail?.jobId,
    };
  });

  const links: RetestChain['links'] = [];
  const unresolved: RetestChain['unresolved'] = [];
  for (let i = 0; i < stagesAsc.length; i++) {
    const stage = stagesAsc[i]!;
    if (stage.outcome !== 'fail') continue;
    // 只往後找:同一版本的重跑不算複驗(被測沒有變更)。
    const retest = stagesAsc.slice(i + 1).find((s) => s.outcome === 'pass');
    if (retest) {
      links.push({
        failedVersion: stage.artifactVersion,
        failedJobId: stage.failJobId ?? stage.jobIds[0]!,
        retestVersion: retest.artifactVersion,
        retestJobId: retest.jobIds[0]!,
      });
    } else {
      unresolved.push({ artifactVersion: stage.artifactVersion, jobId: stage.failJobId ?? stage.jobIds[0]! });
    }
  }

  const note =
    stagesAsc.length === 0
      ? '無歷史執行,無法建立複驗鏈'
      : links.length === 0 && unresolved.length === 0
        ? '歷史中沒有失敗的版本,無複驗鏈'
        : `${links.length} 筆已複驗通過、${unresolved.length} 筆尚未複驗通過;原版本的失敗紀錄保留不覆寫`;

  return {
    stages: stagesAsc.reverse().map(({ failJobId: _failJobId, ...s }) => s),
    links,
    unresolved,
    note,
  };
}

/**
 * flaky 偵測:對每個「產物版本」分組,若該組內同時出現 pass 與 fail(結果反覆但被測未變),
 * 即判為 flaky。跨產物版本的 pass→fail 變化可能是真回歸,不據此判 flaky。
 */
function detectFlaky(
  signals: Array<{ point: RunPoint; outcome: RunOutcome; basis: OutcomeBasis }>,
): { flaky: boolean; flakyReason: string } {
  // 依產物版本分組,只看 pass / fail(受阻與未得出結果不是 App 行為訊號)。
  const byVersion = new Map<string, Array<{ outcome: 'pass' | 'fail'; basis: OutcomeBasis }>>();
  for (const s of signals) {
    if (s.outcome !== 'pass' && s.outcome !== 'fail') continue;
    const list = byVersion.get(s.point.artifactVersion) ?? [];
    list.push({ outcome: s.outcome, basis: s.basis });
    byVersion.set(s.point.artifactVersion, list);
  }

  for (const [version, results] of byVersion) {
    // 同一版本內依據不要混用:若已有依結論判定的點,就忽略退回執行結果的點。
    // 否則「執行完成但結論失敗」的那一次會被算成 pass,憑空造出一個 flaky。
    const hasVerdict = results.some((r) => r.basis === 'verdict');
    const considered = hasVerdict ? results.filter((r) => r.basis === 'verdict') : results;
    const outcomes = new Set(considered.map((r) => r.outcome));
    if (outcomes.has('pass') && outcomes.has('fail')) {
      return {
        flaky: true,
        flakyReason: `同一被測版本(${version})下結果反覆(通過與失敗皆出現),可能為 flaky${hasVerdict ? '' :
          ';此判定退回執行結果,非測試結論'}`,
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
      // 結論與執行結果一起讀:趨勢與 flaky 要用結論,缺結論才退回執行結果。
      const [status, verdict] = await Promise.all([
        readJson<{ state: TaskState }>(s3, bucket, statusKey),
        readJson<VerdictRecord>(s3, bucket, verdictKey(tenantId, job.jobId)).catch(() => null),
      ]);
      points.push({
        jobId: job.jobId,
        state: status?.state ?? 'queued',
        artifactVersion: job.artifactVersion ?? appId,
        createdAt: job.createdAt,
        ...(verdict?.verdict ? { verdict: verdict.verdict } : {}),
      });
    }),
  );

  return computeCaseTrend(appId, caseId, points, recentN);
}
