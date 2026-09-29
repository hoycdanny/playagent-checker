import { describe, test, expect, vi } from 'vitest';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';
import type { SecretWriter } from '../lambda/api/secretValueStore.js';

const claims = { 'custom:tenantId': 't-001', sub: 'u-1', email: 'a@example.com' };
const PREFIX = 'playagent/tenant/t-001/';

/** 記憶體 S3(只需支援 secret-refs.json 的 Get/Put/Delete)。 */
function fakeS3() {
  const store = new Map<string, string>();
  return {
    store,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const Key = cmd.input.Key as string;
      if (name === 'PutObjectCommand') { store.set(Key, String(cmd.input.Body ?? '')); return {}; }
      if (name === 'GetObjectCommand') {
        if (!store.has(Key)) { const e = new Error('nf'); e.name = 'NoSuchKey'; throw e; }
        return { Body: { transformToString: async () => store.get(Key) } };
      }
      if (name === 'DeleteObjectCommand') { store.delete(Key); return {}; }
      return {};
    },
  };
}

function makeDeps(secretWriter?: SecretWriter): ApiDeps & { s3: ReturnType<typeof fakeS3> } {
  const s3 = fakeS3();
  return {
    bucket: 'b',
    s3,
    sharedS3: s3 as never,
    getTenantS3: async () => s3 as never,
    draftCase: async () => '',
    enqueueJob: async () => {},
    hasher: { hash: (i: string) => `h(${i})`, randomToken: () => 'tok' },
    ...(secretWriter ? { secretWriter } : {}),
  } as ApiDeps & { s3: ReturnType<typeof fakeS3> };
}

describe('測試憑證寫入(PUT/DELETE /secret-refs)', () => {
  test('PUT 短鍵+值 → 寫 Secrets Manager 全名、登記只存名稱、回應不含值', async () => {
    const put = vi.fn(async () => {});
    const del = vi.fn(async () => {});
    const deps = makeDeps({ putSecretValue: put, deleteSecret: del });

    const res = await handleRequest(
      { method: 'PUT', path: '/secret-refs', claims, body: { key: 'TEST_USERNAME', value: 'qa2@x', label: '測試帳號' } },
      deps,
    );
    expect(res.status).toBe(200);
    // 值寫進 Secrets Manager,名稱=租戶前綴+短鍵。
    expect(put).toHaveBeenCalledWith(`${PREFIX}TEST_USERNAME`, 'qa2@x');
    // 回應與登記檔都不得含明文值。
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('qa2@x');
    const refs = deps.s3.store.get('tenants/t-001/secret-refs.json')!;
    expect(refs).not.toContain('qa2@x');
    expect(refs).toContain(`${PREFIX}TEST_USERNAME`);
  });

  test('PUT 不合法鍵名 → 400,不呼叫寫入', async () => {
    const put = vi.fn(async () => {});
    const deps = makeDeps({ putSecretValue: put, deleteSecret: vi.fn(async () => {}) });
    const res = await handleRequest(
      { method: 'PUT', path: '/secret-refs', claims, body: { key: 'bad name', value: 'x' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  test('PUT 帶值但未注入 secretWriter → 501', async () => {
    const deps = makeDeps(); // 無 writer
    const res = await handleRequest(
      { method: 'PUT', path: '/secret-refs', claims, body: { key: 'K', value: 'v' } },
      deps,
    );
    expect(res.status).toBe(501);
  });

  test('DELETE 短鍵 → 刪 Secrets Manager 值 + 移除登記', async () => {
    const del = vi.fn(async () => {});
    const deps = makeDeps({ putSecretValue: vi.fn(async () => {}), deleteSecret: del });
    // 先登記一筆。
    await handleRequest(
      { method: 'PUT', path: '/secret-refs', claims, body: { key: 'TEST_PASSWORD', value: 'p' } },
      deps,
    );
    const res = await handleRequest(
      { method: 'DELETE', path: '/secret-refs', claims, query: { name: 'TEST_PASSWORD' } },
      deps,
    );
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith(`${PREFIX}TEST_PASSWORD`);
  });
});
