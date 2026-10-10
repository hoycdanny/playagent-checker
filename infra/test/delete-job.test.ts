import { describe, expect, test } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { deleteJob } from '../lambda/api/tasks.js';

/** 假 S3:List 分頁(每頁 pageSize 個),DeleteObjects 可模擬部分失敗(回 Errors)與整批 SlowDown。 */
function fakeS3(keys: string[], opts: { failFirstN?: number; slowDownOnce?: boolean; pageSize?: number; persistent?: boolean } = {}) {
  const store = new Set(keys);
  let failLeft = opts.failFirstN ?? 0;
  let slow = !!opts.slowDownOnce;
  const deleteOrder: string[] = [];
  const failedOnce = new Set<string>();
  const pageSize = opts.pageSize ?? 1000;
  const send = async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      const all = [...store].filter((k) => k.startsWith(i['Prefix'])).sort();
      // 與真 S3 一樣:continuation token 指向「上一頁最後一個 key 之後」,刪除不會造成跳頁。
      const after = i['ContinuationToken'] as string | undefined;
      const rest = after ? all.filter((k) => k > after) : all;
      const page = rest.slice(0, pageSize);
      const more = rest.length > pageSize;
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? page[page.length - 1] : undefined };
    }
    if (cmd.constructor.name === 'DeleteObjectsCommand') {
      if (slow) { slow = false; throw Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }); }
      const errors: Array<{ Key: string }> = [];
      for (const { Key } of i['Delete'].Objects as Array<{ Key: string }>) {
        // 暫時性失敗:每個 key 最多失敗一次(persistent=true 則一直失敗)。
        if (failLeft > 0 && (opts.persistent || !failedOnce.has(Key))) { failLeft--; failedOnce.add(Key); errors.push({ Key }); continue; }
        store.delete(Key);
        deleteOrder.push(Key);
      }
      return { Errors: errors };
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  };
  return { s3: { send } as unknown as S3Client, store, deleteOrder };
}

const P = 'tenants/t1/jobs/job-a/';
const many = (n: number) => Array.from({ length: n }, (_, i) => `${P}devlogs/logcat/${String(i).padStart(6, '0')}.txt`);

describe('deleteJob', () => {
  test('deletes job.json first so the task disappears from lists even if interrupted', async () => {
    const { s3, store, deleteOrder } = fakeS3([...many(5), `${P}job.json`, `${P}status.json`, 'tenants/t1/jobs/job-b/job.json']);
    await deleteJob(s3, 'b', 't1', 'job-a');
    expect(deleteOrder[0]).toBe(`${P}job.json`);
    expect([...store]).toEqual(['tenants/t1/jobs/job-b/job.json']);
  });

  test('retries keys reported in Errors and whole-batch SlowDown; handles >1000 objects across pages', async () => {
    const { s3, store } = fakeS3([...many(2600), `${P}job.json`], { failFirstN: 40, slowDownOnce: true, pageSize: 1000 });
    await deleteJob(s3, 'b', 't1', 'job-a');
    expect(store.size).toBe(0);
  });

  test('throws when keys keep failing (so the UI can tell the user)', async () => {
    const { s3 } = fakeS3([`${P}job.json`], { failFirstN: 100, persistent: true });
    await expect(deleteJob(s3, 'b', 't1', 'job-a')).rejects.toThrow(/刪除任務檔案失敗/);
  });
});
