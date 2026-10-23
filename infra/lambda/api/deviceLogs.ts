/**
 * 真機 log(runner agent/deviceLogs.mjs 每步上傳):
 *   jobs/<id>/devlogs/logcat/<序號6位>.txt   logcat 片段(App 全部 + 系統 W/E + crash)
 *   jobs/<id>/devlogs/audio/<序號6位>.json   音效播放器 / 聲音輸出狀態快照
 *   jobs/<id>/devlogs/console/<序號6位>.txt  網頁任務的瀏覽器 console
 *                                            (agent/browserLogs.mjs;刻意用與 logcat 相同的
 *                                             行格式,前端 parseLogcat / LogcatView 直接重用)
 *   jobs/<id>/devlogs/host/<序號6位>.txt     Windows 主機腳本的進度與錯誤
 *                                            (worker/windows-host/gamelift/host.ps1;同樣用
 *                                             logcat 行格式)
 * 依序號分頁讀取(StartAfter 游標);任務詳情頁展開「裝置 Log」時才呼叫。
 */
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

export type DeviceLogKind = 'logcat' | 'audio' | 'console' | 'host';
export const DEVICE_LOG_KINDS: readonly DeviceLogKind[] = ['logcat', 'audio', 'console', 'host'];

const NAME_RE: Record<DeviceLogKind, RegExp> = {
  logcat: /^\d{6}\.txt$/,
  audio: /^\d{6}\.json$/,
  // 網頁任務的瀏覽器 console(agent/browserLogs.mjs 每步上傳,格式與 logcat 相同)。
  console: /^\d{6}\.txt$/,
  // Windows 主機腳本(host.ps1)的下載 / 解壓 / 安裝 / runner 啟動與 stderr 尾段。
  // 這是 Windows 任務唯一能看到「runner 還沒起來之前發生什麼事」的地方。
  host: /^\d{6}\.txt$/,
};

/** 純文字類(其餘是 JSON 快照)。 */
const TEXT_KINDS = new Set<DeviceLogKind>(['logcat', 'console', 'host']);

/** 單次回應內容預算(位元組,保守估計:中文字以 2 bytes 計)。 */
const RESPONSE_BUDGET = 3_000_000;

export interface DeviceLogItem {
  name: string;
  /** logcat:文字內容。 */
  text?: string;
  /** audio:快照 JSON。 */
  data?: unknown;
}

/** 讀 after(檔名)之後的片段,一次最多 limit 個(預設 40)。 */
export async function readDeviceLogs(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  kind: DeviceLogKind,
  opts: { after?: string; limit?: number } = {},
): Promise<{ items: DeviceLogItem[]; cursor?: string; more: boolean }> {
  const prefix = `${tenantPrefix(tenantId)}jobs/${jobId}/devlogs/${kind}/`;
  const re = NAME_RE[kind];
  const after = opts.after && re.test(opts.after) ? opts.after : undefined;
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: limit + 1,
    ...(after ? { StartAfter: `${prefix}${after}` } : {}),
  }));
  const names = (res.Contents ?? [])
    .map((o) => (o.Key ?? '').slice(prefix.length))
    .filter((n) => re.test(n))
    .sort();
  const pick = names.slice(0, limit);
  const items = await Promise.all(pick.map(async (name): Promise<DeviceLogItem> => {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${name}` }));
      const body = (await obj.Body?.transformToString()) ?? '';
      if (TEXT_KINDS.has(kind)) return { name, text: body.slice(0, 400_000) };
      return { name, data: JSON.parse(body) as unknown };
    } catch {
      return { name };
    }
  }));
  // 回應大小上限(Lambda 回應最多 6 MB):累計超過預算就截在這裡,其餘留給下一頁。
  const kept: DeviceLogItem[] = [];
  let bytes = 0;
  for (const it of items) {
    const size = it.text ? it.text.length * 2 : JSON.stringify(it.data ?? null).length;
    if (kept.length > 0 && bytes + size > RESPONSE_BUDGET) break;
    kept.push(it);
    bytes += size;
  }
  const last = kept[kept.length - 1]?.name ?? after;
  const more = kept.length < pick.length || names.length > limit || res.IsTruncated === true;
  return { items: kept, ...(last ? { cursor: last } : {}), more };
}
