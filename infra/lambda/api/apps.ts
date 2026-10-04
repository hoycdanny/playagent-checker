import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

/** 被測應用平台。 */
export const APP_PLATFORMS = ['android', 'ios', 'windows', 'web'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * 遊戲類型(genre)。以「玩法機制優先」的產業分類為基準,涵蓋主機/PC 與手遊,
 * 並特別納入 slot/casino 博弈家族(測試團隊常見需求)。前端每個類型配一枚 SVG 圖示。
 * 值為穩定英文 key(存 S3、跨語系顯示標籤由前端 i18n 對應)。
 */
export const APP_GENRES = [
  'action',
  'adventure',
  'action_adventure',
  'rpg',
  'mmorpg',
  'strategy',
  'simulation',
  'shooter',
  'fighting',
  'platformer',
  'puzzle',
  'racing',
  'sports',
  'card',
  'board',
  'rhythm',
  'survival',
  'survivor',
  'roguelike',
  'battle_royale',
  'sandbox',
  'idle',
  'tower_defense',
  'moba',
  'slot',
  'casino',
  'bingo',
  'casual',
  'hyper_casual',
  'educational',
  'other',
] as const;
export type AppGenre = (typeof APP_GENRES)[number];

/** 版本字串長度上限(如 1.2.3 / build 號)。 */
const VERSION_MAX = 64;

export interface AppRecord {
  id: string;
  name: string;
  platform: AppPlatform;
  /** Android 套件名 / iOS bundleId 等,依平台而異(可選)。 */
  identifier?: string;
  /** 遊戲類型(可選)。 */
  genre?: AppGenre;
  /** 次要遊戲類型(可多選,如 RPG + Action);報告引擎合併各類型 profile。 */
  secondaryGenres?: AppGenre[];
  /** 版本(可選,手動填;未來可由 APK 自動解析)。 */
  version?: string;
  /** 引用的產物 id(可選,階段 3 上傳後填入)。 */
  artifactId?: string;
  /** 應用圖示/代表截圖的產物 id(png,可選);前端列表顯示小截圖用。 */
  iconArtifactId?: string;
  /** 測試人員備註(版本、登入需求、注意事項等,可選)。 */
  notes?: string;
  /** 預設帶入的共用知識庫 id(建立測試時預選,可覆蓋)。 */
  defaultKnowledgeBaseIds?: string[];
  createdAt: string;
  /** 最後更新時間(建立時等於 createdAt)。 */
  updatedAt?: string;
}

function appsPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}apps/`;
}

function appKey(tenantId: string, appId: string): string {
  return `${appsPrefix(tenantId)}${appId}.json`;
}

function isPlatform(v: unknown): v is AppPlatform {
  return typeof v === 'string' && (APP_PLATFORMS as readonly string[]).includes(v);
}

function isGenre(v: unknown): v is AppGenre {
  return typeof v === 'string' && (APP_GENRES as readonly string[]).includes(v);
}

/** 次要類型上限(避免 profile 合併過多稀釋報告)。 */
const SECONDARY_GENRES_MAX = 3;

/** 校驗次要類型陣列:必須都在清單內、去重、上限 3。 */
function parseSecondaryGenres(raw: unknown): AppGenre[] {
  if (!Array.isArray(raw)) throw new ValidationError('secondaryGenres 必須是陣列');
  const out: AppGenre[] = [];
  for (const g of raw) {
    if (!isGenre(g)) throw new ValidationError('secondaryGenres 含不支援的類型');
    if (!out.includes(g)) out.push(g);
  }
  if (out.length > SECONDARY_GENRES_MAX) throw new ValidationError(`secondaryGenres 最多 ${SECONDARY_GENRES_MAX} 個`);
  return out;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

/** 應用備註長度上限(避免無節制寫入)。 */
const NOTES_MAX = 2000;

/** 校驗並正規化建立 App 的請求主體。 */
export function validateCreateApp(body: unknown): {
  name: string;
  platform: AppPlatform;
  identifier?: string;
  genre?: AppGenre;
  secondaryGenres?: AppGenre[];
  version?: string;
  artifactId?: string;
  iconArtifactId?: string;
  notes?: string;
  defaultKnowledgeBaseIds?: string[];
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const name = b['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('name 為必填');
  }
  if (!isPlatform(b['platform'])) {
    throw new ValidationError(`platform 必須是 ${APP_PLATFORMS.join('/')} 之一`);
  }
  // genre 若提供必須在清單內(空字串/未提供視為不設定)。
  if (b['genre'] !== undefined && b['genre'] !== '' && !isGenre(b['genre'])) {
    throw new ValidationError('genre 不在支援清單內');
  }
  return {
    name: name.trim(),
    platform: b['platform'],
    ...optionalStr(b, 'identifier'),
    ...(isGenre(b['genre']) ? { genre: b['genre'] } : {}),
    ...(b['secondaryGenres'] !== undefined
      ? (() => {
          const sg = parseSecondaryGenres(b['secondaryGenres']).filter((g) => g !== b['genre']);
          return sg.length > 0 ? { secondaryGenres: sg } : {};
        })()
      : {}),
    ...optionalVersion(b),
    ...optionalStr(b, 'artifactId'),
    ...optionalStr(b, 'iconArtifactId'),
    ...optionalNotes(b),
    ...optionalKbIds(b),
  };
}

/** 正規化 defaultKnowledgeBaseIds(只收安全字串 id 的陣列)。 */
function optionalKbIds(b: Record<string, unknown>): { defaultKnowledgeBaseIds?: string[] } {
  const raw = b['defaultKnowledgeBaseIds'];
  if (!Array.isArray(raw)) return {};
  const ids = raw.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x));
  return { defaultKnowledgeBaseIds: ids };
}

/**
 * 校驗更新 App 的請求主體(局部更新)。只帶入有提供的欄位;
 * name 若提供不可為空,platform 若提供必須合法。
 */
export function validateUpdateApp(body: unknown): {
  name?: string;
  platform?: AppPlatform;
  identifier?: string;
  genre?: string;
  secondaryGenres?: AppGenre[];
  version?: string;
  artifactId?: string;
  iconArtifactId?: string;
  notes?: string;
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const out: {
    name?: string;
    platform?: AppPlatform;
    identifier?: string;
    genre?: string;
    secondaryGenres?: AppGenre[];
    version?: string;
    artifactId?: string;
    iconArtifactId?: string;
    notes?: string;
    defaultKnowledgeBaseIds?: string[];
  } = {};

  // 次要類型:空陣列 = 清除。
  if ('secondaryGenres' in b) out.secondaryGenres = parseSecondaryGenres(b['secondaryGenres']);

  if ('defaultKnowledgeBaseIds' in b) {
    const raw = b['defaultKnowledgeBaseIds'];
    if (!Array.isArray(raw)) {
      throw new ValidationError('defaultKnowledgeBaseIds 必須是陣列');
    }
    out.defaultKnowledgeBaseIds = raw.filter(
      (x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x),
    );
  }

  if ('name' in b) {
    if (typeof b['name'] !== 'string' || b['name'].trim().length === 0) {
      throw new ValidationError('name 不可為空');
    }
    out.name = b['name'].trim();
  }
  if ('platform' in b) {
    if (!isPlatform(b['platform'])) {
      throw new ValidationError(`platform 必須是 ${APP_PLATFORMS.join('/')} 之一`);
    }
    out.platform = b['platform'];
  }
  if ('genre' in b) {
    // 空字串代表清除;非空必須在清單內。
    if (typeof b['genre'] !== 'string') {
      throw new ValidationError('genre 必須是字串');
    }
    if (b['genre'] !== '' && !isGenre(b['genre'])) {
      throw new ValidationError('genre 不在支援清單內');
    }
    out.genre = b['genre'];
  }
  if ('version' in b) {
    if (typeof b['version'] !== 'string') {
      throw new ValidationError('version 必須是字串');
    }
    if (b['version'].length > VERSION_MAX) {
      throw new ValidationError(`version 不可超過 ${VERSION_MAX} 字`);
    }
    out.version = b['version'];
  }
  // 這些欄位允許以空字串清除,故用字串型別判定(空字串代表清除)。
  for (const field of ['identifier', 'artifactId', 'iconArtifactId'] as const) {
    if (field in b) {
      if (typeof b[field] !== 'string') {
        throw new ValidationError(`${field} 必須是字串`);
      }
      out[field] = b[field] as string;
    }
  }
  if ('notes' in b) {
    if (typeof b['notes'] !== 'string') {
      throw new ValidationError('notes 必須是字串');
    }
    if (b['notes'].length > NOTES_MAX) {
      throw new ValidationError(`notes 不可超過 ${NOTES_MAX} 字`);
    }
    out.notes = b['notes'];
  }
  return out;
}

function optionalStr(
  b: Record<string, unknown>,
  key: 'identifier' | 'artifactId' | 'iconArtifactId',
): Record<string, string> {
  const v = b[key];
  return typeof v === 'string' && v.length > 0 ? { [key]: v } : {};
}

function optionalNotes(b: Record<string, unknown>): { notes?: string } {
  const v = b['notes'];
  if (typeof v !== 'string' || v.length === 0) return {};
  if (v.length > NOTES_MAX) throw new ValidationError(`notes 不可超過 ${NOTES_MAX} 字`);
  return { notes: v };
}

function optionalVersion(b: Record<string, unknown>): { version?: string } {
  const v = b['version'];
  if (typeof v !== 'string' || v.trim().length === 0) return {};
  if (v.length > VERSION_MAX) throw new ValidationError(`version 不可超過 ${VERSION_MAX} 字`);
  return { version: v.trim() };
}

/** 建立 App,落租戶前綴。回傳新建的 AppRecord。 */
export async function createApp(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  input: {
    name: string;
    platform: AppPlatform;
    identifier?: string;
    genre?: AppGenre;
    secondaryGenres?: AppGenre[];
    version?: string;
    artifactId?: string;
    iconArtifactId?: string;
    notes?: string;
    defaultKnowledgeBaseIds?: string[];
  },
): Promise<AppRecord> {
  const id = `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const record: AppRecord = {
    id,
    name: input.name,
    platform: input.platform,
    createdAt: now,
    updatedAt: now,
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(input.genre ? { genre: input.genre } : {}),
    ...(input.secondaryGenres && input.secondaryGenres.length > 0 ? { secondaryGenres: input.secondaryGenres } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.iconArtifactId ? { iconArtifactId: input.iconArtifactId } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.defaultKnowledgeBaseIds && input.defaultKnowledgeBaseIds.length > 0
      ? { defaultKnowledgeBaseIds: input.defaultKnowledgeBaseIds }
      : {}),
  };
  await putApp(s3, bucket, tenantId, record);
  return record;
}

