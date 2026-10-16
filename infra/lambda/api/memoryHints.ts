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
import { sanitizeOp, type GraphOp } from '../../../agent/memoryGraph.mjs';

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
  /** 記憶關係圖上手動拖曳的節點位置(只給前端排版用)。 */
  positions?: Record<string, { x: number; y: number }>;
  /** 手動新增的路徑(人工標註 = 對 AI 視為可靠)。 */
  addedEdges?: ManualEdge[];
  /** 合併畫面:被併入的 pageId → 目標 pageId。 */
  merges?: Record<string, string>;
  /** 使用者在關係圖上畫的順序路線(整個應用共用,每次測試注入 AI)。 */
  routes?: MemoryRoute[];
  /**
   * 記憶腳本:每條路徑 / 同畫面操作(edgeKey,同畫面為 from===to)的人工修正。
   * op = 修正後的點擊位置等(0~1 相對座標);verified = 確認可直接執行;disabled = 不要自動執行。
   */
  opEdits?: Record<string, OpEdit>;
  updatedAt?: string;
}

export interface OpEdit {
  op?: GraphOp;
  verified?: boolean;
  disabled?: boolean;
  updatedAt?: string;
}
export const MAX_OP_EDITS = 500;
/** 路徑 / 同畫面操作的識別鍵:page_x>page_y>動作>目標(目標 ≤ 40 字)。 */
const OP_KEY_RE = /^page_[a-f0-9]{8,32}>page_[a-f0-9]{8,32}>[a-z]{2,8}>[^\n]{0,40}$/;

/** 路線的一步:到某個畫面、在那裡做什麼。 */
export interface RouteStep { id: string; pageId: string; action: string }
/**
 * 支線:做到 fromStepId 那一步時若出現 pageId 畫面(例如當天限定活動彈窗),
 * 先做 action,再回到 returnStepId 那一步繼續。
 */
export interface RouteBranch { id: string; fromStepId: string; pageId: string; action: string; returnStepId: string }
export interface MemoryRoute {
  id: string;
  name: string;
  enabled: boolean;
  steps: RouteStep[];
  branches: RouteBranch[];
  updatedAt?: string;
}
export const MAX_ROUTES = 20;
export const MAX_ROUTE_STEPS = 40;
export const MAX_ROUTE_BRANCHES = 40;
const ROUTE_ID_RE = /^route-[a-z0-9]{6,24}$/;
const STEP_ID_RE = /^[sb]-[a-z0-9]{4,24}$/;

