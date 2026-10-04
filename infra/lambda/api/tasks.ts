import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import type { TaskState } from './status.js';
import { computeSpend, PricingError } from './pricing.js';

export const BACKENDS = ['web', 'emulator', 'windows', 'devicefarm', 'attached'] as const;
export type Backend = (typeof BACKENDS)[number];

export class ValidationError extends Error {}

/** cloud = 雲端供給裝置;attached = 使用者本地裝置。由 backend 推導。 */
export type Locality = 'cloud' | 'attached';
export function localityOf(backend: Backend): Locality {
  return backend === 'attached' ? 'attached' : 'cloud';
}

export interface JobRecord {
  jobId: string;
  tenantId: string;
  backend: Backend;
  locality: Locality;
  category: 'test' | 'exploration';
  appId: string;
  caseId: string;
  /** 執行當下被測 App 的產物版本快照(供趨勢判斷「有無被測變更」,Req 12.2)。 */
  artifactVersion?: string;
  /** 使用者選的 VLM 模型(分析畫面)。 */
  vlmModel?: string;
  /** 使用者選的 Agent 模型(控制遊戲)。 */
  agentModel?: string;
  /** 使用者選的 Subagent 模型(子代理)。 */
  subagentModel?: string;
  /** 步數上限(未設=無上限)。 */
  maxSteps?: number;
  /** 預算上限(美元;未設=無上限)。 */
  budgetUsd?: number;
  /** 被測產物的完整 S3 key(emulator userdata 據此拉 APK)。 */
  artifactKey?: string;
  /** 案例任務描述(emulator runner 給 VLM 的目標)。 */
  caseTask?: string;
  /** guest ABI(emulator 選主機架構;預設 arm64-v8a)。 */
  abi?: string;
  /** Android 包名(OBB 推送與自動啟動遊戲用)。 */
  package?: string;
  /** 被測平台(android/ios;Device Farm 據此選裝置與 Appium automationName)。 */
  platform?: string;
  /** 提交時使用者選的 Device Farm 實體裝置 ARN(engine 依此挑真機而非取第一台)。 */
  deviceArn?: string;
  /** 提交時選的裝置機型名稱(顯示用;實際挑機以 deviceArn 為準)。 */
  deviceModel?: string;
  /** 提交時選的 Android 版本(顯示用;deviceArn 已隱含版本)。 */
  osVersion?: string;
  /** 提交時選的共用知識庫 id 快照(執行時據此讀取並注入 Markdown)。 */
  knowledgeBaseIds?: string[];
  /** 提交時 App 的遊戲類型快照(主類型在前);報告引擎據此合併 GenreProfile。 */
  genres?: string[];
  /** 提交時所用知識庫的快照(報告依執行當時的知識庫計算,之後修改/封存不影響舊報告)。 */
  kbSnapshot?: KbSnapshot[];
  /** 操作行為(控制方案)快照:案例指定或依類型建議;runner 據此限定手勢與注入操作說明。 */
  controls?: JobControls;
  /** 本次執行所用的案例版本(不可變,YYYY-MMDD-HHmm-SSss);報告/溯源依此讀取當時的案例內容。 */
  caseVersion?: string;
  /** 該版本的案例名稱快照。 */
  caseName?: string;
  createdAt: string;
}

export interface JobControls {
  ids: string[];
  source: 'case' | 'genre';
}

export interface KbSnapshot {
  id: string;
  name: string;
  genre?: string;
  version?: string;
  revision?: number;
  builtin?: boolean;
  markdown?: string;
  reportSpec?: unknown;
}

function jobsPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}jobs/`;
}
function jobKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/job.json`;
}
function statusKeyFor(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/status.json`;
}
export function cancelKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/cancel.json`;
}
/** 即時畫面幀 key(runner 持續覆寫的最新一幀;web=JPEG、真機=PNG,前端 <img> 皆可顯示)。 */
export function liveFrameKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/live`;
}
function configKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/config.json`;
}
function reportKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/report.json`;
}

interface SubmitInput {
  backend: Backend;
  appId: string;
  caseId: string;
  category: 'test' | 'exploration';
  /** 使用者選的 VLM 模型(分析畫面/判座標);未指定則引擎用預設。 */
  vlmModel?: string;
  /** 使用者選的 Agent 模型(控制遊戲/決策);未指定則引擎用預設。 */
  agentModel?: string;
  /** 使用者選的 Subagent 模型(輔助子任務);未指定則引擎用預設。 */
  subagentModel?: string;
  /** 選用的共用知識庫 id(可多選,Slot + RTP 疊加)。 */
  knowledgeBaseIds?: string[];
  /** 指定執行的案例版本;未指定則用案例目前使用中的版本。 */
  caseVersion?: string;
  /** 步數上限;未指定或 <=0 代表「無上限」。 */
  maxSteps?: number;
  /** 預算上限(美元);未指定或 <=0 代表「無上限」。 */
  budgetUsd?: number;
  /** Device Farm:使用者明選的實體裝置 ARN(engine 依此挑真機而非取第一台)。 */
  deviceArn?: string;
  /** Device Farm:所選機型名稱(顯示用)。 */
  deviceModel?: string;
  /** Device Farm:所選 Android 版本(顯示用;deviceArn 已隱含版本)。 */
  osVersion?: string;
}

/** 提交前校驗請求形狀(存在性校驗於 core 內另做,需 S3)。 */
export function validateSubmit(body: unknown): SubmitInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const backend = b['backend'];
  if (typeof backend !== 'string' || !(BACKENDS as readonly string[]).includes(backend)) {
    throw new ValidationError(`backend 必須是 ${BACKENDS.join('/')} 之一`);
  }
  const appId = b['appId'];
  const caseId = b['caseId'];
  if (typeof appId !== 'string' || appId === '') throw new ValidationError('appId 為必填');
  if (typeof caseId !== 'string' || caseId === '') throw new ValidationError('caseId 為必填');
  const category = b['category'] === 'exploration' ? 'exploration' : 'test';
  const vlmModel = typeof b['vlmModel'] === 'string' ? b['vlmModel'] : undefined;
  const agentModel = typeof b['agentModel'] === 'string' ? b['agentModel'] : undefined;
  const subagentModel = typeof b['subagentModel'] === 'string' ? b['subagentModel'] : undefined;
  // 知識庫 id 陣列(可多選);只收安全字串 id。
  const rawKbIds = b['knowledgeBaseIds'];
  const knowledgeBaseIds = Array.isArray(rawKbIds)
    ? rawKbIds.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x))
    : undefined;
  // 步數/預算上限:僅收「有限正數」;空/0/負/非數 一律視為無上限(不帶入)。
  const rawMaxSteps = Number(b['maxSteps']);
  const maxSteps = Number.isFinite(rawMaxSteps) && rawMaxSteps > 0 ? Math.floor(rawMaxSteps) : undefined;
  const rawBudget = Number(b['budgetUsd']);
  const budgetUsd = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined;
  // Device Farm 裝置選擇(僅 devicefarm 後端有意義;其他後端即使帶了也不落 job)。
  // deviceArn 需符合 Device Farm ARN 形狀,避免注入任意值。
  const rawDeviceArn = b['deviceArn'];
  // Device Farm 公有裝置 ARN 的 account 欄位為空(如 arn:aws:devicefarm:us-west-2::device:XXXX),
  // 故 account 段允許空或數字。
  const deviceArn =
    backend === 'devicefarm' &&
    typeof rawDeviceArn === 'string' &&
    /^arn:aws:devicefarm:[a-z0-9-]+:\d*:device:[A-Za-z0-9-]+$/.test(rawDeviceArn)
      ? rawDeviceArn
      : undefined;
  const deviceModel =
    backend === 'devicefarm' && typeof b['deviceModel'] === 'string' && b['deviceModel'] !== ''
      ? (b['deviceModel'] as string)
      : undefined;
  const osVersion =
    backend === 'devicefarm' && typeof b['osVersion'] === 'string' && b['osVersion'] !== ''
      ? (b['osVersion'] as string)
      : undefined;
  // 指定案例版本(可選;不帶則用案例目前使用中的版本)。
  const rawCaseVersion = b['caseVersion'];
  if (rawCaseVersion !== undefined && rawCaseVersion !== null && rawCaseVersion !== '') {
    if (typeof rawCaseVersion !== 'string' || !/^\d{4}-\d{4}-\d{4}-\d{4}$/.test(rawCaseVersion)) {
      throw new ValidationError('caseVersion 格式不正確(YYYY-MMDD-HHmm-SSss)');
    }
  }
  const caseVersion = typeof rawCaseVersion === 'string' && rawCaseVersion !== '' ? rawCaseVersion : undefined;
  return {
    ...(caseVersion ? { caseVersion } : {}),
    backend: backend as Backend,
    appId,
    caseId,
    category,
    ...(vlmModel ? { vlmModel } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(knowledgeBaseIds && knowledgeBaseIds.length > 0 ? { knowledgeBaseIds } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(deviceArn ? { deviceArn } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(osVersion ? { osVersion } : {}),
  };
}

const JOB_ID_RE = /^job-[a-z0-9-]+$/;

/** 生成 jobId(時間戳 + 亂數,可排序)。 */
export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isValidJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

export async function createJob(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  input: SubmitInput,
  artifactVersion?: string,
  extra?: { artifactKey?: string; caseTask?: string; abi?: string; package?: string; platform?: string; genres?: string[]; kbSnapshot?: KbSnapshot[]; controls?: JobControls; caseVersion?: string; caseName?: string },
): Promise<JobRecord> {
  const jobId = newJobId();
  const record: JobRecord = {
    jobId,
    tenantId,
    backend: input.backend,
    locality: localityOf(input.backend),
    category: input.category,
    appId: input.appId,
    caseId: input.caseId,
    ...(artifactVersion ? { artifactVersion } : {}),
    ...(input.vlmModel ? { vlmModel: input.vlmModel } : {}),
    ...(input.agentModel ? { agentModel: input.agentModel } : {}),
    ...(input.subagentModel ? { subagentModel: input.subagentModel } : {}),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.deviceArn ? { deviceArn: input.deviceArn } : {}),
    ...(input.deviceModel ? { deviceModel: input.deviceModel } : {}),
    ...(input.osVersion ? { osVersion: input.osVersion } : {}),
    ...(extra?.artifactKey ? { artifactKey: extra.artifactKey } : {}),
    ...(extra?.caseTask ? { caseTask: extra.caseTask } : {}),
    ...(extra?.abi ? { abi: extra.abi } : {}),
    ...(extra?.package ? { package: extra.package } : {}),
    ...(extra?.platform ? { platform: extra.platform } : {}),
    ...(extra?.genres && extra.genres.length > 0 ? { genres: extra.genres } : {}),
    ...(extra?.kbSnapshot && extra.kbSnapshot.length > 0 ? { kbSnapshot: extra.kbSnapshot } : {}),
    ...(extra?.controls && extra.controls.ids.length > 0 ? { controls: extra.controls } : {}),
    ...(extra?.caseVersion ? { caseVersion: extra.caseVersion } : {}),
    ...(extra?.caseName ? { caseName: extra.caseName } : {}),
    ...(input.knowledgeBaseIds && input.knowledgeBaseIds.length > 0
      ? { knowledgeBaseIds: input.knowledgeBaseIds }
      : {}),
    createdAt: new Date().toISOString(),
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: jobKey(tenantId, jobId),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
  return record;
}

export interface TaskListItem {
  jobId: string;
  backend: Backend;
  locality: Locality;
  category: string;
  appId: string;
  caseId: string;
  state: TaskState | 'queued';
  createdAt: string;
  updatedAt?: string;
  /** 使用者選的 VLM 模型 id(供列表顯示模型圖示)。 */
  vlmModel?: string;
  /** 各角色(seat)實際生效的模型 id:agent=控制遊戲、vlm=分析畫面、subagent=子代理。 */
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  /** 實際花費(美元);報告未直接記錄時由 token × 單價估算。無報告則 undefined。 */
  billableSpendUsd?: number;
  /** billableSpendUsd 是否為估算(而非引擎直接記錄)。 */
  spendEstimated?: boolean;
  /** 已執行步數(終局取 report.stepCount;執行中取 status.steps)。無則 undefined。 */
  stepCount?: number;
  /** 終局訊息(如「達步數上限」「偵測到 App 死循環」),供報告列表一眼看出結果原因。 */
  message?: string;
  /** 任務目標摘要(report.task 或 job.caseTask,截斷 200 字)。 */
  task?: string;
  /** 實際執行的裝置機型。 */
  deviceModel?: string;
  /** 結束時間(報告產生時間;無報告則取最後狀態更新)。 */
  finishedAt?: string;
  /** 執行時的案例版本號(功能上線前的舊任務無此欄位)。 */
  caseVersion?: string;
  /** 執行時的案例名稱快照。 */
  caseName?: string;
}

/** 讀某物件 JSON(不存在回 null)。 */
async function readJson<T>(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<T | null> {
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

/** listJobs 選項:分頁上限。省略 limit 代表回全部(維持既有行為)。 */
export interface ListJobsOptions {
  /** 只回最新的 N 筆(依 jobId 時間序);省略=全部。 */
  limit?: number;
}

/** listJobs 結果:任務清單 + 該租戶任務總數(供前端顯示「N 之中的前 M」)。 */
export interface ListJobsResult {
  items: TaskListItem[];
  total: number;
}

/** 列出某租戶任務(合併 job/status/report/config)。可選 limit 只取最新 N 筆。 */
export async function listJobs(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  opts: ListJobsOptions = {},
): Promise<ListJobsResult> {
  // 只列「任務資料夾」而非資料夾內所有物件:用 Delimiter:'/' 讓 S3 回 CommonPrefixes
  // (每個 job 一個前綴),而不是把 steps/screenshots/annotated 數千個物件全撈回來再過濾。
  // 舊做法會分頁掃遍每個 job 的數十個 step 物件 → 任務一多,ListObjectsV2 往返暴增,
  // 是 /tasks 端點慢到十幾秒的主因。改用 delimiter 後,列表成本只與「任務數」成正比。
  const jobFolders: string[] = [];
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: jobsPrefix(tenantId),
        Delimiter: '/',
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const p of list.CommonPrefixes ?? []) {
      // p.Prefix 形如 "tenants/<tid>/jobs/<jobId>/"。
      if (typeof p.Prefix === 'string') jobFolders.push(p.Prefix);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  const total = jobFolders.length;

  // jobId 為 `job-<Date.now() base36>-<rand>`,base36 時間戳在同世代下字典序即時間序,
  // 因此可先「僅憑資料夾名」排序取最新 N 筆,再只讀那 N 筆的物件 —— 避免對全部任務
  // 各讀 4 個 S3 檔(N+1 展開)。這是 /tasks 從 ~8s 進一步降到 <2s 的關鍵。
  const ordered = jobFolders.sort((a, b) => b.localeCompare(a));
  const selected =
    typeof opts.limit === 'number' && opts.limit > 0
      ? ordered.slice(0, opts.limit)
      : ordered;
  const jobKeys = selected.map((prefix) => `${prefix}job.json`);

  const items = await Promise.all(
    jobKeys.map(async (key) => {
      const job = await readJson<JobRecord>(s3, bucket, key);
      if (!job) return null;
      // status(狀態)、report(花費/模型)、config(各角色模型)併發讀取,避免序列往返拖慢列表。
      const [status, report, config] = await Promise.all([
        readJson<{ state: TaskState; updatedAt: string; steps?: number; message?: string }>(
          s3,
          bucket,
          statusKeyFor(tenantId, job.jobId),
        ),
        readJson<ReportShape>(s3, bucket, reportKey(tenantId, job.jobId)),
        readJson<ConfigSnapshot>(s3, bucket, configKey(tenantId, job.jobId)),
      ]);
      // 各角色(seat)模型:agent=控制遊戲、vlm=分析畫面、subagent=子代理(來自 config 快照)。
      const seatModels = config?.seats
        ? config.seats.reduce<Record<string, string>>((acc, s) => {
            if (s.seat && s.modelId) acc[s.seat] = s.modelId;
            return acc;
          }, {})
        : undefined;
      // 花費估算與「模型」代表值:優先取 vlm seat(逐步分析畫面,主要花費),
      // 否則 report.vlmModel,再退回 job.vlmModel。
      const vlmModel = seatModels?.vlm ?? report?.vlmModel ?? job.vlmModel;
      // 花費:report 直接記錄優先;否則以 token × 該模型單價估算(Fail Closed:查無單價則留空)。
      let billableSpendUsd: number | undefined;
      let spendEstimated = false;
      if (typeof report?.billableSpendUsd === 'number') {
        billableSpendUsd = report.billableSpendUsd;
      } else if (
        vlmModel &&
        typeof report?.tokens?.input === 'number' &&
        typeof report.tokens.output === 'number'
      ) {
        try {
          billableSpendUsd = computeSpend(vlmModel, report.tokens.input, report.tokens.output);
          spendEstimated = true;
        } catch (err) {
          if (!(err instanceof PricingError)) throw err;
        }
      }
      // 步數:終局優先取 report.stepCount(最終記錄),否則取 status.steps(執行中即時計數)。
      const stepCount =
        typeof report?.stepCount === 'number'
          ? report.stepCount
          : typeof status?.steps === 'number'
            ? status.steps
            : undefined;
      const item: TaskListItem = {
        jobId: job.jobId,
        backend: job.backend,
        locality: job.locality,
        category: job.category,
        appId: job.appId,
        caseId: job.caseId,
        state: status?.state ?? 'queued',
        createdAt: job.createdAt,
        ...(status?.updatedAt ? { updatedAt: status.updatedAt } : {}),
        ...(vlmModel ? { vlmModel } : {}),
        ...(seatModels && Object.keys(seatModels).length > 0 ? { seatModels } : {}),
        ...(billableSpendUsd !== undefined ? { billableSpendUsd } : {}),
        ...(spendEstimated ? { spendEstimated: true } : {}),
        ...(stepCount !== undefined ? { stepCount } : {}),
        ...((report?.message ?? status?.message) ? { message: String(report?.message ?? status?.message).slice(0, 300) } : {}),
        ...((report?.task ?? job.caseTask) ? { task: String(report?.task ?? job.caseTask).slice(0, 200) } : {}),
        ...((report?.deviceModel ?? job.deviceModel) ? { deviceModel: report?.deviceModel ?? job.deviceModel } : {}),
        ...((report?.generatedAt ?? status?.updatedAt) ? { finishedAt: report?.generatedAt ?? status?.updatedAt } : {}),
        ...(job.caseVersion ? { caseVersion: job.caseVersion } : {}),
        ...(job.caseName ? { caseName: job.caseName } : {}),
      };
      return item;
    }),
  );
  const resolved = items
    .filter((i): i is TaskListItem => i !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: resolved, total };
}

export interface StepRecord {
  index: number;
  [key: string]: unknown;
}

/** 讀某任務的全部 steps(供前端重連補讀,Req 5.4),依 index 排序。 */
export async function readSteps(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<StepRecord[]> {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${jobsPrefix(tenantId)}${jobId}/steps/`,
    }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.json'));

  // 用 allSettled 而非 all:單一 step JSON 損毀(寫入中斷/截斷,長任務步數多時機率更高)
  // 不該讓整批 steps 都讀不到 —— 之前用 Promise.all,任一筆 readJson 的 JSON.parse 失敗
  // 就會讓整個請求 reject,前端只能顯示空白/「尚無步驟」,使用者完全看不到其餘數百個
  // 正常步驟。改成略過損毀的那一筆,其餘照常回傳。
  const results = await Promise.allSettled(
    keys.map((key) => readJson<StepRecord>(s3, bucket, key)),
  );
  const steps: StepRecord[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'fulfilled' && r.value !== null) {
      steps.push(r.value);
    } else if (r.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(`[readSteps] 讀取損毀,略過: ${keys[i]}`, r.reason);
    }
  }
  return steps.sort((a, b) => a.index - b.index);
}

