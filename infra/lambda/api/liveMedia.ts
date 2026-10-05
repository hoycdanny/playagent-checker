/**
 * 即時影片 / 音效段落列表(runner 上傳到 jobs/<id>/live/ 與 jobs/<id>/audio/)。
 *
 * - live/s<裝置毫秒>.mp4:screenrecord 2 秒段(無聲、低延遲)。
 * - audio/a<裝置毫秒>.mp4:MediaProjection 錄影段(含音效、延遲較長)+ a<ms>.json 音量時間軸。
 * 檔名以 13 位毫秒時間開頭 → 字典序 = 時間序,可用 StartAfter 做游標分頁。
 */
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { createDownloadUrl } from './artifacts.js';
import { tenantPrefix } from './tenantCredentials.js';

export type MediaKind = 'live' | 'audio';

const NAME_RE: Record<MediaKind, RegExp> = {
  live: /^s(\d{13})\.mp4$/,
  audio: /^a(\d{13})\.mp4$/,
};

export interface MediaSegment {
  name: string;
  /** 段落開始的裝置時間(epoch ms)。 */
  t: number;
  url: string;
  bytes?: number;
  /** audio 段:對應的音量時間軸 JSON URL(若有)。 */
  levelsUrl?: string;
}

/**
 * 列出 after(檔名)之後的段落。after 未給 → 只回最新 latest 段(剛打開頁面時從最新開始播)。
 * 一次最多 limit 段。
 */
export async function listMediaSegments(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  kind: MediaKind,
  opts: { after?: string; latest?: number; limit?: number } = {},
): Promise<{ items: MediaSegment[]; cursor?: string }> {
  const prefix = `${tenantPrefix(tenantId)}jobs/${jobId}/${kind}/`;
  const re = NAME_RE[kind];
  const after = opts.after && re.test(opts.after) ? opts.after : undefined;
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);

  const objs: Array<{ name: string; size?: number }> = [];
  const jsonNames = new Set<string>();
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(after ? { StartAfter: `${prefix}${after}` } : {}),
      ...(token ? { ContinuationToken: token } : {}),
    }));
    for (const o of res.Contents ?? []) {
      const name = (o.Key ?? '').slice(prefix.length);
      if (re.test(name)) objs.push({ name, ...(o.Size !== undefined ? { size: o.Size } : {}) });
      else if (name.endsWith('.json')) jsonNames.add(name);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    // 有游標時只需要前 limit 段;無游標要找最新的,得列完(段落數有限:每分鐘約 25 段)。
    if (after && objs.length >= limit) token = undefined;
  } while (token);

  objs.sort((a, b) => a.name.localeCompare(b.name));
  const pick = after ? objs.slice(0, limit) : objs.slice(-Math.min(Math.max(opts.latest ?? 2, 1), limit));
  const items = await Promise.all(pick.map(async (o): Promise<MediaSegment> => {
    const t = Number(re.exec(o.name)![1]);
    const lv = o.name.replace(/\.mp4$/, '.json');
    return {
      name: o.name,
      t,
      url: await createDownloadUrl(s3, bucket, `${prefix}${o.name}`),
      ...(o.size !== undefined ? { bytes: o.size } : {}),
      ...(jsonNames.has(lv) ? { levelsUrl: await createDownloadUrl(s3, bucket, `${prefix}${lv}`) } : {}),
    };
  }));
  const last = pick[pick.length - 1]?.name ?? after;
  return { items, ...(last ? { cursor: last } : {}) };
}

export interface AudioLevels {
  state: 'on' | 'unavailable' | 'stopped' | 'none';
  /** 每筆 RMS 的時間間隔(秒)。 */
  dt: number;
  /** 各錄音段:開始時間(runner epoch ms)、長度(秒)、RMS dB 陣列。 */
  chunks: Array<{ name: string; t: number; dur: number; rms: number[] }>;
}

/** 讀音量時間軸(runner 每錄完一段就整份覆寫 audio/levels.json)。沒有 → state 'none'。 */
export async function readAudioLevels(s3: S3Client, bucket: string, tenantId: string, jobId: string): Promise<AudioLevels> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${tenantPrefix(tenantId)}jobs/${jobId}/audio/levels.json` }));
    const doc = JSON.parse((await res.Body?.transformToString()) ?? '{}') as Partial<AudioLevels>;
    return {
      state: doc.state === 'unavailable' || doc.state === 'stopped' ? doc.state : 'on',
      dt: typeof doc.dt === 'number' && doc.dt > 0 ? doc.dt : 0.1,
      chunks: Array.isArray(doc.chunks) ? doc.chunks.filter((c) => c && typeof c.t === 'number' && Array.isArray(c.rms)) : [],
    };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') return { state: 'none', dt: 0.1, chunks: [] };
    throw err;
  }
}
