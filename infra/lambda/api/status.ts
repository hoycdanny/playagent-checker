import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

/**
 * 任務終局狀態(Req 3.2)—— 六種互斥,不可混同。
 * running 為唯一非終局狀態(執行中)。
 */
export type TaskState =
  | 'running'
  | 'pass'
  | 'fail'
  | 'error'
  | 'cancelled'
  | 'budget_exceeded'
  | 'dead';

export const TERMINAL_STATES: readonly TaskState[] = [
  'pass',
  'fail',
  'error',
  'cancelled',
  'budget_exceeded',
  'dead',
];

export function isTerminal(s: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}

export interface TaskStatus {
  jobId: string;
  state: TaskState;
  /** 更新時間(ISO)。 */
  updatedAt: string;
  /** 選填:成本、步數、訊息等。 */
  billableSpendUsd?: number;
  budgetUsd?: number;
  steps?: number;
  message?: string;
}

/**
 * 決定「以現有狀態 current 為準,是否接受寫入 next」,回傳最終落地狀態。
 * 純函式,便於單元測試。體現兩條規則:
 *
 * 1. **終態吸收(Req 3.7)**:一旦落任一終態,永不被覆蓋 —— 包含不被 running、
 *    也不被另一個終態覆蓋。「先到的終態」為準。
 * 2. **取消不覆蓋引擎已跑出的真實結果(Req 3.4)**:cancelled 只在「當前為
 *    running(或無值)」時勝出;若引擎已先寫出 pass/fail/error 等真實終態,
 *    cancelled 後到不會覆蓋它(避免報告內容與狀態矛盾)。
 *
 * 兩條規則其實同一句話:**任何終態都吸收後續寫入**。cancelled 不是特例 ——
 * 它只是「running → cancelled」這條合法轉移的結果,而非能推翻既有終態的高優先值。
 */
export function resolveStatus(current: TaskState | null, next: TaskState): TaskState {
  if (current === null) return next;
  // 一旦終態,吸收一切後續寫入(running 或其他終態皆不覆蓋)
  if (isTerminal(current)) return current;
  // current 為 running:接受 next(轉入終態或維持 running)
  return next;
}

export function statusKey(tenantId: string, jobId: string): string {
  return `${tenantPrefix(tenantId)}jobs/${jobId}/status.json`;
}

/** 讀取目前狀態(不存在回 null)。回傳 body 與 ETag(供條件寫)。 */
export async function readStatus(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<{ status: TaskStatus; etag: string } | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: statusKey(tenantId, jobId) }),
    );
    const text = await res.Body?.transformToString();
    if (!text) return null;
    return { status: JSON.parse(text) as TaskStatus, etag: res.ETag ?? '' };
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/**
 * 寫入狀態,遵守終態吸收(Req 3.6/3.7)。
 * 以讀取現值 → resolveStatus 決定最終值 → 條件寫(If-Match ETag)防競態。
 * 若最終值等於現值(無變化)則不寫。
 */
export async function writeStatus(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  next: TaskStatus,
): Promise<TaskState> {
  const existing = await readStatus(s3, bucket, tenantId, next.jobId);
  const resolvedState = resolveStatus(existing?.status.state ?? null, next.state);

  // 若解析後仍是現有終態(next 被吸收),不覆寫
  if (existing && resolvedState === existing.status.state && resolvedState !== next.state) {
    return resolvedState;
  }

  const body: TaskStatus = { ...next, state: resolvedState, updatedAt: new Date().toISOString() };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: statusKey(tenantId, next.jobId),
      Body: JSON.stringify(body),
      ContentType: 'application/json',
      ...(existing?.etag ? { IfMatch: existing.etag } : { IfNoneMatch: '*' }),
    }),
  );
  return resolvedState;
}
