import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  builtinKnowledgeBases,
  getBuiltinKnowledgeBase,
  isBuiltinKbId,
} from './builtinKnowledgeBases.js';

/**
 * 共用知識庫(Knowledge Base)—— 一等資產,**跨租戶共用**(所有登入使用者皆可取用)。
 *
 * 與 per-app 手寫知識(knowledge/<app>.md)不同:知識庫不綁 App、可重用、可在建立測試時多選疊加。
 * 存放於**共用命名空間**(非租戶前綴):shared/knowledge-bases/<id>.json。
 * 因跨租戶,故不經租戶隔離角色,由 API Lambda 自身角色直接存取(見 CDK 權限)。
 *
 * kind:
 * - category:遊戲類別型(可綁一個 genre,如 slot/mmorpg)。
 * - scenario:情境型(自由命名,如 RTP、登入流程、付費)。
 *
 * 每座知識庫含一份可網頁編輯的 Markdown(階段 A:直接注入 agent)。
 * 階段 B 會再加 Bedrock KB 文件檢索欄位(bedrockKbId 等),與 markdown 並存。
 */

export const KB_KINDS = ['category', 'scenario'] as const;
export type KbKind = (typeof KB_KINDS)[number];

/** Markdown 內容上限(每步都在場,字數乘步數變成本;比 per-app 知識稍寬)。 */
const MARKDOWN_MAX = 8000;

export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description?: string;
  kind: KbKind;
  /** kind=category 時可綁一個遊戲類別 key(對齊 APP_GENRES);scenario 不用。 */
  genre?: string;
  /** 可網頁編輯的 Markdown 知識(階段 A 直接注入)。 */
  markdown: string;
  /** true = 平台內建(唯讀,以程式碼為真相源,不落 S3,禁止編輯/刪除)。 */
  builtin?: boolean;
  /** ── Stage B:Bedrock KB(S3 Vectors)座標;有值代表這座 KB 已接文件檢索。 ── */
  bedrockKbId?: string;
  bedrockKbArn?: string;
  dataSourceId?: string;
  vectorBucketName?: string;
  indexName?: string;
  docsPrefix?: string;
  createdAt: string;
  updatedAt?: string;
}

/** 把 Bedrock KB 座標寫進既有記錄(provision 之後)。 */
export async function setBedrockCoords(
  s3: S3Client,
  bucket: string,
  id: string,
  coords: {
    bedrockKbId: string;
    bedrockKbArn: string;
    dataSourceId: string;
    vectorBucketName: string;
    indexName: string;
    docsPrefix: string;
  },
): Promise<KnowledgeBaseRecord> {
  const existing = await getKnowledgeBase(s3, bucket, id);
  if (!existing) throw new NotFoundError(`找不到知識庫: ${id}`);
  const next: KnowledgeBaseRecord = { ...existing, ...coords, updatedAt: new Date().toISOString() };
  await putKb(s3, bucket, next);
  return next;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

const KB_PREFIX = 'shared/knowledge-bases/';

function kbKey(id: string): string {
  return `${KB_PREFIX}${id}.json`;
}

function isKind(v: unknown): v is KbKind {
  return typeof v === 'string' && (KB_KINDS as readonly string[]).includes(v);
}

/** 校驗建立知識庫的請求主體。 */
export function validateCreateKb(body: unknown): {
  name: string;
  kind: KbKind;
  description?: string;
  genre?: string;
  markdown: string;
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  if (typeof b['name'] !== 'string' || b['name'].trim() === '') {
    throw new ValidationError('name 為必填');
  }
  if (!isKind(b['kind'])) {
    throw new ValidationError(`kind 必須是 ${KB_KINDS.join('/')} 之一`);
  }
  const markdown = typeof b['markdown'] === 'string' ? b['markdown'] : '';
  if (markdown.length > MARKDOWN_MAX) {
    throw new ValidationError(`markdown 不可超過 ${MARKDOWN_MAX} 字`);
  }
  const description =
    typeof b['description'] === 'string' && b['description'].trim() !== ''
      ? b['description'].trim()
      : undefined;
  const genre =
    b['kind'] === 'category' && typeof b['genre'] === 'string' && b['genre'] !== ''
      ? b['genre']
      : undefined;
  return {
    name: b['name'].trim(),
    kind: b['kind'],
    markdown,
    ...(description ? { description } : {}),
    ...(genre ? { genre } : {}),
  };
}

/** 校驗更新知識庫的請求主體(局部更新)。 */
export function validateUpdateKb(body: unknown): {
  name?: string;
  description?: string;
  genre?: string;
  markdown?: string;
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const out: { name?: string; description?: string; genre?: string; markdown?: string } = {};
  if ('name' in b) {
    if (typeof b['name'] !== 'string' || b['name'].trim() === '') {
      throw new ValidationError('name 不可為空');
    }
    out.name = b['name'].trim();
  }
  if ('description' in b) {
    if (typeof b['description'] !== 'string') {
      throw new ValidationError('description 必須是字串');
    }
    out.description = b['description'];
  }
  if ('genre' in b) {
    if (typeof b['genre'] !== 'string') {
      throw new ValidationError('genre 必須是字串');
    }
    out.genre = b['genre'];
  }
  if ('markdown' in b) {
    if (typeof b['markdown'] !== 'string') {
      throw new ValidationError('markdown 必須是字串');
    }
    if (b['markdown'].length > MARKDOWN_MAX) {
      throw new ValidationError(`markdown 不可超過 ${MARKDOWN_MAX} 字`);
    }
    out.markdown = b['markdown'];
  }
  return out;
}

/** 建立知識庫。 */
export async function createKnowledgeBase(
  s3: S3Client,
  bucket: string,
  input: { name: string; kind: KbKind; description?: string; genre?: string; markdown: string },
): Promise<KnowledgeBaseRecord> {
  const id = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const record: KnowledgeBaseRecord = {
    id,
    name: input.name,
    kind: input.kind,
    markdown: input.markdown,
    createdAt: now,
    updatedAt: now,
    ...(input.description ? { description: input.description } : {}),
    ...(input.genre ? { genre: input.genre } : {}),
  };
  await putKb(s3, bucket, record);
  return record;
}

/** 讀單一知識庫(先查內建;不存在回 null)。 */
export async function getKnowledgeBase(
  s3: S3Client,
  bucket: string,
  id: string,
): Promise<KnowledgeBaseRecord | null> {
  // 內建知識庫以程式碼為真相源,不落 S3,優先回傳。
  if (isBuiltinKbId(id)) return getBuiltinKnowledgeBase(id);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: kbKey(id) }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as KnowledgeBaseRecord) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/** 局部更新知識庫。找不到拋 NotFoundError;內建唯讀,拒絕修改。 */
