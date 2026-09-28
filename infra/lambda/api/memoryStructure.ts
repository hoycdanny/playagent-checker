import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

/**
 * Memory 導覽關係圖的讀取(對應主機 runner harvest 落的 structure.json / meta.json)。
 * 跨測試累積:每次 emulator 任務跑完,runner 用 pHash 去重把畫面收斂成 Page、建轉移 Edge。
 * 結構:tenants/<t>/memory/<app>/structure.json、meta.json、screenshots/<pageId>.png。
 */

export interface MemPage {
  id: string;
  name: string;
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
  trigger: { kind: string; label?: string };
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
}> {
  const prefix = memPrefix(tenantId, app);
  const structure =
    (await readJson<MemStructure>(s3, bucket, `${prefix}/structure.json`)) ?? {
      schemaVersion: 1,
      appName: app,
      rootPageId: null,
      pages: {},
      edges: [],
      lastUpdatedAt: null,
    };
  const meta = (await readJson<{ totalRuns?: number }>(s3, bucket, `${prefix}/meta.json`)) ?? {};

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
  };
}

/** 某 Page 截圖的 S3 key(供 presigned GET)。 */
export function memScreenshotKey(tenantId: string, app: string, pageId: string): string {
  return `${memPrefix(tenantId, app)}/screenshots/${pageId}.png`;
}
