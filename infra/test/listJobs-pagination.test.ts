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
        const delimiter = cmd.input.Delimiter as string | undefined;
        const token = cmd.input.ContinuationToken as string | undefined;
        const matched = keys.filter((k) => k.startsWith(prefix));
        if (delimiter === '/') {
          // 模擬 S3 delimiter 行為:回 prefix 之後、下一個 '/' 為止的共同前綴(去重)。
          // 對 tenants/<t>/jobs/ 而言即「每個 job 一個資料夾前綴」。
          const prefixes = new Set<string>();
          for (const k of matched) {
            const rest = k.slice(prefix.length);
            const idx = rest.indexOf('/');
            if (idx >= 0) prefixes.add(prefix + rest.slice(0, idx + 1));
          }
          const all = [...prefixes];
          const start = token ? Number(token) : 0;
          const slice = all.slice(start, start + pageSize);
          const next = start + pageSize;
          const truncated = next < all.length;
          return {
            CommonPrefixes: slice.map((Prefix) => ({ Prefix })),
            IsTruncated: truncated,
            ...(truncated ? { NextContinuationToken: String(next) } : {}),
          };
        }
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

    // 每頁 2 個資料夾前綴 → 3 個 job 需要多頁,仍驗證 ContinuationToken 迴圈。
    const s3 = makePagingS3(keys, bodies, 2);
    const { items } = await listJobs(s3, 'test-bucket', tenantId);

    expect(items.map((i) => i.jobId).sort()).toEqual(['job-aaa', 'job-bbb', 'job-ccc']);
  });

  /**
   * 回歸測試:單一任務的附屬 JSON 壞掉,不能害整張清單消失。
   *
   * 2026-10-18 實測:某個任務的 status.json 被寫進 UTF-8 BOM,JSON.parse 丟錯。
   * listJobs 用 Promise.all 併發讀 status / report / config,一筆失敗就讓整個
   * /tasks 請求 reject,應用管理頁的任務清單整頁空白 —— 其他任務全都看不到。
   */
  test('壞掉的 status.json 視同不存在,其餘任務照樣回傳', async () => {
    const tenantId = 't-002';
    const prefix = `tenants/${tenantId}/jobs/`;
    const keys: string[] = [];
    const bodies = new Map<string, string>();
    const jobIds = ['job-aaa', 'job-bad', 'job-ccc'];
    jobIds.forEach((jobId, i) => {
      const jobKey = `${prefix}${jobId}/job.json`;
      keys.push(jobKey);
      bodies.set(jobKey, JSON.stringify({
        jobId, tenantId, backend: 'web', locality: 'cloud', category: 'test',
        appId: 'app-1', caseId: 'case-1', createdAt: `2026-09-27T0${i}:00:00.000Z`,
      }));
      const statusKey = `${prefix}${jobId}/status.json`;
      keys.push(statusKey);
      // 壞掉那一筆:帶 BOM(PowerShell 的 Out-File 等工具會寫進去)。
      bodies.set(statusKey, jobId === 'job-bad'
        ? `\uFEFF${JSON.stringify({ jobId, state: 'pass', updatedAt: '2026-09-27T05:00:00.000Z' })}`
        : JSON.stringify({ jobId, state: 'pass', updatedAt: '2026-09-27T05:00:00.000Z' }));
    });

    const s3 = makePagingS3(keys, bodies, 2);
    const { items } = await listJobs(s3, 'test-bucket', tenantId);

    // 三個任務都要在,壞掉那個只是少了 status 推導出來的欄位。
    expect(items.map((i) => i.jobId).sort()).toEqual(['job-aaa', 'job-bad', 'job-ccc']);
    expect(items.find((i) => i.jobId === 'job-ccc')?.state).toBe('pass');
    // BOM 只是前置字元,內容本身合法 → 去掉 BOM 後照樣解析得出來。
    expect(items.find((i) => i.jobId === 'job-bad')?.state).toBe('pass');
  });

  test('內容真的不是 JSON 時也只是視同不存在', async () => {
    const tenantId = 't-003';
    const prefix = `tenants/${tenantId}/jobs/`;
    const keys = [`${prefix}job-x/job.json`, `${prefix}job-x/status.json`];
    const bodies = new Map<string, string>([
      [keys[0]!, JSON.stringify({
        jobId: 'job-x', tenantId, backend: 'web', locality: 'cloud', category: 'test',
        appId: 'app-1', caseId: 'case-1', createdAt: '2026-09-27T00:00:00.000Z',
      })],
      [keys[1]!, '<html>500 oops</html>'],
    ]);
    const { items } = await listJobs(makePagingS3(keys, bodies, 2), 'test-bucket', tenantId);
    expect(items.map((i) => i.jobId)).toEqual(['job-x']);
    expect(items[0]!.updatedAt).toBeUndefined();
  });
});