export const EDGE_KINDS = ['tap', 'swipe', 'back', 'auto'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export interface ManualEdge {
  fromPageId: string;
  toPageId: string;
  trigger: { kind: EdgeKind; label: string; target?: string };
}
export const MAX_ADDED_EDGES = 300;

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
  | { op: 'deleteEdge'; edgeKey: string; manualOnly?: boolean }
  | { op: 'restoreEdge'; edgeKey: string }
  | { op: 'move'; pageId: string; x: number; y: number }
  | { op: 'moveMany'; positions: Record<string, { x: number; y: number }> }
  | { op: 'resetLayout' }
  | { op: 'addEdge'; edge: ManualEdge }
  | { op: 'mergePage'; pageId: string; intoPageId: string }
  | { op: 'saveRoute'; route: MemoryRoute }
  | { op: 'deleteRoute'; routeId: string }
  | { op: 'setOp'; key: string; patch: { op?: GraphOp | null; verified?: boolean; disabled?: boolean } }
  | { op: 'clearOp'; key: string };

function cleanAction(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** 驗證整條路線(前端每次整條送上來)。 */
export function parseRoute(v: unknown): MemoryRoute {
  const r = (v ?? {}) as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && ROUTE_ID_RE.test(r['id']) ? r['id'] : undefined;
  if (!id) throw new HintValidationError('route.id 格式不正確');
  const name = typeof r['name'] === 'string' ? r['name'].replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  if (!name) throw new HintValidationError('路線名稱必填');
  const rawSteps = Array.isArray(r['steps']) ? r['steps'] : [];
  if (rawSteps.length === 0) throw new HintValidationError('路線至少要有一步');
  if (rawSteps.length > MAX_ROUTE_STEPS) throw new HintValidationError(`每條路線最多 ${MAX_ROUTE_STEPS} 步`);
  const ids = new Set<string>();
  const uniqueId = (x: unknown, what: string): string => {
    if (typeof x !== 'string' || !STEP_ID_RE.test(x) || ids.has(x)) throw new HintValidationError(`${what} id 格式不正確或重複`);
    ids.add(x);
    return x;
  };
  const steps: RouteStep[] = rawSteps.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const pageId = cleanPage(o['pageId']);
    if (!pageId) throw new HintValidationError('路線步驟需要 pageId');
    return { id: uniqueId(o['id'], '步驟'), pageId, action: cleanAction(o['action']) };
  });
  const stepIds = new Set(steps.map((s) => s.id));
  const rawBranches = Array.isArray(r['branches']) ? r['branches'] : [];
  if (rawBranches.length > MAX_ROUTE_BRANCHES) throw new HintValidationError(`每條路線最多 ${MAX_ROUTE_BRANCHES} 條支線`);
  const branches: RouteBranch[] = rawBranches.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const pageId = cleanPage(o['pageId']);
    const fromStepId = typeof o['fromStepId'] === 'string' && stepIds.has(o['fromStepId']) ? o['fromStepId'] : undefined;
    const returnStepId = typeof o['returnStepId'] === 'string' && stepIds.has(o['returnStepId']) ? o['returnStepId'] : fromStepId;
    if (!pageId || !fromStepId || !returnStepId) throw new HintValidationError('支線需要畫面與所屬步驟');
    return { id: uniqueId(o['id'], '支線'), fromStepId, pageId, action: cleanAction(o['action']), returnStepId };
  });
  return { id, name, enabled: r['enabled'] !== false, steps, branches };
}

function cleanCoord(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= 1e6 ? Math.round(n) : undefined;
}

