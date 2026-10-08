import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { TaskListItem } from './tasks.js';

/**
 * 費用分析(方案 C):同時提供
 *  1) AWS 真實成本(Cost Explorer GetCostAndUsage)—— 帳號實際計費,含 SageMaker/Fargate/EC2/
 *     CloudFront 等全部基礎設施,依「服務」與「component 標籤」分組 + 月趨勢。
 *  2) 系統內任務估算成本(逐任務 billableSpendUsd 加總)—— 依應用/模型 seat/月彙整,供對照。
 *
 * 重要限制(誠實揭露,前端也會標註):
 *  - Cost Explorer 只在 us-east-1 提供 API;client 固定用 us-east-1(與部署區無關)。
 *  - 依「標籤」分組需先在 AWS Billing 主控台「啟用」該 cost allocation tag,且僅對啟用「之後」
 *    產生的成本生效;過去成本不回溯。未啟用時 component 分組會落在「未標記」。
 *  - Cost Explorer 資料有延遲(通常 ~24h),非即時;每次查詢 API 收費約 US$0.01。
 *  - 任務估算成本是 token × 單價估算,不含常駐 GPU(UI-TARS)/Fargate/EC2 等基礎設施,
 *    會低於真實 AWS 帳單。兩者口徑不同,不應直接相減。
 */

/** Cost Explorer 僅 us-east-1 提供 API。 */
const CE_REGION = 'us-east-1';

export interface CostBucket {
  key: string;
  amountUsd: number;
}

export interface MonthlyCost {
  month: string; // YYYY-MM
  amountUsd: number;
}

/**
 * 用量明細(依服務 × 用量類型)。
 *
 * 這是「訪問幾次 API / 寫了幾次 S3 / 送了多少 token」的唯一可信來源:
 * Cost Explorer 的 UsageQuantity 就是 AWS 實際計費的計量數字(如
 * `USE2-Requests-Tier1` = S3 PUT 次數、`Lambda-GB-Second`、`...-InputTokenCount`)。
 * 不是我們自己數的,所以不會因為漏記而偏低;代價是和成本一樣有 ~24h 延遲。
 */
export interface UsageTypeRow {
  service: string;
  usageType: string;
  /** AWS 計量數量(單位見 unit)。 */
  quantity: number;
  unit: string;
  amountUsd: number;
}

export interface RealCost {
  available: boolean;
  /** 查詢起訖(YYYY-MM-DD,end 為排他)。 */
  start: string;
  end: string;
  currency: string;
  totalUsd: number;
  byService: CostBucket[];
  byComponent: CostBucket[];
  byMonth: MonthlyCost[];
  /** 近 N 天每日成本(依服務;Cost Explorer 日界線為 UTC)。 */
  byDay?: Array<{ date: string; totalUsd: number; byService: Record<string, number> }>;
  /** 用量明細(依服務 × 用量類型;含計量數量)。 */
  byUsageType?: UsageTypeRow[];
  /** 已套用的專案篩選標籤(前端可顯示「僅本專案:project=playagent-checker」)。 */
  projectFilter?: { key: string; value: string };
  /** 無法貼標、以服務名稱另外納入的服務(如 AWS Device Farm)。 */
  includedServices?: string[];
  /** 取數時的說明/警告(前端顯示)。 */
  note?: string;
}

export interface EstimatedCost {
  totalUsd: number;
  taskCount: number;
  /** 有估算金額的任務數(其餘無 token/無單價,金額不計)。 */
  pricedTaskCount: number;
  byApp: CostBucket[];
  byModel: CostBucket[];
  byMonth: MonthlyCost[];
}

