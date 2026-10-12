import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { effectiveState, isTerminal, type TaskState } from './status.js';
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
  /** Device Farm 執行時長:1 = 單段(140 分鐘收尾);N = 最多 N 段連線接續;0 = 不限段數。未設 = 1。 */
  maxSegments?: number;
  /** 自管主機(Android 容器 / Windows)的最長執行時間(小時,1~72);到時主機自動終止。 */
  maxHours?: number;
  /** 畫面解析度(Windows:GameLift Streams 虛擬螢幕;寬高偶數、總像素 ≤ 1920×1080)。 */
  display?: JobDisplay;
  /** 被測產物的完整 S3 key(emulator userdata 據此拉 APK)。 */
  artifactKey?: string;
  /** 這次測的版本標籤(顯示用;artifactVersion 是產物 id,不好讀)。 */
  artifactLabel?: string;
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

export interface JobDisplay {
  width: number;
  height: number;
}

/** GameLift Streams 單一 session 總像素上限(1920×1080)。 */
export const WINDOWS_MAX_PIXELS = 2_073_600;

/** 解析度校驗:寬高為 320~4096 的偶數;Windows 另限總像素 ≤ 2,073,600。 */
export function parseDisplay(raw: unknown, backend: Backend): JobDisplay | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (backend !== 'windows') return undefined;
  if (typeof raw !== 'object') throw new ValidationError('display 必須是 { width, height }');
  const r = raw as Record<string, unknown>;
  const width = Number(r['width']);
  const height = Number(r['height']);
  const ok = (n: number) => Number.isInteger(n) && n >= 320 && n <= 4096 && n % 2 === 0;
  if (!ok(width) || !ok(height)) throw new ValidationError('解析度寬高必須是 320~4096 的偶數');
  if (width * height > WINDOWS_MAX_PIXELS) {
    throw new ValidationError(`Windows 解析度總像素不可超過 ${WINDOWS_MAX_PIXELS}(1920×1080);${width}×${height} 太大`);
  }
  return { width, height };
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
/** 測試結論快取(由報告引擎依驗收標準算出;列表、任務詳情、報告共用同一個結論)。 */
export function verdictKey(tenantId: string, jobId: string): string {
  return `${jobsPrefix(tenantId)}${jobId}/verdict.json`;
}

export type Verdict = 'PASS' | 'PASS_WITH_RISK' | 'FAIL' | 'BLOCKED';

/** verdict.json 內容。standard / reportAt 不符就重算(驗收標準改版或報告重寫)。 */
export interface VerdictRecord {
  standard: string;
  verdict: Verdict;
  reason: { zh: string; en: string };
  /** 必要項目通過數 / 總數。 */
  must: { passed: number; total: number };
  /** 判定所依據的 report.json generatedAt。 */
  reportAt?: string;
  computedAt: string;
}

/**
 * 任務的「結果」:有測試結論就用結論(pass / pass_risk / fail / blocked),否則用執行狀態
 * (running / queued / error / cancelled …)。所有「通過率 / 失敗數」都用這個,和報告封面一致。
 */
export function outcomeOf(t: { state: string; verdict?: { status: Verdict } }): string {
  switch (t.verdict?.status) {
    case 'PASS': return 'pass';
    case 'PASS_WITH_RISK': return 'pass_risk';
    case 'FAIL': return 'fail';
    case 'BLOCKED': return 'blocked';
    default: return t.state;
  }
}

export async function writeVerdict(s3: S3Client, bucket: string, tenantId: string, jobId: string, rec: VerdictRecord): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: verdictKey(tenantId, jobId), Body: JSON.stringify(rec), ContentType: 'application/json' }));
}