/** 手動路徑的 label(與 memoryGraph 的格式一致:auto 或「動作 目標」)。 */
function edgeLabel(kind: EdgeKind, target?: string): string {
  if (kind === 'auto') return 'auto';
  return target ? `${kind} ${target}` : kind;
}

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
      if (!edgeKey) throw new HintValidationError(`${op} 需要 edgeKey`);
      return { op, edgeKey, ...(b['manualOnly'] === true ? { manualOnly: true } : {}) };
    case 'restoreEdge':
      if (!edgeKey) throw new HintValidationError(`${op} 需要 edgeKey`);
      return { op, edgeKey };
    case 'move': {
      const x = cleanCoord(b['x']);
      const y = cleanCoord(b['y']);
      if (!pageId || x === undefined || y === undefined) throw new HintValidationError('move 需要 pageId、x、y');
      return { op, pageId, x, y };
    }
    case 'moveMany': {
      const src = b['positions'];
      if (!src || typeof src !== 'object') throw new HintValidationError('moveMany 需要 positions');
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [id, v] of Object.entries(src as Record<string, unknown>).slice(0, 500)) {
        const p = (v ?? {}) as Record<string, unknown>;
        const x = cleanCoord(p['x']);
        const y = cleanCoord(p['y']);
        if (cleanPage(id) && x !== undefined && y !== undefined) positions[id] = { x, y };
      }
      return { op, positions };
    }
    case 'resetLayout':
      return { op };
    case 'addEdge': {
      const from = cleanPage(b['fromPageId']);
      const to = cleanPage(b['toPageId']);
      const kind = b['kind'];
      if (!from || !to) throw new HintValidationError('addEdge 需要 fromPageId 與 toPageId');
      if (from === to) throw new HintValidationError('起點與終點不可相同');
      if (typeof kind !== 'string' || !(EDGE_KINDS as readonly string[]).includes(kind)) {
        throw new HintValidationError(`kind 只能是 ${EDGE_KINDS.join(' / ')}`);
      }
      const k = kind as EdgeKind;
      const target = k === 'auto' ? '' : (typeof b['target'] === 'string' ? b['target'].trim().replace(/\s+/g, ' ').slice(0, 40) : '');
      return {
        op,
        edge: { fromPageId: from, toPageId: to, trigger: { kind: k, label: edgeLabel(k, target), ...(target ? { target } : {}) } },
      };
    }
    case 'mergePage': {
      const into = cleanPage(b['intoPageId']);
      if (!pageId || !into) throw new HintValidationError('mergePage 需要 pageId 與 intoPageId');
      if (pageId === into) throw new HintValidationError('不可合併到自己');
      return { op, pageId, intoPageId: into };
    }
    case 'saveRoute':
      return { op, route: parseRoute(b['route']) };
    case 'deleteRoute': {
      const routeId = typeof b['routeId'] === 'string' && ROUTE_ID_RE.test(b['routeId']) ? b['routeId'] : undefined;
      if (!routeId) throw new HintValidationError('deleteRoute 需要 routeId');
      return { op, routeId };
    }
    case 'setOp':
    case 'clearOp': {
      const key = typeof b['key'] === 'string' && OP_KEY_RE.test(b['key']) ? b['key'] : undefined;
      if (!key) throw new HintValidationError(`${op} 需要有效的 key`);
      if (op === 'clearOp') return { op, key };
      const patch: { op?: GraphOp | null; verified?: boolean; disabled?: boolean } = {};
      if (b['opData'] === null) patch.op = null;
      else if (b['opData'] !== undefined) {
        const clean = sanitizeOp(b['opData']);
        if (!clean) throw new HintValidationError('操作格式不正確(座標需為 0~1)');
        // 動作種類必須與路徑一致(不能把「點擊」路徑改成「滑動」)。
        if (clean.a !== key.split('>')[2]) throw new HintValidationError('操作的動作與路徑不一致');
        patch.op = clean;
      }
      if (typeof b['verified'] === 'boolean') patch.verified = b['verified'];
      if (typeof b['disabled'] === 'boolean') patch.disabled = b['disabled'];
      if (Object.keys(patch).length === 0) throw new HintValidationError('setOp 沒有要修改的內容');
      return { op, key, patch };
    }
    default:
      throw new HintValidationError('op 不支援');
  }
}

