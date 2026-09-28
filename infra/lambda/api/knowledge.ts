import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

/**
 * Memory 與 Knowledge 的邊界(Req 9):
 * - Memory:機器學習得到的頁面/控件記憶,按 `(App, Locality)` 隔離為互不合併的實例。
 *   key: tenants/<t>/memory/<app>/<locality>/...
 * - Knowledge:使用者手寫的 App 長期事實,按 App 單一實例,權威源為可編輯檔案。
 *   key: tenants/<t>/knowledge/<app>.md
 * 衝突時 Knowledge 優先於 Memory(Req 9.3);清 Memory / 刪 App 不動 Knowledge(Req 9.4)。
 */

export type Locality = 'cloud' | 'attached';

function knowledgeKey(tenantId: string, app: string): string {
  return `${tenantPrefix(tenantId)}knowledge/${app}.md`;
}

function memoryPrefix(tenantId: string, app: string, locality: Locality): string {
  return `${tenantPrefix(tenantId)}memory/${app}/${locality}/`;
}

/**
 * 讀某 App 在某 Locality 的 Memory 摘要(統計觀察)。
 * Memory 按 (App, Locality) 隔離不合併(Req 9.1);此處只讀對應 locality 前綴下的
 * summary.md(若有),不跨 locality。不存在回空字串。
 */
export async function readMemory(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  locality: Locality,
): Promise<string> {
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `${memoryPrefix(tenantId, app, locality)}summary.md`,
      }),
    );
    return (await res.Body?.transformToString()) ?? '';
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return '';
    }
    throw err;
  }
}

/** 讀某 App 的知識(手寫事實)。不存在回空字串。 */
export async function readKnowledge(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
): Promise<string> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: knowledgeKey(tenantId, app) }),
    );
    return (await res.Body?.transformToString()) ?? '';
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return '';
    }
    throw err;
  }
}

/** 寫某 App 的知識(使用者手寫,權威源)。 */
export async function writeKnowledge(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  content: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: knowledgeKey(tenantId, app),
      Body: content,
      ContentType: 'text/markdown',
    }),
  );
}

/**
 * 清空某 App 在某 Locality 的 Memory(Req 9.4:不動 Knowledge)。
 * 只刪 memory 前綴下的物件,絕不觸及 knowledge/<app>.md。
 */
export async function clearMemory(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  app: string,
  locality: Locality,
): Promise<number> {
  // 兩種佈局都要清,但維持 locality 隔離(清 cloud 不得動 attached):
  //  (1) 舊設計的分區前綴 memory/<app>/<locality>/...
  //  (2) 雲端主機 runner harvest 的扁平佈局 memory/<app>/{structure.json,meta.json,screenshots/}
  //      —— readMemoryOverview / 關係圖讀的就是這個。它屬於 cloud(雲端 emulator 產出),
  //      故僅在 locality==='cloud' 時清,且明確排除任何 <其他 locality>/ 子前綴。
  const appRoot = `${tenantPrefix(tenantId)}memory/${app}/`;
  const localityPrefix = memoryPrefix(tenantId, app, locality); // appRoot + <locality>/
  const otherLocalities: Locality[] = (['cloud', 'attached'] as Locality[]).filter((l) => l !== locality);
  const seen = new Set<string>();

  const deleteByPrefix = async (prefix: string, keep: (k: string) => boolean) => {
    let token: string | undefined;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (list.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string')
        .filter(keep);
      await Promise.all(
        keys.map((Key) => {
          seen.add(Key);
          return s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
        }),
      );
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  };

  // (1) 該 locality 分區:整包清。
  await deleteByPrefix(localityPrefix, () => true);

  // (2) 扁平 runner 佈局(視為 cloud):清 appRoot 下、但排除任何 locality 子資料夾的鍵。
  if (locality === 'cloud') {
    const otherPrefixes = otherLocalities.map((l) => `${appRoot}${l}/`);
    await deleteByPrefix(appRoot, (k) => !otherPrefixes.some((p) => k.startsWith(p)) && !k.startsWith(localityPrefix));
  }

  return seen.size;
}

/**
 * 組裝注入 Agent 的上下文:Knowledge 與 Memory 皆帶入,但以獨立標籤區隔,
 * 且明示「衝突時以 Knowledge(確定事實)優先於 Memory(統計觀察)」(Req 9.3)。
 */
export function composeContext(knowledge: string, memory: string): string {
  const parts: string[] = [];
  if (knowledge.trim()) {
    parts.push(
      `# KNOWLEDGE (authoritative facts — take precedence over memory on conflict)\n${knowledge.trim()}`,
    );
  }
  if (memory.trim()) {
    parts.push(`# MEMORY (statistical observations — lower priority)\n${memory.trim()}`);
  }
  return parts.join('\n\n');
}
