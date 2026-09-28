import { describe, test, expect } from 'vitest';
import { composeContext, clearMemory } from '../lambda/api/knowledge.js';

function fakeS3() {
  const store = new Map<string, string>();
  const deleted: string[] = [];
  const client = {
    deleted,
    store,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = cmd.input.Prefix as string;
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      if (name === 'DeleteObjectCommand') {
        deleted.push(cmd.input.Key as string);
        store.delete(cmd.input.Key as string);
        return {};
      }
      return {};
    },
  };
  return client;
}

describe('composeContext(Req 9.3 Knowledge 優先)', () => {
  test('Knowledge 標為權威且排在 Memory 之前', () => {
    const ctx = composeContext('登入後先關每日簽到', '按鈕通常在右下角');
    expect(ctx.indexOf('KNOWLEDGE')).toBeLessThan(ctx.indexOf('MEMORY'));
    expect(ctx).toContain('authoritative');
    expect(ctx).toContain('登入後先關每日簽到');
  });

  test('只有 Knowledge 時不含 Memory 區塊', () => {
    const ctx = composeContext('只有事實', '');
    expect(ctx).toContain('KNOWLEDGE');
    expect(ctx).not.toContain('MEMORY');
  });
});

describe('clearMemory(Req 9.4 不動 Knowledge)', () => {
  test('清 Memory 只刪 memory 前綴,不碰 knowledge', async () => {
    const s3 = fakeS3();
    s3.store.set('tenants/t-001/memory/app-1/cloud/page1.json', '{}');
    s3.store.set('tenants/t-001/memory/app-1/cloud/page2.json', '{}');
    s3.store.set('tenants/t-001/knowledge/app-1.md', '手寫事實');
    // 也放一個 attached 的 memory,確認 locality 隔離
    s3.store.set('tenants/t-001/memory/app-1/attached/p.json', '{}');

    const n = await clearMemory(s3 as never, 'bucket', 't-001', 'app-1', 'cloud');
    expect(n).toBe(2);
    // knowledge 未被刪
    expect(s3.store.has('tenants/t-001/knowledge/app-1.md')).toBe(true);
    // attached memory 未被刪(locality 隔離)
    expect(s3.store.has('tenants/t-001/memory/app-1/attached/p.json')).toBe(true);
    // cloud memory 已刪
    expect(s3.store.has('tenants/t-001/memory/app-1/cloud/page1.json')).toBe(false);
  });

  test('清 cloud 也清主機 runner 扁平佈局(structure/meta/screenshots),但保留 attached', async () => {
    const s3 = fakeS3();
    // 雲端主機 runner harvest 的實際佈局:扁平在 memory/<app>/ 下(無 locality 段)。
    s3.store.set('tenants/t-001/memory/app-1/structure.json', '{}');
    s3.store.set('tenants/t-001/memory/app-1/meta.json', '{}');
    s3.store.set('tenants/t-001/memory/app-1/screenshots/page_abc.png', 'png');
    // 本地裝置記憶(attached)必須被隔離保留。
    s3.store.set('tenants/t-001/memory/app-1/attached/p.json', '{}');
    s3.store.set('tenants/t-001/knowledge/app-1.md', '手寫事實');

    const n = await clearMemory(s3 as never, 'bucket', 't-001', 'app-1', 'cloud');
    expect(n).toBe(3); // structure + meta + screenshot
    expect(s3.store.has('tenants/t-001/memory/app-1/structure.json')).toBe(false);
    expect(s3.store.has('tenants/t-001/memory/app-1/meta.json')).toBe(false);
    expect(s3.store.has('tenants/t-001/memory/app-1/screenshots/page_abc.png')).toBe(false);
    // attached 與 knowledge 未動
    expect(s3.store.has('tenants/t-001/memory/app-1/attached/p.json')).toBe(true);
    expect(s3.store.has('tenants/t-001/knowledge/app-1.md')).toBe(true);
  });
});