interface SubmitInput {
  backend: Backend;
  appId: string;
  /** 要測哪一個版本(App builds[] 的 artifactId);未指定 = App 目前使用中的版本。 */
  buildId?: string;
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
  /** Device Farm 執行時長(段數;見 JobRecord.maxSegments)。 */
  maxSegments?: number;
  /** 自管主機最長執行時間(小時)。 */
  maxHours?: number;
  /** Windows 畫面解析度。 */
  display?: JobDisplay;
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
  // 執行時長(只有 Device Farm 有 150 分鐘連線上限):0..20 的整數;其他值拒絕。
  const rawSegments = b['maxSegments'];
  let maxSegments: number | undefined;
  if (rawSegments !== undefined && rawSegments !== null && rawSegments !== '') {
    const n = Number(rawSegments);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new ValidationError('maxSegments 必須是 0~20 的整數(0 = 不限段數)');
    if (backend === 'devicefarm' && n !== 1) maxSegments = n;
  }
  const rawHours = b['maxHours'];
  let maxHours: number | undefined;
  if (rawHours !== undefined && rawHours !== null && rawHours !== '') {
    const n = Number(rawHours);
    if (!Number.isInteger(n) || n < 1 || n > 72) throw new ValidationError('maxHours 必須是 1~72 的整數');
    if (backend === 'emulator' || backend === 'windows') maxHours = n;
  }
  // 要測的版本(App 的 builds[] 之一);格式與產物 id 相同。存在性由 core 解析時確認。
  const rawBuild = b['buildId'];
  const buildId =
    typeof rawBuild === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(rawBuild) ? rawBuild : undefined;
  const display = parseDisplay(b['display'], backend as Backend);
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
    ...(buildId ? { buildId } : {}),
    caseId,
    category,
    ...(vlmModel ? { vlmModel } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(knowledgeBaseIds && knowledgeBaseIds.length > 0 ? { knowledgeBaseIds } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(maxSegments !== undefined ? { maxSegments } : {}),
    ...(maxHours !== undefined ? { maxHours } : {}),
    ...(display ? { display } : {}),
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
  extra?: { artifactKey?: string; artifactLabel?: string; caseTask?: string; abi?: string; package?: string; platform?: string; genres?: string[]; kbSnapshot?: KbSnapshot[]; controls?: JobControls; caseVersion?: string; caseName?: string },
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
    ...(input.maxSegments !== undefined ? { maxSegments: input.maxSegments } : {}),
    ...(input.maxHours !== undefined ? { maxHours: input.maxHours } : {}),
    ...(input.display ? { display: input.display } : {}),
    ...(input.deviceArn ? { deviceArn: input.deviceArn } : {}),
    ...(input.deviceModel ? { deviceModel: input.deviceModel } : {}),
    ...(input.osVersion ? { osVersion: input.osVersion } : {}),
    ...(extra?.artifactKey ? { artifactKey: extra.artifactKey } : {}),
    ...(extra?.artifactLabel ? { artifactLabel: extra.artifactLabel } : {}),
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
  /** Device Farm 段數(未帶 = 單段;0 = 不限段數;>1 = 長時)。 */
  maxSegments?: number;
  /** token 用量(三個 seat 合計);費用分析頁的明細用。舊報告可能缺欄位。 */
  tokens?: { input?: number; output?: number };
  /** 各 seat 的 token 用量(agent=控制遊戲、vlm=分析畫面、subagent=子代理)。 */
  tokensBySeat?: Partial<Record<'agent' | 'vlm' | 'subagent', { input?: number; output?: number }>>;
  /**
   * 測試結論(驗收標準判定,與報告封面同一個值)。只有終局且有報告的任務才有;
   * state 是「執行結果」(AI 有沒有走完),verdict 才是「通過 / 失敗 / 受阻」。
   */
  verdict?: { status: Verdict; reason: { zh: string; en: string }; standard: string };
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
  /**
   * 終局任務缺 verdict.json(或標準改版)時呼叫報告引擎算結論並寫回。
   * 每次列表最多算 maxVerdictComputes 筆(預設 6),其餘下次列表再補,列表不會因此變慢太多。
   */
  resolveVerdict?: (jobId: string, report: Record<string, unknown>) => Promise<VerdictRecord | null>;
  /** 目前的驗收標準版本(verdict.json 不同版本就重算)。 */
  verdictStandard?: string;
  maxVerdictComputes?: number;
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
  let verdictBudget = opts.maxVerdictComputes ?? 6;

  const items = await Promise.all(
    jobKeys.map(async (key) => {
      const job = await readJson<JobRecord>(s3, bucket, key);
      if (!job) return null;
      // status(狀態)、report(花費/模型)、config(各角色模型)併發讀取,避免序列往返拖慢列表。
      const [status, report, config, savedVerdict] = await Promise.all([
        readJson<{ state: TaskState; updatedAt: string; steps?: number; message?: string }>(
          s3,
          bucket,
          statusKeyFor(tenantId, job.jobId),
        ),
        readJson<ReportShape>(s3, bucket, reportKey(tenantId, job.jobId)),
        readJson<ConfigSnapshot>(s3, bucket, configKey(tenantId, job.jobId)),
        readJson<VerdictRecord>(s3, bucket, verdictKey(tenantId, job.jobId)).catch(() => null),
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
      let bySeat: number | undefined;
      try {
        bySeat = spendBySeat(report, (seat) => seatModels?.[seat]);
      } catch (err) {
        if (!(err instanceof PricingError)) throw err;
      }
      if (typeof report?.billableSpendUsd === 'number') {
        billableSpendUsd = report.billableSpendUsd;
      } else if (report?.tokensBySeat) {
        if (bySeat !== undefined) { billableSpendUsd = bySeat; spendEstimated = true; }
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
      // 執行中但很久沒回報 → 失聯(dead);見 status.ts effectiveState。
      const eff = effectiveState(status);
      // 測試結論:終局 + 有報告才有。快取過期(標準改版 / 報告重寫)或沒有快取時,在預算內現算。
      let verdictRec: VerdictRecord | null = null;
      if (report && isTerminal(eff.state as TaskState)) {
        const fresh = savedVerdict
          && (!opts.verdictStandard || savedVerdict.standard === opts.verdictStandard)
          && (!report.generatedAt || savedVerdict.reportAt === report.generatedAt);
        if (fresh) verdictRec = savedVerdict;
        else if (opts.resolveVerdict && verdictBudget > 0) {
          verdictBudget--;
          verdictRec = await opts.resolveVerdict(job.jobId, report as Record<string, unknown>).catch((err) => {
            console.warn('[verdict] compute failed', job.jobId, err);
            return null;
          });
        } else if (savedVerdict) verdictRec = savedVerdict; // 舊版結論先顯示,下次列表再更新
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
        state: eff.state as TaskState | 'queued',
        createdAt: job.createdAt,
        ...(status?.updatedAt ? { updatedAt: status.updatedAt } : {}),
        ...(vlmModel ? { vlmModel } : {}),
        ...(seatModels && Object.keys(seatModels).length > 0 ? { seatModels } : {}),
        ...(billableSpendUsd !== undefined ? { billableSpendUsd } : {}),
        ...(spendEstimated ? { spendEstimated: true } : {}),
        ...(stepCount !== undefined ? { stepCount } : {}),
        ...((report?.message ?? eff.message) ? { message: String(report?.message ?? eff.message).slice(0, 300) } : {}),
        ...((report?.task ?? job.caseTask) ? { task: String(report?.task ?? job.caseTask).slice(0, 200) } : {}),
        ...((report?.deviceModel ?? job.deviceModel) ? { deviceModel: report?.deviceModel ?? job.deviceModel } : {}),
        ...((report?.generatedAt ?? status?.updatedAt) ? { finishedAt: report?.generatedAt ?? status?.updatedAt } : {}),
        ...(job.caseVersion ? { caseVersion: job.caseVersion } : {}),
        ...(job.caseName ? { caseName: job.caseName } : {}),
        // Device Farm 長時(多段接續):列表用不同圖示標出。
        ...(typeof job.maxSegments === 'number' ? { maxSegments: job.maxSegments } : {}),
        // token 用量照原樣帶出(不另外讀 S3,report 已經在手上),費用頁的逐筆明細要用。
        ...(report?.tokens ? { tokens: report.tokens } : {}),
        ...(report?.tokensBySeat ? { tokensBySeat: report.tokensBySeat } : {}),
        ...(verdictRec ? { verdict: { status: verdictRec.verdict, reason: verdictRec.reason, standard: verdictRec.standard } } : {}),
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
export type TraceSeat = 'vlm' | 'agent' | 'subagent';

/** trace 檔名 → seat:<i>.json = 視覺;<i>-agent.json = 決策;<i>-subagent*.json / <i>-summary.json = 輔助。 */
export function traceSeatOf(fileName: string): TraceSeat | null {
  const m = /^(\d+)(?:-([a-z-]+))?\.json$/.exec(fileName);
  if (!m) return null;
  const tag = m[2];
  if (!tag) return 'vlm';
  if (tag === 'agent') return 'agent';
  if (tag.startsWith('subagent') || tag === 'summary') return 'subagent';
  return null;
}

/**
 * 讀某任務的互動 log(traces/*.json),依 index 排序。
 * - seat:只讀某個 Agent(依檔名過濾,不必讀其他 Agent 的檔)。
 * - limit:只回最新 N 筆(長測試三個 Agent 合計可能上千筆,整包會超過 Lambda 回應上限)。
 * - summary:只回 token / 成敗 / 耗時(「用量」分頁用,體積小)。
 */
export async function readTraces(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  opts: { seat?: TraceSeat; limit?: number; summary?: boolean } = {},
): Promise<TraceRecord[]> {
  const prefix = `${jobsPrefix(tenantId)}${jobId}/traces/`;
  const entries: Array<{ key: string; index: number }> = [];
  let token: string | undefined;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const o of list.Contents ?? []) {
      const key = o.Key;
      if (typeof key !== 'string') continue;
      const name = key.slice(prefix.length);
      const seat = traceSeatOf(name);
      if (!seat || (opts.seat && seat !== opts.seat)) continue;
      entries.push({ key, index: Number(name.split(/[-.]/)[0]) });
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  entries.sort((a, b) => a.index - b.index);
  const pick = opts.limit && opts.limit > 0 ? entries.slice(-opts.limit) : entries;
  const out: TraceRecord[] = [];
  for (let i = 0; i < pick.length; i += 50) {
    const batch = await Promise.all(pick.slice(i, i + 50).map((e) => readJson<TraceRecord>(s3, bucket, e.key).catch(() => null)));
    for (const t of batch) {
      if (!t) continue;
      if (opts.summary) {
        const r = t as Record<string, unknown>;
        out.push({
          index: t.index,
          ...(typeof r['seat'] === 'string' ? { seat: r['seat'] } : {}),
          ...(typeof r['modelId'] === 'string' ? { modelId: r['modelId'] } : {}),
          ...(typeof r['ok'] === 'boolean' ? { ok: r['ok'] } : {}),
          ...(r['tokens'] && typeof r['tokens'] === 'object' ? { tokens: r['tokens'] } : {}),
          ...(typeof r['ms'] === 'number' ? { ms: r['ms'] } : {}),
          ...(typeof r['at'] === 'string' ? { at: r['at'] } : {}),
        } as TraceRecord);
      } else out.push(t);
    }
  }
  return out.sort((a, b) => a.index - b.index);
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
/**
 * 依各 Agent 的 token × 各自模型單價估算花費(report.tokensBySeat)。
 * 回 undefined = 沒有分 seat 的資料(呼叫端退回舊算法);任一 seat 查不到價 → 拋 PricingError(Fail Closed)。
 */
export function spendBySeat(
  report: Pick<ReportShape, 'tokensBySeat' | 'seatModels'> | null | undefined,
  modelFor: (seat: 'vlm' | 'agent' | 'subagent') => string | undefined,
): number | undefined {
  const by = report?.tokensBySeat;
  if (!by) return undefined;
  let total = 0;
  for (const seat of ['vlm', 'agent', 'subagent'] as const) {
    const t = by[seat];
    const input = t?.input ?? 0;
    const output = t?.output ?? 0;
    if (input === 0 && output === 0) continue;
    const modelId = report?.seatModels?.[seat] ?? modelFor(seat);
    if (!modelId) throw new PricingError(`無法判斷 ${seat} 的模型`);
    total += computeSpend(modelId, input, output);
  }
  return total;
}

/** 報告產出物(report.json)—— 只取本頁需要的欄位(task 描述、token 用量)。 */
interface ReportShape {
  task?: string;
  stepCount?: number;
  tokens?: { input?: number; output?: number };
  /** 三個 Agent 各自的 token(runner agent-team-v1 起);有則花費依各自模型單價分開計。 */
  tokensBySeat?: Partial<Record<'vlm' | 'agent' | 'subagent', { input?: number; output?: number }>>;
  /** runner 實際使用的各 Agent 模型。 */
  seatModels?: Partial<Record<'vlm' | 'agent' | 'subagent', string>>;
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
  session?: { segment: number; maxSegments: number; startedAt: string; wrapAt: string; wrapMin: number };
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
  } else if (report?.tokensBySeat) {
    // 三個 Agent 分開計價(各自模型單價)。
    try {
      const v = spendBySeat(report, (seat) => seats.find((s) => s.seat === seat)?.modelId);
      if (v !== undefined) { billableSpendUsd = v; spendEstimated = true; }
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
    }
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
  opts: Pick<ListJobsOptions, 'resolveVerdict' | 'verdictStandard'> = {},
): Promise<{
  job: JobRecord | null;
  state: string;
  message?: string;
  boot?: BootProgress;
  updatedAt?: string;
  steps: StepRecord[];
  meta: TaskMeta;
  verdict?: TaskListItem['verdict'];
} | null> {
  const job = await readJson<JobRecord>(
    s3,
    bucket,
    jobKey(tenantId, jobId),
  );
  if (!job) return null;
  const [status, steps, meta, saved] = await Promise.all([
    readJson<{ state: string; message?: string; boot?: BootProgress; updatedAt?: string }>(s3, bucket, statusKeyFor(tenantId, jobId)),
    readSteps(s3, bucket, tenantId, jobId),
    buildTaskMeta(s3, bucket, tenantId, jobId, job),
    readJson<VerdictRecord>(s3, bucket, verdictKey(tenantId, jobId)).catch(() => null),
  ]);
  const eff = effectiveState(status);
  // 測試結論(與報告封面同一個值):快取不在 / 過期就現算一次。
  let verdict: VerdictRecord | null = saved && (!opts.verdictStandard || saved.standard === opts.verdictStandard) ? saved : null;
  if (!verdict && isTerminal(eff.state as TaskState) && opts.resolveVerdict) {
    const report = await readJson<Record<string, unknown>>(s3, bucket, reportKey(tenantId, jobId)).catch(() => null);
    if (report) verdict = await opts.resolveVerdict(jobId, report).catch(() => saved ?? null);
  }
  return {
    job,
    state: eff.state,
    ...(verdict ? { verdict: { status: verdict.verdict, reason: verdict.reason, standard: verdict.standard } } : {}),
    ...(eff.message ? { message: eff.message } : {}),
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
  // 1) 先刪「索引檔」:列表靠 job.json 判斷任務存在,先刪掉它,任務立刻從所有清單消失,
  //    即使後面大量檔案(長測試可達數千個截圖/log)刪到一半被中斷,也不會「刪了還在」。
  await deleteKeysStrict(s3, bucket, ['job.json', 'status.json', 'report.json'].map((f) => `${prefix}${f}`));
  // 2) 再刪其餘全部。
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    const keys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string');
    await deleteKeysStrict(s3, bucket, keys);
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * 批次刪除並確認每個 key 都刪掉了。DeleteObjects 即使部分失敗(例如同時大量刪除時 S3 回 SlowDown)
 * 也回 HTTP 200,失敗的 key 只列在 Errors 裡 —— 舊版忽略它,導致任務檔案隨機殘留、任務「刪了還在」。
 * 這裡對失敗的 key 退避重試,仍失敗就丟錯(前端才知道沒刪乾淨)。
 */
async function deleteKeysStrict(s3: S3Client, bucket: string, keys: string[], attempts = 6): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    let pending = keys.slice(i, i + 1000);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= attempts) {
        throw new Error(`刪除任務檔案失敗(${pending.length} 個檔案,例:${pending[0]}),請稍後再試`);
      }
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      try {
        const res = await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: pending.map((Key) => ({ Key })), Quiet: true } }),
        );
        const failed = new Set((res.Errors ?? []).map((e) => e.Key).filter((k): k is string => typeof k === 'string'));
        pending = pending.filter((k) => failed.has(k));
      } catch (err) {
        // 整批被節流(503 SlowDown)→ 重試;其他錯誤直接丟出。
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (!(e?.name === 'SlowDown' || e?.$metadata?.httpStatusCode === 503)) throw err;
      }
    }
  }
}