export async function updateKnowledgeBase(
  s3: S3Client,
  bucket: string,
  id: string,
  patch: { name?: string; description?: string; genre?: string; markdown?: string },
): Promise<KnowledgeBaseRecord> {
  if (isBuiltinKbId(id)) throw new ValidationError('內建知識庫為唯讀,不可編輯');
  const existing = await getKnowledgeBase(s3, bucket, id);
  if (!existing) throw new NotFoundError(`找不到知識庫: ${id}`);
  const next: KnowledgeBaseRecord = { ...existing };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.markdown !== undefined) next.markdown = patch.markdown;
  if (patch.description !== undefined) {
    if (patch.description === '') delete next.description;
    else next.description = patch.description;
  }
  if (patch.genre !== undefined) {
    if (patch.genre === '') delete next.genre;
    else next.genre = patch.genre;
  }
  next.updatedAt = new Date().toISOString();
  await putKb(s3, bucket, next);
  return next;
}

/** 刪除知識庫(幂等);內建唯讀,拒絕刪除。 */
export async function deleteKnowledgeBase(
  s3: S3Client,
  bucket: string,
  id: string,
): Promise<void> {
  if (isBuiltinKbId(id)) throw new ValidationError('內建知識庫為唯讀,不可刪除');
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: kbKey(id) }));
}

/**
 * 列出所有共用知識庫:平台內建(builtin,程式碼真相源)在前,
 * 使用者建立的(S3)依建立時間新到舊排在後。
 */
export async function listKnowledgeBases(
  s3: S3Client,
  bucket: string,
): Promise<KnowledgeBaseRecord[]> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: KB_PREFIX }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('.json'));
  const records = await Promise.all(
    keys.map(async (Key) => {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
        const text = (await res.Body?.transformToString()) ?? '';
        return text ? (JSON.parse(text) as KnowledgeBaseRecord) : null;
      } catch {
        return null;
      }
    }),
  );
  const userKbs = records
    .filter((r): r is KnowledgeBaseRecord => r !== null)
    // 防禦:若 S3 曾誤存過與內建同 id 者,以內建為準,不重複列出。
    .filter((r) => !isBuiltinKbId(r.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // 內建在前(平台預載一眼可見),使用者項在後。
  return [...builtinKnowledgeBases(), ...userKbs];
}

/**
 * 讀多座知識庫的 Markdown 並組成注入區塊(給執行時用)。
 * 只回有 markdown 內容者;帶名稱標題讓 agent 知道每段來自哪座知識庫。
 * 找不到的 id 靜默略過(不擋執行)。
 */
export async function composeKnowledgeBases(
  s3: S3Client,
  bucket: string,
  ids: string[],
): Promise<string> {
  if (ids.length === 0) return '';
  const recs = await Promise.all(ids.map((id) => getKnowledgeBase(s3, bucket, id).catch(() => null)));
  const blocks: string[] = [];
  for (const r of recs) {
    if (r && r.markdown.trim()) {
      blocks.push(`## ${r.name}\n${r.markdown.trim()}`);
    }
  }
  return blocks.join('\n\n');
}

async function putKb(s3: S3Client, bucket: string, record: KnowledgeBaseRecord): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: kbKey(record.id),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );
}
