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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
  now?: Date;
}

/**
 * 取 AWS 真實成本(Cost Explorer)。三次查詢:依服務、依 component 標籤、月趨勢總額。
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
  const TimePeriod = { Start: start, End: end };

  const [byServiceResp, byComponentResp, byMonthResp] = await Promise.all([
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    ),
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'TAG', Key: tagKey }],
      }),
    ),
    client.send(
      new GetCostAndUsageCommand({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
      }),
    ),
  ]);

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
  };
}

/** 建立 Cost Explorer client(固定 us-east-1)。 */
export function makeCostExplorerClient(): CostExplorerClient {
  return new CostExplorerClient({ region: CE_REGION });
}
