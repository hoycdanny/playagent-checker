/**
 * 缺陷人工覆寫的儲存 —— 測試人員回報誤判或調整嚴重性。
 *
 * 存在 tenants/<t>/jobs/<jobId>/overrides.json。
 *
 * **只追加,不修改既有紀錄。** 這是這支模組最重要的性質:
 *   - 要撤回一筆覆寫,是再追加一筆把它改回去,而不是刪掉原本那筆。
 *   - 於是「誰在什麼時候把這筆缺陷標成誤判、後來又被誰改回來」整串都留著。
 *   - 報告端(findingOverrides.applyFindingOverrides)取每筆缺陷時間最晚的那一筆,
 *     所以追加式儲存不會讓結果變得不確定。
 *
 * 如果允許就地修改或刪除單筆,覆寫就從「可追溯的另一種主張」退化成
 * 「可以悄悄改掉的數字」—— 那正是整個報告要避免的事。
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { isUsableOverride } from './report/findingOverrides.js';
import type { FailureClass, FindingOverride, Severity } from './report/types.js';

export class OverrideValidationError extends Error {}

/** 回寫記憶時,缺陷標題與畫面名的長度上限(避免把整段描述灌進記憶)。 */
const MAX_CONTEXT = 120;

/**
 * 覆核理由 → 寫進應用記憶的教學文字。
 *
 * 為什麼要組一句話而不是直接存理由原文:記憶會被注入下一次測試的 prompt,
 * 單獨一句「載入中的正常狀態」對 AI 沒有指向 —— 它不知道那是在說哪個畫面的
 * 哪個現象。所以要把「系統報了什麼」與「人判斷是什麼」一起寫進去。
 *
 * 刻意保留理由原文(不改寫、不摘要):那是人寫的判斷依據,改寫就不再是他說的話。
 */
export function composeHintText(input: {
  dismissed: boolean;
  reason: string;
  findingTitle?: string;
  screen?: string;
}): string {
  const title = (input.findingTitle ?? '').trim().slice(0, MAX_CONTEXT);
  const screen = (input.screen ?? '').trim().slice(0, MAX_CONTEXT);
  const what = title ? `「${title}」` : '先前回報的現象';
  const where = screen ? `在${screen}畫面,` : '';
  const verdict = input.dismissed ? '經人工覆核判定不是缺陷' : '經人工覆核確認為缺陷';
  return `${where}${what}${verdict}:${input.reason}`;
}

/** 單一任務的覆寫紀錄上限。超過就從最舊的開始丟(報告只看最新的那一筆)。 */
const MAX_RECORDS = 500;
export const MAX_REASON = 500;

const CLASSES = new Set<FailureClass>(['GAME_FAILURE', 'AI_TEST_FAILURE', 'ENVIRONMENT', 'NEEDS_TRIAGE']);
const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low']);

const key = (tenantId: string, jobId: string) => `${tenantPrefix(tenantId)}jobs/${jobId}/overrides.json`;

/** 讀覆寫紀錄;沒有檔案或內容壞掉都回空陣列(不讓報告因此失敗)。 */
export async function readOverrides(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<FindingOverride[]> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key(tenantId, jobId) }));
    const text = (await r.Body?.transformToString()) ?? '[]';
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    // 逐筆過濾:一筆壞掉不該讓整份覆寫消失
    return parsed.filter((x): x is FindingOverride => isUsableOverride(x));
  } catch {
    return [];
  }
}

/**
 * 驗證前端送來的覆寫請求。
 *
 * `by` 與 `at` 刻意不接受請求主體的值 —— 由伺服器端填入登入身分與當下時間。
 * 讓前端自報覆寫者等於讓任何人都能冒名覆寫。
 */
/**
 * 回寫記憶的附帶資訊(不存進 overrides.json,只用來組記憶文字)。
 *
 * 標題與畫面名由前端提供 —— 那是使用者畫面上已經看到的文字,而且使用者
 * 本來就能直接編輯應用記憶,所以這裡沒有新增權限。長度與字元由下游把關。
 */
export interface RememberContext {
  remember: boolean;
  findingTitle?: string;
  screen?: string;
}

export function parseRememberContext(body: unknown): RememberContext {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_CONTEXT) : undefined);
  const title = str(b['findingTitle']);
  const screen = str(b['screen']);
  return {
    // 預設不回寫:跨任務的副作用必須是明確選的,不能靠預設值悄悄發生
    remember: b['remember'] === true,
    ...(title ? { findingTitle: title } : {}),
    ...(screen ? { screen } : {}),
  };
}

export function validateOverrideInput(body: unknown): {
  findingId: string;
  reason: string;
  dismissed?: boolean;
  classification?: FailureClass;
  severity?: Severity;
} {
  const b = (body ?? {}) as Record<string, unknown>;

  const findingId = typeof b['findingId'] === 'string' ? b['findingId'].trim() : '';
  if (!findingId) throw new OverrideValidationError('findingId 為必填');

  const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
  if (!reason) throw new OverrideValidationError('reason 為必填 —— 報告要能交代這個數字為什麼變了');
  if (reason.length > MAX_REASON) throw new OverrideValidationError(`reason 最多 ${MAX_REASON} 字`);

  const dismissed = b['dismissed'] === true;
  const classification = typeof b['classification'] === 'string' ? b['classification'] : undefined;
  const severity = typeof b['severity'] === 'string' ? b['severity'] : undefined;

  if (classification !== undefined && !CLASSES.has(classification as FailureClass)) {
    throw new OverrideValidationError(`classification 不是合法值: ${classification}`);
  }
  if (severity !== undefined && !SEVERITIES.has(severity as Severity)) {
    throw new OverrideValidationError(`severity 不是合法值: ${severity}`);
  }
  if (!dismissed && classification === undefined && severity === undefined) {
    throw new OverrideValidationError('至少要指定 dismissed、classification 或 severity 其中一項');
  }

  return {
    findingId,
    reason,
    ...(dismissed ? { dismissed: true } : {}),
    // 標為誤判時忽略另外兩項:以誤判為準,不做半套(與 applyFindingOverrides 一致)
    ...(!dismissed && classification ? { classification: classification as FailureClass } : {}),
    ...(!dismissed && severity ? { severity: severity as Severity } : {}),
  };
}

/** 追加一筆覆寫;回傳追加後的完整紀錄。 */
export async function appendOverride(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  input: ReturnType<typeof validateOverrideInput>,
  by: string,
  now: () => string = () => new Date().toISOString(),
): Promise<FindingOverride[]> {
  const existing = await readOverrides(s3, bucket, tenantId, jobId);
  const record: FindingOverride = { ...input, by, at: now() };
  const next = [...existing, record].slice(-MAX_RECORDS);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key(tenantId, jobId),
    Body: JSON.stringify(next),
    ContentType: 'application/json',
  }));
  return next;
}

/**
 * 清空整份覆寫紀錄。
 *
 * 這會抹掉稽核軌跡,所以路由層限定管理員。一般的「撤回」不該走這裡 ——
 * 追加一筆把判定改回去,原本那筆仍留在紀錄中。
 */
export async function clearOverrides(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key(tenantId, jobId),
    Body: '[]',
    ContentType: 'application/json',
  }));
}