export interface CostReport {
  real: RealCost;
  estimated: EstimatedCost;
  daily: DailyCost;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ───────────────────────── 每日 × 應用(任務歸屬)─────────────────────────

/** Device Farm 計量(METERED)單價:US$0.17 / 裝置分鐘(https://aws.amazon.com/device-farm/pricing/)。 */
export const DEVICE_FARM_USD_PER_MIN = 0.17;

/** Device Farm remote access session 的實際用量(GetRemoteAccessSession.deviceMinutes)。 */
export interface DeviceSessionUsage {
  name: string;
  /** 由 session 名稱 pa-<jobId>-<ts> 解析出的任務 id;非任務 session(手動/探針)為 undefined。 */
  jobId?: string;
  created?: string;
  meteredMinutes: number;
  totalMinutes: number;
}

const SESSION_JOB_RE = /^pa-(job-[a-z0-9]+-[a-z0-9]+)-\d+$/;

export function jobIdFromSessionName(name: string): string | undefined {
  return SESSION_JOB_RE.exec(name)?.[1];
}

/** 以台北時間(UTC+8)取日期 YYYY-MM-DD(使用者在台灣,「哪一天」以當地日界線為準)。 */
export function taipeiDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface DailyAppCost {
  appId: string;
  totalUsd: number;
  modelUsd: number;
  deviceUsd: number;
  deviceMinutes: number;
  runs: number;
}

export interface DailyPoint {
  date: string;
  totalUsd: number;
  modelUsd: number;
  deviceUsd: number;
  runs: number;
  /** appId → 當日費用(模型 + 裝置)。 */
  byApp: Record<string, number>;
}

/** 逐筆測試的花費明細(費用頁最細的一層:這一次測試花在哪)。 */
export interface TaskCostRow {
  jobId: string;
  appId: string;
  caseId: string;
  caseName?: string;
  createdAt: string;
  state: string;
  backend: string;
  model?: string;
  steps?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** 每個 seat 的 token(agent/vlm/subagent);舊報告可能缺欄位。 */
  tokensBySeat?: Partial<Record<'agent' | 'vlm' | 'subagent', { input?: number; output?: number }>>;
  modelUsd: number;
  deviceUsd: number;
  deviceMinutes: number;
  totalUsd: number;
  /** 金額是估算(token × 單價)而非引擎直接記錄。 */
  estimated?: boolean;
}

export interface DailyCost {
  /** 統計區間(台北時間,含頭尾)。 */
  from: string;
  to: string;
  days: DailyPoint[];
  /** 區間內的逐筆測試明細(依花費高到低)。 */
  tasks: TaskCostRow[];
  /** 依區間總額排序(高 → 低)。 */
  byApp: DailyAppCost[];
  totals: { totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number };
  /** Device Farm 資料是否取得(失敗時裝置費用為 0 並附說明)。 */
  deviceDataAvailable: boolean;
  /** 非任務的 Device Farm 用量(手動測試等;僅管理員可見)。 */
  unattributed?: { deviceUsd: number; deviceMinutes: number; sessions: number };
  pricing: { deviceFarmUsdPerMinute: number };
  note?: string;
}

/**
 * 每日 × 應用費用:每個任務 = 模型費用(token × 單價,billableSpendUsd)+ Device Farm 實際計量分鐘 × 單價。
 * 依任務建立時間(台北時間)歸日,依 appId 歸屬應用。區間內沒有任務的日子也列出(值為 0),柱狀圖才連續。
 */
export function buildDailyCost(
  tasks: TaskListItem[],
  sessions: DeviceSessionUsage[] | null,
  opts: { days?: number; now?: Date; includeUnattributed?: boolean } = {},
): DailyCost {
  const nDays = Math.max(1, Math.min(366, Math.floor(opts.days ?? 30)));
  const now = opts.now ?? new Date();
  const to = taipeiDate(now.toISOString());
  const fromMs = Date.parse(`${to}T00:00:00Z`) - (nDays - 1) * 86_400_000;
  const from = new Date(fromMs).toISOString().slice(0, 10);

  const minutesByJob = new Map<string, number>();
  let unattrMin = 0;
  let unattrSessions = 0;
  for (const s of sessions ?? []) {
    if (s.jobId) minutesByJob.set(s.jobId, (minutesByJob.get(s.jobId) ?? 0) + s.meteredMinutes);
    else {
      const d = s.created ? taipeiDate(s.created) : '';
      if (d && d >= from && d <= to) { unattrMin += s.meteredMinutes; unattrSessions++; }
    }
  }

  const dayMap = new Map<string, DailyPoint>();
  for (let i = 0; i < nDays; i++) {
    const date = new Date(fromMs + i * 86_400_000).toISOString().slice(0, 10);
    dayMap.set(date, { date, totalUsd: 0, modelUsd: 0, deviceUsd: 0, runs: 0, byApp: {} });
  }
  const appMap = new Map<string, DailyAppCost>();
  const taskRows: TaskCostRow[] = [];
  for (const t of tasks) {
    const date = taipeiDate(t.createdAt);
    const day = dayMap.get(date);
    if (!day) continue;
    const model = typeof t.billableSpendUsd === 'number' ? t.billableSpendUsd : 0;
    const minutes = minutesByJob.get(t.jobId) ?? 0;
    const device = minutes * DEVICE_FARM_USD_PER_MIN;
    const total = model + device;
    day.modelUsd += model;
    day.deviceUsd += device;
    day.totalUsd += total;
    day.runs += 1;
    day.byApp[t.appId] = (day.byApp[t.appId] ?? 0) + total;
    const a = appMap.get(t.appId) ?? { appId: t.appId, totalUsd: 0, modelUsd: 0, deviceUsd: 0, deviceMinutes: 0, runs: 0 };
    a.totalUsd += total;
    a.modelUsd += model;
    a.deviceUsd += device;
    a.deviceMinutes += minutes;
    a.runs += 1;
    appMap.set(t.appId, a);
    taskRows.push({
      jobId: t.jobId,
      appId: t.appId,
      caseId: t.caseId,
      ...(t.caseName ? { caseName: t.caseName } : {}),
      createdAt: t.createdAt,
      state: t.state,
      backend: t.backend,
      ...(t.seatModels?.vlm ?? t.vlmModel ? { model: t.seatModels?.vlm ?? t.vlmModel } : {}),
      ...(typeof t.stepCount === 'number' ? { steps: t.stepCount } : {}),
      ...(t.tokens ? { tokensIn: t.tokens.input, tokensOut: t.tokens.output } : {}),
      ...(t.tokensBySeat ? { tokensBySeat: t.tokensBySeat } : {}),
      modelUsd: round4(model),
      deviceUsd: round4(device),
      deviceMinutes: round2(minutes),
      totalUsd: round4(total),
      ...(t.spendEstimated ? { estimated: true } : {}),
    });
  }

  const days = [...dayMap.values()].map((d) => ({
    ...d,
    totalUsd: round4(d.totalUsd),
    modelUsd: round4(d.modelUsd),
    deviceUsd: round4(d.deviceUsd),
    byApp: Object.fromEntries(Object.entries(d.byApp).map(([k, v]) => [k, round4(v)])),
  }));
  const byApp = [...appMap.values()]
    .map((a) => ({ ...a, totalUsd: round4(a.totalUsd), modelUsd: round4(a.modelUsd), deviceUsd: round4(a.deviceUsd), deviceMinutes: round2(a.deviceMinutes) }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
  const sum = (k: 'totalUsd' | 'modelUsd' | 'deviceUsd' | 'deviceMinutes' | 'runs') => byApp.reduce((s, a) => s + a[k], 0);

  return {
    from,
    to,
    days,
    tasks: taskRows.sort((a, b) => b.totalUsd - a.totalUsd || b.createdAt.localeCompare(a.createdAt)),
    byApp,
    totals: { totalUsd: round2(sum('totalUsd')), modelUsd: round2(sum('modelUsd')), deviceUsd: round2(sum('deviceUsd')), deviceMinutes: round2(sum('deviceMinutes')), runs: sum('runs') },
    deviceDataAvailable: sessions !== null,
    ...(opts.includeUnattributed && sessions !== null && unattrSessions > 0
      ? { unattributed: { deviceUsd: round2(unattrMin * DEVICE_FARM_USD_PER_MIN), deviceMinutes: round2(unattrMin), sessions: unattrSessions } }
      : {}),
    pricing: { deviceFarmUsdPerMinute: DEVICE_FARM_USD_PER_MIN },
  };
}

/** 由 listJobs 結果彙整系統內任務估算成本(不需額外 S3 讀取)。 */
export function aggregateEstimatedCost(tasks: TaskListItem[]): EstimatedCost {
  let total = 0;
  let priced = 0;
  const byApp = new Map<string, number>();
  const byModel = new Map<string, number>();
  const byMonth = new Map<string, number>();

  for (const t of tasks) {
    const amount = typeof t.billableSpendUsd === 'number' ? t.billableSpendUsd : 0;
    if (typeof t.billableSpendUsd === 'number') priced += 1;
    total += amount;
    byApp.set(t.appId, (byApp.get(t.appId) ?? 0) + amount);
    // 模型歸屬:優先用 vlm seat(逐步花費主要來源),否則 agent。
    const model = t.seatModels?.vlm ?? t.vlmModel ?? t.seatModels?.agent ?? '(未知)';
    byModel.set(model, (byModel.get(model) ?? 0) + amount);
    const month = (t.createdAt ?? '').slice(0, 7); // YYYY-MM
    if (month) byMonth.set(month, (byMonth.get(month) ?? 0) + amount);
  }

  const toBuckets = (m: Map<string, number>): CostBucket[] =>
    [...m.entries()]
      .map(([key, amountUsd]) => ({ key, amountUsd: round2(amountUsd) }))
      .sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    totalUsd: round2(total),
    taskCount: tasks.length,
    pricedTaskCount: priced,
    byApp: toBuckets(byApp),
    byModel: toBuckets(byModel),
    byMonth: [...byMonth.entries()]
      .map(([month, amountUsd]) => ({ month, amountUsd: round2(amountUsd) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/** YYYY-MM-DD(UTC)。 */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 預設區間:近 6 個月(含當月),月粒度。 */
function defaultRange(now = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); // 下月 1 號(排他)
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)); // 6 個月前 1 號
  return { start: ymd(start), end: ymd(end) };
}

export interface RealCostOptions {
  start?: string;
  end?: string;
  /** 依此 cost allocation tag 分組(預設 component)。 */
  componentTagKey?: string;
  /** 只算本專案:用此 tag 篩選成本(預設 project=playagent-checker)。 */
  projectTagKey?: string;
  projectTagValue?: string;
  /** 以服務名稱另外納入(無法貼標)的服務;預設 ['AWS Device Farm']。 */
  includeServices?: string[];
  /** 每日明細天數(預設 30)。 */
  dailyDays?: number;
  now?: Date;
}

/**
 * 取 AWS 真實成本(Cost Explorer)。三次查詢:依服務、依 component 標籤、月趨勢總額。
 *
 * 重要:一律用 project 標籤(預設 project=playagent-checker)Filter,只回「本專案 CDK 部署的資源」
 * 成本,不是整個帳號。前提是該 tag 已在 Billing 主控台啟用為 cost allocation tag,且成本產生在
 * 啟用之後——否則回傳會接近 0 / 空(過去成本不貼標),前端會提示啟用步驟。
 *
 * Cost Explorer 未啟用或無權限時,拋錯由呼叫端捕捉並回 available:false。
 */
export async function getRealCost(
  client: CostExplorerClient,
  opts: RealCostOptions = {},
): Promise<RealCost> {
  const { start, end } = {
    start: opts.start ?? defaultRange(opts.now).start,
    end: opts.end ?? defaultRange(opts.now).end,
  };
  const tagKey = opts.componentTagKey ?? 'component';
  const projectKey = opts.projectTagKey ?? 'project';
  const projectValue = opts.projectTagValue ?? 'playagent-checker';
  const TimePeriod = { Start: start, End: end };
  // 只算本專案:project 標籤 OR 無法貼標但只有本專案在用的服務(Device Farm 的 session 由 runner
  // 動態建立,不帶 CDK 標籤;不納入的話真機費用——本專案最大宗的成本——完全不會出現在帳單頁)。
  const includedServices = opts.includeServices ?? ['AWS Device Farm'];
  const tagFilter = { Tags: { Key: projectKey, Values: [projectValue] } };
  const Filter = includedServices.length
    ? { Or: [tagFilter, { Dimensions: { Key: 'SERVICE' as const, Values: includedServices } }] }
    : tagFilter;
  // 每日明細:近 dailyDays 天(預設 30;Cost Explorer End 為排他)。
  const nowD = opts.now ?? new Date();
  const dailyEnd = ymd(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() + 1)));
  const dailyStart = ymd(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() + 1 - (opts.dailyDays ?? 30))));

