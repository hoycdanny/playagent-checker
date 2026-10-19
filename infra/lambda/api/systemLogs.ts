/**
 * 集中式日誌(admin 專用):把橫跨多個 AWS 服務的 CloudWatch Logs 匯整到一個地方查詢,
 * 讓營運者在單一介面除錯整條鏈路(API / 引擎 / 分派器 / WebSocket / Fargate runner /
 * 系統更新 CodeBuild / 映像建置)。
 *
 * 設計:
 *  - 核心邏輯(來源分類、查詢字串組裝、輸入驗證、結果對應)寫在這個檔,方便用 fake ports 做單元測試。
 *  - 真正打 AWS 的實作在 systemLogsPorts.ts。
 *  - 跨服務查詢用 CloudWatch Logs Insights(StartQuery 一次掃多個 log group,依時間排序),
 *    非同步:啟動回 queryId,前端輪詢結果。
 */

/** 日誌來源的種類(用來分色/分組顯示)。 */
export type LogKind = 'lambda' | 'ecs' | 'codebuild' | 'other';

/** 一個可查詢的日誌來源(= 一個 CloudWatch log group)。 */
export interface LogSource {
  /** 穩定 id,即 log group 名稱。 */
  id: string;
  logGroupName: string;
  kind: LogKind;
  /** 翻譯用的穩定 key:前端依自己的語系表決定顯示文字。 */
  sourceId: LogSourceId;
  /** 繁中預設名稱(舊前端與下載的 .txt 用;前端認得 sourceId 時以 sourceId 為準)。 */
  label: string;
}

/** 查詢輸入(前端送來,後端驗證後正規化)。 */
export interface LogQueryInput {
  /** 要查哪些來源(log group 名)。空或未給 = 全部可用來源。 */
  sources?: string[];
  /** 相對時間窗(分鐘);預設 60,範圍 1..10080(7 天)。給了 start+end 則以絕對時間為準。 */
  minutes?: number;
  /** 絕對起訖(epoch 毫秒),可選。 */
  start?: number;
  end?: number;
  /** 關鍵字(對 @message 做不分大小寫子字串比對);可選。 */
  pattern?: string;
  /** 回傳筆數上限;預設 200,範圍 1..1000。 */
  limit?: number;
}

/** 正規化後的查詢參數(內部用)。 */
export interface NormalizedQuery {
  sources: string[] | null;
  startMs: number;
  endMs: number;
  pattern: string | null;
  limit: number;
}

/** 一筆日誌。 */
export interface LogRow {
  /** epoch 毫秒。 */
  ts: number;
  /** 翻譯用的穩定 key(「來源」欄顯示哪一國語言由前端決定)。 */
  sourceId: LogSourceId;
  /** 來源的繁中預設名稱(舊前端相容用)。 */
  source: string;
  logGroup: string;
  logStream?: string;
  /** 盡力從訊息判斷的等級;判不出為 undefined。 */
  level?: LogLevel;
  message: string;
}

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** CloudWatch Logs Insights 查詢狀態。 */
export type LogQueryState =
  | 'Scheduled' | 'Running' | 'Complete' | 'Failed' | 'Cancelled' | 'Timeout' | 'Unknown';

export interface LogQueryResult {
  status: LogQueryState;
  /** 是否已結束(不論成敗);前端據此停止輪詢。 */
  done: boolean;
  rows: LogRow[];
  recordsMatched?: number;
}

/** 注入點:真正的 AWS 呼叫在 systemLogsPorts.ts;測試用 fake。 */
export interface SystemLogsPorts {
  /** 列出本平台相關的 log group(依命名前綴探索並去重)。 */
  listGroups(): Promise<{ logGroupName: string }[]>;
  /** 啟動一個 Insights 查詢,回 queryId。 */
  startQuery(input: {
    logGroupNames: string[];
    startSec: number;
    endSec: number;
    queryString: string;
  }): Promise<string>;
  /** 取查詢結果。 */
  getQuery(queryId: string): Promise<{
    status: string;
    results: { field: string; value: string }[][];
    recordsMatched?: number;
  }>;
}

