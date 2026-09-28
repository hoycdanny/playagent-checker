import { describe, test, expect } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { listJobs } from '../lambda/api/tasks.js';

/**
 * 回歸測試:listJobs 必須用 ContinuationToken 撈完 S3 所有分頁。
 *
 * 背景 bug:S3 ListObjectsV2 單次最多回 1000 個 key。每個 job 前綴下有數十個
 * steps/screenshots 物件,任務一多,較新的 job.json 會落在第二頁之後。舊版
 * listJobs 只呼叫一次 ListObjectsV2,於是新提交的任務永遠不出現在 GET /tasks
 * 列表(症狀:提交成功但列表停在某個時間點不再更新)。
 */

interface FakeObject {
  Key: string;
}

/** 每頁最多回 pageSize 個物件,並以 IsTruncated/NextContinuationToken 分頁。 */
function makePagingS3(keys: string[], bodies: Map<string, string>, pageSize: number): S3Client {
  return {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = (cmd.input.Prefix as string) ?? '';
        const token = cmd.input.ContinuationToken as string | undefined;
        const matched = keys.filter((k) => k.startsWith(prefix));
        const start = token ? Number(token) : 0;
        const slice = matched.slice(start, start + pageSize);
        const next = start + pageSize;
        const truncated = next < matched.length;
        return {
          Contents: slice.map<FakeObject>((Key) => ({ Key })),
          IsTruncated: truncated,
          ...(truncated ? { NextContinuationToken: String(next) } : {}),
        };
      }
      if (name === 'GetObjectCommand') {
        const key = cmd.input.Key as string;
        const body = bodies.get(key);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: { transformToString: async () => body } };
      }
      return {};
    },
  } as unknown as S3Client;
}

describe('listJobs 分頁', () => {
  test('撈得到落在第二頁之後的 job.json(不因 1000 上限被截斷)', async () => {
    const tenantId = 't-001';
    const prefix = `tenants/${tenantId}/jobs/`;
    const keys: string[] = [];
    const bodies = new Map<string, string>();

    // 3 個 job,每個夾 50 個雜訊物件(steps/screenshots),把 job.json 推到不同頁。
    const jobIds = ['job-aaa', 'job-bbb', 'job-ccc'];
    jobIds.forEach((jobId, i) => {
      const jobKey = `${prefix}${jobId}/job.json`;
      keys.push(jobKey);
      bodies.set(
        jobKey,
        JSON.stringify({
          jobId,
          tenantId,
          backend: 'web',
          locality: 'cloud',
          category: 'test',
          appId: 'app-1',
          caseId: 'case-1',
          createdAt: `2026-09-27T0${i}:00:00.000Z`,
        }),
      );
      for (let n = 0; n < 50; n += 1) {
        keys.push(`${prefix}${jobId}/screenshots/${n}.png`);
      }
    });

    // 每頁 40 個物件 → 需要多頁才撈得完;舊版單次呼叫只會看到第一頁。
    const s3 = makePagingS3(keys, bodies, 40);
    const items = await listJobs(s3, 'test-bucket', tenantId);

    expect(items.map((i) => i.jobId).sort()).toEqual(['job-aaa', 'job-bbb', 'job-ccc']);
  });
});