  const [byServiceResp, byComponentResp, byMonthResp, byDayResp, byUsageResp] = await Promise.all([
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter,
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    ),
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter,
        GroupBy: [{ Type: 'TAG', Key: tagKey }],
      }),
    ),
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter,
      }),
    ),
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: dailyStart, End: dailyEnd },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        Filter,
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    ),
    // 用量明細:同一區間、依服務 × 用量類型,同時取「花多少錢」與「用了多少次/多少量」。
    // Cost Explorer 一次最多兩個 GroupBy,所以服務與用量類型一起分組。
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: dailyStart, End: dailyEnd },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost', 'UsageQuantity'],
        Filter,
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'DIMENSION', Key: 'USAGE_TYPE' },
        ],
      }),
    ),
  ]);
  // 同一個(服務, 用量類型)可能跨多個月份區段,累加數量與金額。
  const usageMap = new Map<string, UsageTypeRow>();
  for (const r of byUsageResp.ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const service = g.Keys?.[0] ?? '(未知)';
      const usageType = g.Keys?.[1] ?? '(未知)';
      const cost = Number(g.Metrics?.['UnblendedCost']?.Amount ?? '0');
      const qty = Number(g.Metrics?.['UsageQuantity']?.Amount ?? '0');
      const unit = g.Metrics?.['UsageQuantity']?.Unit ?? '';
      if (!(qty > 0) && !(cost > 0)) continue;
      const k = `${service}\u0000${usageType}`;
      const cur = usageMap.get(k) ?? { service, usageType, quantity: 0, unit, amountUsd: 0 };
      cur.quantity += qty;
      cur.amountUsd += cost;
      if (!cur.unit && unit) cur.unit = unit;
      usageMap.set(k, cur);
    }
  }
  const byUsageType = [...usageMap.values()]
    .map((u) => ({ ...u, quantity: round4(u.quantity), amountUsd: round4(u.amountUsd) }))
    // 先按金額排,金額同為 0(免費額度內)時按數量排 —— 使用者想看的是「誰在動」。
    .sort((a, b) => b.amountUsd - a.amountUsd || b.quantity - a.quantity);
  const byDay = (byDayResp.ResultsByTime ?? []).map((r) => {
    const bySvc: Record<string, number> = {};
    for (const g of r.Groups ?? []) {
      const v = Number(g.Metrics?.['UnblendedCost']?.Amount ?? '0');
      if (v > 0) bySvc[g.Keys?.[0] ?? '(未知)'] = round4(v);
    }
    return { date: r.TimePeriod?.Start ?? '', totalUsd: round4(Object.values(bySvc).reduce((a, b) => a + b, 0)), byService: bySvc };
  });

  // 依服務 / 依 component:各月 group 累加。
  const svc = new Map<string, number>();
  let currency = 'USD';
  for (const r of byServiceResp.ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const key = g.Keys?.[0] ?? '(未知)';
      const m = g.Metrics?.['UnblendedCost'];
      if (m?.Unit) currency = m.Unit;
      svc.set(key, (svc.get(key) ?? 0) + Number(m?.Amount ?? '0'));
    }
  }
  const comp = new Map<string, number>();
  for (const r of byComponentResp.ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      // TAG 分組的 key 形如 "component$execution";空值為 "component$"。
      const raw = g.Keys?.[0] ?? '';
      const val = raw.includes('$') ? raw.slice(raw.indexOf('$') + 1) : raw;
      const key = val || '(未標記)';
      comp.set(key, (comp.get(key) ?? 0) + Number(g.Metrics?.['UnblendedCost']?.Amount ?? '0'));
    }
  }

  const byMonth: MonthlyCost[] = (byMonthResp.ResultsByTime ?? []).map((r) => ({
    month: (r.TimePeriod?.Start ?? '').slice(0, 7),
    amountUsd: round2(Number(r.Total?.['UnblendedCost']?.Amount ?? '0')),
  }));
  const totalUsd = round2(byMonth.reduce((s, m) => s + m.amountUsd, 0));

  const toBuckets = (m: Map<string, number>): CostBucket[] =>
    [...m.entries()]
      .map(([key, amountUsd]) => ({ key, amountUsd: round2(amountUsd) }))
      .sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    available: true,
    start,
    end,
    currency,
    totalUsd,
    byService: toBuckets(svc),
    byComponent: toBuckets(comp),
    byMonth,
    byDay,
    byUsageType,
    projectFilter: { key: projectKey, value: projectValue },
    ...(includedServices.length ? { includedServices } : {}),
  };
}

/** 建立 Cost Explorer client(固定 us-east-1)。 */
export function makeCostExplorerClient(): CostExplorerClient {
  return new CostExplorerClient({ region: CE_REGION });
}
