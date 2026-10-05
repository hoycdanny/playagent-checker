/**
 * 應用記憶(使用者教 AI 的經驗)+ 記憶地圖手動編修。
 *
 * - hints.json:每個應用獨立的「操作經驗」清單。來源 = 測試中操作員下的即時指令(勾「記住」)
 *   或在記憶地圖手動新增/編修。runner 每次啟動時載入全部啟用中的提示注入 prompt,
 *   綁定畫面的提示在 AI 回到該畫面時再額外提醒 —— 讓 AI 越跑越聰明,不再重複撞牆。
 * - edits.json:記憶地圖的手動編修(改名 / 刪畫面 / 刪路徑)。runner 每步會整份重寫
 *   structure.json,所以編修另存成覆寫層,讀取時與 runner 載入時套用,不會被下一次執行洗掉。
 *
 * 位置:tenants/<t>/memory/<app>/{hints.json, edits.json}(與 structure.json 同目錄)。
 * 寫入以 S3 條件寫入(If-Match ETag)避免同時編修互相覆蓋。
 */
import { randomBytes } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

export class HintValidationError extends Error {}
export class HintNotFoundError extends Error {}

export type HintSource = 'operator' | 'manual';

export interface MemoryHint {
  id: string;
  /** 教學內容(例:「在老虎機畫面要點右下角的 SPIN 按鈕開始轉動」)。 */
  text: string;
  /** 綁定的畫面(記憶地圖 pageId / 畫面名);空 = 整個應用通用。 */
  pageId?: string;
  screen?: string;
  source: HintSource;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** 來自哪次測試的即時指令。 */
  jobId?: string;
  step?: number;
}

export interface HintsDoc {
  schemaVersion: 1;
  hints: MemoryHint[];
}

export interface MemoryEdits {
  schemaVersion: 1;
  /** pageId → 使用者指定名稱。 */
  renames: Record<string, string>;
  deletedPages: string[];
  /** edgeKey(from>to>kind>target)。 */
  deletedEdges: string[];
  updatedAt?: string;
}

export const MAX_HINTS = 200;
export const MAX_HINT_LEN = 500;
const ID_RE = /^hint-[a-z0-9]{6,24}$/;
const PAGE_RE = /^page_[a-f0-9]{8,32}$/;

function prefix(tenantId: string, app: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(app)) throw new HintValidationError('app 格式不正確');
  return `${tenantPrefix(tenantId)}memory/${app}`;
}

async function readWithEtag<T>(s3: S3Client, bucket: string, key: string): Promise<{ value: T | null; etag?: string }> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = (await res.Body?.transformToString()) ?? '';
    return { value: text ? (JSON.parse(text) as T) : null, ...(res.ETag ? { etag: res.ETag } : {}) };
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return { value: null };
    throw err;
  }
}

function isConflict(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.name === 'ConditionalRequestConflict' || e?.$metadata?.httpStatusCode === 412 || e?.$metadata?.httpStatusCode === 409;
}

/** 讀-改-寫(If-Match / If-None-Match 樂觀鎖,衝突重試)。 */
async function mutate<T>(
  s3: S3Client,
  bucket: string,
  key: string,
  empty: () => T,
  fn: (doc: T) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { value, etag } = await readWithEtag<T>(s3, bucket, key);
    const next = fn(value ?? empty());
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(next),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }));
      return next;
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }
  throw new Error('記憶同時被修改,請重試');
}

const emptyHints = (): HintsDoc => ({ schemaVersion: 1, hints: [] });
export const emptyEdits = (): MemoryEdits => ({ schemaVersion: 1, renames: {}, deletedPages: [], deletedEdges: [] });

function cleanText(v: unknown): string {
  if (typeof v !== 'string') throw new HintValidationError('text 必填');
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) throw new HintValidationError('text 不可為空');
  if (t.length > MAX_HINT_LEN) throw new HintValidationError(`text 最多 ${MAX_HINT_LEN} 字`);
  return t;
}
function cleanScreen(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, 80);
  return s || undefined;
}
/** 載入/過場/啟動類畫面名(不適合當記憶的畫面範圍:操作員的指令是針對下一個畫面)。 */
export function isTransientScreenName(name: string): boolean {
  // 「畫面 87」是 AI 回應無法解析時 runner 自動補的流水號名稱,不代表任何真實畫面,同樣不當範圍。
  return /載入|加載|讀取|下載|更新中|過場|啟動畫面|開場|loading|splash|downloading|updating/i.test(name)
    || /^\s*(畫面|screen)\s*#?\d+\s*$/i.test(name);
}

function cleanPage(v: unknown): string | undefined {
  return typeof v === 'string' && PAGE_RE.test(v) ? v : undefined;
}

export async function listHints(s3: S3Client, bucket: string, tenantId: string, app: string): Promise<MemoryHint[]> {
  const { value } = await readWithEtag<HintsDoc>(s3, bucket, `${prefix(tenantId, app)}/hints.json`);
  return value?.hints ?? [];
}