/** Insights 一次最多掃的 log group 數。 */
export const MAX_GROUPS = 50;
const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 7 * 24 * 60;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_PATTERN = 500;

/**
 * 來源種類的穩定識別碼。這是給前端翻譯用的 key —— 前端(LogsPanel)有自己的五語系表,
 * 後端只負責說「這是哪一種服務」,不負責決定顯示哪一國語言的字。
 *
 * 原本後端直接回繁中 label,前端照印,所以日文 / 英文介面的來源晶片與「來源」欄
 * 全都是中文(使用者實際回報的問題)。
 */
export type LogSourceId =
  | 'api' | 'engine' | 'dispatcher' | 'ws-auth' | 'ws-connect' | 'ws-push'
  | 'runner-exploration' | 'runner-web'
  | 'update' | 'image-runner' | 'image-web' | 'installer'
  | 'log-retention' | 's3-events' | 'custom-resource' | 'lambda-other' | 'other';

/**
 * 後端的繁中預設名稱。保留它的理由:
 *  1. 舊前端(部署時間差)還在讀 label,不能一次拔掉;
 *  2. 下載的 .txt 與伺服器端日誌仍需要一個可讀的名字。
 * 前端認得 sourceId 時一律以 sourceId 為準。
 */
const SOURCE_LABEL_ZH: Record<LogSourceId, string> = {
  api: '控制面 API',
  engine: '引擎 Engine',
  dispatcher: '分派器 Dispatcher',
  'ws-auth': 'WebSocket 授權',
  'ws-connect': 'WebSocket 連線',
  'ws-push': 'WebSocket 推送',
  'runner-exploration': 'Runner(真機 / Device Farm)',
  'runner-web': 'Runner(Web 瀏覽器)',
  update: '系統更新(CodeBuild)',
  'image-runner': '映像建置(真機 runner)',
  'image-web': '映像建置(web runner)',
  installer: '安裝器(CodeBuild)',
  'log-retention': '其他(log 保留設定)',
  's3-events': '其他(S3 事件)',
  'custom-resource': '其他(自訂資源)',
  'lambda-other': '其他 Lambda',
  other: '其他',
};

/** log group 名稱 → 種類 + 穩定 id。 */
function classifyId(logGroupName: string): { kind: LogKind; id: LogSourceId } {
  const n = logGroupName;
  // 固定命名(我們自己指定的)。
  if (/\/playagent\/[^/]+\/runner-exploration$/.test(n)) return { kind: 'ecs', id: 'runner-exploration' };
  if (/\/playagent\/[^/]+\/runner-web$/.test(n)) return { kind: 'ecs', id: 'runner-web' };
  if (/\/playagent\/[^/]+\/update$/.test(n)) return { kind: 'codebuild', id: 'update' };
  if (n === '/aws/codebuild/playagent-runner-build') return { kind: 'codebuild', id: 'image-runner' };
  if (n === '/aws/codebuild/playagent-web-runner-build') return { kind: 'codebuild', id: 'image-web' };
  if (n.startsWith('/aws/codebuild/playagent-installer')) return { kind: 'codebuild', id: 'installer' };
  // Lambda:看 logical id 片段判斷角色。
  if (n.startsWith('/aws/lambda/')) {
    if (/-ApiFn/i.test(n)) return { kind: 'lambda', id: 'api' };
    if (/-EngineFn/i.test(n)) return { kind: 'lambda', id: 'engine' };
    if (/-DispatcherFn/i.test(n)) return { kind: 'lambda', id: 'dispatcher' };
    if (/-WsAuthorizer/i.test(n)) return { kind: 'lambda', id: 'ws-auth' };
    if (/-WsConnect/i.test(n)) return { kind: 'lambda', id: 'ws-connect' };
    if (/-WsPush|-WsBroadcast/i.test(n)) return { kind: 'lambda', id: 'ws-push' };
    // CDK 的輔助 Lambda(log 保留、S3 通知、自訂資源)也屬於系統的一部分,照列。
    if (/LogRetention/i.test(n)) return { kind: 'lambda', id: 'log-retention' };
    if (/BucketNotifications/i.test(n)) return { kind: 'lambda', id: 's3-events' };
    if (/CustomResource|AwsCustom|Provider/i.test(n)) return { kind: 'lambda', id: 'custom-resource' };
    return { kind: 'lambda', id: 'lambda-other' };
  }
  return { kind: 'other', id: 'other' };
}