/** 讀單一 App(不存在回 null)。 */
export async function getApp(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
): Promise<AppRecord | null> {
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: appKey(tenantId, appId) }),
    );
    const text = await obj.Body?.transformToString();
    return text ? (JSON.parse(text) as AppRecord) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/**
 * 局部更新 App:讀現有記錄,合併變更欄位後寫回。
 * 對 identifier/artifactId/iconArtifactId/notes,傳入空字串代表清除該欄位。
 * 找不到 App 時拋 NotFoundError。
 */
export async function updateApp(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
  patch: {
    name?: string;
    platform?: AppPlatform;
    identifier?: string;
    genre?: string;
    secondaryGenres?: AppGenre[];
    version?: string;
    artifactId?: string;
    iconArtifactId?: string;
    notes?: string;
    defaultKnowledgeBaseIds?: string[];
  },
): Promise<AppRecord> {
  const existing = await getApp(s3, bucket, tenantId, appId);
  if (!existing) throw new NotFoundError(`找不到 App: ${appId}`);

  const next: AppRecord = { ...existing };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.platform !== undefined) next.platform = patch.platform;
  if (patch.defaultKnowledgeBaseIds !== undefined) {
    if (patch.defaultKnowledgeBaseIds.length === 0) delete next.defaultKnowledgeBaseIds;
    else next.defaultKnowledgeBaseIds = patch.defaultKnowledgeBaseIds;
  }
  // genre 已在校驗層確保非空時屬合法值;空字串→清除。
  if (patch.genre !== undefined) {
    if (patch.genre === '') delete next.genre;
    else next.genre = patch.genre as AppGenre;
  }
  if (patch.secondaryGenres !== undefined) {
    const sg = patch.secondaryGenres.filter((g) => g !== next.genre);
    if (sg.length === 0) delete next.secondaryGenres;
    else next.secondaryGenres = sg;
  }
  applyClearable(next, 'version', patch.version);
  applyClearable(next, 'identifier', patch.identifier);
  applyClearable(next, 'artifactId', patch.artifactId);
  applyClearable(next, 'iconArtifactId', patch.iconArtifactId);
  applyClearable(next, 'notes', patch.notes);
  next.updatedAt = new Date().toISOString();

  await putApp(s3, bucket, tenantId, next);
  return next;
}

/** 對可清除欄位套用 patch:空字串→刪除欄位;非空→設值;undefined→不動。 */
function applyClearable(
  record: AppRecord,
  key: 'identifier' | 'version' | 'artifactId' | 'iconArtifactId' | 'notes',
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (value === '') delete record[key];
  else record[key] = value;
}

/** 刪除 App(找不到視為已刪,幂等)。 */
export async function deleteApp(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: appKey(tenantId, appId) }),
  );
}

async function putApp(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  record: AppRecord,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: appKey(tenantId, record.id),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
}

/** 列出某租戶的所有 App(讀每個物件內容)。 */
export async function listApps(
  s3: S3Client,
  bucket: string,
  tenantId: string,
): Promise<AppRecord[]> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: appsPrefix(tenantId) }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.json'));

  const records = await Promise.all(
    keys.map(async (key) => {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const text = await obj.Body?.transformToString();
      if (!text) return null;
      try {
        return JSON.parse(text) as AppRecord;
      } catch {
        return null;
      }
    }),
  );
  return records
    .filter((r): r is AppRecord => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