/** 單步互動 log(traces/<i>.json):模型/channel/請求摘要/原始回應/token/錯誤。 */
export interface TraceRecord {
  index: number;
  [key: string]: unknown;
}

/** 讀某任務的全部互動 log(traces/*.json),依 index 排序。供「Log」呈現除錯用。 */
export async function readTraces(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<TraceRecord[]> {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${jobsPrefix(tenantId)}${jobId}/traces/`,
    }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.json'));
  const traces = await Promise.all(
    keys.map((key) => readJson<TraceRecord>(s3, bucket, key)),
  );
  return traces
    .filter((t): t is TraceRecord => t !== null)
    .sort((a, b) => a.index - b.index);
}

/** 執行配置快照(config.json,由引擎於執行前落地)—— 每個 seat 的模型與解析單價。 */
interface ConfigSnapshotSeat {
  seat: string;
  modelId: string;
  channel?: string;
  inputPerM: number;
  outputPerM: number;
  estimated?: boolean;
}
interface ConfigSnapshot {
  budgetUsd?: number;
  seats?: ConfigSnapshotSeat[];
  resolvedAt?: string;
}
/** 報告產出物(report.json)—— 只取本頁需要的欄位(task 描述、token 用量)。 */
interface ReportShape {
  task?: string;
  stepCount?: number;
  tokens?: { input?: number; output?: number };
  billableSpendUsd?: number;
  budgetUsd?: number | null;
  /** runner 寫入的 VLM 模型 id(report.json 有帶;供詳情頁在無 seat 快照時回退顯示)。 */
  vlmModel?: string;
  /** runner 寫入的實際執行真機機型(Device Farm;供詳情頁顯示「執行裝置」)。 */
  deviceModel?: string;
  /** 終局訊息。 */
  message?: string;
  /** 報告產生時間(= 任務結束時間)。 */
  generatedAt?: string;
}

/** runner 寫在 status.json 的啟動進度(Device Farm 開機時間軸)。 */
export interface BootProgress {
  runnerAt?: string;
  phase?: 'download' | 'upload' | 'device' | 'connect' | 'run';
  at?: Partial<Record<'download' | 'upload' | 'device' | 'connect' | 'run', string>>;
  deviceStatus?: string;
  deviceModel?: string;
  sizeMB?: number;
}

/** 任務詳情頁需要的彙整 metadata:套用情境、使用模型、花費。 */
export interface TaskMeta {
  /** 本次執行的任務描述(情境語意;取自 report.task,無則 undefined)。 */
  task?: string;
  /** 提交時選用的共用知識庫 id(名稱由前端對照 /knowledge-bases 呈現)。 */
  knowledgeBaseIds: string[];
  /** 使用者明選的 VLM 模型 id。 */
  vlmModel?: string;
  /** 實際執行的真機機型(Device Farm)。優先取 report.deviceModel,無則回退 job.deviceModel。 */
  deviceModel?: string;
  /** 執行實際生效的各 seat 模型 + 單價(來自 config.json)。 */
  seats: ConfigSnapshotSeat[];
  /** token 用量(來自 report.tokens)。 */
  tokens?: { input: number; output: number };
  /** 預算閾值(美元;來自 config.budgetUsd 或 report.budgetUsd)。 */
  budgetUsd?: number;
  /**
   * 實際花費(美元)。優先用 report.billableSpendUsd;若報告未直接記錄,
   * 則以 report.tokens × config.seats 的 vlm(或首個)單價估算,並標記為估算。
   */
  billableSpendUsd?: number;
  /** billableSpendUsd 是否為前端/後端由 token 估出(而非引擎直接記錄)。 */
  spendEstimated?: boolean;
  /** 本次執行的完整測試腳本(案例 task 原文;執行中即可顯示,不必等報告)。 */
  script?: string;
  /** 案例名稱 / 版本快照。 */
  caseName?: string;
  caseVersion?: string;
  /** 步數上限(未設 = 無上限)。 */
  maxSteps?: number;
}

/**
 * 彙整任務詳情頁所需 metadata(情境 / 模型 / 花費)。
 * 資料散落三處:job.json(模型/知識庫)、config.json(生效 seats + 單價 + 預算)、
 * report.json(任務描述 + token 用量 + 可能已算好的花費)。任一缺失都以最佳可得資料退化,
 * 不因缺報告或缺 config 而失敗(任務可能還在跑、或舊資料)。
 */
async function buildTaskMeta(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  job: JobRecord,
): Promise<TaskMeta> {
  const [config, report] = await Promise.all([
    readJson<ConfigSnapshot>(s3, bucket, configKey(tenantId, jobId)),
    readJson<ReportShape>(s3, bucket, reportKey(tenantId, jobId)),
  ]);

  const seats = config?.seats ?? [];
  const tokens =
    typeof report?.tokens?.input === 'number' && typeof report.tokens.output === 'number'
      ? { input: report.tokens.input, output: report.tokens.output }
      : undefined;
  const budgetUsd =
    typeof config?.budgetUsd === 'number'
      ? config.budgetUsd
      : typeof report?.budgetUsd === 'number'
        ? report.budgetUsd
        : undefined;

  // 花費:優先採用報告直接記錄的 billableSpendUsd;否則以 token × 生效單價估算。
  let billableSpendUsd: number | undefined;
  let spendEstimated = false;
  if (typeof report?.billableSpendUsd === 'number') {
    billableSpendUsd = report.billableSpendUsd;
  } else if (tokens) {
    // 以 vlm seat 單價估(VLM 是逐步呼叫的主要花費);無 vlm 則取第一個 seat。
    const priceSeat = seats.find((s) => s.seat === 'vlm') ?? seats[0];
    if (priceSeat) {
      try {
        billableSpendUsd = computeSpend(priceSeat.modelId, tokens.input, tokens.output);
        spendEstimated = true;
      } catch (err) {
        // 查無單價(Fail Closed):不給錯誤數字,留空由前端顯示「無法計算」。
        if (!(err instanceof PricingError)) throw err;
      }
    }
  }

  // 執行裝置:優先採 runner 實際寫入的機型(report.deviceModel),無則回退提交時所選(job.deviceModel)。
  const deviceModel = report?.deviceModel ?? job.deviceModel;

  return {
    ...(report?.task ? { task: report.task } : {}),
    knowledgeBaseIds: job.knowledgeBaseIds ?? [],
    ...(job.vlmModel ? { vlmModel: job.vlmModel } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    seats,
    ...(tokens ? { tokens } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(billableSpendUsd !== undefined ? { billableSpendUsd } : {}),
    ...(spendEstimated ? { spendEstimated: true } : {}),
    ...((job.caseTask ?? report?.task) ? { script: String(job.caseTask ?? report?.task).slice(0, 8000) } : {}),
    ...(job.caseName ? { caseName: job.caseName } : {}),
    ...(job.caseVersion ? { caseVersion: job.caseVersion } : {}),
    ...(typeof job.maxSteps === 'number' && job.maxSteps > 0 ? { maxSteps: job.maxSteps } : {}),
  };
}

/** 讀某任務的 job 記錄 + 狀態 + 步驟 + 詳情 metadata(任務詳情)。 */
export async function readJobDetail(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<{
  job: JobRecord | null;
  state: string;
  message?: string;
  boot?: BootProgress;
  updatedAt?: string;
  steps: StepRecord[];
  meta: TaskMeta;
} | null> {
  const job = await readJson<JobRecord>(
    s3,
    bucket,
    jobKey(tenantId, jobId),
  );
  if (!job) return null;
  const [status, steps, meta] = await Promise.all([
    readJson<{ state: string; message?: string; boot?: BootProgress; updatedAt?: string }>(s3, bucket, statusKeyFor(tenantId, jobId)),
    readSteps(s3, bucket, tenantId, jobId),
    buildTaskMeta(s3, bucket, tenantId, jobId, job),
  ]);
  return {
    job,
    state: status?.state ?? 'queued',
    ...(status?.message ? { message: status.message } : {}),
    ...(status?.boot && typeof status.boot === 'object' ? { boot: status.boot } : {}),
    ...(status?.updatedAt ? { updatedAt: status.updatedAt } : {}),
    steps,
    meta,
  };
}

/** 讀某任務的報告產出物(report.json)。不存在回 null。 */
export async function readReport(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<unknown | null> {
  return readJson<unknown>(
    s3,
    bucket,
    `${jobsPrefix(tenantId)}${jobId}/report.json`,
  );
}

/** 寫取消旗標(協作式取消,Req 3.3)。 */
export async function writeCancelFlag(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: cancelKey(tenantId, jobId),
      Body: JSON.stringify({ cancelledAt: new Date().toISOString() }),
      ContentType: 'application/json',
    }),
  );
}

/**
 * 刪除整個任務(job)資料夾:job.json / status.json / report.json / cancel.json /
 * steps/*.json / 截圖等全部一起清掉。刪報告 = 刪任務(同一個 job)。
 * 列出前綴下所有物件後批次刪除;S3 每批上限 1000。幂等(無物件即無動作)。
 */
export async function deleteJob(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<void> {
  const prefix = `${jobsPrefix(tenantId)}${jobId}/`;
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    const objects = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string')
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      // 分批(每批最多 1000)刪除。
      for (let i = 0; i < objects.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects.slice(i, i + 1000) },
          }),
        );
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}