/**
 * 依 log group 名稱分類並給穩定 id + 繁中預設名稱。
 * Lambda 群組名形如 /aws/lambda/<stage>-<Stack>-<LogicalId><hash>;
 * ECS runner / 更新 CodeBuild 用固定的 /playagent/<stage>/... 名稱。
 */
export function classify(logGroupName: string): { kind: LogKind; id: LogSourceId; label: string } {
  const c = classifyId(logGroupName);
  return { ...c, label: SOURCE_LABEL_ZH[c.id] };
}

/** 來源排序權重:主要服務在前,輔助/其他在後。 */
const KIND_ORDER: Record<LogKind, number> = { lambda: 0, ecs: 1, codebuild: 2, other: 3 };
/** 排序依穩定 id(不是顯示字串)—— 否則換語系就會換順序。 */
const ID_ORDER: LogSourceId[] = [
  'api', 'engine', 'dispatcher',
  'ws-auth', 'ws-connect', 'ws-push',
  'runner-exploration', 'runner-web',
  'update', 'image-runner', 'image-web', 'installer',
];
function idRank(id: LogSourceId): number {
  const i = ID_ORDER.indexOf(id);
  return i === -1 ? ID_ORDER.length : i;
}

/** 列出所有可查詢來源(主要服務在前,「其他」殿後)。 */
export async function listLogSources(ports: SystemLogsPorts): Promise<LogSource[]> {
  const groups = await ports.listGroups();
  const seen = new Set<string>();
  const sources: LogSource[] = [];
  for (const g of groups) {
    if (!g.logGroupName || seen.has(g.logGroupName)) continue;
    seen.add(g.logGroupName);
    const c = classify(g.logGroupName);
    sources.push({ id: g.logGroupName, logGroupName: g.logGroupName, kind: c.kind, sourceId: c.id, label: c.label });
  }
  sources.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    idRank(a.sourceId) - idRank(b.sourceId) ||
    a.logGroupName.localeCompare(b.logGroupName));
  return sources;
}

/** 跳脫使用者關鍵字,安全地放進 Insights 的 `like /.../` 正則(避免注入與語法錯誤)。 */
export function escapeInsightsRegex(pattern: string): string {
  // Insights 的正則用 Java 風格;跳脫所有正則特殊字元,再跳脫斜線。
  return pattern.replace(/[\\^$.|?*+()[\]{}/]/g, '\\$&');
}

/** 組裝 Insights 查詢字串:取欄位 → (可選)關鍵字過濾 → 依時間新到舊 → 限筆數。 */
export function buildQueryString(pattern: string | null, limit: number): string {
  const parts = ['fields @timestamp, @message, @logStream, @log'];
  if (pattern) parts.push(`filter @message like /${escapeInsightsRegex(pattern)}/`);
  parts.push('sort @timestamp desc');
  parts.push(`limit ${limit}`);
  return parts.join('\n| ');
}

/** 驗證並正規化查詢輸入。沒有來源可查則回報(呼叫端轉 400)。 */
export class LogQueryError extends Error {}

