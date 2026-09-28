import { describe, it, expect } from 'vitest';
import {
  listSecretRefs,
  putSecretRef,
  deleteSecretRef,
  SecretRefError,
} from '../lambda/api/secretRefStore.js';
import { tenantSecretPrefix } from '../lambda/api/secretRefs.js';

const TENANT = 'acme-tw';

function fakeS3() {
  const store = new Map<string, string>();
  const client = {
    store,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const Key = cmd.input.Key as string;
      if (name === 'GetObjectCommand') {
        const body = store.get(Key);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: { transformToString: async () => body } };
      }
      if (name === 'PutObjectCommand') {
        store.set(Key, cmd.input.Body as string);
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(Key);
        return {};
      }
      return {};
    },
  };
  return client;
}

describe('機密引用管理 store(Req 14.4 不回值)', () => {
  it('登記引用只記名稱與標籤,不含任何值欄位', async () => {
    const s3 = fakeS3();
    const name = `${tenantSecretPrefix(TENANT)}game-login`;
    const entry = await putSecretRef(s3 as never, 'b', TENANT, {
      name,
      label: '遊戲登入密碼',
    });
    expect(entry.name).toBe(name);
    expect(entry.label).toBe('遊戲登入密碼');
    // 儲存內容不得含任何明文值欄位。
    const raw = s3.store.get(`tenants/${TENANT}/secret-refs.json`)!;
    expect(raw).not.toMatch(/value|secret[\"']?\s*:/i);
    const items = await listSecretRefs(s3 as never, 'b', TENANT);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!)).toEqual(['name', 'label', 'createdAt']);
  });

  it('登記跨租戶名稱 → 拒絕', async () => {
    const s3 = fakeS3();
    await expect(
      putSecretRef(s3 as never, 'b', TENANT, {
        name: 'playagent/tenant/globex-us/pw',
      }),
    ).rejects.toThrow(SecretRefError);
  });

  it('刪除引用', async () => {
    const s3 = fakeS3();
    const name = `${tenantSecretPrefix(TENANT)}a`;
    await putSecretRef(s3 as never, 'b', TENANT, { name });
    await deleteSecretRef(s3 as never, 'b', TENANT, name);
    const items = await listSecretRefs(s3 as never, 'b', TENANT);
    expect(items).toHaveLength(0);
  });
});
