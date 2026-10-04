import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { compactStructure, summarizeForAgent } from '../../../agent/memoryGraph.mjs';
import { applyEdits, edgeKey, type EditsLike } from '../../../agent/operatorMemory.mjs';

/** 讀某 App 的導覽圖並轉成給 agent 的精簡文字(已知畫面 + 可靠路徑)。無資料回空字串。 */
export async function readNavigationSummary(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
): Promise<string> {
  const [raw, edits] = await Promise.all([
    readJson<unknown>(s3, bucket, `${memPrefix(tenantId, app)}/structure.json`),
    readJson<EditsLike>(s3, bucket, `${memPrefix(tenantId, app)}/edits.json`),
  ]);
  if (!raw) return '';
  // 使用者在記憶地圖刪掉/改名的畫面與路徑,摘要給 AI 時也要反映(刪掉的錯誤路徑不再當成「已驗證」)。
  return summarizeForAgent(applyEdits(compactStructure(raw), edits));
}

/**
 * Memory 導覽關係圖的讀取(對應主機 runner harvest 落的 structure.json / meta.json)。
 * 跨測試累積:每次 emulator 任務跑完,runner 用 pHash 去重把畫面收斂成 Page、建轉移 Edge。
 * 結構:tenants/<t>/memory/<app>/structure.json、meta.json、screenshots/<pageId>.png。
 */

export interface MemPage {
  id: string;
  name: string;
  /** AI 對此畫面用過的所有命名與次數(同一畫面不同說法會合併在這裡)。 */
  aliases?: Record<string, number>;
  module?: string;
  /** 載入/過場類畫面(收斂成單一「載入中」節點)。 */
  transient?: boolean;
  /** 使用者在記憶地圖改過名(autoName = AI 自動命名)。 */
  renamed?: boolean;
  autoName?: string;
  pHash: string;
  screenshotRef: string;
  knownControlLabels: string[];
  visitCount: number;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface MemEdge {
  fromPageId: string;
  toPageId: string;
  /** kind = tap/swipe/back/move/type/launch/auto;target = 操作的元件文字。 */
  trigger: { kind: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
}
export interface MemStructure {
  schemaVersion: number;
  appName: string;
  rootPageId: string | null;
  pages: Record<string, MemPage>;
  edges: MemEdge[];
  lastUpdatedAt: string | null;
}

function memPrefix(tenantId: string, app: string): string {
  return `${tenantPrefix(tenantId)}memory/${app}`;
}

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
    throw err;
  }
}

/**
 * 讀某 App 的 Memory 導覽地圖 + 統計。不存在回空結構(前端顯示空狀態)。
 * 統計:介面數(pages)、轉移關係數(edges)、控件數(knownControlLabels 去重)、採集次數(totalRuns)。
 */
export async function readMemoryOverview(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
): Promise<{
  structure: MemStructure;
  stats: { pages: number; edges: number; controls: number; totalRuns: number };
  edits: EditsLike;
  /** 被使用者刪掉的畫面/路徑(帶顯示名稱,供記憶地圖「已刪除」清單還原)。 */
  deleted: {
    pages: Array<{ id: string; name: string }>;
    edges: Array<{ key: string; from: string; to: string; label?: string }>;
  };
}> {
  const prefix = memPrefix(tenantId, app);
  const [raw, editsRaw] = await Promise.all([
    readJson<MemStructure>(s3, bucket, `${prefix}/structure.json`),
    readJson<EditsLike>(s3, bucket, `${prefix}/edits.json`),
  ]);
  const edits: EditsLike = { renames: editsRaw?.renames ?? {}, deletedPages: editsRaw?.deletedPages ?? [], deletedEdges: editsRaw?.deletedEdges ?? [] };
  // 讀取時以新規則收斂(合併 AI 不同命名的同一畫面、去自環/wait 邊、合併重複邊),
  // 舊資料也能直接顯示成乾淨的畫面流程圖;runner 下次執行會把收斂結果寫回。
  // 再套上使用者在記憶地圖的手動編修(改名/刪畫面/刪路徑)。
  const compact = raw ? (compactStructure(raw) as unknown as MemStructure) : null;
  const structure: MemStructure = compact
    ? (applyEdits(compact, edits) as unknown as MemStructure)
    : { schemaVersion: 2, appName: app, rootPageId: null, pages: {}, edges: [], lastUpdatedAt: null };
  const meta = (await readJson<{ totalRuns?: number }>(s3, bucket, `${prefix}/meta.json`)) ?? {};

  // 已刪除清單:以收斂後(未套編修)的原始結構找回名稱;已不存在的 id 照樣列出(仍可還原)。
  const nameOf = (id: string) => edits.renames?.[id] ?? compact?.pages[id]?.name ?? id;
  const deletedPages = (edits.deletedPages ?? []).map((id) => ({ id, name: nameOf(id) }));
  const deletedEdges = (edits.deletedEdges ?? []).map((key) => {
    const e = compact?.edges.find((x) => edgeKey(x) === key);
    const [from = '', to = '', , target = ''] = key.split('>');
    return {
      key,
      from: nameOf(e?.fromPageId ?? from),
      to: nameOf(e?.toPageId ?? to),
      ...((e?.trigger?.label ?? target) ? { label: e?.trigger?.label ?? target } : {}),
    };
  });

  const pages = Object.values(structure.pages);
  const controlSet = new Set<string>();
  for (const p of pages) for (const c of p.knownControlLabels ?? []) controlSet.add(`${p.id}::${c}`);

  return {
    structure,
    stats: {
      pages: pages.length,
      edges: structure.edges.length,
      controls: controlSet.size,
      totalRuns: meta.totalRuns ?? 0,
    },
    edits,
    deleted: { pages: deletedPages, edges: deletedEdges },
  };
}

/** 某 Page 截圖的 S3 key(供 presigned GET)。 */
export function memScreenshotKey(tenantId: string, app: string, pageId: string): string {
  return `${memPrefix(tenantId, app)}/screenshots/${pageId}.png`;
}