export async function applyEdit(s3: S3Client, bucket: string, tenantId: string, app: string, e: EditOp): Promise<MemoryEdits> {
  return mutate(s3, bucket, `${prefix(tenantId, app)}/edits.json`, emptyEdits, (raw) => {
    const doc: MemoryEdits = {
      ...emptyEdits(),
      ...raw,
      renames: { ...(raw.renames ?? {}) },
      positions: { ...(raw.positions ?? {}) },
      addedEdges: [...(raw.addedEdges ?? [])],
      merges: { ...(raw.merges ?? {}) },
      routes: [...(raw.routes ?? [])],
    };
    const positions = doc.positions!;
    const merges = doc.merges!;
    let added = doc.addedEdges!;
    const del = new Set(doc.deletedPages);
    const delE = new Set(doc.deletedEdges);
    switch (e.op) {
      case 'rename': doc.renames[e.pageId] = e.name; break;
      case 'clearRename': delete doc.renames[e.pageId]; break;
      case 'deletePage':
        del.add(e.pageId);
        delete positions[e.pageId];
        added = added.filter((x) => x.fromPageId !== e.pageId && x.toPageId !== e.pageId);
        break;
      case 'restorePage': del.delete(e.pageId); break;
      case 'deleteEdge':
        added = added.filter((x) => edgeKey(x) !== e.edgeKey);
        // 純手動路徑(AI 從沒走過)直接移除即可,不必進「已刪除」清單。
        if (!e.manualOnly) delE.add(e.edgeKey);
        break;
      case 'restoreEdge': delE.delete(e.edgeKey); break;
      case 'move': positions[e.pageId] = { x: e.x, y: e.y }; break;
      case 'moveMany': Object.assign(positions, e.positions); break;
      case 'resetLayout': doc.positions = {}; break;
      case 'addEdge': {
        const key = edgeKey(e.edge);
        delE.delete(key);
        if (!added.some((x) => edgeKey(x) === key)) {
          if (added.length >= MAX_ADDED_EDGES) throw new HintValidationError(`手動路徑最多 ${MAX_ADDED_EDGES} 條`);
          added = [...added, e.edge];
        }
        break;
      }
      case 'mergePage': {
        // 目標若早已被併到別處,沿著鏈找到最終目標(防循環)。
        let into = e.intoPageId;
        for (let i = 0; i < 50 && merges[into]; i++) into = merges[into]!;
        if (into === e.pageId) throw new HintValidationError('不可合併到自己');
        merges[e.pageId] = into;
        // 先前併入 pageId 的也一併改指向新目標(保持單層對應)。
        for (const [k, v] of Object.entries(merges)) if (v === e.pageId) merges[k] = into;
        delete positions[e.pageId];
        delete doc.renames[e.pageId];
        const remap = (id: string) => (id === e.pageId ? into : id);
        // 路線經過被合併的畫面 → 改指向合併後的畫面。
        doc.routes = (doc.routes ?? []).map((r) => ({
          ...r,
          steps: r.steps.map((s) => ({ ...s, pageId: remap(s.pageId) })),
          branches: r.branches.map((x) => ({ ...x, pageId: remap(x.pageId) })),
        }));
        const seen = new Set<string>();
        added = added
          .map((x) => ({ ...x, fromPageId: remap(x.fromPageId), toPageId: remap(x.toPageId) }))
          .filter((x) => {
            const k = edgeKey(x);
            if (x.fromPageId === x.toPageId || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        break;
      }
      case 'saveRoute': {
        const routes = doc.routes ?? [];
        const next = { ...e.route, updatedAt: new Date().toISOString() };
        const i = routes.findIndex((r) => r.id === next.id);
        if (i >= 0) routes[i] = next;
        else {
          if (routes.length >= MAX_ROUTES) throw new HintValidationError(`每個應用最多 ${MAX_ROUTES} 條路線`);
          routes.push(next);
        }
        doc.routes = routes;
        break;
      }
      case 'deleteRoute':
        doc.routes = (doc.routes ?? []).filter((r) => r.id !== e.routeId);
        break;
      case 'setOp': {
        const opEdits = { ...(doc.opEdits ?? {}) };
        const cur: OpEdit = { ...(opEdits[e.key] ?? {}) };
        if (e.patch.op === null) delete cur.op;
        else if (e.patch.op) cur.op = e.patch.op;
        if (e.patch.verified !== undefined) cur.verified = e.patch.verified;
        if (e.patch.disabled !== undefined) cur.disabled = e.patch.disabled;
        // 確認與停用互斥:最後一個動作為準。
        if (e.patch.verified === true) cur.disabled = false;
        if (e.patch.disabled === true) cur.verified = false;
        if (!opEdits[e.key] && Object.keys(opEdits).length >= MAX_OP_EDITS) throw new HintValidationError(`操作修正最多 ${MAX_OP_EDITS} 筆`);
        opEdits[e.key] = { ...cur, updatedAt: new Date().toISOString() };
        doc.opEdits = opEdits;
        break;
      }
      case 'clearOp': {
        const opEdits = { ...(doc.opEdits ?? {}) };
        delete opEdits[e.key];
        doc.opEdits = opEdits;
        break;
      }
    }
    doc.addedEdges = added;
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
