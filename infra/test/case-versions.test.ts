import { describe, expect, test } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  activateCaseVersion,
  createCase,
  ensureCaseVersion,
  formatCaseVersion,
  getCase,
  getCaseVersion,
  listCaseVersions,
  parseCaseVersion,
  updateCase,
  writeCaseVersion,
} from '../lambda/api/cases.js';

/** 最小 S3 假物件:支援 Put(含 If-None-Match)、Get、List、Delete。 */
function fakeS3() {
  const store = new Map<string, { body: string; meta: Record<string, string>; at: Date }>();
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand': {
        const key = i['Key'] as string;
        if (i['IfNoneMatch'] === '*' && store.has(key)) {
          throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
        }
        store.set(key, { body: String(i['Body']), meta: (i['Metadata'] as Record<string, string>) ?? {}, at: new Date() });
        return {};
      }
      case 'GetObjectCommand': {
        const o = store.get(i['Key'] as string);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => o.body }, Metadata: o.meta, LastModified: o.at };
      }
      case 'ListObjectsV2Command': {
        const p = i['Prefix'] as string;
        return { Contents: [...store.keys()].filter((k) => k.startsWith(p)).map((Key) => ({ Key })) };
      }
      case 'DeleteObjectCommand':
        store.delete(i['Key'] as string);
        return {};
    }
    throw new Error(`unsupported ${cmd.constructor.name}`);
  };
  return { s3: { send } as unknown as S3Client, store };
}

describe('case version id', () => {
  test('Taipei time, YYYY-MMDD-HHmm-SSss, round-trips', () => {
    const ms = Date.UTC(2027, 5, 6, 3, 24, 33, 990); // 11:24:33.99 UTC+8
    expect(formatCaseVersion(ms)).toBe('2027-0606-1124-3399');
    expect(parseCaseVersion('2027-0606-1124-3399')).toBe(ms);
    expect(parseCaseVersion('bad')).toBeNull();
  });
});

describe('case versions', () => {
  test('create → edit → activate keeps every version immutable', async () => {
    const { s3, store } = fakeS3();
    const c = await createCase(s3, 'b', 't1', { app: 'app1', name: 'Spin', yaml: 'task: spin 10' }, 'qa@example.com');
    expect(c.version).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/);
    const e1 = await updateCase(s3, 'b', 't1', 'app1', c.id, { yaml: 'task: spin 20' });
    expect(e1.created).toBe(true);
    expect(e1.version! > c.version).toBe(true);
    // 內容沒變不產生新版本
    const same = await updateCase(s3, 'b', 't1', 'app1', c.id, { yaml: 'task: spin 20' });
    expect(same.created).toBe(false);
    expect(same.version).toBe(e1.version);

    const list = await listCaseVersions(s3, 'b', 't1', 'app1', c.id);
    expect(list.items.map((v) => v.version)).toEqual([e1.version, c.version]);
    expect(list.active).toBe(e1.version);
    expect(list.items[0]!.basedOn).toBe(c.version);

    // 切回第一版:head 內容換回去,版本數不變
    const act = await activateCaseVersion(s3, 'b', 't1', 'app1', c.id, c.version);
    expect(act.yaml).toBe('task: spin 10');
    expect((await getCase(s3, 'b', 't1', 'app1', c.id))?.version).toBe(c.version);
    expect((await listCaseVersions(s3, 'b', 't1', 'app1', c.id)).items).toHaveLength(2);
    expect((await getCaseVersion(s3, 'b', 't1', 'app1', c.id, e1.version!))?.yaml).toBe('task: spin 20');
    expect([...store.keys()].filter((k) => k.includes('case-versions/'))).toHaveLength(2);
  });

  test('same-centisecond collisions get distinct, ordered ids', async () => {
    const { s3 } = fakeS3();
    const at = Date.UTC(2027, 5, 6, 3, 24, 33, 990);
    const a = await writeCaseVersion(s3, 'b', 't', { app: 'a', caseId: 'c', name: 'n', yaml: 'y1', source: 'edit', at });
    const b2 = await writeCaseVersion(s3, 'b', 't', { app: 'a', caseId: 'c', name: 'n', yaml: 'y2', source: 'edit', at });
    expect(a.version).toBe('2027-0606-1124-3399');
    expect(b2.version).toBe('2027-0606-1124-3400');
  });

  test('legacy case without version gets a baseline version on first use', async () => {
    const { s3, store } = fakeS3();
    store.set('tenants/t/cases/a/c1.yaml', { body: 'task: old', meta: { name: encodeURIComponent('Old'), app: 'a' }, at: new Date(Date.UTC(2026, 8, 1, 0, 0, 0)) });
    const v = await ensureCaseVersion(s3, 'b', 't', 'a', 'c1');
    expect(v).toBe('2026-0901-0800-0000');
    const rec = await getCaseVersion(s3, 'b', 't', 'a', 'c1', v!);
    expect(rec?.source).toBe('baseline');
    expect(rec?.yaml).toBe('task: old');
    expect((await getCase(s3, 'b', 't', 'a', 'c1'))?.version).toBe(v);
    // 第二次呼叫不再產生新版本
    expect(await ensureCaseVersion(s3, 'b', 't', 'a', 'c1')).toBe(v);
  });
});
