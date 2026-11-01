import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * Android 容器的 per-app 快照(清單與刪除)。
 *
 * 快照是「可測起點」:裡面是一份已安裝、而且走過登入／新手教學的 Redroid `/data`。
 * 它存在的理由不是省安裝時間(實測 APK 下載加安裝只佔前置的 10 秒),而是省掉 AI 每次
 * 重走「啟動器 → 更新 → 登入 → 新手教學」的幾十步 VLM 呼叫,並給測試一個可重現的起點。
 * 見 docs/design/emulator-snapshot.md。
 *
 * 主機端由 infra/lambda/engine/emulator/run.sh 建立與還原;這裡只負責讓使用者看得到、
 * 刪得掉。
 */

/** 快照檔名的形狀(與 run.sh 的 SNAP_KEY 必須一致)。 */
const NAME_RE = /^snap-(.+)-([0-9][0-9.]*)-([a-z0-9_]+)-(\d+)x(\d+)\.tar\.zst$/;

export interface SnapshotInfo {
  name: string;
  /** 這份快照是用哪個產物版本建的(job.json 的 artifactVersion)。 */
  artifactVersion: string;
  androidVersion: string;
  arch: string;
  display: string;
  sizeBytes: number;
  updatedAt: string;
}

export function appSnapshotPrefix(tenantId: string, appId: string): string {
  return `tenants/${tenantId}/apps/${appId}/`;
}

/**
 * 解析快照檔名。認不出來回 null。
 *
 * 為什麼要小心:`artifactVersion` 本身含連字號(例如 `art-mva92xdd-s6il77`),所以不能
 * 單純用 `split('-')`。靠後面三段(Android 版本、架構、解析度)的形狀錨定,讓貪婪的
 * 第一組回溯到正確的邊界。
 */
export function parseSnapshotName(name: string): SnapshotInfo | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return {
    name,
    artifactVersion: m[1]!,
    androidVersion: m[2]!,
    arch: m[3]!,
    display: `${m[4]}x${m[5]}`,
    sizeBytes: 0,
    updatedAt: '',
  };
}

/** 列出某個 App 的快照(新到舊)。 */
export async function listAppSnapshots(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
): Promise<SnapshotInfo[]> {
  const prefix = appSnapshotPrefix(tenantId, appId);
  const out: SnapshotInfo[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      const name = (o.Key ?? '').slice(prefix.length);
      // 跳過子路徑與上傳中的 .part(run.sh 寫暫存 key 再搬正,中斷會留下它)。
      if (!name || name.includes('/')) continue;
      const info = parseSnapshotName(name);
      if (!info) continue;
      out.push({
        ...info,
        sizeBytes: Number(o.Size ?? 0),
        updatedAt: o.LastModified?.toISOString() ?? '',
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 刪一份快照。
 *
 * 只接受認得出形狀的檔名:這個值來自 URL,不驗的話就能用它刪掉該 App 前綴下的任何物件
 * (例如 `../` 或 App 自己的 metadata)。
 */
export async function deleteAppSnapshot(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  appId: string,
  name: string,
): Promise<boolean> {
  if (!parseSnapshotName(name)) return false;
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket, Key: `${appSnapshotPrefix(tenantId, appId)}${name}`,
  }));
  return true;
}