export async function addHint(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  input: { text: unknown; screen?: unknown; pageId?: unknown; source?: HintSource; createdBy?: string; jobId?: string; step?: number },
): Promise<MemoryHint> {
  const now = new Date().toISOString();
  const hint: MemoryHint = {
    id: `hint-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    text: cleanText(input.text),
    ...(cleanPage(input.pageId) ? { pageId: cleanPage(input.pageId)! } : {}),
    ...(cleanScreen(input.screen) ? { screen: cleanScreen(input.screen)! } : {}),
    source: input.source ?? 'manual',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(typeof input.step === 'number' ? { step: input.step } : {}),
  };
  await mutate(s3, bucket, `${prefix(tenantId, app)}/hints.json`, emptyHints, (doc) => {
    // 同一段文字 + 同畫面不重複記(操作員重複下同一指令)。
    const dup = doc.hints.find((h) => h.text === hint.text && (h.pageId ?? h.screen ?? '') === (hint.pageId ?? hint.screen ?? ''));
    if (dup) { hint.id = dup.id; dup.enabled = true; dup.updatedAt = now; return doc; }
    if (doc.hints.length >= MAX_HINTS) throw new HintValidationError(`每個應用最多 ${MAX_HINTS} 條記憶,請先整理舊的`);
    return { ...doc, hints: [...doc.hints, hint] };
  });
  return hint;
}

export async function updateHint(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  id: string,
  patch: { text?: unknown; enabled?: unknown; screen?: unknown; pageId?: unknown },
): Promise<MemoryHint> {
  if (!ID_RE.test(id)) throw new HintValidationError('id 格式不正確');
  let updated: MemoryHint | undefined;
  await mutate(s3, bucket, `${prefix(tenantId, app)}/hints.json`, emptyHints, (doc) => {
    const h = doc.hints.find((x) => x.id === id);
    if (!h) throw new HintNotFoundError('找不到這條記憶');
    if (patch.text !== undefined) h.text = cleanText(patch.text);
    if (typeof patch.enabled === 'boolean') h.enabled = patch.enabled;
    if (patch.screen !== undefined) {
      const s = cleanScreen(patch.screen);
      if (s) h.screen = s; else delete h.screen;
    }
    if (patch.pageId !== undefined) {
      const p = cleanPage(patch.pageId);
      if (p) h.pageId = p; else delete h.pageId;
    }
    h.updatedAt = new Date().toISOString();
    updated = { ...h };
    return doc;
  });
  return updated!;
}

export async function deleteHint(s3: S3Client, bucket: string, tenantId: string, app: string, id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new HintValidationError('id 格式不正確');
  await mutate(s3, bucket, `${prefix(tenantId, app)}/hints.json`, emptyHints, (doc) => ({ ...doc, hints: doc.hints.filter((h) => h.id !== id) }));
}

// ───────────────────────── 記憶地圖編修 ─────────────────────────

export async function readEdits(s3: S3Client, bucket: string, tenantId: string, app: string): Promise<MemoryEdits> {
  const { value } = await readWithEtag<MemoryEdits>(s3, bucket, `${prefix(tenantId, app)}/edits.json`);
  return { ...emptyEdits(), ...(value ?? {}) };
}

export type EditOp =
  | { op: 'rename'; pageId: string; name: string }
  | { op: 'clearRename'; pageId: string }
  | { op: 'deletePage'; pageId: string }
  | { op: 'restorePage'; pageId: string }
  | { op: 'deleteEdge'; edgeKey: string }
  | { op: 'restoreEdge'; edgeKey: string };

export function parseEditOp(body: unknown): EditOp {
  const b = (body ?? {}) as Record<string, unknown>;
  const op = b['op'];
  const pageId = cleanPage(b['pageId']);
  const edgeKey = typeof b['edgeKey'] === 'string' && b['edgeKey'].length <= 200 ? b['edgeKey'] : undefined;
  switch (op) {
    case 'rename': {
      const name = typeof b['name'] === 'string' ? b['name'].trim().slice(0, 60) : '';
      if (!pageId || !name) throw new HintValidationError('rename 需要 pageId 與 name');
      return { op, pageId, name };
    }
    case 'clearRename':
    case 'deletePage':
    case 'restorePage':
      if (!pageId) throw new HintValidationError(`${op} 需要 pageId`);
      return { op, pageId };
    case 'deleteEdge':
    case 'restoreEdge':
      if (!edgeKey) throw new HintValidationError(`${op} 需要 edgeKey`);
      return { op, edgeKey };
    default:
      throw new HintValidationError('op 不支援');
  }
}

export async function applyEdit(s3: S3Client, bucket: string, tenantId: string, app: string, e: EditOp): Promise<MemoryEdits> {
  return mutate(s3, bucket, `${prefix(tenantId, app)}/edits.json`, emptyEdits, (raw) => {
    const doc: MemoryEdits = { ...emptyEdits(), ...raw, renames: { ...(raw.renames ?? {}) } };
    const del = new Set(doc.deletedPages);
    const delE = new Set(doc.deletedEdges);
    switch (e.op) {
      case 'rename': doc.renames[e.pageId] = e.name; break;
      case 'clearRename': delete doc.renames[e.pageId]; break;
      case 'deletePage': del.add(e.pageId); break;
      case 'restorePage': del.delete(e.pageId); break;
      case 'deleteEdge': delE.add(e.edgeKey); break;
      case 'restoreEdge': delE.delete(e.edgeKey); break;
    }
    doc.deletedPages = [...del].slice(-500);
    doc.deletedEdges = [...delE].slice(-1000);
    doc.updatedAt = new Date().toISOString();
    return doc;
  });
}

/** 路徑識別鍵(與 agent/memoryEdits.mjs edgeKey 一致)。 */
export function edgeKey(e: { fromPageId: string; toPageId: string; trigger?: { kind?: string; target?: string } }): string {
  return `${e.fromPageId}>${e.toPageId}>${e.trigger?.kind ?? ''}>${(e.trigger?.target ?? '').trim()}`;
}