export function normalizeQuery(input: LogQueryInput, available: string[], now = Date.now()): NormalizedQuery {
  const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const pattern = typeof input.pattern === 'string' && input.pattern.trim() !== ''
    ? input.pattern.trim().slice(0, MAX_PATTERN)
    : null;

  let startMs: number;
  let endMs: number;
  if (typeof input.start === 'number' && typeof input.end === 'number' && input.end > input.start) {
    startMs = input.start;
    endMs = input.end;
  } else {
    const minutes = clampInt(input.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
    endMs = now;
    startMs = now - minutes * 60_000;
  }

  // 來源:取交集(只允許查目前存在的來源),去重;空=全部。
  let sources: string[] | null = null;
  if (Array.isArray(input.sources) && input.sources.length > 0) {
    const allow = new Set(available);
    const picked = [...new Set(input.sources)].filter((s) => allow.has(s));
    if (picked.length === 0) throw new LogQueryError('選取的日誌來源都不存在');
    sources = picked;
  }
  return { sources, startMs, endMs, pattern, limit };
}

/** 啟動查詢:選定來源(或全部,最多 MAX_GROUPS 個)。 */
export async function startLogQuery(
  ports: SystemLogsPorts,
  input: LogQueryInput,
  now = Date.now(),
): Promise<{ queryId: string; groupCount: number }> {
  const groups = await ports.listGroups();
  const available = groups.map((g) => g.logGroupName).filter(Boolean);
  if (available.length === 0) throw new LogQueryError('目前找不到任何日誌來源');
  const q = normalizeQuery(input, available, now);
  const chosen = (q.sources ?? available).slice(0, MAX_GROUPS);
  const queryId = await ports.startQuery({
    logGroupNames: chosen,
    startSec: Math.floor(q.startMs / 1000),
    endSec: Math.ceil(q.endMs / 1000),
    queryString: buildQueryString(q.pattern, q.limit),
  });
  return { queryId, groupCount: chosen.length };
}

/** 盡力從訊息判斷等級(ERROR / WARN / INFO / DEBUG)。 */
export function detectLevel(message: string): LogLevel | undefined {
  const head = message.slice(0, 200);
  if (/\b(error|exception|fatal|traceback|unhandled|fail(ed|ure)?)\b/i.test(head) || /\[err/i.test(head)) return 'ERROR';
  if (/\b(warn(ing)?)\b/i.test(head)) return 'WARN';
  if (/\b(info)\b/i.test(head)) return 'INFO';
  if (/\b(debug|trace)\b/i.test(head)) return 'DEBUG';
  return undefined;
}

/** Insights 的 @timestamp 是 UTC 的 "yyyy-MM-dd HH:mm:ss.SSS";轉成 epoch 毫秒。 */
export function parseInsightsTs(v: string): number {
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 把一列 Insights 結果欄位對應成 LogRow(@log 是 "accountId:logGroupName")。 */
export function rowFromFields(fields: { field: string; value: string }[]): LogRow {
  const get = (f: string) => fields.find((x) => x.field === f)?.value ?? '';
  const logRaw = get('@log');
  const logGroup = logRaw.includes(':') ? logRaw.slice(logRaw.indexOf(':') + 1) : logRaw;
  const message = get('@message');
  const c = classify(logGroup);
  const row: LogRow = {
    ts: parseInsightsTs(get('@timestamp')),
    sourceId: c.id,
    source: c.label,
    logGroup,
    message,
  };
  const stream = get('@logStream');
  if (stream) row.logStream = stream;
  const level = detectLevel(message);
  if (level) row.level = level;
  return row;
}

const RUNNING = new Set(['Scheduled', 'Running']);
function toState(status: string): LogQueryState {
  switch (status) {
    case 'Scheduled': case 'Running': case 'Complete':
    case 'Failed': case 'Cancelled': case 'Timeout':
      return status;
    default: return 'Unknown';
  }
}

/** 取查詢結果並對應成 LogRow[]。 */
export async function getLogQuery(ports: SystemLogsPorts, queryId: string): Promise<LogQueryResult> {
  const r = await ports.getQuery(queryId);
  const status = toState(r.status);
  const rows = (r.results ?? [])
    .map(rowFromFields)
    // Insights 內部的 @ptr 欄位會被 rowFromFields 忽略;空訊息跳過。
    .filter((row) => row.message !== '' || row.logStream);
  return {
    status,
    done: !RUNNING.has(status),
    rows,
    ...(typeof r.recordsMatched === 'number' ? { recordsMatched: r.recordsMatched } : {}),
  };
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(max, Math.max(min, n));
}
